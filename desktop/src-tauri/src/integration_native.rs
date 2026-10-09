use serde::Deserialize;
use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Default, Deserialize)]
pub struct CodexifyProxyInput {
    #[serde(default)]
    provider: crate::codexify_proxy::ProxyProvider,
}

#[tauri::command]
pub async fn open_webui_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
    runtime: tauri::State<'_, std::sync::Arc<crate::open_webui::OpenWebUiController>>,
) -> Result<crate::open_webui::OpenWebUiStatus, String> {
    crate::updater::authorize(&window)?;
    runtime.status(&state.config_snapshot().await).await
}

#[tauri::command]
pub async fn open_webui_start(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
    runtime: tauri::State<'_, std::sync::Arc<crate::open_webui::OpenWebUiController>>,
    bridge: tauri::State<'_, std::sync::Arc<crate::open_webui_bridge::Controller>>,
) -> Result<crate::open_webui::OpenWebUiStatus, String> {
    crate::updater::authorize(&window)?;
    bridge.ensure_started().await?;
    runtime.start(&state.config_snapshot().await).await
}

#[tauri::command]
pub async fn open_webui_stop(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
    runtime: tauri::State<'_, std::sync::Arc<crate::open_webui::OpenWebUiController>>,
) -> Result<crate::open_webui::OpenWebUiStatus, String> {
    crate::updater::authorize(&window)?;
    runtime.stop(&state.config_snapshot().await).await
}

#[tauri::command]
pub fn open_webui_bootstrap(window: tauri::WebviewWindow) -> Result<String, String> {
    crate::updater::authorize(&window)?;
    let profile = crate::codexify_connection::load()?;
    if profile.project_root.trim().is_empty() {
        return Err("코딩 연결 설정에서 작업 프로젝트를 선택하고 저장하세요.".into());
    }
    let selection = json!({"path": profile.project_root, "createWorktree": false});
    Ok(format!("이 Open WebUI 대화에서 Toris Codexify MCP 도구를 선택해 작업해줘. 먼저 실제 도구 목록을 확인하고 set_project_root({selection})로 앱에 저장된 프로젝트를 선택한 뒤 get_agent_brief를 읽어줘. 이 대화의 Codexify 연결은 기존 ChatGPT 대화와 별개야. 작업 시작·주요 단계·문제·검증한 결과를 대화에 알려줘. 완료하지 않은 작업이나 테스트 성공을 추측하지 말고 실제 결과로 설명해줘. 프로젝트를 변경하려면 Toris Studio 코딩 연결 설정에서 먼저 저장해야 해."))
}

#[tauri::command]
pub async fn open_webui_open(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
    runtime: tauri::State<'_, std::sync::Arc<crate::open_webui::OpenWebUiController>>,
    bridge: tauri::State<'_, std::sync::Arc<crate::open_webui_bridge::Controller>>,
) -> Result<(), String> {
    use tauri::Manager;
    crate::updater::authorize(&window)?;
    bridge.ensure_started().await?;
    let status = runtime.status(&state.config_snapshot().await).await?;
    if !status.can_open {
        return Err("Open WebUI를 시작하고 준비 완료 상태를 확인하세요.".into());
    }
    if let Some(existing) = app.get_webview_window("open-webui") {
        existing
            .show()
            .map_err(|_| "Open WebUI 창을 표시하지 못했습니다.")?;
        existing
            .set_focus()
            .map_err(|_| "Open WebUI 창을 선택하지 못했습니다.")?;
        return Ok(());
    }
    // Remote pages have no main-local capability. Do not grant this window IPC permissions.
    let external = app.clone();
    let popup = app.clone();
    tauri::WebviewWindowBuilder::new(
        &app,
        "open-webui",
        tauri::WebviewUrl::External(
            "http://127.0.0.1:43180"
                .parse()
                .map_err(|_| "Open WebUI 주소 오류")?,
        ),
    )
    .title("Open WebUI · Toris Studio")
    .inner_size(1240.0, 850.0)
    .min_inner_size(820.0, 620.0)
    .on_navigation(move |url| {
        if open_webui_navigation(url) {
            return true;
        }
        if safe_web_link(url) {
            let _ = external.opener().open_url(url.as_str(), None::<&str>);
        }
        false
    })
    .on_new_window(move |url, _| {
        if safe_web_link(&url) {
            let _ = popup.opener().open_url(url.as_str(), None::<&str>);
        }
        tauri::webview::NewWindowResponse::Deny
    })
    .build()
    .map_err(|_| "Open WebUI 창을 열지 못했습니다.")?;
    Ok(())
}

fn open_webui_navigation(url: &url::Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(43180)
        && url.username().is_empty()
        && url.password().is_none()
}
fn safe_web_link(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(test)]
mod open_webui_window_tests {
    use super::*;
    #[test]
    fn remote_window_stays_on_owned_loopback_origin() {
        assert!(open_webui_navigation(
            &"http://127.0.0.1:43180/auth?next=%2F".parse().unwrap()
        ));
        for address in [
            "http://127.0.0.1:43181/",
            "https://127.0.0.1:43180/",
            "http://localhost:43180/",
            "http://127.0.0.1.evil.test:43180/",
            "http://user:password@127.0.0.1:43180/",
            "tauri://localhost/",
            "javascript:alert(1)",
        ] {
            assert!(
                !open_webui_navigation(&address.parse().unwrap()),
                "{address}"
            );
        }
        for address in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "http://user:password@example.test/",
        ] {
            assert!(!safe_web_link(&address.parse().unwrap()));
        }
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(capability["windows"], json!(["main"]));
        assert!(capability.get("remote").is_none());
    }
}

#[tauri::command]
pub async fn codexify_runtime_status(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, std::sync::Arc<crate::codexify_runtime::RuntimeController>>,
) -> Result<crate::codexify_runtime::RuntimeStatus, String> {
    crate::updater::authorize(&window)?;
    runtime.status().await
}
#[tauri::command]
pub async fn codexify_runtime_configure(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, std::sync::Arc<crate::codexify_runtime::RuntimeController>>,
    input: crate::codexify_runtime::ConfigureInput,
) -> Result<crate::codexify_runtime::RuntimeStatus, String> {
    crate::updater::authorize(&window)?;
    runtime.configure(input).await
}
#[tauri::command]
pub async fn codexify_runtime_start(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, std::sync::Arc<crate::codexify_runtime::RuntimeController>>,
) -> Result<crate::codexify_runtime::RuntimeStatus, String> {
    crate::updater::authorize(&window)?;
    runtime.start().await
}
#[tauri::command]
pub async fn codexify_runtime_stop(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, std::sync::Arc<crate::codexify_runtime::RuntimeController>>,
    proxy: tauri::State<'_, std::sync::Arc<crate::codexify_proxy::ProxyController>>,
) -> Result<crate::codexify_runtime::RuntimeStatus, String> {
    crate::updater::authorize(&window)?;
    proxy.stop().await?;
    runtime.stop().await
}
#[tauri::command]
pub async fn codexify_runtime_doctor(
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, std::sync::Arc<crate::codexify_runtime::RuntimeController>>,
) -> Result<crate::codexify_runtime::DoctorReport, String> {
    crate::updater::authorize(&window)?;
    runtime.doctor().await
}

#[tauri::command]
pub async fn codexify_proxy_status(
    window: tauri::WebviewWindow,
    proxy: tauri::State<'_, std::sync::Arc<crate::codexify_proxy::ProxyController>>,
    input: Option<CodexifyProxyInput>,
) -> Result<crate::codexify_proxy::ProxyStatus, String> {
    crate::updater::authorize(&window)?;
    proxy.status_for(input.unwrap_or_default().provider).await
}
#[tauri::command]
pub async fn codexify_proxy_start(
    window: tauri::WebviewWindow,
    proxy: tauri::State<'_, std::sync::Arc<crate::codexify_proxy::ProxyController>>,
    runtime: tauri::State<'_, std::sync::Arc<crate::codexify_runtime::RuntimeController>>,
    input: Option<CodexifyProxyInput>,
) -> Result<crate::codexify_proxy::ProxyStatus, String> {
    crate::updater::authorize(&window)?;
    proxy
        .start_for(
            input.unwrap_or_default().provider,
            runtime.status().await?.port,
        )
        .await
}
#[tauri::command]
pub async fn codexify_proxy_stop(
    window: tauri::WebviewWindow,
    proxy: tauri::State<'_, std::sync::Arc<crate::codexify_proxy::ProxyController>>,
    input: Option<CodexifyProxyInput>,
) -> Result<crate::codexify_proxy::ProxyStatus, String> {
    crate::updater::authorize(&window)?;
    proxy.stop_for(input.unwrap_or_default().provider).await
}

#[tauri::command]
pub fn codexify_connection_get(
    window: tauri::WebviewWindow,
) -> Result<crate::codexify_connection::Profile, String> {
    crate::updater::authorize(&window)?;
    crate::codexify_connection::load()
}
#[tauri::command]
pub fn codexify_connection_save(
    window: tauri::WebviewWindow,
    input: crate::codexify_connection::Profile,
    proxy: tauri::State<'_, std::sync::Arc<crate::codexify_proxy::ProxyController>>,
) -> Result<crate::codexify_connection::Profile, String> {
    crate::updater::authorize(&window)?;
    let before = crate::codexify_connection::load()?;
    let saved = crate::codexify_connection::save(input)?;
    if before.mcp_url != saved.mcp_url {
        proxy.shutdown();
    }
    Ok(saved)
}
#[tauri::command]
pub async fn codexify_connection_check(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::codexify_connection::check().await
}
#[tauri::command]
pub async fn codexify_chats(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::codexify_connection::chats().await
}
#[tauri::command]
pub async fn codexify_chat_read(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::codexify_connection::chat_read().await
}
#[tauri::command]
pub async fn codexify_chat_send(
    window: tauri::WebviewWindow,
    input: crate::codexify_connection::SendInput,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::codexify_connection::chat_send(input).await
}

#[tauri::command]
pub async fn integration_status(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let exe = std::env::current_exe().map_err(|_| "현재 설치 경로를 확인하지 못했습니다.")?;
    let root = crate::assets::root_dir()?;
    let mcp = crate::mcp_bridge::status_at(&root)?;
    Ok(
        json!({"oauth":crate::oauth::status().await?,"mcp":mcp,"mcpConfig":{"mcpServers":{"toris-studio":{"command":exe,"args":["--studio-mcp"]}}},"lastUpload":crate::publishing::last_attempt()?,"version":env!("CARGO_PKG_VERSION")}),
    )
}
#[tauri::command]
pub async fn integration_upload_login(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let mut result = crate::oauth::begin_youtube_upload_login().await?;
    let url = result["authorizationUrl"]
        .as_str()
        .ok_or("YouTube 인증 주소를 만들지 못했습니다.")?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "시스템 브라우저를 열지 못했습니다.")?;
    result
        .as_object_mut()
        .ok_or("YouTube 로그인 응답 오류")?
        .remove("authorizationUrl");
    Ok(result)
}
#[tauri::command]
pub async fn integration_channels(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::publishing::channels().await
}
#[tauri::command]
pub async fn integration_choose_video(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    tokio::task::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("게시 QA용 MP4 선택 · 최대 64 MiB")
            .add_filter("MP4 영상", &["mp4"])
            .blocking_pick_file();
        match selected {
            None => Ok(json!({"cancelled":true})),
            Some(file) => crate::publishing::select_file(
                &file.into_path().map_err(|_| "로컬 파일을 선택하세요.")?,
            ),
        }
    })
    .await
    .map_err(|_| "영상 선택 작업이 중단되었습니다.".to_string())?
}
#[tauri::command]
pub async fn integration_sample_video(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::publishing::make_sample().await
}
#[tauri::command]
pub async fn integration_prepare_upload(
    window: tauri::WebviewWindow,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::publishing::prepare(input).await
}
#[tauri::command]
pub async fn integration_upload(
    window: tauri::WebviewWindow,
    ticket_id: String,
    confirmed: bool,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::publishing::upload(ticket_id, confirmed).await
}
#[tauri::command]
pub fn integration_acknowledge_upload(
    window: tauri::WebviewWindow,
    attempt_id: String,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::publishing::acknowledge(&attempt_id)
}
