// The Agent tab's office view: run events become desks, paperwork and hand-offs.
// Pure data so the procedure is testable; the component only draws it.
import { AGENTS, type AgentRole, type PendingAction, type Phase, type RunEvent, type RunSummary } from "./agent-client";

export type OfficeStepId = "order" | "assign" | "work" | "approval" | "review" | "final";
export const OFFICE_STEPS: Array<{ id: OfficeStepId; label: string }> = [
  { id: "order", label: "지시 접수" },
  { id: "assign", label: "업무 배정" },
  { id: "work", label: "서류 작업" },
  { id: "approval", label: "결재 대기" },
  { id: "review", label: "검수" },
  { id: "final", label: "최종 보고" },
];

export type DeskActivity = "away" | "waiting" | "thinking" | "reading" | "coding" | "testing" | "reviewing" | "approval" | "done";
export type Desk = { id: AgentRole; name: string; role: string; pm: boolean; activity: DeskActivity; note: string; paper: string; read: number; written: number };
export type Party = AgentRole | "user";
export type HandoffKind = "order" | "assign" | "report" | "sendBack" | "approval" | "final";
export type Handoff = { from: Party; to: Party; kind: HandoffKind; seq: number; label: string };
export type OfficeScene = { desks: Desk[]; handoffs: Handoff[]; step: OfficeStepId; tray: string };

const PM: AgentRole = "supervisor";
const WORKERS: AgentRole[] = ["frontend", "backend"];
const TERMINAL: Phase[] = ["done", "failed", "cancelled"];
const ACTIVITY: Partial<Record<Phase, DeskActivity>> = {
  queued: "thinking", thinking: "thinking", reading: "reading", coding: "coding", testing: "testing", reviewing: "reviewing", awaiting_approval: "approval", waiting: "waiting",
};
const LABELS: Record<HandoffKind, string> = { order: "작업 지시서", assign: "업무 배정서", report: "작업 보고서", sendBack: "보완 요청서", approval: "결재 요청", final: "최종 보고서" };

/** Agents in one stage work at the same time: the PM plans, the experts work in parallel, QA reviews. */
type Stage = "plan" | "work" | "review";
const stageOf = (agent: AgentRole): Stage => (agent === PM ? "plan" : agent === "qa" ? "review" : "work");

function kindOf(from: AgentRole, to: AgentRole): HandoffKind {
  if (from === PM) return "assign";
  if (from === "qa" && WORKERS.includes(to)) return "sendBack";
  return "report";
}

const short = (value: string) => (value.length > 60 ? `${value.slice(0, 59)}…` : value);
const subjectOf = (action: PendingAction) => (action.kind === "write_file" ? action.path : action.kind === "save_draft" ? action.title : action.command.join(" "));
const approvalSubject = (event: RunEvent) => (event.approval ? subjectOf(event.approval) : "");

/** Paper moves when the stage changes: from everyone in the stage that ended to each agent starting the next. */
function handoffsOf(events: RunEvent[]): Handoff[] {
  const out: Handoff[] = [];
  const add = (from: Party, to: Party, kind: HandoffKind, seq: number, label = LABELS[kind]) => out.push({ from, to, kind, seq, label });
  let stage: Stage | null = null;
  let previous: AgentRole[] = [];
  let current: AgentRole[] = [];
  for (const event of events) {
    const next = stageOf(event.agent);
    if (stage === null) add("user", PM, "order", event.seq);
    else if (next !== stage) { previous = current; current = []; }
    if (stage !== null && !current.includes(event.agent)) for (const from of previous) add(from, event.agent, kindOf(from, event.agent), event.seq);
    if (!current.includes(event.agent)) current.push(event.agent);
    stage = next;
    if (event.phase === "awaiting_approval" && event.approval) add(event.agent, "user", "approval", event.seq, `${LABELS.approval} · ${short(approvalSubject(event))}`);
    if (TERMINAL.includes(event.phase)) add(event.agent, "user", "final", event.seq);
  }
  return out;
}

/** Agents of the stage the run is in now; they may all be busy at once. */
function activeOf(events: RunEvent[]): Set<AgentRole> {
  const active = new Set<AgentRole>();
  const last = events.at(-1);
  if (!last) return active;
  for (let i = events.length - 1; i >= 0 && stageOf(events[i].agent) === stageOf(last.agent); i--) active.add(events[i].agent);
  return active;
}

function desksOf(run: RunSummary): Desk[] {
  const terminal = TERMINAL.includes(run.phase);
  const active = activeOf(run.events);
  const seen = new Set<string>();
  const written = new Map<AgentRole, number>();
  for (const event of run.events) {
    for (const file of event.changes ?? []) {
      if (seen.has(file)) continue;
      seen.add(file);
      written.set(event.agent, (written.get(event.agent) ?? 0) + 1);
    }
  }
  return AGENTS.map(agent => {
    const own = run.events.filter(e => e.agent === agent.id);
    const latest = own.at(-1);
    const paperEvent = [...own].reverse().find(e => (e.phase === "reading" && e.detail) || e.approval);
    const asking = run.approvals.find(a => a.agent === agent.id);
    let activity: DeskActivity = "away";
    if (latest) activity = terminal ? "done" : asking ? "approval" : active.has(agent.id) ? ACTIVITY[latest.phase] ?? "thinking" : "waiting";
    return {
      id: agent.id, name: agent.name, role: agent.role, pm: agent.id === PM, activity,
      note: latest?.message ?? "",
      paper: asking ? short(subjectOf(asking)) : paperEvent ? short(paperEvent.approval ? approvalSubject(paperEvent) : paperEvent.detail ?? "") : "",
      read: own.filter(e => e.phase === "reading").length,
      written: written.get(agent.id) ?? 0,
    };
  });
}

function stepOf(run: RunSummary): OfficeStepId {
  if (!run.events.length) return "order";
  if (TERMINAL.includes(run.phase)) return "final";
  if (run.approvals.length) return "approval";
  const stage = stageOf(run.events.at(-1)!.agent);
  if (stage === "review") return "review";
  if (stage === "work") return "work";
  return run.phase === "queued" ? "order" : "assign";
}

export function officeScene(run: RunSummary): OfficeScene {
  const [first, ...rest] = run.approvals;
  return {
    desks: desksOf(run),
    handoffs: handoffsOf(run.events),
    step: stepOf(run),
    tray: first ? `${subjectOf(first)}${rest.length ? ` 외 ${rest.length}건` : ""}` : "",
  };
}
