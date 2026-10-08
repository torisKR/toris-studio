# 로컬 키워드 수집 엔진

Toris Studio의 Rust 백엔드는 공식 검색 API로 발견한 공개 URL을 이 독립적인 Crawl4AI 서비스에 전달하고, 반환된 Markdown을 검증해 로컬 DB에 저장합니다. Google Opal 워크플로우, Google 로그인 세션, SNS 쿠키는 이 서비스에 전달하지 않습니다. 웹페이지 본문은 데이터로 처리하며 실행할 코드나 AI 지시문으로 사용하지 않습니다.

## 고정 실행 계약

| 항목 | 값 |
| --- | --- |
| 서비스 / 프로젝트 | `crawl4ai` / `toris-studio-keywords` |
| 공식 버전 | `0.9.4` |
| 고정 multi-platform image | `unclecode/crawl4ai:0.9.4@sha256:9021b3cb5c6f12570bbcd5395638495e0a06969b3148e377b953d174af2ebc9b` |
| 플랫폼 | `linux/arm64`, `linux/amd64` |
| 앱 접속 주소 | `http://127.0.0.1:11235` |
| 수집 인증 | `Authorization: Bearer <local crawler credential>` |
| 상태 | `GET /health` → `status: "ok"`, `version: "0.9.4"` |
| 수집 | `POST /crawl` → `results[].success`, `url`, `metadata.title`, `markdown.raw_markdown` |
| 메모리 / CPU / PID 상한 | `2 GiB` / `2` / `512` |

이미지는 [공식 0.9.4 Docker 정의](https://github.com/unclecode/crawl4ai/blob/v0.9.4/Dockerfile)를 사용합니다. macOS에서는 OrbStack, Windows에서는 Docker Desktop의 Linux 컨테이너 모드를 먼저 실행하세요. 앱의 수집 엔진 시작 기능이 사용자별 앱 데이터의 `crawler-stack` 폴더에 compose와 별도의 임의 인증값을 준비합니다. 서버 인증값은 SNS API 키와 독립적이며 공개 저장소와 설치 파일에 포함하지 않습니다. Unix 환경의 로컬 인증 파일은 `0600`, 폴더는 `0700`으로 제한합니다.

macOS에서 이미 초기화된 엔진의 운영 명령:

```sh
docker compose --env-file "$HOME/Library/Application Support/kr.toris.studio/crawler-stack/.env.crawler.local" -f "$HOME/Library/Application Support/kr.toris.studio/crawler-stack/compose.yaml" up -d --wait crawl4ai
docker compose --env-file "$HOME/Library/Application Support/kr.toris.studio/crawler-stack/.env.crawler.local" -f "$HOME/Library/Application Support/kr.toris.studio/crawler-stack/compose.yaml" ps
docker compose --env-file "$HOME/Library/Application Support/kr.toris.studio/crawler-stack/.env.crawler.local" -f "$HOME/Library/Application Support/kr.toris.studio/crawler-stack/compose.yaml" stop crawl4ai
```

인증값이 포함될 수 있으므로 `docker compose config` 또는 컨테이너 환경 전체를 출력하지 마세요. 구문 검증은 `config --quiet`를 사용합니다. 이 스택은 기존 PostgreSQL compose, DB 볼륨 또는 다른 애플리케이션 컨테이너를 변경하지 않습니다. 서비스의 임시 브라우저 상태와 내부 작업 데이터는 컨테이너 재생성 시 사라지고, 앱의 실제 콘텐츠 데이터는 기존 로컬 DB에 보관됩니다.

## 수집 범위와 보안

호스트의 브라우저 프로필, Docker 소켓, DB 폴더, 사용자 파일을 마운트하지 않습니다. 파일 시스템은 읽기 전용이고 공식 런타임 쓰기 경로만 크기가 제한된 tmpfs로 제공됩니다. Redis는 컨테이너 내부에서 임의 암호와 loopback으로 실행되며 포트를 외부에 공개하지 않습니다.

공식 [egress broker](https://github.com/unclecode/crawl4ai/blob/v0.9.4/deploy/docker/egress_broker.py)와 [pinning proxy](https://github.com/unclecode/crawl4ai/blob/v0.9.4/deploy/docker/egress_proxy.py)를 유지합니다. 대상의 DNS를 검증하고 같은 IP로 연결해 재해석을 피하며, 내부 IP 및 내부 주소로 리다이렉트하는 요청을 차단합니다. `CRAWL4AI_ALLOW_INTERNAL_URLS`, `CRAWL4AI_ALLOW_INSECURE_TLS`, hooks와 임의 JavaScript 실행 API는 비활성 상태를 유지합니다. 앱은 `check_robots_txt: true`로 요청하고 사이트의 응답, robots 규칙 및 접근 제한을 오류로 표시합니다.

공식 컨테이너의 Chromium 실행은 기본적으로 `--no-sandbox`를 사용합니다. 비특권 사용자, capability 제거, 읽기 전용 파일 시스템, 파일 마운트 금지로 컨테이너 경계를 유지합니다. 인증 토큰을 알고 있는 프로세스만 API를 호출하도록 하며, 크롤러를 외부 서버나 공용 포트로 노출하지 않습니다. Chromium sandbox를 켜려면 공식 가이드에 따라 해당 Docker 런타임에서 별도로 동작을 검증해야 합니다.

## 실제 검증

개발용 `smoke.py`는 표준 라이브러리만 사용하며, 앱의 처리 로직은 Rust입니다. health/version, 무인증 및 잘못된 토큰의 `401`, 공개 페이지 Markdown과 원문 주소, loopback/private/metadata/IPv6/DNS/리다이렉트 차단을 검사합니다. 응답 원문과 토큰은 터미널에 출력하지 않습니다.

```sh
python3 infrastructure/keyword-crawler/smoke.py --credential-file "$HOME/Library/Application Support/kr.toris.studio/crawler-stack/.env.crawler.local" --evidence-dir /private/tmp/toris-crawler-evidence-UNIQUE
```

각 테스트의 상태와 제한된 메타데이터만 출력하며, 요청별 원문은 선택한 증거 폴더의 새 `0600` 파일로 기록합니다. 타임아웃이나 서버 `5xx`는 주소 차단 성공으로 간주하지 않습니다.

2026-10-08 macOS ARM64 / OrbStack에서 고정 이미지를 시작하고 12개 실제 API 검증을 통과했습니다. 공개 페이지는 `200`, 원문 URL 및 제목이 일치하는 Markdown 1,285 bytes를 반환했습니다. 초기 내부 주소와 private DNS 응답은 `400 / URL blocked`, 공개 httpbin에서 내부 주소로 이동하는 요청은 최종 `403 / URL blocked`로 차단됐습니다. 실제 Docker 설정에서도 host mount 없음, read-only 및 위 자원 상한을 확인했습니다. 변경되는 DNS 응답을 주입하는 재바인딩 실험은 수행하지 않았으며, IP pinning은 공식 소스와 실제 proxy 차단 경로로 확인했습니다. 사용자 namespace 생성은 이 Docker 런타임에서 `Operation not permitted`로 거절됐으므로 Chromium sandbox 활성화를 검증했다고 표시하지 않습니다.

## 다른 수집 프로젝트

이번 실행 엔진은 Crawl4AI입니다. Firecrawl 어댑터의 이름만으로 로컬 Firecrawl을 실행 중이라고 표시하지 않습니다. [공식 self-host 문서](https://docs.firecrawl.dev/contributing/self-host)에 따르면 기본 구성은 여러 지원 서비스를 필요로 하며 인증이 꺼져 있습니다. 별도의 인증과 egress 검증 없이 앱에 연결하지 않습니다. Firecrawl의 고급 Fire-engine 기능은 기본 self-host 구성에 포함되지 않습니다.

나머지 도구의 적용 범위 및 활성 여부는 [키워드 탐색 설계](../../docs/KEYWORD_EXPLORER.md)를 참고하세요. 설치하지 않은 엔진을 실행 가능 상태로 표시하지 않으며, 기존 SNS 쿠키를 복제하거나 접근 제한을 우회하는 동작을 자동 활성화하지 않습니다.

## 출처 및 고지

Compose의 실행 보안 설정은 [Crawl4AI 0.9.4 공식 compose](https://github.com/unclecode/crawl4ai/blob/v0.9.4/docker-compose.yml)를 참고했고, Toris Studio에서 loopback 고정 포트, 이미지 digest, 리소스 및 tmpfs 크기를 별도로 제한했습니다. [API와 인증 계약](https://github.com/unclecode/crawl4ai/blob/v0.9.4/deploy/docker/server.py)은 공식 버전에 맞춥니다.

This product includes software developed by UncleCode (https://x.com/unclecode) as part of the Crawl4AI project (https://github.com/unclecode/crawl4ai).

[Crawl4AI 라이선스 및 attribution](https://github.com/unclecode/crawl4ai/blob/v0.9.4/LICENSE), [Firecrawl 라이선스](https://github.com/firecrawl/firecrawl/blob/main/LICENSE).
