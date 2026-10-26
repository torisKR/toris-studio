import { END, START, StateGraph, interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatModel } from "../llm/types.js";
import type { ProjectInfo } from "../projects.js";
import type { AgentRole, ApprovalDecision, PendingAction, Phase } from "../protocol.js";
import { applyWrite, grepProject, listProjectDir, proposeEdit, proposeWrite, readProjectFile } from "../tools/fs.js";
import { runCommand, validateCommand } from "../tools/terminal.js";
import { UserError, clip, errorText, parseJsonObject, record } from "../util.js";
import { projectBrief, qaPlanPrompt, qaReviewPrompt, supervisorPrompt, workerPrompt } from "./prompts.js";
import { AgentState, type State, type Update } from "./state.js";

export const MAX_STEPS_PER_TURN = 6;
export const MAX_TOTAL_STEPS = 60;
export const MAX_QA_ROUNDS = 3;
const MAX_OBSERVATION = 12_000;
const KEEP_MESSAGES = 28;

export interface RunContext {
  model: ChatModel;
  projectRoot: string;
  info: ProjectInfo;
  searchPath: string[];
  secrets: string[];
  signal: AbortSignal;
  emit(agent: AgentRole, phase: Phase, message: string, extra?: { detail?: string; approval?: PendingAction; changes?: string[] }): void;
  search(query: string): Promise<string>;
  files(): string[];
}

async function ask(ctx: RunContext, system: string, messages: ChatMessage[]): Promise<Record<string, unknown>> {
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

export function buildGraph(ctx: RunContext, checkpointer: BaseCheckpointSaver) {
  const supervisor = async (state: State): Promise<Update> => {
    ctx.emit("supervisor", "thinking", "작업을 분석하고 담당 에이전트를 고르고 있습니다.");
    const tree = listProjectDir(ctx.projectRoot, ".");
    let related = "";
    try { related = await ctx.search(state.task); } catch (error) { related = `(코드 검색 불가: ${errorText(error)})`; }
    const decision = await ask(ctx, supervisorPrompt(), [{ role: "user", content: `${projectBrief(ctx.info, tree)}\n\n관련 코드(벡터 검색):\n${related}\n\n작업 지시:\n${state.task}` }]);
    const route = decision.route === "backend" ? "backend" : "frontend";
    let testCommand: string[] | null = null;
    try { testCommand = decision.testCommand ? validateCommand(decision.testCommand) : null; } catch { testCommand = null; }
    const plan = String(decision.plan ?? "").slice(0, 2000);
    ctx.emit("supervisor", "thinking", `${route === "frontend" ? "Frontend" : "Backend"} Expert에게 배정했습니다.`, { detail: plan });
    const intro = `작업 지시:\n${state.task}\n\nSupervisor 계획:\n${plan}\n\n${projectBrief(ctx.info, tree)}\n\n관련 코드(벡터 검색):\n${clip(related, 8000)}`;
    return { route, plan, testCommand, messages: [{ role: "user", content: intro }] };
  };

  const worker = async (state: State): Promise<Update> => {
    const role = state.route;
    let messages = state.messages;
    let steps = state.steps;
    for (let i = 0; i < MAX_STEPS_PER_TURN; i++) {
      if (steps >= MAX_TOTAL_STEPS) return { messages, steps, failed: `단계 한도(${MAX_TOTAL_STEPS})에 도달해 중단했습니다.` };
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
            const pending: PendingAction = { kind: "write_file", id: randomUUID(), agent: role, path: proposal.rel, diff: proposal.diff, content: proposal.content, baseHash: proposal.baseHash, reason: String(args.reason ?? thought).slice(0, 500) };
            ctx.emit(role, "awaiting_approval", `${proposal.rel} 변경 승인을 기다립니다.`, { approval: pending });
            return { messages, steps, pending, returnTo: "worker" };
          }
          case "run_command": {
            const command = validateCommand(args.command);
            const pending: PendingAction = { kind: "run_command", id: randomUUID(), agent: role, command, cwd: ctx.info.name, reason: String(args.reason ?? thought).slice(0, 500) };
            ctx.emit(role, "awaiting_approval", `명령 실행 승인을 기다립니다: ${command.join(" ")}`, { approval: pending });
            return { messages, steps, pending, returnTo: "worker" };
          }
          case "finish": {
            const summary = String(args.summary ?? thought).slice(0, 4000);
            ctx.emit(role, "coding", "작업을 마치고 QA에 넘깁니다.", { detail: summary, changes: state.changes });
            return { messages, steps, workerDone: true, workerSummary: summary };
          }
          default:
            messages = observe(messages, `알 수 없는 action입니다: ${name}. 목록의 action만 사용하세요.`);
        }
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        messages = observe(messages, `오류: ${errorText(error)}`);
      }
    }
    return { messages, steps };
  };

  const approval = async (state: State): Promise<Update> => {
    const pending = state.pending;
    if (!pending) return {};
    const decision = record(interrupt(pending)) as ApprovalDecision;
    const approved = decision.actionId === pending.id && decision.decision === "approve";
    const feedback = typeof decision.feedback === "string" ? decision.feedback.slice(0, 2000) : "";
    if (!approved) {
      ctx.emit(pending.agent, "thinking", "사용자가 거절했습니다. 다른 방법을 찾습니다.", { detail: feedback });
      const note = `사용자가 이 작업을 거절했습니다.${feedback ? ` 피드백: ${feedback}` : ""}`;
      return state.returnTo === "qa_review"
        ? { pending: null, testLog: `검증 명령이 거절되었습니다.${feedback ? ` 피드백: ${feedback}` : ""}` }
        : { pending: null, messages: observe(state.messages, note) };
    }
    if (pending.kind === "write_file") {
      try {
        applyWrite(ctx.projectRoot, pending);
        ctx.emit(pending.agent, "coding", `${pending.path}에 변경을 적용했습니다.`, { changes: [...state.changes, pending.path] });
        return { pending: null, changes: [pending.path], diffs: { [pending.path]: pending.diff }, messages: observe(state.messages, `${pending.path} 적용 완료.`) };
      } catch (error) {
        return { pending: null, messages: observe(state.messages, `적용 실패: ${errorText(error)}`) };
      }
    }
    ctx.emit(pending.agent, "testing", `실행 중: ${pending.command.join(" ")}`);
    const result = await runCommand(pending.command, ctx.projectRoot, ctx.searchPath, ctx.secrets, ctx.signal);
    const log = `$ ${pending.command.join(" ")}\nexit=${result.exitCode}${result.timedOut ? " (시간 초과)" : ""} · ${Math.round(result.durationMs / 1000)}초\n${result.log}`;
    ctx.emit(pending.agent, "testing", `명령 종료 (exit ${result.exitCode})`, { detail: clip(result.log, 4000) });
    return state.returnTo === "qa_review" ? { pending: null, testLog: log } : { pending: null, messages: observe(state.messages, log) };
  };

  const qa = async (state: State): Promise<Update> => {
    ctx.emit("qa", "reviewing", "검증 방법을 정하고 있습니다.");
    let command = state.testCommand;
    if (!command) {
      const plan = await ask(ctx, qaPlanPrompt(), [{ role: "user", content: `${projectBrief(ctx.info, listProjectDir(ctx.projectRoot, "."))}\n\n변경 파일: ${state.changes.join(", ") || "없음"}` }]);
      try { command = plan.command ? validateCommand(plan.command) : null; } catch { command = null; }
    }
    if (!command || !state.changes.length) return { testLog: state.changes.length ? "검증 명령이 없습니다." : "변경된 파일이 없습니다." };
    const pending: PendingAction = { kind: "run_command", id: randomUUID(), agent: "qa", command, cwd: ctx.info.name, reason: "변경 사항 검증" };
    ctx.emit("qa", "awaiting_approval", `검증 명령 승인을 기다립니다: ${command.join(" ")}`, { approval: pending });
    return { pending, returnTo: "qa_review" };
  };

  const qaReview = async (state: State): Promise<Update> => {
    ctx.emit("qa", "reviewing", "결과를 검토하고 있습니다.");
    const diffs = Object.entries(state.diffs).map(([file, diff]) => `--- ${file}\n${clip(diff, 6000)}`).join("\n\n") || "(변경 없음)";
    const review = await ask(ctx, qaReviewPrompt(), [{ role: "user", content: `작업 지시:\n${state.task}\n\nExpert 요약:\n${state.workerSummary}\n\n변경 diff:\n${clip(diffs, 30_000)}\n\n검증 로그:\n${clip(state.testLog, 20_000)}` }]);
    const verdict = review.verdict === "pass" ? "pass" : "fail";
    const feedback = String(review.feedback ?? "").slice(0, 4000);
    const summary = String(review.summary ?? "").slice(0, 4000);
    const iterations = state.iterations + 1;
    if (verdict === "fail" && iterations < MAX_QA_ROUNDS) {
      ctx.emit("qa", "reviewing", `문제를 찾아 ${state.route === "frontend" ? "Frontend" : "Backend"} Expert에게 돌려보냅니다 (${iterations}/${MAX_QA_ROUNDS - 1}).`, { detail: feedback });
      return { verdict, feedback, summary, iterations, workerDone: false, messages: observe(state.messages, `QA 피드백 (수정 필요):\n${feedback}\n\n검증 로그:\n${clip(state.testLog, 6000)}`) };
    }
    return { verdict, feedback, summary, iterations };
  };

  const finalize = async (state: State): Promise<Update> => {
    const ok = !state.failed && state.verdict === "pass";
    const summary = state.failed || state.summary || state.workerSummary || "작업을 마쳤습니다.";
    ctx.emit("supervisor", ok ? "done" : "failed", ok ? "작업을 완료했습니다." : "작업을 마쳤지만 확인이 필요합니다.", { detail: summary, changes: state.changes });
    return { summary };
  };

  return new StateGraph(AgentState)
    .addNode("supervisor", supervisor)
    .addNode("worker", worker)
    .addNode("approval", approval)
    .addNode("qa", qa)
    .addNode("qa_review", qaReview)
    .addNode("finalize", finalize)
    .addEdge(START, "supervisor")
    .addEdge("supervisor", "worker")
    .addConditionalEdges("worker", (s: State) => (s.failed ? "finalize" : s.pending ? "approval" : s.workerDone ? "qa" : "worker"), ["finalize", "approval", "qa", "worker"])
    .addConditionalEdges("approval", (s: State) => (s.returnTo === "qa_review" ? "qa_review" : "worker"), ["qa_review", "worker"])
    .addConditionalEdges("qa", (s: State) => (s.pending ? "approval" : "qa_review"), ["approval", "qa_review"])
    .addConditionalEdges("qa_review", (s: State) => (s.verdict === "fail" && !s.workerDone && s.iterations < MAX_QA_ROUNDS ? "worker" : "finalize"), ["worker", "finalize"])
    .addEdge("finalize", END)
    .compile({ checkpointer });
}

