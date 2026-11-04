//! Omarchy themes (CONTRACT.md "Themes").
//!
//! Read side: `theme_omarchy` returns the live desktop theme, the name from
//! `~/.local/state/omarchy/current/theme.name` and the palette from
//! `current/theme/colors.toml`, or None when either file is missing. The
//! palette is the raw string values of that flat TOML (`parse_flat_toml`).
//! `start` runs a watcher thread that stats both files every 2 s and emits
//! `theme:omarchy` with the same payload whenever either changed (mtime, inode
//! or existence). `omarchy theme set` swaps the theme directory with one `mv`,
//! so a read never sees a half-written file.
//!
//! Write side: `theme_export_omarchy` turns a Kansei palette into an Omarchy
//! theme at `~/.config/omarchy/themes/<slug>/` (`colors.toml` from
//! `render_colors_toml`, plus `backgrounds/` seeded with the current
//! wallpaper when empty) and, with `apply`, runs `omarchy theme set <slug>`
//! detached.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// How often the watcher stats the two files.
const POLL: Duration = Duration::from_secs(2);

/// The key order of Omarchy's own `colors.toml`; other keys follow alphabetically.
const KEY_ORDER: [&str; 25] = [
    "accent",
    "selection",
    "muted",
    "background",
    "dark_background",
    "darker_background",
    "lighter_background",
    "foreground",
    "dark_foreground",
    "light_foreground",
    "bright_foreground",
    "red",
    "yellow",
    "orange",
    "green",
    "cyan",
    "blue",
    "magenta",
    "brown",
    "bright_red",
    "bright_yellow",
    "bright_green",
    "bright_cyan",
    "bright_blue",
    "bright_magenta",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmarchyTheme {
    pub name: String,
    pub palette: BTreeMap<String, String>,
}

// ---------------------------------------------------------------------------
// Flat TOML
// ---------------------------------------------------------------------------

/// `key = "value"` lines of a flat TOML file. `#` starts a comment (a whole
/// line, or after the closing quote); whitespace is free; only basic quoted
/// strings count (`\"` and `\\` unescaped), so numbers, booleans, arrays,
/// tables and literal strings are skipped. Keys are kept as written.
pub fn parse_flat_toml(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let Some((key, rest)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || key.contains(char::is_whitespace) {
            continue;
        }
        let Some(body) = rest.trim_start().strip_prefix('"') else {
            continue;
        };
        if let Some((value, tail)) = quoted(body) {
            let tail = tail.trim_start();
            if tail.is_empty() || tail.starts_with('#') {
                out.insert(key.to_string(), value);
            }
        }
    }
    out
}

/// The string up to the closing quote and what follows it; None when unclosed.
fn quoted(body: &str) -> Option<(String, &str)> {
    let mut value = String::new();
    let mut chars = body.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((value, &body[i + 1..])),
            '\\' => match chars.next()?.1 {
                'n' => value.push('\n'),
                't' => value.push('\t'),
                other => value.push(other),
            },
            c => value.push(c),
        }
    }
    None
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// A TOML bare key, the only kind `render_colors_toml` writes.
fn bare_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

// ---------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------

/// `~/.local/state/omarchy/current` (XDG state dir when set).
fn omarchy_current() -> Result<PathBuf, String> {
    let state = match dirs::state_dir() {
        Some(d) => d,
        None => crate::files::home_dir()?.join(".local/state"),
    };
    Ok(state.join("omarchy").join("current"))
}

fn name_file(current: &Path) -> PathBuf {
    current.join("theme.name")
}

fn colors_file(current: &Path) -> PathBuf {
    current.join("theme").join("colors.toml")
}

/// The live theme under an Omarchy `current` dir; None when a file is missing.
fn read_theme(current: &Path) -> Result<Option<OmarchyTheme>, String> {
    let read = |p: PathBuf| match fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", p.display())),
    };
    let Some(name) = read(name_file(current))? else {
        return Ok(None);
    };
    let Some(colors) = read(colors_file(current))? else {
        return Ok(None);
    };
    Ok(Some(OmarchyTheme {
        name: name.trim().to_string(),
        palette: parse_flat_toml(&colors),
    }))
}

#[tauri::command]
pub fn theme_omarchy() -> Result<Option<OmarchyTheme>, String> {
    read_theme(&omarchy_current()?)
}

/// What the watcher compares between polls: existence, mtime and inode.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp(Option<(Option<SystemTime>, u64)>);

fn stamp(path: &Path) -> Stamp {
    Stamp(fs::metadata(path).ok().map(|m| {
        #[cfg(unix)]
        let ino = std::os::unix::fs::MetadataExt::ino(&m);
        #[cfg(not(unix))]
        let ino = 0;
        (m.modified().ok(), ino)
    }))
}

fn stamps(current: &Path) -> (Stamp, Stamp) {
    (stamp(&name_file(current)), stamp(&colors_file(current)))
}

/// Watch the live Omarchy theme; emits `theme:omarchy` on every change after
/// the first poll. The payload is what `theme_omarchy` would return (None on
/// a read error too, so the front end falls back instead of keeping stale colours).
pub fn start(app: &AppHandle) {
    let Ok(current) = omarchy_current() else {
        return;
    };
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("theme-watch".into())
        .spawn(move || {
            let mut last = stamps(&current);
            loop {
                thread::sleep(POLL);
                let now = stamps(&current);
                if now == last {
                    continue;
                }
                last = now;
                let payload = read_theme(&current).unwrap_or(None);
                if let Err(e) = app.emit("theme:omarchy", payload) {
                    crate::watchdog::note(&format!("theme: emit failed: {e}"));
                }
            }
        });
    if let Err(e) = spawned {
        crate::watchdog::note(&format!("theme: could not start watcher: {e}"));
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// `rrggbb` of a `#rrggbb` palette value.
fn hex(value: &str) -> &str {
    value.trim().trim_start_matches('#')
}

/// An Omarchy `colors.toml` for `palette`, dated `date` (`YYYY-MM-DD`).
fn render_colors_toml_on(name: &str, palette: &BTreeMap<String, String>, date: &str) -> String {
    let one_line = name.replace(['\n', '\r'], " ");
    let mode = palette.get("mode").map(String::as_str).unwrap_or("dark");
    let mut out = format!(
        "# {}, exported from Kansei {date}\nmode = \"{}\"\n\n",
        one_line.trim(),
        escape(mode)
    );
    let skip = |k: &str| {
        k == "mode" || k == "hyprland_active_border" || k == "hyprland_inactive_border"
    };
    let mut keys: Vec<&String> = palette
        .keys()
        .filter(|k| !skip(k) && bare_key(k))
        .collect();
    keys.sort_by_key(|k| {
        let rank = KEY_ORDER.iter().position(|o| o == k).unwrap_or(KEY_ORDER.len());
        (rank, k.as_str())
    });
    for k in keys {
        out.push_str(&format!("{k} = \"{}\"\n", escape(&palette[k])));
    }
    if let (Some(accent), Some(cyan)) = (palette.get("accent"), palette.get("cyan")) {
        out.push_str(&format!(
            "hyprland_active_border = \"rgba({}ee) rgba({}ee) 45deg\"\n",
            escape(hex(accent)),
            escape(hex(cyan))
        ));
    }
    if let Some(muted) = palette.get("muted") {
        out.push_str(&format!(
            "hyprland_inactive_border = \"rgba({}aa)\"\n",
            escape(hex(muted))
        ));
    }
    out
}

/// An Omarchy `colors.toml` for `palette`, dated today (local).
pub fn render_colors_toml(name: &str, palette: &BTreeMap<String, String>) -> String {
    let today = crate::board::format_date(crate::board::local_today());
    render_colors_toml_on(name, palette, &today)
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Write `<themes_root>/<slug>/colors.toml` and seed `backgrounds/` from the
/// wallpaper `<current>/background` links to. Returns the theme dir.
fn export_theme(
    themes_root: &Path,
    current: &Path,
    slug: &str,
    name: &str,
    palette: &BTreeMap<String, String>,
) -> Result<PathBuf, String> {
    if !valid_slug(slug) {
        return Err(format!("invalid theme slug {slug:?} (use a-z, 0-9 and -)"));
    }
    let dir = themes_root.join(slug);
    let colors = dir.join("colors.toml");
    crate::files::atomic_write(&colors, render_colors_toml(name, palette).as_bytes(), None)
        .map_err(|e| format!("{}: {e}", colors.display()))?;
    let backgrounds = dir.join("backgrounds");
    fs::create_dir_all(&backgrounds).map_err(|e| format!("{}: {e}", backgrounds.display()))?;
    let empty = fs::read_dir(&backgrounds)
        .map(|mut it| it.next().is_none())
        .unwrap_or(false);
    if empty {
        // Missing or dangling wallpaper link: the theme simply ships without one.
        if let Ok(src) = fs::canonicalize(current.join("background"))
            && src.is_file()
            && let Some(file) = src.file_name()
        {
            let dest = backgrounds.join(file);
            fs::copy(&src, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
        }
    }
    Ok(dir)
}

#[tauri::command]
pub fn theme_export_omarchy(
    slug: String,
    name: String,
    palette: BTreeMap<String, String>,
    apply: bool,
) -> Result<String, String> {
    let themes_root = crate::files::home_dir()?.join(".config/omarchy/themes");
    let dir = export_theme(&themes_root, &omarchy_current()?, &slug, &name, &palette)?;
    if apply {
        let mut child = Command::new("omarchy")
            .args(["theme", "set", &slug])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("wrote {} but could not run omarchy: {e}", dir.display()))?;
        // Reap it off-thread so the finished process does not linger as a zombie.
        thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn parses_flat_toml() {
        let text = r##"
# Fallout - a full-line comment
mode = "dark"
  accent="#3cf07c"
background   =   "#0b1a10"   # trailing comment
hash = "#abc # not a comment"
quote = "say \"hi\""
size = 12
bold = true
list = ["#000000"]
literal = '#ffffff'
[table]
unclosed = "#123456
junk = "#111111" extra
spaced key = "#222222"
"##;
        let got = parse_flat_toml(text);
        assert_eq!(
            got,
            map(&[
                ("mode", "dark"),
                ("accent", "#3cf07c"),
                ("background", "#0b1a10"),
                ("hash", "#abc # not a comment"),
                ("quote", "say \"hi\""),
            ])
        );
    }

    #[test]
    fn read_theme_missing_files_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path();
        assert_eq!(read_theme(current).unwrap(), None);
        fs::write(current.join("theme.name"), "fallout\n").unwrap();
        assert_eq!(read_theme(current).unwrap(), None);
        fs::remove_file(current.join("theme.name")).unwrap();
        fs::create_dir_all(current.join("theme")).unwrap();
        fs::write(current.join("theme/colors.toml"), "accent = \"#000000\"\n").unwrap();
        assert_eq!(read_theme(current).unwrap(), None);
    }

    #[test]
    fn read_theme_happy_path() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path();
        fs::write(current.join("theme.name"), "  fallout \n").unwrap();
        fs::create_dir_all(current.join("theme")).unwrap();
        fs::write(
            current.join("theme/colors.toml"),
            "# x\nmode = \"dark\"\naccent = \"#3cf07c\" # green\nopacity = 0.9\n",
        )
        .unwrap();
        let got = read_theme(current).unwrap().unwrap();
        assert_eq!(got.name, "fallout");
        assert_eq!(got.palette, map(&[("mode", "dark"), ("accent", "#3cf07c")]));
        let json = serde_json::to_value(&got).unwrap();
        assert_eq!(json["name"], "fallout");
        assert_eq!(json["palette"]["accent"], "#3cf07c");
    }

    #[test]
    fn stamps_change_when_files_appear_change_or_vanish() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path();
        let empty = stamps(current);
        fs::write(current.join("theme.name"), "a").unwrap();
        let named = stamps(current);
        assert_ne!(empty, named);
        // A swapped file (new inode) differs even within the same mtime tick.
        let next = current.join("theme.name.next");
        fs::write(&next, "b").unwrap();
        fs::rename(&next, current.join("theme.name")).unwrap();
        assert_ne!(named, stamps(current));
        fs::remove_file(current.join("theme.name")).unwrap();
        assert_eq!(empty, stamps(current));
    }

    #[test]
    fn renders_colors_toml_in_omarchy_order() {
        let palette = map(&[
            ("zeta", "#000001"),
            ("bright_magenta", "#e5b3ff"),
            ("red", "#ff5c4d"),
            ("background", "#0b1a10"),
            ("cyan", "#5fe3c9"),
            ("accent", "#3cf07c"),
            ("muted", "#2f6a40"),
            ("mode", "light"),
            ("alpha", "#000002"),
            ("hyprland_active_border", "stale"),
        ]);
        let got = render_colors_toml_on("Night City", &palette, "2026-11-03");
        assert_eq!(
            got,
            "# Night City, exported from Kansei 2026-11-03\n\
             mode = \"light\"\n\
             \n\
             accent = \"#3cf07c\"\n\
             muted = \"#2f6a40\"\n\
             background = \"#0b1a10\"\n\
             red = \"#ff5c4d\"\n\
             cyan = \"#5fe3c9\"\n\
             bright_magenta = \"#e5b3ff\"\n\
             alpha = \"#000002\"\n\
             zeta = \"#000001\"\n\
             hyprland_active_border = \"rgba(3cf07cee) rgba(5fe3c9ee) 45deg\"\n\
             hyprland_inactive_border = \"rgba(2f6a40aa)\"\n"
        );
        // Round trip through the parser.
        let back = parse_flat_toml(&got);
        assert_eq!(back["accent"], "#3cf07c");
        assert_eq!(back["mode"], "light");
    }

    #[test]
    fn render_defaults_mode_and_skips_missing_border_keys() {
        let got = render_colors_toml_on("X", &map(&[("background", "#000000")]), "2026-01-02");
        assert!(got.starts_with("# X, exported from Kansei 2026-01-02\nmode = \"dark\"\n\n"));
        assert!(!got.contains("hyprland_"));
        let only_accent = render_colors_toml_on("X", &map(&[("accent", "#111111")]), "d");
        assert!(!only_accent.contains("hyprland_active_border"));
        assert!(!only_accent.contains("hyprland_inactive_border"));
    }

    #[test]
    fn export_writes_colors_and_copies_background() {
        let tmp = tempfile::tempdir().unwrap();
        let themes = tmp.path().join("themes");
        let current = tmp.path().join("current");
        let walls = tmp.path().join("walls");
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&walls).unwrap();
        fs::write(walls.join("1-city.png"), b"png").unwrap();
        std::os::unix::fs::symlink(walls.join("1-city.png"), current.join("background")).unwrap();

        let palette = map(&[("accent", "#ff2a6d"), ("cyan", "#05d9e8"), ("muted", "#3b2f5c")]);
        let dir = export_theme(&themes, &current, "kansei-night-city", "Night City", &palette)
            .unwrap();
        assert_eq!(dir, themes.join("kansei-night-city"));
        let colors = fs::read_to_string(dir.join("colors.toml")).unwrap();
        assert!(colors.starts_with("# Night City, exported from Kansei "));
        assert!(colors.contains("accent = \"#ff2a6d\"\n"));
        assert!(colors.contains("hyprland_active_border = \"rgba(ff2a6dee) rgba(05d9e8ee) 45deg\""));
        assert_eq!(fs::read(dir.join("backgrounds/1-city.png")).unwrap(), b"png");

        // A second export overwrites colors.toml and leaves a non-empty backgrounds/ alone.
        fs::write(walls.join("2-other.png"), b"other").unwrap();
        fs::remove_file(current.join("background")).unwrap();
        std::os::unix::fs::symlink(walls.join("2-other.png"), current.join("background")).unwrap();
        let palette2 = map(&[("accent", "#000000")]);
        export_theme(&themes, &current, "kansei-night-city", "Night City", &palette2).unwrap();
        let colors = fs::read_to_string(dir.join("colors.toml")).unwrap();
        assert!(colors.contains("accent = \"#000000\""));
        assert!(!dir.join("backgrounds/2-other.png").exists());
    }

    #[test]
    fn export_without_wallpaper_still_writes_the_theme() {
        let tmp = tempfile::tempdir().unwrap();
        let themes = tmp.path().join("themes");
        let current = tmp.path().join("current");
        let dir = export_theme(&themes, &current, "kansei-grid", "Grid", &map(&[])).unwrap();
        assert!(dir.join("colors.toml").is_file());
        assert!(dir.join("backgrounds").is_dir());
        assert_eq!(fs::read_dir(dir.join("backgrounds")).unwrap().count(), 0);
    }

    #[test]
    fn export_rejects_a_bad_slug() {
        let tmp = tempfile::tempdir().unwrap();
        let themes = tmp.path().join("themes");
        for slug in ["", "Kansei", "../evil", "a/b", "a b", "kansei_grid", "é"] {
            assert!(
                export_theme(&themes, tmp.path(), slug, "X", &map(&[])).is_err(),
                "{slug:?} should be rejected"
            );
        }
        assert!(!themes.exists());
    }
}
