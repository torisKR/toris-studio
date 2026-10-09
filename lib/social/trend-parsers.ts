import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { SocialTrend, TrendSource } from "./types";

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}
function truncate(value: unknown, max: number) { return text(value).trim().slice(0, max); }
function timestamp(value: unknown): string | null {
  const raw = text(value);
  if (!raw || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}
function https(value: unknown): string | null {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.href.slice(0, 2048) : null;
  } catch { return null; }
}
export function stableTrendId(source: TrendSource, url: string, keyword: string) {
  return createHash("sha256").update(`${source}\n${url}\n${keyword}`).digest("hex").slice(0, 40);
}
export function parseGoogleTrendsRss(xml: string, fetchedAt: string): SocialTrend[] {
  if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error("Invalid Google Trends feed");
  }
  const parsed = new XMLParser({ ignoreAttributes: true, processEntities: false,
    parseTagValue: false, trimValues: true }).parse(xml);
  const entries = parsed?.rss?.channel?.item;
  if (!entries) return [];
  const items = Array.isArray(entries) ? entries : [entries];
  return items.slice(0, 50).flatMap((item): SocialTrend[] => {
    const keyword = truncate(item.title, 100);
    if (!keyword) return [];
    const link = `https://trends.google.com/trends/explore?geo=KR&q=${encodeURIComponent(keyword)}`;
    const traffic = truncate(item["ht:approx_traffic"], 80);
    return [{ id: stableTrendId("google_trends", link, keyword), source: "google_trends", keyword,
      title: keyword, url: link, metric: traffic ? `${traffic} 검색 (Google 추정치)` : null,
      region: "KR", publishedAt: timestamp(item.pubDate), fetchedAt, details: { discovery: "google_trending" } }];
  });
}

function count(value: unknown): number | undefined {
  const str = text(value);
  if (!/^\d+$/.test(str)) return undefined;
  const valueNumber = Number(str);
  return Number.isSafeInteger(valueNumber) && valueNumber >= 0 ? valueNumber : undefined;
}
export function parseIsoDuration(value: unknown): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text(value));
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
}

export function parseYouTubeVideos(payload: unknown, fetchedAt: string, keyword?: string,
  channelPayload?: unknown): SocialTrend[] {
  const channelCounts = new Map<string, number>();
  const channels = (channelPayload as {items?: unknown[]})?.items;
  if (Array.isArray(channels)) for (const raw of channels) {
    const item = raw as { id?: unknown; statistics?: { subscriberCount?: unknown; hiddenSubscriberCount?: boolean } };
    const subscribers = item.statistics?.hiddenSubscriberCount ? undefined : count(item.statistics?.subscriberCount);
    if (subscribers !== undefined) channelCounts.set(text(item.id), subscribers);
  }
  const items = (payload as {items?: unknown[]})?.items;
  if (!Array.isArray(items)) throw new Error("Invalid YouTube response");
  return items.slice(0, 50).flatMap((raw): SocialTrend[] => {
    const item = raw as { id?: unknown; snippet?: { title?: unknown; publishedAt?: unknown; channelId?: unknown; channelTitle?: unknown };
      statistics?: { viewCount?: unknown }; contentDetails?: { duration?: unknown } };
    const id = text(item.id);
    const title = truncate(item.snippet?.title, 300);
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id) || !title) return [];
    const link = `https://www.youtube.com/watch?v=${id}`;
    const key = keyword ?? title.slice(0, 100);
    const views = count(item.statistics?.viewCount);
    return [{ id: stableTrendId("youtube", link, key), source: "youtube", keyword: key, title,
      url: link, metric: views === undefined ? null : `${views.toLocaleString("ko-KR")} 조회`, region: "KR",
      publishedAt: timestamp(item.snippet?.publishedAt), fetchedAt,
      details: { discovery: keyword ? "youtube_keyword" : "youtube_popular", viewCount: views,
        subscriberCount: channelCounts.get(text(item.snippet?.channelId)),
        durationSeconds: parseIsoDuration(item.contentDetails?.duration), channelTitle: truncate(item.snippet?.channelTitle, 200) } }];
  }).sort((a, b) => (b.details?.viewCount ?? -1) - (a.details?.viewCount ?? -1)).slice(0, 10);
}

function stripMarkup(value: unknown) {
  return text(value).replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
export function parseNaverBlogs(payload: unknown, keyword: string, fetchedAt: string): SocialTrend[] {
  const items = (payload as {items?: unknown[]})?.items;
  if (!Array.isArray(items)) throw new Error("Invalid Naver response");
  return items.slice(0, 20).flatMap((raw): SocialTrend[] => {
    const item = raw as { title?: unknown; link?: unknown; postdate?: unknown };
    const link = https(item.link);
    const title = stripMarkup(item.title).trim().slice(0, 300);
    if (!link || !title) return [];
    const postdate = text(item.postdate);
    const date = /^\d{8}$/.test(postdate) ? `${postdate.slice(0, 4)}-${postdate.slice(4, 6)}-${postdate.slice(6, 8)}T00:00:00+09:00` : null;
    return [{ id: stableTrendId("naver_blog", link, keyword), source: "naver_blog", keyword, title, url: link,
      metric: null, region: "KR", publishedAt: timestamp(date), fetchedAt, details: { discovery: "naver_search" } }];
  });
}
