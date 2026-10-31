//! Files inside the allowlist (CONTRACT.md "Files inside the allowlist").
//!
//! Allowed: `~/.claude/` (recursive), the exact file `~/.claude.json`, and the
//! app data dir `~/.local/share/tsukue/`. `~/.claude/.credentials.json` is always
//! refused: it holds the OAuth tokens and must never reach the webview.
//!
//! Every path is first checked lexically (absolute, no `..`), then canonicalised
//! (nearest existing ancestor + the not-yet-existing tail) and checked again.
//! One exception: reads below `~/.claude/` may follow a symlink out of it,
//! because Omarchy links its skills from `/usr/share/omarchy` into
//! `~/.claude/skills`. Writes, mkdir and deletes never leave the allowlist.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Refuse to hand the webview files bigger than this.
const MAX_READ: u64 = 32 * 1024 * 1024;

pub fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "home directory not found".to_string())
}

pub fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join("tsukue"))
        .ok_or_else(|| "data directory not found".to_string())
}

pub fn claude_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".claude"))
}

pub fn claude_json() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".claude.json"))
}

/// Run blocking filesystem work off the async runtime.
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `path` via a temp file in the same directory + rename.
/// Creates parent directories. Keeps the permissions of an existing file;
/// `new_mode` (unix) applies when the file is new.
pub fn atomic_write(path: &Path, bytes: &[u8], new_mode: Option<u32>) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    fs::create_dir_all(parent)?;

    let existing = fs::metadata(path).ok();
    if existing.as_ref().is_some_and(|m| m.is_dir()) {
        return Err(io::Error::new(
            io::ErrorKind::IsADirectory,
            "target is a directory",
        ));
    }

    let tmp = parent.join(format!(
        ".{}.tsukue-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));

    let result = (|| {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(meta) = &existing {
                f.set_permissions(meta.permissions())?;
            } else if let Some(mode) = new_mode {
                f.set_permissions(fs::Permissions::from_mode(mode))?;
            }
        }
        #[cfg(not(unix))]
        let _ = new_mode;
        f.write_all(bytes)?;
        f.flush()?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Access {
    Read,
    Write,
}

/// The allowlist roots, as given (lexical) and canonicalised.
pub struct Roots {
    claude_dir: PathBuf,
    claude_json: PathBuf,
    app_data: PathBuf,
    credentials: PathBuf,
    c_claude_dir: PathBuf,
    c_claude_json: PathBuf,
    c_app_data: PathBuf,
    c_credentials: PathBuf,
}

impl Roots {
    pub fn new(home: &Path, app_data: &Path) -> io::Result<Self> {
        let claude_dir = home.join(".claude");
        let claude_json = home.join(".claude.json");
        let credentials = claude_dir.join(".credentials.json");
        Ok(Self {
            c_claude_dir: canonical_nearest(&claude_dir)?,
            c_claude_json: canonical_nearest(&claude_json)?,
            c_app_data: canonical_nearest(app_data)?,
            c_credentials: canonical_nearest(&credentials)?,
            claude_dir,
            claude_json,
            app_data: app_data.to_path_buf(),
            credentials,
        })
    }

    pub fn current() -> Result<Self, String> {
        Self::new(&home_dir()?, &app_data_dir()?)
            .map_err(|e| format!("could not resolve allowed roots: {e}"))
    }

    fn lexical_ok(&self, p: &Path) -> bool {
        p != self.credentials
            && (p.starts_with(&self.claude_dir)
                || p == self.claude_json
                || p.starts_with(&self.app_data))
    }

    fn canonical_ok(&self, p: &Path) -> bool {
        p != self.c_credentials
            && (p.starts_with(&self.c_claude_dir)
                || p == self.c_claude_json
                || p.starts_with(&self.c_app_data))
    }

    pub fn is_claude_json(&self, canonical: &Path) -> bool {
        canonical == self.c_claude_json
    }

    /// Check `path` and return (lexical, canonical).
    pub fn resolve(
        &self,
        home: &Path,
        path: &str,
        access: Access,
    ) -> Result<(PathBuf, PathBuf), String> {
        let denied = || format!("path not allowed: {path}");
        let lexical = lexical(path, home).map_err(|_| denied())?;
        if !self.lexical_ok(&lexical) {
            return Err(denied());
        }
        let canonical =
            canonical_nearest(&lexical).map_err(|e| format!("cannot resolve {path}: {e}"))?;
        if canonical == self.c_credentials {
            return Err(denied());
        }
        let ok = self.canonical_ok(&canonical)
            || (access == Access::Read && lexical.starts_with(&self.claude_dir));
        if ok {
            Ok((lexical, canonical))
        } else {
            Err(denied())
        }
    }
}

impl Roots {
    /// Like `resolve` for Write, but the final component is not followed, so a
    /// symlink inside the allowlist can be removed even if it points outside.
    pub fn resolve_no_follow(&self, home: &Path, path: &str) -> Result<PathBuf, String> {
        let denied = || format!("path not allowed: {path}");
        let lexical = lexical(path, home).map_err(|_| denied())?;
        if !self.lexical_ok(&lexical) {
            return Err(denied());
        }
        let (Some(parent), Some(name)) = (lexical.parent(), lexical.file_name()) else {
            return Err(denied());
        };
        let target = canonical_nearest(parent)
            .map_err(|e| format!("cannot resolve {path}: {e}"))?
            .join(name);
        if self.canonical_ok(&target) {
            Ok(target)
        } else {
            Err(denied())
        }
    }
}

/// Expand a leading `~`, require an absolute path, drop `.`, refuse `..`.
fn lexical(path: &str, home: &Path) -> Result<PathBuf, ()> {
    if path.is_empty() || path.contains('\0') {
        return Err(());
    }
    let expanded = if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    };
    if !expanded.is_absolute() {
        return Err(());
    }
    let mut out = PathBuf::new();
    for c in expanded.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => return Err(()),
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

/// Canonicalise the nearest existing ancestor and re-append the missing tail.
pub fn canonical_nearest(p: &Path) -> io::Result<PathBuf> {
    let mut existing = p;
    let mut tail = Vec::new();
    loop {
        match existing.canonicalize() {
            Ok(mut c) => {
                for part in tail.iter().rev() {
                    c.push(part);
                }
                return Ok(c);
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let (Some(name), Some(parent)) = (existing.file_name(), existing.parent()) else {
                    return Err(e);
                };
                tail.push(name.to_os_string());
                existing = parent;
            }
            Err(e) => return Err(e),
        }
    }
}

fn check(path: &str, access: Access) -> Result<(Roots, PathBuf, PathBuf), String> {
    let home = home_dir()?;
    let roots = Roots::current()?;
    let (lex, canon) = roots.resolve(&home, path, access)?;
    Ok((roots, lex, canon))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    home: String,
    claude_dir: String,
    claude_json: String,
    settings: String,
    settings_local: String,
    agents_dir: String,
    skills_dir: String,
    workflows_dir: String,
    projects_dir: String,
    app_data: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified_ms: u64,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn claude_paths() -> Result<Paths, String> {
    blocking(|| {
        let home = home_dir()?;
        let claude = home.join(".claude");
        let app_data = app_data_dir()?;
        let _ = fs::create_dir_all(&app_data);
        Ok(Paths {
            home: s(&home),
            claude_json: s(&home.join(".claude.json")),
            settings: s(&claude.join("settings.json")),
            settings_local: s(&claude.join("settings.local.json")),
            agents_dir: s(&claude.join("agents")),
            skills_dir: s(&claude.join("skills")),
            workflows_dir: s(&claude.join("workflows")),
            projects_dir: s(&claude.join("projects")),
            claude_dir: s(&claude),
            app_data: s(&app_data),
        })
    })
    .await
}

pub fn read_text(path: &str) -> Result<String, String> {
    let (_, lex, _) = check(path, Access::Read)?;
    let meta = fs::metadata(&lex).map_err(|e| format!("cannot read {path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("is a directory: {path}"));
    }
    if meta.len() > MAX_READ {
        return Err(format!("file too large ({} bytes): {path}", meta.len()));
    }
    let bytes = fs::read(&lex).map_err(|e| format!("cannot read {path}: {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("not valid UTF-8: {path}"))
}

pub fn write_text(path: &str, content: &str) -> Result<(), String> {
    let (roots, _, canon) = check(path, Access::Write)?;
    let write = || {
        atomic_write(&canon, content.as_bytes(), None)
            .map_err(|e| format!("cannot write {path}: {e}"))
    };
    if roots.is_claude_json(&canon) {
        crate::mcp::with_claude_json_lock(|| {
            crate::mcp::backup_once(&canon, &crate::mcp::BACKUP_DONE)?;
            write()
        })
    } else {
        write()
    }
}

pub fn delete(path: &str) -> Result<(), String> {
    let home = home_dir()?;
    let roots = Roots::current()?;
    let target = roots.resolve_no_follow(&home, path)?;
    if target == roots.c_claude_json {
        return Err("refusing to delete ~/.claude.json".into());
    }
    let meta = fs::symlink_metadata(&target).map_err(|e| format!("cannot delete {path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("not a file: {path}"));
    }
    fs::remove_file(&target).map_err(|e| format!("cannot delete {path}: {e}"))
}

pub fn list(path: &str) -> Result<Vec<Entry>, String> {
    let (_, lex, _) = check(path, Access::Read)?;
    let rd = fs::read_dir(&lex).map_err(|e| format!("cannot list {path}: {e}"))?;
    let mut out = Vec::new();
    for item in rd.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        // Follow symlinks for type/size; fall back to the link itself if dangling.
        let meta = match fs::metadata(item.path()) {
            Ok(m) => m,
            Err(_) => match item.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            },
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(Entry {
            path: s(&lex.join(&name)),
            name,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified_ms,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

pub fn exists(path: &str) -> Result<bool, String> {
    let (_, lex, _) = check(path, Access::Read)?;
    Ok(lex.exists())
}

pub fn mkdir(path: &str) -> Result<(), String> {
    let (_, _, canon) = check(path, Access::Write)?;
    fs::create_dir_all(&canon).map_err(|e| format!("cannot create {path}: {e}"))
}

#[tauri::command]
pub async fn fs_read_text(path: String) -> Result<String, String> {
    blocking(move || read_text(&path)).await
}

#[tauri::command]
pub async fn fs_write_text(path: String, content: String) -> Result<(), String> {
    blocking(move || write_text(&path, &content)).await
}

#[tauri::command]
pub async fn fs_delete(path: String) -> Result<(), String> {
    blocking(move || delete(&path)).await
}

#[tauri::command]
pub async fn fs_list(path: String) -> Result<Vec<Entry>, String> {
    blocking(move || list(&path)).await
}

#[tauri::command]
pub async fn fs_exists(path: String) -> Result<bool, String> {
    blocking(move || exists(&path)).await
}

#[tauri::command]
pub async fn fs_mkdir(path: String) -> Result<(), String> {
    blocking(move || mkdir(&path)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _tmp: tempfile::TempDir,
        home: PathBuf,
        roots: Roots,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap().join("home");
        fs::create_dir_all(home.join(".claude/skills")).unwrap();
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::write(home.join(".ssh/id"), "secret").unwrap();
        fs::write(home.join(".claude/.credentials.json"), "{}").unwrap();
        fs::write(home.join(".claude.json"), "{}").unwrap();
        let app_data = home.join(".local/share/tsukue");
        let roots = Roots::new(&home, &app_data).unwrap();
        Fixture {
            _tmp: tmp,
            home,
            roots,
        }
    }

    fn r(f: &Fixture, p: &str, a: Access) -> Result<(PathBuf, PathBuf), String> {
        f.roots.resolve(&f.home, p, a)
    }

    #[test]
    fn allows_roots_and_children() {
        let f = fixture();
        let h = f.home.to_string_lossy().to_string();
        assert!(r(&f, &format!("{h}/.claude"), Access::Read).is_ok());
        assert!(r(&f, &format!("{h}/.claude/agents/new/x.md"), Access::Write).is_ok());
        assert!(r(&f, &format!("{h}/.claude.json"), Access::Write).is_ok());
        assert!(
            r(
                &f,
                &format!("{h}/.local/share/tsukue/tabs.json"),
                Access::Write
            )
            .is_ok()
        );
        assert!(r(&f, "~/.claude/settings.json", Access::Read).is_ok());
    }

    #[test]
    fn refuses_outside_traversal_and_credentials() {
        let f = fixture();
        let h = f.home.to_string_lossy().to_string();
        for p in [
            format!("{h}/.ssh/id"),
            format!("{h}/.claude/../.ssh/id"),
            format!("{h}/.claude.json.bak"),
            format!("{h}/.claudex/y"),
            format!("{h}/.claude/.credentials.json"),
            format!("{h}/.local/share/other"),
            "relative/.claude/x".to_string(),
            String::new(),
        ] {
            let err = r(&f, &p, Access::Read).unwrap_err();
            assert!(err.starts_with("path not allowed"), "{p}: {err}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_out_of_claude_dir_is_read_only() {
        let f = fixture();
        let outside = f.home.join("outside-skill");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("SKILL.md"), "hi").unwrap();
        std::os::unix::fs::symlink(&outside, f.home.join(".claude/skills/linked")).unwrap();
        // A symlink pointing at the credentials file is refused even for reads.
        std::os::unix::fs::symlink(
            f.home.join(".claude/.credentials.json"),
            f.home.join(".claude/creds"),
        )
        .unwrap();

        let h = f.home.to_string_lossy().to_string();
        let p = format!("{h}/.claude/skills/linked/SKILL.md");
        assert!(r(&f, &p, Access::Read).is_ok());
        assert!(r(&f, &p, Access::Write).is_err());
        assert!(r(&f, &format!("{h}/.claude/creds"), Access::Read).is_err());
    }

    #[test]
    fn atomic_write_creates_parents_and_replaces() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a/b/c.txt");
        atomic_write(&p, b"one", None).unwrap();
        atomic_write(&p, b"two", None).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "two");
        let leftovers: Vec<_> = fs::read_dir(p.parent().unwrap())
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(leftovers.len(), 1, "temp file left behind");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_keeps_mode() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("x.json");
        fs::write(&p, "{}").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
        atomic_write(&p, b"{\"a\":1}", None).unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let q = tmp.path().join("new.json");
        atomic_write(&q, b"{}", Some(0o600)).unwrap();
        assert_eq!(
            fs::metadata(&q).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
