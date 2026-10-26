import { Bot, Check, CircleAlert, Code2, FileCode2, LayoutTemplate, ShieldCheck, Square, Terminal, X } from "lucide-react";
import { useState } from "react";
import { AGENTS, PHASE_LABELS, diffLines, stageProgress, type AgentRole, type PendingAction, type RunSummary } from "./agent-client";

const ICONS: Record<AgentRole, typeof Bot> = { supervisor: Bot, frontend: LayoutTemplate, backend: Code2, qa: ShieldCheck };
const time = (iso: string) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Lanes({ run }: { run: RunSummary }) {
  const terminal = run.phase === "done" || run.phase === "failed" || run.phase === "cancelled";
  return <div className="agent-lanes" role="list" aria-label="에이전트 상태">
    {AGENTS.map(agent => {
      const Icon = ICONS[agent.id];
      const active = !terminal && run.agent === agent.id;
      const last = [...run.events].reverse().find(e => e.agent === agent.id);
      const touched = Boolean(last);
      return <div key={agent.id} role="listitem" className={`agent-lane${active ? " active" : ""}${touched ? " touched" : ""}`} data-phase={active ? run.phase : undefined} aria-current={active ? "step" : undefined}>
        <span className="agent-avatar" aria-hidden="true"><Icon size={20} /></span>
        <div><strong>{agent.name}</strong><small>{agent.role}</small>
          <span className="agent-lane-state">{active ? PHASE_LABELS[run.phase] : touched ? (terminal ? "종료" : "대기") : "-"}</span>
        </div>
      </div>;
    })}
  </div>;
}

function Approval({ action, busy, onDecide }: { action: PendingAction; busy: boolean; onDecide: (decision: "approve" | "reject", feedback: string) => void }) {
  const [feedback, setFeedback] = useState("");
  return <section className="agent-approval" aria-label="승인 요청">
    <header><CircleAlert size={18} /><strong>{action.kind === "write_file" ? "파일 변경 승인" : "명령 실행 승인"}</strong><small>{AGENTS.find(a => a.id === action.agent)?.name} 요청</small></header>
    {action.reason && <p className="agent-reason">{action.reason}</p>}
    {action.kind === "write_file"
      ? <><p className="agent-path"><FileCode2 size={14} />{action.path}</p>
        <pre className="agent-diff" aria-label="변경 내용 diff">{diffLines(action.diff).map((line, i) => <span key={i} className={`diff-line diff-${line.kind}`}>{line.text || " "}</span>)}</pre></>
      : <pre className="agent-command" aria-label="실행할 명령"><Terminal size={14} /> {action.cwd}$ {action.command.join(" ")}</pre>}
    <textarea rows={2} maxLength={2000} placeholder="거절하거나 수정 방향을 줄 때 의견 (선택)" value={feedback} onChange={e => setFeedback(e.target.value)} aria-label="승인 의견" />
    <div className="agent-actions">
      <button className="social-button primary" disabled={busy} onClick={() => onDecide("approve", feedback)}><Check size={15} />승인하고 실행</button>
      <button className="social-button" disabled={busy} onClick={() => onDecide("reject", feedback)}><X size={15} />거절</button>
    </div>
    <p className="agent-hint">승인 전에는 파일을 쓰거나 명령을 실행하지 않습니다. 승인 뒤 파일이 바뀌어 있으면 적용하지 않습니다.</p>
  </section>;
}

export function AgentRunView({ run, busy, onDecide, onCancel }: { run: RunSummary; busy: boolean; onDecide: (decision: "approve" | "reject", feedback: string) => void; onCancel: () => void }) {
  const progress = stageProgress(run);
  const terminal = run.phase === "done" || run.phase === "failed" || run.phase === "cancelled";
  return <section className="agent-card agent-run" aria-label="작업 진행">
    <div className="agent-card-head">
      <div><h2>{run.project}</h2><p className="agent-task">{run.task}</p></div>
      {!terminal && <button className="social-button" onClick={onCancel}><Square size={14} />작업 취소</button>}
    </div>
    <div className="agent-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-valuetext={progress.label}>
      <span style={{ width: `${progress.percent}%` }} data-state={run.phase} /><b>{progress.label}</b>
    </div>
    <Lanes run={run} />
    {run.pending && run.phase === "awaiting_approval" && <Approval key={run.pending.id} action={run.pending} busy={busy} onDecide={onDecide} />}
    {terminal && <div className={`social-notice ${run.phase === "done" ? "success" : "info"}`}><span><strong>{PHASE_LABELS[run.phase]}</strong> {run.summary}</span></div>}
    {run.changes.length > 0 && <div className="agent-changes"><strong>변경한 파일</strong>{run.changes.map(file => <code key={file}>{file}</code>)}</div>}
    <ol className="agent-timeline" aria-label="진행 기록">
      {[...run.events].reverse().slice(0, 120).map(event => <li key={event.seq} data-agent={event.agent} data-phase={event.phase}>
        <time>{time(event.at)}</time><span className="agent-chip">{AGENTS.find(a => a.id === event.agent)?.name}</span><span>{event.message}</span>
        {event.detail && <details><summary>자세히</summary><pre>{event.detail}</pre></details>}
      </li>)}
    </ol>
  </section>;
}
