import { parseGoogleTrendsRss, parseNaverBlogs, parseYouTubeVideos } from "./trend-parsers";
import type { SocialTrend } from "./types";

const MAX_RESPONSE_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 8000;
export interface TrendCollection { trends: SocialTrend[]; warnings: string[]; }

async function boundedFetch(url: URL, headers?: Record<string, string>) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error("Source temporarily unavailable");
  if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) throw new Error("Source response too large");
  if (!response.body) throw new Error("Empty source response");
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Source response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString("utf8");
}

async function youtubeRequest(resource: "search" | "videos" | "channels", params: Record<string, string>, key: string) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [name, value] of Object.entries({ ...params, key })) url.searchParams.set(name, value);
  return JSON.parse(await boundedFetch(url)) as { items?: Array<{ id?: unknown; snippet?: { channelId?: string } }> };
}

async function collectYouTube(key: string, now: string, keyword?: string) {
  let params: Record<string, string> = { part: "snippet,statistics,contentDetails", chart: "mostPopular", regionCode: "KR", maxResults: "25" };
  if (keyword) {
    const after = new Date(Date.parse(now) - 60 * 86400000).toISOString();
    const search = await youtubeRequest("search", { part: "id", type: "video", q: keyword, regionCode: "KR",
      relevanceLanguage: "ko", order: "viewCount", publishedAfter: after, maxResults: "25" }, key);
    const ids = (search.items ?? []).flatMap((entry) => {
      const id = (entry.id as {videoId?: unknown})?.videoId;
      return typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id) ? [id] : [];
    });
    if (!ids.length) return [];
    params = { part: "snippet,statistics,contentDetails", id: ids.join(",") };
  }
  const videos = await youtubeRequest("videos", params, key);
  const ids = [...new Set((videos.items ?? []).map((entry) => entry.snippet?.channelId).filter((id): id is string => !!id))].slice(0, 50);
  let channels: unknown;
  if (ids.length) {
    // Missing channel statistics does not discard usable video source data.
    channels = await youtubeRequest("channels", { part: "statistics", id: ids.join(",") }, key).catch(() => undefined);
  }
  return parseYouTubeVideos(videos, now, keyword, channels);
}

export async function collectSocialTrends(keyword?: string): Promise<TrendCollection> {
  const now = new Date().toISOString();
  const jobs: Array<{name: string; run: () => Promise<SocialTrend[]>}> = [{
    name: "Google Trends 한국 RSS",
    run: async () => {
      const feed = await boundedFetch(new URL("https://trends.google.com/trending/rss?geo=KR"));
      const trends = parseGoogleTrendsRss(feed, now);
      return keyword ? trends.filter((item) => item.keyword.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) : trends;
    },
  }];
  const youtubeKey = process.env.YOUTUBE_DATA_API_KEY;
  if (youtubeKey) jobs.push({name: "YouTube Data API", run: () => collectYouTube(youtubeKey, now, keyword)});
  const naverId = process.env.NAVER_CLIENT_ID;
  const naverSecret = process.env.NAVER_CLIENT_SECRET;
  if (keyword && naverId && naverSecret) jobs.push({
    name: "네이버 블로그 검색", run: async () => {
      const url = new URL("https://openapi.naver.com/v1/search/blog.json");
      url.searchParams.set("query", keyword);
      url.searchParams.set("display", "20");
      url.searchParams.set("sort", "date");
      return parseNaverBlogs(JSON.parse(await boundedFetch(url, {
        "X-Naver-Client-Id": naverId, "X-Naver-Client-Secret": naverSecret,
      })), keyword, now);
    },
  });
  const results = await Promise.allSettled(jobs.map((job) => job.run()));
  const trends: SocialTrend[] = [];
  const warnings: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") trends.push(...result.value);
    else warnings.push(`${jobs[index].name} 수집에 실패했습니다. 기존 관측 데이터는 유지됩니다.`);
  });
  if (keyword && !youtubeKey && !(naverId && naverSecret)) {
    warnings.push("검색어는 Google의 현재 인기 키워드에서만 필터링됩니다. YouTube/네이버 검색에는 서버 API 설정이 필요합니다.");
  }
  return { trends: trends.slice(0, 100), warnings };
}
