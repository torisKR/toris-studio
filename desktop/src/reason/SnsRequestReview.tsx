import { CalendarClock, CheckCircle2, Megaphone, Send } from "lucide-react";
import { useState } from "react";
import { isManualPlatform, localToRfc3339, parseHashtags, platformLabel, platformLimit, postLength, rfc3339ToLocal, type SnsImportInput } from "./sns-client";
import type { ReasonMessage, SnsPlatform } from "./types";

type Draft = { include: boolean; title: string; text: string; tags: string };
type Props = {
  message: ReasonMessage; busy: boolean; connected: boolean;
  onImport: (input: SnsImportInput) => void; onSendResult: (messageId: string) => void; onOpenPublications?: () => void;
};

/** Review screen for a received SNS plan. Importing saves drafts only; nothing is posted. */
export function SnsRequestReview({ message, busy, connected, onImport, onSendResult, onOpenPublications }: Props) {
  const request = message.sns!;
  const imported = message.snsImport?.state === "imported" ? message.snsImport : null;
  const [title, setTitle] = useState(request.title);
  const [schedule, setSchedule] = useState(rfc3339ToLocal(request.scheduleAt));
  const [attachMedia, setAttachMedia] = useState(!!request.media);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(request.posts.map(post =>
    [post.platform, { include: true, title: post.title ?? "", text: post.text, tags: post.hashtags.map(tag => "#" + tag).join(" ") }])));
  const [error, setError] = useState("");
  const patch = (platform: SnsPlatform, next: Partial<Draft>) => setDrafts(current => ({ ...current, [platform]: { ...current[platform], ...next } }));
  const chosen = request.posts.filter(post => drafts[post.platform]?.include);
  const over = chosen.some(post => postLength(drafts[post.platform].text, parseHashtags(drafts[post.platform].tags)) > platformLimit(post.platform));
  const submit = () => {
    setError("");
    try {
      onImport({
        messageId: message.id, title, attachMedia, scheduleAt: localToRfc3339(schedule),
        posts: chosen.map(post => { const d = drafts[post.platform]; return { platform: post.platform, text: d.text, hashtags: parseHashtags(d.tags), ...(d.title.trim() ? { title: d.title } : {}) }; })
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <div className="reason-video-request reason-sns-request">
    <span className="reason-request-kind"><Megaphone size={14} />SNS 게시 기획{message.snsVia ? " · " + message.snsVia + " 전달문" : ""}</span>
    <h4>{request.title}</h4>
    <p>{request.posts.map(post => platformLabel(post.platform)).join(" · ")}{request.scheduleAt ? " · 예약 희망 " + new Date(request.scheduleAt).toLocaleString("ko-KR") : ""}{request.media ? " · " + (request.media.kind === "videoJob" ? "Studio 영상 작업 연결" : "게시 미디어 연결") : ""}</p>
    <small>요청 ID: {request.requestId}</small>
    {imported ? <div className="reason-sns-imported" role="status">
      <p><CheckCircle2 size={14} />SNS 콘텐츠 초안 {imported.contentDrafts}개와 발행 계획 초안 {imported.publicationDrafts}개로 저장했습니다{imported.mediaAttached ? " (미디어 연결됨)" : ""}. 아직 게시하지 않았습니다.</p>
      <p className="reason-note">발행 화면에서 계정을 고르고 미리 확인한 뒤 승인해야 게시됩니다. X·네이버 블로그·네이버 클립은 수동 게시로 넘깁니다.</p>
      <div className="reason-actions">
        {onOpenPublications && <button type="button" className="social-button compact primary" disabled={busy} onClick={onOpenPublications}><Send size={14} />발행 화면 열기</button>}
        <button type="button" className="social-button compact" disabled={busy || !connected} onClick={() => onSendResult(message.id)}><Send size={14} />가져오기 결과 보내기</button>
      </div>
    </div> : !message.requestError && <form className="reason-sns-form" aria-label="SNS 기획 검토" onSubmit={event => { event.preventDefault(); submit(); }}>
      <label>기획 제목<input value={title} maxLength={120} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      {request.posts.map(post => {
        const d = drafts[post.platform], length = postLength(d.text, parseHashtags(d.tags)), limit = platformLimit(post.platform);
        return <fieldset key={post.platform} className="reason-sns-post" disabled={busy}>
          <legend><label><input type="checkbox" checked={d.include} onChange={event => patch(post.platform, { include: event.target.checked })} />{platformLabel(post.platform)}</label>
            <small>{isManualPlatform(post.platform) ? "수동 게시" : "승인 후 게시"}</small></legend>
          {d.include && <>
            {(post.platform === "youtube" || post.platform === "naver_blog" || post.title) && <label>제목<input value={d.title} maxLength={100} onChange={event => patch(post.platform, { title: event.target.value })} placeholder="비우면 기획 제목을 씁니다" /></label>}
            <label>본문<textarea rows={4} value={d.text} aria-label={platformLabel(post.platform) + " 본문"} onChange={event => patch(post.platform, { text: event.target.value })} /></label>
            <label>해시태그<input value={d.tags} aria-label={platformLabel(post.platform) + " 해시태그"} onChange={event => patch(post.platform, { tags: event.target.value })} placeholder="#태그 #태그" /></label>
            <small className={length > limit ? "reason-sns-over" : undefined}>{length.toLocaleString("ko-KR")} / {limit.toLocaleString("ko-KR")}자{length > limit ? " · 너무 깁니다" : ""}</small>
          </>}
        </fieldset>;
      })}
      <label><span><CalendarClock size={13} />예약 희망 시간 · 선택</span><input type="datetime-local" value={schedule} disabled={busy} onChange={event => setSchedule(event.target.value)} /></label>
      {request.media && <label className="reason-sns-check"><input type="checkbox" checked={attachMedia} disabled={busy} onChange={event => setAttachMedia(event.target.checked)} />{request.media.kind === "videoJob" ? "Studio 영상 작업의 완성 영상을 게시 미디어로 연결" : "게시 미디어 연결"}</label>}
      <p className="reason-note">가져오기는 SNS 콘텐츠 초안과 발행 계획 초안만 저장합니다. 게시·예약 실행은 발행 화면에서 계정을 고르고 승인할 때만 합니다.</p>
      {error && <p className="reason-request-error" role="alert">{error}</p>}
      <button type="submit" className="social-button compact primary" disabled={busy || !chosen.length || over || !title.trim()}><Megaphone size={14} />SNS 초안으로 가져오기</button>
    </form>}
  </div>;
}
