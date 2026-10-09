use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn asset_command(
    window: tauri::WebviewWindow,
    action: String,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    tokio::task::spawn_blocking(move || super::dispatch(&action, input))
        .await
        .map_err(|_| "에셋 작업을 완료하지 못했습니다.".to_owned())?
}

#[tauri::command]
pub async fn asset_choose_folder(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    purpose: String,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    if !["video", "project"].contains(&purpose.as_str()) {
        return Err("저장 용도를 확인하세요.".into());
    }
    tokio::task::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("에셋 저장 폴더 선택")
            .blocking_pick_folder();
        match selected {
            None => Ok(json!({"cancelled":true})),
            Some(selected) => {
                let path = selected
                    .into_path()
                    .map_err(|_| "로컬 폴더를 선택하세요.".to_owned())?;
                let key = if purpose == "video" {
                    "videoRoot"
                } else {
                    "projectRoot"
                };
                let mut input = json!({});
                input[key] = json!(path);
                super::dispatch("settings", input)
            }
        }
    })
    .await
    .map_err(|_| "폴더 선택을 완료하지 못했습니다.".to_owned())?
}

#[tauri::command]
pub async fn asset_choose_files(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    crate::updater::authorize(&window)?;
    tokio::task::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("기존 이미지·3D 에셋 가져오기")
            .add_filter(
                "이미지 및 3D 에셋",
                &["png", "jpg", "jpeg", "webp", "ico", "glb", "obj", "stl"],
            )
            .blocking_pick_files();
        selected
            .unwrap_or_default()
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|_| "로컬 파일을 선택하세요.".into())
            })
            .collect()
    })
    .await
    .map_err(|_| "파일 선택을 완료하지 못했습니다.".to_owned())?
}

#[tauri::command]
pub async fn asset_reveal(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    let path = tokio::task::spawn_blocking(move || super::output_path(&id))
        .await
        .map_err(|_| "에셋 경로를 확인하지 못했습니다.".to_owned())??;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|_| "파일 위치를 열지 못했습니다.".into())
}
