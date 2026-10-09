# Open WebUI에서 ChatGPT 전용 연결로 전환

Toris Studio 0.1.21부터 Open WebUI 화면, 컨테이너 실행기, 모델 어댑터를 제거합니다. 코딩·AI 작업실·SNS 문구·이미지 작성은 실제 ChatGPT 대화＋Codexify 경로를 사용합니다. ChatGPT에서 연결된 대화를 직접 시작·재개해야 하며 ChatGPT 자체 사용 한도가 적용됩니다.

이전 0.1.20 앱이 생성한 `toris-studio-open-webui` 컨테이너는 중지하며 `toris-studio-open-webui-data` 볼륨의 계정·설정·대화 데이터는 삭제하지 않습니다. 다른 컨테이너, 기존 ChatGPT 대화, 기존 OAuth·수집 API 키는 유지합니다. 이전 로컬 AI 설정은 보존하지만 데스크톱 AI 요청에 사용하지 않습니다.

**코딩**에서 Codexify를 확인하고 ChatGPT 대화를 열어 연결 시작 안내를 실행하세요. 요청 저장은 ChatGPT 턴 시작이나 생성 완료가 아닙니다. 저장·전달·읽음·실제 응답과 파일 수신을 각각 확인합니다. 자세한 사용 방법은 [Codexify 기반 AI 작업실](CODEXIFY_WORKFLOW.md)을 참고하세요.
