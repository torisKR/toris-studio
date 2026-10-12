use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, path::Path};
use toris_studio_desktop::ipc_commands::{
    permission_definition, COMMANDS, CORE_PERMISSIONS, MAIN_PERMISSION,
};

fn strings(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry.as_str().unwrap().to_owned())
        .collect()
}

fn declared_commands(directory: &Path, commands: &mut Vec<String>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            declared_commands(&path, commands);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            let source = fs::read_to_string(&path).unwrap();
            let mut lines = source.lines();
            while let Some(line) = lines.next() {
                if !line.trim().starts_with("#[tauri::command") {
                    continue;
                }
                // A renamed command needs an explicit contract update, rather
                // than silently comparing its Rust name with a different IPC name.
                assert_eq!(line.trim(), "#[tauri::command]", "{}", path.display());
                let declaration = lines.next().unwrap().trim();
                let name = declaration
                    .strip_prefix("pub async fn ")
                    .or_else(|| declaration.strip_prefix("pub fn "))
                    .expect("an application command must have a public function declaration")
                    .split('(')
                    .next()
                    .unwrap();
                commands.push(name.to_owned());
            }
        }
    }
}

#[test]
fn registry_contains_every_native_command_once() {
    let mut declared = Vec::new();
    declared_commands(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut declared,
    );
    let declared_set: BTreeSet<_> = declared.iter().map(String::as_str).collect();
    let registered: BTreeSet<_> = COMMANDS.iter().copied().collect();
    assert_eq!(
        declared_set.len(),
        declared.len(),
        "ambiguous IPC command names"
    );
    assert_eq!(
        registered.len(),
        COMMANDS.len(),
        "duplicate registry entries"
    );
    assert_eq!(
        registered, declared_set,
        "declared and registered commands drifted"
    );
    assert!(registered.iter().all(|name| name
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')));
}

#[test]
fn central_permission_grants_exactly_the_registered_commands() {
    let definition: Value = serde_json::from_str(&permission_definition()).unwrap();
    assert!(definition.get("default").is_none());
    assert!(definition.get("set").is_none());
    let permissions = definition["permission"].as_array().unwrap();
    assert_eq!(permissions.len(), 1);
    assert_eq!(permissions[0]["identifier"], MAIN_PERMISSION);
    assert_eq!(permissions[0]["commands"]["allow"], json!(COMMANDS));
    assert_eq!(permissions[0]["commands"]["deny"], json!([]));
    assert!(permissions[0].get("scope").is_none());
}

#[test]
fn only_local_main_receives_application_commands_and_event_listeners() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"));
    let capabilities: Vec<_> = fs::read_dir(directory.join("capabilities"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json" || extension == "toml")
        })
        .collect();
    assert_eq!(
        capabilities.len(),
        1,
        "new capabilities require an ACL review"
    );
    let capability: Value = serde_json::from_slice(&fs::read(&capabilities[0]).unwrap()).unwrap();
    assert_eq!(capability["identifier"], "main-local");
    assert_eq!(capability["local"], true);
    assert_eq!(capability["windows"], json!(["main"]));
    assert!(capability.get("remote").is_none());
    assert!(capability.get("webviews").is_none());
    let expected: BTreeSet<_> = std::iter::once(MAIN_PERMISSION)
        .chain(CORE_PERMISSIONS.iter().copied())
        .map(str::to_owned)
        .collect();
    assert_eq!(strings(&capability["permissions"]), expected);
    assert_eq!(
        capability["permissions"].as_array().unwrap().len(),
        expected.len()
    );
    let config: Value =
        serde_json::from_slice(&fs::read(directory.join("tauri.conf.json")).unwrap()).unwrap();
    if let Some(selected) = config["app"]["security"].get("capabilities") {
        assert_eq!(selected, &json!(["main-local"]));
    }
}

#[cfg(feature = "desktop")]
#[test]
fn compiled_application_manifest_preserves_the_explicit_grant() {
    let directory = Path::new(env!("OUT_DIR"));
    let manifests: Value =
        serde_json::from_slice(&fs::read(directory.join("acl-manifests.json")).unwrap()).unwrap();
    let app = &manifests["__app-acl__"];
    assert_eq!(
        app["permissions"][MAIN_PERMISSION]["commands"]["allow"],
        json!(COMMANDS)
    );
    assert_eq!(
        app["permissions"][MAIN_PERMISSION]["commands"]["deny"],
        json!([])
    );
    let capabilities: Value =
        serde_json::from_slice(&fs::read(directory.join("capabilities.json")).unwrap()).unwrap();
    assert_eq!(capabilities.as_object().unwrap().len(), 1);
    let main = &capabilities["main-local"];
    assert!(main.get("remote").is_none());
    assert_eq!(main["windows"], json!(["main"]));
    assert_eq!(
        strings(&main["permissions"]),
        std::iter::once(MAIN_PERMISSION)
            .chain(CORE_PERMISSIONS.iter().copied())
            .map(str::to_owned)
            .collect()
    );
}
