//! Native-only independent OAuth grants, isolated in per-connection vault records.
use super::*;
use uuid::Uuid;
const INDEX: &str = "connections:v2";
const COMMIT_INDEX: &str = "connection-commits:v2";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteIdentity {
    account_id: String,
    title: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    id: String,
    platform: String,
    client: ClientConfig,
    session: TokenSession,
    identities: Vec<RemoteIdentity>,
    verified_at: u64,
    disconnected: bool,
    audit: Vec<AuditEvent>,
    legacy_source: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct PendingCleanup {
    generation: String,
    platform: String,
    requested_at: u64,
    #[serde(default)]
    database_fingerprint: Option<String>,
}
fn cleanup_key(id: &str) -> String {
    format!("db-cleanup-pending:v2:{id}")
}
fn cleanup_pending(s: &OAuthService, id: &str) -> Result<bool, String> {
    Ok(s.store.read(&cleanup_key(id))?.is_some())
}
fn mark_cleanup_pending(s: &OAuthService, id: &str) -> Result<(), String> {
    prepare_cleanup_locked(s, id, None)
}
fn prepare_cleanup_locked(
    s: &OAuthService,
    id: &str,
    database_fingerprint: Option<&str>,
) -> Result<(), String> {
    // An existing intent must retain its original database, even if an older
    // version omitted that identity. Never adopt the current configuration.
    if cleanup_pending(s, id)? {
        return Ok(());
    }
    let c = read_connection(s, id)?;
    let pending = PendingCleanup {
        generation: random_secret(),
        platform: c.platform,
        requested_at: s.clock.now(),
        database_fingerprint: database_fingerprint.map(str::to_owned),
    };
    verified_write(
        s,
        &cleanup_key(id),
        &serde_json::to_string(&pending).map_err(|_| "연결 정리 상태 저장 실패")?,
    )
}
#[cfg(any(feature = "desktop", test))]
fn cleanup_tickets_locked(s: &OAuthService) -> Result<Vec<Value>, String> {
    let mut known = ids(s)?;
    known.extend(commit_ids(s)?);
    known.sort();
    known.dedup();
    let mut tickets = vec![];
    for id in known {
        if let Some(raw) = s.store.read(&cleanup_key(&id))? {
            let p: PendingCleanup =
                serde_json::from_str(&raw).map_err(|_| "연결 정리 복구 정보 오류")?;
            tickets.push(json!({"connectionId":id,"generation":p.generation,"platform":p.platform,"databaseFingerprint":p.database_fingerprint}));
        }
    }
    Ok(tickets)
}
#[cfg(any(feature = "desktop", test))]
fn complete_cleanup_locked(
    s: &OAuthService,
    id: &str,
    generation: &str,
    database_fingerprint: &str,
) -> Result<(), String> {
    Uuid::parse_str(id).map_err(|_| "연결 식별자 오류")?;
    let Some(raw) = s.store.read(&cleanup_key(id))? else {
        return Ok(());
    };
    let p: PendingCleanup = serde_json::from_str(&raw).map_err(|_| "연결 정리 복구 정보 오류")?;
    if p.generation != generation {
        return Err("연결 정리 요청이 변경되었습니다. 다시 정리하세요.".into());
    }
    if p.database_fingerprint.as_deref() != Some(database_fingerprint) {
        return Err("원래 정리 대상 DB에서만 연결 정리를 완료할 수 있습니다.".into());
    }
    s.store.delete(&cleanup_key(id))?;
    if s.store.read(&cleanup_key(id))?.is_some() {
        return Err("연결 정리 완료를 저장하지 못했습니다.".into());
    }
    Ok(())
}
fn connection_key(id: &str) -> String {
    format!("connection:v2:{id}")
}
fn ids(s: &OAuthService) -> Result<Vec<String>, String> {
    let result: Vec<String> = s
        .store
        .read(INDEX)?
        .map(|v| serde_json::from_str(&v))
        .transpose()
        .map_err(|_| "연결 목록을 확인하세요.")?
        .unwrap_or_default();
    if result.len() > 100 || result.iter().any(|id| Uuid::parse_str(id).is_err()) {
        return Err("연결 목록을 확인하세요.".into());
    }
    Ok(result)
}
fn read_connection(s: &OAuthService, id: &str) -> Result<Connection, String> {
    Uuid::parse_str(id).map_err(|_| "연결 식별자를 확인하세요.")?;
    let raw = s
        .store
        .read(&connection_key(id))?
        .ok_or("OAuth 연결을 찾을 수 없습니다.")?;
    if raw.len() > 65536 {
        return Err("연결 정보 크기를 확인하세요.".into());
    }
    let c: Connection = serde_json::from_str(&raw).map_err(|_| "연결 정보를 확인하세요.")?;
    if c.id != id || c.identities.is_empty() || c.verified_at == 0 {
        return Err("검증된 계정 연결이 아닙니다.".into());
    }
    Provider::parse(&c.platform)?;
    Ok(c)
}
fn verified_write(s: &OAuthService, key: &str, raw: &str) -> Result<(), String> {
    s.store.write(key, raw)?;
    if s.store.read(key)?.as_deref() != Some(raw) {
        return Err("OS 저장소 복사 검증 실패. 원본 연결은 유지됩니다.".into());
    }
    Ok(())
}
fn save_connection(s: &OAuthService, c: &Connection) -> Result<(), String> {
    let raw = serde_json::to_string(c).map_err(|_| "연결 저장 실패")?;
    if raw.len() > 65536 {
        return Err("연결 정보가 너무 큽니다.".into());
    }
    let mut index = ids(s)?;
    if !index.contains(&c.id) && index.len() >= 100 {
        return Err("연결은 최대 100개입니다.".into());
    }
    verified_write(s, &connection_key(&c.id), &raw)?;
    if !index.contains(&c.id) {
        index.push(c.id.clone());
        verified_write(
            s,
            INDEX,
            &serde_json::to_string(&index).map_err(|_| "연결 목록 저장 실패")?,
        )?;
    }
    Ok(())
}
fn commit_ids(s: &OAuthService) -> Result<Vec<String>, String> {
    let result: Vec<String> = s
        .store
        .read(COMMIT_INDEX)?
        .map(|v| serde_json::from_str(&v))
        .transpose()
        .map_err(|_| "연결 복구 목록 오류")?
        .unwrap_or_default();
    if result.len() > 100 || result.iter().any(|id| Uuid::parse_str(id).is_err()) {
        return Err("연결 복구 목록을 확인하세요.".into());
    }
    Ok(result)
}
fn commit_connection(s: &OAuthService, c: &Connection) -> Result<(), String> {
    if ids(s)?.contains(&c.id) {
        return save_connection(s, c);
    }
    let mut pending = commit_ids(s)?;
    if !pending.contains(&c.id) {
        if pending.len() >= 100 {
            return Err("보류된 연결 복구를 먼저 완료하세요.".into());
        }
        pending.push(c.id.clone());
        verified_write(
            s,
            COMMIT_INDEX,
            &serde_json::to_string(&pending).map_err(|_| "연결 복구 목록 저장 실패")?,
        )?;
    }
    // The discovery marker is durable before the verified credential record.
    // If the normal index write fails after code consumption, list can recover
    // the exact record without replaying OAuth or asking for credentials again.
    save_connection(s, c)?;
    pending.retain(|id| id != &c.id);
    verified_write(
        s,
        COMMIT_INDEX,
        &serde_json::to_string(&pending).map_err(|_| "연결 복구 목록 저장 실패")?,
    )
}
fn recover_commits(s: &OAuthService) -> Result<Vec<Value>, String> {
    let mut pending = commit_ids(s)?;
    let mut warnings = vec![];
    let mut recovered = vec![];
    for id in &pending {
        match read_connection(s, id).and_then(|c| save_connection(s, &c)) {
            Ok(()) => recovered.push(id.clone()),
            Err(message) => {
                warnings.push(json!({"connectionId":id,"recoverable":true,"message":message}))
            }
        }
    }
    if !recovered.is_empty() {
        pending.retain(|id| !recovered.contains(id));
        verified_write(
            s,
            COMMIT_INDEX,
            &serde_json::to_string(&pending).map_err(|_| "연결 복구 목록 저장 실패")?,
        )?;
    }
    Ok(warnings)
}
fn event(c: &mut Connection, now: u64, event: &str, outcome: &str) {
    c.audit.push(AuditEvent {
        at: now,
        event: event.into(),
        outcome: outcome.into(),
    });
    if c.audit.len() > 12 {
        c.audit.drain(..c.audit.len() - 12);
    }
}
fn audit_key(id: &str) -> String {
    format!("audit:v2:{id}")
}
fn connection_audit(
    s: &OAuthService,
    id: &str,
    event_name: &str,
    outcome: &str,
) -> Result<(), String> {
    let key = audit_key(id);
    let mut events: Vec<AuditEvent> = s
        .store
        .read(&key)?
        .map(|v| serde_json::from_str(&v))
        .transpose()
        .map_err(|_| "연결 감사 기록 오류")?
        .unwrap_or_default();
    events.push(AuditEvent {
        at: s.clock.now(),
        event: event_name.into(),
        outcome: outcome.into(),
    });
    if events.len() > 12 {
        events.drain(..events.len() - 12);
    }
    verified_write(
        s,
        &key,
        &serde_json::to_string(&events).map_err(|_| "감사 기록 저장 실패")?,
    )
}
fn read_scope(p: Provider) -> &'static str {
    match p{
 Provider::Youtube=>"https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
 Provider::Threads=>"threads_basic,threads_manage_insights",Provider::Instagram=>"instagram_business_basic,instagram_business_manage_insights",
 Provider::Facebook=>"pages_show_list,pages_read_engagement,read_insights",Provider::Tiktok=>"user.info.basic,user.info.stats,video.list",Provider::NaverBlog=>""}
}
fn has_read(p: Provider, scopes: &[String]) -> bool {
    p != Provider::NaverBlog
        && read_scope(p)
            .split([',', ' '])
            .filter(|s| !s.is_empty())
            .all(|r| scopes.iter().any(|s| s == r))
}
fn connection_list_locked(s: &OAuthService) -> Result<Value, String> {
    let mut result = vec![];
    let mut warnings = recover_commits(s)
        .unwrap_or_else(|message| vec![json!({"kind":"connection_recovery","message":message})]);
    let now = s.clock.now();
    for id in ids(s)? {
        match read_connection(s, &id) {
            Ok(c) => {
                let p = Provider::parse(&c.platform)?;
                let revocation_pending = pending_revocation(s, &id)?.is_some();
                let cleanup_pending = cleanup_pending(s, &id)?;
                let refreshable = c.session.refreshable(p, now)
                    || retained_candidate(s, &id, &c.session, now)?.is_some();
                let connected = !cleanup_pending
                    && !revocation_pending
                    && !c.disconnected
                    && !c.session.needs_reconnect
                    && c.session.expires_at > now;
                let mut audit = c.audit.clone();
                if let Some(raw) = s.store.read(&audit_key(&id)).unwrap_or_else(|message| {
                    warnings.push(json!({"connectionId":id,"kind":"audit","message":message}));
                    None
                }) {
                    if let Ok(external) = serde_json::from_str::<Vec<AuditEvent>>(&raw) {
                        audit.extend(external);
                        audit.sort_by_key(|e| e.at);
                        if audit.len() > 12 {
                            audit.drain(..audit.len() - 12);
                        }
                    }
                }
                for a in &c.identities {
                    result.push(json!({"connectionId":c.id,"platform":c.platform,"accountId":a.account_id,"accountTitle":a.title,"identityVerified":true,"verifiedAt":timestamp(c.verified_at),"connected":connected,"disconnected":c.disconnected||revocation_pending||cleanup_pending,"revocationPending":revocation_pending,"cleanupPending":cleanup_pending,"needsReconnect":!revocation_pending&&!c.disconnected&&(c.session.needs_reconnect||(!refreshable&&c.session.expires_at<=now)),"refreshable":!cleanup_pending&&!revocation_pending&&!c.disconnected&&refreshable,"readAuthorized":connected&&has_read(p,&c.session.scopes),"publishingAuthorized":connected&&p.publishing_authorized(&c.session.scopes),"scopes":c.session.scopes,"expiresAt":timestamp(c.session.expires_at),"audit":audit,"tokenStorage":"os_credentials","cookieStorage":"system_browser","legacyMigrated":c.legacy_source.is_some(),"tiktokAuditDeclared":c.client.tiktok_audit_declared}));
                }
            }
            Err(message) => warnings.push(json!({"connectionId":id,"message":message})),
        }
    }
    Ok(json!({"connections":result,"warnings":warnings}))
}
fn validate_binding(
    c: &Connection,
    platform: &str,
    account: &str,
    scopes: &[&str],
) -> Result<(), String> {
    if c.disconnected || c.session.needs_reconnect {
        return Err("이 계정을 다시 연결하세요.".into());
    }
    if c.platform != platform || !c.identities.iter().any(|a| a.account_id == account) {
        return Err("승인된 연결·플랫폼·계정이 일치하지 않습니다. 다시 확인하세요.".into());
    }
    if scopes
        .iter()
        .any(|r| !c.session.scopes.iter().any(|s| s == r))
    {
        return Err("이 연결에 필요한 읽기 또는 게시 권한을 별도로 승인하세요.".into());
    }
    Ok(())
}
fn unique_connection(s: &OAuthService, p: Provider) -> Result<Connection, String> {
    let found = ids(s)?
        .iter()
        .map(|id| read_connection(s, id))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|c| c.platform == p.id() && !c.disconnected)
        .collect::<Vec<_>>();
    if found.len() != 1 {
        return Err(
            "계정 연결을 명시적으로 선택하세요. 여러 연결이 있거나 검증된 연결이 없습니다.".into(),
        );
    }
    Ok(found.into_iter().next().unwrap())
}
fn identity(id: Option<&str>, title: Option<&str>) -> Result<RemoteIdentity, String> {
    let id = id
        .filter(|id| !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control))
        .ok_or("공식 계정 식별자를 확인할 수 없습니다.")?;
    Ok(RemoteIdentity {
        account_id: id.into(),
        title: title.unwrap_or(id).chars().take(200).collect(),
    })
}
async fn fetch_identities(
    s: &OAuthService,
    p: Provider,
    session: &TokenSession,
) -> Result<Vec<RemoteIdentity>, String> {
    let (endpoint, params): (&'static str, Vec<(&str, &str)>) = match p {
        Provider::Youtube => (
            "https://www.googleapis.com/youtube/v3/channels",
            vec![("part", "snippet"), ("mine", "true"), ("maxResults", "50")],
        ),
        Provider::Threads => (
            "https://graph.threads.net/v1.0/me",
            vec![("fields", "id,username")],
        ),
        Provider::Instagram => (
            "https://graph.instagram.com/v25.0/me",
            vec![("fields", "user_id,username,account_type")],
        ),
        Provider::Facebook => (
            "https://graph.facebook.com/v25.0/me/accounts",
            vec![("fields", "id,name"), ("limit", "100")],
        ),
        Provider::Tiktok => (
            "https://open.tiktokapis.com/v2/user/info/",
            vec![("fields", "open_id,display_name")],
        ),
        Provider::NaverBlog => ("https://openapi.naver.com/v1/nid/me", vec![]),
    };
    let v = s
        .transport
        .send(TokenRequest {
            endpoint,
            get: true,
            parameters: params
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
            bearer: Some(session.access_token.clone()),
        })
        .await
        .map_err(TokenFailure::message)?;
    let result = match p {
        Provider::Youtube => v["items"]
            .as_array()
            .ok_or("YouTube 채널 응답 오류")?
            .iter()
            .map(|v| identity(v["id"].as_str(), v["snippet"]["title"].as_str()))
            .collect::<Result<Vec<_>, _>>()?,
        Provider::Facebook => {
            if v["paging"]["next"].is_string() {
                return Err(
                    "Facebook Page가 조회 한도를 초과했습니다. 연결 범위를 줄이세요.".into(),
                );
            }
            v["data"]
                .as_array()
                .ok_or("Facebook Page 응답 오류")?
                .iter()
                .map(|v| identity(v["id"].as_str(), v["name"].as_str()))
                .collect::<Result<Vec<_>, _>>()?
        }
        Provider::Threads => vec![identity(v["id"].as_str(), v["username"].as_str())?],
        Provider::Instagram => vec![identity(
            v["user_id"].as_str().or(v["id"].as_str()),
            v["username"].as_str(),
        )?],
        Provider::Tiktok => vec![identity(
            v["data"]["user"]["open_id"].as_str(),
            v["data"]["user"]["display_name"].as_str(),
        )?],
        Provider::NaverBlog => vec![identity(
            v["response"]["id"].as_str(),
            v["response"]["nickname"].as_str(),
        )?],
    };
    let mut unique = std::collections::HashSet::new();
    if result.is_empty()
        || result.len() > 100
        || result.iter().any(|a| !unique.insert(a.account_id.clone()))
    {
        return Err("계정 응답이 비어 있거나 모호합니다.".into());
    }
    Ok(result)
}
fn same_identities(a: &[RemoteIdentity], b: &[RemoteIdentity]) -> bool {
    a.iter()
        .map(|a| &a.account_id)
        .collect::<std::collections::HashSet<_>>()
        == b.iter()
            .map(|a| &a.account_id)
            .collect::<std::collections::HashSet<_>>()
}
fn retained_candidate(
    s: &OAuthService,
    id: &str,
    current: &TokenSession,
    now: u64,
) -> Result<Option<TokenSession>, String> {
    s.store
        .read(&format!("refresh-candidate:v2:{id}"))?
        .map(|raw| serde_json::from_str::<TokenSession>(&raw))
        .transpose()
        .map_err(|_| "토큰 갱신 복구 정보 오류".to_string())
        .map(|candidate| {
            candidate.filter(|c| {
                c.issued_at >= current.issued_at
                    && c.access_token != current.access_token
                    && c.expires_at > now
            })
        })
}
async fn refresh_connection_locked(
    s: &OAuthService,
    id: &str,
    automatic: bool,
) -> Result<(), String> {
    let mut c = read_connection(s, id)?;
    let p = Provider::parse(&c.platform)?;
    let now = s.clock.now();
    let candidate_key = format!("refresh-candidate:v2:{id}");
    let candidate = retained_candidate(s, id, &c.session, now)?;
    if c.disconnected
        || cleanup_pending(s, id)?
        || pending_revocation(s, id)?.is_some()
        || (candidate.is_none() && !c.session.refreshable(p, now))
    {
        return if automatic {
            Ok(())
        } else {
            Err("갱신할 수 없는 연결입니다. 다시 로그인하세요.".into())
        };
    }
    if candidate.is_none() && p.meta() && now < c.session.issued_at.saturating_add(DAY) {
        return if automatic {
            Ok(())
        } else {
            Err("장기 토큰은 발급 24시간 뒤 갱신할 수 있습니다.".into())
        };
    }
    if automatic
        && candidate.is_none()
        && (c.session.retry_at > now
            || c.session.expires_at > now.saturating_add(if p.meta() { 7 * DAY } else { 300 }))
    {
        return Ok(());
    }
    let refreshed = if let Some(candidate) = candidate {
        Ok(candidate)
    } else {
        s.transport
            .send(refresh_request(p, &c.client, &c.session))
            .await
            .and_then(|v| {
                session_from_response(&v, Some(&c.session), now, p.meta())
                    .map_err(|_| TokenFailure::transient("invalid_response"))
            })
    };
    match refreshed {
        Ok(session) => {
            // A rotated refresh token may invalidate the previous one. Retain a verified
            // native recovery copy before identity I/O, without issuing it to a consumer.
            verified_write(
                s,
                &candidate_key,
                &serde_json::to_string(&session).map_err(|_| "토큰 갱신 복구 저장 실패")?,
            )?;
            let actual = match fetch_identities(s, p, &session).await {
                Ok(actual) => actual,
                Err(message) => {
                    event(
                        &mut c,
                        now,
                        "refresh_pending",
                        "identity_verification_unavailable",
                    );
                    save_connection(s, &c)?;
                    return Err(message);
                }
            };
            if !same_identities(&c.identities, &actual) {
                c.session.needs_reconnect = true;
                event(&mut c, now, "refresh_failed", "identity_changed");
                save_connection(s, &c)?;
                return Err("원격 계정이 변경되었습니다. 게시 승인을 다시 확인하세요.".into());
            }
            c.session = session;
            c.identities = actual;
            c.verified_at = now;
            event(&mut c, now, "session_refreshed", "success");
            save_connection(s, &c)?;
            let _ = s.store.delete(&candidate_key);
            Ok(())
        }
        Err(f) => {
            c.session.failures = c.session.failures.saturating_add(1);
            c.session.retry_at = now.saturating_add(match c.session.failures {
                1 => 60,
                2 => 300,
                _ => 900,
            });
            c.session.needs_reconnect |= f.permanent;
            event(&mut c, now, "refresh_failed", f.outcome);
            save_connection(s, &c)?;
            if automatic {
                Ok(())
            } else {
                Err(f.message())
            }
        }
    }
}
async fn access_locked(
    s: &OAuthService,
    id: &str,
    platform: &str,
    account: &str,
    scopes: &[&str],
    publish: bool,
) -> Result<PublishingAccess, String> {
    if cleanup_pending(s, id)? {
        return Err(
            "이 연결의 이전 예약과 API 캐시 정리가 완료될 때까지 사용할 수 없습니다.".into(),
        );
    }
    if pending_revocation(s, id)?.is_some() {
        return Err("해제한 계정의 Google 인증 취소를 기다리고 있습니다.".into());
    }
    let mut c = read_connection(s, id)?;
    validate_binding(&c, platform, account, scopes)?;
    if c.session.expires_at <= s.clock.now() + 60 {
        refresh_connection_locked(s, id, false).await?;
        c = read_connection(s, id)?;
        validate_binding(&c, platform, account, scopes)?;
    }
    let p = Provider::parse(platform)?;
    if c.session.expires_at <= s.clock.now()
        || (publish && !p.publishing_authorized(&c.session.scopes))
    {
        return Err("이 연결의 게시 권한 또는 만료 상태를 확인하세요.".into());
    }
    let token = if p == Provider::Facebook && !publish {
        let response = s
            .transport
            .send(TokenRequest {
                endpoint: "https://graph.facebook.com/v25.0/me/accounts",
                get: true,
                parameters: vec![
                    ("fields".into(), "id,access_token,tasks".into()),
                    ("limit".into(), "100".into()),
                ],
                bearer: Some(c.session.access_token.clone()),
            })
            .await
            .map_err(TokenFailure::message)?;
        let pages = response["data"]
            .as_array()
            .ok_or("Facebook Page 토큰 응답을 확인하세요.")?;
        let pages = pages
            .iter()
            .filter(|page| page["id"] == account)
            .collect::<Vec<_>>();
        if pages.len() != 1 {
            return Err("이 연결의 정확한 Page 토큰을 확인할 수 없습니다.".into());
        }
        let page = pages[0];
        if !page["tasks"].as_array().is_some_and(|tasks| {
            tasks
                .iter()
                .any(|task| matches!(task.as_str(), Some("ANALYZE" | "MANAGE")))
        }) {
            return Err("선택한 Page의 분석 권한이 없습니다.".into());
        }
        page["access_token"]
            .as_str()
            .filter(|token| {
                !token.is_empty()
                    && token.len() <= MAX_TOKEN
                    && !token.chars().any(char::is_control)
            })
            .ok_or("Facebook Page 토큰을 확인할 수 없습니다.")?
            .to_owned()
    } else {
        c.session.access_token
    };
    Ok(PublishingAccess {
        token,
        scopes: c.session.scopes,
        tiktok_audit_declared: p == Provider::Tiktok && c.client.tiktok_audit_declared,
    })
}
#[derive(Serialize, Deserialize)]
struct PendingRevocation {
    token: String,
    retry_at: u64,
    failures: u8,
}
fn revocation_key(id: &str) -> String {
    format!("revocation-pending:v2:{id}")
}
fn pending_revocation(s: &OAuthService, id: &str) -> Result<Option<PendingRevocation>, String> {
    s.store
        .read(&revocation_key(id))?
        .map(|raw| serde_json::from_str(&raw).map_err(|_| "인증 취소 복구 정보 오류".into()))
        .transpose()
}
async fn retry_revocation(s: &OAuthService, id: &str, force: bool) -> Result<(), String> {
    let Some(mut pending) = pending_revocation(s, id)? else {
        return Ok(());
    };
    let c = read_connection(s, id)?;
    if c.platform != "youtube" {
        return Err("인증 취소 플랫폼 정보 오류".into());
    }
    if !force && pending.retry_at > s.clock.now() {
        return Ok(());
    }
    let result = s
        .transport
        .send(TokenRequest {
            endpoint: GOOGLE_REVOKE_ENDPOINT,
            get: false,
            parameters: vec![("token".into(), pending.token.clone())],
            bearer: None,
        })
        .await;
    match result {
        Ok(_) => {
            // A previous process may have crashed with the durable deny marker
            // committed but the active record not yet cleared. Never remove the
            // marker until its disconnected tombstone has also been verified.
            disconnect_locked(s, id)?;
            s.store.delete(&revocation_key(id))?;
            connection_audit(s, id, "remote_revocation", "confirmed")?;
            Ok(())
        }
        Err(f) => {
            pending.failures = pending.failures.saturating_add(1);
            pending.retry_at = s.clock.now().saturating_add(match pending.failures {
                1 => 60,
                2 => 300,
                _ => 900,
            });
            verified_write(
                s,
                &revocation_key(id),
                &serde_json::to_string(&pending).map_err(|_| "인증 취소 복구 정보 저장 실패")?,
            )?;
            connection_audit(s, id, "remote_revocation", f.outcome)?;
            Err("이 연결은 로컬에서 해제되었습니다. Google 인증 취소는 연결이 복구되면 다시 시도합니다.".into())
        }
    }
}
fn disconnect_locked(s: &OAuthService, id: &str) -> Result<(), String> {
    let mut c = read_connection(s, id)?;
    if let Some(p) = s
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(id)
    {
        let _ = p.cancel.send(true);
    }
    c.session.access_token.clear();
    c.session.refresh_token = None;
    c.session.needs_reconnect = true;
    c.disconnected = true;
    event(&mut c, s.clock.now(), "session_disconnected", "local_only");
    save_connection(s, &c)?;
    s.store.delete(&format!("refresh-candidate:v2:{id}"))?;
    Ok(())
}
async fn disconnect_connection(s: &OAuthService, id: &str) -> Result<(), String> {
    mark_cleanup_pending(s, id)?;
    let c = read_connection(s, id)?;
    if c.platform != "youtube" {
        return disconnect_locked(s, id);
    }
    if pending_revocation(s, id)?.is_none() {
        let candidate = s
            .store
            .read(&format!("refresh-candidate:v2:{id}"))?
            .map(|raw| serde_json::from_str::<TokenSession>(&raw))
            .transpose()
            .map_err(|_| "토큰 갱신 복구 정보 오류")?;
        let session = candidate.as_ref().unwrap_or(&c.session);
        let token = session
            .refresh_token
            .as_deref()
            .unwrap_or(&session.access_token);
        if token.is_empty() {
            return disconnect_locked(s, id);
        }
        let pending = PendingRevocation {
            token: token.into(),
            retry_at: 0,
            failures: 0,
        };
        // This durable marker blocks every native access before remote I/O and
        // survives a crash or a vault failure while clearing the active record.
        verified_write(
            s,
            &revocation_key(id),
            &serde_json::to_string(&pending).map_err(|_| "인증 취소 복구 정보 저장 실패")?,
        )?;
    }
    let _ = retry_revocation(s, id, true).await;
    disconnect_locked(s, id)
}
async fn begin_connection(
    s: &Arc<OAuthService>,
    p: Provider,
    purpose: &str,
    existing: Option<&str>,
) -> Result<Value, String> {
    let _g = s.gate.lock().await;
    s.cleanup_pending();
    if s.pending.lock().unwrap_or_else(|p| p.into_inner()).len() >= 20 {
        return Err("진행 중인 인증 요청을 먼저 완료하세요.".into());
    }
    if existing.is_none() && ids(s)?.len() >= 100 {
        return Err("연결은 최대 100개입니다.".into());
    }
    if !["read", "publish"].contains(&purpose) {
        return Err("읽기 또는 게시 연결 목적을 선택하세요.".into());
    }
    if let Some(id) = existing {
        if cleanup_pending(s, id)? {
            return Err("이전 연결의 예약과 API 캐시 정리가 완료된 뒤 다시 연결하세요.".into());
        }
        if pending_revocation(s, id)?.is_some() {
            return Err("기존 Google 인증 취소가 완료된 뒤 다시 연결하세요.".into());
        }
    }
    let id = existing
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let config = if existing.is_some() {
        let c = read_connection(s, &id)?;
        if c.platform != p.id() {
            return Err("연결 플랫폼 불일치".into());
        }
        c.client
    } else {
        s.read::<ClientConfig>("client", p)?
            .ok_or_else(|| p.help().to_string())?
    };
    validate_client(p, &config)?;
    if purpose == "publish" && p.publishing_scope().is_none() {
        return Err("이 플랫폼은 수동 게시만 지원합니다.".into());
    }
    if s.pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains_key(&id)
    {
        return Err("이 연결의 인증을 먼저 완료하세요.".into());
    }
    let loopback = Url::parse(&config.redirect_uri)
        .map_err(|_| "콜백 주소 오류")?
        .scheme()
        == "http";
    let listener = if loopback {
        if s.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .any(|p| p.client.redirect_uri.starts_with("http:"))
        {
            return Err("로컬 콜백 로그인을 먼저 완료하세요.".into());
        }
        s.stop_previous_loopback_listener().await;
        Some(
            TcpListener::bind(("127.0.0.1", CALLBACK_PORT))
                .await
                .map_err(|_| "로컬 OAuth 포트가 사용 중입니다.")?,
        )
    } else {
        None
    };
    let state = random_secret();
    let verifier = matches!(p, Provider::Youtube | Provider::Tiktok).then(random_secret);
    let mut url = Url::parse(&authorization_url_for_mode(
        p,
        &config,
        &state,
        verifier.as_deref(),
        purpose == "publish",
    )?)
    .map_err(|_| "인증 주소 오류")?;
    let mut scopes = if purpose == "read" {
        read_scope(p)
    } else {
        p.publishing_scope().unwrap_or_default()
    }
    .split([',', ' '])
    .filter(|s| !s.is_empty())
    .map(str::to_owned)
    .collect::<Vec<_>>();
    if existing.is_some() {
        scopes.extend(read_connection(s, &id)?.session.scopes);
    }
    scopes.sort();
    scopes.dedup();
    let params = url
        .query_pairs()
        .filter(|(key, _)| key != "scope")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    url.query_pairs_mut().extend_pairs(params);
    if !scopes.is_empty() {
        url.query_pairs_mut().append_pair(
            "scope",
            &scopes.join(if p == Provider::Youtube { " " } else { "," }),
        );
    }
    connection_audit(s, &id, "login_started", "pending")?;
    let (cancel, receiver) = watch::channel(false);
    s.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(
        id.clone(),
        PendingLogin {
            state,
            verifier,
            client: config.clone(),
            expires_at: s.clock.now() + LOGIN_TTL,
            cancel,
            publishing: purpose == "publish",
            provider_id: Some(p.id().into()),
        },
    );
    if let Some(listener) = listener {
        let cloned = s.clone();
        let connection = id.clone();
        let task = tokio::spawn(async move {
            listen_connection(cloned, p, connection, listener, receiver).await;
        });
        *s.loopback_listener
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(task);
    }
    Ok(
        json!({"connectionId":id,"platform":p.id(),"purpose":purpose,"authorizationUrl":url.to_string(),"redirectUri":config.redirect_uri,"pending":true,"manualCallback":!loopback}),
    )
}
async fn complete_connection(
    s: &Arc<OAuthService>,
    id: &str,
    callback: &str,
) -> Result<Value, String> {
    let _g = s.gate.lock().await;
    Uuid::parse_str(id).map_err(|_| "연결 식별자 오류")?;
    if cleanup_pending(s, id)? {
        return Err("이전 연결의 예약과 API 캐시 정리를 먼저 완료하세요.".into());
    }
    let (p, validated) = {
        let pending = s.pending.lock().unwrap_or_else(|p| p.into_inner());
        let pending = pending.get(id).ok_or("진행 중인 연결 로그인이 없습니다.")?;
        if pending.expires_at <= s.clock.now() {
            return Err("로그인 요청이 만료되었습니다.".into());
        }
        let p = Provider::parse(pending.provider_id.as_deref().ok_or("플랫폼 정보 오류")?)?;
        let validated =
            match validate_callback(p, &pending.client.redirect_uri, &pending.state, callback) {
                Ok(value) => value,
                Err(message) => {
                    connection_audit(s, id, "callback_rejected", "validation_failed")?;
                    return Err(message);
                }
            };
        (p, validated)
    };
    let pending = s
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(id)
        .ok_or("이미 사용된 요청입니다.")?;
    let _ = pending.cancel.send(true);
    if validated.denied {
        connection_audit(s, id, "login_failed", "user_denied")?;
        return Err("SNS 로그인이 취소되었습니다.".into());
    }
    let mut response = s
        .transport
        .send(authorization_code_request(
            p,
            &pending.client,
            &pending,
            validated.code.as_deref().unwrap_or(""),
        ))
        .await
        .map_err(TokenFailure::message)?;
    if p == Provider::Instagram && response.get("access_token").is_none() {
        let data = response["data"]
            .as_array()
            .filter(|v| v.len() == 1)
            .ok_or("Instagram 응답이 모호합니다.")?;
        response = data[0].clone();
    }
    if p.meta() && response.get("expires_in").is_none() {
        response
            .as_object_mut()
            .ok_or("인증 응답 오류")?
            .insert("expires_in".into(), json!(3600));
    }
    let mut session = session_from_response(&response, None, s.clock.now(), false)
        .map_err(|_| "SNS 인증 응답 오류")?;
    if p.meta() {
        let response = s
            .transport
            .send(long_lived_request(p, &pending.client, &session))
            .await
            .map_err(TokenFailure::message)?;
        session = session_from_response(&response, Some(&session), s.clock.now(), true)
            .map_err(|_| "장기 인증 응답 오류")?;
    }
    if let Some(endpoint) = p.permissions_endpoint() {
        let response = s
            .transport
            .send(TokenRequest {
                endpoint,
                get: true,
                parameters: vec![],
                bearer: Some(session.access_token.clone()),
            })
            .await
            .map_err(TokenFailure::message)?;
        session.scopes = granted_permissions(&response)?;
    }
    let identities = fetch_identities(s, p, &session).await?;
    let old = s
        .store
        .read(&connection_key(id))?
        .map(|_| read_connection(s, id))
        .transpose()?;
    if old
        .as_ref()
        .is_some_and(|c| c.platform != p.id() || !same_identities(&c.identities, &identities))
    {
        return Err(
            "다른 계정으로 인증했습니다. 기존 연결은 유지됩니다. 새 계정 추가로 연결하세요.".into(),
        );
    }
    let c = Connection {
        id: id.into(),
        platform: p.id().into(),
        client: pending.client,
        session,
        identities,
        verified_at: s.clock.now(),
        disconnected: false,
        audit: old.as_ref().map(|c| c.audit.clone()).unwrap_or_default(),
        legacy_source: old.and_then(|c| c.legacy_source),
    };
    commit_connection(s, &c)?;
    connection_audit(
        s,
        id,
        if pending.publishing {
            "publish_login_completed"
        } else {
            "read_login_completed"
        },
        "identity_verified",
    )?;
    connection_list_locked(s)
}
async fn listen_connection(
    s: Arc<OAuthService>,
    p: Provider,
    id: String,
    listener: TcpListener,
    mut cancel: watch::Receiver<bool>,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(LOGIN_TTL);
    loop {
        let accepted = tokio::select! {v=listener.accept()=>v.ok(),_=tokio::time::sleep_until(deadline)=>None,_=cancel.changed()=>None};
        let Some((mut stream, peer)) = accepted else {
            s.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            return;
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let success = match tokio::time::timeout(
            Duration::from_secs(5),
            read_callback_request(&mut stream, p),
        )
        .await
        {
            Ok(Ok(url)) => complete_connection(&s, &id, &url).await.is_ok(),
            _ => false,
        };
        respond(&mut stream, success).await;
        if !s
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(&id)
        {
            return;
        }
    }
}
async fn migrate_legacy(s: &OAuthService, p: Provider) -> Result<String, String> {
    let marker = format!("legacy-copy:v2:{}", p.id());
    let id = match s.store.read(&marker)? {
        Some(id) => {
            Uuid::parse_str(&id).map_err(|_| "이전 연결 복구 정보 오류")?;
            id
        }
        None => {
            let id = Uuid::new_v4().to_string();
            verified_write(s, &marker, &id)?;
            id
        }
    };
    if let Ok(c) = read_connection(s, &id) {
        if c.legacy_source.as_deref() == Some(p.id()) {
            save_connection(s, &c)?;
            return Ok(id);
        }
    }
    if s.store
        .read(&format!("legacy-client-changed:{}", p.id()))?
        .is_some()
    {
        return Err("이전 앱 설정이 변경되었습니다. 원본은 유지되며 새 연결이 필요합니다.".into());
    }
    let client = s
        .read::<ClientConfig>("client", p)?
        .ok_or("이전 앱 설정이 없습니다.")?;
    let session = s
        .read::<TokenSession>("session", p)?
        .ok_or("복사할 이전 연결이 없습니다.")?;
    if session.needs_reconnect || session.expires_at <= s.clock.now() {
        return Err(
            "이전 연결을 확인할 수 없습니다. 원본을 보존하고 새 계정으로 연결하세요.".into(),
        );
    }
    let identities = fetch_identities(s, p, &session).await?;
    let mut c = Connection {
        id: id.clone(),
        platform: p.id().into(),
        client,
        session,
        identities,
        verified_at: s.clock.now(),
        disconnected: false,
        audit: vec![],
        legacy_source: Some(p.id().into()),
    };
    event(
        &mut c,
        s.clock.now(),
        "legacy_migrated",
        "copy_verified_original_preserved",
    );
    save_connection(s, &c)?;
    Ok(id)
}
#[cfg(feature = "desktop")]
pub(super) async fn pending_cleanups() -> Result<Vec<Value>, String> {
    let s = service();
    let _g = s.gate.lock().await;
    cleanup_tickets_locked(s)
}
#[cfg(feature = "desktop")]
pub(super) async fn complete_cleanup(
    id: &str,
    generation: &str,
    database_fingerprint: &str,
) -> Result<(), String> {
    let s = service();
    let _g = s.gate.lock().await;
    complete_cleanup_locked(s, id, generation, database_fingerprint)
}
pub(super) async fn disconnect_for_database(
    id: &str,
    database_fingerprint: Option<&str>,
) -> Result<Value, String> {
    let s = service();
    let _g = s.gate.lock().await;
    // Pin the native configuration and disconnect under one OAuth lock. A
    // cleanup retry cannot acknowledge a preparatory marker in between.
    prepare_cleanup_locked(s, id, database_fingerprint)?;
    disconnect_connection(s, id).await?;
    let mut result = connection_list_locked(s)?;
    if pending_revocation(s, id)?.is_some() {
        result["warnings"].as_array_mut().unwrap().push(json!({"connectionId":id,"kind":"revocation_pending","message":"로컬 연결은 해제되었습니다. Google 인증 취소는 연결이 복구되면 다시 시도합니다."}));
    }
    Ok(result)
}
pub(super) async fn list() -> Result<Value, String> {
    let s = service();
    let _g = s.gate.lock().await;
    connection_list_locked(s)
}
pub(super) async fn scoped(
    id: &str,
    p: &str,
    a: &str,
    scopes: &[&str],
    publish: bool,
) -> Result<PublishingAccess, String> {
    let s = service();
    let _g = s.gate.lock().await;
    access_locked(s, id, p, a, scopes, publish).await
}
pub(super) async fn unique_access(p: &str) -> Result<PublishingAccess, String> {
    let s = service();
    let _g = s.gate.lock().await;
    let c = unique_connection(s, Provider::parse(p)?)?;
    if c.identities.len() != 1 {
        return Err("원격 계정을 명시적으로 선택하세요.".into());
    }
    access_locked(s, &c.id, p, &c.identities[0].account_id, &[], true).await
}
pub(super) async fn unique_id(p: &str) -> Result<String, String> {
    let s = service();
    let _g = s.gate.lock().await;
    Ok(unique_connection(s, Provider::parse(p)?)?.id)
}
pub(super) async fn refresh_all() -> Result<(), String> {
    let s = service();
    let index = {
        let _g = s.gate.lock().await;
        ids(s)?
    };
    let mut failed = false;
    for id in index {
        let _g = s.gate.lock().await;
        failed |= if pending_revocation(s, &id)?.is_some() {
            retry_revocation(s, &id, false).await.is_err()
        } else {
            refresh_connection_locked(s, &id, true).await.is_err()
        };
    }
    if failed {
        Err("일부 연결 갱신 실패".into())
    } else {
        Ok(())
    }
}
pub(super) async fn dispatch(input: Value) -> Result<Value, String> {
    let action = input["action"].as_str().ok_or("OAuth 동작을 선택하세요.")?;
    let id = || {
        input["connectionId"]
            .as_str()
            .ok_or_else(|| "연결 식별자를 입력하세요.".to_string())
    };
    let provider = || Provider::parse(input["platform"].as_str().ok_or("플랫폼을 선택하세요.")?);
    match action {
        "list" => list().await,
        "beginLogin" => {
            begin_connection(
                service(),
                provider()?,
                input["purpose"].as_str().unwrap_or("read"),
                input["connectionId"].as_str(),
            )
            .await
        }
        "completeLogin" => {
            complete_connection(
                service(),
                id()?,
                input["callbackUrl"]
                    .as_str()
                    .ok_or("콜백 주소를 입력하세요.")?,
            )
            .await
        }
        "cancelLogin" => {
            let s = service();
            let _g = s.gate.lock().await;
            let id = id()?;
            Uuid::parse_str(id).map_err(|_| "연결 식별자 오류")?;
            if let Some(p) = s
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(id)
            {
                let _ = p.cancel.send(true);
            }
            connection_audit(s, id, "login_cancelled", "local_only")?;
            let mut result = connection_list_locked(s)?;
            result["cancelled"] = json!(true);
            Ok(result)
        }
        "refresh" => {
            let s = service();
            let _g = s.gate.lock().await;
            refresh_connection_locked(s, id()?, false).await?;
            connection_list_locked(s)
        }
        "disconnect" => disconnect_for_database(id()?, None).await,
        "migrateLegacy" => {
            let s = service();
            let _g = s.gate.lock().await;
            let id = migrate_legacy(s, provider()?).await?;
            let mut result = connection_list_locked(s)?;
            result["migratedConnectionId"] = json!(id);
            Ok(result)
        }
        _ => Err("지원하지 않는 OAuth 동작입니다.".into()),
    }
}
#[cfg(test)]
#[path = "oauth_connections_tests.rs"]
mod tests;
