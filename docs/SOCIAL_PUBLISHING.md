# SNS 일괄 게시 · 0.1.21

실제 게시 순서는 **MP4·썸네일 가져오기 → 공통 문구 작성 → 게시 채널 선택 → 채널별 수정·미리보기 → 사전 검사 → 승인·즉시 전송 또는 예약 → 결과 확인**입니다. 새 일괄 게시 대상은 YouTube, Instagram 전문 계정, Facebook Page, Threads, TikTok입니다. X와 네이버는 포함하지 않으며 기존 네이버 수집·채널·로그인 데이터는 유지합니다.

## ChatGPT 초안과 에셋

코딩에서 실제 ChatGPT 대화와 Codexify를 연결하고 대화를 직접 시작하세요. 앱은 연결된 대화에 초안 요청 ID와 주제를 전달합니다. ChatGPT는 `studio_publication_draft_receive`로 제목·설명·태그·해시태그를 반환합니다. 수신된 초안은 적용·편집·저장할 수 있으며 자동 승인되지 않습니다. 이미지 생성은 기존 `studio_asset_request` / `studio_asset_receive` 경로로 요청·수신하고 게시 썸네일 선택에 사용합니다.

전달 저장, ChatGPT의 요청 수신, 답변, 파일 수신은 별도 상태입니다. 메시지 저장만으로 모델이 실행됐다고 표시하지 않습니다. 대화가 쉬고 있거나 연결이 끊겼으면 실제 ChatGPT에서 대화를 재개해야 합니다. ChatGPT 사용 한도는 그대로 적용됩니다. Open WebUI와 직접 모델 API·CLI 호출은 데스크톱에서 제거했습니다. 이전 앱 소유 컨테이너는 중지하고 대화 데이터 볼륨은 보존합니다.

## 게시 권한과 필드

| 플랫폼 | 전송 경로와 결과 | 필드 적용 |
| --- | --- | --- |
| YouTube | OAuth `youtube.upload`, resumable 업로드, 원격 영상 처리·조회 | 제목·설명·태그·해시태그·썸네일. 수집 API 키는 게시 권한이 아닙니다. 실제 응답의 공개 범위를 결과에 표시합니다. |
| Instagram | 전문 계정 권한, Reel 컨테이너·파일 업로드·상태 조회·게시 | 제목·설명·해시태그를 캡션으로 적용. 별도 태그는 미지원. 커버 URL 또는 영상 프레임. |
| Facebook | 관리 가능한 Page 선택, Reel 시작·파일 전송·게시·조회 | 제목·설명·해시태그. 별도 Video 썸네일 API 실패는 영상 게시 결과와 따로 표시합니다. |
| Threads | 영상 컨테이너·처리 조회·게시 | 제목·본문·해시태그. 별도 태그·썸네일 미지원. 승인 영상 URL을 임시 Cloudflare 터널로 제공합니다. |
| TikTok | Direct Post 또는 받은 편지함 초안, 청크 파일 업로드·상태 조회 | Direct는 캡션·공개 범위·댓글·Duet·Stitch·상업 표시·음악/게시 동의·커버 프레임. 초안은 영상만 전달하고 TikTok에서 문구·설정을 최종 확인합니다. |

TikTok 공개 Direct·예약은 개발자 설정의 심사 승인 선언, `video.publish`, 최신 creator 정보와 실제 API 허용을 모두 확인합니다. 선언만으로 API 심사를 통과했다고 표시하지 않습니다. 미심사 앱은 API가 허용하는 비공개 Direct 또는 초안 전송만 사용할 수 있습니다. 내부·개인용 도구의 공개 Direct 심사는 보장하지 않습니다. 공개 범위는 사용자가 직접 선택하며 최신 계정에서 비활성화한 댓글·Duet·Stitch는 활성화할 수 없습니다. 초안 전송의 최종 상태는 **초안 전송 완료**이며 **게시 완료**로 표시하지 않습니다.

## 승인과 예약 복구

PostgreSQL `publications`의 수정 버전과 채널별 문구·계정·방식, `publication_jobs`의 승인 파일 SHA256·실행 결과를 영구 저장합니다. 가져온 파일은 앱 전용 폴더에 복사하고 사용 시 해시를 재검증합니다. 초안을 수정하면 이전 예약 승인은 취소되며 새 사전 검사·승인이 필요합니다. 기존 일정 기록은 편집 가능한 미승인 초안으로 이행하고 실행 작업을 생성하지 않습니다.

채널별 결과는 **대기 / 예약 / 전송 / 처리 중 / 게시 완료 / 초안 전송 완료 / 결과 불명확 / 재확인 필요 / 실패 / 취소**로 구분합니다. 성공한 채널은 다시 전송하지 않습니다. 네트워크 단절 등으로 결과가 불명확하면 새 업로드를 만들지 않고 기존 원격 ID로 조회합니다. 원격 ID 자체가 없으면 해당 SNS에서 사용자가 직접 게시 여부를 확인한 뒤 결과를 기록하거나 미게시로 확인하고 다시 승인합니다. 확인만으로 재게시하지 않습니다.

앱 창을 닫으면 프로세스는 메뉴 막대·트레이에 남습니다. **열기 / 예약 일시정지 / 재개 / 완전히 종료**를 제공합니다. 게시 전송·원격 미디어 처리 중에는 종료와 업데이트를 보류합니다. 완전 종료·절전으로 놓친 예약은 자동으로 밀어 올리지 않고 재승인을 요구합니다. PC 전원·인터넷·로컬 PostgreSQL이 실행 중이어야 예약이 실행됩니다.

Threads 영상 및 필요한 Instagram 커버는 예측 불가능한 URL의 임시 터널에 승인한 파일만 제공합니다. 디렉터리·MCP·다른 로컬 파일은 노출하지 않습니다. 처리 완료·실패·최대 2시간 만료 시 터널을 폐기합니다. OAuth 토큰·클라이언트 시크릿은 OS 저장소에 유지하고 DB·IPC 결과에는 넣지 않습니다.

## 검증 범위

Rust fixture 테스트로 API 단계, 범위·계정 검증, 업로드·조회, TikTok 초안과 실제 게시 구분, 중복 방지 및 제한을 검사합니다. 별도 임시 PostgreSQL 통합 테스트로 DB 이행·재실행 복구·수정 충돌·실행 claim을 검사합니다. 실제 계정 게시 성공은 사용자 승인 콘텐츠로 API 결과를 확인한 경우에만 주장합니다. 로컬 fixture 통과나 설치 파일 빌드는 실제 SNS 게시 또는 Windows 기기 실행 검증을 대신하지 않습니다.

공식 계약: [Codexify](https://github.com/devnoname120/codexify/blob/main/docs/REFERENCE.md), [YouTube 업로드](https://developers.google.com/youtube/v3/docs/videos/insert), [Meta Reel 샘플](https://github.com/fbsamples/reels_publishing_apis), [Threads API](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api), [TikTok 게시 지침](https://developers.tiktok.com/doc/content-sharing-guidelines).
