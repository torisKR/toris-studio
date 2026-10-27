import { END, START, StateGraph } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatMessage, ChatModel } from "../llm/types.js";
import type { ProjectInfo } from "../projects.js";
import type { AgentRole, ApprovalDecision, PendingAction, Phase } from "../protocol.js";
import { applyWrite, grepProject, listProjectDir, proposeEdit, proposeWrite, readProjectFile } from "../tools/fs.js";
import { runCommand, validateCommand } from "../tools/terminal.js";
import { UserError, clip, errorText, parseJsonObject } from "../util.js";
import { decide, type CommandOutcome } from "../harness/verify.js";
import { projectBrief, qaPlanPrompt, qaReviewPrompt, supervisorPrompt, workerPrompt } from "./prompts.js";
import { AgentState, type LanePlan, type State, type Update, type Worker } from "./state.js";

/** Model steps one expert lane may take over the whole run. */
export const MAX_TOTAL_STEPS = 60;
export const MAX_QA_ROUNDS = 3;
export const MAX_TEST_COMMANDS = 3;
const MAX_OBSERVATION = 12_000;
const KEEP_MESSAGES = 28;
/** Files that decide what a build or test command runs; changing one voids earlier command approvals. */
const MANIFESTS = new Set(["package.json", "pnpm-workspace.yaml", "Cargo.toml", "build.rs", "pyproject.toml", "setup.cfg", "tox.ini", "pubspec.yaml", "go.mod", "deno.json", "deno.jsonc"]);
const isManifest = (file: string) => {
  const name = path.posix.basename(file);
  return MANIFESTS.has(name) || /\.config\.[cm]?[jt]s$/.test(name) || /^tsconfig.*\.json$/.test(name);
};
export const WORKER_NAMES: Record<Worker, string> = { frontend: "Frontend Expert", backend: "Backend Expert" };

export type EmitExtra = { detail?: string; approval?: PendingAction; changes?: string[]; resolved?: string };

export interface RunContext {
  model: ChatModel;
  projectRoot: string;
  info: ProjectInfo;
  /** Data the host passed with run.start (workflows without a project read only this). */
  input: Record<string, unknown>;
  searchPath: string[];
  secrets: string[];
  signal: AbortSignal;
  emit(agent: AgentRole, phase: Phase, message: string, extra?: EmitExtra): void;
  /** Shows the approval and waits for the user's decision. Other lanes keep working meanwhile. */
  approve(action: PendingAction, message: string): Promise<ApprovalDecision>;
  search(query: string): Promise<string>;
  files(): string[];
}

export async function ask(ctx: RunContext, system: string, messages: ChatMessage[]): Promise<Record<string, unknown>> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ctx.model.complete({ system, messages: attempt ? [...messages, { role: "assistant", content: last }, { role: "user", content: "JSON 객체 하나만 다시 출력하세요." }] : messages, signal: ctx.signal });
    last = raw;
    try { return parseJsonObject(raw); } catch { /* retry once */ }
  }
  throw new UserError("모델이 형식에 맞는 JSON을 반환하지 않았습니다.");
}

function trim(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= KEEP_MESSAGES + 1) return messages;
  return [messages[0], { role: "user", content: "(이전 단계 일부 생략)" }, ...messages.slice(-KEEP_MESSAGES)];
}

function observe(messages: ChatMessage[], text: string): ChatMessage[] {
  return trim([...messages, { role: "user", content: `OBSERVATION:\n${clip(text, MAX_OBSERVATION)}` }]);
}

const isWorker = (value: unknown): value is Worker => value === "frontend" || value === "backend";
const names = (roles: Worker[]) => roles.map(role => WORKER_NAMES[role]).join("·");

/** The supervisor's lanes: one per expert, at most two. Falls back to the older single "route". */
export function parseLanes(decision: Record<string, unknown>): LanePlan[] {
  const lanes: LanePlan[] = [];
  for (const item of Array.isArray(decision.lanes) ? decision.lanes : []) {
    const lane = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (isWorker(lane.role) && !lanes.some(l => l.role === lane.role)) lanes.push({ role: lane.role, share: String(lane.share ?? "").slice(0, 2000) });
  }
  return lanes.length ? lanes : [{ role: decision.route === "backend" ? "backend" : "frontend", share: "" }];
}

/** Valid, distinct verification commands; accepts one argv or a list of them. Invalid ones are dropped. */
export function parseCommands(value: unknown): string[][] {
  const list = Array.isArray(value) && value.length && value.every(v => typeof v === "string") ? [value] : Array.isArray(value) ? value : [];
  const out: string[][] = [];
  for (const item of list) {
    if (out.length >= MAX_TEST_COMMANDS) break;
    try {
      const argv = validateCommand(item);
      if (!out.some(c => c.join("\u0000") === argv.join("\u0000"))) out.push(argv);
    } catch { /* not allowed; QA works without it */ }
  }
  return out;
}

/** Lanes QA names for rework; when it names none, every lane gets the feedback. */
export function reworkOf(value: unknown, lanes: LanePlan[]): Worker[] {
  const all = lanes.map(lane => lane.role);
  const named = Array.isArray(value) ? all.filter(role => value.includes(role)) : [];
  return named.length ? named : all;
}

function isApproved(pending: PendingAction, decision: ApprovalDecision): boolean {
  return decision.actionId === pending.id && decision.decision === "approve";
}
const feedbackOf = (decision: ApprovalDecision) => (typeof decision.feedback === "string" ? decision.feedback.slice(0, 2000) : "");

type Shared = { changes: Set<string>; diffs: Record<string, string> };
type LaneResult = { role: Worker; messages: ChatMessage[]; steps: number; summary: string; failed: string };

/** Approvals wait inside a lane (see RunContext.approve), so the graph never pauses and needs no checkpoints. */
export function buildGraph(ctx: RunContext) {
  // Commands the user already approved in this run run again without asking, until a manifest changes.
  const trusted = new Set<string>();

  async function command(agent: AgentRole, argv: string[], reason: string): Promise<{ log: string; exit: number | null }> {
    const key = argv.join("\u0000");
    const shown = argv.join(" ");
    if (trusted.has(key)) ctx.emit(agent, "testing", `승인한 명령을 다시 실행합니다: ${shown}`);
    else {
      const pending: PendingAction = { kind: "run_command", id: randomUUID(), agent, command: argv, cwd: ctx.info.name, reason: reason.slice(0, 500) };
      const decision = await ctx.approve(pending, `${agent === "qa" ? "검증 명령" : "명령 실행"} 승인을 기다립니다: ${shown}`);
      if (!isApproved(pending, decision)) {
        const feedback = feedbackOf(decision);
        ctx.emit(agent, "thinking", "사용자가 명령 실행을 거절했습니다.", { detail: feedback, resolved: pending.id });
        return { log: `$ ${shown}\n사용자가 이 명령을 거절했습니다.${feedback ? ` 피드백: ${feedback}` : ""}`, exit: null };
      }
      trusted.add(key);
      ctx.emit(agent, "testing", `실행 중: ${shown}`, { resolved: pending.id });
    }
    try {
      const result = await runCommand(argv, ctx.projectRoot, ctx.searchPath, ctx.secrets, ctx.signal);
      ctx.emit(agent, "testing", `명령 종료 (exit ${result.exitCode}): ${shown}`, { detail: clip(result.log, 4000) });
      return { log: `$ ${shown}\nexit=${result.exitCode}${result.timedOut ? " (시간 초과)" : ""} · ${Math.round(result.durationMs / 1000)}초\n${result.log}`, exit: result.exitCode };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      // A command that could not start verified nothing; it counts as failed.
      ctx.emit(agent, "testing", `명령을 시작하지 못했습니다: ${shown}`, { detail: errorText(error) });
      return { log: `$ ${shown}\nexit=127\n${errorText(error)}`, exit: 127 };
    }
  }

  async function write(role: Worker, pending: Extract<PendingAction, { kind: "write_file" }>, shared: Shared): Promise<string> {
    const decision = await ctx.approve(pending, `${pending.path} 변경 승인을 기다립니다.`);
    if (!isApproved(pending, decision)) {
      const feedback = feedbackOf(decision);
      ctx.emit(role, "thinking", "사용자가 거절했습니다. 다른 방법을 찾습니다.", { detail: feedback, resolved: pending.id });
      return `사용자가 이 작업을 거절했습니다.${feedback ? ` 피드백: ${feedback}` : ""}`;
    }
    try {
      applyWrite(ctx.projectRoot, pending);
    } catch (error) {
      ctx.emit(role, "thinking", "변경을 적용하지 못했습니다.", { detail: errorText(error), resolved: pending.id });
      return `적용 실패: ${errorText(error)}`;
    }
    shared.changes.add(pending.path);
    shared.diffs[pending.path] = pending.diff;
    if (isManifest(pending.path)) trusted.clear();
    ctx.emit(role, "coding", `${pending.path}에 변경을 적용했습니다.`, { changes: [...shared.changes], resolved: pending.id });
    return `${pending.path} 적용 완료.`;
  }

  function laneIntro(plan: LanePlan, state: State): string {
    const others = state.lanes.filter(lane => lane.role !== plan.role);
    const parallel = others.map(lane => `- ${WORKER_NAMES[lane.role]}: ${lane.share || "(나머지 작업)"}`).join("\n");
    return [
      state.brief,
      `너의 담당 (${WORKER_NAMES[plan.role]}):\n${plan.share || "작업 지시 전체"}`,
      parallel ? `동시에 일하는 다른 Expert:\n${parallel}\n그쪽 담당 파일은 수정하지 않는다. 같은 파일이 필요하면 edit_file이 실패할 수 있으니 다시 읽고 고친다.` : "",
    ].filter(Boolean).join("\n\n");
  }

  async function runLane(plan: LanePlan, state: State, shared: Shared): Promise<LaneResult> {
    const role = plan.role;
    let messages = state.transcripts[role] ?? [];
    let steps = state.steps[role] ?? 0;
    if (!messages.length) messages = [{ role: "user", content: laneIntro(plan, state) }];
    else if (state.feedback) messages = observe(messages, `QA 피드백 (수정 필요):\n${state.feedback}`);
    for (;;) {
      if (steps >= MAX_TOTAL_STEPS) return { role, messages, steps, summary: "", failed: `${WORKER_NAMES[role]}: 단계 한도(${MAX_TOTAL_STEPS})에 도달해 중단했습니다.` };
      steps++;
      ctx.emit(role, "thinking", "다음 단계를 정하고 있습니다.");
      let action: Record<string, unknown>;
      try { action = await ask(ctx, workerPrompt(role), messages); }
      catch (error) { if (ctx.signal.aborted) throw error; messages = observe(messages, `오류: ${errorText(error)}`); continue; }
      messages = [...messages, { role: "assistant", content: JSON.stringify(action) }];
      const name = String(action.action ?? "");
      const args = (action.args && typeof action.args === "object" ? action.args : {}) as Record<string, unknown>;
      const thought = String(action.thought ?? "").slice(0, 300);
      try {
        switch (name) {
          case "list_dir":
            ctx.emit(role, "reading", thought || "폴더를 살펴보고 있습니다.", { detail: String(args.path ?? ".") });
            messages = observe(messages, listProjectDir(ctx.projectRoot, String(args.path ?? ".")));
            break;
          case "read_file":
            ctx.emit(role, "reading", thought || "파일을 읽고 있습니다.", { detail: String(args.path) });
            messages = observe(messages, readProjectFile(ctx.projectRoot, String(args.path), Number(args.startLine) || undefined, Number(args.endLine) || undefined));
            break;
          case "search_code":
            ctx.emit(role, "reading", thought || "관련 코드를 검색하고 있습니다.", { detail: String(args.query) });
            messages = observe(messages, await ctx.search(String(args.query ?? "")));
            break;
          case "grep":
            ctx.emit(role, "reading", thought || "문자열을 찾고 있습니다.", { detail: String(args.pattern) });
            messages = observe(messages, grepProject(ctx.projectRoot, String(args.pattern ?? ""), ctx.files()));
            break;
          case "write_file":
          case "edit_file": {
            const proposal = name === "write_file"
              ? proposeWrite(ctx.projectRoot, String(args.path), String(args.content ?? ""))
              : proposeEdit(ctx.projectRoot, String(args.path), Array.isArray(args.edits) ? args.edits as Array<{ find: string; replace: string }> : []);
            const pending = { kind: "write_file" as const, id: randomUUID(), agent: role, path: proposal.rel, diff: proposal.diff, content: proposal.content, baseHash: proposal.baseHash, reason: String(args.reason ?? thought).slice(0, 500) };
            messages = observe(messages, await write(role, pending, shared));
            break;
          }
          case "run_command": {
            const result = await command(role, validateCommand(args.command), String(args.reason ?? thought));
            messages = observe(messages, result.log);
            break;
          }
          case "finish": {
            const summary = String(args.summary ?? thought).slice(0, 4000);
            ctx.emit(role, "waiting", "맡은 작업을 마쳤습니다. 다른 작업이 끝나면 QA가 검증합니다.", { detail: summary });
            return { role, messages, steps, summary, failed: "" };
          }
          default:
            messages = observe(messages, `알 수 없는 action입니다: ${name}. 목록의 action만 사용하세요.`);
        }
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        messages = observe(messages, `오류: ${errorText(error)}`);
      }
    }
  }

  const supervisor = async (state: State): Promise<Update> => {
    ctx.emit("supervisor", "thinking", "작업을 분석하고 담당 에이전트를 고르고 있습니다.");
    const tree = listProjectDir(ctx.projectRoot, ".");
    let related = "";
    try { related = await ctx.search(state.task); } catch (error) { related = `(코드 검색 불가: ${errorText(error)})`; }
    const decision = await ask(ctx, supervisorPrompt(), [{ role: "user", content: `${projectBrief(ctx.info, tree)}\n\n관련 코드(벡터 검색):\n${related}\n\n작업 지시:\n${state.task}` }]);
    const lanes = parseLanes(decision);
    const testCommands = parseCommands(decision.testCommands ?? decision.testCommand);
    const plan = String(decision.plan ?? "").slice(0, 2000);
    const roles = lanes.map(lane => lane.role);
    ctx.emit("supervisor", "thinking", `${names(roles)}에게 ${roles.length > 1 ? "동시에 " : ""}배정했습니다.`, { detail: plan });
    const brief = `작업 지시:\n${state.task}\n\nSupervisor 계획:\n${plan}\n\n${projectBrief(ctx.info, tree)}\n\n관련 코드(벡터 검색):\n${clip(related, 8000)}`;
    return { plan, brief, lanes, rework: roles, testCommands, testPlanned: testCommands.length > 0 };
  };

  const experts = async (state: State): Promise<Update> => {
    const shared: Shared = { changes: new Set(state.changes), diffs: {} };
    const active = state.lanes.filter(lane => state.rework.includes(lane.role));
    // Every lane runs at once; a lane waiting for approval never holds up the others.
    const settled = await Promise.allSettled(active.map(plan => runLane(plan, state, shared)));
    if (ctx.signal.aborted) throw new DOMException("작업이 취소되었습니다.", "AbortError");
    const update = { transcripts: {} as State["transcripts"], steps: {} as State["steps"], summaries: {} as State["summaries"] };
    const failures: string[] = [];
    settled.forEach((result, i) => {
      const role = active[i].role;
      if (result.status === "rejected") { failures.push(`${WORKER_NAMES[role]}: ${errorText(result.reason)}`); return; }
      update.transcripts[role] = result.value.messages;
      update.steps[role] = result.value.steps;
      update.summaries[role] = result.value.summary;
      if (result.value.failed) failures.push(result.value.failed);
    });
    return { ...update, changes: [...shared.changes], diffs: shared.diffs, feedback: "", failed: failures.join("\n") };
  };

  const qa = async (state: State): Promise<Update> => {
    ctx.emit("qa", "reviewing", "검증 방법을 정하고 있습니다.");
    let commands = state.testCommands;
    let planned = state.testPlanned;
    let log = "";
    let outcomes: CommandOutcome[] = [];
    if (!state.changes.length) log = "변경된 파일이 없습니다.";
    else {
      if (!commands.length && !planned) {
        const plan = await ask(ctx, qaPlanPrompt(), [{ role: "user", content: `${projectBrief(ctx.info, listProjectDir(ctx.projectRoot, "."))}\n\n변경 파일: ${state.changes.join(", ")}` }]);
        commands = parseCommands(plan.commands ?? plan.command);
        planned = true;
      }
      if (!commands.length) log = "검증 명령이 없습니다.";
      else {
        if (commands.length > 1) ctx.emit("qa", "testing", `검증 명령 ${commands.length}개를 동시에 실행합니다.`);
        outcomes = await Promise.all(commands.map(argv => command("qa", argv, "변경 사항 검증")));
        log = outcomes.map(result => result.log).join("\n\n");
      }
    }
    ctx.emit("qa", "reviewing", "결과를 검토하고 있습니다.");
    const diffs = Object.entries(state.diffs).map(([file, diff]) => `--- ${file}\n${clip(diff, 6000)}`).join("\n\n") || "(변경 없음)";
    const summaries = state.lanes.map(lane => `[${WORKER_NAMES[lane.role]}] ${state.summaries[lane.role] ?? ""}`).join("\n");
    const review = await ask(ctx, qaReviewPrompt(), [{ role: "user", content: `작업 지시:\n${state.task}\n\n담당 Expert: ${state.lanes.map(lane => lane.role).join(", ")}\n\nExpert 요약:\n${summaries}\n\n변경 diff:\n${clip(diffs, 30_000)}\n\n검증 로그:\n${clip(log, 20_000)}` }]);
    // A failed verification command is a fact; the model may not overrule it.
    const { verdict, factNote: failNote } = decide(review.verdict, outcomes);
    const feedback = failNote + String(review.feedback ?? "").slice(0, 4000);
    const summary = failNote + String(review.summary ?? "").slice(0, 4000);
    const iterations = state.iterations + 1;
    const kept = { verdict, summary, iterations, testCommands: commands, testPlanned: planned } as const;
    if (verdict === "fail" && iterations < MAX_QA_ROUNDS) {
      const rework = reworkOf(review.rework, state.lanes);
      ctx.emit("qa", "reviewing", `문제를 찾아 ${names(rework)}에게 돌려보냅니다 (${iterations}/${MAX_QA_ROUNDS - 1}).`, { detail: feedback });
      return { ...kept, rework, feedback: `${feedback}\n\n검증 로그:\n${clip(log, 6000)}` };
    }
    return { ...kept, rework: [] };
  };

  const finalize = async (state: State): Promise<Update> => {
    const ok = !state.failed && state.verdict === "pass";
    const summary = state.failed || state.summary || Object.values(state.summaries).filter(Boolean).join("\n") || "작업을 마쳤습니다.";
    ctx.emit("supervisor", ok ? "done" : "failed", ok ? "작업을 완료했습니다." : "작업을 마쳤지만 확인이 필요합니다.", { detail: summary, changes: state.changes });
    return { summary };
  };

  return new StateGraph(AgentState)
    .addNode("supervisor", supervisor)
    .addNode("experts", experts)
    .addNode("qa", qa)
    .addNode("finalize", finalize)
    .addEdge(START, "supervisor")
    .addEdge("supervisor", "experts")
    .addConditionalEdges("experts", (s: State) => (s.failed ? "finalize" : "qa"), ["finalize", "qa"])
    .addConditionalEdges("qa", (s: State) => (s.verdict === "fail" && s.rework.length && s.iterations < MAX_QA_ROUNDS ? "experts" : "finalize"), ["experts", "finalize"])
    .addEdge("finalize", END)
    .compile();
}

