//! Read-only GitHub and Cloudflare status through the user's own `gh`, `cf` or `wrangler` login.
//! The app never sees their tokens: each CLI runs a fixed GET-only argv in an empty folder, with a
//! cleared environment, and only its JSON stdout is parsed into the same states as the REST path.

use super::{status, Status};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_STDOUT: usize = 1024 * 1024;
const MAX_STDERR: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliKind {
    Gh,
    Cf,
    Wrangler,
}
impl CliKind {
    pub fn program(self) -> &'static str {
        match self {
            Self::Gh => "gh",
            Self::Cf => "cf",
            Self::Wrangler => "wrangler",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GhQuery {
    Runs,
    Releases,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CfQuery {
    Worker,
    Pages,
}

fn segment(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 100
        && !raw.starts_with('-')
        && !raw.starts_with('.')
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}
/// Cloudflare script and project names: lowercase, digits and hyphens, never starting with '-'.
fn cf_name(raw: &str) -> Result<&str, String> {
    let ok = !raw.is_empty()
        && raw.len() <= 63
        && !raw.starts_with('-')
        && raw
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    ok.then_some(raw)
        .ok_or_else(|| "Cloudflare 이름 형식 오류".to_string())
}

/// `gh api` GET of one fixed endpoint for an `owner/repo` that cannot become a flag or another path.
pub fn gh_argv(repo: &str, query: GhQuery) -> Result<Vec<String>, String> {
    let (owner, name) = repo
        .split_once('/')
        .filter(|(o, n)| segment(o) && segment(n))
        .ok_or("저장소 이름 형식 오류")?;
    let mut argv: Vec<String> = [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
    ]
    .map(String::from)
    .to_vec();
    match query {
        GhQuery::Runs => argv.extend([
            format!("repos/{owner}/{name}/actions/runs"),
            "-f".into(),
            "per_page=1".into(),
            "-f".into(),
            "exclude_pull_requests=true".into(),
        ]),
        GhQuery::Releases => argv.extend([
            format!("repos/{owner}/{name}/releases"),
            "-f".into(),
            "per_page=1".into(),
        ]),
    }
    Ok(argv)
}

pub fn cf_argv(query: CfQuery, name: &str) -> Result<Vec<String>, String> {
    let name = cf_name(name)?;
    Ok(match query {
        CfQuery::Worker => vec![
            "workers".into(),
            "deployments".into(),
            "list".into(),
            format!("--worker={name}"),
        ],
        CfQuery::Pages => vec!["pages".into(), "get".into(), name.into()],
    })
}

pub fn wrangler_argv(query: CfQuery, name: &str) -> Result<Vec<String>, String> {
    let name = cf_name(name)?;
    Ok(match query {
        CfQuery::Worker => vec![
            "deployments".into(),
            "list".into(),
            format!("--name={name}"),
            "--json".into(),
        ],
        CfQuery::Pages => vec![
            "pages".into(),
            "deployment".into(),
            "list".into(),
            format!("--project-name={name}"),
            "--json".into(),
        ],
    })
}

/// A failed or unreadable CLI call: a fixed reason and message; CLI text never reaches the screen.
#[derive(Debug)]
pub struct CliFailure {
    pub state: &'static str,
    pub reason: &'static str,
    pub summary: String,
}
pub fn classify_failure(kind: CliKind, code: Option<i32>, stderr: &str) -> CliFailure {
    let program = kind.program();
    let lower = stderr.to_ascii_lowercase();
    let (reason, summary) = if code.is_none() {
        (
            "timeout",
            format!("{program} 응답 시간이 초과되었습니다. 잠시 뒤 다시 확인하세요."),
        )
    } else if (kind == CliKind::Gh && code == Some(4))
        || lower.contains("auth login")
        || lower.contains("not logged in")
        || lower.contains("no authentication token")
        || lower.contains("wrangler login")
    {
        (
            "login_required",
            format!("{program} 로그인이 필요합니다. 로그인 버튼으로 터미널에서 로그인하세요."),
        )
    } else if lower.contains("404")
        || lower.contains("not found")
        || lower.contains("does not exist")
    {
        (
            "not_found",
            "저장소·프로젝트가 없거나 이 계정에 권한이 없습니다.".to_string(),
        )
    } else if lower.contains("403") || lower.contains("rate limit") || lower.contains("forbidden") {
        (
            "forbidden",
            "권한 또는 요청 한도 문제로 조회하지 못했습니다.".to_string(),
        )
    } else {
        ("failed", format!("{program} 조회에 실패했습니다."))
    };
    CliFailure {
        state: "error",
        reason,
        summary,
    }
}
fn failure_status(source: &'static str, failure: CliFailure) -> Status {
    status(
        source,
        failure.state,
        failure.summary,
        json!({"via": "cli", "reason": failure.reason}),
    )
}

/// `cf auth whoami` prints JSON; only its two booleans are read.
pub fn cf_logged_in(code: i32, stdout: &str) -> bool {
    code == 0
        && serde_json::from_str::<Value>(stdout)
            .is_ok_and(|v| v["authenticated"] == true && v["tokenValid"] != false)
}

fn parsed(stdout: &str) -> Option<Value> {
    serde_json::from_str::<Value>(stdout)
        .ok()
        .filter(Value::is_object)
}
fn unreadable(program: &str) -> Status {
    status(
        "cloudflare",
        "unknown",
        format!("{program} 출력 형식을 확인하지 못했습니다."),
        json!({"via": "cli"}),
    )
}
/// `cf` prints the API `result` without the `{success, result}` envelope the REST parsers expect.
pub fn cf_worker_status(stdout: &str) -> Status {
    match parsed(stdout).filter(|v| v["deployments"].is_array()) {
        Some(result) => super::cloudflare_worker(&json!({"success": true, "result": result})),
        None => unreadable("cf"),
    }
}
pub fn cf_pages_status(stdout: &str) -> Status {
    match parsed(stdout).filter(|v| v["latest_deployment"].is_object()) {
        Some(result) => super::cloudflare_pages(&json!({"success": true, "result": result})),
        None => unreadable("cf"),
    }
}
/// wrangler `--json` lists: newest first. Field names other than these are not relied on.
pub fn wrangler_worker_status(stdout: &str) -> Status {
    let list = serde_json::from_str::<Value>(stdout)
        .ok()
        .and_then(|v| match v {
            Value::Array(items) => Some(items),
            Value::Object(_) => v["deployments"].as_array().cloned(),
            _ => None,
        });
    match list {
        Some(items) => {
            super::cloudflare_worker(&json!({"success": true, "result": {"deployments": items}}))
        }
        None => unreadable("wrangler"),
    }
}
pub fn wrangler_pages_status(stdout: &str) -> Status {
    let Some(items) = serde_json::from_str::<Value>(stdout)
        .ok()
        .and_then(|v| v.as_array().cloned())
    else {
        return unreadable("wrangler");
    };
    let Some(latest) = items.iter().find(|d| {
        d["Environment"]
            .as_str()
            .is_some_and(|e| e.eq_ignore_ascii_case("production"))
    }) else {
        return status(
            "cloudflare",
            "unknown",
            "Pages 프로덕션 배포가 없습니다.",
            json!({"via": "cli"}),
        );
    };
    let raw = latest["Status"].as_str().unwrap_or("").to_ascii_lowercase();
    let detail = json!({"via": "cli", "id": latest["Id"], "branch": latest["Branch"]});
    if raw.contains("success") {
        status("cloudflare", "deployed", "Pages 최신 배포 성공", detail)
    } else if raw.contains("fail") {
        status("cloudflare", "deploy_failed", "Pages 배포 실패", detail)
    } else {
        status(
            "cloudflare",
            "unknown",
            "Pages 배포 상태를 확인하지 못했습니다.",
            detail,
        )
    }
}

pub async fn run_cli(
    kind: CliKind,
    binary: &Path,
    args: &[String],
    account: Option<&str>,
) -> Result<String, CliFailure> {
    run_cli_with(kind, binary, args, account, TIMEOUT).await
}
/// Runs one CLI with a cleared environment (no app tokens), in an empty temporary folder, stdin closed.
pub async fn run_cli_with(
    kind: CliKind,
    binary: &Path,
    args: &[String],
    account: Option<&str>,
    limit: Duration,
) -> Result<String, CliFailure> {
    let failed = || classify_failure(kind, Some(1), "");
    let folder = tempfile::tempdir().map_err(|_| failed())?;
    let mut command = tokio::process::Command::new(binary);
    command
        .args(args)
        .current_dir(folder.path())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for key in [
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "TMPDIR",
        "SYSTEMROOT",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        // Where gh / cf keep their own login when the user moved the config folder. Never tokens.
        "GH_CONFIG_DIR",
        "XDG_CONFIG_HOME",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let path = std::env::join_paths(crate::agent_runtime::search_path()).map_err(|_| failed())?;
    command.env("PATH", path).env("NO_COLOR", "1");
    match kind {
        CliKind::Gh => {
            command
                .env("GH_PROMPT_DISABLED", "1")
                .env("GH_NO_UPDATE_NOTIFIER", "1");
        }
        CliKind::Cf | CliKind::Wrangler => {
            if let Some(account) =
                account.filter(|a| a.len() <= 64 && a.chars().all(|c| c.is_ascii_hexdigit()))
            {
                command.env("CLOUDFLARE_ACCOUNT_ID", account);
            }
        }
    }
    let mut child = command.spawn().map_err(|_| failed())?;
    let mut stdout = child.stdout.take().ok_or_else(failed)?;
    let mut stderr = child.stderr.take().ok_or_else(failed)?;
    let read = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut limited_out = (&mut stdout).take(MAX_STDOUT as u64 + 1);
        let mut limited_err = (&mut stderr).take(MAX_STDERR as u64);
        let (a, b) = tokio::join!(
            limited_out.read_to_end(&mut out),
            limited_err.read_to_end(&mut err)
        );
        a.and(b).map(|_| (out, err))
    };
    let result = tokio::time::timeout(limit, async {
        let (out, err) = read.await?;
        let code = child.wait().await?;
        Ok::<_, std::io::Error>((out, err, code))
    })
    .await;
    let Ok(Ok((out, err, code))) = result else {
        let _ = child.start_kill();
        return Err(classify_failure(kind, None, ""));
    };
    if !code.success() {
        return Err(classify_failure(
            kind,
            code.code(),
            &String::from_utf8_lossy(&err),
        ));
    }
    if out.len() > MAX_STDOUT {
        return Err(classify_failure(kind, Some(1), ""));
    }
    String::from_utf8(out).map_err(|_| failed())
}

/// GitHub CI and release through `gh`. Returns None when `gh` is not installed.
pub async fn collect_github(repo: &str) -> Option<Vec<Status>> {
    let binary = crate::agent_runtime::find_cli("gh")?;
    let mut out = Vec::new();
    for (query, source) in [
        (GhQuery::Runs, "github_ci"),
        (GhQuery::Releases, "github_release"),
    ] {
        let argv = match gh_argv(repo, query) {
            Ok(argv) => argv,
            Err(error) => return Some(vec![status(source, "error", error, json!({}))]),
        };
        out.push(match run_cli(CliKind::Gh, &binary, &argv, None).await {
            Ok(stdout) => match serde_json::from_str::<Value>(&stdout) {
                Ok(value) if query == GhQuery::Runs => super::github_ci(&value),
                Ok(value) => super::github_release(&value),
                Err(_) => status(
                    source,
                    "unknown",
                    "gh 출력 형식을 확인하지 못했습니다.",
                    json!({"via": "cli"}),
                ),
            },
            Err(failure) => failure_status(source, failure),
        });
    }
    Some(out)
}

/// Worker and Pages through `cf`, or `wrangler` when `cf` is missing. None when neither is installed.
pub async fn collect_cloudflare(
    account: Option<&str>,
    worker: Option<&str>,
    pages: Option<&str>,
) -> Option<Vec<Status>> {
    let (kind, binary) = crate::agent_runtime::find_cli("cf")
        .map(|b| (CliKind::Cf, b))
        .or_else(|| crate::agent_runtime::find_cli("wrangler").map(|b| (CliKind::Wrangler, b)))?;
    let mut out = Vec::new();
    for (query, name) in [(CfQuery::Worker, worker), (CfQuery::Pages, pages)] {
        let Some(name) = name else { continue };
        let argv = match if kind == CliKind::Cf {
            cf_argv(query, name)
        } else {
            wrangler_argv(query, name)
        } {
            Ok(argv) => argv,
            Err(error) => {
                out.push(status("cloudflare", "error", error, json!({})));
                continue;
            }
        };
        out.push(match run_cli(kind, &binary, &argv, account).await {
            Ok(stdout) => match (kind, query) {
                (CliKind::Cf, CfQuery::Worker) => cf_worker_status(&stdout),
                (CliKind::Cf, CfQuery::Pages) => cf_pages_status(&stdout),
                (_, CfQuery::Worker) => wrangler_worker_status(&stdout),
                (_, CfQuery::Pages) => wrangler_pages_status(&stdout),
            },
            Err(failure) => failure_status("cloudflare", failure),
        });
    }
    Some(out)
}

/// Which CLIs are installed and signed in, for the login buttons. Reads only exit codes and whoami flags.
pub async fn login_status() -> Value {
    let gh = crate::agent_runtime::find_cli("gh");
    let cf = crate::agent_runtime::find_cli("cf");
    let wrangler = crate::agent_runtime::find_cli("wrangler");
    let gh_in = match &gh {
        Some(b) => Some(
            run_cli(
                CliKind::Gh,
                b,
                &[
                    "auth".into(),
                    "status".into(),
                    "--hostname".into(),
                    "github.com".into(),
                ],
                None,
            )
            .await
            .is_ok(),
        ),
        None => None,
    };
    let cf_in = match &cf {
        Some(b) => Some(
            run_cli(CliKind::Cf, b, &["auth".into(), "whoami".into()], None)
                .await
                .is_ok_and(|out| cf_logged_in(0, &out)),
        ),
        None => None,
    };
    let wrangler_in = match (&cf, &wrangler) {
        (None, Some(b)) => Some(
            run_cli(CliKind::Wrangler, b, &["whoami".into()], None)
                .await
                .is_ok(),
        ),
        _ => None,
    };
    json!({
        "gh": {"installed": gh.is_some(), "signedIn": gh_in},
        "cf": {"installed": cf.is_some(), "signedIn": cf_in},
        "wrangler": {"installed": wrangler.is_some(), "signedIn": wrangler_in},
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/ops-cli")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn gh_argv_is_a_fixed_get_for_one_validated_repo() {
        assert_eq!(
            gh_argv("torisKR/toris-studio", GhQuery::Runs).unwrap(),
            [
                "api",
                "--hostname",
                "github.com",
                "--method",
                "GET",
                "-H",
                "Accept: application/vnd.github+json",
                "-H",
                "X-GitHub-Api-Version: 2022-11-28",
                "repos/torisKR/toris-studio/actions/runs",
                "-f",
                "per_page=1",
                "-f",
                "exclude_pull_requests=true",
            ]
        );
        assert_eq!(
            gh_argv("o/r", GhQuery::Releases).unwrap()[9..],
            ["repos/o/r/releases", "-f", "per_page=1"]
        );
        for bad in [
            "-X/r", "o/-r", "o/../x", "o", "o/r/x", "o r/x", "o/r?x=1", "o/r;x",
        ] {
            assert!(gh_argv(bad, GhQuery::Runs).is_err(), "{bad}");
        }
    }

    #[test]
    fn cloudflare_argv_keeps_names_inside_one_flag_value() {
        assert_eq!(
            cf_argv(CfQuery::Worker, "toris-site").unwrap(),
            ["workers", "deployments", "list", "--worker=toris-site"]
        );
        assert_eq!(
            cf_argv(CfQuery::Pages, "my-site").unwrap(),
            ["pages", "get", "my-site"]
        );
        assert_eq!(
            wrangler_argv(CfQuery::Worker, "toris-site").unwrap(),
            ["deployments", "list", "--name=toris-site", "--json"]
        );
        assert_eq!(
            wrangler_argv(CfQuery::Pages, "my-site").unwrap(),
            [
                "pages",
                "deployment",
                "list",
                "--project-name=my-site",
                "--json"
            ]
        );
        for bad in ["-x", "--help", "a b", "A", "a/b", ""] {
            assert!(
                cf_argv(CfQuery::Worker, bad).is_err()
                    && cf_argv(CfQuery::Pages, bad).is_err()
                    && wrangler_argv(CfQuery::Pages, bad).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn real_gh_output_feeds_the_existing_parsers() {
        let runs: serde_json::Value =
            serde_json::from_str(&fixture("gh-actions-runs.json")).unwrap();
        assert_eq!(crate::ops_status::github_ci(&runs).state, "passing");
        let releases: serde_json::Value =
            serde_json::from_str(&fixture("gh-releases.json")).unwrap();
        assert_ne!(crate::ops_status::github_release(&releases).state, "error");
    }

    #[test]
    fn real_cf_output_is_read_without_the_api_envelope() {
        let worker = cf_worker_status(&fixture("cf-worker-deployments.json"));
        assert_eq!(worker.state, "deployed");
        let pages = cf_pages_status(&fixture("cf-pages-get.synthetic.json"));
        assert_eq!(pages.state, "deployed");
        assert_eq!(cf_worker_status("not json").state, "unknown");
        assert_eq!(cf_pages_status("{}").state, "unknown");
    }

    #[test]
    fn login_state_comes_from_exit_codes_and_whoami_flags_only() {
        assert!(cf_logged_in(0, &fixture("cf-whoami.json")));
        assert!(!cf_logged_in(0, &fixture("cf-whoami-signed-out.json")));
        assert!(!cf_logged_in(1, &fixture("cf-whoami.json")));
    }

    #[test]
    fn failures_map_to_fixed_messages_without_cli_text() {
        let gh404 = classify_failure(CliKind::Gh, Some(1), &fixture("gh-404.stderr.txt"));
        assert_eq!((gh404.state, gh404.reason), ("error", "not_found"));
        let gh_login = classify_failure(
            CliKind::Gh,
            Some(4),
            &fixture("gh-not-logged-in.stderr.txt"),
        );
        assert_eq!(gh_login.reason, "login_required");
        assert_eq!(
            classify_failure(CliKind::Gh, Some(4), "").reason,
            "login_required",
            "gh exit code 4 alone means sign-in is needed"
        );
        assert_eq!(classify_failure(CliKind::Cf, Some(4), "").reason, "failed");
        let cf404 = classify_failure(CliKind::Cf, Some(1), &fixture("cf-404.stderr.txt"));
        assert_eq!(cf404.reason, "not_found");
        let cf_login = classify_failure(
            CliKind::Cf,
            Some(1),
            &fixture("cf-not-logged-in.stderr.txt"),
        );
        assert_eq!(cf_login.reason, "login_required");
        assert_eq!(
            classify_failure(CliKind::Gh, Some(1), "HTTP 403: API rate limit exceeded").reason,
            "forbidden"
        );
        assert_eq!(classify_failure(CliKind::Gh, None, "").reason, "timeout");
        for f in [gh404, gh_login, cf404, cf_login] {
            assert!(
                !f.summary.contains("0000000000") && !f.summary.contains("HTTP /accounts"),
                "{}",
                f.summary
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_cli_runs_with_a_cleared_environment_in_an_empty_folder() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("gh");
        std::fs::write(&fake, "#!/bin/sh\nprintf '{\"cwd\":\"%s\",\"token\":\"%s\",\"prompt\":\"%s\",\"files\":\"%s\",\"ghConfig\":\"%s\",\"xdg\":\"%s\"}' \"$PWD\" \"$GH_TOKEN$GITHUB_TOKEN$CLOUDFLARE_API_TOKEN\" \"$GH_PROMPT_DISABLED\" \"$(ls -A)\" \"$GH_CONFIG_DIR\" \"$XDG_CONFIG_HOME\"\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
        for (key, value) in [
            ("GH_TOKEN", "leak-me"),
            ("GITHUB_TOKEN", "leak-2"),
            ("CLOUDFLARE_API_TOKEN", "leak-3"),
            ("GH_CONFIG_DIR", "/fixture/gh-config"),
            ("XDG_CONFIG_HOME", "/fixture/xdg"),
        ] {
            std::env::set_var(key, value);
        }
        let out = run_cli(CliKind::Gh, &fake, &["api".to_string()], None)
            .await
            .unwrap();
        for key in [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "CLOUDFLARE_API_TOKEN",
            "GH_CONFIG_DIR",
            "XDG_CONFIG_HOME",
        ] {
            std::env::remove_var(key);
        }
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["token"], "",
            "no token reaches the CLI from the app's environment"
        );
        assert_eq!(v["prompt"], "1");
        assert_eq!(
            v["ghConfig"], "/fixture/gh-config",
            "a custom gh config folder keeps the login visible"
        );
        assert_eq!(v["xdg"], "/fixture/xdg");
        assert_eq!(v["files"], "", "the working folder is empty");
        assert_ne!(
            v["cwd"],
            std::env::current_dir().unwrap().to_string_lossy().as_ref()
        );
        std::fs::write(&fake, "#!/bin/sh\nsleep 5\n").unwrap();
        let timed = run_cli_with(
            CliKind::Gh,
            &fake,
            &[],
            None,
            std::time::Duration::from_millis(200),
        )
        .await
        .unwrap_err();
        assert_eq!(timed.reason, "timeout");
    }
}
