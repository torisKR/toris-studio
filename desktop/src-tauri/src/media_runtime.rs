//! Packaged media dependencies: no PATH fallback in installed builds.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};
pub fn directory() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "앱 경로를 찾을 수 없습니다.")?;
    let base = exe.parent().ok_or("앱 경로 오류")?;
    #[cfg(target_os = "macos")]
    if base.file_name().is_some_and(|n| n == "MacOS") {
        return Ok(base
            .parent()
            .ok_or("앱 리소스 경로 오류")?
            .join("Resources/media-runtime"));
    }
    if base.join("media-runtime").is_dir() {
        return Ok(base.join("media-runtime"));
    }
    #[cfg(debug_assertions)]
    {
        let target = if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                "aarch64-apple-darwin"
            } else {
                "x86_64-apple-darwin"
            }
        } else {
            "x86_64-pc-windows-msvc"
        };
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("media-runtime")
            .join(target));
    }
    #[cfg(not(debug_assertions))]
    Err("동봉 미디어 도구 폴더가 없습니다. 공식 설치 파일로 복구하세요.".into())
}
fn verify_at(dir: &Path) -> Result<(), String> {
    let manifest: Value = serde_json::from_slice(
        &fs::read(dir.join("manifest.json"))
            .map_err(|_| "동봉 FFmpeg 목록이 없습니다. 공식 설치 파일로 복구하세요.")?,
    )
    .map_err(|_| "미디어 도구 목록이 손상되었습니다.")?;
    for name in [
        if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        },
        if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        },
        "NotoSansCJKkr-Regular.otf",
    ] {
        let file = dir.join(name);
        if fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("동봉 {name} 파일 형식 오류"));
        }
        let bytes = fs::read(file)
            .map_err(|_| format!("동봉 {name} 파일이 없습니다. 공식 설치 파일로 복구하세요."))?;
        let hash = format!("{:x}", Sha256::digest(bytes));
        if manifest["files"][name].as_str() != Some(&hash) {
            return Err(format!(
                "동봉 {name} 파일이 손상되었습니다. 공식 설치 파일로 복구하세요."
            ));
        }
    }
    Ok(())
}
pub fn resource(name: &str) -> Result<PathBuf, String> {
    static VERIFIED: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    let dir = VERIFIED
        .get_or_init(|| {
            let dir = directory()?;
            verify_at(&dir)?;
            Ok(dir)
        })
        .clone()?;
    if !["ffmpeg", "ffprobe", "NotoSansCJKkr-Regular.otf"].contains(&name) {
        return Err("미디어 리소스 이름 오류".into());
    }
    Ok(
        dir.join(if cfg!(windows) && name != "NotoSansCJKkr-Regular.otf" {
            format!("{name}.exe")
        } else {
            name.to_string()
        }),
    )
}
