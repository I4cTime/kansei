//! Prompt scratchpad drafts (CONTRACT.md "Prompt scratchpad").
//!
//! Drafts are `<appData>/scratch/<key>.md`, where `key` is the project path
//! encoded like Claude Code's project dirs (`memory::encode`). Reads and writes
//! go through the `fs_*` commands; this module only lists the drafts for the
//! drawer's Drafts menu, newest first.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::files::{app_data_dir, blocking};
use crate::memory::decode_project_path;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScratchDraft {
    /// The file stem: the encoded project path.
    key: String,
    /// The project path the key decodes to on this filesystem, or null.
    project: Option<String>,
    bytes: u64,
    modified_ms: u64,
}

/// Every `*.md` file directly in `dir`, newest first (then by key). A missing
/// dir is an empty list.
pub fn list_drafts(dir: &Path) -> Vec<ScratchDraft> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<ScratchDraft> = rd
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("md") {
                return None;
            }
            let meta = fs::metadata(&path).ok().filter(|m| m.is_file())?;
            let key = path.file_stem()?.to_string_lossy().into_owned();
            if key.is_empty() {
                return None;
            }
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let project = decode_project_path(&key).map(|p| p.to_string_lossy().into_owned());
            Some(ScratchDraft {
                key,
                project,
                bytes: meta.len(),
                modified_ms,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.key.cmp(&b.key))
    });
    out
}

#[tauri::command]
pub async fn scratch_list() -> Result<Vec<ScratchDraft>, String> {
    blocking(|| Ok(list_drafts(&app_data_dir()?.join("scratch")))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::encode;
    use std::time::{Duration, SystemTime};

    fn touch(path: &Path, content: &str, age_s: u64) {
        fs::write(path, content).unwrap();
        let t = SystemTime::now() - Duration::from_secs(age_s);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    #[test]
    fn lists_drafts_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("work").join("my-app");
        fs::create_dir_all(&project).unwrap();
        let dir = tmp.path().join("scratch");
        fs::create_dir_all(dir.join("sub.md")).unwrap(); // a dir, skipped

        let key = encode(&project.to_string_lossy());
        touch(&dir.join(format!("{key}.md")), "hello", 60);
        touch(&dir.join("-nowhere-at-all.md"), "abc", 5);
        touch(&dir.join("notes.txt"), "skip", 1);

        let list = list_drafts(&dir);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].key, "-nowhere-at-all");
        assert_eq!(list[0].project, None);
        assert_eq!(list[0].bytes, 3);
        assert_eq!(list[1].key, key);
        assert_eq!(
            list[1].project.as_deref(),
            Some(project.to_string_lossy().as_ref())
        );
        assert_eq!(list[1].bytes, 5);
        assert!(list[0].modified_ms > list[1].modified_ms);
    }

    #[test]
    fn missing_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_drafts(&tmp.path().join("nope")).is_empty());
    }
}
