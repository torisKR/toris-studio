//! A small, deterministic description of a project folder for the planning
//! stages. Planners on other machines cannot open the folder, so Studio reads
//! a few well-known files itself: the top-level layout, stack markers and the
//! start of the README. No model is involved and nothing is executed.
//!
//! The result is quoted into stage requests as data, and the user reviews the
//! whole request before it is sent. Only regular files are read (no symlinks,
//! devices or large files), each with its own byte cap.
use crate::reason_pipeline::plain_text;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub const MAX_SNAPSHOT_BYTES: usize = 6 * 1024;
const MAX_ENTRIES: usize = 48;
const MAX_README_BYTES: usize = 2 * 1024;
const MAX_MARKER_FILE: u64 = 256 * 1024;
const MAX_NAMES: usize = 30;
// Folders that say nothing about the project and can be huge.
const IGNORED: &[&str] = &[
    "node_modules",
    "target",
    "build",
    "dist",
    "out",
    "Pods",
    "DerivedData",
    "vendor",
    "__pycache__",
];
// File or folder name -> the stack it indicates.
const MARKERS: &[(&str, &str)] = &[
    ("package.json", "Node.js"),
    ("pnpm-workspace.yaml", "pnpm 워크스페이스"),
    ("tsconfig.json", "TypeScript"),
    ("next.config.ts", "Next.js"),
    ("next.config.js", "Next.js"),
    ("vite.config.ts", "Vite"),
    ("app.json", "Expo/React Native 설정"),
    ("pubspec.yaml", "Flutter/Dart"),
    ("Cargo.toml", "Rust"),
    ("go.mod", "Go"),
    ("pyproject.toml", "Python"),
    ("requirements.txt", "Python"),
    ("build.gradle", "Android/Gradle"),
    ("build.gradle.kts", "Android/Gradle"),
    ("settings.gradle.kts", "Android/Gradle"),
    ("Podfile", "iOS CocoaPods"),
    ("Package.swift", "Swift Package"),
    ("project.yml", "XcodeGen"),
    ("project.godot", "Godot"),
    ("ProjectSettings", "Unity"),
    ("android", "Android 폴더"),
    ("ios", "iOS 폴더"),
    ("src-tauri", "Tauri"),
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectInfo {
    /// Absolute folder the implementation agent serves.
    pub folder: String,
    pub name: String,
    pub branch: Option<String>,
    /// Session name of the Studio-started implementation agent for this folder.
    pub agent_name: String,
    pub agent_model: Option<String>,
    /// Plain text, at most `MAX_SNAPSHOT_BYTES`.
    pub snapshot: String,
}

fn small_file(path: &Path, limit: u64) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn cut(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…(잘림)", &text[..end])
}

fn names(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_object())
        .map(|map| map.keys().take(MAX_NAMES).cloned().collect())
        .unwrap_or_default()
}

fn package_summary(folder: &Path) -> Option<String> {
    let text = small_file(&folder.join("package.json"), MAX_MARKER_FILE)?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let mut out = String::new();
    if let Some(name) = json.get("name").and_then(|v| v.as_str()) {
        out.push_str(&format!("- package.json 이름: {name}\n"));
    }
    for (label, key) in [
        ("scripts", "scripts"),
        ("dependencies", "dependencies"),
        ("devDependencies", "devDependencies"),
    ] {
        let list = names(json.get(key));
        if !list.is_empty() {
            out.push_str(&format!("- {label}: {}\n", list.join(", ")));
        }
    }
    Some(out)
}

/// Reads the folder's layout and markers. Never fails: unreadable parts are left out.
pub fn snapshot(folder: &Path) -> String {
    let mut out = String::new();
    let mut entries: Vec<(String, bool)> = fs::read_dir(folder)
        .map(|dir| {
            dir.flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().to_str()?.to_string();
                    let meta = fs::symlink_metadata(entry.path()).ok()?;
                    (!name.starts_with('.') && !IGNORED.contains(&name.as_str()))
                        .then_some((name, meta.is_dir()))
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort();
    let stack: Vec<&str> = MARKERS
        .iter()
        .filter(|(marker, _)| entries.iter().any(|(name, _)| name == marker))
        .map(|(_, stack)| *stack)
        .fold(Vec::new(), |mut list, stack| {
            if !list.contains(&stack) {
                list.push(stack);
            }
            list
        });
    out.push_str(&format!(
        "- 감지한 구성: {}\n",
        if stack.is_empty() {
            "확인되지 않음".to_string()
        } else {
            stack.join(", ")
        }
    ));
    let total = entries.len();
    let listed: Vec<String> = entries
        .iter()
        .take(MAX_ENTRIES)
        .map(|(name, dir)| {
            if *dir {
                format!("{name}/")
            } else {
                name.clone()
            }
        })
        .collect();
    out.push_str(&format!(
        "- 최상위 항목{}: {}\n",
        if total > MAX_ENTRIES {
            format!(" ({total}개 중 {MAX_ENTRIES}개)")
        } else {
            String::new()
        },
        if listed.is_empty() {
            "(비어 있음)".to_string()
        } else {
            listed.join(", ")
        }
    ));
    if let Some(package) = package_summary(folder) {
        out.push_str(&package);
    }
    let readme = ["README.md", "readme.md", "README"]
        .iter()
        .find_map(|name| small_file(&folder.join(name), MAX_MARKER_FILE));
    if let Some(readme) = readme {
        let readme = plain_text(&readme);
        let readme = readme.trim();
        if !readme.is_empty() {
            out.push_str("\nREADME 앞부분:\n");
            out.push_str(&cut(readme, MAX_README_BYTES));
            out.push('\n');
        }
    }
    cut(plain_text(&out).trim(), MAX_SNAPSHOT_BYTES)
}

/// Describes the folder a confirmed implementation session serves.
pub fn describe(
    folder: &str,
    branch: Option<String>,
    agent_name: &str,
    agent_model: Option<String>,
) -> ProjectInfo {
    let path = Path::new(folder);
    ProjectInfo {
        folder: folder.to_string(),
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("project")
            .to_string(),
        branch,
        agent_name: agent_name.to_string(),
        agent_model,
        snapshot: snapshot(path),
    }
}
