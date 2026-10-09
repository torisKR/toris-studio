//! Local, credential-free asset processing shared by desktop IPC and the MCP worker.
mod image_export;
mod mesh;
mod model;
mod presets;
use image_export::image_output;
#[cfg(feature = "desktop")]
pub mod native;

use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_PIXELS: u64 = 33_554_432;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    title: String,
    #[serde(default)]
    prompt: String,
    purpose: String,
    project: String,
    width: u32,
    height: u32,
    format: String,
    fit: String,
    #[serde(default = "one")]
    quantity: u32,
    #[serde(default = "custom_preset")]
    preset_id: String,
    #[serde(default = "white_background")]
    background_color: String,
    #[serde(default = "transparent_background")]
    background_mode: String,
}
fn one() -> u32 {
    1
}
fn custom_preset() -> String {
    "custom".into()
}
fn white_background() -> String {
    "#ffffff".into()
}
fn transparent_background() -> String {
    "transparent".into()
}
impl Spec {
    fn parse(value: Value, generating: bool) -> Result<Self, String> {
        let mut spec: Self = serde_json::from_value(value)
            .map_err(|_| "제목·용도·프로젝트·규격을 확인하세요.".to_owned())?;
        if spec.title.trim().is_empty()
            || spec.title.chars().count() > 120
            || spec.project.trim().is_empty()
            || spec.project.chars().count() > 120
        {
            return Err("제목과 프로젝트는 1~120자로 입력하세요.".into());
        }
        if spec.project.contains(['/', '\\'])
            || spec.project.contains("..")
            || spec.project.chars().any(char::is_control)
        {
            return Err("프로젝트 이름에는 경로나 제어 문자를 사용할 수 없습니다.".into());
        }
        if !["video", "project"].contains(&spec.purpose.as_str())
            || !["png", "jpeg", "webp", "ico"].contains(&spec.format.as_str())
            || !["contain", "cover"].contains(&spec.fit.as_str())
        {
            return Err("지원하지 않는 용도·이미지 형식·맞춤 방식입니다.".into());
        }
        if !(16..=8192).contains(&spec.width)
            || !(16..=8192).contains(&spec.height)
            || spec.width as u64 * spec.height as u64 > MAX_PIXELS
        {
            return Err("가로·세로는 16~8192px, 전체 픽셀은 33,554,432 이하로 지정하세요.".into());
        }
        if !(1..=100).contains(&spec.quantity)
            || spec.prompt.len() > 48_000
            || (generating && spec.prompt.trim().is_empty())
        {
            return Err("프롬프트를 입력하고 요청 수량을 1~100으로 지정하세요.".into());
        }
        presets::validate(&mut spec)?;
        Ok(spec)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    video_root: PathBuf,
    project_root: PathBuf,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    version: u32,
    settings: Settings,
    assets: Vec<Value>,
    jobs: Vec<Value>,
}
impl Store {
    fn new(root: &Path) -> Self {
        Self {
            version: 1,
            settings: Settings {
                video_root: root.join("exports/video"),
                project_root: root.join("exports/projects"),
            },
            assets: vec![],
            jobs: vec![],
        }
    }
    fn output_root(&self, purpose: &str) -> &Path {
        if purpose == "video" {
            &self.settings.video_root
        } else {
            &self.settings.project_root
        }
    }
}
fn err(error: impl std::fmt::Display) -> String {
    format!("에셋 처리 오류: {error}")
}
fn text<'a>(input: &'a Value, field: &str) -> Result<&'a str, String> {
    input
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field} 값을 확인하세요."))
}
fn component(value: &str) -> String {
    let name: String = value
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    if name.trim_matches('_').is_empty() {
        "asset".into()
    } else {
        name
    }
}
pub fn root_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("TORIS_STUDIO_ASSET_HOME") {
        return Ok(PathBuf::from(path));
    }
    Ok(dirs::home_dir()
        .ok_or("홈 폴더를 찾지 못했습니다.")?
        .join(".toris-studio/asset-library"))
}
fn persist(root: &Path, store: &Store) -> Result<(), String> {
    let mut temp = tempfile::NamedTempFile::new_in(root).map_err(err)?;
    serde_json::to_writer_pretty(&mut temp, store).map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist(root.join("library.json")).map_err(err)?;
    Ok(())
}
fn asset_path(asset: &Value, field: &str) -> Result<PathBuf, String> {
    let directory = fs::canonicalize(text(asset, "directory")?).map_err(err)?;
    let path = fs::canonicalize(text(asset, field)?).map_err(err)?;
    if !path.starts_with(&directory) || !path.is_file() {
        return Err("등록된 에셋 파일이 아닙니다.".into());
    }
    Ok(path)
}
pub fn output_path(id: &str) -> Result<PathBuf, String> {
    let result = dispatch("get_asset", json!({"id":id}))?;
    asset_path(&result["asset"], "outputPath")
}
fn bounded_read(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(err)?;
    if !file.metadata().map_err(err)?.is_file()
        || file.metadata().map_err(err)?.len() > MAX_BYTES as u64
    {
        return Err("일반 파일만 지원하며 최대 크기는 32 MiB입니다.".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > MAX_BYTES {
        return Err("파일은 32 MiB 이하여야 합니다.".into());
    }
    Ok(bytes)
}
fn ingest(store: &mut Store, input: &Value) -> Result<Value, String> {
    let filename = text(input, "filename")?;
    if filename.contains(['/', '\\'])
        || filename.chars().any(char::is_control)
        || filename.len() > 512
    {
        return Err("안전한 파일명만 사용할 수 있습니다.".into());
    }
    let encoded = text(input, "dataBase64")?;
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("파일은 32 MiB 이하여야 합니다.".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "파일 인코딩을 확인하세요.")?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("비어 있지 않은 32 MiB 이하 파일이 필요합니다.".into());
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let job_index = input
        .get("jobId")
        .and_then(Value::as_str)
        .map(|id| {
            store
                .jobs
                .iter()
                .position(|j| j["id"] == id)
                .ok_or("작업을 찾지 못했습니다.")
        })
        .transpose()?;
    if let Some(index) = job_index {
        if store.jobs[index]["status"] == "completed" {
            let asset = store
                .assets
                .iter()
                .find(|a| a["id"] == store.jobs[index]["assetId"])
                .ok_or("완료 에셋 기록이 없습니다.")?;
            if asset["sha256"] != hash {
                return Err(
                    "이미 완료한 작업에 다른 파일을 저장할 수 없습니다. 새 작업을 만드세요.".into(),
                );
            }
            // Metadata alone does not prove the result still exists after a manual move/delete.
            for field in ["originalPath", "outputPath"] {
                asset_path(asset, field).map_err(|_| "완료된 에셋의 원본 또는 출력 파일을 찾을 수 없습니다. 파일을 원래 위치로 복원하거나 새 작업으로 가져오세요.".to_owned())?;
            }
            return Ok(json!({"asset":asset,"reused":true}));
        }
        if store.jobs[index]["status"] == "cancelled" {
            return Err("취소된 작업입니다.".into());
        }
    }
    let spec = Spec::parse(
        job_index
            .map(|i| store.jobs[i]["spec"].clone())
            .unwrap_or_else(|| input["spec"].clone()),
        false,
    )?;
    let root = job_index
        .and_then(|i| store.jobs[i]["outputRoot"].as_str().map(PathBuf::from))
        .unwrap_or_else(|| store.output_root(&spec.purpose).to_owned());
    fs::create_dir_all(&root).map_err(err)?;
    let root = fs::canonicalize(root).map_err(err)?;
    let project_dir = root.join(component(&spec.project));
    fs::create_dir_all(&project_dir).map_err(err)?;
    let project_dir = fs::canonicalize(project_dir).map_err(err)?;
    if !project_dir.starts_with(&root) {
        return Err("저장 폴더 밖으로 연결되는 경로는 사용할 수 없습니다.".into());
    }
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = if ["png", "jpg", "jpeg", "webp", "ico"].contains(&ext.as_str()) {
        "image"
    } else if ["glb", "obj", "stl"].contains(&ext.as_str()) {
        "model3d"
    } else {
        return Err("PNG·JPEG·WebP·ICO·GLB·OBJ·STL 파일을 선택하세요.".into());
    };
    let temp = tempfile::Builder::new()
        .prefix(".import-")
        .tempdir_in(&project_dir)
        .map_err(err)?;
    let original_name = format!("original.{ext}");
    fs::write(temp.path().join(&original_name), &bytes).map_err(err)?;
    let (details, output_name, preview_name) = if kind == "image" {
        (
            image_output(&bytes, &spec, temp.path())?,
            format!("export.{}", spec.format),
            Some("preview.jpg"),
        )
    } else {
        let details = model::validate(&bytes, &ext)?;
        let name = format!("export.{ext}");
        fs::write(temp.path().join(&name), &bytes).map_err(err)?;
        (details, name, None)
    };
    let id = Uuid::new_v4().to_string();
    let destination = project_dir.join(format!("{}_{}", component(&spec.title), id));
    fs::rename(temp.path(), &destination).map_err(err)?;
    let now = Utc::now().to_rfc3339();
    let source = input["source"].as_str().unwrap_or("imported");
    if !["chatgpt", "imported", "procedural", "converted"].contains(&source) {
        let _ = fs::remove_dir_all(&destination);
        return Err("지원하지 않는 에셋 출처입니다.".into());
    }
    let asset = json!({"id":id,"originalFilename":filename,"title":spec.title,"prompt":spec.prompt,"purpose":spec.purpose,"project":spec.project,"kind":kind,"format":if kind == "image" {spec.format.as_str()} else {ext.as_str()},"directory":destination,"originalPath":destination.join(original_name),"outputPath":destination.join(output_name),"previewPath":preview_name.map(|name| destination.join(name)),"source":source,"createdAt":now,"favorite":false,"review":"pending","tags":[],"sha256":hash,"bytes":bytes.len(),"details":details,"jobId":input.get("jobId"),"sourceAssetId":input.get("sourceAssetId"),"spec":spec});
    if let Some(index) = job_index {
        store.jobs[index]["status"] = json!("completed");
        store.jobs[index]["assetId"] = json!(id);
        store.jobs[index]["updatedAt"] = json!(now);
    }
    store.assets.push(asset.clone());
    Ok(json!({"asset":asset,"reused":false}))
}

pub fn dispatch(action: &str, input: Value) -> Result<Value, String> {
    dispatch_at(&root_dir()?, action, input)
}
/// The whole read/modify/write transaction is serialized across the GUI and MCP processes.
pub fn dispatch_at(root: &Path, action: &str, input: Value) -> Result<Value, String> {
    fs::create_dir_all(root).map_err(err)?;
    let root = fs::canonicalize(root).map_err(err)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("library.lock"))
        .map_err(err)?;
    lock.lock_exclusive().map_err(err)?;
    let path = root.join("library.json");
    let mut store = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Store>(&bytes).map_err(|_| {
            "에셋 색인 파일이 손상되었습니다. 원본을 보존한 채 복구가 필요합니다.".to_owned()
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Store::new(&root),
        Err(error) => return Err(err(error)),
    };
    if store.version != 1 {
        return Err("지원하지 않는 에셋 색인 버전입니다.".into());
    }
    let old_directories: Vec<String> = store
        .assets
        .iter()
        .filter_map(|a| a["directory"].as_str().map(str::to_owned))
        .collect();
    let mut changed = false;
    let result = match action {
        "snapshot" => {
            let query = input["query"].as_str().unwrap_or("").to_lowercase();
            let purpose = input["purpose"].as_str().unwrap_or("all");
            let kind = input["kind"].as_str().unwrap_or("all");
            let favorites = input["favorite"].as_bool().unwrap_or(false);
            let assets: Vec<&Value> = store
                .assets
                .iter()
                .rev()
                .filter(|a| {
                    (purpose == "all" || a["purpose"] == purpose)
                        && (kind == "all" || a["kind"] == kind)
                        && (!favorites || a["favorite"] == true)
                        && format!(
                            "{} {} {} {}",
                            a["title"], a["project"], a["prompt"], a["tags"]
                        )
                        .to_lowercase()
                        .contains(&query)
                })
                .collect();
            let offset = input["offset"].as_u64().unwrap_or(0) as usize;
            let limit = (input["limit"].as_u64().unwrap_or(48) as usize).clamp(1, 120);
            let job_limit = input["jobLimit"].as_u64().unwrap_or(1000).clamp(1, 1000) as usize;
            let job_status = input["jobStatus"].as_str().unwrap_or("all");
            let job_ids = input["jobIds"].as_array();
            let jobs: Vec<&Value> = store
                .jobs
                .iter()
                .rev()
                .filter(|j| {
                    (job_status == "all"
                        || j["status"] == job_status
                        || (job_status == "pending"
                            && (j["status"] == "queued" || j["status"] == "waiting")))
                        && job_ids.is_none_or(|ids| ids.contains(&j["id"]))
                })
                .take(job_limit)
                .collect();
            json!({"assets":assets.iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":assets.len(),"libraryTotal":store.assets.len(),"offset":offset,"limit":limit,"jobs":jobs,"jobTotal":store.jobs.len(),"settings":store.settings,"storePath":root,"provider":"chatgpt-host","automaticGeneration":false})
        }
        "create_jobs" => {
            let spec = Spec::parse(input, true)?;
            let batch = Uuid::new_v4().to_string();
            let now = Utc::now().to_rfc3339();
            let jobs: Vec<Value> = (0..spec.quantity).map(|index| json!({"id":Uuid::new_v4().to_string(),"batchId":batch,"index":index+1,"spec":spec,"outputRoot":store.output_root(&spec.purpose),"status":"queued","createdAt":now,"updatedAt":now,"assetId":null})).collect();
            store.jobs.extend(jobs.clone());
            changed = true;
            json!({"jobs":jobs,"message":"생성 요청을 저장했습니다. 실제 이미지는 ChatGPT에서 생성한 뒤 전달하세요."})
        }
        "set_job" => {
            let id = text(&input, "id")?;
            let status = text(&input, "status")?;
            if !["queued", "waiting", "cancelled"].contains(&status) {
                return Err("지원하지 않는 작업 상태입니다.".into());
            }
            let job = store
                .jobs
                .iter_mut()
                .find(|j| j["id"] == id)
                .ok_or("작업을 찾지 못했습니다.")?;
            if job["status"] == "completed" {
                return Err("완료한 작업은 변경하지 않습니다.".into());
            }
            job["status"] = json!(status);
            job["updatedAt"] = json!(Utc::now().to_rfc3339());
            changed = true;
            json!({"job":job})
        }
        "settings" => {
            for key in ["videoRoot", "projectRoot"] {
                if let Some(path) = input.get(key) {
                    let path = PathBuf::from(path.as_str().ok_or("저장 폴더를 확인하세요.")?);
                    if !path.is_absolute() || !path.is_dir() || path.parent().is_none() {
                        return Err("존재하는 절대 경로의 폴더를 선택하세요.".into());
                    }
                    let path = fs::canonicalize(path).map_err(err)?;
                    if key == "videoRoot" {
                        store.settings.video_root = path;
                    } else {
                        store.settings.project_root = path;
                    }
                }
            }
            changed = true;
            json!({"settings":store.settings})
        }
        "import" => {
            let result = ingest(&mut store, &input)?;
            changed = result["reused"] != true;
            result
        }
        "resize_asset" => {
            let id = text(&input, "id")?;
            let source = store
                .assets
                .iter()
                .find(|a| a["id"] == id)
                .ok_or("원본 에셋을 찾지 못했습니다.")?
                .clone();
            if source["kind"] != "image" {
                return Err("크기 변경은 이미지 에셋만 지원합니다.".into());
            }
            let spec = Spec::parse(input["spec"].clone(), false)?;
            if spec.quantity != 1 {
                return Err("크기 변경은 에셋 한 개씩 저장합니다.".into());
            }
            let path = asset_path(&source, "originalPath")?;
            let bytes = bounded_read(&path)?;
            let filename = path
                .file_name()
                .and_then(|p| p.to_str())
                .ok_or("보존 원본의 파일명을 확인하세요.")?;
            let result = ingest(
                &mut store,
                &json!({"filename":filename,"dataBase64":STANDARD.encode(bytes),"spec":spec,"source":"converted","sourceAssetId":id}),
            )?;
            changed = true;
            result
        }
        "import_paths" => {
            let paths = input["paths"].as_array().ok_or("파일을 선택하세요.")?;
            if paths.len() > 100 {
                return Err("한 번에 100개 파일까지 가져올 수 있습니다.".into());
            }
            Spec::parse(input["spec"].clone(), false)?;
            let mut results = vec![];
            for path in paths {
                let operation = (|| {
                    let path = Path::new(path.as_str().ok_or("파일 경로를 확인하세요.")?);
                    let bytes = bounded_read(path)?;
                    let mut file_spec = input["spec"].clone();
                    if input["jobId"].as_str().is_none() {
                        file_spec["title"] = json!(path
                            .file_stem()
                            .and_then(|p| p.to_str())
                            .unwrap_or("가져온 에셋")
                            .chars()
                            .take(120)
                            .collect::<String>());
                        file_spec["prompt"] = json!("");
                    }
                    ingest(
                        &mut store,
                        &json!({"filename":path.file_name().and_then(|p|p.to_str()).ok_or("파일명을 확인하세요.")?,"dataBase64":STANDARD.encode(bytes),"spec":file_spec,"source":"imported","jobId":input.get("jobId")}),
                    )
                })();
                match operation {
                    Ok(value) => {
                        changed = true;
                        results.push(value);
                    }
                    Err(error) => results.push(json!({"error":error,"path":path})),
                }
            }
            json!({"results":results})
        }
        "create_mesh" => {
            let (bytes, extension) = mesh::create(&input)?;
            let result = ingest(
                &mut store,
                &json!({"filename":format!("model.{extension}"),"dataBase64":STANDARD.encode(bytes),"spec":input["spec"],"source":"procedural"}),
            )?;
            changed = true;
            result
        }
        "update_asset" => {
            let id = text(&input, "id")?;
            let asset = store
                .assets
                .iter_mut()
                .find(|a| a["id"] == id)
                .ok_or("에셋을 찾지 못했습니다.")?;
            if let Some(favorite) = input.get("favorite") {
                asset["favorite"] = json!(favorite.as_bool().ok_or("즐겨찾기 값을 확인하세요.")?);
            }
            if let Some(review) = input.get("review") {
                let review = review.as_str().ok_or("검토 상태를 확인하세요.")?;
                if !["pending", "approved", "rejected"].contains(&review) {
                    return Err("검토 상태를 확인하세요.".into());
                }
                asset["review"] = json!(review);
            }
            if let Some(tags) = input.get("tags") {
                let values = tags.as_array().ok_or("태그를 확인하세요.")?;
                if values.len() > 32
                    || values
                        .iter()
                        .any(|v| v.as_str().is_none_or(|s| s.chars().count() > 40))
                {
                    return Err("태그는 각 40자, 32개 이하여야 합니다.".into());
                }
                asset["tags"] = tags.clone();
            }
            changed = true;
            json!({"asset":asset})
        }
        "get_asset" | "payload" | "thumbnail" => {
            let id = text(&input, "id")?;
            let asset = store
                .assets
                .iter()
                .find(|a| a["id"] == id)
                .ok_or("에셋을 찾지 못했습니다.")?;
            if action == "get_asset" {
                json!({"asset":asset})
            } else if action == "thumbnail" && asset["previewPath"].is_null() {
                json!({"dataUrl":null})
            } else {
                let bytes = bounded_read(&asset_path(
                    asset,
                    if action == "thumbnail" {
                        "previewPath"
                    } else {
                        "outputPath"
                    },
                )?)?;
                let mime = if action == "thumbnail" {
                    "image/jpeg"
                } else {
                    match asset["format"].as_str().unwrap_or("") {
                        "png" => "image/png",
                        "jpeg" => "image/jpeg",
                        "webp" => "image/webp",
                        "ico" => "image/x-icon",
                        "glb" => "model/gltf-binary",
                        _ => "application/octet-stream",
                    }
                };
                if action == "thumbnail" {
                    json!({"dataUrl":format!("data:{mime};base64,{}",STANDARD.encode(&bytes))})
                } else {
                    json!({"base64":STANDARD.encode(&bytes),"mime":mime})
                }
            }
        }
        _ => return Err("지원하지 않는 에셋 명령입니다.".into()),
    };
    if changed {
        if let Err(error) = persist(&root, &store) {
            // Only directories created by this transaction can be rolled back.
            for directory in store.assets.iter().filter_map(|a| a["directory"].as_str()) {
                if !old_directories.iter().any(|old| old == directory) {
                    let _ = fs::remove_dir_all(directory);
                }
            }
            return Err(error);
        }
    }
    Ok(result)
}

/// Runs before AppConfig::load so MCP asset operations never touch OAuth, Keychain, or model clients.
pub fn worker_main() {
    let result = (|| {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take((MAX_BYTES * 2 + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() > MAX_BYTES * 2 {
            return Err("명령 입력이 너무 큽니다.".into());
        }
        let request: Value = serde_json::from_slice(&bytes).map_err(err)?;
        let action = text(&request, "action")?;
        // File paths and output settings are controlled only by the native UI, never by a remote tool.
        if ![
            "snapshot",
            "create_jobs",
            "set_job",
            "import",
            "create_mesh",
            "update_asset",
            "get_asset",
            "resize_asset",
        ]
        .contains(&action)
        {
            return Err("MCP에서 허용되지 않는 작업입니다.".into());
        }
        dispatch(action, request["input"].clone())
    })();
    match result {
        Ok(result) => {
            let _ = writeln!(std::io::stdout(), "{}", json!({"ok":true,"result":result}));
        }
        Err(error) => {
            let _ = writeln!(std::io::stdout(), "{}", json!({"ok":false,"error":error}));
            std::process::exit(1);
        }
    }
}
