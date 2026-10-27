import { Command, MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { createModel } from "../llm/index.js";
import type { ChatModel } from "../llm/types.js";
import { describeProject, projectDir } from "../projects.js";
import { approvalView, type AgentRole, type ApprovalDecision, type ApprovalView, type PendingAction, type Phase, type RunEvent, type RuntimeSettings } from "../protocol.js";
import { ProjectIndex } from "../rag/index.js";
import { projectFiles } from "../tools/fs.js";
import { UserError, clip, errorText, redact } from "../util.js";
import { buildGraph, type RunContext } from "./build.js";
import type { RunHistory } from "./history.js";

const MAX_EVENTS = 400;
const MAX_RUNS = 30;

export type RunSummary = {
  runId: string;
  project: string;
  task: string;
  phase: Phase;
  agent: AgentRole;
  createdAt: string;
  updatedAt: string;
  pending: ApprovalView | null;
  changes: string[];
  summary: string;
  events: RunEvent[];
};

/** `graph` is dropped once the run ends so its model, file list and closures can be collected. */
type Run = RunSummary & { controller: AbortController; graph: ReturnType<typeof buildGraph> | null; driving: Promise<void>; seq: number };

export class RunManager {
  private runs = new Map<string, Run>();
  private history: RunHistory | null = null;
  constructor(
    private settings: () => RuntimeSettings,
    private send: (event: RunEvent) => void,
    private modelFactory: (settings: RuntimeSettings) => ChatModel = s => createModel(s.agentModel, s),
    private checkpointer: BaseCheckpointSaver = new MemorySaver(),
  ) {}

  /** Loads saved runs and saves every later change. A run the app closed on cannot resume: its graph state was in memory. */
  attachHistory(history: RunHistory): void {
    this.history = history;
    for (const saved of history.load()) {
      if (this.runs.has(saved.runId)) continue;
      const run = { ...saved, pending: null, controller: new AbortController(), graph: null, driving: Promise.resolve(), seq: saved.events.at(-1)?.seq ?? 0 } as Run;
      this.runs.set(run.runId, run);
      if (!isTerminal(run.phase)) this.emit(run, run.agent, "failed", "앱이 꺼져 작업이 멈췄습니다. 같은 작업을 다시 시작하세요.");
    }
  }

  list(): RunSummary[] {
    return [...this.runs.values()].map(run => this.view(run, false)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(runId: string): RunSummary {
    return this.view(this.require(runId), true);
  }

  start(project: string, task: string): RunSummary {
    if (!task.trim()) throw new UserError("에이전트에게 맡길 작업을 입력하세요.");
    if ([...this.runs.values()].some(run => run.project === project && !isTerminal(run.phase))) throw new UserError("이 프로젝트에서 진행 중인 작업이 있습니다. 끝나거나 취소한 뒤 시작하세요.");
    const settings = this.settings();
    const root = projectDir(settings.projectsRoot, project);
    const info = describeProject(settings.projectsRoot, project);
    const model = this.modelFactory(settings);
    const index = new ProjectIndex(settings);
    const controller = new AbortController();
    const runId = randomUUID();
    let files: string[] | null = null;
    const secrets = Object.values(settings.keys).filter((v): v is string => Boolean(v));
    const now = new Date().toISOString();
    const run = { runId, project, task, phase: "queued" as Phase, agent: "supervisor" as AgentRole, createdAt: now, updatedAt: now, pending: null, changes: [], summary: "", events: [], controller, driving: Promise.resolve(), seq: 0 } as unknown as Run;
    const ctx: RunContext = {
      model, projectRoot: root, info, searchPath: settings.searchPath, secrets, signal: controller.signal,
      emit: (agent, phase, message, extra = {}) => this.emit(run, agent, phase, message, extra),
      search: async query => {
        const hits = await index.search(project, query, 8);
        return hits.map(hit => `[${hit.path}:${hit.startLine}-${hit.endLine} · ${hit.score}]\n${clip(hit.text, 1600)}`).join("\n\n") || "검색 결과가 없습니다.";
      },
      files: () => (files ??= projectFiles(root)),
    };
    run.graph = buildGraph(ctx, this.checkpointer);
    this.runs.set(runId, run);
    this.prune();
    this.emit(run, "supervisor", "queued", "작업을 시작합니다.");
    run.driving = this.drive(run, { runId, project, task });
    return this.view(run, true);
  }

  async resume(runId: string, decision: ApprovalDecision): Promise<RunSummary> {
    const run = this.require(runId);
    // The approval event is sent just before the graph pauses; let that pause settle.
    await run.driving;
    if (isTerminal(run.phase)) throw new UserError("이미 끝난 작업입니다.");
    if (!run.pending || run.pending.id !== decision.actionId) throw new UserError("승인할 작업이 바뀌었습니다. 화면을 새로고침하세요.");
    if (decision.decision !== "approve" && decision.decision !== "reject") throw new UserError("승인 또는 거절을 선택하세요.");
    run.pending = null;
    run.driving = this.drive(run, new Command({ resume: decision }));
    return this.view(run, true);
  }

  cancel(runId: string): RunSummary {
    const run = this.require(runId);
    if (!isTerminal(run.phase)) {
      run.controller.abort();
      run.pending = null;
      this.emit(run, run.agent, "cancelled", "사용자가 작업을 취소했습니다.");
      void run.driving.then(() => this.release(run));
    }
    return this.view(run, true);
  }

  shutdown(): void {
    for (const run of this.runs.values()) run.controller.abort();
  }

  private async drive(run: Run, input: unknown): Promise<void> {
    const graph = run.graph;
    if (!graph) return;
    try {
      const stream = await graph.stream(input as never, { configurable: { thread_id: run.runId }, streamMode: "updates", recursionLimit: 400, signal: run.controller.signal });
      for await (const chunk of stream) {
        const interrupts = (chunk as Record<string, unknown>).__interrupt__ as Array<{ value: PendingAction }> | undefined;
        if (interrupts?.length) run.pending = approvalView(interrupts[0].value);
      }
      const state = await graph.getState({ configurable: { thread_id: run.runId } });
      if (!state.next.length) {
        run.summary = String(state.values.summary ?? "");
        if (!isTerminal(run.phase)) this.emit(run, "supervisor", "done", "작업을 마쳤습니다.", { detail: run.summary });
      }
    } catch (error) {
      if (!run.controller.signal.aborted) this.emit(run, run.agent, "failed", "작업 중 오류가 발생했습니다.", { detail: redact(errorText(error)) });
    } finally {
      if (isTerminal(run.phase)) await this.release(run);
    }
  }

  /** A finished run never resumes, so its checkpoints and graph are dead weight. */
  private async release(run: Run): Promise<void> {
    run.graph = null;
    await this.checkpointer.deleteThread(run.runId);
  }

  private emit(run: Run, agent: AgentRole, phase: Phase, message: string, extra: { detail?: string; approval?: PendingAction; changes?: string[] } = {}): void {
    if (isTerminal(run.phase) && phase !== "cancelled") return;
    run.seq += 1;
    run.agent = agent;
    run.phase = phase;
    run.updatedAt = new Date().toISOString();
    if (extra.changes) run.changes = [...new Set(extra.changes)];
    const approval = extra.approval ? approvalView(extra.approval) : undefined;
    if (approval) run.pending = approval;
    if (phase === "done" || phase === "failed") run.summary = extra.detail ?? run.summary;
    const event: RunEvent = { event: "run", runId: run.runId, seq: run.seq, at: run.updatedAt, agent, phase, message, ...(extra.detail ? { detail: redact(clip(extra.detail, 8000)) } : {}), ...(approval ? { approval } : {}), ...(extra.changes ? { changes: run.changes } : {}) };
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    this.persist(run);
    this.send(event);
  }

  private persist(run: Run): void {
    try { this.history?.save(this.view(run, true)); } catch { /* the run goes on; only its saved copy is stale */ }
  }

  private view(run: Run, events: boolean): RunSummary {
    const { runId, project, task, phase, agent, createdAt, updatedAt, pending, changes, summary } = run;
    return { runId, project, task, phase, agent, createdAt, updatedAt, pending, changes, summary, events: events ? run.events : [] };
  }
  private require(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new UserError("작업을 찾을 수 없습니다.");
    return run;
  }
  private prune(): void {
    const done = [...this.runs.values()].filter(run => isTerminal(run.phase)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.runs.size > MAX_RUNS && done.length) this.runs.delete(done.shift()!.runId);
  }
}

export function isTerminal(phase: Phase): boolean {
  return phase === "done" || phase === "failed" || phase === "cancelled";
}
