import { Check, CircleAlert, FileText, Inbox } from "lucide-react";
import { useMemo } from "react";
import { AGENTS, type AgentRole, type RunSummary } from "./agent-client";
import { OFFICE_STEPS, officeScene, type Desk, type DeskActivity, type Party } from "./agent-office";
import { PixelOffice, PixelPortrait } from "./PixelOffice";
import { LOOKS } from "./pixel-sprites";
import { ROLE_LOOK } from "./pixel-office";

const ACTIVITY_LABELS: Record<DeskActivity, string> = {
  away: "자리 비움", waiting: "대기", thinking: "생각 중", reading: "서류 읽는 중", coding: "서류 작성 중",
  testing: "테스트 실행", reviewing: "검수 중", approval: "결재 대기", done: "업무 종료",
};
const partyName = (party: Party) => (party === "user" ? "나" : AGENTS.find(a => a.id === party)?.name ?? party);
const deskCode = (index: number) => `DESK-${String(index + 1).padStart(2, "0")}`;

function DeskCard({ desk, index, selected, onSelect }: { desk: Desk; index: number; selected: boolean; onSelect: () => void }) {
  const label = `${desk.name} 책상: ${ACTIVITY_LABELS[desk.activity]}${desk.pm ? " · PM" : ""}`;
  return <button type="button" className={`office-desk${desk.pm ? " pm" : ""}`} data-party={desk.id} data-activity={desk.activity} aria-pressed={selected} aria-label={label} onClick={onSelect}>
    <PixelPortrait role={desk.id} />
    <span className="office-desk-head"><span className="office-code">{desk.pm ? "PM" : deskCode(index)}</span><strong>{desk.name}</strong></span>
    <span className="office-meta">{LOOKS[ROLE_LOOK[desk.id]].label} · {desk.role}</span>
    <span className="office-state">
      {desk.activity === "approval" ? <CircleAlert size={13} aria-hidden="true" /> : desk.activity === "done" ? <Check size={13} aria-hidden="true" /> : <span className="office-dot" aria-hidden="true" />}
      {ACTIVITY_LABELS[desk.activity]}
    </span>
    <span className="office-paper-chip" title={desk.paper || undefined}><FileText size={12} aria-hidden="true" />{desk.paper || "서류 없음"}</span>
    <span className="office-counts">읽음 <b>{desk.read}</b> · 작성 <b>{desk.written}</b></span>
    {desk.note && <span className="office-note" title={desk.note}>{desk.note}</span>}
  </button>;
}

export function AgentOffice({ run, focus, onFocus }: { run: RunSummary; focus: AgentRole | null; onFocus: (agent: AgentRole | null) => void }) {
  const scene = useMemo(() => officeScene(run), [run]);
  const current = OFFICE_STEPS.findIndex(s => s.id === scene.step);
  const pulses = useMemo(() => new Map(scene.desks.map(d => [d.id, [...run.events].reverse().find(e => e.agent === d.id)?.seq ?? 0])), [scene.desks, run.events]);
  const sceneLabel = `픽셀 사무실: ${scene.desks.map(d => `${d.name} ${ACTIVITY_LABELS[d.activity]}`).join(", ")}`;

  return <section className="office" aria-label="에이전트 사무실">
    <header className="office-head">
      <span className="office-code">FLOOR 01 · {run.project}</span>
      <ol className="office-steps" aria-label="작업 절차">
        {OFFICE_STEPS.map((step, i) => <li key={step.id} data-state={i < current ? "done" : i === current ? "current" : "next"} aria-current={i === current ? "step" : undefined}>
          {i < current && <Check size={12} aria-hidden="true" />}{step.label}
        </li>)}
      </ol>
    </header>
    <div className="office-floor">
      <PixelOffice desks={scene.desks} pulses={pulses} latest={scene.handoffs.at(-1)} tray={Boolean(scene.tray)} final={scene.step === "final"} label={sceneLabel} />
    </div>
    <div className="office-cards">
      {scene.desks.map((desk, i) => <DeskCard key={desk.id} desk={desk} index={i} selected={focus === desk.id} onSelect={() => onFocus(focus === desk.id ? null : desk.id)} />)}
      <div className={`office-tray${scene.tray ? " waiting" : ""}`} role="status">
        <Inbox size={16} aria-hidden="true" />
        <strong>나 · 결재함</strong>
        <span>{scene.tray ? `결재 대기: ${scene.tray}` : scene.step === "final" ? "최종 보고서 도착" : "비어 있음"}</span>
      </div>
    </div>
    <div className="office-log">
      <h3>서류 이동</h3>
      <ol aria-label="서류 이동 기록">
        {scene.handoffs.slice(-6).reverse().map(h => <li key={`${h.seq}-${h.kind}-${h.from}-${h.to}`} data-kind={h.kind}>
          <span className="office-code">#{h.seq}</span>{`${partyName(h.from)} → ${partyName(h.to)} · ${h.label}`}
        </li>)}
        {!scene.handoffs.length && <li>아직 오간 서류가 없습니다.</li>}
      </ol>
    </div>
  </section>;
}
