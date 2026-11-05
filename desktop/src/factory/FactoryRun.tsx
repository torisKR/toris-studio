import { Square } from "lucide-react";
import { useState } from "react";
import type { PendingAction, RunSummary } from "../agent-client";

export function FactoryRun({ run, busy, onDecide, onCancel }: { run: RunSummary; busy: boolean; onDecide: (action: PendingAction, decision: "approve" | "reject", feedback: string) => void; onCancel: () => void }) {
  const terminal = run.phase === "done" || run.phase === "failed" || run.phase === "cancelled";
  return <section className="factory-card" aria-label="팩토리 진행">
    <div className="factory-actions"><h2>진행 · {run.phase}</h2>{!terminal && <button type="button" className="social-button" onClick={onCancel} disabled={busy}><Square size={14} />중단</button>}</div>
    {run.approvals.map(action => <FactoryApproval key={action.id} action={action} busy={busy} onDecide={onDecide} />)}
    <ol className="factory-list" aria-label="진행 기록">
      {[...run.events].slice(-12).reverse().map(event => <li key={event.seq}><strong>{event.message}</strong>{event.detail && !event.detail.startsWith("{") && <small>{event.detail}</small>}</li>)}
    </ol>
  </section>;
}

function FactoryApproval({ action, busy, onDecide }: { action: PendingAction; busy: boolean; onDecide: (action: PendingAction, decision: "approve" | "reject", feedback: string) => void }) {
  const [feedback, setFeedback] = useState("");
  const title = action.kind === "factory_gate" ? (action.gate === "release" ? "릴리스 승인" : action.gate === "paid_api" ? "유료 API 승인" : "기기 설치 승인") : "승인";
  const preview = action.kind === "factory_gate" ? action.preview : action.kind === "run_command" ? action.command.join(" ") : action.kind === "write_file" ? action.path : action.title;
  return <div className="factory-card" aria-label={title}>
    <h2>{title}</h2>
    <p>{action.reason}</p>
    <pre>{preview}</pre>
    <textarea rows={2} maxLength={2000} value={feedback} onChange={event => setFeedback(event.target.value)} aria-label="승인 의견" />
    <div className="factory-actions">
      <button type="button" className="social-button primary" disabled={busy} onClick={() => onDecide(action, "approve", feedback)}>승인</button>
      <button type="button" className="social-button" disabled={busy} onClick={() => onDecide(action, "reject", feedback)}>거절</button>
    </div>
    <p>승인해도 서명하거나 스토어에 제출하지 않습니다. 유료 호출과 기기 설치만 이어서 진행합니다.</p>
  </div>;
}
