//! Dev-only UI driver: when `KANSEI_DRIVER=/path/to.sock` is set, each line
//! received on that unix socket is run as async JS inside the webview (through
//! `window.__kanseiDriverRun`, defined by src/app/driver.ts) and the JSON
//! result is written back as one line. Inert in release builds.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use tauri::Manager;

#[derive(Default)]
pub struct DriverState(Mutex<HashMap<u64, mpsc::Sender<String>>>);

#[tauri::command]
pub fn driver_result(state: tauri::State<'_, DriverState>, id: u64, result: String) {
    if let Some(tx) = state.0.lock().unwrap().remove(&id) {
        let _ = tx.send(result);
    }
}

pub fn start(app: &tauri::AppHandle) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Some(path) = std::env::var_os("KANSEI_DRIVER") else { return };
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("driver: cannot bind {}: {e}", path.to_string_lossy());
            return;
        }
    };
    eprintln!("driver: listening on {}", path.to_string_lossy());
    let app = app.clone();
    std::thread::spawn(move || {
        let mut seq = 0u64;
        for conn in listener.incoming() {
            let Ok(stream) = conn else { continue };
            let Ok(reader_stream) = stream.try_clone() else { continue };
            let mut reader = BufReader::new(reader_stream);
            let mut out = stream;
            let mut line = String::new();
            while reader.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                seq += 1;
                let (tx, rx) = mpsc::channel();
                app.state::<DriverState>().0.lock().unwrap().insert(seq, tx);
                let code = serde_json::to_string(line.trim_end_matches(['\n', '\r'])).unwrap();
                let js = format!("window.__kanseiDriverRun({seq}, {code})");
                match app.get_webview_window("main") {
                    Some(w) => {
                        if let Err(e) = w.eval(js.as_str()) {
                            let _ = writeln!(out, "{{\"__error\":\"eval failed: {e}\"}}");
                            line.clear();
                            continue;
                        }
                    }
                    None => {
                        let _ = writeln!(out, "{{\"__error\":\"no main window\"}}");
                        line.clear();
                        continue;
                    }
                }
                let res = rx
                    .recv_timeout(Duration::from_secs(30))
                    .unwrap_or_else(|_| "{\"__error\":\"timeout\"}".to_string());
                if writeln!(out, "{res}").is_err() {
                    break;
                }
                line.clear();
            }
        }
    });
}
