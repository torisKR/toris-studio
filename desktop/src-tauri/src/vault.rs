//! macOS keeps the desktop's credentials in one encrypted, app-owned Keychain
//! item. Native Keychain creation retains its default caller-only trust; this
//! module never replaces ACLs or grants access to other applications.
//!
//! Threat model: a denied/failed read must not become a missing credential or a
//! polling-induced prompt loop. Migration commits only authorized legacy reads,
//! retains the old items, and caches nothing as committed before the OS write
//! succeeds. Explicit disconnects also erase the corresponding legacy item.
//! The cache is process memory only. Ad hoc signatures change on rebuild, so a
//! different build can still require approval; no identifier-only trust is used.

#[cfg(any(target_os = "macos", test))]
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "macos", test))]
use std::collections::{BTreeMap, HashMap};
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};

#[cfg(any(target_os = "macos", test))]
const SERVICE: &str = "kr.toris.studio.vault";
#[cfg(any(target_os = "macos", test))]
const ACCOUNT: &str = "desktop-secrets-v2";
#[cfg(any(target_os = "macos", test))]
const SETTINGS_SERVICE: &str = "kr.toris.studio.settings";
#[cfg(any(target_os = "macos", test))]
const OAUTH_SERVICE: &str = "kr.toris.studio.oauth.v1";
#[cfg(any(target_os = "macos", test))]
const MAX_RECORD: usize = 65_536;
#[cfg(any(target_os = "macos", test))]
const MAX_ENVELOPE: usize = 1_500_000;

pub fn error() -> String {
    "OS 자격 증명 저장소 접근이 보류되었습니다. 연결 설정에서 ‘저장소 권한 다시 확인’을 누르세요."
        .into()
}

#[cfg(any(target_os = "macos", test))]
fn slot(service: &str, account: &str) -> Result<String, String> {
    if service == SETTINGS_SERVICE {
        let field = account
            .strip_prefix("connection-secrets-v1:")
            .ok_or_else(error)?;
        if [
            "databaseUrl",
            "opencodexApiKey",
            "teamclaudeApiKey",
            "youtubeApiKey",
            "naverClientId",
            "naverClientSecret",
        ]
        .contains(&field)
        {
            return Ok(format!("settings:{field}"));
        }
    } else if service == OAUTH_SERVICE {
        if let Some((kind, provider)) = account.split_once(':') {
            if ["client", "session", "audit"].contains(&kind)
                && ["youtube", "threads", "naver_blog", "tiktok", "instagram"].contains(&provider)
            {
                return Ok(format!("oauth:{account}"));
            }
        }
    }
    Err(error())
}

#[cfg(any(target_os = "macos", test))]
fn valid_slot(key: &str) -> bool {
    if let Some(field) = key.strip_prefix("settings:") {
        slot(SETTINGS_SERVICE, &format!("connection-secrets-v1:{field}")).is_ok()
    } else if let Some(account) = key.strip_prefix("oauth:") {
        slot(OAUTH_SERVICE, account).is_ok()
    } else {
        false
    }
}

#[cfg(any(target_os = "macos", test))]
fn valid_value(key: &str, value: &Option<String>) -> bool {
    let maximum = if key.starts_with("settings:") {
        2048
    } else {
        MAX_RECORD
    };
    value.as_ref().map_or(true, |value| value.len() <= maximum)
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    schema_version: u8,
    // None is an explicit tombstone, preventing a disconnected legacy token
    // from being imported again after a restart.
    entries: BTreeMap<String, Option<String>>,
}

#[cfg(any(target_os = "macos", test))]
impl Default for Envelope {
    fn default() -> Self {
        Self {
            schema_version: 2,
            entries: BTreeMap::new(),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
impl Envelope {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 2
            || self.entries.len() > 21
            || self
                .entries
                .iter()
                .any(|(key, value)| !valid_slot(key) || !valid_value(key, value))
        {
            return Err(error());
        }
        Ok(())
    }

    fn decode(raw: &str) -> Result<Self, String> {
        if raw.len() > MAX_ENVELOPE {
            return Err(error());
        }
        let parsed: Self = serde_json::from_str(raw).map_err(|_| error())?;
        parsed.validate()?;
        Ok(parsed)
    }

    fn encode(&self) -> Result<String, String> {
        self.validate()?;
        let raw = serde_json::to_string(self).map_err(|_| error())?;
        if raw.len() > MAX_ENVELOPE {
            return Err(error());
        }
        Ok(raw)
    }
}

#[cfg(any(target_os = "macos", test))]
trait Backend {
    fn read(&mut self, service: &str, account: &str) -> Result<Option<String>, ()>;
    fn write(&mut self, service: &str, account: &str, value: &str) -> Result<(), ()>;
    fn delete(&mut self, service: &str, account: &str) -> Result<(), ()>;
    fn revision(&mut self) -> Result<Option<String>, ()> {
        Ok(None)
    }
    fn commit(
        &mut self,
        changes: &BTreeMap<String, Option<String>>,
        replace: bool,
    ) -> Result<(Envelope, Option<String>), ()> {
        let latest = commit_unlocked(self, changes, replace)?;
        Ok((latest, self.revision()?))
    }
}

#[cfg(any(target_os = "macos", test))]
fn commit_unlocked<B: Backend + ?Sized>(
    backend: &mut B,
    changes: &BTreeMap<String, Option<String>>,
    replace: bool,
) -> Result<Envelope, ()> {
    let mut latest = backend
        .read(SERVICE, ACCOUNT)?
        .map(|raw| Envelope::decode(&raw))
        .transpose()
        .map_err(|_| ())?
        .unwrap_or_default();
    for (key, value) in changes {
        if replace {
            latest.entries.insert(key.clone(), value.clone());
        } else {
            latest
                .entries
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }
    let raw = latest.encode().map_err(|_| ())?;
    backend.write(SERVICE, ACCOUNT, &raw)?;
    Ok(latest)
}

#[cfg(any(target_os = "macos", test))]
enum Snapshot {
    Unloaded,
    Ready(Envelope),
    Blocked,
}

#[cfg(any(target_os = "macos", test))]
struct Vault<B> {
    backend: B,
    snapshot: Snapshot,
    legacy: HashMap<String, Result<Option<String>, ()>>,
    write_blocked: bool,
    revision: Option<String>,
}

#[cfg(any(target_os = "macos", test))]
impl<B: Backend> Vault<B> {
    fn new(backend: B) -> Self {
        Self {
            backend,
            snapshot: Snapshot::Unloaded,
            legacy: HashMap::new(),
            write_blocked: false,
            revision: None,
        }
    }

    fn blocked(&self) -> bool {
        matches!(self.snapshot, Snapshot::Blocked)
            || self.write_blocked
            || self.legacy.values().any(Result::is_err)
    }

    fn retry(&mut self) {
        if matches!(self.snapshot, Snapshot::Blocked) {
            self.snapshot = Snapshot::Unloaded;
        }
        self.write_blocked = false;
        // Keep successful reads in memory; a retry must not re-prompt for items
        // already authorized during this process.
        self.legacy.retain(|_, value| value.is_ok());
    }

    fn load(&mut self) -> Result<Envelope, String> {
        if matches!(self.snapshot, Snapshot::Blocked) {
            return Err(error());
        }
        let revision = match self.backend.revision() {
            Ok(revision) => revision,
            Err(_) => {
                self.snapshot = Snapshot::Blocked;
                return Err(error());
            }
        };
        if !matches!(self.snapshot, Snapshot::Unloaded) && revision != self.revision {
            // A different desktop/CLI process updated the vault. Never serve an
            // old token after its tombstone or replacement has been committed.
            if self.blocked() {
                return Err(error());
            }
            self.snapshot = Snapshot::Unloaded;
        }
        if matches!(self.snapshot, Snapshot::Unloaded) {
            let loaded = self
                .backend
                .read(SERVICE, ACCOUNT)
                .map_err(|_| error())
                .and_then(|raw| raw.map(|raw| Envelope::decode(&raw)).transpose());
            self.snapshot = match loaded {
                Ok(envelope) => Snapshot::Ready(envelope.unwrap_or_default()),
                Err(_) => Snapshot::Blocked,
            };
            self.revision = revision;
        }
        match &self.snapshot {
            Snapshot::Ready(envelope) => Ok(envelope.clone()),
            _ => Err(error()),
        }
    }

    fn commit(
        &mut self,
        changes: BTreeMap<String, Option<String>>,
        replace: bool,
    ) -> Result<(), String> {
        if self.blocked() {
            return Err(error());
        }
        match self.backend.commit(&changes, replace) {
            Ok((envelope, revision)) => {
                self.snapshot = Snapshot::Ready(envelope);
                // The native writer publishes a non-secret generation marker
                // before changing Keychain, while holding its cross-process lock.
                self.revision = revision;
                Ok(())
            }
            Err(_) => {
                self.write_blocked = true;
                Err(error())
            }
        }
    }

    fn read_many(
        &mut self,
        service: &str,
        accounts: &[&str],
    ) -> Result<Vec<Option<String>>, String> {
        let keys = accounts
            .iter()
            .map(|account| slot(service, account))
            .collect::<Result<Vec<_>, _>>()?;
        let mut candidate = self.load()?;
        let mut changes = BTreeMap::new();
        for (account, key) in accounts.iter().zip(keys.iter()) {
            if candidate.entries.contains_key(key) {
                continue;
            }
            if self.blocked() {
                return Err(error());
            }
            let result = if let Some(cached) = self.legacy.get(key) {
                cached.clone()
            } else {
                let result = self.backend.read(service, account).and_then(|value| {
                    if !valid_value(key, &value) {
                        Err(())
                    } else {
                        Ok(value)
                    }
                });
                self.legacy.insert(key.clone(), result.clone());
                result
            };
            let value = result.map_err(|_| error())?;
            candidate.entries.insert(key.clone(), value.clone());
            changes.insert(key.clone(), value);
        }
        if !changes.is_empty() {
            self.commit(changes, false)?;
            candidate = self.load()?;
        }
        Ok(keys
            .iter()
            .map(|key| candidate.entries.get(key).cloned().flatten())
            .collect())
    }

    fn write_many(&mut self, service: &str, entries: &[(&str, &str)]) -> Result<(), String> {
        if self.blocked() {
            return Err(error());
        }
        let keys = entries
            .iter()
            .map(|(account, value)| {
                let key = slot(service, account)?;
                if !valid_value(&key, &Some((*value).into())) {
                    return Err(error());
                }
                Ok(key)
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.load()?;
        let mut changes = BTreeMap::new();
        for (key, (_, value)) in keys.iter().zip(entries.iter()) {
            changes.insert(key.clone(), Some((*value).into()));
        }
        if !entries.is_empty() {
            self.commit(changes, true)?;
        }
        Ok(())
    }

    fn delete(&mut self, service: &str, account: &str) -> Result<(), String> {
        if self.blocked() {
            return Err(error());
        }
        let key = slot(service, account)?;
        self.load()?;
        self.commit(BTreeMap::from([(key.clone(), None)]), true)?;
        // Migration itself is non-destructive. A user-requested disconnect is
        // different: remove the old record as well, after persisting a tombstone.
        match self.backend.delete(service, account) {
            Ok(()) => {
                self.legacy.insert(key, Ok(None));
                Ok(())
            }
            Err(_) => {
                self.legacy.insert(key, Err(()));
                Err(error())
            }
        }
    }
}

#[cfg(target_os = "macos")]
struct NativeBackend;

#[cfg(target_os = "macos")]
struct FileLock(std::fs::File);

#[cfg(target_os = "macos")]
impl FileLock {
    fn acquire(exclusive: bool) -> Result<Self, ()> {
        let directory = dirs::config_dir().ok_or(())?.join("kr.toris.studio");
        Self::acquire_in(&directory, exclusive)
    }

    fn acquire_in(directory: &std::path::Path, exclusive: bool) -> Result<Self, ()> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)
            .map_err(|_| ())?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory.join("vault-coordination.lock"))
            .map_err(|_| ())?;
        let metadata = file.metadata().map_err(|_| ())?;
        // Do not follow a substituted symlink or use a shared coordination file.
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(());
        }
        let operation = if exclusive {
            libc::LOCK_EX
        } else {
            libc::LOCK_SH
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            // SAFETY: fd belongs to this open File; flock does not access Rust
            // memory. The File stays alive until the RAII lock is released.
            if unsafe { libc::flock(file.as_raw_fd(), operation | libc::LOCK_NB) } == 0 {
                return Ok(Self(file));
            }
            if std::io::Error::last_os_error().kind() != std::io::ErrorKind::WouldBlock
                || std::time::Instant::now() >= deadline
            {
                return Err(());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    fn revision(&mut self) -> Result<Option<String>, ()> {
        use std::io::{Read, Seek, SeekFrom};
        self.0.seek(SeekFrom::Start(0)).map_err(|_| ())?;
        let mut value = String::new();
        (&mut self.0)
            .take(65)
            .read_to_string(&mut value)
            .map_err(|_| ())?;
        if value.is_empty() {
            return Ok(None);
        }
        if value.len() != 36 || uuid::Uuid::parse_str(&value).is_err() {
            return Err(());
        }
        Ok(Some(value))
    }

    fn publish(&mut self, revision: &str) -> Result<(), ()> {
        use std::io::{Seek, SeekFrom, Write};
        self.0.seek(SeekFrom::Start(0)).map_err(|_| ())?;
        self.0.set_len(0).map_err(|_| ())?;
        self.0.write_all(revision.as_bytes()).map_err(|_| ())?;
        self.0.sync_all().map_err(|_| ())
    }
}

#[cfg(target_os = "macos")]
impl Drop for FileLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: the live descriptor was locked by acquire; closing also
        // releases the lock if an OS unlock error occurs.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(target_os = "macos")]
impl Backend for NativeBackend {
    fn read(&mut self, service: &str, account: &str) -> Result<Option<String>, ()> {
        let entry = keyring::Entry::new(service, account).map_err(|_| ())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }
    fn write(&mut self, service: &str, account: &str, value: &str) -> Result<(), ()> {
        keyring::Entry::new(service, account)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| ())
    }
    fn delete(&mut self, service: &str, account: &str) -> Result<(), ()> {
        let entry = keyring::Entry::new(service, account).map_err(|_| ())?;
        match entry.delete_credential() {
            // keyring's legacy macOS deletion wrapper discards the native
            // delete status. Confirm absence rather than claiming removal on
            // that return value alone; never expose any surviving value.
            Ok(()) => match entry.get_password() {
                Err(keyring::Error::NoEntry) => Ok(()),
                _ => Err(()),
            },
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
    fn revision(&mut self) -> Result<Option<String>, ()> {
        FileLock::acquire(false)?.revision()
    }
    fn commit(
        &mut self,
        changes: &BTreeMap<String, Option<String>>,
        replace: bool,
    ) -> Result<(Envelope, Option<String>), ()> {
        let mut lock = FileLock::acquire(true)?;
        let revision = uuid::Uuid::new_v4().to_string();
        // Publish before the OS write: if the process exits immediately after
        // Keychain commits, every other process still notices the change. A
        // failed Keychain write only causes a harmless refresh of old data.
        lock.publish(&revision)?;
        let latest = commit_unlocked(self, changes, replace)?;
        Ok((latest, Some(revision)))
    }
}

#[cfg(target_os = "macos")]
fn instance() -> &'static Mutex<Vault<NativeBackend>> {
    static INSTANCE: OnceLock<Mutex<Vault<NativeBackend>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(Vault::new(NativeBackend)))
}

#[cfg(target_os = "macos")]
pub fn read_many(service: &str, accounts: &[&str]) -> Result<Vec<Option<String>>, String> {
    instance()
        .lock()
        .map_err(|_| error())?
        .read_many(service, accounts)
}
#[cfg(target_os = "macos")]
pub fn read(service: &str, account: &str) -> Result<Option<String>, String> {
    read_many(service, &[account]).map(|mut values| values.remove(0))
}
#[cfg(target_os = "macos")]
pub fn write_many(service: &str, entries: &[(&str, &str)]) -> Result<(), String> {
    instance()
        .lock()
        .map_err(|_| error())?
        .write_many(service, entries)
}
#[cfg(target_os = "macos")]
pub fn write(service: &str, account: &str, value: &str) -> Result<(), String> {
    write_many(service, &[(account, value)])
}
#[cfg(target_os = "macos")]
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    instance()
        .lock()
        .map_err(|_| error())?
        .delete(service, account)
}

/// Read-only status; checking it never calls the OS vault or shows a dialog.
pub fn access_blocked() -> bool {
    #[cfg(target_os = "macos")]
    {
        match instance().try_lock() {
            Ok(vault) => vault.blocked(),
            // A Keychain operation may be awaiting the user's OS confirmation.
            // The status command must never wait on that operation or show a
            // second dialog; its caller already has an explicit loading state.
            Err(std::sync::TryLockError::WouldBlock) => false,
            Err(std::sync::TryLockError::Poisoned(_)) => true,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Called only by the explicit native retry action, never by status polling.
pub fn retry_access() {
    #[cfg(target_os = "macos")]
    if let Ok(mut vault) = instance().lock() {
        vault.retry();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct MemoryBackend {
        values: HashMap<(String, String), String>,
        reads: HashMap<(String, String), usize>,
        writes: usize,
        read_denied: Option<(String, String)>,
        write_denied: bool,
        delete_denied: bool,
    }
    fn pair(service: &str, account: &str) -> (String, String) {
        (service.into(), account.into())
    }
    impl Backend for MemoryBackend {
        fn read(&mut self, service: &str, account: &str) -> Result<Option<String>, ()> {
            let key = pair(service, account);
            *self.reads.entry(key.clone()).or_default() += 1;
            if self.read_denied.as_ref() == Some(&key) {
                Err(())
            } else {
                Ok(self.values.get(&key).cloned())
            }
        }
        fn write(&mut self, service: &str, account: &str, value: &str) -> Result<(), ()> {
            self.writes += 1;
            if self.write_denied {
                return Err(());
            }
            self.values.insert(pair(service, account), value.into());
            Ok(())
        }
        fn delete(&mut self, service: &str, account: &str) -> Result<(), ()> {
            if self.delete_denied {
                return Err(());
            }
            self.values.remove(&pair(service, account));
            Ok(())
        }
    }
    const YOUTUBE: &str = "connection-secrets-v1:youtubeApiKey";
    const NAVER: &str = "connection-secrets-v1:naverClientSecret";

    #[test]
    fn authorized_migration_preserves_legacy_and_restarts_without_legacy_reads() {
        let mut backend = MemoryBackend::default();
        backend
            .values
            .insert(pair(SETTINGS_SERVICE, YOUTUBE), "synthetic-key".into());
        let mut vault = Vault::new(backend);
        assert_eq!(
            vault
                .read_many(SETTINGS_SERVICE, &[YOUTUBE, NAVER])
                .unwrap(),
            [Some("synthetic-key".into()), None]
        );
        assert_eq!(vault.backend.writes, 1);
        assert!(vault
            .backend
            .values
            .contains_key(&pair(SETTINGS_SERVICE, YOUTUBE)));
        for _ in 0..20 {
            assert_eq!(
                vault.read_many(SETTINGS_SERVICE, &[YOUTUBE]).unwrap(),
                [Some("synthetic-key".into())]
            );
        }
        assert_eq!(vault.backend.reads[&pair(SETTINGS_SERVICE, YOUTUBE)], 1);
        let root_reads_before_restart = vault.backend.reads[&pair(SERVICE, ACCOUNT)];
        let mut restarted = Vault::new(vault.backend);
        assert_eq!(
            restarted
                .read_many(SETTINGS_SERVICE, &[YOUTUBE, NAVER])
                .unwrap(),
            [Some("synthetic-key".into()), None]
        );
        assert_eq!(
            restarted.backend.reads[&pair(SERVICE, ACCOUNT)],
            root_reads_before_restart + 1
        );
        assert_eq!(restarted.backend.reads[&pair(SETTINGS_SERVICE, YOUTUBE)], 1);
        assert_eq!(restarted.backend.writes, 1);
    }

    #[test]
    fn denied_legacy_read_stops_polling_prompts_until_explicit_retry() {
        let mut backend = MemoryBackend::default();
        backend.read_denied = Some(pair(SETTINGS_SERVICE, YOUTUBE));
        let mut vault = Vault::new(backend);
        for _ in 0..20 {
            assert!(vault.read_many(SETTINGS_SERVICE, &[YOUTUBE]).is_err());
        }
        assert!(vault.blocked());
        assert_eq!(vault.backend.reads[&pair(SETTINGS_SERVICE, YOUTUBE)], 1);
        assert_eq!(vault.backend.writes, 0);
        assert!(vault
            .read_many(OAUTH_SERVICE, &["client:instagram"])
            .is_err());
        assert!(!vault
            .backend
            .reads
            .contains_key(&pair(OAUTH_SERVICE, "client:instagram")));
        assert!(vault.write_many(SETTINGS_SERVICE, &[]).is_err());
        assert_eq!(vault.backend.writes, 0);
        vault.backend.read_denied = None;
        vault
            .backend
            .values
            .insert(pair(SETTINGS_SERVICE, YOUTUBE), "allowed-now".into());
        assert!(vault.read_many(SETTINGS_SERVICE, &[YOUTUBE]).is_err());
        vault.retry();
        assert_eq!(
            vault.read_many(SETTINGS_SERVICE, &[YOUTUBE]).unwrap(),
            [Some("allowed-now".into())]
        );
        assert!(!vault.blocked());
    }

    #[test]
    fn denied_envelope_never_falls_back_to_legacy_or_reprompts() {
        let mut backend = MemoryBackend::default();
        backend
            .values
            .insert(pair(SETTINGS_SERVICE, YOUTUBE), "must-not-fallback".into());
        backend.read_denied = Some(pair(SERVICE, ACCOUNT));
        let mut vault = Vault::new(backend);
        for _ in 0..20 {
            assert!(vault.read_many(SETTINGS_SERVICE, &[YOUTUBE]).is_err());
        }
        assert_eq!(vault.backend.reads.len(), 1);
        assert_eq!(vault.backend.reads[&pair(SERVICE, ACCOUNT)], 1);
        assert!(vault
            .write_many(SETTINGS_SERVICE, &[(YOUTUBE, "replacement")])
            .is_err());
        assert_eq!(vault.backend.writes, 0);
    }

    #[test]
    fn failed_migration_write_is_atomic_and_retry_reuses_authorized_read() {
        let mut backend = MemoryBackend::default();
        backend
            .values
            .insert(pair(SETTINGS_SERVICE, YOUTUBE), "synthetic-key".into());
        backend.write_denied = true;
        let mut vault = Vault::new(backend);
        for _ in 0..20 {
            assert!(vault.read_many(SETTINGS_SERVICE, &[YOUTUBE]).is_err());
        }
        assert!(!vault.backend.values.contains_key(&pair(SERVICE, ACCOUNT)));
        assert_eq!(vault.backend.writes, 1);
        assert_eq!(vault.backend.reads[&pair(SETTINGS_SERVICE, YOUTUBE)], 1);
        vault.backend.write_denied = false;
        vault.retry();
        assert_eq!(
            vault.read_many(SETTINGS_SERVICE, &[YOUTUBE]).unwrap(),
            [Some("synthetic-key".into())]
        );
        assert_eq!(vault.backend.reads[&pair(SETTINGS_SERVICE, YOUTUBE)], 1);
        assert_eq!(vault.backend.writes, 2);
    }

    #[test]
    fn cache_writes_are_coherent_and_disconnect_cannot_resurrect_legacy_tokens() {
        let mut backend = MemoryBackend::default();
        backend
            .values
            .insert(pair(OAUTH_SERVICE, "session:youtube"), "old-token".into());
        let mut vault = Vault::new(backend);
        vault
            .write_many(OAUTH_SERVICE, &[("session:youtube", "new-token")])
            .unwrap();
        assert_eq!(
            vault
                .read_many(OAUTH_SERVICE, &["session:youtube"])
                .unwrap(),
            [Some("new-token".into())]
        );
        vault.delete(OAUTH_SERVICE, "session:youtube").unwrap();
        assert!(!vault
            .backend
            .values
            .contains_key(&pair(OAUTH_SERVICE, "session:youtube")));
        let mut restarted = Vault::new(vault.backend);
        assert_eq!(
            restarted
                .read_many(OAUTH_SERVICE, &["session:youtube"])
                .unwrap(),
            [None]
        );
        assert!(!restarted
            .backend
            .reads
            .contains_key(&pair(OAUTH_SERVICE, "session:youtube")));
    }

    #[test]
    fn failed_disconnect_cleanup_still_keeps_committed_tombstone() {
        let mut backend = MemoryBackend::default();
        backend
            .values
            .insert(pair(OAUTH_SERVICE, "session:youtube"), "old-token".into());
        backend.delete_denied = true;
        let mut vault = Vault::new(backend);
        assert!(vault.delete(OAUTH_SERVICE, "session:youtube").is_err());
        assert!(vault.blocked());
        let mut restarted = Vault::new(vault.backend);
        assert_eq!(
            restarted
                .read_many(OAUTH_SERVICE, &["session:youtube"])
                .unwrap(),
            [None]
        );
    }

    #[test]
    fn malformed_envelope_and_unknown_records_fail_closed() {
        for raw in [
            "{}",
            r#"{"schemaVersion":1,"entries":{}}"#,
            r#"{"schemaVersion":2,"entries":{"oauth:session:attacker":"data"}}"#,
            r#"{"schemaVersion":2,"entries":{},"unknown":"field"}"#,
        ] {
            let mut backend = MemoryBackend::default();
            backend.values.insert(pair(SERVICE, ACCOUNT), raw.into());
            let mut vault = Vault::new(backend);
            assert!(vault.read_many(SETTINGS_SERVICE, &[YOUTUBE]).is_err());
            assert!(vault.blocked());
            assert_eq!(vault.backend.reads.len(), 1);
        }
        let mut vault = Vault::new(MemoryBackend::default());
        assert!(vault.read_many("unrelated-service", &[YOUTUBE]).is_err());
        assert!(vault
            .write_many(
                OAUTH_SERVICE,
                &[("session:youtube", &"x".repeat(MAX_RECORD + 1))]
            )
            .is_err());
        assert!(vault.backend.reads.is_empty());
        let mut backend = MemoryBackend::default();
        backend
            .values
            .insert(pair(SETTINGS_SERVICE, YOUTUBE), "x".repeat(2049));
        let mut vault = Vault::new(backend);
        assert!(vault.read_many(SETTINGS_SERVICE, &[YOUTUBE]).is_err());
        assert!(vault.blocked());
        assert_eq!(vault.backend.writes, 0);
    }

    #[derive(Clone, Default)]
    struct SharedBackend(std::sync::Arc<std::sync::Mutex<MemoryBackend>>);
    impl Backend for SharedBackend {
        fn read(&mut self, service: &str, account: &str) -> Result<Option<String>, ()> {
            self.0.lock().unwrap().read(service, account)
        }
        fn write(&mut self, service: &str, account: &str, value: &str) -> Result<(), ()> {
            self.0.lock().unwrap().write(service, account, value)
        }
        fn delete(&mut self, service: &str, account: &str) -> Result<(), ()> {
            self.0.lock().unwrap().delete(service, account)
        }
        fn revision(&mut self) -> Result<Option<String>, ()> {
            Ok(Some(self.0.lock().unwrap().writes.to_string()))
        }
        fn commit(
            &mut self,
            changes: &BTreeMap<String, Option<String>>,
            replace: bool,
        ) -> Result<(Envelope, Option<String>), ()> {
            let mut backend = self.0.lock().unwrap();
            let latest = commit_unlocked(&mut *backend, changes, replace)?;
            Ok((latest, Some(backend.writes.to_string())))
        }
    }

    #[test]
    fn separate_process_snapshots_merge_writes_and_notice_disconnects() {
        let backend = SharedBackend::default();
        let mut app = Vault::new(backend.clone());
        let mut cli = Vault::new(backend.clone());
        app.read_many(SETTINGS_SERVICE, &[YOUTUBE]).unwrap();
        cli.read_many(OAUTH_SERVICE, &["session:youtube"]).unwrap();
        app.write_many(OAUTH_SERVICE, &[("session:youtube", "rotated-token")])
            .unwrap();
        cli.write_many(SETTINGS_SERVICE, &[(YOUTUBE, "new-collection-key")])
            .unwrap();
        assert_eq!(
            app.read_many(SETTINGS_SERVICE, &[YOUTUBE]).unwrap(),
            [Some("new-collection-key".into())]
        );
        assert_eq!(
            cli.read_many(OAUTH_SERVICE, &["session:youtube"]).unwrap(),
            [Some("rotated-token".into())]
        );
        cli.delete(OAUTH_SERVICE, "session:youtube").unwrap();
        assert_eq!(
            app.read_many(OAUTH_SERVICE, &["session:youtube"]).unwrap(),
            [None]
        );
        let saved = backend.0.lock().unwrap().values[&pair(SERVICE, ACCOUNT)].clone();
        let envelope = Envelope::decode(&saved).unwrap();
        assert_eq!(
            envelope.entries["settings:youtubeApiKey"],
            Some("new-collection-key".into())
        );
        assert_eq!(envelope.entries["oauth:session:youtube"], None);
    }

    #[test]
    fn delayed_legacy_migration_does_not_overwrite_a_newer_token_or_tombstone() {
        let mut backend = MemoryBackend::default();
        let mut latest = Envelope::default();
        latest
            .entries
            .insert("oauth:session:youtube".into(), Some("rotated-token".into()));
        latest
            .entries
            .insert("oauth:session:instagram".into(), None);
        backend
            .values
            .insert(pair(SERVICE, ACCOUNT), latest.encode().unwrap());
        let old_reads = BTreeMap::from([
            ("oauth:session:youtube".into(), Some("legacy-token".into())),
            (
                "oauth:session:instagram".into(),
                Some("revoked-legacy-token".into()),
            ),
        ]);
        let committed = commit_unlocked(&mut backend, &old_reads, false).unwrap();
        assert_eq!(
            committed.entries["oauth:session:youtube"],
            Some("rotated-token".into())
        );
        assert_eq!(committed.entries["oauth:session:instagram"], None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn coordination_file_is_private_and_rejects_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let mut lock = FileLock::acquire_in(directory.path(), true).unwrap();
        let revision = uuid::Uuid::new_v4().to_string();
        lock.publish(&revision).unwrap();
        assert_eq!(lock.revision().unwrap(), Some(revision.clone()));
        assert_eq!(
            std::fs::metadata(directory.path().join("vault-coordination.lock"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        drop(lock);
        let mut reader = FileLock::acquire_in(directory.path(), false).unwrap();
        assert_eq!(reader.revision().unwrap(), Some(revision));
        drop(reader);
        std::fs::remove_file(directory.path().join("vault-coordination.lock")).unwrap();
        let target = directory.path().join("substituted");
        std::fs::write(&target, "must-not-follow").unwrap();
        symlink(&target, directory.path().join("vault-coordination.lock")).unwrap();
        assert!(FileLock::acquire_in(directory.path(), true).is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "must-not-follow");
    }
}
