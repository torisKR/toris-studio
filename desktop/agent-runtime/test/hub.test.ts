import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkDrafts, checkTriage, contentContext, contentPayload, failingStatuses, templateDrafts } from "../src/harness/hub.js";
import { defaultWorkflows } from "../src/harness/registry.js";
import { RunManager } from "../src/graph/runs.js";
import { Runtime, parseSettings } from "../src/runtime.js";
import { RoleModel } from "../src/harness/testing.js";

const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const context = contentContext({
  now: "2026-10-27T00:00:00Z",
  channels: [{ id: id(1), platform: "threads", name: "토리스" }, { id: "not-a-uuid", platform: "threads", name: "x" }, { id: id(2), platform: "myspace", name: "y" }],
  content: [{ title: "이미 쓴 글" }],
  trends: [{ keyword: "AI", title: "AI 팁", url: "https://www.youtube.com/watch?v=a", source: "youtube" }, { keyword: "x", title: "평문", url: "http://plain.example.com", source: "web" }],
});

test("host input is bounded and malformed rows are dropped", () => {
  assert.deepEqual(context.channels.map(c => c.id), [id(1)]);
  assert.deepEqual(context.trends.map(t => t.url), ["https://www.youtube.com/watch?v=a"], "only https trend links can be cited");
  assert.equal(contentContext({ now: "garbage" }, new Date("2026-01-01T00:00:00Z")).now.toISOString(), "2026-01-01T00:00:00.000Z");
});

test("draft checks: links come only from trends, titles are new, times stay in range", () => {
  const { drafts, problems } = checkDrafts({ drafts: [
    { platform: "threads", title: "새 글", body: "본문", suggestedAt: "2026-10-28T09:00:00+09:00", sourceUrls: ["https://www.youtube.com/watch?v=a", "https://made-up.example.com"] },
    { platform: "threads", title: "이미 쓴 글", body: "본문" },
    { platform: "threads", title: "새 글", body: "중복" },
    { platform: "fax", title: "팩스", body: "본문" },
    { platform: "instagram", title: "먼 미래", body: "본문", suggestedAt: "2027-06-01T00:00:00Z" },
    { platform: "instagram", title: "본문 없음", body: "  " },
  ] }, context);
  assert.deepEqual(drafts.map(d => d.title), ["새 글", "먼 미래"]);
  assert.deepEqual(drafts[0].sources, ["https://www.youtube.com/watch?v=a"]);
  assert.match(drafts[0].body, /참고 자료:\n- https:\/\/www\.youtube\.com/);
  assert.doesNotMatch(drafts[0].body, /made-up/);
  assert.equal(drafts[0].channelId, id(1), "a single matching channel is linked");
  assert.equal(drafts[0].scheduledAt, "2026-10-28T00:00:00.000Z");
  assert.equal(drafts[1].scheduledAt, null, "a time outside 14 days is cleared");
  assert.equal(drafts[1].channelId, null);
  assert.equal(problems.length, 6);
  assert.ok(drafts.every(d => !d.template));
  assert.deepEqual(checkDrafts("nonsense", context).drafts, []);
});

test("template drafts are labelled and never claim to be AI output", () => {
  const drafts = templateDrafts(context);
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].template);
  assert.match(drafts[0].title, /^\[템플릿\]/);
  assert.match(drafts[0].body, /AI가 쓴 글이 아니니/);
  assert.deepEqual(Object.keys(contentPayload(drafts[0])).sort(), ["body", "channelId", "platform", "scheduledAt", "status", "title", "url"]);
  assert.equal(contentPayload(drafts[0]).status, "draft", "drafts are never saved as scheduled or published");
  const timed = checkDrafts({ drafts: [{ platform: "threads", title: "시간 있는 글", body: "본문", suggestedAt: "2026-10-28T00:00:00Z" }] }, context).drafts[0];
  assert.equal(timed.scheduledAt, "2026-10-28T00:00:00.000Z");
  assert.equal(contentPayload(timed).status, "draft", "a suggested time is a note, not a schedule");
});

test("triage keeps real failures only and fills the ones the model skipped", () => {
  const failing = failingStatuses({ products: [
    { id: id(5), name: "앱", statuses: [{ source: "play", state: "in_review" }, { source: "github_ci", state: "failing", summary: "실패" }, { source: "github_ci", state: "failing" }] },
    { id: id(6), name: "웹", statuses: [{ source: "http", state: "unhealthy" }, { source: "shell", state: "error" }] },
    { id: "bad", name: "x", statuses: [{ source: "http", state: "error" }] },
  ] });
  assert.deepEqual(failing.map(f => f.productId + ":" + f.source), [id(5) + ":github_ci", id(6) + ":http"], "review is not a failure; unknown sources and ids are dropped");
  const { tasks, problems } = checkTriage({ tasks: [{ productId: id(6), source: "http", priority: 1, notes: "확인" }, { productId: id(9), source: "http" }, { productId: id(6), source: "http", priority: 3 }] }, failing);
  assert.deepEqual(tasks.map(t => [t.source, t.priority, t.template]), [["http", 1, false], ["github_ci", 2, true]]);
  assert.equal(problems.length, 2);
  assert.match(tasks[1].notes, /^\[템플릿\]/);
});

test("hub workflows run without a project and refuse a second concurrent run", () => {
  assert.deepEqual(defaultWorkflows().list().map(w => [w.id, w.needsProject]), [["coding", true], ["weekly-content", false], ["ops-triage", false]]);
  const settings = parseSettings({ projectsRoot: "/nonexistent-root-for-test", chromaUrl: "http://127.0.0.1:9" });
  const model = new RoleModel({ content: [() => new Promise<string>(() => {})] as never });
  const manager = new RunManager(() => settings, () => {}, () => model);
  const run = manager.start("../../etc", "", "weekly-content", { now: "2026-10-27T00:00:00Z" });
  assert.equal(run.project, "", "the project argument is ignored, never resolved");
  assert.throws(() => manager.start("", "", "weekly-content"), /같은 워크플로가 진행 중/);
  assert.throws(() => manager.start("", "작업", "coding"), /프로젝트를 선택/);
  manager.cancel(run.runId);
  manager.shutdown();
});

test("without a model, weekly content still offers template drafts and never calls them AI", async () => {
  const settings = parseSettings({ projectsRoot: "/nonexistent-root-for-test", chromaUrl: "http://127.0.0.1:9" });
  const manager = new RunManager(() => settings, () => {}, () => { throw new Error("Agent 탭의 모델 설정에서 사용할 모델을 선택하세요."); });
  const run = manager.start("", "", "weekly-content", { now: "2026-10-27T00:00:00Z", trends: [{ keyword: "AI", title: "AI 팁", url: "https://www.youtube.com/watch?v=a", source: "youtube" }] });
  let view = manager.get(run.runId);
  for (let i = 0; i < 100 && !view.approvals.length; i++) { await new Promise(r => setTimeout(r, 10)); view = manager.get(run.runId); }
  const approval = view.approvals[0];
  assert.equal(approval?.kind, "save_draft");
  if (approval?.kind !== "save_draft") return;
  assert.equal(approval.template, true);
  assert.match(approval.title, /^\[템플릿\]/);
  assert.equal(approval.payload.status, "draft");
  await manager.resume(run.runId, { actionId: approval.id, decision: "reject" });
  await manager.settled(run.runId);
  assert.equal(manager.get(run.runId).phase, "done");
  assert.match(manager.get(run.runId).summary, /0건 저장 · 1건 거절 \(템플릿\)/);
  const coding = parseSettings({ projectsRoot: tmpdir(), chromaUrl: "http://127.0.0.1:9" });
  assert.throws(() => new RunManager(() => coding, () => {}, () => { throw new Error("모델 없음"); }).start(path.basename(mkdtempSync(path.join(tmpdir(), "hub-"))), "x", "coding"), /모델 없음/, "the coding workflow still needs a model");
});

test("hub runs are started and resumed by the host only", async () => {
  const out: unknown[] = [];
  const runtime = new Runtime(event => out.push(event));
  runtime.settings = parseSettings({ projectsRoot: tmpdir(), chromaUrl: "http://127.0.0.1:9" });
  await assert.rejects(runtime.handle("run.start", { workflow: "ops-triage", input: { products: [] } }), /Studio 화면에서만/);
  const run = await runtime.handle("run.start", { workflow: "ops-triage", input: { products: [] }, host: true }) as { runId: string };
  await assert.rejects(runtime.handle("run.resume", { runId: run.runId, actionId: "x", decision: "approve" }), /Studio 화면에서 처리/);
  await assert.rejects(runtime.handle("run.start", { workflow: "nope", host: true }), /알 수 없는 워크플로/);
  runtime.shutdown();
});
