//! The transcript walk and the incremental index shared by session search
//! (`search.rs`) and usage (`usage.rs`), CONTRACT.md "Session search" and
//! "Usage".
//!
//! - Discovery: main transcripts `<projects>/<encoded>/<uuid>.jsonl` plus the
//!   subagent transcripts below `<projects>/<encoded>/<uuid>/` of a main
//!   transcript that exists, attributed to that session.
//! - An index dir holds `index.json`, `{ version, files: { <transcript path>:
//!   { size, mtimeMs, sessionId, project } } }`, and one file per session
//!   (`<sessionId>.<ext>`). A refresh rebuilds every session one of whose
//!   transcripts appeared, changed size or mtime, or went; what goes into a
//!   session's file is up to the caller.
//!
//! Transcripts are only ever read, line by line; nothing is written under
//! `~/.claude`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::files::atomic_write;
use crate::sessions;

/// Subdirectory levels below `<project>/<sessionId>/` walked for subagent transcripts.
const SUBAGENT_DEPTH: usize = 2;
/// Read buffer per transcript.
const READ_BUF: usize = 256 * 1024;
/// The manifest's file name inside an index dir.
const INDEX_JSON: &str = "index.json";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM-DDTHH:MM:SS[.fff...][Z|+HH:MM|-HH:MM]` to epoch milliseconds.
/// No offset means UTC.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter().try_fold(0i64, |acc, c| {
            c.is_ascii_digit().then(|| acc * 10 + i64::from(c - b'0'))
        })
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    if b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (h, mi, sec) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            if i - start < 3 {
                ms = ms * 10 + i64::from(b[i] - b'0');
            }
            i += 1;
        }
        if i == start {
            return None;
        }
        for _ in (i - start)..3 {
            ms *= 10;
        }
    }
    let offset_min = match b.get(i) {
        None | Some(b'Z' | b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh = num(i + 1, 2)?;
            let om = match b.get(i + 3) {
                Some(b':') => num(i + 4, 2)?,
                _ => num(i + 3, 2).unwrap_or(0),
            };
            let total = oh * 60 + om;
            if *sign == b'-' { -total } else { total }
        }
        Some(_) => return None,
    };
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some(secs * 1000 + ms)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Call `f` with every line of `path` (trimmed of ASCII whitespace), read
/// through one buffer; a file that cannot be opened yields nothing and a read
/// error ends the file.
pub fn for_each_line(path: &Path, mut f: impl FnMut(&[u8])) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    let mut r = BufReader::with_capacity(READ_BUF, file);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        f(buf.trim_ascii());
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// A transcript found on disk.
#[derive(Debug, Clone)]
pub struct Found {
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ms: i64,
    pub session_id: String,
    /// The encoded project dir name.
    pub encoded: String,
    /// A subagent transcript below `<project>/<sessionId>/`.
    pub subagent: bool,
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

fn is_jsonl(p: &Path) -> bool {
    p.extension().and_then(|x| x.to_str()) == Some("jsonl")
}

fn found_file(path: PathBuf, session_id: &str, encoded: &str, subagent: bool) -> Option<Found> {
    let meta = fs::metadata(&path).ok()?;
    meta.is_file().then(|| Found {
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
        session_id: session_id.to_owned(),
        encoded: encoded.to_owned(),
        subagent,
        path,
    })
}

/// `*.jsonl` below `dir`, `depth` levels of subdirectories deep.
fn walk_jsonl(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else {
            continue;
        };
        let p = e.path();
        if ft.is_dir() {
            if depth > 0 {
                walk_jsonl(&p, depth - 1, out);
            }
        } else if ft.is_file() && is_jsonl(&p) {
            out.push(p);
        }
    }
}

/// Main transcripts `<projects>/<encoded>/<uuid>.jsonl`, plus the subagent
/// transcripts under `<projects>/<encoded>/<uuid>/` of a main transcript that
/// exists (they are attributed to that session).
pub fn discover(projects: &Path) -> Vec<Found> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(projects) else {
        return out;
    };
    for project in rd.flatten() {
        let dir = project.path();
        if !dir.is_dir() {
            continue;
        }
        let encoded = project.file_name().to_string_lossy().into_owned();
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut mains: HashSet<String> = HashSet::new();
        let mut session_dirs: Vec<(String, PathBuf)> = Vec::new();
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else {
                continue;
            };
            if ft.is_dir() {
                if sessions::looks_like_uuid(&name) {
                    session_dirs.push((name, p));
                }
                continue;
            }
            let Some(stem) = name.strip_suffix(".jsonl") else {
                continue;
            };
            if !sessions::looks_like_uuid(stem) {
                continue;
            }
            if let Some(f) = found_file(p, stem, &encoded, false) {
                mains.insert(stem.to_owned());
                out.push(f);
            }
        }
        for (id, sdir) in session_dirs {
            if !mains.contains(&id) {
                continue;
            }
            let mut files = Vec::new();
            walk_jsonl(&sdir, SUBAGENT_DEPTH, &mut files);
            files.sort();
            out.extend(
                files
                    .into_iter()
                    .filter_map(|p| found_file(p, &id, &encoded, true)),
            );
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub size: u64,
    pub mtime_ms: i64,
    pub session_id: String,
    pub project: Option<String>,
}

/// `index.json` of an index dir.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct Manifest {
    pub version: u32,
    pub files: BTreeMap<String, FileEntry>,
}

/// Result of a refresh (`search_index_refresh`, `usage_refresh`).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    /// Transcripts found.
    pub files: usize,
    /// Transcripts read by this refresh.
    pub indexed: usize,
    /// Transcripts left as they were.
    pub skipped: usize,
    /// Size of the index on disk (session files plus index.json).
    pub bytes: u64,
    pub took_ms: u64,
    /// Sessions with a session file.
    pub sessions: usize,
}

pub fn index_json(dir: &Path) -> PathBuf {
    dir.join(INDEX_JSON)
}

/// The manifest in `dir`; empty when missing, unreadable or of another version.
pub fn load_manifest(dir: &Path, version: u32) -> Manifest {
    fs::read(index_json(dir))
        .ok()
        .and_then(|b| serde_json::from_slice::<Manifest>(&b).ok())
        .filter(|i| i.version == version)
        .unwrap_or_default()
}

/// Run `f` over `items` on up to `available_parallelism` threads, keeping the
/// input order in the result.
pub fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(items.len())
        .max(1);
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else {
                        break;
                    };
                    let r = f(item);
                    results.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(r);
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

#[cfg(unix)]
fn private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)
}

/// One kind of index: its manifest version, the extension of its session
/// files, a name for messages and the lock that keeps refreshes one at a time.
pub struct IndexKind {
    pub version: u32,
    pub ext: &'static str,
    pub name: &'static str,
    pub lock: &'static Mutex<()>,
}

impl IndexKind {
    pub fn session_path(&self, dir: &Path, session_id: &str) -> PathBuf {
        dir.join(format!("{session_id}.{}", self.ext))
    }
}

/// What a session's file is made from: the session id and its transcripts
/// (main first, then subagents). `None` means the session has nothing to keep.
pub type BuildSession<'a> = dyn Fn(&str, &[&Found]) -> Result<Option<Vec<u8>>, String> + Sync + 'a;

/// Bring the index of `kind` in `index_dir` up to date with the transcripts
/// under `projects`: every session one of whose transcripts is new, changed
/// or gone gets its file rebuilt by `build`. `decode` turns an encoded project
/// dir into the manifest's `project`. Pure apart from reading `projects` and
/// writing `index_dir`.
pub fn refresh_index(
    kind: &IndexKind,
    projects: &Path,
    index_dir: &Path,
    decode: &(dyn Fn(&str) -> Option<String> + Sync),
    build: &BuildSession<'_>,
) -> Result<IndexStatus, String> {
    let _guard = kind.lock.lock().unwrap_or_else(|e| e.into_inner());
    let started = Instant::now();
    private_dir(index_dir).map_err(|e| format!("cannot create {}: {e}", index_dir.display()))?;
    let old = load_manifest(index_dir, kind.version);
    let found = discover(projects);

    // Sessions to rebuild: a transcript is new, changed or gone.
    let found_paths: HashSet<String> = found
        .iter()
        .map(|f| f.path.to_string_lossy().into_owned())
        .collect();
    let mut dirty: HashSet<String> = HashSet::new();
    for f in &found {
        let key = f.path.to_string_lossy();
        match old.files.get(key.as_ref()) {
            Some(e)
                if e.size == f.size && e.mtime_ms == f.mtime_ms && e.session_id == f.session_id => {
            }
            _ => {
                dirty.insert(f.session_id.clone());
            }
        }
    }
    for (path, e) in &old.files {
        if !found_paths.contains(path) {
            dirty.insert(e.session_id.clone());
        }
    }

    // Group the dirty sessions' transcripts, largest session first.
    let mut by_session: HashMap<&str, Vec<&Found>> = HashMap::new();
    for f in &found {
        if dirty.contains(&f.session_id) {
            by_session.entry(&f.session_id).or_default().push(f);
        }
    }
    let mut jobs: Vec<(&str, Vec<&Found>)> = by_session.into_iter().collect();
    jobs.sort_by_key(|(id, fs)| {
        (
            std::cmp::Reverse(fs.iter().map(|f| f.size).sum::<u64>()),
            *id,
        )
    });

    let written = par_map(&jobs, |(id, files)| -> Result<usize, String> {
        let path = kind.session_path(index_dir, id);
        match build(id, files)? {
            None => match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("cannot remove {}: {e}", path.display())),
            },
            Some(bytes) => atomic_write(&path, &bytes, Some(0o600))
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?,
        }
        Ok(files.len())
    });
    let mut indexed = 0;
    for w in written {
        indexed += w?;
    }

    // Sessions whose transcripts are all gone lose their files.
    let live_sessions: HashSet<&str> = found.iter().map(|f| f.session_id.as_str()).collect();
    for id in &dirty {
        if !live_sessions.contains(id.as_str()) {
            let _ = fs::remove_file(kind.session_path(index_dir, id));
        }
    }

    // New index.json; the project is decoded once per project dir.
    let mut decoded: HashMap<&str, Option<String>> = HashMap::new();
    let mut files = BTreeMap::new();
    for f in &found {
        let key = f.path.to_string_lossy().into_owned();
        let entry = match old.files.get(&key) {
            Some(e) if !dirty.contains(&f.session_id) => e.clone(),
            _ => FileEntry {
                size: f.size,
                mtime_ms: f.mtime_ms,
                session_id: f.session_id.clone(),
                project: decoded
                    .entry(f.encoded.as_str())
                    .or_insert_with(|| decode(&f.encoded))
                    .clone(),
            },
        };
        files.insert(key, entry);
    }
    let manifest = Manifest {
        version: kind.version,
        files,
    };
    let json = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    atomic_write(&index_json(index_dir), &json, Some(0o600))
        .map_err(|e| format!("cannot write the {} index: {e}", kind.name))?;

    // Stray session files (a session no longer indexed, an interrupted run).
    let mut bytes = json.len() as u64;
    let mut sessions = 0;
    let suffix = format!(".{}", kind.ext);
    if let Ok(rd) = fs::read_dir(index_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == INDEX_JSON {
                continue;
            }
            let Some(id) = name.strip_suffix(&suffix) else {
                continue;
            };
            if live_sessions.contains(id) {
                bytes += e.metadata().map_or(0, |m| m.len());
                sessions += 1;
            } else {
                let _ = fs::remove_file(e.path());
            }
        }
    }

    Ok(IndexStatus {
        files: found.len(),
        indexed,
        skipped: found.len() - indexed,
        bytes,
        took_ms: started.elapsed().as_millis() as u64,
        sessions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_timestamps() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_iso_ms("2026-10-19T00:15:00.259Z"),
            Some(1_792_368_900_259)
        );
        assert_eq!(
            parse_iso_ms("2026-10-19T02:15:00.259+02:00"),
            Some(1_792_368_900_259)
        );
        assert_eq!(
            parse_iso_ms("2026-10-19T00:15:00.2Z"),
            Some(1_792_368_900_200)
        );
        assert_eq!(parse_iso_ms("2000-02-29T12:00:00"), Some(951_825_600_000));
        assert_eq!(parse_iso_ms("not a date"), None);
        assert_eq!(parse_iso_ms("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn lines_are_streamed_and_trimmed() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.jsonl");
        fs::write(&p, "one\r\n  two  \n\nthree").unwrap();
        let mut seen = Vec::new();
        for_each_line(&p, |l| seen.push(String::from_utf8_lossy(l).into_owned()));
        assert_eq!(seen, vec!["one", "two", "", "three"]);
        let mut none = 0;
        for_each_line(&tmp.path().join("missing"), |_| none += 1);
        assert_eq!(none, 0);
    }
}
