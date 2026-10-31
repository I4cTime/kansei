// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nvidia_explicit_sync_workaround();
    tsukue_lib::run()
}

/// WebKitGTK's DMA-BUF renderer dies on NVIDIA's explicit-sync Wayland
/// protocol ("Missing acquire timeline", Gdk Error 71). Turning explicit sync
/// off in the driver keeps the GPU renderer; the software fallback
/// (WEBKIT_DISABLE_DMABUF_RENDERER) types with visible lag. Must run before
/// GTK and EGL initialise, so it lives here, not in the Tauri setup hook.
fn nvidia_explicit_sync_workaround() {
    #[cfg(target_os = "linux")]
    {
        let nvidia = std::path::Path::new("/proc/driver/nvidia").exists();
        let unset = std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none();
        if nvidia && unset {
            // SAFETY: single-threaded at this point, nothing has read the env yet.
            unsafe { std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1") };
        }
    }
}
