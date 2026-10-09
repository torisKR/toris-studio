use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

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
) -> Result<crate::codexify_proxy::ProxyStatus, String> {
    crate::updater::authorize(&window)?;
    proxy.status().await
}
#[tauri::command]
pub async fn codexify_proxy_start(
    window: tauri::WebviewWindow,
    proxy: tauri::State<'_, std::sync::Arc<crate::codexify_proxy::ProxyController>>,
    runtime: tauri::State<'_, std::sync::Arc<crate::codexify_runtime::RuntimeController>>,
) -> Result<crate::codexify_proxy::ProxyStatus, String> {
    crate::updater::authorize(&window)?;
    proxy.start(runtime.status().await?.port).await
}
#[tauri::command]
pub async fn codexify_proxy_stop(
    window: tauri::WebviewWindow,
    proxy: tauri::State<'_, std::sync::Arc<crate::codexify_proxy::ProxyController>>,
) -> Result<crate::codexify_proxy::ProxyStatus, String> {
    crate::updater::authorize(&window)?;
    proxy.stop().await
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
