//! Manual destinations use local user-completed handoffs; no automated API publishing.
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
    write_package_with_media(plan, images, None, parent)
}

pub fn write_package_with_media(
    plan: &Value,
    images: &[(Value, PathBuf)],
    video: Option<&(Value, PathBuf)>,
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
    let exported_video = if plan["contentKind"] == "video" {
        let (meta, source) = video.ok_or("승인된 MP4 영상을 선택하세요.")?;
        if *meta != plan["video"] {
            return Err("승인된 영상 메타데이터가 변경되었습니다.".into());
        }
        let info = fs::symlink_metadata(source).map_err(|_| "영상 파일 확인 실패")?;
        let expected = meta["bytes"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 2 * 1024 * 1024 * 1024)
            .ok_or("영상 크기 오류")?;
        if !info.is_file()
            || info.file_type().is_symlink()
            || info.len() != expected
            || meta["mime"] != "video/mp4"
        {
            return Err("승인한 MP4 파일 형식·크기가 변경되었습니다.".into());
        }
        let mut input = fs::File::open(source).map_err(|_| "영상 읽기 실패")?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(staging.path().join("video.mp4"))
            .map_err(|_| "영상 내보내기 실패")?;
        let mut hasher = sha2::Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let n = input.read(&mut buffer).map_err(|_| "영상 읽기 실패")?;
            if n == 0 {
                break;
            }
            total = total
                .checked_add(n as u64)
                .filter(|n| *n <= expected)
                .ok_or("영상 크기가 변경되었습니다.")?;
            hasher.update(&buffer[..n]);
            output
                .write_all(&buffer[..n])
                .map_err(|_| "영상 저장 실패")?;
        }
        if total != expected
            || format!("{:x}", hasher.finalize()) != meta["sha256"].as_str().unwrap_or("")
        {
            return Err("승인한 영상이 변경되었습니다.".into());
        }
        output.sync_all().map_err(|_| "영상 저장 실패")?;
        json!({"file":"video.mp4","id":meta["id"],"sha256":meta["sha256"],"bytes":expected})
    } else {
        if video.is_some() {
            return Err("텍스트 인계에 승인되지 않은 영상이 있습니다.".into());
        }
        Value::Null
    };
    let manifest = json!({"schemaVersion":1,"platform":plan["platform"],"status":"needs_human_publish","verification":"not_published","publicationId":plan["publicationId"],"revision":plan["revision"],"accountId":plan["accountId"],"title":plan["title"],"images":exported,"video":exported_video,"editorUrl":editor_url(plan)});
    write(
        "manifest.json",
        serde_json::to_string_pretty(&manifest)
            .map_err(|_| "인계 메타데이터 오류")?
            .as_bytes(),
    )?;
    write("README.txt",format!("이 폴더는 수동 게시 인계 자료입니다. 게시 완료나 API 검증이 아닙니다.\n1. 대상 플랫폼과 계정을 직접 확인하세요.\n2. title.txt, body.txt, images, video.mp4를 필요한 항목에 적용하세요.\n3. 예약만 설정한 상태는 게시 완료가 아닙니다.\n4. 실제 게시 후 Studio에서 실제 게시 URL과 사용자 확인을 기록하세요.\n열기: {}\n",editor_url(plan)).as_bytes())?;
    let prefix = if plan["platform"] == "naver_blog" {
        "naver"
    } else {
        plan["platform"].as_str().unwrap()
    };
    let destination = parent.join(format!("toris-{prefix}-{}", uuid::Uuid::new_v4()));
    fs::rename(staging.path(), &destination).map_err(|_| "인계 폴더 저장 실패")?;
    Ok(
        json!({"path":destination.to_string_lossy(),"images":images.len(),"videoIncluded":!exported_video.is_null(),"platform":plan["platform"],"editorUrl":editor_url(plan),"status":"needs_human_publish","verification":"not_published"}),
    )
}

pub fn editor_url(plan: &Value) -> String {
    match plan["platform"].as_str() {
        Some("x") => "https://x.com/compose/post".into(),
        Some("naver_clip") => "https://clip.naver.com".into(),
        _ => format!(
            "https://blog.naver.com/{}",
            plan["accountId"].as_str().unwrap_or("")
        ),
    }
}
pub fn validate_plan(plan: &Value) -> Result<(), String> {
    let platform = plan["platform"].as_str().unwrap_or("");
    let account = plan["accountId"].as_str().unwrap_or("");
    match platform {
        "naver_blog" => account_id(account)?,
        "x" => {
            let handle = account.strip_prefix('@').unwrap_or(account);
            if handle.is_empty()
                || handle.len() > 15
                || !handle
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err("X 사용자 이름을 확인하세요.".into());
            }
        }
        "naver_clip" => {
            if account.is_empty()
                || account.len() > 200
                || !account
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            {
                return Err("Clip 계정 식별자를 확인하세요.".into());
            }
        }
        _ => return Err("수동 게시 플랫폼을 확인하세요.".into()),
    }
    let kind = plan["contentKind"].as_str().unwrap_or("");
    if plan["mode"] != "manual_handoff"
        || !plan["scheduledAt"].is_null()
        || !match platform {
            "naver_blog" => matches!(kind, "text" | "article"),
            "naver_clip" => kind == "video",
            "x" => matches!(kind, "text" | "article" | "video"),
            _ => false,
        }
    {
        return Err("콘텐츠 종류와 수동 게시 인계 방식을 확인하세요.".into());
    }
    if kind == "video" && !plan["video"].is_object() {
        return Err("승인할 MP4 영상을 먼저 가져오세요.".into());
    }
    if plan["options"]["confirmHandoff"] != true {
        return Err("사용자가 플랫폼에서 직접 게시하는 인계임을 확인하세요.".into());
    }
    for (key, limit) in [("title", 300), ("description", 30000)] {
        let value = plan[key].as_str().unwrap_or("");
        if (value.trim().is_empty() && (key == "title" || platform == "naver_blog"))
            || value.chars().count() > limit
            || value
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("인계 제목과 본문을 확인하세요.".into());
        }
    }
    Ok(())
}
pub fn platform_post_url(platform: &str, account: &str, raw: &str) -> Result<String, String> {
    if platform == "naver_blog" {
        return post_url(account, raw);
    }
    let url = Url::parse(raw.trim()).map_err(|_| "실제 게시 HTTPS URL을 입력하세요.")?;
    if raw.len() > 2048
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
        || url.fragment().is_some()
    {
        return Err("공식 HTTPS 게시 주소를 입력하세요.".into());
    }
    let parts = url
        .path_segments()
        .ok_or("게시 주소 오류")?
        .collect::<Vec<_>>();
    match platform {
        "x" => {
            let handle = account.strip_prefix('@').unwrap_or(account);
            if !matches!(
                url.host_str(),
                Some("x.com" | "www.x.com" | "twitter.com" | "www.twitter.com")
            ) || parts.len() != 3
                || !parts[0].eq_ignore_ascii_case(handle)
                || parts[1] != "status"
                || parts[2].is_empty()
                || parts[2].len() > 30
                || !parts[2].bytes().all(|b| b.is_ascii_digit())
                || parts[2].bytes().all(|b| b == b'0')
            {
                return Err("대상 X 계정의 개별 게시글 주소를 입력하세요.".into());
            }
            Ok(format!("https://x.com/{handle}/status/{}", parts[2]))
        }
        "naver_clip" => {
            if url.host_str() != Some("clip.naver.com")
                || parts.len() < 2
                || !["clip", "video", "shorts", "player"].contains(&parts[0])
                || parts.last().is_none_or(|s| {
                    s.is_empty()
                        || s.len() > 200
                        || !s
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                })
            {
                return Err("공식 Clip 개별 콘텐츠 URL을 입력하세요.".into());
            }
            let mut normalized = url;
            normalized.set_query(None);
            Ok(normalized.to_string())
        }
        _ => Err("수동 게시 플랫폼을 확인하세요.".into()),
    }
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
    fn x_and_clip_export_hash_verified_video_and_never_claim_published() {
        for platform in ["x", "naver_clip"] {
            let root = tempfile::tempdir().unwrap();
            let source = root.path().join("source.mp4");
            let bytes = b"fixture mp4 bytes";
            fs::write(&source, bytes).unwrap();
            let meta = json!({"id":"video-fixture","mime":"video/mp4","bytes":bytes.len(),"sha256":format!("{:x}",sha2::Sha256::digest(bytes))});
            let plan = json!({"platform":platform,"mode":"manual_handoff","contentKind":"video","accountId":"fixture","title":"Title","description":"Body","video":meta,"options":{"confirmHandoff":true}});
            assert!(write_package(&plan, &[], root.path()).is_err());
            let result = write_package_with_media(
                &plan,
                &[],
                Some(&(meta.clone(), source.clone())),
                root.path(),
            )
            .unwrap();
            assert_eq!(result["verification"], "not_published");
            assert_eq!(result["status"], "needs_human_publish");
            assert_eq!(result["videoIncluded"], true);
            let folder = PathBuf::from(result["path"].as_str().unwrap());
            assert_eq!(fs::read(folder.join("video.mp4")).unwrap(), bytes);
            let manifest: Value =
                serde_json::from_slice(&fs::read(folder.join("manifest.json")).unwrap()).unwrap();
            assert_eq!(manifest["platform"], platform);
            assert_eq!(manifest["video"]["sha256"], meta["sha256"]);
            fs::write(&source, b"modified mp4 file").unwrap();
            let count = fs::read_dir(root.path()).unwrap().count();
            assert!(
                write_package_with_media(&plan, &[], Some(&(meta, source)), root.path()).is_err()
            );
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), count);
        }
    }
    #[test]
    fn manual_receipts_are_platform_specific_without_api_account_claims() {
        assert_eq!(
            platform_post_url("x", "@fixture", "https://x.com/fixture/status/12345?s=20").unwrap(),
            "https://x.com/fixture/status/12345"
        );
        assert_eq!(
            platform_post_url(
                "naver_clip",
                "fixture",
                "https://clip.naver.com/clip/12345?share=1"
            )
            .unwrap(),
            "https://clip.naver.com/clip/12345"
        );
        for (platform, account, url) in [
            ("x", "fixture", "https://x.com/other/status/12345"),
            ("x", "fixture", "https://x.com/compose/post"),
            (
                "naver_clip",
                "fixture",
                "https://clip.naver.com.evil.test/clip/12345",
            ),
            (
                "naver_clip",
                "fixture",
                "https://clip.naver.com/profile/fixture",
            ),
            ("naver_clip", "fixture", "http://clip.naver.com/clip/12345"),
        ] {
            assert!(platform_post_url(platform, account, url).is_err());
        }
        let mut plan = json!({"platform":"naver_clip","mode":"manual_handoff","contentKind":"text","accountId":"fixture","title":"Title","description":"Body","options":{"confirmHandoff":true}});
        assert!(validate_plan(&plan).is_err());
        plan["platform"] = json!("x");
        assert!(validate_plan(&plan).is_ok());
        plan["mode"] = json!("scheduled");
        assert!(validate_plan(&plan).is_err());
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
