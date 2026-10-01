import { DEVDAY_2026_SCENES } from "./devday-2026";
import type { VideoProject, VideoScene } from "./types";

export type SocialDestination = "instagram" | "youtube";

export function createDevDay30(destination: SocialDestination): VideoProject {
  const codex = DEVDAY_2026_SCENES.find(scene => scene.id === "codex")!;
  const mcp = DEVDAY_2026_SCENES.find(scene => scene.id === "mcp")!;
  const scenes: VideoScene[] = [
    {
      id: "hook", durationSec: 3, role: "hook", layout: "social-hook",
      eyebrow: "OPENAI DEVDAY 2026 · 30초",
      headline: "답변하던 AI,\n이제 일을\n실행합니다",
      body: "TORIS의 발표 해석 · 핵심 변화 2가지",
      narration: "답변하던 AI, 이제 일을 실행합니다.", captionCues: [],
      sourceLabel: "TORIS 해석", sourceUrl: "https://openai.com/index/devday-2026-recap/"
    },
    {
      id: "codex", durationSec: 10, role: "point", layout: "social-point",
      eyebrow: "01 · 클라우드 개발",
      headline: "노트북 밖에서도\n개발을 이어갑니다",
      body: "Codex Cloud · Agents API\n컴퓨터 사용: 호스팅 브라우저 범위",
      narration: codex.narration,
      audioPath: "/generated/devday-30/codex.wav",
      mediaType: "image", mediaUrl: codex.asset,
      sourceLabel: "OpenAI 공식 발표", sourceUrl: "https://openai.com/index/devday-2026-recap/",
      // Whole sentence cues follow the source recording's 3.66–5.21s pause.
      // These are not word-level forced alignment results.
      captionCues: [
        { startSec: 0, endSec: 4.0, text: "Codex Cloud는 노트북을 닫아도\n개발을 계속합니다." },
        { startSec: 5.1, endSec: 8.72, text: "Agents API는 컴퓨터도\n직접 조작합니다." }
      ]
    },
    {
      id: "mcp", durationSec: 12, role: "point", layout: "social-point",
      eyebrow: "02 · 이벤트 자동화",
      headline: "새 이벤트가\n자동화를 시작합니다",
      body: "MCP Events · 플러그인\n지원 이벤트·앱·권한에 따라 달라집니다",
      narration: mcp.narration,
      audioPath: "/generated/devday-30/mcp.wav",
      mediaType: "image", mediaUrl: mcp.asset,
      sourceLabel: "OpenAI 공식 발표", sourceUrl: "https://openai.com/index/devday-2026-recap/",
      // The original recording has a 5.60–7.68s clause pause. No audio cut.
      captionCues: [
        { startSec: 0, endSec: 5.8, text: "MCP Events는 새 작업이 생기면\n자동화를 시작하고," },
        { startSec: 7.55, endSec: 10.72, text: "플러그인은 대화 안에\n전용 화면도 만듭니다." }
      ]
    },
    {
      id: "cta", durationSec: 5, role: "action", layout: "social-cta",
      eyebrow: destination === "instagram" ? "INSTAGRAM REELS" : "YOUTUBE SHORTS",
      headline: destination === "instagram" ? "댓글에 Dev를\n남겨주세요" : "관련 영상에서\n자세히 확인하세요",
      body: destination === "instagram" ? "검토용 · 댓글 연결 설정 전" : "검토용 · 관련 영상 연결 전",
      narration: destination === "instagram" ? "댓글에 Dev를 남겨주세요" : "관련 영상에서 자세히 확인하세요",
      captionCues: [], sourceLabel: "게시 전 연결 확인 필요"
    }
  ];
  return {
    id: destination === "instagram" ? "b2150d8a-f2ec-4be4-bfa9-0981c63b9c11" : "b2150d8a-f2ec-4be4-bfa9-0981c63b9c12",
    title: `DevDay 2026 · 30초 · ${destination} · 검토본`,
    subtitle: "0–3초 훅 / 3–25초 핵심 2개 / 25–30초 CTA. 훅·CTA는 화면 문구이며 신규 음성 미확보.",
    format: "shorts", template: "reference-briefing", language: "ko", scenes,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"
  };
}
