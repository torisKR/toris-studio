//! Signed, user-initiated desktop updates. The renderer never supplies a URL or key.
#![cfg(any(feature = "desktop", test))]
use base64::Engine;
use serde::{Deserialize, Serialize};
use url::Url;

pub const UPDATE_ENDPOINT: &str =
    "https://github.com/torisKR/toris-studio/releases/latest/download/latest.json";
const CONFIGURATION_ERROR: &str =
    "서명된 업데이트 설정을 확인하지 못했습니다. 공식 다운로드에서 최신 앱을 설치하세요.";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    UpToDate,
    Downloading,
    Ready,
    Installing,
    Installed,
    Cancelled,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub configured: bool,
    pub current_version: String,
    pub phase: UpdatePhase,
    pub available_version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub message: String,
    pub can_cancel: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallRequest {
    pub expected_version: String,
    pub confirmed: bool,
}

impl InstallRequest {
    fn validate(&self) -> Result<(), String> {
        if !self.confirmed {
            return Err("입력 내용을 저장한 뒤 업데이트 설치와 앱 재시작을 확인하세요.".into());
        }
        if self.expected_version.len() > 64
            || semver::Version::parse(&self.expected_version).is_err()
        {
            return Err("설치할 업데이트 버전을 다시 확인하세요.".into());
        }
        Ok(())
    }
}

fn configured_public_key() -> Result<String, String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .map_err(|_| CONFIGURATION_ERROR.to_owned())?;
    let updater = &config["plugins"]["updater"];
    let key = updater["pubkey"]
        .as_str()
        .filter(|key| !key.is_empty() && key.len() <= 4096)
        .ok_or(CONFIGURATION_ERROR)?;
    if updater["endpoints"] != serde_json::json!([UPDATE_ENDPOINT])
        || updater["requireSignedVersion"] != true
        || updater["allowDowngrades"].as_bool().unwrap_or(false)
        || updater["dangerousInsecureTransportProtocol"]
            .as_bool()
            .unwrap_or(false)
        || updater["dangerousAcceptInvalidCerts"]
            .as_bool()
            .unwrap_or(false)
        || updater["dangerousAcceptInvalidHostnames"]
            .as_bool()
            .unwrap_or(false)
    {
        return Err(CONFIGURATION_ERROR.into());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(key)
        .map_err(|_| CONFIGURATION_ERROR.to_owned())?;
    let decoded = std::str::from_utf8(&decoded).map_err(|_| CONFIGURATION_ERROR.to_owned())?;
    minisign_verify::PublicKey::decode(decoded).map_err(|_| CONFIGURATION_ERROR.to_owned())?;
    Ok(key.to_owned())
}

fn validate_asset_url(url: &Url) -> Result<(), String> {
    let segments: Vec<_> = url.path_segments().ok_or(CONFIGURATION_ERROR)?.collect();
    if url.scheme() != "https"
        || url.as_str().len() > 2048
        || url.host_str() != Some("github.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || segments.len() != 6
        || segments[..4] != ["torisKR", "toris-studio", "releases", "download"]
        || segments[4].is_empty()
        || segments[5].is_empty()
        || segments[4..].iter().any(|segment| {
            segment.chars().any(|character| {
                !(character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
            })
        })
        || !(segments[5].ends_with(".app.tar.gz") || segments[5].ends_with(".exe"))
    {
        return Err("공식 GitHub 릴리스의 업데이트 파일만 설치할 수 있습니다.".into());
    }
    Ok(())
}

fn local_main_window(label: &str, url: &Url, development: bool) -> bool {
    label == "main"
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost"))
            || (development
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port() == Some(1420)))
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(feature = "desktop")]
mod native {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use tauri_plugin_updater::{Update, UpdaterExt};
    use tokio::sync::watch;

    const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

    pub struct UpdateController {
        status: Mutex<UpdateStatus>,
        available: Mutex<Option<Update>>,
        operation: tokio::sync::Mutex<()>,
        cancellation: Mutex<Option<watch::Sender<bool>>>,
    }

    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    impl Default for UpdateController {
        fn default() -> Self {
            let configured = configured_public_key().is_ok();
            Self {
                status: Mutex::new(UpdateStatus {
                    configured,
                    current_version: env!("CARGO_PKG_VERSION").into(),
                    phase: UpdatePhase::Idle,
                    available_version: None,
                    notes: None,
                    published_at: None,
                    downloaded_bytes: 0,
                    total_bytes: None,
                    message: if configured {
                        "업데이트 확인을 누르면 공식 GitHub 릴리스를 확인합니다.".into()
                    } else {
                        CONFIGURATION_ERROR.into()
                    },
                    can_cancel: false,
                }),
                available: Mutex::new(None),
                operation: tokio::sync::Mutex::new(()),
                cancellation: Mutex::new(None),
            }
        }
    }

    struct CancellationGuard<'a>(&'a UpdateController);
    impl Drop for CancellationGuard<'_> {
        fn drop(&mut self) {
            *lock(&self.0.cancellation) = None;
        }
    }

    impl UpdateController {
        pub fn status(&self) -> UpdateStatus {
            lock(&self.status).clone()
        }

        pub fn installing(&self) -> bool {
            matches!(
                self.status().phase,
                UpdatePhase::Ready | UpdatePhase::Installing
            )
        }

        fn publish(&self, app: &AppHandle, edit: impl FnOnce(&mut UpdateStatus)) -> UpdateStatus {
            let snapshot = {
                let mut status = lock(&self.status);
                edit(&mut status);
                status.clone()
            };
            let _ = app.emit_to("main", "desktop-update-status", &snapshot);
            snapshot
        }

        fn phase(&self, app: &AppHandle, phase: UpdatePhase, message: &str) -> UpdateStatus {
            self.publish(app, |status| {
                status.can_cancel =
                    matches!(phase, UpdatePhase::Checking | UpdatePhase::Downloading);
                status.phase = phase;
                status.message = message.into();
            })
        }

        fn cancellation(&self) -> watch::Receiver<bool> {
            let (sender, receiver) = watch::channel(false);
            *lock(&self.cancellation) = Some(sender);
            receiver
        }

        pub fn cancel(&self) -> Result<UpdateStatus, String> {
            let status = lock(&self.status);
            if !status.can_cancel {
                return Err("설치가 시작된 뒤에는 업데이트를 취소할 수 없습니다.".into());
            }
            let cancellation = lock(&self.cancellation);
            cancellation
                .as_ref()
                .ok_or("취소할 업데이트 작업이 없습니다.")?
                .send(true)
                .map_err(|_| "업데이트 작업이 이미 완료되었습니다.".to_owned())?;
            Ok(status.clone())
        }

        fn seal_verified(&self, cancellation: &watch::Receiver<bool>) -> UpdateStatus {
            let mut status = lock(&self.status);
            status.can_cancel = false;
            if *cancellation.borrow() {
                status.phase = UpdatePhase::Cancelled;
                status.message = "다운로드를 취소했습니다. 현재 앱은 유지됩니다.".into();
            } else {
                status.phase = UpdatePhase::Ready;
                status.message = "업데이트 파일의 서명과 버전을 검증했습니다.".into();
            }
            status.clone()
        }

        fn updater(&self, app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
            let key = configured_public_key()?;
            app.updater_builder()
                .pubkey(key)
                .endpoints(vec![
                    Url::parse(UPDATE_ENDPOINT).map_err(|_| CONFIGURATION_ERROR)?
                ])
                .map_err(|_| CONFIGURATION_ERROR)?
                .timeout(Duration::from_secs(30))
                .configure_client(|client| {
                    // GitHub assets redirect to its public asset CDN with signed query strings.
                    // Never follow a redirect to another origin or an insecure transport.
                    client.redirect(updater_http::redirect::Policy::custom(|attempt| {
                        let url = attempt.url();
                        let github = url.host_str() == Some("github.com")
                            && url.path().starts_with("/torisKR/toris-studio/releases/");
                        let cdn = matches!(
                            url.host_str(),
                            Some(
                                "release-assets.githubusercontent.com"
                                    | "objects.githubusercontent.com"
                            )
                        );
                        if attempt.previous().len() < 5
                            && url.scheme() == "https"
                            && url.port_or_known_default() == Some(443)
                            && url.username().is_empty()
                            && url.password().is_none()
                            && (github || cdn)
                        {
                            attempt.follow()
                        } else {
                            attempt.error("공식 업데이트 주소를 벗어난 리디렉션입니다.")
                        }
                    }))
                })
                .build()
                .map_err(|_| CONFIGURATION_ERROR.into())
        }

        pub async fn check(&self, app: &AppHandle) -> Result<UpdateStatus, String> {
            let _operation = self
                .operation
                .try_lock()
                .map_err(|_| "이미 업데이트 작업을 진행하고 있습니다.")?;
            let updater = self.updater(app)?;
            let mut cancellation = self.cancellation();
            let _cleanup = CancellationGuard(self);
            *lock(&self.available) = None;
            self.publish(app, |status| {
                status.available_version = None;
                status.notes = None;
                status.published_at = None;
                status.downloaded_bytes = 0;
                status.total_bytes = None;
            });
            self.phase(
                app,
                UpdatePhase::Checking,
                "공식 GitHub 릴리스를 확인하고 있습니다.",
            );
            let result = tokio::select! {
                biased;
                _ = cancellation.changed() => return Ok(self.phase(app, UpdatePhase::Cancelled, "업데이트 확인을 취소했습니다.")),
                result = updater.check() => result,
            };
            let update = match result {
                Ok(update) => update,
                Err(_) => return Ok(self.phase(app, UpdatePhase::Error, "업데이트 정보를 가져오지 못했습니다. 네트워크와 공식 릴리스 게시 상태를 확인하세요.")),
            };
            if *cancellation.borrow() {
                return Ok(self.phase(
                    app,
                    UpdatePhase::Cancelled,
                    "업데이트 확인을 취소했습니다.",
                ));
            }
            match update {
                Some(mut update) => {
                    if validate_asset_url(&update.download_url).is_err() {
                        return Ok(self.phase(app, UpdatePhase::Error, "공식 릴리스의 업데이트 파일을 확인하지 못했습니다. 공식 다운로드를 이용하세요."));
                    }
                    update.timeout = Some(Duration::from_secs(600));
                    self.publish(app, |status| {
                        status.available_version = Some(update.version.clone());
                        status.notes = update.body.as_ref().map(|notes| {
                            notes
                                .chars()
                                .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
                                .take(6000)
                                .collect()
                        });
                        status.published_at = update.date.and_then(|date| {
                            chrono::DateTime::<chrono::Utc>::from_timestamp(
                                date.unix_timestamp(),
                                date.nanosecond(),
                            )
                            .map(|date| date.to_rfc3339())
                        });
                    });
                    *lock(&self.available) = Some(update);
                    Ok(self.phase(
                        app,
                        UpdatePhase::Available,
                        "새 버전이 있습니다. 입력 내용을 저장한 뒤 설치하세요.",
                    ))
                }
                None => Ok(self.phase(
                    app,
                    UpdatePhase::UpToDate,
                    "현재 최신 버전을 사용하고 있습니다.",
                )),
            }
        }

        pub async fn install(
            &self,
            app: &AppHandle,
            input: InstallRequest,
        ) -> Result<UpdateStatus, String> {
            input.validate()?;
            let _operation = self
                .operation
                .try_lock()
                .map_err(|_| "이미 업데이트 작업을 진행하고 있습니다.")?;
            let update = lock(&self.available)
                .clone()
                .ok_or("업데이트 확인 후 설치하세요.")?;
            if update.version != input.expected_version {
                return Err(
                    "확인한 업데이트 버전이 달라졌습니다. 업데이트를 다시 확인하세요.".into(),
                );
            }
            configured_public_key()?;
            validate_asset_url(&update.download_url)?;
            // Fail early for active browser work. Reacquire immediately before installation.
            drop(crate::opal::lock_for_update()?);
            let mut cancellation = self.cancellation();
            let _cleanup = CancellationGuard(self);
            self.publish(app, |status| {
                status.downloaded_bytes = 0;
                status.total_bytes = None;
            });
            self.phase(
                app,
                UpdatePhase::Downloading,
                "업데이트를 내려받고 있습니다. 완료 후 서명을 검증합니다.",
            );
            let mut last_event = Instant::now() - Duration::from_secs(1);
            let oversized = AtomicBool::new(false);
            let stop_download = lock(&self.cancellation).clone();
            let download = update.download(
                |chunk, length| {
                    let snapshot = {
                        let mut status = lock(&self.status);
                        status.downloaded_bytes =
                            status.downloaded_bytes.saturating_add(chunk as u64);
                        status.total_bytes = length;
                        status.clone()
                    };
                    if snapshot.downloaded_bytes > MAX_DOWNLOAD_BYTES
                        || length.is_some_and(|length| length > MAX_DOWNLOAD_BYTES)
                    {
                        oversized.store(true, Ordering::SeqCst);
                        if let Some(sender) = &stop_download {
                            let _ = sender.send(true);
                        }
                    }
                    if last_event.elapsed() >= Duration::from_millis(150) {
                        let _ = app.emit_to("main", "desktop-update-status", &snapshot);
                        last_event = Instant::now();
                    }
                },
                || {},
            );
            let result = tokio::select! {
                biased;
                _ = cancellation.changed() => {
                    return Ok(if oversized.load(Ordering::SeqCst) {
                        self.phase(app, UpdatePhase::Error, "업데이트 파일이 허용 크기를 초과했습니다. 공식 다운로드를 이용하세요.")
                    } else {
                        self.phase(app, UpdatePhase::Cancelled, "다운로드를 취소했습니다. 현재 앱과 저장 데이터는 유지됩니다.")
                    });
                },
                result = download => result,
            };
            if oversized.load(Ordering::SeqCst) {
                return Ok(self.phase(
                    app,
                    UpdatePhase::Error,
                    "업데이트 파일이 허용 크기를 초과했습니다. 공식 다운로드를 이용하세요.",
                ));
            }
            let bytes = match result {
                Ok(bytes) => bytes,
                Err(_) => return Ok(self.phase(app, UpdatePhase::Error, "다운로드 또는 서명·버전 검증에 실패했습니다. 현재 앱은 유지됩니다. 다시 확인하거나 공식 다운로드를 이용하세요.")),
            };
            // `download` returns only after minisign verifies both artifact and signed version.
            // Use the same status lock as cancel(): a cancellation accepted before this
            // transition wins; after this transition cancellation is explicitly rejected.
            let verified = self.seal_verified(&cancellation);
            let _ = app.emit_to("main", "desktop-update-status", &verified);
            if verified.phase == UpdatePhase::Cancelled {
                return Ok(verified);
            }
            let _opal_guard = match crate::opal::lock_for_update() {
                Ok(permit) => permit,
                Err(error) => return Ok(self.phase(app, UpdatePhase::Error, &error)),
            };
            self.publish(app, |status| {
                status.message = "업데이트 전에 로컬 설정과 콘텐츠를 보존하고 있습니다.".into();
            });
            if !matches!(
                tokio::task::spawn_blocking(crate::config::prepare_portable_data).await,
                Ok(Ok(()))
            ) {
                return Ok(self.phase(app, UpdatePhase::Error, "로컬 설정과 콘텐츠를 보존하지 못해 설치를 중단했습니다. 폴더 권한을 확인하고 다시 시도하세요."));
            }
            self.phase(
                app,
                UpdatePhase::Installing,
                "업데이트를 설치하고 앱을 다시 시작합니다. 잠시 기다려 주세요.",
            );
            if update.install(bytes).is_err() {
                return Ok(self.phase(app, UpdatePhase::Error, "업데이트를 설치하지 못했습니다. 앱을 다시 열거나 공식 다운로드로 설치하세요. 저장 데이터는 삭제하지 않았습니다."));
            }
            self.phase(
                app,
                UpdatePhase::Installed,
                "업데이트를 설치했습니다. 앱을 다시 시작합니다.",
            );
            app.restart()
        }
    }

    pub fn authorize(window: &tauri::WebviewWindow) -> Result<(), String> {
        if local_main_window(
            window.label(),
            &window.url().map_err(|_| "앱 화면을 확인할 수 없습니다.")?,
            cfg!(debug_assertions),
        ) {
            Ok(())
        } else {
            Err("앱의 기본 화면에서만 업데이트를 관리할 수 있습니다.".into())
        }
    }

    pub fn shared() -> Arc<UpdateController> {
        Arc::new(UpdateController::default())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn accepted_cancel_wins_and_verified_installation_cannot_be_cancelled() {
            let controller = UpdateController::default();
            let receiver = controller.cancellation();
            {
                let mut status = lock(&controller.status);
                status.phase = UpdatePhase::Downloading;
                status.can_cancel = true;
            }
            assert!(controller.cancel().is_ok());
            assert_eq!(
                controller.seal_verified(&receiver).phase,
                UpdatePhase::Cancelled
            );
            assert!(controller.cancel().is_err());

            let receiver = controller.cancellation();
            {
                let mut status = lock(&controller.status);
                status.phase = UpdatePhase::Downloading;
                status.can_cancel = true;
            }
            assert_eq!(
                controller.seal_verified(&receiver).phase,
                UpdatePhase::Ready
            );
            assert!(controller.cancel().is_err());
            assert!(!*receiver.borrow());
        }

        #[test]
        fn only_one_update_operation_can_run_at_once() {
            let controller = UpdateController::default();
            let permit = controller.operation.try_lock().unwrap();
            assert!(controller.operation.try_lock().is_err());
            drop(permit);
            assert!(controller.operation.try_lock().is_ok());
        }
    }
}

#[cfg(feature = "desktop")]
pub use native::{authorize, shared, UpdateController};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_artifacts_are_pinned_to_the_public_repository() {
        for allowed in [
            "https://github.com/torisKR/toris-studio/releases/download/desktop-v0.2.0/Toris-Studio-macOS-arm64.app.tar.gz",
            "https://github.com/torisKR/toris-studio/releases/download/desktop-v0.2.0/Toris-Studio-Windows-x64-setup.exe",
        ] {
            assert!(validate_asset_url(&Url::parse(allowed).unwrap()).is_ok());
        }
        for rejected in [
            "http://github.com/torisKR/toris-studio/releases/download/v1/test.exe",
            "https://github.com/other/repo/releases/download/v1/test.exe",
            "https://127.0.0.1/torisKR/toris-studio/releases/download/v1/test.exe",
            "https://github.com:444/torisKR/toris-studio/releases/download/v1/test.exe",
            "https://person@github.com/torisKR/toris-studio/releases/download/v1/test.exe",
            "https://github.com/torisKR/toris-studio/releases/download/v1/test.exe?token=private",
            "https://github.com/torisKR/toris-studio/releases/download/v1/test.exe#state",
            "https://github.com/torisKR/toris-studio/releases/download/v1/test.dmg",
            "https://github.com/torisKR/toris-studio/releases/download/v1/%22--args.exe",
        ] {
            assert!(
                validate_asset_url(&Url::parse(rejected).unwrap()).is_err(),
                "{rejected}"
            );
        }
    }

    #[test]
    fn installation_requires_explicit_confirmation_and_the_observed_version() {
        assert!(InstallRequest {
            expected_version: "0.2.0".into(),
            confirmed: false
        }
        .validate()
        .is_err());
        assert!(InstallRequest {
            expected_version: "0.2.0".into(),
            confirmed: true
        }
        .validate()
        .is_ok());
        assert!(InstallRequest {
            expected_version: "not a version".into(),
            confirmed: true
        }
        .validate()
        .is_err());
        assert!(serde_json::from_value::<InstallRequest>(serde_json::json!({"expectedVersion":"0.2.0","confirmed":true,"url":"https://example.com"})).is_err());
    }

    #[test]
    fn remote_or_secondary_windows_cannot_invoke_the_native_updater() {
        assert!(local_main_window(
            "main",
            &Url::parse("tauri://localhost/index.html").unwrap(),
            false
        ));
        assert!(local_main_window(
            "main",
            &Url::parse("http://tauri.localhost/").unwrap(),
            false
        ));
        assert!(local_main_window(
            "main",
            &Url::parse("http://127.0.0.1:1420/").unwrap(),
            true
        ));
        assert!(!local_main_window(
            "main",
            &Url::parse("http://127.0.0.1:1420/").unwrap(),
            false
        ));
        assert!(!local_main_window(
            "main",
            &Url::parse("https://instagram.com/").unwrap(),
            true
        ));
        assert!(!local_main_window(
            "oauth",
            &Url::parse("tauri://localhost/").unwrap(),
            false
        ));
    }

    #[test]
    fn the_bundled_update_configuration_requires_a_real_key_and_signed_version() {
        assert!(configured_public_key().is_ok());
    }
}
