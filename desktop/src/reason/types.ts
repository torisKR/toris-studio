import type { ProductionInput } from "../production/production-client";

export type NetworkState = "missing" | "setup_required" | "connected" | "error";
export type ReasonPeer = { id: string; name: string; kind: string; machine: string | null; cwd: string | null; branch: string | null; busy: boolean };
export type StoryboardPreview = {
  title: string; story: string;
  scenes: Array<{ id: string; durationSec: number; script: string; narration: string; caption: string }>;
};
export type VideoRequest = { schema: "toris-studio.video.v1"; requestId: string; settings: ProductionInput; storyboard?: StoryboardPreview };
export type ReasonMessage = {
  id: string; from: string; fromName: string | null; text: string; createdAt: string | null; replyTo: string | null;
  video: VideoRequest | null; requestError: string | null; jobId: string | null;
  sns: SnsRequest | null; snsVia: string | null; snsImport: SnsImport | null;
};
export type SnsPlatform = "youtube" | "instagram" | "facebook" | "threads" | "tiktok" | "naver_blog" | "naver_clip" | "x";
export type SnsPost = { platform: SnsPlatform; title?: string; text: string; hashtags: string[] };
export type SnsRequest = {
  schema: "toris-studio.sns.v1"; requestId: string; title: string; posts: SnsPost[];
  media: { kind: "videoJob" | "media"; id: string } | null; scheduleAt: string | null;
};
export type SnsImport = { state: "pending" | "imported"; platforms: SnsPlatform[]; contentDrafts: number; publicationDrafts: number; mediaAttached: boolean; updatedAt: string };
export type SnsHandoff = { code: string; assistant: string; prompt: string };
export type HostedAssistant = "muse" | "dots" | "grok";
export type NetworkSnapshot = { state: NetworkState; version: string | null; selfId: string | null; peers: ReasonPeer[]; messages: ReasonMessage[]; error: string | null };
export type VideoResult = { jobId: string; status: string; stage: string; title: string; hasVideo: boolean; requiresApproval: boolean; summary: string };
export type ProductionSelection = { jobId: string; requestId: number };
export type SendReceipt = { messageIds: string[] };
