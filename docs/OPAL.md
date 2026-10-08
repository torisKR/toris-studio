# Google Labs Opal 탐색

Toris Studio의 Rust 데스크톱 앱에서 주제를 입력하면 로컬 Aside CLI가 등록된 비공개 Opal 워크플로우를 한 번 실행합니다. Rust가 실제 JSON 결과의 형식과 공개 출처 주소를 검증한 뒤 로컬 PostgreSQL에 저장합니다. Google의 Opal 엔진은 Google 서버에서 실행되며, 이 연결은 공개되지 않은 API나 로컬 Opal 서버를 가정하지 않습니다.

## 설정과 사용

1. Aside에서 Google에 로그인하고 비공개 Opal 워크플로우를 만듭니다. `topic`, `region`, `lookbackDays` 입력과 아래 JSON 출력 계약을 설정합니다. 공개 공유는 필요하지 않습니다.
2. 앱의 `Opal 탐색`에서 실제 워크플로우 HTTPS 주소를 저장합니다. 허용 호스트는 `opal.google.com`, `opal.withgoogle.com`, `opal.google`입니다. `app=drive:/...` 워크플로우 주소를 지원합니다.
3. Aside 계정은 기본 `u0`입니다. 다른 등록 계정은 `u1`~`u99`로 지정합니다. 기본 CLI 경로는 사용자 홈의 `.local/bin/aside`이며 Windows에서는 `.local/bin/aside.exe`입니다. 다른 설치 위치는 `aside` 또는 `aside.exe`로 끝나는 절대 경로를 지정합니다.
4. 연결 설정에서 로컬 DB를 시작·갱신합니다. `004_opal_research.sql`이 탐색 결과 테이블을 만들고, `005_opal_result_shape.sql`이 기존 테이블에도 결과 형식 제약을 추가합니다. 기존 채널·콘텐츠·탐색 행을 삭제하지 않습니다. 주제는 1~200자이며 한국의 최근 7일을 탐색합니다.
5. 결과에는 요약, 추천 키워드와 이유, SNS 플랫폼, 실제 공개 출처가 표시됩니다. 재실행 전 이전 실행이 끝나야 하며 결과 이력은 최근 30개를 조회합니다.

로그인, CAPTCHA, 이용약관 또는 추가 권한 동의가 필요한 경우 자동 실행을 중단합니다. Aside에서 사용자가 해당 상태를 확인한 뒤 다시 실행할 수 있습니다. 앱은 브라우저 세션이나 쿠키를 가져오지 않습니다. 기존 YouTube·네이버·Instagram OAuth 설정과 수집 API 키도 이 연결에 전달하지 않습니다.

`Opal에서 열기`는 설치된 Aside 앱에서 엽니다. SNS 로그인에도 `Aside로 로그인`을 선택할 수 있으며, 운영체제의 기본 브라우저 설정을 변경하지 않습니다. Windows에서는 등록된 `Aside.exe`가 필요합니다.

## 워크플로우 출력 계약

실제 실행 출력은 다음 필드만 포함해야 합니다. 키워드는 1~10개이고 각 키워드에 실제 공개 HTTPS 출처 1~3개가 필요합니다. 확인하지 못한 게시 날짜는 `null`로 표시합니다. 조회수, 인기 순위, 게시 날짜와 출처를 만들어 내지 않습니다.

```json
{
  "schemaVersion": 1,
  "topic": "입력한 주제와 정확히 같은 값",
  "region": "KR",
  "lookbackDays": 7,
  "summary": "실제 워크플로우가 탐색한 자료의 요약",
  "keywords": [
    {
      "keyword": "실제 탐색 결과의 키워드",
      "rationale": "이 키워드를 제안한 근거",
      "platforms": ["youtube", "naver_blog"],
      "sources": [
        {
          "title": "실제로 확인한 공개 자료의 제목",
          "url": "https://공개자료의실제주소",
          "publishedAt": null
        }
      ]
    }
  ]
}
```

`platforms` 허용 값은 `youtube`, `threads`, `naver_blog`, `tiktok`, `instagram`입니다. 요약은 최대 3,000자, 키워드는 100자, 이유는 1,600자, 출처 제목은 300자, 주소는 2,048자입니다. Aside는 실제 워크플로우 출력을 읽고 `TORIS_OPAL_RESULT:` 뒤에 JSON을 한 줄로 반환합니다. 원본 CLI 로그는 UI와 DB에 저장하지 않습니다. 잘못된 결과는 저장하지 않습니다.

## Rust IPC와 데이터

| 명령 | 입력 | 반환 |
| --- | --- | --- |
| `get_opal_status` | 없음 | `available`, `cliAvailable`, `workflowUrl`, `account`, `reason`, `runActive` |
| `configure_opal` | `{input:{workflowUrl,asidePath?,account?}}` | 연결 상태. 생략한 경로·계정은 기존 값 유지 |
| `run_opal_research` | `{input:{topic,lookbackDays:7}}` | 검증·저장된 `OpalRun` |
| `get_opal_runs` | 없음 | 최신 `OpalRun[]`, 최대 30개 |

`OpalRun`은 `id`, `topic`, `region`, `lookbackDays`, `generatedAt`, `summary`, `keywords`를 포함합니다. `id`와 저장 시각은 Rust가 생성합니다. 저장된 결과를 다시 읽을 때도 출처와 필드 길이를 검증합니다. 출처 주소 검증은 로컬·사설 IP, 로컬 호스트명, 사용자 인증 정보, 인증 쿼리·fragment를 거부하며 출처를 서버에서 임의 요청하지 않습니다.

비밀이 없는 연결 정보는 기존 설정과 별도인 `opal-settings.json`에 원자적으로 저장하며 Unix 권한은 `0600`입니다. `.toris-studio` 런타임 폴더는 Git에서 제외됩니다. 실행 파일을 직접 호출하고 셸은 사용하지 않습니다. 실행 계정과 로컬 호스트를 고정하고 작업 프롬프트에 JSON으로 인코딩한 주제만 전달합니다. API·DB·OAuth 환경 변수는 CLI 프로세스에 상속하지 않습니다.

실행은 한 번에 하나, 최대 10분, 표준 출력은 최대 128 KiB입니다. 시간 초과·출력 초과·실패·앱의 정상 종료 시에는 CLI가 생성한 해당 세션 ID와 계정만 대상으로 종료합니다. 종료가 확인되지 않으면 중복 탐색을 막고 Aside 확인을 요청합니다. OS 강제 종료나 전원 차단 때 브라우저 작업 종료를 보장할 수 없으므로 Aside에서 진행 중 작업을 확인해야 합니다.

## 서비스 종료와 보관

Google은 Opal과 Gemini의 `Gems made by Labs` 실행 서비스를 **2026년 11월 17일** 종료한다고 공지했습니다. 기존 워크플로우는 자동으로 다른 제품에 이전되지 않습니다. 종료 전 워크플로우의 프롬프트와 설정을 복사해 보관하세요. 워크플로우 파일은 개인 Google Drive의 `Opal` 폴더에 남으며 종료 후에도 파일을 내려받아 텍스트 편집기로 내용을 확인할 수 있습니다. 앱에 이미 저장한 탐색 결과는 로컬 DB에서 계속 조회할 수 있습니다. [Google 공식 FAQ](https://developers.google.com/opal/faq)

Aside CLI 동작과 계정 옵션은 설치된 CLI의 `aside guide`, `aside exec --help`, `aside session stop --help`를 기준으로 구현했습니다.
