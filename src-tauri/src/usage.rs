//! Usage (CONTRACT.md "Usage"): tokens per local day, project and model from
//! the transcripts. Tokens only, no prices.
//!
//! - `<appData>/usage/index.json`: the shared transcript manifest
//!   (`transcripts.rs`), so a refresh only reads sessions whose transcripts
//!   are new, changed or gone.
//! - `<appData>/usage/<sessionId>.json`: `{ project, days: { <Ymd>: { <model>:
//!   UsageBucket } } }`, the session's turns (main and subagent transcripts)
//!   aggregated per local day and model.
//!
//! A turn is one `message.id` of a `type: "assistant"` line that carries
//! `message.usage`; streamed copies of the same id overwrite each other, so
//! the last line wins. Lines of other types are dropped from the raw prefix
//! when it starts with `type`, otherwise by a field visitor that stops at the
//! first sign the line is not an assistant turn.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Serialize};

use crate::board::{MAX_ACTIVITY_DAYS, format_date, local_day_of_ms, parse_date};
use crate::files::{app_data_dir, blocking, claude_dir};
use crate::memory::decode_project_path;
use crate::sessions;
use crate::transcripts::{
    Found, IndexKind, IndexStatus, for_each_line, par_map, parse_iso_ms, refresh_index,
    session_files,
};

const INDEX_VERSION: u32 = 1;
/// Model of a turn whose line names none.
pub const UNKNOWN_MODEL: &str = "unknown";
/// Claude Code's placeholder messages (errors, interrupts): no API call, all zeros.
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// One refresh at a time; a second caller waits and then finds little to do.
static REFRESH: Mutex<()> = Mutex::new(());
static USAGE_INDEX: IndexKind = IndexKind {
    version: INDEX_VERSION,
    ext: "json",
    name: "usage",
    lock: &REFRESH,
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageBucket {
    pub turns: u64,
    pub input: u64,
    pub cache_create: u64,
    pub cache_read: u64,
    pub output: u64,
}

impl UsageBucket {
    fn add(&mut self, o: &UsageBucket) {
        self.turns += o.turns;
        self.input += o.input;
        self.cache_create += o.cache_create;
        self.cache_read += o.cache_read;
        self.output += o.output;
    }
}

/// `<sessionId>.json`.
#[derive(Serialize, Deserialize, Debug, Default, PartialEq)]
pub struct SessionUsage {
    pub project: Option<String>,
    /// Local date -> model -> tokens.
    pub days: BTreeMap<String, BTreeMap<String, UsageBucket>>,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct UsageDay {
    pub date: String,
    pub total: UsageBucket,
    /// Project path, "" when unknown.
    pub projects: BTreeMap<String, UsageBucket>,
    pub models: BTreeMap<String, UsageBucket>,
}

/// One assistant line's turn.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub id: Option<String>,
    pub model: Option<String>,
    pub ts: Option<i64>,
    /// `turns` is 1.
    pub usage: UsageBucket,
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
    Timestamp,
    Message,
    #[serde(other)]
    Other,
}

#[derive(Deserialize, Default)]
struct RawUsage {
    input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

/// `message` of an assistant line; `content` and the rest are skipped.
#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    model: Option<String>,
    usage: Option<RawUsage>,
}

/// Visits one transcript line's top-level object, failing with `SKIP` as soon
/// as the line is known not to be an assistant turn with usage.
struct LineSeed;

impl<'de> DeserializeSeed<'de> for LineSeed {
    type Value = Turn;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Turn, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for LineSeed {
    type Value = Turn;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a transcript line")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Turn, A::Error> {
        let skip = || de::Error::custom(SKIP);
        let mut assistant = false;
        let mut ts: Option<i64> = None;
        let mut message: Option<Message> = None;
        while let Some(key) = map.next_key::<Field>()? {
            match key {
                Field::Type => {
                    let t = map.next_value::<Option<Cow<str>>>()?;
                    if t.as_deref() != Some("assistant") {
                        return Err(skip());
                    }
                    assistant = true;
                }
                Field::Timestamp => {
                    let s = map.next_value::<Option<Cow<str>>>()?;
                    ts = s.as_deref().and_then(parse_iso_ms);
                }
                Field::Message => {
                    let m = map.next_value::<Option<Message>>()?;
                    match m {
                        Some(m) if m.usage.is_some() => message = Some(m),
                        _ => return Err(skip()),
                    }
                }
                Field::Other => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        let Some(m) = message.filter(|_| assistant) else {
            return Err(skip());
        };
        let u = m.usage.unwrap_or_default();
        Ok(Turn {
            id: m.id.filter(|s| !s.is_empty()),
            model: m.model.filter(|s| !s.is_empty()),
            ts,
            usage: UsageBucket {
                turns: 1,
                input: u.input_tokens.unwrap_or(0),
                cache_create: u.cache_creation_input_tokens.unwrap_or(0),
                cache_read: u.cache_read_input_tokens.unwrap_or(0),
                output: u.output_tokens.unwrap_or(0),
            },
        })
    }
}

/// The turn a transcript line carries, if any.
pub fn extract_line(line: &[u8]) -> Option<Turn> {
    const TYPE_PREFIX: &[u8] = br#"{"type":""#;
    if let Some(rest) = line.strip_prefix(TYPE_PREFIX)
        && !rest.starts_with(br#"assistant""#)
    {
        return None;
    }
    if !line.starts_with(b"{") {
        return None;
    }
    let mut de = serde_json::Deserializer::from_slice(line);
    LineSeed.deserialize(&mut de).ok()
}

/// A session's turns from its transcripts, one per `message.id` (the last
/// line of an id wins), aggregated per local day (`to_day` maps epoch ms to a
/// day number) and model. A turn without a timestamp takes the previous
/// line's; one before any timestamp is dropped.
pub fn session_days(
    paths: &[&Path],
    to_day: &dyn Fn(i64) -> i64,
) -> BTreeMap<String, BTreeMap<String, UsageBucket>> {
    let mut by_id: HashMap<String, Turn> = HashMap::new();
    let mut anonymous: Vec<Turn> = Vec::new();
    for path in paths {
        let mut last_ts: Option<i64> = None;
        for_each_line(path, |line| {
            let Some(mut t) = extract_line(line) else {
                return;
            };
            if t.ts.is_none() {
                t.ts = last_ts;
            }
            last_ts = t.ts;
            match t.id.clone() {
                Some(id) => {
                    by_id.insert(id, t);
                }
                None => anonymous.push(t),
            }
        });
    }
    let mut days: BTreeMap<i64, BTreeMap<String, UsageBucket>> = BTreeMap::new();
    for t in by_id.into_values().chain(anonymous) {
        let Some(ts) = t.ts else {
            continue;
        };
        let model = t.model.as_deref().unwrap_or(UNKNOWN_MODEL);
        if model == SYNTHETIC_MODEL {
            continue;
        }
        days.entry(to_day(ts))
            .or_default()
            .entry(model.to_owned())
            .or_default()
            .add(&t.usage);
    }
    days.into_iter().map(|(d, m)| (format_date(d), m)).collect()
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/// Bring the usage index in `index_dir` up to date with the transcripts under
/// `projects`. `project_of` gives a session's project (as `sessions_list`
/// resolves it); a session it does not know takes its decoded project dir.
pub fn refresh(
    projects: &Path,
    index_dir: &Path,
    decode: &(dyn Fn(&str) -> Option<String> + Sync),
    project_of: &(dyn Fn(&str) -> Option<String> + Sync),
    to_day: &(dyn Fn(i64) -> i64 + Sync),
) -> Result<IndexStatus, String> {
    refresh_index(
        &USAGE_INDEX,
        projects,
        index_dir,
        decode,
        &|id, files: &[&Found]| {
            let paths: Vec<&Path> = files.iter().map(|f| f.path.as_path()).collect();
            let days = session_days(&paths, to_day);
            if days.is_empty() {
                return Ok(None);
            }
            let project = project_of(id).or_else(|| files.first().and_then(|f| decode(&f.encoded)));
            let json =
                serde_json::to_vec(&SessionUsage { project, days }).map_err(|e| e.to_string())?;
            Ok(Some(json))
        },
    )
}

/// Every day from `from` to `to` (inclusive, `YYYY-MM-DD`) with at least one
/// turn in the index in `index_dir`, ascending.
pub fn days_between(index_dir: &Path, from: &str, to: &str) -> Result<Vec<UsageDay>, String> {
    let f = parse_date(from).ok_or_else(|| format!("not a YYYY-MM-DD date: {from}"))?;
    let t = parse_date(to).ok_or_else(|| format!("not a YYYY-MM-DD date: {to}"))?;
    if t < f {
        return Err("the range ends before it starts".into());
    }
    if t - f >= MAX_ACTIVITY_DAYS {
        return Err(format!("at most {MAX_ACTIVITY_DAYS} days at a time"));
    }
    let (from, to) = (format_date(f), format_date(t));
    let files: Vec<(String, PathBuf)> = session_files(&USAGE_INDEX, index_dir);
    let sessions = par_map(&files, |(_, path)| {
        fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<SessionUsage>(&b).ok())
    });
    let mut out: BTreeMap<String, UsageDay> = BTreeMap::new();
    for s in sessions.into_iter().flatten() {
        let project = s.project.unwrap_or_default();
        for (date, models) in s.days.range(from.clone()..=to.clone()) {
            let day = out.entry(date.clone()).or_insert_with(|| UsageDay {
                date: date.clone(),
                ..UsageDay::default()
            });
            for (model, b) in models {
                if b.turns == 0 {
                    continue;
                }
                day.total.add(b);
                day.projects.entry(project.clone()).or_default().add(b);
                day.models.entry(model.clone()).or_default().add(b);
            }
        }
    }
    Ok(out.into_values().filter(|d| d.total.turns > 0).collect())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn index_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("usage"))
}

fn decode(enc: &str) -> Option<String> {
    decode_project_path(enc).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn usage_refresh() -> Result<IndexStatus, String> {
    blocking(|| {
        let projects: HashMap<String, Option<String>> = sessions::list_all()?
            .into_iter()
            .map(|s| (s.id, s.project))
            .collect();
        refresh(
            &claude_dir()?.join("projects"),
            &index_dir()?,
            &decode,
            &|id| projects.get(id).cloned().flatten(),
            &local_day_of_ms,
        )
    })
    .await
}

#[tauri::command]
pub async fn usage_days(from: String, to: String) -> Result<Vec<UsageDay>, String> {
    blocking(move || days_between(&index_dir()?, &from, &to)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    const A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const B: &str = "bbbbbbbb-0000-4000-8000-000000000002";

    /// An assistant line as Claude Code writes it (`type` after `message`).
    fn turn(id: &str, model: Option<&str>, ts: &str, usage: &str) -> String {
        let model = model.map_or(String::new(), |m| format!(r#""model":"{m}","#));
        format!(
            r#"{{"parentUuid":"p","isSidechain":false,"message":{{{model}"id":"{id}","type":"message","role":"assistant","content":[{{"type":"thinking","thinking":"","signature":"s"}},{{"type":"text","text":"hi"}}],"usage":{{{usage}}}}},"type":"assistant","uuid":"u","timestamp":"{ts}"}}"#
        )
    }

    fn full(i: u64, cc: u64, cr: u64, o: u64) -> String {
        format!(
            r#""input_tokens":{i},"cache_creation_input_tokens":{cc},"cache_read_input_tokens":{cr},"output_tokens":{o},"output_tokens_details":{{"thinking_tokens":3}},"service_tier":null"#
        )
    }

    fn user(ts: &str) -> String {
        format!(
            r#"{{"parentUuid":null,"isSidechain":false,"type":"user","message":{{"role":"user","content":"hello","usage":{{"input_tokens":99}}}},"timestamp":"{ts}"}}"#
        )
    }

    fn bucket(
        turns: u64,
        input: u64,
        cache_create: u64,
        cache_read: u64,
        output: u64,
    ) -> UsageBucket {
        UsageBucket {
            turns,
            input,
            cache_create,
            cache_read,
            output,
        }
    }

    /// A fixed UTC+02:00 zone, so tests do not depend on the machine's.
    fn plus_two(ms: i64) -> i64 {
        (ms + 2 * 3_600_000).div_euclid(86_400_000)
    }

    fn write(path: &Path, lines: &[String]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, lines.join("\n") + "\n").unwrap();
    }

    #[test]
    fn extraction_of_each_line_kind() {
        let ts = "2026-11-03T23:35:15.782Z";
        let t = extract_line(
            turn(
                "msg_1",
                Some("claude-fable-5-1"),
                ts,
                &full(2, 66, 351_216, 1219),
            )
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            t,
            Turn {
                id: Some("msg_1".into()),
                model: Some("claude-fable-5-1".into()),
                ts: parse_iso_ms(ts),
                usage: bucket(1, 2, 66, 351_216, 1219),
            }
        );
        // Missing fields count 0, a missing model stays None.
        let t = extract_line(turn("msg_2", None, ts, r#""output_tokens":5"#).as_bytes()).unwrap();
        assert_eq!((t.model, t.usage), (None, bucket(1, 0, 0, 0, 5)));
        // `type` first works too.
        let typed_first = format!(
            r#"{{"type":"assistant","message":{{"id":"m","model":"x","usage":{{"input_tokens":1}}}},"timestamp":"{ts}"}}"#
        );
        assert_eq!(extract_line(typed_first.as_bytes()).unwrap().usage.input, 1);
        // Not turns: other types (by prefix and by visitor), no usage, junk.
        for line in [
            user(ts),
            r#"{"type":"attachment","message":{"usage":{"input_tokens":1}}}"#.to_owned(),
            r#"{"parentUuid":"x","message":{"id":"m","usage":{"input_tokens":1}},"type":"system"}"#.to_owned(),
            r#"{"parentUuid":"x","message":{"id":"m","model":"x","content":[]},"type":"assistant"}"#.to_owned(),
            r#"{"parentUuid":"x","message":{"id":"m","usage":{"input_tokens":1}}}"#.to_owned(),
            "not json".to_owned(),
            String::new(),
        ] {
            assert_eq!(extract_line(line.as_bytes()), None, "{line}");
        }
    }

    #[test]
    fn streamed_ids_dedupe_and_models() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main.jsonl");
        let sub = tmp.path().join("agent-1.jsonl");
        let m = Some("claude-fable-5-1");
        write(
            &main,
            &[
                user("2026-11-03T10:00:00Z"),
                // Three streamed lines of one message: the last one counts.
                turn("msg_1", m, "2026-11-03T10:00:01Z", &full(2, 10, 100, 1)),
                turn("msg_1", m, "2026-11-03T10:00:02Z", &full(2, 10, 100, 7)),
                turn("msg_1", m, "2026-11-03T10:00:03Z", &full(2, 10, 100, 40)),
                turn("msg_2", None, "2026-11-03T10:01:00Z", &full(1, 0, 50, 2)),
                turn(
                    "msg_3",
                    Some("<synthetic>"),
                    "2026-11-03T10:02:00Z",
                    &full(0, 0, 0, 0),
                ),
            ],
        );
        write(
            &sub,
            &[turn(
                "msg_9",
                Some("claude-sonnet-5-5"),
                "2026-11-03T10:03:00Z",
                &full(3, 4, 5, 6),
            )],
        );
        let days = session_days(&[main.as_path(), sub.as_path()], &plus_two);
        let day = &days["2026-11-03"];
        assert_eq!(days.len(), 1);
        assert_eq!(day["claude-fable-5-1"], bucket(1, 2, 10, 100, 40));
        assert_eq!(day[UNKNOWN_MODEL], bucket(1, 1, 0, 50, 2));
        assert_eq!(day["claude-sonnet-5-5"], bucket(1, 3, 4, 5, 6));
        assert!(!day.contains_key("<synthetic>"));
    }

    #[test]
    fn days_split_at_local_midnight() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.jsonl");
        let m = Some("m");
        // 21:59Z is 23:59 at +02:00, 22:01Z is 00:01 the next day.
        let no_ts = turn("msg_c", m, "", &full(1, 0, 0, 0)).replace(r#","timestamp":"""#, "");
        write(
            &p,
            &[
                turn("msg_a", m, "2026-11-03T21:59:00Z", &full(1, 0, 0, 0)),
                turn("msg_b", m, "2026-11-03T22:01:00Z", &full(10, 0, 0, 0)),
                // No timestamp: takes the previous line's day.
                no_ts,
            ],
        );
        let days = session_days(&[p.as_path()], &plus_two);
        assert_eq!(
            days.keys().collect::<Vec<_>>(),
            vec!["2026-11-03", "2026-11-04"]
        );
        assert_eq!(days["2026-11-03"]["m"], bucket(1, 1, 0, 0, 0));
        assert_eq!(days["2026-11-04"]["m"], bucket(2, 11, 0, 0, 0));
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        projects: PathBuf,
        index: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        let index = tmp.path().join("data").join("usage");
        fs::create_dir_all(&projects).unwrap();
        Fixture {
            projects,
            index,
            _tmp: tmp,
        }
    }

    fn run(f: &Fixture) -> IndexStatus {
        refresh(
            &f.projects,
            &f.index,
            &|enc| Some(format!("/decoded{enc}")),
            &|id| (id == A).then(|| "/work/alpha".to_owned()),
            &plus_two,
        )
        .unwrap()
    }

    fn set_mtime(path: &Path, secs: u64) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    #[test]
    fn aggregation_per_project_and_model() {
        let f = fixture();
        let a = f.projects.join("-p").join(format!("{A}.jsonl"));
        let sub = f
            .projects
            .join("-p")
            .join(A)
            .join("subagents")
            .join("agent-1.jsonl");
        let b = f.projects.join("-q").join(format!("{B}.jsonl"));
        write(
            &a,
            &[
                turn(
                    "a1",
                    Some("fable"),
                    "2026-11-01T10:00:00Z",
                    &full(1, 2, 3, 4),
                ),
                turn(
                    "a2",
                    Some("fable"),
                    "2026-11-03T10:00:00Z",
                    &full(1, 1, 1, 1),
                ),
            ],
        );
        write(
            &sub,
            &[turn(
                "s1",
                Some("sonnet"),
                "2026-11-03T11:00:00Z",
                &full(5, 5, 5, 5),
            )],
        );
        write(
            &b,
            &[turn(
                "b1",
                Some("fable"),
                "2026-11-03T12:00:00Z",
                &full(10, 0, 100, 3),
            )],
        );
        let s = run(&f);
        assert_eq!((s.files, s.indexed, s.skipped, s.sessions), (3, 3, 0, 2));
        assert!(s.bytes > 0);

        // The session file: project from sessions_list, else the decoded dir.
        let sa: SessionUsage =
            serde_json::from_slice(&fs::read(f.index.join(format!("{A}.json"))).unwrap()).unwrap();
        assert_eq!(sa.project.as_deref(), Some("/work/alpha"));
        assert_eq!(sa.days["2026-11-03"]["sonnet"], bucket(1, 5, 5, 5, 5));
        let sb: SessionUsage =
            serde_json::from_slice(&fs::read(f.index.join(format!("{B}.json"))).unwrap()).unwrap();
        assert_eq!(sb.project.as_deref(), Some("/decoded-q"));

        let days = days_between(&f.index, "2026-11-01", "2026-11-07").unwrap();
        assert_eq!(
            days.iter().map(|d| d.date.as_str()).collect::<Vec<_>>(),
            vec!["2026-11-01", "2026-11-03"]
        );
        let d = &days[1];
        assert_eq!(d.total, bucket(3, 16, 6, 106, 9));
        assert_eq!(d.projects["/work/alpha"], bucket(2, 6, 6, 6, 6));
        assert_eq!(d.projects["/decoded-q"], bucket(1, 10, 0, 100, 3));
        assert_eq!(d.models["fable"], bucket(2, 11, 1, 101, 4));
        assert_eq!(d.models["sonnet"], bucket(1, 5, 5, 5, 5));
        // The range is inclusive and only days with turns come back.
        assert_eq!(
            days_between(&f.index, "2026-11-02", "2026-11-02").unwrap(),
            vec![]
        );
        assert_eq!(
            days_between(&f.index, "2026-11-03", "2026-11-03")
                .unwrap()
                .len(),
            1
        );
        assert!(days_between(&f.index, "2026-11-03", "2026-11-01").is_err());
        assert!(days_between(&f.index, "2026-11-3", "2026-11-04").is_err());
        assert!(days_between(&f.index, "2025-01-01", "2026-11-04").is_err());

        let json = serde_json::to_value(d).unwrap();
        for key in ["date", "total", "projects", "models"] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        for key in ["turns", "input", "cacheCreate", "cacheRead", "output"] {
            assert!(json["total"].get(key).is_some(), "missing {key}");
        }
        // No index yet: nothing, not an error.
        assert_eq!(
            days_between(&f.index.join("none"), "2026-11-01", "2026-11-07").unwrap(),
            vec![]
        );
    }

    #[test]
    fn manifest_skips_unchanged_files() {
        let f = fixture();
        let a = f.projects.join("-p").join(format!("{A}.jsonl"));
        let b = f.projects.join("-q").join(format!("{B}.jsonl"));
        write(
            &a,
            &[turn(
                "a1",
                Some("m"),
                "2026-11-03T10:00:00Z",
                &full(1, 0, 0, 0),
            )],
        );
        write(
            &b,
            &[turn(
                "b1",
                Some("m"),
                "2026-11-03T10:00:00Z",
                &full(2, 0, 0, 0),
            )],
        );
        for p in [&a, &b] {
            set_mtime(p, 1000);
        }
        assert_eq!(run(&f).indexed, 2);
        let file_b = f.index.join(format!("{B}.json"));
        let before = fs::metadata(&file_b).unwrap().modified().unwrap();

        // Unchanged: nothing read, the session file untouched.
        let s = run(&f);
        assert_eq!((s.indexed, s.skipped), (0, 2));
        assert_eq!(fs::metadata(&file_b).unwrap().modified().unwrap(), before);

        // A grown transcript is read again; the other is not.
        write(
            &a,
            &[
                turn("a1", Some("m"), "2026-11-03T10:00:00Z", &full(1, 0, 0, 0)),
                turn("a2", Some("m"), "2026-11-03T11:00:00Z", &full(1, 0, 0, 0)),
            ],
        );
        let s = run(&f);
        assert_eq!((s.indexed, s.skipped), (1, 1));
        let day = &days_between(&f.index, "2026-11-03", "2026-11-03").unwrap()[0];
        assert_eq!(day.total.turns, 3);

        // A deleted transcript drops its session file; index.json stays.
        fs::remove_file(&b).unwrap();
        let s = run(&f);
        assert_eq!((s.files, s.sessions), (1, 1));
        assert!(!file_b.exists());
        assert!(f.index.join("index.json").exists());
    }
}
