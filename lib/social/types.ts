export const SOCIAL_PLATFORMS = ["youtube", "threads", "naver_blog", "tiktok", "instagram"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const CONTENT_STATUSES = ["draft", "ready", "scheduled", "published"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export type TrendSource = "google_trends" | "youtube" | "naver_blog";

export interface SocialChannel {
  id: string;
  platform: SocialPlatform;
  name: string;
  handle: string;
  url: string;
  createdAt: string;
}

export interface SocialContent {
  id: string;
  platform: SocialPlatform;
  channelId: string | null;
  title: string;
  body: string;
  status: ContentStatus;
  scheduledAt: string | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialTrend {
  id: string;
  source: TrendSource;
  keyword: string;
  title: string;
  url: string;
  /** Source-reported text only. Search results have no popularity metric. */
  metric: string | null;
  region: "KR";
  publishedAt: string | null;
  fetchedAt: string;
  details?: {
    discovery: "google_trending" | "youtube_popular" | "youtube_keyword" | "naver_search";
    viewCount?: number;
    subscriberCount?: number;
    durationSeconds?: number;
    channelTitle?: string;
    previousObservedAt?: string;
    viewGrowth?: number;
  };
}

export interface SocialIntegration {
  id: string;
  name: string;
  status: "ready" | "unconfigured" | "manual" | "error";
  message: string;
  capabilities: string[];
}

export interface SocialDashboard {
  channels: SocialChannel[];
  content: SocialContent[];
  trends: SocialTrend[];
  integrations: SocialIntegration[];
  database: { connected: boolean; message: string };
}

export type CreateChannelInput = Pick<SocialChannel, "platform" | "name" | "handle" | "url">;
export type CreateContentInput = Pick<SocialContent, "platform" | "title" | "body" | "status"> &
  Partial<Pick<SocialContent, "channelId" | "scheduledAt" | "url">>;
export type UpdateContentInput = Partial<CreateContentInput>;

export interface TrendRefreshResult {
  dashboard: SocialDashboard;
  collected: number;
  saved: boolean;
  warnings: string[];
}
