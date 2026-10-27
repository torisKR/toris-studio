import { randomUUID } from "node:crypto";
import { createModel } from "../llm/index.js";
import type { ChatModel } from "../llm/types.js";
import { describeProject, projectDir } from "../projects.js";
import { approvalView, type AgentRole, type ApprovalDecision, type ApprovalView, type PendingAction, type Phase, type RunEvent, type RuntimeSettings } from "../protocol.js";
import { ProjectIndex } from "../rag/index.js";
import { projectFiles } from "../tools/fs.js";
import { UserError, clip, errorText, redact } from "../util.js";
import type { EmitExtra, RunContext } from "./build.js";
import { defaultWorkflows } from "../harness/registry.js";
import { Trace } from "../harness/trace.js";
import type { CompiledWorkflow, WorkflowRegistry } from "../harness/workflow.js";
import type { RunHistory } from "./history.js";

const MAX_EVENTS = 400;
const MAX_RUNS = 30;

export type RunSummary = {
  runId: string;
  /** Which registered workflow the run uses; runs saved before workflows existed are "coding". */
  workflow: string;
  project: string;
  task: string;
  phase: Phase;
  agent: AgentRole;
  createdAt: string;
  updatedAt: string;
  /** Every approval waiting right now; parallel lanes can each have one. */
  approvals: ApprovalView[];
  changes: string[];
  summary: string;
  events: RunEvent[];
};

type Waiter = (decision: ApprovalDecision) => void;
/** \`graph\` is dropped once the run ends so its model, file list and closures can be collected. */
type Run = RunSummary & { controller: AbortController; graph: CompiledWorkflow | null; waiters: Map<string, Waiter>; driving: Promise<void>; seq: number; trace: Trace };

export class RunManager {
  private runs = new Map<string, Run>();
  private history: RunHistory | null = null;
  constructor(
    private settings: () => RuntimeSettings,
    private send: (event: RunEvent) => void,
    private modelFactory: (settings: RuntimeSettings) => ChatModel = s => createModel(s.agentModel, s),
    readonly workflows: WorkflowRegistry = defaultWorkflows(),
  ) {}

  /** Loads saved runs and saves every later change. A run the app closed on cannot resume: its lanes lived in memory. */
  attachHistory(history: RunHistory): void {
    this.history = history;
    for (const saved of history.load()) {
      if (this.runs.has(saved.runId)) continue;
      const run = { ...saved, workflow: saved.workflow || "coding", approvals: [], controller: new AbortController(), graph: null, waiters: new Map(), driving: Promise.resolve(), seq: saved.events.at(-1)?.seq ?? 0, trace: new Trace() } as Run;
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

  /**
   * Starts a run. Workflows that need a project get its folder, file list and code search;
   * the others get no folder at all and read only `input` from the host.
   */
  start(project: string, task: string, workflow = "coding", input: Record<string, unknown> = {}): RunSummary {
    let spec;
    try { spec = this.workflows.get(workflow); } catch (error) { throw new UserError(errorText(error)); }
    if (spec.needsProject && !task.trim()) throw new UserError("에이전트에게 맡길 작업을 입력하세요.");
    if (spec.needsProject && !project) throw new UserError("프로젝트를 선택하세요.");
    if (!spec.needsProject) project = "";
    const slot = (run: { project: string; workflow: string }) => run.project || "workflow:" + run.workflow;
    if ([...this.runs.values()].some(run => slot(run) === slot({ project, workflow: spec.id }) && !isTerminal(run.phase))) throw new UserError(project ? "이 프로젝트에서 진행 중인 작업이 있습니다. 끝나거나 취소한 뒤 시작하세요." : "같은 워크플로가 진행 중입니다. 끝나거나 취소한 뒤 시작하세요.");
    const settings = this.settings();
    const root = spec.needsProject ? projectDir(settings.projectsRoot, project) : "";
    const info = spec.needsProject ? describeProject(settings.projectsRoot, project) : { name: "", path: "", stacks: [], scripts: {}, git: false };
    // Hub workflows still run without a model: their nodes fall back to labelled template output.
    let model: ChatModel;
    try { model = this.modelFactory(settings); }
    catch (error) {
      if (spec.needsProject) throw error;
      const reason = errorText(error);
      model = { provider: "ollama", model: "none", complete: async () => { throw new UserError(reason); } };
    }
    const index = new ProjectIndex(settings);
    const controller = new AbortController();
    const runId = randomUUID();
    let files: string[] | null = null;
    const secrets = Object.values(settings.keys).filter((v): v is string => Boolean(v));
    const now = new Date().toISOString();
    const trace = new Trace();
    const run: Run = { runId, workflow: spec.id, project, task, phase: "queued", agent: "supervisor", createdAt: now, updatedAt: now, approvals: [], changes: [], summary: "", events: [], controller, graph: null, waiters: new Map(), driving: Promise.resolve(), seq: 0, trace };
    const traced: ChatModel = {
      provider: model.provider,
      model: model.model,
      complete: async input => {
        const started = Date.now();
        try { const out = await model.complete(input); trace.add({ kind: "model", role: input.system.slice(0, 40), ms: Date.now() - started, ok: true }); return out; }
        catch (error) { trace.add({ kind: "model", role: input.system.slice(0, 40), ms: Date.now() - started, ok: false }); throw error; }
      },
    };
    const ctx: RunContext = {
      model: traced, projectRoot: root, info, input, searchPath: settings.searchPath, secrets, signal: controller.signal,
      emit: (agent, phase, message, extra = {}) => this.emit(run, agent, phase, message, extra),
      approve: (action, message) => this.wait(run, action, message),
      search: async query => {
        if (!spec.needsProject) return "이 워크플로는 프로젝트 코드를 검색하지 않습니다.";
        const hits = await index.search(project, query, 8);
        return hits.map(hit => `[${hit.path}:${hit.startLine}-${hit.endLine} · ${hit.score}]\n${clip(hit.text, 1600)}`).join("\n\n") || "검색 결과가 없습니다.";
      },
      files: () => (spec.needsProject ? (files ??= projectFiles(root)) : []),
    };
    run.graph = spec.build(ctx);
    this.runs.set(runId, run);
    this.prune();
    this.emit(run, "supervisor", "queued", "작업을 시작합니다.");
    run.driving = this.drive(run, task);
    return this.view(run, true);
  }

  /** Resolves once every lane of the run has stopped; a cancelled run must not leave one waiting forever. */
  settled(runId: string): Promise<void> {
    return this.require(runId).driving;
  }

  /** The run's step log as JSON lines (model calls, events, approvals). In memory only. */
  trace(runId: string): string {
    return this.require(runId).trace.jsonl();
  }

  /** Decides one approval. Only its lane continues; the other lanes never stopped. */
  async resume(runId: string, decision: ApprovalDecision): Promise<RunSummary> {
    const run = this.require(runId);
    if (isTerminal(run.phase)) throw new UserError("이미 끝난 작업입니다.");
    if (decision.decision !== "approve" && decision.decision !== "reject") throw new UserError("승인 또는 거절을 선택하세요.");
    const waiter = run.waiters.get(decision.actionId);
    if (!waiter) throw new UserError("승인할 작업이 바뀌었습니다. 화면을 새로고침하세요.");
    run.waiters.delete(decision.actionId);
    run.approvals = run.approvals.filter(a => a.id !== decision.actionId);
    run.trace.add({ kind: "approval", id: decision.actionId, agent: "user", action: "decide", decision: decision.decision });
    waiter(decision);
    return this.view(run, true);
  }

  cancel(runId: string): RunSummary {
    const run = this.require(runId);
    if (!isTerminal(run.phase)) {
      run.controller.abort();
      this.emit(run, run.agent, "cancelled", "사용자가 작업을 취소했습니다.");
      this.release(run);
    }
    return this.view(run, true);
  }

  shutdown(): void {
    for (const run of this.runs.values()) run.controller.abort();
  }

  private wait(run: Run, action: PendingAction, message: string): Promise<ApprovalDecision> {
    if (run.controller.signal.aborted || isTerminal(run.phase)) return Promise.reject(new DOMException("작업이 취소되었습니다.", "AbortError"));
    return new Promise<ApprovalDecision>(resolve => {
      run.waiters.set(action.id, resolve);
      this.emit(run, action.agent, "awaiting_approval", message, { approval: action });
    });
  }

  private async drive(run: Run, task: string): Promise<void> {
    const graph = run.graph;
    if (!graph) return;
    try {
      const state = await graph.invoke({ task }, { recursionLimit: 100, signal: run.controller.signal });
      run.summary = String(state.summary ?? "");
      if (!isTerminal(run.phase)) this.emit(run, "supervisor", "done", "작업을 마쳤습니다.", { detail: run.summary });
    } catch (error) {
      if (!run.controller.signal.aborted) this.emit(run, run.agent, "failed", "작업 중 오류가 발생했습니다.", { detail: redact(errorText(error)) });
    } finally {
      this.release(run);
    }
  }

  /**
   * A finished run never resumes. Cancelling aborts graph.invoke, so a lane still waiting for approval
   * just stops; dropping its waiter and the graph lets the whole run be collected.
   */
  private release(run: Run): void {
    run.waiters.clear();
    run.approvals = [];
    if (isTerminal(run.phase)) run.graph = null;
  }

  private emit(run: Run, agent: AgentRole, phase: Phase, message: string, extra: EmitExtra = {}): void {
    if (isTerminal(run.phase) && phase !== "cancelled") return;
    run.seq += 1;
    run.agent = agent;
    run.updatedAt = new Date().toISOString();
    if (extra.changes) run.changes = [...new Set(extra.changes)];
    const approval = extra.approval ? approvalView(extra.approval) : undefined;
    if (approval) run.approvals = [...run.approvals.filter(a => a.id !== approval.id), approval];
    if (extra.resolved) run.approvals = run.approvals.filter(a => a.id !== extra.resolved);
    if (isTerminal(phase)) run.approvals = [];
    run.phase = runPhase(phase, run.approvals.length);
    if (phase === "done" || phase === "failed") run.summary = extra.detail ?? run.summary;
    const event: RunEvent = { event: "run", runId: run.runId, seq: run.seq, at: run.updatedAt, agent, phase, message, ...(extra.detail ? { detail: redact(clip(extra.detail, 8000)) } : {}), ...(approval ? { approval } : {}), ...(extra.resolved ? { resolved: extra.resolved } : {}), ...(extra.changes ? { changes: run.changes } : {}) };
    run.events.push(event);
    run.trace.add({ kind: "event", agent, phase, message });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    this.persist(run);
    this.send(event);
  }

  private persist(run: Run): void {
    try { this.history?.save(this.view(run, true)); } catch { /* the run goes on; only its saved copy is stale */ }
  }

  private view(run: Run, events: boolean): RunSummary {
    const { runId, workflow, project, task, phase, agent, createdAt, updatedAt, approvals, changes, summary } = run;
    return { runId, workflow, project, task, phase, agent, createdAt, updatedAt, approvals, changes, summary, events: events ? run.events : [] };
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

/** While any approval waits, the run as a whole is waiting for the user, whatever the other lanes do. */
export function runPhase(phase: Phase, approvals: number): Phase {
  return !isTerminal(phase) && approvals > 0 ? "awaiting_approval" : phase;
}
