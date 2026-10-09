# Open WebUI 로컬 채팅

Toris Studio 0.1.20의 **코딩 → Open WebUI**에서 서버를 시작하고 전용 앱 창을 엽니다. macOS는 OrbStack 또는 Docker Desktop, Windows는 Docker Desktop의 Linux 컨테이너 실행 환경이 필요합니다. Rust가 공식 Open WebUI 0.11.4 slim 이미지를 고정 SHA256으로 실행합니다. 이미지에는 Python 서버와 웹 화면이 포함되며, 앱의 컨테이너 관리와 창 제어는 Rust에서 처리합니다.

## 처음 실행

1. Docker 실행 환경을 켜고 **로컬 채팅 시작**을 누릅니다. 처음에는 공식 이미지를 다운로드합니다.
2. 준비 완료 뒤 **Open WebUI 열기**를 누릅니다.
3. 첫 관리자 계정을 직접 생성합니다. 비밀번호를 채팅이나 저장소에 넣지 않습니다. 로그인 기능을 유지합니다.
4. 관리자 설정의 연결에서 OpenCodex 모델 목록을 확인하고, 외부 도구의 **Toris Codexify**를 확인합니다. 연결은 Streamable HTTP MCP이며 OpenAPI 서버와 다릅니다.
5. 앱의 **코딩 연결 안내 복사**를 눌러 Open WebUI 대화에 붙여넣습니다. Toris Codexify 도구를 선택하고 저장된 프로젝트로 작업을 요청합니다. Open WebUI의 응답과 도구 실행 표시로 작업 내용을 확인합니다.

`127.0.0.1:43180`에서만 서버를 공개합니다. 앱 창에 Open WebUI 원래 이름을 유지하며, 기본 Toris Studio 화면의 Rust 명령 권한을 주지 않습니다. 다른 웹 링크는 시스템 브라우저에서 엽니다.

## 데이터와 연결

전용 컨테이너는 `toris-studio-open-webui`, 전용 볼륨은 `toris-studio-open-webui-data`입니다. 대화·계정·설정과 JWT 서명 키를 볼륨에 저장합니다. **로컬 채팅 종료**는 컨테이너를 중지하며 데이터는 보존합니다. 앱 종료 뒤에도 Open WebUI 서버는 유지합니다. 다른 프로젝트 컨테이너와 호스트 프로젝트 파일을 컨테이너에 마운트하지 않습니다.

새 설치의 OpenAI 호환 연결은 앱에 저장한 OpenCodex의 로컬 `/v1` 주소를 Docker의 `host.docker.internal` 주소로 변환합니다. Codexify는 Rust의 `127.0.0.1:43181/mcp` 연결 계층을 거쳐 저장한 로컬 `/mcp` 주소를 사용합니다. Open WebUI의 사용자·대화·프로젝트마다 별도의 Codexify 세션 식별자를 전달해 다음 턴에서도 프로젝트를 유지합니다. MCP 연결만으로 프로젝트를 변경하지 않으며, 복사한 연결 안내의 `set_project_root` 호출로 초기 프로젝트를 선택합니다. 앱을 다시 열고 Open WebUI 열기를 누르면 연결 계층도 준비합니다. API 키가 있으면 Rust가 임시 비공개 환경 파일로 전달하고 파일을 제거합니다. 키를 화면·명령 인자·진단 결과에 출력하지 않습니다. Docker의 관리자 권한으로 컨테이너 환경을 조회하면 설정된 키를 볼 수 있으므로 Docker 접근 권한도 계정 권한으로 취급합니다.

기존 Open WebUI 볼륨에 저장된 관리자 설정은 초기 환경 변수보다 우선합니다. 앱 설정을 변경했다고 기존 Open WebUI 연결이 자동 갱신되는 것으로 표시하지 않습니다. 기존 볼륨의 연결은 Open WebUI 관리자 화면에서 확인·수정합니다.

로컬 서버 응답, 모델 주소 응답, MCP 도구 목록 검사와 실제 모델 실행은 각각 다른 증거입니다. Open WebUI의 대화는 기존 ChatGPT의 Codexify 대화 ID로 연결하지 않습니다. ChatGPT 연결과 작업 전달 기록은 코딩 화면의 기존 ChatGPT 영역에서 확인합니다. 네이티브 MCP는 공식 Open WebUI 관리자 도구 기능을 사용합니다.

공식 자료: [저장소](https://github.com/open-webui/open-webui), [Docker 설치 안내](https://docs.openwebui.com/getting-started/quick-start/), [MCP 안내](https://docs.openwebui.com/features/extensibility/mcp/), [0.11.4 릴리스](https://github.com/open-webui/open-webui/releases/tag/v0.11.4).
