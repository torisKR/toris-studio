export const DEVDAY_2026_SOURCE =
  "https://news.hada.io/topic?id=34505";

export const DEVDAY_2026_OFFICIAL =
  "https://openai.com/ko-KR/index/devday-2026-recap/";

export type DevDayScene = {
  id: string;
  kicker: string;
  title: string;
  body: string;
  narration: string;
  metric?: string;
  metricLabel?: string;
  asset: string;
  accent: string;
  durationSec: number;
};

export const DEVDAY_2026_SCENES: DevDayScene[] = [
  {
    id: "hook",
    kicker: "OPENAI DEVDAY 2026",
    title: "이번 핵심은\n새 모델 하나가 아니었습니다",
    body: "AI가 답하는 도구에서, 계속 일하는 시스템으로.",
    narration:
      "DevDay 2026. AI가 답하는 도구에서, 계속 일하는 시스템으로 넘어갑니다.",
    asset: "/devday-2026/dots-network.svg",
    accent: "#74F0C1",
    durationSec: 7.8
  },
  {
    id: "dots",
    kicker: "01 · DOTS",
    title: "24시간 계속 일하는\n상시 에이전트",
    body: "GPT-6 Astra · 전용 클라우드 컴퓨터 · 4,000+ 앱 연결",
    narration:
      "Dots는 GPT-6 Astra 기반 상시 에이전트. 전용 클라우드 컴퓨터와 4천 개 넘는 앱으로 24시간 일합니다.",
    metric: "4,000+",
    metricLabel: "CONNECTED APPS",
    asset: "/devday-2026/dots-network.svg",
    accent: "#74F0C1",
    durationSec: 9.4
  },
  {
    id: "sol",
    kicker: "02 · GPT-6.1 SOL + ULTRAFAST",
    title: "더 싸고,\n훨씬 빠르게",
    body: "Sol 표준 API: 입력 $2 / 출력 $10 · Ultrafast: Codex 최대 8×",
    narration:
      "GPT-6.1 Sol은 입력 2달러, 출력 10달러. Ultrafast는 Codex에서 최대 8배 빠릅니다.",
    metric: "8×",
    metricLabel: "FASTER IN CODEX",
    asset: "/devday-2026/sol-speed.svg",
    accent: "#8AB9FF",
    durationSec: 9.7
  },
  {
    id: "codex",
    kicker: "03 · CODEX CLOUD + AGENTS API",
    title: "노트북을 닫아도\n개발은 계속됩니다",
    body: "Cloud Codex · Computer Use · Decisions API",
    narration:
      "Codex Cloud는 노트북을 닫아도 개발을 계속합니다. Agents API는 컴퓨터도 직접 조작합니다.",
    asset: "/devday-2026/cloud-agent.svg",
    accent: "#B69CFF",
    durationSec: 8.6
  },
  {
    id: "mcp",
    kicker: "04 · PLUGINS + MCP EVENTS",
    title: "이제 사건이\n작업의 시작점",
    body: "새 메시지 · 새 작업 · 상태 변경 → 자동화 시작",
    narration:
      "MCP Events는 새 작업이 생기면 자동화를 시작하고, 플러그인은 대화 안에 전용 화면도 만듭니다.",
    asset: "/devday-2026/mcp-events.svg",
    accent: "#FFB274",
    durationSec: 11.2
  },
  {
    id: "space",
    kicker: "05 · SPACE + PAGES",
    title: "사람과 에이전트가\n같은 공간에서 협업",
    body: "공유 프로젝트 맥락 · 살아 있는 문서 · 팀 편집",
    narration:
      "Space와 Pages에서는 사람과 에이전트가 한 프로젝트에서 협업합니다. 대화형 AI가 작업 시스템으로 바뀌는 겁니다.",
    asset: "/devday-2026/space-pages.svg",
    accent: "#F59BCB",
    durationSec: 11.4
  }
];

export const DEVDAY_2026_TOTAL_SECONDS = DEVDAY_2026_SCENES.reduce(
  (sum, scene) => sum + scene.durationSec,
  0
);
