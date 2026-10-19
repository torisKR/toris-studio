# SNS 게시·스케줄링·배치 실행 계획 — TikTok 포함

확인일: 2026-10-19 KST. 대상: `/Users/toris/projects/toris_studio`, 기준 HEAD `0005711`과 현재 작업 트리.

이 문서는 설계·적용 범위·검증 근거다. 외부 SNS 게시/결제 승인이나 운영 작업 상태의 원본이 아니다. 아래 선행 검증은 배포 준비 전 개발 기록이며 실제 배포 상태는 해당 GitHub 태그·Release·Actions 결과로 확인한다. 기존 미추적 `campaigns/`, `pocket-circuit/`는 보존하며 OAuth 연결·실계정 게시·운영 스케줄 등록은 이 검증에 포함하지 않는다.

## 결론과 목표

네이버 블로그·X·Instagram·Threads·Facebook·TikTok을 한 콘텐츠에서 채널별로 준비하고, 지원되는 채널에서 검토한 예약을 실행하며, 결과를 대상별로 추적한다. X는 후속 범위, 네이버는 수동 인계, TikTok은 영상 Direct와 받은 편지함 초안을 구분한다. ‘한 번 승인’과 ‘모든 채널이 같은 순간에 게시 완료’는 다르다. 외부 API 사이에 원자적 트랜잭션은 없고 미디어 처리 시간도 다르므로 채널별 성공·실패·수동 처리 필요를 표시한다.

권장 구조는 기존 Tauri/Rust + 로컬 PostgreSQL 게시 엔진 확장이다. 별도 큐 서버·n8n·Hermes cron·클라우드 컴퓨터를 추가해 같은 예약을 이중 실행하지 않는다. Postiz의 공개 저장소를 대안으로 검토했으나 기존 앱의 승인/큐/OS 자격 증명 경로를 중복 운영하게 되고, 확인한 지원 채널 목록에서 네이버 블로그 해결책도 확인하지 못했으므로 이번에는 채택하지 않는다. 유료 서비스나 X API 비용은 별도 승인 전 집행하지 않는다.

## 작업 시작 시점의 코드와 지식 대조

- `desktop/src/PublicationPanel.tsx`: 공통 콘텐츠 → 계정별 문구 → 사전 검사 → 명시적 승인 → 채널별 결과 화면이 있다.
- `desktop/src/publication-client.ts:PUBLISH_PLATFORMS`와 `desktop/src-tauri/src/publications.rs:normalize`: 현재 대상은 YouTube, Instagram, Facebook, Threads, TikTok이다. X/네이버를 문자열 목록에만 추가하면 계정·미디어·어댑터·실행 검증이 빠지므로 그렇게 하지 않는다.
- `desktop/src-tauri/src/publications.rs`: 불변 snapshot, revision+대상+파일 해시 승인, 트랜잭션 claim, 프로세스 잠금, 결과 불명확 시 재업로드 금지가 구현돼 있다. `scheduler.rs`는 07시 트렌드 수집용이며 게시 스케줄러가 아니다.
- `desktop/src-tauri/src/lib.rs`의 백그라운드 루프가 실제 게시 tick을 실행하고 완료 후 10초 대기 또는 Notify로 재개한다. `publications.rs`의 `claim`은 tick마다 신규 job 하나를 직렬 claim/실행한다. 같은 시각 예약도 앞 채널 업로드만큼 뒤 채널이 지연될 수 있으며 동시 전송 엔진이 아니다. 일시정지는 scheduled 실행을 막지만 수동 queued 작업까지 중단하지는 않는다. 절전 감지는 OS 이벤트 자체가 아니라 독립 heartbeat의 90초 초과 간격이다.
- `db/migrations/007_publications.sql`: `publications`/`publication_jobs`, `(publication_id, revision, target_id)` UNIQUE와 due index가 있다. 새 스케줄 DB를 만들지 않는다.
- `docs/SOCIAL_PUBLISHING.md`: X/네이버 제외 및 영상 중심 현재 구현과 일치한다. 일부 README의 ‘자동 게시 별도 구현’ 문구보다 실제 게시 엔진과 이 문서의 범위를 우선한다.
- Hermes Wiki에는 직접 관련된 게시 설계 기록을 찾지 못했다. 코드 그래프 등록 목록에도 toris_studio가 없어 실제 소스를 확인했다.
- SecondBrain의 `toris_studio`, `publishing` 검색은 결과가 없었다. `Toris Studio`로 재검색해 읽은 `Projects/toris-blog.md`는 2026-07-21의 `/Users/toris/projects/Toris_Blog` Astro 사이트 기록이다. 명칭이 비슷하지만 현재 Tauri/React/Rust 앱의 설계 근거로 적용하지 않는다. 조회 범위 밖에 다른 기록이 없다고 단정하지 않는다.

## 채널별 현실적인 범위

| 채널 | 이번 구현 후 로컬 코드 | 후속 범위와 승인 조건 |
| --- | --- | --- |
| 네이버 블로그 | text/article 원고와 최대 20개 이미지의 로컬 수동 인계. 사용자 확인 결과는 API 검증과 별도 표시 | 기존 로그인 방식 글쓰기 Open API는 2020-05-06 종료. 검색 API/로그인 성공을 게시 권한으로 간주하지 않는다. 사용자가 네이버 편집기에서 직접 게시/예약하며 실제 게시 후에만 URL을 기록한다. 새 공식/제휴 API 접근이 실제로 확인되면 재평가한다. |
| X | OAuth 플랫폼 및 게시 어댑터 미구현 | 공식 X API + OAuth 사용자 권한. 비용·사용 계정·앱 등록 승인 후 구현. 초기에는 텍스트/링크, 다음에 미디어. 크레딧 구매·자동 충전은 이번 범위 밖. |
| Instagram | 전문 계정 Reel 영상 게시/예약 | 우선 기존 경로 사용. 이미지/캐러셀은 별도 콘텐츠 종류와 검증이 필요. 개인 계정 지원으로 표시하지 않는다. |
| Threads | 기존 영상 및 TEXT 컨테이너 게시/예약. 텍스트는 영상 파일·공개 미디어 터널 불필요 | IMAGE/CAROUSEL은 후속 범위. 사용자 권한·앱 심사 또는 tester 범위 및 실제 계정 게시를 별도 확인. |
| Facebook | 기존 Page Reel 및 Page feed 텍스트 게시/예약 | 관리 가능한 Page 대상. 개인 타임라인·그룹까지 지원한다고 표시하지 않는다. 사진은 후속 범위이며 실제 계정 게시는 별도 확인. |
| TikTok | 기존 영상 Direct 게시/예약 및 받은 편지함 초안 전송. KST 일괄 예약은 Direct만 포함 | 미심사 Direct는 비공개 계정의 SELF_ONLY. 공개 Direct(예약 포함)는 별도 심사·video.publish·실제 API 허용 필요. 초안은 video.upload 권한과 사용자의 TikTok 최종 게시가 필요. 텍스트·사진은 이번 앱 범위 밖. |

네이버의 CAPTCHA 우회·비밀번호/쿠키 복사·무인 브라우저 대량 발행을 기본 경로로 도입하지 않는다. 브라우저 보조가 필요하면 정책·로그인·사용자 최종 확인 범위를 별도 합의한다. 따라서 초기 목표는 ‘공식 API 채널 자동 실행 + 네이버 수동 인계를 한 화면에서 관리’이지 ‘5채널 무조건 완전 무인 발행’이 아니다.

## 선행 변경: 기존 대상의 예약 시간 일괄 편집

구현 위치:

- `desktop/src/publication-client.ts:batchSchedule`: 순수 초안 변환. 선택한 대상만 화면 순서로 예약하고, 나머지 문구·계정·공개 범위와 원본 객체를 유지한다.
- `desktop/src/PublicationPanel.tsx`: ‘채널 예약 시간을 한 번에 설정’ 영역. 시작 시각 KST, 간격 0~1440분 정수. 아래 ‘이번에 검사·승인할 대상’ 중 자동 게시 가능한 대상만 적용하며 수동 인계·TikTok 초안은 제외한다.
- `kstSchedule`: 엄격한 분 단위 형식과 달력 round-trip 검증. 2월 30일·평년 2월 29일·24:00을 다른 날짜로 자동 보정하지 않고 거부한다.

동작:

1. SNS 일괄 게시에서 콘텐츠와 지원 채널·계정을 선택한다.
2. 이번에 검사·승인할 대상을 체크한다. 시작 KST와 채널 간격을 입력한다.
3. ‘예약 시간을 초안에 적용’을 누른다. 0분이면 같은 예약 시각, 15분이면 선택한 채널별로 15분 차이다.
4. 적용은 메모리의 편집 초안만 바꾼다. DB 저장·job 생성·게시를 하지 않고 기존 사전 검사/최종 동의를 무효화한다.
5. 초안 저장 → 새 사전 검사 → 계정·파일·문구·시간 확인 → 최종 승인을 거쳐야 기존 큐에 예약된다.

안전 조건: 빈/알 수 없는/중복 대상, 대상 20개 초과, 잘못된 간격, 지난 시각, TikTok 받은 편지함 초안, 현재 revision의 이미 승인·전송·결과 확인 중인 대상은 일괄 편집에서 거부한다. 취소/재승인 필요 대상은 새 검토 후 편집 가능하다. 다른 대상의 승인된 예약이 있는 콘텐츠를 저장하면 기존 엔진의 revision 변경 정책으로 해당 예약도 취소되므로 전체 초안을 다시 검토해야 한다.

이 예약 기능은 ‘한 콘텐츠의 여러 채널 예약 편집’이다. 여러 콘텐츠 CSV 등록·반복 예약·X 자동 게시와 구분한다. 네이버 수동 인계는 다음 절의 별도 종류이며 이 예약 기능으로 자동 게시하지 않는다.

## 이번 변경: 콘텐츠 종류·텍스트 게시·네이버 수동 인계

사용자의 ‘기능 구현 진행해줘’ 요청에 따라 아래 A 단계와 Facebook Page·Threads 텍스트 어댑터를 구현했다. 실제 계정 게시·운영 DB 적용·설치 앱 교체는 하지 않았다. 세부 사용법은 [SNS 게시 안내](SOCIAL_PUBLISHING.md)에 있다.

- `contentKind`: `video` / `text` / `article`. 기존 누락/null 값은 video로 처리한다. 종류를 바꾸면 비호환 대상·미디어 연결을 해제하고 사전 검사와 최종 동의를 다시 요구한다. 파일 원본은 삭제하지 않는다.
- text: Facebook Page·Threads·네이버 수동 인계 선택. MP4·썸네일을 요구하지 않으며 첨부한 video 필드를 조용히 무시하지 않고 거부한다. 네이버 외 텍스트 게시에는 공개 게시 동의와 최신 게시 계정/권한 확인이 필요하다.
- article: 네이버 수동 인계 전용. 제목/본문/태그와 최대 20개 등록 이미지 ID를 저장한다. 내보내기는 승인된 snapshot과 파일 SHA256을 확인하고 `title.txt`, `body.txt`, `tags.json`, `images/`, `manifest.json`, `README.txt`를 새 로컬 폴더에 생성한다. 이미지가 없으면 `images/`는 생략한다. 이 자료만으로 외부에 게시하지 않는다.
- `manual_handoff` / `needs_human_publish`: 승인한 수동 업무를 자동 실행 큐와 분리한다. 내보내기 후에도 수동 게시 필요 상태가 유지된다. 네이버에서 실제 게시한 뒤 해당 블로그 ID와 일치하는 개별 HTTPS URL 및 명시적 사용자 확인으로만 `published` + `verification=user_confirmed`를 기록한다. URL을 조회해 실재·소유권을 API로 검증하는 기능은 아니다.
- `008_publication_handoffs.sql`: 위 mode/status 일관성·예약 불가 CHECK를 추가하고 앱의 embedded migration/상태 확인 및 CLI loader에 연결했다. 운영 DB에 직접 적용하지 않았다.
- Facebook text: Page feed `message` 전송 전 체크포인트 → 반환 post ID 저장 → `is_published` 재조회. 확인되지 않은 결과는 published로 만들지 않는다.
- Threads text: TEXT 컨테이너 → 처리 상태 확인 → publish 체크포인트 → 원격 ID·계정·콘텐츠 종류 재조회. commit 결과가 불명확하면 publish를 반복하지 않는다. legacy 영상 경로는 유지한다.
- ChatGPT 초안 요청에도 현재 콘텐츠 종류와 선택한 대상만 전달한다. 텍스트를 영상 초안으로 가정하지 않고 초안 수신/적용/게시 승인을 분리한다.

로컬 완료 기준은 A의 기존 영상 회귀·영상 없는 텍스트·내보내기 상태 보존·URL 검증·승인 분리다. B~E 전체나 5채널 완전 무인 발행의 완료 선언이 아니다.

## 다음 구현 순서와 완료 기준

아래 단계는 설계상 의존성이다. 지속 실행 작업을 등록할 때는 사용 가능한 native Kanban만 원본으로 사용하고 이 문서를 두 번째 작업 보드로 운영하지 않는다.

### A. 콘텐츠 종류와 수동 인계 모델 — 이번 로컬 구현 범위

콘텐츠 종류와 인계 모델을 구현했고 아래 로컬 검증을 통과했다. 사용할 실제 계정·공개 게시 검증은 E에서 별도 승인한다.

- 현재 MP4 필수 preflight를 콘텐츠 종류별 검증으로 나눈다. 기존 영상은 기본값과 migration으로 호환한다.
- 공통 원문과 채널별 title/body/hashtags/media를 분리한다. 장문을 모든 채널에 그대로 복제하거나 자동으로 잘라 발행하지 않는다.
- 네이버는 `manual_handoff` 별도 종류를 사용한다. `needs_human_publish` 상태를 외부 게시 job 성공과 구분하고, 제목/본문/이미지를 로컬 파일로 내보낸다.
- 수동 게시 URL은 네이버의 허용된 HTTPS 호스트·계정과 대조한다. `verification=user_confirmed`로 기록하며 API 검증으로 표시하지 않는다. 외부 플랫폼에서 예약만 설정한 것은 게시 완료가 아니다.
- 완료 기준: 기존 MP4 회귀 없음, 텍스트에서 영상 요구 안 함, 내보내기만으로 게시 상태가 바뀌지 않음, 잘못된 URL 거부, 승인 전 job 생성 없음.

### B. X 공식 API 어댑터

선행: A + 사용자의 X 개발자 앱/비용 상한 승인. 이번 작업에서 자격 증명을 읽거나 등록하지 않았다.

- 기존 OAuth 플랫폼 enum·redirect allowlist·OS 자격 증명 저장·권한 UI를 함께 확장한다.
- 프런트 게시 타입·native normalize·계정 조회·플랫폼 URL 검증과 소셜 채널/콘텐츠 플랫폼 CHECK를 새 migration으로 함께 확장한다. job의 플랫폼은 JSON snapshot 안에 있으므로 존재하지 않는 job platform 컬럼을 가정하지 않는다. 기존 데이터/읽기 경로의 호환 테스트를 포함한다.
- OAuth 2.0 PKCE 사용자 권한에 `tweet.read`, `tweet.write`, `users.read`, 예약 갱신이 필요한 `offline.access`를 공식 endpoint 요구사항과 대조한다. 미디어는 해당 endpoint 추가 scope도 확인한다.
- `POST /2/tweets` 결과 ID를 저장하고, 결과 조회가 확인된 경우에만 published로 표시한다. 앱 전용 read-only Bearer로 게시하지 않는다.
- 현재 공식 문서는 종량제 크레딧 방식이다. 정확한 실행 단가는 Developer Console에서 다시 확인하고 예산·상한·읽기 비용까지 합의한다. 과거 Free/Basic 가격을 하드코딩하지 않는다.
- 타임아웃으로 원격 ID를 받지 못한 create 요청은 단순 재전송하지 않는다. uncertain + 사용자 확인 경로를 유지한다.
- 완료 기준: 잘못된 scope/계정/비용 미승인 차단, fixture 네트워크 계약, 중복 POST 금지, 사용자 승인한 최소 실제 게시 및 ID/URL 재조회. 실제 게시 없이 live 완료로 표시하지 않는다.

### C. 여러 콘텐츠 배치 등록과 반복 일정

선행: A, X를 포함할 경우 B. 기존 PostgreSQL 큐를 재사용한다.

- JSON/CSV 가져오기 → 행 단위 검증 → KST 일정 미리보기 → 채널별 수정 → 승인 가능한 행 선택 → 승인 snapshot 저장 순서.
- UTC `timestamptz`를 저장하고 `Asia/Seoul` 원본 표시값과 변환을 보여준다. 시간대 없는 파일 입력은 추측하지 않고 거부한다.
- 배치 manifest에 콘텐츠 ID/revision/대상/시간/미디어 해시를 바인딩한다. 동일 import 재실행 중복은 별도 import 키와 unique 제약으로 방지한다. 기존 job UNIQUE만으로 파일 전체 중복 방지가 된다고 가정하지 않는다.
- 한 잘못된 행을 조용히 건너뛰지 않는다. ‘전부 검증 후 등록’과 사용자가 명시한 ‘유효 행만 등록’을 구분한다. DB 등록은 트랜잭션, 외부 실행은 채널별 부분 성공으로 표시한다.
- 반복 일정은 무기한 자동 동의가 아니다. 승인한 콘텐츠와 종료일/최대 발생 횟수/시간대의 유한 occurrence를 먼저 구체화한다. 원문·계정·미디어 변경 시 재승인, 이미 게시한 occurrence 재생성 금지, 중단·미래 회차 취소 제공.
- 완료 기준: 재가져오기/앱 재시작 중복 없음, 잘못된 행 번호 표시, 범위 밖 발생 없음, 부분 실패 시 성공 채널 제외, 승인 바뀌면 이전 일정 실행 안 함.

### D. 실행 제한과 운영 가시성

선행: C의 스키마/승인 계약. 인증 만료·rate limit은 실행 시점에도 확인한다.

- 현재 single-owner + SQL claim을 유지한다. 먼저 계정별 제한과 재확인 대기 기능을 추가하고, 처리량 측정 전 병렬 worker를 늘리지 않는다.
- 429/Retry-After와 명시적으로 안전한 실패에만 지수 backoff+jitter·횟수/기한 상한을 적용한다. 원격 전송이 시작된 뒤 결과 불명확한 경우에는 신규 create가 아닌 reconcile을 사용한다.
- 정책상 지연돼 지나간 일정은 needs_confirmation으로 보내는 것을 기본으로 제안한다. 자동 지연 허용 창을 추가한다면 그 범위를 승인 snapshot에 포함하고 별도 검증한다.
- Threads/Meta 미디어 컨테이너는 예약 수일 전에 생성하지 않고 due 실행 근처에서 생성한다. 임시 미디어 URL은 승인 파일만 노출하고 TTL/lease 종료로 폐기한다.
- 예약 대기, 실제 실행 지연, 권한 만료, 수동 인계 필요, published/draft_sent/uncertain을 따로 표시한다. 네이버 수동 필요가 남아 있으면 전체 배치를 ‘게시 완료’로 표시하지 않는다.
- Mac 절전/전원 종료·앱 완전 종료 중에는 실행되지 않는다. 누락 예약을 자동으로 몰아 발행하지 않는다. 로컬 DB·인터넷도 실행 조건이다.
- 완료 기준: 두 앱 인스턴스 중복 claim 없음, API 제한 준수, 재시작/절전/DB 단절 복구, 성공 채널 재전송 없음, 알림 실패가 게시 재실행을 유발하지 않음.

### E. 최소 실제 계정 검증

선행: 위 기능별 로컬 검증 + 채널/계정/콘텐츠/시각/공개 범위에 대한 사용자 명시적 승인.

- Instagram 전문 계정, 관리 가능한 Facebook Page, Threads 권한/tester·심사 상태, X 개발자 비용 승인 각각 확인.
- 채널별 최소 게시/결과 ID·URL 조회 → 단일 예약 → 다채널 부분 실패 → 재시작 복구 순으로 확인한다.
- API fixture/브라우저 IPC fixture 통과는 실제 OAuth/공개 게시 성공이 아니다.
- 네이버는 사용자가 편집기에서 게시한 결과를 수동 확인한다. 새로운 공식 접근이 없으면 완전 무인 범위로 승격하지 않는다.

## 선행 예약 편집 구현의 검증

Node가 처음에는 v26.8.2였으나 `package.json`의 `>=24 <25`에 맞춰 기존 설치 `/Users/toris/.nvm/versions/node/v24.16.0/bin`을 이번 셸 PATH에 사용했다. 시스템 Node/설정 파일은 바꾸지 않았다. 임시 아티팩트는 Hermes scratch 아래에 저장했다.

- TDD: batch helper 미구현 실패 → 구현 통과. 잘못된 대상/시각 검증 실패 → 차단 구현 통과. 존재하지 않는 날짜가 자동 보정되는 회귀 실패 → 엄격한 검증 통과. UI region 부재로 브라우저 검증 실패 → UI 구현 후 통과.
- `pnpm test`: 212 tests, 211 pass, 1 skip, 0 fail. skip은 opt-in PostgreSQL 통합 테스트다.
- `TZ=America/New_York node --import tsx --test tests/publication-batch.test.ts tests/publication-client.test.ts`: 9 pass. 호스트 시간대와 무관한 KST 변환·선택 대상/상태 차단·동시/날짜 경계 검사.
- `pnpm exec tsc --project desktop/tsconfig.json --noEmit`: exit 0.
- `pnpm typecheck`: exit 0.
- `pnpm desktop:ui`: Vite production build 성공. lucide-react `use client` 및 기존 큰 chunk 경고가 남는다.
- `pnpm build`: Next.js 16.3.8 build 성공, 페이지 생성 완료.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib publications::tests`: 5 pass, 1 ignored(격리된 PostgreSQL URL 필요).
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib publishing_adapters`: 19 pass.
- `cargo check --manifest-path desktop/src-tauri/Cargo.toml --features desktop`: exit 0. 실제 desktop feature와 tick/IPC 연결 컴파일 확인이며 앱을 실행하거나 예약을 활성화한 것은 아니다.
- `TORIS_PUBLICATION_UI_ARTIFACTS=/Users/toris/.hermes/cache/scratch/toris-studio-publishing-ui node scripts/verify-publication-ui.mjs`: Chromium IPC fixture 11 checks, errors [], passed true. 3채널 간격 예약·명시적 저장 시 UTC·재검사/동의 무효화·apply 시 submit 없음·820px 가로 overflow 없음 확인.
- UI 결과: `/Users/toris/.hermes/cache/scratch/toris-studio-publishing-ui/verification.json`, `publication-compose.png`, `publication-narrow.png`. scratch는 자동 정리 대상이며 영구 배포 아티팩트가 아니다.
- `git diff --check`: 통과. 신규 테스트는 `tests/publication-batch.test.ts`.

위 수치는 선행 예약 편집 단계의 결과다. 이후 콘텐츠 종류·수동 인계·텍스트 어댑터 및 격리 DB를 추가로 검증한 결과는 다음과 같다.

## 최신 구현 검증 — 2026-10-19

- TDD: 콘텐츠 종류·네이버 인계 helper·native DB 상태·클라이언트·UI 부재를 먼저 실패로 확인한 뒤 구현했다. 최종 대조 중 ChatGPT 요청에 contentKind가 빠지는 회귀를 `undefined !== text` 실패로 재현하고 현재 종류/선택 대상 전달을 보완했다.
- `pnpm test`: 214 tests, 213 pass, 1 skip, 0 fail. skip은 기존 opt-in 소셜 DB 테스트이며 아래 격리 게시 큐 테스트와 별개다.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib`: 246 pass, 11 ignored, 0 fail. live OAuth·공개 터널·일부 미디어/DB 등 opt-in을 기본 실행에서 제외한다. 그중 게시 큐 DB 테스트 2개는 아래에서 별도 실행했다.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --test release_integration_contract`: 6 pass. 배포 IPC/MCP 계약·승인·계정 검증 회귀 확인.
- `node scripts/verify-publication-db.mjs`: 임시 127.0.0.1 PostgreSQL 클러스터·테스트 전용 DB/state에서 실제 SQL 실행. 001/007/008을 두 번 적용해 기존 video/handoff 행 보존과 세 가지 handoff CHECK 위반 차단을 확인했고 native DB 테스트 2개 통과. 수동 인계 claim 불가·내보내기 상태 유지·사용자 URL 확인·원고 변경 취소·재시작 복구·경쟁 claim을 확인한다. 기존 DB/앱 자격 증명은 읽지 않으며 테스트 클러스터를 종료·삭제한다.
- `pnpm exec tsc --project desktop/tsconfig.json --noEmit`, `pnpm typecheck`, `pnpm desktop:ui`, `pnpm build`: 성공. Vite의 lucide-react 지시문/큰 chunk 경고는 남아 있다.
- `cargo check --manifest-path desktop/src-tauri/Cargo.toml --features desktop`: 성공. 실제 UI/IPC/스케줄러 연결의 컴파일 확인이며 설치 앱 실행은 아니다.
- `TORIS_PUBLICATION_UI_ARTIFACTS=/Users/toris/.hermes/cache/scratch/toris-studio-handoff-ui node scripts/verify-publication-ui.mjs`: Chromium IPC fixture 14 checks, errors [], passed true. 종류별 대상/미디어·명시적 승인·네이버 패키지 요청과 미완료 상태·잘못된 URL 거부·user_confirmed 표시·종류별 ChatGPT 요청·820px overflow 없음 확인.
- 브라우저 결과: `/Users/toris/.hermes/cache/scratch/toris-studio-handoff-ui/verification.json`, `publication-compose.png`, `publication-narrow.png`. IPC 결과는 명시적 fixture이며 실제 OAuth·게시·브라우저의 폴더 대화상자 검증이 아니다. 실제 로컬 패키지 생성/DB 반영은 별도 Rust·PostgreSQL 테스트가 검증한다.

위 선행 검증 단계의 미구현/미검증: X OAuth·비용 승인·게시, 여러 콘텐츠 JSON/CSV 배치 등록과 중복 import 키, 유한 반복 예약, Instagram/Threads/Facebook 이미지·캐러셀, 새 텍스트 어댑터의 실제 계정 게시·이모지/링크 세부 제약, macOS 설치 앱 교체 실행, Windows 기기 실행. 운영 DB migration·스케줄 활성화·외부 SNS 게시는 하지 않았다. 배포 준비 이후의 확인 범위는 다음 절과 실제 태그 Release를 구분한다.

## 0.1.23 배포 준비 — TikTok 회귀와 필수 검증 gate

- 사용자 추가 요청으로 TikTok을 이번 릴리스의 명시적 범위에 포함했다. 기존 Direct/받은 편지함 어댑터를 중복 구현하지 않고 영상 전용 선택, 공개 범위 미선택 기본값, 비공개 계정 제한, 음악·전송 동의와 최종 승인 분리를 대조했다.
- `publishing_adapters_tests.rs`의 TikTok fixture 검증은 즉시/예약 Direct의 필수 선택, SELF_ONLY 보존, 업로드 전 원격 ID 체크포인트, 체크포인트 실패 시 PUT 차단을 포함한다. 받은 편지함 초안은 문구·공개 설정을 Direct 방식으로 보내지 않으며 전송 수락을 published로 만들지 않는다.
- Chromium IPC fixture는 TikTok 초안을 일괄 예약에서 제외하고 Direct는 KST→UTC 슬롯과 SELF_ONLY를 보존하며 최종 승인 후에만 scheduled job이 생기는 경로를 확인했다. 이는 실제 TikTok 업로드가 아니라 UI/IPC 계약 검증이다.
- `.github/workflows/publication-checks.yml`은 비밀값·게시 권한 없이 임시 PostgreSQL과 Chromium fixture를 실행한다. main 검사와 태그 릴리스의 native 빌드는 이 gate에 의존하며 CI 구조 계약·네 버전 파일 정합성 테스트를 추가했다.
- TikTok 실제 OAuth·공개 Direct 심사·실계정 게시, 설치 앱 교체/실행은 수행하지 않는다. 공개 Direct 심사는 개인·내부 계정용 도구에서 보장되지 않는다. 로컬/CI 통과와 실제 플랫폼 승인을 구분한다.

## 공식 출처와 확인 범위

아래는 2026-10-19에 조회한 원문이다. 일반 웹 추출 backend는 search-only 오류로 실패했고, 검색으로 실제 URL을 찾은 뒤 공개 공식 원문을 직접 읽었다. 시크릿·개인 노트·프로젝트 코드는 외부 검색에 보내지 않았다.

1. NAVER Developers, [블로그 오픈 API 종료 안내](https://developers.naver.com/notice/article/7527): 종료일과 대상 확인. 이 공지만으로 모든 미래 제휴 경로가 없다고 단정하지 않는다.
2. X 공식 문서 저장소, [Create Post](https://github.com/xdevplatform/docs/blob/main/x-api/posts/create-post.mdx), [OAuth 2.0 PKCE](https://github.com/xdevplatform/docs/blob/main/fundamentals/authentication/oauth-2-0/authorization-code.mdx), [Pricing](https://github.com/xdevplatform/docs/blob/main/x-api/getting-started/pricing.mdx): 사용자 인증·POST 경로·종량제 및 Console 재확인 필요 확인. 실제 계정 요금/권한은 미확인.
3. Meta 공식 [Instagram Content Publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing.md): 전문 계정, 권한, 컨테이너/게시/상태/한도 조회 경로. 숫자 한도는 API 종류/시점에 따라 재검증하며 이번 코드는 이를 하드코딩하지 않는다.
4. Meta 공식 [Threads Posts](https://developers.facebook.com/documentation/threads/posts.md): TEXT/IMAGE/VIDEO/CAROUSEL과 `threads_basic`, `threads_content_publish`, tester/advanced access 차이 확인.
5. Meta 공식 [Facebook Reels sample](https://github.com/fbsamples/reels_publishing_apis/tree/main/fb_reels_publishing_api_sample): 비동기 응답 수락과 실제 업로드/게시 결과 조회의 구분 확인. 샘플 수치를 최신 모든 포맷 한도로 일반화하지 않는다.
6. [Postiz 원본 저장소](https://github.com/gitroomhq/postiz-app): 다채널 스케줄링/AGPL-3.0/별도 인프라 대안 검토. 이번 프로젝트에 설치·코드 복사·외부 연결하지 않았다.
7. Meta 공식 [Facebook Pages Posts](https://developers.facebook.com/docs/pages-api/posts/)와 [Threads Posts 원문](https://developers.facebook.com/documentation/threads/posts.md): 2026-10-19 실제 로컬 브라우저로 재조회해 Page feed message/published, TEXT 컨테이너/threads_publish와 사용자 권한 경로를 대조했다. Page 문서의 플랫폼 서버 예약과 이번 로컬 due 실행은 별개이며, 모든 권한/이모지/링크 제약을 live 검증했다는 뜻은 아니다.
8. TikTok 공식 [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines), [Upload guide](https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content): 2026-10-19 로컬 브라우저 조회. 문서 갱신일 2026-08-04, 미심사 Direct의 비공개 계정·SELF_ONLY 제약, 공개 심사와 내부/개인용 도구 제한, creator 정보/공개 범위 직접 선택, 초안의 사용자 최종 게시, 사진 API 지원과 이번 앱의 영상 전용 범위를 구분했다.
