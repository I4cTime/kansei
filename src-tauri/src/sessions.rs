//! Claude Code sessions (CONTRACT.md "Sessions").
//!
//! Read-only union of three sources:
//! - `~/.claude/history.jsonl`: one line per prompt `{ display, timestamp, project, sessionId }`;
//! - `~/.claude/sessions/<pid>.json`: live sessions, kept only while the pid runs;
//! - `~/.claude/projects/<encoded>/<sessionId>.jsonl`: transcripts (metadata only,
//!   their contents are never read).

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::files::{blocking, claude_dir};
use crate::memory::decode_project_path;

/// Title used when no prompt for the session is in history.jsonl.
pub const NO_PROMPT_TITLE: &str = "(no prompt recorded)";
const TITLE_MAX_CHARS: usize = 120;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveInfo {
    pid: u32,
    status: Option<String>,
    name: Option<String>,
    cwd: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    id: String,
    project: Option<String>,
    title: String,
    first_ts: Option<i64>,
    last_ts: i64,
    prompts: u32,
    transcript_path: Option<String>,
    transcript_bytes: u64,
    live: Option<LiveInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLine {
    display: Option<String>,
    timestamp: Option<i64>,
    project: Option<String>,
    session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveFile {
    pid: Option<u32>,
    session_id: Option<String>,
    cwd: Option<String>,
    started_at: Option<i64>,
    updated_at: Option<i64>,
    status: Option<String>,
    name: Option<String>,
    proc_start: Option<String>,
}

#[derive(Default)]
struct HistoryAgg {
    title: Option<String>,
    first_ts: Option<i64>,
    last_ts: Option<i64>,
    prompts: u32,
    project: Option<String>,
}

struct Transcript {
    path: String,
    bytes: u64,
    mtime_ms: i64,
    project: Option<String>,
}

struct Live {
    info: LiveInfo,
    ts: Option<i64>,
}

/// `8-4-4-4-12` hex with hyphens.
fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Collapse whitespace and cap at TITLE_MAX_CHARS characters.
fn make_title(display: &str) -> Option<String> {
    let collapsed = display.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(TITLE_MAX_CHARS).collect())
}

fn read_history(path: &Path) -> HashMap<String, HistoryAgg> {
    let mut out: HashMap<String, HistoryAgg> = HashMap::new();
    let Ok(file) = fs::File::open(path) else {
        return out;
    };
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(h) = serde_json::from_str::<HistoryLine>(&line) else {
            continue;
        };
        let Some(id) = h.session_id.filter(|s| !s.is_empty()) else {
            continue;
        };
        let agg = out.entry(id).or_default();
        agg.prompts += 1;
        if let Some(ts) = h.timestamp {
            // The title is the earliest prompt with any text.
            let earliest = agg.first_ts.is_none_or(|f| ts < f);
            if let Some(t) = h.display.as_deref().and_then(make_title)
                && (agg.title.is_none() || earliest)
            {
                agg.title = Some(t);
            }
            agg.first_ts = Some(agg.first_ts.map_or(ts, |f| f.min(ts)));
            agg.last_ts = Some(agg.last_ts.map_or(ts, |l| l.max(ts)));
        } else if agg.title.is_none() {
            agg.title = h.display.as_deref().and_then(make_title);
        }
        if let Some(p) = h.project.filter(|p| !p.is_empty()) {
            agg.project = Some(p);
        }
    }
    out
}

/// `/proc/<pid>/stat` field 22 (process start time in clock ticks).
fn proc_start_time(pid: u32) -> Option<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm (field 2) may contain spaces and parens; fields after it start at 3.
    let after = &stat[stat.rfind(')')? + 1..];
    after.split_whitespace().nth(22 - 3).map(str::to_owned)
}

/// A pid is ours if it runs and, when the file recorded one, its start time
/// matches (guards against pid reuse after a crash left a stale file).
pub fn pid_is_running(pid: u32, proc_start: Option<&str>) -> bool {
    if !Path::new(&format!("/proc/{pid}")).exists() {
        return false;
    }
    match proc_start {
        Some(want) => proc_start_time(pid).is_none_or(|got| got == want),
        None => true,
    }
}

fn read_live(dir: &Path, is_running: &dyn Fn(u32, Option<&str>) -> bool) -> HashMap<String, Live> {
    let mut out: HashMap<String, Live> = HashMap::new();
    let Ok(rd) = fs::read_dir(dir) else {
        return out;
    };
    for e in rd.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(f) = serde_json::from_str::<LiveFile>(&text) else {
            continue;
        };
        let (Some(pid), Some(id)) = (f.pid, f.session_id.filter(|s| !s.is_empty())) else {
            continue;
        };
        if !is_running(pid, f.proc_start.as_deref()) {
            continue;
        }
        let ts = f.updated_at.or(f.started_at);
        let live = Live {
            info: LiveInfo {
                pid,
                status: f.status,
                name: f.name,
                cwd: f.cwd,
            },
            ts,
        };
        // Two live processes on one session id: keep the most recently active.
        match out.get(&id) {
            Some(prev) if prev.ts >= live.ts => {}
            _ => {
                out.insert(id, live);
            }
        }
    }
    out
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

fn read_transcripts(
    projects_dir: &Path,
    decode: &dyn Fn(&str) -> Option<String>,
) -> HashMap<String, Transcript> {
    let mut out: HashMap<String, Transcript> = HashMap::new();
    let Ok(rd) = fs::read_dir(projects_dir) else {
        return out;
    };
    for project in rd.flatten() {
        let dir = project.path();
        if !dir.is_dir() {
            continue;
        }
        let encoded = project.file_name().to_string_lossy().into_owned();
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        let mut decoded: Option<Option<String>> = None;
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !looks_like_uuid(stem) {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let project = decoded.get_or_insert_with(|| decode(&encoded)).clone();
            let t = Transcript {
                path: path.to_string_lossy().into_owned(),
                bytes: meta.len(),
                mtime_ms: mtime_ms(&meta),
                project,
            };
            // Same id under two project dirs: keep the most recently written one.
            match out.get(stem) {
                Some(prev) if prev.mtime_ms >= t.mtime_ms => {}
                _ => {
                    out.insert(stem.to_owned(), t);
                }
            }
        }
    }
    out
}

/// Merge the three sources. Pure apart from reading the given roots.
pub fn collect(
    history: &Path,
    sessions_dir: &Path,
    projects_dir: &Path,
    is_running: &dyn Fn(u32, Option<&str>) -> bool,
    decode: &dyn Fn(&str) -> Option<String>,
) -> Vec<Session> {
    let mut hist = read_history(history);
    let mut live = read_live(sessions_dir, is_running);
    let transcripts = read_transcripts(projects_dir, decode);

    let mut ids: Vec<String> = transcripts.keys().cloned().collect();
    ids.extend(
        live.keys()
            .filter(|k| !transcripts.contains_key(*k))
            .cloned(),
    );

    let mut out: Vec<Session> = ids
        .into_iter()
        .map(|id| {
            let h = hist.remove(&id).unwrap_or_default();
            let t = transcripts.get(&id);
            let l = live.remove(&id);
            let last_ts = [
                h.last_ts,
                t.map(|t| t.mtime_ms),
                l.as_ref().and_then(|l| l.ts),
            ]
            .into_iter()
            .flatten()
            .max()
            .unwrap_or(0);
            let project = h
                .project
                .or_else(|| l.as_ref().and_then(|l| l.info.cwd.clone()))
                .or_else(|| t.and_then(|t| t.project.clone()));
            Session {
                title: h.title.unwrap_or_else(|| NO_PROMPT_TITLE.to_owned()),
                project,
                first_ts: h.first_ts,
                last_ts,
                prompts: h.prompts,
                transcript_path: t.map(|t| t.path.clone()),
                transcript_bytes: t.map_or(0, |t| t.bytes),
                live: l.map(|l| l.info),
                id,
            }
        })
        .collect();
    out.sort_by(|a, b| b.last_ts.cmp(&a.last_ts).then_with(|| a.id.cmp(&b.id)));
    out
}

#[tauri::command]
pub async fn sessions_list() -> Result<Vec<Session>, String> {
    blocking(|| {
        let claude = claude_dir()?;
        Ok(collect(
            &claude.join("history.jsonl"),
            &claude.join("sessions"),
            &claude.join("projects"),
            &pid_is_running,
            &|enc| decode_project_path(enc).map(|p| p.to_string_lossy().into_owned()),
        ))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const B: &str = "bbbbbbbb-0000-4000-8000-000000000002";
    const C: &str = "cccccccc-0000-4000-8000-000000000003";
    const D: &str = "dddddddd-0000-4000-8000-000000000004";
    const E: &str = "eeeeeeee-0000-4000-8000-000000000005";

    struct Roots {
        _tmp: tempfile::TempDir,
        history: PathBuf,
        sessions: PathBuf,
        projects: PathBuf,
    }

    fn roots() -> Roots {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().to_path_buf();
        let sessions = base.join("sessions");
        let projects = base.join("projects");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&projects).unwrap();
        Roots {
            history: base.join("history.jsonl"),
            sessions,
            projects,
            _tmp: tmp,
        }
    }

    fn transcript(r: &Roots, encoded: &str, id: &str, bytes: usize) -> PathBuf {
        let dir = r.projects.join(encoded);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{id}.jsonl"));
        fs::write(&p, "x".repeat(bytes)).unwrap();
        p
    }

    fn run(r: &Roots, running: &[u32]) -> Vec<Session> {
        let running = running.to_vec();
        collect(
            &r.history,
            &r.sessions,
            &r.projects,
            &move |pid, _| running.contains(&pid),
            &|enc| (enc == "-work-proj").then(|| "/work/proj".to_owned()),
        )
    }

    fn find<'a>(list: &'a [Session], id: &str) -> &'a Session {
        list.iter()
            .find(|s| s.id == id)
            .unwrap_or_else(|| panic!("missing {id}"))
    }

    #[test]
    fn uuid_shape() {
        assert!(looks_like_uuid(A));
        assert!(!looks_like_uuid("agent-1234"));
        assert!(!looks_like_uuid("aaaaaaaa-0000-4000-8000-00000000000g"));
        assert!(!looks_like_uuid("aaaaaaaa00000-4000-8000-000000000001"));
    }

    #[test]
    fn merges_history_transcripts_and_live() {
        let r = roots();
        let long = "word ".repeat(60);
        let history = [
            format!(
                r#"{{"display":"  first\n prompt ","timestamp":1000,"project":"/real/a","sessionId":"{A}"}}"#
            ),
            "not json at all".to_owned(),
            format!(
                r#"{{"display":"second","timestamp":3000,"project":"/real/a","sessionId":"{A}","pastedContents":{{}}}}"#
            ),
            format!(
                r#"{{"display":"{long}","timestamp":2000,"project":"/real/b","sessionId":"{B}"}}"#
            ),
            // No transcript and not live: dropped.
            format!(
                r#"{{"display":"gone","timestamp":9000,"project":"/real/c","sessionId":"{C}"}}"#
            ),
            r#"{"display":"no session id","timestamp":5}"#.to_owned(),
            String::new(),
        ];
        fs::write(&r.history, history.join("\n")).unwrap();

        let ta = transcript(&r, "-real-a", A, 10);
        transcript(&r, "-real-b", B, 2048);
        // Transcript only, project decoded from its dir.
        transcript(&r, "-work-proj", D, 5);
        // Not a session transcript.
        transcript(&r, "-work-proj", "agent-123", 5);
        // Live only (no transcript yet), plus a stale file whose pid is gone.
        fs::write(
            r.sessions.join("42.json"),
            format!(r#"{{"pid":42,"sessionId":"{E}","cwd":"/live/e","startedAt":100,"updatedAt":7000,"status":"busy","name":"e-1","kind":"interactive"}}"#),
        )
        .unwrap();
        fs::write(
            r.sessions.join("43.json"),
            format!(r#"{{"pid":43,"sessionId":"{B}","cwd":"/real/b","updatedAt":8000}}"#),
        )
        .unwrap();
        fs::write(r.sessions.join("44.json"), "{broken").unwrap();
        fs::write(r.sessions.join("44.key"), "secret").unwrap();
        // Live B runs: pid 43; pid 42 runs too.
        let list = run(&r, &[42, 43]);

        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert!(!ids.contains(&C), "{ids:?}");
        assert_eq!(list.len(), 4, "{ids:?}");

        let a = find(&list, A);
        assert_eq!(a.title, "first prompt");
        assert_eq!(a.prompts, 2);
        assert_eq!(a.first_ts, Some(1000));
        assert_eq!(a.project.as_deref(), Some("/real/a"));
        assert_eq!(
            a.transcript_path.as_deref(),
            Some(ta.to_string_lossy().as_ref())
        );
        assert_eq!(a.transcript_bytes, 10);
        assert!(a.live.is_none());
        // lastTs = max(history, transcript mtime); the file was just written.
        assert!(a.last_ts > 3000);

        let b = find(&list, B);
        assert_eq!(b.title.chars().count(), TITLE_MAX_CHARS);
        assert_eq!(b.transcript_bytes, 2048);
        assert_eq!(b.live.as_ref().map(|l| l.pid), Some(43));

        let d = find(&list, D);
        assert_eq!(d.title, NO_PROMPT_TITLE);
        assert_eq!(d.prompts, 0);
        assert_eq!(d.first_ts, None);
        assert_eq!(d.project.as_deref(), Some("/work/proj"));

        let e = find(&list, E);
        assert_eq!(e.title, NO_PROMPT_TITLE);
        assert_eq!(e.project.as_deref(), Some("/live/e"));
        assert_eq!(e.last_ts, 7000);
        assert_eq!(e.transcript_path, None);
        assert_eq!(e.transcript_bytes, 0);
        assert_eq!(
            e.live,
            Some(LiveInfo {
                pid: 42,
                status: Some("busy".into()),
                name: Some("e-1".into()),
                cwd: Some("/live/e".into()),
            })
        );

        // Sorted by lastTs desc.
        assert!(list.windows(2).all(|w| w[0].last_ts >= w[1].last_ts));

        // When pid 42 is not running, the live-only session disappears.
        let list = run(&r, &[]);
        assert!(list.iter().all(|s| s.id != E && s.live.is_none()));
        assert_eq!(list.len(), 3);
    }

    #[test]
    fn missing_roots_are_empty_and_shape_is_camel_case() {
        let r = roots();
        assert!(run(&r, &[]).is_empty());

        fs::write(
            &r.history,
            format!(r#"{{"display":"/clear","timestamp":5,"project":"/p","sessionId":"{A}"}}"#),
        )
        .unwrap();
        transcript(&r, "-unknown", A, 1);
        let list = run(&r, &[]);
        let json = serde_json::to_value(&list[0]).unwrap();
        for key in [
            "id",
            "project",
            "title",
            "firstTs",
            "lastTs",
            "prompts",
            "transcriptPath",
            "transcriptBytes",
            "live",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert!(json["live"].is_null());
    }

    #[test]
    fn real_process_check() {
        let me = std::process::id();
        assert!(pid_is_running(me, None));
        let start = proc_start_time(me).expect("own stat");
        assert!(pid_is_running(me, Some(&start)));
        assert!(!pid_is_running(me, Some("1")));
        assert!(!pid_is_running(u32::MAX - 1, None));
    }
}
