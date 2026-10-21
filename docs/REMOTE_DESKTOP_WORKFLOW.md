# ChatGPT · Remote Desktop Commander

데스크톱의 문구·영상·이미지·모션 제작은 Remote Desktop Commander(RDC)를 사용합니다. 앱의 코딩 화면, 내장 코딩 실행기, Codexify 브리지·프록시·번들·연결 설정은 제거했습니다. 별도 모델 API나 API 키 설정은 추가하지 않습니다. 이전 사용자 설정·프로젝트·외부 도구의 개인 파일은 보존합니다.

## 요청과 검토

1. **제작** 또는 **게시**에서 자료와 요청을 작성합니다.
2. 앱이 보여주는 RDC 전달문을 실제 ChatGPT 대화에 붙여넣습니다. 전달문에는 현재 실행 중인 Studio의 실행 파일과 `--studio-mcp` 인자가 포함됩니다.
3. RDC가 해당 실행 파일을 stdio MCP로 시작하고 `initialize`, `tools/list`로 도구를 확인합니다. `studio_connection_check`로 연결을 확인할 수 있습니다.
4. ChatGPT가 요청을 조회하고 수신 도구로 변경 초안을 반환합니다. 앱은 요청 저장, 실제 조회, 초안 수신을 구분해 표시합니다.
5. 사용자가 초안을 검토하고 적용·저장합니다. 게시에는 별도의 명시적 승인이 필요합니다.

문구·일반 영상은 `studio_creation_request_get` / `studio_creation_draft_receive`, SNS 게시 문구는 `studio_publication_request_get` / `studio_publication_draft_receive`, 모션은 `studio_motion_request_get` / `studio_motion_draft_receive`를 사용합니다. 이미지·파일은 기존 `studio_asset_request` / `studio_asset_receive` 계약을 사용합니다. 실제 노출된 도구의 스키마를 확인하세요.

요청 ID와 revision이 일치해야 하며, 요청 조회 없이 결과를 수신했다고 표시하지 않습니다. 취소·오래된 요청·다른 내용의 중복 결과는 거부합니다. 편집 후 도착한 초안은 다시 검토하거나 현재 내용을 기준으로 요청해야 합니다. 요청 저장·복사는 생성 완료가 아닙니다.

## 연결 경계

RDC를 사용할 수 없으면 요청이 저장된 상태로 남습니다. 전달문을 실제 대화에서 실행하거나 결과 붙여넣기·파일 가져오기를 사용할 수 있습니다. 앱은 종료된 ChatGPT 대화를 자동으로 재개하지 않습니다.

RDC가 제어하는 기기에서 전달문의 실행 파일이 존재해야 합니다. 설치된 이전 앱과 개발용 앱을 혼동하지 않도록 현재 앱이 제공한 경로를 사용하세요. Studio는 브라우저 인증 정보를 읽거나 ChatGPT 비공개 API를 호출하지 않습니다.

기존 계정·로컬 DB·프로젝트는 유지합니다. SNS OAuth는 시스템 기본 브라우저에서 별도로 진행하며 RDC 연결 자체가 SNS 권한을 부여하지 않습니다.
