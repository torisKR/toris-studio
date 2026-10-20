use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;
fn check(window: &tauri::WebviewWindow) -> Result<(), String> {
    crate::updater::authorize(window)
}
#[tauri::command]
pub fn motion_request_create(window: tauri::WebviewWindow, input: Value) -> Result<Value, String> {
    check(&window)?;
    crate::motion_drafts::request(input)
}
#[tauri::command]
pub fn motion_request_list(window: tauri::WebviewWindow) -> Result<Value, String> {
    check(&window)?;
    crate::motion_drafts::list()
}
#[tauri::command]
pub fn motion_draft_apply(
    window: tauri::WebviewWindow,
    id: String,
    project: Value,
) -> Result<Value, String> {
    check(&window)?;
    crate::motion_drafts::apply(&id, project)
}
#[tauri::command]
pub fn motion_draft_preview(
    window: tauri::WebviewWindow,
    id: String,
    project: Value,
) -> Result<Value, String> {
    check(&window)?;
    let r = crate::motion_drafts::get(&id)?;
    if r["status"] != "received" || r["baseHash"] != crate::graphics::hash(&project) {
        return Err("편집 충돌: 현재 내용으로 다시 요청하세요.".into());
    }
    crate::graphics::apply_patch(&project, &r["draft"])
}
#[tauri::command]
pub fn motion_request_cancel(window: tauri::WebviewWindow, id: String) -> Result<Value, String> {
    check(&window)?;
    crate::motion_drafts::cancel(&id)
}
#[tauri::command]
pub async fn motion_preview(
    window: tauri::WebviewWindow,
    project: Value,
    index: usize,
    time: f64,
) -> Result<Value, String> {
    check(&window)?;
    {
        let permit = crate::graphics_render::try_preview_permit()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            crate::graphics_export::still(project, index, time)
        })
    }
    .await
    .map_err(|_| "미리보기 생성 실패")?
}
#[tauri::command]
pub async fn motion_preview_video(
    window: tauri::WebviewWindow,
    project: Value,
    index: usize,
) -> Result<Value, String> {
    check(&window)?;
    let _update = crate::keyword::lock_for_update().map_err(|_| "업데이트 작업 중입니다.")?;
    crate::graphics_export::preview(project, index).await
}
#[tauri::command]
pub async fn motion_import_image(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    check(&window)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter("이미지", &["png", "jpg", "jpeg", "webp"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let Some(file) = rx.await.map_err(|_| "파일 선택 실패")? else {
        return Ok(json!({"cancelled":true}));
    };
    let path = file.into_path().map_err(|_| "로컬 파일을 선택하세요.")?;
    tauri::async_runtime::spawn_blocking(move||{
        let meta=std::fs::metadata(&path).map_err(|_|"이미지 읽기 실패")?;if !meta.is_file()||meta.len()>32*1024*1024{return Err("이미지는 32MiB 이하입니다.".to_string())}
        let bytes=std::fs::read(path).map_err(|_|"이미지 읽기 실패")?;let format=image::guess_format(&bytes).map_err(|_|"이미지 형식 오류")?;
        if !matches!(format,image::ImageFormat::Png|image::ImageFormat::Jpeg|image::ImageFormat::WebP){return Err("PNG·JPEG·WebP 이미지를 선택하세요.".into())}
        let mut reader=image::ImageReader::with_format(std::io::Cursor::new(&bytes),format);let mut limits=image::Limits::default();limits.max_image_width=Some(8192);limits.max_image_height=Some(8192);limits.max_alloc=Some(128*1024*1024);reader.limits(limits);
        let image=reader.decode().map_err(|_|"이미지가 손상되었거나 크기를 초과합니다.")?;
        let root=crate::media::data_dir()?.join("motion-images");std::fs::create_dir_all(&root).map_err(|_|"이미지 저장 폴더 오류")?;
        let id=uuid::Uuid::new_v4().to_string();std::fs::write(root.join(format!("{id}.original")),bytes).map_err(|_|"원본 저장 실패")?;
        image.save(root.join(format!("{id}.png"))).map_err(|_|"편집 이미지 저장 실패")?;
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;std::fs::set_permissions(&root,std::fs::Permissions::from_mode(0o700)).map_err(|_|"이미지 폴더 권한 오류")?;}
        Ok(json!({"id":id,"width":image.width(),"height":image.height(),"description":"가져온 이미지"}))
    }).await.map_err(|_|"이미지 가져오기 실패")?
}
#[tauri::command]
pub async fn motion_save_video(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    path: String,
) -> Result<Value, String> {
    check(&window)?;
    let source = std::path::PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "출력 파일이 없습니다.")?;
    let root = crate::media::data_dir()?
        .join("renders")
        .canonicalize()
        .map_err(|_| "출력 폴더 오류")?;
    if !source.starts_with(root) || source.extension().is_none_or(|s| s != "mp4") {
        return Err("완성된 로컬 MP4만 저장할 수 있습니다.".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_file_name("toris-motion.mp4")
        .add_filter("MP4", &["mp4"])
        .save_file(move |file| {
            let _ = tx.send(file);
        });
    let Some(file) = rx.await.map_err(|_| "저장 파일 선택 실패")? else {
        return Ok(json!({"cancelled":true}));
    };
    let destination = file.into_path().map_err(|_| "저장 경로 오류")?;
    if source == destination {
        return Ok(json!({"path":source.to_string_lossy()}));
    }
    std::fs::copy(source, &destination).map_err(|_| "MP4 저장 실패")?;
    Ok(json!({"path":destination.to_string_lossy()}))
}
