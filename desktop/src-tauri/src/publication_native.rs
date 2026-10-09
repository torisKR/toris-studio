use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

fn check(
    window: &tauri::WebviewWindow,
    updates: &crate::updater::UpdateController,
) -> Result<(), String> {
    crate::updater::authorize(window)?;
    if updates.installing() {
        return Err("업데이트 설치가 끝난 뒤 게시 작업을 진행하세요.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn publication_list(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::publications::list(&state.config_snapshot().await).await
}
#[tauri::command]
pub async fn publication_get(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    id: String,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::publications::get(&state.config_snapshot().await, &id).await
}
#[tauri::command]
pub async fn publication_save(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    updates: State<'_, Arc<crate::updater::UpdateController>>,
    input: Value,
) -> Result<Value, String> {
    check(&window, &updates)?;
    crate::publications::save(&state.config_snapshot().await, input).await
}
#[tauri::command]
pub async fn publication_preflight(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    updates: State<'_, Arc<crate::updater::UpdateController>>,
    input: Value,
) -> Result<Value, String> {
    check(&window, &updates)?;
    crate::publications::preflight(&state.config_snapshot().await, input).await
}
#[tauri::command]
pub async fn publication_submit(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    updates: State<'_, Arc<crate::updater::UpdateController>>,
    input: Value,
) -> Result<Value, String> {
    check(&window, &updates)?;
    let saved = crate::publications::submit(&state.config_snapshot().await, input).await?;
    crate::PUBLICATION_WAKE.notify_one();
    Ok(saved)
}
#[tauri::command]
pub async fn publication_cancel(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    updates: State<'_, Arc<crate::updater::UpdateController>>,
    input: Value,
) -> Result<Value, String> {
    check(&window, &updates)?;
    crate::publications::cancel(&state.config_snapshot().await, input).await
}
#[tauri::command]
pub async fn publication_retry(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    updates: State<'_, Arc<crate::updater::UpdateController>>,
    input: Value,
) -> Result<Value, String> {
    check(&window, &updates)?;
    let saved = crate::publications::retry(&state.config_snapshot().await, input).await?;
    crate::PUBLICATION_WAKE.notify_one();
    Ok(saved)
}
#[tauri::command]
pub async fn publication_reconcile(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
    updates: State<'_, Arc<crate::updater::UpdateController>>,
    input: Value,
) -> Result<Value, String> {
    check(&window, &updates)?;
    crate::publications::reconcile(&state.config_snapshot().await, input).await
}
#[tauri::command]
pub async fn publication_accounts(
    window: tauri::WebviewWindow,
    platform: Option<String>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    crate::publishing_adapters::accounts(platform.as_deref()).await
}
#[tauri::command]
pub async fn publication_begin_login(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    platform: String,
) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    crate::updater::authorize(&window)?;
    let mut result = crate::oauth::begin_publish_login(platform).await?;
    let url = result["authorizationUrl"]
        .as_str()
        .ok_or("게시 권한 승인 주소를 확인하지 못했습니다.")?;
    let parsed = url::Url::parse(url).map_err(|_| "게시 권한 승인 주소 오류")?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("게시 권한 승인 주소 오류".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "브라우저를 열지 못했습니다.")?;
    result
        .as_object_mut()
        .ok_or("OAuth 응답 형식 오류")?
        .remove("authorizationUrl");
    Ok(result)
}
#[tauri::command]
pub fn publication_scheduler_status(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    Ok(crate::publications::scheduler_status())
}
#[tauri::command]
pub fn publication_set_paused(window: tauri::WebviewWindow, paused: bool) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let status = crate::publications::set_pause(paused)?;
    crate::PUBLICATION_WAKE.notify_one();
    Ok(status)
}
fn render_path(id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(id).map_err(|_| "렌더 파일 ID 형식 오류")?;
    let root = crate::config::config_path()
        .parent()
        .ok_or("렌더 폴더 오류")?
        .join("renders");
    let root = root
        .canonicalize()
        .map_err(|_| "기존 로컬 렌더 파일이 없습니다.")?;
    let path = root.join(format!("{id}.mp4"));
    if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) {
        return Err("로컬 렌더 파일을 확인하세요.".into());
    }
    let path = path
        .canonicalize()
        .map_err(|_| "로컬 렌더 파일 확인 실패")?;
    if !path.starts_with(root) {
        return Err("허용한 렌더 폴더 밖의 파일입니다.".into());
    }
    Ok(path)
}
#[tauri::command]
pub async fn publication_media_sources(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    tokio::task::spawn_blocking(||{
        let root=crate::config::config_path().parent().ok_or("렌더 폴더 오류")?.join("renders");
        let mut renders=Vec::new();
        if let Ok(entries)=std::fs::read_dir(root) {for entry in entries.flatten().take(200) {
            let name=entry.file_name();let name=name.to_string_lossy();
            if let Some(id)=name.strip_suffix(".mp4") {if render_path(id).is_ok(){renders.push(json!({"id":id,"title":format!("로컬 렌더 · {}",id.chars().take(8).collect::<String>())}));}}
        }}
        let library=crate::assets::dispatch("snapshot",json!({"kind":"image","limit":120}))?;
        let assets:Vec<Value>=library["assets"].as_array().unwrap_or(&Vec::new()).iter().filter_map(|asset|{
            let id=asset["id"].as_str()?;let path=crate::assets::output_path(id).ok()?;
            if !matches!(path.extension().and_then(|v|v.to_str()),Some("png"|"jpg"|"jpeg"|"webp")){return None;}
            Some(json!({"id":id,"title":asset["title"]}))
        }).collect();Ok(json!({"renders":renders,"assets":assets}))
    }).await.map_err(|_|"게시 미디어 목록을 확인하지 못했습니다.".to_string())?
}
#[tauri::command]
pub async fn publication_import_media(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let kind = input["kind"]
        .as_str()
        .ok_or("미디어 종류를 선택하세요.")?
        .to_string();
    if !["video", "thumbnail"].contains(&kind.as_str()) {
        return Err("미디어 종류 오류".into());
    }
    let path = match input["source"].as_str().unwrap_or("picker") {
        "asset" if kind == "thumbnail" => {
            let id = input["id"]
                .as_str()
                .ok_or("에셋을 선택하세요.")?
                .to_string();
            Some(
                tokio::task::spawn_blocking(move || crate::assets::output_path(&id))
                    .await
                    .map_err(|_| "에셋 선택 실패")??,
            )
        }
        "render" if kind == "video" => Some(render_path(
            input["id"].as_str().ok_or("렌더 파일을 선택하세요.")?,
        )?),
        "picker" => {
            let video = kind == "video";
            tokio::task::spawn_blocking(move || {
                let mut dialog = app.dialog().file().set_title(if video {
                    "게시할 MP4 선택"
                } else {
                    "게시 썸네일 선택"
                });
                dialog = if video {
                    dialog.add_filter("MP4 영상", &["mp4"])
                } else {
                    dialog.add_filter("커버 이미지", &["png", "jpg", "jpeg", "webp"])
                };
                dialog
                    .blocking_pick_file()
                    .map(|selected| {
                        selected
                            .into_path()
                            .map_err(|_| "로컬 파일을 선택하세요.".to_string())
                    })
                    .transpose()
            })
            .await
            .map_err(|_| "파일 선택 실패")??
        }
        _ => return Err("게시 미디어 선택 경로를 확인하세요.".into()),
    };
    match path {
        Some(path) => crate::publication_media::import(&path, &kind).await,
        None => Ok(json!({"cancelled":true})),
    }
}
#[tauri::command]
pub async fn publication_preview_media(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    let (path, metadata) = tokio::task::spawn_blocking(move || {
        Ok::<_, String>((
            crate::publication_media::private_path(&id)?,
            crate::publication_media::metadata(&id)?,
        ))
    })
    .await
    .map_err(|_| "미리보기 파일 확인 실패")??;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|_| "미리보기 파일 권한 오류")?;
    Ok(json!({"path":path,"kind":metadata["kind"],"mimeType":metadata["mime"]}))
}
#[tauri::command]
pub async fn publication_ai_request(
    window: tauri::WebviewWindow,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    tokio::task::spawn_blocking(move || crate::chatgpt_drafts::request(input))
        .await
        .map_err(|_| "ChatGPT 초안 요청 저장 실패".to_string())?
}
#[tauri::command]
pub async fn publication_ai_drafts(window: tauri::WebviewWindow) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    tokio::task::spawn_blocking(crate::chatgpt_drafts::list)
        .await
        .map_err(|_| "ChatGPT 초안 조회 실패".to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn render_ids_cannot_supply_filesystem_paths() {
        for id in ["../../secret", "/tmp/private.mp4", "x%2f.."] {
            assert!(super::render_path(id).is_err());
        }
    }
}
