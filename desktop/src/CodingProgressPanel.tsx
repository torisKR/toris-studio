import { Check, Circle, Copy, ExternalLink, MessageSquare, TriangleAlert } from "lucide-react";
import type { ChatReceipt, ChatState, CodexifyChat } from "./codexify-client";
import { codingProgress, elapsedLabel, progressLabels } from "./coding-progress-client";
import type { RequestStage } from "./coding-progress-client";
import "./CodingProgressPanel.css";

const stages: RequestStage[] = ["saved", "delivered", "read", "reply"];
function date(value: number | null): string { return value != null ? new Date(value).toLocaleString("ko-KR") : "기록 없음"; }

export function CodingProgressPanel({ state, receipt, conversationSelected, observedAt, now, error, selectedChat, onShowChat, onOpenChat, onCopyStart, canStartChat, actionBusy }: {
  state: ChatState | null;
  receipt: ChatReceipt | null;
  conversationSelected: boolean;
  observedAt: number;
  now: number;
  error: string;
  selectedChat?: CodexifyChat;
  onShowChat: () => void;
  onOpenChat: () => void;
  onCopyStart: () => void;
  canStartChat: boolean;
  actionBusy: boolean;
}) {
  const progress = codingProgress({ state, receipt, conversationSelected, observedAt, now, error });
  const current = progress.latest;
  return <section className={`coding-progress-panel ${progress.tone}`} aria-label="코딩 작업 진행 상황">
    <header><div><span className="codexify-eyebrow">WORK OBSERVATIONS</span><h3>지금 어떤 단계인가요?</h3></div><span className="coding-observation-time">상태 확인 {observedAt ? elapsedLabel(observedAt, now) : "기록 없음"}</span></header>
    <div className="coding-progress-summary" role="status" aria-live="polite" aria-atomic="true">{progress.stale ? <TriangleAlert size={20}/> : <MessageSquare size={20}/>}<div><strong>{progress.title}</strong><p>{progress.detail}</p></div></div>
    {current && <>
      <ol className="coding-stepper" aria-label="최근 요청 전달 단계">{stages.map(stage => {
        const reached = stage === "saved" || stage === "delivered" && Boolean(state && state.delivered_through >= current.request.end) || stage === "read" && Boolean(state && state.read_through >= current.request.end) || stage === "reply" && Boolean(current.reply);
        return <li key={stage} className={reached ? "observed" : "pending"}>{reached ? <Check size={14}/> : <Circle size={14}/>}<span>{progressLabels[stage]}</span><small>{reached ? progress.stale ? "이전 확인 기록" : "확인됨" : "확인 대기"}</small></li>;
      })}</ol>
      <div className="coding-current-request"><div><span>최근 요청</span><time dateTime={current.request.created_at_ms != null ? new Date(current.request.created_at_ms).toISOString() : undefined}>{date(current.request.created_at_ms)}</time></div><p>{current.content}</p><code>요청 ID · {current.request.id}</code></div>
      {current.reply && <div className="coding-response-preview"><span>이 요청 이후의 최근 ChatGPT 응답</span><p>{current.reply.markdown}</p><small>응답 관찰 · {date(current.reply.created_at_ms)}</small></div>}
    </>}
    <dl className="coding-agent-evidence"><div><dt>ChatGPT 요청 대기</dt><dd>{progress.stale ? "재확인 필요" : progress.agentWaiting ? "chat_await 대기 확인됨" : "활성 대기 확인 안 됨"}</dd></div><div><dt>최근 ChatGPT 도구 접근</dt><dd>{date(state?.last_agent_call_at_ms ?? null)}</dd></div><div><dt>대화에서 관찰한 도구 호출</dt><dd>{state?.total_tool_calls != null ? `${state.total_tool_calls}회 · 누적` : selectedChat ? `${selectedChat.totalToolCalls}회 · 누적` : "대화 목록 확인 필요"}</dd></div></dl>
    {progress.recent.length > 1 && <details className="coding-recent-requests"><summary>최근 요청 {progress.recent.length}개</summary><ol>{progress.recent.map(item => <li key={item.request.id}><strong>{progressLabels[item.stage]}</strong><p>{item.content}</p><small>요청 ID · {item.request.id}</small></li>)}</ol></details>}
    <div className="codexify-actions">{conversationSelected && !progress.agentWaiting && <><button className="social-button compact" disabled={!canStartChat || actionBusy} onClick={onOpenChat}><ExternalLink size={14}/>ChatGPT에서 연결 이어가기</button><button className="social-button compact" disabled={!canStartChat || actionBusy} onClick={onCopyStart}><Copy size={14}/>ChatGPT 연결 안내 복사</button></>}<button className="social-button compact" onClick={onShowChat}>대화와 작업 요청으로 이동</button></div>
  </section>;
}
