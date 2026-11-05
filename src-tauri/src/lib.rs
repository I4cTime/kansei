mod activity;
mod board;
mod files;
mod mcp;
mod mcp_health;
mod memory;
mod projects;
mod pty;
mod search;
mod sessions;
mod theme;
mod transcripts;
mod usage;
mod watchdog;
mod workspace;

use tauri::{Manager, RunEvent};

mod driver;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    files::migrate_legacy_dirs();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .manage(driver::DriverState::default())
        .setup(|app| {
            driver::start(app.handle());
            watchdog::start(app.handle());
            theme::start(app.handle());
            activity::start(app.handle());
            board::startup_render();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            driver::driver_result,
            #[cfg(debug_assertions)]
            watchdog::debug_block_main,
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
            files::project_root,
            memory::memory_projects,
            mcp::mcp_list,
            mcp::mcp_upsert,
            mcp::mcp_remove,
            mcp::mcp_extras,
            mcp_health::mcp_health_check,
            mcp_health::mcp_health_cached,
            sessions::sessions_list,
            search::search_index_refresh,
            search::search_sessions,
            usage::usage_refresh,
            usage::usage_days,
            projects::projects_info,
            projects::file_executable,
            workspace::workspace_scan,
            workspace::workspace_claude_md,
            workspace::project_additional_dirs,
            board::gh_status,
            board::board_fetch,
            board::board_cached,
            board::board_set_field,
            board::board_create_task,
            board::board_create_epic,
            board::board_configure,
            board::schedule_read,
            board::schedule_write,
            board::schedule_render,
            board::activity_days,
            theme::theme_omarchy,
            theme::theme_export_omarchy,
            activity::notify,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                watchdog::note("exit");
                app.state::<pty::PtyState>().kill_all();
            }
        });
}
