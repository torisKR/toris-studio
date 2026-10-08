use crate::AppState;
use chrono::{DateTime, Duration, FixedOffset, TimeZone, Timelike, Utc};
use serde::Serialize;
use std::{fs, sync::Arc};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStatus {
    pub enabled: bool,
    pub last_success_at: Option<String>,
    pub next_run_at: String,
    pub last_error: Option<String>,
    pub running: bool,
}

fn korea() -> FixedOffset {
    FixedOffset::east_opt(9 * 3600).unwrap()
}
pub fn day(now: DateTime<Utc>) -> String {
    now.with_timezone(&korea()).date_naive().to_string()
}
pub fn due(now: DateTime<Utc>, last_day: Option<&str>) -> bool {
    now.with_timezone(&korea()).hour() >= 7 && last_day != Some(day(now).as_str())
}
pub fn next_run(now: DateTime<Utc>, completed_today: bool) -> String {
    let local = now.with_timezone(&korea());
    let today = local.date_naive().and_hms_opt(7, 0, 0).unwrap();
    let next = if completed_today || local.hour() >= 7 {
        today + Duration::days(1)
    } else {
        today
    };
    korea()
        .from_local_datetime(&next)
        .single()
        .unwrap()
        .to_rfc3339()
}

fn state_path() -> std::path::PathBuf {
    crate::config::config_path().with_file_name("desktop-scheduler.json")
}
pub fn initial_status(enabled: bool) -> SchedulerStatus {
    let last = fs::read(state_path())
        .ok()
        .filter(|v| v.len() < 2048)
        .and_then(|v| serde_json::from_slice::<serde_json::Value>(&v).ok())
        .and_then(|v| {
            v.get("lastSuccessAt")
                .and_then(|v| v.as_str())
                .map(String::from)
        });
    let completed = last
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|d| day(d.with_timezone(&Utc)) == day(Utc::now()));
    SchedulerStatus {
        enabled,
        last_success_at: last,
        next_run_at: next_run(Utc::now(), completed),
        ..Default::default()
    }
}

pub async fn tick(state: Arc<AppState>) {
    let config = state.config.read().await.clone();
    if !config.scheduler_enabled {
        return;
    }
    let now = Utc::now();
    let last_day = state
        .scheduler
        .lock()
        .await
        .last_success_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| day(d.with_timezone(&Utc)));
    if !due(now, last_day.as_deref()) {
        return;
    }
    let Ok(_permit) = state.trend_lock.try_lock() else {
        return;
    };
    state.scheduler.lock().await.running = true;
    let result = crate::social::refresh_trends(&config, None).await;
    let mut status = state.scheduler.lock().await;
    status.running = false;
    match result {
        Ok(result) if result.saved && result.collected > 0 => {
            let at = Utc::now().to_rfc3339();
            status.last_success_at = Some(at.clone());
            status.last_error = None;
            status.next_run_at = next_run(Utc::now(), true);
            let path = state_path();
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(path, serde_json::json!({"lastSuccessAt":at}).to_string());
        }
        _ => {
            status.last_error =
                Some("자동 수집 실패. DB와 네트워크를 확인하세요. 5분 뒤 재시도합니다.".into());
            status.next_run_at = (Utc::now() + Duration::minutes(5))
                .with_timezone(&korea())
                .to_rfc3339();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn korean_schedule_skips_completed_day() {
        let before = DateTime::parse_from_rfc3339("2026-10-07T21:59:59Z")
            .unwrap()
            .with_timezone(&Utc);
        let after = DateTime::parse_from_rfc3339("2026-10-07T22:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(!due(before, None));
        assert!(due(after, None));
        assert!(!due(after, Some("2026-10-08")));
        assert_eq!(next_run(after, true), "2026-10-09T07:00:00+09:00");
    }
}
