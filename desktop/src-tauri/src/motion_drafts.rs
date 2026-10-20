//! Motion-only draft inbox. Receiving never saves or changes a project.
use crate::graphics;
use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;
fn access<T>(
    root: &Path,
    mutation: impl FnOnce(&mut Vec<Value>) -> Result<T, String>,
) -> Result<T, String> {
    fs::create_dir_all(root).map_err(|_| "초안 폴더를 만들지 못했습니다.")?;
    if fs::symlink_metadata(root)
        .map_err(|_| "초안 폴더 확인 실패")?
        .file_type()
        .is_symlink()
    {
        return Err("초안 폴더에 심볼릭 링크를 사용할 수 없습니다.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "초안 폴더 권한 오류")?;
    }
    let path = root.join("inbox.json");
    let lock_path = root.join("inbox.lock");
    for file in [&path, &lock_path] {
        if fs::symlink_metadata(file).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
            return Err("초안 저장 파일 형식 오류".into());
        }
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(lock_path).map_err(|_| "초안 잠금 실패")?;
    lock.lock_exclusive().map_err(|_| "초안 잠금 실패")?;
    let mut requests: Vec<Value> = match fs::read(&path) {
        Ok(bytes) if bytes.len() <= 16 * 1024 * 1024 => serde_json::from_slice(&bytes)
            .map_err(|_| "초안 색인이 손상되었습니다. 원본을 보존하세요.")?,
        Ok(_) => return Err("초안 색인 크기 초과".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err("초안 저장소 읽기 실패".into()),
    };
    let before = requests.clone();
    let result = mutation(&mut requests)?;
    if requests != before {
        let mut temporary = tempfile::NamedTempFile::new_in(root).map_err(|_| "초안 저장 실패")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            temporary
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| "초안 파일 권한 오류")?;
        }
        let bytes = serde_json::to_vec(&requests).map_err(|_| "모션 저장 실패")?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("모션 요청 저장소 크기 초과".into());
        }
        temporary.write_all(&bytes).map_err(|_| "모션 저장 실패")?;
        temporary
            .flush()
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "초안 저장 실패")?;
        temporary.persist(path).map_err(|_| "초안 저장 실패")?;
    }
    Ok(result)
}
pub fn root_dir() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("TORIS_STUDIO_MOTION_TEST_HOME") {
        let path = PathBuf::from(path);
        if !path.is_absolute() || path.parent().is_none() {
            return Err("모션 테스트 경로 오류".into());
        }
        return Ok(path);
    }
    Ok(crate::config::config_path()
        .parent()
        .ok_or("모션 저장 경로 오류")?
        .join("motion-drafts"))
}
pub fn request(input: Value) -> Result<Value, String> {
    request_at(&root_dir()?, input)
}
pub fn list() -> Result<Value, String> {
    access(&root_dir()?, |items| Ok(json!(items)))
}
pub fn request_at(root: &Path, input: Value) -> Result<Value, String> {
    let p = &input["project"];
    crate::media::validate_project(p)?;
    graphics::sources(p)?;
    let instruction = input["instruction"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 6000)
        .ok_or("지시문은 1~6000자입니다.")?;
    let mode = input["mode"]
        .as_str()
        .filter(|s| ["create", "edit"].contains(s))
        .ok_or("모션 요청 모드 오류")?;
    let scene_ids = input["sceneIds"]
        .as_array()
        .filter(|s| s.len() <= 12)
        .ok_or("선택 장면 오류")?;
    let element_ids = input["elementIds"]
        .as_array()
        .filter(|s| s.len() <= 32)
        .ok_or("선택 요소 오류")?;
    let scenes = p["scenes"].as_array().ok_or("장면 오류")?;
    for id in scene_ids {
        if !id.is_string() || !scenes.iter().any(|s| s["id"] == *id) {
            return Err("선택한 장면이 없습니다.".into());
        }
    }
    for id in element_ids {
        if !id.is_string()
            || !scenes
                .iter()
                .filter(|s| scene_ids.is_empty() || scene_ids.contains(&s["id"]))
                .any(|s| {
                    s["graphics"]["elements"]
                        .as_array()
                        .is_some_and(|es| es.iter().any(|e| e["id"] == *id))
                })
        {
            return Err("선택한 요소가 없습니다.".into());
        }
    }
    let r = json!({"id":Uuid::new_v4().to_string(),"projectId":p["id"],"baseHash":graphics::hash(p),"mode":mode,"instruction":instruction,"allowDataEdits":input["allowDataEdits"].as_bool().unwrap_or(false),"sceneIds":scene_ids,"elementIds":element_ids,"project":p,"status":"waiting","createdAt":Utc::now().to_rfc3339()});
    access(root, |items| {
        if items.len() >= 40 {
            let index = items
                .iter()
                .position(|r| r["status"] == "applied" || r["status"] == "cancelled")
                .ok_or("진행 중 요청이 40개입니다. 기존 요청을 적용하거나 취소하세요.")?;
            let archive = archive_dir(root)?;
            let id = items[index]["id"].as_str().ok_or("요청 ID 오류")?;
            let destination = archive.join(format!("{id}.json"));
            if !destination.exists() {
                let mut temporary =
                    tempfile::NamedTempFile::new_in(&archive).map_err(|_| "요청 보관 실패")?;
                serde_json::to_writer(&mut temporary, &items[index])
                    .map_err(|_| "요청 보관 실패")?;
                temporary
                    .as_file()
                    .sync_all()
                    .map_err(|_| "요청 보관 실패")?;
                temporary
                    .persist_noclobber(destination)
                    .map_err(|_| "요청 보관 실패")?;
            } else if archived(root, id)?.as_ref() != Some(&items[index]) {
                return Err("보관 요청 불일치".into());
            }
            items.remove(index);
        }
        items.push(r.clone());
        Ok(r)
    })
}
fn find<'a>(items: &'a mut [Value], id: &str) -> Result<&'a mut Value, String> {
    Uuid::parse_str(id).map_err(|_| "요청 ID 오류")?;
    items
        .iter_mut()
        .find(|r| r["id"] == id)
        .ok_or("등록된 모션 요청이 없습니다.".into())
}
fn fresh(r: &Value) -> Result<(), String> {
    let date = DateTime::parse_from_rfc3339(r["createdAt"].as_str().ok_or("요청 시각 오류")?)
        .map_err(|_| "요청 시각 오류")?;
    if (Utc::now() - date.with_timezone(&Utc)).num_seconds() > 86400 {
        return Err("24시간 지난 요청입니다. 현재 편집 내용으로 다시 요청하세요.".into());
    }
    Ok(())
}
pub fn get(id: &str) -> Result<Value, String> {
    get_at(&root_dir()?, id)
}
pub fn get_at(root: &Path, id: &str) -> Result<Value, String> {
    access(root, |items| {
        let mut r = if items.iter().any(|r| r["id"] == id) {
            find(items, id)?.clone()
        } else {
            archived(root, id)?.ok_or("등록된 모션 요청이 없습니다.")?
        };
        // Expose a closed AI context, preserving the private full snapshot for hashing/apply.
        if let Some(object) = r["project"].as_object_mut() {
            object.retain(|key, _| {
                [
                    "id",
                    "title",
                    "format",
                    "template",
                    "language",
                    "motionGraphics",
                    "scenes",
                ]
                .contains(&key.as_str())
            });
        }
        if let Some(scenes) = r["project"]["scenes"].as_array_mut() {
            for scene in scenes {
                if let Some(object) = scene.as_object_mut() {
                    object.retain(|key, _| {
                        [
                            "id",
                            "headline",
                            "body",
                            "narration",
                            "durationSec",
                            "graphics",
                        ]
                        .contains(&key.as_str())
                    });
                }
            }
        }
        Ok(r)
    })
}
fn scope(r: &Value, d: &Value) -> Result<(), String> {
    let scenes = r["sceneIds"].as_array().ok_or("요청 범위 오류")?;
    let elements = r["elementIds"].as_array().ok_or("요청 범위 오류")?;
    for op in d["operations"].as_array().ok_or("변경 연산 오류")? {
        if op["op"] == "set-table-value" {
            if r["allowDataEdits"] != true || !scenes.is_empty() || !elements.is_empty() {
                return Err("원본 수치 변경은 전체 범위와 명시적 허용이 필요합니다.".into());
            }
            continue;
        }
        if !scenes.is_empty() && !scenes.contains(&op["sceneId"]) {
            return Err("선택한 장면 밖의 변경입니다. 전체 장면으로 다시 요청하세요.".into());
        }
        if !elements.is_empty() {
            let eid = if op["op"] == "replace-element" {
                &op["element"]["id"]
            } else if op["op"] == "delete-element" {
                &op["elementId"]
            } else {
                return Err("선택 요소만 변경할 수 있습니다.".into());
            };
            if !elements.contains(eid) {
                return Err("선택한 요소 밖의 변경입니다.".into());
            }
        }
    }
    Ok(())
}
pub fn receive(input: Value) -> Result<Value, String> {
    receive_at(&root_dir()?, input)
}
pub fn receive_at(root: &Path, input: Value) -> Result<Value, String> {
    let id = input["requestId"].as_str().ok_or("요청 ID 필요")?;
    access(root, |items| {
        if !items.iter().any(|r| r["id"] == id) {
            if let Some(r) = archived(root, id)? {
                if r["status"] == "applied"
                    && r["draft"] == input["draft"]
                    && r["projectId"] == input["projectId"]
                    && r["baseHash"] == input["baseHash"]
                {
                    return Ok(r);
                }
                return Err("취소되었거나 이미 보관한 모션 요청입니다.".into());
            }
        }
        let r = find(items, id)?;
        fresh(r)?;
        if input["projectId"] != r["projectId"] || input["baseHash"] != r["baseHash"] {
            return Err("프로젝트 또는 요청 편집 해시가 일치하지 않습니다.".into());
        }
        if r["status"] == "cancelled" {
            return Err("취소한 요청입니다.".into());
        }
        if r["status"] == "received" || r["status"] == "applied" {
            return if r["draft"] == input["draft"] {
                Ok(r.clone())
            } else {
                Err("이미 받은 결과를 덮어쓸 수 없습니다.".into())
            };
        }
        scope(r, &input["draft"])?;
        graphics::apply_patch(&r["project"], &input["draft"])?;
        r["draft"] = input["draft"].clone();
        r["status"] = json!("received");
        r["receivedAt"] = json!(Utc::now().to_rfc3339());
        Ok(r.clone())
    })
}
pub fn apply(id: &str, current: Value) -> Result<Value, String> {
    apply_at(&root_dir()?, id, current)
}
pub fn apply_at(root: &Path, id: &str, current: Value) -> Result<Value, String> {
    access(root, |items| {
        let r = find(items, id)?;
        fresh(r)?;
        if r["status"] != "received" {
            return Err("검토할 모션 초안이 없습니다.".into());
        }
        if current["id"] != r["projectId"]
            || graphics::hash(&current) != r["baseHash"].as_str().unwrap_or("")
        {
            return Err(
                "요청 후 수동 편집 충돌이 있습니다. 현재 편집 내용으로 다시 요청하세요.".into(),
            );
        }
        let next = graphics::apply_patch(&current, &r["draft"])?;
        r["status"] = json!("applied");
        Ok(next)
    })
}
pub fn cancel(id: &str) -> Result<Value, String> {
    cancel_at(&root_dir()?, id)
}
pub fn cancel_at(root: &Path, id: &str) -> Result<Value, String> {
    access(root, |items| {
        let r = find(items, id)?;
        if r["status"] == "applied" {
            return Err("이미 적용한 요청은 실행 취소로 복원하세요.".into());
        }
        r["status"] = json!("cancelled");
        Ok(r.clone())
    })
}

fn archive_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join("archive");
    fs::create_dir_all(&dir).map_err(|_| "완료 초안 보관 폴더 오류")?;
    if !fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
        return Err("완료 초안 보관 폴더 형식 오류".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "보관 폴더 권한 오류")?;
    }
    Ok(dir)
}
fn archived(root: &Path, id: &str) -> Result<Option<Value>, String> {
    let id = Uuid::parse_str(id).map_err(|_| "초안 식별자 오류")?;
    let dir = root.join("archive");
    if !dir.exists() {
        return Ok(None);
    }
    let dir = archive_dir(root)?;
    let path = dir.join(format!("{id}.json"));
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(m) if m.is_file() && !m.file_type().is_symlink() && m.len() <= 3 * 1024 * 1024 => {}
        _ => return Err("보관 초안 파일 형식 오류".into()),
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "보관 초안 읽기 실패")?)
        .map(Some)
        .map_err(|_| "보관 초안 형식 오류".into())
}
