//! Credential-free ChatGPT draft inbox. This module cannot publish or approve content.
use chrono::Utc;
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn root_dir() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("TORIS_STUDIO_DRAFT_TEST_HOME") {
        let path = PathBuf::from(path);
        if !path.is_absolute() || path.parent().is_none() {
            return Err("테스트 초안 경로 오류".into());
        }
        return Ok(path);
    }
    Ok(crate::config::config_path()
        .parent()
        .ok_or("초안 저장 경로 오류")?
        .join("chatgpt-drafts"))
}
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
        serde_json::to_writer(&mut temporary, &requests).map_err(|_| "초안 저장 실패")?;
        temporary
            .flush()
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "초안 저장 실패")?;
        temporary.persist(path).map_err(|_| "초안 저장 실패")?;
    }
    Ok(result)
}
pub fn request(input: Value) -> Result<Value, String> {
    request_at(&root_dir()?, input)
}
fn request_at(root: &Path, input: Value) -> Result<Value, String> {
    let topic = input["topic"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 300)
        .ok_or("주제를 1~300자로 입력하세요.")?;
    let context = input["context"].as_str().unwrap_or("");
    if context.chars().count() > 6000 {
        return Err("초안 참고자료는 6000자 이내로 입력하세요.".into());
    }
    let publication_id = input["publicationId"].as_str();
    if publication_id.is_some_and(|id| Uuid::parse_str(id).is_err()) {
        return Err("콘텐츠 ID 형식 오류".into());
    }
    let value = json!({"id":Uuid::new_v4().to_string(),"publicationId":publication_id,"revision":input["revision"].as_u64(),"topic":topic,"context":context,"status":"waiting","createdAt":Utc::now().to_rfc3339()});
    access(root, |requests| {
        if requests.len() >= 200 {
            let index = requests
                .iter()
                .position(|r| r["status"] == "received")
                .ok_or("대기 중인 요청이 200개입니다. 기존 ChatGPT 요청의 수신을 완료하세요.")?;
            let archive = archive_dir(root)?;
            let id = Uuid::parse_str(requests[index]["id"].as_str().ok_or("초안 식별자 오류")?)
                .map_err(|_| "초안 식별자 오류")?;
            let path = archive.join(format!("{id}.json"));
            if path.exists() {
                if archived(root, &id.to_string())?.as_ref() != Some(&requests[index]) {
                    return Err("보관 초안이 일치하지 않습니다.".into());
                }
            } else {
                let mut temporary =
                    tempfile::NamedTempFile::new_in(archive).map_err(|_| "완료 초안 보관 실패")?;
                serde_json::to_writer(&mut temporary, &requests[index])
                    .map_err(|_| "완료 초안 보관 실패")?;
                temporary
                    .as_file()
                    .sync_all()
                    .map_err(|_| "완료 초안 보관 실패")?;
                temporary
                    .persist_noclobber(path)
                    .map_err(|_| "완료 초안 보관 실패")?;
            }
            requests.remove(index);
        }
        requests.push(value.clone());
        Ok(value)
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
        Ok(m) if m.is_file() && !m.file_type().is_symlink() && m.len() <= 256 * 1024 => {}
        _ => return Err("보관 초안 파일 형식 오류".into()),
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "보관 초안 읽기 실패")?)
        .map(Some)
        .map_err(|_| "보관 초안 형식 오류".into())
}
pub fn list() -> Result<Value, String> {
    list_at(&root_dir()?)
}
fn list_at(root: &Path) -> Result<Value, String> {
    access(root, |requests| Ok(json!({"requests":requests})))
}
fn validate_draft(input: &Value) -> Result<Value, String> {
    let title = input["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 300)
        .ok_or("초안 제목 형식 오류")?;
    let description = input["description"]
        .as_str()
        .filter(|s| s.chars().count() <= 30000)
        .ok_or("초안 설명 형식 오류")?;
    let mut draft = json!({"title":title,"description":description});
    for field in ["tags", "hashtags"] {
        let entries = input[field]
            .as_array()
            .filter(|a| a.len() <= 50)
            .ok_or("초안 태그 형식 오류")?;
        if entries.iter().any(|v| {
            v.as_str()
                .is_none_or(|s| s.chars().count() > 100 || s.chars().any(char::is_control))
        }) {
            return Err("초안 태그 길이 또는 형식 오류".into());
        }
        draft[field] = json!(entries);
    }
    Ok(draft)
}
pub fn receive(input: Value) -> Result<Value, String> {
    receive_at(&root_dir()?, input)
}
pub fn receive_at(root: &Path, input: Value) -> Result<Value, String> {
    let id = input["requestId"]
        .as_str()
        .ok_or("앱에서 생성한 초안 요청 ID가 필요합니다.")?;
    Uuid::parse_str(id).map_err(|_| "초안 요청 ID 형식 오류")?;
    let draft = validate_draft(&input)?;
    access(root, |requests| {
        if !requests.iter().any(|r| r["id"] == id) {
            if let Some(item) = archived(root, id)? {
                if item["draft"] == draft {
                    return Ok(item);
                }
                return Err("이미 수신한 초안을 덮어쓸 수 없습니다. 새 요청을 등록하세요.".into());
            }
        }
        let item = requests
            .iter_mut()
            .find(|r| r["id"] == id)
            .ok_or("앱에서 등록한 초안 요청이 없습니다.")?;
        if item["status"] == "received" {
            if item["draft"] == draft {
                return Ok(item.clone());
            }
            return Err("이미 수신한 초안을 덮어쓸 수 없습니다. 새 요청을 등록하세요.".into());
        }
        item["draft"] = draft;
        item["status"] = json!("received");
        item["receivedAt"] = json!(Utc::now().to_rfc3339());
        Ok(item.clone())
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn received_draft_requires_registered_request_and_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let request = request_at(root.path(), json!({"topic":"영상 주제"})).unwrap();
        let mut reply = json!({"requestId":request["id"],"title":"영상 제목","description":"설명","tags":["Rust"],"hashtags":["#개발"]});
        let received = receive_at(root.path(), reply.clone()).unwrap();
        assert_eq!(received["status"], "received");
        assert_eq!(receive_at(root.path(), reply.clone()).unwrap(), received);
        reply["title"] = json!("다른 제목");
        assert!(receive_at(root.path(), reply).is_err());
        assert_eq!(
            list_at(root.path()).unwrap()["requests"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn unsolicited_reply_cannot_create_content_or_queue() {
        let root = tempfile::tempdir().unwrap();
        assert!(receive_at(root.path(),json!({"requestId":Uuid::new_v4().to_string(),"title":"제목","description":"설명","tags":[],"hashtags":[]})).is_err());
    }
    #[test]
    fn completed_requests_archive_without_blocking_new_requests_or_duplicate_receipts() {
        let root = tempfile::tempdir().unwrap();
        let first = request_at(root.path(), json!({"topic":"첫 요청"})).unwrap();
        let reply = json!({"requestId":first["id"],"title":"제목","description":"설명","tags":[],"hashtags":[]});
        let received = receive_at(root.path(), reply.clone()).unwrap();
        access(root.path(), |requests| {
            for _ in 0..199 {
                requests.push(json!({"id":Uuid::new_v4().to_string(),"status":"waiting"}));
            }
            Ok(())
        })
        .unwrap();
        assert!(request_at(root.path(), json!({"topic":"201번째 요청"})).is_ok());
        assert_eq!(receive_at(root.path(), reply).unwrap(), received);
        assert_eq!(
            list_at(root.path()).unwrap()["requests"]
                .as_array()
                .unwrap()
                .len(),
            200
        );
    }
}
