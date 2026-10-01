# OpenAI DevDay 2026 Shorts

GeekNews GN#34505 「OpenAI DevDay 2026 주요 발표 총정리」를 출발점으로 만든 Toris Studio 전용 9:16 쇼츠입니다.

## 최종 결과

- Composition: `DevDay2026-Shorts`
- Output: `public/renders/openai-devday-2026-shorts.mp4`
- Cover: `public/renders/openai-devday-2026-cover.jpg`
- 1080×1920 / 30fps / H.264 + AAC 48kHz
- 58.2초

## 편집 방향

기사 전체의 20개 이상 발표를 한 영상에 나열하지 않고, 작업 방식의 변화를 설명하는 5개 축만 선별했습니다.

1. Dots — 상시 작동 에이전트
2. GPT-6.1 Sol + Ultrafast — 비용과 속도
3. Codex Cloud + Agents API — 클라우드 개발과 컴퓨터 사용
4. Plugins + MCP Events — 사건 기반 자동화
5. Space + Pages — 사람과 에이전트의 공동 작업 공간

결론 프레임은 “대화형 AI → 작업 시스템”입니다.

## 소스

- GeekNews GN#34505: https://news.hada.io/topic?id=34505
- OpenAI DevDay 2026 recap: https://openai.com/ko-KR/index/devday-2026-recap/
- dots: https://openai.com/ko-KR/index/introducing-dots/
- GPT-6.1 Sol: https://openai.com/ko-KR/index/introducing-gpt-6-1-sol/
- MCP Events: https://developers.openai.com/plugins/build/mcp-events

## 자체 제작 에셋

외부 발표 슬라이드 이미지를 복사하지 않고 Toris Studio에서 직접 만든 SVG를 사용합니다.

- `public/devday-2026/dots-network.svg`
- `public/devday-2026/sol-speed.svg`
- `public/devday-2026/cloud-agent.svg`
- `public/devday-2026/mcp-events.svg`
- `public/devday-2026/space-pages.svg`

## 음성

- Qwen3-TTS MLX
- Speaker: Sohee
- 한국 여성 테크 뉴스 진행자 톤
- 제품명은 화면에 공식 영문 표기를 유지하고, 음성 합성 입력에서는 한국어 발음 표기를 사용해 전달력을 높였습니다.
- 최종 음성은 loudness normalization 후 AAC 48kHz로 출력합니다.

## 코드

- 콘텐츠 데이터: `lib/video/devday-2026.ts`
- Remotion: `remotion/templates/DevDay2026Shorts.tsx`
- Composition 등록: `remotion/root.tsx`

## 렌더

```bash
pnpm exec remotion render remotion/index.ts DevDay2026-Shorts public/renders/openai-devday-2026-shorts.mp4 --codec=h264 --pixel-format=yuv420p
```

게시용 최종본은 렌더 후 음성 loudness를 정규화한 현재 `public/renders/openai-devday-2026-shorts.mp4`를 사용합니다.
