//! "Toris 연결": Toris's public OAuth apps, with the code exchange and secret-needing refreshes done by
//! the Toris OAuth Broker (infrastructure/oauth-broker). The app never holds a client secret; tokens come
//! back in the response and stay in Rust and the OS credential store. Google (YouTube, Calendar) uses it too:
//! Google's desktop clients need their secret for the exchange and every hourly refresh.
use super::*;

/// The broker every Toris connection uses unless the user stored another (validated) origin.
pub(crate) const TORIS_BROKER: &str = "https://oauth.toris.kr";
const CONFIG_TTL: u64 = 600;
const CONFIG_FAILURE_TTL: u64 = 60;

/// One broker call. The body can hold a code, verifier or token: never Debug, never logged.
#[derive(Clone)]
pub(crate) struct BrokerRequest {
    pub base: String,
    pub path: String,
    pub body: Option<Value>,
}

/// The broker refuses requests without it (HTTP 426).
pub(crate) fn broker_user_agent() -> String {
    format!("TorisStudio/{}", env!("CARGO_PKG_VERSION"))
}

/// An origin only: https (loopback http in debug builds), no credentials, path, query or fragment.
pub(crate) fn validate_broker_url(raw: &str) -> Result<String, String> {
    let error = || "Toris 연결 서버 주소는 https 주소만 쓸 수 있습니다.".to_string();
    let url = Url::parse(raw.trim()).map_err(|_| error())?;
    let loopback_dev = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if !(url.scheme() == "https" || loopback_dev)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
        || url.host_str().is_none()
    {
        return Err(error());
    }
    Ok(url.origin().ascii_serialization())
}

/// The broker new logins use. There is no IPC or keychain override; each connection still refreshes at
/// the broker origin recorded when it was issued.
pub(crate) fn broker_base(s: &OAuthService) -> Result<String, String> {
    Ok(s.broker_url.clone())
}

pub(crate) fn toris_platform(p: Provider) -> bool {
    matches!(
        p,
        Provider::Tiktok
            | Provider::Threads
            | Provider::Instagram
            | Provider::Facebook
            | Provider::NaverBlog
            | Provider::Youtube
            | Provider::GoogleCalendar
    )
}

/// Fixed redirect per platform, identical to the broker's: loopback for TikTok, Naver and Google, HTTPS for Meta.
pub(crate) fn toris_redirect(p: Provider) -> &'static str {
    match p {
        Provider::Tiktok => "http://127.0.0.1:38471/oauth/tiktok/callback",
        Provider::NaverBlog => "http://127.0.0.1:38471/oauth/naver_blog/callback",
        Provider::Threads => "https://toris.kr/oauth/threads/callback",
        Provider::Instagram => "https://toris.kr/oauth/instagram/callback",
        Provider::Facebook => "https://toris.kr/oauth/facebook/callback",
        Provider::Youtube => "http://127.0.0.1:38471/oauth/youtube/callback",
        Provider::GoogleCalendar => "http://127.0.0.1:38471/oauth/google_calendar/callback",
    }
}

/// Threads and Instagram refresh without a secret, directly with the provider.
fn refresh_needs_broker(p: Provider) -> bool {
    matches!(
        p,
        Provider::Tiktok
            | Provider::NaverBlog
            | Provider::Facebook
            | Provider::Youtube
            | Provider::GoogleCalendar
    )
}

/// Broker error codes: a rejected or mismatched login needs a new login; capacity problems are retried, and so
/// is a platform switched off at the broker, so its connections survive until it is switched back on.
pub(crate) fn broker_failure(body: &Value) -> TokenFailure {
    let transient = |outcome| TokenFailure::transient(outcome);
    match body["error"]["code"].as_str() {
        Some("rate_limited") => transient("rate_limited"),
        Some("quota_exhausted") => transient("quota_exhausted"),
        Some("provider_unavailable") => transient("provider_unavailable"),
        Some("internal") => transient("broker_internal"),
        Some("unsupported_platform") => transient("platform_unavailable"),
        Some("upgrade_required") => TokenFailure {
            permanent: true,
            outcome: "upgrade_required",
        },
        Some(_) => TokenFailure::invalid(),
        None => transient("invalid_response"),
    }
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn printable(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.chars().all(|c| c.is_ascii_graphic())
}

/// Starts a Toris login: the broker signs a state bound to SHA-256(verifier) and names its public client.
pub(crate) async fn broker_start(
    s: &OAuthService,
    p: Provider,
    purpose: &str,
    verifier: &str,
    stored: &ClientConfig,
) -> Result<(ClientConfig, String), String> {
    let base = broker_base(s)?;
    let response = s
        .transport
        .broker(BrokerRequest {
            base: base.clone(),
            path: format!("/v1/oauth/{}/start", p.id()),
            body: Some(json!({"purpose": purpose, "challenge": challenge(verifier)})),
        })
        .await
        .map_err(TokenFailure::message)?;
    let invalid = || "Toris 연결 서버 응답을 확인할 수 없습니다.".to_string();
    let state = response["state"]
        .as_str()
        .filter(|v| {
            v.len() <= 1024
                && !v.is_empty()
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
        .ok_or_else(invalid)?;
    let client_id = response["clientId"]
        .as_str()
        .filter(|v| printable(v, 256))
        .ok_or_else(invalid)?;
    if response["redirectUri"].as_str() != Some(toris_redirect(p)) {
        return Err(invalid());
    }
    Ok((
        ClientConfig {
            client_id: client_id.into(),
            client_secret: None,
            redirect_uri: toris_redirect(p).into(),
            tiktok_audit_declared: stored.tiktok_audit_declared,
            mode: ClientMode::Toris,
            broker: Some(base),
        },
        state.into(),
    ))
}

/// Exchanges the code at the broker that started the login. Meta comes back already long-lived.
pub(crate) async fn broker_token(
    s: &OAuthService,
    p: Provider,
    pending: &PendingLogin,
    code: &str,
) -> Result<Value, TokenFailure> {
    let base = pending
        .client
        .broker
        .clone()
        .ok_or_else(TokenFailure::invalid)?;
    let verifier = pending.verifier.clone().ok_or_else(TokenFailure::invalid)?;
    s.transport
        .broker(BrokerRequest {
            base,
            path: format!("/v1/oauth/{}/token", p.id()),
            body: Some(json!({
                "state": pending.state,
                "code": code,
                "verifier": verifier,
                "redirectUri": pending.client.redirect_uri,
            })),
        })
        .await
}

/// Refresh for any connection: the broker (where the grant came from) only when a secret is needed.
pub(crate) async fn refresh_call(
    s: &OAuthService,
    p: Provider,
    client: &ClientConfig,
    session: &TokenSession,
) -> Result<Value, TokenFailure> {
    if client.mode != ClientMode::Toris || !refresh_needs_broker(p) {
        return s.transport.send(refresh_request(p, client, session)).await;
    }
    let base = client
        .broker
        .as_deref()
        .map(validate_broker_url)
        .unwrap_or_else(|| Ok(TORIS_BROKER.into()))
        .map_err(|_| TokenFailure::invalid())?;
    let body = if p == Provider::Facebook {
        json!({"accessToken": session.access_token})
    } else {
        json!({"refreshToken": session.refresh_token.clone().ok_or_else(TokenFailure::invalid)?})
    };
    s.transport
        .broker(BrokerRequest {
            base,
            path: format!("/v1/oauth/{}/refresh", p.id()),
            body: Some(body),
        })
        .await
}

/// Which platforms the broker serves now. Cached; an unreachable broker means "내 개발자 앱" only.
pub(crate) async fn broker_config(s: &OAuthService) -> Option<Value> {
    let now = s.clock.now();
    if let Some((at, cached)) = s
        .broker_config
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        let ttl = if cached.is_some() {
            CONFIG_TTL
        } else {
            CONFIG_FAILURE_TTL
        };
        if now < at.saturating_add(ttl) {
            return cached;
        }
    }
    let base = broker_base(s).ok()?;
    let fetched = s
        .transport
        .broker(BrokerRequest {
            base,
            path: "/v1/config".into(),
            body: None,
        })
        .await
        .ok()
        .filter(|v| v["platforms"].is_object());
    *s.broker_config.lock().unwrap_or_else(|p| p.into_inner()) = Some((now, fetched.clone()));
    fetched
}

/// Public view of the broker config: per-platform availability, never addresses or IDs.
pub(crate) fn toris_available(config: Option<&Value>, p: Provider) -> bool {
    toris_platform(p) && config.is_some_and(|c| c["platforms"][p.id()]["enabled"] == true)
}

/// HTTPS call to the broker: fixed origin, `/v1/` paths, no proxy or redirects, capped response.
pub(crate) async fn send_broker(request: BrokerRequest) -> Result<Value, TokenFailure> {
    let base = validate_broker_url(&request.base).map_err(|_| TokenFailure::invalid())?;
    if !request.path.starts_with("/v1/") || request.path.contains("..") {
        return Err(TokenFailure::invalid());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        .user_agent(broker_user_agent())
        .build()
        .map_err(|_| TokenFailure::transient("transport_unavailable"))?;
    let url = format!("{base}{}", request.path);
    let builder = match &request.body {
        Some(body) => client.post(&url).json(body),
        None => client.get(&url),
    };
    let mut response = builder
        .header("Accept", "application/json")
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|_| TokenFailure::transient("network_failure"))?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| TokenFailure::transient("network_failure"))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(TokenFailure::transient("oversized_response"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value =
        serde_json::from_slice(&bytes).map_err(|_| TokenFailure::transient("invalid_response"))?;
    if body.get("error").is_some() || !status.is_success() {
        return Err(broker_failure(&body));
    }
    Ok(body)
}

/// What the SNS screen may know: which platforms offer "Toris 연결" and whether Naver search is served.
/// No address, client ID or version leaves Rust.
pub(crate) async fn broker_view(s: &OAuthService) -> Value {
    let config = broker_config(s).await;
    let available: serde_json::Map<String, Value> = PROVIDERS
        .into_iter()
        .filter(|p| toris_platform(*p))
        .map(|p| {
            (
                p.id().to_string(),
                json!(toris_available(config.as_ref(), p)),
            )
        })
        .collect();
    json!({
        "available": available,
        "naverSearch": config.as_ref().is_some_and(|c| c["naverSearch"]["enabled"] == true),
        "clients": PROVIDERS.into_iter().map(|p| {
            let mode = s.client_for(p).ok().flatten().map(|c| c.mode);
            (p.id().to_string(), json!({"mode": mode}))
        }).collect::<serde_json::Map<String, Value>>(),
    })
}

/// Naver blog search with Toris's Naver search key, held by the broker. Only the query fields are sent.
pub(crate) async fn naver_search_with(s: &OAuthService, query: &str) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 100 || query.chars().any(char::is_control) {
        return Err("검색어를 1~100자로 입력하세요.".into());
    }
    s.transport
        .broker(BrokerRequest {
            base: broker_base(s)?,
            path: "/v1/naver/search/blog".into(),
            body: Some(json!({"query": query, "display": 20, "sort": "date"})),
        })
        .await
        .map_err(|failure| match failure.outcome {
            "quota_exhausted" => "Toris 네이버 검색 한도를 오늘 모두 썼습니다. 내 네이버 검색 API 키를 넣으면 계속 검색할 수 있습니다.".into(),
            _ => failure.message(),
        })
}
