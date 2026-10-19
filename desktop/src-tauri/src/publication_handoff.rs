//! Naver is a local, user-completed handoff, never an automated API publisher.
use serde_json::{json, Value};
use sha2::Digest;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use url::Url;

/// The caller supplies only the approved snapshot and registered private media.
/// Export never updates a job or makes an HTTP request.
pub fn write_package(
    plan: &Value,
    images: &[(Value, PathBuf)],
    parent: &Path,
) -> Result<Value, String> {
    validate_plan(plan)?;
    if images.len() > 20 {
        return Err("첨부 이미지는 최대 20개입니다.".into());
    }
    let parent = parent
        .canonicalize()
        .map_err(|_| "내보낼 폴더를 확인하세요.")?;
    let staging = tempfile::Builder::new()
        .prefix(".toris-handoff-")
        .tempdir_in(&parent)
        .map_err(|_| "인계 폴더 생성 실패")?;
    let write = |name: &str, bytes: &[u8]| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(staging.path().join(name))
            .map_err(|_| "인계 파일 생성 실패")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "인계 파일 저장 실패".to_string())
    };
    write("title.txt", plan["title"].as_str().unwrap().as_bytes())?;
    write("body.txt", plan["description"].as_str().unwrap().as_bytes())?;
    write(
        "tags.json",
        json!({"tags":plan["tags"],"hashtags":plan["hashtags"]})
            .to_string()
            .as_bytes(),
    )?;
    let mut exported = vec![];
    if !images.is_empty() {
        fs::create_dir(staging.path().join("images")).map_err(|_| "이미지 폴더 생성 실패")?;
    }
    for (index, (meta, source)) in images.iter().enumerate() {
        let info = fs::symlink_metadata(source).map_err(|_| "첨부 이미지 확인 실패")?;
        if !info.is_file() || info.file_type().is_symlink() || info.len() > 20 * 1024 * 1024 {
            return Err("첨부 이미지 형식·크기를 확인하세요.".into());
        }
        let mut bytes = vec![];
        fs::File::open(source)
            .and_then(|file| file.take(20 * 1024 * 1024 + 1).read_to_end(&mut bytes))
            .map_err(|_| "첨부 이미지 읽기 실패")?;
        if bytes.len() as u64 != meta["bytes"].as_u64().unwrap_or(u64::MAX)
            || format!("{:x}", sha2::Sha256::digest(&bytes))
                != meta["sha256"].as_str().unwrap_or("")
        {
            return Err("승인한 첨부 이미지가 변경되었습니다.".into());
        }
        let extension = match meta["mime"].as_str() {
            Some("image/png") => "png",
            Some("image/jpeg") => "jpg",
            Some("image/webp") => "webp",
            _ => return Err("첨부 이미지 형식 오류".into()),
        };
        let file = format!("images/{:02}.{extension}", index + 1);
        write(&file, &bytes)?;
        exported.push(
            json!({"file":file,"id":meta["id"],"sha256":meta["sha256"],"bytes":meta["bytes"]}),
        );
    }
    let manifest = json!({"schemaVersion":1,"platform":"naver_blog","status":"needs_human_publish","verification":"not_published","publicationId":plan["publicationId"],"revision":plan["revision"],"accountId":plan["accountId"],"title":plan["title"],"images":exported});
    write(
        "manifest.json",
        serde_json::to_string_pretty(&manifest)
            .map_err(|_| "인계 메타데이터 오류")?
            .as_bytes(),
    )?;
    write("README.txt", "이 폴더는 게시 완료가 아닌 수동 게시 인계 자료입니다.\n1. 대상 네이버 블로그를 직접 확인하세요.\n2. title.txt와 body.txt 및 images를 네이버 편집기에 적용하세요.\n3. 예약만 설정한 상태는 게시 완료가 아닙니다.\n4. 실제 게시 후 Studio에서 해당 블로그의 게시 URL과 사용자 확인을 기록하세요.\n".as_bytes())?;
    let destination = parent.join(format!("toris-naver-{}", uuid::Uuid::new_v4()));
    fs::rename(staging.path(), &destination).map_err(|_| "인계 폴더 저장 실패")?;
    Ok(
        json!({"path":destination.to_string_lossy(),"images":images.len(),"status":"needs_human_publish"}),
    )
}

pub fn validate_plan(plan: &Value) -> Result<(), String> {
    account_id(plan["accountId"].as_str().unwrap_or(""))?;
    if plan["platform"] != "naver_blog"
        || plan["mode"] != "manual_handoff"
        || !matches!(plan["contentKind"].as_str(), Some("text" | "article"))
        || !plan["scheduledAt"].is_null()
    {
        return Err("네이버는 텍스트·블로그 원고의 수동 게시 인계만 지원합니다.".into());
    }
    if plan["options"]["confirmHandoff"] != true {
        return Err("자동 게시가 아닌 사용자 수동 게시 인계임을 확인하세요.".into());
    }
    for (key, limit) in [("title", 300), ("description", 30000)] {
        let value = plan[key].as_str().unwrap_or("");
        if value.trim().is_empty()
            || value.chars().count() > limit
            || value
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("네이버 제목과 본문을 확인하세요.".into());
        }
    }
    Ok(())
}

fn account_id(account: &str) -> Result<(), String> {
    if account.is_empty()
        || account.len() > 50
        || !account
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(
            "네이버 블로그 ID를 확인하세요. 주소나 로그인 비밀번호가 아닌 블로그 ID만 입력하세요."
                .into(),
        );
    }
    Ok(())
}

pub fn post_url(account: &str, raw: &str) -> Result<String, String> {
    account_id(account)?;
    let url = Url::parse(raw.trim()).map_err(|_| "실제 네이버 게시 URL을 입력하세요.")?;
    if raw.len() > 2048
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || !matches!(url.host_str(), Some("blog.naver.com" | "m.blog.naver.com"))
    {
        return Err("공식 네이버 블로그 HTTPS 게시 URL만 허용합니다.".into());
    }
    let parts: Vec<_> = url.path_segments().ok_or("게시 주소 오류")?.collect();
    let post = if parts == ["PostView.naver"] {
        let blogs: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key == "blogId")
            .map(|(_, value)| value.into_owned())
            .collect();
        let posts: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key == "logNo")
            .map(|(_, value)| value.into_owned())
            .collect();
        if blogs != [account] || posts.len() != 1 {
            return Err("대상 블로그와 게시 URL이 일치하지 않습니다.".into());
        }
        posts[0].clone()
    } else if parts.len() == 2 && parts[0] == account {
        parts[1].to_string()
    } else {
        return Err("대상 블로그의 개별 게시글 URL을 입력하세요.".into());
    };
    if post.is_empty()
        || post.len() > 30
        || !post.bytes().all(|c| c.is_ascii_digit())
        || post.bytes().all(|c| c == b'0')
    {
        return Err("게시글 번호를 확인하세요.".into());
    }
    Ok(format!("https://blog.naver.com/{account}/{post}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn package_exports_exact_text_and_hash_verified_images_without_posting() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.png");
        std::fs::write(&source, b"fixture image").unwrap();
        let plan = json!({"platform":"naver_blog","contentKind":"article","mode":"manual_handoff","accountId":"my_blog","title":"제목 <script>","description":"원문\n본문","tags":["태그"],"hashtags":["별도"],"options":{"confirmHandoff":true}});
        let meta = json!({"id":"image-id","mime":"image/png","sha256":format!("{:x}",sha2::Sha256::digest(b"fixture image")),"bytes":13,"name":"../../escape.png"});
        let result = write_package(&plan, &[(meta.clone(), source.clone())], root.path()).unwrap();
        let folder = std::path::PathBuf::from(result["path"].as_str().unwrap());
        assert!(folder.starts_with(root.path().canonicalize().unwrap()));
        assert_eq!(
            std::fs::read_to_string(folder.join("body.txt")).unwrap(),
            "원문\n본문"
        );
        assert_eq!(
            std::fs::read(folder.join("images/01.png")).unwrap(),
            b"fixture image"
        );
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(folder.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["status"], "needs_human_publish");
        assert_eq!(manifest["images"][0]["file"], "images/01.png");
        assert!(manifest.get("options").is_none());
        assert!(plan.get("status").is_none());
        std::fs::write(&source, b"modified").unwrap();
        let count = std::fs::read_dir(root.path()).unwrap().count();
        assert!(write_package(&plan, &[(meta, source)], root.path()).is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), count);
    }

    #[test]
    fn handoff_requires_explicit_consent_without_claiming_api_authority() {
        let mut plan = json!({"platform":"naver_blog","contentKind":"article","mode":"manual_handoff","accountId":"my_blog","title":"제목","description":"본문","options":{"confirmHandoff":false}});
        assert!(validate_plan(&plan).is_err());
        plan["options"]["confirmHandoff"] = json!(true);
        validate_plan(&plan).unwrap();
        plan["mode"] = json!("scheduled");
        assert!(validate_plan(&plan).is_err());
        plan["mode"] = json!("manual_handoff");
        plan["accountId"] = json!("https://blog.naver.com/my_blog");
        assert!(validate_plan(&plan).is_err());
    }

    #[test]
    fn post_urls_require_https_the_exact_blog_and_a_concrete_post() {
        assert_eq!(
            post_url(
                "my_blog",
                "https://m.blog.naver.com/my_blog/12345?ref=share"
            )
            .unwrap(),
            "https://blog.naver.com/my_blog/12345"
        );
        assert_eq!(
            post_url(
                "my_blog",
                "https://blog.naver.com/PostView.naver?blogId=my_blog&logNo=12345"
            )
            .unwrap(),
            "https://blog.naver.com/my_blog/12345"
        );
        for url in [
            "https://blog.naver.com/other/12345",
            "https://blog.naver.com/my_blog",
            "http://blog.naver.com/my_blog/12345",
            "https://blog.naver.com.evil.test/my_blog/12345",
            "https://user:token@blog.naver.com/my_blog/12345",
            "https://blog.naver.com:8443/my_blog/12345",
            "https://blog.naver.com/PostView.naver?blogId=my_blog&blogId=other&logNo=12345",
            "https://blog.naver.com/my_blog/not-a-post",
        ] {
            assert!(post_url("my_blog", url).is_err(), "accepted {url}");
        }
        assert!(post_url("../escape", "https://blog.naver.com/../escape/123").is_err());
    }
}
