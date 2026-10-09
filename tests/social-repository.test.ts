import { test } from "node:test";
import assert from "node:assert/strict";
import type { QueryResultRow } from "pg";
import type { SqlExecutor, SqlResult } from "../lib/social/database";
import { SocialRepository, SocialRecordError } from "../lib/social/repository";

const id = "42c1570e-cef0-4274-b0da-1212676345ae";
const record = {id, platform: "youtube", channel_id: null, title: "old", body: "body", status: "draft", scheduled_at: null, url: null,
  created_at: "2026-10-08T01:00:00.000Z", updated_at: "2026-10-08T01:00:00.000Z", updated_at_token: "2026-10-08 01:00:00.000123+00"};
class RecordingDatabase implements SqlExecutor {
  calls: Array<{ sql: string; values?: unknown[] }> = [];
  constructor(private replies: QueryResultRow[][]) {}
  async query<T extends QueryResultRow>(sql: string, values?: unknown[]): Promise<SqlResult<T>> {
    this.calls.push({sql, values});
    const rows = this.replies.shift() ?? [];
    return { rows: rows as T[], rowCount: rows.length };
  }
}

test("content insertion binds untrusted SQL-like body as data", async () => {
  const body = "'); DROP TABLE social_channels; --";
  const db = new RecordingDatabase([[{...record, body}]]);
  const repository = new SocialRepository(db);
  const created = await repository.createContent({platform: "youtube", title: "제목", body, status: "draft"});
  assert.equal(created.body, body);
  assert.equal(db.calls[0].sql.includes(body), false);
  assert.equal(db.calls[0].values?.[4], body);
});

test("channel mismatch fails before writing content", async () => {
  const db = new RecordingDatabase([[]]);
  const repository = new SocialRepository(db);
  await assert.rejects(repository.createContent({platform: "threads", channelId: id, title: "제목", body: "본문", status: "draft"}),
    (error: unknown) => error instanceof SocialRecordError && error.code === "CHANNEL_MISMATCH");
  assert.equal(db.calls.length, 1);
});

test("invalid transition leaves existing row unchanged; overlapping updates report conflict", async () => {
  const db = new RecordingDatabase([[record]]);
  await assert.rejects(new SocialRepository(db).updateContent(id, {status: "scheduled"}));
  assert.equal(db.calls.length, 1);
  const concurrentDb = new RecordingDatabase([[record], []]);
  await assert.rejects(new SocialRepository(concurrentDb).updateContent(id, {title: "new"}),
    (error: unknown) => error instanceof SocialRecordError && error.code === "CONFLICT");
  assert.equal(concurrentDb.calls[1].values?.[8], record.updated_at_token);
});
