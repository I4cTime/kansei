//! MCP health (CONTRACT.md "MCP health").
//!
//! Each configured MCP server is probed with a real `initialize` handshake:
//!
//! - stdio: the command is spawned argv-only in its own process group with the
//!   configured env merged over ours (never logged), one JSON-RPC `initialize`
//!   line goes to stdin and stdout is read line by line until a line parses as
//!   JSON with `"id":1`. stderr drains on its own thread into a 2 KB ring that
//!   becomes the detail of a failure or timeout. Whatever happens, the group
//!   gets SIGTERM, then SIGKILL after 1 s, and the child is reaped: a probe
//!   never leaves a server running.
//! - http: `curl` argv-only POSTs the same body; the status code decides
//!   (2xx ok, 401/403 auth, other codes failed, exit 28 timeout). Configured
//!   headers go to curl on stdin (`-H @-`), not on its command line, so their
//!   values (tokens) never show in `ps`.
//!
//! - `${VAR}` and `${VAR:-default}` in command, args, env, url and headers
//!   are expanded from Kansei's environment as Claude Code does; a server that
//!   needs an unset variable is skipped, naming only the variable.
//!
//! Probes run three at a time; each result is emitted as `mcp:health` when it
//! finishes, and the batch is merged into `<appData>/mcp-health.json`.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter};

use crate::files::{app_data_dir, atomic_write, blocking};

/// Every probe child is stopped after this.
pub const TIMEOUT: Duration = Duration::from_secs(8);
/// Between SIGTERM and SIGKILL.
const TERM_GRACE: Duration = Duration::from_secs(1);
/// Probes in flight at once.
const CONCURRENCY: usize = 3;
/// The stderr tail kept for `detail`.
const STDERR_MAX: usize = 2048;
/// stdout read from one stdio server before giving up on it.
const STDOUT_MAX: u64 = 4 * 1024 * 1024;
const PROTOCOL_VERSION: &str = "2025-06-18";
const CACHE_FILE: &str = "mcp-health.json";
const CURL_FALLBACK: &str = "/usr/bin/curl";
/// Serialises read-merge-write of the cache across concurrent checks.
static CACHE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Auth,
    Failed,
    Timeout,
    Skipped,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub version: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    /// `<scope>|<project or ''>|<name>`.
    pub key: String,
    pub status: Status,
    /// stderr tail, HTTP status, spawn error, or why it was skipped.
    pub detail: Option<String>,
    /// Handshake latency; null when nothing ran.
    pub ms: Option<u64>,
    pub server_info: Option<ServerInfo>,
    /// Epoch ms.
    pub checked_at: i64,
}

/// One server to probe: an `McpServer` from `mcp_list`, or a plugin server
/// (scope "plugin", project "<plugin>@<marketplace>") or a claude.ai
/// connector (scope "connector", skipped) built by the front end.
#[derive(Deserialize, Debug, Clone)]
pub struct Target {
    pub scope: String,
    #[serde(default)]
    pub project: Option<String>,
    pub name: String,
    #[serde(default)]
    pub config: Value,
}

pub fn key_of(scope: &str, project: Option<&str>, name: &str) -> String {
    format!("{scope}|{}|{name}", project.unwrap_or(""))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The probe's result before it gets a key and a time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub status: Status,
    pub detail: Option<String>,
    pub ms: Option<u64>,
    pub server_info: Option<ServerInfo>,
}

impl Outcome {
    fn skipped(why: impl Into<String>) -> Self {
        Outcome {
            status: Status::Skipped,
            detail: Some(why.into()),
            ms: None,
            server_info: None,
        }
    }
    fn failed(detail: impl Into<String>, ms: Option<u64>) -> Self {
        Outcome {
            status: Status::Failed,
            detail: Some(detail.into()),
            ms,
            server_info: None,
        }
    }
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum Transport {
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
        cwd: Option<String>,
    },
    Http {
        url: String,
        /// `Name: value` lines.
        headers: Vec<String>,
    },
    Skip(String),
}

fn scalar_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn pairs(v: Option<&Value>) -> Vec<(String, String)> {
    let Some(Value::Object(map)) = v else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(k, v)| scalar_string(v).map(|v| (k.clone(), v)))
        .collect()
}

fn str_field<'a>(config: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    config.get(key).and_then(Value::as_str)
}

/// How a config would be probed, the way the panel's `transportOf` reads it:
/// an explicit `type` first, else `command` means stdio and `url` http.
pub fn transport_of(config: &Value) -> Transport {
    let Value::Object(config) = config else {
        return Transport::Skip("config is not a JSON object".into());
    };
    let kind = match str_field(config, "type") {
        Some(t) => t.to_string(),
        None if config.get("command").is_some() => "stdio".into(),
        None if config.get("url").is_some() => "http".into(),
        None => return Transport::Skip("no command or url in the config".into()),
    };
    match kind.as_str() {
        "stdio" => {
            let command = str_field(config, "command")
                .unwrap_or("")
                .trim()
                .to_string();
            if command.is_empty() {
                return Transport::Skip("command is empty".into());
            }
            let args = match config.get("args") {
                Some(Value::Array(xs)) => xs
                    .iter()
                    .map(|x| scalar_string(x).unwrap_or_else(|| x.to_string()))
                    .collect(),
                _ => Vec::new(),
            };
            let cwd = str_field(config, "cwd")
                .filter(|c| !c.trim().is_empty())
                .map(str::to_string);
            Transport::Stdio {
                command,
                args,
                env: pairs(config.get("env")),
                cwd,
            }
        }
        "http" | "streamable-http" => {
            let url = str_field(config, "url").unwrap_or("").trim().to_string();
            if url.is_empty() {
                return Transport::Skip("url is empty".into());
            }
            let headers = pairs(config.get("headers"))
                .into_iter()
                .map(|(k, v)| format!("{k}: {}", v.replace(['\r', '\n'], " ")))
                .collect();
            Transport::Http { url, headers }
        }
        "sse" => Transport::Skip("sse transport: not probed (no single request/answer)".into()),
        other => Transport::Skip(format!("unknown transport \"{other}\"")),
    }
}

/// `${NAME}` and `${NAME:-default}` replaced the way Claude Code expands
/// them in MCP configs (command, args, env, url, headers), from `lookup`.
/// Names that are unset (and have no default) are pushed to `missing`.
pub fn expand(
    s: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
    missing: &mut Vec<String>,
) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find("${") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[at..]);
            return out;
        };
        let inner = &after[..end];
        let (name, default) = match inner.split_once(":-") {
            Some((n, d)) => (n, Some(d)),
            None => (inner, None),
        };
        let valid = !name.is_empty()
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !name.starts_with(|c: char| c.is_ascii_digit());
        if !valid {
            out.push_str(&rest[at..at + 3 + end]);
        } else {
            match (lookup(name), default) {
                (Some(v), Some(d)) if v.is_empty() => out.push_str(d),
                (Some(v), _) => out.push_str(&v),
                (None, Some(d)) => out.push_str(d),
                (None, None) => {
                    if !missing.iter().any(|m| m == name) {
                        missing.push(name.to_string());
                    }
                }
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// `t` with every `${VAR}` expanded; skipped (naming the variables, never
/// their values) when one is not set in Kansei's environment.
pub fn expand_transport(t: Transport, lookup: &dyn Fn(&str) -> Option<String>) -> Transport {
    let mut missing = Vec::new();
    let mut x = |s: &str| expand(s, lookup, &mut missing);
    let t = match t {
        Transport::Stdio {
            command,
            args,
            env,
            cwd,
        } => Transport::Stdio {
            command: x(&command),
            args: args.iter().map(|a| x(a)).collect(),
            env: env.iter().map(|(k, v)| (k.clone(), x(v))).collect(),
            cwd: cwd.as_deref().map(&mut x),
        },
        Transport::Http { url, headers } => Transport::Http {
            url: x(&url),
            headers: headers.iter().map(|h| x(h)).collect(),
        },
        skip => skip,
    };
    if missing.is_empty() {
        return t;
    }
    let names: Vec<String> = missing.iter().map(|m| format!("${{{m}}}")).collect();
    Transport::Skip(format!(
        "uses {}, not set in Kansei's environment (Claude Code may get it from its launcher)",
        names.join(", ")
    ))
}

// ---------------------------------------------------------------------------
// process handling
// ---------------------------------------------------------------------------

/// True once the child has exited, without reaping it: the zombie keeps its
/// pid (and so its process group id) reserved until `wait`.
fn exited_nowait(pid: u32) -> bool {
    // SAFETY: waitid with WNOWAIT only inspects our own child; the zeroed
    // siginfo_t is plain data that waitid fills in.
    unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        let r = libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        );
        r == 0 && info.si_pid() != 0
    }
}

/// SIGTERM to the child's process group, SIGKILL after `TERM_GRACE`, then
/// reap. The leader is not reaped before the SIGKILL, so the group id cannot
/// have been reused by then.
fn stop(child: &mut Child) -> Option<ExitStatus> {
    let pgid = child.id() as libc::pid_t;
    // SAFETY: plain kill(2) on the process group of a child we spawned with
    // process_group(0) and have not reaped yet.
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }
    let deadline = Instant::now() + TERM_GRACE;
    while Instant::now() < deadline && !exited_nowait(child.id()) {
        thread::sleep(Duration::from_millis(20));
    }
    // SAFETY: as above; grandchildren that ignored SIGTERM go too.
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
    let _ = child.kill();
    child.wait().ok()
}

/// Keeps the last `STDERR_MAX` bytes of a stream; `done` fires at EOF.
fn drain_tail(
    mut stream: impl Read + Send + 'static,
) -> (Arc<Mutex<VecDeque<u8>>>, mpsc::Receiver<()>) {
    let ring = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_MAX)));
    let (tx, rx) = mpsc::channel();
    let r = ring.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = stream.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut ring = r.lock().unwrap_or_else(|p| p.into_inner());
            ring.extend(&buf[..n]);
            let excess = ring.len().saturating_sub(STDERR_MAX);
            ring.drain(..excess);
        }
        let _ = tx.send(());
    });
    (ring, rx)
}

/// The tail as text, after the reader finished (or a short wait for it).
fn tail_text(ring: &Arc<Mutex<VecDeque<u8>>>, done: &mpsc::Receiver<()>) -> String {
    let _ = done.recv_timeout(Duration::from_millis(300));
    let ring = ring.lock().unwrap_or_else(|p| p.into_inner());
    let bytes: Vec<u8> = ring.iter().copied().collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn elapsed_ms(start: Instant) -> Option<u64> {
    Some(start.elapsed().as_millis() as u64)
}

pub fn initialize_body(version: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "kansei", "version": version }
        }
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

enum Line {
    Answer(Value),
    Eof,
}

/// What an `"id":1` answer says.
fn outcome_of_answer(v: &Value, ms: Option<u64>) -> Outcome {
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| err.to_string());
        return Outcome::failed(format!("initialize error: {msg}"), ms);
    }
    let server_info = v
        .get("result")
        .and_then(|r| r.get("serverInfo"))
        .and_then(|i| {
            let name = i.get("name").and_then(Value::as_str)?.to_string();
            let version = i.get("version").and_then(scalar_string);
            Some(ServerInfo { name, version })
        });
    Outcome {
        status: Status::Ok,
        detail: None,
        ms,
        server_info,
    }
}

pub fn probe_stdio(
    command: &str,
    args: &[String],
    env: &[(String, String)],
    cwd: Option<&str>,
    body: &str,
    timeout: Duration,
) -> Outcome {
    let start = Instant::now();
    let mut cmd = Command::new(command);
    cmd.args(args)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Outcome::failed(format!("could not start {command}: {e}"), None),
    };
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        stop(&mut child);
        return Outcome::failed("no stdio pipes", None);
    };
    let (ring, stderr_done) = drain_tail(stderr);

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout.take(STDOUT_MAX));
        for line in reader.split(b'\n') {
            let Ok(line) = line else { break };
            let Ok(v) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if v.get("id") == Some(&json!(1)) {
                let _ = tx.send(Line::Answer(v));
                return;
            }
        }
        let _ = tx.send(Line::Eof);
    });

    // A server that already exited makes this fail with EPIPE; the stdout
    // reader then reports EOF.
    let _ = stdin
        .write_all(format!("{body}\n").as_bytes())
        .and_then(|_| stdin.flush());

    let got = rx.recv_timeout(timeout);
    let ms = elapsed_ms(start);
    drop(stdin);
    let exit = stop(&mut child);
    match got {
        Ok(Line::Answer(v)) => outcome_of_answer(&v, ms),
        Ok(Line::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => {
            let tail = tail_text(&ring, &stderr_done);
            let why = match exit {
                Some(s) if ms.is_some_and(|m| m < timeout.as_millis() as u64) => {
                    format!("exited ({s}) before answering initialize")
                }
                _ => "closed stdout before answering initialize".into(),
            };
            Outcome::failed(if tail.is_empty() { why } else { tail }, ms)
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let tail = tail_text(&ring, &stderr_done);
            Outcome {
                status: Status::Timeout,
                detail: Some(if tail.is_empty() {
                    format!("no answer to initialize within {} s", timeout.as_secs())
                } else {
                    tail
                }),
                ms,
                server_info: None,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

/// curl's argv (without the program). Headers come on stdin when `stdin_headers`.
pub fn curl_args(url: &str, body: &str, timeout: Duration, stdin_headers: bool) -> Vec<String> {
    let mut a: Vec<String> = [
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-m",
        &timeout.as_secs().to_string(),
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-H",
        "Accept: application/json, text/event-stream",
        "--data",
        body,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if stdin_headers {
        a.extend(["-H".into(), "@-".into()]);
    }
    a.extend(["--url".into(), url.to_string()]);
    a
}

/// Status from curl's exit code, the `%{http_code}` it printed and its stderr.
pub fn http_outcome(exit: Option<i32>, code: &str, stderr: &str) -> (Status, Option<String>) {
    let stderr = stderr.trim();
    match exit {
        Some(0) => match code.trim().parse::<u16>() {
            Ok(c @ 200..=299) => (Status::Ok, Some(format!("HTTP {c}"))),
            Ok(c @ (401 | 403)) => (
                Status::Auth,
                Some(format!("HTTP {c}: reachable, needs sign-in")),
            ),
            Ok(c) => (Status::Failed, Some(format!("HTTP {c}"))),
            Err(_) => (
                Status::Failed,
                Some(format!("no HTTP status from curl ({})", code.trim())),
            ),
        },
        Some(28) => (
            Status::Timeout,
            Some(if stderr.is_empty() {
                "curl: timed out".into()
            } else {
                stderr.to_string()
            }),
        ),
        Some(n) => (
            Status::Failed,
            Some(if stderr.is_empty() {
                format!("curl exited with {n}")
            } else {
                stderr.to_string()
            }),
        ),
        None => (
            Status::Failed,
            Some(if stderr.is_empty() {
                "curl was killed".into()
            } else {
                stderr.to_string()
            }),
        ),
    }
}

pub fn probe_http(
    curl: &Path,
    url: &str,
    headers: &[String],
    body: &str,
    timeout: Duration,
) -> Outcome {
    let start = Instant::now();
    let stdin_headers = !headers.is_empty();
    let mut child = match Command::new(curl)
        .args(curl_args(url, body, timeout, stdin_headers))
        .stdin(if stdin_headers {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Outcome::failed(format!("could not start curl: {e}"), None),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let mut text = headers.join("\n");
        text.push('\n');
        let _ = stdin.write_all(text.as_bytes());
    }
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        stop(&mut child);
        return Outcome::failed("no curl pipes", None);
    };
    let (out_ring, out_done) = drain_tail(stdout);
    let (err_ring, err_done) = drain_tail(stderr);
    // curl stops itself after `-m`; this is the backstop.
    let deadline = start + timeout + Duration::from_secs(2);
    let mut killed = false;
    let exit = loop {
        if exited_nowait(child.id()) {
            break child.wait().ok();
        }
        if Instant::now() >= deadline {
            killed = true;
            break stop(&mut child);
        }
        thread::sleep(Duration::from_millis(20));
    };
    let ms = elapsed_ms(start);
    let code = tail_text(&out_ring, &out_done);
    let err = tail_text(&err_ring, &err_done);
    if killed {
        return Outcome {
            status: Status::Timeout,
            detail: Some(format!("no answer within {} s", timeout.as_secs())),
            ms,
            server_info: None,
        };
    }
    let (status, detail) = http_outcome(exit.and_then(|s| s.code()), &code, &err);
    Outcome {
        status,
        detail,
        ms,
        server_info: None,
    }
}

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

/// What every probe in a batch shares.
pub struct Probe {
    pub timeout: Duration,
    /// None when curl is not installed: http servers are skipped.
    pub curl: Option<PathBuf>,
    pub body: String,
}

impl Probe {
    pub fn new(timeout: Duration) -> Self {
        let curl = crate::activity::in_path("curl").or_else(|| {
            Some(PathBuf::from(CURL_FALLBACK)).filter(|p| crate::activity::is_executable(p))
        });
        Probe {
            timeout,
            curl,
            body: initialize_body(env!("CARGO_PKG_VERSION")),
        }
    }
}

pub fn probe(t: &Target, p: &Probe) -> McpHealth {
    let key = key_of(&t.scope, t.project.as_deref(), &t.name);
    let out = if t.scope == "connector" {
        Outcome::skipped("claude.ai connector: no transport Kansei can probe")
    } else {
        let env = |name: &str| std::env::var(name).ok();
        match expand_transport(transport_of(&t.config), &env) {
            Transport::Skip(why) => Outcome::skipped(why),
            Transport::Stdio {
                command,
                args,
                env,
                cwd,
            } => probe_stdio(&command, &args, &env, cwd.as_deref(), &p.body, p.timeout),
            Transport::Http { url, headers } => match &p.curl {
                Some(curl) => probe_http(curl, &url, &headers, &p.body, p.timeout),
                None => Outcome::skipped("curl not found"),
            },
        }
    };
    McpHealth {
        key,
        status: out.status,
        detail: out.detail,
        ms: out.ms,
        server_info: out.server_info,
        checked_at: now_ms(),
    }
}

/// Probe `targets` `CONCURRENCY` at a time, calling `emit` as each finishes.
/// Results come back in input order.
pub fn check_all(
    targets: Vec<Target>,
    p: &Probe,
    emit: &(dyn Fn(&McpHealth) + Sync),
) -> Vec<McpHealth> {
    let n = targets.len();
    let queue = Mutex::new(targets.into_iter().enumerate().collect::<VecDeque<_>>());
    let results: Mutex<Vec<Option<McpHealth>>> = Mutex::new(vec![None; n]);
    thread::scope(|s| {
        for _ in 0..CONCURRENCY.min(n) {
            s.spawn(|| {
                loop {
                    let next = queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front();
                    let Some((i, t)) = next else { break };
                    let h = probe(&t, p);
                    emit(&h);
                    results.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(h);
                }
            });
        }
    });
    results
        .into_inner()
        .unwrap_or_else(|e| e.into_inner())
        .into_iter()
        .flatten()
        .collect()
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct CacheFile {
    #[serde(default)]
    results: Map<String, Value>,
}

/// Entries of `<dir>/mcp-health.json`; a missing or malformed file is empty.
pub fn read_cache(dir: &Path) -> Vec<McpHealth> {
    let Ok(text) = fs::read_to_string(dir.join(CACHE_FILE)) else {
        return Vec::new();
    };
    let Ok(file) = serde_json::from_str::<CacheFile>(&text) else {
        return Vec::new();
    };
    file.results
        .into_iter()
        .filter_map(|(_, v)| serde_json::from_value(v).ok())
        .collect()
}

/// Merge `fresh` into `<dir>/mcp-health.json` by key; earlier keys stay.
pub fn merge_cache(dir: &Path, fresh: &[McpHealth]) -> Result<(), String> {
    let _guard = CACHE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = dir.join(CACHE_FILE);
    let mut file = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<CacheFile>(&t).ok())
        .unwrap_or_default();
    for h in fresh {
        let v = serde_json::to_value(h).map_err(|e| format!("mcp-health.json: {e}"))?;
        file.results.insert(h.key.clone(), v);
    }
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("mcp-health.json: {e}"))?;
    atomic_write(&path, format!("{text}\n").as_bytes(), Some(0o644))
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn mcp_health_check(
    app: AppHandle,
    servers: Vec<Target>,
) -> Result<Vec<McpHealth>, String> {
    blocking(move || {
        let probe = Probe::new(TIMEOUT);
        let emit = |h: &McpHealth| {
            if let Err(e) = app.emit("mcp:health", h) {
                crate::watchdog::note(&format!("mcp health: emit failed: {e}"));
            }
        };
        let out = check_all(servers, &probe, &emit);
        if let Err(e) = app_data_dir().and_then(|dir| merge_cache(&dir, &out)) {
            crate::watchdog::note(&format!("mcp health: {e}"));
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn mcp_health_cached() -> Result<Vec<McpHealth>, String> {
    blocking(|| Ok(read_cache(&app_data_dir()?))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    const SHORT: Duration = Duration::from_secs(2);

    fn body() -> String {
        initialize_body("9.9.9")
    }

    /// A fake server: `/bin/sh <script>` (no exec of the fresh file, so no ETXTBSY).
    fn script(dir: &Path, name: &str, text: &str) -> Vec<String> {
        let p = dir.join(name);
        fs::write(&p, text).unwrap();
        vec![p.to_string_lossy().into_owned()]
    }

    fn pid_in(path: &Path) -> u32 {
        for _ in 0..100 {
            if let Ok(t) = fs::read_to_string(path)
                && let Ok(pid) = t.trim().parse()
            {
                return pid;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("no pid in {}", path.display());
    }

    /// Gone, or a zombie waiting for init to reap it.
    fn gone(pid: u32) -> bool {
        for _ in 0..100 {
            match fs::read_to_string(format!("/proc/{pid}/stat")) {
                Err(_) => return true,
                Ok(s) => {
                    let state = s
                        .rsplit_once(')')
                        .map(|(_, r)| r.trim_start().chars().next());
                    if state == Some(Some('Z')) || state == Some(Some('X')) {
                        return true;
                    }
                }
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn key_format() {
        assert_eq!(key_of("user", None, "godot"), "user||godot");
        assert_eq!(
            key_of("project", Some("/home/me/x"), "db"),
            "project|/home/me/x|db"
        );
        let t: Target = serde_json::from_value(json!({
            "scope": "plugin", "project": "qring@q-ring", "name": "q-ring", "config": {}
        }))
        .unwrap();
        let h = probe(&t, &Probe::new(SHORT));
        assert_eq!(h.key, "plugin|qring@q-ring|q-ring");
        assert_eq!(h.status, Status::Skipped);
    }

    #[test]
    fn initialize_line_shape() {
        let v: Value = serde_json::from_str(&body()).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["method"], "initialize");
        assert_eq!(v["params"]["protocolVersion"], "2025-06-18");
        assert_eq!(v["params"]["clientInfo"]["name"], "kansei");
        assert_eq!(v["params"]["clientInfo"]["version"], "9.9.9");
        assert!(!body().contains('\n'));
    }

    #[test]
    fn transports() {
        assert!(matches!(
            transport_of(&json!({ "command": "npx", "args": ["-y", "x"], "env": { "A": "1", "N": 2 } })),
            Transport::Stdio { ref command, ref args, ref env, cwd: None }
                if command == "npx" && args == &["-y", "x"] && env == &[("A".into(), "1".into()), ("N".into(), "2".into())]
        ));
        // q-ring's plugin writes "env": [].
        assert!(matches!(
            transport_of(&json!({ "type": "stdio", "command": "qring-mcp", "args": [], "env": [] })),
            Transport::Stdio { ref env, .. } if env.is_empty()
        ));
        assert_eq!(
            transport_of(&json!({ "type": "stdio", "command": "  " })),
            Transport::Skip("command is empty".into())
        );
        assert_eq!(
            transport_of(
                &json!({ "type": "http", "url": "https://x/mcp", "headers": { "Authorization": "Bearer t" } })
            ),
            Transport::Http {
                url: "https://x/mcp".into(),
                headers: vec!["Authorization: Bearer t".into()]
            }
        );
        assert!(matches!(
            transport_of(&json!({ "url": "https://x" })),
            Transport::Http { .. }
        ));
        assert!(matches!(
            transport_of(&json!({ "type": "sse", "url": "https://x" })),
            Transport::Skip(_)
        ));
        assert_eq!(
            transport_of(&json!({ "type": "ws", "url": "wss://x" })),
            Transport::Skip("unknown transport \"ws\"".into())
        );
        assert!(matches!(transport_of(&json!({})), Transport::Skip(_)));
        assert!(matches!(transport_of(&json!("x")), Transport::Skip(_)));
    }

    #[test]
    fn expands_env_placeholders_like_claude_code() {
        let lookup = |n: &str| match n {
            "TOKEN" => Some("t0k".to_string()),
            "EMPTY" => Some(String::new()),
            _ => None,
        };
        let mut missing = Vec::new();
        assert_eq!(
            expand("Bearer ${TOKEN}", &lookup, &mut missing),
            "Bearer t0k"
        );
        assert_eq!(
            expand("${NOPE:-dflt}/${EMPTY:-e}/${EMPTY}", &lookup, &mut missing),
            "dflt/e/"
        );
        assert_eq!(
            expand("$TOKEN ${1X} ${} ${open", &lookup, &mut missing),
            "$TOKEN ${1X} ${} ${open"
        );
        assert!(missing.is_empty());
        assert_eq!(expand("a${NOPE}b${NOPE}", &lookup, &mut missing), "ab");
        assert_eq!(missing, ["NOPE"]);

        let http = transport_of(
            &json!({ "type": "http", "url": "https://x/${NOPE:-mcp}", "headers": { "Authorization": "Bearer ${TOKEN}" } }),
        );
        assert_eq!(
            expand_transport(http, &lookup),
            Transport::Http {
                url: "https://x/mcp".into(),
                headers: vec!["Authorization: Bearer t0k".into()]
            }
        );
        let stdio = transport_of(
            &json!({ "command": "${HOME_BIN:-/bin}/sh", "args": ["${TOKEN}"], "env": { "K": "${TOKEN}" } }),
        );
        assert_eq!(
            expand_transport(stdio, &lookup),
            Transport::Stdio {
                command: "/bin/sh".into(),
                args: vec!["t0k".into()],
                env: vec![("K".into(), "t0k".into())],
                cwd: None
            }
        );
        let unset = transport_of(
            &json!({ "url": "https://x", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } }),
        );
        let Transport::Skip(why) = expand_transport(unset, &lookup) else {
            panic!("not skipped")
        };
        assert!(why.starts_with("uses ${GITHUB_TOKEN}, not set"), "{why}");
    }

    #[test]
    fn stdio_ok_reads_server_info_and_stops_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let pidf = dir.path().join("pid");
        let reqf = dir.path().join("req");
        let envf = dir.path().join("env");
        let args = script(
            dir.path(),
            "ok.sh",
            &format!(
                "echo $$ > '{}'\nIFS= read -r line\nprintf '%s' \"$line\" > '{}'\nprintf '%s' \"$FAKE_TOKEN\" > '{}'\n\
                 echo 'starting up (log line on stdout)'\n\
                 echo '{{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}}'\n\
                 echo '{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{{}},\"serverInfo\":{{\"name\":\"fake\",\"version\":\"1.2.3\"}}}}}}'\n\
                 sleep 30\n",
                pidf.display(),
                reqf.display(),
                envf.display()
            ),
        );
        let env = vec![("FAKE_TOKEN".to_string(), "s3cret".to_string())];
        let out = probe_stdio(
            "/bin/sh",
            &args,
            &env,
            Some(dir.path().to_str().unwrap()),
            &body(),
            SHORT,
        );
        assert_eq!(out.status, Status::Ok, "{out:?}");
        assert_eq!(
            out.server_info,
            Some(ServerInfo {
                name: "fake".into(),
                version: Some("1.2.3".into())
            })
        );
        assert!(out.ms.is_some());
        assert_eq!(fs::read_to_string(&reqf).unwrap(), body());
        assert_eq!(fs::read_to_string(&envf).unwrap(), "s3cret");
        assert!(gone(pid_in(&pidf)), "the server is still running");
    }

    #[test]
    fn stdio_error_answer_is_failed_with_the_message() {
        let dir = tempfile::tempdir().unwrap();
        let args = script(
            dir.path(),
            "err.sh",
            "read -r line\necho '{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32602,\"message\":\"unsupported protocol\"}}'\n",
        );
        let out = probe_stdio("/bin/sh", &args, &[], None, &body(), SHORT);
        assert_eq!(out.status, Status::Failed);
        assert_eq!(
            out.detail.as_deref(),
            Some("initialize error: unsupported protocol")
        );
    }

    #[test]
    fn stdio_exit_1_keeps_the_stderr_tail() {
        let dir = tempfile::tempdir().unwrap();
        let args = script(
            dir.path(),
            "fail.sh",
            "i=0\nwhile [ $i -lt 200 ]; do echo \"noise line $i\" >&2; i=$((i+1)); done\necho 'Error: GODOT_PATH is not set' >&2\nexit 1\n",
        );
        let out = probe_stdio("/bin/sh", &args, &[], None, &body(), SHORT);
        assert_eq!(out.status, Status::Failed);
        let detail = out.detail.unwrap();
        assert!(detail.ends_with("Error: GODOT_PATH is not set"), "{detail}");
        assert!(detail.len() <= STDERR_MAX, "{}", detail.len());
        assert!(!detail.contains("noise line 0\n"));
    }

    #[test]
    fn stdio_silent_exit_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let args = script(dir.path(), "quiet.sh", "exit 3\n");
        let out = probe_stdio("/bin/sh", &args, &[], None, &body(), SHORT);
        assert_eq!(out.status, Status::Failed);
        assert!(out.detail.unwrap().contains("before answering"));
    }

    #[test]
    fn stdio_timeout_kills_the_whole_group() {
        let dir = tempfile::tempdir().unwrap();
        let pidf = dir.path().join("pid");
        let kidf = dir.path().join("kid");
        // Ignores SIGTERM (and so does its child), so only SIGKILL ends them.
        let args = script(
            dir.path(),
            "hang.sh",
            &format!(
                "trap '' TERM\necho $$ > '{}'\nsleep 30 &\necho $! > '{}'\necho 'still loading' >&2\nwait\n",
                pidf.display(),
                kidf.display()
            ),
        );
        let started = Instant::now();
        let out = probe_stdio("/bin/sh", &args, &[], None, &body(), Duration::from_secs(1));
        assert_eq!(out.status, Status::Timeout);
        assert_eq!(out.detail.as_deref(), Some("still loading"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(gone(pid_in(&pidf)), "the server is still running");
        assert!(gone(pid_in(&kidf)), "the server's child is still running");
    }

    #[test]
    fn stdio_missing_binary_is_failed_with_the_os_error() {
        let out = probe_stdio(
            "/nonexistent/kansei-no-such-server",
            &[],
            &[],
            None,
            &body(),
            SHORT,
        );
        assert_eq!(out.status, Status::Failed);
        let d = out.detail.unwrap();
        assert!(
            d.starts_with("could not start /nonexistent/kansei-no-such-server"),
            "{d}"
        );
        assert!(d.contains("No such file"), "{d}");
    }

    #[test]
    fn http_status_mapping() {
        assert_eq!(http_outcome(Some(0), "200", "").0, Status::Ok);
        assert_eq!(http_outcome(Some(0), "202", "").0, Status::Ok);
        assert_eq!(
            http_outcome(Some(0), "401", ""),
            (
                Status::Auth,
                Some("HTTP 401: reachable, needs sign-in".into())
            )
        );
        assert_eq!(http_outcome(Some(0), "403", "").0, Status::Auth);
        assert_eq!(
            http_outcome(Some(0), "404", ""),
            (Status::Failed, Some("HTTP 404".into()))
        );
        assert_eq!(http_outcome(Some(0), "500", "").0, Status::Failed);
        assert_eq!(
            http_outcome(
                Some(28),
                "000",
                "curl: (28) Operation timed out after 8001 ms\n"
            ),
            (
                Status::Timeout,
                Some("curl: (28) Operation timed out after 8001 ms".into())
            )
        );
        assert_eq!(
            http_outcome(
                Some(6),
                "000",
                "curl: (6) Could not resolve host: nope.invalid"
            ),
            (
                Status::Failed,
                Some("curl: (6) Could not resolve host: nope.invalid".into())
            )
        );
        assert_eq!(
            http_outcome(Some(7), "000", ""),
            (Status::Failed, Some("curl exited with 7".into()))
        );
    }

    #[test]
    fn curl_argv_keeps_headers_off_the_command_line() {
        let a = curl_args("https://x/mcp", &body(), TIMEOUT, true);
        assert_eq!(
            &a[..7],
            &["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-m", "8"]
        );
        assert!(a.windows(2).any(|w| w == ["-H", "@-"]));
        assert_eq!(&a[a.len() - 2..], &["--url", "https://x/mcp"]);
        assert!(!curl_args("https://x", &body(), TIMEOUT, false).contains(&"@-".to_string()));
    }

    /// End to end through the real curl against a local listener answering 401.
    #[test]
    fn http_probe_against_a_local_server() {
        let probe = Probe::new(SHORT);
        let Some(curl) = probe.curl.clone() else {
            eprintln!("curl not installed; skipping");
            return;
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            sock.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = sock.read(&mut buf) {
                if n == 0 {
                    break;
                }
                req.extend(&buf[..n]);
                if String::from_utf8_lossy(&req).contains("\"initialize\"") {
                    break;
                }
            }
            sock.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            String::from_utf8_lossy(&req).into_owned()
        });
        let out = probe_http(
            &curl,
            &format!("http://127.0.0.1:{port}/mcp"),
            &["X-Test-Token: abc123".into()],
            &probe.body,
            SHORT,
        );
        let req = server.join().unwrap();
        assert_eq!(out.status, Status::Auth, "{out:?}");
        assert!(req.starts_with("POST /mcp"), "{req}");
        assert!(req.contains("X-Test-Token: abc123"), "{req}");
        assert!(
            req.contains("Accept: application/json, text/event-stream"),
            "{req}"
        );
        assert!(req.contains("\"clientInfo\""), "{req}");
    }

    #[test]
    fn batch_runs_everything_and_emits_each() {
        let dir = tempfile::tempdir().unwrap();
        let ok = script(
            dir.path(),
            "ok.sh",
            "read -r line\necho '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"f\"}}}'\n",
        );
        let targets: Vec<Target> = (0..5)
            .map(|i| Target {
                scope: "user".into(),
                project: None,
                name: format!("s{i}"),
                config: json!({ "command": "/bin/sh", "args": ok }),
            })
            .chain([Target {
                scope: "connector".into(),
                project: None,
                name: "claude.ai Docs".into(),
                config: Value::Null,
            }])
            .collect();
        let seen = Mutex::new(Vec::new());
        let out = check_all(targets, &Probe::new(SHORT), &|h| {
            seen.lock().unwrap().push(h.key.clone())
        });
        assert_eq!(
            out.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(),
            [
                "user||s0",
                "user||s1",
                "user||s2",
                "user||s3",
                "user||s4",
                "connector||claude.ai Docs"
            ]
        );
        assert!(out[..5].iter().all(|h| h.status == Status::Ok));
        assert_eq!(out[5].status, Status::Skipped);
        assert_eq!(seen.lock().unwrap().len(), 6);
    }

    fn health(key: &str, status: Status) -> McpHealth {
        McpHealth {
            key: key.into(),
            status,
            detail: None,
            ms: Some(5),
            server_info: None,
            checked_at: 1,
        }
    }

    #[test]
    fn cache_merges_by_key() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_cache(dir.path()).is_empty());
        merge_cache(
            dir.path(),
            &[
                health("user||a", Status::Ok),
                health("user||b", Status::Failed),
            ],
        )
        .unwrap();
        merge_cache(
            dir.path(),
            &[
                health("user||b", Status::Ok),
                health("plugin|p@m|c", Status::Auth),
            ],
        )
        .unwrap();
        let mut got = read_cache(dir.path());
        got.sort_by(|a, b| a.key.cmp(&b.key));
        assert_eq!(
            got.iter()
                .map(|h| (h.key.as_str(), h.status))
                .collect::<Vec<_>>(),
            [
                ("plugin|p@m|c", Status::Auth),
                ("user||a", Status::Ok),
                ("user||b", Status::Ok)
            ]
        );
        let raw: Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join(CACHE_FILE)).unwrap())
                .unwrap();
        assert_eq!(raw["results"]["user||a"]["checkedAt"], 1);
        assert_eq!(raw["results"]["user||a"]["serverInfo"], Value::Null);
        // A malformed file reads as empty and is replaced on the next merge.
        fs::write(dir.path().join(CACHE_FILE), "{ nope").unwrap();
        assert!(read_cache(dir.path()).is_empty());
        merge_cache(dir.path(), &[health("user||a", Status::Timeout)]).unwrap();
        assert_eq!(read_cache(dir.path()).len(), 1);
    }
}
