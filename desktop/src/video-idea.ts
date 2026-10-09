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
  "orbit-cards": { label: "오빗 카드", detail: "주변 카드를 움직여 중앙의 메시지를 강조합니다." }
} as const;

export type VideoIdeaCategory = keyof typeof ideaCategories;
export type VideoMotionPreset = keyof typeof motionPresets;
export type VideoIdeaProvider = "chatgpt";
export type VideoMotion = { preset: VideoMotionPreset; intensity: number };
export type VideoIdeaInput = {
  topic: string; category: VideoIdeaCategory; format: VideoFormat; provider: VideoIdeaProvider;
  language: VideoProject["language"]; sceneCount: number; durationSec: number;
};
export type VideoIdeaMetadata = {
  version: 1; topic: string; category: VideoIdeaCategory; provider: string;
  createdAt: string; reviewRequired: true; motionSkill: "toris-video-motion";
};
export type StudioVideoScene = VideoScene & { motion?: VideoMotion };
export type StudioVideoProject = Omit<VideoProject, "scenes"> & { scenes: StudioVideoScene[]; research?: VideoResearchMetadata; idea?: VideoIdeaMetadata };
export type VideoIdeaResult = { project: StudioVideoProject; provider: string; warnings: string[] };

const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export function readIdeaMetadata(value: unknown): VideoIdeaMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<VideoIdeaMetadata>;
  return candidate.version === 1 && typeof candidate.topic === "string" && candidate.topic.length <= 300
    && typeof candidate.category === "string" && owns(ideaCategories, candidate.category)
    && typeof candidate.provider === "string" && ["chatgpt", "opencodex", "teamclaude", "claude-cli"].includes(candidate.provider)
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
