import { Check, CircleAlert, FileText, Inbox } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AGENTS, type AgentRole, type RunSummary } from "./agent-client";
import { OFFICE_STEPS, officeScene, type Desk, type DeskActivity, type Handoff, type Party } from "./agent-office";
import { OfficeWorker } from "./OfficeWorker";

const ACTIVITY_LABELS: Record<DeskActivity, string> = {
  away: "자리 비움", waiting: "대기", thinking: "생각 중", reading: "서류 읽는 중", coding: "서류 작성 중",
  testing: "테스트 실행", reviewing: "검수 중", approval: "결재 대기", done: "업무 종료",
};
const partyName = (party: Party) => (party === "user" ? "나" : AGENTS.find(a => a.id === party)?.name ?? party);
const deskCode = (index: number) => `DESK-${String(index + 1).padStart(2, "0")}`;

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia(REDUCED_QUERY).matches;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const list = matchMedia(REDUCED_QUERY);
    const update = () => setReduced(list.matches);
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, []);
  return reduced;
}

type Flight = { key: string; kind: Handoff["kind"]; x: number; y: number; dx: number; dy: number };

/** One paper per new hand-off, flown once from desk to desk; nothing moves after it lands. */
function usePaperFlight(latest: Handoff | undefined, floor: React.RefObject<HTMLDivElement | null>, reduced: boolean) {
  const [flight, setFlight] = useState<Flight | null>(null);
  const seen = useRef<string | null>(null);
  const key = latest ? `${latest.seq}-${latest.kind}-${latest.from}-${latest.to}` : null;
  useLayoutEffect(() => {
    if (!latest || !key || key === seen.current) return;
    const first = seen.current === null;
    seen.current = key;
    // Opening a run shows its state; only hand-offs that happen while watching fly.
    // The live media query is read here: React state may lag a just-changed setting.
    if (first || prefersReducedMotion() || !floor.current) return;
    const box = floor.current.getBoundingClientRect();
    const spot = (party: Party) => floor.current?.querySelector<HTMLElement>(`[data-party="${party}"]`)?.getBoundingClientRect();
    const from = spot(latest.from), to = spot(latest.to);
    if (!from || !to) return;
    const cx = (r: DOMRect) => r.left - box.left + r.width / 2, cy = (r: DOMRect) => r.top - box.top + r.height / 2;
    setFlight({ key, kind: latest.kind, x: cx(from), y: cy(from), dx: cx(to) - cx(from), dy: cy(to) - cy(from) });
  }, [key, latest, reduced, floor]);
  useEffect(() => { if (reduced) setFlight(null); }, [reduced]);
  return { flight, land: () => setFlight(null) };
}

function DeskCard({ desk, index, selected, pulse, onSelect }: { desk: Desk; index: number; selected: boolean; pulse: number; onSelect: () => void }) {
  const label = `${desk.name} 책상: ${ACTIVITY_LABELS[desk.activity]}${desk.pm ? " · PM" : ""}`;
  return <button type="button" className={`office-desk${desk.pm ? " pm" : ""}`} data-party={desk.id} data-activity={desk.activity} aria-pressed={selected} aria-label={label} onClick={onSelect}>
    <span className="office-desk-head"><span className="office-code">{desk.pm ? "PM" : deskCode(index)}</span><strong>{desk.name}</strong></span>
    <OfficeWorker key={pulse} role={desk.id} activity={desk.activity} />
    <span className="office-state">
      {desk.activity === "approval" ? <CircleAlert size={13} aria-hidden="true" /> : desk.activity === "done" ? <Check size={13} aria-hidden="true" /> : <span className="office-dot" aria-hidden="true" />}
      {ACTIVITY_LABELS[desk.activity]}
    </span>
    <span className="office-meta">{desk.role}</span>
    <span className="office-paper-chip" title={desk.paper || undefined}><FileText size={12} aria-hidden="true" />{desk.paper || "서류 없음"}</span>
    <span className="office-counts">읽음 <b>{desk.read}</b> · 작성 <b>{desk.written}</b></span>
    {desk.note && <span className="office-note" title={desk.note}>{desk.note}</span>}
  </button>;
}

export function AgentOffice({ run, focus, onFocus }: { run: RunSummary; focus: AgentRole | null; onFocus: (agent: AgentRole | null) => void }) {
  const scene = useMemo(() => officeScene(run), [run]);
  const floor = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const latest = scene.handoffs.at(-1);
  const { flight, land } = usePaperFlight(latest, floor, reduced);
  const current = OFFICE_STEPS.findIndex(s => s.id === scene.step);
  const pulses = useMemo(() => new Map(scene.desks.map(d => [d.id, [...run.events].reverse().find(e => e.agent === d.id)?.seq ?? 0])), [scene.desks, run.events]);
  const pm = scene.desks.find(d => d.pm);
  const staff = scene.desks.filter(d => !d.pm);
  const deskOf = (desk: Desk) => <DeskCard key={desk.id} desk={desk} index={scene.desks.indexOf(desk)} selected={focus === desk.id} pulse={pulses.get(desk.id) ?? 0} onSelect={() => onFocus(focus === desk.id ? null : desk.id)} />;

  return <section className="office" aria-label="에이전트 사무실">
    <header className="office-head">
      <span className="office-code">FLOOR 01 · {run.project}</span>
      <ol className="office-steps" aria-label="작업 절차">
        {OFFICE_STEPS.map((step, i) => <li key={step.id} data-state={i < current ? "done" : i === current ? "current" : "next"} aria-current={i === current ? "step" : undefined}>
          {i < current && <Check size={12} aria-hidden="true" />}{step.label}
        </li>)}
      </ol>
    </header>
    <div className="office-floor" ref={floor}>
      <div className="office-row office-row-pm">
        {pm && deskOf(pm)}
        <div className={`office-tray${scene.tray ? " waiting" : ""}`} data-party="user" role="status">
          <Inbox size={18} aria-hidden="true" />
          <strong>나 · 결재함</strong>
          <span>{scene.tray ? `결재 대기: ${scene.tray}` : scene.step === "final" ? "최종 보고서 도착" : "비어 있음"}</span>
        </div>
      </div>
      <div className="office-row office-row-staff">{staff.map(deskOf)}</div>
      {flight && <span key={flight.key} className="office-paper" data-kind={flight.kind} aria-hidden="true"
        style={{ left: flight.x, top: flight.y, "--dx": `${flight.dx}px`, "--dy": `${flight.dy}px` } as React.CSSProperties}
        onAnimationEnd={land}><FileText size={16} /></span>}
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
