//! Explicit exports of the editor snapshot. No user configuration or vault data.
use serde_json::Value;
use std::{io::Write, path::Path};

pub fn extension(format: &str) -> Result<&'static str, String> {
    match format {
        "json" => Ok("json"),
        "markdown" => Ok("md"),
        _ => Err("내보내기는 JSON 또는 Markdown을 선택하세요.".into()),
    }
}

fn prose(text: &str) -> String {
    text.chars()
        .flat_map(|character| match character {
            '<' => "&lt;".chars().collect::<Vec<_>>(),
            '>' => "&gt;".chars().collect(),
            '&' => "&amp;".chars().collect(),
            '\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '#' | '!' | '|' => {
                vec!['\\', character]
            }
            _ => vec![character],
        })
        .collect()
}

pub fn prepare(project: &Value, format: &str) -> Result<Vec<u8>, String> {
    extension(format)?;
    crate::media::validate_project(project)?;
    if format == "json" {
        return serde_json::to_vec_pretty(project)
            .map_err(|_| "프로젝트 JSON을 만들 수 없습니다.".into());
    }
    let value = |item: &Value, field: &str| prose(item[field].as_str().unwrap_or(""));
    let mut output = format!("# {}\n\n", value(project, "title"));
    output.push_str(&format!(
        "- 형식: {}\n- 언어: {}\n",
        value(project, "format"),
        value(project, "language")
    ));
    if let Some(name) = project["templateRecipe"]["name"].as_str() {
        output.push_str(&format!("- 템플릿: {}\n", prose(name)));
    }
    let scenes = project["scenes"]
        .as_array()
        .ok_or("장면 목록을 확인하세요.")?;
    let mut start = 0.0;
    for (index, scene) in scenes.iter().enumerate() {
        let duration = scene["durationSec"]
            .as_f64()
            .ok_or("장면 길이를 확인하세요.")?;
        output.push_str(&format!("\n## 장면 {} · {:.1}–{:.1}초\n\n### 제목\n\n{}\n\n### 본문\n\n{}\n\n### 내레이션\n\n{}\n", index + 1, start, start + duration, value(scene, "headline"), value(scene, "body"), value(scene, "narration")));
        if let Some(motion) = crate::motion::MotionSpec::from_scene(scene)? {
            output.push_str(&format!(
                "\n모션: {} · 강도 {:.2}\n",
                value(&scene["motion"], "preset"),
                motion.intensity
            ));
        }
        start += duration;
    }
    output.push_str(&format!(
        "\n---\n전체 {}장면 · {:.1}초\n",
        scenes.len(),
        start
    ));
    Ok(output.into_bytes())
}

/// Only call with a path returned by the native Save dialog, never an IPC path.
pub fn write_selected_file(path: &Path, format: &str, bytes: &[u8]) -> Result<(), String> {
    let expected = extension(format)?;
    if !path.is_absolute()
        || path
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case(expected))
    {
        return Err(format!("저장할 파일의 확장자를 .{expected}로 지정하세요."));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("일반 파일에만 내보낼 수 있습니다.".into());
        }
    }
    let directory = path.parent().ok_or("저장 경로를 확인하세요.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| "내보내기 파일을 만들 수 없습니다.")?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "내보내기 파일을 저장할 수 없습니다.")?;
    temporary
        .persist(path)
        .map_err(|_| "내보내기 파일을 저장할 수 없습니다.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Value {
        crate::video_templates::catalog()[0].sample_project.clone()
    }

    #[test]
    fn json_roundtrip_preserves_every_edited_field_without_saving_a_project() {
        let mut project = sample();
        project["scenes"][0]["narration"] = Value::String("내가 편집한 내레이션".into());
        let bytes = prepare(&project, "json").unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), project);
    }

    #[test]
    fn markdown_has_scene_times_copy_and_narration_and_escapes_active_markup() {
        let mut project = sample();
        project["title"] = Value::String("<script> & [제목](https://example.com)".into());
        let text = String::from_utf8(prepare(&project, "markdown").unwrap()).unwrap();
        assert!(text.contains("&lt;script&gt; &amp; \\[제목\\]"));
        assert!(!text.contains("<script>"));
        assert!(text.contains("### 본문") && text.contains("### 내레이션"));
        assert!(text.contains("전체 5장면 · 45.0초"));
    }

    #[test]
    fn invalid_exports_leave_selected_file_unchanged() {
        assert!(prepare(&sample(), "html").is_err());
        assert!(prepare(&serde_json::json!({"title":"잘못된 프로젝트"}), "json").is_err());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("existing.exe");
        std::fs::write(&path, b"keep").unwrap();
        assert!(write_selected_file(&path, "markdown", b"bad").is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"keep");
    }

    #[test]
    fn selected_export_is_atomic_and_does_not_touch_project_store() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("projects.json");
        std::fs::write(&store, b"preserve user store").unwrap();
        let path = directory.path().join("storyboard.md");
        let bytes = prepare(&sample(), "markdown").unwrap();
        write_selected_file(&path, "markdown", &bytes).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::read(&store).unwrap(), b"preserve user store");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
