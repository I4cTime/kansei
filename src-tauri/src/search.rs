//! Session search (CONTRACT.md "Session search").
//!
//! Full text search runs over an extracted text index, not over the raw
//! transcripts: most of a transcript is noise for search (thinking blocks,
//! tool payloads, request blobs, attachments).
//!
//! - `<appData>/search/<sessionId>.txt`: one record per line,
//!   `<ts ms>\t<u|a>\t<text>`, whitespace runs collapsed to one space, the text
//!   cut at `TEXT_MAX_CHARS` characters. A session's subagent transcripts
//!   (`<project>/<sessionId>/**/*.jsonl`) go into the same file.
//! - `<appData>/search/index.json`: `{ version, files: { <transcript path>:
//!   { size, mtimeMs, sessionId, project } } }`. A refresh re-extracts every
//!   session one of whose transcripts appeared, changed size or mtime, or went.
//!
//! Transcripts are read line by line; lines whose `type` is not `user` or
//! `assistant` are dropped from the raw prefix when they start with `type`,
//! and otherwise by a field visitor that aborts the parse as soon as the line
//! is known to carry nothing (another type, `isMeta`, a sidechain line in a
//! main transcript, a message without text parts). Nothing is written under
//! `~/.claude`.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};

use crate::files::{app_data_dir, blocking, claude_dir};
use crate::memory::decode_project_path;
use crate::sessions::{self, NO_PROMPT_TITLE};
pub use crate::transcripts::IndexStatus;
use crate::transcripts::{
    IndexKind, Manifest, for_each_line, load_manifest, par_map, parse_iso_ms, refresh_index,
};

const INDEX_VERSION: u32 = 1;
/// Characters kept per record.
const TEXT_MAX_CHARS: usize = 4000;
/// Characters of a hit's snippet (markers not counted).
const SNIPPET_CHARS: usize = 160;
/// Hits returned when the caller gives no limit.
const DEFAULT_LIMIT: usize = 50;
/// Marks around a match in a snippet.
pub const MARK_START: char = '\u{1}';
pub const MARK_END: char = '\u{2}';

/// One refresh at a time; a second caller waits and then finds little to do.
static REFRESH: Mutex<()> = Mutex::new(());
static SEARCH_INDEX: IndexKind = IndexKind {
    version: INDEX_VERSION,
    ext: "txt",
    name: "search",
    lock: &REFRESH,
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub project: Option<String>,
    pub title: String,
    pub ts: i64,
    /// "user" | "assistant".
    pub role: String,
    /// About `SNIPPET_CHARS` characters around the first match, every match of
    /// a term inside it wrapped in `MARK_START` / `MARK_END`.
    pub snippet: String,
    /// Matching records in this session.
    pub hits: usize,
    pub transcript_path: String,
}

/// One extracted message.
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub ts: i64,
    /// 'u' or 'a'.
    pub role: char,
    pub text: String,
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/// Why a line parse was abandoned early (any error drops the line).
const SKIP: &str = "skip";

#[derive(Deserialize)]
#[serde(field_identifier, rename_all = "camelCase")]
enum Field {
    Type,
    IsMeta,
    IsSidechain,
    Timestamp,
    Message,
    #[serde(other)]
    Other,
}

#[derive(Deserialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Kind {
    User,
    Assistant,
    #[serde(other)]
    Other,
}

/// A `message.content` part; only `text` parts are kept.
#[derive(Deserialize)]
struct Part<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<Cow<'a, str>>,
    text: Option<String>,
}

/// `message.content`: a string, or an array of parts whose `text` parts are kept.
struct Content(Vec<String>);

impl<'de> Deserialize<'de> for Content {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Content;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a string or an array of content parts")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Content, E> {
                Ok(Content(vec![v.to_owned()]))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Content, E> {
                Ok(Content(vec![v]))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Content, A::Error> {
                let mut out = Vec::new();
                while let Some(p) = seq.next_element::<Part>()? {
                    if p.kind.as_deref() == Some("text")
                        && let Some(t) = p.text
                    {
                        out.push(t);
                    }
                }
                Ok(Content(out))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Content, E> {
                Ok(Content(Vec::new()))
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Deserialize)]
struct Message {
    content: Option<Content>,
}

/// What a kept line yields before normalisation.
struct LineFields {
    kind: Kind,
    ts: Option<i64>,
    texts: Vec<String>,
}

/// Visits one transcript line's top-level object, failing with `SKIP` as soon
/// as the line is known to carry no searchable text.
struct LineSeed {
    keep_sidechain: bool,
}

impl<'de> DeserializeSeed<'de> for LineSeed {
    type Value = LineFields;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<LineFields, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for LineSeed {
    type Value = LineFields;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a transcript line")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<LineFields, A::Error> {
        let skip = || de::Error::custom(SKIP);
        let mut kind: Option<Kind> = None;
        let mut ts: Option<i64> = None;
        let mut texts: Option<Vec<String>> = None;
        while let Some(key) = map.next_key::<Field>()? {
            match key {
                Field::Type => {
                    let k = map.next_value::<Kind>()?;
                    if k == Kind::Other {
                        return Err(skip());
                    }
                    kind = Some(k);
                }
                Field::IsMeta => {
                    if map.next_value::<Option<bool>>()? == Some(true) {
                        return Err(skip());
                    }
                }
                Field::IsSidechain => {
                    if map.next_value::<Option<bool>>()? == Some(true) && !self.keep_sidechain {
                        return Err(skip());
                    }
                }
                Field::Timestamp => {
                    let s = map.next_value::<Option<Cow<str>>>()?;
                    ts = s.as_deref().and_then(parse_iso_ms);
                }
                Field::Message => {
                    let m = map.next_value::<Option<Message>>()?;
                    let t: Vec<String> = m
                        .and_then(|m| m.content)
                        .map(|c| c.0)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|t| !t.trim().is_empty())
                        .collect();
                    if t.is_empty() {
                        return Err(skip());
                    }
                    texts = Some(t);
                }
                Field::Other => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        match (kind, texts) {
            (Some(kind), Some(texts)) => Ok(LineFields { kind, ts, texts }),
            _ => Err(skip()),
        }
    }
}

/// Join text parts, collapse whitespace runs (tabs and newlines included) to
/// one space and cut at `TEXT_MAX_CHARS` characters.
fn normalise(parts: &[String]) -> String {
    let mut out = String::new();
    let mut chars = 0;
    'outer: for p in parts {
        for w in p.split_whitespace() {
            let need_space = !out.is_empty();
            for c in need_space.then_some(' ').into_iter().chain(w.chars()) {
                if chars == TEXT_MAX_CHARS {
                    break 'outer;
                }
                out.push(c);
                chars += 1;
            }
        }
    }
    out
}

/// The record a transcript line yields, if any. `keep_sidechain` is true for
/// subagent transcripts, whose every line is a sidechain line.
pub fn extract_line(line: &[u8], keep_sidechain: bool) -> Option<Record> {
    const TYPE_PREFIX: &[u8] = br#"{"type":""#;
    if let Some(rest) = line.strip_prefix(TYPE_PREFIX)
        && !rest.starts_with(br#"user""#)
        && !rest.starts_with(br#"assistant""#)
    {
        return None;
    }
    if !line.starts_with(b"{") {
        return None;
    }
    let mut de = serde_json::Deserializer::from_slice(line);
    let f = LineSeed { keep_sidechain }.deserialize(&mut de).ok()?;
    let text = normalise(&f.texts);
    if text.is_empty() {
        return None;
    }
    let role = match f.kind {
        Kind::User => 'u',
        Kind::Assistant => 'a',
        Kind::Other => return None,
    };
    Some(Record {
        ts: f.ts.unwrap_or(0),
        role,
        text,
    })
}

/// Every record of a transcript, read line by line. A record without a
/// timestamp takes the previous record's.
pub fn extract_file(path: &Path, keep_sidechain: bool) -> Vec<Record> {
    let mut out = Vec::new();
    let mut last_ts = 0;
    for_each_line(path, |line| {
        if let Some(mut rec) = extract_line(line, keep_sidechain) {
            if rec.ts == 0 {
                rec.ts = last_ts;
            }
            last_ts = rec.ts;
            out.push(rec);
        }
    });
    out
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

fn records_path(dir: &Path, session_id: &str) -> PathBuf {
    SEARCH_INDEX.session_path(dir, session_id)
}

fn load_index(dir: &Path) -> Manifest {
    load_manifest(dir, INDEX_VERSION)
}

fn render_records(records: &[Record]) -> String {
    let mut s = String::new();
    for r in records {
        s.push_str(&r.ts.to_string());
        s.push('\t');
        s.push(r.role);
        s.push('\t');
        s.push_str(&r.text);
        s.push('\n');
    }
    s
}

/// Bring the index in `index_dir` up to date with the transcripts under
/// `projects`. Pure apart from reading `projects` and writing `index_dir`.
pub fn refresh(
    projects: &Path,
    index_dir: &Path,
    decode: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<IndexStatus, String> {
    refresh_index(&SEARCH_INDEX, projects, index_dir, decode, &|_, files| {
        let mut records: Vec<Record> = Vec::new();
        for f in files {
            records.extend(extract_file(&f.path, f.subagent));
        }
        records.sort_by_key(|r| r.ts);
        Ok((!records.is_empty()).then(|| render_records(&records).into_bytes()))
    })
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// Lowercased terms: words split on whitespace, a double-quoted run kept
/// whole with its spaces. An unclosed quote runs to the end.
pub fn parse_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut rest = query;
    while !rest.is_empty() {
        rest = rest.trim_start();
        if let Some(q) = rest.strip_prefix('"') {
            let (phrase, after) = match q.find('"') {
                Some(i) => (&q[..i], &q[i + 1..]),
                None => (q, ""),
            };
            let phrase = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
            if !phrase.is_empty() {
                terms.push(phrase.to_lowercase());
            }
            rest = after;
        } else {
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '"')
                .unwrap_or(rest.len());
            let word = &rest[..end];
            if !word.is_empty() {
                terms.push(word.to_lowercase());
            }
            rest = &rest[end..];
        }
    }
    terms.sort();
    terms.dedup();
    terms
}

/// Lowercase `text` into `out` (ASCII fast path).
fn lower_into(text: &str, out: &mut String) {
    out.clear();
    if text.is_ascii() {
        out.push_str(text);
        out.make_ascii_lowercase();
    } else {
        out.extend(text.chars().flat_map(char::to_lowercase));
    }
}

/// `text` cut to `SNIPPET_CHARS` characters around the first match of any
/// term, every term match inside the cut wrapped in the mark characters.
pub fn snippet(text: &str, terms: &[String]) -> String {
    let chars: Vec<char> = text.chars().collect();
    // Lowercase with, per lowercase byte, the index of the source char.
    let mut lower = String::new();
    let mut src: Vec<usize> = Vec::new();
    for (i, c) in chars.iter().enumerate() {
        for l in c.to_lowercase() {
            lower.push(l);
            src.resize(lower.len(), i);
        }
    }
    let to_char = |byte: usize| src.get(byte).copied().unwrap_or(chars.len());
    // Every match as a char range, merged.
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for t in terms.iter().filter(|t| !t.is_empty()) {
        let mut from = 0;
        while let Some(i) = lower[from..].find(t.as_str()) {
            let b = from + i;
            let start = to_char(b);
            let end = to_char(b + t.len() - 1) + 1;
            ranges.push((start, end));
            from = b + t.len();
        }
    }
    ranges.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in ranges {
        match merged.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    let (win_start, win_end) = match merged.first() {
        None => (0, chars.len().min(SNIPPET_CHARS)),
        Some(&(s, e)) => {
            let len = e - s;
            if len >= SNIPPET_CHARS {
                (s, s + SNIPPET_CHARS)
            } else {
                let start = s.saturating_sub((SNIPPET_CHARS - len) / 2);
                let end = (start + SNIPPET_CHARS).min(chars.len());
                (end.saturating_sub(SNIPPET_CHARS), end)
            }
        }
    };
    let inside = |i: usize| merged.iter().any(|&(s, e)| s <= i && i < e);
    let mut out = String::new();
    for (i, c) in chars.iter().enumerate().take(win_end).skip(win_start) {
        let here = inside(i);
        if here && (i == win_start || !inside(i - 1)) {
            out.push(MARK_START);
        }
        out.push(*c);
        if here && (i + 1 == win_end || !inside(i + 1)) {
            out.push(MARK_END);
        }
    }
    out
}

/// The best (latest) matching record of one session and the match count.
struct SessionMatch {
    ts: i64,
    role: char,
    text: String,
    hits: usize,
}

fn scan_session(path: &Path, terms: &[String]) -> Option<SessionMatch> {
    let f = fs::File::open(path).ok()?;
    let mut r = BufReader::with_capacity(64 * 1024, f);
    let mut line = String::new();
    let mut lower = String::new();
    let mut best: Option<SessionMatch> = None;
    let mut hits = 0;
    loop {
        line.clear();
        match r.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let rec = line.trim_end_matches(['\n', '\r']);
        let mut parts = rec.splitn(3, '\t');
        let (Some(ts), Some(role), Some(text)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        lower_into(text, &mut lower);
        if !terms.iter().all(|t| lower.contains(t.as_str())) {
            continue;
        }
        hits += 1;
        let ts = ts.parse::<i64>().unwrap_or(0);
        if best.as_ref().is_none_or(|b| ts >= b.ts) {
            best = Some(SessionMatch {
                ts,
                role: role.chars().next().unwrap_or('u'),
                text: text.to_owned(),
                hits: 0,
            });
        }
    }
    best.map(|mut b| {
        b.hits = hits;
        b
    })
}

/// What `sessions_list` knows about a session.
pub struct SessionMeta {
    pub title: String,
    pub project: Option<String>,
    pub transcript_path: Option<String>,
}

/// Search the index in `index_dir`. `meta` supplies titles and projects.
pub fn search(
    index_dir: &Path,
    query: &str,
    limit: usize,
    meta: &HashMap<String, SessionMeta>,
) -> Vec<SearchHit> {
    let terms = parse_terms(query);
    if terms.is_empty() || limit == 0 {
        return Vec::new();
    }
    let index = load_index(index_dir);
    // Per session: its project and main transcript from the index.
    let mut sessions: BTreeMap<&str, (Option<&str>, Option<&str>)> = BTreeMap::new();
    for (path, e) in &index.files {
        let s = sessions
            .entry(e.session_id.as_str())
            .or_insert((None, None));
        if s.0.is_none() {
            s.0 = e.project.as_deref();
        }
        let main =
            Path::new(path).file_stem().and_then(|x| x.to_str()) == Some(e.session_id.as_str());
        if main {
            s.1 = Some(path.as_str());
        }
    }
    let list: Vec<(&str, Option<&str>, Option<&str>)> = sessions
        .into_iter()
        .map(|(id, (p, t))| (id, p, t))
        .collect();
    let matches = par_map(&list, |(id, _, _)| {
        scan_session(&records_path(index_dir, id), &terms)
    });
    let mut hits: Vec<SearchHit> = list
        .iter()
        .zip(matches)
        .filter_map(|((id, project, transcript), m)| {
            let m = m?;
            let info = meta.get(*id);
            let transcript_path = info
                .and_then(|i| i.transcript_path.clone())
                .or_else(|| transcript.map(str::to_owned))?;
            Some(SearchHit {
                session_id: (*id).to_owned(),
                project: info
                    .and_then(|i| i.project.clone())
                    .or_else(|| project.map(str::to_owned)),
                title: info.map_or_else(|| NO_PROMPT_TITLE.to_owned(), |i| i.title.clone()),
                ts: m.ts,
                role: if m.role == 'a' { "assistant" } else { "user" }.to_owned(),
                snippet: snippet(&m.text, &terms),
                hits: m.hits,
                transcript_path,
            })
        })
        .collect();
    hits.sort_by(|a, b| {
        b.ts.cmp(&a.ts)
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    hits.truncate(limit);
    hits
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn index_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("search"))
}

#[tauri::command]
pub async fn search_index_refresh() -> Result<IndexStatus, String> {
    blocking(|| {
        refresh(&claude_dir()?.join("projects"), &index_dir()?, &|enc| {
            decode_project_path(enc).map(|p| p.to_string_lossy().into_owned())
        })
    })
    .await
}

#[tauri::command]
pub async fn search_sessions(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    blocking(move || {
        let meta: HashMap<String, SessionMeta> = sessions::list_all()?
            .into_iter()
            .map(|s| {
                (
                    s.id,
                    SessionMeta {
                        title: s.title,
                        project: s.project,
                        transcript_path: s.transcript_path,
                    },
                )
            })
            .collect();
        Ok(search(
            &index_dir()?,
            &query,
            limit.unwrap_or(DEFAULT_LIMIT),
            &meta,
        ))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcripts::index_json;
    use std::time::{Duration, SystemTime};

    const A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const B: &str = "bbbbbbbb-0000-4000-8000-000000000002";
    const C: &str = "cccccccc-0000-4000-8000-000000000003";

    fn user(text: &str, ts: &str) -> String {
        format!(
            r#"{{"parentUuid":null,"isSidechain":false,"promptId":"p","type":"user","message":{{"role":"user","content":{}}},"uuid":"u","timestamp":"{ts}"}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    fn assistant_text(text: &str, ts: &str) -> String {
        format!(
            r#"{{"parentUuid":"x","isSidechain":false,"message":{{"model":"m","content":[{{"type":"text","text":{}}}],"usage":{{"input_tokens":1}}}},"type":"assistant","uuid":"v","timestamp":"{ts}"}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    #[test]
    fn extraction_of_each_line_kind() {
        let ts = "2026-10-19T00:15:00.259Z";
        let ms = parse_iso_ms(ts).unwrap();
        // User with a string content, as Claude Code writes it with `type` first too.
        let r = extract_line(user("had a\tthought\n about  it", ts).as_bytes(), false).unwrap();
        assert_eq!(
            r,
            Record {
                ts: ms,
                role: 'u',
                text: "had a thought about it".into()
            }
        );
        let typed_first = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"type first"}},"uuid":"u","timestamp":"{ts}"}}"#
        );
        assert_eq!(
            extract_line(typed_first.as_bytes(), false).unwrap().text,
            "type first"
        );
        // User with parts: text kept, images and tool results dropped.
        let parts = format!(
            r#"{{"parentUuid":null,"type":"user","message":{{"role":"user","content":[{{"type":"text","text":"one"}},{{"type":"image","source":{{}}}},{{"type":"text","text":"two"}}]}},"timestamp":"{ts}"}}"#
        );
        assert_eq!(
            extract_line(parts.as_bytes(), false).unwrap().text,
            "one two"
        );
        let tool_result = format!(
            r#"{{"parentUuid":"x","type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t","content":"secret output"}}]}},"toolUseResult":{{"stdout":"big"}},"timestamp":"{ts}"}}"#
        );
        assert_eq!(extract_line(tool_result.as_bytes(), false), None);
        // Assistant: only text parts, never thinking or tool_use.
        let mixed = format!(
            r#"{{"parentUuid":"x","isSidechain":false,"message":{{"model":"m","content":[{{"type":"thinking","thinking":"private musing","signature":"s"}},{{"type":"text","text":"the answer"}},{{"type":"tool_use","id":"t","name":"Bash","input":{{"command":"ls","text":"no"}}}}]}},"type":"assistant","timestamp":"{ts}"}}"#
        );
        let r = extract_line(mixed.as_bytes(), false).unwrap();
        assert_eq!((r.role, r.text.as_str()), ('a', "the answer"));
        let only_tools = r#"{"parentUuid":"x","message":{"content":[{"type":"thinking","thinking":"t"},{"type":"tool_use","input":{}}]},"type":"assistant"}"#;
        assert_eq!(extract_line(only_tools.as_bytes(), false), None);
        // Other types: by prefix and by visitor.
        for line in [
            r#"{"type":"attachment","attachment":{"content":"hello"}}"#.to_owned(),
            r#"{"type":"api-request-blob","message":{"content":"hello"}}"#.to_owned(),
            r#"{"parentUuid":"x","type":"attachment","message":{"content":"hello"}}"#.to_owned(),
            r#"{"parentUuid":"x","message":{"content":"hello"},"type":"system"}"#.to_owned(),
            "not json".to_owned(),
            String::new(),
        ] {
            assert_eq!(extract_line(line.as_bytes(), false), None, "{line}");
        }
        // isMeta always skipped; isSidechain skipped in a main transcript only.
        let meta = format!(
            r#"{{"parentUuid":null,"type":"user","message":{{"content":"caveat"}},"isMeta":true,"timestamp":"{ts}"}}"#
        );
        assert_eq!(extract_line(meta.as_bytes(), true), None);
        let side =
            user("from a subagent", ts).replace(r#""isSidechain":false"#, r#""isSidechain":true"#);
        assert_eq!(extract_line(side.as_bytes(), false), None);
        assert_eq!(
            extract_line(side.as_bytes(), true).unwrap().text,
            "from a subagent"
        );
        // Long text is cut at TEXT_MAX_CHARS characters.
        let long = "\u{e9}".repeat(TEXT_MAX_CHARS + 50);
        let r = extract_line(user(&long, ts).as_bytes(), false).unwrap();
        assert_eq!(r.text.chars().count(), TEXT_MAX_CHARS);
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        projects: PathBuf,
        index: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        let index = tmp.path().join("data").join("search");
        fs::create_dir_all(&projects).unwrap();
        Fixture {
            projects,
            index,
            _tmp: tmp,
        }
    }

    fn write(path: &Path, lines: &[String]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, lines.join("\n") + "\n").unwrap();
    }

    fn set_mtime(path: &Path, secs: u64) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    fn run(f: &Fixture) -> IndexStatus {
        refresh(&f.projects, &f.index, &|enc| Some(format!("/decoded{enc}"))).unwrap()
    }

    fn records(f: &Fixture, id: &str) -> String {
        fs::read_to_string(records_path(&f.index, id)).unwrap_or_default()
    }

    #[test]
    fn incremental_refresh() {
        let f = fixture();
        let a = f.projects.join("-p").join(format!("{A}.jsonl"));
        let b = f.projects.join("-q").join(format!("{B}.jsonl"));
        let sub = f
            .projects
            .join("-p")
            .join(A)
            .join("subagents")
            .join("agent-1.jsonl");
        // A subagent dir whose main transcript does not exist is ignored.
        let orphan = f
            .projects
            .join("-p")
            .join(C)
            .join("subagents")
            .join("agent-2.jsonl");
        write(
            &a,
            &[
                user("alpha one", "2026-10-01T00:00:00Z"),
                assistant_text("alpha reply", "2026-10-01T00:00:01Z"),
            ],
        );
        write(&b, &[user("bravo", "2026-10-02T00:00:00Z")]);
        let side = user("subagent brief", "2026-10-01T00:00:00.500Z")
            .replace("\"isSidechain\":false", "\"isSidechain\":true");
        write(&sub, &[side]);
        write(&orphan, &[user("orphan", "2026-10-01T00:00:00Z")]);
        fs::write(f.projects.join("-p").join("notes.jsonl"), "{}").unwrap();
        for p in [&a, &b, &sub] {
            set_mtime(p, 1000);
        }

        let s = run(&f);
        assert_eq!((s.files, s.indexed, s.skipped, s.sessions), (3, 3, 0, 2));
        assert!(s.bytes > 0);
        let ra = records(&f, A);
        assert_eq!(
            ra,
            format!(
                "{}\tu\talpha one\n{}\tu\tsubagent brief\n{}\ta\talpha reply\n",
                parse_iso_ms("2026-10-01T00:00:00Z").unwrap(),
                parse_iso_ms("2026-10-01T00:00:00.500Z").unwrap(),
                parse_iso_ms("2026-10-01T00:00:01Z").unwrap()
            )
        );
        let idx = load_index(&f.index);
        assert_eq!(idx.files.len(), 3);
        let ea = &idx.files[a.to_string_lossy().as_ref()];
        assert_eq!(ea.session_id, A);
        assert_eq!(ea.project.as_deref(), Some("/decoded-p"));
        assert_eq!(idx.files[sub.to_string_lossy().as_ref()].session_id, A);
        assert!(!records_path(&f.index, C).exists());

        // Unchanged: nothing re-extracted, record files untouched.
        let before = fs::metadata(records_path(&f.index, B))
            .unwrap()
            .modified()
            .unwrap();
        let s = run(&f);
        assert_eq!((s.indexed, s.skipped), (0, 3));
        assert_eq!(
            fs::metadata(records_path(&f.index, B))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );

        // Grown file: its session is re-extracted (with its subagent file).
        write(
            &b,
            &[
                user("bravo", "2026-10-02T00:00:00Z"),
                user("bravo again", "2026-10-03T00:00:00Z"),
            ],
        );
        let s = run(&f);
        assert_eq!((s.indexed, s.skipped), (1, 2));
        assert!(records(&f, B).contains("bravo again"));
        fs::write(
            &sub,
            format!(
                "{}\n",
                user("changed brief", "2026-10-01T00:00:00Z")
                    .replace("\"isSidechain\":false", "\"isSidechain\":true")
            ),
        )
        .unwrap();
        let s = run(&f);
        assert_eq!((s.indexed, s.skipped), (2, 1));
        assert!(records(&f, A).contains("changed brief"));

        // Deleted: its entry and records go.
        fs::remove_file(&b).unwrap();
        let s = run(&f);
        assert_eq!((s.files, s.sessions), (2, 1));
        assert!(!records_path(&f.index, B).exists());
        assert!(
            !load_index(&f.index)
                .files
                .contains_key(b.to_string_lossy().as_ref())
        );

        // A broken or old index.json is rebuilt from scratch.
        fs::write(index_json(&f.index), "{\"version\":0,\"files\":{}}").unwrap();
        assert_eq!(run(&f).indexed, 2);
    }

    #[test]
    fn terms_and_quotes() {
        assert_eq!(
            parse_terms("  Hidden   WORKSPACE "),
            vec!["hidden", "workspace"]
        );
        assert_eq!(
            parse_terms(r#"say "Hidden   Workspace" now"#),
            vec!["hidden workspace", "now", "say"]
        );
        assert_eq!(parse_terms(r#""unclosed phrase"#), vec!["unclosed phrase"]);
        assert!(parse_terms(r#"  "" "#).is_empty());
    }

    #[test]
    fn snippet_marks_matches() {
        let t = vec!["fox".to_owned()];
        assert_eq!(
            snippet("The quick Fox jumps", &t),
            "The quick \u{1}Fox\u{2} jumps"
        );
        // A window of SNIPPET_CHARS centred on the first match.
        let text = format!("{}needle{}", "a".repeat(500), "b".repeat(500));
        let s = snippet(&text, &["needle".to_owned()]);
        assert_eq!(
            s.chars()
                .filter(|c| *c != MARK_START && *c != MARK_END)
                .count(),
            SNIPPET_CHARS
        );
        assert!(s.contains("\u{1}needle\u{2}"));
        let before = s.split('\u{1}').next().unwrap().len();
        assert_eq!(before, (SNIPPET_CHARS - 6) / 2);
        // Several terms and a phrase; non-ASCII case folding keeps char positions.
        let s = snippet(
            "\u{c9}t\u{c9} hidden Workspace, then hidden",
            &["hidden workspace".to_owned(), "\u{e9}t\u{e9}".to_owned()],
        );
        assert_eq!(
            s,
            "\u{1}\u{c9}t\u{c9}\u{2} \u{1}hidden Workspace\u{2}, then hidden"
        );
        // No match (cannot happen for a hit) yields the start of the text.
        assert_eq!(snippet("abc", &["zzz".to_owned()]), "abc");
    }

    #[test]
    fn query_and_or_quotes_ordering() {
        let f = fixture();
        let a = f.projects.join("-p").join(format!("{A}.jsonl"));
        let b = f.projects.join("-p").join(format!("{B}.jsonl"));
        let c = f.projects.join("-q").join(format!("{C}.jsonl"));
        write(
            &a,
            &[
                user("the hidden workspace idea", "2026-10-01T00:00:00Z"),
                assistant_text("workspace is hidden here", "2026-10-05T00:00:00Z"),
            ],
        );
        write(
            &b,
            &[user("Hidden Workspace again", "2026-10-03T00:00:00Z")],
        );
        write(&c, &[user("nothing relevant", "2026-10-09T00:00:00Z")]);
        run(&f);
        let mut meta = HashMap::new();
        meta.insert(
            A.to_owned(),
            SessionMeta {
                title: "Session A".into(),
                project: Some("/real/p".into()),
                transcript_path: Some(a.to_string_lossy().into_owned()),
            },
        );

        // AND of words: both sessions, latest hit first, one hit per session.
        let hits = search(&f.index, "workspace HIDDEN", 50, &meta);
        assert_eq!(
            hits.iter()
                .map(|h| h.session_id.as_str())
                .collect::<Vec<_>>(),
            vec![A, B]
        );
        assert_eq!(hits[0].hits, 2);
        assert_eq!(hits[0].role, "assistant");
        assert_eq!(hits[0].ts, parse_iso_ms("2026-10-05T00:00:00Z").unwrap());
        assert_eq!(hits[0].title, "Session A");
        assert_eq!(hits[0].project.as_deref(), Some("/real/p"));
        assert!(hits[0].snippet.contains("\u{1}workspace\u{2}"));
        // Unknown to sessions_list: index project and main transcript.
        assert_eq!(hits[1].title, NO_PROMPT_TITLE);
        assert_eq!(hits[1].project.as_deref(), Some("/decoded-p"));
        assert_eq!(hits[1].transcript_path, b.to_string_lossy());

        // Quoted: the phrase literally, case-insensitive.
        let hits = search(&f.index, "\"hidden workspace\"", 50, &meta);
        assert_eq!(
            hits.iter()
                .map(|h| h.session_id.as_str())
                .collect::<Vec<_>>(),
            vec![B, A]
        );
        assert_eq!(hits[1].hits, 1);
        assert_eq!(hits[1].role, "user");

        assert_eq!(search(&f.index, "workspace", 1, &meta).len(), 1);
        assert!(search(&f.index, "workspace missingterm", 50, &meta).is_empty());
        assert!(search(&f.index, "   ", 50, &meta).is_empty());

        let json = serde_json::to_value(&search(&f.index, "relevant", 5, &meta)[0]).unwrap();
        for key in [
            "sessionId",
            "project",
            "title",
            "ts",
            "role",
            "snippet",
            "hits",
            "transcriptPath",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }
}
