mod files;
mod mcp;
mod memory;
mod pty;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            files::claude_paths,
            files::fs_read_text,
            files::fs_write_text,
            files::fs_delete,
            files::fs_list,
            files::fs_exists,
            files::fs_mkdir,
            memory::memory_projects,
            mcp::mcp_list,
            mcp::mcp_upsert,
            mcp::mcp_remove,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<pty::PtyState>().kill_all();
            }
        });
}
