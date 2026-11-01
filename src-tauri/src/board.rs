//! Board and Calendar (CONTRACT.md "Board and Calendar").
//!
//! The source of truth is the GitHub Project "I4C" (user I4cTime, number 3).
//! Tsukue keeps only a cache of it in `<appData>/board.json`, and owns the
//! calendar layer: `<appData>/schedule.json` (weekly rhythm + per-day
//! overrides) and the generated `SCHEDULE.md` in the first workspace root.
//!
//! All GitHub traffic goes through the `gh` CLI, through a runner function the
//! tests replace (no test talks to GitHub). Every real `gh` child is spawned
//! with `GITHUB_TOKEN` removed from its environment: the token a Claude
//! session exports is read-only and would make writes fail; the keyring login
//! carries the `project` scope. Commands are async and run gh on a blocking
//! worker, so the GTK main thread never waits for the network.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::files::{app_data_dir, atomic_write, blocking, claude_dir, home_dir};
use crate::sessions::history_lines;
use crate::workspace;

pub const OWNER: &str = "I4cTime";
pub const PROJECT_NUMBER: &str = "3";
pub const PROJECT_ID: &str = "PVT_kwHOAW7RTs4BfzfL";
pub const HUB_REPO: &str = "I4cTime/focus";
pub const BOARD_URL: &str = "https://github.com/users/I4cTime/projects/3";

/// `board_fetch` without `force` returns a cached snapshot younger than this.
const FRESH_SECS: i64 = 60;
/// A gh call that takes longer than this is killed.
const GH_TIMEOUT: Duration = Duration::from_secs(60);
/// Pagination stops after this many pages of 100 items.
const MAX_PAGES: usize = 50;
/// `activity_days` refuses longer ranges.
const MAX_ACTIVITY_DAYS: i64 = 400;

pub const SCHEDULE_PARAGRAPH: &str = "Schedule: @SCHEDULE.md";

// ---------------------------------------------------------------------------
// Dates (days since 1970-01-01; no chrono)
// ---------------------------------------------------------------------------

const WEEKDAYS: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DD` -> days, None when malformed or not a real date.
pub fn parse_date(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let t = &s[r];
        t.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| t.parse().ok())?
    };
    let (y, m, d) = (num(0..4)?, num(5..7)? as u32, num(8..10)? as u32);
    if !(1..=12).contains(&m) || d == 0 {
        return None;
    }
    let days = days_from_civil(y, m, d);
    (civil_from_days(days) == (y, m, d)).then_some(days)
}

pub fn format_date(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 0 = Monday .. 6 = Sunday.
pub fn weekday(days: i64) -> usize {
    (days + 3).rem_euclid(7) as usize
}

/// "2026-11-01 Sunday".
fn date_label(days: i64) -> String {
    format!("{} {}", format_date(days), WEEKDAYS[weekday(days)])
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// `YYYY-MM-DDTHH:MM:SSZ` for epoch seconds.
pub fn iso_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        format_date(days),
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Epoch seconds of an ISO UTC stamp (`YYYY-MM-DDTHH:MM:SS...`, offset ignored).
pub fn parse_iso_utc(s: &str) -> Option<i64> {
    let days = parse_date(s.get(0..10)?)?;
    if s.as_bytes().get(10) != Some(&b'T') {
        return None;
    }
    let part = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    Some(days * 86_400 + part(11..13)? * 3600 + part(14..16)? * 60 + part(17..19)?)
}

/// The local calendar day of an epoch-milliseconds instant.
pub fn local_day_of_ms(ms: i64) -> i64 {
    let secs = ms.div_euclid(1000);
    #[cfg(unix)]
    {
        let t = secs as libc::time_t;
        // SAFETY: localtime_r only writes into the tm we own.
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        let ok = unsafe { !libc::localtime_r(&t, &mut tm).is_null() };
        if ok {
            return days_from_civil(
                tm.tm_year as i64 + 1900,
                (tm.tm_mon + 1) as u32,
                tm.tm_mday as u32,
            );
        }
    }
    secs.div_euclid(86_400)
}

pub fn local_today() -> i64 {
    local_day_of_ms(now_secs() * 1000)
}

// ---------------------------------------------------------------------------
// gh runner
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct GhOut {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `gh <args>` with optional stdin. Production: [`real_gh`]; tests pass
/// their own function.
pub type Runner<'a> = dyn Fn(&[&str], Option<&str>) -> io::Result<GhOut> + Sync + 'a;

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// `gh` on PATH, else the usual install spots (the desktop session's PATH may
/// lack mise and ~/.local/bin), else plain "gh" (spawn then reports NotFound).
fn gh_program() -> PathBuf {
    static GH: LazyLock<PathBuf> = LazyLock::new(|| {
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                let c = dir.join("gh");
                if is_executable(&c) {
                    return c;
                }
            }
        }
        if let Ok(home) = home_dir() {
            for rel in [".local/bin/gh", ".local/share/mise/shims/gh"] {
                let c = home.join(rel);
                if is_executable(&c) {
                    return c;
                }
            }
        }
        for c in ["/usr/local/bin/gh", "/usr/bin/gh"] {
            if is_executable(Path::new(c)) {
                return PathBuf::from(c);
            }
        }
        PathBuf::from("gh")
    });
    GH.clone()
}

/// The `gh` command line with GITHUB_TOKEN removed and prompts disabled.
pub fn gh_command(program: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(program);
    c.args(args)
        .env_remove("GITHUB_TOKEN")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}

/// Spawn gh (GITHUB_TOKEN removed), feed stdin, wait up to GH_TIMEOUT.
pub fn real_gh(args: &[&str], stdin: Option<&str>) -> io::Result<GhOut> {
    let mut cmd = gh_command(&gh_program(), args);
    if stdin.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn()?;
    let feeder = stdin.and_then(|input| {
        let mut pipe = child.stdin.take()?;
        let input = input.to_owned();
        Some(std::thread::spawn(move || {
            let _ = pipe.write_all(input.as_bytes());
        }))
    });
    let mut out = child.stdout.take().expect("stdout is piped");
    let mut err = child.stderr.take().expect("stderr is piped");
    let read_out = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = out.read_to_end(&mut v);
        v
    });
    let read_err = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = err.read_to_end(&mut v);
        v
    });
    let deadline = Instant::now() + GH_TIMEOUT;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("gh did not answer within {} s", GH_TIMEOUT.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    if let Some(f) = feeder {
        let _ = f.join();
    }
    let stdout = String::from_utf8_lossy(&read_out.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&read_err.join().unwrap_or_default()).into_owned();
    Ok(GhOut {
        ok: status.success(),
        stdout,
        stderr,
    })
}

fn spawn_error(e: io::Error) -> String {
    if e.kind() == io::ErrorKind::NotFound {
        "gh is not installed (or not on PATH)".into()
    } else {
        format!("could not run gh: {e}")
    }
}

fn failure_text(out: &GhOut) -> String {
    let t = out.stderr.trim();
    let t = if t.is_empty() { out.stdout.trim() } else { t };
    let t = t.strip_prefix("gh: ").unwrap_or(t);
    if t.is_empty() {
        "gh exited with an error".into()
    } else {
        t.lines().take(6).collect::<Vec<_>>().join(" ")
    }
}

/// Run gh; stdout on success, the error text otherwise.
fn gh(run: &Runner<'_>, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let out = run(args, stdin).map_err(spawn_error)?;
    if out.ok {
        Ok(out.stdout)
    } else {
        Err(failure_text(&out))
    }
}

/// `gh api graphql` with a JSON body on stdin. Returns `data` (when present,
/// even next to errors) and the error messages.
fn graphql(
    run: &Runner<'_>,
    query: &str,
    variables: Value,
) -> Result<(Value, Vec<String>), String> {
    let body = json!({ "query": query, "variables": variables }).to_string();
    let out = run(&["api", "graphql", "--input", "-"], Some(&body)).map_err(spawn_error)?;
    let parsed: Option<Value> = serde_json::from_str(out.stdout.trim()).ok();
    let errors: Vec<String> = parsed
        .as_ref()
        .and_then(|v| v.get("errors"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|e| {
                    e.get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("GraphQL error")
                        .to_owned()
                })
                .collect()
        })
        .unwrap_or_default();
    match parsed
        .as_ref()
        .and_then(|v| v.get("data"))
        .filter(|d| !d.is_null())
    {
        Some(data) => Ok((data.clone(), errors)),
        None if !errors.is_empty() => Err(errors.join("; ")),
        None if !out.ok => Err(failure_text(&out)),
        None => Err("gh api graphql returned no data".into()),
    }
}

/// Like [`graphql`], but any error message fails the call (mutations).
fn graphql_strict(run: &Runner<'_>, query: &str, variables: Value) -> Result<Value, String> {
    let (data, errors) = graphql(run, query, variables)?;
    if errors.is_empty() {
        Ok(data)
    } else {
        Err(errors.join("; "))
    }
}

// ---------------------------------------------------------------------------
// gh_status
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub available: bool,
    pub login: Option<String>,
    pub scopes: Vec<String>,
    pub error: Option<String>,
}

/// Parse `gh auth status` text (stdout and stderr together). Only the login
/// and scopes are kept; the masked token line is ignored.
pub fn parse_auth_status(text: &str, ok: bool) -> GhStatus {
    struct Account {
        login: String,
        active: bool,
        scopes: Vec<String>,
    }
    let mut accounts: Vec<Account> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(i) = t.find("Logged in to github.com account ") {
            let rest = &t[i + "Logged in to github.com account ".len()..];
            if let Some(login) = rest.split_whitespace().next() {
                accounts.push(Account {
                    login: login.to_owned(),
                    active: false,
                    scopes: Vec::new(),
                });
            }
        } else if let Some(acc) = accounts.last_mut() {
            if t.contains("Active account: true") {
                acc.active = true;
            } else if let Some(rest) = t.strip_prefix("- Token scopes:") {
                acc.scopes = rest
                    .split(',')
                    .map(|s| s.trim().trim_matches('\'').trim().to_owned())
                    .filter(|s| !s.is_empty() && s != "none")
                    .collect();
            }
        }
    }
    let chosen = accounts
        .iter()
        .position(|a| a.active)
        .or(if accounts.is_empty() { None } else { Some(0) });
    match chosen {
        Some(i) if ok || accounts[i].active => GhStatus {
            available: true,
            login: Some(accounts[i].login.clone()),
            scopes: accounts[i].scopes.clone(),
            error: None,
        },
        _ => {
            let error = text
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && *l != "github.com" && !l.contains("Token:"))
                .map(str::to_owned)
                .unwrap_or_else(|| "gh is not logged in to github.com".into());
            GhStatus {
                available: false,
                login: None,
                scopes: Vec::new(),
                error: Some(error),
            }
        }
    }
}

pub fn status_with(run: &Runner<'_>) -> GhStatus {
    match run(&["auth", "status", "--hostname", "github.com"], None) {
        Ok(out) => parse_auth_status(&format!("{}\n{}", out.stdout, out.stderr), out.ok),
        Err(e) => GhStatus {
            available: false,
            login: None,
            scopes: Vec::new(),
            error: Some(spawn_error(e)),
        },
    }
}

// ---------------------------------------------------------------------------
// Board items
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueRef {
    pub repo: String,
    pub number: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubIssues {
    pub total: u64,
    pub completed: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardItem {
    pub item_id: String,
    pub number: u64,
    pub repo: String,
    pub title: String,
    pub url: String,
    /// "open" | "closed" (a merged PR is closed).
    pub state: String,
    pub closed_at: Option<String>,
    pub is_pr: bool,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub area: Option<String>,
    pub scheduled: Option<String>,
    pub started: Option<String>,
    pub target: Option<String>,
    pub order: Option<f64>,
    pub done_when: Option<String>,
    pub outcome: Option<String>,
    pub parent: Option<IssueRef>,
    #[serde(default)]
    pub sub_issues: SubIssues,
}

impl BoardItem {
    fn is_epic(&self) -> bool {
        self.kind.as_deref() == Some("Epic")
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardSnapshot {
    /// ISO UTC; "" when the board was never fetched.
    pub fetched_at: String,
    pub items: Vec<BoardItem>,
    pub error: Option<String>,
    /// The Area field's option names, in board order.
    #[serde(default)]
    pub areas: Vec<String>,
}

const ITEM_FRAGMENT: &str = "fragment Item on ProjectV2Item { id type \
fieldValues(first: 30) { nodes { __typename \
... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } \
... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } \
... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } } \
... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } } } \
content { __typename \
... on Issue { number title url state closedAt repository { nameWithOwner } \
parent { number repository { nameWithOwner } } subIssuesSummary { total completed } } \
... on PullRequest { number title url state closedAt repository { nameWithOwner } } } }";

const FIELDS_SELECTION: &str = "fields(first: 50) { nodes { \
... on ProjectV2FieldCommon { id name dataType } \
... on ProjectV2SingleSelectField { options { id name } } } }";

fn board_query() -> String {
    format!(
        "query($id: ID!, $after: String) {{ node(id: $id) {{ ... on ProjectV2 {{ {FIELDS_SELECTION} \
items(first: 100, after: $after) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ ...Item }} }} }} }} }} {ITEM_FRAGMENT}"
    )
}

fn item_query() -> String {
    format!(
        "query($id: ID!) {{ node(id: $id) {{ ... on ProjectV2Item {{ ...Item }} }} }} {ITEM_FRAGMENT}"
    )
}

fn fields_query() -> String {
    format!("query($id: ID!) {{ node(id: $id) {{ ... on ProjectV2 {{ {FIELDS_SELECTION} }} }} }}")
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

/// One `ProjectV2Item` node -> BoardItem. Draft issues and items whose
/// content is not visible (no number or repository) are skipped.
pub fn map_item(node: &Value) -> Option<BoardItem> {
    let item_id = node.get("id")?.as_str()?.to_owned();
    let content = node.get("content")?;
    let is_pr = match content.get("__typename")?.as_str()? {
        "Issue" => false,
        "PullRequest" => true,
        _ => return None,
    };
    let number = content.get("number")?.as_u64()?;
    let repo = content
        .pointer("/repository/nameWithOwner")?
        .as_str()?
        .to_owned();
    let state = match content.get("state").and_then(Value::as_str) {
        Some("OPEN") => "open",
        _ => "closed",
    };
    let parent = content
        .get("parent")
        .filter(|p| !p.is_null())
        .and_then(|p| {
            Some(IssueRef {
                repo: p.pointer("/repository/nameWithOwner")?.as_str()?.to_owned(),
                number: p.get("number")?.as_u64()?,
            })
        });
    let sub_issues = content
        .get("subIssuesSummary")
        .map(|s| SubIssues {
            total: s.get("total").and_then(Value::as_u64).unwrap_or(0),
            completed: s.get("completed").and_then(Value::as_u64).unwrap_or(0),
        })
        .unwrap_or_default();
    let mut item = BoardItem {
        item_id,
        number,
        repo,
        title: content.get("title").and_then(str_of).unwrap_or_default(),
        url: content.get("url").and_then(str_of).unwrap_or_default(),
        state: state.to_owned(),
        closed_at: content.get("closedAt").and_then(str_of),
        is_pr,
        status: None,
        kind: None,
        area: None,
        scheduled: None,
        started: None,
        target: None,
        order: None,
        done_when: None,
        outcome: None,
        parent,
        sub_issues,
    };
    let values = node
        .pointer("/fieldValues/nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for fv in values {
        let Some(name) = fv.pointer("/field/name").and_then(Value::as_str) else {
            continue;
        };
        let text = || {
            fv.get("name")
                .or_else(|| fv.get("date"))
                .or_else(|| fv.get("text"))
                .and_then(str_of)
        };
        match name.to_ascii_lowercase().as_str() {
            "status" => item.status = text(),
            "kind" => item.kind = text(),
            "area" => item.area = text(),
            "scheduled" => item.scheduled = text(),
            "started" => item.started = text(),
            "target" => item.target = text(),
            "done when" => item.done_when = text(),
            "outcome" => item.outcome = text(),
            "order" => item.order = fv.get("number").and_then(Value::as_f64),
            _ => {}
        }
    }
    Some(item)
}

// ---------------------------------------------------------------------------
// Fields (ids resolved from names)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct FieldDef {
    pub id: String,
    pub name: String,
    pub data_type: String,
    /// (id, name) of single-select options.
    pub options: Vec<(String, String)>,
}

pub fn parse_fields(fields: &Value) -> Vec<FieldDef> {
    fields
        .get("nodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| {
                    Some(FieldDef {
                        id: n.get("id")?.as_str()?.to_owned(),
                        name: n.get("name")?.as_str()?.to_owned(),
                        data_type: n.get("dataType").and_then(str_of).unwrap_or_default(),
                        options: n
                            .get("options")
                            .and_then(Value::as_array)
                            .map(|o| {
                                o.iter()
                                    .filter_map(|o| {
                                        Some((
                                            o.get("id")?.as_str()?.to_owned(),
                                            o.get("name")?.as_str()?.to_owned(),
                                        ))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn area_options(fields: &[FieldDef]) -> Vec<String> {
    fields
        .iter()
        .find(|f| f.name.eq_ignore_ascii_case("Area"))
        .map(|f| f.options.iter().map(|(_, n)| n.clone()).collect())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum FieldType {
    Single,
    Date,
    Number,
    Text,
}

/// `board_set_field` keys -> board field name and type.
fn field_spec(key: &str) -> Option<(&'static str, FieldType)> {
    Some(match key {
        "status" => ("Status", FieldType::Single),
        "kind" => ("Kind", FieldType::Single),
        "area" => ("Area", FieldType::Single),
        "scheduled" => ("Scheduled", FieldType::Date),
        "order" => ("Order", FieldType::Number),
        "started" => ("Started", FieldType::Date),
        "target" => ("Target", FieldType::Date),
        "doneWhen" => ("Done when", FieldType::Text),
        "outcome" => ("Outcome", FieldType::Text),
        _ => return None,
    })
}

/// A field write: the field id and the `ProjectV2FieldValue` (None clears).
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub field_id: String,
    pub value: Option<Value>,
}

/// Everything a board operation needs: the gh runner, the app data dir (for
/// board.json) and the field list cached for the run.
pub struct Ctx<'a> {
    pub gh: &'a Runner<'a>,
    pub dir: &'a Path,
    pub fields: &'a Mutex<Option<Vec<FieldDef>>>,
}

static FIELDS: Mutex<Option<Vec<FieldDef>>> = Mutex::new(None);
/// One board.json read-modify-write at a time.
static CACHE_LOCK: Mutex<()> = Mutex::new(());
/// One board fetch at a time (a second caller then finds the fresh cache).
static FETCH_LOCK: Mutex<()> = Mutex::new(());
/// One SCHEDULE.md render at a time.
static RENDER_LOCK: Mutex<()> = Mutex::new(());

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Ctx<'_> {
    fn store_fields(&self, f: Vec<FieldDef>) {
        *lock(self.fields) = Some(f);
    }

    /// The cached field list, or a fresh one (`fresh` set) when there is none or `force`.
    fn field_list(&self, force: bool, fresh: &mut bool) -> Result<Vec<FieldDef>, String> {
        if !force && let Some(f) = lock(self.fields).clone() {
            return Ok(f);
        }
        let (data, _) = graphql(self.gh, &fields_query(), json!({ "id": PROJECT_ID }))?;
        let fields = data
            .pointer("/node/fields")
            .map(parse_fields)
            .ok_or_else(|| "the I4C project was not found".to_string())?;
        self.store_fields(fields.clone());
        *fresh = true;
        Ok(fields)
    }

    /// Resolve a field key and value to ids. Field and option names are
    /// matched case-insensitively; a miss refetches the field list once.
    fn resolve(&self, key: &str, value: &Value, fresh: &mut bool) -> Result<Resolved, String> {
        let (name, ty) = field_spec(key).ok_or_else(|| format!("unknown board field: {key}"))?;
        let mut defs = self.field_list(false, fresh)?;
        loop {
            let Some(fi) = defs.iter().position(|f| f.name.eq_ignore_ascii_case(name)) else {
                if !*fresh {
                    defs = self.field_list(true, fresh)?;
                    continue;
                }
                return Err(format!("the board has no {name} field"));
            };
            let field = defs[fi].clone();
            let clear = Resolved {
                field_id: field.id.clone(),
                value: None,
            };
            if value.is_null() {
                return Ok(clear);
            }
            let text = value.as_str().map(str::trim);
            let v = match ty {
                FieldType::Single => {
                    let s = text.ok_or_else(|| format!("{name} needs an option name"))?;
                    if s.is_empty() {
                        return Ok(clear);
                    }
                    match field
                        .options
                        .iter()
                        .find(|(_, n)| n.eq_ignore_ascii_case(s))
                    {
                        Some((id, _)) => json!({ "singleSelectOptionId": id }),
                        None if !*fresh => {
                            defs = self.field_list(true, fresh)?;
                            continue;
                        }
                        None => {
                            let names: Vec<&str> =
                                field.options.iter().map(|(_, n)| n.as_str()).collect();
                            return Err(format!(
                                "{name} has no option \"{s}\" (options: {})",
                                names.join(", ")
                            ));
                        }
                    }
                }
                FieldType::Date => {
                    let s = text.ok_or_else(|| format!("{name} needs a YYYY-MM-DD date"))?;
                    if s.is_empty() {
                        return Ok(clear);
                    }
                    parse_date(s).ok_or_else(|| format!("{name}: not a YYYY-MM-DD date: {s}"))?;
                    json!({ "date": s })
                }
                FieldType::Number => {
                    let n = value
                        .as_f64()
                        .or_else(|| text.filter(|s| !s.is_empty()).and_then(|s| s.parse().ok()));
                    match n {
                        Some(n) if n.is_finite() => json!({ "number": n }),
                        _ if text == Some("") => return Ok(clear),
                        _ => return Err(format!("{name} needs a number")),
                    }
                }
                FieldType::Text => {
                    let s = text.ok_or_else(|| format!("{name} needs text"))?;
                    if s.is_empty() {
                        return Ok(clear);
                    }
                    json!({ "text": s })
                }
            };
            return Ok(Resolved {
                field_id: field.id.clone(),
                value: Some(v),
            });
        }
    }

    fn write(&self, item_id: &str, r: &Resolved) -> Result<(), String> {
        let (query, path, vars) = match &r.value {
            Some(v) => (
                "mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) { \
updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) { projectV2Item { id } } }",
                "/updateProjectV2ItemFieldValue/projectV2Item/id",
                json!({ "project": PROJECT_ID, "item": item_id, "field": r.field_id, "value": v }),
            ),
            None => (
                "mutation($project: ID!, $item: ID!, $field: ID!) { \
clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) { projectV2Item { id } } }",
                "/clearProjectV2ItemFieldValue/projectV2Item/id",
                json!({ "project": PROJECT_ID, "item": item_id, "field": r.field_id }),
            ),
        };
        let data = graphql_strict(self.gh, query, vars)?;
        data.pointer(path)
            .and_then(Value::as_str)
            .map(|_| ())
            .ok_or_else(|| "the board did not confirm the change".to_string())
    }

    /// Resolve and write one field. When a write with cached ids fails, the
    /// field list is fetched again and the write retried once if the ids moved.
    fn set_value(&self, item_id: &str, key: &str, value: &Value) -> Result<(), String> {
        let mut fresh = false;
        let r = self.resolve(key, value, &mut fresh)?;
        match self.write(item_id, &r) {
            Ok(()) => Ok(()),
            Err(e) if !fresh => {
                *lock(self.fields) = None;
                let again = self.resolve(key, value, &mut fresh)?;
                if again == r {
                    Err(e)
                } else {
                    self.write(item_id, &again)
                }
            }
            Err(e) => Err(e),
        }
    }

    fn fetch_item(&self, item_id: &str) -> Result<BoardItem, String> {
        let (data, _) = graphql(self.gh, &item_query(), json!({ "id": item_id }))?;
        data.get("node")
            .and_then(map_item)
            .ok_or_else(|| format!("board item not found: {item_id}"))
    }
}

// ---------------------------------------------------------------------------
// board.json
// ---------------------------------------------------------------------------

pub fn read_cached(dir: &Path) -> Option<BoardSnapshot> {
    let text = fs::read_to_string(dir.join("board.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_cache(dir: &Path, snap: &BoardSnapshot) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(snap).map_err(|e| e.to_string())?;
    text.push('\n');
    atomic_write(&dir.join("board.json"), text.as_bytes(), Some(0o644))
        .map_err(|e| format!("cannot write board.json: {e}"))
}

/// Replace (or add) one item in the cached snapshot. No cache, no write.
fn cache_upsert(dir: &Path, item: &BoardItem) {
    let _g = lock(&CACHE_LOCK);
    let Some(mut snap) = read_cached(dir) else {
        return;
    };
    match snap.items.iter_mut().find(|i| i.item_id == item.item_id) {
        Some(slot) => *slot = item.clone(),
        None => snap.items.push(item.clone()),
    }
    let _ = write_cache(dir, &snap);
}

/// Fetch the whole board (paginated at 100) and cache it. Without `force` a
/// snapshot younger than FRESH_SECS is returned as is. A failure returns the
/// cached snapshot (or an empty one) with `error` set; the cache is kept.
pub fn fetch(ctx: &Ctx, force: bool, now: i64) -> BoardSnapshot {
    let _g = lock(&FETCH_LOCK);
    let cached = read_cached(ctx.dir);
    if !force
        && let Some(c) = &cached
        && c.error.is_none()
        && parse_iso_utc(&c.fetched_at).is_some_and(|t| (0..FRESH_SECS).contains(&(now - t)))
    {
        return c.clone();
    }
    match fetch_all(ctx) {
        Ok((items, fields)) => {
            let snap = BoardSnapshot {
                fetched_at: iso_utc(now),
                items,
                error: None,
                areas: area_options(&fields),
            };
            ctx.store_fields(fields);
            let _c = lock(&CACHE_LOCK);
            match write_cache(ctx.dir, &snap) {
                Ok(()) => snap,
                Err(e) => BoardSnapshot {
                    error: Some(e),
                    ..snap
                },
            }
        }
        Err(e) => match cached {
            Some(c) => BoardSnapshot {
                error: Some(e),
                ..c
            },
            None => BoardSnapshot {
                fetched_at: String::new(),
                items: Vec::new(),
                error: Some(e),
                areas: Vec::new(),
            },
        },
    }
}

fn fetch_all(ctx: &Ctx) -> Result<(Vec<BoardItem>, Vec<FieldDef>), String> {
    let query = board_query();
    let mut items = Vec::new();
    let mut fields = Vec::new();
    let mut after: Option<String> = None;
    for page in 0..MAX_PAGES {
        let (data, errors) = graphql(ctx.gh, &query, json!({ "id": PROJECT_ID, "after": after }))?;
        let node =
            data.get("node")
                .filter(|n| !n.is_null())
                .ok_or_else(|| match errors.first() {
                    Some(e) => e.clone(),
                    None => "the I4C project was not found".to_string(),
                })?;
        if page == 0 {
            fields = node.get("fields").map(parse_fields).unwrap_or_default();
        }
        let conn = node
            .get("items")
            .ok_or_else(|| "the board answer has no items".to_string())?;
        if let Some(nodes) = conn.get("nodes").and_then(Value::as_array) {
            items.extend(nodes.iter().filter_map(map_item));
        }
        let next = conn
            .pointer("/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            == Some(true);
        after = conn.pointer("/pageInfo/endCursor").and_then(str_of);
        if !next || after.is_none() {
            return Ok((items, fields));
        }
    }
    Ok((items, fields))
}

pub fn set_field(ctx: &Ctx, item_id: &str, key: &str, value: &Value) -> Result<BoardItem, String> {
    if item_id.trim().is_empty() {
        return Err("no board item given".into());
    }
    ctx.set_value(item_id, key, value)?;
    let item = ctx.fetch_item(item_id)?;
    cache_upsert(ctx.dir, &item);
    Ok(item)
}

// ---------------------------------------------------------------------------
// Creating tasks and epics
// ---------------------------------------------------------------------------

fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn split_repo(repo: &str) -> (&str, &str) {
    repo.split_once('/').unwrap_or((repo, ""))
}

/// The issue URL `gh issue create` printed (its last https line) and its number.
pub fn parse_issue_url(stdout: &str) -> Option<(String, u64)> {
    let url = stdout
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| l.starts_with("https://"))?;
    let number = url.rsplit('/').next()?.parse().ok()?;
    Some((url.to_owned(), number))
}

fn issue_create(ctx: &Ctx, repo: &str, title: &str, body: &str) -> Result<(String, u64), String> {
    let (repo_a, title_a, body_a) = (
        format!("--repo={repo}"),
        format!("--title={title}"),
        format!("--body={body}"),
    );
    let out = gh(
        ctx.gh,
        &["issue", "create", &repo_a, &title_a, &body_a],
        None,
    )?;
    parse_issue_url(&out)
        .ok_or_else(|| format!("gh issue create printed no issue URL: {}", out.trim()))
}

fn add_sub_issue(ctx: &Ctx, parent: &IssueRef, child_repo: &str, child: u64) -> Result<(), String> {
    let (po, pn) = split_repo(&parent.repo);
    let (co, cn) = split_repo(child_repo);
    let (data, _) = graphql(
        ctx.gh,
        "query($po: String!, $pn: String!, $pi: Int!, $co: String!, $cn: String!, $ci: Int!) { \
parent: repository(owner: $po, name: $pn) { issue(number: $pi) { id } } \
child: repository(owner: $co, name: $cn) { issue(number: $ci) { id } } }",
        json!({ "po": po, "pn": pn, "pi": parent.number, "co": co, "cn": cn, "ci": child }),
    )?;
    let parent_id = data
        .pointer("/parent/issue/id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("epic {}#{} not found", parent.repo, parent.number))?;
    let child_id = data
        .pointer("/child/issue/id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("issue {child_repo}#{child} not found"))?;
    graphql_strict(
        ctx.gh,
        "mutation($parent: ID!, $child: ID!) { addSubIssue(input: { issueId: $parent, subIssueId: $child }) { issue { id } } }",
        json!({ "parent": parent_id, "child": child_id }),
    )?;
    Ok(())
}

/// `gh project item-add` (idempotent) -> the item id.
fn item_add(ctx: &Ctx, url: &str) -> Result<String, String> {
    let out = gh(
        ctx.gh,
        &[
            "project",
            "item-add",
            PROJECT_NUMBER,
            "--owner",
            OWNER,
            "--url",
            url,
            "--format",
            "json",
        ],
        None,
    )?;
    serde_json::from_str::<Value>(out.trim())
        .ok()
        .and_then(|v| str_of(v.get("id")?))
        .ok_or_else(|| "gh project item-add returned no item id".to_string())
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewTask {
    pub repo: String,
    pub title: String,
    pub body: String,
    pub epic: Option<IssueRef>,
    pub scheduled: Option<String>,
}

/// Create an issue, link it under its epic, add it to the board as a Task
/// (with Scheduled when given). Errors after the issue exists name its URL.
pub fn create_task(ctx: &Ctx, t: &NewTask) -> Result<BoardItem, String> {
    let repo = t.repo.trim();
    let title = t.title.trim();
    if !valid_repo(repo) {
        return Err(format!("not an owner/name repository: {repo}"));
    }
    if title.is_empty() {
        return Err("a task needs a title".into());
    }
    if let Some(e) = &t.epic
        && !valid_repo(&e.repo)
    {
        return Err(format!("not an owner/name repository: {}", e.repo));
    }
    let scheduled = t
        .scheduled
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(s) = scheduled {
        parse_date(s).ok_or_else(|| format!("not a YYYY-MM-DD date: {s}"))?;
    }
    let (url, number) = issue_create(ctx, repo, title, &t.body)?;
    let after = |what: &str| {
        let url = url.clone();
        let what = what.to_owned();
        move |e: String| format!("created {url}, but {what} failed: {e}")
    };
    if let Some(epic) = &t.epic {
        add_sub_issue(ctx, epic, repo, number).map_err(after("linking it to its epic"))?;
    }
    let item_id = item_add(ctx, &url).map_err(after("adding it to the board"))?;
    ctx.set_value(&item_id, "kind", &json!("Task"))
        .map_err(after("setting Kind"))?;
    if let Some(s) = scheduled {
        ctx.set_value(&item_id, "scheduled", &json!(s))
            .map_err(after("setting Scheduled"))?;
    }
    let item = ctx.fetch_item(&item_id).map_err(after("reading it back"))?;
    cache_upsert(ctx.dir, &item);
    Ok(item)
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewEpic {
    pub title: String,
    pub body: String,
    pub area: Option<String>,
    pub done_when: Option<String>,
}

/// Create an epic issue in the hub repo and add it to the board as an Epic.
pub fn create_epic(ctx: &Ctx, e: &NewEpic) -> Result<BoardItem, String> {
    let title = e.title.trim();
    if title.is_empty() {
        return Err("an epic needs a title".into());
    }
    let (url, _) = issue_create(ctx, HUB_REPO, title, &e.body)?;
    let after = |what: &str| {
        let url = url.clone();
        let what = what.to_owned();
        move |err: String| format!("created {url}, but {what} failed: {err}")
    };
    let item_id = item_add(ctx, &url).map_err(after("adding it to the board"))?;
    ctx.set_value(&item_id, "kind", &json!("Epic"))
        .map_err(after("setting Kind"))?;
    if let Some(a) = e.area.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        ctx.set_value(&item_id, "area", &json!(a))
            .map_err(after("setting Area"))?;
    }
    if let Some(d) = e
        .done_when
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        ctx.set_value(&item_id, "doneWhen", &json!(d))
            .map_err(after("setting Done when"))?;
    }
    let item = ctx.fetch_item(&item_id).map_err(after("reading it back"))?;
    cache_upsert(ctx.dir, &item);
    Ok(item)
}

// ---------------------------------------------------------------------------
// Schedule (schedule.json)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct DayPlan {
    pub area: Option<String>,
    pub note: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct Rhythm {
    pub mon: DayPlan,
    pub tue: DayPlan,
    pub wed: DayPlan,
    pub thu: DayPlan,
    pub fri: DayPlan,
    pub sat: DayPlan,
    pub sun: DayPlan,
}

impl Rhythm {
    /// 0 = Monday.
    pub fn day(&self, wd: usize) -> &DayPlan {
        match wd {
            0 => &self.mon,
            1 => &self.tue,
            2 => &self.wed,
            3 => &self.thu,
            4 => &self.fri,
            5 => &self.sat,
            _ => &self.sun,
        }
    }

    fn days_mut(&mut self) -> [&mut DayPlan; 7] {
        [
            &mut self.mon,
            &mut self.tue,
            &mut self.wed,
            &mut self.thu,
            &mut self.fri,
            &mut self.sat,
            &mut self.sun,
        ]
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(default)]
pub struct Schedule {
    pub rhythm: Rhythm,
    /// "YYYY-MM-DD" -> plan; an override wins over the rhythm for that day.
    pub overrides: BTreeMap<String, DayPlan>,
}

fn clean_plan(p: &mut DayPlan) {
    p.area = p
        .area
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    p.note = p.note.split_whitespace().collect::<Vec<_>>().join(" ");
}

/// Trim areas and notes (notes become one line), drop overrides whose key is
/// not a date.
pub fn sanitize_schedule(mut s: Schedule) -> Schedule {
    for d in s.rhythm.days_mut() {
        clean_plan(d);
    }
    s.overrides.retain(|k, _| parse_date(k).is_some());
    for p in s.overrides.values_mut() {
        clean_plan(p);
    }
    s
}

impl Schedule {
    /// The plan for a day: (area, override note, from the rhythm?).
    pub fn plan(&self, day: i64) -> (Option<&str>, Option<&str>, bool) {
        match self.overrides.get(&format_date(day)) {
            Some(o) => (
                o.area.as_deref(),
                Some(o.note.as_str()).filter(|n| !n.is_empty()),
                false,
            ),
            None => (self.rhythm.day(weekday(day)).area.as_deref(), None, true),
        }
    }
}

pub fn read_schedule(dir: &Path) -> Result<Schedule, String> {
    match fs::read_to_string(dir.join("schedule.json")) {
        Ok(t) if t.trim().is_empty() => Ok(Schedule::default()),
        Ok(t) => serde_json::from_str::<Schedule>(&t)
            .map(sanitize_schedule)
            .map_err(|e| format!("cannot parse schedule.json: {e}")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Schedule::default()),
        Err(e) => Err(format!("cannot read schedule.json: {e}")),
    }
}

pub fn write_schedule(dir: &Path, s: Schedule) -> Result<Schedule, String> {
    let s = sanitize_schedule(s);
    let mut text = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    text.push('\n');
    atomic_write(&dir.join("schedule.json"), text.as_bytes(), Some(0o644))
        .map_err(|e| format!("cannot write schedule.json: {e}"))?;
    Ok(s)
}

// ---------------------------------------------------------------------------
// SCHEDULE.md
// ---------------------------------------------------------------------------

const LANES: [&str; 5] = ["Backlog", "Ready", "In progress", "In review", "Done"];

fn lane_rank(status: Option<&str>) -> usize {
    status
        .and_then(|s| LANES.iter().position(|l| l.eq_ignore_ascii_case(s)))
        .unwrap_or(LANES.len())
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// No em or en dashes in the generated file.
fn no_dashes(s: &str) -> String {
    s.replace(['\u{2014}', '\u{2013}'], "-")
}

struct MdContext<'a> {
    by_ref: HashMap<(&'a str, u64), &'a BoardItem>,
}

impl MdContext<'_> {
    /// `- <repo>#<n> <title> (<status>; epic <hub>#<n> <title>)`
    fn task_line(&self, it: &BoardItem) -> String {
        let status = it.status.clone().unwrap_or_else(|| {
            if it.state == "closed" {
                "closed".into()
            } else {
                "no status".into()
            }
        });
        let mut t = format!(
            "- {}#{} {} ({status}",
            it.repo,
            it.number,
            one_line(&it.title)
        );
        if let Some(p) = &it.parent {
            t.push_str(&format!("; epic {}#{}", p.repo, p.number));
            if let Some(e) = self.by_ref.get(&(p.repo.as_str(), p.number)) {
                t.push(' ');
                t.push_str(&one_line(&e.title));
            }
        }
        t.push(')');
        t
    }
}

fn sorted_tasks(mut v: Vec<&BoardItem>) -> Vec<&BoardItem> {
    v.sort_by(|a, b| {
        lane_rank(a.status.as_deref())
            .cmp(&lane_rank(b.status.as_deref()))
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| a.number.cmp(&b.number))
    });
    v
}

fn md_cell(s: &str) -> String {
    let t = one_line(s).replace('|', "\\|");
    if t.is_empty() { "-".into() } else { t }
}

/// The calendar layer as Markdown for `today` (local day).
pub fn render_schedule_md(
    board: Option<&BoardSnapshot>,
    schedule: &Schedule,
    today: i64,
) -> String {
    let items: &[BoardItem] = board.map(|b| b.items.as_slice()).unwrap_or_default();
    let ctx = MdContext {
        by_ref: items
            .iter()
            .map(|i| ((i.repo.as_str(), i.number), i))
            .collect(),
    };
    let mut by_date: BTreeMap<i64, Vec<&BoardItem>> = BTreeMap::new();
    for it in items {
        if let Some(d) = it.scheduled.as_deref().and_then(parse_date) {
            by_date.entry(d).or_default().push(it);
        }
    }
    let tasks_on = |d: i64| sorted_tasks(by_date.get(&d).cloned().unwrap_or_default());

    let mut out: Vec<String> = vec![
        "# Schedule".into(),
        format!(
            "Generated by Tsukue (Calendar panel) from the I4C board and the weekly rhythm; edit there, this file is overwritten. Board: {BOARD_URL}"
        ),
        String::new(),
    ];

    // Today
    let (area, note, _) = schedule.plan(today);
    out.push(format!("## Today: {}", date_label(today)));
    out.push(String::new());
    out.push(format!("Area: {}", area.unwrap_or("none")));
    if let Some(n) = note {
        out.push(format!("Note: {n}"));
    }
    let today_tasks = tasks_on(today);
    if today_tasks.is_empty() {
        out.push("Nothing scheduled.".into());
    } else {
        out.extend(today_tasks.iter().map(|t| ctx.task_line(t)));
    }
    out.push(String::new());

    // This week, Monday to Sunday
    let monday = today - weekday(today) as i64;
    let sunday = monday + 6;
    out.push(format!(
        "## This week: {} to {}",
        date_label(monday),
        date_label(sunday)
    ));
    for d in monday..=sunday {
        out.push(String::new());
        let mark = if d == today { " (today)" } else { "" };
        out.push(format!("### {}{mark}", date_label(d)));
        let (area, note, _) = schedule.plan(d);
        let tasks = tasks_on(d);
        if area.is_none() && note.is_none() && tasks.is_empty() {
            out.push("nothing scheduled".into());
            continue;
        }
        if let Some(a) = area {
            out.push(format!("Area: {a}"));
        }
        if let Some(n) = note {
            out.push(format!("Note: {n}"));
        }
        out.extend(tasks.iter().map(|t| ctx.task_line(t)));
    }
    out.push(String::new());

    // Coming up: dated tasks after this week, within 30 days of today
    out.push("## Coming up (next 30 days)".into());
    let later: Vec<(i64, Vec<&BoardItem>)> = by_date
        .range(sunday + 1..=today + 30)
        .map(|(d, v)| (*d, sorted_tasks(v.clone())))
        .collect();
    if later.is_empty() {
        out.push(String::new());
        out.push("Nothing dated after this week.".into());
    }
    for (d, tasks) in later {
        out.push(String::new());
        out.push(format!("### {}", date_label(d)));
        out.extend(tasks.iter().map(|t| ctx.task_line(t)));
    }
    out.push(String::new());

    // Weekly rhythm
    out.push("## Weekly rhythm".into());
    out.push(String::new());
    out.push("| Weekday | Area | Note |".into());
    out.push("| --- | --- | --- |".into());
    for (i, name) in WEEKDAYS.iter().enumerate() {
        let p = schedule.rhythm.day(i);
        out.push(format!(
            "| {name} | {} | {} |",
            md_cell(p.area.as_deref().unwrap_or("none")),
            md_cell(&p.note)
        ));
    }
    out.push(String::new());

    // Unscheduled open tasks in Ready or In progress
    out.push("## Unscheduled".into());
    out.push(String::new());
    out.push("Open tasks in Ready or In progress without a date (propose one):".into());
    let mut open: Vec<&BoardItem> = items
        .iter()
        .filter(|i| {
            !i.is_epic()
                && i.state == "open"
                && i.scheduled.is_none()
                && matches!(i.status.as_deref(), Some("Ready") | Some("In progress"))
        })
        .collect();
    open.sort_by(|a, b| {
        // In progress first, then Ready by Order, then title.
        let rank = |i: &BoardItem| {
            if i.status.as_deref() == Some("In progress") {
                0
            } else {
                1
            }
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| {
                let o = |i: &BoardItem| i.order.unwrap_or(f64::MAX);
                o(a).partial_cmp(&o(b)).unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    if open.is_empty() {
        out.push("- none".into());
    } else {
        out.extend(open.iter().map(|t| ctx.task_line(t)));
    }
    no_dashes(&(out.join("\n") + "\n"))
}

/// `existing` plus the schedule import, or None when it already has one.
pub fn amended_schedule_import(existing: &str) -> Option<String> {
    if existing.contains("@SCHEDULE.md") {
        return None;
    }
    let mut t = existing.to_owned();
    if !t.is_empty() {
        if !t.ends_with('\n') {
            t.push('\n');
        }
        t.push('\n');
    }
    t.push_str(SCHEDULE_PARAGRAPH);
    t.push('\n');
    Some(t)
}

fn trim_root(s: &str) -> Option<PathBuf> {
    let t = s.trim();
    let t = if t.len() > 1 {
        t.trim_end_matches('/')
    } else {
        t
    };
    (t.starts_with('/') && !t.split('/').any(|c| c == "..")).then(|| PathBuf::from(t))
}

/// prefs.json `workspaceRoots` (default `[<home>/Develop]` when the key is
/// missing and that folder exists; an explicit `[]` stays empty).
pub fn workspace_roots(dir: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let prefs: Option<Value> = fs::read_to_string(dir.join("prefs.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    match prefs.as_ref().and_then(|p| p.get("workspaceRoots")) {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .filter_map(trim_root)
            .collect(),
        _ => home
            .map(|h| h.join("Develop"))
            .filter(|d| d.is_dir())
            .into_iter()
            .collect(),
    }
}

/// The first configured workspace root that exists.
pub fn first_workspace_root(dir: &Path, home: Option<&Path>) -> Option<PathBuf> {
    workspace_roots(dir, home).into_iter().find(|r| r.is_dir())
}

/// Append the `@SCHEDULE.md` import to `<root>/CLAUDE.md` once per root
/// (remembered in `<appData>/schedule-imports.json`), so an import the user
/// removes stays removed. A missing CLAUDE.md is left alone (the Projects
/// panel creates it) and retried next time.
pub fn ensure_schedule_import(dir: &Path, root: &Path) -> Result<bool, String> {
    let state_path = dir.join("schedule-imports.json");
    let mut done: Vec<String> = fs::read_to_string(&state_path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| {
            v.get("roots")?
                .as_array()
                .map(|a| a.iter().filter_map(str_of).collect())
        })
        .unwrap_or_default();
    let key = root.to_string_lossy().into_owned();
    if done.contains(&key) {
        return Ok(false);
    }
    let file = root.join("CLAUDE.md");
    let target = file.canonicalize().unwrap_or_else(|_| file.clone());
    let amended = match fs::read_to_string(&target) {
        Ok(existing) => match amended_schedule_import(&existing) {
            Some(t) => {
                atomic_write(&target, t.as_bytes(), None)
                    .map_err(|e| format!("cannot write {}: {e}", file.display()))?;
                true
            }
            None => false,
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("cannot read {}: {e}", file.display())),
    };
    done.push(key);
    let text =
        serde_json::to_string_pretty(&json!({ "roots": done })).map_err(|e| e.to_string())? + "\n";
    atomic_write(&state_path, text.as_bytes(), Some(0o644))
        .map_err(|e| format!("cannot write schedule-imports.json: {e}"))?;
    Ok(amended)
}

/// Render SCHEDULE.md from the cached board and the schedule into `root`,
/// writing only when the text changed; then the one-time CLAUDE.md import.
pub fn render_into(dir: &Path, root: &Path, today: i64) -> Result<PathBuf, String> {
    let _g = lock(&RENDER_LOCK);
    let board = read_cached(dir);
    let schedule = read_schedule(dir)?;
    let text = render_schedule_md(board.as_ref(), &schedule, today);
    let path = root.join("SCHEDULE.md");
    if fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
        atomic_write(&path, text.as_bytes(), Some(0o644))
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    ensure_schedule_import(dir, root)?;
    Ok(path)
}

/// SCHEDULE.md in the first workspace root, for today.
pub fn render_now(dir: &Path) -> Result<PathBuf, String> {
    let home = home_dir().ok();
    let root = first_workspace_root(dir, home.as_deref()).ok_or_else(|| {
        "no workspace root to write SCHEDULE.md to (Settings, This app, Projects)".to_string()
    })?;
    render_into(dir, &root, local_today())
}

/// Render and only log a failure (after fetches and field writes).
fn render_quietly(dir: &Path) {
    if let Err(e) = render_now(dir) {
        crate::watchdog::note(&format!("SCHEDULE.md not written: {e}"));
    }
}

/// At startup: render SCHEDULE.md from what is on disk, off the main thread.
pub fn startup_render() {
    std::thread::spawn(|| {
        if let Ok(dir) = app_data_dir() {
            render_quietly(&dir);
        }
    });
}

// ---------------------------------------------------------------------------
// activity_days
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ActivityDay {
    pub date: String,
    /// Project path -> prompt count.
    pub projects: BTreeMap<String, u32>,
}

/// The deepest workspace project containing `cwd` (as scanned), else `cwd`.
fn project_for(cwd: &str, projects: &[(PathBuf, Option<PathBuf>)]) -> String {
    let p = Path::new(cwd);
    projects
        .iter()
        .filter_map(|(given, canon)| {
            // Depth of the spelling that contains cwd, so the closest project wins.
            let depth = [Some(given), canon.as_ref()]
                .into_iter()
                .flatten()
                .filter(|q| p.starts_with(q))
                .map(|q| q.components().count())
                .max()?;
            Some((depth, given))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, given)| given.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            let t = cwd.trim_end_matches('/');
            if t.is_empty() {
                cwd.to_owned()
            } else {
                t.to_owned()
            }
        })
}

/// Prompts per day (`to_day` maps epoch ms to a local day) and project from
/// history.jsonl, for every day from `from` to `to` inclusive.
pub fn activity_between(
    from: &str,
    to: &str,
    history: &Path,
    projects: &[(PathBuf, Option<PathBuf>)],
    to_day: &dyn Fn(i64) -> i64,
) -> Result<Vec<ActivityDay>, String> {
    let f = parse_date(from).ok_or_else(|| format!("not a YYYY-MM-DD date: {from}"))?;
    let t = parse_date(to).ok_or_else(|| format!("not a YYYY-MM-DD date: {to}"))?;
    if t < f {
        return Err("the range ends before it starts".into());
    }
    if t - f >= MAX_ACTIVITY_DAYS {
        return Err(format!("at most {MAX_ACTIVITY_DAYS} days at a time"));
    }
    let mut days: BTreeMap<i64, BTreeMap<String, u32>> = BTreeMap::new();
    let mut groups: HashMap<String, String> = HashMap::new();
    for h in history_lines(history) {
        let (Some(ts), Some(cwd)) = (h.timestamp, h.project.filter(|p| !p.is_empty())) else {
            continue;
        };
        let d = to_day(ts);
        if d < f || d > t {
            continue;
        }
        let key = groups
            .entry(cwd.clone())
            .or_insert_with(|| project_for(&cwd, projects))
            .clone();
        *days.entry(d).or_default().entry(key).or_insert(0) += 1;
    }
    Ok((f..=t)
        .map(|d| ActivityDay {
            date: format_date(d),
            projects: days.remove(&d).unwrap_or_default(),
        })
        .collect())
}

/// Projects of the last workspace scan, or a fresh scan of the configured roots.
fn activity_projects(dir: &Path) -> Vec<(PathBuf, Option<PathBuf>)> {
    let last = workspace::last_projects();
    if !last.is_empty() {
        return last;
    }
    let home = home_dir().ok().and_then(|h| h.canonicalize().ok());
    let roots: Vec<String> = workspace_roots(dir, home.as_deref())
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    workspace::with_canonical(workspace::project_paths(&workspace::scan(
        &roots,
        home.as_deref(),
    )))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn real_ctx<T>(dir: &Path, f: impl FnOnce(&Ctx) -> T) -> T {
    let ctx = Ctx {
        gh: &real_gh,
        dir,
        fields: &FIELDS,
    };
    f(&ctx)
}

#[tauri::command]
pub async fn gh_status() -> Result<GhStatus, String> {
    blocking(|| Ok(status_with(&real_gh))).await
}

#[tauri::command]
pub async fn board_fetch(force: Option<bool>) -> Result<BoardSnapshot, String> {
    blocking(move || {
        let dir = app_data_dir()?;
        let snap = real_ctx(&dir, |ctx| fetch(ctx, force.unwrap_or(false), now_secs()));
        if snap.error.is_none() {
            render_quietly(&dir);
        }
        Ok(snap)
    })
    .await
}

#[tauri::command]
pub async fn board_cached() -> Result<Option<BoardSnapshot>, String> {
    blocking(|| Ok(read_cached(&app_data_dir()?))).await
}

#[tauri::command]
pub async fn board_set_field(
    item_id: String,
    field: String,
    value: Option<Value>,
) -> Result<BoardItem, String> {
    blocking(move || {
        let dir = app_data_dir()?;
        let item = real_ctx(&dir, |ctx| {
            set_field(ctx, &item_id, &field, &value.unwrap_or(Value::Null))
        })?;
        render_quietly(&dir);
        Ok(item)
    })
    .await
}

#[tauri::command]
pub async fn board_create_task(
    repo: String,
    title: String,
    body: Option<String>,
    epic: Option<IssueRef>,
    scheduled: Option<String>,
) -> Result<BoardItem, String> {
    blocking(move || {
        let dir = app_data_dir()?;
        let t = NewTask {
            repo,
            title,
            body: body.unwrap_or_default(),
            epic,
            scheduled,
        };
        let item = real_ctx(&dir, |ctx| create_task(ctx, &t))?;
        render_quietly(&dir);
        Ok(item)
    })
    .await
}

#[tauri::command]
pub async fn board_create_epic(
    title: String,
    body: Option<String>,
    area: Option<String>,
    done_when: Option<String>,
) -> Result<BoardItem, String> {
    blocking(move || {
        let dir = app_data_dir()?;
        let e = NewEpic {
            title,
            body: body.unwrap_or_default(),
            area,
            done_when,
        };
        let item = real_ctx(&dir, |ctx| create_epic(ctx, &e))?;
        render_quietly(&dir);
        Ok(item)
    })
    .await
}

#[tauri::command]
pub async fn schedule_read() -> Result<Schedule, String> {
    blocking(|| read_schedule(&app_data_dir()?)).await
}

/// Write schedule.json, then SCHEDULE.md. Returns the schedule as saved.
#[tauri::command]
pub async fn schedule_write(schedule: Schedule) -> Result<Schedule, String> {
    blocking(move || {
        let dir = app_data_dir()?;
        let saved = write_schedule(&dir, schedule)?;
        render_now(&dir).map_err(|e| format!("schedule saved, but {e}"))?;
        Ok(saved)
    })
    .await
}

#[tauri::command]
pub async fn schedule_render() -> Result<String, String> {
    blocking(|| Ok(render_now(&app_data_dir()?)?.to_string_lossy().into_owned())).await
}

#[tauri::command]
pub async fn activity_days(from: String, to: String) -> Result<Vec<ActivityDay>, String> {
    blocking(move || {
        let dir = app_data_dir()?;
        let projects = activity_projects(&dir);
        activity_between(
            &from,
            &to,
            &claude_dir()?.join("history.jsonl"),
            &projects,
            &local_day_of_ms,
        )
    })
    .await
}

// ---------------------------------------------------------------------------
// Tests (no test runs the real gh)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn d(s: &str) -> i64 {
        parse_date(s).unwrap()
    }

    #[test]
    fn date_maths() {
        assert_eq!(d("1970-01-01"), 0);
        assert_eq!(d("2026-11-01"), 20758);
        assert_eq!(weekday(d("2026-11-01")), 6, "Sunday");
        assert_eq!(weekday(d("2026-10-26")), 0, "Monday");
        assert_eq!(weekday(d("2024-02-29")), 3, "Thursday");
        assert_eq!(format_date(d("2026-12-28") + 6), "2027-01-03");
        assert_eq!(parse_date("2026-02-29"), None);
        assert_eq!(parse_date("2026-13-01"), None);
        assert_eq!(parse_date("2026-1-01"), None);
        for days in [-1000, 0, 19782, 20758, 40000] {
            assert_eq!(parse_date(&format_date(days)), Some(days));
        }
        assert_eq!(iso_utc(1_793_503_800), "2026-11-01T03:30:00Z");
        assert_eq!(parse_iso_utc("2026-11-01T03:30:00Z"), Some(1_793_503_800));
        assert_eq!(parse_iso_utc(""), None);
    }

    // ---- gh runner fakes ------------------------------------------------

    type Handler = Box<dyn Fn(&[&str], Option<&str>) -> GhOut + Send + Sync>;

    /// Records every call; answers through `handler`.
    struct Fake {
        calls: StdMutex<Vec<(Vec<String>, Option<String>)>>,
        handler: Handler,
    }

    impl Fake {
        fn new(handler: impl Fn(&[&str], Option<&str>) -> GhOut + Send + Sync + 'static) -> Self {
            Fake {
                calls: StdMutex::new(Vec::new()),
                handler: Box::new(handler),
            }
        }
        fn run(&self, args: &[&str], stdin: Option<&str>) -> io::Result<GhOut> {
            self.calls.lock().unwrap().push((
                args.iter().map(|s| s.to_string()).collect(),
                stdin.map(str::to_owned),
            ));
            Ok((self.handler)(args, stdin))
        }
        fn calls(&self) -> Vec<(Vec<String>, Option<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    fn ok(stdout: impl Into<String>) -> GhOut {
        GhOut {
            ok: true,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    fn body_of(stdin: Option<&str>) -> Value {
        serde_json::from_str(stdin.unwrap_or("{}")).unwrap()
    }

    fn fields_json(extra_area: Option<&str>) -> Value {
        let mut areas = vec![
            json!({ "id": "a-qring", "name": "q-ring" }),
            json!({ "id": "a-aibou", "name": "aibou" }),
        ];
        if let Some(a) = extra_area {
            areas.push(json!({ "id": format!("a-{a}"), "name": a }));
        }
        json!({ "nodes": [
            { "id": "F_TITLE", "name": "Title", "dataType": "TITLE" },
            { "id": "F_STATUS", "name": "Status", "dataType": "SINGLE_SELECT", "options": [
                { "id": "s-backlog", "name": "Backlog" }, { "id": "s-ready", "name": "Ready" },
                { "id": "s-prog", "name": "In progress" }, { "id": "s-review", "name": "In review" },
                { "id": "s-done", "name": "Done" } ] },
            { "id": "F_KIND", "name": "Kind", "dataType": "SINGLE_SELECT", "options": [
                { "id": "k-epic", "name": "Epic" }, { "id": "k-task", "name": "Task" } ] },
            { "id": "F_AREA", "name": "Area", "dataType": "SINGLE_SELECT", "options": areas },
            { "id": "F_SCHED", "name": "Scheduled", "dataType": "DATE" },
            { "id": "F_ORDER", "name": "Order", "dataType": "NUMBER" },
            { "id": "F_DONE", "name": "Done when", "dataType": "TEXT" },
            {}
        ] })
    }

    fn sv(field: &str, name: &str) -> Value {
        json!({ "__typename": "ProjectV2ItemFieldSingleSelectValue", "name": name, "field": { "name": field } })
    }

    /// A small board: an epic in the hub, a task under it (in another repo), a PR, a draft.
    fn item_nodes() -> Vec<Value> {
        vec![
            json!({ "id": "PVTI_epic", "type": "ISSUE", "fieldValues": { "nodes": [
                { "__typename": "ProjectV2ItemFieldRepositoryValue" },
                { "__typename": "ProjectV2ItemFieldTextValue", "text": "Aibou app", "field": { "name": "Title" } },
                sv("Status", "In progress"), sv("Kind", "Epic"), sv("Area", "aibou"),
                { "__typename": "ProjectV2ItemFieldDateValue", "date": "2026-09-29", "field": { "name": "Started" } },
                { "__typename": "ProjectV2ItemFieldTextValue", "text": "On Play", "field": { "name": "Done when" } }
              ] },
              "content": { "__typename": "Issue", "number": 20, "title": "Aibou \u{2014} pet care", "url": "https://github.com/I4cTime/focus/issues/20",
                "state": "OPEN", "closedAt": null, "repository": { "nameWithOwner": "I4cTime/focus" }, "parent": null,
                "subIssuesSummary": { "total": 7, "completed": 3 } } }),
            json!({ "id": "PVTI_task", "type": "ISSUE", "fieldValues": { "nodes": [
                sv("Status", "Ready"), sv("Kind", "Task"),
                { "__typename": "ProjectV2ItemFieldDateValue", "date": "2026-11-01", "field": { "name": "Scheduled" } },
                { "__typename": "ProjectV2ItemFieldNumberValue", "number": 2.5, "field": { "name": "Order" } }
              ] },
              "content": { "__typename": "Issue", "number": 12, "title": "Refund test", "url": "https://github.com/I4cTime/aibou/issues/12",
                "state": "OPEN", "closedAt": null, "repository": { "nameWithOwner": "I4cTime/aibou" },
                "parent": { "number": 20, "repository": { "nameWithOwner": "I4cTime/focus" } },
                "subIssuesSummary": { "total": 0, "completed": 0 } } }),
            json!({ "id": "PVTI_pr", "type": "PULL_REQUEST", "fieldValues": { "nodes": [ sv("Status", "Done") ] },
              "content": { "__typename": "PullRequest", "number": 5, "title": "Fix", "url": "https://github.com/I4cTime/niwa/pull/5",
                "state": "MERGED", "closedAt": "2026-10-30T10:00:00Z", "repository": { "nameWithOwner": "I4cTime/niwa" } } }),
            json!({ "id": "PVTI_draft", "type": "DRAFT_ISSUE", "fieldValues": { "nodes": [] },
              "content": { "__typename": "DraftIssue", "title": "An idea" } }),
            json!({ "id": "PVTI_hidden", "type": "REDACTED", "fieldValues": { "nodes": [] }, "content": null }),
        ]
    }

    #[test]
    fn maps_graphql_items() {
        let items: Vec<BoardItem> = item_nodes().iter().filter_map(map_item).collect();
        assert_eq!(items.len(), 3, "draft and redacted items are skipped");
        let epic = &items[0];
        assert_eq!(epic.item_id, "PVTI_epic");
        assert_eq!((epic.repo.as_str(), epic.number), ("I4cTime/focus", 20));
        assert_eq!(epic.state, "open");
        assert_eq!(epic.status.as_deref(), Some("In progress"));
        assert_eq!(epic.kind.as_deref(), Some("Epic"));
        assert_eq!(epic.area.as_deref(), Some("aibou"));
        assert_eq!(epic.started.as_deref(), Some("2026-09-29"));
        assert_eq!(epic.done_when.as_deref(), Some("On Play"));
        assert_eq!(
            epic.sub_issues,
            SubIssues {
                total: 7,
                completed: 3
            }
        );
        assert_eq!(epic.parent, None);
        assert!(!epic.is_pr);

        let task = &items[1];
        assert_eq!(task.scheduled.as_deref(), Some("2026-11-01"));
        assert_eq!(task.order, Some(2.5));
        assert_eq!(
            task.parent,
            Some(IssueRef {
                repo: "I4cTime/focus".into(),
                number: 20
            })
        );
        assert_eq!(task.area, None);

        let pr = &items[2];
        assert!(pr.is_pr);
        assert_eq!(pr.state, "closed", "merged counts as closed");
        assert_eq!(pr.closed_at.as_deref(), Some("2026-10-30T10:00:00Z"));
        assert_eq!(pr.sub_issues, SubIssues::default());

        let json = serde_json::to_value(task).unwrap();
        for key in [
            "itemId",
            "number",
            "repo",
            "title",
            "url",
            "state",
            "closedAt",
            "isPr",
            "status",
            "kind",
            "area",
            "scheduled",
            "started",
            "target",
            "order",
            "doneWhen",
            "outcome",
            "parent",
            "subIssues",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }

    /// A fake board: two pages of items, the field list, mutations and item reads.
    fn board_fake(fields: Value) -> Fake {
        Fake::new(move |args, stdin| {
            assert_eq!(&args[..2], &["api", "graphql"]);
            let body = body_of(stdin);
            let q = body["query"].as_str().unwrap();
            let vars = &body["variables"];
            if q.contains("items(first: 100") {
                let nodes = item_nodes();
                let page = if vars["after"].is_null() {
                    json!({ "pageInfo": { "hasNextPage": true, "endCursor": "C1" }, "nodes": nodes[..2].to_vec() })
                } else {
                    assert_eq!(vars["after"], "C1");
                    json!({ "pageInfo": { "hasNextPage": false, "endCursor": "C2" }, "nodes": nodes[2..].to_vec() })
                };
                ok(json!({ "data": { "node": { "fields": fields, "items": page } } }).to_string())
            } else if q.contains("updateProjectV2ItemFieldValue") {
                ok(json!({ "data": { "updateProjectV2ItemFieldValue": { "projectV2Item": { "id": vars["item"] } } } }).to_string())
            } else if q.contains("clearProjectV2ItemFieldValue") {
                ok(json!({ "data": { "clearProjectV2ItemFieldValue": { "projectV2Item": { "id": vars["item"] } } } }).to_string())
            } else if q.contains("... on ProjectV2Item") {
                let node = item_nodes()
                    .into_iter()
                    .find(|n| n["id"] == vars["id"])
                    .unwrap_or(json!(null));
                ok(json!({ "data": { "node": node } }).to_string())
            } else if q.contains("fields(first: 50)") {
                ok(json!({ "data": { "node": { "fields": fields } } }).to_string())
            } else {
                panic!("unexpected query {q}");
            }
        })
    }

    #[test]
    fn fetch_paginates_caches_and_honours_freshness() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = board_fake(fields_json(None));
        let run = |a: &[&str], s: Option<&str>| fake.run(a, s);
        let cache = Mutex::new(None);
        let ctx = Ctx {
            gh: &run,
            dir: tmp.path(),
            fields: &cache,
        };
        let now = 1_793_503_800;

        let snap = fetch(&ctx, false, now);
        assert_eq!(snap.error, None);
        assert_eq!(snap.items.len(), 3);
        assert_eq!(snap.fetched_at, "2026-11-01T03:30:00Z");
        assert_eq!(snap.areas, vec!["q-ring", "aibou"]);
        assert_eq!(fake.calls().len(), 2, "two pages");
        assert_eq!(read_cached(tmp.path()), Some(snap.clone()));
        assert!(
            cache.lock().unwrap().is_some(),
            "the field list is cached from the fetch"
        );

        // Within 60 s and not forced: no gh call.
        assert_eq!(fetch(&ctx, false, now + 30), snap);
        assert_eq!(fake.calls().len(), 2);
        // Forced: fetched again.
        fetch(&ctx, true, now + 30);
        assert_eq!(fake.calls().len(), 4);

        // A failing fetch keeps the cache and reports the error.
        let failing = |_: &[&str], _: Option<&str>| -> io::Result<GhOut> {
            Ok(GhOut {
                ok: false,
                stdout: String::new(),
                stderr: "gh: HTTP 502".into(),
            })
        };
        let ctx2 = Ctx {
            gh: &failing,
            dir: tmp.path(),
            fields: &cache,
        };
        let bad = fetch(&ctx2, true, now + 100);
        assert_eq!(bad.error.as_deref(), Some("HTTP 502"));
        assert_eq!(bad.items.len(), 3);
        assert_eq!(read_cached(tmp.path()).unwrap().error, None);

        // No gh at all, no cache: an empty snapshot with the error.
        let empty = tempfile::tempdir().unwrap();
        let missing = |_: &[&str], _: Option<&str>| -> io::Result<GhOut> {
            Err(io::Error::from(io::ErrorKind::NotFound))
        };
        let ctx3 = Ctx {
            gh: &missing,
            dir: empty.path(),
            fields: &cache,
        };
        let none = fetch(&ctx3, false, now);
        assert_eq!(none.fetched_at, "");
        assert_eq!(
            none.error.as_deref(),
            Some("gh is not installed (or not on PATH)")
        );
    }

    #[test]
    fn resolves_option_names_and_refetches_on_a_miss() {
        let tmp = tempfile::tempdir().unwrap();
        let fetches = StdMutex::new(0);
        let fake = Fake::new(move |_, stdin| {
            let q = body_of(stdin)["query"].as_str().unwrap().to_owned();
            assert!(q.contains("fields(first: 50)"));
            let mut n = fetches.lock().unwrap();
            *n += 1;
            // The second field list has a new Area option.
            let fields = fields_json(if *n >= 2 { Some("tsukue") } else { None });
            ok(json!({ "data": { "node": { "fields": fields } } }).to_string())
        });
        let run = |a: &[&str], s: Option<&str>| fake.run(a, s);
        let cache = Mutex::new(None);
        let ctx = Ctx {
            gh: &run,
            dir: tmp.path(),
            fields: &cache,
        };

        let mut fresh = false;
        let r = ctx
            .resolve("status", &json!("in progress"), &mut fresh)
            .unwrap();
        assert_eq!(
            r,
            Resolved {
                field_id: "F_STATUS".into(),
                value: Some(json!({ "singleSelectOptionId": "s-prog" }))
            }
        );
        assert!(fresh);
        assert_eq!(fake.calls().len(), 1);

        // Cached: no new call.
        let mut fresh = false;
        let r = ctx.resolve("kind", &json!("Task"), &mut fresh).unwrap();
        assert_eq!(r.value, Some(json!({ "singleSelectOptionId": "k-task" })));
        assert!(!fresh);
        assert_eq!(fake.calls().len(), 1);

        // A name the cached list lacks: refetched once, then found.
        let mut fresh = false;
        let r = ctx.resolve("area", &json!("Tsukue"), &mut fresh).unwrap();
        assert_eq!(r.value, Some(json!({ "singleSelectOptionId": "a-tsukue" })));
        assert_eq!(fake.calls().len(), 2);

        // Still missing after a fresh list: an error naming the options.
        let mut fresh = false;
        let e = ctx.resolve("area", &json!("nope"), &mut fresh).unwrap_err();
        assert!(
            e.starts_with("Area has no option \"nope\" (options: q-ring, aibou, tsukue)"),
            "{e}"
        );
        assert_eq!(fake.calls().len(), 3);

        // Other types, clears and bad values.
        let mut fresh = false;
        assert_eq!(
            ctx.resolve("scheduled", &Value::Null, &mut fresh).unwrap(),
            Resolved {
                field_id: "F_SCHED".into(),
                value: None
            }
        );
        assert_eq!(
            ctx.resolve("scheduled", &json!("2026-11-03"), &mut fresh)
                .unwrap()
                .value,
            Some(json!({ "date": "2026-11-03" }))
        );
        assert!(
            ctx.resolve("scheduled", &json!("tomorrow"), &mut fresh)
                .is_err()
        );
        assert_eq!(
            ctx.resolve("order", &json!(3), &mut fresh).unwrap().value,
            Some(json!({ "number": 3.0 }))
        );
        assert_eq!(
            ctx.resolve("order", &json!("1.5"), &mut fresh)
                .unwrap()
                .value,
            Some(json!({ "number": 1.5 }))
        );
        assert_eq!(
            ctx.resolve("doneWhen", &json!("  "), &mut fresh)
                .unwrap()
                .value,
            None
        );
        assert_eq!(
            ctx.resolve("doneWhen", &json!("Shipped"), &mut fresh)
                .unwrap()
                .value,
            Some(json!({ "text": "Shipped" }))
        );
        assert_eq!(
            ctx.resolve("status", &json!(""), &mut fresh).unwrap().value,
            None
        );
        assert!(
            ctx.resolve("bogus", &json!("x"), &mut fresh)
                .unwrap_err()
                .contains("unknown board field")
        );
    }

    #[test]
    fn set_field_writes_reads_back_and_updates_the_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = board_fake(fields_json(None));
        let run = |a: &[&str], s: Option<&str>| fake.run(a, s);
        let cache = Mutex::new(None);
        let ctx = Ctx {
            gh: &run,
            dir: tmp.path(),
            fields: &cache,
        };
        fetch(&ctx, true, 1_793_503_800);
        let before = fake.calls().len();

        let item = set_field(&ctx, "PVTI_task", "status", &json!("Done")).unwrap();
        assert_eq!(item.item_id, "PVTI_task");
        let calls = fake.calls();
        assert_eq!(
            calls.len(),
            before + 2,
            "mutation + read back, field ids from the fetch"
        );
        let m = body_of(calls[before].1.as_deref());
        assert!(
            m["query"]
                .as_str()
                .unwrap()
                .contains("updateProjectV2ItemFieldValue")
        );
        assert_eq!(m["variables"]["project"], PROJECT_ID);
        assert_eq!(m["variables"]["item"], "PVTI_task");
        assert_eq!(m["variables"]["field"], "F_STATUS");
        assert_eq!(
            m["variables"]["value"],
            json!({ "singleSelectOptionId": "s-done" })
        );

        set_field(&ctx, "PVTI_task", "scheduled", &Value::Null).unwrap();
        let m = body_of(fake.calls()[before + 2].1.as_deref());
        assert!(
            m["query"]
                .as_str()
                .unwrap()
                .contains("clearProjectV2ItemFieldValue")
        );
        assert_eq!(m["variables"]["field"], "F_SCHED");
        assert_eq!(read_cached(tmp.path()).unwrap().items.len(), 3);
    }

    #[test]
    fn a_failed_write_refreshes_ids_and_retries_once() {
        let tmp = tempfile::tempdir().unwrap();
        let writes = StdMutex::new(Vec::<String>::new());
        let fake = Fake::new(move |_, stdin| {
            let body = body_of(stdin);
            let q = body["query"].as_str().unwrap();
            if q.contains("updateProjectV2ItemFieldValue") {
                let field = body["variables"]["field"].as_str().unwrap().to_owned();
                writes.lock().unwrap().push(field.clone());
                if field == "F_OLD" {
                    return GhOut { ok: false, stdout: json!({ "data": null, "errors": [{ "message": "Could not resolve to a node" }] }).to_string(), stderr: "gh: Could not resolve".into() };
                }
                ok(json!({ "data": { "updateProjectV2ItemFieldValue": { "projectV2Item": { "id": "I" } } } }).to_string())
            } else {
                ok(json!({ "data": { "node": { "fields": fields_json(None) } } }).to_string())
            }
        });
        let run = |a: &[&str], s: Option<&str>| fake.run(a, s);
        // A stale cached list: Status has an old id.
        let mut stale = parse_fields(&fields_json(None));
        stale[1].id = "F_OLD".into();
        let cache = Mutex::new(Some(stale));
        let ctx = Ctx {
            gh: &run,
            dir: tmp.path(),
            fields: &cache,
        };
        ctx.set_value("I", "status", &json!("Ready")).unwrap();
        assert_eq!(
            fake.calls().len(),
            3,
            "failed write, field list, retried write"
        );
    }

    #[test]
    fn create_task_runs_the_expected_gh_calls() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Fake::new(|args, stdin| {
            if args[0] == "issue" {
                return ok(
                    "Creating issue in I4cTime/aibou\n\nhttps://github.com/I4cTime/aibou/issues/12\n",
                );
            }
            if args[0] == "project" {
                return ok(r#"{"id":"PVTI_task","title":"Refund test"}"#);
            }
            let body = body_of(stdin);
            let q = body["query"].as_str().unwrap();
            let v = &body["variables"];
            if q.contains("parent: repository") {
                assert_eq!(
                    (v["po"].as_str(), v["pn"].as_str(), v["pi"].as_u64()),
                    (Some("I4cTime"), Some("focus"), Some(20))
                );
                assert_eq!(
                    (v["co"].as_str(), v["cn"].as_str(), v["ci"].as_u64()),
                    (Some("I4cTime"), Some("aibou"), Some(12))
                );
                return ok(json!({ "data": { "parent": { "issue": { "id": "I_epic" } }, "child": { "issue": { "id": "I_new" } } } }).to_string());
            }
            if q.contains("addSubIssue") {
                assert_eq!(v["parent"], "I_epic");
                assert_eq!(v["child"], "I_new");
                return ok(
                    json!({ "data": { "addSubIssue": { "issue": { "id": "I_epic" } } } })
                        .to_string(),
                );
            }
            if q.contains("fields(first: 50)") {
                return ok(
                    json!({ "data": { "node": { "fields": fields_json(None) } } }).to_string(),
                );
            }
            if q.contains("updateProjectV2ItemFieldValue") {
                return ok(json!({ "data": { "updateProjectV2ItemFieldValue": { "projectV2Item": { "id": "PVTI_task" } } } }).to_string());
            }
            if q.contains("... on ProjectV2Item") {
                return ok(json!({ "data": { "node": item_nodes()[1] } }).to_string());
            }
            panic!("unexpected {args:?} {q}");
        });
        let run = |a: &[&str], s: Option<&str>| fake.run(a, s);
        let cache = Mutex::new(None);
        let ctx = Ctx {
            gh: &run,
            dir: tmp.path(),
            fields: &cache,
        };
        let t = NewTask {
            repo: "I4cTime/aibou".into(),
            title: "--Refund test".into(),
            body: String::new(),
            epic: Some(IssueRef {
                repo: "I4cTime/focus".into(),
                number: 20,
            }),
            scheduled: Some("2026-11-01".into()),
        };
        let item = create_task(&ctx, &t).unwrap();
        assert_eq!(item.number, 12);
        let calls = fake.calls();
        assert_eq!(
            calls[0].0,
            [
                "issue",
                "create",
                "--repo=I4cTime/aibou",
                "--title=--Refund test",
                "--body="
            ]
        );
        assert_eq!(
            calls[3].0,
            [
                "project",
                "item-add",
                "3",
                "--owner",
                "I4cTime",
                "--url",
                "https://github.com/I4cTime/aibou/issues/12",
                "--format",
                "json"
            ]
        );
        let values: Vec<Value> = calls
            .iter()
            .filter_map(|(_, s)| s.as_deref())
            .map(|s| body_of(Some(s)))
            .filter(|b| {
                b["query"]
                    .as_str()
                    .unwrap()
                    .contains("updateProjectV2ItemFieldValue")
            })
            .map(|b| b["variables"]["value"].clone())
            .collect();
        assert_eq!(
            values,
            vec![
                json!({ "singleSelectOptionId": "k-task" }),
                json!({ "date": "2026-11-01" })
            ]
        );

        // Validation happens before any gh call.
        let before = fake.calls().len();
        assert!(
            create_task(
                &ctx,
                &NewTask {
                    repo: "aibou".into(),
                    title: "x".into(),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            create_task(
                &ctx,
                &NewTask {
                    repo: "I4cTime/aibou".into(),
                    title: " ".into(),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            create_task(
                &ctx,
                &NewTask {
                    repo: "I4cTime/aibou".into(),
                    title: "x".into(),
                    scheduled: Some("soon".into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert_eq!(fake.calls().len(), before);
    }

    #[test]
    fn create_epic_goes_to_the_hub_and_reports_partial_failures() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Fake::new(|args, _| {
            if args[0] == "issue" {
                return ok("https://github.com/I4cTime/focus/issues/31\n");
            }
            GhOut {
                ok: false,
                stdout: String::new(),
                stderr: "gh: missing project scope".into(),
            }
        });
        let run = |a: &[&str], s: Option<&str>| fake.run(a, s);
        let cache = Mutex::new(None);
        let ctx = Ctx {
            gh: &run,
            dir: tmp.path(),
            fields: &cache,
        };
        let e = create_epic(
            &ctx,
            &NewEpic {
                title: "Tsukue board".into(),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(
            e,
            "created https://github.com/I4cTime/focus/issues/31, but adding it to the board failed: missing project scope"
        );
        assert_eq!(fake.calls()[0].0[2], "--repo=I4cTime/focus");
    }

    #[test]
    fn gh_children_lose_github_token() {
        let cmd = gh_command(Path::new("gh"), &["auth", "status"]);
        let envs: Vec<_> = cmd.get_envs().collect();
        assert!(
            envs.contains(&(std::ffi::OsStr::new("GITHUB_TOKEN"), None)),
            "{envs:?}"
        );
        assert!(envs.contains(&(
            std::ffi::OsStr::new("GH_PROMPT_DISABLED"),
            Some(std::ffi::OsStr::new("1"))
        )));
    }

    #[test]
    fn parses_auth_status() {
        let text = "github.com\n  \u{2713} Logged in to github.com account I4cTime (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_****\n  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'\n";
        let s = parse_auth_status(text, true);
        assert_eq!(
            s,
            GhStatus {
                available: true,
                login: Some("I4cTime".into()),
                scopes: vec![
                    "gist".into(),
                    "project".into(),
                    "read:org".into(),
                    "repo".into(),
                    "workflow".into()
                ],
                error: None,
            }
        );
        let s = parse_auth_status(
            "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
            false,
        );
        assert!(!s.available);
        assert_eq!(
            s.error.as_deref(),
            Some("You are not logged into any GitHub hosts. To log in, run: gh auth login")
        );
        assert!(!serde_json::to_string(&s).unwrap().contains("gho_"));
    }

    // ---- schedule and SCHEDULE.md --------------------------------------

    fn plan(area: Option<&str>, note: &str) -> DayPlan {
        DayPlan {
            area: area.map(str::to_owned),
            note: note.into(),
        }
    }

    fn sample_schedule() -> Schedule {
        let mut s = Schedule::default();
        s.rhythm.mon = plan(Some("aibou"), "Play console");
        s.rhythm.wed = plan(Some("shiori"), "");
        s.rhythm.sun = plan(Some("niwa"), "");
        s.overrides.insert(
            "2026-11-01".into(),
            plan(Some("tsukue"), "Board \u{2014} calendar"),
        );
        s.overrides.insert("2026-10-28".into(), plan(None, ""));
        s
    }

    fn sample_board() -> BoardSnapshot {
        let mut items: Vec<BoardItem> = item_nodes().iter().filter_map(map_item).collect();
        let mut later = items[1].clone();
        later.item_id = "PVTI_later".into();
        later.number = 13;
        later.title = "Landing for Play".into();
        later.scheduled = Some("2026-11-10".into());
        let mut far = later.clone();
        far.item_id = "PVTI_far".into();
        far.number = 14;
        far.scheduled = Some("2026-12-25".into());
        let mut loose = later.clone();
        loose.item_id = "PVTI_loose".into();
        loose.number = 15;
        loose.title = "Pairing on two devices".into();
        loose.scheduled = None;
        loose.status = Some("In progress".into());
        loose.parent = Some(IssueRef {
            repo: "I4cTime/focus".into(),
            number: 99,
        });
        items.extend([later, far, loose]);
        BoardSnapshot {
            fetched_at: "2026-11-01T03:30:00Z".into(),
            items,
            error: None,
            areas: vec![],
        }
    }

    #[test]
    fn renders_schedule_md_on_a_fixed_date() {
        let md = render_schedule_md(Some(&sample_board()), &sample_schedule(), d("2026-11-01"));
        let expected_start = "# Schedule\n\
Generated by Tsukue (Calendar panel) from the I4C board and the weekly rhythm; edit there, this file is overwritten. Board: https://github.com/users/I4cTime/projects/3\n\
\n\
## Today: 2026-11-01 Sunday\n\
\n\
Area: tsukue\n\
Note: Board - calendar\n\
- I4cTime/aibou#12 Refund test (Ready; epic I4cTime/focus#20 Aibou - pet care)\n\
\n\
## This week: 2026-10-26 Monday to 2026-11-01 Sunday\n\
\n\
### 2026-10-26 Monday\n\
Area: aibou\n\
\n\
### 2026-10-27 Tuesday\n\
nothing scheduled\n\
\n\
### 2026-10-28 Wednesday\n\
nothing scheduled\n";
        assert!(md.starts_with(expected_start), "{md}");
        assert!(md.contains("### 2026-11-01 Sunday (today)\nArea: tsukue\nNote: Board - calendar\n- I4cTime/aibou#12"), "{md}");
        assert!(md.contains("## Coming up (next 30 days)\n\n### 2026-11-10 Tuesday\n- I4cTime/aibou#13 Landing for Play (Ready; epic I4cTime/focus#20 Aibou - pet care)\n"), "{md}");
        assert!(!md.contains("2026-12-25"), "beyond 30 days");
        assert!(
            md.contains("| Monday | aibou | Play console |\n| Tuesday | none | - |"),
            "{md}"
        );
        assert!(md.contains("| Sunday | niwa | - |"));
        assert!(md.ends_with("## Unscheduled\n\nOpen tasks in Ready or In progress without a date (propose one):\n- I4cTime/aibou#15 Pairing on two devices (In progress; epic I4cTime/focus#99)\n"), "{md}");
        assert!(!md.contains('\u{2014}') && !md.contains('\u{2013}'));

        // No board yet, nothing planned.
        let md = render_schedule_md(None, &Schedule::default(), d("2026-12-30"));
        assert!(
            md.contains("## Today: 2026-12-30 Wednesday\n\nArea: none\nNothing scheduled.\n"),
            "{md}"
        );
        assert!(md.contains("## This week: 2026-12-28 Monday to 2027-01-03 Sunday"));
        assert!(md.contains("Nothing dated after this week."));
        assert!(md.contains("- none\n"));
    }

    #[test]
    fn schedule_round_trip_and_sanitize() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(read_schedule(tmp.path()).unwrap(), Schedule::default());
        let mut s = sample_schedule();
        s.rhythm.tue = plan(Some("  "), "  two\n lines ");
        s.overrides.insert("not a date".into(), plan(Some("x"), ""));
        let saved = write_schedule(tmp.path(), s).unwrap();
        assert_eq!(saved.rhythm.tue, plan(None, "two lines"));
        assert!(!saved.overrides.contains_key("not a date"));
        assert_eq!(read_schedule(tmp.path()).unwrap(), saved);
        // An override wins (also one that clears the area).
        assert_eq!(saved.plan(d("2026-10-28")), (None, None, false));
        assert_eq!(saved.plan(d("2026-11-04")), (Some("shiori"), None, true));
        fs::write(tmp.path().join("schedule.json"), "{ broken").unwrap();
        assert!(read_schedule(tmp.path()).is_err());
        fs::write(
            tmp.path().join("schedule.json"),
            r#"{"rhythm":{"fri":{"area":"cryo"}}}"#,
        )
        .unwrap();
        assert_eq!(
            read_schedule(tmp.path()).unwrap().rhythm.fri,
            plan(Some("cryo"), "")
        );
    }

    #[test]
    fn schedule_md_and_claude_md_import() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("CLAUDE.md"),
            "# Develop workspace\n\nEvery project ... @PROJECTS.md\n",
        )
        .unwrap();
        write_schedule(data.path(), sample_schedule()).unwrap();
        let path = render_into(data.path(), root.path(), d("2026-11-01")).unwrap();
        assert_eq!(path, root.path().join("SCHEDULE.md"));
        assert!(fs::read_to_string(&path).unwrap().contains("Area: tsukue"));
        let claude = fs::read_to_string(root.path().join("CLAUDE.md")).unwrap();
        assert_eq!(
            claude,
            "# Develop workspace\n\nEvery project ... @PROJECTS.md\n\nSchedule: @SCHEDULE.md\n"
        );

        // Removed by hand: it stays removed.
        fs::write(root.path().join("CLAUDE.md"), "# Develop workspace\n").unwrap();
        render_into(data.path(), root.path(), d("2026-11-02")).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("CLAUDE.md")).unwrap(),
            "# Develop workspace\n"
        );

        // A root without CLAUDE.md gets none, and is retried later.
        let bare = tempfile::tempdir().unwrap();
        assert!(!ensure_schedule_import(data.path(), bare.path()).unwrap());
        assert!(!bare.path().join("CLAUDE.md").exists());
        fs::write(bare.path().join("CLAUDE.md"), "x").unwrap();
        assert!(ensure_schedule_import(data.path(), bare.path()).unwrap());
        assert_eq!(
            fs::read_to_string(bare.path().join("CLAUDE.md")).unwrap(),
            "x\n\nSchedule: @SCHEDULE.md\n"
        );
        assert_eq!(amended_schedule_import("a @SCHEDULE.md b"), None);
        assert_eq!(
            amended_schedule_import("").as_deref(),
            Some("Schedule: @SCHEDULE.md\n")
        );
    }

    #[test]
    fn workspace_roots_from_prefs() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        // No prefs, no ~/Develop: nothing.
        assert_eq!(first_workspace_root(data.path(), Some(home.path())), None);
        fs::create_dir(home.path().join("Develop")).unwrap();
        assert_eq!(
            first_workspace_root(data.path(), Some(home.path())),
            Some(home.path().join("Develop"))
        );
        // Explicit roots: the first existing one, trailing slash dropped.
        let other = tempfile::tempdir().unwrap();
        let prefs = json!({ "workspaceRoots": ["/does/not/exist", format!("{}/", other.path().display()), "relative"] });
        fs::write(data.path().join("prefs.json"), prefs.to_string()).unwrap();
        assert_eq!(
            first_workspace_root(data.path(), Some(home.path())),
            Some(other.path().to_path_buf())
        );
        // An explicit empty list stays empty.
        fs::write(data.path().join("prefs.json"), r#"{"workspaceRoots":[]}"#).unwrap();
        assert_eq!(first_workspace_root(data.path(), Some(home.path())), None);
    }

    #[test]
    fn activity_buckets_by_local_day_and_project() {
        let tmp = tempfile::tempdir().unwrap();
        let history = tmp.path().join("history.jsonl");
        let ms = |s: &str| parse_iso_utc(s).unwrap() * 1000;
        let lines = [
            json!({ "display": "a", "timestamp": ms("2026-11-01T03:30:00Z"), "project": "/dev/products/aibou", "sessionId": "s" }),
            json!({ "display": "b", "timestamp": ms("2026-11-01T06:00:00Z"), "project": "/dev/products/aibou/web/src", "sessionId": "s" }),
            json!({ "display": "c", "timestamp": ms("2026-11-01T12:00:00Z"), "project": "/dev/sites/i4c/apps/qring", "sessionId": "t" }),
            json!({ "display": "d", "timestamp": ms("2026-11-01T12:00:00Z"), "project": "/elsewhere/", "sessionId": "t" }),
            json!({ "display": "e", "timestamp": ms("2026-11-03T12:00:00Z"), "project": "/dev/products/aibou", "sessionId": "t" }),
            json!({ "display": "no project", "timestamp": ms("2026-11-01T12:00:00Z") }),
        ];
        let text: Vec<String> = lines
            .iter()
            .map(Value::to_string)
            .chain(["garbage".to_owned()])
            .collect();
        fs::write(&history, text.join("\n")).unwrap();
        let projects = vec![
            (PathBuf::from("/dev/products/aibou"), None),
            (PathBuf::from("/dev/sites/i4c"), None),
            (
                PathBuf::from("/real/qring"),
                Some(PathBuf::from("/dev/sites/i4c/apps/qring")),
            ),
        ];
        // Local time = UTC-5: 03:30Z on the 1st is still the 31st.
        let to_day = |ms: i64| (ms / 1000 - 5 * 3600).div_euclid(86_400);
        let days =
            activity_between("2026-10-31", "2026-11-02", &history, &projects, &to_day).unwrap();
        assert_eq!(days.len(), 3);
        assert_eq!(days[0].date, "2026-10-31");
        assert_eq!(
            days[0].projects,
            BTreeMap::from([("/dev/products/aibou".to_owned(), 1)])
        );
        assert_eq!(
            days[1].projects,
            BTreeMap::from([
                ("/dev/products/aibou".to_owned(), 1),
                ("/real/qring".to_owned(), 1),
                ("/elsewhere".to_owned(), 1),
            ])
        );
        assert!(days[2].projects.is_empty(), "the 3rd is outside the range");
        assert!(
            activity_between("2026-11-02", "2026-11-01", &history, &projects, &to_day).is_err()
        );
        assert!(
            activity_between("2025-01-01", "2026-11-01", &history, &projects, &to_day).is_err()
        );
    }

    /// Reads the real board through the real gh (read only). Run by hand:
    /// `cargo test live_board_read -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_board_read() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = Mutex::new(None);
        let ctx = Ctx {
            gh: &real_gh,
            dir: tmp.path(),
            fields: &cache,
        };
        println!("{:?}", status_with(&real_gh));
        let snap = fetch(&ctx, true, now_secs());
        assert_eq!(snap.error, None);
        println!("{} items, areas {:?}", snap.items.len(), snap.areas);
        let epics = snap.items.iter().filter(|i| i.is_epic()).count();
        println!("{epics} epics; first: {:?}", snap.items.first());
        let md = render_schedule_md(Some(&snap), &Schedule::default(), local_today());
        println!("{md}");
    }
}
