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

GitHub와 Cloudflare는 **내 컴퓨터의 공식 CLI 로그인**으로 읽습니다. 앱은 그 토큰을 보지 않습니다.

- GitHub: `gh`가 있으면 `gh api --method GET`으로 `repos/<owner>/<repo>/actions/runs`(최근 1건)와 `releases`(최근 1건)만 읽습니다. `gh`가 없으면 공개 저장소를 비인증 REST로 읽습니다.
- Cloudflare: `cf`가 있으면 `cf workers deployments list --worker=<이름>`, `cf pages get <프로젝트>`를 쓰고, 없으면 `wrangler deployments list --name=<이름> --json`, `wrangler pages deployment list --project-name=<프로젝트> --json`을 씁니다. 여러 계정이 있으면 아래 Cloudflare 계정 ID를 `CLOUDFLARE_ACCOUNT_ID`로 넘깁니다.
- 실행 방식(`desktop/src-tauri/src/ops_status_cli.rs`): 고정된 읽기 전용 argv만 실행합니다. 이름은 `--worker=<이름>`처럼 한 값으로 넘겨 플래그로 해석되지 않게 하고, `-`로 시작하는 이름은 거절합니다. 환경 변수를 비운 뒤(`GH_TOKEN`·`GITHUB_TOKEN`·`CLOUDFLARE_API_TOKEN`은 전달하지 않고, 설정 폴더를 옮긴 사용자를 위해 `GH_CONFIG_DIR`·`XDG_CONFIG_HOME`만 넘김) 빈 임시 폴더에서 20초 제한으로 실행합니다. CLI 오류 원문은 화면에 보내지 않고 `미로그인`·`없음·권한 없음`·`권한·한도`·`시간 초과`로만 분류합니다.
- 로그인: **연결 설정**에 각 CLI의 설치·로그인 상태가 보이고, 로그인이 필요하면 **gh 로그인** / **cf 로그인**(cf가 없으면 **wrangler 로그인**)이 시스템 터미널에서 그 CLI의 공식 로그인 명령을 엽니다. 이 창으로 돌아오면 다시 확인합니다.

**연결 설정**에 직접 입력하는 값은 OS 키체인(`kr.toris.studio.ops.v1`)에만 들어가고 화면으로 돌아오지 않습니다.

- Cloudflare 계정 ID: 계정이 여럿일 때만 필요합니다.
- Play 서비스 계정 JSON: Google Play Developer API의 `androidpublisher` 범위는 읽기 전용 범위가 따로 없어 관리 권한까지 포함합니다. Play Console에서 이 서비스 계정에 앱 정보 보기 권한만 주세요.
- 예전 버전에서 저장한 GitHub·Cloudflare 토큰은 CLI가 없을 때만 쓰며, 화면에서는 **삭제**만 할 수 있습니다. 새로 입력하는 칸은 없습니다.

출력 형식 근거: `desktop/src-tauri/tests/fixtures/ops-cli/`에 실제 `gh`(2.100.0)·`cf`(1.0.0-beta.14) 읽기 전용 출력을 계정 식별자를 지워 저장했습니다. Pages는 이 계정에 프로젝트가 없어 `cf schema` 기준의 합성 응답(`cf-pages-get.synthetic.json`)이고, `wrangler` 출력 형식은 Cloudflare 문서 기준이며 실제로 실행해 보지 않았습니다.

## 검증

```bash
node --import tsx --test tests/planner-client.test.ts tests/ops-client.test.ts
cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib planner:: ops_status
node scripts/verify-planner-ui.mjs   # Chromium + IPC fixture
node scripts/verify-ops-ui.mjs       # Chromium + IPC fixture
node scripts/verify-publication-db.mjs  # 격리 PostgreSQL에서 012/013 제약과 실제 쿼리
```

실제 Google 계정 동기화, 다른 계정에서의 `gh`·`cf`·`wrangler` 로그인과 Play 호출은 위 검사에 포함되지 않습니다. CLI 실행 경계(환경 변수·작업 폴더·시간 제한)는 가짜 실행 파일로 검사합니다.
