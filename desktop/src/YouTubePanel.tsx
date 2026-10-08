import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, Check, CircleAlert, Clock3, Eye, KeyRound, LoaderCircle, MessageCircle, Plus, RefreshCw, Search, Settings2, ShieldCheck, ThumbsUp, Video } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { External } from "./External";
import type { PublicSettings } from "./SettingsPanel";
import type { SocialChannel } from "./types";
import "./YouTubePanel.css";

type YouTubeChannel = {
  id: string; title: string; description: string; url: string;
  thumbnailUrl?: string; subscriberCount?: number; hiddenSubscriberCount: boolean;
  videoCount?: number; viewCount?: number; uploadsPlaylistId?: string;
};
type YouTubeVideo = {
  id: string; title: string; url: string; publishedAt: string;
  thumbnailUrl?: string; viewCount?: number; likeCount?: number;
  commentCount?: number; durationSeconds?: number;
};
type VideoResult = { channel: YouTubeChannel; videos: YouTubeVideo[]; fetchedAt: string };
type Notice = { text: string; tone: "success" | "error" | "info" };
type Props = {
  active?: boolean; databaseConnected?: boolean;
  onMessage?: (notice: Notice) => void;
  onOpenSettings?: () => void;
  onChanged?: () => void;
};

function failure(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "YouTube 정보를 불러오지 못했습니다. 잠시 후 다시 시도하세요.";
}
function count(value?: number) {
  return value !== undefined && Number.isFinite(value) ? new Intl.NumberFormat("ko-KR").format(value) : "제공되지 않음";
}
function date(value: string, withTime = false) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "제공되지 않음" : new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "short", day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {})
  }).format(parsed);
}
function duration(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "길이 미제공";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

export function YouTubePanel({ active = true, databaseConnected = true, onMessage, onOpenSettings, onChanged }: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState<YouTubeChannel | null>(null);
  const [videos, setVideos] = useState<YouTubeVideo[]>([]);
  const [fetchedAt, setFetchedAt] = useState("");
  const [busy, setBusy] = useState<"lookup" | "videos" | "register" | null>(null);
  const [error, setError] = useState("");
  const [videoError, setVideoError] = useState("");
  const [registered, setRegistered] = useState<string[]>([]);
  const [sort, setSort] = useState<"latest" | "views">("latest");

  const checkSettings = useCallback(async () => {
    setSettingsError("");
    try { setConfigured((await invoke<PublicSettings>("get_settings")).youtubeConfigured); }
    catch (reason) { setConfigured(null); setSettingsError(failure(reason)); }
  }, []);
  useEffect(() => { if (active) void checkSettings(); }, [active, checkSettings]);

  const sortedVideos = useMemo(() => [...videos].sort((left, right) => {
    const published = (Date.parse(right.publishedAt) || 0) - (Date.parse(left.publishedAt) || 0);
    return sort === "views" ? (right.viewCount ?? -1) - (left.viewCount ?? -1) || published : published;
  }), [videos, sort]);

  async function loadVideos(channelId: string) {
    setVideoError("");
    try {
      const result = await invoke<VideoResult>("youtube_channel_videos", { channelId });
      setChannel(result.channel); setVideos(result.videos); setFetchedAt(result.fetchedAt);
    } catch (reason) { setVideoError(failure(reason)); }
  }
  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim() || busy) return;
    setBusy("lookup"); setError(""); setVideoError(""); setChannel(null); setVideos([]); setFetchedAt("");
    try {
      const result = await invoke<YouTubeChannel>("youtube_lookup_channel", { input: { query: query.trim() } });
      setChannel(result);
      await loadVideos(result.id);
    } catch (reason) { setError(failure(reason)); }
    finally { setBusy(null); }
  }
  async function refresh() {
    if (!channel || busy) return;
    setBusy("videos");
    await loadVideos(channel.id);
    setBusy(null);
  }
  async function register() {
    if (!channel || busy) return;
    setBusy("register"); setError("");
    try {
      await invoke<SocialChannel>("create_channel", {
        input: { platform: "youtube", name: channel.title, handle: channel.id, url: channel.url }
      });
      setRegistered((current) => [...current, channel.id]);
      onChanged?.();
      onMessage?.({ tone: "success", text: `${channel.title} 채널을 로컬 DB에 등록했습니다. 내 채널과 콘텐츠 플래너에서 사용할 수 있습니다.` });
    } catch (reason) { setError(failure(reason)); }
    finally { setBusy(null); }
  }

  return <div className="desktop-youtube">
    <div className="desktop-youtube-connection"><div><KeyRound size={18} aria-hidden="true" /><span>YouTube Data API 키</span><strong className={configured ? "configured" : ""}>{configured === null ? "확인 중" : configured ? "저장됨 · 조회 시 확인" : "설정 필요"}</strong></div><button type="button" className="social-button compact" onClick={onOpenSettings} disabled={!onOpenSettings}><Settings2 size={14} />연결 설정</button></div>
    {settingsError && <div className="social-notice error" role="alert"><CircleAlert size={18} /><span>{settingsError}</span><button type="button" className="social-button compact" onClick={() => void checkSettings()}>다시 확인</button></div>}
    {configured === false ? <div className="desktop-youtube-setup"><span className="desktop-youtube-symbol"><Video size={27} aria-hidden="true" /></span><div><h2>내 채널의 공개 성과를 확인하세요</h2><p>연결 설정에 YouTube Data API 키를 저장하면 채널의 구독자·조회수와 최근 공개 영상을 조회할 수 있습니다.</p></div><button type="button" className="social-button primary" onClick={onOpenSettings} disabled={!onOpenSettings}><KeyRound size={16} />API 키 설정</button></div> : null}

    <form className="desktop-youtube-search" onSubmit={lookup}>
      <div><label htmlFor="youtube-channel-query">채널 핸들 또는 채널 주소</label><div className="social-search"><Search size={18} aria-hidden="true" /><input id="youtube-channel-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="@handle · UC 채널 ID · youtube.com/@handle" required maxLength={500} spellCheck={false} autoComplete="off" disabled={!!busy || configured !== true} aria-describedby="youtube-query-help" /></div></div>
      <button className="social-button primary" type="submit" disabled={!!busy || configured !== true || !query.trim()}>{busy === "lookup" ? <LoaderCircle size={17} className="social-spin" /> : <Search size={17} />}{busy === "lookup" ? "조회 중" : "채널 조회"}</button>
      <p id="youtube-query-help">공개된 채널 정보를 조회합니다. @핸들, UC로 시작하는 채널 ID, YouTube 채널 URL을 입력하세요.</p>
    </form>
    {error && <div className="social-notice error" role="alert"><CircleAlert size={18} /><span>{error}</span>{onOpenSettings && <button type="button" className="social-button compact" onClick={onOpenSettings}>API 설정 확인</button>}</div>}

    {channel ? <>
      <section className="desktop-youtube-channel" aria-labelledby="youtube-channel-title"><div className="desktop-youtube-channel-heading"><span className="desktop-youtube-symbol"><Video size={24} aria-hidden="true" /></span><div><p>조회한 채널</p><h2 id="youtube-channel-title">{channel.title}</h2><code>{channel.id}</code></div><External url={channel.url} className="social-button compact"><ArrowUpRight size={15} />채널 열기</External></div>
        {channel.description && <p className="desktop-youtube-description">{channel.description}</p>}
        <dl className="desktop-youtube-stats"><div><dt>구독자</dt><dd>{channel.hiddenSubscriberCount ? "비공개" : count(channel.subscriberCount)}{!channel.hiddenSubscriberCount && channel.subscriberCount !== undefined && <small>명</small>}</dd></div><div><dt>누적 조회수</dt><dd>{count(channel.viewCount)}{channel.viewCount !== undefined && <small>회</small>}</dd></div><div><dt>공개 영상</dt><dd>{count(channel.videoCount)}{channel.videoCount !== undefined && <small>개</small>}</dd></div></dl>
        <div className="desktop-youtube-register"><p>{registered.includes(channel.id) ? "이 채널을 로컬 DB에 등록했습니다." : databaseConnected ? "이 채널을 등록하면 콘텐츠 플래너에서 선택할 수 있습니다." : "로컬 DB를 연결하면 이 채널을 등록할 수 있습니다."}</p><button type="button" className="social-button" disabled={!!busy || !databaseConnected || registered.includes(channel.id)} onClick={() => void register()}>{busy === "register" ? <LoaderCircle size={16} className="social-spin" /> : registered.includes(channel.id) ? <Check size={16} /> : <Plus size={16} />}{registered.includes(channel.id) ? "내 채널에 등록됨" : "내 채널로 등록"}</button></div>
      </section>
      <section aria-labelledby="youtube-videos-title"><div className="desktop-youtube-videos-heading"><div><h2 id="youtube-videos-title">최근 공개 영상 <span>{videos.length}개</span></h2><p>최근 업로드 중 최대 25개입니다.{fetchedAt && ` ${date(fetchedAt, true)} 조회`}</p></div><div><label className="social-sr-only" htmlFor="youtube-video-sort">영상 정렬</label><select id="youtube-video-sort" value={sort} onChange={(event) => setSort(event.target.value as "latest" | "views")}><option value="latest">최신 업로드 순</option><option value="views">조회수 높은 순</option></select><button type="button" className="social-button compact" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy === "videos" ? "social-spin" : ""} />새로고침</button></div></div>
        {videoError && <div className="social-notice error" role="alert"><CircleAlert size={18} /><span>{videoError}{fetchedAt ? " 이전 조회 결과가 표시됩니다." : ""}</span></div>}
        {busy === "lookup" || busy === "videos" ? <div className="desktop-youtube-videos-loading" role="status"><LoaderCircle size={20} className="social-spin" />최근 영상과 원본 수치를 확인하고 있습니다.</div> : null}
        {videos.length ? <div className="desktop-youtube-videos">{sortedVideos.map((video, index) => <article className="desktop-youtube-video" key={video.id}><span className="desktop-youtube-video-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><div className="desktop-youtube-video-copy"><div className="desktop-youtube-video-meta"><time dateTime={video.publishedAt}>{date(video.publishedAt)}</time><span><Clock3 size={12} aria-hidden="true" />{duration(video.durationSeconds)}</span></div><h3><External url={video.url}>{video.title}<ArrowUpRight size={15} aria-hidden="true" /></External></h3><dl className="desktop-youtube-video-stats"><div><dt><Eye size={13} aria-hidden="true" />조회수</dt><dd>{count(video.viewCount)}{video.viewCount !== undefined && "회"}</dd></div><div><dt><ThumbsUp size={13} aria-hidden="true" />좋아요</dt><dd>{count(video.likeCount)}{video.likeCount !== undefined && "개"}</dd></div><div><dt><MessageCircle size={13} aria-hidden="true" />댓글</dt><dd>{count(video.commentCount)}{video.commentCount !== undefined && "개"}</dd></div></dl></div></article>)}</div> : !busy && !videoError ? <div className="desktop-youtube-empty"><Video size={25} aria-hidden="true" /><strong>조회 가능한 공개 영상이 없습니다</strong><p>이 채널의 최근 공개 업로드가 있으면 이곳에 표시됩니다.</p></div> : null}
      </section>
    </> : !busy && configured === true && !error ? <div className="desktop-youtube-empty"><Video size={28} aria-hidden="true" /><strong>채널을 조회해 관리를 시작하세요</strong><p>원본 API가 제공한 채널 성과와 영상 수치를 확인하고, 내 채널로 등록하세요.</p></div> : null}
    <div className="desktop-youtube-footnote"><ShieldCheck size={16} aria-hidden="true" /><p>API 키로 공개 정보만 조회합니다. 비공개 영상·수익 조회, 업로드, 제목 수정에는 별도 계정 권한이 필요합니다. 키는 화면에 다시 표시하지 않습니다.</p></div>
  </div>;
}
