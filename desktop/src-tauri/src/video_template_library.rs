//! A small, private per-user list of template IDs. This store never touches
//! project/media files, account credentials, provider settings, or the catalog.
use crate::video_templates::validate_template_id;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

const STORE_LIMIT: u64 = 16 * 1024;
const LIST_LIMIT: usize = 10;
const DIRECTORY: &str = "video-template-library";
const FILENAME: &str = "state.json";
static LIBRARY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateLibraryState {
    pub version: u8,
    pub favorites: Vec<String>,
    pub recent: Vec<String>,
}

impl Default for TemplateLibraryState {
    fn default() -> Self {
        Self {
            version: 1,
            favorites: Vec::new(),
            recent: Vec::new(),
        }
    }
}

fn validate(state: &TemplateLibraryState) -> Result<(), String> {
    if state.version != 1 {
        return Err("영상 템플릿 라이브러리 버전을 확인하세요.".into());
    }
    for list in [&state.favorites, &state.recent] {
        let mut seen = HashSet::new();
        if list.len() > LIST_LIMIT
            || list
                .iter()
                .any(|id| !seen.insert(id.as_str()) || validate_template_id(id).is_err())
        {
            return Err("영상 템플릿 라이브러리의 저장된 목록을 확인하세요.".into());
        }
    }
    Ok(())
}

/// The base is an app-owned native path, never supplied by renderer IPC. IDs
/// are validated separately and never become path components. Canonicalize
/// the base before joining our fixed subdirectory and reject links at each
/// app-owned boundary; legitimate system ancestors may themselves be links.
fn store_path(app_data_path: &Path, create: bool) -> Result<Option<PathBuf>, String> {
    if !app_data_path.is_absolute()
        || app_data_path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("영상 템플릿 저장 경로를 확인하세요.".into());
    }
    let base = match fs::symlink_metadata(app_data_path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("영상 템플릿 저장 폴더 형식을 확인하세요.".into());
            }
            app_data_path
                .canonicalize()
                .map_err(|_| "영상 템플릿 저장 폴더를 확인할 수 없습니다.")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !create {
                return Ok(None);
            }
            fs::create_dir_all(app_data_path)
                .map_err(|_| "영상 템플릿 저장 폴더를 만들 수 없습니다.")?;
            let metadata = fs::symlink_metadata(app_data_path)
                .map_err(|_| "영상 템플릿 저장 폴더를 확인할 수 없습니다.")?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("영상 템플릿 저장 폴더 형식을 확인하세요.".into());
            }
            app_data_path
                .canonicalize()
                .map_err(|_| "영상 템플릿 저장 폴더를 확인할 수 없습니다.")?
        }
        Err(_) => return Err("영상 템플릿 저장 폴더를 확인할 수 없습니다.".into()),
    };
    let directory = base.join(DIRECTORY);
    match fs::symlink_metadata(&directory) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("영상 템플릿 전용 폴더 형식을 확인하세요.".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !create {
                return Ok(None);
            }
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(&directory)
                .map_err(|_| "영상 템플릿 전용 폴더를 만들 수 없습니다.")?;
        }
        Err(_) => return Err("영상 템플릿 전용 폴더를 확인할 수 없습니다.".into()),
    }
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|_| "영상 템플릿 전용 폴더를 확인할 수 없습니다.")?;
    let directory = directory
        .canonicalize()
        .map_err(|_| "영상 템플릿 전용 폴더를 확인할 수 없습니다.")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || directory.parent() != Some(base.as_path())
    {
        return Err("영상 템플릿 전용 폴더 형식을 확인하세요.".into());
    }
    #[cfg(unix)]
    if create {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "영상 템플릿 전용 폴더 권한을 설정할 수 없습니다.")?;
    }
    Ok(Some(directory.join(FILENAME)))
}

fn read_at(path: Option<&Path>) -> Result<TemplateLibraryState, String> {
    let Some(path) = path else {
        return Ok(TemplateLibraryState::default());
    };
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TemplateLibraryState::default());
        }
        Err(_) => return Err("영상 템플릿 라이브러리를 읽을 수 없습니다.".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > STORE_LIMIT {
        return Err("영상 템플릿 라이브러리의 파일 형식 또는 크기를 확인하세요.".into());
    }
    let file = fs::File::open(path).map_err(|_| "영상 템플릿 라이브러리를 읽을 수 없습니다.")?;
    if !file
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= STORE_LIMIT)
    {
        return Err("영상 템플릿 라이브러리의 파일 형식 또는 크기를 확인하세요.".into());
    }
    let mut bytes = Vec::new();
    file.take(STORE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "영상 템플릿 라이브러리를 읽을 수 없습니다.")?;
    if bytes.len() as u64 > STORE_LIMIT {
        return Err("영상 템플릿 라이브러리의 파일 크기를 확인하세요.".into());
    }
    let state = serde_json::from_slice(&bytes)
        .map_err(|_| "영상 템플릿 라이브러리 JSON이 손상되었습니다. 원본 파일을 확인하세요.")?;
    validate(&state)?;
    Ok(state)
}

fn write_at(path: &Path, state: &TemplateLibraryState) -> Result<(), String> {
    validate(state)?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("영상 템플릿 라이브러리의 파일 형식을 확인하세요.".into());
        }
    }
    let directory = path.parent().ok_or("영상 템플릿 저장 경로 오류")?;
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|_| "영상 템플릿 라이브러리 형식을 확인하세요.")?;
    if bytes.len() as u64 > STORE_LIMIT {
        return Err("영상 템플릿 라이브러리의 파일 크기를 확인하세요.".into());
    }
    // Like native project persistence: one private temporary file, flush to
    // disk, then replace the destination atomically. Failed writes leave the
    // previous valid library intact and tempfile cleans its own partial file.
    let mut temporary = tempfile::Builder::new()
        .prefix(".state-")
        .tempfile_in(directory)
        .map_err(|_| "영상 템플릿 임시 저장 파일을 만들 수 없습니다.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "영상 템플릿 파일 권한을 설정할 수 없습니다.")?;
    }
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "영상 템플릿 라이브러리를 저장할 수 없습니다.")?;
    temporary
        .persist(path)
        .map_err(|_| "영상 템플릿 라이브러리를 저장할 수 없습니다.")?;
    Ok(())
}

pub fn get(app_data_path: &Path) -> Result<TemplateLibraryState, String> {
    let _guard = LIBRARY_LOCK
        .lock()
        .map_err(|_| "영상 템플릿 라이브러리가 사용 중입니다.")?;
    read_at(store_path(app_data_path, false)?.as_deref())
}

pub fn set_favorite(
    app_data_path: &Path,
    template_id: &str,
    favorite: bool,
) -> Result<TemplateLibraryState, String> {
    validate_template_id(template_id)?;
    let _guard = LIBRARY_LOCK
        .lock()
        .map_err(|_| "영상 템플릿 라이브러리가 사용 중입니다.")?;
    let existing_path = store_path(app_data_path, false)?;
    let mut state = read_at(existing_path.as_deref())?;
    let existed = state.favorites.iter().any(|id| id == template_id);
    if favorite == existed {
        return Ok(state);
    }
    state.favorites.retain(|id| id != template_id);
    if favorite {
        state.favorites.push(template_id.to_owned());
    }
    validate(&state)?;
    let path = store_path(app_data_path, true)?.ok_or("영상 템플릿 저장 경로 오류")?;
    write_at(&path, &state)?;
    Ok(state)
}

pub fn record_use(app_data_path: &Path, template_id: &str) -> Result<TemplateLibraryState, String> {
    validate_template_id(template_id)?;
    let _guard = LIBRARY_LOCK
        .lock()
        .map_err(|_| "영상 템플릿 라이브러리가 사용 중입니다.")?;
    let existing_path = store_path(app_data_path, false)?;
    let mut state = read_at(existing_path.as_deref())?;
    if state.recent.first().is_some_and(|id| id == template_id) {
        return Ok(state);
    }
    state.recent.retain(|id| id != template_id);
    state.recent.insert(0, template_id.to_owned());
    state.recent.truncate(LIST_LIMIT);
    let path = store_path(app_data_path, true)?.ok_or("영상 템플릿 저장 경로 오류")?;
    write_at(&path, &state)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video_templates;

    fn fixture() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("toris-template-library-test-")
            .tempdir()
            .unwrap()
    }

    fn fixture_path(base: &Path) -> PathBuf {
        base.join(DIRECTORY).join(FILENAME)
    }

    #[test]
    fn missing_library_is_empty_and_read_only() {
        let fixture = fixture();
        let missing = fixture.path().join("new-app-data");
        assert_eq!(get(&missing).unwrap(), TemplateLibraryState::default());
        assert!(!missing.exists());
        assert_eq!(
            get(fixture.path()).unwrap(),
            TemplateLibraryState::default()
        );
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 0);
    }

    #[test]
    fn favorites_and_recent_survive_reopen_without_touching_other_files() {
        let fixture = fixture();
        let sentinels = ["settings.json", "projects.json", "credentials.json"];
        for name in sentinels {
            fs::write(fixture.path().join(name), b"untouched").unwrap();
        }
        let state = set_favorite(fixture.path(), "how-to", true).unwrap();
        assert_eq!(state.favorites, vec!["how-to"]);
        assert!(state.recent.is_empty());
        let state = record_use(fixture.path(), "story-hook").unwrap();
        assert_eq!(get(fixture.path()).unwrap(), state);
        assert_eq!(state.recent, vec!["story-hook"]);
        assert_eq!(state.favorites, vec!["how-to"]);
        let state = set_favorite(fixture.path(), "how-to", false).unwrap();
        assert!(state.favorites.is_empty());
        assert_eq!(state.recent, vec!["story-hook"]);
        for name in sentinels {
            assert_eq!(fs::read(fixture.path().join(name)).unwrap(), b"untouched");
        }
        assert_eq!(
            fs::read_dir(fixture.path().join(DIRECTORY))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn lists_are_deduplicated_ordered_and_bounded_to_ten() {
        let fixture = fixture();
        let catalog = video_templates::catalog();
        assert_eq!(catalog.len(), 10);
        for descriptor in &catalog {
            set_favorite(fixture.path(), &descriptor.id, true).unwrap();
            set_favorite(fixture.path(), &descriptor.id, true).unwrap();
            record_use(fixture.path(), &descriptor.id).unwrap();
        }
        let state = record_use(fixture.path(), &catalog[0].id).unwrap();
        assert_eq!(state.favorites.len(), 10);
        assert_eq!(state.recent.len(), 10);
        assert_eq!(state.recent[0], catalog[0].id);
        assert_eq!(state.recent.iter().collect::<HashSet<_>>().len(), 10);
        assert_eq!(state.favorites.iter().collect::<HashSet<_>>().len(), 10);
        assert_eq!(get(fixture.path()).unwrap(), state);
    }

    #[test]
    fn invalid_ids_and_paths_do_not_create_or_change_library() {
        let fixture = fixture();
        for id in [
            "",
            "../settings",
            "unknown",
            "file:///private/file",
            "HOW-TO",
        ] {
            assert!(set_favorite(fixture.path(), id, true).is_err());
            assert!(record_use(fixture.path(), id).is_err());
        }
        assert_eq!(fs::read_dir(fixture.path()).unwrap().count(), 0);
        assert!(get(Path::new("relative/app")).is_err());
        let state = record_use(fixture.path(), "how-to").unwrap();
        let bytes = fs::read(fixture_path(fixture.path())).unwrap();
        assert!(set_favorite(fixture.path(), "unknown", false).is_err());
        assert_eq!(fs::read(fixture_path(fixture.path())).unwrap(), bytes);
        assert_eq!(get(fixture.path()).unwrap(), state);
    }

    #[test]
    fn malformed_or_unknown_saved_data_is_preserved_and_rejected() {
        let fixture = fixture();
        record_use(fixture.path(), "how-to").unwrap();
        for bytes in [
            b"not-json".to_vec(),
            br#"{"version":2,"favorites":[],"recent":[]}"#.to_vec(),
            br#"{"version":1,"favorites":["unknown"],"recent":[]}"#.to_vec(),
            br#"{"version":1,"favorites":[],"recent":["how-to","how-to"]}"#.to_vec(),
            br#"{"version":1,"favorites":[],"recent":[],"secret":"not-supported"}"#.to_vec(),
            vec![b'x'; STORE_LIMIT as usize + 1],
        ] {
            let path = fixture_path(fixture.path());
            fs::write(&path, &bytes).unwrap();
            assert!(get(fixture.path()).is_err());
            assert!(set_favorite(fixture.path(), "how-to", true).is_err());
            assert!(record_use(fixture.path(), "how-to").is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn simultaneous_updates_do_not_lose_other_favorites() {
        let fixture = fixture();
        let base = fixture.path().to_owned();
        let threads: Vec<_> = video_templates::catalog()
            .into_iter()
            .map(|descriptor| {
                let base = base.clone();
                std::thread::spawn(move || {
                    set_favorite(&base, &descriptor.id, true).unwrap();
                    record_use(&base, &descriptor.id).unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let state = get(&base).unwrap();
        assert_eq!(state.favorites.len(), 10);
        assert_eq!(state.recent.len(), 10);
    }

    #[cfg(unix)]
    #[test]
    fn private_modes_and_symlink_boundaries_are_enforced() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = fixture();
        set_favorite(fixture.path(), "how-to", true).unwrap();
        let directory = fixture.path().join(DIRECTORY);
        let path = fixture_path(fixture.path());
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let target = fixture.path().join("outside.json");
        fs::write(&target, b"untouched").unwrap();
        fs::remove_file(&path).unwrap();
        symlink(&target, &path).unwrap();
        assert!(get(fixture.path()).is_err());
        assert!(record_use(fixture.path(), "how-to").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"untouched");
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&directory).unwrap();
        let outside_directory = fixture.path().join("outside");
        fs::create_dir(&outside_directory).unwrap();
        symlink(&outside_directory, &directory).unwrap();
        assert!(get(fixture.path()).is_err());
        assert!(set_favorite(fixture.path(), "how-to", true).is_err());
        assert_eq!(fs::read_dir(&outside_directory).unwrap().count(), 0);
        let linked_base = fixture.path().join("linked-base");
        symlink(&outside_directory, &linked_base).unwrap();
        assert!(record_use(&linked_base, "how-to").is_err());
    }
}
