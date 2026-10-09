import "server-only";
import { getDatabase } from "./database";
import { SocialRepository } from "./repository";
import { collectSocialTrends } from "./trend-collector";
import { refreshSchema } from "./schema";
import type { SocialDashboard, SocialIntegration, TrendRefreshResult } from "./types";

export function socialIntegrations(): SocialIntegration[] {
  const youtube = Boolean(process.env.YOUTUBE_DATA_API_KEY);
  const naver = Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);
  return [
    { id: "google_trends", name: "Google Trends 한국", status: "ready", capabilities: ["실시간 키워드 RSS"],
      message: "공개 RSS의 실제 검색 추정치를 수집합니다. 자체 생성한 인기도 점수는 없습니다." },
    { id: "youtube", name: "YouTube", status: youtube ? "ready" : "unconfigured", capabilities: ["채널 관리", "콘텐츠 계획", "인기 영상 조회", "키워드 검색 TOP 10"],
      message: youtube ? "한국 인기 영상 또는 최근 60일 검색 영상을 실제 조회수로 정렬합니다. 인기 목록에는 일반 영상도 포함됩니다." : "채널·초안 관리 가능. 인기 영상/키워드 검색에는 서버 YOUTUBE_DATA_API_KEY가 필요합니다." },
    { id: "naver_blog", name: "네이버 블로그", status: naver ? "ready" : "unconfigured", capabilities: ["채널 관리", "콘텐츠 계획", "블로그 검색"],
      message: naver ? "검색어로 최신 블로그 글을 조회합니다. 조회수/인기도 순위가 아닙니다." : "채널·초안 관리 가능. 검색에는 서버 NAVER_CLIENT_ID/SECRET이 필요합니다." },
    { id: "threads", name: "Threads", status: "manual", capabilities: ["채널 관리", "콘텐츠 계획", "게시 URL 기록"], message: "로컬 작성·예약 계획·게시 URL 기록을 지원합니다. 자동 게시·통계 연결은 제공하지 않습니다." },
    { id: "tiktok", name: "TikTok", status: "manual", capabilities: ["채널 관리", "콘텐츠 계획", "게시 URL 기록"], message: "로컬 작성·예약 계획·게시 URL 기록을 지원합니다. 자동 게시·통계 연결은 제공하지 않습니다." },
    { id: "instagram", name: "Instagram", status: "manual", capabilities: ["채널 관리", "콘텐츠 계획", "게시 URL 기록"], message: "로컬 작성·예약 계획·게시 URL 기록을 지원합니다. 자동 게시·통계 연결은 제공하지 않습니다." },
  ];
}

export function socialRepository() { return new SocialRepository(getDatabase()); }

export async function getSocialDashboard(): Promise<SocialDashboard> {
  const integrations = socialIntegrations();
  try {
    const records = await socialRepository().dashboardRecords();
    return { ...records, integrations, database: { connected: true, message: "로컬 PostgreSQL에 저장됩니다." } };
  } catch {
    return { channels: [], content: [], trends: [], integrations,
      database: { connected: false, message: "로컬 DB에 연결할 수 없습니다. npm run db:start 후 개발 서버를 다시 시작하세요." } };
  }
}

let lastRefresh = 0;
export class RefreshThrottledError extends Error {
  readonly code = "REFRESH_THROTTLED";
  constructor() { super("수집 요청은 30초 간격으로 실행할 수 있습니다."); }
}

export async function refreshSocialTrends(keyword?: string): Promise<TrendRefreshResult> {
  const input = refreshSchema.parse({ keyword });
  if (Date.now() - lastRefresh < 30000) throw new RefreshThrottledError();
  lastRefresh = Date.now();
  const collection = await collectSocialTrends(input.keyword);
  let saved = false;
  try {
    const repository = socialRepository();
    await repository.saveTrends(collection.trends);
    saved = collection.trends.length > 0;
  } catch {
    collection.warnings.push("DB 저장에 실패했습니다. 수집 결과는 현재 화면에만 표시되며 다음 방문까지 보존되지 않습니다.");
  }
  const dashboard = await getSocialDashboard();
  if (!saved && collection.trends.length) dashboard.trends = collection.trends;
  return { dashboard, collected: collection.trends.length, saved, warnings: collection.warnings };
}
