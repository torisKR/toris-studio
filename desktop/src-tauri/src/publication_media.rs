//! Private immutable publication assets. The public tunnel exposes only a
//! random capability URL for the files selected by an approved publishing job.
use axum::{
    body::Body,
    extract::{Path as AxumPath, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use chrono::Utc;
use futures_util::stream;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader},
    process::{Child, Command},
};
use uuid::Uuid;

const MAX_VIDEO: u64 = 2 * 1024 * 1024 * 1024;
const MAX_IMAGE: u64 = 20 * 1024 * 1024;

pub fn root_dir() -> Result<PathBuf, String> {
    let root = crate::config::config_path()
        .parent()
        .ok_or("미디어 저장 경로 오류")?
        .join("publication-media");
    private_dir(&root)?;
    Ok(root)
}
fn private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "게시 미디어 폴더를 만들 수 없습니다.")?;
    if !fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
        return Err("게시 미디어 폴더 형식을 확인하세요.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "미디어 폴더 권한 설정 실패")?;
    }
    Ok(())
}
fn id(raw: &str) -> Result<Uuid, String> {
    Uuid::parse_str(raw).map_err(|_| "게시 미디어 식별자가 잘못되었습니다.".into())
}
fn extension(path: &Path, kind: &str) -> Result<(&'static str, &'static str), String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match (kind, ext.as_str()) {
        ("video", "mp4") => Ok(("mp4", "video/mp4")),
        ("thumbnail", "png") => Ok(("png", "image/png")),
        ("thumbnail", "jpg" | "jpeg") => Ok(("jpg", "image/jpeg")),
        ("thumbnail", "webp") => Ok(("webp", "image/webp")),
        _ => Err("영상은 MP4, 썸네일은 PNG·JPEG·WebP 파일을 선택하세요.".into()),
    }
}
fn hash_file(path: &Path) -> Result<(String, u64), String> {
    if !fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) {
        return Err("게시 미디어 파일 형식을 확인하세요.".into());
    }
    let mut file = fs::File::open(path).map_err(|_| "게시 미디어를 열 수 없습니다.")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0;
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| "게시 미디어 검사에 실패했습니다.")?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        size += n as u64;
    }
    Ok((format!("{:x}", hash.finalize()), size))
}
fn tool(name: &str) -> PathBuf {
    for base in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let p = Path::new(base).join(name);
        if p.is_file() {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(base) = exe.parent() {
            let p = base.join(if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.into()
            });
            if p.is_file() {
                return p;
            }
        }
    }
    PathBuf::from(name)
}
async fn probe(path: &Path, kind: &str) -> Result<Value, String> {
    if kind == "thumbnail" {
        let reader = image::ImageReader::open(path)
            .map_err(|_| "썸네일을 읽을 수 없습니다.")?
            .with_guessed_format()
            .map_err(|_| "썸네일 형식 검사 실패")?;
        let expected = match path.extension().and_then(|v| v.to_str()) {
            Some("png") => image::ImageFormat::Png,
            Some("jpg") => image::ImageFormat::Jpeg,
            Some("webp") => image::ImageFormat::WebP,
            _ => return Err("썸네일 형식이 잘못되었습니다.".into()),
        };
        if reader.format() != Some(expected) {
            return Err(
                "썸네일 확장자와 실제 이미지 형식이 다릅니다. 올바른 파일로 다시 선택하세요."
                    .into(),
            );
        }
        let (width, height) = reader
            .into_dimensions()
            .map_err(|_| "썸네일 이미지 형식이 올바르지 않습니다.")?;
        if width == 0 || height == 0 || width > 16384 || height > 16384 {
            return Err("썸네일 크기는 1~16,384px여야 합니다.".into());
        }
        return Ok(json!({"width":width,"height":height}));
    }
    let mut command = Command::new(tool("ffprobe"));
    command
        .kill_on_drop(true)
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "mov",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name,width,height",
            "-of",
            "json",
        ])
        .arg(path);
    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .map_err(|_| "영상 규격 검사가 시간 초과되었습니다.")?
        .map_err(|_| "ffprobe가 없습니다. FFmpeg를 설치한 뒤 영상을 가져오세요.")?;
    if !output.status.success() || output.stdout.len() > 65536 {
        return Err("ffprobe로 MP4 영상 규격을 확인하지 못했습니다.".into());
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "영상 규격 검사 결과가 올바르지 않습니다.")?;
    let video = value["streams"]
        .as_array()
        .and_then(|v| v.iter().find(|s| s["codec_type"] == "video"))
        .ok_or("MP4에 영상 트랙이 없습니다.")?;
    let duration = value["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.)
        .ok_or("영상 재생 시간을 확인할 수 없습니다.")?;
    Ok(
        json!({"width":video["width"],"height":video["height"],"durationSeconds":duration,"codec":video["codec_name"]}),
    )
}
pub async fn import(path: &Path, kind: &str) -> Result<Value, String> {
    import_at(&root_dir()?, path, kind).await
}
async fn import_at(root: &Path, path: &Path, kind: &str) -> Result<Value, String> {
    let (ext, mime) = extension(path, kind)?;
    if !fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) {
        return Err("심볼릭 링크가 아닌 실제 미디어 파일을 선택하세요.".into());
    }
    let mut original = fs::File::open(path).map_err(|_| "미디어 파일을 열 수 없습니다.")?;
    let size = original
        .metadata()
        .map_err(|_| "미디어 정보를 읽지 못했습니다.")?
        .len();
    let max = if kind == "video" {
        MAX_VIDEO
    } else {
        MAX_IMAGE
    };
    if size == 0 || size > max {
        return Err("영상은 2 GiB, 썸네일은 20 MiB 이하의 실제 파일이어야 합니다.".into());
    }
    private_dir(root)?;
    let uuid = Uuid::new_v4();
    let folder = root.join(uuid.to_string());
    private_dir(&folder)?;
    let outcome=async {
        let destination=folder.join(format!("media.{ext}"));let mut options=fs::OpenOptions::new();options.write(true).create_new(true);
        #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
        let mut dest=options.open(&destination).map_err(|_|"미디어 저장 파일을 만들지 못했습니다.")?;
        let mut hasher=Sha256::new();let mut buffer=[0u8;65536];let mut copied=0;
        loop{let count=original.read(&mut buffer).map_err(|_|"미디어 복사에 실패했습니다.")?;if count==0{break;}copied+=count as u64;if copied>max{return Err("가져오는 중 파일 크기가 변경되었습니다.".into());}dest.write_all(&buffer[..count]).map_err(|_|"미디어 저장에 실패했습니다.")?;hasher.update(&buffer[..count]);}
        if copied!=size{return Err("가져오는 중 파일이 변경되었습니다. 다시 선택하세요.".into());}dest.sync_all().map_err(|_|"미디어 저장에 실패했습니다.")?;drop(dest);
        let probe=probe(&destination,kind).await?;
        let metadata=json!({"id":uuid.to_string(),"kind":kind,"name":path.file_name().unwrap_or_default().to_string_lossy(),"bytes":size,"sha256":format!("{:x}",hasher.finalize()),"mime":mime,"extension":ext,"probe":probe,"createdAt":Utc::now().to_rfc3339()});
        let mut file=fs::OpenOptions::new().write(true).create_new(true).open(folder.join("metadata.json")).map_err(|_|"미디어 등록 정보를 저장하지 못했습니다.")?;
        serde_json::to_writer(&mut file,&metadata).map_err(|_|"미디어 등록 정보를 저장하지 못했습니다.")?;file.sync_all().map_err(|_|"미디어 등록 저장 실패")?;
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;fs::set_permissions(&destination,fs::Permissions::from_mode(0o400)).map_err(|_|"미디어 파일 권한 설정 실패")?;fs::set_permissions(folder.join("metadata.json"),fs::Permissions::from_mode(0o400)).map_err(|_|"미디어 정보 권한 설정 실패")?;}
        Ok(public_metadata(&metadata))
    }.await;
    if outcome.is_err() {
        let _ = fs::remove_dir_all(folder);
    }
    outcome
}
fn public_metadata(value: &Value) -> Value {
    let mut v = value.clone();
    v.as_object_mut().map(|o| o.remove("extension"));
    v
}
pub fn metadata(raw: &str) -> Result<Value, String> {
    let folder = root_dir()?.join(id(raw)?.to_string());
    if !fs::symlink_metadata(&folder).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
        return Err("저장된 미디어를 찾을 수 없습니다.".into());
    }
    let path = folder.join("metadata.json");
    if !fs::symlink_metadata(&path)
        .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink() && m.len() <= 16384)
    {
        return Err("미디어 등록 정보가 잘못되었습니다.".into());
    }
    let value: Value =
        serde_json::from_slice(&fs::read(path).map_err(|_| "미디어 정보를 읽지 못했습니다.")?)
            .map_err(|_| "미디어 정보 형식 오류")?;
    if value["id"] != raw {
        return Err("미디어 식별자가 일치하지 않습니다.".into());
    }
    Ok(value)
}
pub fn private_path(raw: &str) -> Result<PathBuf, String> {
    let meta = metadata(raw)?;
    let ext = meta["extension"]
        .as_str()
        .filter(|s| ["mp4", "png", "jpg", "webp"].contains(s))
        .ok_or("미디어 확장자 오류")?;
    let path = root_dir()?
        .join(id(raw)?.to_string())
        .join(format!("media.{ext}"));
    let (sha, size) = hash_file(&path)?;
    if meta["sha256"] != sha || meta["bytes"].as_u64() != Some(size) {
        return Err("승인 미디어 파일이 변경되거나 손상되었습니다. 다시 가져오세요.".into());
    }
    Ok(path)
}
pub fn list() -> Result<Value, String> {
    let root = root_dir()?;
    let mut items = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| "게시 미디어 목록 조회 실패")? {
        let entry = entry.map_err(|_| "게시 미디어 목록 조회 실패")?;
        if let Some(raw) = entry.file_name().to_str() {
            if let Ok(v) = metadata(raw) {
                items.push(public_metadata(&v));
            }
        }
    }
    items.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
    Ok(Value::Array(items))
}
pub fn preview(raw: &str) -> Result<Value, String> {
    use base64::Engine;
    let meta = metadata(raw)?;
    if meta["kind"] != "thumbnail" {
        return Err("영상은 데스크톱 미디어 미리보기로 확인하세요.".into());
    }
    let path = private_path(raw)?;
    let bytes = fs::read(path).map_err(|_| "미디어 미리보기 읽기 실패")?;
    Ok(
        json!({"id":raw,"dataUrl":format!("data:{};base64,{}",meta["mime"].as_str().unwrap_or("image/png"),base64::engine::general_purpose::STANDARD.encode(bytes))}),
    )
}

#[derive(Clone)]
struct Exposed {
    path: PathBuf,
    mime: String,
    size: u64,
}
#[derive(Clone)]
struct LeaseState {
    token: String,
    files: HashMap<String, Exposed>,
    expires: Instant,
}
fn range(raw: Option<&str>, size: u64) -> Result<(u64, u64, bool), ()> {
    let Some(raw) = raw else {
        return Ok((0, size - 1, false));
    };
    let raw = raw.strip_prefix("bytes=").ok_or(())?;
    if raw.contains(',') {
        return Err(());
    }
    let (left, right) = raw.split_once('-').ok_or(())?;
    let (start, end) = if left.is_empty() {
        let count = right.parse::<u64>().map_err(|_| ())?;
        if count == 0 {
            return Err(());
        }
        (size.saturating_sub(count), size - 1)
    } else {
        (
            left.parse::<u64>().map_err(|_| ())?,
            if right.is_empty() {
                size - 1
            } else {
                right.parse::<u64>().map_err(|_| ())?.min(size - 1)
            },
        )
    };
    if start >= size || start > end {
        return Err(());
    }
    Ok((start, end, true))
}
async fn serve(
    State(state): State<Arc<LeaseState>>,
    AxumPath((token, id)): AxumPath<(String, String)>,
    headers: HeaderMap,
    method: axum::http::Method,
) -> Response {
    if token != state.token || Instant::now() > state.expires {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    }
    let Some(file) = state.files.get(&id) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    };
    let Ok((start, end, partial)) = range(
        headers.get(header::RANGE).and_then(|h| h.to_str().ok()),
        file.size,
    ) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{}", file.size))
            .body(Body::empty())
            .unwrap();
    };
    let count = end - start + 1;
    let mut builder = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, &file.mime)
        .header(header::CONTENT_LENGTH, count.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header("x-content-type-options", "nosniff");
    if partial {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", file.size),
        );
    }
    if method == axum::http::Method::HEAD {
        return builder.body(Body::empty()).unwrap();
    }
    let Ok(mut opened) = tokio::fs::File::open(&file.path).await else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    };
    if opened.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    }
    let chunks = stream::try_unfold((opened, count), |(mut file, left)| async move {
        if left == 0 {
            return Ok::<_, std::io::Error>(None);
        }
        let mut bytes = vec![0; left.min(65536) as usize];
        let n = file.read(&mut bytes).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "media",
            ));
        }
        bytes.truncate(n);
        Ok(Some((bytes, (file, left - n as u64))))
    });
    builder.body(Body::from_stream(chunks)).unwrap()
}
pub struct MediaLease {
    pub video_url: String,
    pub thumbnail_url: Option<String>,
    child: Child,
    server: tokio::task::JoinHandle<()>,
    readers: Vec<tokio::task::JoinHandle<()>>,
    _configuration: tempfile::NamedTempFile,
}
impl Drop for MediaLease {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        self.server.abort();
        for task in &self.readers {
            task.abort();
        }
    }
}
pub async fn lease(video: &str, thumbnail: Option<&str>) -> Result<MediaLease, String> {
    let executable = crate::codexify_proxy::cloudflared_binary()
        .ok_or("앱에 포함된 cloudflared 실행 파일을 찾을 수 없습니다.")?;
    let configuration = tempfile::NamedTempFile::new().map_err(|_| "미디어 터널 설정 준비 실패")?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut files = HashMap::new();
    for raw in std::iter::once(video).chain(thumbnail) {
        let meta = metadata(raw)?;
        files.insert(
            raw.to_string(),
            Exposed {
                path: private_path(raw)?,
                mime: meta["mime"].as_str().ok_or("미디어 형식 오류")?.into(),
                size: meta["bytes"].as_u64().ok_or("미디어 크기 오류")?,
            },
        );
    }
    let expected_size = files
        .get(video)
        .ok_or("승인 영상 정보를 찾을 수 없습니다.")?
        .size;
    let state = Arc::new(LeaseState {
        token: token.clone(),
        files,
        expires: Instant::now() + Duration::from_secs(7200),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "임시 미디어 서버를 시작하지 못했습니다.")?;
    let port = listener
        .local_addr()
        .map_err(|_| "미디어 서버 주소 확인 실패")?
        .port();
    let app = Router::new()
        .route("/{token}/{id}", get(serve))
        .with_state(state);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let mut command = Command::new(executable);
    command
        .kill_on_drop(true)
        .args(["tunnel", "--config"])
        .arg(configuration.path())
        .args(["--no-autoupdate", "--url"])
        .arg(format!("http://127.0.0.1:{port}"))
        .args(["--protocol", "http2"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (key, _) in std::env::vars_os() {
        let normalized = key.to_string_lossy().to_ascii_uppercase();
        if normalized.starts_with("TUNNEL_")
            || ["NO_TLS_VERIFY", "NO_AUTOUPDATE"].contains(&normalized.as_str())
        {
            command.env_remove(key);
        }
    }
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(_) => {
            server.abort();
            return Err(
                "cloudflared 실행 파일을 찾을 수 없습니다. 임시 미디어 터널을 준비하세요.".into(),
            );
        }
    };
    let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
    let mut readers = Vec::new();
    macro_rules! reader {
        ($source:expr) => {
            if let Some(pipe) = $source {
                let sender = sender.clone();
                readers.push(tokio::spawn(async move {
                    let mut lines = BufReader::new(pipe).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        for word in line.split_whitespace() {
                            if let Some(origin) = tunnel_origin(word) {
                                let _ = sender.send(origin).await;
                            }
                        }
                    }
                }));
            }
        };
    }
    reader!(child.stdout.take());
    reader!(child.stderr.take());
    drop(sender);
    let origin = match tokio::time::timeout(Duration::from_secs(30), receiver.recv()).await {
        Ok(Some(v)) => v,
        _ => {
            let _ = child.start_kill();
            server.abort();
            for r in readers {
                r.abort();
            }
            return Err(
                "임시 미디어 터널 주소를 받지 못했습니다. 네트워크와 cloudflared를 확인하세요."
                    .into(),
            );
        }
    };
    let lease = MediaLease {
        video_url: format!("{origin}/{token}/{video}"),
        thumbnail_url: thumbnail.map(|id| format!("{origin}/{token}/{id}")),
        child,
        server,
        readers,
        _configuration: configuration,
    };
    // A printed hostname may precede DNS registration or a connected tunnel.
    // Verify only a capability-bound HEAD; no public directory or diagnostic
    // endpoint is exposed and the asset body is never downloaded for readiness.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "미디어 터널 확인 연결을 준비하지 못했습니다.")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if client.head(&lease.video_url).send().await.is_ok_and(|r| {
            r.status().is_success()
                && r.headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    == Some("video/mp4")
                && r.headers()
                    .get(header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    == Some(expected_size)
        }) {
            return Ok(lease);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("임시 미디어 터널 연결이 준비되지 않았습니다. DNS·네트워크를 확인하고 다시 승인하세요.".into());
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }
}
fn tunnel_origin(raw: &str) -> Option<String> {
    let url =
        url::Url::parse(raw.trim_matches(|c: char| matches!(c, '|' | '"' | '\'' | ','))).ok()?;
    let host = url.host_str()?;
    let label = host.strip_suffix(".trycloudflare.com")?;
    if url.scheme() != "https"
        || label.is_empty()
        || label.contains('.')
        || !label
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(format!("https://{host}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_ranges_are_bounded() {
        assert_eq!(range(Some("bytes=3-8"), 10), Ok((3, 8, true)));
        assert_eq!(range(Some("bytes=-3"), 10), Ok((7, 9, true)));
        assert!(range(Some("bytes=10-"), 10).is_err());
        assert!(range(Some("bytes=0-1,4-5"), 10).is_err());
        assert!(range(Some("bytes=-0"), 10).is_err());
    }
    #[test]
    fn tunnel_host_is_strict() {
        assert!(tunnel_origin("https://media.trycloudflare.com").is_some());
        for raw in [
            "https://media.trycloudflare.com.evil.com",
            "https://x.y.trycloudflare.com",
            "https://u:p@media.trycloudflare.com",
            "http://media.trycloudflare.com",
        ] {
            assert!(tunnel_origin(raw).is_none());
        }
    }
    #[tokio::test]
    async fn private_media_handler_requires_exact_token_and_serves_range_and_head() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("video.mp4");
        fs::write(&path, b"0123456789").unwrap();
        let files = HashMap::from([(
            "asset".into(),
            Exposed {
                path,
                mime: "video/mp4".into(),
                size: 10,
            },
        )]);
        let state = Arc::new(LeaseState {
            token: "unguessable-fixture-token".into(),
            files,
            expires: Instant::now() + Duration::from_secs(10),
        });
        let denied = serve(
            State(state.clone()),
            AxumPath(("wrong".into(), "asset".into())),
            HeaderMap::new(),
            axum::http::Method::GET,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=2-5".parse().unwrap());
        let response = serve(
            State(state.clone()),
            AxumPath((state.token.clone(), "asset".into())),
            headers.clone(),
            axum::http::Method::GET,
        )
        .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap()
                .as_ref(),
            b"2345"
        );
        let head = serve(
            State(state.clone()),
            AxumPath((state.token.clone(), "asset".into())),
            headers,
            axum::http::Method::HEAD,
        )
        .await;
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "4");
        assert!(axum::body::to_bytes(head.into_body(), 100)
            .await
            .unwrap()
            .is_empty());
        let expired = Arc::new(LeaseState {
            expires: Instant::now() - Duration::from_secs(1),
            ..(*state).clone()
        });
        let denied = serve(
            State(expired),
            AxumPath((state.token.clone(), "asset".into())),
            HeaderMap::new(),
            axum::http::Method::GET,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    }
    #[tokio::test]
    async fn import_private_copy_preserves_original() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("cover.png");
        image::RgbImage::new(8, 12).save(&source).unwrap();
        let root = temp.path().join("private");
        let result = import_at(&root, &source, "thumbnail").await.unwrap();
        assert_eq!(result["kind"], "thumbnail");
        assert_eq!(result["probe"]["height"], 12);
        assert!(result.get("extension").is_none());
        assert!(source.exists());
        let saved = root.join(result["id"].as_str().unwrap()).join("media.png");
        assert_eq!(hash_file(&saved).unwrap().0, result["sha256"]);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_import() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("cover.png");
        image::RgbImage::new(1, 1).save(&source).unwrap();
        let link = temp.path().join("link.png");
        std::os::unix::fs::symlink(source, &link).unwrap();
        assert!(import_at(&temp.path().join("private"), &link, "thumbnail")
            .await
            .is_err());
    }
}
