use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf};
use url::Url;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AppConfig {
    pub database_url: Option<String>,
    pub opencodex_base_url: String,
    pub opencodex_model: String,
    pub opencodex_allowed_models: Vec<String>,
    pub opencodex_api_key: Option<String>,
    pub teamclaude_base_url: Option<String>,
    pub teamclaude_model: Option<String>,
    pub teamclaude_allowed_models: Vec<String>,
    pub teamclaude_api_key: Option<String>,
    pub claude_cli_enabled: bool,
    pub claude_cli_path: String,
    pub youtube_api_key: Option<String>,
    pub naver_client_id: Option<String>,
    pub naver_client_secret: Option<String>,
    pub scheduler_enabled: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            database_url: None,
            opencodex_base_url: "http://127.0.0.1:10100/v1".into(),
            opencodex_model: "gpt-6.1-sol".into(),
            opencodex_allowed_models: vec!["gpt-6.1-sol".into()],
            opencodex_api_key: None,
            teamclaude_base_url: None,
            teamclaude_model: None,
            teamclaude_allowed_models: vec![],
            teamclaude_api_key: None,
            claude_cli_enabled: false,
            claude_cli_path: "claude".into(),
            youtube_api_key: None,
            naver_client_id: None,
            naver_client_secret: None,
            scheduler_enabled: false,
        }
    }
}

pub fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("kr.toris.studio/settings.json")
}

/// Move development-install data into the same per-user location used by CI
/// installers. Originals are retained and existing destination files always win.
pub fn prepare_portable_data() -> Result<(), String> {
    let directory = dirs::config_dir()
        .ok_or("사용자 설정 폴더를 찾을 수 없습니다.")?
        .join("kr.toris.studio");
    migrate_portable_data(&project_root(), &directory)
}

fn copy_missing(source: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    use std::io::Write;
    let metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("기존 저장 데이터를 읽을 수 없습니다.".into()),
    };
    if metadata.file_type().is_symlink() {
        return Err("기존 저장 데이터의 심볼릭 링크를 확인하세요.".into());
    }
    if let Ok(existing) = fs::symlink_metadata(destination) {
        if existing.file_type().is_symlink() || existing.is_dir() != metadata.is_dir() {
            return Err("사용자 저장 경로 형식을 확인하세요.".into());
        }
        if existing.is_file() {
            return Ok(());
        }
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination).map_err(|_| "사용자 저장 폴더를 만들 수 없습니다.")?;
        for entry in fs::read_dir(source).map_err(|_| "기존 저장 폴더를 읽을 수 없습니다.")?
        {
            let entry = entry.map_err(|_| "기존 저장 폴더를 읽을 수 없습니다.")?;
            copy_missing(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        let parent = destination.parent().ok_or("사용자 저장 경로 오류")?;
        fs::create_dir_all(parent).map_err(|_| "사용자 저장 폴더를 만들 수 없습니다.")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "기존 데이터 복사 파일을 만들 수 없습니다.")?;
        let mut original = fs::File::open(source).map_err(|_| "기존 데이터를 읽을 수 없습니다.")?;
        std::io::copy(&mut original, &mut temporary)
            .and_then(|_| temporary.flush())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "기존 데이터를 보존하지 못했습니다. 업데이트를 다시 시도하세요.")?;
        if let Err(error) = temporary.persist_noclobber(destination) {
            if error.error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(
                    "기존 데이터를 보존하지 못했습니다. 업데이트를 다시 시도하세요.".into(),
                );
            }
        }
    } else {
        return Err("기존 저장 파일 형식을 확인하세요.".into());
    }
    Ok(())
}

fn migrate_portable_data(
    project: &std::path::Path,
    directory: &std::path::Path,
) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|_| "사용자 설정 폴더를 만들 수 없습니다.")?;
    let marker = directory.join("portable-data-v1");
    if marker.is_file() || !project.join("package.json").is_file() {
        return Ok(());
    }
    let legacy = project.join(".toris-studio");
    for (old, new) in [
        ("desktop-settings.json", "settings.json"),
        ("desktop-scheduler.json", "desktop-scheduler.json"),
        ("projects.json", "projects.json"),
        ("opal-settings.json", "opal-settings.json"),
        ("renders", "renders"),
        ("backups", "backups"),
    ] {
        copy_missing(&legacy.join(old), &directory.join(new))?;
    }
    copy_missing(
        &project.join(".env.db.local"),
        &directory.join("db-stack/.env.db.local"),
    )?;
    copy_missing(&project.join("public"), &directory.join("media"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| "데이터 보존 상태를 저장할 수 없습니다.")?;
    use std::io::Write;
    temporary
        .write_all(b"1\n")
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "데이터 보존 상태를 저장할 수 없습니다.")?;
    if let Err(error) = temporary.persist_noclobber(marker) {
        if error.error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err("데이터 보존 상태를 저장할 수 없습니다.".into());
        }
    }
    Ok(())
}

impl AppConfig {
    pub fn load() -> Result<Self, String> {
        prepare_portable_data()?;
        let path = config_path();
        if path.exists() {
            let bytes = fs::read(path).map_err(|_| "로컬 설정을 읽을 수 없습니다.")?;
            if bytes.len() > 32768 {
                return Err("설정 파일이 너무 큽니다.".into());
            }
            let config: Self =
                serde_json::from_slice(&bytes).map_err(|_| "로컬 설정 형식을 확인하세요.")?;
            config.validate()?;
            return crate::credentials::hydrate(config);
        }
        let mut values = HashMap::new();
        if let Ok(iter) = dotenvy::from_path_iter(project_root().join(".env.local")) {
            for (key, value) in iter.flatten() {
                values.insert(key, value);
            }
        }
        for (key, value) in std::env::vars() {
            if !value.is_empty() {
                values.insert(key, value);
            }
        }
        let get = |key: &str| values.get(key).filter(|v| !v.trim().is_empty()).cloned();
        let mut config = Self::default();
        config.database_url = get("DATABASE_URL");
        config.opencodex_base_url = get("OPENCODEX_BASE_URL").unwrap_or(config.opencodex_base_url);
        config.opencodex_model = get("OPENCODEX_MODEL").unwrap_or(config.opencodex_model);
        config.opencodex_allowed_models = get("OPENCODEX_ALLOWED_MODELS")
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or(config.opencodex_allowed_models);
        config.opencodex_api_key = get("OPENCODEX_API_KEY");
        config.teamclaude_base_url = get("TEAMCLAUDE_BASE_URL");
        config.teamclaude_model = get("TEAMCLAUDE_MODEL");
        config.teamclaude_api_key = get("TEAMCLAUDE_API_KEY");
        config.teamclaude_allowed_models = get("TEAMCLAUDE_ALLOWED_MODELS")
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        config.claude_cli_enabled = get("CLAUDE_CLI_ENABLED").as_deref() == Some("true");
        config.claude_cli_path = get("CLAUDE_CLI_PATH").unwrap_or(config.claude_cli_path);
        config.youtube_api_key = get("YOUTUBE_DATA_API_KEY");
        config.naver_client_id = get("NAVER_CLIENT_ID");
        config.naver_client_secret = get("NAVER_CLIENT_SECRET");
        config.validate()?;
        crate::credentials::hydrate(config)
    }

    pub fn validate(&self) -> Result<(), String> {
        if let Some(raw) = &self.database_url {
            validate_database_url(raw)?;
        }
        for raw in [
            Some(&self.opencodex_base_url),
            self.teamclaude_base_url.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            let url = Url::parse(raw).map_err(|_| "AI 연결 주소 형식을 확인하세요.")?;
            if !["http", "https"].contains(&url.scheme())
                || !["127.0.0.1", "localhost", "[::1]"].contains(&url.host_str().unwrap_or(""))
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || url.path().trim_end_matches('/') != "/v1"
            {
                return Err("AI 연결 주소는 localhost의 /v1만 허용됩니다.".into());
            }
        }
        if self.opencodex_allowed_models.is_empty()
            || self.opencodex_allowed_models.len() > 30
            || !self
                .opencodex_allowed_models
                .contains(&self.opencodex_model)
        {
            return Err("기본 모델을 모델 허용 목록에 포함하세요.".into());
        }
        if self
            .opencodex_allowed_models
            .iter()
            .chain(self.teamclaude_allowed_models.iter())
            .any(|v| v.is_empty() || v.len() > 120 || v.chars().any(char::is_control))
        {
            return Err("모델 이름 형식을 확인하세요.".into());
        }
        if self.claude_cli_path.len() > 2048 || self.claude_cli_path.chars().any(char::is_control) {
            return Err("Claude CLI 경로 형식을 확인하세요.".into());
        }
        Ok(())
    }

    pub fn public(&self) -> Value {
        json!({
            "databaseConfigured": self.database_url.is_some(), "opencodexBaseUrl": self.opencodex_base_url,
            "opencodexModel": self.opencodex_model, "opencodexAllowedModels": self.opencodex_allowed_models,
            "teamclaudeBaseUrl": self.teamclaude_base_url, "teamclaudeModel": self.teamclaude_model,
            "teamclaudeAllowedModels": self.teamclaude_allowed_models, "claudeCliEnabled": self.claude_cli_enabled,
            "claudeCliPath": self.claude_cli_path, "youtubeConfigured": self.youtube_api_key.is_some(),
            "naverConfigured": self.naver_client_id.is_some() && self.naver_client_secret.is_some(),
            "savedCollectionKeys": {
                "youtubeApiKey": self.youtube_api_key.is_some(),
                "naverClientId": self.naver_client_id.is_some(),
                "naverClientSecret": self.naver_client_secret.is_some(),
            },
            "configPath": config_path().to_string_lossy(), "schedulerEnabled": self.scheduler_enabled,
        })
    }

    pub fn saved_collection_secret(&self, key: &str) -> Result<Option<String>, String> {
        match key {
            "youtubeApiKey" => Ok(self.youtube_api_key.clone()),
            "naverClientId" => Ok(self.naver_client_id.clone()),
            "naverClientSecret" => Ok(self.naver_client_secret.clone()),
            _ => Err("확인할 수 없는 수집 설정 항목입니다.".into()),
        }
    }

    pub fn updated(&self, input: &Value) -> Result<Self, String> {
        if serde_json::to_vec(input)
            .map_err(|_| "설정 형식 오류")?
            .len()
            > 32768
        {
            return Err("설정이 너무 큽니다.".into());
        }
        let object = input.as_object().ok_or("설정 형식 오류")?;
        let mut merged = serde_json::to_value(self).map_err(|_| "설정 형식 오류")?;
        let target = merged.as_object_mut().ok_or("설정 형식 오류")?;
        for (key, value) in object {
            if !target.contains_key(key) {
                return Err("지원하지 않는 설정 항목입니다.".into());
            }
            let secret = [
                "databaseUrl",
                "opencodexApiKey",
                "teamclaudeApiKey",
                "youtubeApiKey",
                "naverClientId",
                "naverClientSecret",
            ]
            .contains(&key.as_str());
            if secret && (value.is_null() || value.as_str().is_some_and(|v| v.trim().is_empty())) {
                continue;
            }
            if ["teamclaudeBaseUrl", "teamclaudeModel"].contains(&key.as_str())
                && value.as_str().is_some_and(|v| v.trim().is_empty())
            {
                target.insert(key.clone(), Value::Null);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
        let updated: Self =
            serde_json::from_value(merged).map_err(|_| "설정 값 형식을 확인하세요.")?;
        updated.validate()?;
        Ok(updated)
    }

    pub fn save(&self) -> Result<(), String> {
        self.validate()?;
        let path = config_path();
        fs::create_dir_all(path.parent().ok_or("설정 경로 오류")?)
            .map_err(|_| "설정 폴더를 만들 수 없습니다.")?;
        let temporary = path.with_extension("tmp");
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let public = crate::credentials::store(self)?;
        let mut file = options
            .open(&temporary)
            .map_err(|_| "설정을 저장할 수 없습니다.")?;
        use std::io::Write;
        file.write_all(&serde_json::to_vec_pretty(&public).map_err(|_| "설정 형식 오류")?)
            .map_err(|_| "설정을 저장할 수 없습니다.")?;
        file.sync_all().map_err(|_| "설정을 저장할 수 없습니다.")?;
        fs::rename(&temporary, path).map_err(|_| "설정을 저장할 수 없습니다.")?;
        Ok(())
    }
}

pub fn validate_database_url(raw: &str) -> Result<(), String> {
    let url = Url::parse(raw).map_err(|_| "DB 연결 주소 형식을 확인하세요.")?;
    if !["postgres", "postgresql"].contains(&url.scheme())
        || !["127.0.0.1", "localhost", "[::1]"].contains(&url.host_str().unwrap_or(""))
        || url.password().is_none()
        || url.username() != "toris_app"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("DB는 암호가 있는 localhost PostgreSQL의 toris_app 계정만 허용됩니다.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_migration_preserves_existing_destination_and_originals() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("old-checkout");
        let destination = temporary.path().join("user-data");
        fs::create_dir_all(project.join(".toris-studio/renders")).unwrap();
        fs::create_dir_all(project.join("public/generated")).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(project.join("package.json"), b"{}").unwrap();
        fs::write(project.join(".toris-studio/desktop-settings.json"), b"old").unwrap();
        fs::write(destination.join("settings.json"), b"newer").unwrap();
        fs::write(project.join(".toris-studio/projects.json"), b"projects").unwrap();
        fs::write(project.join(".toris-studio/renders/video.mp4"), b"video").unwrap();
        fs::write(project.join("public/generated/voice.wav"), b"voice").unwrap();
        fs::write(project.join(".env.db.local"), b"private-test-password").unwrap();
        migrate_portable_data(&project, &destination).unwrap();
        assert_eq!(
            fs::read(destination.join("settings.json")).unwrap(),
            b"newer"
        );
        assert_eq!(
            fs::read(destination.join("projects.json")).unwrap(),
            b"projects"
        );
        assert_eq!(
            fs::read(destination.join("renders/video.mp4")).unwrap(),
            b"video"
        );
        assert_eq!(
            fs::read(destination.join("media/generated/voice.wav")).unwrap(),
            b"voice"
        );
        assert_eq!(
            fs::read(destination.join("db-stack/.env.db.local")).unwrap(),
            b"private-test-password"
        );
        assert!(project.join(".env.db.local").is_file());
        assert!(project.join(".toris-studio/projects.json").is_file());
        fs::write(project.join(".toris-studio/projects.json"), b"stale").unwrap();
        migrate_portable_data(&project, &destination).unwrap();
        assert_eq!(
            fs::read(destination.join("projects.json")).unwrap(),
            b"projects"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(destination.join("db-stack/.env.db.local"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn portable_migration_rejects_symlinks_without_marking_complete() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("old-checkout");
        let destination = temporary.path().join("user-data");
        fs::create_dir_all(project.join(".toris-studio")).unwrap();
        fs::write(project.join("package.json"), b"{}").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", project.join(".toris-studio/projects.json"))
            .unwrap();
        assert!(migrate_portable_data(&project, &destination).is_err());
        assert!(!destination.join("portable-data-v1").exists());
        assert!(!destination.join("projects.json").exists());
    }
    #[test]
    fn public_settings_do_not_contain_secrets() {
        let config = AppConfig {
            database_url: Some("postgresql://user:private-local-value@localhost/db".into()),
            opencodex_api_key: Some("private-provider-value".into()),
            youtube_api_key: Some("private-youtube-value".into()),
            naver_client_id: Some("private-naver-id".into()),
            naver_client_secret: Some("private-naver-value".into()),
            ..Default::default()
        };
        let public = config.public();
        for key in [
            "databaseUrl",
            "opencodexApiKey",
            "youtubeApiKey",
            "naverClientId",
            "naverClientSecret",
        ] {
            assert!(public.get(key).is_none());
        }
        let serialized = public.to_string();
        for value in [
            "private-local-value",
            "private-provider-value",
            "private-youtube-value",
            "private-naver-id",
            "private-naver-value",
        ] {
            assert!(!serialized.contains(value));
        }
    }
    #[test]
    fn only_exact_collection_keys_can_reveal_saved_values() {
        let config = AppConfig {
            youtube_api_key: Some("collection-youtube-value".into()),
            naver_client_id: Some("collection-naver-id".into()),
            naver_client_secret: Some("collection-naver-value".into()),
            database_url: Some("postgresql://toris_app:example@localhost/db".into()),
            opencodex_api_key: Some("provider-value".into()),
            teamclaude_api_key: Some("other-provider-value".into()),
            ..Default::default()
        };
        for (key, expected) in [
            ("youtubeApiKey", "collection-youtube-value"),
            ("naverClientId", "collection-naver-id"),
            ("naverClientSecret", "collection-naver-value"),
        ] {
            assert_eq!(
                config.saved_collection_secret(key).unwrap().as_deref(),
                Some(expected)
            );
        }
        for rejected in [
            "databaseUrl",
            "opencodexApiKey",
            "teamclaudeApiKey",
            "youtube_api_key",
            "YoutubeApiKey",
            "youtubeApiKey ",
            " naverClientId",
            "naverClientSecret\n",
            "",
            "unknown-private-input",
        ] {
            assert_eq!(
                config.saved_collection_secret(rejected).unwrap_err(),
                "확인할 수 없는 수집 설정 항목입니다."
            );
        }
    }
    #[test]
    fn unset_collection_values_return_none() {
        let config = AppConfig::default();
        for key in ["youtubeApiKey", "naverClientId", "naverClientSecret"] {
            assert_eq!(config.saved_collection_secret(key).unwrap(), None);
        }
    }
    #[test]
    fn public_collection_flags_distinguish_partially_saved_naver_keys() {
        let config = AppConfig {
            naver_client_id: Some("collection-naver-id".into()),
            ..Default::default()
        };
        let public = config.public();
        assert_eq!(public["naverConfigured"], false);
        assert_eq!(
            public["savedCollectionKeys"],
            json!({
                "youtubeApiKey": false,
                "naverClientId": true,
                "naverClientSecret": false,
            })
        );
    }
    #[test]
    fn prevents_remote_endpoints_and_preserves_blank_passwords() {
        let config = AppConfig {
            database_url: Some("postgresql://toris_app:local-test-value@localhost/db".into()),
            ..Default::default()
        };
        assert_eq!(
            config
                .updated(&json!({"databaseUrl":""}))
                .unwrap()
                .database_url,
            config.database_url
        );
        assert!(config
            .updated(&json!({"opencodexBaseUrl":"https://evil.example/v1"}))
            .is_err());
        assert!(validate_database_url("postgresql://user:local@remote.example/db").is_err());
        assert!(config
            .updated(&json!({"opencodexAllowedModels":["paid-external-model"]}))
            .is_err());
    }
}
