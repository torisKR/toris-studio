import { useState } from "react";
import type { PendingAction } from "../agent-client";
import { taskStatusLabel, type FactoryJobView } from "./factory-client";
import { taskLabel } from "./FactoryDag";

export function FactoryTaskDetail({ job, action, busy, onDecide }: { job: FactoryJobView | null; action: PendingAction | null; busy: boolean; onDecide: (action: PendingAction, decision: "approve" | "reject", feedback: string) => void }) {
  if (!job) return <p className="factory-empty">칸을 누르면 그 작업의 메시지와 승인 버튼이 여기에 붙습니다.</p>;
  return <div className="factory-detail" aria-label={`${taskLabel(job.taskId)} 상세`}>
    <strong>{taskLabel(job.taskId)}</strong>
    <small className={`factory-status ${job.status}`}>{taskStatusLabel(job.status)}{job.approval === "explicit" ? " · 승인 필요" : ""}</small>
    <p>{job.message || "아직 기록이 없습니다."}</p>
    {action?.kind === "factory_gate" && <FactoryApproval action={action} busy={busy} onDecide={onDecide} />}
  </div>;
}

function FactoryApproval({ action, busy, onDecide }: { action: Extract<PendingAction, { kind: "factory_gate" }>; busy: boolean; onDecide: (action: PendingAction, decision: "approve" | "reject", feedback: string) => void }) {
  const [feedback, setFeedback] = useState("");
  const title = action.gate === "release" ? "릴리스 승인" : action.gate === "paid_api" ? "유료 API 승인" : "기기 설치 승인";
  return <div aria-label={title}>
    <h2>{title}</h2>
    <p>{action.reason}</p>
    <pre>{action.preview}</pre>
    <textarea rows={2} maxLength={2000} value={feedback} onChange={event => setFeedback(event.target.value)} aria-label="승인 의견" />
    <div className="factory-actions">
      <button type="button" className="social-button primary" disabled={busy} onClick={() => onDecide(action, "approve", feedback)}>승인</button>
      <button type="button" className="social-button" disabled={busy} onClick={() => onDecide(action, "reject", feedback)}>거절</button>
    </div>
    <p className="factory-note">승인해도 서명하거나 스토어에 제출하지 않습니다. 유료 호출과 기기 설치만 이어서 진행합니다.</p>
  </div>;
}
