//! MCP servers in `~/.claude.json` (CONTRACT.md "MCP servers").
//!
//! Read-modify-write with `serde_json::Value` (`preserve_order`), touching only
//! the top-level `mcpServers` (scope "user") and `projects.<path>.mcpServers`
//! (scope "project"). The first write of a run copies the file to
//! `~/.claude.json.tsukue-bak`. All logic takes a path so tests use temp files.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::files::{atomic_write, blocking, claude_json};

pub static BACKUP_DONE: OnceLock<()> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Serialise every in-process write of `~/.claude.json`.
pub fn with_claude_json_lock<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    f()
}

fn backup_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".tsukue-bak");
    PathBuf::from(s)
}

/// Copy `path` to `<path>.tsukue-bak` once per `flag` (once per process for the real file).
pub fn backup_once(path: &Path, flag: &OnceLock<()>) -> Result<(), String> {
    if flag.get().is_some() {
        return Ok(());
    }
    if path.exists() {
        // fs::copy keeps the mode (0600 for ~/.claude.json).
        fs::copy(path, backup_path(path))
            .map_err(|e| format!("could not back up {}: {e}", path.display()))?;
    }
    let _ = flag.set(());
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    User,
    Project,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    name: String,
    config: Value,
}

fn read_json(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Value::Object(Map::new())),
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("{} is not valid JSON: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

fn servers_of(
    map: &Map<String, Value>,
    scope: Scope,
    project: Option<&str>,
    out: &mut Vec<McpServer>,
) {
    if let Some(Value::Object(servers)) = map.get("mcpServers") {
        for (name, config) in servers {
            out.push(McpServer {
                scope,
                project: project.map(str::to_string),
                name: name.clone(),
                config: config.clone(),
            });
        }
    }
}

pub fn list_at(path: &Path) -> Result<Vec<McpServer>, String> {
    let root = read_json(path)?;
    let Value::Object(root) = root else {
        return Err(format!("{} is not a JSON object", path.display()));
    };
    let mut out = Vec::new();
    servers_of(&root, Scope::User, None, &mut out);
    if let Some(Value::Object(projects)) = root.get("projects") {
        for (project, entry) in projects {
            if let Value::Object(entry) = entry {
                servers_of(entry, Scope::Project, Some(project), &mut out);
            }
        }
    }
    Ok(out)
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("server name is empty".into());
    }
    if name.chars().any(char::is_control) {
        return Err("server name contains control characters".into());
    }
    Ok(())
}

fn project_key(scope: Scope, project: Option<&str>) -> Result<Option<&str>, String> {
    match scope {
        Scope::User => Ok(None),
        Scope::Project => match project.map(str::trim) {
            Some(p) if !p.is_empty() => Ok(project),
            _ => Err("project scope needs a project path".into()),
        },
    }
}

/// Get (creating if needed) the object at `obj[key]`.
fn object_at<'a>(
    obj: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    let slot = obj
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    match slot {
        Value::Object(m) => Ok(m),
        _ => Err(format!("\"{key}\" in ~/.claude.json is not an object")),
    }
}

/// Locked read-modify-write of `path` with a one-time backup.
fn modify(
    path: &Path,
    backup: &OnceLock<()>,
    f: impl FnOnce(&mut Map<String, Value>) -> Result<(), String>,
) -> Result<(), String> {
    with_claude_json_lock(|| {
        let mut root = read_json(path)?;
        let Value::Object(map) = &mut root else {
            return Err(format!("{} is not a JSON object", path.display()));
        };
        f(map)?;
        // Same shape as Claude Code's JSON.stringify(value, null, 2).
        let text =
            serde_json::to_string_pretty(&root).map_err(|e| format!("cannot serialise: {e}"))?;
        backup_once(path, backup)?;
        atomic_write(path, text.as_bytes(), Some(0o600))
            .map_err(|e| format!("cannot write {}: {e}", path.display()))
    })
}

pub fn upsert_at(
    path: &Path,
    backup: &OnceLock<()>,
    scope: Scope,
    project: Option<&str>,
    name: &str,
    config: Value,
) -> Result<(), String> {
    validate_name(name)?;
    if !config.is_object() {
        return Err("server config must be a JSON object".into());
    }
    let project = project_key(scope, project)?;
    modify(path, backup, |root| {
        let parent = match project {
            None => root,
            Some(p) => object_at(object_at(root, "projects")?, p)?,
        };
        // Replacing an existing key keeps its position; a new key is appended.
        object_at(parent, "mcpServers")?.insert(name.to_string(), config);
        Ok(())
    })
}

pub fn remove_at(
    path: &Path,
    backup: &OnceLock<()>,
    scope: Scope,
    project: Option<&str>,
    name: &str,
) -> Result<(), String> {
    let project = project_key(scope, project)?;
    modify(path, backup, |root| {
        let parent = match project {
            None => Some(root),
            Some(p) => match root.get_mut("projects") {
                Some(Value::Object(projects)) => match projects.get_mut(p) {
                    Some(Value::Object(entry)) => Some(entry),
                    _ => None,
                },
                _ => None,
            },
        };
        let removed = match parent.and_then(|p| p.get_mut("mcpServers")) {
            Some(Value::Object(servers)) => servers.shift_remove(name).is_some(),
            _ => false,
        };
        if removed {
            Ok(())
        } else {
            Err(format!("MCP server not found: {name}"))
        }
    })
}

#[tauri::command]
pub async fn mcp_list() -> Result<Vec<McpServer>, String> {
    blocking(|| list_at(&claude_json()?)).await
}

#[tauri::command]
pub async fn mcp_upsert(
    scope: Scope,
    project: Option<String>,
    name: String,
    config: Value,
) -> Result<(), String> {
    blocking(move || {
        upsert_at(
            &claude_json()?,
            &BACKUP_DONE,
            scope,
            project.as_deref(),
            &name,
            config,
        )
    })
    .await
}

#[tauri::command]
pub async fn mcp_remove(scope: Scope, project: Option<String>, name: String) -> Result<(), String> {
    blocking(move || {
        remove_at(
            &claude_json()?,
            &BACKUP_DONE,
            scope,
            project.as_deref(),
            &name,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = r#"{
  "numStartups": 12,
  "score": 0.30000000000000004,
  "tiny": 1.2345678901234566e-7,
  "mcpServers": {
    "alpha": {
      "type": "stdio",
      "command": "alpha"
    },
    "beta": {
      "command": "beta",
      "args": []
    }
  },
  "projects": {
    "/home/me/app": {
      "allowedTools": [],
      "mcpServers": {
        "gamma": {
          "command": "gamma"
        }
      },
      "zLast": true
    }
  },
  "userID": "abc"
}"#;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join(".claude.json");
        fs::write(&p, SAMPLE).unwrap();
        (tmp, p)
    }

    #[test]
    fn lists_both_scopes() {
        let (_t, p) = setup();
        let list = list_at(&p).unwrap();
        let names: Vec<_> = list
            .iter()
            .map(|s| (s.scope, s.project.clone(), s.name.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                (Scope::User, None, "alpha"),
                (Scope::User, None, "beta"),
                (Scope::Project, Some("/home/me/app".to_string()), "gamma"),
            ]
        );
        let v = serde_json::to_value(&list[2]).unwrap();
        assert_eq!(v["scope"], "project");
        assert_eq!(v["project"], "/home/me/app");
        assert!(
            serde_json::to_value(&list[0])
                .unwrap()
                .get("project")
                .is_none()
        );
    }

    #[test]
    fn noop_roundtrip_is_byte_identical() {
        let (_t, p) = setup();
        let flag = OnceLock::new();
        modify(&p, &flag, |_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), SAMPLE);
    }

    #[test]
    fn upsert_preserves_order_and_other_keys() {
        let (_t, p) = setup();
        let flag = OnceLock::new();
        upsert_at(
            &p,
            &flag,
            Scope::User,
            None,
            "alpha",
            json!({"command": "alpha2"}),
        )
        .unwrap();
        upsert_at(
            &p,
            &flag,
            Scope::User,
            None,
            "delta",
            json!({"command": "delta"}),
        )
        .unwrap();
        upsert_at(
            &p,
            &flag,
            Scope::Project,
            Some("/home/me/app"),
            "eps",
            json!({"command": "e"}),
        )
        .unwrap();
        upsert_at(
            &p,
            &flag,
            Scope::Project,
            Some("/new/proj"),
            "z",
            json!({"command": "z"}),
        )
        .unwrap();

        let v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        let top: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            top,
            [
                "numStartups",
                "score",
                "tiny",
                "mcpServers",
                "projects",
                "userID"
            ]
        );
        let servers: Vec<_> = v["mcpServers"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(servers, ["alpha", "beta", "delta"]);
        assert_eq!(v["mcpServers"]["alpha"]["command"], "alpha2");
        let proj: Vec<_> = v["projects"]["/home/me/app"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(proj, ["allowedTools", "mcpServers", "zLast"]);
        assert_eq!(
            v["projects"]["/new/proj"]["mcpServers"]["z"]["command"],
            "z"
        );

        // Backup taken once, from the original content.
        assert_eq!(fs::read_to_string(backup_path(&p)).unwrap(), SAMPLE);
    }

    #[test]
    fn remove_keeps_order() {
        let (_t, p) = setup();
        let flag = OnceLock::new();
        upsert_at(&p, &flag, Scope::User, None, "gamma2", json!({})).unwrap();
        remove_at(&p, &flag, Scope::User, None, "beta").unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        let servers: Vec<_> = v["mcpServers"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(servers, ["alpha", "gamma2"]);
        remove_at(&p, &flag, Scope::Project, Some("/home/me/app"), "gamma").unwrap();
        assert!(remove_at(&p, &flag, Scope::Project, Some("/home/me/app"), "gamma").is_err());
        assert!(remove_at(&p, &flag, Scope::Project, Some("/nope"), "x").is_err());
    }

    #[test]
    fn validates_input() {
        let (_t, p) = setup();
        let flag = OnceLock::new();
        assert!(upsert_at(&p, &flag, Scope::User, None, "", json!({})).is_err());
        assert!(upsert_at(&p, &flag, Scope::User, None, "x", json!([1])).is_err());
        assert!(upsert_at(&p, &flag, Scope::Project, None, "x", json!({})).is_err());
        // Nothing written, so no backup either.
        assert!(!backup_path(&p).exists());
        assert_eq!(fs::read_to_string(&p).unwrap(), SAMPLE);
    }

    #[test]
    fn missing_file_is_created() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join(".claude.json");
        assert!(list_at(&p).unwrap().is_empty());
        let flag = OnceLock::new();
        upsert_at(&p, &flag, Scope::User, None, "a", json!({"command": "a"})).unwrap();
        assert_eq!(list_at(&p).unwrap().len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    /// Read-only check against the real ~/.claude.json: parse + pretty-print must
    /// reproduce it byte for byte. Never writes. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn real_claude_json_roundtrips_losslessly() {
        let p = claude_json().unwrap();
        let original = fs::read_to_string(&p).unwrap();
        let v: Value = serde_json::from_str(&original).unwrap();
        let again = serde_json::to_string_pretty(&v).unwrap();
        assert!(
            again == original.trim_end_matches('\n'),
            "re-serialised ~/.claude.json differs from the original"
        );
    }
}
