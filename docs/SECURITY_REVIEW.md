# 보안 검사와 Tauri 적용 기록

검사일: 2026-10-11. 검사 기준은 수정 전 `ac450988f14bec3bfd95dc42860b8d9767f8e42b`이며, 아래 수정과 검증은 로컬 작업 사본에서 진행했다. 설치 앱과 공개 서비스에 반영된 상태를 뜻하지 않는다.

## 검사 범위

Rust 데스크톱, 번들 UI, 기존 웹/API/MCP, OAuth와 게시 큐, 미디어 전송, CI와 배포 스크립트를 소스 기준으로 검토했다. 수정 전 추적 파일 441개를 대상으로 격리된 비밀값 패턴 검사도 수행했으며 탐지는 0건이었다. 개인 설정 파일, 키체인, 실제 계정 세션, 별도 미추적 프로젝트, Git 전체 이력은 이 검사의 대상이 아니다.

소스 검토, 합성 요청을 사용하는 모의 실행, 패키지 권고 조회를 조합했다. 실제 SNS 게시나 공개 Worker 공격 요청은 실행하지 않았다. 외부 Codexify·브라우저·크롤러 구현과 공개 서비스의 런타임 설정은 검증되지 않았으므로 전체 시스템의 무취약성을 인증하는 검사가 아니다.

## 수정한 항목

| 항목 | 확인 결과와 수정 |
| --- | --- |
| OAuth 콜백 Worker의 전달 대상 | 중간 심각도 1건. 요청 경로를 상대 URL로 해석하면 지정된 Sites 서버 대신 다른 서버로 요청할 수 있었다. 신뢰하는 origin을 먼저 만들고 pathname/search를 대입하도록 수정했다. |
| 프록시 리디렉션 | 문자열 접두사 비교를 URL의 정확한 origin 비교로 바꾸었다. 상대 주소는 요청된 upstream 페이지 기준으로 해석하며, 다른 호스트·포트·사용자 정보가 있는 주소는 로컬 주소로 바꾸지 않는다. |
| JavaScript 의존성 | 수정 전 권고 7건은 버전 일치 결과이며 앱에서 7개 공격이 가능하다는 뜻은 아니다. Next를 16.3.8, source-map-js를 1.2.2로 고정한 뒤 `pnpm audit`는 0건이다. |
| Rust 의존성 | 두 Cargo.lock에서 보안 취약점은 0건이다. 데스크톱에는 proc-macro-error와 ttf-parser의 유지보수 종료, Linux glib 관련 안내 3건이 남아 있다. glib는 현재 Mac·Windows 대상에 포함되지 않는다. |

Worker 수정은 아직 공개 배포되지 않았다. `infrastructure/oauth-callback/deploy-manifest.json`은 새 소스를 배포 대기로 표시하고 과거 배포 증거를 `historicalDeployment`에 구분한다. 배포와 확인 절차는 해당 디렉터리의 README를 따른다.

## Tauri 기능 적용

- **명령 권한:** 90개 앱 명령을 `ipc_commands.rs` 한 곳에 등록했다. 같은 목록을 invoke handler와 Tauri `AppManifest`가 사용한다. 명령 추가와 권한 목록이 어긋나면 계약 테스트가 실패한다.
- **Capability:** 로컬 `main` 창에 앱 명령과 이벤트 listen/unlisten만 허용한다. 포괄적인 `core:default` 대신 필요한 권한을 명시한다. 원격 창과 JS shell·filesystem·opener 권한은 추가하지 않았다. 기존 Rust 경로 검증과 창 인증도 유지한다.
- **Channel:** 영상 렌더 명령이 Tauri Channel로 준비·장면 렌더·합치기·출력 확인을 전달한다. 장면 수는 실제 FFmpeg 성공 후 증가하며 최종 성공은 IPC 결과가 돌아온 뒤 표시한다. 시간 추정이나 가짜 진행률은 사용하지 않는다.
- **UI 연결:** 기존 영상 제작 패널을 메뉴에 연결했다. 메뉴 이동 시 패널을 숨겨 작업 상태를 유지하며, 종료된 요청의 늦은 이벤트는 무시한다. 기존 ChatGPT 대화 경로를 사용한다.
- **기존 네이티브 기능:** 트레이, 업데이트, OS 비밀값 저장소, 파일 선택과 미디어 처리는 기존 Rust 경로를 유지한다. 이 검사를 위해 실제 비밀값이나 로그인 세션을 읽지 않았다.

## 실행한 검증

| 검증 | 결과 |
| --- | --- |
| Node 24 전체 계약 테스트 | 165 통과, 1 건너뜀(DB 명시적 opt-in) |
| 실제 Worker를 호출하는 모의 fetch 테스트 | 13 통과 |
| 번들 런타임 패키징 계약 | 15 통과, 다운로드 없음 |
| 배포 에셋·서명 검증 계약 | Node 9개와 Rust 2개 통과, 모의 배포·합성 서명만 사용 |
| Rust no-default-features 전체 테스트 | 231 통과, 10 무시됨(환경·실계정 opt-in 포함) |
| 기본 desktop feature의 Cargo check | 통과 |
| 기본 desktop feature의 ACL 계약 | 4 통과; 실제 컴파일된 manifest와 capability 검사 포함 |
| 임시 2장면 MP4 출력 | 통과; 실제 FFmpeg/FFprobe, 해상도·길이·진행 이벤트 순서 확인 |
| 누락 미디어 실패 경로 | 통과; 완료 이벤트와 최종 출력이 발생하지 않음 |
| 데스크톱 TypeScript, Vite 빌드, Rustfmt, diff 공백 | 통과 |
| 수정 후 추적 파일과 신규 작업 파일의 비밀값 패턴 검사 | 격리 사본 447개 파일, 탐지 0건 |

Rust 전체 테스트는 처음에 샌드박스의 loopback 소켓 제한으로 실패했다. 테스트 전용 로컬 서버 사용을 허용한 동일 테스트에서 통과했다. 실제 서비스나 계정을 호출하도록 변경한 테스트는 없다.

루트 전체 TypeScript 검사에는 기존 AI/Codexify 테스트의 타입 오류가 남아 있다. 이번에 수정한 데스크톱 프로젝트의 TypeScript 검사는 통과한다. 실제 설치 앱의 WebView 조작, Windows 실기, 공개 Worker 배포, DB opt-in 및 실제 SNS 게시 검증은 이 기록에 포함되지 않는다.

## CI 반영

Desktop CI는 모든 루트 계약 테스트와 Worker 테스트, `pnpm audit`, Mac·Windows 빌드 대상에서 기본 feature ACL 계약을 실행하도록 변경했다. 테스트와 workspace override 변경도 workflow를 시작한다. CI 설정은 작성됐으며 원격 실행 결과나 신규 Release·Packages 배포는 아직 생성하지 않았다.
