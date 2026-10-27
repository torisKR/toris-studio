#[cfg(feature = "desktop")]
mod agent_native;
pub mod agent_runtime;
pub mod ai;
pub mod analytics;
pub mod assets;
pub mod browser;
pub mod chatgpt_drafts;
pub mod config;
pub mod creation;
#[cfg(feature = "desktop")]
mod creation_native;
pub mod credentials;
pub mod graphics;
pub mod graphics_export;
pub mod graphics_render;
#[cfg(feature = "desktop")]
mod integration_native;
pub mod ipc_commands;
pub mod keyword;
pub mod legacy_cleanup;
pub mod mcp_bridge;
pub mod media;
pub mod media_runtime;
pub mod models;
pub mod motion;
pub mod motion_drafts;
#[cfg(feature = "desktop")]
mod motion_native;
#[cfg(any(feature = "desktop", test))]
pub mod native_windows;
pub mod oauth;
#[cfg(feature = "desktop")]
mod oauth_native;
pub mod planner;
#[cfg(feature = "desktop")]
mod planner_native;
pub mod publications;
pub mod shared_binary;
pub mod workspace_export;
#[cfg(feature = "desktop")]
static PUBLICATION_WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
pub mod hub;
#[cfg(feature = "desktop")]
mod hub_native;
pub mod ops;
#[cfg(feature = "desktop")]
mod ops_native;
pub mod ops_status;
pub mod publication_handoff;
pub mod publication_media;
#[cfg(feature = "desktop")]
mod publication_native;
pub mod publishing;
pub mod publishing_adapters;
pub mod scheduler;
pub mod social;
#[cfg(any(feature = "desktop", test))]
mod startup_smoke;
#[cfg(feature = "desktop")]
mod tray;
pub mod trends;
pub mod updater;
pub mod vault;
pub mod video_embed;
pub mod video_idea;
pub mod video_project_export;
pub mod video_research;
pub mod video_template_library;
pub mod video_templates;
pub mod youtube;

#[cfg(feature = "desktop")]
use serde_json::Value;
#[cfg(feature = "desktop")]
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

pub struct AppState {
    pub config: RwLock<config::AppConfig>,
    pub scheduler: Mutex<scheduler::SchedulerStatus>,
    pub trend_lock: Mutex<()>,
}
impl AppState {
    pub fn new(config: config::AppConfig) -> Self {
        let status = scheduler::initial_status(config.scheduler_enabled);
        Self {
            config: RwLock::new(config),
            scheduler: Mutex::new(status),
            trend_lock: Mutex::new(()),
        }
    }

    #[cfg(any(feature = "desktop", test))]
    pub(crate) async fn config_snapshot(&self) -> config::AppConfig {
        // End the read guard here, before an IPC command awaits external work.
        self.config.read().await.clone()
    }
}

#[cfg(any(feature = "desktop", test))]
fn merge_bootstrapped_database(
    current: &config::AppConfig,
    bootstrapped: &config::AppConfig,
) -> config::AppConfig {
    let mut next = current.clone();
    if next.database_url.is_none() {
        next.database_url = bootstrapped.database_url.clone();
    }
    next
}

#[cfg(feature = "desktop")]
mod desktop {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::{Manager, State};
    static EXIT_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
    static EXIT_READY: AtomicBool = AtomicBool::new(false);
    #[tauri::command]
    pub fn get_update_status(
        window: tauri::WebviewWindow,
        updates: State<'_, Arc<updater::UpdateController>>,
    ) -> Result<updater::UpdateStatus, String> {
        updater::authorize(&window)?;
        Ok(updates.status())
    }
    #[tauri::command]
    pub async fn check_for_updates(
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        updates: State<'_, Arc<updater::UpdateController>>,
    ) -> Result<updater::UpdateStatus, String> {
        updater::authorize(&window)?;
        updates.check(&app).await
    }
    #[tauri::command]
    pub async fn install_update(
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        updates: State<'_, Arc<updater::UpdateController>>,
        input: updater::InstallRequest,
    ) -> Result<updater::UpdateStatus, String> {
        updater::authorize(&window)?;
        updates.install(&app, input).await
    }
    #[tauri::command]
    pub fn cancel_update(
        window: tauri::WebviewWindow,
        updates: State<'_, Arc<updater::UpdateController>>,
    ) -> Result<updater::UpdateStatus, String> {
        updater::authorize(&window)?;
        updates.cancel()
    }
    #[tauri::command]
    pub async fn get_dashboard(
        state: State<'_, Arc<AppState>>,
    ) -> Result<models::SocialDashboard, String> {
        let config = state.config_snapshot().await;
        social::dashboard(&config).await
    }
    #[tauri::command]
    pub async fn create_channel(
        state: State<'_, Arc<AppState>>,
        input: Value,
    ) -> Result<models::SocialChannel, String> {
        let config = state.config_snapshot().await;
        social::create_channel(&config, &input).await
    }
    #[tauri::command]
    pub async fn create_content(
        state: State<'_, Arc<AppState>>,
        input: Value,
    ) -> Result<models::SocialContent, String> {
        let config = state.config_snapshot().await;
        social::create_content(&config, &input).await
    }
    #[tauri::command]
    pub async fn update_content(
        state: State<'_, Arc<AppState>>,
        id: String,
        input: Value,
    ) -> Result<models::SocialContent, String> {
        let config = state.config_snapshot().await;
        social::update_content(&config, &id, &input).await
    }
    #[tauri::command]
    pub async fn refresh_trends(
        state: State<'_, Arc<AppState>>,
        keyword: Option<String>,
    ) -> Result<models::TrendRefreshResult, String> {
        let _permit = state
            .trend_lock
            .try_lock()
            .map_err(|_| "이미 트렌드를 수집하고 있습니다.")?;
        let config = state.config_snapshot().await;
        social::refresh_trends(&config, keyword).await
    }
    #[tauri::command]
    pub async fn analytics_dispatch(
        window: tauri::WebviewWindow,
        state: State<'_, Arc<AppState>>,
        input: Value,
    ) -> Result<Value, String> {
        updater::authorize(&window)?;
        analytics::dispatch(&state.config_snapshot().await, input).await
    }
    #[tauri::command]
    pub async fn get_settings(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
        Ok(state.config.read().await.public())
    }
    #[tauri::command]
    pub fn get_keychain_status() -> Value {
        serde_json::json!({"blocked": vault::access_blocked()})
    }
    #[tauri::command]
    pub async fn retry_keychain_access(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
        // Serialize with settings saves; failed authorization never replaces live configuration.
        let mut current = state.config.write().await;
        let restored = tokio::task::spawn_blocking(|| {
            vault::retry_access();
            config::AppConfig::load()
        })
        .await
        .map_err(|_| "저장소 권한 확인을 완료하지 못했습니다.".to_owned())??;
        state.scheduler.lock().await.enabled = restored.scheduler_enabled;
        *current = restored;
        Ok(current.public())
    }
    #[tauri::command]
    pub async fn get_saved_collection_secret(
        state: State<'_, Arc<AppState>>,
        key: String,
    ) -> Result<Option<String>, String> {
        let config = state.config_snapshot().await;
        config.saved_collection_secret(&key)
    }
    #[tauri::command]
    pub async fn save_settings(
        state: State<'_, Arc<AppState>>,
        input: Value,
    ) -> Result<Value, String> {
        let mut current = state.config.write().await;
        let updated = current.updated(&input)?;
        updated.save()?;
        *current = updated;
        state.scheduler.lock().await.enabled = current.scheduler_enabled;
        Ok(current.public())
    }
    #[tauri::command]
    pub async fn get_scheduler_status(
        state: State<'_, Arc<AppState>>,
    ) -> Result<scheduler::SchedulerStatus, String> {
        Ok(state.scheduler.lock().await.clone())
    }
    #[tauri::command]
    pub async fn set_scheduler(
        state: State<'_, Arc<AppState>>,
        enabled: bool,
    ) -> Result<scheduler::SchedulerStatus, String> {
        let mut config = state.config.write().await;
        let mut next = config.clone();
        next.scheduler_enabled = enabled;
        next.save()?;
        *config = next;
        let mut status = state.scheduler.lock().await;
        status.enabled = enabled;
        Ok(status.clone())
    }
    #[tauri::command]
    pub async fn open_external(
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        updates: State<'_, Arc<updater::UpdateController>>,
        url: String,
        browser: Option<browser::BrowserChoice>,
    ) -> Result<(), String> {
        updater::authorize(&window)?;
        if updates.installing() {
            return Err("업데이트 설치가 끝난 뒤 링크를 여세요.".into());
        }
        use tauri_plugin_opener::OpenerExt;
        browser::open(url, browser, move |url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "시스템 기본 브라우저를 열지 못했습니다.".into())
        })
        .await
    }
    #[tauri::command]
    pub fn browser_runtime_status(
        window: tauri::WebviewWindow,
    ) -> Result<browser::BrowserStatus, String> {
        updater::authorize(&window)?;
        browser::status()
    }
    #[tauri::command]
    pub fn save_browser_preferences(
        window: tauri::WebviewWindow,
        input: browser::PreferencesInput,
    ) -> Result<browser::BrowserStatus, String> {
        updater::authorize(&window)?;
        browser::save_preferences(input)
    }
    #[tauri::command]
    pub fn copy_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        if text.chars().count() > 40000 {
            return Err("복사할 텍스트가 너무 큽니다.".into());
        }
        app.clipboard()
            .write_text(text)
            .map_err(|_| "클립보드에 복사할 수 없습니다.".into())
    }
    #[tauri::command]
    pub async fn start_database(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
        let snapshot = state.config_snapshot().await;
        let bootstrapped = ops::start_database(&snapshot).await?;
        let mut current = state.config.write().await;
        let next = merge_bootstrapped_database(&current, &bootstrapped);
        next.save()?;
        *current = next;
        Ok(serde_json::json!({"ok":true,"message":"로컬 PostgreSQL이 준비되었습니다."}))
    }
    #[tauri::command]
    pub async fn backup_database() -> Result<Value, String> {
        ops::backup_database().await
    }
    #[tauri::command]
    pub async fn start_keyword_crawler(
        window: tauri::WebviewWindow,
        updates: State<'_, Arc<updater::UpdateController>>,
    ) -> Result<Value, String> {
        updater::authorize(&window)?;
        if updates.installing() {
            return Err("업데이트 설치가 끝난 뒤 수집기를 시작하세요.".into());
        }
        ops::start_keyword_crawler().await
    }
    #[tauri::command]
    pub fn video_list_projects() -> Result<Value, String> {
        media::list_projects()
    }
    #[tauri::command]
    pub fn video_save_project(input: Value) -> Result<Value, String> {
        media::save_project(input)
    }
    #[tauri::command]
    pub fn video_template_catalog(
        window: tauri::WebviewWindow,
    ) -> Result<Vec<video_templates::TemplateDescriptor>, String> {
        updater::authorize(&window)?;
        Ok(video_templates::catalog())
    }
    #[tauri::command]
    pub fn video_template_preview(
        window: tauri::WebviewWindow,
        input: video_templates::CreateInput,
    ) -> Result<video_templates::PreviewResult, String> {
        updater::authorize(&window)?;
        video_templates::preview(input)
    }
    #[tauri::command]
    pub fn video_template_library_get(
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
    ) -> Result<video_template_library::TemplateLibraryState, String> {
        updater::authorize(&window)?;
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|_| "템플릿 저장 경로를 확인하세요.")?;
        video_template_library::get(&directory)
    }
    #[tauri::command]
    pub fn video_template_favorite(
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        template_id: String,
        enabled: bool,
    ) -> Result<video_template_library::TemplateLibraryState, String> {
        updater::authorize(&window)?;
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|_| "템플릿 저장 경로를 확인하세요.")?;
        video_template_library::set_favorite(&directory, &template_id, enabled)
    }
    #[tauri::command]
    pub fn video_template_record_use(
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        template_id: String,
    ) -> Result<video_template_library::TemplateLibraryState, String> {
        updater::authorize(&window)?;
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|_| "템플릿 저장 경로를 확인하세요.")?;
        video_template_library::record_use(&directory, &template_id)
    }
    #[tauri::command]
    pub async fn video_export_project(
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        updates: State<'_, Arc<updater::UpdateController>>,
        project: Value,
        format: String,
    ) -> Result<Option<String>, String> {
        use tauri_plugin_dialog::DialogExt;
        static EXPORT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        updater::authorize(&window)?;
        if updates.installing() {
            return Err("업데이트 설치가 끝난 뒤 내보내세요.".into());
        }
        let _guard = EXPORT_LOCK
            .try_lock()
            .map_err(|_| "현재 내보내기를 마친 뒤 다시 실행하세요.")?;
        let bytes = video_project_export::prepare(&project, &format)?;
        let extension = video_project_export::extension(&format)?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .set_parent(&window)
            .set_title("영상 스토리보드 내보내기")
            .set_file_name(format!("toris-video-storyboard.{extension}"))
            .add_filter("영상 스토리보드", &[extension])
            .save_file(move |file| {
                let _ = sender.send(file);
            });
        let Some(file) = receiver
            .await
            .map_err(|_| "파일 선택을 완료하지 못했습니다.")?
        else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|_| "로컬 저장 경로를 확인하세요.")?;
        tauri::async_runtime::spawn_blocking(move || {
            video_project_export::write_selected_file(&path, &format, &bytes)?;
            Ok(Some(path.to_string_lossy().into_owned()))
        })
        .await
        .map_err(|_| "스토리보드를 내보내지 못했습니다.")?
    }
    #[tauri::command]
    pub async fn video_research_preview(
        window: tauri::WebviewWindow,
        state: State<'_, Arc<AppState>>,
        input: video_research::PreviewInput,
    ) -> Result<video_research::ResearchPreview, String> {
        updater::authorize(&window)?;
        video_research::preview(&state.config_snapshot().await, input).await
    }
    #[tauri::command]
    pub async fn video_create_research_project(
        window: tauri::WebviewWindow,
        state: State<'_, Arc<AppState>>,
        updates: State<'_, Arc<updater::UpdateController>>,
        runtime: State<'_, Arc<agent_runtime::AgentRuntime>>,
        input: video_research::CreateInput,
    ) -> Result<video_research::ResearchResult, String> {
        updater::authorize(&window)?;
        if updates.installing() {
            return Err("업데이트 설치가 끝난 뒤 영상 초안을 만드세요.".into());
        }
        // Only the local draft and the Agent tab's content model are offered here.
        let provider = input.provider.as_deref().unwrap_or("local");
        if !matches!(provider, "local" | "agent-model") {
            return Err("기본 초안 또는 Agent 탭의 콘텐츠 작성 모델을 선택하세요.".into());
        }
        let runtime = runtime.inner().clone();
        let agent: video_research::AgentGenerate = Box::new(move |system, prompt| {
            Box::pin(async move {
                let result = runtime
                    .call("complete", serde_json::json!({"system": system, "prompt": prompt, "purpose": "content"}))
                    .await?;
                result["text"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "AI 응답이 비어 있습니다.".to_string())
            })
        });
        video_research::create(&state.config_snapshot().await, input, Some(agent)).await
    }
    #[tauri::command]
    pub async fn video_create_idea_project(
        window: tauri::WebviewWindow,
        updates: State<'_, Arc<updater::UpdateController>>,
        runtime: State<'_, Arc<agent_runtime::AgentRuntime>>,
        input: video_idea::CreateInput,
    ) -> Result<Value, String> {
        updater::authorize(&window)?;
        if updates.installing() {
            return Err("업데이트 설치가 끝난 뒤 영상 기획을 생성하세요.".into());
        }
        let runtime = runtime.inner().clone();
        video_idea::create(input, |system, prompt| async move {
            let result = runtime
                .call(
                    "complete",
                    serde_json::json!({"system": system, "prompt": prompt, "purpose": "content"}),
                )
                .await?;
            result["text"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "AI 응답이 비어 있습니다.".to_string())
        })
        .await
    }
    #[tauri::command]
    pub async fn video_render_project(
        window: tauri::WebviewWindow,
        project: Value,
        on_progress: tauri::ipc::Channel<media::RenderProgress>,
    ) -> Result<Value, String> {
        updater::authorize(&window)?;
        let observer: media::RenderObserver = Box::new(move |progress| {
            // Closing the UI must not abort a native render or lose its output.
            let _ = on_progress.send(progress);
        });
        media::render_project_with_progress(project, Some(observer)).await
    }
    #[tauri::command]
    pub async fn video_generate_voice(input: Value) -> Result<Value, String> {
        // Local Qwen3 TTS on 127.0.0.1:50010; no account or remote model involved.
        media::generate_voice(input).await
    }
    #[tauri::command]
    pub async fn media_status() -> Result<Value, String> {
        media::status().await
    }
    #[tauri::command]
    pub async fn youtube_lookup_channel(
        state: State<'_, Arc<AppState>>,
        input: Value,
    ) -> Result<Value, String> {
        let config = state.config_snapshot().await;
        youtube::lookup_channel(&config, input).await
    }
    #[tauri::command]
    pub async fn youtube_channel_videos(
        state: State<'_, Arc<AppState>>,
        channel_id: String,
    ) -> Result<Value, String> {
        let config = state.config_snapshot().await;
        youtube::channel_videos(&config, channel_id).await
    }
    #[tauri::command]
    pub async fn prepare_youtube_embed(video_id: String) -> Result<String, String> {
        video_embed::prepare(video_id).await
    }
    #[tauri::command]
    pub async fn get_keyword_status(
        window: tauri::WebviewWindow,
        state: State<'_, Arc<AppState>>,
    ) -> Result<Value, String> {
        updater::authorize(&window)?;
        Ok(keyword::status(&state.config_snapshot().await).await)
    }
    #[tauri::command]
    pub async fn search_keywords(
        window: tauri::WebviewWindow,
        state: State<'_, Arc<AppState>>,
        updates: State<'_, Arc<updater::UpdateController>>,
        input: keyword::SearchInput,
    ) -> Result<keyword::SearchResult, String> {
        updater::authorize(&window)?;
        if updates.installing() {
            return Err("업데이트 설치가 끝난 뒤 키워드 탐색을 실행하세요.".into());
        }
        let _permit = state
            .trend_lock
            .try_lock()
            .map_err(|_| "기존 트렌드 수집을 마친 뒤 실행하세요.")?;
        keyword::search(&state.config_snapshot().await, input).await
    }
    #[tauri::command]
    pub async fn get_content_keywords(
        window: tauri::WebviewWindow,
        state: State<'_, Arc<AppState>>,
        input: keyword::ContentInput,
    ) -> Result<keyword::ContentResult, String> {
        updater::authorize(&window)?;
        keyword::content(&state.config_snapshot().await, input).await
    }
    #[tauri::command]
    pub async fn get_keyword_runs(
        window: tauri::WebviewWindow,
        state: State<'_, Arc<AppState>>,
    ) -> Result<Vec<keyword::SearchRun>, String> {
        updater::authorize(&window)?;
        keyword::runs(&state.config_snapshot().await).await
    }
    #[tauri::command]
    pub async fn crawl_keyword_content(
        window: tauri::WebviewWindow,
        state: State<'_, Arc<AppState>>,
        updates: State<'_, Arc<updater::UpdateController>>,
        input: keyword::CrawlInput,
    ) -> Result<keyword::CrawlResult, String> {
        updater::authorize(&window)?;
        if updates.installing() {
            return Err("업데이트 설치가 끝난 뒤 콘텐츠를 수집하세요.".into());
        }
        keyword::crawl(&state.config_snapshot().await, input).await
    }
    #[tauri::command]
    pub fn cancel_keyword_search(window: tauri::WebviewWindow) -> Result<(), String> {
        updater::authorize(&window)?;
        keyword::cancel()
    }
    #[tauri::command]
    pub async fn oauth_status() -> Result<Value, String> {
        oauth::status().await
    }
    #[tauri::command]
    pub async fn oauth_save_client(platform: String, input: Value) -> Result<Value, String> {
        oauth::save_client(platform, input).await
    }
    #[tauri::command]
    pub async fn oauth_begin_login(
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        platform: String,
    ) -> Result<Value, String> {
        updater::authorize(&window)?;
        use tauri_plugin_opener::OpenerExt;
        oauth::finish_system_login(oauth::begin_login(platform).await?, |url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "시스템 기본 브라우저를 열지 못했습니다.".into())
        })
    }
    #[tauri::command]
    pub async fn oauth_complete_login(platform: String, input: Value) -> Result<Value, String> {
        oauth::complete_login(platform, input).await
    }
    #[tauri::command]
    pub async fn oauth_refresh_session(platform: String) -> Result<Value, String> {
        oauth::refresh_session(platform).await
    }
    #[tauri::command]
    pub async fn oauth_disconnect(platform: String) -> Result<Value, String> {
        oauth::disconnect(platform).await
    }
    #[tauri::command]
    pub fn open_rendered_video(app: tauri::AppHandle, path: String) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        let actual = std::fs::canonicalize(&path).map_err(|_| "영상 파일을 찾을 수 없습니다.")?;
        let root = config::project_root().join("public/renders");
        let fallback = config::config_path()
            .parent()
            .ok_or("로컬 저장 경로 오류")?
            .join("renders");
        let allowed = [root, fallback]
            .iter()
            .filter_map(|root| std::fs::canonicalize(root).ok())
            .any(|root| actual.starts_with(root));
        if !allowed || actual.extension().and_then(|v| v.to_str()) != Some("mp4") {
            return Err("Rust가 출력한 로컬 MP4만 열 수 있습니다.".into());
        }
        app.opener()
            .open_path(actual.to_string_lossy(), None::<&str>)
            .map_err(|_| "영상 플레이어를 열 수 없습니다.".into())
    }
    pub fn launch(config: config::AppConfig) {
        let state = Arc::new(AppState::new(config));
        tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                crate::tray::show(app)
            }))
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_clipboard_manager::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .manage(state.clone())
            .manage(updater::shared())
            .manage(agent_runtime::shared())
            .manage(Arc::new(native_windows::NativeWindows::default()))
            .register_asynchronous_uri_scheme_protocol(
                native_windows::PREVIEW_SCHEME,
                native_windows::protocol,
            )
            .on_window_event(|window, event| {
                use tauri::Manager;
                if window.label() == "main" {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if window
                            .app_handle()
                            .state::<Arc<updater::UpdateController>>()
                            .installing()
                        {
                            return;
                        }
                        let _ = window.hide();
                    }
                }
            })
            .setup(move |app| {
                crate::tray::setup(app)?;
                {
                    use tauri::{Emitter, Manager};
                    let handle = app.handle().clone();
                    app.state::<Arc<agent_runtime::AgentRuntime>>()
                        .set_emitter(Arc::new(move |event| {
                            let _ = handle.emit_to("main", "agent-event", event);
                        }));
                }
                // Independent from uploads: a resume during a long request must
                // still invalidate other reservations missed while asleep.
                tauri::async_runtime::spawn(async move {
                    loop {
                        crate::publications::heartbeat();
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    }
                });
                let publishing_state = state.clone();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri::Emitter;
                    let _ = crate::legacy_cleanup::retire().await;
                    let mut last_error = None;
                    let mut database = None;
                    let mut schema_ready = false;
                    let mut schema_attempt = None;
                    loop {
                        let config = publishing_state.config_snapshot().await;
                        if database != config.database_url {
                            database = config.database_url.clone();
                            schema_ready = false;
                            schema_attempt = None;
                        }
                        if config.database_url.is_some() {
                            let outcome = if !schema_ready
                                && schema_attempt.is_none_or(|last: std::time::Instant| {
                                    last.elapsed().as_secs() >= 60
                                }) {
                                schema_attempt = Some(std::time::Instant::now());
                                match crate::ops::migrate_configured_publications(&config).await {
                                    Ok(()) => {
                                        schema_ready = true;
                                        crate::publications::tick(&config).await
                                    }
                                    Err(message) => Err(message),
                                }
                            } else if schema_ready {
                                crate::publications::tick(&config).await
                            } else {
                                Ok(())
                            };
                            match outcome {
                                Err(message) => {
                                    if last_error.as_ref() != Some(&message) {
                                        let _ = app_handle.emit_to(
                                            "main",
                                            "publication-runtime-error",
                                            &message,
                                        );
                                        last_error = Some(message);
                                    }
                                }
                                Ok(()) if schema_ready => last_error = None,
                                Ok(()) => {}
                            }
                            let _ = app_handle.emit_to(
                                "main",
                                "publication-scheduler-status",
                                crate::publications::scheduler_status(),
                            );
                        }
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => {},
                            _ = crate::PUBLICATION_WAKE.notified() => {},
                        }
                    }
                });
                let calendar_state = state.clone();
                let ops_state = state.clone();
                let state = state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        scheduler::tick(state.clone()).await;
                        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    }
                });
                let analytics_state = app.state::<Arc<AppState>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let config = analytics_state.config_snapshot().await;
                        oauth_native::cleanup_disconnected(&config).await;
                        let _ = analytics::sync_due(&config).await;
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    }
                });
                tauri::async_runtime::spawn(async move {
                    loop {
                        let _ = oauth::refresh_due().await;
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    }
                });
                tauri::async_runtime::spawn(async move {
                    // Every 5 minutes; a missing DB or Google connection just records the reason.
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                        let _ = crate::planner_native::sync_once(&calendar_state).await;
                    }
                });
                tauri::async_runtime::spawn(async move {
                    // Read-only status every 15 minutes; failures are stored as error snapshots.
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(900)).await;
                        let _ = crate::ops_native::refresh_once(&ops_state).await;
                    }
                });
                Ok(())
            })
            .invoke_handler({
                macro_rules! registered_handler {
                    ($( [$($module:ident)::*] $command:ident, )*) => {
                        tauri::generate_handler![$($($module::)*$command),*]
                    };
                }
                crate::ipc_commands::app_command_registry!(registered_handler)
            })
            .build(tauri::generate_context!())
            .expect("Toris Studio application runtime failed")
            .run(|app, event| {
                if let tauri::RunEvent::Exit = event {
                    crate::publications::shutdown_media();
                    app.state::<Arc<agent_runtime::AgentRuntime>>().shutdown();
                }
                if let tauri::RunEvent::ExitRequested { ref api, code, .. } = event {
                    // The updater holds the publication barrier until this signed restart.
                    if code == Some(tauri::RESTART_EXIT_CODE)
                        && app.state::<Arc<updater::UpdateController>>().status().phase
                            == updater::UpdatePhase::Installed
                    {
                        return;
                    }
                    if EXIT_READY.load(Ordering::SeqCst) {
                        return;
                    }
                    if app.state::<Arc<updater::UpdateController>>().installing() {
                        // Never interrupt replacement of the signed application bundle.
                        api.prevent_exit();
                    } else if keyword::running() && keyword::cancel().is_err() && keyword::running()
                    {
                        api.prevent_exit();
                    } else if !crate::publications::begin_shutdown() {
                        api.prevent_exit();
                        crate::tray::show(app);
                        use tauri::Emitter;
                        let _ = app.emit_to(
                            "main",
                            "publication-runtime-error",
                            "게시 처리 중입니다. 전송 결과가 확인된 뒤 종료하세요.",
                        );
                    } else {
                        api.prevent_exit();
                        if !EXIT_IN_PROGRESS.swap(true, Ordering::SeqCst) {
                            let handle = app.clone();
                            let exit_code = code.unwrap_or(0);
                            tauri::async_runtime::spawn(async move {
                                match crate::browser::shutdown().await {
                                    Ok(()) => {
                                        EXIT_READY.store(true, Ordering::SeqCst);
                                        handle.exit(exit_code);
                                    }
                                    Err(error) => {
                                        crate::publications::cancel_shutdown();
                                        EXIT_IN_PROGRESS.store(false, Ordering::SeqCst);
                                        crate::tray::show(&handle);
                                        use tauri::Emitter;
                                        let _ =
                                            handle.emit_to("main", "browser-runtime-error", error);
                                    }
                                }
                            });
                        }
                    }
                }
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Reopen { .. } = event {
                    crate::tray::show(app);
                }
            });
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn pending_external_work_does_not_block_settings_write() {
        let state = Arc::new(AppState::new(config::AppConfig::default()));
        let task_state = state.clone();
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let pending_request = tokio::spawn(async move {
            let config = task_state.config_snapshot().await;
            started_tx.send(()).unwrap();
            // Represent an in-flight provider/DB response, without using real credentials.
            finish_rx.await.unwrap();
            config.opencodex_model
        });
        started_rx.await.unwrap();

        let write = tokio::time::timeout(Duration::from_millis(250), state.config.write()).await;
        let mut current = write.expect("a pending provider request must not retain a config guard");
        current.opencodex_model = "recent-model".into();
        current.opencodex_allowed_models = vec!["recent-model".into()];
        drop(current);
        finish_tx.send(()).unwrap();

        assert_eq!(pending_request.await.unwrap(), "gpt-6.1-sol");
        assert_eq!(
            state.config_snapshot().await.opencodex_model,
            "recent-model"
        );
    }

    #[test]
    fn database_bootstrap_preserves_settings_saved_while_it_was_running() {
        let mut original = config::AppConfig::default();
        original.youtube_api_key = Some("previous-value".into());
        let mut bootstrapped = original.clone();
        bootstrapped.database_url =
            Some("postgresql://toris_app:example@127.0.0.1:54329/toris_studio".into());
        let mut latest = original;
        latest.youtube_api_key = Some("recent-value".into());
        latest.opencodex_model = "recent-model".into();
        latest.opencodex_allowed_models = vec!["recent-model".into()];
        latest.scheduler_enabled = true;

        let merged = merge_bootstrapped_database(&latest, &bootstrapped);
        assert_eq!(merged.database_url, bootstrapped.database_url);
        assert_eq!(merged.youtube_api_key, latest.youtube_api_key);
        assert_eq!(merged.opencodex_model, latest.opencodex_model);
        assert_eq!(
            merged.opencodex_allowed_models,
            latest.opencodex_allowed_models
        );
        assert!(merged.scheduler_enabled);
    }

    #[test]
    fn database_bootstrap_keeps_a_database_url_selected_during_startup() {
        let bootstrapped = config::AppConfig {
            database_url: Some(
                "postgresql://toris_app:example@127.0.0.1:54329/toris_studio".into(),
            ),
            ..Default::default()
        };
        let latest = config::AppConfig {
            database_url: Some(
                "postgresql://toris_app:example@127.0.0.1:54330/toris_studio".into(),
            ),
            ..Default::default()
        };

        let merged = merge_bootstrapped_database(&latest, &bootstrapped);
        assert_eq!(merged.database_url, latest.database_url);
    }
}

pub fn run() {
    let action = std::env::args().nth(1);
    if action.as_deref() == Some("--startup-smoke") {
        #[cfg(feature = "desktop")]
        std::process::exit(startup_smoke::run());
        #[cfg(not(feature = "desktop"))]
        {
            eprintln!("Native startup smoke requires a packaged desktop build.");
            std::process::exit(1);
        }
    }
    if action.as_deref() == Some("--motion-smoke") {
        let runtime = tokio::runtime::Runtime::new().expect("Rust runtime unavailable");
        match runtime.block_on(graphics_export::smoke()) {
            Ok(result) => println!("{result}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if action.as_deref() == Some("--studio-mcp") {
        mcp_bridge::run();
        return;
    }
    if action.as_deref() == Some("--asset-command") {
        assets::worker_main();
        return;
    }
    // These fixed maintenance operations use the private DB stack credentials,
    // so they never need to unlock saved API keys or OAuth records.
    let loaded = if matches!(
        action.as_deref(),
        Some("--db-migrate" | "--db-backup" | "--retire-webui")
    ) {
        Ok(config::AppConfig::default())
    } else {
        config::AppConfig::load()
    };
    let config = match loaded {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            config::AppConfig::default()
        }
    };
    if let Some(action) = action {
        let runtime = tokio::runtime::Runtime::new().expect("Rust runtime unavailable");
        let result = runtime.block_on(async {
            match action.as_str() {
                "--self-check" => {
                    let dashboard = social::dashboard(&config).await?;
                    let ai = serde_json::json!({"mode":"agent-runtime","settings":agent_runtime::load_settings().ok(),"node":agent_runtime::node_path(),"bundle":agent_runtime::bundle_path()});
                    Ok(serde_json::json!({"database":dashboard.database,"channelCount":dashboard.channels.len(),"contentCount":dashboard.content.len(),"trendCount":dashboard.trends.len(),"ai":ai}))
                },
                "--collect-trends" => serde_json::to_value(social::refresh_trends(&config,None).await?).map_err(|_| "직렬화 실패".into()),
                "--verify-ai" => Err("앱의 Agent 탭에서 모델을 선택하고 연결을 확인하세요.".into()),
                "--db-start" => { let next = ops::start_database(&config).await?; next.save()?; Ok(serde_json::json!({"ok":true})) },
                "--db-backup" => ops::backup_database().await,
                "--db-migrate" => { ops::migrate_database().await?; Ok(serde_json::json!({"ok":true})) },
                "--retire-webui" => Ok(legacy_cleanup::retire().await),
                _ => Err("지원하지 않는 명령입니다.".into()),
            }
        });
        match result {
            Ok(result) => println!("{}", serde_json::to_string_pretty(&result).unwrap()),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(feature = "desktop")]
    desktop::launch(config);
    #[cfg(not(feature = "desktop"))]
    eprintln!("CLI mode requires --self-check, --collect-trends, --db-start, --db-backup or --db-migrate.");
}
