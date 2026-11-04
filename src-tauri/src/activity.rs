//! Tab status and context gauge (CONTRACT.md "Tab status and context gauge").
//!
//! A 1 s poll thread matches Claude Code sessions to the tabs' pty pids and
//! emits `tabs:activity` with one `TabActivity` per matched tab whenever the
//! list changed (status, waitingFor, tokens or membership).
//!
//! - `~/.claude/sessions/<pid>.json` gives `busy` / `idle`. The session pid is
//!   a descendant of the tab's pty child, so `/proc/<pid>/stat` parents are
//!   walked upwards (at most `MAX_WALK` levels) until a tab pid is reached.
//!   Files are parsed only when their mtime or size changed.
//! - `claude agents --json --all` adds `waiting` and `waitingFor`. It costs a
//!   Node start, so it runs only while a matched session is busy, at most
//!   every 4 s, with a 3 s timeout, in its own thread.
//! - The transcript tail gives the context size: the last assistant line with
//!   `message.usage` counts `input + cache_creation + cache_read` tokens.
//!
//! `notify` raises a desktop notification through `omarchy-notification-send`
//! or `notify-send`, argv only, detached and reaped.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// How often the session files are polled.
const POLL: Duration = Duration::from_secs(1);
/// Minimum gap between two `claude agents` runs.
const AGENTS_EVERY: Duration = Duration::from_secs(4);
/// A `claude agents` run is killed after this.
const AGENTS_TIMEOUT: Duration = Duration::from_secs(3);
/// Parent levels walked from a session pid to a tab pid.
const MAX_WALK: usize = 12;
/// Bytes read from the end of a transcript first.
const TAIL_BYTES: u64 = 64 * 1024;
/// Without a usage line in the first tail, the window grows to these sizes
/// (one large tool result or attachment line can push the last assistant line
/// out of 64 KB); it stops once it reaches back past the previous size, whose
/// bytes were already looked at.
const TAIL_STEPS: [u64; 3] = [TAIL_BYTES, 256 * 1024, 1024 * 1024];
/// When the encoded-dir guess misses and the search found nothing (a new
/// session without a transcript yet), search again after this.
const SEARCH_RETRY: Duration = Duration::from_secs(30);
/// Failures of `claude agents` are logged at most this often.
const LOG_EVERY: Duration = Duration::from_secs(60);

const OMARCHY_NOTIFY: &str = "omarchy-notification-send";
const OMARCHY_NOTIFY_PATH: &str = "/usr/share/omarchy/bin/omarchy-notification-send";

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub tokens: u64,
    pub model: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabActivity {
    /// The tab's pty child pid.
    pub pid: u32,
    pub session_id: String,
    /// "busy" | "waiting" | "idle".
    pub status: String,
    pub waiting_for: Option<String>,
    /// Epoch ms.
    pub status_updated_at: i64,
    /// None until the first assistant turn.
    pub context: Option<Context>,
}

/// The fields of a `~/.claude/sessions/<pid>.json` this module reads.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    pid: Option<u32>,
    session_id: Option<String>,
    cwd: Option<String>,
    status: Option<String>,
    /// Newer Claude Code versions write `waiting` here with a reason.
    waiting_for: Option<String>,
    status_updated_at: Option<i64>,
    updated_at: Option<i64>,
    proc_start: Option<String>,
}

/// One interactive entry of `claude agents --json --all`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentEntry {
    pub pid: u32,
    pub session_id: String,
    pub status: String,
    pub waiting_for: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

// ---------------------------------------------------------------------------
// /proc parent walk
// ---------------------------------------------------------------------------

/// Parent pid (field 4) and start time (field 22) of `<proc_root>/<pid>/stat`.
fn proc_stat(proc_root: &Path, pid: u32) -> Option<(u32, String)> {
    let stat = fs::read_to_string(proc_root.join(pid.to_string()).join("stat")).ok()?;
    // comm (field 2) may contain spaces and parens; fields after it start at 3.
    let mut fields = stat[stat.rfind(')')? + 1..].split_whitespace();
    let ppid = fields.nth(1)?.parse().ok()?;
    let start = fields.nth(22 - 5)?.to_owned();
    Some((ppid, start))
}

/// The tab pid `pid` runs under: `pid` itself or one of its first `MAX_WALK`
/// ancestors. None when the process is gone, its start time differs from
/// `proc_start` (a reused pid behind a stale file) or no tab is reached.
fn match_tab(
    proc_root: &Path,
    pid: u32,
    proc_start: Option<&str>,
    tabs: &HashSet<u32>,
) -> Option<u32> {
    let (mut ppid, start) = proc_stat(proc_root, pid)?;
    if proc_start.is_some_and(|want| want != start) {
        return None;
    }
    let mut cur = pid;
    for _ in 0..MAX_WALK {
        if tabs.contains(&cur) {
            return Some(cur);
        }
        if ppid <= 1 {
            return None;
        }
        cur = ppid;
        ppid = proc_stat(proc_root, cur)?.0;
    }
    tabs.contains(&cur).then_some(cur)
}

// ---------------------------------------------------------------------------
// Transcript usage
// ---------------------------------------------------------------------------

/// Context of the last assistant line with `message.usage` in a transcript
/// tail. A truncated first line, other line types, sidechain (subagent) lines
/// and Claude Code's own `<synthetic>` messages (zero usage) are skipped.
pub fn usage_from_tail(tail: &str) -> Option<Context> {
    for line in tail.lines().rev() {
        if !line.contains("\"type\":\"assistant\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant")
            || v.get("isSidechain").and_then(|s| s.as_bool()) == Some(true)
        {
            continue;
        }
        let Some(message) = v.get("message") else {
            continue;
        };
        let model = message.get("model").and_then(|m| m.as_str());
        if model == Some("<synthetic>") {
            continue;
        }
        let Some(usage) = message.get("usage").filter(|u| u.is_object()) else {
            continue;
        };
        let n = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        return Some(Context {
            tokens: n("input_tokens")
                + n("cache_creation_input_tokens")
                + n("cache_read_input_tokens"),
            model: model.map(str::to_owned),
        });
    }
    None
}

/// The last `bytes` of a file of length `len`, lossily decoded.
fn read_tail(path: &Path, len: u64, bytes: u64) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let from = len.saturating_sub(bytes);
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::with_capacity((len - from) as usize);
    f.take(len - from).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// The usage in the last 64 KB, else in a growing tail (`TAIL_STEPS`) that
/// stops once it covers the whole file or reaches back before `prev_len`.
fn usage_from_file(path: &Path, len: u64, prev_len: Option<u64>) -> Option<Context> {
    for bytes in TAIL_STEPS {
        if let Some(ctx) = read_tail(path, len, bytes)
            .as_deref()
            .and_then(usage_from_tail)
        {
            return Some(ctx);
        }
        let from = len.saturating_sub(bytes);
        if from == 0 || prev_len.is_some_and(|p| from < p) {
            break;
        }
    }
    None
}

#[derive(Default)]
struct Transcript {
    path: Option<PathBuf>,
    last_search: Option<Instant>,
    size: Option<u64>,
    context: Option<Context>,
}

/// `<projects>/<encoded cwd>/<id>.jsonl` when it exists.
fn guess_transcript(projects: &Path, cwd: Option<&str>, id: &str) -> Option<PathBuf> {
    let p = projects
        .join(crate::memory::encode(cwd?))
        .join(format!("{id}.jsonl"));
    p.is_file().then_some(p)
}

/// `<projects>/*/<id>.jsonl`, the first found.
fn search_transcript(projects: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&name))
        .find(|p| p.is_file())
}

impl Transcript {
    /// Locate the file and, when its size changed, re-read the usage.
    fn refresh(&mut self, projects: &Path, cwd: Option<&str>, id: &str) {
        let meta = self.path.as_deref().and_then(|p| fs::metadata(p).ok());
        let meta = match meta {
            Some(m) => Some(m),
            None => {
                self.path = guess_transcript(projects, cwd, id);
                if self.path.is_none()
                    && self.last_search.is_none_or(|t| t.elapsed() >= SEARCH_RETRY)
                {
                    self.last_search = Some(Instant::now());
                    self.path = search_transcript(projects, id);
                }
                self.path.as_deref().and_then(|p| fs::metadata(p).ok())
            }
        };
        let (Some(path), Some(meta)) = (self.path.as_deref(), meta) else {
            return;
        };
        let len = meta.len();
        if self.size == Some(len) {
            return;
        }
        // A shrunk file (rewritten) is read as new.
        let prev = self.size.filter(|&p| p <= len);
        self.size = Some(len);
        // No usage line in the tail: keep the previous value.
        if let Some(ctx) = usage_from_file(path, len, prev) {
            self.context = Some(ctx);
        }
    }
}

// ---------------------------------------------------------------------------
// claude agents --json --all
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAgent {
    pid: Option<u32>,
    session_id: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    waiting_for: Option<String>,
}

/// Interactive entries of `claude agents --json --all`; background entries
/// (which carry `state` instead of `status`) are dropped.
pub fn parse_agents(json: &str) -> Result<Vec<AgentEntry>, String> {
    let raw: Vec<RawAgent> =
        serde_json::from_str(json).map_err(|e| format!("claude agents: bad JSON: {e}"))?;
    Ok(raw
        .into_iter()
        .filter(|a| a.kind.as_deref() != Some("background"))
        .filter_map(|a| {
            Some(AgentEntry {
                pid: a.pid?,
                session_id: a.session_id.filter(|s| !s.is_empty())?,
                status: a.status?,
                waiting_for: a.waiting_for.filter(|s| !s.is_empty()),
            })
        })
        .collect())
}

/// `claude` for the status poll: from PATH first, and only when PATH has none
/// the `~/.local/bin/claude` launcher a tab would run. The launcher fetches
/// credentials (q-ring) on every start, which `claude agents` does not need and
/// would otherwise do every 4 s while a tab is busy.
fn claude_program() -> PathBuf {
    if let Some(p) = in_path("claude") {
        return p;
    }
    let local = crate::files::home_dir()
        .map(|h| h.join(".local/bin/claude"))
        .ok();
    match local {
        Some(p) if is_executable(&p) => p,
        _ => PathBuf::from("claude"),
    }
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Kill a child's whole process group (the launcher may fork) and reap it.
fn kill_group(child: &mut Child) {
    // SAFETY: plain kill(2) on the process group of a child we spawned with
    // process_group(0) and have not reaped yet.
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// One `claude agents --json --all` run, killed after `AGENTS_TIMEOUT`.
fn run_agents(program: &Path) -> Result<Vec<AgentEntry>, String> {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(program);
    cmd.args(["agents", "--json", "--all"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    for var in crate::pty::CLAUDE_SESSION_VARS {
        cmd.env_remove(var);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("claude agents: could not start {}: {e}", program.display()))?;
    let Some(mut out) = child.stdout.take() else {
        kill_group(&mut child);
        return Err("claude agents: no stdout".into());
    };
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = tx.send(out.read_to_end(&mut buf).map(|_| buf));
    });
    let deadline = Instant::now() + AGENTS_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                kill_group(&mut child);
                return Err("claude agents: timed out after 3 s".into());
            }
            Err(e) => {
                kill_group(&mut child);
                return Err(format!("claude agents: wait failed: {e}"));
            }
        }
    };
    if !status.success() {
        return Err(format!("claude agents: {status}"));
    }
    let buf = rx
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "claude agents: output not closed".to_string())?
        .map_err(|e| format!("claude agents: read failed: {e}"))?;
    parse_agents(&String::from_utf8_lossy(&buf))
}

/// The entries of one run and when it started (epoch ms).
#[derive(Clone)]
struct AgentsSnapshot {
    at_ms: i64,
    entries: Vec<AgentEntry>,
}

/// Runs `claude agents` off the poll thread, one run at a time.
struct AgentsRunner {
    in_flight: Arc<AtomicBool>,
    last_start: Option<Instant>,
    result: Arc<Mutex<Option<AgentsSnapshot>>>,
    last_log: Arc<Mutex<Option<Instant>>>,
}

impl AgentsRunner {
    fn new() -> Self {
        Self {
            in_flight: Arc::new(AtomicBool::new(false)),
            last_start: None,
            result: Arc::new(Mutex::new(None)),
            last_log: Arc::new(Mutex::new(None)),
        }
    }

    /// Start a run when a matched session is busy and the last one began at
    /// least `AGENTS_EVERY` ago; with nothing busy, forget the last result so a
    /// stale `waiting` never carries into the next turn.
    fn tick(&mut self, any_busy: bool) {
        if !any_busy {
            *self.result.lock().unwrap_or_else(|p| p.into_inner()) = None;
            return;
        }
        if self.in_flight.load(Ordering::SeqCst)
            || self.last_start.is_some_and(|t| t.elapsed() < AGENTS_EVERY)
        {
            return;
        }
        self.last_start = Some(Instant::now());
        self.in_flight.store(true, Ordering::SeqCst);
        let (in_flight, result, last_log) = (
            self.in_flight.clone(),
            self.result.clone(),
            self.last_log.clone(),
        );
        let spawned = thread::Builder::new()
            .name("activity-agents".into())
            .spawn(move || {
                let at_ms = now_ms();
                match run_agents(&claude_program()) {
                    Ok(entries) => {
                        *result.lock().unwrap_or_else(|p| p.into_inner()) =
                            Some(AgentsSnapshot { at_ms, entries });
                    }
                    Err(e) => {
                        let mut last = last_log.lock().unwrap_or_else(|p| p.into_inner());
                        if last.is_none_or(|t| t.elapsed() >= LOG_EVERY) {
                            *last = Some(Instant::now());
                            crate::watchdog::note(&format!("activity: {e}"));
                        }
                    }
                }
                in_flight.store(false, Ordering::SeqCst);
            });
        if spawned.is_err() {
            self.in_flight.store(false, Ordering::SeqCst);
        }
    }

    fn snapshot(&self) -> Option<AgentsSnapshot> {
        self.result
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

struct FileEntry {
    stamp: (Option<SystemTime>, u64),
    parsed: Option<SessionFile>,
}

/// Session files, transcripts and the last emitted list, across polls.
struct Poller {
    sessions_dir: PathBuf,
    projects_dir: PathBuf,
    proc_root: PathBuf,
    files: HashMap<PathBuf, FileEntry>,
    transcripts: HashMap<String, Transcript>,
}

/// A session file matched to a tab.
struct Matched {
    tab: u32,
    file: SessionFile,
    session_id: String,
}

fn normal_status(s: Option<&str>) -> &'static str {
    match s {
        Some("busy") => "busy",
        Some("waiting") => "waiting",
        _ => "idle",
    }
}

impl Poller {
    fn new(sessions_dir: PathBuf, projects_dir: PathBuf, proc_root: PathBuf) -> Self {
        Self {
            sessions_dir,
            projects_dir,
            proc_root,
            files: HashMap::new(),
            transcripts: HashMap::new(),
        }
    }

    /// Re-read changed session files (one read_dir plus one metadata per file).
    fn read_files(&mut self) {
        let Ok(rd) = fs::read_dir(&self.sessions_dir) else {
            self.files.clear();
            return;
        };
        let mut seen = HashSet::new();
        for e in rd.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            let stamp = (meta.modified().ok(), meta.len());
            seen.insert(path.clone());
            if self.files.get(&path).is_some_and(|f| f.stamp == stamp) {
                continue;
            }
            let parsed = fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str::<SessionFile>(&t).ok());
            self.files.insert(path, FileEntry { stamp, parsed });
        }
        self.files.retain(|p, _| seen.contains(p));
    }

    /// The session file per tab pid; with two, the most recently updated.
    fn match_files(&self, tabs: &HashSet<u32>) -> Vec<Matched> {
        let mut by_tab: HashMap<u32, Matched> = HashMap::new();
        for f in self.files.values().filter_map(|f| f.parsed.as_ref()) {
            let (Some(pid), Some(id)) = (f.pid, f.session_id.as_deref().filter(|s| !s.is_empty()))
            else {
                continue;
            };
            let Some(tab) = match_tab(&self.proc_root, pid, f.proc_start.as_deref(), tabs) else {
                continue;
            };
            let ts = |f: &SessionFile| f.status_updated_at.or(f.updated_at);
            if by_tab.get(&tab).is_some_and(|m| ts(&m.file) >= ts(f)) {
                continue;
            }
            by_tab.insert(
                tab,
                Matched {
                    tab,
                    file: f.clone(),
                    session_id: id.to_owned(),
                },
            );
        }
        let mut out: Vec<Matched> = by_tab.into_values().collect();
        out.sort_by_key(|m| m.tab);
        out
    }

    /// One poll: the activity list for these tab pids. `agents` runs in
    /// between matching and building (it decides from the matched statuses).
    fn poll(
        &mut self,
        tabs: &HashSet<u32>,
        agents: &mut dyn FnMut(bool) -> Option<AgentsSnapshot>,
    ) -> Vec<TabActivity> {
        if tabs.is_empty() {
            self.transcripts.clear();
            agents(false);
            return Vec::new();
        }
        self.read_files();
        let matched = self.match_files(tabs);
        let any_busy = matched
            .iter()
            .any(|m| normal_status(m.file.status.as_deref()) == "busy");
        let snapshot = agents(any_busy);
        // Agents entries by session id, kept only when their pid is under the same tab.
        let waiting: HashMap<(&str, u32), &AgentEntry> = snapshot
            .as_ref()
            .map(|s| {
                s.entries
                    .iter()
                    .filter(|a| a.status == "waiting")
                    .filter_map(|a| {
                        let tab = match_tab(&self.proc_root, a.pid, None, tabs)?;
                        Some(((a.session_id.as_str(), tab), a))
                    })
                    .collect()
            })
            .unwrap_or_default();

        let live: HashSet<&str> = matched.iter().map(|m| m.session_id.as_str()).collect();
        self.transcripts.retain(|id, _| live.contains(id.as_str()));

        let mut out = Vec::with_capacity(matched.len());
        for m in &matched {
            let status_updated_at = m.file.status_updated_at.or(m.file.updated_at).unwrap_or(0);
            let mut status = normal_status(m.file.status.as_deref()).to_owned();
            let mut waiting_for = if status == "waiting" {
                m.file.waiting_for.clone().filter(|s| !s.is_empty())
            } else {
                None
            };
            // A `waiting` entry overrides the file's `busy`, unless the file
            // changed after that run started.
            if status == "busy"
                && let Some(s) = &snapshot
                && s.at_ms >= status_updated_at
                && let Some(a) = waiting.get(&(m.session_id.as_str(), m.tab))
            {
                status = "waiting".into();
                waiting_for = a.waiting_for.clone();
            }
            let t = self.transcripts.entry(m.session_id.clone()).or_default();
            t.refresh(&self.projects_dir, m.file.cwd.as_deref(), &m.session_id);
            out.push(TabActivity {
                pid: m.tab,
                session_id: m.session_id.clone(),
                status,
                waiting_for,
                status_updated_at,
                context: t.context.clone(),
            });
        }
        out
    }
}

/// True when two lists differ in membership, status, waitingFor or tokens.
fn changed(a: &[TabActivity], b: &[TabActivity]) -> bool {
    let key = |x: &TabActivity| {
        (
            x.pid,
            x.session_id.clone(),
            x.status.clone(),
            x.waiting_for.clone(),
            x.context.as_ref().map(|c| c.tokens),
        )
    };
    a.len() != b.len() || a.iter().zip(b).any(|(x, y)| key(x) != key(y))
}

/// Start the poll thread; emits `tabs:activity` with `TabActivity[]`.
pub fn start(app: &AppHandle) {
    let Ok(claude) = crate::files::claude_dir() else {
        return;
    };
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("activity".into())
        .spawn(move || {
            let mut poller = Poller::new(
                claude.join("sessions"),
                claude.join("projects"),
                PathBuf::from("/proc"),
            );
            let mut runner = AgentsRunner::new();
            let mut last: Vec<TabActivity> = Vec::new();
            loop {
                thread::sleep(POLL);
                let tabs = app.state::<crate::pty::PtyState>().live_pids();
                let now = poller.poll(&tabs, &mut |busy| {
                    runner.tick(busy);
                    runner.snapshot()
                });
                if !changed(&last, &now) {
                    continue;
                }
                if let Err(e) = app.emit("tabs:activity", &now) {
                    crate::watchdog::note(&format!("activity: emit failed: {e}"));
                }
                last = now;
            }
        });
    if let Err(e) = spawned {
        crate::watchdog::note(&format!("activity: could not start poller: {e}"));
    }
}

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------

/// `name` in PATH, or None.
fn in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(name))
        .find(|p| is_executable(p))
}

/// Text that cannot be taken for an option by either notifier.
fn positional(s: &str) -> String {
    let one_line = s.replace(['\n', '\r'], " ");
    if one_line.starts_with('-') {
        format!(" {one_line}")
    } else {
        one_line
    }
}

/// The notifier argv for this title and body, or None without a notifier.
fn notify_argv(
    title: &str,
    body: &str,
    omarchy: Option<PathBuf>,
    notify_send: Option<PathBuf>,
) -> Option<(PathBuf, Vec<String>)> {
    let (title, body) = (positional(title), positional(body));
    if let Some(p) = omarchy {
        return Some((p, vec!["-u".into(), "normal".into(), title, body]));
    }
    notify_send.map(|p| (p, vec![title, body]))
}

/// Desktop notification; `Ok(false)` when no notifier is installed.
#[tauri::command]
pub async fn notify(title: String, body: String) -> Result<bool, String> {
    let omarchy = in_path(OMARCHY_NOTIFY)
        .or_else(|| Some(PathBuf::from(OMARCHY_NOTIFY_PATH)).filter(|p| is_executable(p)));
    let notify_send = in_path("notify-send")
        .or_else(|| Some(PathBuf::from("/usr/bin/notify-send")).filter(|p| is_executable(p)));
    let Some((program, args)) = notify_argv(&title, &body, omarchy, notify_send) else {
        return Ok(false);
    };
    let mut child = Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", program.display()))?;
    // Reap it off-thread so the finished process does not linger as a zombie.
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `claude agents --json --all` output (2026-11-03, paths and names
    /// shortened): background entries carry `state`, interactive ones `status`.
    const AGENTS_FIXTURE: &str = r#"[
  {
    "id": "0cb79e0c",
    "cwd": "/home/me",
    "kind": "background",
    "startedAt": 1789446259837,
    "sessionId": "0cb79e0c-3f76-4573-bab0-6e5dc077092a",
    "name": "Cryo audience expansion",
    "state": "stopped"
  },
  {
    "id": "da1ebf9e",
    "cwd": "/home/me",
    "kind": "background",
    "startedAt": 1792354347335,
    "sessionId": "da1ebf9e-5ebe-47ff-a64e-46bc674f0313",
    "name": "Vercel cleanup",
    "state": "done"
  },
  {
    "pid": 2275997,
    "cwd": "/home/me/Develop/lab/kansei",
    "kind": "interactive",
    "startedAt": 1793766304011,
    "sessionId": "69c9ff27-3709-45fa-ae0b-041663d246ac",
    "name": "kansei-1c",
    "status": "busy"
  },
  {
    "pid": 2275916,
    "cwd": "/home/me/Develop/products/aibou",
    "kind": "interactive",
    "startedAt": 1793766304014,
    "sessionId": "13721589-df9f-4466-bf8a-5dce3b32ae59",
    "name": "aibou-6f",
    "status": "idle"
  },
  {
    "pid": 2275943,
    "cwd": "/home/me/Develop/products/niwa",
    "kind": "interactive",
    "startedAt": 1793766304040,
    "sessionId": "ff65c04f-981b-4278-8699-44dc45e36e43",
    "name": "niwa-0d",
    "status": "waiting",
    "waitingFor": "permission prompt"
  }
]"#;

    const S1: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const S2: &str = "bbbbbbbb-0000-4000-8000-000000000002";

    /// A fake `/proc`: `<root>/<pid>/stat` with the given parent and start time.
    fn proc_entry(root: &Path, pid: u32, ppid: u32, start: &str) {
        let dir = root.join(pid.to_string());
        fs::create_dir_all(&dir).unwrap();
        // Field 2 with spaces and a paren, like a real comm can have.
        let mut fields: Vec<String> = vec!["S".into(), ppid.to_string()];
        fields.extend((5..22).map(|i| i.to_string()));
        fields.push(start.to_string());
        fields.extend((23..30).map(|i| i.to_string()));
        fs::write(
            dir.join("stat"),
            format!("{pid} (node (x) y) {}\n", fields.join(" ")),
        )
        .unwrap();
    }

    fn set(pids: &[u32]) -> HashSet<u32> {
        pids.iter().copied().collect()
    }

    #[test]
    fn parses_proc_stat() {
        let tmp = tempfile::tempdir().unwrap();
        proc_entry(tmp.path(), 10, 7, "12345");
        assert_eq!(proc_stat(tmp.path(), 10), Some((7, "12345".into())));
        assert_eq!(proc_stat(tmp.path(), 11), None);
        // The real stat of this process parses too.
        let me = std::process::id();
        let (ppid, _) = proc_stat(Path::new("/proc"), me).expect("own stat");
        assert!(ppid > 0);
    }

    #[test]
    fn walks_parents_to_a_tab_pid() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // kansei 100 -> tab pty child 200 -> 300 -> 400 (session pid)
        proc_entry(root, 100, 1, "1");
        proc_entry(root, 200, 100, "2");
        proc_entry(root, 300, 200, "3");
        proc_entry(root, 400, 300, "4");
        let tabs = set(&[200, 900]);
        assert_eq!(match_tab(root, 400, None, &tabs), Some(200));
        assert_eq!(match_tab(root, 400, Some("4"), &tabs), Some(200));
        // The session pid is the tab pid itself.
        assert_eq!(match_tab(root, 200, Some("2"), &tabs), Some(200));
        // Stale file: the pid now belongs to a process with another start time.
        assert_eq!(match_tab(root, 400, Some("99"), &tabs), None);
        // Gone, or not under any tab.
        assert_eq!(match_tab(root, 500, None, &tabs), None);
        assert_eq!(match_tab(root, 400, None, &set(&[900])), None);
    }

    #[test]
    fn parent_walk_stops_after_twelve_levels() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Chain 1000 (tab) <- 1001 <- ... <- 1020.
        proc_entry(root, 1000, 1, "s");
        for pid in 1001..=1020 {
            proc_entry(root, pid, pid - 1, "s");
        }
        let tabs = set(&[1000]);
        assert_eq!(match_tab(root, 1012, None, &tabs), Some(1000));
        assert_eq!(match_tab(root, 1013, None, &tabs), None);
    }

    fn assistant(tokens: (u64, u64, u64), model: &str) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":false,"message":{{"model":"{model}","role":"assistant","usage":{{"input_tokens":{},"cache_creation_input_tokens":{},"cache_read_input_tokens":{},"output_tokens":1219}}}},"timestamp":"2026-11-03T10:00:00Z"}}"#,
            tokens.0, tokens.1, tokens.2
        )
    }

    #[test]
    fn usage_takes_the_last_assistant_line() {
        let tail = [
            // Truncated first line of the tail.
            r#"ne":"x","type":"assistant","message":{"usage":{"input_tokens":99999"#.to_owned(),
            assistant((2, 66, 351216), "claude-fable-5-1"),
            assistant((5, 100, 400000), "claude-fable-5-1"),
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#.to_owned(),
            r#"{"type":"assistant","isSidechain":true,"message":{"model":"claude-sonnet","usage":{"input_tokens":1}}}"#.to_owned(),
            r#"{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#.to_owned(),
            r#"{"type":"assistant","message":{"model":"claude-fable-5-1","content":[]}}"#.to_owned(),
            r#"{"type":"system","subtype":"turn_duration"}"#.to_owned(),
            String::new(),
        ]
        .join("\n");
        assert_eq!(
            usage_from_tail(&tail),
            Some(Context {
                tokens: 400105,
                model: Some("claude-fable-5-1".into())
            })
        );
        assert_eq!(usage_from_tail(&tail[..tail.find('\n').unwrap()]), None);
        assert_eq!(
            usage_from_tail(r#"{"type":"user","message":{"usage":{"input_tokens":5}}}"#),
            None
        );
        // Missing counters count as zero; a missing model is None.
        assert_eq!(
            usage_from_tail(r#"{"type":"assistant","message":{"usage":{"input_tokens":7}}}"#),
            Some(Context {
                tokens: 7,
                model: None
            })
        );
    }

    #[test]
    fn transcript_usage_updates_and_keeps_old_values() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        let dir = projects.join(crate::memory::encode("/work/proj"));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{S1}.jsonl"));
        // An early usage line pushed out of the tail by 70 KB of other lines.
        let filler = format!(
            r#"{{"type":"user","message":{{"content":"{}"}}}}"#,
            "x".repeat(1000)
        );
        let mut text = assistant((1, 1, 1), "old") + "\n";
        for _ in 0..70 {
            text.push_str(&filler);
            text.push('\n');
        }
        fs::write(&file, &text).unwrap();

        let mut t = Transcript::default();
        t.refresh(&projects, Some("/work/proj"), S1);
        assert_eq!(t.path.as_deref(), Some(file.as_path()));
        // Not in the last 64 KB: the first read grows its window to find it.
        assert_eq!(t.context.as_ref().map(|c| c.tokens), Some(3));

        text.push_str(&assistant((10, 20, 30), "m1"));
        text.push('\n');
        fs::write(&file, &text).unwrap();
        t.refresh(&projects, Some("/work/proj"), S1);
        assert_eq!(t.context.as_ref().map(|c| c.tokens), Some(60));

        // Growth without a usage line keeps the previous value.
        text.push_str(&filler);
        text.push('\n');
        fs::write(&file, &text).unwrap();
        t.refresh(&projects, Some("/work/proj"), S1);
        assert_eq!(t.context.as_ref().map(|c| c.tokens), Some(60));
    }

    #[test]
    fn transcript_tail_grows_past_one_large_line() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        let dir = projects.join(crate::memory::encode("/w"));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{S1}.jsonl"));
        // Like a real first turn: the reply, then a 140 KB attachment line.
        let big = format!(
            r#"{{"type":"attachment","content":"{}"}}"#,
            "y".repeat(140_000)
        );
        let mut text = assistant((2, 57255, 29137), "claude-fable-5-1") + "\n" + &big + "\n";
        fs::write(&file, &text).unwrap();
        let mut t = Transcript::default();
        t.refresh(&projects, Some("/w"), S1);
        assert_eq!(t.context.as_ref().map(|c| c.tokens), Some(86394));

        // A later growth only looks back to the previous size: an old usage
        // line beyond the first tail is not re-read, the value is kept.
        fs::write(&file, assistant((1, 1, 1), "early") + "\n" + &big + "\n").unwrap();
        let mut t = Transcript {
            size: Some(fs::metadata(&file).unwrap().len()),
            ..Transcript::default()
        };
        text = fs::read_to_string(&file).unwrap() + &big + "\n";
        fs::write(&file, &text).unwrap();
        t.path = Some(file.clone());
        t.refresh(&projects, Some("/w"), S1);
        assert_eq!(t.context, None);
    }

    #[test]
    fn transcript_found_by_name_when_the_guess_misses() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        let dir = projects.join("-somewhere-else");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{S2}.jsonl")),
            assistant((1, 2, 3), "m") + "\n",
        )
        .unwrap();
        let mut t = Transcript::default();
        t.refresh(&projects, Some("/not/this"), S2);
        assert_eq!(t.context.as_ref().map(|c| c.tokens), Some(6));
        assert!(t.last_search.is_some());

        // No transcript anywhere: nothing, and no repeat search right away.
        let mut none = Transcript::default();
        none.refresh(&projects, None, S1);
        assert!(none.path.is_none() && none.context.is_none());
        let first = none.last_search;
        none.refresh(&projects, None, S1);
        assert_eq!(none.last_search, first);
    }

    #[test]
    fn parses_agents_fixture() {
        let got = parse_agents(AGENTS_FIXTURE).unwrap();
        assert_eq!(
            got,
            vec![
                AgentEntry {
                    pid: 2275997,
                    session_id: "69c9ff27-3709-45fa-ae0b-041663d246ac".into(),
                    status: "busy".into(),
                    waiting_for: None,
                },
                AgentEntry {
                    pid: 2275916,
                    session_id: "13721589-df9f-4466-bf8a-5dce3b32ae59".into(),
                    status: "idle".into(),
                    waiting_for: None,
                },
                AgentEntry {
                    pid: 2275943,
                    session_id: "ff65c04f-981b-4278-8699-44dc45e36e43".into(),
                    status: "waiting".into(),
                    waiting_for: Some("permission prompt".into()),
                },
            ]
        );
        assert_eq!(parse_agents("[]").unwrap(), vec![]);
        assert!(parse_agents("not json").is_err());
    }

    struct Fake {
        _tmp: tempfile::TempDir,
        poller: Poller,
        sessions: PathBuf,
        projects: PathBuf,
    }

    fn fake() -> Fake {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let (sessions, projects, proc_root) = (
            base.join("sessions"),
            base.join("projects"),
            base.join("proc"),
        );
        for d in [&sessions, &projects, &proc_root] {
            fs::create_dir_all(d).unwrap();
        }
        // Tab 200 runs session pid 400 (two levels down); tab 210 runs 210 itself.
        proc_entry(&proc_root, 200, 100, "2");
        proc_entry(&proc_root, 300, 200, "3");
        proc_entry(&proc_root, 400, 300, "4");
        proc_entry(&proc_root, 210, 100, "21");
        proc_entry(&proc_root, 100, 1, "1");
        Fake {
            poller: Poller::new(sessions.clone(), projects.clone(), proc_root),
            sessions,
            projects,
            _tmp: tmp,
        }
    }

    fn session_file(f: &Fake, pid: u32, id: &str, status: &str, at: i64, start: &str) {
        fs::write(
            f.sessions.join(format!("{pid}.json")),
            format!(
                r#"{{"pid":{pid},"sessionId":"{id}","cwd":"/work/proj","procStart":"{start}","status":"{status}","statusUpdatedAt":{at},"kind":"interactive"}}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn poll_matches_files_and_applies_waiting() {
        let mut f = fake();
        let tabs = set(&[200, 210]);
        session_file(&f, 400, S1, "busy", 1000, "4");
        session_file(&f, 210, S2, "idle", 900, "21");
        // A stale file for a pid not under any tab.
        session_file(
            &f,
            999,
            "cccccccc-0000-4000-8000-000000000003",
            "busy",
            5,
            "x",
        );
        fs::write(f.sessions.join("401.json"), "{broken").unwrap();
        let dir = f.projects.join(crate::memory::encode("/work/proj"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{S1}.jsonl")),
            assistant((1, 2, 3), "m") + "\n",
        )
        .unwrap();

        let mut asked = Vec::new();
        let list = f.poller.poll(&tabs, &mut |busy| {
            asked.push(busy);
            None
        });
        assert_eq!(asked, vec![true]);
        assert_eq!(list.len(), 2);
        assert_eq!(
            list[0],
            TabActivity {
                pid: 200,
                session_id: S1.into(),
                status: "busy".into(),
                waiting_for: None,
                status_updated_at: 1000,
                context: Some(Context {
                    tokens: 6,
                    model: Some("m".into())
                }),
            }
        );
        assert_eq!((list[1].pid, list[1].status.as_str()), (210, "idle"));
        assert_eq!(list[1].context, None);

        // A waiting agents entry (pid 400 is under tab 200) overrides busy.
        let snap = AgentsSnapshot {
            at_ms: 2000,
            entries: vec![AgentEntry {
                pid: 400,
                session_id: S1.into(),
                status: "waiting".into(),
                waiting_for: Some("permission prompt".into()),
            }],
        };
        let list = f.poller.poll(&tabs, &mut |_| Some(snap.clone()));
        assert_eq!(list[0].status, "waiting");
        assert_eq!(list[0].waiting_for.as_deref(), Some("permission prompt"));

        // A run older than the file's status is stale and ignored.
        let old = AgentsSnapshot {
            at_ms: 500,
            ..snap.clone()
        };
        let list = f.poller.poll(&tabs, &mut |_| Some(old.clone()));
        assert_eq!(list[0].status, "busy");

        // Idle files: agents is not wanted, and waiting never overrides idle.
        session_file(&f, 400, S1, "idle", 3000, "4");
        let mut asked = Vec::new();
        let list = f.poller.poll(&tabs, &mut |busy| {
            asked.push(busy);
            Some(snap.clone())
        });
        assert_eq!(asked, vec![false]);
        assert_eq!(list[0].status, "idle");

        // The file itself can say waiting, with a reason.
        fs::write(
            f.sessions.join("210.json"),
            format!(
                r#"{{"pid":210,"sessionId":"{S2}","procStart":"21","status":"waiting","waitingFor":"input needed","statusUpdatedAt":950}}"#
            ),
        )
        .unwrap();
        let list = f.poller.poll(&tabs, &mut |_| None);
        assert_eq!(list[1].status, "waiting");
        assert_eq!(list[1].waiting_for.as_deref(), Some("input needed"));

        // No tabs: nothing, and agents is told nothing is busy.
        let mut asked = Vec::new();
        let list = f.poller.poll(&HashSet::new(), &mut |busy| {
            asked.push(busy);
            None
        });
        assert!(list.is_empty());
        assert_eq!(asked, vec![false]);
    }

    #[test]
    fn change_detection() {
        let a = TabActivity {
            pid: 1,
            session_id: S1.into(),
            status: "busy".into(),
            waiting_for: None,
            status_updated_at: 1,
            context: None,
        };
        assert!(!changed(&[], &[]));
        assert!(changed(&[], std::slice::from_ref(&a)));
        assert!(changed(std::slice::from_ref(&a), &[]));
        // statusUpdatedAt and model alone do not count.
        let b = TabActivity {
            status_updated_at: 2,
            ..a.clone()
        };
        assert!(!changed(std::slice::from_ref(&a), std::slice::from_ref(&b)));
        let with = |ctx: Option<Context>| TabActivity {
            context: ctx,
            ..a.clone()
        };
        let ctx = |tokens, model: &str| {
            Some(Context {
                tokens,
                model: Some(model.into()),
            })
        };
        assert!(!changed(&[with(ctx(5, "x"))], &[with(ctx(5, "y"))]));
        assert!(changed(&[with(ctx(5, "x"))], &[with(ctx(6, "x"))]));
        assert!(changed(&[with(None)], &[with(ctx(6, "x"))]));
        for patch in [
            TabActivity {
                status: "idle".into(),
                ..a.clone()
            },
            TabActivity {
                waiting_for: Some("input needed".into()),
                ..a.clone()
            },
            TabActivity {
                session_id: S2.into(),
                ..a.clone()
            },
            TabActivity {
                pid: 2,
                ..a.clone()
            },
        ] {
            assert!(changed(std::slice::from_ref(&a), &[patch]));
        }
        // camelCase payload.
        let json = serde_json::to_value(with(ctx(5, "x"))).unwrap();
        for key in [
            "pid",
            "sessionId",
            "status",
            "waitingFor",
            "statusUpdatedAt",
            "context",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert_eq!(json["context"]["tokens"], 5);
    }

    #[test]
    fn notify_argv_prefers_omarchy_and_guards_dashes() {
        let om = Some(PathBuf::from("/o/omarchy-notification-send"));
        let ns = Some(PathBuf::from("/usr/bin/notify-send"));
        assert_eq!(
            notify_argv("kansei", "Permission prompt", om.clone(), ns.clone()),
            Some((
                PathBuf::from("/o/omarchy-notification-send"),
                vec![
                    "-u".into(),
                    "normal".into(),
                    "kansei".into(),
                    "Permission prompt".into()
                ]
            ))
        );
        assert_eq!(
            notify_argv("-u", "a\nb", None, ns.clone()),
            Some((
                PathBuf::from("/usr/bin/notify-send"),
                vec![" -u".into(), "a b".into()]
            ))
        );
        assert_eq!(notify_argv("t", "b", None, None), None);
    }
}
