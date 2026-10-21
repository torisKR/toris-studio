# Open WebUI에서 ChatGPT 전용 연결로 전환

Toris Studio 0.1.21부터 Open WebUI 화면, 컨테이너 실행기, 모델 어댑터를 제거합니다. 문구·영상·모션·이미지 작성은 실제 ChatGPT 대화＋Remote Desktop Commander 경로를 사용합니다. ChatGPT에서 연결된 대화를 직접 시작·재개해야 하며 ChatGPT 자체 사용 한도가 적용됩니다.

이전 0.1.20 앱이 생성한 `toris-studio-open-webui` 컨테이너는 중지하며 `toris-studio-open-webui-data` 볼륨의 계정·설정·대화 데이터는 삭제하지 않습니다. 다른 컨테이너, 기존 ChatGPT 대화, 기존 OAuth·수집 API 키는 유지합니다. 이전 로컬 AI 설정은 보존하지만 데스크톱 AI 요청에 사용하지 않습니다.

**제작**에서 요청을 저장하고 Remote Desktop Commander 전달문을 실제 ChatGPT 대화에 붙여넣으세요. 요청 저장은 ChatGPT 턴 시작이나 생성 완료가 아닙니다. 저장·전달·읽음·실제 응답과 파일 수신을 각각 확인합니다. 자세한 사용 방법은 [Remote Desktop Commander 연결](REMOTE_DESKTOP_WORKFLOW.md)을 참고하세요.
