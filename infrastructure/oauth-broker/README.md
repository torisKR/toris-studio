# Toris OAuth Broker v1

`toris-oauth-broker` Worker는 TikTok·Threads·Instagram·Facebook·네이버·Google(YouTube·Calendar) 로그인의 코드 교환·갱신과 네이버 블로그 검색을 Toris가 가진 클라이언트 시크릿으로 대신 처리합니다. 사용자는 시크릿을 입력하지 않고 로그인만 합니다. 토큰은 서버에 저장하지 않고 응답으로만 돌려주며, 앱이 OS 키체인에 보관합니다. Google 데스크톱 클라이언트는 교환과 갱신에 시크릿을 요구하므로(시크릿 없이 교환하면 `client_secret is missing`) Google도 이 브로커를 거칩니다.

**상태: 2026-11-20에 `https://oauth.toris.kr`로 배포했고, 모든 플랫폼은 꺼져 있습니다.** 제공자 클라이언트 ID와 시크릿을 아직 넣지 않았기 때문입니다. 배포 뒤 확인한 것: `/v1/config` 200(모두 `enabled:false`), `Origin` 헤더 403, 브라우저 UA와 0.7.0 앱 426, 꺼진 플랫폼 404, 알 수 없는 경로 400, `workers.dev` 주소 꺼짐, Workers 로그·Logpush·tail 소비자 없음. 실제 제공자 호출과 실제 로그인은 확인하지 않았습니다. Google(`youtube`, `google_calendar`)은 저장소에만 추가했고 아직 배포하지 않았습니다. 배포에는 `GOOGLE_CLIENT_SECRET` 비밀값이 필요합니다(아래 2·3).

배포는 저장소 밖 폴더에서 했습니다. 이 디렉터리에는 Wrangler 의존성을 두지 않으므로, `worker.ts`와 `wrangler.jsonc`를 임시 폴더에 복사하고 `wrangler`를 설치한 뒤 `wrangler deploy` → `wrangler triggers deploy` → `wrangler secret bulk` 순으로 실행합니다. 처음 만들 때는 업로드 직후 Worker가 조회되지 않아 `wrangler deploy`가 오류로 끝날 수 있습니다. 업로드는 된 것이니 잠시 뒤 `wrangler triggers deploy`를 다시 실행합니다. `toris-site` Worker가 이 영역의 와일드카드 경로를 갖고 있어서 사용자 지정 도메인만으로는 요청이 오지 않습니다. 그래서 `oauth.toris.kr/*` 경로를 함께 둡니다.

## 엔드포인트

모든 응답에는 `"v":1`과 `Toris-Broker-Version: 1`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`가 붙습니다. CORS 헤더는 보내지 않습니다.

| 경로 | 요청 | 요청 제한(IP, 60초) |
|---|---|---|
| `GET /v1/config` | 없음 | 없음 |
| `POST /v1/oauth/{platform}/start` | `{"purpose":"read"\|"publish","challenge":"<43자 base64url>"}` | 20 |
| `POST /v1/oauth/{platform}/token` | `{"state","code","verifier","redirectUri"}` | 10 |
| `POST /v1/oauth/{platform}/refresh` | tiktok·naver_blog·youtube·google_calendar `{"refreshToken"}`, facebook `{"accessToken"}` | 30 |
| `POST /v1/naver/search/blog` | `{"query":"1~100자","display":1..100,"start":1..1000,"sort":"sim"\|"date"}` | 30 + 전역 일일 예산 |

- `platform`은 `tiktok`, `threads`, `instagram`, `facebook`, `naver_blog`, `youtube`, `google_calendar`만 허용합니다. threads·instagram의 `/refresh`는 404입니다(앱이 시크릿 없이 직접 갱신).
- 모든 요청에서 `Origin` 헤더가 있으면 403, `User-Agent: TorisStudio/<semver>`가 `MIN_APP_VERSION`보다 낮거나 없으면 426입니다.
- POST 본문은 `application/json`, 8 KiB 이하, 정해진 필드만 받습니다.
- `/token`은 서명 → 만료 → 플랫폼 → `redirectUri` → `base64url(SHA256(verifier)) == challenge` 순서로 검사한 뒤 제공자에 요청합니다. 비교는 상수 시간입니다.
- Meta 3종은 단기 교환과 장기 교환을 한 번에 처리해 장기 토큰만 돌려줍니다(`long_lived:true`). Instagram의 `data[0]` 감싸기는 서버가 풉니다.
- 오류 형식은 `{"v":1,"error":{"code","retryable"}}`이고, 제공자 오류 원문은 돌려주지 않습니다.
- Google(`youtube`, `google_calendar`): 클라이언트 ID·시크릿 하나를 둘이 함께 씁니다. 교환과 갱신은 `POST https://oauth2.googleapis.com/token`(form)이고, 교환에는 앱이 보낸 verifier를 `code_verifier`로 그대로 넘깁니다. 갱신 응답에 `refresh_token`이 없으면 응답에서도 빠지고 앱이 기존 값을 유지합니다. `long_lived`는 `false`입니다.
- Google 오류: `invalid_grant`만 `provider_rejected`(401, 다시 로그인)입니다. 그 밖의 4xx(`invalid_client`, `invalid_request`, `unauthorized_client` 등)는 서버 설정 문제로 보고 `provider_unavailable`(502, 재시도)로 답합니다. 시크릿 설정 실수 하나로 모든 사용자의 Google 연결이 '다시 로그인 필요'가 되지 않게 하려는 것입니다. 다른 플랫폼의 오류 매핑은 그대로입니다.
- Google 철회(`/revoke`)는 시크릿이 필요 없어 앱이 Google에 직접 합니다.
- 1차에서 뺀 것: `/revoke`, 검색 결과 캐시.

## 저장하는 것과 남기지 않는 것

- 저장: 비밀값, Durable Object `SearchBudget`의 `{day:"YYYY-MM-DD"(KST), count}` 한 건, Cloudflare 관리형 요청 제한 카운터.
- 저장하지 않음: 인가 코드, state, verifier, 토큰, 검색어, 계정 ID, IP(요청 제한 키로만 사용).
- `console.*` 호출이 없고(테스트가 소스와 실행 중 호출을 모두 검사), 예외는 오류 코드로만 바뀝니다.

## 배포 절차 (사람이 승인한 뒤에만)

### 1. 제공자 앱에 등록할 리디렉션 주소

| 플랫폼 | 리디렉션 주소 | 비고 |
|---|---|---|
| TikTok | `http://127.0.0.1:38471/oauth/tiktok/callback` | 데스크톱 PKCE |
| 네이버 로그인 | `http://127.0.0.1:38471/oauth/naver_blog/callback` | 검수에서 http 루프백을 허용하는지 미확인 |
| Threads | `https://toris.kr/oauth/threads/callback` | 브로커 형식 state면 `toris-site` Worker가 루프백으로 302 중계 |
| Instagram | `https://toris.kr/oauth/instagram/callback` | 같음 |
| Facebook | `https://toris.kr/oauth/facebook/callback` | 같음. Graph `v25.0` 사용 |
| YouTube | `http://127.0.0.1:38471/oauth/youtube/callback` | Google 데스크톱 클라이언트(루프백은 Google이 따로 등록받지 않음), PKCE |
| Google Calendar | `http://127.0.0.1:38471/oauth/google_calendar/callback` | YouTube와 같은 클라이언트 |

Meta 3종의 콜백 중계는 `infrastructure/oauth-callback/worker.ts`에 있습니다. 그 변경을 먼저 배포해야 Meta 로그인이 앱으로 돌아옵니다.

### 2. 비밀값 (`wrangler secret put <이름>`)

`TIKTOK_CLIENT_SECRET`, `THREADS_APP_SECRET`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `NAVER_LOGIN_CLIENT_SECRET`, `NAVER_SEARCH_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `STATE_SIGNING_KEYS`

`STATE_SIGNING_KEYS`는 `{"<kid>":"<base64 32바이트>"}` JSON이며 키는 1~2개만 허용합니다(현재 키 + 이전 키). 형식이 틀리면 모든 OAuth 요청이 `internal`로 실패합니다.

### 3. 변수 (`wrangler.jsonc`의 `vars`, 비밀 아님)

`TIKTOK_CLIENT_KEY`, `THREADS_APP_ID`, `INSTAGRAM_APP_ID`, `FACEBOOK_APP_ID`, `NAVER_LOGIN_CLIENT_ID`, `NAVER_SEARCH_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `STATE_KEY_ID`, `MIN_APP_VERSION`, `ENABLED_PLATFORMS`(쉼표 목록), `NAVER_SEARCH_DAILY_BUDGET`(기본 20000, 0이면 검색 끔)

클라이언트 ID나 시크릿이 비어 있는 플랫폼은 `/v1/config`에서 `enabled:false`가 되고 요청은 404입니다. 저장소의 `wrangler.jsonc`는 Google을 뺀 클라이언트 ID를 빈 값으로 둡니다. `GOOGLE_CLIENT_ID`(공개 값)와 `ENABLED_PLATFORMS`의 `youtube,google_calendar`는 저장소에 있으므로, Google은 `GOOGLE_CLIENT_SECRET`을 넣은 때부터 켜집니다. 시크릿이 없으면 `enabled:false`로 남습니다.

### 4. 경로와 바인딩

- 사용자 지정 도메인 `oauth.toris.kr` 하나만 씁니다. `workers_dev`와 미리보기 주소는 끕니다.
- `ratelimits` 네 개(`START_LIMITER` 20, `TOKEN_LIMITER` 10, `REFRESH_LIMITER` 30, `SEARCH_LIMITER` 30, 모두 60초). `namespace_id`가 계정 안의 다른 Worker와 겹치지 않는지 확인합니다. 바인딩이 없으면 해당 엔드포인트는 `internal`로 실패합니다(닫힌 쪽으로 실패).
- Durable Object `SEARCH_BUDGET` → `SearchBudget`, 마이그레이션 `v1`(`new_sqlite_classes`).

### 5. 로그 설정 확인 항목

- `wrangler.jsonc`에서 `observability.logs.enabled=false`, `invocation_logs=false`. 호출 로그에는 요청 URL이 남습니다. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)
- 배포 전에 계정 단위 설정을 대시보드에서 확인합니다: 이 Worker의 Logpush 작업 없음, tail 소비자 없음, `wrangler tail` 세션을 열지 않음. 계정 단위 상태는 이 작업에서 확인하지 않았습니다.

### 6. 배포 뒤 확인

- `GET https://oauth.toris.kr/v1/config`에 `User-Agent: TorisStudio/<현재 버전>`으로 요청해 `enabled` 값을 확인합니다.
- `Origin`을 붙인 요청이 403인지, 브라우저 UA가 426인지 확인합니다.
- 실제 로그인은 각 제공자의 테스트 계정으로 앱에서 한 번씩 진행합니다.
- Google: Google Cloud의 OAuth 동의 화면 게시 상태가 '프로덕션'인지 확인합니다. '테스트'면 등록된 테스트 사용자만 로그인할 수 있고 갱신 토큰이 7일 뒤 만료됩니다. YouTube와 Calendar로 각각 로그인 → 한 시간 뒤 자동 갱신 → 연결 해제(철회)까지 한 번씩 확인합니다.

## 키 교체 절차

1. 새 32바이트 키를 만들고 `STATE_SIGNING_KEYS`를 `{"<새 kid>":"…","<현재 kid>":"…"}`로 바꿉니다.
2. `STATE_KEY_ID`를 새 kid로 바꿔 배포합니다. 이전 키로 서명된 state(최대 10분)는 계속 통과합니다.
3. 10분 이상 지난 뒤 이전 키를 `STATE_SIGNING_KEYS`에서 뺍니다.
4. 제공자 시크릿 교체: 제공자 콘솔에서 새 시크릿을 발급 → `wrangler secret put`으로 바꿈 → 이전 시크릿 폐기. TikTok·네이버 갱신 토큰이 시크릿 교체 뒤에도 유지되는지는 제공자 정책을 확인합니다.
5. 비상 차단: `MIN_APP_VERSION`을 올리거나 `ENABLED_PLATFORMS`에서 플랫폼을 빼고 배포합니다.

## 남는 위험

1. 앱을 분해하면 Toris 클라이언트 ID와 브로커로 누구나 자기 도구를 만들 수 있고, 동의 화면에는 "Toris Studio"가 보입니다. 공개 클라이언트라 막을 수 없습니다.
2. 훔친 갱신 토큰(TikTok·네이버)이나 장기 토큰(Facebook)을 브로커로 연장할 수 있습니다. 요청 제한은 속도만 늦춥니다.
3. 누군가 네이버 검색 예산을 소진하면 모든 사용자가 그날 검색을 못 씁니다.
4. 브로커가 침해되면 시크릿이 유출되고 진행 중인 교환의 토큰이 노출됩니다.
5. 제공자가 앱 심사를 철회하거나 시크릿을 바꾸면 모든 사용자의 연결이 동시에 끊깁니다.
6. IP 기준 제한은 분산 공격에 약하고, Cloudflare 요청 제한은 위치별 근사치입니다.
7. Meta는 PKCE가 없어서, 가로챈 코드를 막는 장치는 브로커의 verifier 바인딩뿐입니다.
8. state의 purpose(`u`)는 서명에만 들어가고 서버가 scope를 강제하지 않습니다. scope는 앱의 인가 요청과 제공자 앱 설정이 정합니다.
9. Google: 검증받지 않은 앱이라 로그인 화면에 확인되지 않은 앱 경고가 나옵니다. 검증 전 민감 범위 앱의 사용자 수 한도(Google 정책상 100명으로 알려짐)는 이번에 확인하지 않았습니다. YouTube Data API 하루 쿼터는 Toris 연결 사용자 전체가 나눠 쓰므로, 앱은 Toris 연결 토큰으로 `search.list`를 하지 않습니다.
10. Google 철회는 프로젝트 단위라 같은 계정의 YouTube를 해제하면 Calendar 권한도 함께 철회될 수 있습니다.
11. `toris.kr` 콜백 Worker는 서명 키 없이 state의 형식만 보고 루프백 중계 여부를 고릅니다. 경로 선택용이며 보안 장치가 아닙니다. 서명 검증과 verifier 바인딩은 이 브로커가 합니다.

## 검증

```sh
node --import tsx --test infrastructure/oauth-broker/broker.test.mjs infrastructure/oauth-callback/callback.test.mjs
node scripts/mutation-check.mjs infrastructure/oauth-broker/mutants.json
```

테스트는 실제 Worker 모듈을 가짜 `fetch`·가짜 요청 제한·메모리 저장소로 실행합니다. 증거 수준은 단위 테스트입니다.
