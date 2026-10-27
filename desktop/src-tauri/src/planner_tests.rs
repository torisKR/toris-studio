use super::*;
use chrono::TimeZone;
use std::sync::Mutex;

fn at(hour: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 27, hour, 0, 0).unwrap()
}
fn fields(title: &str, hour: u32) -> EventFields {
    EventFields {
        title: title.into(),
        notes: String::new(),
        starts_at: at(hour),
        ends_at: at(hour + 1),
        all_day: false,
        deleted: false,
    }
}
fn local(title: &str, google: Option<&str>, edited: u32, seen: Option<u32>) -> LocalEvent {
    LocalEvent {
        id: Uuid::new_v4(),
        fields: fields(title, 9),
        link: LinkKind::None,
        google_id: google.map(str::to_owned),
        google_etag: None,
        local_updated_at: at(edited),
        remote_updated_at: seen.map(at),
    }
}
fn remote(id: &str, title: &str, updated: u32) -> RemoteEvent {
    RemoteEvent {
        google_id: id.into(),
        etag: "e".into(),
        fields: fields(title, 9),
        updated: at(updated),
        studio_id: None,
    }
}

#[test]
fn decide_covers_every_side_of_a_two_way_sync() {
    let last = Some(at(10));
    // New on one side only.
    assert_eq!(
        decide(None, Some(&remote("g", "새 일정", 11)), last),
        Action::Import
    );
    assert_eq!(
        decide(Some(&local("새 로컬", None, 8, None)), None, last),
        Action::Push,
        "never synced: push even if old"
    );
    // Nothing changed.
    assert_eq!(
        decide(
            Some(&local("같음", Some("g"), 8, Some(9))),
            Some(&remote("g", "같음", 9)),
            last
        ),
        Action::Keep
    );
    // One side changed.
    assert_eq!(
        decide(
            Some(&local("로컬 수정", Some("g"), 11, Some(9))),
            Some(&remote("g", "같음", 9)),
            last
        ),
        Action::Push
    );
    assert_eq!(
        decide(
            Some(&local("같음", Some("g"), 8, Some(9))),
            Some(&remote("g", "구글 수정", 11)),
            last
        ),
        Action::Pull
    );
    // Both changed: newer wins.
    assert_eq!(
        decide(
            Some(&local("로컬", Some("g"), 12, Some(9))),
            Some(&remote("g", "구글", 11)),
            last
        ),
        Action::Conflict {
            winner: Side::Local
        }
    );
    assert_eq!(
        decide(
            Some(&local("로컬", Some("g"), 11, Some(9))),
            Some(&remote("g", "구글", 12)),
            last
        ),
        Action::Conflict {
            winner: Side::Remote
        }
    );
    // Both changed to the same thing: no conflict.
    assert_eq!(
        decide(
            Some(&local("같게 고침", Some("g"), 11, Some(9))),
            Some(&remote("g", "같게 고침", 12)),
            last
        ),
        Action::Keep
    );
    // A Google-side delete of a plain event is pulled.
    let mut gone = remote("g", "", 11);
    gone.fields.deleted = true;
    assert_eq!(
        decide(
            Some(&local("같음", Some("g"), 8, Some(9))),
            Some(&gone),
            last
        ),
        Action::Pull
    );
}

#[test]
fn studio_owned_publication_events_are_reverted_never_pulled() {
    let mut owned = local("게시 예약", Some("g"), 8, Some(9));
    owned.link = LinkKind::PublicationJob;
    assert_eq!(
        decide(
            Some(&owned),
            Some(&remote("g", "누가 옮김", 11)),
            Some(at(10))
        ),
        Action::Revert
    );
    let mut gone = remote("g", "", 11);
    gone.fields.deleted = true;
    assert_eq!(
        decide(Some(&owned), Some(&gone), Some(at(10))),
        Action::Revert,
        "a Google delete does not cancel the publication"
    );
    owned.local_updated_at = at(12);
    assert_eq!(
        decide(
            Some(&owned),
            Some(&remote("g", "누가 옮김", 11)),
            Some(at(10))
        ),
        Action::Revert,
        "even when Studio also changed it"
    );
}

#[test]
fn event_bodies_round_trip_and_mark_studio_ownership() {
    let mut event = local("회의", None, 8, None);
    let body = event_body(&event);
    assert_eq!(body["start"]["dateTime"], at(9).to_rfc3339());
    assert_eq!(
        body["extendedProperties"]["private"]["torisStudioId"],
        event.id.to_string()
    );
    let mut echoed = body.clone();
    echoed["id"] = json!("gid");
    echoed["etag"] = json!("\"1\"");
    echoed["updated"] = json!("2026-10-27T12:00:00Z");
    let back = remote_event(&echoed).unwrap();
    assert_eq!(back.fields, event.fields);
    assert_eq!(back.studio_id, Some(event.id));
    event.fields.all_day = true;
    let day = event_body(&event);
    assert_eq!(day["start"]["date"], "2026-10-27");
    assert_eq!(
        day["end"]["date"], "2026-10-28",
        "Google all-day end dates are exclusive"
    );
    event.link = LinkKind::PublicationJob;
    assert!(event_body(&event)["description"]
        .as_str()
        .unwrap()
        .contains("Studio에서"));
}

#[test]
fn remote_parsing_bounds_text_and_handles_cancelled_items() {
    let cancelled = remote_event(&json!({"id":"g1","status":"cancelled"})).unwrap();
    assert!(cancelled.fields.deleted);
    let noisy = remote_event(&json!({"id":"g2","summary":format!("{}\u{0007}", "가".repeat(400)),"start":{"dateTime":"2026-10-27T09:00:00+09:00"},"end":{"dateTime":"2026-10-27T08:00:00+09:00"}})).unwrap();
    assert_eq!(noisy.fields.title.chars().count(), 300);
    assert!(!noisy.fields.title.contains('\u{0007}'));
    assert_eq!(
        noisy.fields.ends_at, noisy.fields.starts_at,
        "an end before the start is clamped"
    );
    assert!(remote_event(&json!({"summary":"no id"})).is_err());
    assert!(remote_event(&json!({"id":"g3","start":{"dateTime":"nope"},"end":{}})).is_err());
}

#[test]
fn inputs_reject_unknown_fields_bad_times_and_sync_bookkeeping() {
    assert!(
        validate_event(&json!({"title":"회의","startsAt":"2026-10-27T09:00:00+09:00"})).is_ok()
    );
    for bad in [
        json!({"title":"","startsAt":"2026-10-27T09:00:00Z"}),
        json!({"title":"t","startsAt":"2026-10-27 09:00"}),
        json!({"title":"t","startsAt":"2026-10-27T09:00:00Z","endsAt":"2026-10-27T08:00:00Z"}),
        json!({"title":"t","startsAt":"2026-10-01T09:00:00Z","endsAt":"2026-12-01T09:00:00Z"}),
        json!({"title":"t","startsAt":"2026-10-27T09:00:00Z","googleId":"forged"}),
        json!({"title":"t","startsAt":"2026-10-27T09:00:00Z","link":"publication_job"}),
    ] {
        assert!(validate_event(&bad).is_err(), "{bad}");
    }
    assert!(validate_work_item(
        &json!({"title":"출시 준비","status":"doing","dueAt":"2026-10-30T18:00:00+09:00"})
    )
    .is_ok());
    assert!(validate_work_item(&json!({"title":"t","status":"archived"})).is_err());
    assert!(
        validate_work_item(&json!({"title":"t","source":"ops"})).is_err(),
        "source is set by the app, not the form"
    );
}

// ---- a full sync against a fake Google and an in-memory store ----

#[derive(Default)]
struct FakeGoogle {
    events: Mutex<Vec<Value>>,
    gone_once: Mutex<bool>,
    calls: Mutex<Vec<String>>,
    clock: Mutex<u32>,
}
impl FakeGoogle {
    fn tick(&self) -> String {
        let mut clock = self.clock.lock().unwrap();
        *clock += 1;
        Utc.with_ymd_and_hms(2026, 10, 28, 0, 0, *clock)
            .unwrap()
            .to_rfc3339()
    }
    fn edit(&self, id: &str, title: &str) {
        let updated = self.tick();
        let mut events = self.events.lock().unwrap();
        let item = events.iter_mut().find(|e| e["id"] == id).unwrap();
        item["summary"] = json!(title);
        item["updated"] = json!(updated);
    }
}
impl CalendarApi for FakeGoogle {
    async fn create_calendar(&self) -> Result<String, String> {
        self.calls.lock().unwrap().push("create_calendar".into());
        Ok("cal-1".into())
    }
    async fn list(
        &self,
        _calendar: &str,
        token: Option<&str>,
        _page: Option<&str>,
    ) -> Result<(Vec<Value>, Option<String>, Option<String>), String> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("list:{}", token.unwrap_or("full")));
        if token.is_some() && std::mem::take(&mut *self.gone_once.lock().unwrap()) {
            return Err("GONE".into());
        }
        Ok((
            self.events.lock().unwrap().clone(),
            None,
            Some("tok".into()),
        ))
    }
    async fn insert(&self, _calendar: &str, body: &Value) -> Result<Value, String> {
        let mut item = body.clone();
        let id = format!("g{}", self.events.lock().unwrap().len() + 1);
        item["id"] = json!(id);
        item["etag"] = json!("e");
        item["updated"] = json!(self.tick());
        self.events.lock().unwrap().push(item.clone());
        self.calls.lock().unwrap().push(format!("insert:{id}"));
        Ok(item)
    }
    async fn update(&self, _calendar: &str, id: &str, body: &Value) -> Result<Value, String> {
        let mut item = body.clone();
        item["id"] = json!(id);
        item["etag"] = json!("e2");
        item["updated"] = json!(self.tick());
        let mut events = self.events.lock().unwrap();
        events.retain(|e| e["id"] != id);
        events.push(item.clone());
        self.calls.lock().unwrap().push(format!("update:{id}"));
        Ok(item)
    }
    async fn delete(&self, _calendar: &str, id: &str) -> Result<(), String> {
        self.events.lock().unwrap().retain(|e| e["id"] != id);
        self.calls.lock().unwrap().push(format!("delete:{id}"));
        Ok(())
    }
}

#[derive(Default)]
struct MemoryStore {
    events: Vec<LocalEvent>,
    calendar: Option<String>,
    token: Option<String>,
    last: Option<DateTime<Utc>>,
    conflicts: Vec<(Uuid, Side)>,
}
impl Store for MemoryStore {
    async fn state(&mut self) -> Result<SyncState, String> {
        Ok(SyncState {
            calendar_id: self.calendar.clone(),
            sync_token: self.token.clone(),
            last_synced_at: self.last,
        })
    }
    async fn save_state(
        &mut self,
        calendar: &str,
        token: Option<&str>,
        at: DateTime<Utc>,
        _error: Option<&str>,
    ) -> Result<(), String> {
        self.calendar = Some(calendar.into());
        self.token = token.map(str::to_owned);
        self.last = Some(at);
        Ok(())
    }
    async fn events(&mut self) -> Result<Vec<LocalEvent>, String> {
        Ok(self.events.clone())
    }
    async fn apply_remote(
        &mut self,
        local: Option<Uuid>,
        remote: &RemoteEvent,
    ) -> Result<(), String> {
        match local {
            Some(id) if remote.fields.deleted => self.events.retain(|e| e.id != id),
            Some(id) => {
                let event = self.events.iter_mut().find(|e| e.id == id).unwrap();
                event.fields = remote.fields.clone();
                event.google_id = Some(remote.google_id.clone());
                event.remote_updated_at = Some(remote.updated);
                event.local_updated_at = remote.updated;
            }
            None => self.events.push(LocalEvent {
                id: Uuid::new_v4(),
                fields: remote.fields.clone(),
                link: LinkKind::None,
                google_id: Some(remote.google_id.clone()),
                google_etag: None,
                local_updated_at: remote.updated,
                remote_updated_at: Some(remote.updated),
            }),
        }
        Ok(())
    }
    async fn mark_pushed(
        &mut self,
        id: Uuid,
        google_id: &str,
        _etag: &str,
        updated: DateTime<Utc>,
    ) -> Result<(), String> {
        let event = self.events.iter_mut().find(|e| e.id == id).unwrap();
        event.google_id = Some(google_id.into());
        event.remote_updated_at = Some(updated);
        Ok(())
    }
    async fn record_conflict(
        &mut self,
        id: Uuid,
        winner: Side,
        _losing: Value,
    ) -> Result<(), String> {
        self.conflicts.push((id, winner));
        Ok(())
    }
    async fn purge(&mut self, id: Uuid) -> Result<(), String> {
        self.events.retain(|e| e.id != id);
        Ok(())
    }
}

fn sync_now(api: &FakeGoogle, store: &mut MemoryStore, hour: u32) -> SyncReport {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(sync(
            api,
            store,
            Utc.with_ymd_and_hms(2026, 10, 29, hour, 0, 0).unwrap(),
        ))
        .unwrap()
}

#[test]
fn a_sync_creates_the_calendar_pushes_new_events_and_is_idempotent() {
    let api = FakeGoogle::default();
    let mut store = MemoryStore::default();
    store.events.push(local("기획 회의", None, 8, None));
    let first = sync_now(&api, &mut store, 1);
    assert_eq!(first.pushed, 1);
    assert_eq!(api.calls.lock().unwrap()[0], "create_calendar");
    assert_eq!(store.events[0].google_id.as_deref(), Some("g1"));
    let second = sync_now(&api, &mut store, 2);
    assert_eq!(
        second,
        SyncReport::default(),
        "nothing changed, nothing sent: {second:?}"
    );
    assert_eq!(
        api.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.starts_with("insert") || c.starts_with("update"))
            .count(),
        1
    );
}

#[test]
fn google_edits_and_new_google_events_come_back_and_deletes_flow_both_ways() {
    let api = FakeGoogle::default();
    let mut store = MemoryStore::default();
    store.events.push(local("원래 제목", None, 8, None));
    sync_now(&api, &mut store, 1);
    api.edit("g1", "구글에서 고침");
    api.events.lock().unwrap().push(json!({"id":"phone","etag":"e","updated":"2026-10-28T05:00:00Z","summary":"폰에서 만든 일정","start":{"dateTime":"2026-10-30T10:00:00Z"},"end":{"dateTime":"2026-10-30T11:00:00Z"}}));
    let report = sync_now(&api, &mut store, 2);
    assert_eq!((report.pulled, report.imported), (1, 1), "{report:?}");
    assert!(store
        .events
        .iter()
        .any(|e| e.fields.title == "구글에서 고침"));
    assert!(store
        .events
        .iter()
        .any(|e| e.fields.title == "폰에서 만든 일정"));
    // Delete locally: the next sync removes it from Google and purges the row.
    let target = store
        .events
        .iter_mut()
        .find(|e| e.fields.title == "폰에서 만든 일정")
        .unwrap();
    target.fields.deleted = true;
    target.local_updated_at = Utc.with_ymd_and_hms(2026, 10, 29, 3, 0, 0).unwrap();
    let report = sync_now(&api, &mut store, 4);
    assert_eq!(report.deleted, 1, "{report:?}");
    assert!(!api
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| e["id"] == "phone"));
    assert!(!store
        .events
        .iter()
        .any(|e| e.fields.title == "폰에서 만든 일정"));
}

#[test]
fn an_expired_sync_token_falls_back_to_a_full_listing() {
    let api = FakeGoogle::default();
    let mut store = MemoryStore::default();
    store.events.push(local("a", None, 8, None));
    sync_now(&api, &mut store, 1);
    *api.gone_once.lock().unwrap() = true;
    let report = sync_now(&api, &mut store, 2);
    assert!(report.full_resync);
    let calls = api.calls.lock().unwrap();
    assert!(
        calls.iter().any(|c| c == "list:tok")
            && calls.iter().filter(|c| *c == "list:full").count() == 2,
        "{calls:?}"
    );
    assert_eq!(store.token.as_deref(), Some("tok"));
}

#[test]
fn a_moved_publication_event_is_put_back_and_logged() {
    let api = FakeGoogle::default();
    let mut store = MemoryStore::default();
    let mut owned = local("게시 예약 · youtube · 신제품", None, 8, None);
    owned.link = LinkKind::PublicationJob;
    store.events.push(owned);
    sync_now(&api, &mut store, 1);
    api.edit("g1", "누가 시간을 옮김");
    let report = sync_now(&api, &mut store, 2);
    assert_eq!(report.reverted, 1);
    assert_eq!(
        store.events[0].fields.title, "게시 예약 · youtube · 신제품",
        "Studio's version stays"
    );
    let google = api.events.lock().unwrap();
    assert_eq!(
        google.iter().find(|e| e["id"] == "g1").unwrap()["summary"],
        "게시 예약 · youtube · 신제품",
        "and Google is put back"
    );
    assert_eq!(store.conflicts, vec![(store.events[0].id, Side::Local)]);
}

#[tokio::test]
#[ignore = "Requires TORIS_PUBLICATIONS_TEST_DB pointing to an isolated toris_publications_test_* database (scripts/verify-publication-db.mjs)"]
async fn postgres_store_runs_the_real_sync_and_mirrors_scheduled_publications() {
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
    let db = crate::social::database(&config).await.unwrap();
    let client = &db.client;
    client.batch_execute("DELETE FROM calendar_conflicts; DELETE FROM calendar_events; UPDATE calendar_sync_state SET calendar_id=NULL,sync_token=NULL,last_synced_at=NULL,last_error=NULL;").await.unwrap();
    // A scheduled publication appears as a Studio-owned event.
    let publication = Uuid::new_v4();
    let job = Uuid::new_v4();
    let when = Utc::now() + Duration::days(2);
    client
        .execute(
            "INSERT INTO publications(id,payload) VALUES($1,$2)",
            &[&publication, &json!({"title":"신제품 영상"})],
        )
        .await
        .unwrap();
    client.execute("INSERT INTO publication_jobs(id,publication_id,revision,target_id,approval_hash,snapshot,mode,status,scheduled_at) VALUES($1,$2,1,$3,$4,$5,'scheduled','scheduled',$6)",
        &[&job, &publication, &Uuid::new_v4(), &"0".repeat(64), &json!({"platform":"youtube"}), &when]).await.unwrap();
    let manual = save_event(
        client,
        &json!({"title":"촬영","startsAt":(Utc::now() + Duration::days(1)).to_rfc3339()}),
    )
    .await
    .unwrap();
    let view = today(
        client,
        Utc::now() - Duration::days(1),
        Utc::now() + Duration::days(7),
    )
    .await
    .unwrap();
    let events = view["events"].as_array().unwrap();
    assert_eq!(events.len(), 2, "{view}");
    let owned = events
        .iter()
        .find(|e| e["link"] == "publication_job")
        .unwrap();
    assert_eq!(owned["studioOwned"], true);
    assert!(
        owned["title"].as_str().unwrap().contains("youtube")
            && owned["title"].as_str().unwrap().contains("신제품 영상")
    );
    assert!(
        save_event(
            client,
            &json!({"id":owned["id"],"title":"옮김","startsAt":Utc::now().to_rfc3339()})
        )
        .await
        .is_err(),
        "publication events are changed in the publisher"
    );
    assert!(delete_event(client, owned["id"].as_str().unwrap())
        .await
        .is_err());
    // Sync through the real DB store and a fake Google.
    let api = FakeGoogle::default();
    let mut store = DbStore { client };
    let first = sync(&api, &mut store, Utc::now()).await.unwrap();
    assert_eq!(first.pushed, 2, "{first:?}");
    let second = sync(&api, &mut store, Utc::now()).await.unwrap();
    assert_eq!(
        second,
        SyncReport::default(),
        "idempotent against the real DB: {second:?}"
    );
    // Cancelling the publication removes its event on the next mirror + sync.
    client
        .execute(
            "UPDATE publication_jobs SET status='cancelled' WHERE id=$1",
            &[&job],
        )
        .await
        .unwrap();
    mirror_publications(client).await.unwrap();
    let third = sync(&api, &mut store, Utc::now()).await.unwrap();
    assert_eq!(third.deleted, 1, "{third:?}");
    assert_eq!(
        api.events.lock().unwrap().len(),
        1,
        "only the manual event remains in Google"
    );
    let left = today(
        client,
        Utc::now() - Duration::days(1),
        Utc::now() + Duration::days(7),
    )
    .await
    .unwrap();
    assert_eq!(left["events"].as_array().unwrap().len(), 1);
    assert_eq!(left["events"][0]["id"], manual["id"]);
    let work = save_work_item(
        client,
        &json!({"title":"스토어 문구 검토","dueAt":(Utc::now() + Duration::days(3)).to_rfc3339()}),
    )
    .await
    .unwrap();
    assert_eq!(work["status"], "todo");
    assert_eq!(
        today(client, Utc::now(), Utc::now() + Duration::days(1))
            .await
            .unwrap()["work"][0]["title"],
        "스토어 문구 검토"
    );
    client
        .batch_execute(
            "DELETE FROM calendar_events; DELETE FROM work_items; DELETE FROM publications;",
        )
        .await
        .unwrap();
}
