import type { VideoFormat, VideoProject, VideoScene } from "../../lib/video/types";
import type { VideoResearchMetadata } from "./video-research";

export const ideaCategories = {
  education: "교육·지식", tech: "기술·AI", business: "비즈니스", lifestyle: "라이프스타일", entertainment: "엔터테인먼트", news: "뉴스·시사"
} as const;

export const motionPresets = {
  "kinetic-title": { label: "키네틱 타이틀", detail: "제목을 순서대로 드러내며 핵심 문장에 시선을 모읍니다." },
  "stagger-rise": { label: "차례로 떠오르기", detail: "제목과 본문을 시차를 두고 아래에서 올립니다." },
  "slide-reveal": { label: "슬라이드 리빌", detail: "옆에서 들어오는 텍스트로 장면을 전환합니다." },
  "focus-pulse": { label: "포커스 펄스", detail: "핵심 문장을 부드럽게 확대해 강조합니다." },
  "parallax-pan": { label: "패럴랙스 팬", detail: "배경과 텍스트를 다른 속도로 이동해 깊이를 만듭니다." },
  "orbit-cards": { label: "오빗 카드", detail: "주변 카드를 움직여 중앙의 메시지를 강조합니다." },
  "lower-third": { label: "하단 자막 바", detail: "제목이 이름표처럼 옆에서 들어오고 본문이 반대쪽에서 이어집니다." },
  "count-up": { label: "숫자 카운터", detail: "입력한 시작값에서 목표값까지 숫자가 올라갑니다." },
  "bar-chart": { label: "막대 차트", detail: "입력한 값만큼 막대가 아래에서 자랍니다." },
  "progress-steps": { label: "진행 단계", detail: "본문 카드가 1·2·3 순서로 차례대로 켜집니다." },
  "quote-card": { label: "인용 카드", detail: "본문을 큰 카드로 천천히 확대해 보여 줍니다." },
  "logo-reveal": { label: "로고 등장", detail: "프로젝트의 로고 이미지가 가운데에서 커지며 나타납니다." }
} as const;

/** Presets that need extra scene data; Rust validates the same bounds. */
export const DATA_PRESETS = { "count-up": "countUp", "bar-chart": "chart", "logo-reveal": "logoPath" } as const;

export const transitions = { cut: "컷", fade: "페이드", dip: "어둡게 전환" } as const;
export type VideoTransition = keyof typeof transitions;
export type CountUpData = { from: number; to: number; unit?: string; decimals?: number };
export type ChartBar = { label: string; value: number };

/** Parses "라벨: 값" lines into chart bars. Returns an error message for bad input. */
export function parseChart(text: string): ChartBar[] | string {
  const bars = text.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const at = line.lastIndexOf(":");
    return at < 0 ? null : { label: line.slice(0, at).trim(), value: Number(line.slice(at + 1).trim()) };
  });
  if (bars.length < 2 || bars.length > 8) return "막대는 2~8개여야 합니다. 한 줄에 \"라벨: 값\"으로 입력하세요.";
  if (bars.some(bar => !bar || !bar.label || bar.label.length > 16 || !Number.isFinite(bar.value) || bar.value < 0)) return "각 줄은 16자 이하 라벨과 0 이상의 숫자여야 합니다.";
  return bars as ChartBar[];
}

export function chartText(bars: unknown): string {
  return Array.isArray(bars) ? bars.map(bar => `${bar?.label ?? ""}: ${bar?.value ?? ""}`).join("\n") : "";
}

export type VideoIdeaCategory = keyof typeof ideaCategories;
export type VideoMotionPreset = keyof typeof motionPresets;
/** agent-model: the Agent tab's content model writes the prose. template: a model-free draft. */
export type VideoIdeaProvider = "agent-model" | "template";
export type VideoMotion = { preset: VideoMotionPreset; intensity: number };
export type VideoIdeaInput = {
  topic: string; category: VideoIdeaCategory; format: VideoFormat; provider: VideoIdeaProvider;
  language: VideoProject["language"]; sceneCount: number; durationSec: number;
};
export type VideoIdeaMetadata = {
  version: 1; topic: string; category: VideoIdeaCategory; provider: string;
  createdAt: string; reviewRequired: true; motionSkill: "toris-video-motion";
};
export type StudioVideoScene = VideoScene & { motion?: VideoMotion; transition?: VideoTransition; countUp?: CountUpData; chart?: ChartBar[]; logoPath?: string; burnCaptions?: boolean };
export type StudioVideoProject = Omit<VideoProject, "scenes"> & { scenes: StudioVideoScene[]; research?: VideoResearchMetadata; idea?: VideoIdeaMetadata; templateRecipe?: { version: 1; id: string; name: string } };
export type VideoIdeaResult = { project: StudioVideoProject; provider: string; warnings: string[] };

const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
/** Saved projects may name older providers; they still read as AI-written ideas. */
const IDEA_PROVIDERS = ["agent-model", "template", "chatgpt", "opencodex", "teamclaude", "claude-cli"];

/** Older saved selections said "chatgpt" for the Agent tab model. */
export function ideaProviderOf(value: unknown): VideoIdeaProvider | "" {
  return value === "template" ? "template" : value === "agent-model" || value === "chatgpt" ? "agent-model" : "";
}

export function readIdeaMetadata(value: unknown): VideoIdeaMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<VideoIdeaMetadata>;
  return candidate.version === 1 && typeof candidate.topic === "string" && candidate.topic.length <= 300
    && typeof candidate.category === "string" && owns(ideaCategories, candidate.category)
    && typeof candidate.provider === "string" && IDEA_PROVIDERS.includes(candidate.provider)
    && typeof candidate.createdAt === "string" && candidate.reviewRequired === true && candidate.motionSkill === "toris-video-motion"
    ? candidate as VideoIdeaMetadata : null;
}

export function readMotion(value: unknown): VideoMotion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<VideoMotion>;
  return typeof candidate.preset === "string" && owns(motionPresets, candidate.preset)
    && typeof candidate.intensity === "number" && Number.isFinite(candidate.intensity) && candidate.intensity >= 0 && candidate.intensity <= 1
    ? candidate as VideoMotion : null;
}
