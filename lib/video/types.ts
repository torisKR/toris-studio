export type VideoFormat = "youtube-landscape" | "vertical" | "shorts";

export type SceneMediaType = "none" | "image" | "video" | "screen";
export type VideoTemplateId = "reference-briefing" | "adaptive-promo";
export type SceneRole = "hook" | "point" | "proof" | "reaction" | "cost" | "action" | "outro";
export type SceneLayout = "hero" | "split" | "media-focus" | "reaction-grid" | "action-card" | "social-hook" | "social-point" | "social-cta";

export type VideoScene = {
  id: string;
  eyebrow?: string;
  headline: string;
  body: string;
  narration: string;
  durationSec: number;
  sourceLabel?: string;
  sourceUrl?: string;
  mediaType?: SceneMediaType;
  mediaUrl?: string;
  mediaFit?: "contain" | "cover";
  captionCues?: Array<{ startSec: number; endSec: number; text: string }>;
  audioPath?: string;
  accent?: string;
  role?: SceneRole;
  layout?: SceneLayout;
  badge?: string;
};

export type VideoProject = {
  id: string;
  title: string;
  subtitle?: string;
  format: VideoFormat;
  template: VideoTemplateId;
  language: "ko" | "ja" | "zh" | "en";
  scenes: VideoScene[];
  createdAt: string;
  updatedAt: string;
};

export type RenderRecord = {
  id: string;
  projectId: string;
  status: "queued" | "rendering" | "completed" | "failed";
  format: VideoFormat;
  outputPath?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
};

export type ProjectPatch = Partial<Omit<VideoProject, "id" | "createdAt">>;
