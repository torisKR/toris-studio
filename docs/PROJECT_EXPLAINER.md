# 선택형 프로젝트 설명 편집

기존 프로젝트·템플릿·DevDay/SeniorClub 전용 composition의 기본 디자인은 유지됩니다. `editingPreset`을 명시한 일반 `News-*` composition과 Studio 미리보기만 새 편집 경로를 사용합니다. 패키지 설치, TTS 서비스 변경, 원격 업로드는 필요하지 않습니다.

## 사용

1. Studio 오른쪽 **재사용 편집 프리셋**에서 `프로젝트 설명 · UI 강조 모션` 또는 `정지형`을 선택합니다. 처음 선택하면 새 프로젝트 UUID를 만들고 장면·미디어·음성을 복사합니다. 원본 프로젝트는 자동 저장하거나 변경하지 않습니다. 새 복사본을 저장하세요.
2. 실제 UI 캡처/화면 녹화를 장면 미디어에 연결하고 **전체 표시(contain)**를 선택합니다. 원본의 실제 가로/세로 픽셀을 모두 입력합니다. `mediaSize`는 사용자 제공 정보이므로 파일 자체의 크기와 일치하는지 확인해야 합니다.
3. **UI 강조 영역 JSON**을 입력합니다. 좌표는 원본 이미지의 왼쪽 위를 기준으로 0~1이며 화면비를 바꾸면 실제 contain/cover 배치를 따라 정수 픽셀로 다시 계산합니다. 전체 UI는 유지하면서 설명 대상의 별도 **부분 확대** 창을 기본 표시합니다. **전체 UI 옆에 설명 대상 상세 창 표시**를 끄거나 JSON에 `focusDetail:false`를 넣으면 강조 테두리만 표시합니다.
4. **자막 cue JSON**을 음성에 맞춰 입력합니다. 시간은 장면 시작 기준 초, 끝은 포함하지 않습니다. `[]`은 자막 숨김, 필드가 없으면 대본을 균등 시간으로 나눈 **초안**입니다. 자동 음성 동기화로 주장하지 않습니다. 기존 TTS로 음성을 다시 만들면 이전 cue가 제거되므로 재검토하세요.
5. 미디어가 없는 장면에는 **설명 단계** 2~4개를 입력합니다. 입력→처리→결과를 직접 작성하세요. 실제 화면이 있는 장면은 UI를 우선 표시합니다. 모션형은 설명 순서에 따라 카드를 강조하고 정지형은 모든 카드를 동일하게 표시합니다.
6. 16:9 또는 9:16/Shorts로 전환하고 사전검사 내용을 확인한 뒤 새 MP4를 렌더합니다. 새 스타일 출력 파일에는 UUID가 붙습니다. 기존 출력은 덮어쓰지 않습니다.

```json
{
  "editingPreset": "project-explainer",
  "scenes": [{
    "mediaSize": {"width": 1920, "height": 1080},
    "mediaFit": "contain",
    "focusRegion": {
      "x": 0.1, "y": 0.2, "width": 0.4, "height": 0.2,
      "startSec": 1, "endSec": 3, "label": "설명할 UI 영역"
    },
    "captionCues": [{"startSec": 0, "endSec": 2, "text": "실제 동작을 보여드립니다"}]
  }]
}
```

위는 추가 필드 예시입니다. 완전한 프로젝트에는 기존 title/format/template/language와 scene 필수 필드가 필요합니다. JSON 가져오기, 프로젝트 API, `studio_create_template_project`/`studio_save_project` MCP, `render:project` 모두 필드를 유지합니다. MCP로 새 스타일을 만들 때 기존 `projectId`를 지정하지 않아야 원본 프로젝트를 보존합니다.

## 설계한 레이아웃

아래 수치는 이 작업의 편집 설계값이며 레퍼런스 채널에서 측정한 값이 아닙니다. 플랫폼 UI는 계정/기기마다 달라 최종 화면 검토가 필요합니다.

| 영역 | 1920×1080 본편 (x,y,w,h) | 1080×1920 쇼츠·릴스 (x,y,w,h) |
|---|---|---|
| 안전영역 | 96,60,1728,960 | 72,156,864,1452 |
| 헤드라인 | 96,192,624,288 | 72,216,864,240 |
| 설명 | 96,504,624,192 | 72,480,864,144 |
| UI/도식 | 792,144,1032,648 | 72,672,864,656 |
| 자막 | 240,864,1440,120 | 72,1392,864,144 |

자막 컨테이너와 첫 줄 위치는 고정이고, 프로젝트 내 모든 cue에 같은 정수 글자 크기/줄 높이를 적용합니다. 2줄을 넘으면 렌더 전에 차단합니다. 공백 없는 긴 한글과 이모지는 grapheme 단위로 줄을 나누며 글자는 삭제하지 않습니다. 글자 폭 검사는 보수적인 예산 계산으로, 최종 폰트의 실제 브라우저 측정을 대신하지 않습니다. 설명/헤드라인 초과, cue 겹침·장면 초과·1프레임 미만, 강조 크롭·너무 작은 영역·미디어 크기 누락은 렌더 전 오류로 표시합니다. cover 자체와 크기 없는 일반 미디어는 검토 경고입니다.

CLI 사전검사:

```sh
node --import tsx scripts/check-explainer-project.ts project.json
```

## 고정 자막과 실제 출력 픽셀

프로젝트의 모든 장면/cue를 함께 검사하여 화면비·출력 해상도별 하나의 자막 크기와 행간을 선택합니다. 같은 프로젝트의 장면 전환에서도 박스·첫 줄 기준 위치·폰트 크기·행간이 유지됩니다. 한 장면의 긴 cue를 줄이면 전체 프로젝트 자막 크기도 다시 계산됩니다. 넘침 오류는 cue를 나누거나 문장을 줄여 해결하세요.

줄바꿈은 명시한 개행과 공백으로 구분한 어절을 우선 유지합니다. 박스 전체보다 긴 공백 없는 토큰만 글리프 단위로 나눕니다. 실제 출력 `REMOTION_SCALE`은 새 프리셋에서 composition의 목표 가로·세로를 먼저 결정합니다. 좌표/폰트/행간/미디어/강조를 그 해상도의 정수 픽셀로 다시 계산하고 후처리 확대·축소를 하지 않습니다. H.264 목표 크기는 정수이며 짝수여야 합니다. 예: scale 1은 1920×1080/1080×1920, scale 0.5는 960×540/540×960입니다. 기존 디자인의 scale 경로는 그대로입니다.

UI·카드·강조 테두리는 모두 박스 안쪽에 그립니다. 전체 UI 옆 부분 확대 창은 원본 타깃 주변의 별도 크롭이며 전체 화면을 대체하지 않습니다. 타깃과 상세 창의 정수 좌표/크롭을 사전검사합니다. 작은 UI 전체를 동시에 읽을 수 있다고 보장하지 않으므로 실제 대상 글씨를 렌더 프레임에서 확인하세요.

## 레퍼런스 상태

요청한 [Solostack Shorts](https://www.youtube.com/@Solostack-1/shorts)의 대표 ID:
`7E1_mZDDhNA`, `GwpkxLhNWFo`, `Rx23w4cw2zE`, `QvOSO6luQjc`, `lqp4M0rrfMM`.
전달받은 Cloud 조사에서 영상 로딩/CAPTCHA 때문에 실제 프레임·음성은 확인하지 못했고 제목만 확인했습니다. 이번 URL 읽기도 제한됐습니다. 컷 간격, 폰트, 색, 자막 위치, 효과음, 카메라 움직임을 원본 특징으로 확정하지 않습니다. 현재 프리셋은 사용자의 실제 프로젝트 설명·풍부한 시각 자료 목표를 구현한 독립 편집 설계입니다. 레퍼런스 영상/대본/음악은 복사하지 않았습니다.

## Cloud CPU 재현

아래는 **Cloud Linux에서 사용자가 준비한 환경**에 실행할 자료이며, Cloud 렌더를 완료했다는 뜻이 아닙니다. 별도 승인된 Mac 검토에서는 설치된 공식 Remotion headless만 사용하며 기존 브라우저와 Mac Blender를 사용하지 않습니다. 필수 환경: Node 24, 저장소 lockfile에 맞는 의존성, Chromium, FFmpeg/FFprobe, fontconfig, Noto Sans CJK. 기존 `docs/LINUX.md`와 `scripts/setup-linux.sh`를 참고하세요. 이 기능 자체는 자동 설치/유료 서비스 호출을 하지 않습니다.

```sh
bash scripts/cloud-explainer-sample.sh
```

매 실행마다 `.toris-studio/explainer-samples/run-*`에 새 UUID의 세 포맷 JSON/출처 SHA-256/사전검사를 만들고 16:9+Shorts 6초 MP4를 새로 렌더합니다. `REMOTION_CONCURRENCY=1`, `REMOTION_SCALE=1`, 30fps입니다. `vertical` JSON도 같은 9:16 레이아웃으로 제공되며 `scripts/render-project.ts`로 별도 렌더할 수 있습니다. 기존 `public/senior-club/home.png`를 **저장소 화면 에셋 예시**로 재사용합니다. 이 파일의 원본은 변경하지 않습니다. 소스의 알림 영역과 설명 단계 3개를 보여주는 **무음 시각 검토 초안**이며, 새 음성이나 실제 사용자 조작을 녹화한 샘플은 아닙니다.

스크립트는 새 폴더에 ffprobe JSON과 초별 PNG를 저장합니다. 실제 한국어 글리프, 0/1/2초 UI 강조, 3/4/5초 단계 모션, 두 자막 길이의 고정 위치, UI 전체 표시, 화면비별 여백을 확인하세요. 음성이 있는 본편은 추가로 cue와 음성을 듣고 맞춰야 합니다. Chromium은 Remotion 전용 headless 프로세스를 사용하며 사용자의 Mac 브라우저 세션과 무관합니다. 서버 렌더는 기존 [Remotion renderMedia](https://www.remotion.dev/docs/renderer/render-media) 경로를 사용합니다.

선택 사항: Cloud에 이미 준비된 **Blender 4.5 LTS**로 384×216, 30fps, 12프레임, Cycles CPU 8 samples의 무음 UI 강조 insert를 만들 수 있습니다. bpy 런타임/실제 렌더는 아직 미검증입니다.

```sh
blender --background --factory-startup --threads 2 \
  --python scripts/cloud-ui-focus-blender.py -- \
  --cloud-cpu --image public/senior-club/home.png \
  --output /tmp/toris-ui-focus-NEW-RUN
ffmpeg -n -framerate 30 -i /tmp/toris-ui-focus-NEW-RUN/frame-%04d.png \
  -c:v libx264 -pix_fmt yuv420p /tmp/toris-ui-focus-NEW-RUN/insert.mp4
```

`--output`은 새 폴더여야 합니다. Linux guard가 Mac 실행을 거부합니다. 새 Blender scene에서만 작업하고 `.blend` 파일을 로드/저장하지 않습니다. UI 이미지를 평면에 연결하고 알림 영역의 테두리를 5프레임부터 표시합니다. 실행 설정을 `settings.json`에 기록합니다. AgX 처리된 별도 insert이므로 본편의 픽셀 정밀 자막은 Remotion에서 합성하세요. 기존 이미지·영상·프로젝트는 덮어쓰지 않습니다.
