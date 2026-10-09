//! Retire only the old Studio-owned WebUI container; never remove its volume.
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

const NAME: &str = "toris-studio-open-webui";
const VOLUME: &str = "toris-studio-open-webui-data";

fn binary() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "docker.exe"
    } else {
        "docker"
    };
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".orbstack/bin").join(name));
        candidates.push(home.join(".docker/bin").join(name));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&paths)
                .filter(|p| p.is_absolute())
                .map(|p| p.join(name)),
        );
    }
    candidates.into_iter().find(|p| p.is_file())
}
async fn call(binary: &std::path::Path, args: &[&str]) -> Result<Vec<u8>, ()> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .env_remove("DOCKER_HOST")
        .env_remove("DOCKER_CONTEXT")
        .env_remove("DOCKER_TLS_VERIFY")
        .env_remove("DOCKER_CERT_PATH")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| ())?;
    let mut stdout = child.stdout.take().ok_or(())?;
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut bytes = Vec::new();
        (&mut stdout)
            .take(8193)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| ())?;
        if bytes.len() > 8192 || !child.wait().await.map_err(|_| ())?.success() {
            return Err(());
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| ())?
}
fn owned(value: &Value) -> bool {
    let id = value["id"].as_str().unwrap_or("");
    value["name"] == format!("/{NAME}")
        && value["owner"] == "open-webui"
        && value["schema"] == "1"
        && id.len() == 64
        && id.bytes().all(|b| b.is_ascii_hexdigit())
        && value["mounts"].as_array().is_some_and(|mounts| {
            mounts.len() == 1
                && mounts[0]["Type"] == "volume"
                && mounts[0]["Name"] == VOLUME
                && mounts[0]["Destination"] == "/app/backend/data"
        })
}
pub async fn retire() -> Value {
    let Some(binary) = binary() else {
        return json!({"status":"unavailable"});
    };
    let host = call(
        &binary,
        &[
            "context",
            "inspect",
            "--format",
            "{{json .Endpoints.docker.Host}}",
        ],
    )
    .await;
    let local = host
        .ok()
        .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok())
        .is_some_and(|host| {
            host.starts_with("unix:///") || (cfg!(windows) && host.starts_with("npipe://"))
        });
    if !local {
        return json!({"status":"unavailable"});
    }
    // This format intentionally excludes container environment variables and credentials.
    let format = "{\"id\":{{json .Id}},\"name\":{{json .Name}},\"owner\":{{json (index .Config.Labels \"kr.toris.studio.managed\")}},\"schema\":{{json (index .Config.Labels \"kr.toris.studio.open-webui.schema\")}},\"mounts\":{{json .Mounts}}}";
    let Ok(bytes) = call(&binary, &["inspect", "--format", format, NAME]).await else {
        return json!({"status":"not_found"});
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return json!({"status":"unavailable"});
    };
    if !owned(&value) {
        return json!({"status":"not_owned"});
    }
    let id = value["id"].as_str().unwrap();
    match call(&binary, &["stop", "--time", "10", id]).await {
        Ok(_) => json!({"status":"retired","dataPreserved":true}),
        Err(_) => json!({"status":"unavailable","dataPreserved":true}),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_requires_exact_owned_container_and_volume() {
        let mut value = json!({"id":"a".repeat(64),"name":format!("/{NAME}"),"owner":"open-webui","schema":"1","mounts":[{"Type":"volume","Name":VOLUME,"Destination":"/app/backend/data"}]});
        assert!(owned(&value));
        value["mounts"][0]["Type"] = json!("bind");
        assert!(!owned(&value));
        value["mounts"][0]["Type"] = json!("volume");
        value["owner"] = json!("another-project");
        assert!(!owned(&value));
    }
}
