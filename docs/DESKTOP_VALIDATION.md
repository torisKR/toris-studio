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

## 0.1.7 업데이트 준비 및 데이터 이관 검사

- 자동 업데이트 기능을 포함한 0.1.7 bootstrap 앱을 기존 설치본 백업 후 설치했습니다. 앱의 업데이트 화면에 현재 버전 0.1.7이 표시됩니다. 엄격한 macOS 코드 서명 검사와 기존 로고 ICNS 일치를 확인했습니다.
- 설정·프로젝트·스케줄러·미디어·DB 실행 설정을 `Application Support/kr.toris.studio` 아래로 이관했습니다. 원본을 보존하고, 기존 대상 파일을 덮어쓰지 않으며, 일반 설정의 비밀 필드 6개는 null 상태입니다. 설정과 DB 실행 설정의 파일 권한은 0600입니다.
- 실제 앱에서 YouTube·네이버 연결 2개, 로컬 DB, 영상 프로젝트 2개, 기존 채널·콘텐츠 각 1개가 복원되었습니다. 실제 DB 백업 23,005 bytes 생성도 확인했습니다.
- Rust 핵심 검사 97개 통과·환경이 필요한 3개 기본 제외. updater 기본 feature 검사 6개와 Opal 실행 중 설치를 제한하는 검사가 통과했습니다. TypeScript·Vite·배포 도구 검사도 통과했습니다.

## 0.1.9 GitHub CI 설치 빌드 검사

- PR Actions 실행 [37747878957](https://github.com/torisKR/toris-studio/actions/runs/37747878957)에서 macOS Apple Silicon·Intel, Windows x64의 소스 검사와 설치 파일 빌드가 모두 성공했습니다. artifact 크기는 각각 7,410,187 / 7,933,830 / 4,332,676 bytes입니다.
- Windows에서 Unix 경로를 사용하던 Opal 테스트 fixture를 OS에 맞게 수정했습니다. 이 변경은 실제 Windows CI에서 통과했습니다. production CLI 경로 검증은 유지했습니다.
- 배포 시 선택적인 Apple 인증서 secret이 없으면 해당 환경 변수를 제거하도록 수정했습니다. 빈 인증서 환경 변수를 인증서로 가져오려던 실패를 방지합니다. updater 서명 secret은 필수이며 이 예외와 관계없습니다.
- 이 절의 PR 설치 파일은 배포 비밀을 사용하지 않은 preview입니다. 공개 Release·GitHub Package 및 실제 앱 업데이트 결과는 별도로 확인해야 하며, Windows 기기 실행 또는 Apple 공증의 증거로 해석하지 않습니다.

## 0.1.9 서명 빌드와 게시 차단

- [실제 배포 실행 37757216878](https://github.com/torisKR/toris-studio/actions/runs/37757216878)에서 Mac arm64·Intel 및 Windows x64의 설치 파일 빌드와 updater 서명, Rust의 버전·서명·SHA256 통합 검증은 통과했습니다.
- 고정한 ORAS 설치 action의 내장 버전 목록에 1.3.4가 없어 게시 전에 실패했습니다. 공식 1.3.4 릴리스는 존재하며, 후속 배포는 공식 Linux 배포 파일 URL과 검증된 SHA256을 지정합니다. 실패한 태그를 덮어쓰거나 완성되지 않은 Release를 공개하지 않았습니다.
- GitHub Pages [다운로드 페이지](https://toriskr.github.io/toris-studio/)는 배포 성공과 HTTP 200을 확인했습니다. 페이지 배포와 설치 파일 공개는 별개입니다.

## 0.1.10 오버뷰 UI 검증

- 기본 오버뷰, 그룹별 작업 메뉴, 현재 불러온 데이터 현황, 콘텐츠 상태 필터, 콘텐츠·채널·키워드 검색, 수집된 YouTube의 실제 조회수 정렬을 구현했습니다. 채널 등록과 수집 API 설정, SNS OAuth 연결은 서로 다른 상태로 안내합니다.
- 설치 아이콘을 유지하고 동일한 사용자 제공 T 로고와 직접 만든 SVG를 번들에 추가했습니다. 외부 폰트·에셋·셰이더 라이브러리는 추가하지 않았습니다. 브랜드 SVG에는 스크립트나 외부 참조가 없습니다.
- 임시 Vite 화면 검증 서버에서 합성 데이터로 검색·필터·조회수 정렬·빈 결과 초기화·빈 DB·DB 미연결·불러오기 오류를 확인했습니다. 실제 DB나 키를 사용하지 않았으며 합성 결과를 사용자 DB에 저장하지 않았습니다.
- 검증에서 Instagram 필터 이후 새 초안의 플랫폼이 유지되고, 네이버 결과는 네이버 초안으로 열리는 것을 확인했습니다. 같은 플랫폼의 두 번째 채널 이름 검색도 일치한 이름과 정확한 검색 건수를 표시했습니다.
- 1280px·820px 화면에서 수평 overflow가 없고 모든 로컬 브랜드 이미지가 로드됐습니다. 상단 영역은 실제 216px이며 메뉴 13px, 작업 제목 14px을 확인했습니다. TypeScript·Vite 빌드를 통과했습니다. 키보드 focus와 모션 축소 CSS/포인터 조건은 소스 검토했습니다.
- 이 절의 브라우저 결과는 화면 검증입니다. 네이티브 설치본·서명된 공개 업데이트·Windows 기기 실행의 증거는 별도로 기록합니다.

## 0.1.10 Opal 오류 수정 및 실서비스 실행 검증

- 기존의 접근 실패 안내를 조사한 결과 Google 로그인과 등록 주소는 유효했으며, 등록된 비공개 Draft에 실행 단계가 없었습니다. 같은 비공개 워크플로에 입력 4개·검색 생성·원문 출력의 6단계를 구성해 저장했습니다. 공개 공유나 게시 없이 실행했습니다.
- Rust는 저장된 Aside 계정과 CLI를 사용해 워크플로를 열고, iframe 내부 Preview를 포함해 실제 접근 거부·로그인 필요·빈 워크플로 상태를 구분합니다. UI는 미저장 연결 설정으로 실행하지 않으며 오류 발생 시 연결 설정을 표시합니다.
- 앱이 실행 시점의 한국 기준 날짜를 전달합니다. 날짜 입력이 없는 기존 3입력 워크플로도 유지하며 결과 JSON 형식은 바꾸지 않았습니다. UTC 자정 변환과 연말 경계를 포함한 Opal 검사 10개 및 기본 desktop Rust 검사, TypeScript·Vite 빌드를 통과했습니다.
- 실제 Google Opal 검색 실행에서 구조화된 키워드 1개·출처 1개를 받았습니다. 출력의 schemaVersion 1, 지역 KR, 기간 7일을 확인하고 개별 원문을 열어 제목·본문·발행시각 및 기간 내 게시 여부를 검증했습니다. 홈페이지만 반환하던 이전 결과와 잘못된 출력은 DB에 저장하지 않았습니다.
- 저장된 설정과 production 프롬프트·환경·명령 인수로 실행한 실제 Aside 브리지는 409.08초에 종료 코드 0으로 완료했습니다. 결과 마커 1개·차단 마커 0개, 주제 일치·schemaVersion 1·KR·7일 필드, 키워드 2개·고유 출처 2개를 확인했습니다. 두 개별 원문의 제목·본문·발행시각도 대조했습니다. 한 출처는 기준 날짜와 7일 차이가 있어 오늘을 포함한 최근 7개 달력 날짜까지 모두 충족했다고 해석하지 않습니다. 이 진단은 DB에 쓰지 않았습니다.
- 실제 CLI가 세션 생성 메타데이터를 stderr에 출력하는 것을 확인해, stdout만 읽던 종료 처리의 결함을 수정했습니다. 별도로 제한 수집한 stderr의 정확한 메타데이터만 사용하고 stdout 결과로 세션 ID를 대체하지 않습니다. 시간 초과·출력 초과·IPC Drop·정상 앱 종료·메타데이터 도착 지연 및 불확실한 ID의 차단 회귀 검사와 기본 desktop Rust·포맷 검사를 통과했습니다. 원문 실행 로그는 UI나 공개 소스로 반환하지 않습니다.
- 실제 설치본의 Opal 실행은 사용자가 탐색 시작을 눌러 진행 중 상태를 확인했습니다. 이후 DB를 읽기 전용으로 확인해 Opal 행 수 0→1, 지역 KR·기간 7일·키워드 2개 저장을 확인했습니다. 저장 이후 네이티브 재실행 복원은 별도 미검증입니다. 이후 사용자 요청으로 Opal 기능을 키워드 탐색으로 교체하며 이 행은 보존합니다. 개인 워크플로 주소·Google 계정·입력 주제·결과 원문은 공개 소스에 포함하지 않았습니다.

## 0.1.10 공개 배포 및 실제 업데이트

- [배포 실행 37769105400](https://github.com/torisKR/toris-studio/actions/runs/37769105400)의 macOS arm64·Intel·Windows x64 빌드·서명과 최종 게시가 성공했습니다. 첫 시도의 설치 파일을 유지하고 실패한 게시 job만 다시 실행했습니다. [v0.1.10](https://github.com/torisKR/toris-studio/releases/tag/v0.1.10)은 태그의 정확한 원본 커밋에 연결되어 있습니다.
- 공개 Release의 설치·updater 파일과 서명, latest.json 총 15개를 [공개 GitHub Package](https://github.com/torisKR/toris-studio/pkgs/container/toris-studio%2Fdesktop)의 파일과 크기·SHA256으로 대조했습니다. 익명 접근과 공식 updater 공개키 검증도 통과했습니다. Package는 저장소의 Public 권한을 상속했습니다.
- 기존 0.1.7 앱의 업데이트 확인·설치·재시작 버튼으로 공식 0.1.10으로 갱신했습니다. 설치된 macOS 실행 파일 SHA256이 공식 arm64 updater 파일 안의 실행 파일과 일치합니다. 설치 아이콘도 이전과 일치했습니다. 사용자가 재시작된 앱 창이 보인다고 확인했습니다.
- 업데이트 직후 기존 채널 1개·콘텐츠 1개·트렌드 42개와 프로젝트 파일을 보존했습니다. 화면 제어 도구는 재시작된 창을 찾지 못해 그 이후 네이티브 조작 검증은 사용자의 직접 조작 확인과 구분합니다.
- 게시 API의 생성 직후 목록 지연을 수정한 [PR 4](https://github.com/torisKR/toris-studio/pull/4)를 병합했습니다. [검증 실행 37771120417](https://github.com/torisKR/toris-studio/actions/runs/37771120417)의 세 OS 빌드와 보안 job, 배포 도구 회귀 검사 9개가 통과했습니다.

## 키워드 탐색 컨테이너 검증

- 공식 Crawl4AI 0.9.4 multiarch manifest digest로 고정한 arm64 이미지를 OrbStack에 설치했습니다. `toris-studio-keywords-crawl4ai-1` 컨테이너가 healthy이고 `127.0.0.1:11235`에만 노출됩니다. PostgreSQL과 다른 컨테이너를 변경하지 않았습니다.
- 실제 API 검사 12개 통과: health 버전, 무인증·틀린 토큰 401, 공개 Example Domain 제목·원본 URL·Markdown 1,285 bytes, loopback·사설망·metadata·Docker host·IPv6·NAT64·사설 DNS 차단, 공개 httpbin에서 사설 주소로 리디렉션하는 요청의 403 차단. 단순 통신 실패를 차단 성공으로 처리하지 않았습니다.
- Docker inspect에서 비관리자·읽기 전용·호스트 마운트 없음·cap_drop ALL·no-new-privileges·2GiB/2CPU/512PID/256MiB SHM 제한을 확인했습니다. 토큰 파일은 런타임 디렉터리의 0600 파일에만 두고 출력·공개 소스에 포함하지 않았습니다.
- 공식 이미지의 Chromium은 이 환경에서 사용자 namespace sandbox를 실행하지 못합니다. 컨테이너 권한을 확대하지 않았으며 이 한계는 [크롤러 운영 문서](../infrastructure/keyword-crawler/README.md)에 기록했습니다. DNS rebinding을 실제 공격 환경으로 구성한 검증은 하지 않았습니다. 기본 egress broker와 Rust preflight를 유지합니다.
- 컨테이너 단독 검증은 앱 IPC·DB 본문 저장 또는 네이티브 UI 검증의 증거와 구분합니다.

## 0.1.11 키워드 탐색 Rust 및 실제 DB 검증

- Backend Architect, Frontend Developer, Application Security Engineer, DevOps Automator 역할로 나누어 Opal 메뉴·IPC를 키워드 탐색으로 교체했습니다. Opal Rust 소스와 이전 설정·DB 이력은 보존하고 활성 실행 등록은 제거했습니다. 설계·소스 범위·다른 수집 도구의 적용 상태는 [키워드 탐색 설계](KEYWORD_EXPLORER.md)에 있습니다.
- Rust 단위 검사 95개 통과, 환경이 필요한 3개 기본 제외. 기본 desktop feature 검사와 rustfmt 검사도 통과했습니다. 한국어 Unicode 정규화·일치 필드·관측 검색어와 기존 주제의 분리·추출 횟수, URL/IP/토큰/응답 크기 검증을 검사했습니다.
- 취소가 성공했는데 저장되는 경합을 수정했습니다. 취소와 저장 시작을 같은 mutex에서 결정하며, 먼저 저장이 시작되면 취소를 명시적으로 거절합니다. 64개 스레드 경합 검사와 업데이트 lock 검사가 통과했습니다.
- 이미 완료된 작업의 취소도 명시적으로 거절해 늦은 취소 응답이 완료 결과를 버리지 않도록 했습니다. 종료 직후 취소·64회 경합과 앱 종료 가드를 추가 검사했습니다.
- 새 Rust 유지보수 실행 파일의 `--db-migrate`로 기존 OrbStack PostgreSQL에 `006`을 적용했습니다. 키체인·API 키를 읽지 않았습니다. 실제 `toris_app` 계정의 SELECT·INSERT 허용과 UPDATE·DELETE 제한, 빈 검색어·잘못된 결과 JSON·빈 본문 제약 거부를 확인했습니다. 합성 검증 행은 트랜잭션 롤백 후 남지 않았습니다.
- 별도 Rust 프로세스에서 기존 자료 42개 검색, 콘텐츠 상세와 제목 검색의 일치, 실제 Google RSS 주제 한 건의 공식 필터 수집·저장·별도 연결 재조회 성공을 확인했습니다. Google 필터를 YouTube·네이버 API 검색어 관측으로 만들지 않았습니다. 자료는 42→43개가 됐고 기존 채널 1개·콘텐츠 1개·Opal 결과 1개는 유지했습니다. 원문과 실제 검색어는 검증 출력이나 공개 소스에 넣지 않았습니다.
- Rust 크롤러 상태가 실제 Crawl4AI의 토큰 파일과 health 버전을 확인해 연결됨으로 반환했습니다. Firecrawl은 인증·egress 계약 검증 전 비활성화 상태로 유지합니다.
- 0.1.11 버전의 새 Rust 프로세스를 별도로 실행해 DB의 자료 43개와 공식 검색 이력 1개를 읽기 전용으로 다시 복원했습니다. 이 과정에서는 추가 수집·DB 쓰기·키체인 읽기를 하지 않았습니다.
- 별도의 읽기 전용 보안 리뷰에서 Critical/High 배포 차단 문제는 발견하지 않았습니다. UI 취소 거절이 성공 결과를 버리던 문제는 Frontend 담당에게 전달해 수정했습니다. 실제 네이티브 새 화면과 Windows 기기 실행, YouTube·네이버의 이번 검색어 실계정 요청 검증은 별도입니다.

## 0.1.11 키워드 화면 검증

- 합성 Tauri IPC fixture로 키워드→콘텐츠 검색, 콘텐츠→키워드 상세, 관측 검색어와 추출 단어의 구분, 키워드 클릭 재검색과 저장 검색 이력을 확인했습니다. 합성 자료는 화면에 검증 자료임을 표시하고 사용자 DB에 저장하지 않았습니다.
- 원문 표시에서 HTML/script가 텍스트로 보이고 실행되지 않는지, 외부 영상 재생 주소를 거절하고 Rust가 준비한 loopback iframe 주소만 사용하는지 확인했습니다. 로컬 크롤러 시작·원문 수집 IPC, 원문 접기·다시 열기, 재검색에서 선택 상세 유지와 선택 항목 제거 안내를 확인했습니다.
- 빈 DB·검색 0건·DB 미연결과 복구, status·검색·상세 오류 표시를 확인했습니다. 취소 수락·저장 중 거절·원래 요청 완료 이후 늦은 취소 거절의 세 경로에서 입력이 복구되고 완료 결과가 유지됐습니다.
- TypeScript·Vite 빌드가 통과했습니다. 1280px·820px 화면에 수평 overflow가 없고 820px에서 결과와 상세가 세로로 배치됩니다. 소스 선택 이후 네이버 검색 결과의 정확한 필터 건수도 확인했습니다. 개인 API 키·사용자 콘텐츠를 fixture에 사용하지 않았습니다. 이 절의 화면 검사는 실제 네이티브 DB 연결 UI나 Windows 기기 실행의 증거와 구분합니다.

## 0.1.11 공개 배포 검증

- 키워드 탐색 구현 [PR 5](https://github.com/torisKR/toris-studio/pull/5)를 병합했습니다. [PR 검사 37775497750](https://github.com/torisKR/toris-studio/actions/runs/37775497750)에서 보안 검사와 macOS arm64·Intel·Windows x64 빌드가 모두 성공했습니다. 공개 태그의 소스는 `3df351a703569933587e1e70d83dff13965fb040`입니다.
- [배포 실행 37776920740](https://github.com/torisKR/toris-studio/actions/runs/37776920740)의 준비·세 OS updater 서명 빌드·게시가 모두 성공했습니다. [v0.1.11](https://github.com/torisKR/toris-studio/releases/tag/v0.1.11)은 draft·prerelease가 아닌 최신 공개 릴리스입니다.
- Release의 15개 파일을 익명으로 다운로드해 manifest의 크기·SHA256과 대조했습니다. 최신 feed와 태그 feed의 바이트가 일치하며, 플랫폼별 updater URL이 정확한 arm64·Intel·Windows 파일에 연결됩니다. Rust verifier로 세 updater의 minisign 서명과 인증된 앱 버전 `0.1.11`을 확인했습니다.
- [공개 GitHub Package](https://github.com/torisKR/toris-studio/pkgs/container/toris-studio%2Fdesktop)의 `0.1.11` manifest와 config·15개 layer를 익명으로 받아 크기·digest 및 Release 파일과의 일치를 확인했습니다. manifest digest는 `sha256:ff9b3bc836d0e725d3661f338f78a6e29547130189b400c49e011bdb1eadb87e`입니다.
- 공식 arm64 updater 안의 실행 파일 SHA256은 `50f8128384b75984e2e7e04b1aad2744d898e634dfed8ba7bf5508365cf6d263`입니다. 설치 아이콘은 기존 공식 0.1.10과 일치합니다. updater 서명 검증은 Apple Developer ID 공증이나 Windows Authenticode 인증의 증거가 아닙니다.
- 이 절의 공개 배포 검증 시점에 로컬 설치본은 `0.1.10`입니다. 화면 제어 도구의 `noWindowsAvailable`로 업데이트 버튼을 조작하지 못해 사용자에게 앱 내 0.1.11 설치·재실행을 요청했습니다. 로컬 설치와 새 네이티브 화면은 확인 이후 별도로 기록합니다.

## 0.1.12 칸반과 자료 기반 영상 제작

- 이 작업을 시작하며 실제 설치본이 공식 `0.1.11`임을 확인했습니다. macOS 실행 파일 SHA256과 설치 아이콘이 공개 arm64 updater와 일치했고, 화면 제어로 영상 스튜디오의 저장 프로젝트 4개·FFmpeg 및 한국어 글꼴 준비 상태를 확인했습니다. 이 확인은 새 `0.1.12` 설치 검증과 구분합니다.
- Frontend Developer 담당 두 명과 Desktop App Engineer 담당을 나눠 칸반 스크롤, 소재 전달·편집 UI, Rust 영상 프로젝트 생성·저장을 구현했습니다. 사용자 흐름과 현재 출력 범위는 [트렌드·키워드 영상 기획](RESEARCH_VIDEO.md)에 있습니다.
- 칸반 합성 Chromium 검사에서 1280·820·390px 모두 페이지 가로 넘침 없이 네 열이 한 줄을 유지했습니다. 실제 휠·방향키·Page·Home/End·이동 버튼과 열 내부 세로 이동, 카드 수정·추가·빈 열·DB 미연결 상태를 확인했습니다. 관찰 기록은 29개이며 콘솔 경고·오류가 없었습니다. Shift+휠 분기는 합성 WheelEvent로 검사했고 실제 장치의 Shift+휠과 네이티브 WebView는 별도 미검증입니다.
- Rust 입력 검증·모든 출처 보존·세 영상 형식·설명 없음 처리·AI 허구 및 임의 경로 거부·작업 잠금 검사를 추가했습니다. 문장 또는 어절 경계에서 발췌를 끝내도록 보완하고 한국어·Unicode 경계 검사도 추가했습니다. 최종 단위 회귀 검사 106개 통과·기본 제외 2개, 별도 DB integration 기본 제외 1개를 확인했습니다. 첫 실행에서 샌드박스의 loopback 포트 금지로 실패한 모의 HTTP 검사는 권한을 갖춘 로컬 모의 서버로 재실행해 통과했습니다. 실제 제공자 API를 호출한 결과로 해석하지 않습니다.
- 기존 프로젝트 파일을 비공개 임시 위치에 백업한 뒤 별도 Rust 프로세스로 실제 로컬 DB의 저장 자료 한 건을 조회하고, 새 로컬 영상 프로젝트 두 개를 생성·저장했습니다. 기존 프로젝트 2개는 내용이 정확히 일치한 채 보존됐고 저장소는 2→4개가 됐습니다. 프로젝트마다 자료 1개·장면 3개와 출처를 보존했습니다. API 키·키체인·OAuth 값을 읽지 않았고 임시 진단 소스는 삭제했습니다.
- 실제 FFmpeg·시스템 한국어 글꼴로 쇼츠 720×1280, 가로 1280×720 MP4 출력을 완료했습니다. FFprobe에서 두 영상의 H.264·24fps·AAC 스트림과 약 28.02초 길이를 확인했습니다. 음성을 생성하지 않은 검증이므로 AAC 스트림은 무음이며 실제 TTS 생성 성공을 의미하지 않습니다. 생성한 MP4와 프로젝트는 사용자의 로컬 작업실에 보존했습니다.
- 소재 전달·새 프로젝트 저장·장면 편집 후 렌더 IPC·미저장 프로젝트 보호·취소와 재시도·AI 실패 시 로컬 표시·초기 목록의 늦은 응답 보호 등 합성 UI 검사 18개를 통과했습니다. 1280·820px 화면의 가로 넘침이 없었고 원문 HTML은 텍스트로 표시됐습니다. 실제 DB·제공자 요청은 fixture에서 사용하지 않았습니다. TypeScript와 Vite production 빌드를 통과했습니다.
- 가져온 프로젝트의 잘못된 `research` 정보에 대한 합성 화면 검사 4개에서 편집·저장 및 기존 프로젝트 필드 보존을 확인했습니다. 추가 코드 검토에서 프로토타입 이름을 출처로 가져오면 React 화면이 중단되는 문제를 발견해 세 가지 지원 출처만 허용하도록 수정했습니다. 최신 실제 함수를 TypeScript AST로 읽어 검증한 Node·React SSR 회귀 7개에서 잘못된 값 거부와 지원 출처 허용·알 수 없는 기존 필드 보존을 확인했습니다. 추가 SSR 검사는 브라우저 화면 검증으로 해석하지 않습니다.
- 최소 macOS 12.0 설정을 유지하며 출처 guard는 `Object.prototype.hasOwnProperty.call`을 사용했습니다. [`Object.hasOwn`이 Safari 15.4부터 추가된 공식 변경 기록](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)을 확인하고, 해당 함수가 없는 런타임 조건에서도 동일한 실제 함수·React SSR 회귀 7개와 TypeScript·Vite 빌드 통과를 확인했습니다. macOS 12.0 기기의 실제 실행 검증은 별도입니다.
- AI 장면 생성이 기존 SNS 대본 지시와 충돌하던 문제를 발견해 Rust 내부 전용 자료 발췌 경로로 분리했습니다. 고정 JSON 장면 지시는 system, 저장된 제목·설명·자료 ID는 user 데이터로 전달하며 기존 제공자 인증·모델 제한·시간 제한·도구 차단·오류 정제 transport를 공유합니다. 모의 HTTP 요청을 캡처해 역할과 JSON 스키마·발췌 한도·긴 정상 설명·자료 내 지시 분리 및 기존 SNS 출력 지시 유지를 확인했습니다. AI 모듈 15개 검사와 기본 기능 컴파일·포맷 검사도 통과했습니다. 실제 구독 계정의 요청 성공 검증은 별도입니다.
- 이 절은 Rust 실제 처리와 합성 화면 검사를 구분합니다. 새 버전의 공개 배포·네이티브 설치 화면·Windows 기기 실행은 확인 후 별도로 기록합니다.
