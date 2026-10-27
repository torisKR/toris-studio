import { Check, CircleAlert, FileCode2, Square, Terminal, X } from "lucide-react";
import { useState } from "react";
import { AGENTS, PHASE_LABELS, diffLines, runTitle, type AgentRole, type PendingAction, type RunSummary } from "./agent-client";
import { AgentOffice } from "./AgentOffice";
import "./AgentOffice.css";

const time = (iso: string) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export type Decide = (action: PendingAction, decision: "approve" | "reject", feedback: string) => void;

function Approval({ action, busy, onDecide }: { action: PendingAction; busy: boolean; onDecide: Decide }) {
  const [feedback, setFeedback] = useState("");
  const who = AGENTS.find(a => a.id === action.agent)?.name;
  return <section className="agent-approval" aria-label={`승인 요청 · ${who}`} data-agent={action.agent}>
    <header><CircleAlert size={18} /><strong>{action.kind === "write_file" ? "파일 변경 승인" : action.kind === "save_draft" ? (action.target === "ops_task" ? "작업 열기 승인" : "초안 저장 승인") : "명령 실행 승인"}</strong><small>{who} 요청</small>{action.kind === "save_draft" && action.template && <span className="agent-template">템플릿 · AI 아님</span>}</header>
    {action.reason && <p className="agent-reason">{action.reason}</p>}
    {action.kind === "write_file"
      ? <><p className="agent-path"><FileCode2 size={14} />{action.path}</p>
        <pre className="agent-diff" aria-label="변경 내용 diff">{diffLines(action.diff).map((line, i) => <span key={i} className={`diff-line diff-${line.kind}`}>{line.text || " "}</span>)}</pre></>
      : action.kind === "save_draft"
        ? <><p className="agent-path"><FileCode2 size={14} />{action.title}</p><pre className="agent-draft" aria-label="저장할 내용">{action.preview}</pre></>
        : <pre className="agent-command" aria-label="실행할 명령"><Terminal size={14} /> {action.cwd}$ {action.command.join(" ")}</pre>}
    <textarea rows={2} maxLength={2000} placeholder="거절하거나 수정 방향을 줄 때 의견 (선택)" value={feedback} onChange={e => setFeedback(e.target.value)} aria-label="승인 의견" />
    <div className="agent-actions">
      <button className="social-button primary" disabled={busy} onClick={() => onDecide(action, "approve", feedback)}><Check size={15} />{action.kind === "save_draft" ? "승인하고 저장" : "승인하고 실행"}</button>
      <button className="social-button" disabled={busy} onClick={() => onDecide(action, "reject", feedback)}><X size={15} />거절</button>
    </div>
    <p className="agent-hint">{action.kind === "save_draft" ? "승인 전에는 저장하지 않습니다. 초안은 초안 상태로만 저장되고 자동으로 게시하지 않습니다." : "승인 전에는 파일을 쓰거나 명령을 실행하지 않습니다. 승인 뒤 파일이 바뀌어 있으면 적용하지 않습니다."}</p>
  </section>;
}

export function AgentRunView({ run, busy, onDecide, onCancel }: { run: RunSummary; busy: (action: PendingAction) => boolean; onDecide: Decide; onCancel: () => void }) {
  const terminal = run.phase === "done" || run.phase === "failed" || run.phase === "cancelled";
  const [focus, setFocus] = useState<AgentRole | null>(null);
  const events = [...run.events].reverse().filter(e => !focus || e.agent === focus).slice(0, 120);
  return <section className="agent-card agent-run" aria-label="작업 진행">
    <div className="agent-card-head">
      <div><h2>{runTitle(run)}</h2>{run.task && <p className="agent-task">{run.task}</p>}</div>
      {!terminal && <button className="social-button" onClick={onCancel}><Square size={14} />작업 취소</button>}
    </div>
    <AgentOffice run={run} focus={focus} onFocus={setFocus} />
    {!terminal && run.approvals.length > 1 && <p className="agent-hint" role="status">승인 요청 {run.approvals.length}건이 기다립니다. 결정하지 않은 요청이 있어도 다른 에이전트는 계속 일합니다.</p>}
    {!terminal && run.approvals.map(action => <Approval key={action.id} action={action} busy={busy(action)} onDecide={onDecide} />)}
    {terminal && <div className={`social-notice ${run.phase === "done" ? "success" : "info"}`}><span><strong>{PHASE_LABELS[run.phase]}</strong> {run.summary}</span></div>}
    {run.changes.length > 0 && <div className="agent-changes"><strong>변경한 파일</strong>{run.changes.map(file => <code key={file}>{file}</code>)}</div>}
    {focus && <div className="agent-filter"><span>{AGENTS.find(a => a.id === focus)?.name} 기록만 보는 중</span><button type="button" className="social-button compact" onClick={() => setFocus(null)}>전체 보기</button></div>}
    <ol className="agent-timeline" aria-label="진행 기록">
      {events.map(event => <li key={event.seq} data-agent={event.agent} data-phase={event.phase}>
        <time>{time(event.at)}</time><span className="agent-chip">{AGENTS.find(a => a.id === event.agent)?.name}</span><span>{event.message}</span>
        {event.detail && <details><summary>자세히</summary><pre>{event.detail}</pre></details>}
      </li>)}
    </ol>
  </section>;
}
