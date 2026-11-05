//! Pinned factory tool execution. The model and the Node runtime never choose
//! the binary or the argument vector. A mismatch, a missing binary, or a
//! working directory outside the projects root does not spawn a process.
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const TOOL_MISSING: &str = "도구를 실행하지 않았습니다";
const TOOL_TIMEOUT: Duration = Duration::from_secs(120);

pub struct ExecOutcome {
    pub exit: Option<i32>,
    pub log: String,
}

pub fn execute(tool: &str, args: &[String], cwd: &str, projects_root: &str) -> ExecOutcome {
    execute_with(
        tool,
        args,
        cwd,
        projects_root,
        |key| std::env::var(key).ok(),
        std_spawn,
    )
}

/// Host-side handler for a `factory.tool` event. The jail root is the host's
/// projects directory, not the path the child put on the event.
pub fn from_event(event: &Value, projects_root: &str) -> Value {
    let call_id = event["callId"].as_str().unwrap_or("");
    let tool = event["tool"].as_str().unwrap_or("");
    let cwd = event["cwd"].as_str().unwrap_or("");
    let args_value = event.get("args").and_then(Value::as_array);
    let args_ok = args_value.is_some_and(|items| items.iter().all(Value::is_string));
    if !call_id_ok(call_id) || !args_ok {
        return blocked_json(call_id, "허용되지 않은 인자입니다.");
    }
    let args: Vec<String> = args_value
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect();
    let result = execute(tool, &args, cwd, projects_root);
    json!({"callId": call_id, "exit": result.exit, "log": result.log})
}

fn execute_with<E, S>(
    tool: &str,
    args: &[String],
    cwd: &str,
    projects_root: &str,
    env: E,
    spawn: S,
) -> ExecOutcome
where
    E: Fn(&str) -> Option<String>,
    S: FnOnce(&Path, &[String], &Path) -> std::io::Result<(Option<i32>, String)>,
{
    let Some(planned) = expected_args(tool, args) else {
        return blocked("허용되지 않은 인자입니다.");
    };
    let Ok(dir) = project_dir(cwd, projects_root) else {
        return blocked("프로젝트 밖으로 나갈 수 없습니다.");
    };
    let Ok(binary) = binary_path(tool, &env) else {
        return blocked(tool);
    };
    match spawn(&binary, &planned, &dir) {
        Ok((exit, log)) => ExecOutcome {
            exit,
            log: clip(&log),
        },
        Err(_) => blocked(tool),
    }
}

fn blocked(detail: &str) -> ExecOutcome {
    ExecOutcome {
        exit: None,
        log: format!("{TOOL_MISSING}: {detail}"),
    }
}

fn blocked_json(call_id: &str, detail: &str) -> Value {
    let result = blocked(detail);
    json!({"callId": call_id, "exit": result.exit, "log": result.log})
}

fn call_id_ok(call_id: &str) -> bool {
    let bytes = call_id.as_bytes();
    (8..=80).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

fn expected_args(tool: &str, args: &[String]) -> Option<Vec<String>> {
    let expected = match tool {
        "godot_import" => list(&["--headless", "--path", ".", "--import", "--quit"]),
        "godot_build_debug" => list(&[
            "--headless",
            "--path",
            ".",
            "--export-debug",
            "Android",
            "build/factory-debug.apk",
        ]),
        "sprite_gen_prepare" => list(&["prepare"]),
        "sprite_gen_extract" => list(&["extract"]),
        "pixelfx_render" => {
            let effect = args.get(1)?.as_str();
            if !matches!(effect, "fireball" | "hit" | "slash" | "spark") {
                return None;
            }
            vec![
                "tools/render.mjs".to_string(),
                effect.to_string(),
                "--sheet".to_string(),
            ]
        }
        "blender_export" => list(&[
            "--background",
            "--python",
            "tools/blender_export.py",
            "--",
            "data/models.json",
        ]),
        "gradle_build" => list(&["assembleDebug"]),
        "adb_devices" => list(&["devices"]),
        "adb_install" => list(&["install", "-r", "build/factory-debug.apk"]),
        "adb_launch" => list(&[
            "shell",
            "am",
            "start",
            "-n",
            "kr.toris.factory/.MainActivity",
        ]),
        _ => return None,
    };
    if args == expected {
        Some(expected)
    } else {
        None
    }
}

fn list(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_string()).collect()
}

fn project_dir(cwd: &str, projects_root: &str) -> Result<PathBuf, ()> {
    let cwd_path = Path::new(cwd);
    let root_path = Path::new(projects_root);
    if !cwd_path.is_absolute()
        || !root_path.is_absolute()
        || has_parent(cwd_path)
        || has_parent(root_path)
    {
        return Err(());
    }
    let root = root_path.canonicalize().map_err(|_| ())?;
    let dir = cwd_path.canonicalize().map_err(|_| ())?;
    if !dir.is_dir() || dir == root || !dir.starts_with(&root) {
        return Err(());
    }
    Ok(dir)
}

fn binary_path(tool: &str, env: &impl Fn(&str) -> Option<String>) -> Result<PathBuf, ()> {
    let key = env_key(tool).ok_or(())?;
    let raw = env(key).unwrap_or_default();
    let path = PathBuf::from(&raw);
    if !path.is_absolute() || has_parent(&path) || !path.is_file() {
        return Err(());
    }
    let real = path.canonicalize().map_err(|_| ())?;
    if !allowed_base(tool, &base_name(&real)) {
        return Err(());
    }
    Ok(real)
}

fn env_key(tool: &str) -> Option<&'static str> {
    Some(match tool {
        "godot_import" | "godot_build_debug" => "TORIS_FACTORY_GODOT",
        "sprite_gen_prepare" | "sprite_gen_extract" => "TORIS_FACTORY_SPRITE_GEN",
        "pixelfx_render" => "TORIS_FACTORY_NODE",
        "blender_export" => "TORIS_FACTORY_BLENDER",
        "gradle_build" => "TORIS_FACTORY_GRADLE",
        "adb_devices" | "adb_install" | "adb_launch" => "TORIS_FACTORY_ADB",
        _ => return None,
    })
}

fn allowed_base(tool: &str, name: &str) -> bool {
    matches!(
        (tool, name),
        ("godot_import" | "godot_build_debug", "godot" | "godot.exe")
            | (
                "sprite_gen_prepare" | "sprite_gen_extract",
                "sprite-gen" | "sprite-gen.exe" | "sprite-gen.cmd"
            )
            | ("pixelfx_render", "node" | "node.exe")
            | ("blender_export", "blender" | "blender.exe")
            | ("gradle_build", "gradle" | "gradle.bat")
            | (
                "adb_devices" | "adb_install" | "adb_launch",
                "adb" | "adb.exe"
            )
    )
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn has_parent(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn clip(log: &str) -> String {
    log.chars().take(2000).collect()
}

/// `Command::new` does not invoke a shell. The child does not inherit API keys.
fn std_spawn(binary: &Path, args: &[String], cwd: &Path) -> std::io::Result<(Option<i32>, String)> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    for key in [
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
        "HOME",
        "USERPROFILE",
        "TMP",
        "TEMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "PATHEXT",
    ] {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("stderr"))?;
    let out = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > TOOL_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out.join();
            let _ = err.join();
            return Ok((None, "도구 실행 시간이 초과되었습니다.".into()));
        }
        thread::sleep(Duration::from_millis(40));
    };
    let mut log = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    log.push_str(&String::from_utf8_lossy(&err.join().unwrap_or_default()));
    Ok((status.code(), log))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("toris-factory-exec-{nanos}-{n}"));
            fs::create_dir_all(dir.join("projects").join("game")).unwrap();
            Self(dir)
        }
        fn root(&self) -> PathBuf {
            self.0.join("projects")
        }
        fn game(&self) -> PathBuf {
            self.root().join("game")
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn godot_args() -> Vec<String> {
        ["--headless", "--path", ".", "--import", "--quit"]
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    fn run(
        tool: &str,
        args: &[String],
        cwd: &Path,
        root: &Path,
        binary: Option<&Path>,
        spawn: &mut dyn FnMut() -> bool,
    ) -> ExecOutcome {
        let binary = binary.map(|path| path.display().to_string());
        execute_with(
            tool,
            args,
            &cwd.display().to_string(),
            &root.display().to_string(),
            |key| {
                if key == "TORIS_FACTORY_GODOT" {
                    binary.clone()
                } else {
                    None
                }
            },
            |_, _, _| {
                if !spawn() {
                    panic!("spawned");
                }
                Ok((Some(0), String::new()))
            },
        )
    }

    #[test]
    fn path_escape_does_not_spawn() {
        let tmp = Tmp::new();
        let mut spawned = false;
        let outside = tmp.0.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let escaped = format!("{}/../outside", tmp.root().display());
        let outcome = run(
            "godot_import",
            &godot_args(),
            Path::new(&escaped),
            &tmp.root(),
            None,
            &mut || {
                spawned = true;
                true
            },
        );
        assert!(!spawned);
        assert!(outcome.exit.is_none());
        assert!(outcome.log.contains("프로젝트 밖으로"));

        #[cfg(unix)]
        {
            let link = tmp.root().join("link");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            let mut spawned = false;
            let outcome = run(
                "godot_import",
                &godot_args(),
                &link,
                &tmp.root(),
                None,
                &mut || {
                    spawned = true;
                    true
                },
            );
            assert!(!spawned);
            assert!(outcome.log.contains("프로젝트 밖으로"));
        }
    }

    #[test]
    fn disallowed_args_do_not_spawn() {
        let tmp = Tmp::new();
        let binary = tmp.game().join("godot");
        fs::write(&binary, b"not-run").unwrap();
        let mut spawned = false;
        let args = vec!["--headless".into(), "--quit".into()];
        let outcome = run(
            "godot_import",
            &args,
            &tmp.game(),
            &tmp.root(),
            Some(&binary),
            &mut || {
                spawned = true;
                true
            },
        );
        assert!(!spawned);
        assert!(outcome.log.contains("허용되지 않은 인자"));
        let shell = vec!["assembleDebug; rm -rf /".into()];
        let outcome = execute_with(
            "gradle_build",
            &shell,
            &tmp.game().display().to_string(),
            &tmp.root().display().to_string(),
            |_| None,
            |_, _, _| {
                spawned = true;
                Ok((Some(0), String::new()))
            },
        );
        assert!(!spawned);
        assert!(outcome.exit.is_none());
    }

    #[test]
    fn missing_or_renamed_binary_does_not_spawn() {
        let tmp = Tmp::new();
        let missing = tmp.game().join("godot");
        let mut spawned = false;
        let outcome = run(
            "godot_import",
            &godot_args(),
            &tmp.game(),
            &tmp.root(),
            Some(&missing),
            &mut || {
                spawned = true;
                true
            },
        );
        assert!(!spawned);
        assert!(outcome.log.starts_with(TOOL_MISSING));
        assert!(outcome.log.contains("godot_import"));

        #[cfg(unix)]
        {
            let decoy = tmp.0.join("bash");
            fs::write(&decoy, b"nope").unwrap();
            let link = tmp.game().join("godot");
            std::os::unix::fs::symlink(&decoy, &link).unwrap();
            let mut spawned = false;
            let outcome = run(
                "godot_import",
                &godot_args(),
                &tmp.game(),
                &tmp.root(),
                Some(&link),
                &mut || {
                    spawned = true;
                    true
                },
            );
            assert!(
                !spawned,
                "a pin that resolves to another file name must not run"
            );
            assert!(outcome.log.contains(TOOL_MISSING));
        }
    }

    #[test]
    fn canonical_args_reach_spawn_as_a_vector() {
        let tmp = Tmp::new();
        let binary = tmp.game().join("godot");
        fs::write(&binary, b"not-run").unwrap();
        let mut seen = None;
        let outcome = execute_with(
            "godot_import",
            &godot_args(),
            &tmp.game().display().to_string(),
            &tmp.root().display().to_string(),
            |key| (key == "TORIS_FACTORY_GODOT").then(|| binary.display().to_string()),
            |bin, args, cwd| {
                seen = Some((bin.to_path_buf(), args.to_vec(), cwd.to_path_buf()));
                Ok((Some(0), "ok".into()))
            },
        );
        let (bin, args, cwd) = seen.expect("pinned command spawns");
        assert_eq!(bin, binary.canonicalize().unwrap());
        assert_eq!(args, godot_args());
        assert_eq!(cwd, tmp.game().canonicalize().unwrap());
        assert_eq!(outcome.exit, Some(0));
    }
}
