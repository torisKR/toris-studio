import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGoogleTrendsRss, parseYouTubeVideos, parseNaverBlogs, parseIsoDuration } from "../lib/social/trend-parsers";

const observedAt = "2026-10-08T04:00:00.000Z";

test("Google Trends preserves actual approximate traffic and source date without invented score", () => {
  const xml = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss"><channel>
    <item><title>한국 키워드</title><ht:approx_traffic>500+</ht:approx_traffic><pubDate>Thu, 08 Oct 2026 10:00:00 +0900</pubDate></item>
    <item><title>트래픽 없는 키워드</title></item></channel></rss>`;
  const data = parseGoogleTrendsRss(xml, observedAt);
  assert.equal(data.length, 2);
  assert.equal(data[0].keyword, "한국 키워드");
  assert.equal(data[0].metric, "500+ 검색 (Google 추정치)");
  assert.equal(data[1].metric, null);
  assert.equal(data[0].publishedAt, "2026-10-08T01:00:00.000Z");
  assert.equal(new URL(data[0].url).searchParams.get("q"), "한국 키워드");
  assert.equal("score" in data[0], false);
});

test("RSS refuses entity expansion, malformed XML, and oversized source responses", () => {
  assert.throws(() => parseGoogleTrendsRss('<!DOCTYPE rss [<!ENTITY x "private">]><rss/>', observedAt));
  assert.throws(() => parseGoogleTrendsRss('<rss><channel>', observedAt));
  assert.throws(() => parseGoogleTrendsRss('x'.repeat(2_000_001), observedAt));
  assert.deepEqual(parseGoogleTrendsRss('<rss><channel/></rss>', observedAt), []);
});

test("YouTube TOP 10 uses real views, duration and public subscribers; missing counts stay absent", () => {
  const videos = {items: Array.from({length: 12}, (_, i) => ({
    id: `abcdefghij${i.toString(16)}`, snippet: {title: `실제 영상 ${i}`, channelId: "channel1", channelTitle: "채널", publishedAt: observedAt},
    statistics: i === 0 ? {} : {viewCount: String(i * 1000)}, contentDetails: {duration: "PT1M30S"},
  }))};
  const channels = {items: [{id: "channel1", statistics: {subscriberCount: "12345", hiddenSubscriberCount: false}}]};
  const trends = parseYouTubeVideos(videos, observedAt, "테스트", channels);
  assert.equal(trends.length, 10);
  assert.equal(trends[0].details?.viewCount, 11000);
  assert.equal(trends[0].details?.durationSeconds, 90);
  assert.equal(trends[0].details?.subscriberCount, 12345);
  assert.equal(trends[0].details?.discovery, "youtube_keyword");
  const missing = parseYouTubeVideos({items: [{id: "abcdefghijk", snippet: {title: "통계 비공개"}}]}, observedAt);
  assert.equal(missing[0].metric, null);
  assert.equal(missing[0].details?.viewCount, undefined);
  assert.equal(parseIsoDuration("P1DT1H2M3S"), 90123);
  assert.equal(parseIsoDuration("not-a-duration"), undefined);
});

test("Naver strips source formatting and keeps no fabricated popularity measurement", () => {
  const trends = parseNaverBlogs({items: [
    {title: "<b>콘텐츠</b> &amp; 키워드", link: "https://blog.naver.com/example/1", postdate: "20261008"},
    {title: "bad", link: "javascript:alert(1)"},
  ]}, "콘텐츠", observedAt);
  assert.equal(trends.length, 1);
  assert.equal(trends[0].title, "콘텐츠 & 키워드");
  assert.equal(trends[0].metric, null);
  assert.equal(trends[0].details?.discovery, "naver_search");
});
