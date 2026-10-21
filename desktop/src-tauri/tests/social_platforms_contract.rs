use toris_studio_desktop::{models::SOCIAL_PLATFORMS, social::validate_platform_url};
#[test]
fn manual_channels_accept_only_their_official_https_urls() {
    for (platform, url) in [
        ("x", "https://x.com/my_channel"),
        ("naver_clip", "https://clip.naver.com/my-channel"),
    ] {
        assert!(SOCIAL_PLATFORMS.contains(&platform));
        assert!(validate_platform_url(platform, url).is_ok());
        assert!(validate_platform_url(platform, "https://example.com/").is_err());
    }
    for url in [
        "https://x.com.evil.test/a",
        "http://x.com/a",
        "https://user:secret@x.com/a",
        "https://x.com:9443/a",
    ] {
        assert!(validate_platform_url("x", url).is_err());
    }
}
