//! A small, unprivileged HTTP document for the official YouTube iframe player.
//!
//! The native app uses a custom URI scheme, which cannot provide the HTTP Referer
//! required by YouTube. A loopback document gives the player a normal web origin.
//! This listener only serves generated HTML for validated video IDs. It exposes
//! no credentials, filesystem, forwarding, or IPC and requires a random path.

use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{OnceCell, Semaphore},
    task::JoinHandle,
};
use uuid::Uuid;

const MAX_REQUEST_BYTES: usize = 8192;
const MAX_CONNECTIONS: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
static SERVER: OnceCell<EmbedServer> = OnceCell::const_new();

struct EmbedServer {
    route: Arc<EmbedRoute>,
    _task: JoinHandle<()>,
}

struct EmbedRoute {
    address: SocketAddr,
    capability: String,
}

/// Accept only YouTube's opaque eleven-character IDs, never an arbitrary URL.
pub fn validate_video_id(video_id: &str) -> Result<(), String> {
    if video_id.len() == 11
        && video_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        Ok(())
    } else {
        Err("올바른 YouTube 영상 ID가 필요합니다.".into())
    }
}

pub async fn prepare(video_id: String) -> Result<String, String> {
    validate_video_id(&video_id)?;
    let server = SERVER.get_or_try_init(EmbedServer::start).await?;
    Ok(server.route.viewer_url(&video_id))
}

impl EmbedServer {
    async fn start() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| "영상 미리보기 연결을 열 수 없습니다. 다시 시도하세요.".to_string())?;
        let address = listener
            .local_addr()
            .map_err(|_| "영상 미리보기 주소를 확인할 수 없습니다.".to_string())?;
        let route = Arc::new(EmbedRoute {
            address,
            capability: Uuid::new_v4().simple().to_string(),
        });
        let task_route = route.clone();
        let task = tokio::spawn(async move {
            let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
            while let Ok((stream, peer)) = listener.accept().await {
                if !peer.ip().is_loopback() {
                    continue;
                }
                let Ok(permit) = connections.clone().try_acquire_owned() else {
                    continue;
                };
                let route = task_route.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = tokio::time::timeout(REQUEST_TIMEOUT, serve(stream, &route)).await;
                });
            }
        });
        Ok(Self { route, _task: task })
    }
}

impl EmbedRoute {
    fn viewer_url(&self, video_id: &str) -> String {
        format!(
            "http://{}/{}/youtube/{video_id}",
            self.address, self.capability
        )
    }

    fn video_from_request(&self, request: &str) -> Result<String, u16> {
        let mut lines = request.split("\r\n");
        let request_line = lines.next().ok_or(400u16)?;
        let parts: Vec<_> = request_line.split(' ').collect();
        if parts.len() != 3 || parts[2] != "HTTP/1.1" {
            return Err(400);
        }
        if parts[0] != "GET" {
            return Err(405);
        }
        let prefix = format!("/{}/youtube/", self.capability);
        let video_id = parts[1].strip_prefix(&prefix).ok_or(404u16)?;
        validate_video_id(video_id).map_err(|_| 404u16)?;

        let mut host = None;
        let mut origin = None;
        let mut content_length = None;
        let mut count = 0;
        for line in lines {
            if line.is_empty() {
                break;
            }
            count += 1;
            if count > 64 || line.bytes().any(|byte| byte < 32 && byte != b'\t') {
                return Err(400);
            }
            let (name, value) = line.split_once(':').ok_or(400u16)?;
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err(400);
            }
            let value = value.trim();
            match name.to_ascii_lowercase().as_str() {
                "host" => {
                    if host.replace(value).is_some() {
                        return Err(400);
                    }
                }
                "origin" => {
                    if origin.replace(value).is_some() {
                        return Err(400);
                    }
                }
                "content-length" => {
                    if content_length.replace(value).is_some() || value != "0" {
                        return Err(400);
                    }
                }
                "transfer-encoding" => return Err(400),
                "sec-fetch-dest" if !matches!(value, "iframe" | "document" | "empty") => {
                    return Err(403);
                }
                _ => {}
            }
        }
        // Reject DNS rebinding and ambiguous authority headers.
        if host != Some(self.address.to_string().as_str()) {
            return Err(403);
        }
        if let Some(origin) = origin {
            let local_origin = format!("http://{}", self.address);
            if !matches!(
                origin,
                "tauri://localhost"
                    | "http://tauri.localhost"
                    | "https://tauri.localhost"
                    | "http://127.0.0.1:1420"
            ) && origin != local_origin
            {
                return Err(403);
            }
        }
        Ok(video_id.to_owned())
    }

    fn html(&self, video_id: &str) -> String {
        let origin = format!("http://{}", self.address);
        let origin_parameter: String =
            url::form_urlencoded::byte_serialize(origin.as_bytes()).collect();
        format!(
            r#"<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="strict-origin-when-cross-origin"><title>YouTube 영상 미리보기</title><style>html,body{{margin:0;width:100%;height:100%;background:#10141d}}iframe{{display:block;border:0;width:100%;height:100%;min-height:200px}}</style></head><body><iframe title="YouTube 영상 플레이어" src="https://www.youtube-nocookie.com/embed/{video_id}?autoplay=1&amp;playsinline=1&amp;rel=0&amp;origin={origin_parameter}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></body></html>"#
        )
    }
}

async fn serve(mut stream: TcpStream, route: &EmbedRoute) -> std::io::Result<()> {
    let mut buffer = [0u8; MAX_REQUEST_BYTES];
    let mut length = 0;
    let status_and_body = loop {
        if length == buffer.len() {
            break (431, String::new());
        }
        let read = stream.read(&mut buffer[length..]).await?;
        if read == 0 {
            return Ok(());
        }
        length += read;
        if let Some(end) = buffer[..length]
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
        {
            // This is a document-only endpoint, with neither bodies nor pipelining.
            if end + 4 != length {
                break (400, String::new());
            }
            let Ok(request) = std::str::from_utf8(&buffer[..length]) else {
                break (400, String::new());
            };
            break match route.video_from_request(request) {
                Ok(video_id) => (200, route.html(&video_id)),
                Err(status) => (status, String::new()),
            };
        }
    };
    let (status, body) = status_and_body;
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        _ => "Bad Request",
    };
    let csp = "default-src 'none'; frame-src https://www.youtube-nocookie.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors tauri://localhost http://tauri.localhost https://tauri.localhost http://127.0.0.1:1420";
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: strict-origin-when-cross-origin\r\nContent-Security-Policy: {csp}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> EmbedRoute {
        EmbedRoute {
            address: "127.0.0.1:49152".parse().unwrap(),
            capability: "16b393e99f994ccf80d5106db2197061".into(),
        }
    }

    fn request(route: &EmbedRoute, video_id: &str, headers: &str) -> String {
        format!(
            "GET /{}/youtube/{video_id} HTTP/1.1\r\nHost: {}\r\n{headers}\r\n",
            route.capability, route.address
        )
    }

    #[test]
    fn only_opaque_video_ids_cross_the_boundary() {
        for valid in ["M7lc1UVf-VE", "aBcDeF01-_2"] {
            assert!(validate_video_id(valid).is_ok());
        }
        for invalid in [
            "",
            "M7lc1UVf-VE?autoplay=1",
            "https://youtu.be/M7lc1UVf-VE",
            "../secrets!",
            "<script>123",
            "한글123456789",
        ] {
            assert!(validate_video_id(invalid).is_err());
        }
    }

    #[test]
    fn capability_host_and_method_are_required() {
        let route = route();
        let valid = request(&route, "M7lc1UVf-VE", "Sec-Fetch-Dest: iframe\r\n");
        assert_eq!(route.video_from_request(&valid).unwrap(), "M7lc1UVf-VE");
        assert_eq!(
            route.video_from_request(&valid.replace("GET", "POST")),
            Err(405)
        );
        assert_eq!(
            route.video_from_request(&valid.replace(&route.capability, "unknown")),
            Err(404)
        );
        assert_eq!(
            route
                .video_from_request(&valid.replace("Host: 127.0.0.1:49152", "Host: attacker.test")),
            Err(403)
        );
        assert_eq!(
            route.video_from_request(&request(&route, "M7lc1UVf-VE", "Host: attacker.test\r\n")),
            Err(400)
        );
    }

    #[test]
    fn foreign_origins_bodies_and_fetches_are_rejected() {
        let route = route();
        assert!(route
            .video_from_request(&request(
                &route,
                "M7lc1UVf-VE",
                "Origin: tauri://localhost\r\n"
            ))
            .is_ok());
        for headers in [
            "Origin: https://attacker.test\r\n",
            "Sec-Fetch-Dest: script\r\n",
        ] {
            assert_eq!(
                route.video_from_request(&request(&route, "M7lc1UVf-VE", headers)),
                Err(403)
            );
        }
        for headers in ["Content-Length: 5\r\n", "Transfer-Encoding: chunked\r\n"] {
            assert_eq!(
                route.video_from_request(&request(&route, "M7lc1UVf-VE", headers)),
                Err(400)
            );
        }
    }

    #[test]
    fn viewer_is_static_unprivileged_and_supplies_referrer() {
        let html = route().html("M7lc1UVf-VE");
        assert!(html.contains("https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?"));
        assert!(html.contains("origin=http%3A%2F%2F127.0.0.1%3A49152"));
        assert!(html.contains("strict-origin-when-cross-origin"));
        assert!(!html.contains("<script"));
        assert!(!html.contains("__TAURI"));
    }

    #[tokio::test]
    async fn loopback_serves_only_the_capability_document() {
        let server = EmbedServer::start().await.unwrap();
        let url = server.route.viewer_url("M7lc1UVf-VE");
        let client = reqwest::Client::new();
        let response = client.get(&url).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["referrer-policy"],
            "strict-origin-when-cross-origin"
        );
        assert!(response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("default-src 'none'"));
        assert!(response
            .text()
            .await
            .unwrap()
            .contains("youtube-nocookie.com/embed/M7lc1UVf-VE"));
        assert_eq!(client.post(&url).send().await.unwrap().status(), 405);
        assert_eq!(
            client
                .get(&url)
                .header("Host", "attacker.test")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .get(format!(
                    "http://{}/youtube/M7lc1UVf-VE",
                    server.route.address
                ))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        server._task.abort();
    }
}
