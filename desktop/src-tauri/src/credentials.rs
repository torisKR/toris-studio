//! Desktop API credentials live in the OS vault, never in the public settings JSON.
use crate::config::AppConfig;
use serde_json::{Map, Value};

const SERVICE: &str = "kr.toris.studio.settings";
const ACCOUNT: &str = "connection-secrets-v1";
const FIELDS: [&str; 6] = [
    "databaseUrl",
    "opencodexApiKey",
    "teamclaudeApiKey",
    "youtubeApiKey",
    "naverClientId",
    "naverClientSecret",
];

#[cfg(not(target_os = "macos"))]
fn error() -> String {
    "OS 자격 증명 저장소에 접근할 수 없습니다. Keychain 또는 Windows 자격 증명 관리자 권한을 확인하세요.".into()
}

pub fn split(config: &AppConfig) -> Result<(Value, Value), String> {
    let mut public = serde_json::to_value(config).map_err(|_| "설정 형식 오류")?;
    let fields = public.as_object_mut().ok_or("설정 형식 오류")?;
    let mut secrets = Map::new();
    for field in FIELDS {
        secrets.insert(
            field.into(),
            fields
                .insert(field.into(), Value::Null)
                .unwrap_or(Value::Null),
        );
    }
    Ok((public, Value::Object(secrets)))
}

pub fn store(config: &AppConfig) -> Result<Value, String> {
    let (public, secrets) = split(config)?;
    if FIELDS.iter().any(|field| {
        secrets[*field]
            .as_str()
            .is_some_and(|value| value.len() > 2048)
    }) {
        return Err("연결 비밀 값은 2048바이트 이내로 입력하세요.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let entries: Vec<(String, &str)> = FIELDS
            .iter()
            .filter_map(|field| {
                secrets[*field]
                    .as_str()
                    .map(|value| (format!("{ACCOUNT}:{field}"), value))
            })
            .collect();
        let entries: Vec<(&str, &str)> = entries
            .iter()
            .map(|(account, value)| (account.as_str(), *value))
            .collect();
        crate::vault::write_many(SERVICE, &entries)?;
    }
    #[cfg(not(target_os = "macos"))]
    for field in FIELDS {
        if let Some(value) = secrets[field].as_str() {
            let entry =
                keyring::Entry::new(SERVICE, &format!("{ACCOUNT}:{field}")).map_err(|_| error())?;
            // Native Windows password strings double ASCII byte counts in UTF-16.
            // Binary secrets fit the credential manager's 2560-byte blob limit.
            #[cfg(target_os = "windows")]
            entry.set_secret(value.as_bytes()).map_err(|_| error())?;
            #[cfg(not(target_os = "windows"))]
            entry.set_password(value).map_err(|_| error())?;
        }
    }
    Ok(public)
}

pub fn hydrate(mut config: AppConfig) -> Result<AppConfig, String> {
    let mut merged = serde_json::to_value(&config).map_err(|_| "설정 형식 오류")?;
    let fields = merged.as_object_mut().ok_or("설정 형식 오류")?;
    #[cfg(target_os = "macos")]
    {
        let missing: Vec<&str> = FIELDS
            .iter()
            .copied()
            .filter(|field| fields.get(*field).map_or(true, Value::is_null))
            .collect();
        let accounts: Vec<String> = missing
            .iter()
            .map(|field| format!("{ACCOUNT}:{field}"))
            .collect();
        let accounts: Vec<&str> = accounts.iter().map(String::as_str).collect();
        for (field, value) in missing
            .iter()
            .zip(crate::vault::read_many(SERVICE, &accounts)?)
        {
            if let Some(value) = value {
                if value.len() > 2048 {
                    return Err("자격 증명 형식을 확인하세요.".into());
                }
                fields.insert((*field).into(), Value::String(value));
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    for field in FIELDS {
        // Preserve legacy explicit settings until the next save migrates them into the vault.
        if fields.get(field).map_or(true, Value::is_null) {
            let entry =
                keyring::Entry::new(SERVICE, &format!("{ACCOUNT}:{field}")).map_err(|_| error())?;
            #[cfg(target_os = "windows")]
            let result = entry.get_secret().and_then(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|error| keyring::Error::BadEncoding(error.into_bytes()))
            });
            #[cfg(not(target_os = "windows"))]
            let result = entry.get_password();
            match result {
                Ok(value) if value.len() <= 2048 => {
                    fields.insert(field.into(), Value::String(value));
                }
                Ok(_) => return Err("자격 증명 형식을 확인하세요.".into()),
                Err(keyring::Error::NoEntry) => {}
                Err(_) => return Err(error()),
            }
        }
    }
    config = serde_json::from_value(merged).map_err(|_| "자격 증명 형식을 확인하세요.")?;
    config.validate()?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_file_contains_no_connection_secrets() {
        let config = AppConfig {
            youtube_api_key: Some("fake-test-key".into()),
            database_url: Some("postgresql://toris_app:fake@127.0.0.1:54329/toris_studio".into()),
            ..AppConfig::default()
        };
        let (public, secrets) = split(&config).unwrap();
        assert!(FIELDS.iter().all(|field| public[*field].is_null()));
        assert_eq!(secrets["youtubeApiKey"], "fake-test-key");
        assert!(!public.to_string().contains("fake-test-key"));
        assert_eq!(public["opencodexModel"], "gpt-6.1-sol");
    }
}
