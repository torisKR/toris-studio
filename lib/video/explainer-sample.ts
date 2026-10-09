import type { VideoFormat, VideoProject } from "./types";

/** Reuses a repository screenshot, never the reference channel's media. Silent visual draft. */
export function createExplainerSample(format: VideoFormat): VideoProject {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), title: `UI 설명 편집 샘플 · ${format}`, format,
    template: "adaptive-promo", editingPreset: "project-explainer", language: "ko",
    createdAt: now, updatedAt: now,
    scenes: [{
      id: "ui-proof", headline: "실제 화면에서\n설명할 곳을 짚습니다", body: "저장소의 시니어 클럽 화면 예시\n전체 UI를 유지하고 알림 영역만 강조합니다.",
      eyebrow: "UI SCREENSHOT · SILENT DRAFT", narration: "", durationSec: 3,
      mediaType: "image", mediaUrl: "/senior-club/home.png", mediaFit: "contain",
      mediaSize: { width: 1080, height: 1920 }, role: "proof",
      sourceLabel: "시니어 클럽 · 저장소 화면 에셋",
      focusRegion: { x: 0.73, y: 0.51, width: 0.16, height: 0.09, startSec: 0.5, endSec: 2.5, label: "알림 영역" },
      captionCues: [{ startSec: 0, endSec: 1.5, text: "전체 화면을 보존합니다" }, { startSec: 1.5, endSec: 3, text: "설명하는 영역에만 시선을 모읍니다" }]
    }, {
      id: "workflow", headline: "설명도 순서대로\n따라갈 수 있게", body: "직접 작성한 설명 단계\n음성 없는 6초 시각 검토 샘플입니다.",
      narration: "", durationSec: 3, mediaType: "none", role: "point",
      explanationSteps: ["실제 화면과 근거 연결", "장면별 설명과 자막 작성", "화면비별 크롭 검사"],
      captionCues: [{ startSec: 0, endSec: 3, text: "화면 → 설명 → 검사" }]
    }]
  };
}
