// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nvidia_workarounds();
    tsukue_lib::run()
}

/// Two NVIDIA driver settings, forced whenever the NVIDIA driver is present.
/// They override the session: a gaming profile in ~/.config/environment.d
/// exports `__GL_SYNC_TO_VBLANK=1`, and honouring it brought the hidden-workspace
/// hang back (stalls of 36 to 115 s on 2026-11-01). Set `TSUKUE_NVIDIA_ENV=keep`
/// to leave the environment alone. Must run before GTK and EGL initialise, so
/// they live here, not in the Tauri setup hook.
///
/// - `__NV_DISABLE_EXPLICIT_SYNC=1`: WebKitGTK's DMA-BUF renderer dies on
///   NVIDIA's explicit-sync Wayland protocol ("Missing acquire timeline", Gdk
///   Error 71). Turning explicit sync off keeps the GPU renderer; the software
///   fallback (WEBKIT_DISABLE_DMABUF_RENDERER) types with visible lag.
/// - `__GL_SYNC_TO_VBLANK=0`: with the default swap interval, eglSwapBuffers in
///   libnvidia-egl-wayland waits for the compositor's frame callback. A window
///   on a hidden Hyprland workspace never gets one, so any repaint (a tab
///   printing output) blocked the GTK main thread until the workspace was
///   shown again, 20 to 60 s in practice ("Application Not Responding").
///   Swap interval 0 returns at once; GTK's frame clock still paces drawing.
fn nvidia_workarounds() {
    #[cfg(target_os = "linux")]
    {
        if !std::path::Path::new("/proc/driver/nvidia").exists() {
            return;
        }
        if std::env::var_os("TSUKUE_NVIDIA_ENV").is_some_and(|v| v == "keep") {
            return;
        }
        for (key, value) in [("__NV_DISABLE_EXPLICIT_SYNC", "1"), ("__GL_SYNC_TO_VBLANK", "0")] {
            // SAFETY: single-threaded at this point, nothing has read the env yet.
            unsafe { std::env::set_var(key, value) };
        }
    }
}
