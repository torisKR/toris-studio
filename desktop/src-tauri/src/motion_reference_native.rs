//! IPC for motion references. Paths picked in the OS dialog stay in Rust; the window receives
//! only the closed reference data.
use crate::motion_reference as reference;
use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;

fn check(window: &tauri::WebviewWindow) -> Result<(), String> {
    crate::updater::authorize(window)
}
fn name_of(input: &Value) -> Result<String, String> {
    input["name"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty() && n.chars().count() <= 40)
        .map(str::to_owned)
        .ok_or_else(|| "레퍼런스 이름은 1~40자로 입력하세요.".into())
}

#[tauri::command]
pub fn motion_reference_list(window: tauri::WebviewWindow) -> Result<Value, String> {
    check(&window)?;
    let (references, skipped) = reference::list_at(&reference::root_dir()?)?;
    Ok(json!({"references": references, "skipped": skipped}))
}

/// Saves the feel of the current Motion Studio project. Text and data never leave the project.
#[tauri::command]
pub fn motion_reference_from_project(
    window: tauri::WebviewWindow,
    input: Value,
) -> Result<Value, String> {
    check(&window)?;
    let r = reference::from_project(&input["project"], &name_of(&input)?)?;
    reference::save_at(&reference::root_dir()?, &r)?;
    Ok(json!(r))
}

/// Colours from a local image or video the user picks; speed and layout come from `base`.
#[tauri::command]
pub async fn motion_reference_from_media(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    input: Value,
) -> Result<Value, String> {
    check(&window)?;
    let name = name_of(&input)?;
    let root = reference::root_dir()?;
    let base = reference::get_at(
        &root,
        input["base"].as_str().unwrap_or(reference::DEFAULT_ID),
    )?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter(
            "이미지·영상",
            &[
                "png", "jpg", "jpeg", "webp", "mp4", "mov", "m4v", "webm", "mkv",
            ],
        )
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let Some(file) = rx.await.map_err(|_| "파일 선택 실패")? else {
        return Ok(json!({"cancelled": true}));
    };
    let path = file.into_path().map_err(|_| "로컬 파일을 선택하세요.")?;
    let r = reference::from_media(&path, &name, &base).await?;
    reference::save_at(&root, &r)?;
    Ok(json!(r))
}

#[tauri::command]
pub fn motion_reference_delete(
    window: tauri::WebviewWindow,
    input: Value,
) -> Result<Value, String> {
    check(&window)?;
    reference::delete_at(
        &reference::root_dir()?,
        input["id"].as_str().ok_or("레퍼런스 ID가 없습니다.")?,
    )?;
    Ok(json!({"deleted": true}))
}
