use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;
static CLEANUP_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub async fn oauth_connections(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<crate::AppState>>,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    with_bindings(
        crate::oauth::connections().await?,
        &state.config_snapshot().await,
    )
    .await
}
#[tauri::command]
pub async fn oauth_connection_dispatch(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Arc<crate::AppState>>,
    input: Value,
) -> Result<Value, String> {
    crate::updater::authorize(&window)?;
    if input["action"] == "bindChannel" {
        let channel = uuid::Uuid::parse_str(
            input["channelId"]
                .as_str()
                .ok_or("채널 식별자를 선택하세요.")?,
        )
        .map_err(|_| "채널 식별자 오류")?;
        let id = input["connectionId"].as_str().ok_or("연결을 선택하세요.")?;
        let connection = uuid::Uuid::parse_str(id).map_err(|_| "연결 식별자 오류")?;
        let account = input["accountId"].as_str().ok_or("계정을 선택하세요.")?;
        let connections = crate::oauth::connections().await?;
        let selected = connections["connections"]
            .as_array()
            .and_then(|items| {
                items.iter().find(|c| {
                    c["connectionId"] == id
                        && c["accountId"] == account
                        && c["identityVerified"] == true
                        && c["disconnected"] == false
                })
            })
            .ok_or("검증된 계정 연결을 선택하세요.")?;
        let platform = selected["platform"].as_str().ok_or("플랫폼 오류")?;
        let mut db = crate::social::database(&state.config_snapshot().await).await?;
        let tx = db
            .client
            .transaction()
            .await
            .map_err(|_| "채널 연결 저장을 시작하지 못했습니다.")?;
        crate::analytics::remember_report_owners(&tx, &channel, platform, account).await?;
        let count=tx.execute("INSERT INTO social_channel_connections(channel_id,connection_id,platform,account_id) SELECT id,$2,platform,$4 FROM social_channels WHERE id=$1 AND platform=$3 ON CONFLICT(channel_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,platform=EXCLUDED.platform,account_id=EXCLUDED.account_id,verified_at=now()",&[&channel,&connection,&platform,&account]).await.map_err(|_|"채널 연결을 저장하지 못했습니다. OAuth DB 마이그레이션을 확인하세요.")?;
        if count != 1 {
            return Err("채널과 계정 플랫폼이 일치하지 않습니다.".into());
        }
        tx.commit()
            .await
            .map_err(|_| "채널 연결 기록을 완료하지 못했습니다.")?;
        let binding = json!({"channelId":channel,"connectionId":id,"platform":platform,"accountId":account,"identityVerified":true});
        let mut result = with_bindings(
            crate::oauth::connections().await?,
            &state.config_snapshot().await,
        )
        .await?;
        result["binding"] = binding;
        return Ok(result);
    }
    let begin = input["action"] == "beginLogin";
    let disconnect = if input["action"] == "disconnect" {
        input["connectionId"].as_str().map(str::to_owned)
    } else {
        None
    };
    let mut result = if let Some(id) = disconnect.as_deref() {
        let config = state.config_snapshot().await;
        // Missing/invalid configuration still permits local revocation, but
        // leaves an unbound, fail-closed intent for explicit recovery.
        let fingerprint = database_fingerprint(&config).ok().flatten();
        crate::oauth::disconnect_connection_from_database(id, fingerprint.as_deref()).await?
    } else {
        crate::oauth::connection_dispatch(input).await?
    };
    if let Some(id) = disconnect {
        if cleanup_connection(&state.config_snapshot().await, &id)
            .await
            .is_err()
        {
            if !result["warnings"].is_array() {
                result["warnings"] = json!([]);
            }
            result["warnings"].as_array_mut().unwrap().push(json!({"kind":"disconnect_cleanup","message":"연결은 해제되었습니다. 로컬 DB 복구 후 해당 예약과 API 캐시 정리를 계속합니다."}));
        } else {
            result = crate::oauth::connections().await?;
        }
    }
    if begin {
        use tauri_plugin_opener::OpenerExt;
        let id = result["connectionId"].clone();
        let opened = crate::oauth::finish_system_login(result, |url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "시스템 기본 브라우저를 열지 못했습니다.".into())
        });
        if opened.is_err() {
            let _ = crate::oauth::connection_dispatch(
                json!({"action":"cancelLogin","connectionId":id}),
            )
            .await;
        }
        opened
    } else {
        with_bindings(result, &state.config_snapshot().await).await
    }
}

pub(crate) async fn cleanup_connection(
    config: &crate::config::AppConfig,
    id: &str,
) -> Result<(), String> {
    uuid::Uuid::parse_str(id).map_err(|_| "연결 식별자 오류")?;
    cleanup_current(
        || async {
            Ok(crate::oauth::pending_connection_cleanups()
                .await?
                .into_iter()
                .find(|ticket| ticket["connectionId"] == id))
        },
        |ticket| async move { cleanup_ticket(config, &ticket).await },
    )
    .await
}
async fn cleanup_current<Read, ReadFuture, Execute, ExecuteFuture>(
    read: Read,
    execute: Execute,
) -> Result<(), String>
where
    Read: FnOnce() -> ReadFuture,
    ReadFuture: std::future::Future<Output = Result<Option<Value>, String>>,
    Execute: FnOnce(Value) -> ExecuteFuture,
    ExecuteFuture: std::future::Future<Output = Result<(), String>>,
{
    // Foreground and background cleanup share this lock. Read the ticket only
    // after acquiring it and hold it through the database work and vault ack.
    let _guard = CLEANUP_GATE.lock().await;
    if let Some(ticket) = read().await? {
        execute(ticket).await?;
    }
    Ok(())
}
pub(crate) fn database_fingerprint(
    config: &crate::config::AppConfig,
) -> Result<Option<String>, String> {
    let Some(raw) = config.database_url.as_deref() else {
        return Ok(None);
    };
    let url = url::Url::parse(raw).map_err(|_| "정리 대상 DB 주소 오류")?;
    if !matches!(url.scheme(), "postgres" | "postgresql")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("정리 대상 DB 형식 오류".into());
    }
    let host = url
        .host()
        .ok_or("정리 대상 DB 호스트 오류")?
        .to_string()
        .to_ascii_lowercase();
    let parsed: tokio_postgres::Config = raw.parse().map_err(|_| "정리 대상 DB 주소 오류")?;
    let database = parsed
        .get_dbname()
        .unwrap_or_else(|| parsed.get_user().unwrap_or("toris_app"));
    use sha2::Digest;
    Ok(Some(format!(
        "{:x}",
        sha2::Sha256::digest(
            json!({"host":host,"port":url.port().unwrap_or(5432),"database":database})
                .to_string()
                .as_bytes()
        )
    )))
}
pub(crate) fn cleanup_database_target(
    ticket: &Value,
    config: &crate::config::AppConfig,
) -> Result<String, String> {
    let expected = ticket["databaseFingerprint"]
        .as_str()
        .ok_or("원래 정리 대상 DB 정보가 없어 자동 정리를 완료할 수 없습니다.")?;
    let current = database_fingerprint(config)?.ok_or("정리 대상 DB가 설정되지 않았습니다.")?;
    if expected != current {
        return Err("원래 정리 대상 DB 설정을 복구한 후 다시 정리하세요.".into());
    }
    Ok(current)
}
async fn cleanup_ticket(config: &crate::config::AppConfig, ticket: &Value) -> Result<(), String> {
    let id = ticket["connectionId"]
        .as_str()
        .ok_or("연결 정리 식별자 오류")?;
    let generation = ticket["generation"].as_str().ok_or("연결 정리 요청 오류")?;
    let database = cleanup_database_target(ticket, config)?;
    run_cleanup(
        cleanup_database(config, id),
        crate::oauth::complete_connection_cleanup(id, generation, &database),
    )
    .await
}
// Ack is polled only after all database work succeeds. Tests inject a memory
// vault acknowledgement and a disposable database, never the user's vault.
pub(crate) async fn run_cleanup(
    operation: impl std::future::Future<Output = Result<(), String>>,
    acknowledge: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    operation.await?;
    acknowledge.await
}
pub(crate) async fn cleanup_database(
    config: &crate::config::AppConfig,
    id: &str,
) -> Result<(), String> {
    uuid::Uuid::parse_str(id).map_err(|_| "연결 식별자 오류")?;
    let mut session = crate::social::database(config).await?;
    let jobs_exist = session
        .client
        .query_one("SELECT to_regclass('public.publication_jobs')::text", &[])
        .await
        .map_err(|_| "게시 저장소 확인 실패")?
        .get::<_, Option<String>>(0)
        .is_some();
    if jobs_exist {
        let tx = session
            .client
            .transaction()
            .await
            .map_err(|_| "연결 정리 트랜잭션 실패")?;
        tx.batch_execute("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'")
            .await
            .map_err(|_| "연결 정리 제한 설정 실패")?;
        // Never silently skip a locked approval: timeout preserves the durable
        // cleanup ticket and keeps native use/reconnection blocked for retry.
        tx.execute("UPDATE publication_jobs SET status='needs_confirmation',retryable=false,error='계정 연결이 해제되었습니다. 다시 연결하고 승인하세요.',updated_at=now() WHERE snapshot->>'connectionId'=$1 AND mode<>'manual_handoff' AND status IN ('queued','scheduled','failed')",&[&id]).await.map_err(|_|"해제한 계정의 예약 정리 실패. 잠긴 작업은 DB 복구 후 다시 처리합니다.")?;
        let remaining=tx.query_one("SELECT count(*) FROM publication_jobs WHERE snapshot->>'connectionId'=$1 AND mode<>'manual_handoff' AND status IN ('queued','scheduled','failed')",&[&id]).await.map_err(|_|"해제한 계정의 예약 정리 검증 실패")?.get::<_,i64>(0);
        if remaining != 0 {
            return Err("해제한 계정의 예약 정리가 아직 완료되지 않았습니다.".into());
        }
        tx.commit().await.map_err(|_| "연결 정리 기록 실패")?;
    }
    let analytics_exist = session
        .client
        .query_one("SELECT to_regclass('public.analytics_sources')::text", &[])
        .await
        .map_err(|_| "분석 저장소 확인 실패")?
        .get::<_, Option<String>>(0)
        .is_some();
    drop(session);
    if analytics_exist {
        crate::analytics::dispatch(config, json!({"action":"deleteApiCache","connectionId":id}))
            .await?;
    }
    Ok(())
}

// Cleanup intent is independent of whether the active grant is disconnected.
// Reauthorization cannot replace this ticket; only verified DB success clears it.
pub(crate) async fn cleanup_disconnected(config: &crate::config::AppConfig) {
    if let Ok(tickets) = crate::oauth::pending_connection_cleanups().await {
        for ticket in tickets {
            if let Some(id) = ticket["connectionId"].as_str() {
                // Enumeration can precede a foreground acknowledgement. Pass
                // only the ID so the serialized path re-reads the current intent.
                let _ = cleanup_connection(config, id).await;
            }
        }
    }
}

async fn with_bindings(
    mut result: Value,
    config: &crate::config::AppConfig,
) -> Result<Value, String> {
    result["bindings"] = json!([]);
    let load=async {
  let db=crate::social::database(config).await?;
  let rows=db.client.query("SELECT channel_id,connection_id,platform,account_id FROM social_channel_connections ORDER BY channel_id",&[]).await.map_err(|_|"채널 계정 매핑을 읽지 못했습니다. OAuth DB 마이그레이션을 확인하세요.".to_string())?;
  Ok::<Vec<Value>,String>(rows.iter().map(|r|json!({"channelId":r.get::<_,uuid::Uuid>("channel_id"),"connectionId":r.get::<_,uuid::Uuid>("connection_id"),"platform":r.get::<_,String>("platform"),"accountId":r.get::<_,String>("account_id")})).collect())
 }.await;
    match load {
        Ok(bindings) => result["bindings"] = json!(bindings),
        Err(message) => {
            if !result["warnings"].is_array() {
                result["warnings"] = json!([]);
            }
            result["warnings"]
                .as_array_mut()
                .unwrap()
                .push(json!({"kind":"channel_bindings","message":message}));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct CleanupFixture {
        ticket: Option<Value>,
        scheduled: bool,
        api_cached: bool,
        cleanups: usize,
    }
    #[test]
    fn cleanup_target_cannot_switch_databases_or_adopt_missing_identity() {
        let cfg = |url: &str| crate::config::AppConfig {
            database_url: Some(url.into()),
            ..Default::default()
        };
        let a = cfg("postgresql://toris_app:first@127.0.0.1:55491/database_a");
        let b = cfg("postgresql://toris_app:second@127.0.0.1:55491/database_b");
        let rotated = cfg("postgresql://toris_app:changed@127.0.0.1:55491/database_a");
        let fp = database_fingerprint(&a).unwrap().unwrap();
        let ticket = json!({"databaseFingerprint":fp});
        assert!(
            cleanup_database_target(&ticket, &b).is_err(),
            "empty DB B must not acknowledge DB A cleanup"
        );
        assert_eq!(
            cleanup_database_target(&ticket, &rotated).unwrap(),
            fp,
            "credential rotation preserves DB identity"
        );
        assert!(
            cleanup_database_target(&json!({}), &a).is_err(),
            "legacy/missing targets cannot adopt current DB"
        );
        assert!(cleanup_database_target(&ticket, &crate::config::AppConfig::default()).is_err());
        assert_ne!(
            database_fingerprint(&a).unwrap(),
            database_fingerprint(&cfg("postgresql://toris_app:first@[::1]:55491/database_a"))
                .unwrap()
        );
        assert_ne!(
            database_fingerprint(&a).unwrap(),
            database_fingerprint(&cfg(
                "postgresql://toris_app:first@localhost:55491/database_a"
            ))
            .unwrap()
        );
        assert_eq!(
            database_fingerprint(&cfg("postgresql://toris_app:first@127.0.0.1/database_a"))
                .unwrap(),
            database_fingerprint(&cfg(
                "postgresql://toris_app:changed@127.0.0.1:5432/database_a"
            ))
            .unwrap()
        );
    }
    #[tokio::test]
    async fn duplicate_cleanup_rereads_after_lock_and_preserves_reconnected_data() {
        let shared = Arc::new(tokio::sync::Mutex::new(CleanupFixture {
            ticket: Some(json!({"connectionId":"fixture","generation":"old"})),
            scheduled: true,
            api_cached: true,
            cleanups: 0,
        }));
        let (a_enter_tx, a_enter_rx) = tokio::sync::oneshot::channel();
        let (a_release_tx, a_release_rx) = tokio::sync::oneshot::channel();
        let (a_ack_tx, a_ack_rx) = tokio::sync::oneshot::channel();
        let (a_return_tx, a_return_rx) = tokio::sync::oneshot::channel();
        let a_read = shared.clone();
        let a_execute = shared.clone();
        let a = tokio::spawn(async move {
            cleanup_current(
                || async move { Ok(a_read.lock().await.ticket.clone()) },
                |_ticket| async move {
                    let _ = a_enter_tx.send(());
                    a_release_rx.await.map_err(|_| "fixture release")?;
                    {
                        let mut state = a_execute.lock().await;
                        state.scheduled = false;
                        state.api_cached = false;
                        state.ticket = None;
                        state.cleanups += 1;
                    }
                    let _ = a_ack_tx.send(());
                    a_return_rx.await.map_err(|_| "fixture return")?;
                    Ok(())
                },
            )
            .await
        });
        a_enter_rx.await.unwrap();
        let (b_started_tx, b_started_rx) = tokio::sync::oneshot::channel();
        let (b_resume_tx, b_resume_rx) = tokio::sync::oneshot::channel();
        let b_read = shared.clone();
        let b_execute = shared.clone();
        let b = tokio::spawn(async move {
            let _ = b_started_tx.send(());
            cleanup_current(
                || async move { Ok(b_read.lock().await.ticket.clone()) },
                |ticket| async move {
                    b_resume_rx.await.map_err(|_| "fixture resume")?;
                    let mut state = b_execute.lock().await;
                    state.scheduled = false;
                    state.api_cached = false;
                    state.cleanups += 1;
                    if state
                        .ticket
                        .as_ref()
                        .is_none_or(|current| current["generation"] != ticket["generation"])
                    {
                        return Err("stale acknowledgement".into());
                    }
                    state.ticket = None;
                    Ok(())
                },
            )
            .await
        });
        b_started_rx.await.unwrap();
        let _ = a_release_tx.send(());
        a_ack_rx.await.unwrap();
        // A acknowledged. The user reconnected and created a fresh approval/cache
        // before queued duplicate B resumes. No old cleanup may mutate these.
        {
            let mut state = shared.lock().await;
            state.scheduled = true;
            state.api_cached = true;
        }
        let _ = a_return_tx.send(());
        let _ = b_resume_tx.send(());
        a.await.unwrap().unwrap();
        let b_result = b.await.unwrap();
        let state = shared.lock().await;
        assert!(state.scheduled, "stale cleanup held a fresh approval");
        assert!(
            state.api_cached,
            "stale cleanup erased freshly authorized cache"
        );
        assert_eq!(state.cleanups, 1);
        assert!(b_result.is_ok());
    }
}
