//! One-person planner: work items and calendar events in the local DB, with a
//! two-way sync to one app-created Google calendar (scope calendar.app.created).
//!
//! The sync rules live in pure functions (`decide`, `event_body`, `remote_event`)
//! so they can be tested without a network. Studio owns publication-linked events:
//! they are pushed to Google and a Google-side edit or delete is reverted.
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

const DB_ERROR: &str =
    "일정 DB에 저장하지 못했습니다. 로컬 DB 연결과 마이그레이션(009)을 확인하세요.";
const CALENDAR_API: &str = "https://www.googleapis.com/calendar/v3";
const CALENDAR_NAME: &str = "Toris Studio";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    None,
    WorkItem,
    PublicationJob,
}

impl LinkKind {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "none" => Ok(Self::None),
            "work_item" => Ok(Self::WorkItem),
            "publication_job" => Ok(Self::PublicationJob),
            _ => Err("일정 연결 종류를 확인하세요.".into()),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::WorkItem => "work_item",
            Self::PublicationJob => "publication_job",
        }
    }
    /// Studio is the source of truth: Google edits to these events are reverted.
    pub fn studio_owned(self) -> bool {
        self == Self::PublicationJob
    }
}

/// The parts of an event both sides can change.
#[derive(Debug, Clone, PartialEq)]
pub struct EventFields {
    pub title: String,
    pub notes: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub all_day: bool,
    pub deleted: bool,
}

#[derive(Debug, Clone)]
pub struct LocalEvent {
    pub id: Uuid,
    pub fields: EventFields,
    pub link: LinkKind,
    pub google_id: Option<String>,
    pub google_etag: Option<String>,
    pub local_updated_at: DateTime<Utc>,
    /// The remote `updated` time we last saw; a newer one means Google changed it.
    pub remote_updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct RemoteEvent {
    pub google_id: String,
    pub etag: String,
    pub fields: EventFields,
    pub updated: DateTime<Utc>,
    /// The local id we stamped into extendedProperties.private; absent for events made in Google.
    pub studio_id: Option<Uuid>,
}

/// What one sync step does for one event.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Nothing changed on either side.
    Keep,
    /// Send the local version to Google (create when there is no google_id yet).
    Push,
    /// Take Google's version into the local row.
    Pull,
    /// Both changed. The newer side wins; the losing version is recorded.
    Conflict { winner: Side },
    /// Google changed a Studio-owned event; push the local version back and say so.
    Revert,
    /// A new event made in Google: create a local row.
    Import,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Local,
    Remote,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
        }
    }
}

/// The sync rule for one event, given its local row (if any) and Google's copy (if any in this page).
/// `last_sync` is when the previous sync finished; a local edit after it is a local change.
pub fn decide(
    local: Option<&LocalEvent>,
    remote: Option<&RemoteEvent>,
    last_sync: Option<DateTime<Utc>>,
) -> Action {
    let Some(local) = local else {
        return if remote.is_some_and(|r| !r.fields.deleted) {
            Action::Import
        } else {
            Action::Keep
        };
    };
    let local_changed =
        local.google_id.is_none() || last_sync.is_none_or(|at| local.local_updated_at > at);
    let Some(remote) = remote else {
        return if local_changed {
            Action::Push
        } else {
            Action::Keep
        };
    };
    let remote_changed = local
        .remote_updated_at
        .is_none_or(|seen| remote.updated > seen)
        && remote.fields != local.fields;
    // Already identical on both sides (including the same edit made twice): nothing to send.
    if local.google_id.is_some() && remote.fields == local.fields {
        return Action::Keep;
    }
    match (local_changed, remote_changed) {
        (_, true) if local.link.studio_owned() => Action::Revert,
        (false, false) => Action::Keep,
        (true, false) => Action::Push,
        (false, true) => Action::Pull,
        (true, true) => Action::Conflict {
            winner: if remote.updated > local.local_updated_at {
                Side::Remote
            } else {
                Side::Local
            },
        },
    }
}

/// Google Calendar event resource for a local event. All-day events use dates; timed ones use RFC 3339.
pub fn event_body(event: &LocalEvent) -> Value {
    let f = &event.fields;
    let (start, end) = if f.all_day {
        let end_day = if f.ends_at.date_naive() > f.starts_at.date_naive() {
            f.ends_at.date_naive()
        } else {
            f.starts_at.date_naive() + Duration::days(1)
        };
        (
            json!({"date": f.starts_at.date_naive().to_string()}),
            json!({"date": end_day.to_string()}),
        )
    } else {
        (
            json!({"dateTime": f.starts_at.to_rfc3339()}),
            json!({"dateTime": f.ends_at.to_rfc3339()}),
        )
    };
    let mut description = f.notes.clone();
    if event.link.studio_owned() {
        description = format!("{description}\n\n(Toris Studio가 관리하는 게시 일정입니다. 시간 변경은 Studio에서 하세요.)").trim().to_owned();
    }
    json!({
        "summary": f.title,
        "description": description,
        "start": start,
        "end": end,
        "extendedProperties": {"private": {"torisStudioId": event.id.to_string(), "torisLink": event.link.as_str()}},
    })
}

#[derive(Deserialize)]
struct GoogleTime {
    #[serde(rename = "dateTime")]
    date_time: Option<String>,
    date: Option<String>,
}

fn parse_time(value: &Value) -> Result<(DateTime<Utc>, bool), String> {
    let time: GoogleTime = serde_json::from_value(value.clone())
        .map_err(|_| "Google 일정 시간을 해석하지 못했습니다.")?;
    if let Some(raw) = time.date_time {
        return Ok((
            DateTime::parse_from_rfc3339(&raw)
                .map_err(|_| "Google 일정 시간을 해석하지 못했습니다.")?
                .with_timezone(&Utc),
            false,
        ));
    }
    let date = time.date.ok_or("Google 일정 시간이 없습니다.")?;
    let day = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .map_err(|_| "Google 일정 날짜를 해석하지 못했습니다.")?;
    Ok((day.and_hms_opt(0, 0, 0).expect("midnight").and_utc(), true))
}

fn bounded(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect()
}

/// Reads one item of an events.list response. Cancelled events come back with only an id and status.
pub fn remote_event(item: &Value) -> Result<RemoteEvent, String> {
    let google_id = item["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 1024)
        .ok_or("Google 일정 ID가 없습니다.")?
        .to_owned();
    let etag = item["etag"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(200)
        .collect();
    let updated = item["updated"]
        .as_str()
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);
    let studio_id = item["extendedProperties"]["private"]["torisStudioId"]
        .as_str()
        .and_then(|raw| Uuid::parse_str(raw).ok());
    if item["status"] == "cancelled" {
        let epoch = DateTime::<Utc>::UNIX_EPOCH;
        return Ok(RemoteEvent {
            google_id,
            etag,
            updated,
            studio_id,
            fields: EventFields {
                title: String::new(),
                notes: String::new(),
                starts_at: epoch,
                ends_at: epoch,
                all_day: false,
                deleted: true,
            },
        });
    }
    let (starts_at, all_day) = parse_time(&item["start"])?;
    let (mut ends_at, _) = parse_time(&item["end"])?;
    if ends_at < starts_at {
        ends_at = starts_at;
    }
    let title = bounded(item["summary"].as_str().unwrap_or("(제목 없음)"), 300);
    Ok(RemoteEvent {
        google_id,
        etag,
        updated,
        studio_id,
        fields: EventFields {
            title: if title.trim().is_empty() {
                "(제목 없음)".into()
            } else {
                title
            },
            notes: bounded(item["description"].as_str().unwrap_or(""), 8000),
            starts_at,
            ends_at,
            all_day,
            deleted: false,
        },
    })
}

// ---- Google Calendar HTTP (fixed endpoints, bearer token from the native OAuth store) ----

/// Calendar API calls, behind a trait so the sync loop is tested against a fake.
pub trait CalendarApi: Send + Sync {
    fn create_calendar(&self) -> impl std::future::Future<Output = Result<String, String>> + Send;
    /// Returns (items, next page token, next sync token). A 410 maps to Err("GONE").
    fn list(
        &self,
        calendar: &str,
        sync_token: Option<&str>,
        page: Option<&str>,
    ) -> impl std::future::Future<
        Output = Result<(Vec<Value>, Option<String>, Option<String>), String>,
    > + Send;
    fn insert(
        &self,
        calendar: &str,
        body: &Value,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send;
    fn update(
        &self,
        calendar: &str,
        id: &str,
        body: &Value,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send;
    fn delete(
        &self,
        calendar: &str,
        id: &str,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
}

pub struct GoogleCalendar {
    client: reqwest::Client,
    token: String,
    base: String,
}

impl GoogleCalendar {
    pub fn new(token: String) -> Result<Self, String> {
        Self::with_base(token, CALENDAR_API.into())
    }
    fn with_base(token: String, base: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|_| "Google Calendar HTTP 설정 오류")?;
        Ok(Self {
            client,
            token,
            base,
        })
    }
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value, String> {
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| "Google Calendar에 연결하지 못했습니다.")?;
        let status = response.status();
        if status.as_u16() == 410 {
            return Err("GONE".into());
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(
                "Google Calendar 권한이 없거나 만료되었습니다. 연결을 다시 확인하세요.".into(),
            );
        }
        if !status.is_success() {
            return Err(format!(
                "Google Calendar 요청이 실패했습니다 (HTTP {}).",
                status.as_u16()
            ));
        }
        if status.as_u16() == 204 {
            return Ok(Value::Null);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "Google Calendar 응답을 읽지 못했습니다.")?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("Google Calendar 응답이 너무 큽니다.".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Google Calendar 응답 형식 오류".into())
    }
    fn calendar_path(&self, calendar: &str) -> String {
        format!("{}/calendars/{}/events", self.base, urlencode(calendar))
    }
}

fn urlencode(raw: &str) -> String {
    url::form_urlencoded::byte_serialize(raw.as_bytes()).collect()
}

impl CalendarApi for GoogleCalendar {
    async fn create_calendar(&self) -> Result<String, String> {
        let created = self.send(self.client.post(format!("{}/calendars", self.base)).json(&json!({"summary": CALENDAR_NAME, "description": "Toris Studio 일정·게시 예약", "timeZone": "Asia/Seoul"}))).await?;
        created["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Google 캘린더를 만들지 못했습니다.".into())
    }
    async fn list(
        &self,
        calendar: &str,
        sync_token: Option<&str>,
        page: Option<&str>,
    ) -> Result<(Vec<Value>, Option<String>, Option<String>), String> {
        let mut request = self.client.get(self.calendar_path(calendar)).query(&[
            ("maxResults", "250"),
            ("showDeleted", "true"),
            ("singleEvents", "true"),
        ]);
        if let Some(token) = sync_token {
            request = request.query(&[("syncToken", token)]);
        } else {
            // First sync: a bounded window around today.
            let from = (Utc::now() - Duration::days(90)).to_rfc3339();
            request = request.query(&[("timeMin", from.as_str())]);
        }
        if let Some(page) = page {
            request = request.query(&[("pageToken", page)]);
        }
        let value = self.send(request).await?;
        let items = value["items"].as_array().cloned().unwrap_or_default();
        Ok((
            items,
            value["nextPageToken"].as_str().map(str::to_owned),
            value["nextSyncToken"].as_str().map(str::to_owned),
        ))
    }
    async fn insert(&self, calendar: &str, body: &Value) -> Result<Value, String> {
        self.send(self.client.post(self.calendar_path(calendar)).json(body))
            .await
    }
    async fn update(&self, calendar: &str, id: &str, body: &Value) -> Result<Value, String> {
        self.send(
            self.client
                .put(format!(
                    "{}/{}",
                    self.calendar_path(calendar),
                    urlencode(id)
                ))
                .json(body),
        )
        .await
    }
    async fn delete(&self, calendar: &str, id: &str) -> Result<(), String> {
        match self
            .send(self.client.delete(format!(
                "{}/{}",
                self.calendar_path(calendar),
                urlencode(id)
            )))
            .await
        {
            Ok(_) => Ok(()),
            // Already gone on Google's side is the outcome we wanted.
            Err(error) if error == "GONE" || error.contains("HTTP 404") => Ok(()),
            Err(error) => Err(error),
        }
    }
}

// ---- Sync over a store (DB in production, memory in tests) ----

pub struct SyncState {
    pub calendar_id: Option<String>,
    pub sync_token: Option<String>,
    pub last_synced_at: Option<DateTime<Utc>>,
}

/// Storage the sync loop needs. Production uses PostgreSQL (`DbStore`).
pub trait Store: Send {
    fn state(&mut self) -> impl std::future::Future<Output = Result<SyncState, String>> + Send;
    fn save_state(
        &mut self,
        calendar_id: &str,
        sync_token: Option<&str>,
        at: DateTime<Utc>,
        error: Option<&str>,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
    fn events(
        &mut self,
    ) -> impl std::future::Future<Output = Result<Vec<LocalEvent>, String>> + Send;
    fn apply_remote(
        &mut self,
        local: Option<Uuid>,
        remote: &RemoteEvent,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
    fn mark_pushed(
        &mut self,
        id: Uuid,
        google_id: &str,
        etag: &str,
        updated: DateTime<Utc>,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
    fn record_conflict(
        &mut self,
        id: Uuid,
        winner: Side,
        losing: Value,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
    fn purge(&mut self, id: Uuid) -> impl std::future::Future<Output = Result<(), String>> + Send;
}

#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: usize,
    pub pulled: usize,
    pub imported: usize,
    pub conflicts: usize,
    pub reverted: usize,
    pub deleted: usize,
    pub full_resync: bool,
}

fn fields_json(fields: &EventFields) -> Value {
    json!({"title":fields.title,"notes":fields.notes,"startsAt":fields.starts_at.to_rfc3339(),"endsAt":fields.ends_at.to_rfc3339(),"allDay":fields.all_day,"deleted":fields.deleted})
}

async fn push<A: CalendarApi, S: Store>(
    api: &A,
    store: &mut S,
    calendar: &str,
    event: &LocalEvent,
) -> Result<bool, String> {
    if event.fields.deleted {
        if let Some(google_id) = &event.google_id {
            api.delete(calendar, google_id).await?;
        }
        store.purge(event.id).await?;
        return Ok(true);
    }
    let body = event_body(event);
    let saved = match &event.google_id {
        Some(google_id) => api.update(calendar, google_id, &body).await?,
        None => api.insert(calendar, &body).await?,
    };
    let remote = remote_event(&saved)?;
    store
        .mark_pushed(event.id, &remote.google_id, &remote.etag, remote.updated)
        .await?;
    Ok(false)
}

/// One sync pass: pull Google's changes (incremental via syncToken, full after 410), decide per
/// event, push local changes. Returns what happened. Idempotent: a second pass with no edits does nothing.
pub async fn sync<A: CalendarApi, S: Store>(
    api: &A,
    store: &mut S,
    now: DateTime<Utc>,
) -> Result<SyncReport, String> {
    let mut report = SyncReport::default();
    let state = store.state().await?;
    let calendar = match state.calendar_id {
        Some(id) => id,
        None => {
            let id = api.create_calendar().await?;
            store.save_state(&id, None, now, None).await?;
            id
        }
    };
    let mut token = state.sync_token.clone();
    let (remote, next_token) = loop {
        let mut page: Option<String> = None;
        let mut collected = Vec::new();
        let result = loop {
            match api.list(&calendar, token.as_deref(), page.as_deref()).await {
                Ok((items, next_page, next_sync)) => {
                    for item in &items {
                        collected.push(remote_event(item)?);
                    }
                    match next_page {
                        Some(next) => page = Some(next),
                        None => break Ok(next_sync),
                    }
                }
                Err(error) => break Err(error),
            }
        };
        match result {
            Ok(next) => {
                break (collected, next);
            }
            // The sync token expired: Google wants a full listing.
            Err(error) if error == "GONE" && token.is_some() => {
                token = None;
                report.full_resync = true;
            }
            Err(error) => return Err(error),
        }
    };
    let last_sync = if report.full_resync {
        None
    } else {
        state.last_synced_at
    };
    let locals = store.events().await?;
    let mut seen = std::collections::HashSet::new();
    for item in &remote {
        let local = locals.iter().find(|event| {
            event.google_id.as_deref() == Some(item.google_id.as_str())
                || item.studio_id == Some(event.id)
        });
        if let Some(local) = local {
            seen.insert(local.id);
        }
        match decide(local, Some(item), last_sync) {
            Action::Keep => {}
            Action::Import => {
                store.apply_remote(None, item).await?;
                report.imported += 1;
            }
            Action::Pull => {
                let local = local.expect("pull has a local row");
                store.apply_remote(Some(local.id), item).await?;
                if item.fields.deleted {
                    report.deleted += 1
                } else {
                    report.pulled += 1
                }
            }
            Action::Push => {
                let local = local.expect("push has a local row");
                if push(api, store, &calendar, local).await? {
                    report.deleted += 1
                } else {
                    report.pushed += 1
                }
            }
            Action::Revert => {
                let local = local.expect("revert has a local row");
                // A Google-side delete of a Studio-owned event recreates it.
                let mut restored = local.clone();
                if item.fields.deleted {
                    restored.google_id = None;
                }
                push(api, store, &calendar, &restored).await?;
                store
                    .record_conflict(local.id, Side::Local, fields_json(&item.fields))
                    .await?;
                report.reverted += 1;
            }
            Action::Conflict { winner } => {
                let local = local.expect("conflict has a local row");
                match winner {
                    Side::Remote => {
                        store
                            .record_conflict(local.id, winner, fields_json(&local.fields))
                            .await?;
                        store.apply_remote(Some(local.id), item).await?;
                    }
                    Side::Local => {
                        store
                            .record_conflict(local.id, winner, fields_json(&item.fields))
                            .await?;
                        push(api, store, &calendar, local).await?;
                    }
                }
                report.conflicts += 1;
            }
        }
    }
    for local in locals.iter().filter(|event| !seen.contains(&event.id)) {
        if decide(Some(local), None, last_sync) == Action::Push {
            if push(api, store, &calendar, local).await? {
                report.deleted += 1
            } else {
                report.pushed += 1
            }
        }
    }
    store
        .save_state(&calendar, next_token.as_deref(), now, None)
        .await?;
    Ok(report)
}

// ---- PostgreSQL store and planner records ----

pub struct DbStore<'a> {
    pub client: &'a tokio_postgres::Client,
}

fn db<T>(result: Result<T, tokio_postgres::Error>) -> Result<T, String> {
    result.map_err(|_| DB_ERROR.to_string())
}

fn local_from_row(row: &tokio_postgres::Row) -> Result<LocalEvent, String> {
    Ok(LocalEvent {
        id: db(row.try_get("id"))?,
        fields: EventFields {
            title: db(row.try_get("title"))?,
            notes: db(row.try_get("notes"))?,
            starts_at: db(row.try_get("starts_at"))?,
            ends_at: db(row.try_get("ends_at"))?,
            all_day: db(row.try_get("all_day"))?,
            deleted: db(row.try_get("deleted"))?,
        },
        link: LinkKind::parse(&db(row.try_get::<_, String>("link_kind"))?)?,
        google_id: db(row.try_get("google_id"))?,
        google_etag: db(row.try_get("google_etag"))?,
        local_updated_at: db(row.try_get("local_updated_at"))?,
        remote_updated_at: db(row.try_get("remote_updated_at"))?,
    })
}

impl Store for DbStore<'_> {
    async fn state(&mut self) -> Result<SyncState, String> {
        let row = db(self
            .client
            .query_one(
                "SELECT calendar_id,sync_token,last_synced_at FROM calendar_sync_state WHERE id=1",
                &[],
            )
            .await)?;
        Ok(SyncState {
            calendar_id: db(row.try_get(0))?,
            sync_token: db(row.try_get(1))?,
            last_synced_at: db(row.try_get(2))?,
        })
    }
    async fn save_state(
        &mut self,
        calendar_id: &str,
        sync_token: Option<&str>,
        at: DateTime<Utc>,
        error: Option<&str>,
    ) -> Result<(), String> {
        db(self.client.execute("UPDATE calendar_sync_state SET calendar_id=$1,sync_token=$2,last_synced_at=$3,last_error=$4 WHERE id=1", &[&calendar_id, &sync_token, &at, &error]).await)?;
        Ok(())
    }
    async fn events(&mut self) -> Result<Vec<LocalEvent>, String> {
        let rows = db(self
            .client
            .query("SELECT * FROM calendar_events", &[])
            .await)?;
        rows.iter().map(local_from_row).collect()
    }
    async fn apply_remote(
        &mut self,
        local: Option<Uuid>,
        remote: &RemoteEvent,
    ) -> Result<(), String> {
        let f = &remote.fields;
        match local {
            Some(id) if f.deleted => {
                db(self
                    .client
                    .execute("DELETE FROM calendar_events WHERE id=$1", &[&id])
                    .await)?;
            }
            Some(id) => {
                // local_updated_at follows the remote edit, so the next pass does not echo it back.
                db(self.client.execute("UPDATE calendar_events SET title=$2,notes=$3,starts_at=$4,ends_at=$5,all_day=$6,google_id=$7,google_etag=$8,remote_updated_at=$9,local_updated_at=$9 WHERE id=$1",
                    &[&id, &f.title, &f.notes, &f.starts_at, &f.ends_at, &f.all_day, &remote.google_id, &remote.etag, &remote.updated]).await)?;
            }
            None => {
                db(self.client.execute("INSERT INTO calendar_events(id,title,notes,starts_at,ends_at,all_day,google_id,google_etag,remote_updated_at,local_updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT (google_id) WHERE google_id IS NOT NULL DO NOTHING",
                    &[&Uuid::new_v4(), &f.title, &f.notes, &f.starts_at, &f.ends_at, &f.all_day, &remote.google_id, &remote.etag, &remote.updated]).await)?;
            }
        }
        Ok(())
    }
    async fn mark_pushed(
        &mut self,
        id: Uuid,
        google_id: &str,
        etag: &str,
        updated: DateTime<Utc>,
    ) -> Result<(), String> {
        db(self.client.execute("UPDATE calendar_events SET google_id=$2,google_etag=$3,remote_updated_at=$4 WHERE id=$1", &[&id, &google_id, &etag, &updated]).await)?;
        Ok(())
    }
    async fn record_conflict(
        &mut self,
        id: Uuid,
        winner: Side,
        losing: Value,
    ) -> Result<(), String> {
        db(self
            .client
            .execute(
                "INSERT INTO calendar_conflicts(id,event_id,winner,losing) VALUES($1,$2,$3,$4)",
                &[&Uuid::new_v4(), &id, &winner.as_str(), &losing],
            )
            .await)?;
        Ok(())
    }
    async fn purge(&mut self, id: Uuid) -> Result<(), String> {
        db(self
            .client
            .execute("DELETE FROM calendar_events WHERE id=$1", &[&id])
            .await)?;
        Ok(())
    }
}

fn text_field(input: &Value, key: &str, max: usize, required: bool) -> Result<String, String> {
    match input.get(key) {
        None | Some(Value::Null) if !required => Ok(String::new()),
        Some(Value::String(text))
            if text.chars().count() <= max
                && !text.chars().any(|c| c.is_control() && c != '\n')
                && (!required || !text.trim().is_empty()) =>
        {
            Ok(text.trim().to_owned())
        }
        _ => Err(format!("{key} 값을 확인하세요 ({max}자 이하).")),
    }
}

fn time_field(input: &Value, key: &str) -> Result<Option<DateTime<Utc>>, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) => DateTime::parse_from_rfc3339(raw)
            .map(|t| Some(t.with_timezone(&Utc)))
            .map_err(|_| format!("{key}는 시간대가 포함된 ISO 8601 시각이어야 합니다.")),
        _ => Err(format!("{key} 형식을 확인하세요.")),
    }
}

/// Rejects unknown fields so a caller cannot set sync bookkeeping (google_id, etag, link) directly.
fn only(input: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = input.as_object().ok_or("입력 형식을 확인하세요.")?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!(
            "지원하지 않는 필드입니다: {}",
            key.chars().take(40).collect::<String>()
        ));
    }
    Ok(())
}

pub fn validate_event(
    input: &Value,
) -> Result<(String, String, DateTime<Utc>, DateTime<Utc>, bool), String> {
    only(
        input,
        &["id", "title", "notes", "startsAt", "endsAt", "allDay"],
    )?;
    let title = text_field(input, "title", 300, true)?;
    let notes = text_field(input, "notes", 8000, false)?;
    let starts = time_field(input, "startsAt")?.ok_or("시작 시각을 입력하세요.")?;
    let ends = time_field(input, "endsAt")?.unwrap_or(starts + Duration::hours(1));
    if ends < starts || ends - starts > Duration::days(31) {
        return Err("끝 시각은 시작 이후, 31일 이내여야 합니다.".into());
    }
    let all_day = input
        .get("allDay")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok((title, notes, starts, ends, all_day))
}

pub fn validate_work_item(
    input: &Value,
) -> Result<(String, String, String, Option<DateTime<Utc>>), String> {
    only(
        input,
        &["id", "title", "notes", "status", "dueAt", "productId"],
    )?;
    let title = text_field(input, "title", 300, true)?;
    let notes = text_field(input, "notes", 20000, false)?;
    let status = input
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("todo")
        .to_owned();
    if !matches!(status.as_str(), "todo" | "doing" | "done" | "dropped") {
        return Err("작업 상태는 todo, doing, done, dropped 중 하나여야 합니다.".into());
    }
    Ok((title, notes, status, time_field(input, "dueAt")?))
}

fn event_json(row: &tokio_postgres::Row) -> Result<Value, String> {
    let event = local_from_row(row)?;
    Ok(
        json!({"id":event.id.to_string(),"title":event.fields.title,"notes":event.fields.notes,"startsAt":event.fields.starts_at.to_rfc3339(),"endsAt":event.fields.ends_at.to_rfc3339(),
        "allDay":event.fields.all_day,"link":event.link.as_str(),"linkId":db(row.try_get::<_, Option<Uuid>>("link_id"))?.map(|id| id.to_string()),"synced":event.google_id.is_some(),"studioOwned":event.link.studio_owned()}),
    )
}

fn work_json(row: &tokio_postgres::Row) -> Result<Value, String> {
    Ok(
        json!({"id":db(row.try_get::<_, Uuid>("id"))?.to_string(),"title":db(row.try_get::<_, String>("title"))?,"notes":db(row.try_get::<_, String>("notes"))?,
        "status":db(row.try_get::<_, String>("status"))?,"dueAt":db(row.try_get::<_, Option<DateTime<Utc>>>("due_at"))?.map(|t| t.to_rfc3339()),
        "productId":db(row.try_get::<_, Option<Uuid>>("product_id"))?.map(|id| id.to_string()),"source":db(row.try_get::<_, String>("source"))?,"updatedAt":db(row.try_get::<_, DateTime<Utc>>("updated_at"))?.to_rfc3339()}),
    )
}

/// Mirrors scheduled publication jobs into calendar events (Studio-owned, one-way to Google).
pub async fn mirror_publications(client: &tokio_postgres::Client) -> Result<(), String> {
    db(client.batch_execute(
        "INSERT INTO calendar_events(id,title,starts_at,ends_at,link_kind,link_id)
           SELECT gen_random_uuid(), left('게시 예약 · '||coalesce(j.snapshot->>'platform','SNS')||' · '||coalesce(p.payload->>'title','제목 없음'),300), j.scheduled_at, j.scheduled_at + interval '15 minutes', 'publication_job', j.id
           FROM publication_jobs j JOIN publications p ON p.id=j.publication_id
           WHERE j.status='scheduled' AND j.scheduled_at IS NOT NULL
         ON CONFLICT (link_kind, link_id) WHERE link_id IS NOT NULL DO UPDATE
           SET title=EXCLUDED.title, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, deleted=false, local_updated_at=now()
           WHERE calendar_events.starts_at IS DISTINCT FROM EXCLUDED.starts_at OR calendar_events.title IS DISTINCT FROM EXCLUDED.title OR calendar_events.deleted;
         UPDATE calendar_events e SET deleted=true, local_updated_at=now()
           WHERE e.link_kind='publication_job' AND NOT e.deleted AND NOT EXISTS (SELECT 1 FROM publication_jobs j WHERE j.id=e.link_id AND j.status='scheduled');",
    ).await)
}

pub async fn today(
    client: &tokio_postgres::Client,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Value, String> {
    mirror_publications(client).await?;
    let events = db(client.query("SELECT * FROM calendar_events WHERE NOT deleted AND ends_at >= $1 AND starts_at < $2 ORDER BY starts_at LIMIT 500", &[&from, &to]).await)?;
    let work = db(client.query("SELECT * FROM work_items WHERE status IN ('todo','doing') ORDER BY due_at NULLS LAST, updated_at DESC LIMIT 500", &[]).await)?;
    let conflicts = db(client
        .query_one(
            "SELECT count(*) FROM calendar_conflicts WHERE NOT resolved",
            &[],
        )
        .await)?;
    let state = db(client.query_one("SELECT calendar_id IS NOT NULL, last_synced_at, last_error FROM calendar_sync_state WHERE id=1", &[]).await)?;
    Ok(json!({
        "events": events.iter().map(event_json).collect::<Result<Vec<_>, _>>()?,
        "work": work.iter().map(work_json).collect::<Result<Vec<_>, _>>()?,
        "openConflicts": db(conflicts.try_get::<_, i64>(0))?,
        "calendar": {"linked": db(state.try_get::<_, bool>(0))?, "lastSyncedAt": db(state.try_get::<_, Option<DateTime<Utc>>>(1))?.map(|t| t.to_rfc3339()), "lastError": db(state.try_get::<_, Option<String>>(2))?},
    }))
}

pub async fn save_event(client: &tokio_postgres::Client, input: &Value) -> Result<Value, String> {
    let (title, notes, starts, ends, all_day) = validate_event(input)?;
    let row = match input.get("id").and_then(Value::as_str) {
        Some(raw) => {
            let id = Uuid::parse_str(raw).map_err(|_| "일정 ID 형식 오류")?;
            // Studio-owned publication events are changed by rescheduling the publication.
            db(client.query_opt("UPDATE calendar_events SET title=$2,notes=$3,starts_at=$4,ends_at=$5,all_day=$6,local_updated_at=now() WHERE id=$1 AND link_kind<>'publication_job' AND NOT deleted RETURNING *", &[&id, &title, &notes, &starts, &ends, &all_day]).await)?
                .ok_or("일정을 찾을 수 없거나 게시 예약 일정입니다. 게시 예약은 SNS 일괄 게시에서 바꾸세요.")?
        }
        None => db(client.query_one("INSERT INTO calendar_events(id,title,notes,starts_at,ends_at,all_day) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", &[&Uuid::new_v4(), &title, &notes, &starts, &ends, &all_day]).await)?,
    };
    event_json(&row)
}

pub async fn delete_event(client: &tokio_postgres::Client, raw: &str) -> Result<(), String> {
    let id = Uuid::parse_str(raw).map_err(|_| "일정 ID 형식 오류")?;
    // Soft delete: the next sync removes it from Google, then purges the row.
    let changed = db(client.execute("UPDATE calendar_events SET deleted=true,local_updated_at=now() WHERE id=$1 AND link_kind<>'publication_job'", &[&id]).await)?;
    if changed == 0 {
        return Err("일정을 찾을 수 없거나 게시 예약 일정입니다.".into());
    }
    Ok(())
}

pub async fn save_work_item(
    client: &tokio_postgres::Client,
    input: &Value,
) -> Result<Value, String> {
    let (title, notes, status, due) = validate_work_item(input)?;
    let row = match input.get("id").and_then(Value::as_str) {
        Some(raw) => {
            let id = Uuid::parse_str(raw).map_err(|_| "작업 ID 형식 오류")?;
            db(client.query_opt("UPDATE work_items SET title=$2,notes=$3,status=$4,due_at=$5,updated_at=now() WHERE id=$1 RETURNING *", &[&id, &title, &notes, &status, &due]).await)?.ok_or("작업을 찾을 수 없습니다.")?
        }
        None => db(client.query_one("INSERT INTO work_items(id,title,notes,status,due_at) VALUES($1,$2,$3,$4,$5) RETURNING *", &[&Uuid::new_v4(), &title, &notes, &status, &due]).await)?,
    };
    work_json(&row)
}

pub async fn conflicts(client: &tokio_postgres::Client) -> Result<Value, String> {
    let rows = db(client.query("SELECT c.id,c.winner,c.losing,c.created_at,e.title FROM calendar_conflicts c JOIN calendar_events e ON e.id=c.event_id WHERE NOT c.resolved ORDER BY c.created_at DESC LIMIT 100", &[]).await)?;
    Ok(json!(rows.iter().map(|row| json!({"id":row.get::<_, Uuid>(0).to_string(),"winner":row.get::<_, String>(1),"losing":row.get::<_, Value>(2),"at":row.get::<_, DateTime<Utc>>(3).to_rfc3339(),"title":row.get::<_, String>(4)})).collect::<Vec<_>>()))
}

pub async fn resolve_conflict(client: &tokio_postgres::Client, raw: &str) -> Result<(), String> {
    let id = Uuid::parse_str(raw).map_err(|_| "충돌 ID 형식 오류")?;
    db(client
        .execute(
            "UPDATE calendar_conflicts SET resolved=true WHERE id=$1",
            &[&id],
        )
        .await)?;
    Ok(())
}

pub async fn record_sync_error(client: &tokio_postgres::Client, error: &str) {
    let message: String = error.chars().take(500).collect();
    let _ = client
        .execute(
            "UPDATE calendar_sync_state SET last_error=$1 WHERE id=1",
            &[&message],
        )
        .await;
}

#[cfg(test)]
#[path = "planner_tests.rs"]
mod tests;
