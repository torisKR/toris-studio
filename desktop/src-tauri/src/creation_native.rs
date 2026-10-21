use serde_json::{json, Value};
fn guard(window: &tauri::WebviewWindow) -> Result<(), String> {
    crate::updater::authorize(window)
}
#[tauri::command]
pub fn creation_bridge_info(window: tauri::WebviewWindow) -> Result<Value, String> {
    guard(&window)?;
    crate::creation::bridge_info()
}
#[tauri::command]
pub fn creation_request_create(
    window: tauri::WebviewWindow,
    input: Value,
) -> Result<Value, String> {
    guard(&window)?;
    crate::creation::create(input)
}
#[tauri::command]
pub fn creation_request_list(window: tauri::WebviewWindow) -> Result<Value, String> {
    guard(&window)?;
    crate::creation::list()
}
#[tauri::command]
pub fn creation_request_get(
    window: tauri::WebviewWindow,
    input: crate::creation::RequestInput,
) -> Result<Value, String> {
    guard(&window)?;
    Ok(json!({"request":crate::creation::get(&input.request_id)?}))
}
#[tauri::command]
pub fn creation_request_cancel(
    window: tauri::WebviewWindow,
    input: Value,
) -> Result<Value, String> {
    guard(&window)?;
    Ok(json!({"request":crate::creation::cancel(input)?}))
}
