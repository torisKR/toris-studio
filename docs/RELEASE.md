# Toris Studio 데스크톱 빌드·배포

일반 사용자는 [다운로드 페이지](https://toriskr.github.io/toris-studio/) 또는 [최신 GitHub Release](https://github.com/torisKR/toris-studio/releases/latest)에서 설치 파일을 받습니다. 앱의 **업데이트 확인**은 같은 Release의 `latest.json`을 읽고 Rust의 Tauri updater가 서명을 검증한 다음 설치합니다. GitHub Packages에는 동일한 파일 묶음을 OCI artifact로 보관합니다.

| 대상 | 사용자 설치 파일 | 자동 업데이트 파일 |
| --- | --- | --- |
| Mac Apple Silicon | `Toris-Studio-macOS-arm64.dmg` | `Toris-Studio-macOS-arm64.app.tar.gz` + `.sig` |
| Mac Intel | `Toris-Studio-macOS-x64.dmg` | `Toris-Studio-macOS-x64.app.tar.gz` + `.sig` |
| Windows 64비트 | `Toris-Studio-Windows-x64-setup.exe` | 같은 `.exe` + `.sig` |

다운로드 버튼은 `/releases/latest/download/<파일명>`을 사용하므로 새 버전이 나와도 링크를 바꿀 필요가 없습니다. 설치 파일, 서명, `SHA256SUMS`, 소스 commit이 적힌 `release-manifest.json`을 함께 제공합니다. Windows ARM은 현재 지원 목록에 없습니다.

## 워크플로

배포와 PR 모두 공식 Gitleaks 8.30.1의 고정 SHA256을 확인한 뒤 Git 이력의 자격 증명을 검사합니다. 발견 결과는 redact하며 검사가 실패하면 빌드·배포를 중단합니다.

- `desktop.yml`: main과 PR의 UI·Rust·배포 도구 검사 후 세 플랫폼의 미리보기 설치 파일을 Actions artifact에 저장합니다. PR에는 배포 키와 쓰기 권한이 전달되지 않습니다.
- `desktop-release.yml`: `v0.1.10` 같은 stable version tag 또는 main에서 `workflow_dispatch`로 실행합니다. Tauri/Cargo/desktop package 버전이 모두 같아야 하며 서명 키가 없으면 배포 전에 실패합니다.
- `release-downloads.yml`: `docs/download/`를 GitHub Pages로 배포합니다. 저장소 **Settings → Pages → Source → GitHub Actions**를 처음 한 번 설정해야 합니다.

배포는 검사 → Mac arm64/Intel 및 Windows x64 빌드 → Rust 서명·버전·SHA256 검증 → 완성된 draft Release와 GitHub Package 업로드 → 공개 전환 → 실제 공개 다운로드 확인 순서입니다. 세 빌드 중 하나라도 실패하면 Release를 공개하지 않습니다. 공개 후 다운로드 검증이 실패하면 해당 Release를 prerelease로 바꿔 stable 최신 다운로드 대상에서 제외하고 기존 배포는 보존합니다. 작업 실패는 GitHub Actions 상태와 run summary에서 확인합니다. GitHub의 워크플로 실패 알림을 켜면 계정 알림도 받을 수 있습니다.

publish job은 태그 push·수동 실행·다른 버전 사이에서도 하나의 저장소 concurrency 그룹으로 직렬 실행합니다. REST의 tag 조회는 draft를 반환하지 않으므로 기존 draft는 인증된 release 목록에서 찾고, 새 draft는 생성 API 응답에서 numeric release ID를 바로 고정합니다. 생성 직후 목록 반영 지연에 의존하지 않으며 ID·태그·소스 commit 검증은 유지합니다. 업로드 완전성 확인과 공개 전환, 실패 시 prerelease 전환은 같은 ID로 처리하며 다른 공개 버전을 변경하지 않습니다.

실행 도중 만들어진 draft는 같은 source commit으로 재시도할 수 있습니다. 이미 같은 Package 버전이 있다면 source와 모든 파일 bytes가 같아야 하며, 다르면 새 버전을 사용합니다. 공개된 버전의 파일은 다시 덮어쓰지 않으며 변경하려면 버전을 올려야 합니다. Actions는 SHA로 고정했고 Rust 1.96.0, Node 24, frozen pnpm/Cargo lockfile을 사용합니다. publish 작업에만 `contents: write`, `packages: write`를 허용합니다. `pull_request_target`, 외부 PR에서 비밀 사용, 개인 API 키를 넣은 빌드는 사용하지 않습니다.

## 서명 키 설정

반드시 유지할 GitHub Actions repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: Tauri signer로 만든 private key 전체 내용. GitHub Actions secret 입력 또는 안전한 stdin으로 설정합니다.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: 키 생성 때 지정한 비밀번호. 빈 비밀번호로 생성한 키라면 생략할 수 있습니다.

대응하는 **public key**만 `desktop/src-tauri/tauri.conf.json → plugins.updater.pubkey`에 저장합니다. `bundle.createUpdaterArtifacts: true`와 `plugins.updater.requireSignedVersion: true`를 유지합니다. Rust 배포 검증기는 설치 파일의 minisign 서명과 인증된 trusted comment의 버전까지 확인합니다. Private key, 비밀번호, SNS/API 키, 로컬 DB 설정과 사용자 데이터는 installer나 OCI artifact에 넣지 않습니다.

private key를 잃거나 바꾸면 이미 설치된 앱이 새 업데이트를 검증할 수 없습니다. 저장소 밖의 안전한 위치에 별도 백업하고 Actions secrets를 설치자와 함께 유지해야 합니다. 새 공개 버전마다 키를 만들지 않습니다.

### macOS 설치·키체인 승인

Tauri 업데이트 서명과 Apple 코드 서명은 별개입니다. Apple 인증서가 없는 현재 빌드는 `APPLE_SIGNING_IDENTITY: '-'`로 ad-hoc 서명하며 서명 구조는 `codesign --verify --deep --strict`로 검사합니다. 이 경우 첫 실행에 macOS 보안 허용이 필요할 수 있고, 빌드 교체 뒤 키체인 승인이 유지되는 보장에는 동일 Developer ID 코드 서명이 필요합니다. 같은 설치본을 다시 열 때의 키체인 반복 접근 문제와 배포 서명 변경에 따른 시스템 승인은 구분해야 합니다.

Developer ID를 준비하면 Actions secrets에 다음 값을 설정합니다. CI의 기존 Tauri build 단계가 인증서를 가져와 같은 identity로 서명하고 notarization을 실행합니다.

- `APPLE_CERTIFICATE`: Developer ID Application `.p12`의 base64 내용
- `APPLE_CERTIFICATE_PASSWORD`: `.p12` 비밀번호
- `APPLE_SIGNING_IDENTITY`: 인증서 identity 전체 문자열
- `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`: notarization용 Apple ID, **앱 전용 비밀번호**, Team ID

사용자가 다운로드한 Mac 설치 파일을 보안 우회 명령으로 실행하도록 안내하지 않습니다. Apple 인증서와 notarization을 설정하기 전에는 Apple 공인 배포 또는 Gatekeeper 승인 생략을 주장하지 않습니다.

### Windows 설치 승인

Windows NSIS 설치 파일도 자동 업데이트용 Tauri minisign 서명을 갖습니다. Windows Authenticode/SmartScreen 서명은 별도 인증서와 signing 서비스 설정이 필요하며 현재 워크플로에는 포함되지 않습니다. 인증서가 없는 설치 파일에는 Windows 확인 화면이 표시될 수 있습니다.

## GitHub Packages

OCI artifact 이름은 `ghcr.io/toriskr/toris-studio/desktop:<버전>`입니다. `org.opencontainers.image.source`, version, revision annotation으로 저장소와 소스 commit을 연결합니다. publish 작업의 `GITHUB_TOKEN`으로 로그인하고 별도 PAT를 앱에 포함하지 않습니다.

GitHub는 새 container package의 visibility를 기본 **Private**으로 만듭니다. 첫 업로드 뒤 계정의 **Packages → toris-studio/desktop → Package settings → Change visibility → Public**을 한 번 설정하면 일반 사용자는 토큰 없이 OCI artifact를 내려받을 수 있습니다. Public 저장소라는 사실만으로 Packages가 공개되었다고 가정하지 않습니다. 일반 사용자의 설치 파일 다운로드와 앱 업데이트는 항상 public GitHub Release URL을 사용합니다.

개발·보관용 ORAS 명령:

```sh
oras pull ghcr.io/toriskr/toris-studio/desktop:0.1.10 --output ./toris-studio-0.1.10
```

Public 설정 전에는 읽기 권한이 있는 registry 인증이 필요합니다. 버전별 OCI artifact가 모두 세 OS/아키텍처의 설치 파일, updater 파일, 서명, feed 및 검증 manifest를 포함하므로 `docker run`으로 실행하는 컨테이너 이미지가 아닙니다.

## 로컬 검증

```sh
actionlint .github/workflows/desktop.yml .github/workflows/desktop-release.yml .github/workflows/release-downloads.yml
node --test scripts/release-assets.test.mjs
cargo test --locked --manifest-path scripts/release-verify/Cargo.toml
```

빌드 결과 검증은 `cargo run --locked --manifest-path scripts/release-verify/Cargo.toml -- <release-assets> desktop/src-tauri/tauri.conf.json <버전> <40자리 commit>`을 사용합니다. 이 검사는 세 타깃이 모두 있어야 성공합니다. 로컬 Mac 빌드만으로 Windows installer나 공개 배포 성공을 대신 확인하지 않습니다.

공식 기준: [Tauri updater](https://v2.tauri.app/plugin/updater/), [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), [GitHub Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [ORAS remote registry](https://oras.land/docs/1.2/how_to_guides/remote_registries/).

## ORAS 설치 호환성

ORAS CLI 1.3.4는 공식 stable release이지만, 고정한 `setup-oras` action commit의 내장 release catalog는 1.3.0까지만 포함합니다. 배포 워크플로는 action SHA를 유지하면서 공식 Linux amd64 asset URL과 SHA256 `f27adb935022d94df8dc77719c322dda592c78a0d57a6f7dcdd8d900b248c454`를 명시합니다. 해당 action의 공식 `url`/`checksum` 입력은 catalog 조회 대신 다운로드한 archive의 SHA256을 확인합니다. 버전을 지정하는 것만으로 실제 action의 catalog 호환성이 확인되었다고 가정하지 않습니다.

`v0.1.9`는 세 플랫폼 빌드와 통합 서명 검증에 성공했으나 ORAS catalog 조회 단계에서 게시 전에 실패했습니다. 실패 기록과 태그는 유지하며, 다음 UI 배포와 설치 호환성 수정은 `v0.1.10`에서 진행합니다. 아직 공개되지 않은 버전의 installer 또는 Package를 다운로드 가능하다고 안내하지 않습니다.

검증 근거: [ORAS 1.3.4 공식 release](https://github.com/oras-project/oras/releases/tag/v1.3.4), [고정 action의 지원 catalog](https://github.com/oras-project/setup-oras/blob/22ce207df3b08e061f537244349aac6ae1d214f6/src/lib/data/releases.json), [URL·checksum 입력 처리](https://github.com/oras-project/setup-oras/blob/22ce207df3b08e061f537244349aac6ae1d214f6/src/lib/release.ts).
