//! Read-only product status: GitHub CI and releases, Cloudflare Workers/Pages deploys,
//! an HTTPS health check, and Google Play track releases. Nothing here changes a remote.
//!
//! States are kept apart on purpose: CI "passing" is not "deployed", "deployed" is not
//! "healthy", and Play "in_review" is never "public". The mapping functions are pure and tested.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

const DB_ERROR: &str =
    "운영 상태 DB에 저장하지 못했습니다. 로컬 DB 연결과 마이그레이션(013)을 확인하세요.";
const KEY_SERVICE: &str = "kr.toris.studio.ops.v1";
/// Secrets the collectors read; each is its own OS credential item.
pub const SECRET_KINDS: [&str; 4] = [
    "github_token",
    "cloudflare_token",
    "cloudflare_account",
    "play_service_account",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub source: &'static str,
    pub state: &'static str,
    pub summary: String,
    pub detail: Value,
}

fn status(
    source: &'static str,
    state: &'static str,
    summary: impl Into<String>,
    detail: Value,
) -> Status {
    Status {
        source,
        state,
        summary: summary.into().chars().take(500).collect(),
        detail,
    }
}

/// Latest GitHub Actions run on the default branch.
pub fn github_ci(response: &Value) -> Status {
    let Some(run) = response["workflow_runs"]
        .as_array()
        .and_then(|runs| runs.first())
    else {
        return status("github_ci", "unknown", "실행 기록이 없습니다.", json!({}));
    };
    let name = run["name"].as_str().unwrap_or("CI");
    let detail = json!({"url": run["html_url"], "branch": run["head_branch"], "sha": run["head_sha"].as_str().map(|s| s.chars().take(12).collect::<String>()), "at": run["updated_at"]});
    match (run["status"].as_str(), run["conclusion"].as_str()) {
        (Some("completed"), Some("success")) => {
            status("github_ci", "passing", format!("{name} 통과"), detail)
        }
        (Some("completed"), Some("failure" | "timed_out" | "startup_failure")) => {
            status("github_ci", "failing", format!("{name} 실패"), detail)
        }
        (Some("completed"), Some(other)) => status(
            "github_ci",
            "unknown",
            format!("{name} 종료: {other}"),
            detail,
        ),
        (Some(_), _) => status("github_ci", "running", format!("{name} 실행 중"), detail),
        _ => status("github_ci", "unknown", "CI 상태를 알 수 없습니다.", detail),
    }
}

/// Latest GitHub release. A draft is not published; a prerelease is public but marked.
pub fn github_release(response: &Value) -> Status {
    let Some(release) = response.as_array().and_then(|list| list.first()) else {
        return status("github_release", "unknown", "릴리스가 없습니다.", json!({}));
    };
    let tag = release["tag_name"].as_str().unwrap_or("?");
    let detail = json!({"url": release["html_url"], "tag": tag, "at": release["published_at"], "prerelease": release["prerelease"]});
    if release["draft"] == true {
        status(
            "github_release",
            "draft",
            format!("{tag} 초안(미공개)"),
            detail,
        )
    } else {
        status(
            "github_release",
            "public",
            format!(
                "{tag} 공개{}",
                if release["prerelease"] == true {
                    " · 프리릴리스"
                } else {
                    ""
                }
            ),
            detail,
        )
    }
}

/// Workers deployments list: the first item is the deployment serving traffic. A deploy says nothing about health.
pub fn cloudflare_worker(response: &Value) -> Status {
    if response["success"] != true {
        return status(
            "cloudflare",
            "error",
            "Cloudflare API 응답이 실패했습니다.",
            json!({}),
        );
    }
    let deployments = response["result"]["deployments"]
        .as_array()
        .or_else(|| response["result"].as_array());
    match deployments.and_then(|list| list.first()) {
        Some(latest) => status(
            "cloudflare",
            "deployed",
            "Worker 최신 배포가 트래픽을 받고 있습니다.",
            json!({"id": latest["id"], "at": latest["created_on"], "source": latest["source"]}),
        ),
        None => status(
            "cloudflare",
            "unknown",
            "Worker 배포가 없습니다.",
            json!({}),
        ),
    }
}

/// Pages project: latest_deployment.latest_stage.status is success/failure/active/idle/canceled/skipped.
pub fn cloudflare_pages(response: &Value) -> Status {
    if response["success"] != true {
        return status(
            "cloudflare",
            "error",
            "Cloudflare API 응답이 실패했습니다.",
            json!({}),
        );
    }
    let latest = &response["result"]["latest_deployment"];
    let stage = &latest["latest_stage"];
    let detail = json!({"url": latest["url"], "stage": stage["name"], "at": stage["ended_on"].as_str().or(stage["started_on"].as_str()), "branch": latest["deployment_trigger"]["metadata"]["branch"]});
    match stage["status"].as_str() {
        Some("success") => status("cloudflare", "deployed", "Pages 최신 배포 성공", detail),
        Some("failure") => status(
            "cloudflare",
            "deploy_failed",
            format!(
                "Pages 배포 실패 ({})",
                stage["name"].as_str().unwrap_or("?")
            ),
            detail,
        ),
        Some("active" | "idle") => status("cloudflare", "running", "Pages 배포 진행 중", detail),
        Some(other) => status(
            "cloudflare",
            "unknown",
            format!("Pages 배포 상태: {other}"),
            detail,
        ),
        None => status("cloudflare", "unknown", "Pages 배포가 없습니다.", detail),
    }
}

/// HTTPS GET result. Only 2xx within the time limit counts as healthy.
pub fn health(code: Option<u16>, millis: u128) -> Status {
    match code {
        Some(code) if (200..300).contains(&code) => status(
            "http",
            "healthy",
            format!("HTTP {code} · {millis}ms"),
            json!({"code": code, "ms": millis}),
        ),
        Some(code) => status(
            "http",
            "unhealthy",
            format!("HTTP {code} · {millis}ms"),
            json!({"code": code, "ms": millis}),
        ),
        None => status(
            "http",
            "unhealthy",
            "응답 없음 또는 시간 초과",
            json!({"ms": millis}),
        ),
    }
}

/// Play track releases (tracks.releases.list → ReleaseSummary). Only PUBLISHED is public;
/// review, approved-but-unpublished, drafts and rejections are separate states.
pub fn play_release(response: &Value) -> Status {
    let releases = response["releases"].as_array().cloned().unwrap_or_default();
    let pick = releases
        .iter()
        .find(|r| r["releaseLifecycleState"].is_string())
        .or_else(|| releases.first());
    let Some(release) = pick else {
        return status("play", "unknown", "이 트랙에 릴리스가 없습니다.", json!({}));
    };
    let codes: Vec<Value> = release["activeArtifacts"]
        .as_array()
        .map(|list| list.iter().map(|a| a["versionCode"].clone()).collect())
        .unwrap_or_default();
    let fallback = codes.first().map(|code| code.to_string());
    let name = release["releaseName"]
        .as_str()
        .map(str::to_owned)
        .or(fallback)
        .unwrap_or_else(|| "?".into());
    let detail = json!({"track": release["track"].as_str().or(response["track"].as_str()), "versionCodes": codes, "lifecycle": release["releaseLifecycleState"], "status": release["status"]});
    let state = match (
        release["releaseLifecycleState"].as_str(),
        release["status"].as_str(),
    ) {
        (Some("RELEASE_LIFECYCLE_STATE_PUBLISHED"), _) => "public",
        (
            Some(
                "RELEASE_LIFECYCLE_STATE_IN_REVIEW"
                | "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED",
            ),
            _,
        ) => "in_review",
        (
            Some("RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW" | "RELEASE_LIFECYCLE_STATE_DRAFT"),
            _,
        ) => "draft",
        (Some("RELEASE_LIFECYCLE_STATE_NOT_APPROVED"), _) => "halted",
        (Some(_), _) => "unknown",
        (_, Some("completed" | "inProgress")) => "public",
        (_, Some("draft")) => "draft",
        (_, Some("halted")) => "halted",
        _ => "unknown",
    };
    let label = match state {
        "public" => "공개",
        "in_review" => "심사 중(미공개)",
        "draft" => "초안",
        "halted" => "중단/거절",
        _ => "알 수 없음",
    };
    status(
        "play",
        state,
        format!(
            "{} · {name} {label}",
            response["track"].as_str().unwrap_or("production")
        ),
        detail,
    )
}

// ---- secrets ----

fn secret_kind(kind: &str) -> Result<&'static str, String> {
    SECRET_KINDS
        .into_iter()
        .find(|k| *k == kind)
        .ok_or_else(|| "운영 연결 종류를 확인하세요.".to_string())
}

pub fn read_secret(kind: &str) -> Result<Option<String>, String> {
    let account = secret_kind(kind)?;
    match keyring::Entry::new(KEY_SERVICE, account).and_then(|entry| entry.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(crate::vault::error()),
    }
}

pub fn write_secret(kind: &str, value: Option<&str>) -> Result<(), String> {
    let account = secret_kind(kind)?;
    if let Some(value) = value {
        let limit = if account == "play_service_account" {
            16_384
        } else {
            512
        };
        if value.len() > limit
            || (account != "play_service_account" && value.chars().any(char::is_control))
        {
            return Err("값의 형식이나 길이를 확인하세요.".into());
        }
        if account == "play_service_account" {
            service_account(value)?;
        }
    }
    let entry = keyring::Entry::new(KEY_SERVICE, account).map_err(|_| crate::vault::error())?;
    match value {
        Some(value) => entry.set_password(value).map_err(|_| crate::vault::error()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(crate::vault::error()),
        },
    }
}

/// Which secrets are saved (never their values).
pub fn secret_flags() -> Value {
    Value::Object(
        SECRET_KINDS
            .iter()
            .map(|kind| {
                (
                    kind.to_string(),
                    json!(read_secret(kind).ok().flatten().is_some()),
                )
            })
            .collect::<serde_json::Map<_, _>>(),
    )
}

struct ServiceAccount {
    email: String,
    key_der: Vec<u8>,
}

fn service_account(raw: &str) -> Result<ServiceAccount, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|_| "서비스 계정 JSON 형식이 아닙니다.")?;
    if value["type"] != "service_account" {
        return Err("Google 서비스 계정 키(JSON)를 입력하세요.".into());
    }
    let email = value["client_email"]
        .as_str()
        .filter(|e| e.ends_with(".iam.gserviceaccount.com"))
        .ok_or("서비스 계정 이메일이 없습니다.")?;
    let pem = value["private_key"]
        .as_str()
        .ok_or("서비스 계정 키가 없습니다.")?;
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let key_der = base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .map_err(|_| "서비스 계정 키 형식 오류")?;
    ring::signature::RsaKeyPair::from_pkcs8(&key_der)
        .map_err(|_| "서비스 계정 키(RSA PKCS#8)를 읽지 못했습니다.")?;
    Ok(ServiceAccount {
        email: email.to_owned(),
        key_der,
    })
}

/// RS256 JWT assertion for the Google OAuth token endpoint (androidpublisher scope).
fn play_assertion(account: &ServiceAccount, now: i64) -> Result<String, String> {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = URL_SAFE_NO_PAD.encode(json!({"iss": account.email, "scope": "https://www.googleapis.com/auth/androidpublisher", "aud": "https://oauth2.googleapis.com/token", "iat": now, "exp": now + 3600}).to_string());
    let input = format!("{header}.{claims}");
    let pair = ring::signature::RsaKeyPair::from_pkcs8(&account.key_der)
        .map_err(|_| "서비스 계정 키 오류")?;
    let mut signature = vec![0; pair.public().modulus_len()];
    pair.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        input.as_bytes(),
        &mut signature,
    )
    .map_err(|_| "서명 실패")?;
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

// ---- HTTP (fixed hosts, no redirects, bounded bodies) ----

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent("toris-studio-ops")
        .build()
        .map_err(|_| "HTTP 설정 오류".to_string())
}

async fn get_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|_| "연결하지 못했습니다.")?;
    let code = response.status().as_u16();
    if code == 401 || code == 403 {
        return Err(format!(
            "권한이 없습니다 (HTTP {code}). 토큰 권한을 확인하세요."
        ));
    }
    if !response.status().is_success() {
        return Err(format!("요청 실패 (HTTP {code})."));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "응답을 읽지 못했습니다.")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("응답이 너무 큽니다.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "응답 형식 오류".into())
}

fn valid_name(raw: &str, pattern: fn(char) -> bool, max: usize) -> bool {
    !raw.is_empty() && raw.len() <= max && raw.chars().all(pattern)
}

pub async fn collect_github(repo: &str, token: Option<&str>) -> Vec<Status> {
    let Some((owner, name)) = repo.split_once('/').filter(|(o, n)| {
        valid_name(o, |c| c.is_ascii_alphanumeric() || "-_.".contains(c), 100)
            && valid_name(n, |c| c.is_ascii_alphanumeric() || "-_.".contains(c), 100)
    }) else {
        return vec![status(
            "github_ci",
            "error",
            "저장소 이름 형식 오류",
            json!({}),
        )];
    };
    let Ok(http) = client() else {
        return vec![status("github_ci", "error", "HTTP 설정 오류", json!({}))];
    };
    let base = format!("https://api.github.com/repos/{owner}/{name}");
    let with = |req: reqwest::RequestBuilder| {
        let req = req
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        match token {
            Some(t) => req.bearer_auth(t),
            None => req,
        }
    };
    let ci = match get_json(with(
        http.get(format!("{base}/actions/runs"))
            .query(&[("per_page", "1"), ("exclude_pull_requests", "true")]),
    ))
    .await
    {
        Ok(value) => github_ci(&value),
        Err(error) => status("github_ci", "error", error, json!({})),
    };
    let release = match get_json(with(
        http.get(format!("{base}/releases"))
            .query(&[("per_page", "1")]),
    ))
    .await
    {
        Ok(value) => github_release(&value),
        Err(error) => status("github_release", "error", error, json!({})),
    };
    vec![ci, release]
}

pub async fn collect_cloudflare(
    account: &str,
    token: &str,
    worker: Option<&str>,
    pages: Option<&str>,
) -> Vec<Status> {
    let ok = |s: &str| {
        valid_name(
            s,
            |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-',
            63,
        )
    };
    if !valid_name(account, |c| c.is_ascii_hexdigit(), 64) {
        return vec![status(
            "cloudflare",
            "error",
            "Cloudflare 계정 ID 형식 오류",
            json!({}),
        )];
    }
    let Ok(http) = client() else { return vec![] };
    let base = format!("https://api.cloudflare.com/client/v4/accounts/{account}");
    let mut out = Vec::new();
    if let Some(worker) = worker.filter(|w| ok(w)) {
        out.push(
            match get_json(
                http.get(format!("{base}/workers/scripts/{worker}/deployments"))
                    .bearer_auth(token),
            )
            .await
            {
                Ok(value) => cloudflare_worker(&value),
                Err(error) => status("cloudflare", "error", error, json!({})),
            },
        );
    }
    if let Some(project) = pages.filter(|p| ok(p)) {
        out.push(
            match get_json(
                http.get(format!("{base}/pages/projects/{project}"))
                    .bearer_auth(token),
            )
            .await
            {
                Ok(value) => cloudflare_pages(&value),
                Err(error) => status("cloudflare", "error", error, json!({})),
            },
        );
    }
    out
}

pub async fn collect_health(url: &str) -> Status {
    let Ok(parsed) = url::Url::parse(url) else {
        return status("http", "error", "헬스체크 주소 형식 오류", json!({}));
    };
    // HTTPS only, and never this machine or a private network address.
    let private = match parsed.host() {
        Some(url::Host::Domain(host)) => {
            host == "localhost" || host.ends_with(".local") || host.ends_with(".internal")
        }
        Some(url::Host::Ipv4(ip)) => {
            ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
        }
        // Loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10).
        Some(url::Host::Ipv6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
        None => true,
    };
    if parsed.scheme() != "https"
        || private
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return status(
            "http",
            "error",
            "공개 HTTPS 주소만 확인할 수 있습니다.",
            json!({}),
        );
    }
    let Ok(http) = client() else {
        return status("http", "error", "HTTP 설정 오류", json!({}));
    };
    let started = std::time::Instant::now();
    let code = http
        .get(parsed)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()
        .map(|r| r.status().as_u16());
    health(code, started.elapsed().as_millis())
}

pub async fn collect_play(package: &str, service_json: &str) -> Status {
    if !valid_name(
        package,
        |c| c.is_ascii_alphanumeric() || c == '.' || c == '_',
        200,
    ) || !package.contains('.')
    {
        return status("play", "error", "패키지 이름 형식 오류", json!({}));
    }
    let account = match service_account(service_json) {
        Ok(a) => a,
        Err(e) => return status("play", "error", e, json!({})),
    };
    let Ok(http) = client() else {
        return status("play", "error", "HTTP 설정 오류", json!({}));
    };
    let assertion = match play_assertion(&account, Utc::now().timestamp()) {
        Ok(a) => a,
        Err(e) => return status("play", "error", e, json!({})),
    };
    let token = match http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => match response
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v["access_token"].as_str().map(str::to_owned))
        {
            Some(token) => token,
            None => return status("play", "error", "Google 토큰 응답 형식 오류", json!({})),
        },
        Ok(response) => {
            return status(
                "play",
                "error",
                format!(
                    "서비스 계정 인증 실패 (HTTP {})",
                    response.status().as_u16()
                ),
                json!({}),
            )
        }
        Err(_) => {
            return status(
                "play",
                "error",
                "Google 인증 서버에 연결하지 못했습니다.",
                json!({}),
            )
        }
    };
    match get_json(http.get(format!("https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{package}/tracks/production/releases")).bearer_auth(&token)).await {
        Ok(mut value) => { value["track"] = json!("production"); play_release(&value) }
        Err(error) => status("play", "error", error, json!({})),
    }
}

// ---- products and snapshots ----

fn db<T>(result: Result<T, tokio_postgres::Error>) -> Result<T, String> {
    result.map_err(|_| DB_ERROR.to_string())
}

fn opt_text(input: &Value, key: &str, max: usize) -> Result<Option<String>, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) if s.len() <= max && !s.chars().any(char::is_control) => {
            Ok(Some(s.trim().to_owned()))
        }
        _ => Err(format!("{key} 값을 확인하세요.")),
    }
}

pub fn validate_product(input: &Value) -> Result<(String, String, [Option<String>; 5]), String> {
    let object = input.as_object().ok_or("제품 정보 형식 오류")?;
    let allowed = [
        "id",
        "name",
        "kind",
        "githubRepo",
        "cloudflareWorker",
        "cloudflarePages",
        "healthUrl",
        "playPackage",
    ];
    if let Some(key) = object.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(format!(
            "지원하지 않는 필드입니다: {}",
            key.chars().take(40).collect::<String>()
        ));
    }
    let name = opt_text(input, "name", 120)?.ok_or("제품 이름을 입력하세요.")?;
    let kind = input
        .get("kind")
        .and_then(Value::as_str)
        .filter(|k| matches!(*k, "app" | "web" | "service"))
        .ok_or("종류는 app, web, service 중 하나입니다.")?
        .to_owned();
    let fields = [
        opt_text(input, "githubRepo", 200)?,
        opt_text(input, "cloudflareWorker", 100)?,
        opt_text(input, "cloudflarePages", 100)?,
        opt_text(input, "healthUrl", 2048)?,
        opt_text(input, "playPackage", 200)?,
    ];
    if fields[3]
        .as_deref()
        .is_some_and(|u| !u.starts_with("https://"))
    {
        return Err("헬스체크 주소는 https://로 시작해야 합니다.".into());
    }
    Ok((name, kind, fields))
}

pub async fn save_product(client: &tokio_postgres::Client, input: &Value) -> Result<Value, String> {
    let (name, kind, [repo, worker, pages, health_url, package]) = validate_product(input)?;
    let id = match input.get("id").and_then(Value::as_str) {
        Some(raw) => Uuid::parse_str(raw).map_err(|_| "제품 ID 형식 오류")?,
        None => Uuid::new_v4(),
    };
    // The table's CHECK constraints re-validate repo, names, URL and package formats.
    db(client.execute("INSERT INTO products(id,name,kind,github_repo,cloudflare_worker,cloudflare_pages,health_url,play_package) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO UPDATE SET name=$2,kind=$3,github_repo=$4,cloudflare_worker=$5,cloudflare_pages=$6,health_url=$7,play_package=$8,updated_at=now()",
        &[&id, &name, &kind, &repo, &worker, &pages, &health_url, &package]).await)?;
    Ok(json!({"id": id.to_string()}))
}

pub async fn delete_product(client: &tokio_postgres::Client, raw: &str) -> Result<(), String> {
    let id = Uuid::parse_str(raw).map_err(|_| "제품 ID 형식 오류")?;
    db(client
        .execute("DELETE FROM products WHERE id=$1", &[&id])
        .await)?;
    Ok(())
}

/// Products with their latest snapshot per source. `secrets` is the saved/missing map from `secret_flags`.
pub async fn overview(client: &tokio_postgres::Client, secrets: Value) -> Result<Value, String> {
    let products = db(client
        .query("SELECT * FROM products ORDER BY name", &[])
        .await)?;
    let latest = db(client.query("SELECT DISTINCT ON (product_id, source) product_id, source, state, summary, detail, observed_at FROM product_status_snapshots ORDER BY product_id, source, observed_at DESC", &[]).await)?;
    let list: Vec<Value> = products.iter().map(|row| {
        let id: Uuid = row.get("id");
        let statuses: Vec<Value> = latest.iter().filter(|s| s.get::<_, Uuid>(0) == id).map(|s| json!({"source": s.get::<_, String>(1), "state": s.get::<_, String>(2), "summary": s.get::<_, String>(3), "detail": s.get::<_, Value>(4), "observedAt": s.get::<_, DateTime<Utc>>(5).to_rfc3339()})).collect();
        json!({"id": id.to_string(), "name": row.get::<_, String>("name"), "kind": row.get::<_, String>("kind"), "githubRepo": row.get::<_, Option<String>>("github_repo"), "cloudflareWorker": row.get::<_, Option<String>>("cloudflare_worker"), "cloudflarePages": row.get::<_, Option<String>>("cloudflare_pages"), "healthUrl": row.get::<_, Option<String>>("health_url"), "playPackage": row.get::<_, Option<String>>("play_package"), "statuses": statuses})
    }).collect();
    Ok(json!({"products": list, "secrets": secrets}))
}

/// Credentials the collectors use, loaded once per refresh.
#[derive(Default)]
pub struct Secrets {
    pub github: Option<String>,
    pub cloudflare_account: Option<String>,
    pub cloudflare_token: Option<String>,
    pub play: Option<String>,
}

impl Secrets {
    pub fn load() -> Self {
        let read = |kind: &str| read_secret(kind).ok().flatten();
        Secrets {
            github: read("github_token"),
            cloudflare_account: read("cloudflare_account"),
            cloudflare_token: read("cloudflare_token"),
            play: read("play_service_account"),
        }
    }
}

/// Collects every configured source for every product and stores one snapshot per source.
pub async fn refresh(client: &tokio_postgres::Client, secrets: &Secrets) -> Result<usize, String> {
    let products = db(client.query("SELECT * FROM products", &[]).await)?;
    let mut written = 0;
    for row in products {
        let id: Uuid = row.get("id");
        let mut statuses = Vec::new();
        if let Some(repo) = row.get::<_, Option<String>>("github_repo") {
            statuses.extend(collect_github(&repo, secrets.github.as_deref()).await);
        }
        let worker = row.get::<_, Option<String>>("cloudflare_worker");
        let pages = row.get::<_, Option<String>>("cloudflare_pages");
        if worker.is_some() || pages.is_some() {
            match (&secrets.cloudflare_account, &secrets.cloudflare_token) {
                (Some(account), Some(token)) => statuses.extend(
                    collect_cloudflare(account, token, worker.as_deref(), pages.as_deref()).await,
                ),
                _ => statuses.push(status(
                    "cloudflare",
                    "error",
                    "Cloudflare 계정 ID와 읽기 전용 토큰을 운영 설정에 저장하세요.",
                    json!({}),
                )),
            }
        }
        if let Some(url) = row.get::<_, Option<String>>("health_url") {
            statuses.push(collect_health(&url).await);
        }
        if let Some(package) = row.get::<_, Option<String>>("play_package") {
            statuses.push(match &secrets.play {
                Some(json) => collect_play(&package, json).await,
                None => status(
                    "play",
                    "error",
                    "Play 서비스 계정 키를 운영 설정에 저장하세요.",
                    json!({}),
                ),
            });
        }
        for s in statuses {
            db(client.execute("INSERT INTO product_status_snapshots(id,product_id,source,state,summary,detail) VALUES($1,$2,$3,$4,$5,$6)", &[&Uuid::new_v4(), &id, &s.source, &s.state, &s.summary, &s.detail]).await)?;
            written += 1;
        }
    }
    // Keep 30 days of history.
    db(client
        .execute(
            "DELETE FROM product_status_snapshots WHERE observed_at < now() - interval '30 days'",
            &[],
        )
        .await)?;
    Ok(written)
}

/// Opens (or reuses) a work item for a failing source. Idempotent per product+source.
pub async fn open_task(
    client: &tokio_postgres::Client,
    product: &str,
    source: &str,
) -> Result<Value, String> {
    let id = Uuid::parse_str(product).map_err(|_| "제품 ID 형식 오류")?;
    if !matches!(
        source,
        "github_ci" | "github_release" | "cloudflare" | "http" | "play"
    ) {
        return Err("상태 소스를 확인하세요.".into());
    }
    let row = db(client.query_opt("SELECT p.name, s.summary FROM products p LEFT JOIN LATERAL (SELECT summary FROM product_status_snapshots WHERE product_id=p.id AND source=$2 ORDER BY observed_at DESC LIMIT 1) s ON true WHERE p.id=$1", &[&id, &source]).await)?.ok_or("제품을 찾을 수 없습니다.")?;
    let title: String = format!(
        "{} · {}: {}",
        row.get::<_, String>(0),
        source,
        row.get::<_, Option<String>>(1).unwrap_or_default()
    )
    .chars()
    .take(300)
    .collect();
    let reference = format!("{id}:{source}");
    let task = db(client.query_one("INSERT INTO work_items(id,title,status,product_id,source,source_ref) VALUES($1,$2,'todo',$3,'ops',$4)
        ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET status=CASE WHEN work_items.status IN ('done','dropped') THEN 'todo' ELSE work_items.status END, title=EXCLUDED.title, updated_at=now() RETURNING id",
        &[&Uuid::new_v4(), &title, &id, &reference]).await)?;
    Ok(json!({"id": task.get::<_, Uuid>(0).to_string()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ci_success_failure_and_running_are_distinct() {
        let run = |status: &str, conclusion: Option<&str>| json!({"workflow_runs":[{"name":"Desktop checks","status":status,"conclusion":conclusion,"html_url":"https://github.com/o/r/actions/runs/1","head_sha":"0123456789abcdef"}]});
        assert_eq!(
            github_ci(&run("completed", Some("success"))).state,
            "passing"
        );
        assert_eq!(
            github_ci(&run("completed", Some("failure"))).state,
            "failing"
        );
        assert_eq!(
            github_ci(&run("completed", Some("cancelled"))).state,
            "unknown"
        );
        assert_eq!(github_ci(&run("in_progress", None)).state, "running");
        assert_eq!(github_ci(&json!({"workflow_runs":[]})).state, "unknown");
        assert_eq!(
            github_ci(&run("completed", Some("success"))).detail["sha"],
            "0123456789ab"
        );
    }

    #[test]
    fn a_draft_release_is_never_reported_public() {
        assert_eq!(
            github_release(&json!([{"tag_name":"v1.0.0","draft":true}])).state,
            "draft"
        );
        assert_eq!(
            github_release(&json!([{"tag_name":"v1.0.0","draft":false}])).state,
            "public"
        );
        assert!(
            github_release(&json!([{"tag_name":"v1.1.0-rc","draft":false,"prerelease":true}]))
                .summary
                .contains("프리릴리스")
        );
        assert_eq!(github_release(&json!([])).state, "unknown");
    }

    #[test]
    fn cloudflare_deploys_are_not_health_and_failures_are_named() {
        let worker = cloudflare_worker(
            &json!({"success":true,"result":{"deployments":[{"id":"d1","created_on":"2026-10-27T00:00:00Z"}]}}),
        );
        assert_eq!(worker.state, "deployed");
        assert_ne!(worker.state, "healthy");
        assert_eq!(cloudflare_worker(&json!({"success":false})).state, "error");
        let pages = |status: &str| json!({"success":true,"result":{"latest_deployment":{"url":"https://x.pages.dev","latest_stage":{"name":"build","status":status}}}});
        assert_eq!(cloudflare_pages(&pages("success")).state, "deployed");
        assert_eq!(cloudflare_pages(&pages("failure")).state, "deploy_failed");
        assert!(cloudflare_pages(&pages("failure"))
            .summary
            .contains("build"));
        assert_eq!(cloudflare_pages(&pages("active")).state, "running");
        assert_eq!(cloudflare_pages(&pages("canceled")).state, "unknown");
    }

    #[test]
    fn health_is_only_2xx_and_timeouts_are_unhealthy() {
        assert_eq!(health(Some(200), 80).state, "healthy");
        assert_eq!(health(Some(204), 80).state, "healthy");
        assert_eq!(
            health(Some(301), 80).state,
            "unhealthy",
            "a redirect is not followed and not healthy"
        );
        assert_eq!(health(Some(503), 80).state, "unhealthy");
        assert_eq!(health(None, 10_000).state, "unhealthy");
    }

    #[test]
    fn play_in_review_is_never_public() {
        let release = |lifecycle: Option<&str>, status: &str| json!({"track":"production","releases":[{"releaseName":"1.2.0 (4)","track":"production","activeArtifacts":[{"versionCode":4}],"status":status,"releaseLifecycleState":lifecycle}]});
        assert_eq!(
            play_release(&release(
                Some("RELEASE_LIFECYCLE_STATE_IN_REVIEW"),
                "completed"
            ))
            .state,
            "in_review",
            "lifecycle outranks the legacy status"
        );
        assert_eq!(
            play_release(&release(
                Some("RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED"),
                "completed"
            ))
            .state,
            "in_review"
        );
        assert_eq!(
            play_release(&release(
                Some("RELEASE_LIFECYCLE_STATE_PUBLISHED"),
                "completed"
            ))
            .state,
            "public"
        );
        assert_eq!(
            play_release(&release(
                Some("RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW"),
                "draft"
            ))
            .state,
            "draft"
        );
        assert_eq!(
            play_release(&release(
                Some("RELEASE_LIFECYCLE_STATE_NOT_APPROVED"),
                "completed"
            ))
            .state,
            "halted"
        );
        assert_eq!(
            play_release(&release(
                Some("RELEASE_LIFECYCLE_STATE_UNSPECIFIED"),
                "completed"
            ))
            .state,
            "unknown",
            "an unknown lifecycle never falls back to public"
        );
        assert_eq!(
            play_release(&release(
                Some("RELEASE_LIFECYCLE_STATE_PUBLISHED"),
                "completed"
            ))
            .detail["versionCodes"],
            json!([4])
        );
        assert!(play_release(&json!({"releases":[{"activeArtifacts":[{"versionCode":7}],"releaseLifecycleState":"RELEASE_LIFECYCLE_STATE_DRAFT"}]})).summary.contains('7'));
        assert_eq!(play_release(&release(None, "draft")).state, "draft");
        assert_eq!(play_release(&json!({"releases":[]})).state, "unknown");
        assert!(play_release(&release(
            Some("RELEASE_LIFECYCLE_STATE_IN_REVIEW"),
            "completed"
        ))
        .summary
        .contains("미공개"));
    }

    #[tokio::test]
    async fn health_checks_refuse_plain_http_and_private_hosts_before_any_request() {
        for url in [
            "http://example.com",
            "https://127.0.0.1/health",
            "https://10.0.0.5/",
            "https://localhost/",
            "https://user:pw@example.com/",
            "not a url",
            "https://printer.local/",
            "https://[::1]/",
            "https://[fd00::1]/",
            "https://[fe80::1]/",
        ] {
            assert_eq!(collect_health(url).await.state, "error", "{url}");
        }
    }

    #[tokio::test]
    async fn malformed_identifiers_never_reach_a_request() {
        assert_eq!(collect_github("../../etc", None).await[0].state, "error");
        assert_eq!(
            collect_github("owner/repo/extra", None).await[0].state,
            "error"
        );
        assert_eq!(
            collect_cloudflare("not-hex!", "t", Some("w"), None).await[0].state,
            "error"
        );
        assert!(
            collect_cloudflare("0123abcd", "t", Some("Bad_Name"), Some("../x"))
                .await
                .is_empty(),
            "invalid script/project names are skipped"
        );
        assert_eq!(collect_play("nodots", "{}").await.state, "error");
        assert_eq!(
            collect_play("com.toris.app", "{\"type\":\"user\"}")
                .await
                .state,
            "error"
        );
    }

    #[test]
    fn product_input_rejects_unknown_fields_and_plain_http() {
        assert!(validate_product(&json!({"name":"Toris 앱","kind":"app","playPackage":"com.toris.app","healthUrl":"https://toris.kr/health"})).is_ok());
        assert!(
            validate_product(&json!({"name":"x","kind":"app","token":"secret"})).is_err(),
            "secrets never go through product records"
        );
        assert!(validate_product(&json!({"name":"x","kind":"desktop"})).is_err());
        assert!(
            validate_product(&json!({"name":"x","kind":"web","healthUrl":"http://toris.kr"}))
                .is_err()
        );
        assert!(validate_product(&json!({"kind":"web"})).is_err());
    }

    #[test]
    fn service_account_keys_must_be_rsa_keys_from_a_service_account() {
        let rng = ring::rand::SystemRandom::new();
        // A throwaway key generated for this test only.
        let pkcs8 = ring::signature::EcdsaKeyPair::generate_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &rng,
        )
        .unwrap();
        let ec_pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(pkcs8.as_ref())
        );
        let json = json!({"type":"service_account","client_email":"ops@project.iam.gserviceaccount.com","private_key":ec_pem}).to_string();
        assert!(
            service_account(&json).is_err(),
            "only RSA keys are accepted"
        );
        assert!(service_account(
            &json!({"type":"service_account","client_email":"someone@gmail.com","private_key":"x"})
                .to_string()
        )
        .is_err());
        assert!(service_account("not json").is_err());
    }

    #[tokio::test]
    #[ignore = "Requires TORIS_PUBLICATIONS_TEST_DB pointing to an isolated toris_publications_test_* database (scripts/verify-publication-db.mjs)"]
    async fn postgres_refresh_records_errors_without_network_and_tasks_are_idempotent() {
        let raw =
            std::env::var("TORIS_PUBLICATIONS_TEST_DB").expect("isolated fixture DB URL required");
        let parsed = url::Url::parse(&raw).unwrap();
        assert!(matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")));
        assert!(
            parsed.path().starts_with("/toris_publications_test_"),
            "production database is forbidden"
        );
        let config = crate::config::AppConfig {
            database_url: Some(raw),
            ..Default::default()
        };
        let session = crate::social::database(&config).await.unwrap();
        let client = &session.client;
        client
            .batch_execute("DELETE FROM work_items; DELETE FROM products;")
            .await
            .unwrap();
        // Nothing configured: no snapshot. Private health URL and Cloudflare without credentials: error snapshots, no request.
        save_product(client, &json!({"name":"메모","kind":"web"}))
            .await
            .unwrap();
        let app = save_product(client, &json!({"name":"앱","kind":"service","healthUrl":"https://10.0.0.5/health","cloudflareWorker":"api-worker"})).await.unwrap();
        let app_id = app["id"].as_str().unwrap().to_owned();
        assert_eq!(refresh(client, &Secrets::default()).await.unwrap(), 2);
        let view = overview(client, json!({"github_token": false}))
            .await
            .unwrap();
        let products = view["products"].as_array().unwrap();
        assert_eq!(products.len(), 2);
        assert_eq!(view["secrets"]["github_token"], false);
        let statuses = products
            .iter()
            .find(|p| p["id"] == app_id.as_str())
            .unwrap()["statuses"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(statuses.len(), 2, "{statuses:?}");
        assert!(statuses.iter().all(|s| s["state"] == "error"));
        assert!(
            products.iter().find(|p| p["name"] == "메모").unwrap()["statuses"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        // A second refresh keeps history; overview still shows one latest row per source.
        refresh(client, &Secrets::default()).await.unwrap();
        let again = overview(client, json!({})).await.unwrap();
        assert_eq!(
            again["products"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == app_id.as_str())
                .unwrap()["statuses"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        // Opening the same task twice reuses one work item; a finished one is reopened.
        let first = open_task(client, &app_id, "http").await.unwrap();
        let second = open_task(client, &app_id, "http").await.unwrap();
        assert_eq!(first["id"], second["id"]);
        let count: i64 = client
            .query_one("SELECT count(*) FROM work_items WHERE source='ops'", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(count, 1);
        client
            .execute("UPDATE work_items SET status='done'", &[])
            .await
            .unwrap();
        open_task(client, &app_id, "http").await.unwrap();
        let status: String = client
            .query_one("SELECT status FROM work_items WHERE source='ops'", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(status, "todo");
        let title: String = client
            .query_one("SELECT title FROM work_items WHERE source='ops'", &[])
            .await
            .unwrap()
            .get(0);
        assert!(title.starts_with("앱 · http: "), "{title}");
        assert!(open_task(client, &app_id, "shell").await.is_err());
        assert!(open_task(client, &Uuid::new_v4().to_string(), "http")
            .await
            .is_err());
        // Deleting a product removes its snapshots.
        delete_product(client, &app_id).await.unwrap();
        let left: i64 = client
            .query_one("SELECT count(*) FROM product_status_snapshots", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(left, 0);
        client
            .batch_execute("DELETE FROM work_items; DELETE FROM products;")
            .await
            .unwrap();
    }
}
