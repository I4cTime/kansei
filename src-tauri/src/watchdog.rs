//! Main-thread watchdog and the app log.
//!
//! A background thread posts a ping to the GTK main thread every 500 ms
//! (`run_on_main_thread`); the ping stores a "last pong" time. When no pong
//! has arrived for more than 3 s a stall is in progress: the log gets
//! `stall start ...`, and the watchdog thread runs `eu-stack -p <own pid>`
//! once into `<appData>/stalls/<unix ts>.txt` (at most 5 captures per
//! process). When pongs resume the log gets `stall end, lasted ...`.
//!
//! Log: `<appData>/tsukue.log`, append-only, one `<UTC time> <message>` line
//! per entry, rotated to `tsukue.log.1` past 1 MB. `note` is the public entry.
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How often a ping is posted to the main thread and the pong age checked.
const TICK: Duration = Duration::from_millis(500);
/// No pong for longer than this counts as a stall.
const STALL_AFTER_MS: u64 = 3000;
/// Stack captures per process lifetime.
const MAX_CAPTURES: u32 = 5;
/// eu-stack is killed if it has not finished by then.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
/// The log rotates to `tsukue.log.1` once it is larger than this.
const LOG_MAX_BYTES: u64 = 1024 * 1024;

/// Serialises appends (and the rotation check) across threads.
static LOG_LOCK: Mutex<()> = Mutex::new(());

fn data_dir() -> Option<PathBuf> {
    crate::files::app_data_dir().ok()
}

/// Append one line to `<appData>/tsukue.log`. Newlines in `msg` become spaces
/// so every entry stays on one line. Failures go to stderr and are otherwise
/// ignored: logging must never break the caller.
pub fn note(msg: &str) {
    let Some(dir) = data_dir() else { return };
    let line = format!(
        "{} {}",
        timestamp(SystemTime::now()),
        msg.replace(['\n', '\r'], " ")
    );
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let res = fs::create_dir_all(&dir)
        .and_then(|_| append_line(&dir.join("tsukue.log"), &line, LOG_MAX_BYTES));
    if let Err(e) = res {
        eprintln!("tsukue log: {e}");
    }
}

/// Append `line` to `path`, first renaming `path` to `<path>.1` (replacing an
/// older one) when it is larger than `max_bytes`.
fn append_line(path: &Path, line: &str, max_bytes: u64) -> std::io::Result<()> {
    if fs::metadata(path)
        .map(|m| m.len() > max_bytes)
        .unwrap_or(false)
    {
        let mut rotated = path.as_os_str().to_owned();
        rotated.push(".1");
        fs::rename(path, rotated)?;
    }
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(format!("{line}\n").as_bytes())
}

/// `2026-10-31T20:12:03.123` in UTC (no chrono here, so no local offset).
fn timestamp(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (y, m, day) = civil_from_days(secs.div_euclid(86_400));
    let sod = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{day:02}T{:02}:{:02}:{:02}.{:03}",
        sod / 3600,
        sod % 3600 / 60,
        sod % 60,
        d.subsec_millis()
    )
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian
/// (Howard Hinnant's civil_from_days).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// What one watchdog check found.
#[derive(Debug, PartialEq, Eq)]
enum Transition {
    None,
    /// A stall began: `silent_ms` since the last pong; `capture` is false once
    /// the per-process capture budget is spent.
    Start {
        silent_ms: u64,
        capture: bool,
    },
    /// Pongs resumed; `lasted_ms` from the last pong before the stall to the
    /// first one after it.
    End {
        lasted_ms: u64,
    },
}

/// The stall detector as a pure function of timestamps (ms since start).
/// A `last_pong` of 0 means no pong yet: startup is not judged.
#[derive(Debug, Default)]
struct Detector {
    /// The last pong seen before the current stall, while one is in progress.
    stall_from: Option<u64>,
    captures: u32,
}

impl Detector {
    fn check(&mut self, now_ms: u64, last_pong_ms: u64) -> Transition {
        if last_pong_ms == 0 {
            return Transition::None;
        }
        match self.stall_from {
            None => {
                let silent_ms = now_ms.saturating_sub(last_pong_ms);
                if silent_ms <= STALL_AFTER_MS {
                    return Transition::None;
                }
                self.stall_from = Some(last_pong_ms);
                let capture = self.captures < MAX_CAPTURES;
                if capture {
                    self.captures += 1;
                }
                Transition::Start { silent_ms, capture }
            }
            Some(from) if last_pong_ms > from => {
                self.stall_from = None;
                Transition::End {
                    lasted_ms: last_pong_ms - from,
                }
            }
            Some(_) => Transition::None,
        }
    }
}

/// Log the startup line and start the watchdog thread.
pub fn start(app: &tauri::AppHandle) {
    let env = |k: &str| std::env::var(k).unwrap_or_else(|_| "unset".into());
    note(&format!(
        "start tsukue {} ({}) pid {}, nvidia driver {}, __NV_DISABLE_EXPLICIT_SYNC={}, \
         WEBKIT_DISABLE_DMABUF_RENDERER={}, GDK_BACKEND={}",
        env!("CARGO_PKG_VERSION"),
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        std::process::id(),
        if Path::new("/proc/driver/nvidia").exists() {
            "present"
        } else {
            "absent"
        },
        env("__NV_DISABLE_EXPLICIT_SYNC"),
        env("WEBKIT_DISABLE_DMABUF_RENDERER"),
        env("GDK_BACKEND"),
    ));
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("watchdog".into())
        .spawn(move || run(app));
    if let Err(e) = spawned {
        note(&format!("watchdog: could not start thread: {e}"));
    }
}

fn run(app: tauri::AppHandle) {
    let start = Instant::now();
    let since_start = move || (start.elapsed().as_millis() as u64).max(1);
    let last_pong = Arc::new(AtomicU64::new(0));
    // One ping in flight at most, so a long hang does not queue thousands.
    let pending = Arc::new(AtomicBool::new(false));
    let mut detector = Detector::default();
    loop {
        if !pending.swap(true, Ordering::SeqCst) {
            let (pong, pend) = (last_pong.clone(), pending.clone());
            let posted = app.run_on_main_thread(move || {
                pong.store(since_start(), Ordering::SeqCst);
                pend.store(false, Ordering::SeqCst);
            });
            if posted.is_err() {
                // The event loop is gone: the app is exiting.
                return;
            }
        }
        thread::sleep(TICK);
        match detector.check(since_start(), last_pong.load(Ordering::SeqCst)) {
            Transition::None => {}
            Transition::Start { silent_ms, capture } => {
                note(&format!("stall start after {silent_ms} ms without pong"));
                if capture {
                    match capture_stacks() {
                        Ok(msg) => note(&msg),
                        Err(e) => note(&format!("stack capture failed: {e}")),
                    }
                }
            }
            Transition::End { lasted_ms } => note(&format!("stall end, lasted {lasted_ms} ms")),
        }
    }
}

/// Run `eu-stack -p <own pid>` into `<appData>/stalls/<unix ts>.txt`.
/// Called from the watchdog thread only.
fn capture_stacks() -> Result<String, String> {
    let dir = data_dir().ok_or("data directory not found")?.join("stalls");
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut path = dir.join(format!("{ts}.txt"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{ts}-{n}.txt"));
        n += 1;
    }
    let out = File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new("eu-stack");
    cmd.arg("-p")
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        // debuginfod downloads for WebKit could take minutes; local symbols only.
        .env_remove("DEBUGINFOD_URLS");

    // Yama ptrace_scope 1 only lets ancestors trace; allow the child in.
    set_ptracer(true);
    let spawned = cmd.spawn();
    let result = match spawned {
        Ok(mut child) => {
            let deadline = Instant::now() + CAPTURE_TIMEOUT;
            loop {
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => {
                        break Ok(format!("stacks captured to {}", path.display()));
                    }
                    // eu-stack exits non-zero when one thread fails to unwind,
                    // with the other threads' stacks still in the file.
                    Ok(Some(status)) => {
                        break Ok(format!(
                            "stacks captured to {} (eu-stack {status})",
                            path.display()
                        ));
                    }
                    Ok(None) if Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break Err(format!(
                            "eu-stack timed out after 10 s, partial output in {}",
                            path.display()
                        ));
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(100)),
                    Err(e) => break Err(format!("waiting for eu-stack: {e}")),
                }
            }
        }
        Err(e) => {
            let _ = fs::remove_file(&path);
            Err(format!("could not run eu-stack (elfutils): {e}"))
        }
    };
    set_ptracer(false);
    result
}

/// PR_SET_PTRACER: any process (`true`) or none beyond the default (`false`).
fn set_ptracer(any: bool) {
    #[cfg(target_os = "linux")]
    {
        let arg = if any { libc::PR_SET_PTRACER_ANY } else { 0 };
        // SAFETY: prctl with integer arguments only, no memory is passed.
        unsafe { libc::prctl(libc::PR_SET_PTRACER, arg, 0, 0, 0) };
    }
    #[cfg(not(target_os = "linux"))]
    let _ = any;
}

/// Debug builds only: block the main thread for `ms` (capped at 60 s) so the
/// watchdog can be seen firing. Registered in `lib.rs` under the same cfg.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn debug_block_main(app: tauri::AppHandle, ms: u64) -> Result<(), String> {
    let ms = ms.min(60_000);
    app.run_on_main_thread(move || thread::sleep(Duration::from_millis(ms)))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_formats_utc() {
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000");
        let t = UNIX_EPOCH + Duration::from_millis(1_793_564_523_123);
        assert_eq!(timestamp(t), "2026-11-01T20:22:03.123");
        // Leap day.
        let t = UNIX_EPOCH + Duration::from_secs(1_709_164_800);
        assert_eq!(timestamp(t), "2024-02-29T00:00:00.000");
        let t = UNIX_EPOCH + Duration::from_secs(951_868_799);
        assert_eq!(timestamp(t), "2000-02-29T23:59:59.000");
    }

    #[test]
    fn append_rotates_past_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("tsukue.log");
        let old = dir.path().join("tsukue.log.1");
        fs::write(&old, "ancient\n").unwrap();

        append_line(&log, "one", 10).unwrap();
        append_line(&log, "two", 10).unwrap();
        // 8 bytes, not over 10: no rotation yet.
        assert_eq!(fs::read_to_string(&log).unwrap(), "one\ntwo\n");
        assert_eq!(fs::read_to_string(&old).unwrap(), "ancient\n");

        append_line(&log, "three", 10).unwrap();
        // 14 bytes now; the next append rotates first.
        assert_eq!(fs::read_to_string(&log).unwrap(), "one\ntwo\nthree\n");
        append_line(&log, "four", 10).unwrap();
        assert_eq!(fs::read_to_string(&log).unwrap(), "four\n");
        assert_eq!(fs::read_to_string(&old).unwrap(), "one\ntwo\nthree\n");
    }

    #[test]
    fn detector_waits_for_the_first_pong() {
        let mut d = Detector::default();
        assert_eq!(d.check(10_000, 0), Transition::None);
        assert_eq!(d.check(10_000, 9_000), Transition::None);
    }

    #[test]
    fn detector_starts_and_ends_one_stall() {
        let mut d = Detector::default();
        assert_eq!(
            d.check(3_500, 500),
            Transition::None,
            "exactly 3000 ms is not a stall"
        );
        assert_eq!(
            d.check(4_000, 500),
            Transition::Start {
                silent_ms: 3_500,
                capture: true
            }
        );
        // Still stalled: no second start, no second capture.
        assert_eq!(d.check(4_500, 500), Transition::None);
        assert_eq!(d.check(9_000, 500), Transition::None);
        assert_eq!(d.check(9_500, 9_200), Transition::End { lasted_ms: 8_700 });
        assert_eq!(d.check(10_000, 9_700), Transition::None);
        assert_eq!(d.captures, 1);
    }

    #[test]
    fn detector_caps_captures_per_process() {
        let mut d = Detector::default();
        let mut pong = 1;
        let mut captured = 0;
        for _ in 0..8 {
            let now = pong + 3_001;
            match d.check(now, pong) {
                Transition::Start { capture, .. } => captured += u32::from(capture),
                other => panic!("expected a stall start, got {other:?}"),
            }
            pong = now + 1;
            assert_eq!(d.check(pong, pong), Transition::End { lasted_ms: 3_002 });
        }
        assert_eq!(captured, MAX_CAPTURES);
    }
}
