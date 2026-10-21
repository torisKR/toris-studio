use serde::Deserialize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportInput {
    pub filename: String,
    pub content: String,
}
pub fn validate(input: &ReportInput) -> Result<&str, String> {
    if input.filename.is_empty()
        || input.filename.len() > 120
        || input.filename.contains(['/', '\\'])
        || input.filename.chars().any(char::is_control)
        || input.content.len() > 16 * 1024 * 1024
    {
        return Err("내보내기 파일명과 크기를 확인하세요.".into());
    }
    let extension = std::path::Path::new(&input.filename)
        .extension()
        .and_then(|s| s.to_str())
        .ok_or("파일 확장자를 확인하세요.")?;
    if !["csv", "txt", "json"].contains(&extension) {
        return Err("CSV·TXT·JSON 파일만 내보낼 수 있습니다.".into());
    }
    Ok(extension)
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn workspace_export_report(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    input: ReportInput,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    crate::updater::authorize(&window)?;
    let extension = validate(&input)?.to_string();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&input.filename)
        .add_filter("보고서", &[&extension])
        .save_file(move |file| {
            let _ = send.send(file);
        });
    let Some(file) = receive
        .await
        .map_err(|_| "파일 선택을 완료하지 못했습니다.")?
    else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| "로컬 저장 경로를 확인하세요.")?;
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        if !path.is_absolute()
            || path.extension().and_then(|s| s.to_str()) != Some(extension.as_str())
        {
            return Err("선택한 보고서 확장자를 확인하세요.".into());
        }
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("일반 파일로만 내보낼 수 있습니다.".into());
            }
        }
        let mut file =
            tempfile::NamedTempFile::new_in(path.parent().ok_or("저장 경로를 확인하세요.")?)
                .map_err(|_| "임시 파일을 만들 수 없습니다.")?;
        file.write_all(input.content.as_bytes())
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| "보고서를 저장하지 못했습니다.")?;
        file.persist(&path)
            .map_err(|_| "보고서를 저장하지 못했습니다.")?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "보고서를 내보내지 못했습니다.")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_has_no_ipc_path_or_executable_extension() {
        assert!(validate(&ReportInput {
            filename: "report.csv".into(),
            content: "0".into()
        })
        .is_ok());
        for name in ["../report.csv", "report.sh", "a/b.csv", "a\\b.csv"] {
            assert!(validate(&ReportInput {
                filename: name.into(),
                content: String::new()
            })
            .is_err());
        }
        assert!(serde_json::from_value::<ReportInput>(
            serde_json::json!({"filename":"r.csv","content":"","path":"/tmp/arbitrary"})
        )
        .is_err());
    }
}
