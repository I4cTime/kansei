//! MCP servers in `~/.claude.json` (CONTRACT.md "MCP servers").
//!
//! Read-modify-write with `serde_json::Value` (`preserve_order`), touching only
//! the top-level `mcpServers` (scope "user") and `projects.<path>.mcpServers`
//! (scope "project"). The first write of a run copies the file to
//! `~/.claude.json.tsukue-bak`. All logic takes a path so tests use temp files.
//!
//! Scope "projectFile" (CONTRACT.md "Project scope") lives in `<root>/.mcp.json`
//! as `{ "mcpServers": { name: config } }`; the path goes through the files
//! allowlist, so `root` must be a registered project root.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::files::{Access, allowed, atomic_write, blocking, claude_json};

pub static BACKUP_DONE: OnceLock<()> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static PROJECT_FILE_LOCK: Mutex<()> = Mutex::new(());

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
#[serde(rename_all = "camelCase")]
pub enum Scope {
    User,
    Project,
    ProjectFile,
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
        Scope::ProjectFile => Err("projectFile scope is stored in <root>/.mcp.json".into()),
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

// ---------------------------------------------------------------------------
// projectFile scope: <root>/.mcp.json
// ---------------------------------------------------------------------------

/// Servers in a project's `.mcp.json` at `path`, labelled with `root`.
pub fn project_file_list_at(path: &Path, root: &str) -> Result<Vec<McpServer>, String> {
    let Value::Object(map) = read_json(path)? else {
        return Err(format!("{} is not a JSON object", path.display()));
    };
    let mut out = Vec::new();
    servers_of(&map, Scope::ProjectFile, Some(root), &mut out);
    Ok(out)
}

/// Locked read-modify-write of a project's `.mcp.json` (created when missing).
fn modify_project_file(
    path: &Path,
    f: impl FnOnce(&mut Map<String, Value>) -> Result<(), String>,
) -> Result<(), String> {
    modify_json_file(path, |map| f(map).map(|()| true)).map(|_| ())
}

/// Locked read-modify-write of a JSON object file inside a project (`.mcp.json`,
/// `.claude/settings.json`), created when missing. Key order is preserved
/// (`preserve_order`) and a trailing newline is kept as it was. `f` returns
/// whether it changed anything; nothing is written when it did not. Returns
/// whether the file was written.
pub fn modify_json_file(
    path: &Path,
    f: impl FnOnce(&mut Map<String, Value>) -> Result<bool, String>,
) -> Result<bool, String> {
    let _guard = PROJECT_FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let newline = match fs::read_to_string(path) {
        Ok(t) => t.is_empty() || t.ends_with('\n'),
        Err(_) => true,
    };
    let mut root = read_json(path)?;
    let Value::Object(map) = &mut root else {
        return Err(format!("{} is not a JSON object", path.display()));
    };
    if !f(map)? {
        return Ok(false);
    }
    let mut text =
        serde_json::to_string_pretty(&root).map_err(|e| format!("cannot serialise: {e}"))?;
    if newline {
        text.push('\n');
    }
    atomic_write(path, text.as_bytes(), Some(0o644))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(true)
}

pub fn project_file_upsert_at(path: &Path, name: &str, config: Value) -> Result<(), String> {
    validate_name(name)?;
    if !config.is_object() {
        return Err("server config must be a JSON object".into());
    }
    modify_project_file(path, |root| {
        let servers = root
            .entry("mcpServers".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        match servers {
            Value::Object(m) => {
                m.insert(name.to_string(), config);
                Ok(())
            }
            _ => Err(format!(
                "\"mcpServers\" in {} is not an object",
                path.display()
            )),
        }
    })
}

pub fn project_file_remove_at(path: &Path, name: &str) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("MCP server not found: {name}"));
    }
    modify_project_file(path, |root| {
        let removed = match root.get_mut("mcpServers") {
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

/// `<project>/.mcp.json` through the files allowlist. Returns (lexical, canonical).
fn project_file_path(project: Option<&str>, access: Access) -> Result<(PathBuf, PathBuf), String> {
    let root = match project.map(str::trim) {
        Some(p) if !p.is_empty() => p,
        _ => return Err("project scope needs a project path".into()),
    };
    let path = Path::new(root).join(".mcp.json");
    allowed(&path.to_string_lossy(), access)
}

#[tauri::command]
pub async fn mcp_list(project: Option<String>) -> Result<Vec<McpServer>, String> {
    blocking(move || {
        let mut out = list_at(&claude_json()?)?;
        if let Some(root) = project.as_deref().filter(|p| !p.trim().is_empty()) {
            let (lex, _) = project_file_path(Some(root), Access::Read)?;
            out.extend(project_file_list_at(&lex, root)?);
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn mcp_upsert(
    scope: Scope,
    project: Option<String>,
    name: String,
    config: Value,
) -> Result<(), String> {
    blocking(move || {
        if scope == Scope::ProjectFile {
            let (_, canon) = project_file_path(project.as_deref(), Access::Write)?;
            return project_file_upsert_at(&canon, &name, config);
        }
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
        if scope == Scope::ProjectFile {
            let (_, canon) = project_file_path(project.as_deref(), Access::Write)?;
            return project_file_remove_at(&canon, &name);
        }
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

// ---------------------------------------------------------------------------
// Read-only extras: plugin servers, claude.ai connectors, built-ins
// ---------------------------------------------------------------------------

/// One MCP server shipped by an installed plugin (`<installPath>/.mcp.json`).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginServer {
    /// Plugin name (the part of the `name@marketplace` key before the last `@`).
    plugin: String,
    marketplace: Option<String>,
    version: Option<String>,
    /// Install scope from installed_plugins.json ("user", "project", ...).
    scope: Option<String>,
    project_path: Option<String>,
    /// `enabledPlugins["name@marketplace"]` in ~/.claude/settings.json, when set.
    enabled: Option<bool>,
    name: String,
    config: Value,
    /// The `.mcp.json` the server came from (under ~/.claude/plugins).
    file: String,
    /// Listed in ~/.claude.json `mcpNeedsAuthNoticed` as `plugin:<plugin>:<name>`.
    needs_auth: bool,
}

/// A claude.ai connector recorded in ~/.claude.json `claudeAiMcpEverConnected`.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    name: String,
    needs_auth: bool,
}

/// A server built into Claude Code (today only `claude-in-chrome`).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Builtin {
    name: String,
    note: String,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpExtras {
    plugins: Vec<PluginServer>,
    connectors: Vec<Connector>,
    builtins: Vec<Builtin>,
}

/// Parse a JSON object file; missing, unreadable or invalid files give None.
fn read_object(path: &Path) -> Option<Map<String, Value>> {
    match read_json(path).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// `<install_path>/.mcp.json` when `install_path` is absolute, has no `..` and
/// the file stays inside `plugins` both as written and with symlinks resolved.
/// Returns the path as written (the front end opens it read-only).
fn plugin_mcp_json(plugins: &Path, c_plugins: &Path, install_path: &str) -> Option<PathBuf> {
    let p = Path::new(install_path);
    if !p.is_absolute()
        || p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let file = p.join(".mcp.json");
    if !file.starts_with(plugins) {
        return None;
    }
    let canonical = file.canonicalize().ok()?;
    (canonical.starts_with(c_plugins) && canonical.is_file()).then_some(file)
}

/// Strings of a JSON array; objects contribute their `name` (or `id`) field.
fn names_of(v: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = v else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let name = match item {
            Value::String(s) => Some(s.clone()),
            Value::Object(o) => o
                .get("name")
                .or_else(|| o.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        };
        if let Some(n) = name.filter(|n| !n.trim().is_empty())
            && !out.contains(&n)
        {
            out.push(n);
        }
    }
    out
}

/// Everything Claude Code loads besides the editable `mcpServers` blocks, read
/// from `home` (`.claude.json`, `.claude/settings.json`,
/// `.claude/plugins/installed_plugins.json` and each plugin's `.mcp.json`).
/// Never writes. Plugin files outside `home/.claude/plugins` are skipped.
pub fn extras_at(home: &Path) -> McpExtras {
    let claude_json = read_object(&home.join(".claude.json")).unwrap_or_default();
    let needs_auth = names_of(claude_json.get("mcpNeedsAuthNoticed"));
    let settings = read_object(&home.join(".claude").join("settings.json")).unwrap_or_default();
    let enabled = settings.get("enabledPlugins").and_then(Value::as_object);

    let mut out = McpExtras::default();

    let plugins_dir = home.join(".claude").join("plugins");
    if let (Ok(c_plugins), Some(installed)) = (
        plugins_dir.canonicalize(),
        read_object(&plugins_dir.join("installed_plugins.json")),
    ) && let Some(Value::Object(plugins)) = installed.get("plugins")
    {
        let mut seen: Vec<PathBuf> = Vec::new();
        for (key, installs) in plugins {
            let (plugin, marketplace) = match key.rsplit_once('@') {
                Some((n, m)) if !n.is_empty() => (n.to_string(), Some(m.to_string())),
                _ => (key.clone(), None),
            };
            let installs: Vec<&Value> = match installs {
                Value::Array(a) => a.iter().collect(),
                Value::Object(_) => vec![installs],
                _ => Vec::new(),
            };
            for install in installs {
                let Some(inst) = install.as_object() else {
                    continue;
                };
                let Some(file) = inst
                    .get("installPath")
                    .and_then(Value::as_str)
                    .and_then(|p| plugin_mcp_json(&plugins_dir, &c_plugins, p))
                else {
                    continue;
                };
                if seen.contains(&file) {
                    continue;
                }
                seen.push(file.clone());
                let Some(Value::Object(servers)) =
                    read_object(&file).and_then(|mut m| m.remove("mcpServers"))
                else {
                    continue;
                };
                let text = |k: &str| inst.get(k).and_then(Value::as_str).map(str::to_string);
                for (name, config) in servers {
                    out.plugins.push(PluginServer {
                        needs_auth: needs_auth.contains(&format!("plugin:{plugin}:{name}")),
                        plugin: plugin.clone(),
                        marketplace: marketplace.clone(),
                        version: text("version"),
                        scope: text("scope"),
                        project_path: text("projectPath"),
                        enabled: enabled.and_then(|e| e.get(key)).and_then(Value::as_bool),
                        name,
                        config,
                        file: file.to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }

    out.connectors = names_of(claude_json.get("claudeAiMcpEverConnected"))
        .into_iter()
        .map(|name| Connector {
            needs_auth: needs_auth.contains(&name),
            name,
        })
        .collect();

    if claude_json.get("claudeInChromeDefaultEnabled") == Some(&Value::Bool(true)) {
        out.builtins.push(Builtin {
            name: "claude-in-chrome".into(),
            note: "Chrome extension, built into Claude Code".into(),
        });
    }
    out
}

#[tauri::command]
pub async fn mcp_extras() -> Result<McpExtras, String> {
    blocking(|| Ok(extras_at(&crate::files::home_dir()?))).await
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

    const PROJECT_SAMPLE: &str = r#"{
  "mcpServers": {
    "zeta": {
      "command": "zeta"
    },
    "alpha": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  },
  "other": 1
}
"#;

    #[test]
    fn project_file_lists_upserts_and_removes_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join(".mcp.json");
        fs::write(&p, PROJECT_SAMPLE).unwrap();
        let list = project_file_list_at(&p, "/repo").unwrap();
        let names: Vec<_> = list.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["zeta", "alpha"]);
        let v = serde_json::to_value(&list[0]).unwrap();
        assert_eq!(v["scope"], "projectFile");
        assert_eq!(v["project"], "/repo");

        // No-op modify keeps the bytes, including the trailing newline.
        modify_project_file(&p, |_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), PROJECT_SAMPLE);

        project_file_upsert_at(&p, "zeta", json!({"command": "zeta2"})).unwrap();
        project_file_upsert_at(&p, "beta", json!({"command": "beta"})).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        let keys: Vec<_> = v["mcpServers"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, ["zeta", "alpha", "beta"]);
        assert_eq!(v["mcpServers"]["zeta"]["command"], "zeta2");
        assert_eq!(v["other"], 1);
        let top: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(top, ["mcpServers", "other"]);

        project_file_remove_at(&p, "alpha").unwrap();
        assert!(
            project_file_remove_at(&p, "alpha")
                .unwrap_err()
                .starts_with("MCP server not found")
        );
        let names: Vec<_> = project_file_list_at(&p, "/repo")
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, ["zeta", "beta"]);
        // No backup file for project files.
        assert!(!backup_path(&p).exists());
    }

    #[test]
    fn project_file_is_created_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join(".mcp.json");
        assert!(project_file_list_at(&p, "/r").unwrap().is_empty());
        assert!(project_file_remove_at(&p, "x").is_err());
        assert!(!p.exists());
        assert!(project_file_upsert_at(&p, "", json!({})).is_err());
        assert!(project_file_upsert_at(&p, "x", json!("nope")).is_err());
        assert!(!p.exists());
        project_file_upsert_at(&p, "a", json!({"command": "a"})).unwrap();
        assert_eq!(
            fs::read_to_string(&p).unwrap(),
            "{\n  \"mcpServers\": {\n    \"a\": {\n      \"command\": \"a\"\n    }\n  }\n}\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o644
            );
        }
    }

    #[test]
    fn project_file_scope_is_not_written_to_claude_json() {
        let (_t, p) = setup();
        let flag = OnceLock::new();
        let err = upsert_at(&p, &flag, Scope::ProjectFile, Some("/r"), "x", json!({})).unwrap_err();
        assert!(err.contains(".mcp.json"), "{err}");
        assert!(remove_at(&p, &flag, Scope::ProjectFile, Some("/r"), "x").is_err());
        assert_eq!(fs::read_to_string(&p).unwrap(), SAMPLE);
        let s: Scope = serde_json::from_value(json!("projectFile")).unwrap();
        assert_eq!(s, Scope::ProjectFile);
        let u: Scope = serde_json::from_value(json!("user")).unwrap();
        assert_eq!(u, Scope::User);
    }

    #[test]
    fn project_file_path_needs_an_allowed_root() {
        assert!(project_file_path(None, Access::Read).is_err());
        assert!(project_file_path(Some("  "), Access::Write).is_err());
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let err = project_file_path(Some(&root.to_string_lossy()), Access::Write).unwrap_err();
        assert!(err.starts_with("path not allowed"), "{err}");
    }

    fn write(p: &Path, text: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    /// A fake home with three plugins (two with servers, one without .mcp.json),
    /// one install pointing outside ~/.claude/plugins, connectors and Chrome.
    fn extras_home() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let plugins = home.join(".claude/plugins");
        let cache = plugins.join("cache/official");
        write(
            &cache.join("vercel/0.50.0/.mcp.json"),
            r#"{ "mcpServers": { "vercel": { "type": "http", "url": "https://mcp.vercel.com", "note": "OAuth on first use" } } }"#,
        );
        write(
            &cache.join("context7/abc/.mcp.json"),
            r#"{ "mcpServers": { "zeta": { "command": "z" }, "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" } } }"#,
        );
        fs::create_dir_all(cache.join("lsp/1.0.0")).unwrap();
        // Outside the plugins dir: must never be read.
        write(
            &home.join("elsewhere/.mcp.json"),
            r#"{ "mcpServers": { "evil": { "command": "x" } } }"#,
        );
        let installed = format!(
            r#"{{
  "version": 2,
  "plugins": {{
    "vercel@official": [ {{ "scope": "user", "installPath": "{c}/vercel/0.50.0", "version": "0.50.0" }} ],
    "context7@official": [ {{ "scope": "user", "installPath": "{c}/context7/abc", "version": "abc" }},
                           {{ "scope": "project", "installPath": "{c}/context7/abc", "version": "abc" }} ],
    "lsp@official": [ {{ "scope": "user", "installPath": "{c}/lsp/1.0.0", "version": "1.0.0" }} ],
    "evil@official": [ {{ "scope": "user", "installPath": "{h}/elsewhere" }},
                       {{ "scope": "user", "installPath": "{c}/../../../elsewhere" }} ]
  }}
}}"#,
            c = cache.display(),
            h = home.display()
        );
        write(&plugins.join("installed_plugins.json"), &installed);
        write(
            &home.join(".claude/settings.json"),
            r#"{ "enabledPlugins": { "vercel@official": true, "context7@official": false } }"#,
        );
        write(
            &home.join(".claude.json"),
            r#"{ "mcpServers": {}, "claudeAiMcpEverConnected": ["claude.ai Docs", { "name": "claude.ai Gmail" }, "claude.ai Docs", 3],
                 "mcpNeedsAuthNoticed": ["plugin:context7:context7", "claude.ai Gmail"], "claudeInChromeDefaultEnabled": true }"#,
        );
        (tmp, home)
    }

    #[test]
    fn extras_list_plugins_connectors_and_builtins() {
        let (_t, home) = extras_home();
        let x = extras_at(&home);
        let rows: Vec<_> = x
            .plugins
            .iter()
            .map(|p| (p.plugin.as_str(), p.name.as_str(), p.enabled, p.needs_auth))
            .collect();
        assert_eq!(
            rows,
            [
                ("vercel", "vercel", Some(true), false),
                ("context7", "zeta", Some(false), false),
                ("context7", "context7", Some(false), true),
            ]
        );
        let v = &x.plugins[0];
        assert_eq!(v.marketplace.as_deref(), Some("official"));
        assert_eq!(v.version.as_deref(), Some("0.50.0"));
        assert_eq!(v.scope.as_deref(), Some("user"));
        assert_eq!(v.config["note"], "OAuth on first use");
        assert!(v.file.ends_with("vercel/0.50.0/.mcp.json"));
        let json = serde_json::to_value(&x).unwrap();
        assert_eq!(json["plugins"][0]["needsAuth"], false);
        assert_eq!(json["plugins"][0]["projectPath"], Value::Null);
        // No read ever leaves ~/.claude/plugins.
        assert!(x.plugins.iter().all(|p| {
            p.file
                .starts_with(&*home.join(".claude/plugins").to_string_lossy())
        }));
        assert!(!x.plugins.iter().any(|p| p.name == "evil"));

        let c: Vec<_> = x
            .connectors
            .iter()
            .map(|c| (c.name.as_str(), c.needs_auth))
            .collect();
        assert_eq!(c, [("claude.ai Docs", false), ("claude.ai Gmail", true)]);
        assert_eq!(x.builtins.len(), 1);
        assert_eq!(x.builtins[0].name, "claude-in-chrome");
    }

    #[cfg(unix)]
    #[test]
    fn extras_skip_plugin_symlinks_out_of_the_plugins_dir() {
        let (_t, home) = extras_home();
        let cache = home.join(".claude/plugins/cache/official");
        // The lsp install has no .mcp.json; make it a link to the outside one.
        std::os::unix::fs::symlink(
            home.join("elsewhere/.mcp.json"),
            cache.join("lsp/1.0.0/.mcp.json"),
        )
        .unwrap();
        let x = extras_at(&home);
        assert!(!x.plugins.iter().any(|p| p.name == "evil"));
        assert_eq!(x.plugins.len(), 3);
    }

    #[test]
    fn extras_of_an_empty_home_are_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(extras_at(tmp.path()), McpExtras::default());
        // Odd shapes do not fail either.
        write(
            &tmp.path().join(".claude.json"),
            r#"{ "claudeAiMcpEverConnected": "x", "claudeInChromeDefaultEnabled": "yes" }"#,
        );
        write(
            &tmp.path().join(".claude/plugins/installed_plugins.json"),
            r#"{ "plugins": [] }"#,
        );
        assert_eq!(extras_at(tmp.path()), McpExtras::default());
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
