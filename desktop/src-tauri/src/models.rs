use serde::{Deserialize, Serialize};

pub const SOCIAL_PLATFORMS: [&str; 5] = ["youtube", "threads", "naver_blog", "tiktok", "instagram"];
pub const CONTENT_STATUSES: [&str; 4] = ["draft", "ready", "scheduled", "published"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialChannel {
    pub id: String,
    pub platform: String,
    pub name: String,
    pub handle: String,
    pub url: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialContent {
    pub id: String,
    pub platform: String,
    pub channel_id: Option<String>,
    pub title: String,
    pub body: String,
    pub status: String,
    pub scheduled_at: Option<String>,
    pub url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendDetails {
    pub discovery: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscriber_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_observed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_growth: Option<i64>,
}

impl TrendDetails {
    pub fn discovery(discovery: &str) -> Self {
        Self {
            discovery: discovery.into(),
            description: None,
            view_count: None,
            subscriber_count: None,
            duration_seconds: None,
            channel_title: None,
            previous_observed_at: None,
            view_growth: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialTrend {
    pub id: String,
    pub source: String,
    pub keyword: String,
    pub title: String,
    pub url: String,
    pub metric: Option<String>,
    pub region: String,
    pub published_at: Option<String>,
    pub fetched_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<TrendDetails>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialIntegration {
    pub id: String,
    pub name: String,
    pub status: String,
    pub message: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseState {
    pub connected: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialDashboard {
    pub channels: Vec<SocialChannel>,
    pub content: Vec<SocialContent>,
    pub trends: Vec<SocialTrend>,
    pub integrations: Vec<SocialIntegration>,
    pub database: DatabaseState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrendRefreshResult {
    pub dashboard: SocialDashboard,
    pub collected: usize,
    pub saved: bool,
    pub warnings: Vec<String>,
}
