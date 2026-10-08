# Google Labs Opal 탐색

Toris Studio의 Rust 데스크톱 앱에서 주제를 입력하면 로컬 Aside CLI가 등록된 비공개 Opal 워크플로우를 한 번 실행합니다. Rust가 실제 JSON 결과의 형식과 공개 출처 주소를 검증한 뒤 로컬 PostgreSQL에 저장합니다. Google의 Opal 엔진은 Google 서버에서 실행되며, 이 연결은 공개되지 않은 API나 로컬 Opal 서버를 가정하지 않습니다.

**2026-10-08 확인 상태:** 등록된 주소의 Google 로그인과 비공개 편집기 접근은 정상입니다. 입력 4개(주제·지역·기간·기준 날짜), 생성 단계(Generate), Manual layout 출력의 6개 단계를 저장했습니다. 생성 단계는 Gemini 3.1 Pro와 실제 Search Web·Get Webpage 도구를 사용합니다. 출력 계약을 충족하지 않거나 출처가 홈페이지뿐인 시험 결과는 저장하지 않았습니다. 개별 기사·문서 원문 주소와 제목·날짜를 확인하도록 지침을 강화해 재실행을 검증 중입니다. 성공 결과와 Toris Studio의 로컬 DB 저장은 아직 확인되지 않았습니다. 단계 저장만으로 전체 탐색 성공을 의미하지 않습니다.

## 설정과 사용

1. Aside에서 Google에 로그인하고 비공개 Opal 워크플로우를 만듭니다. `topic`, `region`, `lookbackDays` 입력과 아래 JSON 출력 계약을 설정합니다. 최근 7일의 검색 기준을 정확히 전달하려면 `asOfDate`(화면 이름 `Reference Date` 또는 `기준 날짜`) 입력도 추가합니다. 공개 공유는 필요하지 않습니다.
2. 앱의 `Opal 탐색`에서 실제 워크플로우 HTTPS 주소를 저장합니다. 허용 호스트는 `opal.google.com`, `opal.withgoogle.com`, `opal.google`입니다. `app=drive:/...` 주소와 `/edit/<워크플로 ID>` 편집기 주소를 지원합니다. 주소를 저장했다는 사실만으로 해당 워크플로의 단계·접근 권한·Google 로그인이 검증되지는 않습니다.
3. Aside 계정은 기본 `u0`입니다. 다른 등록 계정은 `u1`~`u99`로 지정합니다. 기본 CLI 경로는 사용자 홈의 `.local/bin/aside`이며 Windows에서는 `.local/bin/aside.exe`입니다. 다른 설치 위치는 `aside` 또는 `aside.exe`로 끝나는 절대 경로를 지정합니다.
4. 연결 설정에서 로컬 DB를 시작·갱신합니다. `004_opal_research.sql`이 탐색 결과 테이블을 만들고, `005_opal_result_shape.sql`이 기존 테이블에도 결과 형식 제약을 추가합니다. 기존 채널·콘텐츠·탐색 행을 삭제하지 않습니다. 주제는 1~200자이며 한국의 최근 7일을 탐색합니다.
5. 결과에는 요약, 추천 키워드와 이유, SNS 플랫폼, 실제 공개 출처가 표시됩니다. 재실행 전 이전 실행이 끝나야 하며 결과 이력은 최근 30개를 조회합니다.

Rust는 매 탐색 시작 시 현재 UTC 시간을 한국의 고정 시간대 `UTC+09:00`으로 변환해 `YYYY-MM-DD` 형식의 `asOfDate`를 Aside에 전달합니다. 기존 워크플로에 기준 날짜 입력이 있으면 그 값을 입력하고, 없으면 기존의 필수 입력 3개만 사용합니다. 주제에 날짜나 지시를 덧붙이지 않으며 브라우저 작업자가 새 입력을 만들거나 워크플로를 수정하지 않습니다. 생성 단계에서는 기준 날짜를 참조해 최근 7일을 검색하고 모델의 지식 기준 날짜나 하드코딩한 날짜로 현재 날짜를 추정하지 않도록 구성합니다. 기준 날짜는 실행 입력이며 기존 결과 JSON이나 DB 저장 필드에는 추가하지 않습니다.

로그인, CAPTCHA, 이용약관 또는 추가 권한 동의가 필요한 경우 자동 실행을 중단합니다. Aside에서 사용자가 해당 상태를 확인한 뒤 다시 실행할 수 있습니다. 앱은 브라우저 세션이나 쿠키를 가져오지 않습니다. 기존 YouTube·네이버·Instagram OAuth 설정과 수집 API 키도 이 연결에 전달하지 않습니다.

`Opal에서 열기`는 저장된 Aside CLI와 계정을 사용합니다. Rust가 `--host local --account <저장된 계정>`과 공식 Opal 주소를 직접 전달하므로 수동 로그인과 탐색 실행이 같은 Aside 프로필을 사용합니다. 아직 워크플로를 등록하지 않았다면 공식 Opal 홈을 엽니다. 주소·계정·CLI 경로를 편집한 상태에서는 먼저 `연결 저장`을 완료해야 열기와 탐색을 실행할 수 있습니다. 앱은 열기 요청을 최대 15초로 제한하고 탐색·업데이트 설치와 동시에 실행하지 않습니다.

워크플로 편집기는 iframe 안에 표시될 수 있습니다. `/edit/` 주소에서는 로드된 편집기의 실제 단계를 확인하고 **Preview → Start**로 실행합니다. 바깥 화면에 실행 버튼이 없거나 편집기가 보인다는 이유로 접근 실패로 판단하지 않습니다. 공개 공유나 Publish는 필요하지 않습니다. SNS 로그인에는 별도로 `Aside로 로그인`을 선택할 수 있으며 운영체제의 기본 브라우저 설정은 변경하지 않습니다.

## 실행 상태와 복구

화면의 `실행 환경 설정됨`과 IPC의 `available`은 Aside CLI와 워크플로 주소가 설정됐다는 뜻입니다. 실제 워크플로 실행 성공이나 Google 로그인 확인 상태를 나타내지 않습니다.

| 브라우저 결과 코드 | 확인한 상태 | 다음 행동 |
| --- | --- | --- |
| `LOGIN_REQUIRED` | 실제 Google 로그인 화면 | 같은 Aside 계정에서 직접 로그인 후 재시도 |
| `PERMISSION_REQUIRED` | 명시적인 권한 동의 요청 | Aside에서 요청을 직접 확인 |
| `CAPTCHA` | 사용자 확인 필요 | Aside에서 직접 확인 완료 |
| `WORKFLOW_EMPTY` | 로드된 Draft에 입력·생성·출력 단계 없음 | 비공개 워크플로의 단계를 구성하고 저장·Preview 확인 |
| `WORKFLOW_UNAVAILABLE` | 워크플로 없음 또는 명시적인 접근 거부 | 등록 주소와 해당 Google 계정의 접근 권한 확인 |
| `RUN_FAILED` | 실행 또는 출력 계약 충족 실패 | Preview의 실행 상태·입력값·출력 단계 확인 |

Aside는 위 코드 하나를 `TORIS_OPAL_BLOCKED:` 뒤에 반환합니다. 실패를 성공 결과로 바꾸거나 탐색 이력에 저장하지 않습니다. 원인을 확인할 수 없는 상태에서 새 워크플로를 자동 생성하거나 다른 계정으로 전환하지 않습니다.

## 워크플로우 출력 계약

실제 실행 출력은 다음 필드만 포함해야 합니다. 키워드는 1~10개이고 각 키워드에 실제 공개 HTTPS 출처 1~3개가 필요합니다. 확인하지 못한 게시 날짜는 `null`로 표시합니다. 조회수, 인기 순위, 게시 날짜와 출처를 만들어 내지 않습니다.

출처는 **실제로 연 개별 기사·문서의 전체 원문 주소**여야 합니다. 도메인이나 홈페이지, 검색 결과·기사 목록 페이지를 특정 관측의 근거로 대신 쓰지 않습니다. Get Webpage로 원문을 열어 제목·내용·게시 날짜를 확인하고, 확인되지 않은 시각은 `null`로 유지합니다. 검증된 원문이 하나뿐이면 키워드도 한 개만 출력하며, 검증된 출처가 전혀 없으면 `TORIS_OPAL_BLOCKED:RUN_FAILED`로 종료합니다. 이는 워크플로와 원문 검토의 품질 요구이며, Rust의 URL 형식 검증만으로 기사 내용·날짜가 검증됐다고 판단하지 않습니다.

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
          "url": "https://공개출처도메인/실제기사또는문서경로",
          "publishedAt": null
        }
      ]
    }
  ]
}
```

`platforms` 허용 값은 `youtube`, `threads`, `naver_blog`, `tiktok`, `instagram`입니다. 요약은 최대 3,000자, 키워드는 100자, 이유는 1,600자, 출처 제목은 300자, 주소는 2,048자입니다. Aside는 실제 워크플로우 출력을 읽고 `TORIS_OPAL_RESULT:` 뒤에 JSON을 한 줄로 반환합니다. 원본 CLI 로그는 UI와 DB에 저장하지 않습니다. 잘못된 결과는 저장하지 않습니다.

Opal의 최종 Output은 **Manual layout**에서 생성 단계(Generate) 결과를 참조하는 실제 단계 chip을 사용해 원문을 그대로 표시하도록 구성합니다. Auto-layout이나 별도 요약 단계가 JSON을 HTML·설명문·다른 데이터로 다시 작성하지 않도록 합니다. 성공 marker 또는 실패 marker 한 줄을 Preview의 실제 출력에서 확인해야 합니다. 자세한 작성 절차는 [OPAL_WORKFLOW_PROMPT.md](OPAL_WORKFLOW_PROMPT.md)를 참고하세요.

## Rust IPC와 데이터

| 명령 | 입력 | 반환 |
| --- | --- | --- |
| `get_opal_status` | 없음 | `available`, `cliAvailable`, `workflowUrl`, `account`, `reason`, `runActive` |
| `configure_opal` | `{input:{workflowUrl,asidePath?,account?}}` | 연결 상태. 생략한 경로·계정은 기존 값 유지 |
| `open_opal_workflow` | 없음 | 저장된 Aside 계정에서 워크플로 열기 요청. 성공 시 반환 값 없음 |
| `run_opal_research` | `{input:{topic,lookbackDays:7}}` | 검증·저장된 `OpalRun` |
| `get_opal_runs` | 없음 | 최신 `OpalRun[]`, 최대 30개 |

`OpalRun`은 `id`, `topic`, `region`, `lookbackDays`, `generatedAt`, `summary`, `keywords`를 포함합니다. `id`와 저장 시각은 Rust가 생성합니다. 저장된 결과를 다시 읽을 때도 출처와 필드 길이를 검증합니다. 출처 주소 검증은 로컬·사설 IP, 로컬 호스트명, 사용자 인증 정보, 인증 쿼리·fragment를 거부하며 출처를 서버에서 임의 요청하지 않습니다.

`open_opal_workflow`는 로컬 앱의 main 창에서만 허용하며 renderer에서 URL·프로그램·계정 인수를 받지 않습니다. 업데이트 설치 준비·진행 중에는 열기를 거부하고 Rust의 Opal 실행 gate로 탐색과 설치가 동시에 시작되지 않도록 합니다. CLI 종료 성공은 열기 요청의 성공이며 페이지 접근과 워크플로 실행 성공의 증거는 아닙니다.

비밀이 없는 연결 정보는 기존 설정과 별도인 `opal-settings.json`에 원자적으로 저장하며 Unix 권한은 `0600`입니다. `.toris-studio` 런타임 폴더는 Git에서 제외됩니다. 실행 파일을 직접 호출하고 셸은 사용하지 않습니다. 실행 계정과 로컬 호스트를 고정하고 작업 프롬프트에 JSON으로 인코딩한 주제만 전달합니다. API·DB·OAuth 환경 변수는 CLI 프로세스에 상속하지 않습니다.

실행은 한 번에 하나, 최대 10분, 표준 출력은 최대 128 KiB입니다. 시간 초과·출력 초과·실패·앱의 정상 종료 시에는 CLI가 생성한 해당 세션 ID와 계정만 대상으로 종료합니다. 종료가 확인되지 않으면 중복 탐색을 막고 Aside 확인을 요청합니다. OS 강제 종료나 전원 차단 때 브라우저 작업 종료를 보장할 수 없으므로 Aside에서 진행 중 작업을 확인해야 합니다.

## 서비스 종료와 보관

Google은 Opal과 Gemini의 `Gems made by Labs` 실행 서비스를 **2026년 11월 17일** 종료한다고 공지했습니다. 기존 워크플로우는 자동으로 다른 제품에 이전되지 않습니다. 종료 전 워크플로우의 프롬프트와 설정을 복사해 보관하세요. 워크플로우 파일은 개인 Google Drive의 `Opal` 폴더에 남으며 종료 후에도 파일을 내려받아 텍스트 편집기로 내용을 확인할 수 있습니다. 앱에 이미 저장한 탐색 결과는 로컬 DB에서 계속 조회할 수 있습니다. [Google 공식 FAQ](https://developers.google.com/opal/faq)

Aside CLI 동작과 계정 옵션은 설치된 CLI의 `aside guide`, `aside exec --help`, `aside session stop --help`를 기준으로 구현했습니다.
