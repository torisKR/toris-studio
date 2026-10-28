//! Local Qwen3-TTS (MLX) voice engine.
//!
//! Finds or installs a Python runtime and the CustomVoice model, runs the
//! 127.0.0.1 server as a child the app owns, and reports license facts.
//! An existing MLX-Narration install (~/projects/MLX-Narration) is reused
//! read-only: its venv and Hugging Face model cache are never modified.
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

pub const PORT: u16 = 50010;
pub const BASE: &str = "http://127.0.0.1:50010";
pub const MODEL_REPO: &str = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit";
pub const SPEAKERS: &[&str] = &[
    "Sohee", "Ryan", "Aiden", "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ono_Anna",
];
pub const STYLES: &[&str] = &[
    "natural",
    "documentary",
    "tech-news",
    "shorts",
    "story",
    "commercial",
    "emphasis",
    "whisper",
];
pub const EMPHASIS: &[&str] = &["subtle", "normal", "strong"];
pub const QUALITY: &[&str] = &["stable", "standard", "expressive"];
/// Versions verified together by MLX-Narration on Apple Silicon.
const PACKAGES: &[&str] = &[
    "mlx-audio==0.6.2",
    "mlx==0.32.4",
    "fastapi==0.162.0",
    "uvicorn==0.54.0",
    "soundfile==0.14.0",
    "numpy==2.5.4",
    "huggingface-hub==2.3.0",
    "hf-xet==1.7.0",
];
const SERVER: &str = include_str!("../../../runtime/qwen3_tts_server.py");
const NARRATION: &str = include_str!("../../../runtime/narration.py");
const REQUIRED_MODULES: &str = "import importlib.util as u, sys; sys.exit(0 if all(u.find_spec(m) for m in ('mlx_audio', 'fastapi', 'uvicorn', 'soundfile', 'numpy')) else 3)";
const DOWNLOAD: &str = "import sys; from huggingface_hub import snapshot_download; snapshot_download(sys.argv[1], local_dir=sys.argv[2])";
const LOG_LINES: usize = 40;

/// Sampling for servers that predate /narrate (same numbers as runtime/narration.py).
pub fn sampling(quality: &str) -> Value {
    match quality {
        "standard" => json!({"temperature":0.9,"top_p":1.0,"top_k":50,"repetition_penalty":1.05}),
        "expressive" => json!({"temperature":1.0,"top_p":0.95,"top_k":60,"repetition_penalty":1.0}),
        _ => json!({"temperature":0.7,"top_p":0.9,"top_k":40,"repetition_penalty":1.1}),
    }
}

pub fn license() -> Value {
    json!({
        "commercialUse": true,
        "model": {"name": "Qwen3-TTS-12Hz-1.7B-CustomVoice", "license": "Apache-2.0", "url": "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"},
        "runtime": [
            {"name": "mlx-audio", "license": "MIT"},
            {"name": "MLX", "license": "MIT"},
            {"name": "FastAPI", "license": "MIT"},
            {"name": "uvicorn", "license": "BSD-3-Clause"}
        ]
    })
}

pub fn supported() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

#[derive(Clone)]
pub struct Paths {
    pub dir: PathBuf,
    pub home: PathBuf,
    pub hf_hub: PathBuf,
}

impl Paths {
    pub fn detect() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let runtime = std::env::var_os("TORIS_RUNTIME_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".local/share/toris-studio"));
        let hf_hub = std::env::var_os("HF_HUB_CACHE")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HF_HOME").map(|path| PathBuf::from(path).join("hub")))
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".cache/huggingface/hub"));
        Self {
            dir: runtime.join("qwen3-tts-mlx"),
            home,
            hf_hub,
        }
    }
    fn managed_python(&self) -> PathBuf {
        self.dir.join("venv/bin/python")
    }
    pub fn python_candidates(&self) -> Vec<(&'static str, PathBuf)> {
        vec![
            ("toris", self.managed_python()),
            (
                "mlx-narration",
                self.home.join("projects/MLX-Narration/.venv/bin/python"),
            ),
        ]
    }
    pub fn model_candidates(&self) -> Vec<(&'static str, PathBuf)> {
        let mut out = vec![("toris", self.dir.join("model"))];
        let snapshots = self
            .hf_hub
            .join("models--mlx-community--Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit/snapshots");
        if let Ok(entries) = std::fs::read_dir(snapshots) {
            let mut list: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
            list.sort();
            out.extend(list.into_iter().rev().map(|path| ("huggingface", path)));
        }
        out.push((
            "lmstudio",
            self.home
                .join(".lmstudio/models/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"),
        ));
        out
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let metadata =
        std::fs::metadata(path).map_err(|_| format!("{} 파일이 없습니다.", path.display()))?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err(format!("{} 파일 형식을 확인하세요.", path.display()));
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|_| "모델 설정을 읽을 수 없습니다.")?)
        .map_err(|_| format!("{} JSON이 손상되었습니다.", path.display()))
}

fn weights(directory: &Path) -> Result<(), String> {
    let mut found = false;
    for entry in std::fs::read_dir(directory)
        .map_err(|_| "모델 폴더를 읽을 수 없습니다.")?
        .flatten()
    {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "safetensors")
        {
            // metadata() follows Hugging Face cache symlinks to the real blob.
            if !std::fs::metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() > 0) {
                return Err(format!(
                    "모델 가중치가 비어 있거나 덜 받아졌습니다: {}",
                    path.display()
                ));
            }
            found = true;
        }
    }
    if found {
        Ok(())
    } else {
        Err(format!(
            "모델 가중치(.safetensors)가 없습니다: {}",
            directory.display()
        ))
    }
}

/// A complete Qwen3-TTS CustomVoice model: config, weights and speech tokenizer.
pub fn validate_model(directory: &Path) -> Result<(), String> {
    let config = read_json(&directory.join("config.json"))?;
    if config["model_type"] != "qwen3_tts" || config["tts_model_type"] != "custom_voice" {
        return Err("Qwen3-TTS CustomVoice 모델이 아닙니다.".into());
    }
    weights(directory)?;
    read_json(&directory.join("speech_tokenizer/config.json"))?;
    weights(&directory.join("speech_tokenizer"))
}

fn find_model(paths: &Paths) -> Option<(&'static str, PathBuf)> {
    paths
        .model_candidates()
        .into_iter()
        .find(|(_, path)| validate_model(path).is_ok())
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
        .stdin(Stdio::null())
        .kill_on_drop(true);
}

async fn python_ready(python: &Path) -> bool {
    if !python.is_file() {
        return false;
    }
    let mut command = Command::new(python);
    command.args(["-c", REQUIRED_MODULES]);
    base_env(&mut command);
    command.stdout(Stdio::null()).stderr(Stdio::null());
    matches!(
        tokio::time::timeout(Duration::from_secs(20), command.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

fn which(name: &str) -> Option<PathBuf> {
    crate::agent_runtime::search_path()
        .into_iter()
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

pub async fn health() -> Option<Value> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(1500))
        .build()
        .ok()?;
    let response = client.get(format!("{BASE}/health")).send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > 65536)
    {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    (value["ok"] == true && value["provider"] == "qwen3-tts-mlx").then_some(value)
}

async fn port_open() -> bool {
    tokio::time::timeout(
        Duration::from_millis(600),
        tokio::net::TcpStream::connect(("127.0.0.1", PORT)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    let directory = path.parent().ok_or("음성 엔진 경로 오류")?;
    std::fs::create_dir_all(directory).map_err(|_| "음성 엔진 폴더를 만들 수 없습니다.")?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, contents)
        .and_then(|_| std::fs::rename(&temporary, path))
        .map_err(|_| "음성 엔진 파일을 쓸 수 없습니다.".into())
}

fn log_tail(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(6)..].join("\n");
    (!tail.is_empty()).then(|| {
        tail.chars()
            .rev()
            .take(1200)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    })
}

#[derive(Default)]
struct Install {
    phase: &'static str,
    step: String,
    log: VecDeque<String>,
}

pub struct TtsRuntime {
    paths: Paths,
    child: Mutex<Option<Child>>,
    exited: std::sync::Mutex<Option<String>>,
    install: Arc<std::sync::Mutex<Install>>,
    python: Mutex<Option<(&'static str, PathBuf)>>,
}

pub fn shared() -> Arc<TtsRuntime> {
    Arc::new(TtsRuntime::new(Paths::detect()))
}

impl TtsRuntime {
    pub fn new(paths: Paths) -> Self {
        Self {
            paths,
            child: Mutex::new(None),
            exited: std::sync::Mutex::new(None),
            install: Arc::new(std::sync::Mutex::new(Install {
                phase: "idle",
                ..Install::default()
            })),
            python: Mutex::new(None),
        }
    }

    fn log_path(&self) -> PathBuf {
        self.paths.dir.join("service/app-server.log")
    }

    async fn python(&self) -> Option<(&'static str, PathBuf)> {
        let mut cached = self.python.lock().await;
        if let Some(found) = cached.as_ref().filter(|(_, path)| path.is_file()) {
            return Some(found.clone());
        }
        for (source, path) in self.paths.python_candidates() {
            if python_ready(&path).await {
                *cached = Some((source, path));
                return cached.clone();
            }
        }
        *cached = None;
        None
    }

    async fn owned(&self) -> bool {
        let mut guard = self.child.lock().await;
        let Some(child) = guard.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => true,
            _ => {
                *guard = None;
                *self.exited.lock().unwrap() = Some(
                    log_tail(&self.log_path())
                        .unwrap_or_else(|| "음성 서버가 시작 중에 종료되었습니다.".into()),
                );
                false
            }
        }
    }

    fn installing(&self) -> bool {
        self.install.lock().unwrap().phase == "running"
    }

    pub async fn status(&self) -> Value {
        let python = self.python().await;
        let model = find_model(&self.paths);
        let owned = self.owned().await;
        let health = health().await;
        let state = if health.is_some() {
            "running"
        } else if owned {
            "starting"
        } else {
            "stopped"
        };
        let install = {
            let install = self.install.lock().unwrap();
            json!({"phase": install.phase, "step": install.step, "log": install.log})
        };
        json!({
            "supported": supported(),
            "state": state,
            "owned": owned && health.is_some(),
            "narration": health.as_ref().is_some_and(|value| value.get("narration").is_some()),
            "installed": python.is_some() && model.is_some(),
            "python": python.map(|(source, path)| json!({"source": source, "path": path})),
            "model": model.map(|(source, path)| json!({"source": source, "path": path})),
            "install": install,
            "lastError": if state == "running" { None } else { self.exited.lock().unwrap().clone() },
            "endpoint": BASE,
            "license": license(),
        })
    }

    pub async fn start(&self) -> Result<Value, String> {
        if !supported() {
            return Err("로컬 음성 엔진(MLX)은 Apple Silicon Mac에서만 실행됩니다.".into());
        }
        if self.installing() {
            return Err("음성 엔진 설치가 끝난 뒤 켜세요.".into());
        }
        if health().await.is_some() || self.owned().await {
            return Ok(self.status().await);
        }
        if port_open().await {
            return Err(format!(
                "포트 {PORT}을 다른 프로그램이 쓰고 있어 음성 서버를 켤 수 없습니다."
            ));
        }
        let (_, python) = self
            .python()
            .await
            .ok_or("음성 엔진이 설치되지 않았습니다. 설정 › 로컬 음성에서 설치하세요.")?;
        let (_, model) = find_model(&self.paths)
            .ok_or("음성 모델이 없습니다. 설정 › 로컬 음성에서 설치하세요.")?;
        let app = self.paths.dir.join("app");
        write_file(&app.join("runtime/qwen3_tts_server.py"), SERVER)?;
        write_file(&app.join("runtime/narration.py"), NARRATION)?;
        let log_path = self.log_path();
        std::fs::create_dir_all(log_path.parent().ok_or("로그 경로 오류")?)
            .map_err(|_| "로그 폴더를 만들 수 없습니다.")?;
        let log =
            std::fs::File::create(&log_path).map_err(|_| "음성 서버 로그를 만들 수 없습니다.")?;
        let log_err = log
            .try_clone()
            .map_err(|_| "음성 서버 로그를 만들 수 없습니다.")?;
        let mut command = Command::new(&python);
        command
            .arg("-m")
            .arg("uvicorn")
            .arg("runtime.qwen3_tts_server:app")
            .arg("--app-dir")
            .arg(&app)
            .args(["--host", "127.0.0.1", "--port", "50010"])
            .current_dir(&app);
        base_env(&mut command);
        command
            .env("QWEN_TTS_MODEL_DIR", &model)
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));
        let mut guard = self.child.lock().await;
        *guard = Some(
            command
                .spawn()
                .map_err(|_| "음성 서버를 시작하지 못했습니다.")?,
        );
        drop(guard);
        *self.exited.lock().unwrap() = None;
        Ok(self.status().await)
    }

    pub async fn stop(&self) -> Result<Value, String> {
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
            drop(guard);
            return Ok(self.status().await);
        }
        drop(guard);
        if health().await.is_some() {
            return Err(
                "앱 밖에서 켠 음성 서버라 여기서 끄지 않습니다. 터미널에서 pnpm tts:off로 끄세요."
                    .into(),
            );
        }
        Ok(self.status().await)
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.child.try_lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.start_kill();
            }
        }
    }

    /// Installs only what is missing; returns immediately and reports progress via status().
    pub async fn install(self: &Arc<Self>) -> Result<Value, String> {
        if !supported() {
            return Err("로컬 음성 엔진(MLX)은 Apple Silicon Mac에서만 설치할 수 있습니다.".into());
        }
        let already = {
            let mut install = self.install.lock().unwrap();
            let running = install.phase == "running";
            if !running {
                *install = Install {
                    phase: "running",
                    step: "설치 상태 확인".into(),
                    log: VecDeque::new(),
                };
            }
            running
        };
        if already {
            return Ok(self.status().await);
        }
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let result = this.run_install().await;
            *this.python.lock().await = None;
            let mut install = this.install.lock().unwrap();
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
        });
        Ok(self.status().await)
    }

    fn step(&self, text: &str) {
        let mut install = self.install.lock().unwrap();
        install.step = text.into();
        install.log.push_back(format!("▶ {text}"));
        while install.log.len() > LOG_LINES {
            install.log.pop_front();
        }
    }

    async fn run(
        &self,
        program: &Path,
        args: &[&std::ffi::OsStr],
        minutes: u64,
    ) -> Result<(), String> {
        let mut command = Command::new(program);
        command.args(args);
        base_env(&mut command);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|_| format!("{} 실행 실패", program.display()))?;
        let mut readers = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            readers.push(tokio::spawn(collect(stdout, Arc::clone(&self.install))));
        }
        if let Some(stderr) = child.stderr.take() {
            readers.push(tokio::spawn(collect(stderr, Arc::clone(&self.install))));
        }
        let status = tokio::time::timeout(Duration::from_secs(minutes * 60), child.wait())
            .await
            .map_err(|_| "설치 단계가 제한 시간을 넘었습니다.".to_string())?
            .map_err(|_| "설치 명령을 기다리지 못했습니다.".to_string())?;
        for reader in readers {
            let _ = reader.await;
        }
        if status.success() {
            Ok(())
        } else {
            Err("설치 명령이 실패했습니다. 아래 기록을 확인하세요.".into())
        }
    }

    async fn run_install(&self) -> Result<(), String> {
        let python = match self.python().await {
            Some((source, path)) => {
                self.step(&format!("Python 런타임 사용: {source}"));
                path
            }
            None => {
                let venv = self.paths.dir.join("venv");
                let python = self.paths.managed_python();
                std::fs::create_dir_all(&self.paths.dir)
                    .map_err(|_| "설치 폴더를 만들 수 없습니다.")?;
                let packages: Vec<&std::ffi::OsStr> = PACKAGES
                    .iter()
                    .map(|package| std::ffi::OsStr::new(*package))
                    .collect();
                if let Some(uv) = which("uv") {
                    if !python.is_file() {
                        self.step("Python 3.12 가상환경 만들기 (uv)");
                        self.run(
                            &uv,
                            &[
                                "venv".as_ref(),
                                "--python".as_ref(),
                                "3.12".as_ref(),
                                venv.as_os_str(),
                            ],
                            10,
                        )
                        .await?;
                    }
                    self.step("mlx-audio·FastAPI 설치 (고정 버전)");
                    let mut args: Vec<&std::ffi::OsStr> = vec![
                        "pip".as_ref(),
                        "install".as_ref(),
                        "--python".as_ref(),
                        python.as_os_str(),
                    ];
                    args.extend(packages);
                    self.run(&uv, &args, 30).await?;
                } else if let Some(system) = which("python3.12") {
                    if !python.is_file() {
                        self.step("Python 3.12 가상환경 만들기");
                        self.run(
                            &system,
                            &["-m".as_ref(), "venv".as_ref(), venv.as_os_str()],
                            10,
                        )
                        .await?;
                    }
                    self.step("mlx-audio·FastAPI 설치 (고정 버전)");
                    let mut args: Vec<&std::ffi::OsStr> = vec![
                        "-m".as_ref(),
                        "pip".as_ref(),
                        "install".as_ref(),
                        "--disable-pip-version-check".as_ref(),
                    ];
                    args.extend(packages);
                    self.run(&python, &args, 30).await?;
                } else {
                    return Err("uv 또는 Python 3.12가 필요합니다. 터미널에서 brew install uv 후 다시 설치하세요.".into());
                }
                *self.python.lock().await = None;
                if !python_ready(&python).await {
                    return Err("설치한 Python에서 mlx-audio를 불러오지 못했습니다.".into());
                }
                python
            }
        };
        if let Some((source, _)) = find_model(&self.paths) {
            self.step(&format!("음성 모델 사용: {source}"));
            return Ok(());
        }
        self.step("Qwen3-TTS 1.7B CustomVoice 8bit 모델 받기 (약 2.4GB)");
        let model = self.paths.dir.join("model");
        self.run(
            &python,
            &[
                "-c".as_ref(),
                DOWNLOAD.as_ref(),
                MODEL_REPO.as_ref(),
                model.as_os_str(),
            ],
            90,
        )
        .await?;
        validate_model(&model)
    }
}

async fn collect(stream: impl AsyncRead + Unpin, install: Arc<std::sync::Mutex<Install>>) {
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut install = install.lock().unwrap();
        install.log.push_back(line.chars().take(300).collect());
        while install.log.len() > LOG_LINES {
            install.log.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(directory: &Path, voice: &str) {
        std::fs::create_dir_all(directory.join("speech_tokenizer")).unwrap();
        std::fs::write(
            directory.join("config.json"),
            json!({"model_type":"qwen3_tts","tts_model_type":voice}).to_string(),
        )
        .unwrap();
        std::fs::write(directory.join("model.safetensors"), b"w").unwrap();
        std::fs::write(directory.join("speech_tokenizer/config.json"), "{}").unwrap();
        std::fs::write(directory.join("speech_tokenizer/model.safetensors"), b"w").unwrap();
    }

    fn python_keys(name: &str) -> Vec<String> {
        let start = NARRATION
            .find(&format!("\n{name} = {{"))
            .expect("dict in narration.py");
        let body = &NARRATION[start..];
        let body = &body[..body.find("\n}").unwrap()];
        body.lines()
            .filter_map(|line| line.trim().strip_prefix('"'))
            .filter_map(|line| line.split_once("\":").map(|(key, _)| key.to_owned()))
            .collect()
    }

    #[test]
    fn rust_choices_match_the_python_narration_module() {
        assert_eq!(python_keys("SPEAKERS"), SPEAKERS);
        assert_eq!(python_keys("STYLES"), STYLES);
        assert_eq!(python_keys("EMPHASIS"), EMPHASIS);
        assert_eq!(python_keys("QUALITY"), QUALITY);
        assert!(SERVER.contains("@app.post(\"/narrate\")"));
    }

    #[test]
    fn only_complete_custom_voice_models_are_accepted() {
        let root = tempfile::tempdir().unwrap();
        let good = root.path().join("good");
        model(&good, "custom_voice");
        assert!(validate_model(&good).is_ok());
        let base = root.path().join("base");
        model(&base, "base");
        assert!(validate_model(&base).is_err());
        let partial = root.path().join("partial");
        model(&partial, "custom_voice");
        std::fs::write(partial.join("model.safetensors"), b"").unwrap();
        assert!(validate_model(&partial).unwrap_err().contains("덜 받아졌"));
        let no_tokenizer = root.path().join("no-tokenizer");
        model(&no_tokenizer, "custom_voice");
        std::fs::remove_dir_all(no_tokenizer.join("speech_tokenizer")).unwrap();
        assert!(validate_model(&no_tokenizer).is_err());
    }

    #[test]
    fn managed_model_wins_then_hugging_face_cache_then_lm_studio() {
        let root = tempfile::tempdir().unwrap();
        let paths = Paths {
            dir: root.path().join("runtime/qwen3-tts-mlx"),
            home: root.path().join("home"),
            hf_hub: root.path().join("hub"),
        };
        let snapshot = paths
            .hf_hub
            .join("models--mlx-community--Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit/snapshots/abc");
        model(&snapshot, "custom_voice");
        let sources: Vec<_> = paths
            .model_candidates()
            .into_iter()
            .map(|(source, _)| source)
            .collect();
        assert_eq!(sources, ["toris", "huggingface", "lmstudio"]);
        assert_eq!(find_model(&paths).unwrap(), ("huggingface", snapshot));
        model(&paths.dir.join("model"), "custom_voice");
        assert_eq!(find_model(&paths).unwrap().0, "toris");
        let pythons: Vec<_> = paths
            .python_candidates()
            .into_iter()
            .map(|(source, _)| source)
            .collect();
        assert_eq!(pythons, ["toris", "mlx-narration"]);
    }

    #[test]
    fn license_states_commercial_use_with_its_basis() {
        let license = license();
        assert_eq!(license["commercialUse"], true);
        assert_eq!(license["model"]["license"], "Apache-2.0");
        assert!(license["runtime"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| ["MIT", "BSD-3-Clause"].contains(&item["license"].as_str().unwrap())));
    }

    #[test]
    fn fallback_sampling_matches_presets() {
        assert_eq!(sampling("stable")["temperature"], 0.7);
        assert_eq!(sampling("expressive")["top_k"], 60);
    }
}
