import assert from "node:assert/strict";
import test from "node:test";
import { STATE_LABELS, draftError, emptyDraft, isStale, needsAttention, openTask, orderedStatuses, productInput, saveProduct, saveSecret, type OpsStatus } from "../desktop/src/ops-client";

const status = (source: OpsStatus["source"], state: OpsStatus["state"], observedAt = "2026-10-27T03:00:00Z"): OpsStatus => ({ source, state, summary: "", detail: {}, observedAt });

test("separate states keep separate wording", () => {
  assert.notEqual(STATE_LABELS.passing.label, STATE_LABELS.deployed.label);
  assert.notEqual(STATE_LABELS.deployed.label, STATE_LABELS.healthy.label);
  assert.match(STATE_LABELS.in_review.label, /미공개/);
  assert.notEqual(STATE_LABELS.in_review.tone, "good", "review is never shown as a success");
  assert.equal(STATE_LABELS.deployed.tone, "info", "a deploy is not proof of health");
});

test("only failures ask for a task", () => {
  assert.deepEqual((["failing", "deploy_failed", "unhealthy", "halted", "error"] as const).map(s => needsAttention(status("http", s))), [true, true, true, true, true]);
  assert.deepEqual((["passing", "deployed", "healthy", "in_review", "public", "draft", "running", "unknown"] as const).filter(s => needsAttention(status("http", s))), []);
});

test("stale snapshots and source order", () => {
  const now = new Date("2026-10-27T04:30:00Z");
  assert.equal(isStale(status("http", "healthy", "2026-10-27T04:00:00Z"), now), false);
  assert.equal(isStale(status("http", "healthy", "2026-10-27T03:00:00Z"), now), true);
  assert.equal(isStale(status("http", "healthy", "nope"), now), true);
  assert.deepEqual(orderedStatuses([status("play", "public"), status("http", "healthy"), status("github_ci", "passing")]).map(s => s.source), ["github_ci", "http", "play"]);
});

test("draft validation mirrors the native rules", () => {
  const draft = { ...emptyDraft(), name: "앱" };
  assert.equal(draftError(draft), null);
  assert.ok(draftError({ ...draft, name: " " }));
  assert.ok(draftError({ ...draft, githubRepo: "../../etc" }));
  assert.ok(draftError({ ...draft, githubRepo: "a/b/c" }));
  assert.ok(draftError({ ...draft, cloudflareWorker: "Bad_Name" }));
  assert.ok(draftError({ ...draft, healthUrl: "http://example.com" }));
  assert.ok(draftError({ ...draft, playPackage: "nodots" }));
  assert.equal(draftError({ ...draft, githubRepo: "torisKR/toris_app", cloudflarePages: "toris-site", healthUrl: "https://toris.kr/health", playPackage: "com.toris.app" }), null);
});

test("IPC payloads carry only allowed fields and never echo secrets", async () => {
  const calls: Array<[string, unknown]> = [];
  const call = async (command: string, args?: Record<string, unknown>) => { calls.push([command, args]); return { github_token: true }; };
  await saveProduct({ ...emptyDraft(), name: " 앱 ", githubRepo: " o/r ", token: "x" } as never, call);
  assert.deepEqual(calls[0], ["ops_save_product", { input: { name: "앱", kind: "app", githubRepo: "o/r", cloudflareWorker: null, cloudflarePages: null, healthUrl: null, playPackage: null } }]);
  assert.deepEqual(Object.keys(productInput({ ...emptyDraft(), id: "p1", name: "x" })).sort(), ["cloudflarePages", "cloudflareWorker", "githubRepo", "healthUrl", "id", "kind", "name", "playPackage"]);
  const flags = await saveSecret("github_token", "ghp_value", call);
  assert.deepEqual(flags, { github_token: true });
  assert.deepEqual(calls[1], ["ops_save_secret", { kind: "github_token", value: "ghp_value" }]);
  await openTask("p1", "http", call);
  assert.deepEqual(calls[2], ["ops_open_task", { product: "p1", source: "http" }]);
});
