//! Workspace trees for the Projects panel (CONTRACT.md "Workspaces").
//!
//! `workspace_scan` walks each configured workspace root (stat only, except
//! the first bytes of `.git` files) into a tree of groups, projects and monorepo subprojects, and
//! registers every root, project and subproject as a project root in the files
//! allowlist, so the front end can read and write their Claude files and the
//! generated `PROJECTS.md`.
//!
//! Rules:
//! - depth 1 under a root: every directory is a `group`; files are ignored;
//! - depth 2: a directory with a marker (`.git`, `CLAUDE.md`, `.claude/`) is a
//!   `project`; one without markers whose direct subdirectories include marker
//!   folders is a wrapper `group` of those (the other subdirectories are
//!   ignored); one with neither is still a plain `project`;
//! - a project with `pnpm-workspace.yaml`, `apps/` or `packages/` (and not a
//!   git worktree, whose `.git` is a `gitdir:` file) lists every
//!   `apps/*` and `packages/*` directory with `package.json`, `CLAUDE.md` or
//!   `.claude/` as a `subproject` (one level);
//! - `flags.worktree` needs the first bytes of `.git` when it is a file; that
//!   is the only read; everything else is stat only;
//! - hidden directories, `node_modules`, `target`, `dist`, `build` and `out`
//!   are skipped, symlinked directories are never followed, children sort by
//!   name (case-insensitive) and the whole result stops at MAX_NODES nodes.
//!
//! Also here: `workspace_claude_md` (the root `CLAUDE.md` that imports
//! `@PROJECTS.md`) and `project_additional_dirs` (`permissions.additionalDirectories`
//! in a project's `.claude/settings.json`, written by the Related sheet).

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::files::{Access, allowed, atomic_write, blocking, home_dir, register_project_root};
use crate::mcp::modify_json_file;
use crate::projects::{ProjectFlags, flags_of};

/// The scan stops adding nodes after this many (roots included).
pub const MAX_NODES: usize = 3000;

/// Directory names that are never part of the tree (besides hidden ones).
const SKIP: &[&str] = &["node_modules", "target", "dist", "build", "out"];

/// Monorepo folders whose children can be subprojects.
const MONOREPO_DIRS: &[&str] = &["apps", "packages"];

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Root,
    Group,
    Project,
    Subproject,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNode {
    path: String,
    name: String,
    kind: Kind,
    flags: ProjectFlags,
    children: Vec<WorkspaceNode>,
}

/// Workspace roots scanned this run; `workspace_claude_md` only accepts these.
static WORKSPACE_ROOTS: LazyLock<Mutex<HashSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Absolute, `.` dropped, trailing slash dropped, `..` refused.
fn clean_abs(p: &str) -> Option<PathBuf> {
    let p = Path::new(p.trim());
    if !p.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => return None,
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

/// A real directory (symlinks are not followed).
fn is_real_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}

/// Child directories that may be in the tree, sorted by name (case-insensitive).
fn subdirs(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            (!name.starts_with('.') && !SKIP.contains(&name.as_str())).then(|| (name, e.path()))
        })
        .collect();
    out.sort_by(|a, b| {
        a.0.to_lowercase()
            .cmp(&b.0.to_lowercase())
            .then_with(|| a.0.cmp(&b.0))
    });
    out
}

struct Scanner<'a> {
    left: usize,
    home: Option<&'a Path>,
}

impl Scanner<'_> {
    /// Take one node slot; None once the cap is reached.
    fn node(&mut self, path: &Path, name: String, kind: Kind) -> Option<WorkspaceNode> {
        if self.left == 0 {
            return None;
        }
        self.left -= 1;
        Some(WorkspaceNode {
            path: s(path),
            name,
            kind,
            flags: self.flags(path),
            children: Vec::new(),
        })
    }

    fn flags(&self, path: &Path) -> ProjectFlags {
        flags_of(path, self.home == Some(path))
    }

    fn root(&mut self, path: &Path) -> Option<WorkspaceNode> {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| s(path));
        let mut root = self.node(path, name, Kind::Root)?;
        for (name, dir) in subdirs(path) {
            let Some(mut group) = self.node(&dir, name, Kind::Group) else {
                break;
            };
            for (name, d) in subdirs(&dir) {
                match self.classify(&d, name) {
                    Some(n) => group.children.push(n),
                    None => break,
                }
            }
            root.children.push(group);
        }
        Some(root)
    }

    /// A depth-2 folder: project, wrapper group, or plain project.
    fn classify(&mut self, dir: &Path, name: String) -> Option<WorkspaceNode> {
        if self.flags(dir).is_project() {
            return self.project(dir, name);
        }
        let inner: Vec<(String, PathBuf)> = subdirs(dir)
            .into_iter()
            .filter(|(_, p)| self.flags(p).is_project())
            .collect();
        if inner.is_empty() {
            return self.node(dir, name, Kind::Project);
        }
        let mut wrapper = self.node(dir, name, Kind::Group)?;
        for (name, p) in inner {
            match self.project(&p, name) {
                Some(n) => wrapper.children.push(n),
                None => break,
            }
        }
        Some(wrapper)
    }

    /// A project, with its monorepo subprojects.
    fn project(&mut self, dir: &Path, name: String) -> Option<WorkspaceNode> {
        let mut node = self.node(dir, name, Kind::Project)?;
        // A worktree repeats its main checkout's apps; list it as one project.
        if node.flags.is_worktree() {
            return Some(node);
        }
        let monorepo = dir.join("pnpm-workspace.yaml").is_file()
            || MONOREPO_DIRS.iter().any(|d| is_real_dir(&dir.join(d)));
        if !monorepo {
            return Some(node);
        }
        let mut subs: Vec<(String, PathBuf)> = MONOREPO_DIRS
            .iter()
            .map(|d| dir.join(d))
            .filter(|d| is_real_dir(d))
            .flat_map(|d| subdirs(&d))
            .filter(|(_, p)| {
                p.join("package.json").is_file()
                    || p.join("CLAUDE.md").is_file()
                    || p.join(".claude").is_dir()
            })
            .collect();
        subs.sort_by(|a, b| {
            a.0.to_lowercase()
                .cmp(&b.0.to_lowercase())
                .then_with(|| a.1.cmp(&b.1))
        });
        for (name, p) in subs {
            match self.node(&p, name, Kind::Subproject) {
                Some(n) => node.children.push(n),
                None => break,
            }
        }
        Some(node)
    }
}

/// Scan `roots` (absolute folders; others skipped, duplicates dropped) into trees.
pub fn scan(roots: &[String], home: Option<&Path>) -> Vec<WorkspaceNode> {
    scan_with_cap(roots, home, MAX_NODES)
}

fn scan_with_cap(roots: &[String], home: Option<&Path>, cap: usize) -> Vec<WorkspaceNode> {
    let mut scanner = Scanner { left: cap, home };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for r in roots {
        let Some(path) = clean_abs(r) else { continue };
        if !path.is_dir() || !seen.insert(path.clone()) {
            continue;
        }
        match scanner.root(&path) {
            Some(n) => out.push(n),
            None => break,
        }
    }
    out
}

/// Every root, project and subproject path in the trees.
pub fn openable_paths(nodes: &[WorkspaceNode]) -> Vec<PathBuf> {
    fn walk(n: &WorkspaceNode, out: &mut Vec<PathBuf>) {
        if n.kind != Kind::Group {
            out.push(PathBuf::from(&n.path));
        }
        for c in &n.children {
            walk(c, out);
        }
    }
    let mut out = Vec::new();
    for n in nodes {
        walk(n, &mut out);
    }
    out
}

/// Register the scan with the files allowlist and remember the roots.
fn register(nodes: &[WorkspaceNode]) {
    for p in openable_paths(nodes) {
        register_project_root(&p);
    }
    let mut roots = WORKSPACE_ROOTS.lock().unwrap_or_else(|p| p.into_inner());
    for n in nodes {
        let p = PathBuf::from(&n.path);
        if let Ok(c) = p.canonicalize() {
            roots.insert(c);
        }
        roots.insert(p);
    }
}

fn is_workspace_root(p: &Path) -> bool {
    let roots = WORKSPACE_ROOTS.lock().unwrap_or_else(|p| p.into_inner());
    roots.contains(p) || p.canonicalize().is_ok_and(|c| roots.contains(&c))
}

#[tauri::command]
pub async fn workspace_scan(roots: Vec<String>) -> Result<Vec<WorkspaceNode>, String> {
    blocking(move || {
        let home = home_dir().ok().and_then(|h| h.canonicalize().ok());
        let nodes = scan(&roots, home.as_deref());
        register(&nodes);
        Ok(nodes)
    })
    .await
}

// ---------------------------------------------------------------------------
// Root CLAUDE.md
// ---------------------------------------------------------------------------

pub const IMPORT_PARAGRAPH: &str = "Every project under this folder is listed in @PROJECTS.md with its path, a one-line description, its status and the projects it is related to. Read it before assuming a sibling project does not exist.";

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeMdOutcome {
    Created,
    Amended,
    Unchanged,
}

/// The CLAUDE.md for a new workspace root.
pub fn new_claude_md(root_name: &str, focus: bool) -> String {
    let mut t = format!("# {root_name} workspace\n\n{IMPORT_PARAGRAPH}\n");
    if focus {
        t.push_str("\nCurrent focus: @FOCUS.md\n");
    }
    t
}

/// `existing` plus the import paragraph, or None when it already imports PROJECTS.md.
pub fn amended_claude_md(existing: &str) -> Option<String> {
    if existing.contains("@PROJECTS.md") {
        return None;
    }
    let mut t = existing.to_owned();
    if !t.is_empty() {
        if !t.ends_with('\n') {
            t.push('\n');
        }
        t.push('\n');
    }
    t.push_str(IMPORT_PARAGRAPH);
    t.push('\n');
    Some(t)
}

/// Create `<root>/CLAUDE.md` when missing, or append the import paragraph once
/// when it does not mention `@PROJECTS.md`. `target` is where the file is
/// written (the canonical path); `root` names the workspace.
pub fn ensure_claude_md_at(root: &Path, target: &Path) -> Result<ClaudeMdOutcome, String> {
    let err = |e: std::io::Error| format!("cannot write {}: {e}", target.display());
    match fs::read_to_string(target) {
        Ok(existing) => match amended_claude_md(&existing) {
            Some(t) => {
                atomic_write(target, t.as_bytes(), None).map_err(err)?;
                Ok(ClaudeMdOutcome::Amended)
            }
            None => Ok(ClaudeMdOutcome::Unchanged),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let name = root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| s(root));
            let focus = root.join("FOCUS.md").is_file();
            atomic_write(target, new_claude_md(&name, focus).as_bytes(), Some(0o644))
                .map_err(err)?;
            Ok(ClaudeMdOutcome::Created)
        }
        Err(e) => Err(format!("cannot read {}: {e}", target.display())),
    }
}

#[tauri::command]
pub async fn workspace_claude_md(root: String) -> Result<ClaudeMdOutcome, String> {
    blocking(move || {
        let path = clean_abs(&root).ok_or_else(|| format!("not a workspace root: {root}"))?;
        if !is_workspace_root(&path) {
            return Err(format!("not a workspace root: {root}"));
        }
        let file = path.join("CLAUDE.md");
        let (_, canonical) = allowed(&s(&file), Access::Write)?;
        ensure_claude_md_at(&path, &canonical)
    })
    .await
}

// ---------------------------------------------------------------------------
// permissions.additionalDirectories
// ---------------------------------------------------------------------------

fn norm_dir(p: &str) -> String {
    let t = p.trim();
    let n = t.trim_end_matches('/');
    if n.is_empty() && t.starts_with('/') {
        "/".into()
    } else {
        n.to_owned()
    }
}

/// Set the workspace part of `permissions.additionalDirectories` in the
/// settings file at `path`: every entry of `dirs` is present (appended when
/// new), entries listed in `managed` but not in `dirs` are removed, everything
/// else (hand-added entries, other keys, key order) is kept. The file is
/// created only when there is something to add. Returns the resulting array.
pub fn set_additional_dirs_at(
    path: &Path,
    dirs: &[String],
    managed: &[String],
) -> Result<Vec<String>, String> {
    let mut want: Vec<String> = Vec::new();
    for d in dirs {
        let n = norm_dir(d);
        if !n.starts_with('/') {
            return Err(format!("not an absolute path: {d}"));
        }
        if !want.contains(&n) {
            want.push(n);
        }
    }
    if want.is_empty() && !path.exists() {
        return Ok(Vec::new());
    }
    let managed: HashSet<String> = managed.iter().map(|m| norm_dir(m)).collect();
    let file = path.display().to_string();
    let mut result: Vec<String> = Vec::new();
    modify_json_file(path, |root| {
        let perms = root
            .entry("permissions".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let Value::Object(perms) = perms else {
            return Err(format!("\"permissions\" in {file} is not an object"));
        };
        let current = match perms.get("additionalDirectories") {
            None => None,
            Some(Value::Array(a)) => Some(a.clone()),
            Some(_) => {
                return Err(format!(
                    "\"permissions.additionalDirectories\" in {file} is not an array"
                ));
            }
        };
        let mut next: Vec<Value> = Vec::new();
        let mut have: HashSet<String> = HashSet::new();
        for v in current.iter().flatten() {
            if let Value::String(entry) = v {
                let n = norm_dir(entry);
                let wanted = want.contains(&n);
                if managed.contains(&n) && !wanted {
                    continue;
                }
                if wanted && !have.insert(n) {
                    continue;
                }
            }
            next.push(v.clone());
        }
        for w in &want {
            if have.insert(w.clone()) {
                next.push(Value::String(w.clone()));
            }
        }
        result = next
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        let changed = match &current {
            None => !next.is_empty(),
            Some(c) => *c != next,
        };
        if changed {
            // IndexMap::insert keeps the position of an existing key.
            perms.insert("additionalDirectories".to_string(), Value::Array(next));
        }
        Ok(changed)
    })?;
    Ok(result)
}

#[tauri::command]
pub async fn project_additional_dirs(
    project: String,
    dirs: Vec<String>,
    managed: Vec<String>,
) -> Result<Vec<String>, String> {
    blocking(move || {
        let path = Path::new(project.trim()).join(".claude/settings.json");
        let (_, canonical) = allowed(&s(&path), Access::Write)?;
        set_additional_dirs_at(&canonical, &dirs, &managed)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        (tmp, base)
    }

    fn mk(p: &Path) {
        fs::create_dir_all(p).unwrap();
    }

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }

    /// A tree like ~/Develop: groups, a wrapper, a monorepo, plain folders, noise.
    fn develop(base: &Path) -> PathBuf {
        let root = base.join("Develop");
        touch(&root.join("Develop.code-workspace"));
        touch(&root.join("FOCUS.md"));
        mk(&root.join(".hidden-group/x/.git"));
        mk(&root.join("node_modules/pkg"));
        // products: a project with an inner repo, a wrapper, a plain folder.
        let products = root.join("products");
        mk(&products.join("aibou/.git"));
        touch(&products.join("aibou/CLAUDE.md"));
        mk(&products.join("aibou/relay/.git"));
        mk(&products.join("mine/mineui/.git"));
        touch(&products.join("mine/Utils/CLAUDE.md"));
        mk(&products.join("mine/notes"));
        mk(&products.join("mine/.cache/.git"));
        mk(&products.join("Plain/sub/deeper"));
        mk(&products.join("target/x/.git"));
        // sites: a pnpm monorepo with apps and packages.
        let mono = root.join("sites/i4c-sites");
        mk(&mono.join(".git"));
        touch(&mono.join("pnpm-workspace.yaml"));
        touch(&mono.join("apps/sparkle/package.json"));
        touch(&mono.join("apps/Qring/package.json"));
        mk(&mono.join("apps/empty"));
        touch(&mono.join("apps/.hidden/package.json"));
        mk(&mono.join("packages/ui/.claude"));
        touch(&mono.join("packages/config/CLAUDE.md"));
        mk(&mono.join("node_modules/dep"));
        // lab: a .claude-only project and a plain folder.
        mk(&root.join("lab/thermal/.claude"));
        mk(&root.join("lab/feature-specs"));
        // An empty group.
        mk(&root.join("empty"));
        root
    }

    fn names(n: &WorkspaceNode) -> Vec<&str> {
        n.children.iter().map(|c| c.name.as_str()).collect()
    }

    fn child<'a>(n: &'a WorkspaceNode, name: &str) -> &'a WorkspaceNode {
        n.children
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("no child {name} in {}", n.path))
    }

    #[test]
    fn scans_groups_wrappers_and_monorepos() {
        let (_t, base) = base();
        let root = develop(&base);
        let trees = scan(&[s(&root)], None);
        assert_eq!(trees.len(), 1);
        let r = &trees[0];
        assert_eq!(r.kind, Kind::Root);
        assert_eq!(r.name, "Develop");
        assert_eq!(r.path, s(&root));
        // Files, hidden dirs and skipped names are not groups; order is case-insensitive.
        assert_eq!(names(r), ["empty", "lab", "products", "sites"]);
        assert!(r.children.iter().all(|g| g.kind == Kind::Group));
        assert!(child(r, "empty").children.is_empty());

        let products = child(r, "products");
        assert_eq!(names(products), ["aibou", "mine", "Plain"]);
        let aibou = child(products, "aibou");
        assert_eq!(aibou.kind, Kind::Project);
        assert!(
            aibou.children.is_empty(),
            "inner repos of a project are not listed"
        );
        assert!(aibou.flags.is_project());
        let mine = child(products, "mine");
        assert_eq!(
            mine.kind,
            Kind::Group,
            "a folder of repos is a wrapper group"
        );
        assert_eq!(names(mine), ["mineui", "Utils"]);
        assert!(mine.children.iter().all(|c| c.kind == Kind::Project));
        assert_eq!(
            child(mine, "mineui").path,
            s(&root.join("products/mine/mineui"))
        );
        let plain = child(products, "Plain");
        assert_eq!(
            plain.kind,
            Kind::Project,
            "a folder without markers is a plain project"
        );
        assert!(plain.children.is_empty());
        assert!(!plain.flags.is_project());

        let mono = child(child(r, "sites"), "i4c-sites");
        assert_eq!(mono.kind, Kind::Project);
        assert_eq!(names(mono), ["config", "Qring", "sparkle", "ui"]);
        assert!(mono.children.iter().all(|c| c.kind == Kind::Subproject));
        assert_eq!(
            child(mono, "ui").path,
            s(&root.join("sites/i4c-sites/packages/ui"))
        );

        let lab = child(r, "lab");
        assert_eq!(names(lab), ["feature-specs", "thermal"]);
        assert!(lab.children.iter().all(|c| c.kind == Kind::Project));
    }

    #[test]
    fn monorepo_needs_a_marker_folder_or_workspace_file() {
        let (_t, base) = base();
        let root = base.join("ws");
        // apps/ alone makes a monorepo, even without pnpm-workspace.yaml.
        touch(&root.join("g/appsonly/CLAUDE.md"));
        touch(&root.join("g/appsonly/apps/web/CLAUDE.md"));
        // A subfolder named like a monorepo dir somewhere else does not count.
        mk(&root.join("g/single/.git"));
        touch(&root.join("g/single/src/apps/x/package.json"));
        let trees = scan(&[s(&root)], None);
        let g = child(&trees[0], "g");
        assert_eq!(names(child(g, "appsonly")), ["web"]);
        assert!(child(g, "single").children.is_empty());
    }

    #[test]
    fn worktrees_are_single_projects() {
        let (_t, base) = base();
        let root = base.join("ws");
        let main = root.join("sites/mono");
        mk(&main.join(".git"));
        touch(&main.join("apps/web/package.json"));
        let wt = root.join("sites/mono-wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: ../mono/.git/worktrees/mono-wt\n").unwrap();
        touch(&wt.join("pnpm-workspace.yaml"));
        touch(&wt.join("apps/web/package.json"));
        let trees = scan(&[s(&root)], None);
        let sites = child(&trees[0], "sites");
        let m = child(sites, "mono");
        assert!(!m.flags.is_worktree());
        assert_eq!(names(m), ["web"]);
        let w = child(sites, "mono-wt");
        assert_eq!(w.kind, Kind::Project);
        assert!(w.flags.is_worktree());
        assert!(w.children.is_empty(), "no subprojects for a worktree");
        let json = serde_json::to_value(w).unwrap();
        assert_eq!(json["flags"]["worktree"], true);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directories_are_not_followed() {
        use std::os::unix::fs::symlink;
        let (_t, base) = base();
        let root = base.join("ws");
        mk(&root.join("g/real/.git"));
        mk(&base.join("outside/repo/.git"));
        symlink(base.join("outside"), root.join("linkgroup")).unwrap();
        symlink(root.join("g/real"), root.join("g/linked")).unwrap();
        let mono = root.join("g/mono");
        mk(&mono.join(".git"));
        mk(&base.join("elsewhere/web"));
        touch(&base.join("elsewhere/web/package.json"));
        symlink(base.join("elsewhere"), mono.join("apps")).unwrap();
        let trees = scan(&[s(&root)], None);
        assert_eq!(names(&trees[0]), ["g"]);
        let g = child(&trees[0], "g");
        assert_eq!(names(g), ["mono", "real"]);
        assert!(child(g, "mono").children.is_empty());
    }

    #[test]
    fn roots_are_cleaned_deduped_and_capped() {
        let (_t, base) = base();
        let root = develop(&base);
        let r = s(&root);
        let trees = scan(
            &[
                format!("{r}/"),
                r.clone(),
                "relative".into(),
                format!("{r}/../Develop"),
                s(&base.join("missing")),
            ],
            None,
        );
        assert_eq!(trees.len(), 1);
        assert_eq!(trees[0].path, r, "trailing slash dropped");

        fn count(n: &WorkspaceNode) -> usize {
            1 + n.children.iter().map(count).sum::<usize>()
        }
        let full = count(&scan(std::slice::from_ref(&r), None)[0]);
        let capped = scan_with_cap(std::slice::from_ref(&r), None, 5);
        assert_eq!(count(&capped[0]), 5);
        assert!(full > 5);
        assert!(scan_with_cap(&[r], None, 0).is_empty());
    }

    #[test]
    fn openable_paths_skip_groups_and_register_with_the_allowlist() {
        let (_t, base) = base();
        let root = develop(&base);
        let trees = scan(&[s(&root)], None);
        let paths = openable_paths(&trees);
        assert!(paths.contains(&root));
        assert!(paths.contains(&root.join("products/mine/mineui")));
        assert!(paths.contains(&root.join("sites/i4c-sites/apps/sparkle")));
        assert!(paths.contains(&root.join("lab/feature-specs")));
        assert!(!paths.contains(&root.join("products")));
        assert!(!paths.contains(&root.join("products/mine")));

        register(&trees);
        assert!(is_workspace_root(&root));
        assert!(!is_workspace_root(&root.join("products")));
        let md = s(&root.join("PROJECTS.md"));
        assert!(allowed(&md, Access::Write).is_ok());
        let sub = s(&root.join("sites/i4c-sites/apps/sparkle/.claude/settings.json"));
        assert!(allowed(&sub, Access::Write).is_ok());
        let other = s(&root.join("products/aibou/src/main.ts"));
        assert!(allowed(&other, Access::Read).is_err());
        let group = s(&root.join("products/CLAUDE.md"));
        assert!(
            allowed(&group, Access::Read).is_err(),
            "groups are not project roots"
        );
    }

    #[test]
    fn shape_is_camel_case_and_lowercase_kinds() {
        let (_t, base) = base();
        let root = develop(&base);
        let json = serde_json::to_value(&scan(&[s(&root)], None)[0]).unwrap();
        assert_eq!(json["kind"], "root");
        for key in ["path", "name", "kind", "flags", "children"] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert!(json["flags"].get("claudeMd").is_some());
        let products = &json["children"][2];
        assert_eq!(products["kind"], "group");
        assert_eq!(products["children"][0]["kind"], "project");
    }

    #[test]
    fn claude_md_is_created_with_focus_or_amended_once() {
        let (_t, base) = base();
        let root = develop(&base);
        let target = root.join("CLAUDE.md");
        assert_eq!(
            ensure_claude_md_at(&root, &target).unwrap(),
            ClaudeMdOutcome::Created
        );
        let text = fs::read_to_string(&target).unwrap();
        assert_eq!(
            text,
            format!("# Develop workspace\n\n{IMPORT_PARAGRAPH}\n\nCurrent focus: @FOCUS.md\n")
        );
        assert_eq!(
            ensure_claude_md_at(&root, &target).unwrap(),
            ClaudeMdOutcome::Unchanged
        );

        // Without FOCUS.md there is no focus line.
        let other = base.join("Other");
        mk(&other);
        ensure_claude_md_at(&other, &other.join("CLAUDE.md")).unwrap();
        assert!(
            !fs::read_to_string(other.join("CLAUDE.md"))
                .unwrap()
                .contains("FOCUS")
        );

        // An existing file without the import gets the paragraph appended, nothing else.
        let own = base.join("Own");
        mk(&own);
        fs::write(own.join("CLAUDE.md"), "# Mine\n\nKeep this.").unwrap();
        assert_eq!(
            ensure_claude_md_at(&own, &own.join("CLAUDE.md")).unwrap(),
            ClaudeMdOutcome::Amended
        );
        assert_eq!(
            fs::read_to_string(own.join("CLAUDE.md")).unwrap(),
            format!("# Mine\n\nKeep this.\n\n{IMPORT_PARAGRAPH}\n")
        );
        assert_eq!(
            ensure_claude_md_at(&own, &own.join("CLAUDE.md")).unwrap(),
            ClaudeMdOutcome::Unchanged
        );
        assert_eq!(amended_claude_md(""), Some(format!("{IMPORT_PARAGRAPH}\n")));
        assert_eq!(amended_claude_md("see @PROJECTS.md\n"), None);
    }

    #[test]
    fn additional_dirs_keep_other_keys_and_hand_added_entries() {
        let (_t, base) = base();
        let path = base.join("p/.claude/settings.json");

        // Nothing to add and no file: no file is created.
        assert!(
            set_additional_dirs_at(&path, &[], &["/w/a".into()])
                .unwrap()
                .is_empty()
        );
        assert!(!path.exists());

        // Missing file: created with just the array.
        let got = set_additional_dirs_at(&path, &["/w/a/".into()], &["/w/a".into()]).unwrap();
        assert_eq!(got, ["/w/a"]);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"permissions\": {\n    \"additionalDirectories\": [\n      \"/w/a\"\n    ]\n  }\n}\n"
        );

        // Existing file: other keys and their order survive, hand-added entries stay,
        // managed entries that are no longer related go, new ones are appended.
        fs::write(
            &path,
            r#"{"zeta":1,"permissions":{"deny":["x"],"additionalDirectories":["/hand","/w/a","/w/b"],"allow":["y"]},"alpha":true}"#,
        )
        .unwrap();
        let managed: Vec<String> = ["/w/a", "/w/b", "/w/c"].map(String::from).to_vec();
        let got = set_additional_dirs_at(&path, &["/w/b".into(), "/w/c".into()], &managed).unwrap();
        assert_eq!(got, ["/hand", "/w/b", "/w/c"]);
        let text = fs::read_to_string(&path).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["zeta", "permissions", "alpha"]);
        let pkeys: Vec<&String> = v["permissions"].as_object().unwrap().keys().collect();
        assert_eq!(pkeys, ["deny", "additionalDirectories", "allow"]);
        assert!(
            !text.ends_with('\n'),
            "no trailing newline added when there was none"
        );

        // No change: the file is not rewritten.
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        set_additional_dirs_at(&path, &["/w/c".into(), "/w/b".into()], &managed).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);

        // Removing everything keeps the hand-added entry.
        assert_eq!(
            set_additional_dirs_at(&path, &[], &managed).unwrap(),
            ["/hand"]
        );

        // Bad shapes and relative paths are errors, the file is left alone.
        assert!(set_additional_dirs_at(&path, &["rel".into()], &managed).is_err());
        fs::write(&path, r#"{"permissions":{"additionalDirectories":"/x"}}"#).unwrap();
        assert!(set_additional_dirs_at(&path, &["/w/a".into()], &managed).is_err());
        fs::write(&path, r#"{"permissions":[]}"#).unwrap();
        assert!(set_additional_dirs_at(&path, &["/w/a".into()], &managed).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"permissions":[]}"#);
    }
}
