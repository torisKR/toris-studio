pub mod ai;
pub mod config;
pub mod credentials;
pub mod keyword;
pub mod media;
pub mod models;
pub mod oauth;
pub mod ops;
pub mod scheduler;
pub mod social;
pub mod trends;
pub mod updater;
pub mod vault;
pub mod video_embed;
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
    use tauri::State;
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
    pub async fn ai_status(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
        let config = state.config_snapshot().await;
        ai::status(&config).await
    }
    #[tauri::command]
    pub async fn ai_generate(
        state: State<'_, Arc<AppState>>,
        input: Value,
    ) -> Result<Value, String> {
        let config = state.config_snapshot().await;
        ai::generate(&config, input).await
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
    pub fn open_external(
        app: tauri::AppHandle,
        url: String,
        browser: Option<oauth::LoginBrowser>,
    ) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        let url = oauth::canonical_browser_url(&url)?;
        let program = browser.unwrap_or(oauth::LoginBrowser::System).program();
        app.opener().open_url(url, program).map_err(|_| {
            if program.is_some() {
                "Aside에서 링크를 열 수 없습니다. Aside 앱 설치 상태를 확인하세요.".into()
            } else {
                "기본 브라우저에서 링크를 열 수 없습니다.".into()
            }
        })
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
    pub async fn video_render_project(project: Value) -> Result<Value, String> {
        media::render_project(project).await
    }
    #[tauri::command]
    pub async fn video_generate_voice(input: Value) -> Result<Value, String> {
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
        app: tauri::AppHandle,
        platform: String,
        browser: Option<oauth::LoginBrowser>,
    ) -> Result<Value, String> {
        let result = oauth::begin_login(platform).await?;
        let url = result
            .get("authorizationUrl")
            .and_then(Value::as_str)
            .ok_or("로그인 주소를 준비하지 못했습니다.")?;
        open_external(app, url.to_owned(), browser)?;
        // Authorization URLs contain state/PKCE data; they need not enter renderer state.
        let mut public = result;
        public
            .as_object_mut()
            .ok_or("로그인 응답 오류")?
            .remove("authorizationUrl");
        Ok(public)
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
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_clipboard_manager::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .manage(state.clone())
            .manage(updater::shared())
            .on_window_event(|window, event| {
                use tauri::Manager;
                if window.label() == "main" {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if window
                            .app_handle()
                            .state::<Arc<updater::UpdateController>>()
                            .installing()
                        {
                            api.prevent_close();
                        }
                    }
                }
            })
            .setup(move |_| {
                let state = state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        scheduler::tick(state.clone()).await;
                        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    }
                });
                tauri::async_runtime::spawn(async move {
                    loop {
                        let _ = oauth::refresh_due().await;
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    }
                });
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                get_dashboard,
                get_update_status,
                check_for_updates,
                install_update,
                cancel_update,
                create_channel,
                create_content,
                update_content,
                refresh_trends,
                ai_status,
                ai_generate,
                get_settings,
                get_keychain_status,
                retry_keychain_access,
                get_saved_collection_secret,
                save_settings,
                get_scheduler_status,
                set_scheduler,
                open_external,
                copy_text,
                start_database,
                backup_database,
                start_keyword_crawler,
                video_list_projects,
                video_save_project,
                video_render_project,
                video_generate_voice,
                media_status,
                open_rendered_video,
                youtube_lookup_channel,
                youtube_channel_videos,
                prepare_youtube_embed,
                get_keyword_status,
                search_keywords,
                get_content_keywords,
                get_keyword_runs,
                crawl_keyword_content,
                cancel_keyword_search,
                oauth_status,
                oauth_save_client,
                oauth_begin_login,
                oauth_complete_login,
                oauth_refresh_session,
                oauth_disconnect
            ])
            .build(tauri::generate_context!())
            .expect("Toris Studio application runtime failed")
            .run(|app, event| {
                if let tauri::RunEvent::ExitRequested { api, .. } = event {
                    use tauri::Manager;
                    if app.state::<Arc<updater::UpdateController>>().installing() {
                        // Never interrupt replacement of the signed application bundle.
                        api.prevent_exit();
                    } else if keyword::running() {
                        if keyword::cancel().is_err() && keyword::running() {
                            // Never interrupt committing an observation transaction.
                            api.prevent_exit();
                        }
                    }
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
    // These fixed maintenance operations use the private DB stack credentials,
    // so they never need to unlock saved API keys or OAuth records.
    let loaded = if matches!(action.as_deref(), Some("--db-migrate" | "--db-backup")) {
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
                    let ai = ai::status(&config).await?;
                    Ok(serde_json::json!({"database":dashboard.database,"channelCount":dashboard.channels.len(),"contentCount":dashboard.content.len(),"trendCount":dashboard.trends.len(),"ai":ai}))
                },
                "--collect-trends" => serde_json::to_value(social::refresh_trends(&config,None).await?).map_err(|_| "직렬화 실패".into()),
                "--verify-ai" => ai::generate(&config,serde_json::json!({"provider":"opencodex","platform":"threads","topic":"Rust 기반 로컬 콘텐츠 스튜디오에 대한 짧은 한국어 소개 초안을 작성해 주세요."})).await,
                "--db-start" => { let next = ops::start_database(&config).await?; next.save()?; Ok(serde_json::json!({"ok":true})) },
                "--db-backup" => ops::backup_database().await,
                "--db-migrate" => { ops::migrate_database().await?; Ok(serde_json::json!({"ok":true})) },
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
