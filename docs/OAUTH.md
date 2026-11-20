# SNS OAuth 연결

앱의 **SNS 로그인**에서 직접 등록한 플랫폼 앱으로 공식 로그인을 시작합니다. 계정 비밀번호를 Toris Studio에 입력하지 않습니다. Rust가 인증 코드와 토큰을 처리하고 OS 자격 증명 저장소에 저장합니다. React 화면에는 토큰·클라이언트 비밀키를 반환하지 않습니다.

## 연결 방식 세 가지

| 방식 | 대상 | 사용자가 하는 일 | 비밀값 |
|---|---|---|---|
| **Toris 연결 (로그인만)** | TikTok, Threads, Instagram, Facebook Page, 네이버 | 로그인만 | 앱에 없음. 코드 교환과 시크릿이 필요한 갱신은 Toris OAuth Broker(`https://oauth.toris.kr`)가 합니다. |
| **Toris 기본 Google 클라이언트** | YouTube, Google Calendar | 로그인만 | 없음. Google 설치형 앱 클라이언트 ID + PKCE. |
| **내 개발자 앱** | 7개 모두 | 각 플랫폼에 개발자 앱을 등록하고 클라이언트 ID·시크릿·리디렉션 입력 | 사용자가 입력한 시크릿을 OS 키체인에만 저장 |

SNS 관리의 **연결·권한**에서 플랫폼을 고르면 **연결 방식** 선택지가 보입니다. 저장한 내 개발자 앱이 있으면 그것을, 없으면 Toris 연결(브로커가 그 플랫폼을 제공할 때)이나 Toris 기본 Google 클라이언트(빌드에 클라이언트 ID가 있을 때)를 기본으로 고릅니다. 둘 다 없으면 지금처럼 내 개발자 앱 입력만 보입니다. 방식을 바꾸면 기존 연결은 백업 후 다시 로그인해야 합니다.

### Toris 연결

- 브로커 프로토콜의 기준은 `infrastructure/oauth-broker/README.md`와 `worker.ts`입니다. 앱 구현은 `desktop/src-tauri/src/oauth_broker.rs`입니다.
- 로그인 시작: 앱이 로그인마다 verifier를 만들고 `POST /v1/oauth/{platform}/start`에 `SHA-256(verifier)`만 보냅니다. 브로커가 서명한 state와 공개 클라이언트 ID를 받아 인가 주소를 만듭니다. 리디렉션 주소는 앱과 브로커에 같은 값으로 고정되어 있고, 다르면 거절합니다.
- 코드 교환: `POST /v1/oauth/{platform}/token`에 `state`·`code`·`verifier`·`redirectUri`만 보냅니다. Meta 3종은 장기 토큰을 한 번에 받습니다. 토큰은 응답으로만 오고 Rust와 OS 키체인에만 저장합니다. IPC 응답·이벤트·로그·오류 문구에는 넣지 않습니다.
- 갱신: TikTok·네이버·Facebook은 그 연결을 발급한 브로커의 `/refresh`로, Threads·Instagram은 시크릿이 필요 없어 제공자에 직접 요청합니다.
- 모든 브로커 요청에 `User-Agent: TorisStudio/<앱 버전>`을 보냅니다. 브로커의 `MIN_APP_VERSION`보다 낮으면 "앱을 업데이트하세요"로 안내합니다.
- Meta 콜백: 제공자는 HTTPS 리디렉션만 받으므로 `https://toris.kr/oauth/{threads|instagram|facebook}/callback`이 브로커 형식 state일 때만 앱의 루프백(`http://127.0.0.1:38471/oauth/{platform}/callback`)으로 넘겨 줍니다. 자동으로 돌아오지 않으면 브라우저의 최종 주소를 붙여 넣어도 됩니다. 가로챈 코드는 앱 메모리에만 있는 verifier 없이 교환할 수 없습니다.
- 브로커가 응답하지 않으면(배포 전 포함) Toris 연결 선택지는 보이지 않습니다. `/v1/config` 결과는 10분(실패는 1분) 캐시합니다.
- 브로커 주소(`https://oauth.toris.kr`)는 앱의 상수이며 화면·IPC·키체인으로 바꿀 수 없습니다(테스트만 별도 주입). 각 연결은 발급받은 브로커 주소를 기록해 두고 그 주소에서 갱신합니다.

### Toris 기본 Google 클라이언트

- 클라이언트 ID는 빌드 환경 변수 `TORIS_GOOGLE_CLIENT_ID`로 넣습니다. 비어 있으면 이 방식은 꺼지고 내 Google 클라이언트 입력만 보입니다. Google의 [설치형 앱 안내](https://developers.google.com/identity/protocols/oauth2/native-app)대로 시크릿 없이 PKCE로 교환합니다. YouTube와 Calendar 모두 PKCE를 씁니다.
- 동의 화면에 등록할 범위: `youtube.readonly`, `yt-analytics.readonly`, `youtube.upload`, `calendar.app.created`.
- 앱이 Google에서 "테스트" 상태(`TORIS_GOOGLE_CLIENT_STATUS`가 `production`이 아니면)일 때는 [갱신 토큰이 7일 뒤 만료](https://developers.google.com/identity/protocols/oauth2#expiration)됩니다. 카드에 "7일마다 다시 로그인"과 현재 로그인의 유효 기한(최초 로그인 + 7일, 갱신해도 바뀌지 않음)을 보여 줍니다. 등록된 테스트 사용자만 로그인할 수 있고 확인되지 않은 앱 경고가 나올 수 있습니다. 이 상태에서 **연결 갱신**을 눌렀을 때 갱신이 거절되면(`invalid_grant` 등) "Google 테스트 단계 로그인은 7일마다 만료됩니다. 다시 로그인하세요."로 안내합니다. 앱이 자동으로 갱신하다 거절된 경우에는 연결 상태에 **다시 로그인 필요**만 표시합니다. 만료 전 미리 알림은 없습니다.
- 일정·작업의 Calendar 카드는 **내 Google 클라이언트 사용**으로 덮어쓰고 **Toris 기본 클라이언트로 되돌리기**로 돌아갑니다. YouTube는 SNS 관리의 연결 방식에서 **내 개발자 앱**을 고르면 덮어씁니다.

### 내 개발자 앱

다섯 SNS와 Google 두 가지(모두 7개)는 직접 등록한 개발자 앱으로도 연결할 수 있습니다. Toris Studio는 클라이언트를 임의로 만들거나 승인된 상태로 표시하지 않습니다. 저장된 설정의 빈 입력은 기존 값을 유지합니다. 클라이언트나 리디렉션 주소를 변경하면 기존 계정 연결을 해제하고 다시 로그인해야 합니다.

| 플랫폼 | 읽기 권한 | 준비할 클라이언트 | 리디렉션 처리 |
| --- | --- | --- | --- |
| YouTube | `youtube.readonly`, `yt-analytics.readonly` | Google 데스크톱 OAuth 클라이언트 | `http://127.0.0.1:38471/oauth/youtube/callback` |
| Google Calendar | `calendar.app.created` | Google 데스크톱 OAuth 클라이언트 | `http://127.0.0.1:38471/oauth/google_calendar/callback` |
| Threads | `threads_basic`, `threads_manage_insights` | Meta Threads 앱·시크릿 | 등록된 HTTPS 주소로 이동 후 전체 URL 붙여넣기 |
| Instagram | `instagram_business_basic`, `instagram_business_manage_insights` | Meta 앱·시크릿, Business/Creator 계정 | 등록된 HTTPS 주소로 이동 후 전체 URL 붙여넣기 |
| Facebook Page | `pages_show_list`, `pages_read_engagement`, `read_insights` | Facebook Login 앱·시크릿 | 등록된 HTTPS 주소로 이동 후 전체 URL 붙여넣기 |
| TikTok | `user.info.basic`, `user.info.stats`, `video.list` | Desktop Login Kit 클라이언트 키·시크릿 | `http://127.0.0.1:38471/oauth/tiktok/callback` |
| 네이버 | 네이버 계정 로그인 | 네이버 로그인 앱·시크릿 | `http://127.0.0.1:38471/oauth/naver_blog/callback` |

게시 권한은 계정 연결 뒤 **게시 권한 연결**에서 따로 동의받습니다. 네이버 블로그는 공식 글쓰기 API가 없어 게시 권한이 없습니다([SNS 게시](SOCIAL_PUBLISHING.md) 참고).

YouTube 공개 조회(채널 검색·트렌드)는 YouTube Data API 키가 있으면 그 키를, 없으면 연결된 YouTube 계정의 읽기 토큰을 씁니다. 토큰은 Rust 안에서 고정된 `googleapis.com` 주소에만 씁니다.

## 로그인 완료와 저장

**브라우저에서 로그인**을 누르면 시스템 기본 브라우저에서 공식 제공자 페이지가 열립니다. 계정 로그인·게시 권한·업로드 권한 승인은 모두 시스템 기본 브라우저를 사용하며, 일반 링크용 Playwright 설정의 영향을 받지 않습니다. 운영체제의 기본 브라우저 설정은 변경하지 않습니다. Google·네이버·TikTok의 기본 로컬 콜백은 앱이 자동으로 받습니다. 동시에 하나의 로컬 콜백 로그인을 진행하고 포트 `38471`을 다른 서비스가 사용 중이면 해당 서비스를 확인하세요.

요청은 5분 뒤 만료됩니다. 완료하지 못했으면 **로그인 다시 시작**을 누릅니다. HTTPS 수동 콜백이나 자동 수신이 되지 않는 경우 브라우저의 최종 주소를 붙여넣어 완료할 수 있습니다. 입력란은 숨김 처리하며 완료·화면 이동 시 값을 지웁니다.

로컬 로그인을 다시 시작할 때 Rust는 이전 콜백 수신 작업을 취소하고 소켓이 닫힌 뒤 같은 포트를 다시 엽니다. 이전 요청의 `state`는 새 로그인에 사용할 수 없습니다. 다른 SNS에서 진행 중인 로컬 로그인은 먼저 완료하거나 **저장된 연결 해제**로 취소합니다.

Rust는 등록된 주소, 해당 제공자의 일회용 `state`, 허용된 코드 형식을 검증하고 잘못된 주소·중복 콜백·다른 제공자의 상태 값을 거절합니다. 인증 URL과 토큰 응답의 리디렉션도 제한합니다. 성공한 토큰 응답을 OS 저장소에 기록한 뒤에만 계정 연결 상태가 바뀝니다.

## 갱신과 다시 로그인

앱 실행 중 만료가 가까운 연결을 주기적으로 확인하고 공식 갱신 프로토콜을 호출합니다. 앱을 종료한 동안에는 갱신하지 않습니다. 다시 실행하면 저장된 연결을 읽고 갱신 가능한 토큰을 확인합니다. Google·네이버·TikTok은 유효한 갱신 토큰이 있으면 만료된 액세스 토큰을 갱신할 수 있습니다. 제공자마다 발급 조건·만료 정책이 달라 성공을 영구적으로 보장하지 않습니다.

Threads·Instagram은 유효한 장기 액세스 토큰을 갱신하며 발급·이전 갱신 후 24시간이 지나야 합니다. 이미 만료된 장기 토큰은 다시 로그인해야 합니다. 플랫폼 권한 철회·무효화 응답은 **다시 로그인 필요**로 표시합니다. 일시적인 네트워크 오류는 제한된 간격으로 다시 시도합니다. 앱의 **연결 갱신**으로 수동 갱신 결과를 확인할 수 있습니다.

화면의 만료 일시는 한국 시간으로 표시합니다. 연결 상태·만료 표시만으로 실제 API 조회나 게시가 성공했다고 판단하지 않습니다. 실제 사용자 앱의 로그인 성공·OS 저장소 재읽기·토큰 갱신은 등록된 클라이언트와 해당 계정으로 따로 검증해야 합니다.

## 브라우저 쿠키와 연결 해제

브라우저 로그인 쿠키는 시스템 브라우저가 관리합니다. Toris Studio는 쿠키를 추출·복제하거나 만료 일시를 연장하지 않습니다. 앱이 저장하는 세션은 OAuth 액세스·갱신 토큰과 만료 정보입니다. macOS는 Keychain, Windows는 Credential Manager를 사용하며 비밀 정보를 공개 저장소에 넣지 않습니다.

**저장된 연결 해제**는 Toris Studio에 저장된 계정 토큰과 진행 중인 요청을 삭제합니다. 등록한 앱 설정과 브라우저 로그인은 유지합니다. SNS에서 앱 권한까지 철회하려면 해당 플랫폼의 연결된 앱 관리에서 해제하고, 브라우저 로그아웃은 브라우저에서 진행합니다.

AI 구독 계정(Claude Code·Codex 등)은 SNS OAuth와 별개이며 각 CLI의 로그인을 씁니다. [AI 모델 연결](AI_PROVIDERS.md)을 참고하세요.

## macOS 키체인 승인

macOS의 연결 설정과 OAuth 기록은 Toris Studio 전용 통합 키체인 항목으로 옮깁니다. 기존 값을 읽는 첫 이전 과정에서는 macOS의 승인이 필요할 수 있습니다. 승인해 읽은 값이 통합 항목에 저장된 뒤에는 같은 설치본을 재실행할 때 기존 항목을 다시 읽지 않습니다. 앱 실행 중 읽은 값도 메모리에서 재사용합니다. 평문 설정 파일로 비밀 값을 옮기거나 모든 앱에 접근 권한을 부여하지 않습니다. Windows는 기존 자격 증명 저장 방식을 유지합니다.

사용자가 거절하거나 저장소 오류가 나면 상태 확인이 같은 승인 창을 계속 열지 않습니다. **저장소 권한 다시 확인**을 직접 눌러 재시도할 수 있습니다. 실패한 재시도는 실행 중 설정을 교체하지 않습니다. 기존 항목은 이전 시 보존하며, 명시적인 연결 해제는 해당 연결의 이전 기록도 삭제합니다.

현재 macOS 빌드는 로컬 ad-hoc 서명입니다. 같은 설치본에 대한 승인과 새 빌드로 교체할 때의 승인은 다릅니다. ad-hoc 서명은 실행 파일 해시로 앱을 식별하므로 업데이트 후 macOS가 다시 승인을 요구할 수 있습니다. 후속 업데이트까지 동일한 앱으로 신뢰받으려면 동일한 지속 코드 서명 인증서를 사용해야 합니다. [Apple 코드 서명 요구사항](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)
