import assert from "node:assert/strict";
import test from "node:test";
import { EARLY_EVENTS_PER_RUN, EARLY_RUNS, agentCall, applyEvent, bufferEarlyEvent, decide, diffLines, loadPanel, runTitle, saveSettings, startHub } from "../desktop/src/agent-client";
import type { RunEvent, RunSummary } from "../desktop/src/agent-client";

const base: RunSummary = { runId: "r1", project: "demo", task: "t", phase: "queued", agent: "supervisor", createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", approvals: [], changes: [], summary: "", events: [] };
const event = (seq: number, patch: Partial<RunEvent>): RunEvent => ({ event: "run", runId: "r1", seq, at: `2026-10-27T00:00:0${seq}Z`, agent: "supervisor", phase: "thinking", message: `m${seq}`, ...patch });

test("events apply in order; duplicates, stale and foreign events never rewind the run", () => {
  let run = applyEvent(base, event(1, {}))!;
  run = applyEvent(run, event(2, { agent: "frontend", phase: "awaiting_approval", approval: { kind: "run_command", id: "a1", agent: "frontend", command: ["pnpm", "test"], cwd: "demo", reason: "" } }))!;
  assert.deepEqual(run.approvals.map(a => a.id), ["a1"]);
  assert.equal(applyEvent(run, event(2, { phase: "done" })), run, "duplicate seq ignored");
  assert.equal(applyEvent(run, { ...event(9, {}), runId: "other" }), run);
  run = applyEvent(run, event(3, { agent: "frontend", phase: "testing", resolved: "a1" }))!;
  assert.deepEqual(run.approvals, [], "a decided approval clears");
  assert.equal(run.phase, "testing");
  run = applyEvent(run, event(4, { phase: "done", detail: "완료 요약", changes: ["src/a.ts"] }))!;
  assert.equal(run.summary, "완료 요약");
  assert.deepEqual(run.changes, ["src/a.ts"]);
  assert.equal(run.events.length, 4);
});

test("parallel lanes keep their own approvals; another lane's progress never hides one", () => {
  const write = { kind: "write_file" as const, id: "w1", agent: "frontend" as const, path: "src/ui.ts", diff: "", reason: "" };
  const cmd = { kind: "run_command" as const, id: "c1", agent: "backend" as const, command: ["cargo", "test"], cwd: "demo", reason: "" };
  let run = applyEvent(base, event(1, { agent: "frontend", phase: "awaiting_approval", approval: write }))!;
  run = applyEvent(run, event(2, { agent: "backend", phase: "reading", detail: "src/api.rs" }))!;
  assert.deepEqual(run.approvals.map(a => a.id), ["w1"], "backend reading does not clear frontend's request");
  assert.equal(run.phase, "awaiting_approval", "the run still waits for the user");
  run = applyEvent(run, event(3, { agent: "backend", phase: "awaiting_approval", approval: cmd }))!;
  assert.deepEqual(run.approvals.map(a => a.id), ["w1", "c1"]);
  run = applyEvent(run, event(4, { agent: "backend", phase: "testing", resolved: "c1" }))!;
  assert.deepEqual(run.approvals.map(a => a.id), ["w1"], "only the decided one closes");
  run = applyEvent(run, event(5, { agent: "supervisor", phase: "cancelled" }))!;
  assert.deepEqual(run.approvals, [], "a finished run has nothing to approve");
});

test("diff lines are typed for display", () => {
  const lines = diffLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same");
  assert.deepEqual(lines.map(l => l.kind), ["meta", "meta", "hunk", "del", "add", "ctx"]);
});

test("agent calls go through one allowlisted native command; keys are sent only on save", async () => {
  const calls: Array<[string, unknown]> = [];
  const call = async (command: string, args?: Record<string, unknown>) => { calls.push([command, args]); return {}; };
  await agentCall("run.start", { project: "demo", task: "t" }, call);
  const settings = { projectsRoot: "/p", ollamaUrl: "http://127.0.0.1:11434", agentModel: { provider: "codex-cli", model: "" }, contentModel: null, image: null, embedding: { provider: "local", model: "" } };
  await saveSettings(settings, { openai: "sk-test" }, call);
  assert.deepEqual(calls[0], ["agent_call", { method: "run.start", params: { project: "demo", task: "t" } }]);
  assert.deepEqual(calls[1], ["agent_settings_save", { input: { settings, keys: { openai: "sk-test" } } }]);
});

test("events for runs the tab does not know yet are buffered within fixed limits", () => {
  const buffer = new Map<string, RunEvent[]>();
  for (let i = 0; i < 300; i++) bufferEarlyEvent(buffer, { ...event(1, {}), seq: i + 1, runId: "same" });
  assert.equal(buffer.get("same")!.length, EARLY_EVENTS_PER_RUN, "per-run cap");
  assert.equal(buffer.get("same")!.at(-1)!.seq, 300, "newest kept");
  for (let i = 0; i < 50; i++) bufferEarlyEvent(buffer, { ...event(1, {}), runId: `run-${i}` });
  assert.equal(buffer.size, EARLY_RUNS, "run cap");
  assert.ok(buffer.has("run-49") && !buffer.has("same"), "oldest run dropped first");
});

test("a locked key store does not hide the runtime status, projects or runs", async () => {
  const vault = "OS 자격 증명 저장소 접근이 보류되었습니다.";
  const call = (async (command: string, args?: { method?: string }) => {
    if (command === "agent_settings_get") throw new Error(vault);
    if (args?.method === "status") return { version: "1.0.0", providers: [], chroma: false, projectsRoot: "/p" };
    if (args?.method === "projects.list") return { projects: [{ name: "demo", path: "/p/demo", stacks: [], scripts: {}, git: true }] };
    if (args?.method === "run.list") return { runs: [base] };
    throw new Error(`unexpected ${command} ${args?.method}`);
  }) as Parameters<typeof loadPanel>[0];
  const data = await loadPanel(call);
  assert.equal(data.status?.version, "1.0.0");
  assert.equal(data.settings, null);
  assert.deepEqual(data.projects.map(p => p.name), ["demo"]);
  assert.deepEqual(data.runs.map(r => r.runId), ["r1"]);
  assert.deepEqual(data.errors, [vault]);
});

test("model settings load when only the key store is locked; its warning still shows", async () => {
  const vault = "OS 자격 증명 저장소 접근이 보류되었습니다.";
  const view = { settings: { projectsRoot: "/p" }, keys: { anthropic: false }, chromaUrl: "http://127.0.0.1:8000", keyStore: vault };
  const call = (async (command: string, args?: { method?: string }) => {
    if (command === "agent_settings_get") return view;
    if (args?.method === "status") return { version: "1.0.0", providers: [], chroma: true, projectsRoot: "/p" };
    if (args?.method === "projects.list") return { projects: [] };
    return { runs: [] };
  }) as Parameters<typeof loadPanel>[0];
  const data = await loadPanel(call);
  assert.equal(data.settings?.settings.projectsRoot, "/p");
  assert.deepEqual(data.errors, [vault]);
});

test("hub runs start and decide through the host commands; code runs keep run.resume", async () => {
  const calls: Array<[string, unknown]> = [];
  const call = async (command: string, args?: Record<string, unknown>) => { calls.push([command, args]); return { runId: "r" }; };
  await startHub("weekly-content", "", call);
  await decide({ runId: "r", workflow: "weekly-content" }, "a1", "approve", "", call);
  await decide({ runId: "r2", workflow: "coding" }, "a2", "reject", "아니요", call);
  await decide({ runId: "r3" }, "a3", "approve", "", call);
  assert.deepEqual(calls, [
    ["hub_start", { workflow: "weekly-content", task: "" }],
    ["hub_decide", { runId: "r", actionId: "a1", decision: "approve", feedback: "" }],
    ["agent_call", { method: "run.resume", params: { runId: "r2", actionId: "a2", decision: "reject", feedback: "아니요" } }],
    ["agent_call", { method: "run.resume", params: { runId: "r3", actionId: "a3", decision: "approve", feedback: "" } }],
  ]);
  assert.equal(runTitle({ workflow: "ops-triage", project: "" }), "운영 점검");
  assert.equal(runTitle({ workflow: "coding", project: "demo" }), "demo");
});

test("model auto-assign: first signed-in subscription CLI in order, saved for both slots", async () => {
  const { AUTO_MODEL_ORDER, pickDetected, autoAssignModel } = await import("../desktop/src/agent-client");
  assert.deepEqual([...AUTO_MODEL_ORDER], ["claude-cli", "codex-cli", "gemini-cli", "cursor-cli", "kiro-cli"]);
  const check = (provider: string, state: string, models: string[], source = "account") => ({ provider, state, detail: "", models: models.map(id => ({ id, label: id })), source, checkedAt: "" }) as never;
  assert.equal(pickDetected([check("claude-cli", "signed-out", ["sonnet"]), check("codex-cli", "missing", [])]), null, "signed-out and missing never count");
  assert.deepEqual(pickDetected([check("claude-cli", "signed-out", ["sonnet"]), check("codex-cli", "connected", ["gpt-6-astra"])]), { provider: "codex-cli", model: "gpt-6-astra" });
  assert.deepEqual(pickDetected([check("claude-cli", "connected", ["sonnet", "opus"], "suggested")]), { provider: "claude-cli", model: "sonnet" });
  assert.deepEqual(pickDetected([check("codex-cli", "connected", ["gpt-5.5"], "suggested")]), { provider: "codex-cli", model: "" }, "a built-in suggestion may not exist on this account: use the CLI's own default");
  assert.deepEqual(pickDetected([check("gemini-cli", "connected", ["gemini-2.5-pro"], "suggested")]), { provider: "gemini-cli", model: "" });
  assert.deepEqual(pickDetected([check("kiro-cli", "connected", ["auto", "claude-opus-5.5"], "account")]), { provider: "kiro-cli", model: "auto" }, "the account's own list is trusted");

  const empty = { projectsRoot: "/p", ollamaUrl: "http://127.0.0.1:11434", agentModel: null, contentModel: null, image: null, embedding: { provider: "local", model: "" } };
  const calls: Array<[string, unknown]> = [];
  const states: Record<string, string> = { "claude-cli": "signed-out", "codex-cli": "connected" };
  const bridge = async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    if (command === "agent_settings_get") return { settings: empty, keys: {}, chromaUrl: "" };
    if (command === "agent_call") { const p = (args!.params as { provider: string }).provider; return check(p, states[p] ?? "missing", p === "codex-cli" ? ["gpt-6-astra"] : ["x"]); }
    if (command === "agent_settings_save") return args;
    throw new Error(command);
  };
  const result = await autoAssignModel(bridge);
  assert.deepEqual(result, { choice: { provider: "codex-cli", model: "gpt-6-astra" }, label: "Codex CLI" });
  assert.deepEqual(calls.filter(c => c[0] === "agent_call").map(c => (c[1] as { params: { provider: string } }).params.provider), ["claude-cli", "codex-cli"], "stops at the first connected CLI");
  const save = calls.find(c => c[0] === "agent_settings_save")![1] as { input: { settings: typeof empty; keys: Record<string, string> } };
  assert.deepEqual(save.input.settings.agentModel, { provider: "codex-cli", model: "gpt-6-astra" });
  assert.deepEqual(save.input.settings.contentModel, { provider: "codex-cli", model: "gpt-6-astra" });
  assert.deepEqual(save.input.keys, {}, "no API key is touched");

  const noop = async (settings: Record<string, unknown>) => {
    const seen: string[] = [];
    const out = await autoAssignModel(async (command: string) => { seen.push(command); if (command === "agent_settings_get") return { settings, keys: {}, chromaUrl: "" }; return check("claude-cli", "connected", ["sonnet"]); });
    return { out, seen };
  };
  assert.deepEqual(await noop({ ...empty, modelAutoSelect: false }), { out: null, seen: ["agent_settings_get"] }, "a user who cleared the models is left alone");
  assert.deepEqual(await noop({ ...empty, contentModel: { provider: "openai", model: "gpt-5" } }), { out: null, seen: ["agent_settings_get"] }, "an existing choice is never replaced");
});

test("saving with both models empty turns auto-assign off", async () => {
  const { withAutoSelect } = await import("../desktop/src/agent-client");
  const base = { projectsRoot: "/p", ollamaUrl: "", agentModel: null, contentModel: null, image: null, embedding: { provider: "local", model: "" } };
  assert.equal(withAutoSelect(base).modelAutoSelect, false);
  assert.equal(withAutoSelect({ ...base, agentModel: { provider: "claude-cli", model: "sonnet" } }).modelAutoSelect, true);
});

test("CLI login: provider ids map to the closed tool list and only the tool name crosses IPC", async () => {
  const { CLI_LOGIN_TOOL, startCliLogin } = await import("../desktop/src/agent-client");
  assert.deepEqual(CLI_LOGIN_TOOL, { "claude-cli": "claude", "codex-cli": "codex", "gemini-cli": "gemini", "cursor-cli": "cursor", "kiro-cli": "kiro" });
  const calls: unknown[] = [];
  await startCliLogin("gh", async (command, args) => { calls.push([command, args]); return { started: true }; });
  assert.deepEqual(calls, [["agent_cli_login", { tool: "gh" }]]);
});
