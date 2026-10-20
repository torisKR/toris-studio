# 브라우저 전환 검증 기록 (2026-10-20)

개발 브랜치 `feat/playwright-browser`의 검증 기록입니다. 공개 릴리스·설치 앱 교체·실제 SNS 계정 로그인은 실행하지 않았습니다. 로컬 검증 후 사용자가 별도 브랜치 push와 원격 CI 실행을 승인했습니다.

## 완료한 회귀 검증

- 웹 TypeScript 검사와 Next 프로덕션 빌드 통과.
- Node 24.16.0에서 기존 웹 테스트 214개: 213 통과, DB 환경 의존 1개 건너뜀.
- OAuth Rust 테스트 27 통과, 명시적 실제 계정 검증 1개 건너뜀. state·PKCE·만료·재시도·일회용 콜백·토큰 저장/갱신·비밀정보 비노출 회귀 포함.
- OAuth 콜백 Worker 계약 13개 통과.
- 릴리스 자산/게시 계약 12개 및 릴리스 서명 검증기 2개 통과. 릴리스 자산 테스트의 게시 로그는 mock 응답이며 실제 게시를 수행하지 않았습니다.
- 새 브라우저 설정 UI와 기존 desktop interactions·integration·AI workspace UI 검증 통과. UI의 native IPC는 fixture이며 실제 OAuth 로그인 성공을 뜻하지 않습니다.
- 변경 파일의 redacted gitleaks 검사 통과. 저장소 전체 `pnpm security:check`는 기존 미추적 `campaigns/2026-10-15-developer-proof/.bundle/39.bundle.js:101094`의 Algolia 패턴 탐지 1건으로 실패했습니다. 키 유효성을 조회하거나 기존 폴더를 수정하지 않았습니다.

## 보존

미추적 `campaigns/`·`pocket-circuit/`, 기존 앱 설정·계정·토큰·Opal DB 마이그레이션과 이력은 보존했습니다. 휴면 Aside 실행 소스 `opal.rs`만 제거했습니다. 설치된 `/Applications/Toris Studio.app`은 교체하지 않았습니다.

## 브라우저 동작 검증

- Rust 전체 no-default-features 회귀: 311 통과, 13 ignored. 기본 desktop feature의 lib/IPC ACL 검사: 288 통과, 12 ignored. Mac 경로 분리 후 브라우저 집중 검사 27 통과, 실제 브라우저용 1개 ignored.
- opt-in Rust → 실제 Node 24 → Playwright → headed Chrome 연결 검사 통과: 로컬 페이지, 작업자 재사용, OAuth 리디렉션의 native 전달, 계속 실행 가능 상태, 종료 확인. 격리된 임시 프로필을 사용했습니다.
- Node 브라우저 테스트 13개 통과 (실제 headed fixture 포함). 초기 OAuth, 직접/리디렉션 팝업, 두 단계 302와 인코딩된 인증 경로, POST 인증 폼에서 인증 서버의 Playwright 요청 0회를 확인했습니다. 전달 성공 응답·중복 억제·프로필 재사용·브라우저 실제 버전·종료를 검사했습니다. 연결 실패 페이지를 연 뒤에도 기존 탭의 heartbeat·동일 브라우저 PID·후속 링크 열기가 유지되는 회귀를 추가했습니다.
- 독립 리뷰에서 종료 잠금, 시작 취소, 오래된 실행 기록 복구, 브라우저 하위 프로세스 종료, 인증 전달 성공 응답, CI 아키텍처를 수정 후 확인했습니다.
- 실제 Tauri Mac 서명 검증에서 Helpers의 JavaScript 데이터 배치 문제를 확인했습니다. Node/Chrome만 Helpers에, 작업자/Playwright/라이선스는 Resources에 두도록 수정했습니다. 분리된 임시 앱의 구성요소 서명과 실제 브라우저 fixture가 통과했습니다.

## 설치 산출물

아래 파일은 공개 배포하지 않은 0.1.24 프리뷰입니다. 세 설치 파일 모두 512 MiB 미만이며 재추출 검증을 통과했습니다.

| 플랫폼 | 설치 파일 | 크기 | 재추출 검증 |
| --- | --- | ---: | --- |
| macOS Apple Silicon | [DMG](../desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Toris%20Studio_0.1.24_aarch64.dmg) | 244.80 MiB (256,691,336 bytes) | 최상위 앱 deep/strict 서명, Node/PW/Chrome 버전·라이선스·아키텍처·상대 링크, 실제 headed 브라우저 통과 |
| macOS Intel | [DMG](../desktop/src-tauri/target/cross-x64/x86_64-apple-darwin/release/bundle/dmg/Toris%20Studio_0.1.24_x64.dmg) | 261.89 MiB (274,607,184 bytes) | 서명·버전·라이선스·x64 아키텍처·상대 링크 정적 검사 통과, 실행 미검증 |
| Windows x64 | [NSIS](../desktop/src-tauri/target/cross-windows/x86_64-pc-windows-msvc/release/bundle/nsis/Toris%20Studio_0.1.24_x64-setup.exe) | 192.89 MiB (202,260,178 bytes) | 재추출·버전·라이선스·작업자 소스 일치·앱과 런타임 18개 PE의 x64 검사 통과, 실행 미검증 |

SHA256:

```text
aarch64-apple-darwin  a4b1aba743b5376823f5de17dfe33a2c8e8f6d90cb5a678f4de44c8f480adf50
x86_64-apple-darwin   6d7978cd013403c18baae28d10f815c1d5d258ca2653440a3af94de5fb5c54c1
x86_64-windows-msvc   06bb83ce3b0700f39355b28e8f92c067e12b1b8f57461ff53114184e9cf1f803
```

두 Mac 앱은 ad-hoc 서명이며 Developer ID 공증은 하지 않았습니다. Windows 앱·설치 파일에는 Authenticode 서명이 없습니다. 두 Mac 앱의 최소 OS 메타데이터는 12.0이고, Studio 본체에는 JIT 권한이 없습니다. Node/Chrome에만 필요한 권한을 부여했습니다.

Apple Silicon DMG를 읽기 전용으로 마운트하고 앱을 임시 폴더로 복사한 뒤, 재추출된 Node 24.16.0·PW 1.63.0·Chrome 153.0.8010.12로 headed fixture를 실행했습니다 (통과). Intel·Windows는 로컬 장비가 없어 정적 검증만 수행했습니다. 해당 플랫폼 네이티브 실행은 완료되지 않았습니다. CI는 Intel 전용 macos-15-intel 및 Windows runner에서 설치 파일 재추출과 실제 fixture를 실행하도록 구성했으며, 이 작업에서 원격 CI를 실행하지 않았습니다.

최종 Mac 경로 분리는 브라우저 바깥의 보조 JSON/ABOUT 데이터까지 Resources로 옮겨 최상위 앱 서명을 통과했습니다. 앱 본체는 최종 소스로 빌드했고 마지막 번들은 공식 `tauri bundle` 명령과 동일한 검증된 overlay로 생성했습니다.

재현 명령:

```sh
node scripts/prepare-browser-installer.mjs aarch64-apple-darwin desktop/src-tauri/target/aarch64-apple-darwin/release/bundle
node scripts/prepare-browser-installer.mjs x86_64-apple-darwin desktop/src-tauri/target/cross-x64/x86_64-apple-darwin/release/bundle --static-only
node scripts/prepare-browser-installer.mjs x86_64-pc-windows-msvc desktop/src-tauri/target/cross-windows/x86_64-pc-windows-msvc/release/bundle --static-only
```

최초 로컬 검증에서는 실제 SNS 제공자 로그인·프로덕션 DB 테스트, Intel Mac·Windows 네이티브 실행, 공증·Authenticode·서명된 업데이트 피드와 공개 릴리스를 검증/실행하지 않았습니다. 설치된 앱을 교체하지 않았습니다. 후속 원격 CI 결과는 확인 후 이 문서에 기록합니다.

## 원격 CI 진행 기록

사용자 승인 후 `daf7fb4`를 별도 브랜치로 push하고 [데스크톱 CI](https://github.com/torisKR/toris-studio/actions/runs/39433344096)를 실행했습니다. 보안·의존성·API/OAuth·패키징 계약과 격리 PostgreSQL/게시 UI 회귀가 통과했습니다.

첫 Windows 네이티브 실행에서 브라우저 테스트 3개가 실패했습니다. 테스트가 Mac의 확인 불가 종료 상태를 Windows에도 요구한 것이 원인이었습니다. Windows는 작업자 실행 전에 할당한 Job Object에서 자식 프로세스 수가 0인지 확인하므로, 이 경우 idle 복귀와 소유 기록 삭제가 올바릅니다. 테스트의 OS별 기대값을 수정하고, PID를 보고하지 않은 자식 프로세스의 실제 종료·소유 기록 삭제를 검증하는 Windows 회귀를 추가했습니다. 실행 로직과 확인 불가 시 재실행을 차단하는 조건은 변경하지 않았습니다. 수정 후 네이티브 CI 결과는 후속 기록합니다.
