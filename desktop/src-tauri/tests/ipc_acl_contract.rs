use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, path::Path};
use toris_studio_desktop::ipc_commands::{
    permission_definition, COMMANDS, CORE_PERMISSIONS, MAIN_PERMISSION,
};

const ISOLATED_SMOKE_COMMAND: &str = "startup_smoke_result";

fn strings(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry.as_str().unwrap().to_owned())
        .collect()
}

fn declared_commands(
    directory: &Path,
    isolated_module: &Path,
    commands: &mut Vec<String>,
    isolated_commands: &mut Vec<String>,
) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            declared_commands(&path, isolated_module, commands, isolated_commands);
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
                if path == isolated_module {
                    // This exact private result handler belongs to a separate,
                    // isolated test builder. Never skip the entire module:
                    // another command here must fail this contract explicitly.
                    assert_eq!(
                        declaration, "fn startup_smoke_result(",
                        "only the private startup_smoke_result command may use the isolated builder"
                    );
                    isolated_commands.push(ISOLATED_SMOKE_COMMAND.to_owned());
                    continue;
                }
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
    let mut isolated = Vec::new();
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    declared_commands(
        &source,
        &source.join("startup_smoke.rs"),
        &mut declared,
        &mut isolated,
    );
    assert_eq!(isolated, [ISOLATED_SMOKE_COMMAND]);
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
fn startup_smoke_result_stays_exclusive_to_its_isolated_builder() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"));
    let smoke = fs::read_to_string(directory.join("src/startup_smoke.rs")).unwrap();
    let app = fs::read_to_string(directory.join("src/lib.rs")).unwrap();
    assert!(!COMMANDS.contains(&ISOLATED_SMOKE_COMMAND));
    assert!(!permission_definition().contains(ISOLATED_SMOKE_COMMAND));
    assert!(!app.contains(ISOLATED_SMOKE_COMMAND));
    assert!(!smoke.contains("app_command_registry!"));
    assert_eq!(smoke.matches("#[tauri::command]").count(), 1);
    assert_eq!(smoke.matches("tauri::Builder::default()").count(), 1);
    assert_eq!(smoke.matches(".invoke_handler(").count(), 1);
    assert!(smoke.contains(".invoke_handler(tauri::generate_handler![startup_smoke_result])"));
    assert_eq!(smoke.matches(".__allow_command(").count(), 1);
    let normalized = smoke.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(normalized.contains(
        "context.runtime_authority_mut().__allow_command( \"startup_smoke_result\".into(), tauri::utils::acl::ExecutionContext::Local, );"
    ));
    assert!(smoke.contains("const LABEL: &str = \"startup-smoke\";"));
    assert!(smoke.contains("if window.label() != LABEL {"));
    assert!(smoke.contains("context.config_mut().app.windows.clear();"));
    assert!(!smoke.contains(".plugin("));

    // The isolated builder must be selected before saved configuration can load.
    let entry = app.split("pub fn run() {").nth(1).unwrap();
    assert_eq!(entry.matches("startup_smoke::run()").count(), 1);
    assert!(
        entry.find("startup_smoke::run()").unwrap()
            < entry.find("config::AppConfig::load()").unwrap()
    );
    for capability in fs::read_dir(directory.join("capabilities")).unwrap() {
        let source = fs::read_to_string(capability.unwrap().path()).unwrap();
        assert!(!source.contains(ISOLATED_SMOKE_COMMAND));
        assert!(!source.contains("startup-smoke"));
    }
}

#[test]
#[should_panic(expected = "only the private startup_smoke_result command")]
fn isolated_module_cannot_hide_additional_commands_from_the_registry() {
    let directory = tempfile::tempdir().unwrap();
    let module = directory.path().join("startup_smoke.rs");
    fs::write(
        &module,
        "#[tauri::command]\nfn startup_smoke_result(\n) {}\n#[tauri::command]\nfn another_command(\n) {}\n",
    )
    .unwrap();
    declared_commands(directory.path(), &module, &mut Vec::new(), &mut Vec::new());
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
