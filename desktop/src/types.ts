export const SOCIAL_PLATFORMS = ["youtube", "threads", "naver_blog", "tiktok", "instagram", "facebook"] as const;
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
    /** Actual source-provided excerpt; older collected rows may not have one. */
    description?: string;
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

export type KeywordSearchMode = "local" | "official";
export type KeywordSource = TrendSource | "all";
export type KeywordCrawler = "crawl4ai" | "firecrawl";
export interface KeywordStatus {
  databaseConnected: boolean;
  libraryCount: number;
  indexLimit: number;
  sources: { id: string; name: string; configured: boolean }[];
  engines: { id: string; name: string; endpoint: string | null; available: boolean }[];
  running: boolean;
}
export interface KeywordEvidence {
  field: "title" | "description" | "observed_query" | "source_topic" | "body";
  terms: string[];
}
export interface ObservedKeyword {
  keyword: string;
  source: string;
  observedAt: string;
  rank?: number | null;
}
export interface ExtractedKeyword {
  keyword: string;
  score: number;
  occurrences: number;
}
export interface KeywordContent {
  trend: SocialTrend;
  matches: KeywordEvidence[];
  observedKeywords: ObservedKeyword[];
  extractedKeywords: ExtractedKeyword[];
  libraryCount?: number;
  originalKeyword?: string;
  /** Only returned by get_content_keywords; search pages do not include full text. */
  body?: string;
  crawledAt?: string | null;
  crawlEngine?: string | null;
}
export interface KeywordSearchResult {
  query: string;
  mode: KeywordSearchMode;
  items: KeywordContent[];
  total: number;
  libraryCount: number;
  indexLimit: number;
  truncated: boolean;
  searchedAt: string;
  runId?: string | null;
  warnings: string[];
}
export interface KeywordRun {
  id: string;
  query: string;
  source: KeywordSource;
  searchedAt: string;
  resultCount: number;
  results: { url: string; title: string; source: string; rank: number }[];
}
export interface KeywordCrawlResult {
  trendId: string;
  engine: KeywordCrawler;
  url: string;
  title: string;
  text: string;
  extractedKeywords: ExtractedKeyword[];
  observedAt: string;
  warnings: string[];
}
