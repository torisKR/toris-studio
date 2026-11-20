import assert from "node:assert/strict";
import test from "node:test";
import { readiness, type ReadinessInput } from "../desktop/src/SettingsReadiness";

const fresh: ReadinessInput = { database: false, contentModel: false, image: false, youtubeKey: false, youtubeLogin: false, naverKey: false, naverBroker: false, snsConnections: 0 };
const row = (rows: ReturnType<typeof readiness>, id: string) => rows.find(r => r.id === id)!;

test("fresh install: every feature lists what is missing and one fix", () => {
  const rows = readiness(fresh);
  assert.deepEqual(rows.map(r => r.id), ["ai-writing", "image", "database", "youtube", "naver", "sns"]);
  assert.ok(rows.every(r => !r.ready && r.missing && r.fix), "nothing is ready and each row has a fix");
  assert.equal(row(rows, "database").fix, "start_database");
  assert.equal(row(rows, "ai-writing").fix, "open_agent");
  assert.equal(row(rows, "youtube").fix, "open_sns");
});

test("alternatives count: a YouTube login replaces the key, the Toris broker replaces the Naver key", () => {
  const rows = readiness({ ...fresh, database: true, contentModel: true, youtubeLogin: true, naverBroker: true, snsConnections: 1 });
  for (const id of ["ai-writing", "database", "youtube", "naver", "sns"]) assert.equal(row(rows, id).ready, true, id);
  assert.equal(row(rows, "image").ready, false, "images still need an API key");
  assert.equal(row(rows, "sns").fix, null);
});

test("SNS needs both a connection and the database", () => {
  assert.equal(row(readiness({ ...fresh, snsConnections: 2 }), "sns").ready, false);
  assert.equal(row(readiness({ ...fresh, snsConnections: 2 }), "sns").fix, "start_database");
});
