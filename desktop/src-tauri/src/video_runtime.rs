//! Local AI video engines (Apple MLX). One scene per worker process, one worker at a time.
//!
//! The engine table is the license gate: an engine is usable only when its code and
//! weight licenses were verified as commercial-use permissive and its pinned files are
//! present with matching hashes. Unverified or over-memory engines stay listed but disabled.
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
};

pub const DEFAULT_ENGINE: &str = "wan2.1-t2v-1.3b";
const WORKER: &str = include_str!("../../../runtime/wan_t2v_worker.py");
const DOWNLOADER: &str = include_str!("../../../runtime/wan_t2v_download.py");
const T5_CONVERTER: &str = include_str!("../../../runtime/wan_t5_convert.py");
/// bf16 copy of the UMT5 encoder; Apple's .pth loader would upcast it to float32 (about 23GB).
pub const T5_SAFETENSORS: &str = "models_t5_umt5-xxl-enc-bf16.safetensors";
/// Apple's MLX port, pinned. Files and hashes must match before the worker may run.
pub const MLX_EXAMPLES_COMMIT: &str = "796f5b53cab69a3d48a44233ce21aae889e94a08";
const SOURCE_FILES: &[(&str, &str)] = &[
    (
        "wan/__init__.py",
        "f7eef62a24debfce0d1830e32327212d033cf798876c55dc6be147f0b6582a9c",
    ),
    (
        "wan/clip.py",
        "9173989af2ea92eb70d1343dbf688f88301c47c3cbb8ca159fe3f0d5836756cc",
    ),
    (
        "wan/layers.py",
        "8f718280770f9c8592540f988e3d0c451a6be6c1542e7d95b92ffa5fa99fc37c",
    ),
    (
        "wan/model.py",
        "d9cf877868db5daa7f10a1d0fb695b8430e8e79ecb27585c0ef3c00e713309f8",
    ),
    (
        "wan/pipeline.py",
        "e83297e341ab34443721d74927c9c7b7aa429cb4a65b66a55fa87ab5fb7dc3e5",
    ),
    (
        "wan/rope.py",
        "207f945a91400cf91a2fbe0bf4859f11cc875507a800527900b0115afa12e5b7",
    ),
    (
        "wan/sampler.py",
        "0978230dbf6cba779109009e490c41b5daec127e8680bb8235dbce0f09c632db",
    ),
    (
        "wan/t5.py",
        "84a88d8bf2a96fa36b7c0d9157db1554e656f28fe45c6a7857c96b9d96998d99",
    ),
    (
        "wan/tokenizers.py",
        "b6dd93e23f7c30e1d68d65892a4104b0f7da4ea11d669ce7447270d0c8230165",
    ),
    (
        "wan/utils.py",
        "e22a3d79f0f96aaff06b0e8ad49cb04cc00ecf9c1a11b3461df5dc4255aa2eae",
    ),
    (
        "wan/vae.py",
        "4fb77cdef35e4e718ba410cedf90bc6e948136c46d03ac61e6c27cf6365efc12",
    ),
    (
        "wan/vae_layers.py",
        "5abfd40a53f61dbfb73d495d45b250dc485d7b680e2b43c1da9f396c65be8eaf",
    ),
];
/// Weights the worker loads, with the Hugging Face LFS SHA256 at the pinned revision.
const MODEL_FILES: &[(&str, &str)] = &[
    (
        "Wan2.1_VAE.pth",
        "38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981",
    ),
    (
        "diffusion_pytorch_model.safetensors",
        "96b6b242ca1c2f24e9d02cd6596066fab6d310e2d7538f33ae267cb18d957e8f",
    ),
    (
        "models_t5_umt5-xxl-enc-bf16.pth",
        "7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d",
    ),
    (
        "google/umt5-xxl/tokenizer.json",
        "6e197b4d3dbd71da14b4eb255f4fa91c9c1f2068b20a2de2472967ca3d22602b",
    ),
];
const PACKAGES: &[&str] = &[
    "mlx==0.32.4",
    "einops==0.8.2",
    "huggingface-hub==1.33.0",
    "numpy==2.5.3",
    "pillow==12.3.0",
    "tokenizers==0.23.3",
    "torch==2.12.0",
    "tqdm==4.70.1",
    "safetensors==0.8.0",
];
/// Memory the worker may use; leaves room for the app, WebKit and the OS on a 24GB Mac.
pub const MEMORY_LIMIT_GB: f64 = 18.0;
/// Cap used while a TTS server the app did not start keeps its model loaded (the app never stops it).
pub const SHARED_MEMORY_LIMIT_GB: f64 = 16.0;

/// Worker memory cap: lower when a TTS server outside the app's control holds its model in memory.
pub fn memory_limit_gb(external_tts_running: bool) -> f64 {
    if external_tts_running {
        SHARED_MEMORY_LIMIT_GB
    } else {
        MEMORY_LIMIT_GB
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Engine {
    pub id: &'static str,
    pub label: &'static str,
    pub repo: &'static str,
    pub revision: &'static str,
    pub weights_license: &'static str,
    pub code_license: &'static str,
    pub size_gb: f64,
    pub memory_gb: f64,
    /// Why the engine cannot be enabled on this build, if anything.
    pub blocked: Option<&'static str>,
}

pub const ENGINES: &[Engine] = &[
    Engine {
        id: DEFAULT_ENGINE,
        label: "Wan2.1 T2V 1.3B · MLX",
        repo: "Wan-AI/Wan2.1-T2V-1.3B",
        revision: "37ec512624d61f7aa208f7ea8140a131f93afc9a",
        weights_license: "Apache-2.0",
        code_license: "MIT",
        size_gb: 17.6,
        memory_gb: 10.0,
        blocked: None,
    },
    Engine {
        id: "wan2.2-ti2v-5b",
        label: "Wan2.2 TI2V 5B",
        repo: "Wan-AI/Wan2.2-TI2V-5B",
        revision: "",
        weights_license: "Apache-2.0",
        code_license: "미확인",
        size_gb: 0.0,
        memory_gb: 24.0,
        blocked: Some(
            "M5 Pro 24GB에서 검증되지 않았습니다. 공개 측정치의 최대 메모리가 24GB를 넘습니다.",
        ),
    },
    Engine {
        id: "wan2.1-i2v-14b",
        label: "Wan2.1 I2V 14B (이미지→영상)",
        repo: "Wan-AI/Wan2.1-I2V-14B-480P",
        revision: "",
        weights_license: "Apache-2.0",
        code_license: "MIT",
        size_gb: 0.0,
        memory_gb: 39.0,
        blocked: Some("MLX 예제 기준 약 39GB가 필요해 24GB에서 실행할 수 없습니다."),
    },
];

pub fn engine(id: &str) -> Result<&'static Engine, String> {
    ENGINES
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "지원하지 않는 영상 엔진입니다.".into())
}

pub fn supported() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

/// Generation sizes per aspect and quality. Output size is decided by the editor, not here.
pub fn generation_size(aspect: &str, quality: &str) -> Result<(&'static str, u32, u32), String> {
    let portrait = match aspect {
        "9:16" => Some(true),
        "16:9" => Some(false),
        "1:1" => None,
        _ => return Err("화면 비율을 확인하세요.".into()),
    };
    let size = match (portrait, quality) {
        (None, _) => "480x480",
        (Some(true), "preview") => "368x640",
        (Some(false), "preview") => "640x368",
        (Some(true), "standard" | "high") => "480x832",
        (Some(false), "standard" | "high") => "832x480",
        _ => return Err("품질을 확인하세요.".into()),
    };
    let (frames, steps) = match quality {
        "preview" => (33, 20),
        "standard" => (49, 30),
        "high" => (81, 50),
        _ => unreachable!(),
    };
    Ok((size, frames, steps))
}

#[derive(Clone)]
pub struct Paths {
    pub dir: PathBuf,
}

impl Paths {
    pub fn detect() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let runtime = std::env::var_os("TORIS_RUNTIME_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".local/share/toris-studio"));
        Self {
            dir: runtime.join("wan2.1-mlx"),
        }
    }
    fn python(&self) -> PathBuf {
        self.dir.join("venv/bin/python")
    }
    fn source(&self) -> PathBuf {
        self.dir.join("src")
    }
    pub fn model(&self) -> PathBuf {
        self.dir.join("model")
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).map_err(|_| format!("{} 파일이 없습니다.", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "파일을 읽을 수 없습니다.")?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Source files must match the pinned commit byte for byte.
pub fn verify_source(dir: &Path) -> Result<(), String> {
    for (name, digest) in SOURCE_FILES {
        if sha256_file(&dir.join(name))? != *digest {
            return Err(format!("영상 엔진 코드 {name}가 고정 버전과 다릅니다."));
        }
    }
    Ok(())
}

/// The downloader writes toris-model.json only after the license and every hash passed.
/// Re-hashing 17GB on every status call is too slow, so status trusts the receipt plus sizes;
/// the full hash runs once after install (verify_model_full).
pub fn verify_model_receipt(dir: &Path, engine: &Engine) -> Result<(), String> {
    let receipt: Value = serde_json::from_slice(
        &std::fs::read(dir.join("toris-model.json")).map_err(|_| "모델 설치 기록이 없습니다.")?,
    )
    .map_err(|_| "모델 설치 기록이 손상되었습니다.")?;
    if receipt["repo"] != engine.repo
        || receipt["revision"] != engine.revision
        || receipt["license"] != "apache-2.0"
    {
        return Err("모델 설치 기록의 저장소·리비전·라이선스가 다릅니다.".into());
    }
    for (name, digest) in MODEL_FILES {
        if receipt["files"][name] != *digest {
            return Err(format!("모델 설치 기록에 {name} 해시가 없습니다."));
        }
        let meta = std::fs::metadata(dir.join(name))
            .map_err(|_| format!("모델 파일 {name}이 없습니다."))?;
        if !meta.is_file() || meta.len() == 0 {
            return Err(format!("모델 파일 {name}이 비어 있습니다."));
        }
    }
    if !std::fs::metadata(dir.join(T5_SAFETENSORS))
        .is_ok_and(|m| m.is_file() && m.len() > 10_000_000_000)
    {
        return Err("UMT5 인코더 bf16 변환본이 없습니다. 영상 엔진 설치를 다시 실행하세요.".into());
    }
    Ok(())
}

pub fn verify_model_full(dir: &Path) -> Result<(), String> {
    for (name, digest) in MODEL_FILES {
        if sha256_file(&dir.join(name))? != *digest {
            return Err(format!("모델 파일 {name}의 해시가 다릅니다."));
        }
    }
    Ok(())
}

fn base_env(command: &mut Command) {
    command.env_clear();
    for key in ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env(
            "PATH",
            std::env::join_paths(crate::agent_runtime::search_path()).unwrap_or_default(),
        )
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::piped())
        .kill_on_drop(true);
}

/// Progress from one scene: denoising steps are the only real unit of work.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SceneEvent {
    Stage(String),
    Step { done: u32, total: u32 },
}

#[derive(Clone, Debug, PartialEq)]
pub struct SceneJob {
    pub prompt: String,
    pub negative: String,
    pub size: &'static str,
    pub frames: u32,
    pub steps: u32,
    pub seed: u32,
    pub quantize: u8,
    pub output: PathBuf,
    pub memory_limit_gb: f64,
}

impl SceneJob {
    pub fn worker_input(&self, snapshot: &Path) -> Value {
        json!({"prompt": self.prompt, "negativePrompt": self.negative, "size": self.size, "frames": self.frames,
               "steps": self.steps, "seed": self.seed, "quantize": self.quantize, "guidance": 5.0, "shift": 5.0,
               "output": self.output, "snapshot": snapshot,
               "memoryLimitGb": self.memory_limit_gb.clamp(4.0, MEMORY_LIMIT_GB)})
    }
}

/// Parses one worker stdout line. Unknown lines are ignored; errors keep their kind.
pub fn parse_worker_line(line: &str) -> Option<Result<Value, (String, String)>> {
    let value: Value = serde_json::from_str(line).ok()?;
    match value["event"].as_str()? {
        "error" => Some(Err((
            value["kind"].as_str().unwrap_or("failed").to_owned(),
            value["message"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(600)
                .collect(),
        ))),
        "stage" | "step" | "done" => Some(Ok(value)),
        _ => None,
    }
}

#[derive(Default)]
struct Install {
    phase: &'static str,
    step: String,
    log: Vec<String>,
}

pub struct VideoRuntime {
    paths: Paths,
    /// Only one MLX generation at a time on this machine.
    gpu: Mutex<()>,
    current: StdMutex<Option<u32>>,
    install: Arc<StdMutex<Install>>,
}

pub fn shared() -> Arc<VideoRuntime> {
    Arc::new(VideoRuntime::new(Paths::detect()))
}

impl VideoRuntime {
    pub fn new(paths: Paths) -> Self {
        Self {
            paths,
            gpu: Mutex::new(()),
            current: StdMutex::new(None),
            install: Arc::new(StdMutex::new(Install {
                phase: "idle",
                ..Default::default()
            })),
        }
    }

    pub fn ready(&self, id: &str) -> Result<(), String> {
        let engine = engine(id)?;
        if let Some(reason) = engine.blocked {
            return Err(reason.into());
        }
        if !supported() {
            return Err("MLX 영상 엔진은 Apple Silicon Mac에서만 실행됩니다.".into());
        }
        if !self.paths.python().is_file() {
            return Err("영상 엔진이 설치되지 않았습니다.".into());
        }
        verify_source(&self.paths.source())?;
        verify_model_receipt(&self.paths.model(), engine)
    }

    pub fn status(&self) -> Value {
        let install = self
            .install
            .lock()
            .map(|i| json!({"phase": i.phase, "step": i.step, "log": i.log}))
            .unwrap_or(Value::Null);
        let busy = self.gpu.try_lock().is_err();
        let engines: Vec<Value> = ENGINES.iter().map(|e| {
            let ready = self.ready(e.id);
            json!({"id": e.id, "label": e.label, "repo": e.repo, "revision": e.revision,
                   "license": {"weights": e.weights_license, "code": e.code_license},
                   "commercialUse": e.blocked.is_none() && e.weights_license == "Apache-2.0" && e.code_license == "MIT",
                   "sizeGb": e.size_gb, "memoryGb": e.memory_gb, "supported": supported() && e.blocked.is_none(),
                   "installed": ready.is_ok(), "enabled": e.blocked.is_none(), "reason": ready.err()})
        }).collect();
        json!({"engines": engines, "default": DEFAULT_ENGINE, "busy": busy, "install": install, "memoryLimitGb": MEMORY_LIMIT_GB})
    }

    fn log(&self, line: impl Into<String>) {
        if let Ok(mut install) = self.install.lock() {
            install.log.push(line.into().chars().take(300).collect());
            let overflow = install.log.len().saturating_sub(40);
            install.log.drain(..overflow);
        }
    }

    fn step(&self, text: &str) {
        if let Ok(mut install) = self.install.lock() {
            install.step = text.into();
        }
        self.log(format!("▶ {text}"));
    }

    /// Installs the pinned code, an isolated venv and the license-checked weights. Returns at once.
    pub fn install(self: &Arc<Self>, id: &str) -> Result<Value, String> {
        let engine = engine(id)?;
        if let Some(reason) = engine.blocked {
            return Err(reason.into());
        }
        if !supported() {
            return Err("MLX 영상 엔진은 Apple Silicon Mac에서만 설치할 수 있습니다.".into());
        }
        {
            let mut install = self.install.lock().map_err(|_| "설치 상태 오류")?;
            if install.phase == "running" {
                drop(install);
                return Ok(self.status());
            }
            *install = Install {
                phase: "running",
                step: "설치 준비".into(),
                log: vec![],
            };
        }
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let result = this.run_install().await;
            if let Ok(mut install) = this.install.lock() {
                match result {
                    Ok(()) => {
                        install.phase = "done";
                        install.step = "설치 완료".into();
                    }
                    Err(error) => {
                        install.phase = "failed";
                        install.step = error;
                    }
                }
            }
        });
        Ok(self.status())
    }

    async fn run(
        &self,
        program: &Path,
        args: &[&std::ffi::OsStr],
        stdin: Option<&str>,
        minutes: u64,
    ) -> Result<(), String> {
        let mut command = Command::new(program);
        command.args(args).current_dir(&self.paths.dir);
        base_env(&mut command);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|_| format!("{} 실행 실패", program.display()))?;
        if let Some(input) = stdin {
            if let Some(mut pipe) = child.stdin.take() {
                let _ = pipe.write_all(input.as_bytes()).await;
            }
        } else {
            drop(child.stdin.take());
        }
        let mut lines = BufReader::new(child.stdout.take().ok_or("출력 연결 실패")?).lines();
        let stderr = child.stderr.take();
        let errors = tokio::spawn(async move {
            let mut collected = Vec::new();
            if let Some(stderr) = stderr {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    collected.push(line);
                }
            }
            collected
        });
        let reading = async {
            while let Ok(Some(line)) = lines.next_line().await {
                self.log(line);
            }
        };
        let waited = tokio::time::timeout(Duration::from_secs(minutes * 60), async {
            reading.await;
            child.wait().await
        })
        .await;
        let status = match waited {
            Ok(Ok(status)) => status,
            _ => {
                let _ = child.kill().await;
                return Err("설치 단계가 제한 시간을 넘었습니다.".into());
            }
        };
        for line in errors
            .await
            .unwrap_or_default()
            .into_iter()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            self.log(line);
        }
        if status.success() {
            Ok(())
        } else {
            Err("설치 명령이 실패했습니다. 기록을 확인하세요.".into())
        }
    }

    async fn run_install(&self) -> Result<(), String> {
        let dir = &self.paths.dir;
        std::fs::create_dir_all(self.paths.source().join("wan"))
            .map_err(|_| "설치 폴더를 만들 수 없습니다.")?;
        if verify_source(&self.paths.source()).is_err() {
            self.step("Apple MLX 예제 코드 받기 (고정 커밋)");
            for (name, digest) in SOURCE_FILES {
                let url = format!("https://raw.githubusercontent.com/ml-explore/mlx-examples/{MLX_EXAMPLES_COMMIT}/video/wan2.1/{name}");
                let bytes = reqwest::Client::builder()
                    .timeout(Duration::from_secs(60))
                    .build()
                    .map_err(|_| "HTTP 설정 오류")?
                    .get(&url)
                    .send()
                    .await
                    .and_then(|r| r.error_for_status())
                    .map_err(|_| format!("{name}을 받을 수 없습니다."))?
                    .bytes()
                    .await
                    .map_err(|_| format!("{name}을 받을 수 없습니다."))?;
                use sha2::{Digest, Sha256};
                if format!("{:x}", Sha256::digest(&bytes)) != *digest {
                    return Err(format!("{name} 해시가 고정 커밋과 다릅니다."));
                }
                std::fs::write(self.paths.source().join(name), &bytes)
                    .map_err(|_| "코드를 저장할 수 없습니다.")?;
            }
        }
        std::fs::write(dir.join("wan_t2v_worker.py"), WORKER)
            .map_err(|_| "워커를 저장할 수 없습니다.")?;
        std::fs::write(dir.join("wan_t2v_download.py"), DOWNLOADER)
            .map_err(|_| "다운로더를 저장할 수 없습니다.")?;
        let python = self.paths.python();
        if !python.is_file() {
            let uv = crate::agent_runtime::search_path()
                .into_iter()
                .map(|d| d.join("uv"))
                .find(|p| p.is_file())
                .ok_or("uv가 필요합니다. 터미널에서 brew install uv 후 다시 설치하세요.")?;
            self.step("Python 3.12 가상환경 만들기");
            self.run(
                &uv,
                &[
                    "venv".as_ref(),
                    "--python".as_ref(),
                    "3.12".as_ref(),
                    dir.join("venv").as_os_str(),
                ],
                None,
                10,
            )
            .await?;
            self.step("MLX·torch 설치 (고정 버전)");
            let mut args: Vec<&std::ffi::OsStr> = vec![
                "pip".as_ref(),
                "install".as_ref(),
                "--python".as_ref(),
                python.as_os_str(),
            ];
            args.extend(PACKAGES.iter().map(|p| std::ffi::OsStr::new(*p)));
            self.run(&uv, &args, None, 30).await?;
        }
        let engine = engine(DEFAULT_ENGINE)?;
        if verify_model_receipt(&self.paths.model(), engine).is_err() {
            self.step("라이선스 확인 후 Wan2.1 1.3B 가중치 받기 (약 17.6GB)");
            let model = self.paths.model();
            self.run(
                &python,
                &[
                    dir.join("wan_t2v_download.py").as_os_str(),
                    model.as_os_str(),
                ],
                None,
                240,
            )
            .await?;
        }
        self.step("모델 파일 해시 확인");
        let model = self.paths.model();
        tokio::task::spawn_blocking(move || verify_model_full(&model))
            .await
            .map_err(|_| "해시 확인 실패")??;
        if !self.paths.model().join(T5_SAFETENSORS).is_file() {
            self.step("UMT5 인코더를 bf16 그대로 변환 (24GB 메모리 대비)");
            std::fs::write(dir.join("wan_t5_convert.py"), T5_CONVERTER)
                .map_err(|_| "변환기를 저장할 수 없습니다.")?;
            let model = self.paths.model();
            self.run(
                &python,
                &[dir.join("wan_t5_convert.py").as_os_str(), model.as_os_str()],
                None,
                30,
            )
            .await?;
        }
        self.ready(DEFAULT_ENGINE)
    }

    /// Renders one scene. Fails fast if another generation holds the GPU slot.
    /// cancel: when it resolves the worker is killed and the partial file removed.
    pub async fn generate(
        &self,
        id: &str,
        job: &SceneJob,
        on_event: impl Fn(SceneEvent),
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Value, String> {
        self.ready(id)?;
        let _slot = self
            .gpu
            .try_lock()
            .map_err(|_| "다른 AI 영상 생성이 진행 중입니다.")?;
        let mut command = Command::new(self.paths.python());
        command
            .arg(self.paths.dir.join("wan_t2v_worker.py"))
            .current_dir(self.paths.source());
        base_env(&mut command);
        command
            .env("PYTHONPATH", self.paths.source())
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        std::fs::write(self.paths.dir.join("wan_t2v_worker.py"), WORKER)
            .map_err(|_| "워커를 준비할 수 없습니다.")?;
        let mut child = command
            .spawn()
            .map_err(|_| "영상 엔진을 시작하지 못했습니다.")?;
        if let Ok(mut current) = self.current.lock() {
            *current = child.id();
        }
        let input = job.worker_input(&self.paths.model()).to_string();
        let mut stdin = child.stdin.take().ok_or("입력 연결 실패")?;
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|_| "영상 엔진에 작업을 보내지 못했습니다.")?;
        drop(stdin);
        let mut lines = BufReader::new(child.stdout.take().ok_or("출력 연결 실패")?).lines();
        let mut done: Option<Value> = None;
        let mut failure: Option<(String, String)> = None;
        let mut cancel = cancel;
        loop {
            tokio::select! {
                changed = cancel.changed() => {
                    if changed.is_ok() && *cancel.borrow() {
                        let _ = child.kill().await;
                        let _ = std::fs::remove_file(&job.output);
                        if let Ok(mut current) = self.current.lock() { *current = None; }
                        return Err("취소했습니다.".into());
                    }
                }
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else { break };
                    match parse_worker_line(&line) {
                        Some(Ok(value)) => match value["event"].as_str() {
                            Some("stage") => on_event(SceneEvent::Stage(value["stage"].as_str().unwrap_or("").into())),
                            Some("step") => on_event(SceneEvent::Step { done: value["done"].as_u64().unwrap_or(0) as u32, total: value["total"].as_u64().unwrap_or(0) as u32 }),
                            Some("done") => done = Some(value),
                            _ => {}
                        },
                        Some(Err(error)) => failure = Some(error),
                        None => {}
                    }
                }
            }
        }
        let status = child
            .wait()
            .await
            .map_err(|_| "영상 엔진 상태를 확인하지 못했습니다.")?;
        if let Ok(mut current) = self.current.lock() {
            *current = None;
        }
        if let Some((kind, message)) = failure {
            let _ = std::fs::remove_file(&job.output);
            return Err(match kind.as_str() {
                "memory" => format!("메모리가 부족해 장면을 만들지 못했습니다. 품질을 낮추거나 다른 앱을 닫고 다시 시도하세요. ({message})"),
                "model-missing" => "모델 파일이 없습니다. 영상 엔진을 다시 설치하세요.".into(),
                "invalid" => format!("장면 설정이 올바르지 않습니다. ({message})"),
                _ => format!("장면 생성에 실패했습니다. ({message})"),
            });
        }
        let done = done.ok_or_else(|| {
            if status.success() {
                "영상 엔진이 결과를 보고하지 않았습니다.".to_string()
            } else {
                "영상 엔진이 비정상 종료했습니다. 메모리가 부족했을 수 있습니다.".into()
            }
        })?;
        if !std::fs::metadata(&job.output).is_ok_and(|m| m.is_file() && m.len() > 0) {
            return Err("생성한 장면 파일이 없습니다.".into());
        }
        Ok(done)
    }

    pub fn shutdown(&self) {
        if let Ok(current) = self.current.lock() {
            if let Some(pid) = *current {
                #[cfg(unix)]
                unsafe {
                    libc_kill(pid as i32);
                }
            }
        }
    }
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, 15);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_verified_commercial_engines_are_enabled() {
        let enabled: Vec<_> = ENGINES
            .iter()
            .filter(|e| e.blocked.is_none())
            .map(|e| e.id)
            .collect();
        assert_eq!(enabled, [DEFAULT_ENGINE]);
        let default = engine(DEFAULT_ENGINE).unwrap();
        assert_eq!(
            (default.weights_license, default.code_license),
            ("Apache-2.0", "MIT")
        );
        assert_eq!(default.revision.len(), 40);
        assert!(engine("wan2.1-i2v-14b").unwrap().blocked.is_some());
        assert!(engine("unknown").is_err());
    }

    #[test]
    fn generation_sizes_are_closed_and_stay_low_resolution() {
        assert_eq!(
            generation_size("9:16", "preview").unwrap(),
            ("368x640", 33, 20)
        );
        assert_eq!(
            generation_size("16:9", "standard").unwrap(),
            ("832x480", 49, 30)
        );
        assert_eq!(generation_size("1:1", "high").unwrap(), ("480x480", 81, 50));
        assert!(generation_size("4:3", "standard").is_err());
        assert!(generation_size("9:16", "ultra").is_err());
        let worker = WORKER;
        for (size, _, _) in [
            generation_size("9:16", "high").unwrap(),
            generation_size("16:9", "preview").unwrap(),
        ] {
            assert!(
                worker.contains(&format!("\"{size}\"")),
                "{size} is accepted by the worker"
            );
        }
    }

    #[test]
    fn model_receipt_must_match_repo_revision_license_and_files() {
        let root = tempfile::tempdir().unwrap();
        let engine = engine(DEFAULT_ENGINE).unwrap();
        assert!(verify_model_receipt(root.path(), engine).is_err());
        std::fs::create_dir_all(root.path().join("google/umt5-xxl")).unwrap();
        for (name, _) in MODEL_FILES {
            std::fs::write(root.path().join(name), b"w").unwrap();
        }
        std::fs::File::create(root.path().join(T5_SAFETENSORS))
            .unwrap()
            .set_len(11_000_000_000)
            .unwrap();
        let files: serde_json::Map<String, Value> = MODEL_FILES
            .iter()
            .map(|(n, d)| ((*n).to_owned(), json!(d)))
            .collect();
        let write = |license: &str, revision: &str| {
            std::fs::write(root.path().join("toris-model.json"), json!({"repo": engine.repo, "revision": revision, "license": license, "files": files}).to_string()).unwrap()
        };
        write("apache-2.0", engine.revision);
        assert!(verify_model_receipt(root.path(), engine).is_ok());
        write("cc-by-nc-4.0", engine.revision);
        assert!(verify_model_receipt(root.path(), engine)
            .unwrap_err()
            .contains("라이선스"));
        write("apache-2.0", "0000000000000000000000000000000000000000");
        assert!(verify_model_receipt(root.path(), engine).is_err());
        write("apache-2.0", engine.revision);
        std::fs::write(root.path().join("Wan2.1_VAE.pth"), b"").unwrap();
        assert!(verify_model_receipt(root.path(), engine).is_err());
        assert!(
            verify_model_full(root.path()).is_err(),
            "placeholder bytes never pass the real hashes"
        );
    }

    #[test]
    fn worker_lines_keep_error_kind_and_ignore_noise() {
        assert!(parse_worker_line("Saving 49 frames").is_none());
        assert_eq!(
            parse_worker_line(r#"{"event":"step","done":3,"total":30}"#)
                .unwrap()
                .unwrap()["done"],
            3
        );
        let (kind, message) =
            parse_worker_line(r#"{"event":"error","kind":"memory","message":"over"}"#)
                .unwrap()
                .unwrap_err();
        assert_eq!((kind.as_str(), message.as_str()), ("memory", "over"));
        assert!(parse_worker_line(r#"{"event":"shell","cmd":"rm"}"#).is_none());
    }

    #[test]
    fn worker_input_has_only_closed_fields_and_the_memory_cap() {
        let job = SceneJob {
            prompt: "city".into(),
            negative: "".into(),
            size: "480x832",
            frames: 49,
            steps: 30,
            seed: 7,
            quantize: 0,
            output: "/tmp/a.mp4".into(),
            memory_limit_gb: MEMORY_LIMIT_GB,
        };
        let input = job.worker_input(Path::new("/m"));
        assert_eq!(input["memoryLimitGb"], MEMORY_LIMIT_GB);
        assert!(memory_limit_gb(true) < memory_limit_gb(false));
        assert_eq!(memory_limit_gb(false), MEMORY_LIMIT_GB);
        let over = SceneJob {
            memory_limit_gb: 40.0,
            ..job.clone()
        };
        assert_eq!(
            over.worker_input(Path::new("/m"))["memoryLimitGb"],
            MEMORY_LIMIT_GB
        );
        let keys: Vec<_> = input.as_object().unwrap().keys().cloned().collect();
        for key in &keys {
            assert!(
                WORKER.contains(&format!("\"{key}\"")),
                "{key} is allowed by the worker"
            );
        }
    }

    #[tokio::test]
    async fn uninstalled_engine_refuses_to_generate() {
        let root = tempfile::tempdir().unwrap();
        let runtime = VideoRuntime::new(Paths {
            dir: root.path().to_path_buf(),
        });
        let job = SceneJob {
            prompt: "x".into(),
            negative: "".into(),
            size: "368x640",
            frames: 33,
            steps: 20,
            seed: 0,
            quantize: 0,
            output: root.path().join("a.mp4"),
            memory_limit_gb: MEMORY_LIMIT_GB,
        };
        let (_tx, rx) = tokio::sync::watch::channel(false);
        let error = runtime
            .generate(DEFAULT_ENGINE, &job, |_| {}, rx)
            .await
            .unwrap_err();
        assert!(
            error.contains("설치") || error.contains("Apple Silicon"),
            "{error}"
        );
        assert_eq!(runtime.status()["engines"][0]["installed"], false);
        assert!(runtime
            .generate(
                "wan2.1-i2v-14b",
                &job,
                |_| {},
                tokio::sync::watch::channel(false).1
            )
            .await
            .unwrap_err()
            .contains("39GB"));
    }
}
