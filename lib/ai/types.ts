export const AI_PLATFORMS = ["youtube", "threads", "naver_blog", "tiktok", "instagram"] as const;
export type AiPlatform = (typeof AI_PLATFORMS)[number];
export type AiProviderId = "opencodex" | "teamclaude" | "claude-cli";

export interface DraftInput {
  provider?: AiProviderId;
  platform: AiPlatform;
  topic: string;
  context?: string;
  model?: string;
}

export interface ProviderStatus {
  id: AiProviderId;
  label: string;
  configured: boolean;
  available: boolean;
  reachable: boolean;
  authenticated: boolean | null;
  generationVerified: boolean;
  detail: string;
  models?: string[];
}

export interface DraftResult {
  text: string;
  provider: AiProviderId;
  model: string;
}

export class AiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 503,
  ) {
    super(message);
    this.name = "AiError";
  }
}
