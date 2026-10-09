import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SocialRepository } from "../lib/social/repository";
import { stableTrendId } from "../lib/social/trend-parsers";
import type { SocialTrend } from "../lib/social/types";

test("local PostgreSQL persists CRUD, enforces channel platform, and compares prior real snapshots", {
  skip: process.env.TORIS_SOCIAL_DATABASE_INTEGRATION !== "1" || !process.env.DATABASE_URL,
}, async () => {
  const db = new pg.Pool({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, max: 3});
  await db.query("SELECT 1");
  const repo = new SocialRepository(db);
  let channelId: string | undefined;
  let contentId: string | undefined;
  const trendUrl = `https://www.youtube.com/watch?v=${randomUUID()}`;
  const keyword = `integration-${randomUUID()}`;
  try {
    const channel = await repo.createChannel({platform: "youtube", name: "통합 검증 임시 채널", handle: "@integration-test", url: "https://www.youtube.com/@integration-test"});
    channelId = channel.id;
    const content = await repo.createContent({platform: "youtube", channelId, title: "통합 검증 임시 초안", body: "보존 확인", status: "draft"});
    contentId = content.id;
    const updated = await repo.updateContent(content.id, {status: "ready", title: "변경 검증"});
    assert.equal(updated.status, "ready");
    await repo.updateContent(content.id, {body: "두 번째 저장도 성공"});
    await assert.rejects(repo.createContent({platform: "threads", channelId, title: "불일치", body: "", status: "draft"}));
    const records = await repo.dashboardRecords();
    assert.equal(records.content.find((item) => item.id === content.id)?.body, "두 번째 저장도 성공");
    const previous = new Date(Date.now() - 86400000).toISOString();
    const now = new Date().toISOString();
    const makeTrend = (views: number, at: string): SocialTrend => ({id: stableTrendId("youtube", trendUrl, keyword), source: "youtube", keyword,
      title: "실제 스냅샷 통합 검증", url: trendUrl, metric: `${views} 조회`, region: "KR", publishedAt: null, fetchedAt: at,
      details: {discovery: "youtube_popular", viewCount: views}});
    await repo.saveTrends([makeTrend(100, previous)]);
    await repo.saveTrends([makeTrend(175, now)]);
    const trends = await db.query("SELECT details FROM social_trends WHERE url=$1", [trendUrl]);
    assert.equal(trends.rows[0].details.viewGrowth, 75);
    assert.equal(new Date(trends.rows[0].details.previousObservedAt).toISOString(), previous);
  } finally {
    if (contentId) await db.query("DELETE FROM social_content WHERE id=$1", [contentId]);
    if (channelId) await db.query("DELETE FROM social_channels WHERE id=$1", [channelId]);
    await db.query("DELETE FROM social_trends WHERE url=$1", [trendUrl]);
    await db.query("DELETE FROM social_trend_snapshots WHERE url=$1", [trendUrl]);
    await db.end();
  }
});
