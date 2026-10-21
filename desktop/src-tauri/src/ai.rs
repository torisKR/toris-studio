//! Pure compatibility validation. Model transports and subprocess execution were removed.
use url::{Host, Url};
fn error(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}
pub fn validate_provider_url(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|_| {
        error(
            "INVALID_PROVIDER_CONFIG",
            "AI 제공자 주소 설정을 확인해 주세요.",
        )
    })?;
    let loopback = match url.host() {
        Some(Host::Domain(host)) => host == "localhost",
        Some(Host::Ipv4(address)) => address == std::net::Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(address)) => address == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    };
    if !loopback
        || !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["/v1", "/v1/"].contains(&url.path())
    {
        return Err(error(
            "INVALID_PROVIDER_CONFIG",
            "AI 주소는 로컬 루프백 호스트의 /v1 경로여야 합니다.",
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_url_validation_is_pure_and_loopback_only() {
        assert!(validate_provider_url("http://127.0.0.1:10100/v1").is_ok());
        assert!(validate_provider_url("https://evil.test/v1").is_err());
        assert!(validate_provider_url("http://localhost/v1?key=x").is_err());
    }
}
