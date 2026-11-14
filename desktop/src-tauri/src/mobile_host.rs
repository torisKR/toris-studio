//! An opt-in, private-interface SSH server dedicated to the companion protocol.
//! It does not use the system SSH daemon, shell, forwarding, or authorized_keys.
use crate::{
    agent_runtime::AgentRuntime,
    mobile_registry::{DeviceView, MobileRegistry, Scope},
    mobile_service::{Identity, MobileService},
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use rand::rngs::OsRng;
use russh::{
    keys::{Algorithm, PrivateKey, PublicKey},
    server::{self, Auth, Msg, Session},
    Channel, ChannelId, CryptoVec, Disconnect, MethodKind, MethodSet, Pty,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    net::Ipv4Addr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex, Semaphore},
    task::JoinHandle,
};
use uuid::Uuid;
use zeroize::Zeroizing;

const SUBSYSTEM: &str = "toris-mobile-v1";
const HOST_KEY_SERVICE: &str = "kr.toris.studio.mobile.ssh.v1";
const HOST_KEY_ACCOUNT: &str = "host-key";
const MAX_SESSIONS: usize = 8;
const MAX_LINE: usize = 8192;

#[derive(Clone, Serialize)]
pub struct InterfaceView {
    pub name: String,
    pub address: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub available: bool,
    pub enabled: bool,
    pub interfaces: Vec<InterfaceView>,
    pub address: Option<String>,
    pub port: Option<u16>,
    pub fingerprint: Option<String>,
    pub devices: Vec<DeviceView>,
    pub pending: Option<crate::mobile_pairing::PendingView>,
    pub projects: Vec<ProjectName>,
}

#[derive(Clone, Serialize)]
pub struct ProjectName {
    pub name: String,
}

struct Client {
    handle: server::Handle,
    device: Option<Uuid>,
}
type Clients = Arc<Mutex<HashMap<Uuid, Client>>>;

struct Running {
    address: Ipv4Addr,
    port: u16,
    fingerprint: String,
    enabled: Arc<AtomicBool>,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

struct QrImage {
    bytes: Vec<u8>,
    deadline: Instant,
}

pub struct MobileHost {
    runtime: Arc<AgentRuntime>,
    service: OnceLock<Result<Arc<MobileService>, String>>,
    lifecycle: Mutex<()>,
    active: Mutex<Option<Running>>,
    clients: Clients,
    qr: Arc<StdMutex<Option<QrImage>>>,
}

impl MobileHost {
    pub fn new(runtime: Arc<AgentRuntime>) -> Self {
        Self {
            runtime,
            service: OnceLock::new(),
            lifecycle: Mutex::new(()),
            active: Mutex::new(None),
            clients: Arc::new(Mutex::new(HashMap::new())),
            qr: Arc::new(StdMutex::new(None)),
        }
    }

    fn service(&self) -> Result<Arc<MobileService>, String> {
        self.service
            .get_or_init(|| {
                let dir = crate::config::config_path()
                    .parent()
                    .ok_or("기기 저장 위치를 확인하세요.")?
                    .join("mobile");
                let registry = MobileRegistry::open(dir.join("devices.json"))?;
                Ok(Arc::new(MobileService::new(
                    registry,
                    Arc::clone(&self.runtime),
                )))
            })
            .clone()
    }

    pub fn interfaces() -> Result<Vec<InterfaceView>, String> {
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for interface in
            if_addrs::get_if_addrs().map_err(|_| "네트워크 인터페이스를 확인하지 못했습니다.")?
        {
            if let std::net::IpAddr::V4(address) = interface.ip() {
                if address.is_private() && seen.insert(address) {
                    result.push(InterfaceView {
                        name: interface.name,
                        address: address.to_string(),
                    });
                }
            }
        }
        result.sort_by(|a, b| a.name.cmp(&b.name).then(a.address.cmp(&b.address)));
        Ok(result)
    }

    pub async fn status(&self) -> Result<HostStatus, String> {
        let service = self.service()?;
        let active = self.active.lock().await;
        let enabled = active
            .as_ref()
            .is_some_and(|run| run.enabled.load(Ordering::SeqCst));
        let address = active.as_ref().map(|run| run.address.to_string());
        let port = active.as_ref().map(|run| run.port);
        let fingerprint = active.as_ref().map(|run| run.fingerprint.clone());
        drop(active);
        let devices = service.registry.lock().await.devices();
        let pending = service.gate.lock().await.pending_view(Instant::now());
        let projects = if enabled {
            self.project_catalog().await.unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(HostStatus {
            available: true,
            enabled,
            interfaces: Self::interfaces()?,
            address,
            port,
            fingerprint,
            devices,
            pending,
            projects,
        })
    }

    pub async fn enable(&self, address: Ipv4Addr) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        if !address.is_private()
            || !Self::interfaces()?
                .iter()
                .any(|item| item.address == address.to_string())
        {
            return Err("사용할 사설 네트워크 인터페이스를 선택하세요.".into());
        }
        if self
            .active
            .lock()
            .await
            .as_ref()
            .is_some_and(|run| run.enabled.load(Ordering::SeqCst))
        {
            return Err("모바일 연결이 이미 켜져 있습니다.".into());
        }
        let key = host_key()?;
        let service = self.service()?;
        let port = service.registry.lock().await.host_port().unwrap_or(0);
        let listener = TcpListener::bind((address, port)).await.map_err(|_| {
            if port == 0 { "모바일 연결을 열지 못했습니다.".to_string() }
            else { format!("기존 모바일 연결 포트 {port}를 사용할 수 없습니다. 포트를 점유한 앱을 종료한 뒤 다시 켜세요.") }
        })?;
        if port == 0 {
            let assigned = listener
                .local_addr()
                .map_err(|_| "모바일 연결 포트를 확인하지 못했습니다.")?
                .port();
            service.registry.lock().await.remember_host_port(assigned)?;
        }
        self.start_listener(listener, key).await
    }

    async fn start_listener(&self, listener: TcpListener, key: PrivateKey) -> Result<(), String> {
        let mut active = self.active.lock().await;
        if active
            .as_ref()
            .is_some_and(|run| run.enabled.load(Ordering::SeqCst))
        {
            return Err("모바일 연결이 이미 켜져 있습니다.".into());
        }
        if let Some(stopped) = active.take() {
            let _ = stopped.stop.send(true);
            stopped.task.abort();
        }
        let addr = listener
            .local_addr()
            .map_err(|_| "모바일 연결 주소를 확인하지 못했습니다.")?;
        let address = match addr.ip() {
            std::net::IpAddr::V4(value) => value,
            _ => return Err("IPv4 주소가 필요합니다.".into()),
        };
        let key_blob = key
            .public_key()
            .to_bytes()
            .map_err(|_| "Mac 지문을 확인하지 못했습니다.")?;
        let fingerprint = format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(key_blob))
        );
        let config = Arc::new(server::Config {
            keys: vec![key],
            methods: MethodSet::from(&[MethodKind::None, MethodKind::PublicKey][..]),
            max_auth_attempts: 3,
            inactivity_timeout: Some(Duration::from_secs(120)),
            auth_rejection_time: Duration::from_millis(500),
            auth_rejection_time_initial: Some(Duration::from_millis(300)),
            ..Default::default()
        });
        let service = self.service()?;
        let enabled = Arc::new(AtomicBool::new(true));
        let (stop, receiver) = watch::channel(false);
        let task = tokio::spawn(accept_loop(
            listener,
            config,
            service,
            Arc::clone(&self.clients),
            Arc::clone(&self.qr),
            Arc::clone(&enabled),
            receiver,
        ));
        *active = Some(Running {
            address,
            port: addr.port(),
            fingerprint,
            enabled,
            stop,
            task,
        });
        Ok(())
    }

    pub async fn disable(&self) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        let run = self.active.lock().await.take();
        if let Some(run) = run.as_ref() {
            run.enabled.store(false, Ordering::SeqCst);
        }
        let close_result = self.close_pairing().await;
        if let Some(mut run) = run {
            let _ = run.stop.send(true);
            disconnect_all(&self.clients, None).await;
            if tokio::time::timeout(Duration::from_secs(2), &mut run.task)
                .await
                .is_err()
            {
                run.task.abort();
            }
        }
        close_result
    }

    pub fn shutdown(&self) {
        if let Ok(mut active) = self.active.try_lock() {
            if let Some(run) = active.take() {
                run.enabled.store(false, Ordering::SeqCst);
                let _ = run.stop.send(true);
                run.task.abort();
            }
        }
        if let Some(Ok(service)) = self.service.get() {
            if let Ok(mut gate) = service.gate.try_lock() {
                gate.close();
            }
        }
        if let Ok(mut image) = self.qr.lock() {
            *image = None;
        }
    }

    pub async fn issue_qr(&self) -> Result<u64, String> {
        let active = self.active.lock().await;
        let run = active
            .as_ref()
            .filter(|run| run.enabled.load(Ordering::SeqCst))
            .ok_or("모바일 연결을 먼저 켜세요.")?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "Mac 시간을 확인하세요.")?
            .as_secs();
        let issued = Instant::now();
        let image = self.service()?.gate.lock().await.issue_qr(
            run.address,
            run.port,
            &run.fingerprint,
            now,
            issued,
        )?;
        *self
            .qr
            .lock()
            .map_err(|_| "QR 코드를 표시하지 못했습니다.")? = Some(QrImage {
            bytes: image,
            deadline: issued + Duration::from_secs(120),
        });
        Ok(now + 120)
    }

    pub fn qr_image(&self) -> Option<Vec<u8>> {
        let mut image = self.qr.lock().ok()?;
        if image
            .as_ref()
            .is_some_and(|qr| Instant::now() >= qr.deadline)
        {
            *image = None;
        }
        image.as_ref().map(|qr| qr.bytes.clone())
    }

    pub async fn close_pairing(&self) -> Result<(), String> {
        self.service()?.gate.lock().await.close();
        if let Ok(mut image) = self.qr.lock() {
            *image = None;
        }
        // Enrollment sessions are never useful once their QR is closed.
        disconnect_enrollments(&self.clients).await;
        Ok(())
    }

    async fn project_catalog(&self) -> Result<Vec<ProjectName>, String> {
        let result = self
            .runtime
            .call("projects.list", serde_json::json!({}))
            .await
            .map_err(|_| "프로젝트 목록을 확인하지 못했습니다.")?;
        let mut names = Vec::new();
        for project in result["projects"].as_array().into_iter().flatten() {
            if let Some(name) = project["name"]
                .as_str()
                .filter(|name| crate::factory::is_slug(name))
            {
                if !names.iter().any(|item: &ProjectName| item.name == name) {
                    names.push(ProjectName { name: name.into() });
                }
            }
        }
        names.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(names)
    }

    async fn scopes(&self, projects: &[String], allow_create: bool) -> Result<Vec<Scope>, String> {
        let available: HashSet<String> = if projects.is_empty() {
            HashSet::new()
        } else {
            self.project_catalog()
                .await?
                .into_iter()
                .map(|p| p.name)
                .collect()
        };
        let mut scopes = Vec::new();
        let mut seen = HashSet::new();
        for project in projects {
            if !available.contains(project) || !seen.insert(project.clone()) {
                return Err("허용할 프로젝트를 확인하세요.".into());
            }
            scopes.push(Scope {
                name: project.clone(),
                slug: Some(project.clone()),
            });
        }
        if allow_create {
            scopes.push(Scope {
                name: "새 프로젝트 만들기".into(),
                slug: None,
            });
        }
        Ok(scopes)
    }

    pub async fn approve(
        &self,
        attempt: Uuid,
        projects: &[String],
        allow_create: bool,
    ) -> Result<(), String> {
        let scopes = self.scopes(projects, allow_create).await?;
        let service = self.service()?;
        let now = Instant::now();
        let mut gate = service.gate.lock().await;
        let (pending, key) = gate
            .approval_key(attempt, now)
            .ok_or("등록 요청이 만료되었거나 변경되었습니다.")?;
        service
            .registry
            .lock()
            .await
            .register(&pending.name, &key, &scopes)?;
        if !gate.mark_approved(attempt, now) {
            return Err("등록 요청이 변경되었습니다.".into());
        }
        if let Ok(mut image) = self.qr.lock() {
            *image = None;
        }
        Ok(())
    }

    pub async fn set_permissions(
        &self,
        device: Uuid,
        projects: &[String],
        allow_create: bool,
    ) -> Result<(), String> {
        let scopes = self.scopes(projects, allow_create).await?;
        self.service()?
            .registry
            .lock()
            .await
            .set_scopes(device, &scopes)
    }

    pub async fn revoke(&self, device: Uuid) -> Result<(), String> {
        self.service()?.registry.lock().await.revoke(device)?;
        disconnect_all(&self.clients, Some(device)).await;
        Ok(())
    }
}

fn host_key() -> Result<PrivateKey, String> {
    let entry = keyring::Entry::new(HOST_KEY_SERVICE, HOST_KEY_ACCOUNT)
        .map_err(|_| crate::vault::error())?;
    match entry.get_password() {
        Ok(value) => {
            let protected = Zeroizing::new(value);
            PrivateKey::from_openssh(protected.as_str())
                .map_err(|_| "저장된 Mac 호스트 키를 읽지 못했습니다.".into())
        }
        Err(keyring::Error::NoEntry) => {
            let key = PrivateKey::random(
                &mut OsRng,
                Algorithm::Ecdsa {
                    curve: russh::keys::EcdsaCurve::NistP256,
                },
            )
            .map_err(|_| "Mac 호스트 키를 만들지 못했습니다.")?;
            let encoded = key
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .map_err(|_| "Mac 호스트 키를 저장하지 못했습니다.")?;
            entry
                .set_password(encoded.as_str())
                .map_err(|_| crate::vault::error())?;
            Ok(key)
        }
        Err(_) => Err(crate::vault::error()),
    }
}

async fn disconnect_all(clients: &Clients, only_device: Option<Uuid>) {
    let handles: Vec<_> = clients
        .lock()
        .await
        .values()
        .filter(|client| only_device.is_none() || client.device == only_device)
        .map(|client| client.handle.clone())
        .collect();
    for handle in handles {
        let _ = tokio::time::timeout(
            Duration::from_millis(500),
            handle.disconnect(
                Disconnect::ByApplication,
                "연결이 종료되었습니다.".into(),
                "".into(),
            ),
        )
        .await;
    }
}

async fn disconnect_enrollments(clients: &Clients) {
    let handles: Vec<_> = clients
        .lock()
        .await
        .values()
        .filter(|client| client.device.is_none())
        .map(|client| client.handle.clone())
        .collect();
    for handle in handles {
        let _ = tokio::time::timeout(
            Duration::from_millis(500),
            handle.disconnect(
                Disconnect::ByApplication,
                "등록이 종료되었습니다.".into(),
                "".into(),
            ),
        )
        .await;
    }
}

async fn accept_loop(
    listener: TcpListener,
    config: Arc<server::Config>,
    service: Arc<MobileService>,
    clients: Clients,
    qr: Arc<StdMutex<Option<QrImage>>>,
    enabled: Arc<AtomicBool>,
    mut stop: watch::Receiver<bool>,
) {
    let permits = Arc::new(Semaphore::new(MAX_SESSIONS));
    loop {
        tokio::select! {
            changed = stop.changed() => { if changed.is_err() || *stop.borrow() { break; } }
            accepted = listener.accept() => {
                let Ok((stream, _peer)) = accepted else { break };
                let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else { continue };
                let id = Uuid::new_v4();
                let handler = Connection {
                    id, identity: None, channel: None, subsystem: false, input: Vec::new(),
                    service: Arc::clone(&service), clients: Arc::clone(&clients), qr: Arc::clone(&qr),
                    enabled: Arc::clone(&enabled), inflight: Arc::new(Semaphore::new(1)),
                };
                let mut session_stop = stop.clone();
                let session_config = Arc::clone(&config);
                let session_clients = Arc::clone(&clients);
                let session_service = Arc::clone(&service);
                tokio::spawn(async move {
                    let _permit = permit;
                    let session = tokio::select! {
                        _ = session_stop.changed() => return,
                        result = tokio::time::timeout(Duration::from_secs(10), server::run_stream(session_config, stream, handler)) => result,
                    };
                    let Ok(Ok(mut session)) = session else { return };
                    let handle = session.handle();
                    session_clients.lock().await.entry(id).or_insert(Client { handle: handle.clone(), device: None });
                    tokio::select! {
                        _ = session_stop.changed() => { let _ = handle.disconnect(Disconnect::ByApplication, "연결이 종료되었습니다.".into(), "".into()).await; }
                        _ = &mut session => {}
                    }
                    session_clients.lock().await.remove(&id);
                    session_service.gate.lock().await.cancel_session(id);
                });
            }
        }
    }
    enabled.store(false, Ordering::SeqCst);
    disconnect_all(&clients, None).await;
}

struct Connection {
    id: Uuid,
    identity: Option<Identity>,
    channel: Option<ChannelId>,
    subsystem: bool,
    input: Vec<u8>,
    service: Arc<MobileService>,
    clients: Clients,
    qr: Arc<StdMutex<Option<QrImage>>>,
    enabled: Arc<AtomicBool>,
    inflight: Arc<Semaphore>,
}

impl server::Handler for Connection {
    type Error = russh::Error;

    async fn auth_none(&mut self, user: &str) -> Result<Auth, Self::Error> {
        if user == "enroll"
            && self.enabled.load(Ordering::SeqCst)
            && self
                .service
                .gate
                .lock()
                .await
                .registration_open(Instant::now())
        {
            self.identity = Some(Identity::Enrollment(self.id));
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        if user != "device" || !self.enabled.load(Ordering::SeqCst) {
            return Ok(Auth::reject());
        }
        let Ok(bytes) = public_key.to_bytes() else {
            return Ok(Auth::reject());
        };
        match self.service.registry.lock().await.authenticate(&bytes) {
            Ok(device) => {
                self.identity = Some(Identity::Device(device));
                Ok(Auth::Accept)
            }
            Err(_) => Ok(Auth::reject()),
        }
    }

    async fn auth_succeeded(&mut self, session: &mut Session) -> Result<(), Self::Error> {
        let device = match self.identity {
            Some(Identity::Device(id)) => Some(id),
            _ => None,
        };
        self.clients
            .lock()
            .await
            .entry(self.id)
            .and_modify(|client| client.device = device)
            .or_insert(Client {
                handle: session.handle(),
                device,
            });
        let authorized = match device {
            Some(id) => self.service.registry.lock().await.is_authorized(id),
            None => true,
        };
        if !authorized || !self.enabled.load(Ordering::SeqCst) {
            session.disconnect(Disconnect::ByApplication, "연결 권한이 없습니다.", "")?;
        }
        Ok(())
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if self.identity.is_none() || self.channel.is_some() || !self.enabled.load(Ordering::SeqCst)
        {
            return Ok(false);
        }
        self.channel = Some(channel.id());
        Ok(true)
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if Some(channel) == self.channel
            && !self.subsystem
            && name == SUBSYSTEM
            && self.enabled.load(Ordering::SeqCst)
        {
            self.subsystem = true;
            session.channel_success(channel)?;
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.subsystem || Some(channel) != self.channel || !self.enabled.load(Ordering::SeqCst)
        {
            return Err(russh::Error::Disconnect);
        }
        self.input.extend_from_slice(data);
        if self.input.len() > MAX_LINE + 1 {
            return Err(russh::Error::Disconnect);
        }
        let Some(end) = self.input.iter().position(|byte| *byte == b'\n') else {
            return Ok(());
        };
        if end + 1 != self.input.len() {
            return Err(russh::Error::Disconnect);
        }
        let line = std::mem::take(&mut self.input);
        let request = MobileService::parse(&line[..end]);
        let Ok(permit) = Arc::clone(&self.inflight).try_acquire_owned() else {
            return Err(russh::Error::Disconnect);
        };
        let Some(identity) = self.identity else {
            return Err(russh::Error::Disconnect);
        };
        let handle = session.handle();
        let service = Arc::clone(&self.service);
        let enabled = Arc::clone(&self.enabled);
        let qr = Arc::clone(&self.qr);
        tokio::spawn(async move {
            if !enabled.load(Ordering::SeqCst) {
                return;
            }
            let result = match request {
                Ok(request) => service.handle(identity, request).await,
                Err(error) => Err(error),
            };
            if !enabled.load(Ordering::SeqCst) {
                return;
            }
            if let Identity::Device(device) = identity {
                if !service.registry.lock().await.is_authorized(device) {
                    return;
                }
            }
            let (payload, close) = match result {
                Ok(reply) => {
                    if matches!(identity, Identity::Enrollment(_))
                        && reply.value["state"] == "waiting"
                        && reply.value.get("confirmationCode").is_some()
                    {
                        if let Ok(mut image) = qr.lock() {
                            *image = None;
                        }
                    }
                    (
                        serde_json::json!({"ok":true,"result":reply.value}),
                        reply.close,
                    )
                }
                Err(error) => (serde_json::json!({"ok":false,"error":error}), false),
            };
            if let Ok(mut bytes) = serde_json::to_vec(&payload) {
                bytes.push(b'\n');
                let _ = handle.data(channel, CryptoVec::from(bytes)).await;
            }
            drop(permit);
            if close {
                let _ = handle.eof(channel).await;
                let _ = handle.close(channel).await;
                let _ = handle
                    .disconnect(
                        Disconnect::ByApplication,
                        "등록을 마쳤습니다.".into(),
                        "".into(),
                    )
                    .await;
            }
        });
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }
    async fn env_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        _value: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _width: u32,
        _height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }
    async fn x11_request(
        &mut self,
        channel: ChannelId,
        _single: bool,
        _protocol: &str,
        _cookie: &str,
        _screen: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile_service::MobileService;
    use russh::{
        client,
        keys::{EcdsaCurve, PrivateKeyWithHashAlg},
        ChannelMsg,
    };
    use serde_json::{json, Value};

    struct Pinned(PublicKey);
    impl client::Handler for Pinned {
        type Error = russh::Error;
        async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
            Ok(self.0.to_bytes().ok() == key.to_bytes().ok())
        }
    }

    async fn connect(port: u16, key: PublicKey) -> client::Handle<Pinned> {
        client::connect(
            Arc::new(client::Config::default()),
            ("127.0.0.1", port),
            Pinned(key),
        )
        .await
        .unwrap()
    }

    async fn read_message(channel: &mut Channel<client::Msg>) -> Value {
        let mut bytes = Vec::new();
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), channel.wait())
                .await
                .unwrap()
                .unwrap();
            if let ChannelMsg::Data { data } = message {
                bytes.extend_from_slice(&data);
                if bytes.contains(&b'\n') {
                    break;
                }
            }
        }
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn send(channel: &mut Channel<client::Msg>, value: Value) -> Value {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        channel.data(&bytes[..]).await.unwrap();
        read_message(channel).await
    }

    async fn expect_reply(channel: &mut Channel<client::Msg>, success: bool) {
        let msg = tokio::time::timeout(Duration::from_secs(5), channel.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(if success {
            matches!(msg, ChannelMsg::Success)
        } else {
            matches!(msg, ChannelMsg::Failure)
        });
    }

    #[tokio::test]
    async fn real_ssh_enrollment_requires_approval_reauth_and_revocation_closes_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let script = r#"const rl=require('node:readline').createInterface({input:process.stdin});
console.log(JSON.stringify({event:'ready',version:'test'}));
rl.on('line',l=>{const m=JSON.parse(l); console.log(JSON.stringify({id:m.id,ok:true,result:{projects:[]}}));});"#;
        let runtime = Arc::new(AgentRuntime::with_launcher(
            crate::agent_runtime::node_path().unwrap(),
            vec!["-e".into(), script.into()],
            Box::new(|| Ok(json!({}))),
        ));
        let registry = MobileRegistry::open(dir.path().join("mobile/devices.json")).unwrap();
        let service = Arc::new(MobileService::new(registry, Arc::clone(&runtime)));
        let host = MobileHost::new(Arc::clone(&runtime));
        assert!(host.service.set(Ok(Arc::clone(&service))).is_ok());
        let host_key = PrivateKey::random(
            &mut OsRng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .unwrap();
        let host_public = host_key.public_key().clone();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        host.start_listener(listener, host_key).await.unwrap();

        let mut before_qr = connect(port, host_public.clone()).await;
        assert!(!before_qr
            .authenticate_none("enroll")
            .await
            .unwrap()
            .success());
        let _ = before_qr
            .disconnect(Disconnect::ByApplication, "", "")
            .await;

        let now = Instant::now();
        let host_blob = host_public.to_bytes().unwrap();
        let fingerprint = format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(host_blob))
        );
        let png = service
            .gate
            .lock()
            .await
            .issue_qr(Ipv4Addr::new(192, 168, 1, 8), port, &fingerprint, 1000, now)
            .unwrap();
        let mut image =
            rqrr::PreparedImage::prepare(image::load_from_memory(&png).unwrap().to_luma8());
        let grids = image.detect_grids();
        let (_, qr_text) = grids[0].decode().unwrap();
        let payload: Value = serde_json::from_str(&qr_text).unwrap();
        let token = payload["token"].as_str().unwrap();

        let device_key = PrivateKey::random(
            &mut OsRng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .unwrap();
        let device_blob = device_key.public_key().to_bytes().unwrap();
        let mut enrollment = connect(port, host_public.clone()).await;
        assert!(enrollment
            .authenticate_none("enroll")
            .await
            .unwrap()
            .success());
        let mut channel = enrollment.channel_open_session().await.unwrap();
        channel.request_subsystem(true, SUBSYSTEM).await.unwrap();
        expect_reply(&mut channel, true).await;
        assert_eq!(
            send(&mut channel, json!({"method":"projects.list"})).await["ok"],
            false
        );
        let waiting = send(&mut channel, json!({"method":"enroll.begin","token":token,"name":"테스트 기기","publicKey":STANDARD_NO_PAD.encode(&device_blob)})).await;
        assert_eq!(waiting["result"]["state"], "waiting");
        let pending = service
            .gate
            .lock()
            .await
            .pending_view(Instant::now())
            .unwrap();
        assert_eq!(
            waiting["result"]["confirmationCode"],
            pending.confirmation_code
        );
        assert_eq!(
            send(&mut channel, json!({"method":"enroll.poll"})).await["result"]["state"],
            "waiting"
        );
        host.approve(pending.id, &[], true).await.unwrap();
        assert_eq!(
            send(&mut channel, json!({"method":"enroll.poll"})).await["result"]["state"],
            "approved"
        );
        let device_id = service.registry.lock().await.devices()[0].id;

        let mut device = connect(port, host_public.clone()).await;
        assert!(device
            .authenticate_publickey(
                "device",
                PrivateKeyWithHashAlg::new(Arc::new(device_key.clone()), None)
            )
            .await
            .unwrap()
            .success());
        assert!(device
            .channel_open_direct_tcpip("127.0.0.1", 80, "127.0.0.1", 1000)
            .await
            .is_err());
        let mut device_channel = device.channel_open_session().await.unwrap();
        device_channel.request_shell(true).await.unwrap();
        expect_reply(&mut device_channel, false).await;
        device_channel.exec(true, "whoami").await.unwrap();
        expect_reply(&mut device_channel, false).await;
        device_channel
            .request_subsystem(true, "sftp")
            .await
            .unwrap();
        expect_reply(&mut device_channel, false).await;
        device_channel
            .request_subsystem(true, SUBSYSTEM)
            .await
            .unwrap();
        expect_reply(&mut device_channel, true).await;
        let projects = send(&mut device_channel, json!({"method":"projects.list"})).await;
        assert_eq!(projects["result"]["projects"].as_array().unwrap().len(), 1);

        host.revoke(device_id).await.unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match device_channel.wait().await {
                    None | Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) => break true,
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        assert!(closed);
        let mut revoked = connect(port, host_public).await;
        let auth = revoked
            .authenticate_publickey(
                "device",
                PrivateKeyWithHashAlg::new(Arc::new(device_key), None),
            )
            .await;
        assert!(auth.is_err() || !auth.unwrap().success());
        host.disable().await.unwrap();
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err());
        runtime.stop().await;
    }
}
