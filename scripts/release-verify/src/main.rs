use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, env, fs, path::Path};

const REPOSITORY: &str = "torisKR/toris-studio";
const TARGETS: [(&str, &str, &str); 3] = [
    (
        "darwin-aarch64",
        "Toris-Studio-macOS-arm64.dmg",
        "Toris-Studio-macOS-arm64.app.tar.gz",
    ),
    (
        "darwin-x86_64",
        "Toris-Studio-macOS-x64.dmg",
        "Toris-Studio-macOS-x64.app.tar.gz",
    ),
    (
        "windows-x86_64",
        "Toris-Studio-Windows-x64-setup.exe",
        "Toris-Studio-Windows-x64-setup.exe",
    ),
];

fn regular_file(directory: &Path, name: &str, max: u64) -> Result<Vec<u8>, String> {
    let file = directory.join(name);
    let metadata =
        fs::symlink_metadata(&file).map_err(|_| format!("Missing release asset: {name}"))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > max
    {
        return Err(format!("Invalid release asset: {name}"));
    }
    fs::read(file).map_err(|_| format!("Cannot read release asset: {name}"))
}

fn verify_signature(
    public_key: &PublicKey,
    encoded: &str,
    content: &[u8],
    version: &str,
) -> Result<(), String> {
    let decoded = STANDARD
        .decode(encoded.trim())
        .map_err(|_| "Malformed updater signature encoding")?;
    let text = std::str::from_utf8(&decoded).map_err(|_| "Malformed updater signature text")?;
    let signature = Signature::decode(text).map_err(|_| "Malformed minisign updater signature")?;
    public_key
        .verify(content, &signature, false)
        .map_err(|_| "Updater signature verification failed")?;
    let versions: Vec<_> = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|field| field.strip_prefix("version:"))
        .collect();
    if versions.as_slice() != [version] {
        return Err("Authenticated updater version must match the release version".into());
    }
    Ok(())
}

fn generate(
    directory: &Path,
    config_path: &Path,
    version: &str,
    commit: &str,
) -> Result<(), String> {
    let config: Value =
        serde_json::from_slice(&fs::read(config_path).map_err(|_| "Missing Tauri configuration")?)
            .map_err(|_| "Invalid Tauri configuration")?;
    if config["version"] != version
        || !stable_version(version)
        || commit.len() != 40
        || !commit
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("Release source and stable version must match Tauri configuration".into());
    }
    let encoded_key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("Updater public key is missing")?;
    let decoded_key = STANDARD
        .decode(encoded_key.trim())
        .map_err(|_| "Invalid updater public key encoding")?;
    let public_key = PublicKey::decode(
        std::str::from_utf8(&decoded_key).map_err(|_| "Invalid updater public key text")?,
    )
    .map_err(|_| "Invalid updater public key")?;
    let mut allowed = BTreeSet::new();
    let mut assets = BTreeSet::new();
    let mut builds = Vec::new();
    let mut platforms = serde_json::Map::new();
    for (target, installer, updater) in TARGETS {
        allowed.insert(format!("build-{target}.json"));
        assets.insert(installer.to_string());
        assets.insert(updater.to_string());
        assets.insert(format!("{updater}.sig"));
        let build: Value = serde_json::from_slice(&regular_file(
            directory,
            &format!("build-{target}.json"),
            8192,
        )?)
        .map_err(|_| "Invalid native build metadata")?;
        if build["schemaVersion"] != 1
            || build["platform"] != target
            || build["version"] != version
            || build["commit"] != commit
        {
            return Err(format!("Native build source/version mismatch: {target}"));
        }
        builds.push(build);
        let updater_bytes = regular_file(directory, updater, 512 * 1024 * 1024)?;
        let signature =
            String::from_utf8(regular_file(directory, &format!("{updater}.sig"), 8192)?)
                .map_err(|_| "Invalid updater signature UTF-8")?;
        verify_signature(&public_key, &signature, &updater_bytes, version)?;
        platforms.insert(target.into(), json!({"url": format!("https://github.com/{REPOSITORY}/releases/download/v{version}/{updater}"), "signature": signature.trim()}));
    }
    allowed.extend(assets.iter().cloned());
    allowed.extend([
        "latest.json".into(),
        "release-manifest.json".into(),
        "SHA256SUMS".into(),
        "DOWNLOADS.md".into(),
    ]);
    for entry in fs::read_dir(directory).map_err(|_| "Cannot read release directory")? {
        let name = entry
            .map_err(|_| "Cannot read release directory entry")?
            .file_name()
            .to_string_lossy()
            .into_owned();
        if !allowed.contains(&name) {
            return Err(format!("Unexpected file in release directory: {name}"));
        }
    }
    let mut files = Vec::new();
    let mut checksums = String::new();
    for name in assets {
        let bytes = regular_file(directory, &name, 512 * 1024 * 1024)?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        checksums.push_str(&format!("{sha256}  {name}\n"));
        files.push(json!({"name": name, "size": bytes.len(), "sha256": sha256}));
    }
    let latest = json!({"version": version, "notes": format!("Toris Studio {version}: macOS and Windows desktop update."), "platforms": platforms});
    let manifest = json!({"schemaVersion": 1, "version": version, "commit": commit, "signatureVerification": "minisign-verify", "builds": builds, "files": files});
    for (name, value) in [("latest.json", latest), ("release-manifest.json", manifest)] {
        fs::write(
            directory.join(name),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&value)
                    .map_err(|_| "Cannot serialize release manifest")?
            ),
        )
        .map_err(|_| "Cannot write release manifest")?;
    }
    fs::write(directory.join("SHA256SUMS"), checksums)
        .map_err(|_| "Cannot write release checksums")?;
    println!(
        "Verified all three native targets, their authenticated versions, and updater signatures."
    );
    Ok(())
}

fn stable_version(version: &str) -> bool {
    let components: Vec<_> = version.split('.').collect();
    components.len() == 3
        && components.iter().all(|s| {
            !s.is_empty()
                && s.bytes().all(|b| b.is_ascii_digit())
                && (s.len() == 1 || !s.starts_with('0'))
        })
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 4 {
        eprintln!("Usage: toris-release-verify ASSETS TAURI_CONFIG VERSION COMMIT");
        std::process::exit(1);
    }
    if let Err(error) = generate(Path::new(&args[0]), Path::new(&args[1]), &args[2], &args[3]) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_version_rejects_injection_and_prereleases() {
        assert!(stable_version("0.1.7"));
        for value in ["01.2.3", "1.2", "1.2.3-rc1", "1.2.3\n", "1.2.$(id)"] {
            assert!(!stable_version(value));
        }
    }
    #[test]
    fn cryptographic_verification_rejects_tampering_and_missing_version() {
        // Public fixture from minisign-verify. This is a public verification key, never a private signing key.
        let key =
            PublicKey::from_base64("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")
                .unwrap();
        let signature = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
        let encoded = STANDARD.encode(signature);
        assert!(verify_signature(&key, &encoded, b"Test", "0.1.7")
            .unwrap_err()
            .contains("verification failed"));
        assert!(verify_signature(&key, &encoded, b"test", "0.1.7")
            .unwrap_err()
            .contains("version"));
    }
}
