//! Fixed Docker/PostgreSQL operations. No shell interpolation, Node runtime or public listener.
use crate::config::{config_path, AppConfig};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;

const SCHEMA: &str = include_str!("../../../db/migrations/001_social.sql");
const OPAL_SCHEMA: &str = include_str!("../../../db/migrations/004_opal_research.sql");
const OPAL_RESULT_SHAPE: &str = include_str!("../../../db/migrations/005_opal_result_shape.sql");
const COMPOSE: &str = include_str!("../../../compose.yaml");
const INIT: &str = include_str!("../../../db/init/00-app-role.sh");

fn stack_root() -> Result<PathBuf, String> {
    crate::config::prepare_portable_data()?;
    let root = config_path()
        .parent()
        .ok_or("설정 경로 오류")?
        .join("db-stack");
    fs::create_dir_all(root.join("db/init")).map_err(|_| "DB 설정 폴더 생성 실패")?;
    fs::create_dir_all(root.join("db/migrations")).map_err(|_| "DB 설정 폴더 생성 실패")?;
    fs::write(root.join("compose.yaml"), COMPOSE).map_err(|_| "DB 설정 저장 실패")?;
    fs::write(root.join("db/init/00-app-role.sh"), INIT).map_err(|_| "DB 설정 저장 실패")?;
    fs::write(root.join("db/migrations/001_social.sql"), SCHEMA)
        .map_err(|_| "DB 설정 저장 실패")?;
    fs::write(
        root.join("db/migrations/004_opal_research.sql"),
        OPAL_SCHEMA,
    )
    .map_err(|_| "DB 설정 저장 실패")?;
    fs::write(
        root.join("db/migrations/005_opal_result_shape.sql"),
        OPAL_RESULT_SHAPE,
    )
    .map_err(|_| "DB 설정 저장 실패")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            root.join("db/init/00-app-role.sh"),
            fs::Permissions::from_mode(0o755),
        )
        .map_err(|_| "DB 초기화 권한 설정 실패")?;
    }
    Ok(root)
}
fn write_private(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| "로컬 DB 파일 저장 실패")?;
    file.write_all(data).map_err(|_| "로컬 DB 파일 저장 실패")?;
    file.sync_all().map_err(|_| "로컬 DB 파일 저장 실패")?;
    Ok(())
}
fn credentials(root: &std::path::Path, create: bool) -> Result<HashMap<String, String>, String> {
    let path = root.join(".env.db.local");
    if create && !path.exists() {
        let owner = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let app = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        write_private(
            &path,
            format!(
                "POSTGRES_PASSWORD={owner}\nTORIS_DB_APP_PASSWORD={app}\nTORIS_DB_PORT=54329\n"
            )
            .as_bytes(),
        )?;
    }
    let values: HashMap<_, _> = dotenvy::from_path_iter(&path)
        .map_err(|_| "먼저 로컬 DB를 시작하세요.")?
        .collect::<Result<_, _>>()
        .map_err(|_| "DB 설정 형식 오류")?;
    if values.get("POSTGRES_PASSWORD").is_none_or(|v| v.is_empty())
        || values
            .get("TORIS_DB_APP_PASSWORD")
            .is_none_or(|v| v.is_empty())
    {
        return Err("로컬 DB 인증 설정을 확인하세요.".into());
    }
    let port = values
        .get("TORIS_DB_PORT")
        .map(String::as_str)
        .unwrap_or("54329");
    if port.parse::<u16>().ok().filter(|p| *p >= 1024).is_none() {
        return Err("로컬 DB 포트 형식을 확인하세요.".into());
    }
    Ok(values)
}
fn docker(root: &std::path::Path) -> Command {
    // Finder does not inherit shell PATH. Resolve the standard vendor install too.
    let vendor = if cfg!(target_os = "macos") {
        ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"]
            .into_iter()
            .find(|path| std::path::Path::new(path).is_file())
    } else if cfg!(target_os = "windows") {
        Some("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe")
            .filter(|path| std::path::Path::new(path).is_file())
    } else {
        None
    };
    let mut command = Command::new(vendor.unwrap_or("docker"));
    command
        .current_dir(root)
        .arg("compose")
        .arg("--env-file")
        .arg(root.join(".env.db.local"))
        .arg("-f")
        .arg(root.join("compose.yaml"));
    command.kill_on_drop(true);
    command
}
pub async fn start_database(config: &AppConfig) -> Result<AppConfig, String> {
    let root = stack_root()?;
    let values = credentials(&root, true)?;
    let output = tokio::time::timeout(
        Duration::from_secs(180),
        docker(&root)
            .args(["up", "-d", "--wait", "postgres"])
            .output(),
    )
    .await
    .map_err(|_| "DB 시작 시간이 초과되었습니다.")?
    .map_err(|_| "Docker/OrbStack을 설치하고 실행하세요.")?;
    if !output.status.success() {
        return Err(
            "DB 시작 실패. OrbStack 또는 Docker Desktop 상태와 포트 54329를 확인하세요.".into(),
        );
    }
    let mut next = config.clone();
    if next.database_url.is_none() {
        let mut url = url::Url::parse("postgresql://toris_app@127.0.0.1/toris_studio").unwrap();
        url.set_password(Some(&values["TORIS_DB_APP_PASSWORD"]))
            .map_err(|_| "DB 인증 형식 오류")?;
        url.set_port(Some(
            values
                .get("TORIS_DB_PORT")
                .and_then(|v| v.parse().ok())
                .unwrap_or(54329),
        ))
        .map_err(|_| "DB 포트 형식 오류")?;
        next.database_url = Some(url.to_string());
    }
    next.validate()?;
    migrate_database().await?;
    Ok(next)
}
pub async fn migrate_database() -> Result<(), String> {
    let root = stack_root()?;
    let values = credentials(&root, false)?;
    let mut config = tokio_postgres::Config::new();
    config
        .host("127.0.0.1")
        .port(
            values
                .get("TORIS_DB_PORT")
                .and_then(|v| v.parse().ok())
                .unwrap_or(54329),
        )
        .user("toris_owner")
        .password(&values["POSTGRES_PASSWORD"])
        .dbname("toris_studio")
        .connect_timeout(Duration::from_secs(5));
    let (mut client, connection) = config
        .connect(tokio_postgres::NoTls)
        .await
        .map_err(|_| "로컬 DB 마이그레이션 연결 실패")?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let transaction = client
        .transaction()
        .await
        .map_err(|_| "DB 마이그레이션 실패")?;
    transaction
        .query_one("SELECT pg_advisory_xact_lock(8740291)", &[])
        .await
        .map_err(|_| "DB 마이그레이션 잠금 실패")?;
    transaction
        .batch_execute(SCHEMA)
        .await
        .map_err(|_| "DB 스키마 갱신 실패")?;
    transaction
        .batch_execute(OPAL_SCHEMA)
        .await
        .map_err(|_| "Opal DB 스키마 갱신 실패")?;
    transaction
        .batch_execute(OPAL_RESULT_SHAPE)
        .await
        .map_err(|_| "Opal 결과 형식 제약 갱신 실패")?;
    transaction
        .commit()
        .await
        .map_err(|_| "DB 스키마 갱신 실패")?;
    Ok(())
}
pub async fn backup_database() -> Result<Value, String> {
    let root = stack_root()?;
    credentials(&root, false)?;
    let backup_dir = config_path()
        .parent()
        .ok_or("설정 경로 오류")?
        .join("backups");
    fs::create_dir_all(&backup_dir).map_err(|_| "백업 폴더 생성 실패")?;
    let path = backup_dir.join(format!(
        "social-{}.dump",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path).map_err(|_| "백업 파일 생성 실패")?;
    let result = tokio::time::timeout(
        Duration::from_secs(90),
        docker(&root)
            .args([
                "exec",
                "-T",
                "postgres",
                "pg_dump",
                "-U",
                "toris_owner",
                "-d",
                "toris_studio",
                "--format=custom",
            ])
            .stdout(Stdio::from(file))
            .stderr(Stdio::null())
            .status(),
    )
    .await
    .map_err(|_| "백업 시간이 초과되었습니다.")?
    .map_err(|_| "Docker DB 백업 실행 실패")?;
    if !result.success() {
        return Err("DB 백업 실패. 로컬 Docker DB 상태를 확인하세요.".into());
    }
    Ok(
        json!({"ok":true,"path":path.to_string_lossy(),"bytes":fs::metadata(&path).map_err(|_| "백업 확인 실패")?.len()}),
    )
}
