import { Clapperboard, CornerUpLeft, RefreshCw, Send } from "lucide-react";
import { JOB_STATUS_LABELS, STYLES } from "../production/production-model";
import type { ReasonMessage, VideoResult } from "./types";

type Props = {
  messages: ReasonMessage[]; results: Record<string, VideoResult>; busy: boolean; connected: boolean;
  onAccept: (messageId: string) => void; onReply: (message: ReasonMessage) => void;
  onInspect: (messageId: string) => void; onSendResult: (messageId: string) => void; onOpenProduction: (jobId: string) => void;
};
function dateLabel(raw: string | null): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function ReasonInbox({ messages, results, busy, connected, onAccept, onReply, onInspect, onSendResult, onOpenProduction }: Props) {
  return <section className="reason-inbox" aria-labelledby="reason-inbox-title">
    <div className="reason-section-heading"><h3 id="reason-inbox-title">받은 요청</h3><span>{messages.length}개</span></div>
    {!messages.length ? <p className="reason-empty">받은 메시지가 없습니다. 연결된 AI에게 이 Studio 주소로 요청을 보내 달라고 하세요.</p>
      : <ul className="reason-messages">{messages.map(message => {
        const request = message.video, settings = request?.settings, storyboard = request?.storyboard, result = results[message.id];
        const date = dateLabel(message.createdAt);
        return <li key={message.id}>
          <article className="reason-message" aria-label={(message.fromName || message.from) + "의 요청"}>
            <header><div><strong>{message.fromName || message.from}</strong><code>{message.from}</code></div>{date && <time dateTime={message.createdAt!}>{date}</time>}</header>
            {request && settings ? <div className="reason-video-request">
              <span className="reason-request-kind"><Clapperboard size={14} />영상 제작 요청</span>
              <h4>{storyboard?.title || settings.topic}</h4>
              <p>{settings.durationSec}초 · {settings.aspect} · {STYLES[settings.style]} · {settings.visual === "stock" ? "사진 + 모션" : "AI 장면"} · {settings.narration ? "나레이션 포함" : "나레이션 없음"}</p>
              <small>요청 ID: {request.requestId}</small>
              {storyboard && <details className="reason-storyboard">
                <summary>받은 스토리보드 · {storyboard.scenes.length}개 장면</summary>
                {storyboard.story && <p>{storyboard.story}</p>}
                <ol>{storyboard.scenes.map((scene, index) => <li key={scene.id}>
                  <div><strong>{index + 1}. {scene.caption || "장면"}</strong><span>{scene.durationSec}초</span></div>
                  {scene.script && <p>{scene.script}</p>}
                  {scene.narration && <blockquote>{scene.narration}</blockquote>}
                </li>)}</ol>
              </details>}
              {!message.jobId && <p className="reason-note">{storyboard ? "받은 대본과 장면 구성을 그대로 가져와 검토합니다. 스토리보드 승인 후 이 컴퓨터에서 영상을 생성합니다." : "Agent 탭의 모델로 기획하며, 모델이 없으면 기본 템플릿을 사용합니다. 스토리보드 승인 후 이 컴퓨터에서 영상을 생성합니다."}</p>}
            </div> : <pre className="reason-message-text">{message.text || "본문 없는 메시지"}</pre>}
            {request && <details className="reason-original"><summary>원본 메시지 보기</summary><pre>{message.text}</pre></details>}
            {message.requestError && <p className="reason-request-error" role="note">{message.requestError}</p>}
            <div className="reason-actions">
              {request && !message.requestError && !message.jobId && <button type="button" className="social-button compact primary" disabled={busy || !connected} onClick={() => onAccept(message.id)}><Clapperboard size={14} />{storyboard ? "스토리보드 가져오기" : "영상 기획 만들기"}</button>}
              {message.jobId && <><button type="button" className="social-button compact primary" disabled={busy} onClick={() => onOpenProduction(message.jobId!)}><Clapperboard size={14} />영상 제작으로 열기</button>
                <button type="button" className="social-button compact" disabled={busy} onClick={() => onInspect(message.id)}><RefreshCw size={14} />작업 결과 확인</button></>}
              <button type="button" className="social-button compact" disabled={busy || !connected} onClick={() => onReply(message)}><CornerUpLeft size={14} />답장 작성</button>
            </div>
            {result && <section className="reason-result" aria-label="영상 작업 결과">
              <div className="reason-section-heading"><strong>{result.title || "영상 작업"}</strong><span>{JOB_STATUS_LABELS[result.status as keyof typeof JOB_STATUS_LABELS] ?? result.status}</span></div>
              <pre>{result.summary}</pre>
              {result.requiresApproval && <p className="reason-note">{result.status === "done" ? "완성 영상의 외부 게시는 발행 화면에서 별도로 승인합니다." : "영상 제작 화면에서 스토리보드 승인을 기다리고 있습니다."}</p>}
              <p className="reason-note">보내기를 누르면 최신 작업 상태 요약을 요청자에게 전송합니다. 영상 파일을 업로드하거나 SNS에 게시하지 않습니다.</p>
              <button type="button" className="social-button compact" disabled={busy || !connected} onClick={() => onSendResult(message.id)}><Send size={14} />작업 상태 보내기</button>
            </section>}
          </article>
        </li>;
      })}</ul>}
  </section>;
}
