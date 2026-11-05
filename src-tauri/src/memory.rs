//! Claude Code project memory dirs (CONTRACT.md "Memory").
//!
//! `~/.claude/projects/<encoded>/memory/`, where `<encoded>` is the project path
//! with every non-alphanumeric character replaced by `-` (Claude Code's scheme:
//! `/home/me/Develop/sites/i4c-sites` -> `-home-me-Develop-sites-i4c-sites`,
//! `/home/me/.config` -> `-home-me--config`). Decoding is ambiguous, so it is
//! resolved against the filesystem: at each directory, try the entries whose
//! encoded name matches the longest prefix of what is left, backtracking when a
//! branch dead-ends.
//!
//! `memory_graph` (CONTRACT.md "Memory graph") reads every note in those dirs and
//! resolves the `[[links]]` between them. Read only.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::files::{blocking, claude_dir, home_dir};

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

// ---------------------------------------------------------------------------
// Memory graph

/// The index file of a memory dir; not a note.
const INDEX: &str = "MEMORY.md";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// Absolute path of the note.
    pub id: String,
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// Decoded project path of the memory dir; null for the home dir (and for a
    /// dir whose project folder no longer exists).
    pub project: Option<String>,
    pub bytes: u64,
    pub links: usize,
    pub backlinks: usize,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq, Hash)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq, Hash)]
pub struct Unresolved {
    pub from: String,
    pub target: String,
}

#[derive(Serialize, Debug, Default)]
pub struct MemoryGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub unresolved: Vec<Unresolved>,
}

/// The fields of the simple `---` frontmatter block the graph needs, and the body after it.
#[derive(Debug, Default, PartialEq)]
struct Front<'a> {
    name: Option<String>,
    description: Option<String>,
    kind: Option<String>,
    body: &'a str,
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let quoted = v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
    if quoted { &v[1..v.len() - 1] } else { v }.to_string()
}

/// `name`, `description` and `metadata.type` from a leading `---` block; other keys are ignored.
fn parse_front(text: &str) -> Front<'_> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Front {
        body: text,
        ..Front::default()
    };
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return out;
    };
    let mut in_metadata = false;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        let l = line.trim_end_matches(['\n', '\r']);
        if l.trim_end() == "---" {
            out.body = &rest[offset..];
            return out;
        }
        let indented = l.starts_with(' ') || l.starts_with('\t');
        let Some((key, value)) = l.trim().split_once(':') else {
            continue;
        };
        let value = unquote(value);
        let value = (!value.is_empty()).then_some(value);
        if indented {
            if in_metadata && key.trim() == "type" {
                out.kind = value;
            }
            continue;
        }
        in_metadata = key == "metadata";
        match key {
            "name" => out.name = value,
            "description" => out.description = value,
            _ => {}
        }
    }
    // No closing `---`: not frontmatter after all.
    Front {
        body: text,
        ..Front::default()
    }
}

/// The first `# ` heading of the body.
fn first_h1(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim)
        .find_map(|l| l.strip_prefix("# ").map(|t| t.trim().to_string()))
        .filter(|t| !t.is_empty())
}

/// `[[target]]` and `[[target|label]]` targets, in order (empty ones dropped).
fn link_targets(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let inner = &after[..end];
        // A `[[` inside the brackets starts a new link; skip to it.
        if let Some(nested) = inner.rfind("[[") {
            rest = &after[nested..];
            continue;
        }
        let target = inner.split('|').next().unwrap_or("").trim();
        if !target.is_empty() && !target.contains('\n') {
            out.push(target.to_string());
        }
        rest = &after[end + 2..];
    }
    out
}

struct Parsed {
    node: GraphNode,
    dir: usize,
    stem: String,
    targets: Vec<String>,
    is_index: bool,
}

fn read_dir_notes(dir: &Path, dir_idx: usize, project: Option<&str>) -> Vec<Parsed> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "md"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .filter_map(|path| {
            let text = fs::read_to_string(&path).ok()?;
            let file = path.file_name()?.to_string_lossy().into_owned();
            let stem = path.file_stem()?.to_string_lossy().into_owned();
            let front = parse_front(&text);
            let name = front.name.clone().unwrap_or_else(|| stem.clone());
            let is_index = file == INDEX;
            Some(Parsed {
                node: GraphNode {
                    id: path.to_string_lossy().into_owned(),
                    title: first_h1(front.body).unwrap_or_else(|| name.clone()),
                    name: if is_index { INDEX.to_string() } else { name },
                    description: front.description,
                    kind: front.kind,
                    project: project.map(str::to_string),
                    bytes: text.len() as u64,
                    links: 0,
                    backlinks: 0,
                },
                dir: dir_idx,
                stem,
                targets: link_targets(front.body),
                is_index,
            })
        })
        .collect()
}

/// Pick a candidate: the first one in `dir`, else the first.
fn pick(cands: Option<&Vec<usize>>, parsed: &[Parsed], dir: usize) -> Option<usize> {
    let c = cands?;
    c.iter()
        .copied()
        .find(|&i| parsed[i].dir == dir)
        .or_else(|| c.first().copied())
}

/// The graph over the given memory dirs, each with its project path (None = home).
pub fn build_graph(dirs: &[(PathBuf, Option<String>)]) -> MemoryGraph {
    let parsed: Vec<Parsed> = dirs
        .iter()
        .enumerate()
        .flat_map(|(i, (dir, project))| read_dir_notes(dir, i, project.as_deref()))
        .collect();

    // name: slugs first, then file stems; lower-cased, in walk order. Index files are not targets.
    let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_stem: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, p) in parsed.iter().enumerate().filter(|(_, p)| !p.is_index) {
        by_name
            .entry(p.node.name.to_lowercase())
            .or_default()
            .push(i);
        by_stem.entry(p.stem.to_lowercase()).or_default().push(i);
    }

    let mut edges: Vec<(usize, usize)> = Vec::new();
    let mut seen_edges: HashSet<(usize, usize)> = HashSet::new();
    let mut unresolved: Vec<(usize, String)> = Vec::new();
    let mut seen_unresolved: HashSet<(usize, String)> = HashSet::new();
    // Index files become nodes only when they have something to draw.
    let mut index_used: HashSet<usize> = HashSet::new();

    for (i, p) in parsed.iter().enumerate() {
        for target in &p.targets {
            let key = target.to_lowercase();
            let hit = pick(by_name.get(&key), &parsed, p.dir)
                .or_else(|| pick(by_stem.get(&key), &parsed, p.dir));
            match hit {
                Some(j) if j == i => {}
                // The index links every note of its own dir by design.
                Some(j) if p.is_index && parsed[j].dir == p.dir => {}
                Some(j) => {
                    if seen_edges.insert((i, j)) {
                        edges.push((i, j));
                        if p.is_index {
                            index_used.insert(i);
                        }
                    }
                }
                None => {
                    if seen_unresolved.insert((i, key)) {
                        unresolved.push((i, target.clone()));
                        if p.is_index {
                            index_used.insert(i);
                        }
                    }
                }
            }
        }
    }

    let mut links = vec![0usize; parsed.len()];
    let mut backlinks = vec![0usize; parsed.len()];
    for &(a, b) in &edges {
        links[a] += 1;
        backlinks[b] += 1;
    }
    let id = |i: usize| parsed[i].node.id.clone();
    MemoryGraph {
        edges: edges
            .iter()
            .map(|&(a, b)| GraphEdge {
                from: id(a),
                to: id(b),
            })
            .collect(),
        unresolved: unresolved
            .iter()
            .map(|(a, t)| Unresolved {
                from: id(*a),
                target: t.clone(),
            })
            .collect(),
        nodes: parsed
            .iter()
            .enumerate()
            .filter(|(i, p)| !p.is_index || index_used.contains(i))
            .map(|(i, p)| GraphNode {
                links: links[i],
                backlinks: backlinks[i],
                ..p.node.clone()
            })
            .collect(),
    }
}

/// Every memory dir `list_projects` finds, with its project path (None for the home dir).
pub fn graph_dirs(projects_dir: &Path, home: &Path) -> Vec<(PathBuf, Option<String>)> {
    let home = home.to_string_lossy();
    let home = home.trim_end_matches('/');
    list_projects(projects_dir)
        .into_iter()
        .map(|p| {
            let project = p.guessed_path.filter(|g| g.trim_end_matches('/') != home);
            (PathBuf::from(p.dir), project)
        })
        .collect()
}

#[tauri::command]
pub async fn memory_graph() -> Result<MemoryGraph, String> {
    blocking(|| {
        let dirs = graph_dirs(&claude_dir()?.join("projects"), &home_dir()?);
        Ok(build_graph(&dirs))
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

    // -----------------------------------------------------------------------
    // memory graph

    fn note(dir: &Path, file: &str, name: Option<&str>, body: &str) -> String {
        let front = match name {
            Some(n) => {
                format!("---\nname: {n}\ndescription: about {n}\nmetadata:\n  type: project\n---\n")
            }
            None => String::new(),
        };
        let path = dir.join(file);
        fs::write(&path, format!("{front}{body}")).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn edge(g: &MemoryGraph, from: &str, to: &str) -> bool {
        g.edges.iter().any(|e| e.from == from && e.to == to)
    }

    fn node<'a>(g: &'a MemoryGraph, id: &str) -> &'a GraphNode {
        g.nodes.iter().find(|n| n.id == id).unwrap()
    }

    /// Two memory dirs, a and b, each its own project.
    fn two_dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let (t, base) = base();
        let a = base.join("a/memory");
        let b = base.join("b/memory");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        (t, a, b)
    }

    fn dirs(a: &Path, b: &Path) -> Vec<(PathBuf, Option<String>)> {
        vec![
            (a.to_path_buf(), Some("/p/a".into())),
            (b.to_path_buf(), None),
        ]
    }

    #[test]
    fn parses_frontmatter() {
        let f = parse_front(
            "---\nname: \"x-y\"\ndescription: one line: with colon\nmetadata:\n  node_type: memory\n  type: feedback\nother: 1\n---\n# Title\nbody",
        );
        assert_eq!(f.name.as_deref(), Some("x-y"));
        assert_eq!(f.description.as_deref(), Some("one line: with colon"));
        assert_eq!(f.kind.as_deref(), Some("feedback"));
        assert_eq!(f.body, "# Title\nbody");
        assert_eq!(first_h1(f.body).as_deref(), Some("Title"));
        // `type` outside metadata is not the memory type.
        let g = parse_front("---\ntags:\n  type: nope\n---\n");
        assert_eq!(g.kind, None);
        // No closing fence: no frontmatter.
        let h = parse_front("---\nname: x\nno end");
        assert_eq!(h.name, None);
        assert_eq!(h.body, "---\nname: x\nno end");
    }

    #[test]
    fn link_syntax() {
        assert_eq!(
            link_targets("see [[a]], [[B|label]] and [[ c ]] but not [[]] or [[x\ny]] [[[[d]]"),
            vec!["a", "B", "c", "d"]
        );
    }

    #[test]
    fn resolves_across_dirs_names_then_stems() {
        let (_t, a, b) = two_dirs();
        let a1 = note(
            &a,
            "a1.md",
            Some("alpha"),
            "# Alpha one\n[[beta]] [[b-stem]] [[ALPHA-TWO]] [[alpha]]",
        );
        let a2 = note(
            &a,
            "a2.md",
            Some("alpha-two"),
            "[[Alpha|the alpha]] [[alpha]]",
        );
        let b1 = note(&b, "b-stem.md", Some("beta"), "no links");
        let g = build_graph(&dirs(&a, &b));

        assert_eq!(g.nodes.len(), 3);
        assert!(edge(&g, &a1, &b1), "name match across dirs");
        assert!(edge(&g, &a1, &a2), "case-insensitive name");
        assert!(edge(&g, &a2, &a1), "alias part before |");
        // [[beta]] and [[b-stem]] both hit b1: one edge; the self link is dropped.
        assert_eq!(g.edges.len(), 3);
        assert!(!edge(&g, &a1, &a1));
        assert!(g.unresolved.is_empty());

        let n = node(&g, &a1);
        assert_eq!(n.name, "alpha");
        assert_eq!(n.title, "Alpha one");
        assert_eq!(n.description.as_deref(), Some("about alpha"));
        assert_eq!(n.kind.as_deref(), Some("project"));
        assert_eq!(n.project.as_deref(), Some("/p/a"));
        assert_eq!((n.links, n.backlinks), (2, 1));
        assert_eq!(node(&g, &b1).project, None);
        assert_eq!((node(&g, &b1).links, node(&g, &b1).backlinks), (0, 1));
        assert_eq!(node(&g, &a2).title, "alpha-two", "no H1: the name");
        assert!(node(&g, &a1).bytes > 0);
    }

    #[test]
    fn name_wins_over_stem_and_ties_go_to_same_dir() {
        let (_t, a, b) = two_dirs();
        // "shared" is a name in both dirs and a stem in a.
        let a_named = note(&a, "a-named.md", Some("shared"), "");
        note(&a, "shared.md", Some("something-else"), "");
        let b_named = note(&b, "b-named.md", Some("shared"), "");
        let a_src = note(&a, "src.md", None, "[[shared]]");
        let b_src = note(&b, "src2.md", None, "[[shared]]");
        let g = build_graph(&dirs(&a, &b));
        assert!(edge(&g, &a_src, &a_named));
        assert!(edge(&g, &b_src, &b_named));
        assert_eq!(g.edges.len(), 2);
        // A note without frontmatter is named after its stem.
        assert_eq!(node(&g, &a_src).name, "src");
    }

    #[test]
    fn reports_unresolved_once() {
        let (_t, a, b) = two_dirs();
        let a1 = note(
            &a,
            "a1.md",
            Some("alpha"),
            "[[ghost]] [[Ghost|again]] [[other-ghost]]",
        );
        let g = build_graph(&dirs(&a, &b));
        assert!(g.edges.is_empty());
        assert_eq!(
            g.unresolved,
            vec![
                Unresolved {
                    from: a1.clone(),
                    target: "ghost".into()
                },
                Unresolved {
                    from: a1,
                    target: "other-ghost".into()
                },
            ]
        );
    }

    #[test]
    fn memory_index_handling() {
        let (_t, a, b) = two_dirs();
        let a1 = note(&a, "a1.md", Some("alpha"), "");
        let b1 = note(&b, "b1.md", Some("beta"), "");
        // a's index links its own note (ignored) and b's (an edge from the index node).
        let a_index = note(&a, "MEMORY.md", None, "# Index\n- [[alpha]]\n- [[beta]]\n");
        // b's index only links its own note: no node.
        let b_index = note(&b, "MEMORY.md", None, "- [[beta]]\n");
        // An index is not a link target.
        let a2 = note(&a, "a2.md", Some("alpha-two"), "[[MEMORY]]");
        let g = build_graph(&dirs(&a, &b));

        assert!(edge(&g, &a_index, &b1));
        assert!(!edge(&g, &a_index, &a1));
        assert!(g.nodes.iter().all(|n| n.id != b_index));
        let idx = node(&g, &a_index);
        assert_eq!(idx.name, "MEMORY.md");
        assert_eq!((idx.links, idx.backlinks), (1, 0));
        assert_eq!(node(&g, &b1).backlinks, 1);
        assert_eq!(node(&g, &a1).backlinks, 0);
        assert_eq!(g.nodes.len(), 4);
        assert_eq!(
            g.unresolved,
            vec![Unresolved {
                from: a2,
                target: "MEMORY".into()
            }]
        );
    }

    #[test]
    fn graph_dirs_marks_home() {
        let (_t, base) = base();
        let home = base.join("home");
        let project = home.join("proj");
        fs::create_dir_all(&project).unwrap();
        let projects = base.join("claude/projects");
        for p in [&home, &project] {
            fs::create_dir_all(projects.join(enc(p)).join("memory")).unwrap();
        }
        let d = graph_dirs(&projects, &home);
        assert_eq!(d.len(), 2);
        let home_dir = d
            .iter()
            .find(|(dir, _)| dir.starts_with(projects.join(enc(&home))))
            .unwrap();
        assert_eq!(home_dir.1, None);
        let proj = d
            .iter()
            .find(|(dir, _)| dir.starts_with(projects.join(enc(&project))))
            .unwrap();
        assert_eq!(proj.1.as_deref(), Some(project.to_string_lossy().as_ref()));

        let json = serde_json::to_value(build_graph(&d)).unwrap();
        for key in ["nodes", "edges", "unresolved"] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }

    #[test]
    fn node_json_shape() {
        let (_t, a, b) = two_dirs();
        note(&a, "a1.md", Some("alpha"), "");
        let g = build_graph(&dirs(&a, &b));
        let json = serde_json::to_value(&g.nodes[0]).unwrap();
        for key in [
            "id",
            "name",
            "title",
            "description",
            "type",
            "project",
            "bytes",
            "links",
            "backlinks",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }
}
