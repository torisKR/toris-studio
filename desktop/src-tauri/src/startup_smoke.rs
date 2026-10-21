//! An actual native webview startup check, isolated from all user state.
//!
//! This entry point must be selected before `AppConfig::load`. It deliberately
//! does not call the normal builder, register application IPC, load plugins or
//! start database, OAuth, publication, browser or analytics background loops.

use serde::Deserialize;

const NAVIGATION: [&str; 4] = ["SNS 관리", "콘텐츠", "제작", "게시"];
const READS: [&str; 9] = [
    "analytics_dispatch:status",
    "browser_runtime_status",
    "creation_bridge_info",
    "get_dashboard",
    "get_keychain_status",
    "get_scheduler_status",
    "get_settings",
    "get_update_status",
    "oauth_connections",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartupResult {
    navigation: Vec<String>,
    from: String,
    to: String,
    sns: bool,
    no_boundary: bool,
    settings_loaded: bool,
    failures: Vec<String>,
    reads: Vec<String>,
}

fn valid(result: &StartupResult) -> bool {
    let date = |value: &str| {
        value.len() == 10
            && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == value)
    };
    result.navigation == NAVIGATION
        && result.sns
        && result.no_boundary
        && result.settings_loaded
        && result.failures.is_empty()
        && result.reads == READS
        && date(&result.from)
        && date(&result.to)
        && result.from <= result.to
}

fn native_fixtures() -> serde_json::Value {
    // Use the actual producer's public DTO, never a compatibility superset from
    // a browser fixture. Default construction reads no saved configuration.
    let mut settings = crate::config::AppConfig::default().public();
    settings["configPath"] = serde_json::json!("/fixture/settings.json");
    let browser = crate::browser::BrowserStatus {
        preference: crate::browser::BrowserChoice::Playwright,
        effective_browser: crate::browser::BrowserChoice::Playwright,
        available: true,
        reason: None,
        phase: "idle",
    };
    let update = crate::updater::UpdateStatus {
        revision: 0,
        configured: true,
        current_version: env!("CARGO_PKG_VERSION").into(),
        phase: crate::updater::UpdatePhase::Idle,
        available_version: None,
        notes: None,
        published_at: None,
        downloaded_bytes: 0,
        total_bytes: None,
        message: "Isolated native startup fixture".into(),
        can_cancel: false,
    };
    serde_json::json!({
        "get_settings": settings,
        "get_scheduler_status": crate::scheduler::SchedulerStatus::default(),
        "get_keychain_status": {"blocked":false},
        "browser_runtime_status": browser,
        "get_update_status": update,
    })
}

#[cfg(feature = "desktop")]
mod native {
    use super::*;
    use std::{
        io::Write,
        sync::{atomic::AtomicBool, atomic::Ordering, Arc, Mutex},
    };

    const LABEL: &str = "startup-smoke";
    const SCRIPT: &str = include_str!("startup_smoke.js");

    #[derive(Default)]
    struct SmokeState {
        outcome: Mutex<Option<Outcome>>,
        emitted: AtomicBool,
    }

    #[derive(Clone, Copy)]
    struct Outcome {
        passed: bool,
        reason: &'static str,
    }

    fn record(state: &SmokeState, passed: bool, reason: &'static str) -> bool {
        let mut outcome = state
            .outcome
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if outcome.is_some() {
            return false;
        }
        *outcome = Some(Outcome { passed, reason });
        true
    }

    fn emit(state: &SmokeState, passed: bool, reason: &'static str) {
        if state.emitted.swap(true, Ordering::SeqCst) {
            return;
        }
        // Emit only fixed diagnostics. Do not serialize webview errors, paths,
        // environment variables or any data supplied by the frontend.
        println!(
            "{}",
            serde_json::json!({
                "check": "native-tauri-startup",
                "ok": passed,
                "reason": reason,
                "version": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "userDataAccessed": false,
                "providerExecution": false,
                "checks": ["packaged-index", "four-destinations", "iso-date-fields", "loaded-settings", "no-startup-error", "read-only-ipc-fixtures"]
            })
        );
        let _ = std::io::stdout().flush();
    }

    #[tauri::command]
    fn startup_smoke_result(
        window: tauri::WebviewWindow,
        app: tauri::AppHandle,
        state: tauri::State<'_, Arc<SmokeState>>,
        result: StartupResult,
    ) -> Result<(), &'static str> {
        if window.label() != LABEL {
            return Err("Invalid startup smoke window");
        }
        let passed = valid(&result);
        if record(
            &state,
            passed,
            if passed { "passed" } else { "render-failed" },
        ) {
            app.exit(if passed { 0 } else { 1 });
        }
        Ok(())
    }

    pub fn run() -> i32 {
        let state = Arc::new(SmokeState::default());
        let watchdog = state.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(35));
            // Also bound native shutdown after a result has arrived. Success is
            // emitted only once run_return and temporary-profile cleanup finish.
            emit(&watchdog, false, "native-timeout");
            std::process::exit(1);
        });

        let profile = match tempfile::Builder::new()
            .prefix("toris-native-startup-")
            .tempdir()
        {
            Ok(profile) => profile,
            Err(_) => {
                emit(&state, false, "temporary-profile-failed");
                return 1;
            }
        };
        let mut context = tauri::generate_context!();
        // Never create the configured main window or select the development
        // server. The check exercises exactly the embedded packaged index.
        context.config_mut().app.windows.clear();
        context.config_mut().build.dev_url = None;
        context.config_mut().identifier = "kr.toris.studio.startup-smoke".into();
        if context
            .assets()
            .get(&tauri::utils::assets::AssetKey::from("index.html"))
            .is_none()
        {
            emit(&state, false, "packaged-index-missing");
            return 1;
        }
        // A dedicated builder has no app commands. This scoped authority grant
        // exists only here; the main app capability/command registry is intact.
        context.runtime_authority_mut().__allow_command(
            "startup_smoke_result".into(),
            tauri::utils::acl::ExecutionContext::Local,
        );
        let profile_path = profile.path().to_owned();
        let setup_state = state.clone();
        let app = tauri::Builder::default()
            .manage(state.clone())
            .invoke_system(SCRIPT.replace("__NATIVE_FIXTURES__", &native_fixtures().to_string()))
            .invoke_handler(tauri::generate_handler![startup_smoke_result])
            .setup(move |app| {
                let created = tauri::WebviewWindowBuilder::new(
                    app,
                    LABEL,
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Toris Studio isolated startup check")
                .inner_size(1380.0, 900.0)
                .visible(false)
                .focused(false)
                .incognito(true)
                .data_directory(profile_path.clone())
                .on_navigation(|url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https")
                            && url.host_str() == Some("tauri.localhost"))
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build();
                if created.is_err() {
                    record(&setup_state, false, "webview-create-failed");
                    app.handle().exit(1);
                }
                Ok(())
            })
            .build(context);
        let app = match app {
            Ok(app) => app,
            Err(_) => {
                emit(&state, false, "native-build-failed");
                return 1;
            }
        };
        let exit = app.run_return(|_, _| {});
        // Drop the temporary WebView2 profile after its runtime has closed.
        drop(profile);
        let outcome = *state
            .outcome
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let outcome = outcome.unwrap_or(Outcome {
            passed: false,
            reason: "native-exited-before-result",
        });
        let passed = exit == 0 && outcome.passed;
        let reason = if exit != 0 && outcome.passed {
            "native-exit-failed"
        } else {
            outcome.reason
        };
        emit(&state, passed, reason);
        if passed {
            0
        } else {
            1
        }
    }
}

#[cfg(feature = "desktop")]
pub use native::run;

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> StartupResult {
        StartupResult {
            navigation: NAVIGATION.map(str::to_owned).to_vec(),
            from: "2026-12-05".into(),
            to: "2027-01-01".into(),
            sns: true,
            no_boundary: true,
            settings_loaded: true,
            failures: vec![],
            reads: READS.map(str::to_owned).to_vec(),
        }
    }

    #[test]
    fn requires_rendered_shell_and_real_iso_dates() {
        assert!(valid(&ready()));
        for date in ["12/05/2026", "2026-2-05", "2026-02-30", "", "2027-01-02"] {
            let mut result = ready();
            result.from = date.into();
            assert!(!valid(&result));
        }
    }

    #[test]
    fn rejects_boundary_errors_and_incomplete_fixture_reads() {
        let mut result = ready();
        result.no_boundary = false;
        assert!(!valid(&result));
        result = ready();
        result.failures.push("javascript-error".into());
        assert!(!valid(&result));
        result = ready();
        result.reads.pop();
        assert!(!valid(&result));
        result = ready();
        result.navigation.swap(0, 1);
        assert!(!valid(&result));
        result = ready();
        result.settings_loaded = false;
        assert!(!valid(&result));
    }

    #[test]
    fn settings_fixture_uses_current_public_producer_without_retired_fields() {
        let fixture = native_fixtures();
        let mut actual = crate::config::AppConfig::default().public();
        actual["configPath"] = serde_json::json!("/fixture/settings.json");
        assert_eq!(fixture["get_settings"], actual);
        assert_eq!(
            fixture["get_settings"]["creationMode"],
            "remote-desktop-commander"
        );
        for key in [
            "opencodexAllowedModels",
            "opencodexModel",
            "teamclaudeModel",
            "claudeCliEnabled",
        ] {
            assert!(fixture["get_settings"].get(key).is_none());
        }
    }
}
