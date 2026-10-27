# 일정·작업과 운영 상태

1인 개발자·사업자가 SNS, 앱, 웹, 서비스와 일정을 한 화면에서 관리하기 위한 두 탭입니다. 데이터는 모두 로컬 PostgreSQL에 저장합니다(마이그레이션 `012_planner`, `013_ops_status`).

## 일정·작업

- 다가오는 8일의 일정, 열린 작업, 마감이 지난 작업을 보여 줍니다. SNS 게시 예약은 자동으로 일정에 들어오며 Studio가 관리합니다(여기서 편집하지 않고 SNS 일괄 게시에서 바꿉니다).
- Google Calendar와 양방향 동기화합니다. 범위는 `calendar.app.created` 하나이고, Studio가 만든 전용 캘린더만 읽고 씁니다. 기존 캘린더는 보지 않습니다.
- SNS 로그인 탭에서 Google Calendar를 연결한 뒤 **지금 동기화**를 누르거나 5분마다 자동으로 동기화합니다.
- 양쪽에서 같은 일정을 고치면 최근에 고친 쪽이 이기고, 진 쪽 내용은 충돌 기록으로 남습니다. 게시 예약 일정을 Google에서 고치면 Studio 내용으로 되돌립니다.
- Google이 동기화 토큰을 만료시키면(HTTP 410) 전체 목록을 다시 받습니다.

## 운영 상태

제품(앱·웹·서비스)마다 필요한 소스만 등록하면 상태를 읽어 옵니다. 원격 서비스는 바꾸지 않습니다.

| 소스 | 읽는 것 | 상태 |
|---|---|---|
| GitHub CI | 기본 브랜치의 최근 Actions 실행 | CI 통과 / CI 실패 / 진행 중 |
| GitHub 릴리스 | 최근 릴리스 | 공개 / 초안 |
| Cloudflare | Worker 배포 목록, Pages 최근 배포 | 배포됨 / 배포 실패 / 진행 중 |
| 헬스체크 | 공개 HTTPS 주소에 GET (리다이렉트 따라가지 않음) | 정상 응답(2xx) / 응답 이상 |
| Google Play | production 트랙 릴리스의 `releaseLifecycleState` | 공개 / 심사 중·미공개 / 초안 / 중단·거절 |

상태는 섞지 않습니다. CI 통과는 배포가 아니고, 배포됨은 정상 응답이 아니며, Play 심사 중은 공개가 아닙니다. 실패 항목의 **작업 만들기**는 일정·작업에 작업을 열고, 같은 제품·소스는 한 건만 유지합니다(완료한 작업은 다시 엽니다). 15분마다 자동으로 확인하고 30일치 기록을 남깁니다.

헬스체크는 `https://` 공개 주소만 받습니다. `localhost`, 사설 IP, `.local`·`.internal` 주소는 요청 전에 거부합니다.

### 연결 설정

운영 상태 탭의 **연결 설정**에 저장한 값은 OS 키체인(`kr.toris.studio.ops.v1`)에만 들어가고 화면으로 돌아오지 않습니다.

- GitHub 토큰: 공개 저장소는 없어도 됩니다. 비공개 저장소는 Actions·Contents 읽기 권한만 준 fine-grained 토큰을 쓰세요.
- Cloudflare 계정 ID와 토큰: Workers Scripts·Pages 읽기 권한만 준 API 토큰.
- Play 서비스 계정 JSON: Google Play Developer API의 `androidpublisher` 범위는 읽기 전용 범위가 따로 없어 관리 권한까지 포함합니다. Play Console에서 이 서비스 계정에 앱 정보 보기 권한만 주세요.

## 검증

```bash
node --import tsx --test tests/planner-client.test.ts tests/ops-client.test.ts
cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib planner:: ops_status::
node scripts/verify-planner-ui.mjs   # Chromium + IPC fixture
node scripts/verify-ops-ui.mjs       # Chromium + IPC fixture
node scripts/verify-publication-db.mjs  # 격리 PostgreSQL에서 012/013 제약과 실제 쿼리
```

실제 Google 계정 동기화와 GitHub·Cloudflare·Play 토큰 호출은 위 검사에 포함되지 않습니다.
