//! Main-window-only settings commands for the Mac companion host.
use serde_json::{json, Value};
use tauri::Manager;

#[cfg(not(target_os = "macos"))]
fn unsupported() -> String {
    "모바일 연결은 macOS에서 사용할 수 있습니다.".into()
}

#[tauri::command]
pub async fn mobile_status(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    #[cfg(target_os = "macos")]
    {
        let host = window
            .app_handle()
            .state::<std::sync::Arc<crate::mobile_host::MobileHost>>();
        return serde_json::to_value(host.status().await?)
            .map_err(|_| "모바일 연결 상태를 확인하지 못했습니다.".into());
    }
    #[cfg(not(target_os = "macos"))]
    Ok(
        json!({"available":false,"enabled":false,"interfaces":[],"devices":[],"projects":[],"pending":null}),
    )
}

#[tauri::command]
pub async fn mobile_enable(window: tauri::WebviewWindow, address: String) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    #[cfg(target_os = "macos")]
    {
        let ip = address
            .parse::<std::net::Ipv4Addr>()
            .map_err(|_| "네트워크 주소를 확인하세요.")?;
        let host = window
            .app_handle()
            .state::<std::sync::Arc<crate::mobile_host::MobileHost>>();
        return host.enable(ip).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = address;
        Err(unsupported())
    }
}

#[tauri::command]
pub async fn mobile_disable(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    #[cfg(target_os = "macos")]
    {
        let host = window
            .app_handle()
            .state::<std::sync::Arc<crate::mobile_host::MobileHost>>();
        return host.disable().await;
    }
    #[cfg(not(target_os = "macos"))]
    Err(unsupported())
}

#[tauri::command]
pub async fn mobile_issue_qr(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    #[cfg(target_os = "macos")]
    {
        let host = window
            .app_handle()
            .state::<std::sync::Arc<crate::mobile_host::MobileHost>>();
        let expires = host.issue_qr().await?;
        // The URL is only a cache buster. The registration value is inside the
        // native image response, never in the command result or a log.
        return Ok(
            json!({"url":format!("toris-mobile://localhost/qr?v={}", uuid::Uuid::new_v4()),"expiresAt":expires}),
        );
    }
    #[cfg(not(target_os = "macos"))]
    Err(unsupported())
}

#[tauri::command]
pub async fn mobile_close_qr(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    #[cfg(target_os = "macos")]
    {
        let host = window
            .app_handle()
            .state::<std::sync::Arc<crate::mobile_host::MobileHost>>();
        return host.close_pairing().await;
    }
    #[cfg(not(target_os = "macos"))]
    Err(unsupported())
}

#[tauri::command]
pub async fn mobile_approve(
    window: tauri::WebviewWindow,
    attempt_id: String,
    projects: Vec<String>,
    allow_create: bool,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    #[cfg(target_os = "macos")]
    {
        let attempt = uuid::Uuid::parse_str(&attempt_id).map_err(|_| "등록 요청을 확인하세요.")?;
        let host = window
            .app_handle()
            .state::<std::sync::Arc<crate::mobile_host::MobileHost>>();
        return host.approve(attempt, &projects, allow_create).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (attempt_id, projects, allow_create);
        Err(unsupported())
    }
}

#[tauri::command]
pub async fn mobile_set_permissions(
    window: tauri::WebviewWindow,
    device_id: String,
    projects: Vec<String>,
    allow_create: bool,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    #[cfg(target_os = "macos")]
    {
        let device = uuid::Uuid::parse_str(&device_id).map_err(|_| "기기를 확인하세요.")?;
        let host = window
            .app_handle()
            .state::<std::sync::Arc<crate::mobile_host::MobileHost>>();
        return host.set_permissions(device, &projects, allow_create).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (device_id, projects, allow_create);
        Err(unsupported())
    }
}

#[tauri::command]
pub async fn mobile_revoke(window: tauri::WebviewWindow, device_id: String) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    #[cfg(target_os = "macos")]
    {
        let device = uuid::Uuid::parse_str(&device_id).map_err(|_| "기기를 확인하세요.")?;
        let host = window
            .app_handle()
            .state::<std::sync::Arc<crate::mobile_host::MobileHost>>();
        return host.revoke(device).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = device_id;
        Err(unsupported())
    }
}

#[cfg(target_os = "macos")]
pub fn qr_protocol(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    use tauri::http::{header, Response};
    let allowed = context.webview_label() == "main"
        && request.method() == "GET"
        && request.uri().path() == "/qr";
    let png = if allowed {
        context
            .app_handle()
            .state::<std::sync::Arc<crate::mobile_host::MobileHost>>()
            .qr_image()
    } else {
        None
    };
    let (status, content_type, bytes) = match png {
        Some(bytes) => (200, "image/png", bytes),
        None => (404, "text/plain", Vec::new()),
    };
    responder.respond(
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .body(bytes)
            .expect("static QR response"),
    );
}
