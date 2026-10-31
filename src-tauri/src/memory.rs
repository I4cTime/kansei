//! Claude Code project memory dirs (CONTRACT.md "Memory").
//!
//! `~/.claude/projects/<encoded>/memory/`, where `<encoded>` is the project path
//! with every non-alphanumeric character replaced by `-` (Claude Code's scheme:
//! `/home/me/Develop/sites/i4c-sites` -> `-home-me-Develop-sites-i4c-sites`,
//! `/home/me/.config` -> `-home-me--config`). Decoding is ambiguous, so it is
//! resolved against the filesystem: at each directory, try the entries whose
//! encoded name matches the longest prefix of what is left, backtracking when a
//! branch dead-ends.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::files::{blocking, claude_dir};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProject {
    encoded: String,
    dir: String,
    guessed_path: Option<String>,
    file_count: usize,
    has_index: bool,
}

/// Claude Code's encoding of one path component (or a whole path).
pub fn encode(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Decode an encoded project dir name into an existing absolute path, or None.
pub fn decode_project_path(encoded: &str) -> Option<PathBuf> {
    // Absolute unix paths encode with a leading '-' for the root '/'.
    let rest = encoded.strip_prefix('-')?;
    decode_from(Path::new("/"), rest, 0)
}

fn decode_from(dir: &Path, rest: &str, depth: usize) -> Option<PathBuf> {
    if rest.is_empty() {
        return Some(dir.to_path_buf());
    }
    if depth > 64 {
        return None;
    }
    let mut candidates: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if !path.is_dir() {
                return None;
            }
            let enc = encode(&e.file_name().to_string_lossy());
            let matches = rest == enc
                || rest
                    .strip_prefix(enc.as_str())
                    .is_some_and(|r| r.starts_with('-'));
            matches.then_some((enc, path))
        })
        .collect();
    // Longest match first; stable tie-break by name so results are deterministic.
    candidates.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.1.cmp(&b.1)));
    for (enc, path) in candidates {
        if rest == enc {
            return Some(path);
        }
        // Skip the '-' that stood for the '/' separator.
        let next = &rest[enc.len() + 1..];
        if let Some(found) = decode_from(&path, next, depth + 1) {
            return Some(found);
        }
    }
    None
}

pub fn list_projects(projects_dir: &Path) -> Vec<MemoryProject> {
    let Ok(rd) = fs::read_dir(projects_dir) else {
        return Vec::new();
    };
    let mut out: Vec<MemoryProject> = rd
        .flatten()
        .filter_map(|e| {
            let encoded = e.file_name().to_string_lossy().into_owned();
            let mem = e.path().join("memory");
            if !mem.is_dir() {
                return None;
            }
            let files: Vec<String> = fs::read_dir(&mem)
                .map(|rd| {
                    rd.flatten()
                        .filter(|f| f.path().is_file())
                        .map(|f| f.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            Some(MemoryProject {
                guessed_path: decode_project_path(&encoded)
                    .map(|p| p.to_string_lossy().into_owned()),
                dir: mem.to_string_lossy().into_owned(),
                file_count: files.len(),
                has_index: files.iter().any(|f| f == "MEMORY.md"),
                encoded,
            })
        })
        .collect();
    out.sort_by(|a, b| a.encoded.cmp(&b.encoded));
    out
}

#[tauri::command]
pub async fn memory_projects() -> Result<Vec<MemoryProject>, String> {
    blocking(|| Ok(list_projects(&claude_dir()?.join("projects")))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        (tmp, base)
    }

    fn enc(p: &Path) -> String {
        encode(&p.to_string_lossy())
    }

    #[test]
    fn decodes_hyphenated_segments() {
        let (_t, base) = base();
        let target = base.join("Develop/sites/i4c-sites");
        fs::create_dir_all(&target).unwrap();
        // Decoys that a naive split would pick.
        fs::create_dir_all(base.join("Develop/sites/i4c")).unwrap();
        assert_eq!(decode_project_path(&enc(&target)), Some(target));
    }

    #[test]
    fn prefers_longest_existing_join() {
        let (_t, base) = base();
        let long = base.join("a-b-c");
        fs::create_dir_all(&long).unwrap();
        fs::create_dir_all(base.join("a/b/c")).unwrap();
        assert_eq!(decode_project_path(&enc(&long)), Some(long));
    }

    #[test]
    fn backtracks_from_dead_ends() {
        let (_t, base) = base();
        // `a-b` exists but has no `c`; the real path is a/b/c.
        fs::create_dir_all(base.join("a-b")).unwrap();
        let real = base.join("a/b/c");
        fs::create_dir_all(&real).unwrap();
        assert_eq!(decode_project_path(&enc(&real)), Some(real));
    }

    #[test]
    fn decodes_dots_and_underscores() {
        let (_t, base) = base();
        let target = base.join("home/me/.config/my_app.v2");
        fs::create_dir_all(&target).unwrap();
        let e = enc(&target);
        assert!(e.contains("--config-my-app-v2"), "{e}");
        assert_eq!(decode_project_path(&e), Some(target));
    }

    #[test]
    fn unresolvable_is_none() {
        let (_t, base) = base();
        let gone = base.join("deleted-project/x");
        assert_eq!(decode_project_path(&enc(&gone)), None);
        assert_eq!(decode_project_path("no-leading-dash"), None);
    }

    #[test]
    fn root_decodes() {
        assert_eq!(decode_project_path("-"), Some(PathBuf::from("/")));
    }

    #[test]
    fn lists_projects_with_memory() {
        let (_t, base) = base();
        let project = base.join("Develop/sites/i4c-sites");
        fs::create_dir_all(&project).unwrap();
        let projects = base.join("claude/projects");
        let with_mem = projects.join(enc(&project)).join("memory");
        fs::create_dir_all(&with_mem).unwrap();
        fs::write(with_mem.join("MEMORY.md"), "- x").unwrap();
        fs::write(with_mem.join("topic.md"), "y").unwrap();
        fs::create_dir_all(projects.join("-no-memory-here")).unwrap();
        fs::create_dir_all(projects.join("-gone-project/memory")).unwrap();

        let list = list_projects(&projects);
        assert_eq!(list.len(), 2);
        let p = list.iter().find(|p| p.encoded == enc(&project)).unwrap();
        assert_eq!(
            p.guessed_path.as_deref(),
            Some(project.to_string_lossy().as_ref())
        );
        assert_eq!(p.file_count, 2);
        assert!(p.has_index);
        let gone = list.iter().find(|p| p.encoded == "-gone-project").unwrap();
        assert_eq!(gone.guessed_path, None);
        assert!(!gone.has_index);

        let json = serde_json::to_value(p).unwrap();
        for key in ["encoded", "dir", "guessedPath", "fileCount", "hasIndex"] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }
}
