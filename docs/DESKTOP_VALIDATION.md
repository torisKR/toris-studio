# 로컬 검증 기록 · 2026-10-08

아래 초기 실행 결과는 0.1.0 기준입니다. 이후 버전의 추가 검증은 문서 마지막에 기록합니다.

macOS Apple Silicon, Rust 1.96, Node.js 24, OrbStack 환경에서 확인했습니다. 구현은 Desktop App Engineer, Backend Architect, API Platform Engineer, Identity & Access Engineer, AI Engineer, Rust Refactoring Specialist, Application Security Engineer 역할에 나누어 진행했습니다.

## 확인한 실행 결과

- macOS release `.app`와 `.dmg` 생성 및 `tauri://localhost` 네이티브 창 실행. Next.js 서버 없이 DB 연결됨.
- 첨부 로고의 투명 배경을 유지한 ICNS·ICO 생성. 앱 번들 `Contents/Resources/icon.icns`가 원본 생성 ICNS와 SHA256 일치. Windows 아이콘은 여러 크기의 RGBA 이미지 포함.
- Rust DB 시작·마이그레이션 재실행: 기존 OrbStack PostgreSQL 데이터 유지, 컨테이너 healthy, `127.0.0.1:54329`에만 노출.
- DB 주소를 OS Keychain에 저장한 뒤 새 Rust 프로세스에서 다시 읽고 DB 연결 성공. 설정 JSON의 비밀 필드 6개는 모두 null, 파일 권한 0600.
- Rust `pg_dump` 백업 실제 생성, PostgreSQL CRUD/동시 업데이트/플랫폼 일치/일별 최초 관측 저장 계약 테스트 통과.
- Rust RSS 요청으로 실제 한국 인기 검색어 10개 수집·저장. YouTube·네이버 API 키는 입력되지 않아 해당 실서비스 수집을 확인한 것으로 표시하지 않음.
- 최종 앱 AI 작업실에서 OpenCodex `gpt-6.1-sol`로 한국어 초안 생성 성공. 생성 결과를 콘텐츠로 가져와 실제 PostgreSQL에 초안 저장 성공.
- 최종 앱 영상 화면에서 새로운 1장면 프로젝트 저장 후 Rust·FFmpeg로 2초 MP4 출력 성공. 기존 영상 프로젝트 유지.
- SNS 로그인 화면에 실제 Rust 상태가 반영되며, 미등록 5개 제공자의 로그인 버튼은 설정 전 비활성화.

## 검사 범위

Rust 전체 단위 테스트 56개 통과. 이 중 OAuth 19개는 모의 전송·저장소를 사용해 state 위조·재사용·만료, PKCE, 정확한 콜백, 원자적 토큰 갱신, 재연결, Windows UTF-16 저장 한도와 삭제 재시도를 검증했습니다. 기본 실행에서 제외한 DB·미디어 통합 테스트는 로컬 환경에서 별도로 실행했습니다.

기존 웹 테스트는 82개 통과·1개 기본 제외, 웹과 데스크톱 TypeScript 검사 통과, pnpm frozen lockfile 설치 확인. Git 이력 3개 커밋과 Git에 포함 가능한 현재 파일의 gitleaks 검사에서 유출 없음. Rust 보안 감사에서 macOS/Windows 취약점 오류는 없으며, 유지보수 중단 의존성 경고가 남습니다.

OAuth UI 렌더링은 모의 상태로 로그인 대기·완료·갱신·연결 해제·비밀 입력 초기화 및 820px 레이아웃을 검증했습니다. 이 결과는 실계정 로그인의 증거가 아닙니다.

## 확인하지 않은 범위

실제 SNS 클라이언트·계정으로 로그인, 토큰 갱신, 실제 YouTube API 키 요청, Windows 설치 파일 빌드·기기 실행은 미검증입니다. Windows 빌드 워크플로는 소스에 준비했으며 GitHub에 푸시하거나 실행하지 않았습니다. Claude CLI는 미로그인 상태였고 TeamClaude는 미설정이므로 성공한 AI 생성은 OpenCodex만 해당합니다.

플랫폼 자동 발행·업로드 API는 데스크톱에 구현하지 않았습니다. 콘텐츠 발행 계획은 DB 기록입니다. 브라우저 쿠키는 기본 브라우저가 관리하고 앱은 OAuth 토큰을 저장·갱신합니다. Python/MLX TTS 모델 추론은 기존 외부 로컬 서비스를 사용합니다. 맥 앱은 로컬 빌드이며 배포 공증·업데이트 운영은 별도입니다.

공개 소스에 실제 토큰·DB 비밀번호·백업·렌더 결과를 포함하지 않았습니다. OS 저장소 장애 시 갱신 후 이전의 암호화된 토큰 조각 정리가 실패해 잔여물이 남을 수 있습니다. 평문 또는 화면 노출은 허용하지 않습니다.

## 0.1.4 소스 검사

- 데스크톱 TypeScript 검사 통과. Rust 단위 테스트 71개 통과, DB·미디어 환경이 필요한 2개 기본 제외. 별도 PostgreSQL 계약 테스트 1개도 기본 제외이며 이 실행에서 통합 검증을 다시 실행하지 않았습니다.
- `pnpm desktop:build --ci --bundles app`으로 macOS Apple Silicon 0.1.4 앱 생성 완료. Tauri 기준 번들 크기는 12.77 MiB이며 로컬 ad-hoc 서명 후 `codesign --verify --deep --strict` 통과. 배포 인증서 서명·공증은 하지 않았습니다. 번들 병합 후 버전·ATS 설정과 원본 ICNS의 SHA256 일치 확인.
- 서명된 소스 앱과 Applications 링크로 `Toris Studio_0.1.4_aarch64.dmg` 생성. `hdiutil verify` 내장 체크섬 검증 통과, 파일 크기 7,325,680 bytes. 이 단계에서는 `/Applications`의 실행 중 설치본을 변경하지 않았습니다.
- Git 이력 3개 커밋과 Git에 포함 가능한 현재 파일 약 32.13 MB의 gitleaks 검사에서 유출 없음.
- YouTube 플레이어 문서는 Rust의 `127.0.0.1` 임의 포트와 무작위 경로에서만 제공합니다. 영상 ID만 허용하고 외부 Host·Origin, 임의 URL·파일·IPC를 허용하지 않습니다. YouTube 요청에 실제 loopback origin과 HTTP Referer를 사용하며 선택적 `widget_referrer`는 생략합니다.
- ATS는 `127.0.0.1`의 HTTP에만 예외를 둡니다. [Apple 공식 문서](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)에 따르면 macOS 12/13은 IP 연결을 기본 허용하고 macOS 14부터 IP별 예외가 필요합니다. `NSAllowsArbitraryLoads`나 `NSAllowsArbitraryLoadsInWebContent`를 추가하지 않았습니다. 이전 macOS 버전의 실제 기기 실행은 검증하지 않았습니다.

앱 번들·디스크 이미지 검사는 실계정 인증이나 영상 재생의 증거와 구분합니다. 실계정 연결과 네이티브 재생 결과는 별도로 기록합니다.

## 0.1.5 Opal 및 Aside 연결 검사

- macOS arm64 수정본을 기존 설치본 백업 후 `/Applications/Toris Studio.app`에 설치했습니다. 실행 파일 SHA256은 `c1fb12ef88d9b4a8cdface5b4c7f2c2fff736354b5c976b1c9fdfd5a92472f29`이며 엄격한 서명 검증을 통과했습니다. DMG는 7,451,311 bytes, SHA256 `da297393da60b57c7746b2a209f0660764449c93c33fb52d9db07efb56badaa6`이며 내장 체크섬을 검증했습니다.
- Rust 핵심 검사 79개 통과·2개 기본 제외 이후 Aside 브라우저 선택을 포함한 OAuth 검사 21개와 URL 인수 인코딩 회귀 검사 1개를 별도로 통과했습니다. 데스크톱 TypeScript·Vite 검사도 통과했습니다.
- 최종 설치 실행 파일의 `--db-migrate`가 실제 OrbStack PostgreSQL에 `004`·`005`를 적용했습니다. 실제 애플리케이션 계정으로 정상 결과의 삽입·조회가 일치했고 잘못된 결과 8종은 모두 `23514`로 거부했습니다. 새 결과 형식 제약은 validated 상태이며 UPDATE·DELETE·TRUNCATE 권한이 없습니다. 검증 트랜잭션은 전부 롤백했고 Opal 행 수는 0→0, 검증 UUID도 남지 않았습니다.
- 기존 설치본에서 YouTube·네이버 OAuth 연결 2개와 채널·콘텐츠 각 1개가 유지되었습니다. 네이버 재발급 Secret을 OS 저장소에 갱신하고 실제 네이버 로그인을 다시 완료했습니다. YouTube 플레이어는 이전 0.1.4 네이티브 화면에서 실제 재생을 확인했습니다.
- Instagram 안내 콜백을 소유 도메인에 배포하고 Meta에 등록했습니다. 실계정 인증 완료와 토큰 저장은 아직 확인하지 않았습니다. 네이버 검색 API는 실제 요청이 `401/024`이며 개발자센터 검색 API 활성화가 남았습니다.
- Opal UI·JSON 검증·로컬 이력 저장 경로를 구현했습니다. 실제 Opal 사이트는 Sign in/Try Opal 이후에도 Welcome 페이지로 돌아와 워크플로 생성과 실행을 완료하지 못했습니다. 모의 결과를 실제 이력으로 넣지 않았습니다. 수동 준비 문서는 [Opal 워크플로 프롬프트](OPAL_WORKFLOW_PROMPT.md)에 있습니다.

키체인 승인 반복은 별도 수정 중이며 이후 설치본 검증은 다음 버전에 기록합니다.


## 0.1.6 키체인 승인 및 재실행 검사

- 키체인 값을 하나의 암호화된 항목으로 통합하고, 프로세스 내 읽기 캐시와 프로세스 간 변경 감지를 적용했습니다. 거부 이후 자동 재요청은 중지하며 앱에서 사용자가 직접 권한 확인을 다시 요청할 수 있습니다.
- 실제 설치본을 두 차례 종료·재실행해 추가 승인 요청 없이 DB와 YouTube·네이버 연결 2개가 복원되었습니다. 네이버 자동 토큰 갱신도 확인했습니다. 기존 채널·콘텐츠 각 1개가 유지되었습니다.
- Rust 핵심 검사 91개 통과, 환경이 필요한 검사 3개 기본 제외. 데스크톱 타입 검사·UI 빌드·엄격한 macOS 앱 서명 검증·공개 파일 비밀값 검사 통과.
- 로컬 빌드는 ad-hoc 서명입니다. 다른 빌드로 업데이트한 후에도 OS 신뢰를 유지하려면 같은 Developer ID 인증서를 통한 서명 설정이 필요합니다. 반복 읽기로 발생하던 권한 요청과 OS의 빌드 교체 승인은 구분합니다.
