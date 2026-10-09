//! Closing the window preserves the existing Rust process and its vault cache.
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

pub fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "studio-open", "Toris Studio 열기", true, None::<&str>)?;
    let pause = MenuItem::with_id(
        app,
        "studio-pause",
        "예약 게시 일시정지",
        true,
        None::<&str>,
    )?;
    let resume = MenuItem::with_id(app, "studio-resume", "예약 게시 재개", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "studio-quit", "완전히 종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &resume, &quit])?;
    let mut tray = TrayIconBuilder::with_id("toris-studio-publisher")
        .menu(&menu)
        .tooltip("Toris Studio · SNS 예약 게시")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "studio-open" => show(app),
            "studio-pause" | "studio-resume" => {
                let pause = event.id.as_ref() == "studio-pause";
                match crate::publications::set_pause(pause) {
                    Ok(status) => {
                        let _ = app.emit_to("main", "publication-scheduler-status", status);
                    }
                    Err(message) => {
                        show(app);
                        let _ = app.emit_to("main", "publication-runtime-error", message);
                    }
                }
            }
            "studio-quit" => {
                if crate::publications::running() {
                    show(app);
                    let _ = app.emit_to(
                        "main",
                        "publication-runtime-error",
                        "게시 처리 중입니다. 전송 결과가 확인된 뒤 종료하세요.",
                    );
                } else {
                    app.exit(0);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
