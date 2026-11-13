//! Durable public-device grants and run ownership. This file contains no
//! enrollment tokens, private keys, prompts, raw logs, or model credentials.
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use russh::keys::{Algorithm, EcdsaCurve, PublicKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_DEVICES: usize = 32;
const MAX_BINDINGS: usize = 4096;
const MAX_REGISTRY_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectGrant {
    id: Uuid,
    name: String,
    /// None means the explicit Mac-granted factory-create capability.
    resume_slug: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: Uuid,
    name: String,
    public_key: String,
    fingerprint: String,
    last_connected: Option<String>,
    projects: Vec<ProjectGrant>,
    #[serde(default)]
    retired_projects: Vec<ProjectGrant>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunBinding {
    device_id: Uuid,
    project_id: Uuid,
    request_key: Uuid,
    request_hash: String,
    run_id: Uuid,
    started: bool,
    #[serde(default)]
    safe_snapshot: Option<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    version: u8,
    #[serde(default)]
    host_port: Option<u16>,
    devices: Vec<Device>,
    runs: Vec<RunBinding>,
}
impl Default for Data {
    fn default() -> Self {
        Self {
            version: 1,
            host_port: None,
            devices: Vec::new(),
            runs: Vec::new(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub id: Uuid,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: Uuid,
    pub name: String,
    pub fingerprint: String,
    pub last_connected: Option<String>,
    pub projects: Vec<ProjectView>,
}

/// `slug` comes from a Mac-validated catalog, never from a remote request.
#[derive(Clone)]
pub struct Scope {
    pub name: String,
    pub slug: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reservation {
    pub run_id: Uuid,
    pub existing: bool,
    pub started: bool,
}

pub struct VisibleRun {
    pub run_id: Uuid,
    pub project_name: String,
    pub safe_snapshot: Option<Value>,
}
pub struct VisibleRunPage {
    pub runs: Vec<VisibleRun>,
    pub next_offset: Option<usize>,
}

pub struct MobileRegistry {
    path: PathBuf,
    data: Data,
}

impl MobileRegistry {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let data = match fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(MAX_REGISTRY_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "기기 권한을 읽지 못했습니다.")?;
                if bytes.len() as u64 > MAX_REGISTRY_BYTES {
                    return Err("기기 권한 파일이 너무 큽니다.".into());
                }
                let data: Data =
                    serde_json::from_slice(&bytes).map_err(|_| "기기 권한 파일을 확인하세요.")?;
                if data.version != 1 || data.host_port.is_some_and(|port| port < 1024) {
                    return Err("지원하지 않는 기기 권한 형식입니다.".into());
                }
                data
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Data::default(),
            Err(_) => return Err("기기 권한을 읽지 못했습니다.".into()),
        };
        Ok(Self { path, data })
    }

    fn change<T>(
        &mut self,
        action: impl FnOnce(&mut Data) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut next = self.data.clone();
        let result = action(&mut next)?;
        save(&self.path, &next)?;
        self.data = next;
        Ok(result)
    }

    pub fn devices(&self) -> Vec<DeviceView> {
        self.data.devices.iter().map(device_view).collect()
    }

    pub fn host_port(&self) -> Option<u16> {
        self.data.host_port
    }

    pub fn remember_host_port(&mut self, port: u16) -> Result<(), String> {
        if port < 1024 {
            return Err("모바일 연결 포트를 확인하세요.".into());
        }
        self.change(|data| {
            if data.host_port.is_some_and(|saved| saved != port) {
                return Err("모바일 연결 포트가 변경되었습니다.".into());
            }
            data.host_port = Some(port);
            Ok(())
        })
    }

    pub fn register(
        &mut self,
        name: &str,
        key_bytes: &[u8],
        scopes: &[Scope],
    ) -> Result<Uuid, String> {
        let key = PublicKey::from_bytes(key_bytes).map_err(|_| "기기 공개키를 확인하세요.")?;
        if key.algorithm()
            != (Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            })
            || key.to_bytes().ok().as_deref() != Some(key_bytes)
        {
            return Err("지원하지 않는 기기 공개키입니다.".into());
        }
        let name = name.trim().to_owned();
        if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
            return Err("기기 이름을 확인하세요.".into());
        }
        let projects = build_grants(&[], scopes)?;
        let public_key = STANDARD_NO_PAD.encode(key_bytes);
        let fingerprint = format!(
            "SHA256:{}",
            STANDARD_NO_PAD.encode(Sha256::digest(key_bytes))
        );
        self.change(|data| {
            if data.devices.len() >= MAX_DEVICES
                || data
                    .devices
                    .iter()
                    .any(|device| device.public_key == public_key)
            {
                return Err("기기가 이미 등록되었거나 등록 한도에 도달했습니다.".into());
            }
            let id = Uuid::new_v4();
            data.devices.push(Device {
                id,
                name,
                public_key,
                fingerprint,
                last_connected: None,
                projects,
                retired_projects: Vec::new(),
            });
            Ok(id)
        })
    }

    pub fn set_scopes(&mut self, device_id: Uuid, scopes: &[Scope]) -> Result<(), String> {
        self.change(|data| {
            let device = data
                .devices
                .iter_mut()
                .find(|d| d.id == device_id)
                .ok_or("등록된 기기를 찾을 수 없습니다.")?;
            let mut known = device.projects.clone();
            known.extend(device.retired_projects.clone());
            let projects = build_grants(&known, scopes)?;
            let retired: Vec<_> = known
                .into_iter()
                .filter(|old| !projects.iter().any(|active| active.id == old.id))
                .collect();
            if retired.len() > MAX_BINDINGS {
                return Err("저장된 프로젝트 권한이 너무 많습니다.".into());
            }
            device.projects = projects;
            device.retired_projects = retired;
            Ok(())
        })
    }

    pub fn revoke(&mut self, device_id: Uuid) -> Result<(), String> {
        self.change(|data| {
            let old_len = data.devices.len();
            data.devices.retain(|device| device.id != device_id);
            if data.devices.len() == old_len {
                return Err("등록된 기기를 찾을 수 없습니다.".into());
            }
            Ok(())
        })
    }

    /// Call only after the SSH library has verified the key's signature.
    pub fn authenticate(&mut self, public_key: &[u8]) -> Result<Uuid, String> {
        let encoded = STANDARD_NO_PAD.encode(public_key);
        self.change(|data| {
            let device = data
                .devices
                .iter_mut()
                .find(|device| device.public_key == encoded)
                .ok_or("등록되지 않은 기기입니다.")?;
            device.last_connected = Some(chrono::Utc::now().to_rfc3339());
            Ok(device.id)
        })
    }

    pub fn is_authorized(&self, device: Uuid) -> bool {
        self.data.devices.iter().any(|item| item.id == device)
    }

    pub fn projects(&self, device: Uuid) -> Result<Vec<ProjectView>, String> {
        Ok(self
            .device(device)?
            .projects
            .iter()
            .map(project_view)
            .collect())
    }

    /// Distinguishes an authorized new-project grant from an existing project.
    pub fn project_scope(&self, device: Uuid, project: Uuid) -> Result<Option<String>, String> {
        self.device(device)?
            .projects
            .iter()
            .find(|grant| grant.id == project)
            .map(|grant| grant.resume_slug.clone())
            .ok_or_else(|| "이 기기에 허용되지 않은 프로젝트입니다.".into())
    }

    /// Persist the binding before the runtime is started, so a lost reply or
    /// concurrent retransmission never allocates a second run.
    pub fn reserve(
        &mut self,
        device: Uuid,
        project: Uuid,
        request_key: Uuid,
        request_hash: &str,
    ) -> Result<Reservation, String> {
        self.project_scope(device, project)?;
        if request_key.get_version_num() != 4
            || request_hash.len() != 64
            || !request_hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("작업 요청 식별자를 확인하세요.".into());
        }
        if let Some(run) = self
            .data
            .runs
            .iter()
            .find(|run| run.device_id == device && run.request_key == request_key)
        {
            if run.project_id != project || run.request_hash != request_hash {
                return Err("이미 사용한 요청 식별자입니다.".into());
            }
            return Ok(Reservation {
                run_id: run.run_id,
                existing: true,
                started: run.started,
            });
        }
        self.change(|data| {
            if data.runs.len() >= MAX_BINDINGS {
                return Err("저장된 모바일 작업이 너무 많습니다.".into());
            }
            let run_id = Uuid::new_v4();
            data.runs.push(RunBinding {
                device_id: device,
                project_id: project,
                request_key,
                request_hash: request_hash.into(),
                run_id,
                started: false,
                safe_snapshot: None,
            });
            Ok(Reservation {
                run_id,
                existing: false,
                started: false,
            })
        })
    }

    pub fn mark_started(&mut self, device: Uuid, run_id: Uuid) -> Result<(), String> {
        self.authorize_run(device, run_id)?;
        self.change(|data| {
            data.runs
                .iter_mut()
                .find(|run| run.device_id == device && run.run_id == run_id)
                .ok_or("작업을 찾을 수 없습니다.")?
                .started = true;
            Ok(())
        })
    }

    pub fn lookup_request(&self, device: Uuid, request_key: Uuid) -> Result<Reservation, String> {
        let run = self
            .data
            .runs
            .iter()
            .find(|run| run.device_id == device && run.request_key == request_key)
            .ok_or("작업을 찾을 수 없습니다.")?;
        self.project_scope(device, run.project_id)?;
        Ok(Reservation {
            run_id: run.run_id,
            existing: true,
            started: run.started,
        })
    }

    /// Only this device's own runs in its currently granted projects. Keep the
    /// response bounded even when the durable ownership ledger is much larger.
    pub fn visible_runs_page(&self, device: Uuid, offset: usize) -> Result<VisibleRunPage, String> {
        const PAGE_SIZE: usize = 12;
        if offset > MAX_BINDINGS {
            return Err("작업 목록 위치를 확인하세요.".into());
        }
        let device_view = self.device(device)?;
        let mut matching = self
            .data
            .runs
            .iter()
            .rev()
            .filter_map(|run| {
                if run.device_id != device {
                    return None;
                }
                device_view
                    .projects
                    .iter()
                    .find(|project| project.id == run.project_id)
                    .map(|project| VisibleRun {
                        run_id: run.run_id,
                        project_name: project.name.clone(),
                        safe_snapshot: run.safe_snapshot.clone(),
                    })
            })
            .skip(offset)
            .take(PAGE_SIZE + 1)
            .collect::<Vec<_>>();
        let next_offset = if matching.len() > PAGE_SIZE {
            matching.pop();
            Some(offset + PAGE_SIZE)
        } else {
            None
        };
        Ok(VisibleRunPage {
            runs: matching,
            next_offset,
        })
    }

    /// Snapshots are generated by the host's closed sanitizer, never by the
    /// phone. Keeping them lets mobile history survive runtime history pruning.
    pub fn cache_snapshots(
        &mut self,
        device: Uuid,
        snapshots: &[(Uuid, Value)],
    ) -> Result<(), String> {
        for (run_id, snapshot) in snapshots {
            self.authorize_run(device, *run_id)?;
            if snapshot["runId"] != run_id.to_string()
                || serde_json::to_vec(snapshot)
                    .map_err(|_| "작업 상태를 저장하지 못했습니다.")?
                    .len()
                    > 8192
            {
                return Err("작업 상태를 저장하지 못했습니다.".into());
            }
        }
        let updates: Vec<_> = snapshots
            .iter()
            .filter(|(id, snapshot)| {
                let old = self
                    .data
                    .runs
                    .iter()
                    .find(|run| run.device_id == device && run.run_id == *id)
                    .and_then(|run| run.safe_snapshot.as_ref());
                let old_seq = old
                    .and_then(|value| value["sequence"].as_u64())
                    .unwrap_or(0);
                let next_seq = snapshot["sequence"].as_u64().unwrap_or(0);
                old != Some(snapshot)
                    && old_seq <= next_seq
                    && !(old.is_some_and(|value| {
                        matches!(
                            value["phase"].as_str(),
                            Some("done" | "failed" | "cancelled")
                        )
                    }) && !matches!(
                        snapshot["phase"].as_str(),
                        Some("done" | "failed" | "cancelled")
                    ))
            })
            .collect();
        if updates.is_empty() {
            return Ok(());
        }
        self.change(|data| {
            for (id, snapshot) in updates {
                let run = data
                    .runs
                    .iter_mut()
                    .find(|run| run.device_id == device && run.run_id == *id)
                    .ok_or("작업을 찾을 수 없습니다.")?;
                run.safe_snapshot = Some(snapshot.clone());
            }
            Ok(())
        })
    }

    pub fn cached_snapshot(&self, device: Uuid, run_id: Uuid) -> Result<Option<Value>, String> {
        self.authorize_run(device, run_id)?;
        Ok(self
            .data
            .runs
            .iter()
            .find(|run| run.device_id == device && run.run_id == run_id)
            .and_then(|run| run.safe_snapshot.clone()))
    }

    pub fn authorize_run(&self, device: Uuid, run_id: Uuid) -> Result<(), String> {
        let run = self
            .data
            .runs
            .iter()
            .find(|run| run.device_id == device && run.run_id == run_id)
            .ok_or("작업을 찾을 수 없습니다.")?;
        self.project_scope(device, run.project_id)?;
        Ok(())
    }

    fn device(&self, id: Uuid) -> Result<&Device, String> {
        self.data
            .devices
            .iter()
            .find(|device| device.id == id)
            .ok_or_else(|| "등록되지 않은 기기입니다.".into())
    }
}

fn build_grants(existing: &[ProjectGrant], scopes: &[Scope]) -> Result<Vec<ProjectGrant>, String> {
    if scopes.len() > 100 {
        return Err("프로젝트가 너무 많습니다.".into());
    }
    let mut grants = Vec::new();
    for scope in scopes {
        if scope.name.trim().is_empty()
            || scope.name.chars().count() > 100
            || scope.name.chars().any(char::is_control)
            || scope
                .slug
                .as_ref()
                .is_some_and(|slug| !crate::factory::is_slug(slug))
            || grants
                .iter()
                .any(|grant: &ProjectGrant| grant.resume_slug == scope.slug)
        {
            return Err("허용할 프로젝트를 확인하세요.".into());
        }
        let id = existing
            .iter()
            .find(|grant| grant.resume_slug == scope.slug)
            .map(|grant| grant.id)
            .unwrap_or_else(Uuid::new_v4);
        grants.push(ProjectGrant {
            id,
            name: scope.name.trim().into(),
            resume_slug: scope.slug.clone(),
        });
    }
    Ok(grants)
}

fn project_view(project: &ProjectGrant) -> ProjectView {
    ProjectView {
        id: project.id,
        name: project.name.clone(),
    }
}
fn device_view(device: &Device) -> DeviceView {
    DeviceView {
        id: device.id,
        name: device.name.clone(),
        fingerprint: device.fingerprint.clone(),
        last_connected: device.last_connected.clone(),
        projects: device.projects.iter().map(project_view).collect(),
    }
}

fn save(path: &Path, data: &Data) -> Result<(), String> {
    let dir = path.parent().ok_or("기기 저장 위치를 확인하세요.")?;
    fs::create_dir_all(dir).map_err(|_| "기기 권한을 저장하지 못했습니다.")?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
        .map_err(|_| "기기 권한을 보호하지 못했습니다.")?;
    let bytes = serde_json::to_vec(data).map_err(|_| "기기 권한을 저장하지 못했습니다.")?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err("기기 권한 파일이 너무 큽니다.".into());
    }
    let mut tmp =
        tempfile::NamedTempFile::new_in(dir).map_err(|_| "기기 권한을 저장하지 못했습니다.")?;
    tmp.write_all(&bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|_| "기기 권한을 저장하지 못했습니다.")?;
    tmp.persist(path)
        .map_err(|_| "기기 권한을 저장하지 못했습니다.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    use russh::keys::PrivateKey;

    fn key() -> Vec<u8> {
        PrivateKey::random(
            &mut OsRng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .unwrap()
        .public_key()
        .to_bytes()
        .unwrap()
    }
    fn scope() -> Scope {
        Scope {
            name: "새 프로젝트 만들기".into(),
            slug: None,
        }
    }

    #[test]
    fn host_port_survives_restart_and_loads_older_registries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        fs::write(&path, br#"{"version":1,"devices":[],"runs":[]}"#).unwrap();
        let mut registry = MobileRegistry::open(path.clone()).unwrap();
        assert_eq!(registry.host_port(), None);
        assert!(registry.remember_host_port(22).is_err());
        registry.remember_host_port(35791).unwrap();
        assert!(registry.remember_host_port(35792).is_err());
        assert_eq!(MobileRegistry::open(path).unwrap().host_port(), Some(35791));
    }

    #[test]
    fn mobile_run_pages_only_include_owned_runs_with_current_project_grants() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = MobileRegistry::open(dir.path().join("devices.json")).unwrap();
        let first = registry.register("첫 기기", &key(), &[scope()]).unwrap();
        let second = registry.register("둘째 기기", &key(), &[scope()]).unwrap();
        let first_project = registry.projects(first).unwrap()[0].id;
        let second_project = registry.projects(second).unwrap()[0].id;
        for _ in 0..13 {
            registry
                .reserve(first, first_project, Uuid::new_v4(), &"a".repeat(64))
                .unwrap();
        }
        let other = registry
            .reserve(second, second_project, Uuid::new_v4(), &"a".repeat(64))
            .unwrap()
            .run_id;
        // Even if grant IDs were ever shared, ownership still filters the list.
        registry
            .data
            .runs
            .iter_mut()
            .find(|run| run.run_id == other)
            .unwrap()
            .project_id = first_project;
        let page = registry.visible_runs_page(first, 0).unwrap();
        assert_eq!(page.runs.len(), 12);
        assert_eq!(page.next_offset, Some(12));
        assert!(!page.runs.iter().any(|run| run.run_id == other));
        let first_run = page.runs[0].run_id;
        let safe = serde_json::json!({"runId":first_run,"phase":"done","sequence":8,"gates":[]});
        registry
            .cache_snapshots(first, &[(first_run, safe.clone())])
            .unwrap();
        let older = serde_json::json!({"runId":first_run,"phase":"done","sequence":7,"gates":[]});
        registry
            .cache_snapshots(first, &[(first_run, older)])
            .unwrap();
        assert_eq!(
            MobileRegistry::open(dir.path().join("devices.json"))
                .unwrap()
                .cached_snapshot(first, first_run)
                .unwrap(),
            Some(safe)
        );
        assert!(registry.cached_snapshot(second, first_run).is_err());
        let tail = registry.visible_runs_page(first, 12).unwrap();
        assert_eq!(tail.runs.len(), 1);
        assert_eq!(tail.next_offset, None);
        assert!(registry.visible_runs_page(first, MAX_BINDINGS + 1).is_err());
        registry.set_scopes(first, &[]).unwrap();
        assert!(registry
            .visible_runs_page(first, 0)
            .unwrap()
            .runs
            .is_empty());
        registry.set_scopes(first, &[scope()]).unwrap();
        assert_eq!(registry.projects(first).unwrap()[0].id, first_project);
        assert_eq!(registry.visible_runs_page(first, 0).unwrap().runs.len(), 12);
        registry.revoke(first).unwrap();
        assert!(registry.visible_runs_page(first, 0).is_err());
    }

    #[test]
    fn persists_device_grants_and_rejects_other_devices_and_removed_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobile/devices.json");
        let mut registry = MobileRegistry::open(path.clone()).unwrap();
        let first_key = key();
        let first = registry
            .register("첫 기기", &first_key, &[scope()])
            .unwrap();
        let second = registry.register("다른 기기", &key(), &[scope()]).unwrap();
        let project = registry.projects(first).unwrap()[0].id;
        let request_key = Uuid::new_v4();
        let hash = "a".repeat(64);
        let reserved = registry
            .reserve(first, project, request_key, &hash)
            .unwrap();
        assert!(!reserved.existing);
        assert!(registry.authorize_run(second, reserved.run_id).is_err());
        // Run ownership must remain independent of project grants, including if
        // two devices are ever assigned the same opaque project identifier.
        let second_project = registry.projects(second).unwrap()[0].id;
        registry
            .data
            .devices
            .iter_mut()
            .find(|device| device.id == second)
            .unwrap()
            .projects[0]
            .id = project;
        assert!(registry.authorize_run(second, reserved.run_id).is_err());
        registry
            .data
            .devices
            .iter_mut()
            .find(|device| device.id == second)
            .unwrap()
            .projects[0]
            .id = second_project;
        assert!(registry
            .reserve(first, project, request_key, &"b".repeat(64))
            .is_err());
        registry.mark_started(first, reserved.run_id).unwrap();
        let mut reopened = MobileRegistry::open(path).unwrap();
        assert_eq!(reopened.authenticate(&first_key).unwrap(), first);
        let repeated = reopened
            .reserve(first, project, request_key, &hash)
            .unwrap();
        assert_eq!(repeated.run_id, reserved.run_id);
        assert!(repeated.existing && repeated.started);
        reopened.set_scopes(first, &[]).unwrap();
        assert!(reopened.authorize_run(first, reserved.run_id).is_err());
        reopened.revoke(first).unwrap();
        assert!(reopened.authenticate(&first_key).is_err());
    }

    #[test]
    fn failed_persistence_never_grants_a_device() {
        let dir = tempfile::tempdir().unwrap();
        let not_a_directory = dir.path().join("file");
        let mut registry = MobileRegistry::open(not_a_directory.join("devices.json")).unwrap();
        fs::write(&not_a_directory, b"x").unwrap();
        assert!(registry.register("기기", &key(), &[scope()]).is_err());
        assert!(registry.devices().is_empty());
    }
}
