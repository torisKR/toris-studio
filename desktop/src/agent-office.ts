// The Agent tab's office view: run events become desks, paperwork and hand-offs.
// Pure data so the procedure is testable; the component only draws it.
import { AGENTS, type AgentRole, type Phase, type RunEvent, type RunSummary } from "./agent-client";

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
  queued: "thinking", thinking: "thinking", reading: "reading", coding: "coding", testing: "testing", reviewing: "reviewing", awaiting_approval: "approval",
};
const LABELS: Record<HandoffKind, string> = { order: "작업 지시서", assign: "업무 배정서", report: "작업 보고서", sendBack: "보완 요청서", approval: "결재 요청", final: "최종 보고서" };

function kindOf(from: AgentRole, to: AgentRole): HandoffKind {
  if (from === PM) return "assign";
  if (from === "qa" && WORKERS.includes(to)) return "sendBack";
  return "report";
}

const short = (value: string) => (value.length > 60 ? `${value.slice(0, 59)}…` : value);
const approvalSubject = (event: RunEvent) =>
  event.approval?.kind === "write_file" ? event.approval.path : event.approval ? event.approval.command.join(" ") : "";

function handoffsOf(events: RunEvent[]): Handoff[] {
  const out: Handoff[] = [];
  const add = (from: Party, to: Party, kind: HandoffKind, seq: number, label = LABELS[kind]) => out.push({ from, to, kind, seq, label });
  let prev: AgentRole | null = null;
  for (const event of events) {
    if (prev === null) add("user", PM, "order", event.seq);
    else if (prev !== event.agent) add(prev, event.agent, kindOf(prev, event.agent), event.seq);
    if (event.phase === "awaiting_approval" && event.approval) add(event.agent, "user", "approval", event.seq, `${LABELS.approval} · ${short(approvalSubject(event))}`);
    if (TERMINAL.includes(event.phase)) add(event.agent, "user", "final", event.seq);
    prev = event.agent;
  }
  return out;
}

function desksOf(run: RunSummary): Desk[] {
  const last = run.events.at(-1);
  const terminal = TERMINAL.includes(run.phase);
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
    let activity: DeskActivity = "away";
    if (latest) activity = terminal ? "done" : last?.agent === agent.id ? ACTIVITY[run.phase] ?? "thinking" : "waiting";
    return {
      id: agent.id, name: agent.name, role: agent.role, pm: agent.id === PM, activity,
      note: latest?.message ?? "",
      paper: paperEvent ? short(paperEvent.approval ? approvalSubject(paperEvent) : paperEvent.detail ?? "") : "",
      read: own.filter(e => e.phase === "reading").length,
      written: written.get(agent.id) ?? 0,
    };
  });
}

function stepOf(run: RunSummary): OfficeStepId {
  if (!run.events.length) return "order";
  if (TERMINAL.includes(run.phase)) return "final";
  if (run.phase === "awaiting_approval") return "approval";
  if (run.agent === "qa") return "review";
  if (WORKERS.includes(run.agent)) return "work";
  return run.phase === "queued" ? "order" : "assign";
}

export function officeScene(run: RunSummary): OfficeScene {
  return {
    desks: desksOf(run),
    handoffs: handoffsOf(run.events),
    step: stepOf(run),
    tray: run.phase === "awaiting_approval" && run.pending ? (run.pending.kind === "write_file" ? run.pending.path : run.pending.command.join(" ")) : "",
  };
}
