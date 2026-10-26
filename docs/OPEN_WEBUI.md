# Open WebUI에서 ChatGPT 전용 연결로 전환

Toris Studio 0.1.21부터 Open WebUI 화면, 컨테이너 실행기, 모델 어댑터를 제거했습니다. 현재 AI 기능은 Agent 탭의 모델 설정을 사용합니다.

이전 0.1.20 앱이 생성한 `toris-studio-open-webui` 컨테이너는 중지하며 `toris-studio-open-webui-data` 볼륨의 계정·설정·대화 데이터는 삭제하지 않습니다. 다른 컨테이너, 기존 ChatGPT 대화, 기존 OAuth·수집 API 키는 유지합니다. 이전 로컬 AI 설정은 보존하지만 데스크톱 AI 요청에 사용하지 않습니다.

모델 선택과 사용 방법은 [Agent 안내](AGENT.md)를 참고하세요.
