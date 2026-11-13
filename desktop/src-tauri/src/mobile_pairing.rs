//! One-use enrollment state for the Mac companion server. Secrets stay in
//! memory; the UI receives only a QR image and a separate confirmation code.
use base64::{
    engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD},
    Engine,
};
use image::{DynamicImage, ImageFormat, Luma};
use rand::{rngs::OsRng, RngCore};
use russh::keys::{Algorithm, EcdsaCurve, PublicKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    io::Cursor,
    net::Ipv4Addr,
    time::{Duration, Instant},
};
use uuid::Uuid;

const LIFETIME: Duration = Duration::from_secs(120);
const MAX_ATTEMPTS: u8 = 5;

struct Issued {
    hash: [u8; 32],
    deadline: Instant,
    attempts: u8,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub id: Uuid,
    pub name: String,
    pub fingerprint: String,
    pub confirmation_code: String,
}

struct Pending {
    view: PendingView,
    public_key: Vec<u8>,
    session: Uuid,
    deadline: Instant,
    approved: bool,
}

#[derive(Default)]
pub struct PairingGate {
    issued: Option<Issued>,
    pending: Option<Pending>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EnrollmentStatus {
    Waiting,
    Approved,
    Unavailable,
}

impl PairingGate {
    /// The enrollment value itself never crosses Tauri IPC.
    pub fn issue_qr(
        &mut self,
        host: Ipv4Addr,
        port: u16,
        fingerprint: &str,
        unix_now: u64,
        now: Instant,
    ) -> Result<Vec<u8>, String> {
        if !host.is_private() || port == 0 || !valid_fingerprint(fingerprint) {
            return Err("사설 네트워크 주소와 Mac 지문을 확인하세요.".into());
        }
        let token = self.issue_token(now);
        let payload = serde_json::json!({
            "v": 1, "host": host.to_string(), "port": port,
            "fingerprint": fingerprint, "expires": unix_now.saturating_add(LIFETIME.as_secs()),
            "token": URL_SAFE_NO_PAD.encode(token),
        });
        let code = qrcode::QrCode::new(payload.to_string().as_bytes())
            .map_err(|_| "QR 코드를 만들지 못했습니다.")?;
        let pixels = code.render::<Luma<u8>>().min_dimensions(420, 420).build();
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageLuma8(pixels)
            .write_to(&mut png, ImageFormat::Png)
            .map_err(|_| "QR 코드를 만들지 못했습니다.")?;
        Ok(png.into_inner())
    }

    fn issue_token(&mut self, now: Instant) -> [u8; 32] {
        let mut token = [0u8; 32];
        OsRng.fill_bytes(&mut token);
        self.pending = None;
        self.issued = Some(Issued {
            hash: Sha256::digest(token).into(),
            deadline: now + LIFETIME,
            attempts: 0,
        });
        token
    }

    /// The caller supplies a server-generated session id, never one from the phone.
    pub fn begin(
        &mut self,
        session: Uuid,
        token_text: &str,
        name: &str,
        public_key: &[u8],
        now: Instant,
    ) -> Result<PendingView, String> {
        let issued = self.issued.as_mut().ok_or("유효한 등록 QR이 없습니다.")?;
        if now >= issued.deadline {
            self.close();
            return Err("QR이 만료되었습니다. Mac에서 다시 발급하세요.".into());
        }
        let token = URL_SAFE_NO_PAD.decode(token_text).unwrap_or_default();
        let hash = Sha256::digest(&token);
        #[allow(deprecated)]
        let matches = token.len() == 32
            && ring::constant_time::verify_slices_are_equal(&hash, &issued.hash).is_ok();
        if !matches {
            issued.attempts += 1;
            if issued.attempts >= MAX_ATTEMPTS {
                self.close();
            }
            return Err("등록 정보를 확인하세요.".into());
        }
        let deadline = issued.deadline;
        // Consume before parsing any device data; even malformed use cannot replay it.
        self.issued = None;
        let name = name.trim();
        if name.is_empty()
            || name.chars().count() > 60
            || name.chars().any(char::is_control)
            || public_key.len() > 512
        {
            return Err("기기 정보를 확인하세요.".into());
        }
        let key = PublicKey::from_bytes(public_key).map_err(|_| "기기 공개키를 확인하세요.")?;
        if key.algorithm()
            != (Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            })
        {
            return Err("지원하지 않는 기기 공개키입니다.".into());
        }
        let view = PendingView {
            id: Uuid::new_v4(),
            name: name.to_owned(),
            fingerprint: format!(
                "SHA256:{}",
                STANDARD_NO_PAD.encode(Sha256::digest(public_key))
            ),
            confirmation_code: confirmation_code(&token, public_key),
        };
        self.pending = Some(Pending {
            view: view.clone(),
            public_key: public_key.to_vec(),
            session,
            deadline,
            approved: false,
        });
        Ok(view)
    }

    pub fn pending_view(&mut self, now: Instant) -> Option<PendingView> {
        self.expire(now);
        self.pending
            .as_ref()
            .filter(|item| !item.approved)
            .map(|item| item.view.clone())
    }

    /// A caller must persist the device and its Mac-selected permissions before
    /// marking this attempt approved. A failed persistence must never grant access.
    pub fn approval_key(&mut self, id: Uuid, now: Instant) -> Option<(PendingView, Vec<u8>)> {
        self.expire(now);
        self.pending
            .as_ref()
            .filter(|item| item.view.id == id && !item.approved)
            .map(|item| (item.view.clone(), item.public_key.clone()))
    }

    pub fn mark_approved(&mut self, id: Uuid, now: Instant) -> bool {
        self.expire(now);
        if let Some(pending) = self
            .pending
            .as_mut()
            .filter(|item| item.view.id == id && !item.approved)
        {
            pending.approved = true;
            true
        } else {
            false
        }
    }

    /// Only the enrollment session which submitted the token can claim approval.
    pub fn claim_approval(&mut self, session: Uuid, now: Instant) -> bool {
        self.expire(now);
        if self
            .pending
            .as_ref()
            .is_some_and(|item| item.session == session && item.approved)
        {
            self.pending = None;
            true
        } else {
            false
        }
    }

    pub fn poll(&mut self, session: Uuid, now: Instant) -> EnrollmentStatus {
        self.expire(now);
        match self.pending.as_ref() {
            Some(item) if item.session == session && item.approved => {
                self.pending = None;
                EnrollmentStatus::Approved
            }
            Some(item) if item.session == session => EnrollmentStatus::Waiting,
            _ => EnrollmentStatus::Unavailable,
        }
    }

    pub fn close(&mut self) {
        self.issued = None;
        self.pending = None;
    }

    pub fn cancel_session(&mut self, session: Uuid) {
        if self
            .pending
            .as_ref()
            .is_some_and(|item| item.session == session)
        {
            self.pending = None;
        }
    }

    pub fn registration_open(&mut self, now: Instant) -> bool {
        self.expire(now);
        self.issued.is_some()
    }

    fn expire(&mut self, now: Instant) {
        if self
            .issued
            .as_ref()
            .is_some_and(|item| now >= item.deadline)
        {
            self.issued = None;
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|item| now >= item.deadline)
        {
            self.pending = None;
        }
    }
}

fn valid_fingerprint(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("SHA256:") else {
        return false;
    };
    let Ok(bytes) = STANDARD_NO_PAD.decode(encoded) else {
        return false;
    };
    bytes.len() == 32 && STANDARD_NO_PAD.encode(bytes) == encoded
}

fn confirmation_code(token: &[u8], public_key: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"toris-mobile-confirm-v1\0");
    hash.update(token);
    hash.update(public_key);
    let digest = hash.finalize();
    let number = u32::from_be_bytes(digest[..4].try_into().unwrap()) & 0x7fff_ffff;
    format!("{:06}", number % 1_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::PrivateKey;
    use std::sync::{Arc, Mutex};

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

    #[test]
    fn enrollment_is_one_use_and_approval_is_bound_to_the_session_and_key() {
        let now = Instant::now();
        let mut gate = PairingGate::default();
        let token = gate.issue_token(now);
        let key = key();
        let session = Uuid::new_v4();
        let view = gate
            .begin(session, &URL_SAFE_NO_PAD.encode(token), "휴대폰", &key, now)
            .unwrap();
        assert_eq!(view.confirmation_code, confirmation_code(&token, &key));
        assert!(gate
            .begin(
                Uuid::new_v4(),
                &URL_SAFE_NO_PAD.encode(token),
                "복제",
                &key,
                now
            )
            .is_err());
        assert!(!gate.claim_approval(session, now));
        assert!(gate.approval_key(Uuid::new_v4(), now).is_none());
        assert!(gate.mark_approved(view.id, now));
        assert!(!gate.claim_approval(Uuid::new_v4(), now));
        assert!(gate.claim_approval(session, now));
        assert!(!gate.claim_approval(session, now));
    }

    #[test]
    fn generated_qr_is_decodable_and_contains_only_the_enrollment_fields() {
        let now = Instant::now();
        let mut gate = PairingGate::default();
        let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode([4u8; 32]));
        let png = gate
            .issue_qr(Ipv4Addr::new(192, 168, 1, 5), 2345, &fingerprint, 1000, now)
            .unwrap();
        let image = image::load_from_memory(&png).unwrap().to_luma8();
        let mut prepared = rqrr::PreparedImage::prepare(image);
        let grids = prepared.detect_grids();
        assert_eq!(grids.len(), 1);
        let (_, text) = grids[0].decode().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(payload.as_object().unwrap().len(), 6);
        assert_eq!(payload["v"], 1);
        assert_eq!(payload["expires"], 1120);
        assert_eq!(payload["fingerprint"], fingerprint);
        let token = payload["token"].as_str().unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(token).unwrap().len(), 32);
        assert!(gate
            .begin(Uuid::new_v4(), token, "휴대폰", &key(), now)
            .is_ok());
    }

    #[test]
    fn confirmation_matches_android_protocol_vector() {
        let token: Vec<u8> = (0..32).collect();
        assert_eq!(confirmation_code(&token, &[1, 2]), "396241");
    }

    #[test]
    fn expiry_reissue_closing_and_invalid_attempts_invalidate_tokens() {
        let now = Instant::now();
        let mut gate = PairingGate::default();
        let key = key();
        let old = gate.issue_token(now);
        let new = gate.issue_token(now);
        assert!(gate
            .begin(
                Uuid::new_v4(),
                &URL_SAFE_NO_PAD.encode(old),
                "기기",
                &key,
                now
            )
            .is_err());
        assert!(gate
            .begin(
                Uuid::new_v4(),
                &URL_SAFE_NO_PAD.encode(new),
                "기기",
                &key,
                now + LIFETIME
            )
            .is_err());
        let token = gate.issue_token(now);
        for _ in 0..MAX_ATTEMPTS {
            assert!(gate
                .begin(Uuid::new_v4(), "invalid", "기기", &key, now)
                .is_err());
        }
        assert!(gate
            .begin(
                Uuid::new_v4(),
                &URL_SAFE_NO_PAD.encode(token),
                "기기",
                &key,
                now
            )
            .is_err());
        let token = gate.issue_token(now);
        gate.close();
        assert!(gate
            .begin(
                Uuid::new_v4(),
                &URL_SAFE_NO_PAD.encode(token),
                "기기",
                &key,
                now
            )
            .is_err());
    }

    #[test]
    fn concurrent_registration_consumes_a_token_only_once() {
        let now = Instant::now();
        let mut gate = PairingGate::default();
        let token = URL_SAFE_NO_PAD.encode(gate.issue_token(now));
        let gate = Arc::new(Mutex::new(gate));
        let key = key();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let gate = Arc::clone(&gate);
                let token = token.clone();
                let key = key.clone();
                std::thread::spawn(move || {
                    gate.lock()
                        .unwrap()
                        .begin(Uuid::new_v4(), &token, "기기", &key, now)
                        .is_ok()
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|t| t.join().unwrap())
                .filter(|ok| *ok)
                .count(),
            1
        );
    }
}
