import { LoaderCircle, Send, Workflow } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { nativeInvoke, type BridgeInvoke } from "../ai-client";
import {
  createPipeline, listPipelines, sendStage, STAGE_LABELS, STAGES, STATUS_LABELS, updatePipeline,
  type PipelineAction, type PipelineView, type Stage
} from "./pipeline-client";
import type { NetworkSnapshot, ReasonPeer } from "./types";

const REPLY_POLL_MS = 60_000;
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value);
const noAssignees = () => STAGES.map(() => "");
type Props = { active: boolean; snapshot: NetworkSnapshot | null; onRefresh: () => void; call?: BridgeInvoke };

function PeerSelect({ id, label, value, peers, disabled, onChange }: { id: string; label: string; value: string; peers: ReasonPeer[]; disabled: boolean; onChange: (value: string) => void }) {
  const listed = peers.some(peer => peer.id === value);
  return <select id={id} aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="">담당 에이전트 선택</option>
    {value && !listed && <option value={value} disabled>{value} · 현재 목록에 없음</option>}
    {peers.map(peer => <option key={peer.id} value={peer.id}>{peer.name} · {peer.kind}</option>)}
  </select>;
}

/** Five fixed stages. Nothing is sent until the user approves the exact request shown. */
export function ReasonPipeline({ active, snapshot, onRefresh, call = nativeInvoke }: Props) {
  const [views, setViews] = useState<PipelineView[]>([]);
  const [brief, setBrief] = useState("");
  const [assignees, setAssignees] = useState(noAssignees);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const busyRef = useRef(false);
  const peers = snapshot?.peers ?? [];
  const connected = snapshot?.state === "connected";

  const load = useCallback(async () => {
    try { setViews(await listPipelines(call)); setLoadError(""); }
    catch (cause) { setLoadError(errorText(cause)); }
  }, [call]);
  // Replies are linked from mail the network refresh already saved; listing sends nothing.
  useEffect(() => { if (active && snapshot) void load(); }, [active, snapshot, load]);
  const waiting = views.some(view => !view.cancelled && view.stages.some(stage => stage.status === "waiting"));
  useEffect(() => {
    if (!active || !waiting) return;
    const timer = window.setInterval(() => { if (!document.hidden) onRefresh(); }, REPLY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, waiting, onRefresh]);

  const perform = async (task: () => Promise<PipelineView>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const updated = await task();
      setViews(current => current.some(view => view.id === updated.id) ? current.map(view => view.id === updated.id ? updated : view) : [updated, ...current]);
      return updated;
    } catch (cause) { setError(errorText(cause)); await load(); return undefined; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const act = (view: PipelineView, action: PipelineAction) => void perform(() => updatePipeline(view.id, action, peers, call));
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const created = await perform(() => createPipeline(brief, assignees, peers, call));
    if (created) { setBrief(""); setAssignees(noAssignees()); }
  };
  const locked = busy || !connected;

  return <section className="reason-pipeline" aria-labelledby="reason-pipeline-title">
    <div className="reason-section-heading"><h3 id="reason-pipeline-title"><Workflow size={15} />단계별 작업 맡기기</h3><span>디자인 → 기획 → 개발 → 음향 → 배포</span></div>
    <p className="reason-note">단계마다 연결된 에이전트 하나를 정하면, 앞 단계의 답장을 다음 단계 요청에 인용해 이어 갑니다. 요청은 보낼 내용을 확인하고 승인할 때만 전송됩니다.</p>
    {error && <p className="reason-alert" role="alert">{error}</p>}
    {loadError && !error && <p className="reason-alert" role="alert">{loadError}</p>}
    <form className="reason-message-form reason-pipeline-form" aria-label="새 단계 파이프라인" onSubmit={event => void create(event)}>
      <label htmlFor="reason-pipeline-brief">프로젝트 브리프</label>
      <textarea id="reason-pipeline-brief" rows={3} maxLength={2500} disabled={locked} value={brief} onChange={event => setBrief(event.target.value)} placeholder="예: 도트풍 무협 로그라이트 게임을 Android에 출시한다. 가로 화면, 공격과 회피." />
      <div className="reason-stage-assign">{STAGES.map((stage, index) => <label key={stage}>{STAGE_LABELS[stage]}
        <PeerSelect id={"reason-assign-" + stage} label={STAGE_LABELS[stage] + " 담당"} value={assignees[index]} peers={peers} disabled={locked}
          onChange={value => setAssignees(current => current.map((item, i) => i === index ? value : item))} />
      </label>)}</div>
      <button type="submit" className="social-button primary" disabled={locked || !brief.trim()}>파이프라인 만들기</button>
    </form>
    {views.map(view => <PipelineCard key={view.id} view={view} peers={peers} locked={locked} busy={busy}
      onAction={action => act(view, action)} onSend={deployApproved => void perform(() => sendStage(view, deployApproved, call))} />)}
  </section>;
}

type CardProps = {
  view: PipelineView; peers: ReasonPeer[]; locked: boolean; busy: boolean;
  onAction: (action: PipelineAction) => void; onSend: (deployApproved: boolean) => void;
};
function PipelineCard({ view, peers, locked, busy, onAction, onSend }: CardProps) {
  // Approval belongs to the one request on screen; a changed request must be approved again.
  const [deployApproved, setDeployApproved] = useState(false);
  useEffect(() => setDeployApproved(false), [view.next?.digest]);
  // One tick approves one attempt; a failed or uncertain send must be approved again.
  const send = () => { onSend(deployApproved); setDeployApproved(false); };
  const done = view.cancelled || view.current === null;
  const name = (address: string | null) => peers.find(peer => peer.id === address)?.name ?? address ?? "담당자 없음";
  const next = view.next, isDeploy = next?.stage === "deploy";
  // The stage just before an untouched current stage can still be taken back.
  const lastDone = (stage: Stage) => {
    const following = view.stages[STAGES.indexOf(stage) + 1];
    return !!following && view.current === following.stage && following.status === "pending";
  };
  return <article className="reason-message reason-pipeline-card" aria-label={"단계 파이프라인: " + view.brief.slice(0, 40)}>
    <header><div><strong>{view.brief}</strong></div>
      <span className="reason-pipeline-state">{view.cancelled ? "취소됨" : view.current ? STAGE_LABELS[view.current] + " 단계" : "모든 단계 완료"}</span></header>
    <ol className="reason-stages">{view.stages.map(stage => {
      const current = !done && view.current === stage.stage;
      return <li key={stage.stage} className={current ? "current" : undefined} aria-current={current ? "step" : undefined}>
        <div className="reason-stage-row"><strong>{STAGE_LABELS[stage.stage]}</strong><span>{STATUS_LABELS[stage.status]}</span></div>
        {stage.status === "pending" && !done
          ? <PeerSelect id={view.id + "-" + stage.stage} label={STAGE_LABELS[stage.stage] + " 담당 변경"} value={stage.assignee ?? ""} peers={peers} disabled={locked}
              onChange={value => { if (value) onAction({ type: "assign", stage: stage.stage, assignee: value }); }} />
          : <small>{name(stage.assignee)}</small>}
        {stage.reply && <blockquote>{stage.reply}</blockquote>}
        {!done && <div className="reason-actions">
          {current && stage.status === "pending" && <button type="button" className="social-button compact" disabled={locked} onClick={() => onAction({ type: "skip", stage: stage.stage })}>이 단계 건너뛰기</button>}
          {((current && stage.status === "waiting") || (["replied", "skipped"].includes(stage.status) && lastDone(stage.stage)))
            && <button type="button" className="social-button compact" disabled={locked} onClick={() => onAction({ type: "reset", stage: stage.stage })}>{STAGE_LABELS[stage.stage]} 단계 되돌리기</button>}
        </div>}
      </li>;
    })}</ol>
    {view.candidates.length > 0 && view.current && <div className="reason-pipeline-candidates">
      <p className="reason-note">담당 에이전트가 요청을 지정하지 않고 보낸 메시지입니다. 이 단계의 결과가 맞으면 직접 연결하세요.</p>
      {view.candidates.map(candidate => <div key={candidate.id} className="reason-result">
        <strong>{candidate.fromName || candidate.from}</strong><pre className="reason-message-text">{candidate.text}</pre>
        <button type="button" className="social-button compact" disabled={locked} onClick={() => onAction({ type: "attach", stage: view.current!, messageId: candidate.id })}>이 답장으로 진행</button>
      </div>)}
    </div>}
    {next && <div className="reason-pipeline-approval" role="group" aria-label={STAGE_LABELS[next.stage] + " 단계 전송 승인"}>
      <strong>{STAGE_LABELS[next.stage]} 단계 요청 · 받는 에이전트 {name(next.assignee)}</strong>
      {next.resend && <p className="reason-alert" role="alert">이전 전송이 도착했는지 확인하지 못했습니다. 다시 보내면 상대에게 같은 요청이 두 번 갈 수 있습니다.</p>}
      <pre className="reason-message-text">{next.text}</pre>
      {isDeploy && <label className="reason-deploy-approve"><input type="checkbox" checked={deployApproved} disabled={locked} onChange={event => setDeployApproved(event.target.checked)} />
        이 에이전트가 배포를 진행하도록 승인합니다.</label>}
      <div className="reason-actions">
        <button type="button" className="social-button primary" disabled={locked || (isDeploy && !deployApproved)} onClick={send}>
          {busy ? <LoaderCircle size={14} className="social-spin" /> : <Send size={14} />}{next.resend ? "확인했고 다시 보내기" : "승인하고 보내기"}</button>
        {next.resend && <button type="button" className="social-button compact" disabled={locked} onClick={() => onAction({ type: "assumeSent", stage: next.stage })}>보낸 것으로 보고 답장 기다리기</button>}
      </div>
    </div>}
    {!done && <div className="reason-actions"><button type="button" className="social-button compact" disabled={busy} onClick={() => onAction({ type: "cancel" })}>파이프라인 취소</button></div>}
  </article>;
}
