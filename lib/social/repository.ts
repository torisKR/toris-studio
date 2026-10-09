import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { SqlExecutor } from "./database";
import { channelSchema, contentSchema, contentPatchSchema, recordIdSchema } from "./schema";
import type { SocialChannel, SocialContent, SocialTrend, CreateChannelInput, CreateContentInput, UpdateContentInput } from "./types";

export class SocialRecordError extends Error {
  constructor(readonly code: "CHANNEL_MISMATCH" | "NOT_FOUND" | "CONFLICT", message: string) { super(message); }
}

function iso(value: Date | string) { return new Date(value).toISOString(); }
function channel(row: QueryResultRow): SocialChannel {
  return { id: row.id, platform: row.platform, name: row.name, handle: row.handle, url: row.url, createdAt: iso(row.created_at) };
}
function content(row: QueryResultRow): SocialContent {
  return { id: row.id, platform: row.platform, channelId: row.channel_id, title: row.title, body: row.body,
    status: row.status, scheduledAt: row.scheduled_at ? iso(row.scheduled_at) : null, url: row.url,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function trend(row: QueryResultRow): SocialTrend {
  return { id: row.id, source: row.source, keyword: row.keyword, title: row.title, url: row.url,
    metric: row.metric, region: "KR", publishedAt: row.published_at ? iso(row.published_at) : null, fetchedAt: iso(row.fetched_at), details: row.details ?? undefined };
}

export class SocialRepository {
  constructor(private readonly db: SqlExecutor) {}

  async dashboardRecords() {
    const [channels, contents, trends] = await Promise.all([
      this.db.query("SELECT * FROM social_channels ORDER BY created_at DESC LIMIT 200"),
      this.db.query("SELECT * FROM social_content ORDER BY updated_at DESC LIMIT 200"),
      this.db.query("SELECT * FROM social_trends ORDER BY fetched_at DESC, keyword ASC LIMIT 100"),
    ]);
    return { channels: channels.rows.map(channel), content: contents.rows.map(content), trends: trends.rows.map(trend) };
  }

  async createChannel(input: CreateChannelInput) {
    const data = channelSchema.parse(input);
    const result = await this.db.query(
      "INSERT INTO social_channels (id, platform, name, handle, url) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [randomUUID(), data.platform, data.name, data.handle, data.url],
    );
    return channel(result.rows[0]);
  }

  private async assertChannel(id: string | null | undefined, platform: string) {
    if (!id) return;
    const match = await this.db.query("SELECT id FROM social_channels WHERE id=$1 AND platform=$2", [id, platform]);
    if (!match.rows.length) throw new SocialRecordError("CHANNEL_MISMATCH", "채널과 플랫폼이 일치하지 않습니다.");
  }

  async createContent(input: CreateContentInput) {
    const data = contentSchema.parse(input);
    await this.assertChannel(data.channelId, data.platform);
    const result = await this.db.query(
      "INSERT INTO social_content (id, platform, channel_id, title, body, status, scheduled_at, url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [randomUUID(), data.platform, data.channelId ?? null, data.title, data.body, data.status, data.scheduledAt ?? null, data.url ?? null],
    );
    return content(result.rows[0]);
  }

  async updateContent(id: string, input: UpdateContentInput) {
    recordIdSchema.parse(id);
    const patch = contentPatchSchema.parse(input);
    const current = await this.db.query("SELECT *, updated_at::text AS updated_at_token FROM social_content WHERE id=$1", [id]);
    if (!current.rows.length) throw new SocialRecordError("NOT_FOUND", "콘텐츠를 찾을 수 없습니다.");
    const existing = content(current.rows[0]);
    const data = contentSchema.parse({ platform: existing.platform, channelId: existing.channelId, title: existing.title,
      body: existing.body, status: existing.status, scheduledAt: existing.scheduledAt, url: existing.url, ...patch });
    await this.assertChannel(data.channelId, data.platform);
    // Optimistic comparison prevents overlapping editor requests silently losing another edit.
    const result = await this.db.query(
      "UPDATE social_content SET platform=$2, channel_id=$3, title=$4, body=$5, status=$6, scheduled_at=$7, url=$8, updated_at=clock_timestamp() WHERE id=$1 AND updated_at=$9 RETURNING *",
      [id, data.platform, data.channelId ?? null, data.title, data.body, data.status, data.scheduledAt ?? null, data.url ?? null, current.rows[0].updated_at_token],
    );
    if (!result.rows.length) throw new SocialRecordError("CONFLICT", "다른 요청에서 수정했습니다. 새로고침 후 다시 시도하세요.");
    return content(result.rows[0]);
  }

  async saveTrends(trends: SocialTrend[]) {
    if (!trends.length) return;
    // One statement makes each refresh batch atomic. Empty/failed fetches never erase existing data.
    const params: unknown[] = [];
    const values = trends.slice(0, 100).map((item, index) => {
      params.push(item.id, item.source, item.keyword, item.title, item.url, item.metric, item.region, item.publishedAt, item.fetchedAt,
        JSON.stringify(item.details ?? {}));
      return `(${Array.from({length: 10}, (_, offset) => `$${index * 10 + offset + 1}`).join(",")})`;
    });
    await this.db.query(
      `WITH incoming (id,source,keyword,title,url,metric,region,published_at,fetched_at,details) AS (VALUES ${values.join(",")}),
       enriched AS (
         SELECT i.*, COALESCE(i.details::jsonb, '{}'::jsonb) ||
           CASE WHEN old.view_count IS NOT NULL AND i.details::jsonb ? 'viewCount'
           THEN jsonb_build_object('previousObservedAt', old.observed_at,
             'viewGrowth', (i.details::jsonb->>'viewCount')::bigint - old.view_count)
           ELSE '{}'::jsonb END AS enriched_details
         FROM incoming i
         LEFT JOIN LATERAL (
           SELECT view_count, observed_at FROM social_trend_snapshots
           WHERE source=i.source AND url=i.url AND observed_day < (i.fetched_at::timestamptz AT TIME ZONE 'Asia/Seoul')::date
           ORDER BY observed_day DESC LIMIT 1
         ) old ON true
       ), snapshots AS (
         INSERT INTO social_trend_snapshots (source,url,observed_day,observed_at,view_count)
         SELECT source,url,(fetched_at::timestamptz AT TIME ZONE 'Asia/Seoul')::date,
           fetched_at::timestamptz,(details::jsonb->>'viewCount')::bigint FROM incoming
         WHERE details::jsonb ? 'viewCount'
         ON CONFLICT (source,url,observed_day) DO NOTHING
       )
       INSERT INTO social_trends (id,source,keyword,title,url,metric,region,published_at,fetched_at,details)
       SELECT id,source,keyword,title,url,metric,region,published_at::timestamptz,fetched_at::timestamptz,enriched_details FROM enriched
       ON CONFLICT (source,url,keyword) DO UPDATE SET title=EXCLUDED.title, metric=EXCLUDED.metric,
         published_at=EXCLUDED.published_at, fetched_at=EXCLUDED.fetched_at, details=EXCLUDED.details`,
      params,
    );
  }
}
