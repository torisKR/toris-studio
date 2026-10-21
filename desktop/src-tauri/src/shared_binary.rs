//! Shared media-lease runtime resolution, independent of model/coding bridges.
use std::path::{Path, PathBuf};
pub(crate) fn cloudflared_binary() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    resolve(
        &executable,
        dirs::home_dir().as_deref(),
        cfg!(debug_assertions),
    )
}
fn resolve(executable: &Path, home: Option<&Path>, development: bool) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };
    let sibling = executable.parent()?.join(name);
    if sibling.is_file() {
        return Some(sibling);
    }
    if development {
        let mut candidates = vec![
            PathBuf::from("/opt/homebrew/bin").join(name),
            PathBuf::from("/usr/local/bin").join(name),
        ];
        if let Some(home) = home {
            candidates.push(home.join(".cloudflared/bin").join(name));
        }
        return candidates.into_iter().find(|p| p.is_file());
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_resolution_uses_only_packaged_media_runtime() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("studio");
        assert!(resolve(&exe, None, false).is_none());
        let file = root.path().join(if cfg!(windows) {
            "cloudflared.exe"
        } else {
            "cloudflared"
        });
        std::fs::write(&file, b"fixture").unwrap();
        assert_eq!(resolve(&exe, None, false), Some(file));
    }
}
