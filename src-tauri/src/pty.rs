//! PTY sessions (CONTRACT.md "PTY").
//!
//! Each pty owns three threads:
//! - reader: blocking reads from the master, forwards raw chunks over a channel;
//! - emitter: coalesces chunks for up to ~4 ms, emits `pty:data` (base64), and on
//!   EOF waits for the child and emits `pty:exit`;
//! - writer: drains a queue of input bytes into the master, so `pty_write` never
//!   blocks the main thread and keystrokes keep their order.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// How long the emitter waits for more output before flushing a chunk.
const COALESCE: Duration = Duration::from_millis(4);
/// Flush early once a coalesced chunk reaches this size.
const MAX_CHUNK: usize = 64 * 1024;
/// After `pty_kill`, escalate to SIGKILL if the child is still alive after this.
#[cfg(unix)]
const KILL_GRACE: Duration = Duration::from_secs(3);

pub struct PtyHandle {
    cwd: String,
    command: String,
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[cfg_attr(not(unix), allow(dead_code))]
    pid: Option<u32>,
    alive: Arc<AtomicBool>,
}

impl PtyHandle {
    fn terminate(&mut self) {
        if !self.alive.load(Ordering::SeqCst) {
            return;
        }
        // SIGHUP on unix, TerminateProcess on Windows.
        let _ = self.killer.kill();
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            let alive = self.alive.clone();
            thread::spawn(move || {
                thread::sleep(KILL_GRACE);
                if alive.load(Ordering::SeqCst) {
                    // SAFETY: plain kill(2) on a pid we spawned and have not reaped
                    // (the emitter thread reaps it and flips `alive` first).
                    unsafe {
                        libc::kill(pid as libc::pid_t, libc::SIGKILL);
                    }
                }
            });
        }
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[derive(Default)]
pub struct PtyState {
    next_id: AtomicU64,
    ptys: Mutex<HashMap<String, PtyHandle>>,
}

impl PtyState {
    /// Called on app exit: terminate every child.
    pub fn kill_all(&self) {
        let drained: Vec<PtyHandle> = match self.ptys.lock() {
            Ok(mut map) => map.drain().map(|(_, h)| h).collect(),
            Err(poisoned) => poisoned.into_inner().drain().map(|(_, h)| h).collect(),
        };
        drop(drained); // Drop -> terminate()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PtyHandle>> {
        self.ptys.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[derive(Serialize)]
pub struct SpawnResult {
    id: String,
}

#[derive(Serialize)]
pub struct PtyInfo {
    id: String,
    cwd: String,
    command: String,
    alive: bool,
}

#[derive(Serialize, Clone)]
struct DataEvent<'a> {
    id: &'a str,
    data: String,
}

#[derive(Serialize, Clone)]
struct ExitEvent<'a> {
    id: &'a str,
    code: Option<i64>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Variables an AppImage runtime injects that must not leak into host programs
/// (they make host binaries load the bundle's libraries).
#[cfg(target_os = "linux")]
const APPIMAGE_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "GST_PLUGIN_PATH",
    "GST_PLUGIN_PATH_1_0",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_SCANNER",
    "GST_PLUGIN_SCANNER_1_0",
    "GST_REGISTRY",
    "GST_REGISTRY_1_0",
    "GTK_PATH",
    "GTK_EXE_PREFIX",
    "GTK_DATA_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
    "GSETTINGS_SCHEMA_DIR",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
];

fn sanitize_env(cmd: &mut CommandBuilder) {
    // A tab running `claude` must not think it is nested inside another Claude
    // Code session (happens when Tsukue itself is started from one, e.g. in dev).
    // Only the session markers are dropped; user-level CLAUDE_CODE_* settings
    // (for example provider switches) stay.
    for var in [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SESSION_ATTENDED",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_BRIDGE_SESSION_ID",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_PID",
        "CLAUDE_EFFORT",
    ] {
        cmd.env_remove(var);
    }

    #[cfg(target_os = "linux")]
    if let Some(appdir) =
        std::env::var_os("APPDIR").filter(|_| std::env::var_os("APPIMAGE").is_some())
    {
        for var in APPIMAGE_VARS {
            cmd.env_remove(var);
        }
        // Drop the bundle's own entries from list-style variables.
        let appdir = Path::new(&appdir).to_path_buf();
        for var in ["PATH", "XDG_DATA_DIRS"] {
            if let Some(value) = std::env::var_os(var) {
                let kept: Vec<_> = std::env::split_paths(&value)
                    .filter(|p| !p.starts_with(&appdir))
                    .collect();
                if let Ok(joined) = std::env::join_paths(kept) {
                    cmd.env(var, joined);
                }
            }
        }
    }
}

/// Event sink for a pty session; the Tauri command forwards these to `app.emit`.
pub enum PtyEvent<'a> {
    Data { id: &'a str, data: String },
    Exit { id: &'a str, code: Option<i64> },
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: String,
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<SpawnResult, String> {
    let id = spawn(&state, cwd, command, args, cols, rows, move |ev| {
        let _ = match ev {
            PtyEvent::Data { id, data } => app.emit("pty:data", DataEvent { id, data }),
            PtyEvent::Exit { id, code } => app.emit("pty:exit", ExitEvent { id, code }),
        };
    })?;
    Ok(SpawnResult { id })
}

pub fn spawn<F>(
    state: &PtyState,
    cwd: String,
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    emit: F,
) -> Result<String, String>
where
    F: Fn(PtyEvent<'_>) + Send + 'static,
{
    if command.trim().is_empty() {
        return Err("command is empty".into());
    }
    if command.contains('\0') || args.iter().any(|a| a.contains('\0')) {
        return Err("command or args contain a NUL byte".into());
    }
    let cwd_path = Path::new(&cwd);
    if !cwd_path.is_absolute() {
        return Err(format!("cwd must be an absolute path: {cwd}"));
    }
    if !cwd_path.is_dir() {
        return Err(format!("cwd does not exist or is not a directory: {cwd}"));
    }

    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| format!("could not open a pty: {e}"))?;

    let mut cmd = CommandBuilder::new(&command);
    cmd.args(&args);
    cmd.cwd(cwd_path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TSUKUE", "1");
    sanitize_env(&mut cmd);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start {command}: {e}"))?;
    // Close our copy of the slave so the master sees EOF when the child exits.
    drop(pair.slave);

    let master = pair.master;
    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"));
    let writer = master.take_writer().map_err(|e| format!("pty writer: {e}"));
    let (mut reader, mut writer) = match (reader, writer) {
        (Ok(r), Ok(w)) => (r, w),
        (Err(e), _) | (_, Err(e)) => {
            let _ = child.kill();
            return Err(e);
        }
    };

    let id = (state.next_id.fetch_add(1, Ordering::SeqCst) + 1).to_string();
    let alive = Arc::new(AtomicBool::new(true));
    let killer = child.clone_killer();
    let pid = child.process_id();

    // Writer thread.
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
    thread::Builder::new()
        .name(format!("pty-{id}-writer"))
        .spawn(move || {
            while let Ok(bytes) = input_rx.recv() {
                if writer
                    .write_all(&bytes)
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        })
        .map_err(|e| format!("could not start writer thread: {e}"))?;

    // Reader thread.
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    thread::Builder::new()
        .name(format!("pty-{id}-reader"))
        .spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if out_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    // EIO on Linux once the slave side is closed.
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| format!("could not start reader thread: {e}"))?;

    // Emitter thread: coalesce, emit, then reap the child.
    {
        let id = id.clone();
        let alive = alive.clone();
        thread::Builder::new()
            .name(format!("pty-{id}-emitter"))
            .spawn(move || {
                'outer: while let Ok(first) = out_rx.recv() {
                    let mut chunk = first;
                    let deadline = Instant::now() + COALESCE;
                    let mut closed = false;
                    while chunk.len() < MAX_CHUNK {
                        let now = Instant::now();
                        if now >= deadline {
                            break;
                        }
                        match out_rx.recv_timeout(deadline - now) {
                            Ok(more) => chunk.extend_from_slice(&more),
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => {
                                closed = true;
                                break;
                            }
                        }
                    }
                    emit(PtyEvent::Data {
                        id: &id,
                        data: B64.encode(&chunk),
                    });
                    if closed {
                        break 'outer;
                    }
                }
                let code = child.wait().ok().map(|s| i64::from(s.exit_code()));
                alive.store(false, Ordering::SeqCst);
                emit(PtyEvent::Exit { id: &id, code });
            })
            .map_err(|e| format!("could not start emitter thread: {e}"))?;
    }

    state.lock().insert(
        id.clone(),
        PtyHandle {
            cwd,
            command,
            master,
            input: input_tx,
            killer,
            pid,
            alive,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let map = state.lock();
    let handle = map.get(&id).ok_or_else(|| format!("pty not found: {id}"))?;
    if !handle.alive.load(Ordering::SeqCst) {
        return Err(format!("pty has exited: {id}"));
    }
    handle
        .input
        .send(data.into_bytes())
        .map_err(|_| format!("pty input closed: {id}"))
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.lock();
    let handle = map.get(&id).ok_or_else(|| format!("pty not found: {id}"))?;
    handle
        .master
        .resize(size(cols, rows))
        .map_err(|e| format!("resize failed: {e}"))
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let handle = state
        .lock()
        .remove(&id)
        .ok_or_else(|| format!("pty not found: {id}"))?;
    drop(handle); // Drop -> terminate(), closes master and input queue
    Ok(())
}

#[tauri::command]
pub fn pty_list(state: State<'_, PtyState>) -> Vec<PtyInfo> {
    pty_list_inner(&state)
}

fn pty_list_inner(state: &PtyState) -> Vec<PtyInfo> {
    let map = state.lock();
    let mut out: Vec<PtyInfo> = map
        .iter()
        .map(|(id, h)| PtyInfo {
            id: id.clone(),
            cwd: h.cwd.clone(),
            command: h.command.clone(),
            alive: h.alive.load(Ordering::SeqCst),
        })
        .collect();
    out.sort_by_key(|p| p.id.parse::<u64>().unwrap_or(u64::MAX));
    out
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    enum Ev {
        Data(String, Vec<u8>),
        Exit(String, Option<i64>),
    }

    fn start(
        state: &PtyState,
        cwd: &str,
        cmd: &str,
        args: &[&str],
    ) -> (String, mpsc::Receiver<Ev>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let id = spawn(
            state,
            cwd.into(),
            cmd.into(),
            args.iter().map(|s| s.to_string()).collect(),
            80,
            24,
            move |ev| {
                let ev = match ev {
                    PtyEvent::Data { id, data } => {
                        Ev::Data(id.to_string(), B64.decode(data).unwrap())
                    }
                    PtyEvent::Exit { id, code } => Ev::Exit(id.to_string(), code),
                };
                let _ = tx.lock().unwrap().send(ev);
            },
        )
        .unwrap();
        (id, rx)
    }

    /// Collect output until exit (or timeout). Returns (bytes, exit code).
    fn drain(rx: &mpsc::Receiver<Ev>, want_id: &str) -> (Vec<u8>, Option<Option<i64>>) {
        let mut out = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Ev::Data(id, bytes)) => {
                    assert_eq!(id, want_id);
                    out.extend(bytes);
                }
                Ok(Ev::Exit(id, code)) => {
                    assert_eq!(id, want_id);
                    return (out, Some(code));
                }
                Err(_) => {}
            }
        }
        (out, None)
    }

    #[test]
    fn runs_command_with_env_and_exit_code() {
        let state = PtyState::default();
        let (id, rx) = start(
            &state,
            "/tmp",
            "sh",
            &[
                "-c",
                "printf '%s|%s|%s|%s' \"$TERM\" \"$COLORTERM\" \"$TSUKUE\" \"$PWD\"; exit 3",
            ],
        );
        let (out, code) = drain(&rx, &id);
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("xterm-256color|truecolor|1|/tmp"), "{text}");
        assert_eq!(code, Some(Some(3)));
        let info = &pty_list_inner(&state)[0];
        assert!(!info.alive);
    }

    #[test]
    fn write_reaches_child_and_kill_ends_it() {
        let state = PtyState::default();
        let (id, rx) = start(&state, "/tmp", "cat", &[]);
        state
            .lock()
            .get(&id)
            .unwrap()
            .input
            .send(b"ping\n".to_vec())
            .unwrap();
        // Wait for the echo, then kill.
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !String::from_utf8_lossy(&seen).contains("ping") && Instant::now() < deadline {
            if let Ok(Ev::Data(_, b)) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.extend(b);
            }
        }
        assert!(String::from_utf8_lossy(&seen).contains("ping"));
        let handle = state.lock().remove(&id).unwrap();
        drop(handle);
        let (_, code) = drain(&rx, &id);
        assert!(code.is_some(), "no exit event after kill");
        assert!(pty_list_inner(&state).is_empty());
    }

    #[test]
    fn rejects_bad_cwd_and_command() {
        let state = PtyState::default();
        let noop = |_: PtyEvent<'_>| {};
        assert!(
            spawn(
                &state,
                "/definitely/not/here".into(),
                "sh".into(),
                vec![],
                80,
                24,
                noop
            )
            .is_err()
        );
        assert!(spawn(&state, "relative".into(), "sh".into(), vec![], 80, 24, noop).is_err());
        assert!(spawn(&state, "/tmp".into(), "".into(), vec![], 80, 24, noop).is_err());
        let err = spawn(
            &state,
            "/tmp".into(),
            "no-such-binary-tsukue".into(),
            vec![],
            80,
            24,
            noop,
        )
        .unwrap_err();
        assert!(err.contains("could not start"), "{err}");
    }
}
