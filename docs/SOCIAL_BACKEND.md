# 로컬 소셜 콘텐츠 DB와 수집

`/manage`에서 YouTube, Threads, 네이버 블로그, TikTok, Instagram 채널 정보를 등록하고 초안, 준비 완료, 예약 계획, 게시 완료 URL을 PostgreSQL에 보존합니다. `scheduled`는 캘린더용 계획 상태입니다. 플랫폼에 자동 게시하지 않습니다. 게시 완료는 외부에 실제 게시된 URL을 사용자가 기록하는 기능입니다.

## OrbStack에서 시작

Node.js 24와 OrbStack Docker 엔진을 켠 뒤 저장소에서 실행합니다.

```sh
npm run db:start
npm run db:migrate
npm run dev:local
```

`db:start`는 처음에 `.env.db.local`에 암호학적으로 생성한 관리자/앱 별도 암호를 만들고 `.env.local`에 `DATABASE_URL`이 없는 경우만 추가합니다. 두 파일은 권한 `0600`이고 Git에서 제외됩니다. 기존 환경 설정과 DB 볼륨을 보존합니다. Next 개발 서버가 이미 실행 중이었다면 재시작해야 새 연결 문자열을 읽습니다. Compose의 `postgres` 서비스는 `127.0.0.1:54329`에만 연결되며 저장 데이터는 `postgres-data` 볼륨에 남습니다. 연결 포트는 `.env.db.local`의 `TORIS_DB_PORT`로 조절할 수 있습니다.

마이그레이션은 관리자 계정을 이용하고 PostgreSQL 트랜잭션 및 advisory lock 안에서 실행됩니다. 앱은 `toris_app` 계정의 데이터 조회/작성 권한만 이용합니다. 서버 연결은 로컬 주소로 제한하고 연결/쿼리 제한 시간을 둡니다. 브라우저는 연결 문자열이나 플랫폼 API 암호를 받지 않습니다. 모든 소셜 API에는 루프백 주소와 동일 출처 요청 검사가 있습니다. 앱을 인터넷에 공개하려면 별도 사용자 인증/권한 모델이 필요합니다.

## 실제 인기 키워드와 콘텐츠

기본 키워드 소스는 [Google Trends 한국 공개 RSS](https://trends.google.com/trending/rss?geo=KR)입니다. 피드가 제공한 검색 추정치와 게시 시각만 표시합니다. 키워드를 입력하면 현재 인기 키워드 중 일치하는 항목을 필터링합니다. 네트워크 실패 시 DB에 저장된 마지막 관측을 유지하고 경고를 표시합니다. 임의 인기 점수나 조회수를 생성하지 않습니다.

`.env.local`에 아래 서버 환경 변수를 설정하면 API 기반 검색이 추가됩니다. 실제 값은 커밋하지 않습니다.

```dotenv
YOUTUBE_DATA_API_KEY=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
```

- YouTube: 검색어 없이 [mostPopular 한국 영상](https://developers.google.com/youtube/v3/docs/videos/list)을 조회합니다. 검색어가 있으면 최근 60일의 [영상 검색](https://developers.google.com/youtube/v3/docs/search/list)을 조회하고 실제 조회수 TOP 10을 저장합니다. 조회수, 영상 길이, 공개된 구독자 수를 표시할 수 있습니다. 3분 이하 영상은 짧은 영상 후보이며 길이만으로 실제 Shorts라고 판정하지 않습니다. 검색은 API 할당량을 사용합니다.
- 네이버: 검색어가 있을 때 [블로그 검색 API](https://developers.naver.com/docs/serviceapi/search/blog/blog.md)의 최신 글을 표시합니다. 검색 결과의 인기도나 조회수는 제공되지 않으므로 표시하지 않습니다.
- Threads/TikTok/Instagram: 로컬 채널·초안·예약 계획·게시 URL 기록입니다. 플랫폼 OAuth, 자동 게시, 계정 분석 권한을 연결했다고 주장하지 않습니다.

같은 YouTube 영상의 최초 일별 실측치를 한국 날짜로 저장합니다. 이후 수집 시 이전 날짜의 가장 최근 관측과 조회수 차이를 계산하고 실제 이전 관측 시각을 함께 반환합니다. 최초 관측에는 증가량이 없습니다. 일일 수집이 누락된 경우에도 항상 '어제 증가량'이라고 표시하지 않습니다. 최근 API 응답 기준 TOP 10이며 전체 YouTube를 완전 탐색한 순위가 아닙니다.

수집 호출은 30초 간격으로 제한합니다. 외부 URL은 고정된 공식 API로만 요청하며 리디렉션을 따르지 않습니다. 소스별 8초 제한, 2 MB 응답 제한, 병렬 소스 격리, XML 엔티티 거부를 적용합니다. 실패 소스는 다른 소스의 수집이나 기존 데이터에 영향을 주지 않습니다. 자동 게시 요청은 없습니다.

## API 계약

모든 요청/응답은 JSON이고 응답 캐시는 `no-store`입니다. 목록은 채널 200개, 콘텐츠 200개, 키워드 100개로 제한합니다. `lib/social/types.ts`가 클라이언트와 서버의 공유 계약입니다.

| API | 입력/결과 |
| --- | --- |
| `GET /api/social/dashboard` | `{channels, content, trends, integrations, database:{connected,message}}` |
| `POST /api/social/channels` | `{platform,name,handle?,url}` → `201 {channel}` |
| `POST /api/social/content` | `{platform,channelId?,title,body,status,scheduledAt?,url?}` → `201 {content}` |
| `PATCH /api/social/content/:id` | 변경할 필드 → `{content}` |
| `POST /api/social/trends/refresh` | `{keyword?}` → `{dashboard,collected,saved,warnings}` |

`status`: `draft`, `ready`, `scheduled`, `published`. 예약은 ISO 8601 오프셋 포함 일시가 필요하고 게시 완료에는 HTTPS URL이 필요합니다. 채널 플랫폼 불일치, 수정 충돌은 `409`; 입력 오류 `400`; 요청 크기 초과 `413`; 다른 출처 요청 `403`; DB 실패 `503`; 수집 빈도 초과 `429` + `Retry-After: 30`. 쓰기 재시도를 자동 실행하지 않으므로 중복 초안 생성에 주의하세요. 콘텐츠 수정은 정밀한 DB 수정 시각을 비교해 같은 시점의 병렬 저장 충돌을 감지합니다.

## 백업과 복원

```sh
npm run db:backup
docker compose --env-file .env.db.local stop postgres
docker compose --env-file .env.db.local start postgres
```

백업은 `.toris-studio/backups/*.dump`에 저장되고 Git에서 제외됩니다. 개인 콘텐츠를 포함하므로 별도 암호화 저장소에서 보관하세요. 볼륨을 삭제하는 `down -v`는 데이터 손실을 일으키므로 일반 종료에 사용하지 않습니다. 새 DB에 복원할 때 파일명을 확인하고 아래처럼 적용합니다. 기존 DB에 복원할 경우 중복 객체 오류가 발생할 수 있으므로 먼저 별도 빈 DB에서 검증합니다.

```sh
docker compose --env-file .env.db.local exec -T postgres pg_restore --username=toris_owner --dbname=toris_studio --no-owner < .toris-studio/backups/선택한파일.dump
```

실제 DB 통합 검증은 임시 채널/콘텐츠/관측만 만든 뒤 정리합니다.

```sh
TORIS_SOCIAL_DATABASE_INTEGRATION=1 node --env-file=.env.local --import=tsx --test tests/social-database.test.ts
npm test
```

일반 테스트는 입력 크기·URL·상태 전이, 소스 파서, SQL 바인딩, 채널 일치, 병렬 수정 충돌을 검증합니다. API 키가 없으면 YouTube/네이버 실계정 연결 검증은 수행되지 않습니다. 기존 영상 프로젝트 JSON 저장은 이 마이그레이션의 대상이 아닙니다.
