# Toris Studio Video Templates

Toris Studio는 같은 장면 데이터 모델을 사용하되, 목적과 화면비에 따라 장면 구조를 다르게 만드는 템플릿 시스템을 사용합니다.

## 1. Reference Briefing

리서치·뉴스·제품 발표·비교 영상에 사용합니다.

### Shorts
Hook → Key Point → Reaction/Proof → Action

### Long-form
Hook → Key Point → Official Proof → Reaction → Cost/Condition → Action → Takeaway

공식 정보와 의견/커뮤니티 반응을 분리하고, 근거 장면에는 sourceUrl과 실제 화면을 연결하는 것을 기본 규칙으로 합니다.

## 2. Adaptive Promo

앱·SaaS·서비스·브랜드 홍보용입니다. format에 따라 장면 수와 리듬이 자동으로 달라집니다.

### YouTube Shorts · 1080×1920
- 4~8초 Hook
- Benefit / Problem
- 실제 앱·웹 Product 화면
- Payoff
- 하나의 CTA
- 권장 총 길이: 40~50초

### Vertical · 1080×1920
- Hook
- Problem
- Solution
- Feature
- Proof / Result
- CTA
- Brand Outro
- 권장 총 길이: 60~90초

### YouTube Long-form · 1920×1080
- Hook
- Context
- Problem
- Solution / Demo
- Feature 1
- Feature 2 / Workflow
- Proof / Payoff
- Cost / Limitation / Objection
- Action
- Takeaway
- 기본 골격: 약 3~4분

## 장면 문법

| Role | Layout | 용도 |
| --- | --- | --- |
| hook | hero | 첫 시청 이유 |
| point | split | 설명 + B-roll |
| proof | media-focus | 제품 UI·문서·근거 |
| reaction | reaction-grid | 결과·반응·비교 |
| cost | split | 가격·조건·한계 |
| action | action-card | 다음 행동 |
| outro | hero | 브랜드·한 문장 결론 |

## ChatGPT / MCP 사용

ChatGPT가 골격부터 만들 때는 studio_create_template_project를 사용합니다.

- template=adaptive-promo, format=shorts: 서비스 쇼츠
- template=adaptive-promo, format=youtube-landscape: 서비스 롱폼
- template=reference-briefing: 리서치·브리핑

골격 생성 후 ChatGPT는 실제 서비스 문구·미디어·출처를 반영해 studio_save_project로 장면을 완성합니다.

## TTS

장면 narration은 로컬 Qwen3-TTS MLX에서 생성합니다.

- 모델: mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit
- 기본 화자: Sohee
- 언어: Korean
- 출력: 24kHz WAV
- Studio는 생성된 실제 음성 길이에 0.45초 여유를 더해 장면 길이를 조정합니다.

## 품질 검사

Studio의 Quality Check는 다음을 자동 검사합니다.

1. 8초 이내 Hook
2. 레이아웃 변화
3. 실제 미디어 연결 비율
4. 근거 장면 sourceUrl
5. 장면 길이 대비 narration 밀도
6. Hook → 근거/제품 → Reaction/Payoff → Action 구조
7. Shorts 60초 이하

템플릿의 디자인 완성도와 게시 준비도는 별개입니다. 실제 화면/B-roll과 출처가 비어 있으면 점수가 낮게 나오는 것이 정상입니다.

## 구현 위치

- 템플릿 정의: lib/video/templates.ts
- 타입: lib/video/types.ts
- 품질 검사: lib/video/quality.ts
- 렌더 레이아웃: remotion/templates/NewsBriefingVideo.tsx
- 편집 UI: components/StudioApp.tsx
- Qwen3-TTS 클라이언트: lib/tts/qwen3-local.ts
- Qwen3-TTS 로컬 서버: runtime/qwen3_tts_server.py
