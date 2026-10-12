//! One read-only, app-local video window; no preview IPC or global file grants.
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub const PREVIEW_LABEL: &str = "render-preview";
pub const PREVIEW_SCHEME: &str = "toris-preview";
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NativeActivity {
    #[default]
    Idle,
    Busy,
    Progress {
        current: u64,
        total: u64,
    },
}

#[derive(Default)]
struct Activities {
    main: bool,
    update: NativeActivity,
}
impl Activities {
    fn effective(&self) -> NativeActivity {
        match self.update {
            NativeActivity::Idle if self.main => NativeActivity::Busy,
            activity => activity,
        }
    }
}

fn open_render(path: &Path, roots: &[PathBuf]) -> Result<File, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("영상 경로 오류")?;
    let id = name
        .strip_suffix(".mp4")
        .ok_or("로컬 MP4만 미리볼 수 있습니다.")?;
    let id = uuid::Uuid::parse_str(id).map_err(|_| "Rust가 출력한 MP4만 미리볼 수 있습니다.")?;
    if name != format!("{id}.mp4") {
        return Err("렌더 파일 이름 오류".into());
    }
    let original = std::fs::symlink_metadata(path).map_err(|_| "영상 파일을 찾을 수 없습니다.")?;
    if !original.is_file() || original.file_type().is_symlink() {
        return Err("일반 영상 파일만 미리볼 수 있습니다.".into());
    }
    let actual = path.canonicalize().map_err(|_| "영상 경로 확인 실패")?;
    if !roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| actual.parent() == Some(root.as_path()))
    {
        return Err("허용한 렌더 폴더 밖의 파일입니다.".into());
    }
    let file = File::open(&actual).map_err(|_| "영상 파일을 열 수 없습니다.")?;
    let opened = file.metadata().map_err(|_| "영상 파일 확인 실패")?;
    if !opened.is_file() || opened.len() == 0 || opened.len() > MAX_FILE_BYTES {
        return Err("미리보기 영상 크기 오류".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if original.dev() != opened.dev() || original.ino() != opened.ino() {
            return Err("영상 파일이 변경되었습니다.".into());
        }
    }
    Ok(file)
}

fn byte_range(range: Option<&str>, size: u64) -> Result<(u64, u64), ()> {
    let number = |value: &str| {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(());
        }
        value.parse::<u64>().map_err(|_| ())
    };
    if size == 0 {
        return Err(());
    }
    let (start, end) = match range {
        None => (0, size - 1),
        Some(value) if value.len() <= 128 => {
            let value = value.strip_prefix("bytes=").ok_or(())?;
            let (first, last) = value.split_once('-').ok_or(())?;
            if first.is_empty() {
                let suffix = number(last)?;
                if suffix == 0 {
                    return Err(());
                }
                (size.saturating_sub(suffix), size - 1)
            } else {
                let start = number(first)?;
                let end = if last.is_empty() {
                    size - 1
                } else {
                    number(last)?
                };
                (start, end.min(size - 1))
            }
        }
        _ => return Err(()),
    };
    if start >= size || end < start {
        return Err(());
    }
    Ok((start, end.min(start.saturating_add(MAX_CHUNK_BYTES - 1))))
}

#[cfg(feature = "desktop")]
use tauri::{Manager, State};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewInfo {
    key: String,
    title: String,
    file_size: u64,
}
struct Selection {
    info: PreviewInfo,
    file: Arc<Mutex<File>>,
    generation: String,
}

fn clear_generation(selection: &mut Option<Selection>, generation: &str) {
    if selection
        .as_ref()
        .is_some_and(|item| item.generation == generation)
    {
        *selection = None;
    }
}

fn selected_resource<'a>(
    selection: Option<&'a Selection>,
    label: &str,
    path: &str,
) -> Option<&'a Selection> {
    if label != PREVIEW_LABEL {
        return None;
    }
    selection.filter(|item| path.strip_prefix('/') == Some(item.info.key.as_str()))
}
#[cfg(feature = "desktop")]
pub struct NativeWindows {
    selection: Mutex<Option<Selection>>,
    activities: Mutex<Activities>,
    open_gate: tokio::sync::Mutex<()>,
    reads: Arc<tokio::sync::Semaphore>,
}
#[cfg(feature = "desktop")]
impl Default for NativeWindows {
    fn default() -> Self {
        Self {
            selection: Mutex::new(None),
            activities: Mutex::new(Activities::default()),
            open_gate: tokio::sync::Mutex::new(()),
            reads: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }
}

#[cfg(feature = "desktop")]
fn document_allowed(url: &url::Url) -> bool {
    let origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http"
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none())
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1420));
    origin
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && matches!(url.path(), "/" | "/index.html")
}

#[cfg(feature = "desktop")]
fn preview_script(info: &PreviewInfo) -> String {
    format!("window.__TORIS_RENDER_PREVIEW__={};window.dispatchEvent(new Event('toris-native-preview-change'));", serde_json::to_string(info).unwrap())
}

#[cfg(feature = "desktop")]
fn apply_progress(app: &tauri::AppHandle, activity: NativeActivity) {
    use tauri::window::{ProgressBarState, ProgressBarStatus};
    if let Some(window) = app.get_webview_window("main") {
        let (status, progress) = match activity {
            NativeActivity::Idle => (ProgressBarStatus::None, None),
            NativeActivity::Busy => (ProgressBarStatus::Indeterminate, Some(0)),
            NativeActivity::Progress { current, total } if total > 0 => (
                ProgressBarStatus::Normal,
                Some(((current.min(total) as u128 * 100) / total as u128) as u64),
            ),
            NativeActivity::Progress { .. } => (ProgressBarStatus::Indeterminate, Some(0)),
        };
        let _ = window.set_progress_bar(ProgressBarState {
            status: Some(status),
            progress,
        });
        // macOS treats indeterminate bars as normal bars. A native Dock badge
        // makes an unknown-duration task visible without inventing a percentage.
        #[cfg(target_os = "macos")]
        let _ = window.set_badge_label(match activity {
            NativeActivity::Busy | NativeActivity::Progress { total: 0, .. } => {
                Some("작업 중".into())
            }
            _ => None,
        });
    }
}

#[cfg(feature = "desktop")]
pub fn set_update_activity(app: &tauri::AppHandle, activity: NativeActivity) {
    let state = app.state::<Arc<NativeWindows>>();
    let mut activities = state
        .activities
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    activities.update = activity;
    apply_progress(app, activities.effective());
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub fn set_main_activity(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Arc<NativeWindows>>,
    active: bool,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    let mut activities = state.activities.lock().map_err(|_| "작업 상태 확인 실패")?;
    activities.main = active;
    apply_progress(&app, activities.effective());
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn native_open_render_preview(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Arc<NativeWindows>>,
    path: String,
) -> Result<(), String> {
    crate::updater::authorize(&window)?;
    if path.len() > 4096 {
        return Err("영상 경로가 너무 깁니다.".into());
    }
    if app
        .state::<Arc<crate::updater::UpdateController>>()
        .installing()
    {
        return Err("업데이트 설치가 끝난 뒤 미리보기를 여세요.".into());
    }
    let _gate = state
        .open_gate
        .try_lock()
        .map_err(|_| "미리보기 창을 여는 중입니다.")?;
    let roots = [
        crate::config::project_root().join("public/renders"),
        crate::config::config_path()
            .parent()
            .ok_or("렌더 폴더 오류")?
            .join("renders"),
    ];
    let file = open_render(Path::new(&path), &roots)?;
    let info = PreviewInfo {
        key: uuid::Uuid::new_v4().simple().to_string(),
        title: format!(
            "MP4 · {}",
            Path::new(&path)
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .chars()
                .take(8)
                .collect::<String>()
        ),
        file_size: file.metadata().map_err(|_| "영상 크기 확인 실패")?.len(),
    };
    let existing = app.get_webview_window(PREVIEW_LABEL);
    let generation = if existing.is_some() {
        state
            .selection
            .lock()
            .map_err(|_| "미리보기 상태 확인 실패")?
            .as_ref()
            .map(|item| item.generation.clone())
            .ok_or("미리보기 창이 닫히는 중입니다. 다시 여세요.")?
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let previous = state
        .selection
        .lock()
        .map_err(|_| "미리보기 상태 저장 실패")?
        .replace(Selection {
            info: info.clone(),
            file: Arc::new(Mutex::new(file)),
            generation: generation.clone(),
        });
    if let Some(preview) = existing {
        if preview.eval(preview_script(&info)).is_err() {
            let mut selection = state.selection.lock().map_err(|_| "미리보기 정리 실패")?;
            // Do not resurrect a file after the window's destroy callback clears it.
            if selection
                .as_ref()
                .is_some_and(|item| item.info.key == info.key)
            {
                *selection = previous;
            }
            return Err("미리보기 갱신 실패".into());
        }
        let _ = preview.show();
        let _ = preview.unminimize();
        let _ = preview.set_focus();
        return Ok(());
    }
    let page_state = state.inner().clone();
    let result =
        tauri::WebviewWindowBuilder::new(
            &app,
            PREVIEW_LABEL,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Toris Studio · 영상 미리보기")
        .visible(false)
        .inner_size(1040.0, 760.0)
        .min_inner_size(480.0, 420.0)
        .initialization_script(preview_script(&info))
        .on_navigation(document_allowed)
        .on_page_load(move |preview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && document_allowed(payload.url())
            {
                if let Some(selection) = page_state.selection.lock().ok().and_then(|selection| {
                    selection.as_ref().map(|selection| selection.info.clone())
                }) {
                    let _ = preview.eval(preview_script(&selection));
                }
            }
        })
        .build();
    match result {
        Ok(preview) => {
            let close_state = state.inner().clone();
            preview.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    if let Ok(mut selection) = close_state.selection.lock() {
                        clear_generation(&mut selection, &generation);
                    }
                }
            });
            if preview.show().is_err() {
                let _ = preview.close();
                return Err("미리보기 창을 표시할 수 없습니다.".into());
            }
            let _ = preview.set_focus();
            Ok(())
        }
        Err(_) => {
            *state.selection.lock().map_err(|_| "미리보기 정리 실패")? = None;
            Err("미리보기 창을 열 수 없습니다.".into())
        }
    }
}

#[cfg(feature = "desktop")]
pub fn protocol(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    use tauri::http::{header, Response};
    let denied = |code| {
        Response::builder()
            .status(code)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Vec::<u8>::new())
            .unwrap()
    };
    if context.webview_label() != PREVIEW_LABEL
        || !matches!(request.method().as_str(), "GET" | "HEAD")
        || request.uri().query().is_some()
    {
        responder.respond(denied(403));
        return;
    }
    let state = context.app_handle().state::<Arc<NativeWindows>>();
    let selection = state.selection.lock().ok().and_then(|selection| {
        selected_resource(
            selection.as_ref(),
            context.webview_label(),
            request.uri().path(),
        )
        .map(|selection| (selection.file.clone(), selection.info.file_size))
    });
    let Some((file, size)) = selection else {
        responder.respond(denied(404));
        return;
    };
    let Ok(permit) = state.reads.clone().try_acquire_owned() else {
        responder.respond(denied(429));
        return;
    };
    let range = match request
        .headers()
        .get(header::RANGE)
        .map(|value| value.to_str())
        .transpose()
    {
        Ok(range) => range,
        Err(_) => {
            responder.respond(denied(416));
            return;
        }
    };
    let Ok((start, end)) = byte_range(range, size) else {
        responder.respond(
            Response::builder()
                .status(416)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Vec::<u8>::new())
                .unwrap(),
        );
        return;
    };
    let head = request.method() == tauri::http::Method::HEAD;
    let has_range = range.is_some();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let _permit = permit;
        let mut body = Vec::new();
        if !head {
            let result = file.lock().map_err(|_| ()).and_then(|mut file| {
                file.seek(SeekFrom::Start(start)).map_err(|_| ())?;
                (&mut *file)
                    .take(end - start + 1)
                    .read_to_end(&mut body)
                    .map_err(|_| ())?;
                if body.len() as u64 != end - start + 1 {
                    return Err(());
                }
                Ok(())
            });
            if result.is_err() {
                responder.respond(
                    Response::builder()
                        .status(500)
                        .body(Vec::<u8>::new())
                        .unwrap(),
                );
                return;
            }
        }
        let partial = has_range || (!head && end + 1 < size);
        let mut response = Response::builder()
            .status(if partial { 206 } else { 200 })
            .header(header::CONTENT_TYPE, "video/mp4")
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header(
                header::CONTENT_LENGTH,
                if head && !partial {
                    size
                } else {
                    end - start + 1
                },
            );
        if partial {
            response =
                response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
        }
        responder.respond(response.body(body).unwrap());
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_progress_never_clears_ordinary_activity() {
        let mut activities = Activities {
            main: true,
            update: NativeActivity::Progress {
                current: 4,
                total: 10,
            },
        };
        assert_eq!(activities.effective(), activities.update);
        activities.main = false;
        assert_eq!(activities.effective(), activities.update);
        activities.main = true;
        activities.update = NativeActivity::Idle;
        assert_eq!(activities.effective(), NativeActivity::Busy);
        activities.main = false;
        assert_eq!(activities.effective(), NativeActivity::Idle);
    }
    #[test]
    fn ranges_are_single_bounded_and_checked() {
        assert_eq!(
            byte_range(None, MAX_FILE_BYTES),
            Ok((0, MAX_CHUNK_BYTES - 1))
        );
        assert_eq!(byte_range(Some("bytes=8-"), 16), Ok((8, 15)));
        assert_eq!(byte_range(Some("bytes=-4"), 16), Ok((12, 15)));
        assert_eq!(
            byte_range(Some("bytes=4194304-"), 8 * MAX_CHUNK_BYTES),
            Ok((4 * MAX_CHUNK_BYTES, 5 * MAX_CHUNK_BYTES - 1))
        );
        for range in [
            "bytes=0-4,8-9",
            "bytes=16-",
            "bytes=8-4",
            "bytes=-0",
            "bytes=+0-",
            "bytes=0-+1",
            "bytes=18446744073709551616-",
        ] {
            assert!(byte_range(Some(range), 16).is_err());
        }
    }
    #[test]
    fn only_uuid_mp4_in_exact_render_root_can_be_opened() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let name = format!("{}.mp4", uuid::Uuid::new_v4());
        let file = root.path().join(&name);
        std::fs::write(&file, b"mp4 fixture").unwrap();
        assert!(open_render(&file, &[root.path().to_owned()]).is_ok());
        assert!(open_render(&file, &[outside.path().to_owned()]).is_err());
        let bad = root.path().join("other.mp4");
        std::fs::write(&bad, b"mp4").unwrap();
        assert!(open_render(&bad, &[root.path().to_owned()]).is_err());
        #[cfg(unix)]
        {
            let link = root.path().join(format!("{}.mp4", uuid::Uuid::new_v4()));
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(open_render(&link, &[root.path().to_owned()]).is_err());
        }
    }

    #[test]
    fn resource_is_scoped_to_current_preview_and_file_handle_is_released() {
        let make = |key: &str, generation: &str| Selection {
            info: PreviewInfo {
                key: key.into(),
                title: "MP4".into(),
                file_size: 4,
            },
            file: Arc::new(Mutex::new(tempfile::tempfile().unwrap())),
            generation: generation.into(),
        };
        let mut selected = Some(make("first", "window-one"));
        let old_file = Arc::downgrade(&selected.as_ref().unwrap().file);
        assert!(selected_resource(selected.as_ref(), "main", "/first").is_none());
        assert!(selected_resource(selected.as_ref(), PREVIEW_LABEL, "/other").is_none());
        assert!(selected_resource(selected.as_ref(), PREVIEW_LABEL, "/first/../first").is_none());
        assert!(selected_resource(selected.as_ref(), PREVIEW_LABEL, "/first").is_some());
        selected = Some(make("second", "window-two"));
        assert!(
            old_file.upgrade().is_none(),
            "replacing a video must close the old handle"
        );
        assert!(selected_resource(selected.as_ref(), PREVIEW_LABEL, "/first").is_none());
        let new_file = Arc::downgrade(&selected.as_ref().unwrap().file);
        clear_generation(&mut selected, "window-one");
        assert!(
            selected.is_some(),
            "late destruction must not clear a reopened window"
        );
        clear_generation(&mut selected, "window-two");
        assert!(selected.is_none());
        assert!(new_file.upgrade().is_none());
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn preview_document_cannot_navigate_to_remote_or_arbitrary_local_routes() {
        for url in ["tauri://localhost/index.html", "http://tauri.localhost/"] {
            assert!(document_allowed(&url.parse().unwrap()));
        }
        for url in [
            "https://example.com/",
            "tauri://localhost/index.html?path=other",
            "tauri://localhost/other.html",
            "http://tauri.localhost.evil/",
            "http://user@tauri.localhost/",
            "http://127.0.0.1:9999/",
        ] {
            assert!(!document_allowed(&url.parse().unwrap()));
        }
    }
}
