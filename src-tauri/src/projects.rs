//! Project folder facts for the Projects panel (CONTRACT.md "Projects").
//!
//! Stat-only: it checks whether each path is a directory and which Claude
//! markers sit in it, never reads a file and never registers anything as a
//! project root, so it needs no allowlist.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use crate::files::{blocking, home_dir};

/// At most this many paths are looked at per call; the rest are ignored.
pub const MAX_PATHS: usize = 500;

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFlags {
    claude_md: bool,
    claude_dir: bool,
    mcp_json: bool,
    git: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsInfo {
    path: String,
    /// Canonical path (symlinks resolved) when the folder exists.
    canonical: Option<String>,
    exists: bool,
    flags: ProjectFlags,
}

/// Facts about one absolute path. `home/.claude` is the user config dir, so it
/// does not count as a project `.claude` (same rule as `project_root`).
pub fn info_for(path: &str, home: Option<&Path>) -> ProjectsInfo {
    let p = Path::new(path);
    let exists = p.is_dir();
    if !exists {
        return ProjectsInfo {
            path: path.to_owned(),
            canonical: None,
            exists,
            flags: ProjectFlags::default(),
        };
    }
    let canonical = p.canonicalize().ok();
    let is_home = match (home, canonical.as_deref()) {
        (Some(h), Some(c)) => h == c,
        _ => false,
    };
    ProjectsInfo {
        path: path.to_owned(),
        canonical: canonical.map(|c| c.to_string_lossy().into_owned()),
        exists,
        flags: ProjectFlags {
            claude_md: p.join("CLAUDE.md").is_file(),
            claude_dir: !is_home && p.join(".claude").is_dir(),
            mcp_json: p.join(".mcp.json").is_file(),
            git: p.join(".git").exists(),
        },
    }
}

/// Absolute paths only, duplicates dropped, capped at MAX_PATHS, input order kept.
pub fn infos(paths: &[String], home: Option<&Path>) -> Vec<ProjectsInfo> {
    let home = home.and_then(|h| h.canonicalize().ok());
    let mut seen = HashSet::new();
    paths
        .iter()
        .filter(|p| Path::new(p.as_str()).is_absolute())
        .filter(|p| seen.insert(p.as_str()))
        .take(MAX_PATHS)
        .map(|p| info_for(p, home.as_deref()))
        .collect()
}

#[tauri::command]
pub async fn projects_info(paths: Vec<String>) -> Result<Vec<ProjectsInfo>, String> {
    blocking(move || Ok(infos(&paths, home_dir().ok().as_deref()))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn base() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        (tmp, base)
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn flags_follow_the_markers() {
        let (_t, base) = base();
        let full = base.join("full");
        fs::create_dir_all(full.join(".claude")).unwrap();
        fs::create_dir_all(full.join(".git")).unwrap();
        fs::write(full.join("CLAUDE.md"), "# x").unwrap();
        fs::write(full.join(".mcp.json"), "{}").unwrap();
        let bare = base.join("bare");
        fs::create_dir_all(&bare).unwrap();
        // Wrong kinds do not count: CLAUDE.md as a dir, .claude as a file, .mcp.json as a dir.
        let odd = base.join("odd");
        fs::create_dir_all(odd.join("CLAUDE.md")).unwrap();
        fs::create_dir_all(odd.join(".mcp.json")).unwrap();
        fs::write(odd.join(".claude"), "").unwrap();
        // A worktree has a .git file.
        fs::write(odd.join(".git"), "gitdir: /elsewhere").unwrap();

        let list = infos(&[s(&full), s(&bare), s(&odd)], None);
        assert_eq!(list.len(), 3);
        let f = &list[0];
        assert!(f.exists);
        assert_eq!(f.canonical.as_deref(), Some(s(&full).as_str()));
        assert_eq!(
            f.flags,
            ProjectFlags {
                claude_md: true,
                claude_dir: true,
                mcp_json: true,
                git: true
            }
        );
        assert!(list[1].exists);
        assert_eq!(list[1].flags, ProjectFlags::default());
        assert_eq!(
            list[2].flags,
            ProjectFlags {
                claude_md: false,
                claude_dir: false,
                mcp_json: false,
                git: true
            }
        );
    }

    #[test]
    fn missing_files_and_relative_paths() {
        let (_t, base) = base();
        let gone = base.join("gone");
        let file = base.join("file.txt");
        fs::write(&file, "x").unwrap();
        let list = infos(
            &[
                s(&gone),
                s(&file),
                "relative/dir".into(),
                "".into(),
                "~/x".into(),
            ],
            None,
        );
        assert_eq!(list.len(), 2, "relative, empty and ~ paths are skipped");
        for i in &list {
            assert!(!i.exists);
            assert_eq!(i.canonical, None);
            assert_eq!(i.flags, ProjectFlags::default());
        }
        assert_eq!(list[0].path, s(&gone));
        assert_eq!(list[1].path, s(&file));
    }

    #[test]
    fn home_claude_dir_is_not_a_project_marker() {
        let (_t, base) = base();
        let home = base.join("home");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(home.join("CLAUDE.md"), "x").unwrap();
        let list = infos(&[s(&home)], Some(&home));
        assert!(!list[0].flags.claude_dir);
        assert!(list[0].flags.claude_md);
        // Without a home it counts.
        assert!(infos(&[s(&home)], None)[0].flags.claude_dir);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_report_the_canonical_path() {
        let (_t, base) = base();
        let real = base.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let list = infos(&[s(&link)], None);
        assert_eq!(list[0].path, s(&link));
        assert_eq!(list[0].canonical.as_deref(), Some(s(&real).as_str()));
    }

    #[test]
    fn dedupes_and_caps() {
        let (_t, base) = base();
        let p = s(&base);
        let mut many: Vec<String> = vec![p.clone(), p.clone()];
        many.extend((0..MAX_PATHS + 50).map(|i| format!("/nonexistent-tsukue-test/{i}")));
        let list = infos(&many, None);
        assert_eq!(list.len(), MAX_PATHS);
        assert_eq!(list[0].path, p);
        assert_eq!(list[1].path, "/nonexistent-tsukue-test/0");
    }

    #[test]
    fn shape_is_camel_case() {
        let (_t, base) = base();
        let json = serde_json::to_value(&infos(&[s(&base)], None)[0]).unwrap();
        for key in ["path", "canonical", "exists", "flags"] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        for key in ["claudeMd", "claudeDir", "mcpJson", "git"] {
            assert!(json["flags"].get(key).is_some(), "missing flags.{key}");
        }
    }
}
