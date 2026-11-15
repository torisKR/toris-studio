import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeInvoke } from "../desktop/src/ai-client";
import { normalizeSnapshot } from "../desktop/src/reason/reason-client";
import {
  createSnsHandoff, importSnsRequest, localToRfc3339, parseHashtags, postLength, sendSnsResult, snsRequest, SNS_REQUEST_EXAMPLE
} from "../desktop/src/reason/sns-client";

const request = JSON.parse(SNS_REQUEST_EXAMPLE);
const base = { id: "m1", from: "toris/peer", fromName: "Peer", text: SNS_REQUEST_EXAMPLE, createdAt: null, replyTo: null, video: null, requestError: null, jobId: null };
const snapshot = (message: Record<string, unknown>) => ({ state: "connected", version: "0.12.17", selfId: "toris/studio", peers: [], messages: [message], error: null });

test("the example is a valid toris-studio.sns.v1 request within platform limits", () => {
  const parsed = snsRequest(request);
  assert.ok(parsed);
  assert.equal(parsed.posts.length, 3);
  for (const post of parsed.posts) assert.ok(postLength(post.text, post.hashtags) <= (post.platform === "x" ? 280 : 2200));
});

test("snapshot keeps host-classified SNS plans and their import state", () => {
  const message = normalizeSnapshot(snapshot({ ...base, sns: request, snsVia: "Muse", snsImport: { state: "imported", platforms: ["threads", "x"], contentDrafts: 2, publicationDrafts: 1, mediaAttached: false, updatedAt: "" } })).messages[0];
  assert.equal(message.sns?.requestId, "sns-demo-001");
  assert.equal(message.snsVia, "Muse");
  assert.equal(message.snsImport?.contentDrafts, 2);
});

test("unknown platforms or duplicate platforms never become a reviewable plan", () => {
  for (const posts of [[{ platform: "linkedin", text: "a", hashtags: [] }], [request.posts[0], request.posts[0]], []]) {
    assert.equal(normalizeSnapshot(snapshot({ ...base, sns: { ...request, posts } })).messages[0].sns, null);
  }
  // Older hosts without the field still produce ordinary messages.
  assert.equal(normalizeSnapshot(snapshot(base)).messages[0].sns, null);
});

test("hashtags are split without # and dates carry an offset", () => {
  assert.deepEqual(parseHashtags("#단월 #업데이트, 게임 #단월"), ["단월", "업데이트", "게임"]);
  assert.match(localToRfc3339("2026-06-01T19:00") ?? "", /^2026-06-01T19:00:00[+-]\d\d:\d\d$/);
  assert.equal(localToRfc3339(""), null);
});

test("import sends only the message ID and reviewed posts; over-long posts are refused locally", async () => {
  const calls: Array<[string, unknown]> = [];
  const call: BridgeInvoke = async (command, args) => {
    calls.push([command, args]);
    return { reused: false, import: { state: "imported", platforms: ["threads"], contentDrafts: 1, publicationDrafts: 1, mediaAttached: false, updatedAt: "" } };
  };
  const result = await importSnsRequest({ messageId: "m1", title: " 제목 ", attachMedia: false, scheduleAt: null, posts: [{ platform: "threads", text: "본문", hashtags: ["단월"] }] }, call);
  assert.equal(result.import.contentDrafts, 1);
  assert.deepEqual(calls, [["reason_network_import_sns", { input: { messageId: "m1", title: "제목", attachMedia: false, posts: [{ platform: "threads", text: "본문", hashtags: ["단월"] }] } }]]);
  await assert.rejects(importSnsRequest({ messageId: "m1", title: "t", attachMedia: false, scheduleAt: null, posts: [{ platform: "x", text: "가".repeat(281), hashtags: [] }] }, call), /280자/);
  assert.equal(calls.length, 1);
});

test("handoff and result calls use their own closed commands", async () => {
  const calls: string[] = [];
  const call: BridgeInvoke = async command => {
    calls.push(command);
    return command === "reason_network_sns_handoff" ? { code: "TS-0123456789", assistant: "Muse", prompt: "[Toris Studio SNS 기획 요청 · TS-0123456789]" } : { messageIds: ["r1"] };
  };
  const handoff = await createSnsHandoff("muse", "업데이트 홍보", ["threads"], call);
  assert.equal(handoff.code, "TS-0123456789");
  assert.deepEqual((await sendSnsResult("m1", call)).messageIds, ["r1"]);
  await assert.rejects(createSnsHandoff("muse", "", ["threads"], call));
  await assert.rejects(createSnsHandoff("muse", "x", [], call));
  assert.deepEqual(calls, ["reason_network_sns_handoff", "reason_network_send_sns_result"]);
});
