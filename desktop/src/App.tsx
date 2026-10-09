import { invoke } from "@tauri-apps/api/core";
import { SettingsPanel } from "./SettingsPanel";
import { IntegrationPanel } from "./IntegrationPanel";
import { AssetStudio } from "./assets/AssetStudio";
import { AiDiscovery } from "./AiDiscovery";
import { BookOpen } from "lucide-react";
import { ActivityStatus, ActivitySkeleton } from "./ActivityStatus";
import { applyMaterial, materialFromTrend, composeContext, chatBrief } from "./ai-discovery";
import type { AiMaterial, AiSelectionMode } from "./ai-discovery";
import { YouTubePanel } from "./YouTubePanel";
import { OAuthPanel } from "./OAuthPanel";
import { KeywordPanel } from "./KeywordPanel";
import { External } from "./External";
import { OverviewPanel } from "./OverviewPanel";
import { ContentBoard } from "./ContentBoard";
import {
  ArrowRight, ArrowUpRight, AtSign, CalendarClock, Check, ChevronRight,
  CircleAlert, Copy, Database, ExternalLink, Eye, EyeOff, FileText, Camera as Instagram,
  LayoutDashboard, LoaderCircle, Music2, NotebookPen, Play, Plus, RefreshCw,
  Search, Settings2, ShieldCheck, Sparkles, TrendingUp, Users, X, Video as Youtube
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { CONTENT_STATUSES, SOCIAL_PLATFORMS } from "./types";
import type {
  ContentStatus, SocialChannel, SocialContent, SocialDashboard as DashboardData,
  SocialPlatform, SocialTrend, TrendRefreshResult, TrendSource
} from "./types";

type Tab = "overview" | "content" | "trends" | "keywords" | "channels" | "youtube" | "oauth" | "ai" | "assets" | "integrations" | "settings";
type AiProvider = {
  id: string; label: string; configured: boolean; available: boolean;
  detail: string; models?: string[]; authenticated?: boolean; generationVerified?: boolean;
};
type AiStatus = { providers: AiProvider[]; defaultProvider: string | null };
type Notice = { text: string; tone: "success" | "error" | "info" };
type ContentForm = {
  id?: string; platform: SocialPlatform; channelId: string; title: string;
  body: string; status: ContentStatus; scheduledAt: string; url: string;
};

const platforms = {
  youtube: { label: "YouTube", icon: Youtube, hint: "영상 · 쇼츠" },
  threads: { label: "Threads", icon: AtSign, hint: "생각 · 대화" },
  naver_blog: { label: "네이버 블로그", icon: NotebookPen, hint: "검색 · 깊이 있는 글" },
  tiktok: { label: "TikTok", icon: Music2, hint: "숏폼 · 발견" },
  instagram: { label: "Instagram", icon: Instagram, hint: "릴스 · 피드" }
} satisfies Record<SocialPlatform, { label: string; icon: typeof Youtube; hint: string }>;
const statusLabels: Record<ContentStatus, string> = {
  draft: "초안", ready: "검토 완료", scheduled: "발행 계획", published: "발행 기록"
};
const sourceLabels: Record<TrendSource, string> = {
  google_trends: "Google 트렌드", youtube: "YouTube", naver_blog: "네이버 블로그"
};
const tabs = [
  { id: "overview", label: "오버뷰", icon: LayoutDashboard, group: "워크스페이스" },
  { id: "content", label: "콘텐츠 플래너", icon: FileText, group: "워크스페이스" },
  { id: "trends", label: "트렌드 탐색", icon: TrendingUp, group: "워크스페이스" },
  { id: "keywords", label: "키워드 탐색", icon: Search, group: "워크스페이스" },
  { id: "ai", label: "AI 작업실", icon: Sparkles, group: "제작" },
  { id: "assets", label: "이미지 생성기", icon: Plus, group: "제작" },
  { id: "channels", label: "내 채널", icon: Users, group: "채널과 연결" },
  { id: "youtube", label: "YouTube 관리", icon: Youtube, group: "채널과 연결" },
  { id: "oauth", label: "SNS 로그인", icon: ShieldCheck, group: "채널과 연결" },
  { id: "integrations", label: "연결·게시 QA", icon: ShieldCheck, group: "채널과 연결" },
  { id: "settings", label: "연결 설정", icon: Settings2, group: "채널과 연결" }
] as const;
const emptyDashboard: DashboardData = {
  channels: [], content: [], trends: [], integrations: [],
  database: { connected: false, message: "DB 연결 상태를 확인하고 있습니다." }
};

function emptyContent(platform: SocialPlatform = "youtube"): ContentForm {
  return { platform, channelId: "", title: "", body: "", status: "draft", scheduledAt: "", url: "" };
}

function formatDate(value: string | null, withTime = true) {
  if (!value) return "미정";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "일시 확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "short", day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {})
  }).format(date);
}

function toLocalInput(value: string | null) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function safeUrl(value: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "응답이 지연되고 있습니다. 연결 상태를 확인한 뒤 다시 시도하세요.";
    return error.message;
  }
  if (typeof error === "string") return error;
  return "요청을 처리하지 못했습니다.";
}

function PlatformMark({ platform, small = false }: { platform: SocialPlatform; small?: boolean }) {
  const Icon = platforms[platform].icon;
  return <span className={`social-platform-mark ${platform}${small ? " small" : ""}`} aria-hidden="true"><Icon size={small ? 15 : 21} /></span>;
}

function EmptyState({ icon: Icon, title, text, children }: {
  icon: typeof FileText; title: string; text: string; children?: React.ReactNode;
}) {
  return <div className="social-empty"><Icon size={28} aria-hidden="true" /><strong>{title}</strong><p>{text}</p>{children}</div>;
}

function youtubeVideoId(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    const id = hostname === "youtu.be"
      ? url.pathname.slice(1)
      : ["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"].includes(hostname)
        ? url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:shorts|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1]
        : null;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

function TrendCard({ trend, index, canSave, onSave, onUseInAi }: {
  trend: SocialTrend; index: number; canSave: boolean; onSave: (trend: SocialTrend) => void;
  onUseInAi: (trend: SocialTrend) => void;
}) {
  const videoId = trend.source === "youtube" ? youtubeVideoId(trend.url) : null;
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playerError, setPlayerError] = useState("");
  const [thumbnailMissing, setThumbnailMissing] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const playerRequest = useRef(0);
  const description = trend.details?.description?.trim();
  const originalUrl = safeUrl(trend.url);
  const sourceAddress = originalUrl ? new URL(originalUrl).hostname : sourceLabels[trend.source];

  useEffect(() => () => { playerRequest.current += 1; }, []);

  async function playVideo() {
    if (!videoId) return;
    const request = ++playerRequest.current;
    setPlayerLoading(true); setPlayerError("");
    try {
      const viewer = await invoke<string>("prepare_youtube_embed", { videoId });
      const url = new URL(viewer);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
        throw new Error("영상 재생 주소를 확인하지 못했습니다.");
      }
      if (request === playerRequest.current) setPlayerUrl(url.href);
    } catch (error) {
      if (request === playerRequest.current) setPlayerError(errorMessage(error));
    } finally {
      if (request === playerRequest.current) setPlayerLoading(false);
    }
  }

  function stopVideo() {
    playerRequest.current += 1;
    setPlayerUrl(null); setPlayerLoading(false); setPlayerError("");
  }

  return <article className={`desktop-trend-card ${trend.source}`}>
    <div className="desktop-trend-card-header">
      <span className={`desktop-trend-source-mark ${trend.source}`} aria-hidden="true">
        {trend.source === "youtube" ? <Youtube size={18} /> : trend.source === "naver_blog" ? "N" : "G"}
      </span>
      <div><strong>{sourceLabels[trend.source]}</strong><span>{sourceAddress}</span></div>
      <span className="desktop-trend-order" aria-label={`수집 목록 ${index + 1}번째`}>{String(index + 1).padStart(2, "0")}</span>
    </div>
    {trend.source === "youtube" && <div className="desktop-trend-video">
      {playerUrl ? <>
        <iframe src={playerUrl} title={`${trend.title} · YouTube 영상`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
        <button type="button" className="desktop-trend-player-close" aria-label="영상 재생 닫기" onClick={stopVideo}><X size={16} /></button>
      </> : videoId ? <button type="button" className="desktop-trend-video-play" disabled={playerLoading} aria-label={`${trend.title} 영상 재생`} onClick={() => void playVideo()}>
        {!thumbnailMissing && <img src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`} alt="" loading="lazy" onError={() => setThumbnailMissing(true)} />}
        <span className="desktop-trend-play-icon">{playerLoading ? <LoaderCircle size={25} className="social-spin" /> : <Play size={25} fill="currentColor" />}</span>
        <span className="desktop-trend-play-label">{playerLoading ? "플레이어 준비 중" : "영상 재생"}</span>
      </button> : <div className="desktop-trend-video-unavailable"><Youtube size={28} /><span>이 영상은 원본 링크에서 확인하세요.</span></div>}
    </div>}
    <div className="desktop-trend-card-body">
      <div className="social-trend-meta"><span>한국</span><span>{formatDate(trend.fetchedAt)} 수집</span>{trend.publishedAt && <span>{formatDate(trend.publishedAt, false)} 발행</span>}</div>
      <h3><External url={originalUrl}>{trend.title}<ArrowUpRight size={15} /></External></h3>
      <div className={`desktop-trend-description${descriptionExpanded ? " expanded" : ""}${!description ? " unavailable" : ""}`}>
        <p>{description || "수집된 원본에 설명이 없습니다. 원본에서 자세한 내용을 확인하세요."}</p>
      </div>
      {description && description.length > 180 && <button type="button" className="desktop-trend-description-toggle" aria-expanded={descriptionExpanded} onClick={() => setDescriptionExpanded((expanded) => !expanded)}>{descriptionExpanded ? "설명 접기" : "설명 더 보기"}</button>}
      <div className="social-trend-keyword"><span>#{trend.keyword}</span>{trend.metric && <strong>{trend.metric}</strong>}{trend.details?.channelTitle && <span>{trend.details.channelTitle}</span>}{trend.details?.viewCount !== undefined && <span>조회 {new Intl.NumberFormat("ko-KR").format(trend.details.viewCount)}회</span>}{trend.details?.subscriberCount !== undefined && <span>구독자 {new Intl.NumberFormat("ko-KR").format(trend.details.subscriberCount)}명</span>}{trend.details?.viewCount !== undefined && trend.details?.subscriberCount !== undefined && trend.details.subscriberCount > 0 && <span>조회 ÷ 구독자 {(trend.details.viewCount / trend.details.subscriberCount).toFixed(1)}배</span>}{trend.details?.durationSeconds !== undefined && <span>{Math.floor(trend.details.durationSeconds / 60)}분 {trend.details.durationSeconds % 60}초</span>}{trend.details?.viewGrowth !== undefined && <span>이전 수집 대비 {trend.details.viewGrowth >= 0 ? "+" : ""}{new Intl.NumberFormat("ko-KR").format(trend.details.viewGrowth)}회</span>}</div>
      {playerError && <p className="desktop-trend-player-error" role="alert">{playerError} 원본 보기로 영상을 확인할 수 있습니다.</p>}
    </div>
    <div className="desktop-trend-card-actions"><External url={originalUrl} className="desktop-trend-original"><ExternalLink size={14} />{trend.source === "youtube" ? "YouTube에서 보기" : "원본 보기"}</External><div className="desktop-trend-create-actions"><button type="button" className="social-button compact" disabled={!canSave} onClick={() => onSave(trend)}><Plus size={15} />아이디어로 저장</button><button type="button" className="social-button compact primary" onClick={() => onUseInAi(trend)}><Sparkles size={15} />AI 작업실에서 사용</button></div></div>
  </article>;
}

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
  const [aiReferences, setAiReferences] = useState<AiMaterial[]>([]);
  const [aiSelectionNotice, setAiSelectionNotice] = useState("");
  const [dashboard, setDashboard] = useState<DashboardData>(emptyDashboard);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [platformFilter, setPlatformFilter] = useState<SocialPlatform | "all">("all");
  const [contentSearch, setContentSearch] = useState("");
  const [contentForm, setContentForm] = useState<ContentForm>(emptyContent());
  const [contentOpen, setContentOpen] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [channelForm, setChannelForm] = useState({ platform: "youtube" as SocialPlatform, name: "", handle: "", url: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [trendKeyword, setTrendKeyword] = useState("");
  const [trendSource, setTrendSource] = useState<TrendSource | "all">("all");
  const [trendFilter, setTrendFilter] = useState<"all" | "short" | "small_channel">("all");
  const [refreshingTrends, setRefreshingTrends] = useState(false);
  const [trendWarnings, setTrendWarnings] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus>({ providers: [], defaultProvider: null });
  const [aiStatusError, setAiStatusError] = useState("");
  const [aiChecking, setAiChecking] = useState(true);
  const [aiProvider, setAiProvider] = useState("");
  const [aiPlatform, setAiPlatform] = useState<SocialPlatform>("youtube");
  const [aiTopic, setAiTopic] = useState("");
  const [aiContext, setAiContext] = useState("");
  const [aiOutput, setAiOutput] = useState("");
  const [aiOutputLabel, setAiOutputLabel] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStartedAt, setAiStartedAt] = useState<number>();
  const [aiError, setAiError] = useState("");
  const [copying, setCopying] = useState(false);
  const contentDialog = useRef<HTMLDialogElement>(null);
  const channelDialog = useRef<HTMLDialogElement>(null);
  const noticeRegion = useRef<HTMLDivElement>(null);
  const contentError = useRef<HTMLParagraphElement>(null);
  const channelError = useRef<HTMLParagraphElement>(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true); setLoadError("");
    try { setDashboard(await invoke<DashboardData>("get_dashboard")); }
    catch (error) { setLoadError(errorMessage(error)); }
    finally { setLoading(false); }
  }, []);

  const checkAi = useCallback(async () => {
    setAiChecking(true); setAiStatusError("");
    try {
      const data = await invoke<AiStatus>("ai_status");
      setAiStatus(data);
      setAiProvider((current) => data.providers.some((provider) => provider.id === current && provider.available)
        ? current : data.defaultProvider ?? data.providers.find((provider) => provider.available)?.id ?? "");
    } catch (error) { setAiStatusError(errorMessage(error)); }
    finally { setAiChecking(false); }
  }, []);

  useEffect(() => {
    void loadDashboard(); void checkAi();
  }, [loadDashboard, checkAi]);

  useEffect(() => {
    if (contentOpen) contentDialog.current?.showModal();
    else contentDialog.current?.close();
  }, [contentOpen]);
  useEffect(() => {
    if (channelOpen) channelDialog.current?.showModal();
    else channelDialog.current?.close();
  }, [channelOpen]);

  useEffect(() => {
    if (!formError) return;
    const target = channelOpen ? channelError.current : contentError.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  }, [formError, channelOpen]);

  useEffect(() => {
    if (notice && !channelOpen && !contentOpen) {
      noticeRegion.current?.focus({ preventScroll: true });
      noticeRegion.current?.scrollIntoView({ block: "nearest" });
    }
  }, [notice, channelOpen, contentOpen]);

  const visibleContent = useMemo(() => dashboard.content.filter((item) =>
    (platformFilter === "all" || item.platform === platformFilter) &&
    `${item.title} ${item.body}`.toLocaleLowerCase().includes(contentSearch.toLocaleLowerCase())
  ), [dashboard.content, platformFilter, contentSearch]);
  const visibleTrends = useMemo(() => dashboard.trends.filter((item) =>
    (trendSource === "all" || item.source === trendSource) &&
    (trendFilter === "all" || (item.source === "youtube" && (
      trendFilter === "short" ? item.details?.durationSeconds !== undefined && item.details.durationSeconds > 0 && item.details.durationSeconds <= 180
      : item.details?.subscriberCount !== undefined && item.details.subscriberCount > 0 && item.details.subscriberCount <= 10000 && item.details.viewCount !== undefined && item.details.viewCount / item.details.subscriberCount >= 5
    )))
  ).slice(0, 10), [dashboard.trends, trendSource, trendFilter]);
  const availableAi = aiStatus.providers.filter((provider) => provider.available);
  const count = (status: ContentStatus) => dashboard.content.filter((item) => item.status === status).length;

  const aiCompiledContext = useMemo(() => {
    try { return { text: composeContext(aiContext, aiReferences), error: "" }; }
    catch (error) { return { text: "", error: errorMessage(error) }; }
  }, [aiContext, aiReferences]);
  function useAiMaterial(material: AiMaterial, mode: AiSelectionMode = "both") {
    if (aiBusy) { setNotice({ tone: "info", text: "현재 AI 응답이 끝난 뒤 자료를 선택하세요. 진행 중인 요청은 유지합니다." }); return; }
    try {
      const next = applyMaterial({ topic: aiTopic, context: aiContext, references: aiReferences }, material, mode);
      setAiTopic(next.topic); setAiReferences(next.references); setAiError("");
      setAiSelectionNotice(mode === "topic" ? "선택한 키워드를 주제로 적용했습니다." : mode === "reference" ? "참고자료를 연결했습니다. 직접 입력한 맥락은 유지됩니다." : "주제와 참고자료를 함께 적용했습니다.");
      setTab("ai");
    } catch (error) { setAiError(errorMessage(error)); setTab("ai"); }
  }
  function useTrendInAi(trend: SocialTrend) {
    try { useAiMaterial(materialFromTrend(trend)); }
    catch (error) { setAiError(errorMessage(error)); setTab("ai"); }
  }
  async function copyAiBrief() {
    setAiError("");
    try { await invoke("copy_text", { text: chatBrief(aiPlatform, aiTopic, aiContext, aiReferences) }); setAiSelectionNotice("주제와 선택한 자료를 복사했습니다. Codexify가 연결된 ChatGPT 대화에 붙여넣으세요."); }
    catch (error) { setAiError(errorMessage(error)); }
  }

  function renderContentCard(item: SocialContent) {
    return <article className="social-content-card" key={item.id}><div className="social-card-platform"><PlatformMark platform={item.platform} small /><span>{platforms[item.platform].label}</span><span className="social-card-account">{dashboard.channels.find((channel) => channel.id === item.channelId)?.name ?? "채널 미지정"}</span></div><button className="social-card-edit" onClick={() => openContent(item)}><h3>{item.title}</h3><p>{item.body || "본문을 작성해 아이디어를 구체화하세요."}</p></button><div className="social-card-footer"><span>{item.status === "scheduled" ? <CalendarClock size={13} /> : <FileText size={13} />}{formatDate(item.status === "scheduled" ? item.scheduledAt : item.updatedAt, item.status === "scheduled")}</span>{safeUrl(item.url) ? <External url={safeUrl(item.url)} aria-label={`${item.title} 발행 링크 열기`}><ExternalLink size={14} /></External> : <button aria-label={`${item.title} 수정`} onClick={() => openContent(item)}><ArrowRight size={14} /></button>}</div></article>;
  }

  function openContent(item?: SocialContent, seed?: Partial<ContentForm>) {
    setContentForm(item ? {
      id: item.id, platform: item.platform, channelId: item.channelId ?? "", title: item.title,
      body: item.body, status: item.status, scheduledAt: toLocalInput(item.scheduledAt), url: item.url ?? ""
    } : { ...emptyContent(platformFilter === "all" ? "youtube" : platformFilter), ...seed });
    setFormError(""); setAiError(""); setContentOpen(true);
  }

  function openChannel(platform: SocialPlatform = "youtube") {
    setChannelForm({ platform, name: "", handle: "", url: "" });
    setFormError(""); setChannelOpen(true);
  }

  async function saveContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError("");
    if (!contentForm.title.trim()) { setFormError("콘텐츠 제목을 입력하세요. 저장하지 않았습니다."); return; }
    if (!event.currentTarget.checkValidity()) { setFormError("필수 입력란, 날짜와 발행 URL 형식을 확인하세요. 저장하지 않았습니다."); return; }
    setSaving(true);
    try {
      const scheduledAt = contentForm.status === "scheduled" && contentForm.scheduledAt
        ? new Date(`${contentForm.scheduledAt}:00+09:00`).toISOString() : null;
      const payload = {
        platform: contentForm.platform, channelId: contentForm.channelId || null,
        title: contentForm.title.trim(), body: contentForm.body, status: contentForm.status,
        scheduledAt, url: contentForm.url.trim() || null
      };
      const content = await invoke<SocialContent>(contentForm.id ? "update_content" : "create_content",
        contentForm.id ? { id: contentForm.id, input: payload } : { input: payload });
      setDashboard((current) => ({ ...current, content: [content, ...current.content.filter((item) => item.id !== content.id)] }));
      setContentOpen(false);
      setNotice({ tone: "success", text: contentForm.status === "scheduled" ? "발행 계획을 로컬 DB에 저장했습니다. 계획 일시에 자동 발행하지는 않습니다." : "콘텐츠를 로컬 DB에 저장했습니다." });
    } catch (error) { setFormError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  async function saveChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError("");
    if (!channelForm.name.trim()) { setFormError("채널 이름을 입력하세요. 저장하지 않았습니다."); return; }
    if (!channelForm.url.trim()) { setFormError("채널 URL은 필수입니다. 선택한 SNS의 공식 HTTPS 채널 주소를 입력하세요."); return; }
    if (!event.currentTarget.checkValidity()) { setFormError("채널 URL을 https://로 시작하는 전체 주소로 입력하세요. 저장하지 않았습니다."); return; }
    setSaving(true);
    try {
      const channel = await invoke<SocialChannel>("create_channel", { input: { ...channelForm, name: channelForm.name.trim(), handle: channelForm.handle.trim(), url: channelForm.url.trim() } });
      setDashboard((current) => ({ ...current, channels: [channel, ...current.channels] }));
      setChannelOpen(false); setTab("channels"); setNotice({ tone: "success", text: `${channel.name} 채널을 로컬 DB에 저장했습니다. 계정 권한 연결은 SNS 로그인에서 설정하세요.` });
    } catch (error) { setFormError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  async function refreshTrends(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault(); setRefreshingTrends(true); setTrendWarnings([]);
    try {
      const result = await invoke<TrendRefreshResult>("refresh_trends", { keyword: trendKeyword.trim() || null });
      setDashboard(result.dashboard); setTrendWarnings(result.warnings);
      setNotice({ tone: result.saved ? "success" : "info", text: result.collected
        ? `${result.collected}개의 콘텐츠·키워드를 수집했습니다.${result.saved ? " 로컬 DB에 저장했습니다." : " DB에 저장하지 못했습니다."}`
        : "새로 수집된 결과가 없습니다. 수집 소스의 연결 상태를 확인하세요." });
    } catch (error) { setNotice({ tone: "error", text: errorMessage(error) }); }
    finally { setRefreshingTrends(false); }
  }

  async function generateAi(topic = aiTopic, context: string | undefined = undefined, destination: "workspace" | "content" = "workspace") {
    if (aiBusy) return;
    const resolvedContext = context ?? aiCompiledContext.text;
    if (context === undefined && aiCompiledContext.error) { setAiError(aiCompiledContext.error); return; }
    if (!topic.trim()) { setAiError("주제 또는 작성 방향을 입력하세요."); return; }
    if (!aiProvider) { setAiError("사용 가능한 AI 연결을 먼저 설정하세요."); return; }
    setAiStartedAt(Date.now()); setAiBusy(true); setAiError("");
    try {
      const result = await invoke<{ text: string; provider: string; model?: string }>("ai_generate", {
        input: { provider: aiProvider, platform: destination === "content" ? contentForm.platform : aiPlatform, topic: topic.trim(), context: resolvedContext }
      });
      if (destination === "content") setContentForm((current) => ({ ...current, body: result.text }));
      else {
        setAiOutput(result.text);
        setAiOutputLabel([aiStatus.providers.find((provider) => provider.id === result.provider)?.label ?? result.provider, result.model].filter(Boolean).join(" · "));
      }
      void checkAi();
    } catch (error) { setAiError(errorMessage(error)); }
    finally { setAiBusy(false); }
  }

  function patternReport() {
    const topic = "실제 수집된 최근 콘텐츠·키워드 10개의 공통 패턴과 내 채널에 적용할 콘텐츠 아이디어를 분석해줘.";
    const context = visibleTrends.map((trend, index) => `${index + 1}. 출처: ${sourceLabels[trend.source]}\n키워드: ${trend.keyword}\n제목: ${trend.title}\n원본 수치: ${trend.metric ?? "제공되지 않음"}\n조회수: ${trend.details?.viewCount ?? "제공되지 않음"}\n채널: ${trend.details?.channelTitle ?? "제공되지 않음"}\n구독자: ${trend.details?.subscriberCount ?? "제공되지 않음"}\n길이: ${trend.details?.durationSeconds ?? "제공되지 않음"}초\n링크: ${trend.url}\n수집: ${trend.fetchedAt}`).join("\n\n") +
      "\n\n위 제목과 출처 정보만 근거로 사용해줘. 원문을 읽었다고 주장하지 말고 사실과 추정을 구분해줘. 수치가 없는 검색 결과를 인기 순위로 해석하지 말아줘. 도입 훅, 주제, 표현 형식의 공통점을 분석하고 각 플랫폼 아이디어와 검증할 가설을 제안해줘.";
    setAiTopic(topic); setAiContext(context.slice(0, 6000)); setAiReferences([]); setAiOutput(""); setTab("ai");
    void generateAi(topic, context.slice(0, 6000));
  }

  function useTrend(trend: SocialTrend, selectedPlatform?: SocialPlatform) {
    const platform = selectedPlatform ?? (trend.source === "youtube" || trend.source === "naver_blog" ? trend.source : undefined);
    openContent(undefined, { ...(platform ? { platform } : {}), title: trend.keyword || trend.title, body: `참고 콘텐츠: ${trend.title}\n출처: ${trend.url}` });
  }

  const viewTitle = { overview: "오버뷰", content: "콘텐츠 플래너", trends: "트렌드 탐색", keywords: "키워드 탐색", channels: "내 채널", youtube: "YouTube 관리", oauth: "SNS 로그인", ai: "AI 작업실", assets: "이미지 생성기", integrations: "연결·게시 QA", settings: "연결 설정" }[tab];
  const viewDescription = {
    overview: "내 채널의 작업과 발견한 콘텐츠를 한눈에 확인하세요.",
    content: "아이디어를 모으고, 초안을 다듬고, 다음 발행을 계획하세요.",
    trends: "실제 출처가 있는 콘텐츠와 키워드에서 다음 아이디어를 찾으세요.",
    keywords: "키워드로 콘텐츠를 찾고, 콘텐츠에 연결된 실제 검색어와 원문 근거를 확인하세요.",
    channels: "다섯 플랫폼의 채널 정보와 콘텐츠를 한 곳에서 관리하세요.",
    youtube: "YouTube Data API로 채널의 공개 성과와 최근 영상을 확인하세요.",
    oauth: "공식 로그인으로 계정을 연결하고, 저장된 연결과 만료 일시를 확인하세요.",
    ai: "수집한 키워드로 주제를 고르고, 근거를 연결해 ChatGPT 또는 로컬 AI에서 초안을 만드세요.",
    assets: "이미지와 3D 에셋을 규격에 맞추고, 영상·프로젝트별로 모아 재사용하세요.",
    integrations: "ChatGPT 도구 연결부터 실제 업로드까지, 확인한 단계만 완료로 표시합니다.",
    settings: "내 기기의 데이터베이스와 AI, 수집 소스를 연결하세요."
  }[tab];

  return (
    <div className="social-workspace">
      <a className="social-skip-link" href="#social-main">본문으로 이동</a>
      <aside className="social-sidebar" aria-label="워크스페이스 메뉴">
        <button type="button" onClick={() => setTab("overview")} className="social-brand" aria-label="Toris Studio 오버뷰"><span className="social-brand-mark"><img src="./brand/toris-logo.png" alt="" width={40} height={40} /></span><span><strong>Toris Studio</strong><small>Creator workspace</small></span></button>
        <div className="social-workspace-label"><span className="social-workspace-dot" />내 작업실 <span>LOCAL</span></div>
        <nav className="social-nav" aria-label="콘텐츠 관리">
          {(["워크스페이스", "제작", "채널과 연결"] as const).map((group) => <div className="social-nav-group" key={group}><span className="social-nav-group-label">{group}</span>{tabs.filter((item) => item.group === group).map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}><Icon size={18} aria-hidden="true" /><span>{label}</span>{id === "content" && dashboard.content.length > 0 && <small>{dashboard.content.length}</small>}</button>)}</div>)}
        </nav>
        <div className="social-sidebar-bottom"><ShieldCheck size={18} /><strong>내 기기에 저장되는 작업</strong><p>콘텐츠는 로컬 DB에 저장됩니다.<br />AI 요청 시 입력한 내용은 선택한 제공자에게 전달됩니다.</p></div>
      </aside>

      <div className="social-shell">
        <header className="social-topbar"><span className="social-breadcrumb"><button type="button" onClick={() => setTab("overview")}>내 작업실</button><ChevronRight size={14} /> <strong>{viewTitle}</strong></span><div className="social-topbar-context"><span className="social-local-label">DESKTOP</span><div className={`social-db-state ${dashboard.database.connected ? "connected" : ""}`}><span className="social-db-dot" /><span>{loading ? "DB 확인 중" : dashboard.database.connected ? "로컬 DB 연결됨" : "DB 연결 필요"}</span></div></div></header>
        <main id="social-main" className="social-main" tabIndex={-1}>
          <div className="social-page-heading"><div><h1>{viewTitle}</h1><p>{viewDescription}</p></div><div className="social-heading-actions"><button className="social-button subtle icon-only" aria-label="워크스페이스 새로고침" disabled={tab !== "assets" && loading} onClick={() => { if (tab === "assets" || tab === "integrations") setAssetRefreshKey(key => key + 1); else { void loadDashboard(); void checkAi(); } }}><RefreshCw size={17} className={tab !== "assets" && loading ? "social-spin" : ""} /></button>{tab === "channels" ? <button className="social-button primary" disabled={!dashboard.database.connected} onClick={() => openChannel()}><Plus size={17} />채널 등록</button> : tab === "content" ? <button className="social-button primary" disabled={!dashboard.database.connected} onClick={() => openContent()}><Plus size={17} />새 콘텐츠</button> : tab === "trends" ? <button className="social-button primary" disabled={refreshingTrends} onClick={() => void refreshTrends()}><RefreshCw size={17} className={refreshingTrends ? "social-spin" : ""} />{refreshingTrends ? "수집 중" : "트렌드 수집"}</button> : tab === "ai" ? <button className="social-button" disabled={aiChecking} onClick={() => void checkAi()}><RefreshCw size={17} className={aiChecking ? "social-spin" : ""} />연결 확인</button> : null}</div></div>

          {notice && <div ref={noticeRegion} tabIndex={-1} className={`social-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "success" ? <Check size={18} /> : <CircleAlert size={18} />}<span>{notice.text}</span><button className="social-dismiss" aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={16} /></button></div>}
          {tab !== "assets" && tab !== "integrations" && loadError && <div className="social-notice error" role="alert"><CircleAlert size={18} /><span>{loadError}</span><button className="social-button compact" onClick={() => void loadDashboard()}>다시 시도</button></div>}
          {tab !== "assets" && tab !== "integrations" && !loading && !dashboard.database.connected && <div className="social-notice info"><Database size={18} /><span>{dashboard.database.message} 채널·콘텐츠 저장은 DB 연결 후 사용할 수 있습니다.</span><button className="social-button compact" onClick={() => setTab("settings")}>연결 설정</button></div>}

          {tab === "overview" && <OverviewPanel dashboard={dashboard} loading={loading} aiChecking={aiChecking} availableAiCount={availableAi.length} onNavigate={setTab} onCreate={(platform) => openContent(undefined, platform ? { platform } : {})} onEdit={openContent} onAddChannel={openChannel} onSaveTrend={useTrend} onUseInAi={useTrendInAi} />}

          <div hidden={tab !== "assets"}><AssetStudio active={tab === "assets"} refreshKey={assetRefreshKey} /></div>
          <div hidden={tab !== "youtube"}><YouTubePanel active={tab === "youtube"} databaseConnected={dashboard.database.connected} onMessage={setNotice} onOpenSettings={() => setTab("settings")} onChanged={() => void loadDashboard()} /></div>
          <div hidden={tab !== "integrations"}><IntegrationPanel active={tab === "integrations"} refreshKey={assetRefreshKey} onOAuth={() => setTab("oauth")} /></div>
          <div hidden={tab !== "oauth"}><OAuthPanel active={tab === "oauth"} /></div>
          <div hidden={tab !== "keywords"}><KeywordPanel active={tab === "keywords"} databaseConnected={dashboard.database.connected} onOpenSettings={() => setTab("settings")} onChanged={() => void loadDashboard()} onUseInAi={(material) => useAiMaterial(material)} /></div>

          {tab === "content" && <>
            <section className="social-stats" aria-label="콘텐츠 현황"><div><span>불러온 콘텐츠</span><strong>{dashboard.content.length}<small>개</small></strong></div><div><span>검토할 초안</span><strong>{count("draft")}<small>개</small></strong></div><div><span>발행 계획</span><strong>{count("scheduled")}<small>개</small></strong></div><div><span>등록한 채널</span><strong>{dashboard.channels.length}<small>개</small></strong></div></section>
            <div className="social-content-toolbar"><div className="social-platform-filters" role="group" aria-label="플랫폼 필터"><button className={platformFilter === "all" ? "active" : ""} aria-pressed={platformFilter === "all"} onClick={() => setPlatformFilter("all")}>전체 채널</button>{SOCIAL_PLATFORMS.map((platform) => { const Icon = platforms[platform].icon; return <button key={platform} className={platformFilter === platform ? "active" : ""} aria-pressed={platformFilter === platform} onClick={() => setPlatformFilter(platform)}><Icon size={15} />{platforms[platform].label}</button>; })}</div><label className="social-search"><Search size={16} /><input aria-label="콘텐츠 검색" placeholder="콘텐츠 검색" value={contentSearch} onChange={(event) => setContentSearch(event.target.value)} /></label></div>
            <p className="social-plan-note"><CalendarClock size={15} />발행 계획은 한국 시간으로 관리하는 일정입니다. 플랫폼에 자동으로 게시하지 않습니다.</p>
            {loading && dashboard.content.length === 0 ? <ActivitySkeleton label="콘텐츠를 불러오는 중입니다." showStatus/> : <ContentBoard items={visibleContent} renderContentCard={renderContentCard} onAddContent={(status) => openContent(undefined, { status })} canAddContent={dashboard.database.connected} showCreateDraft={!contentSearch} />}
            <div className="social-bottom-prompt"><TrendingUp size={20} /><div><strong>오늘은 어떤 콘텐츠를 만들까요?</strong><span>최신 키워드를 살펴보고, 실제 출처에서 아이디어를 가져오세요.</span></div><button className="social-button" onClick={() => setTab("trends")}>트렌드 탐색<ArrowRight size={16} /></button></div>
          </>}

          {tab === "trends" && <>
            <form className="social-trend-search" onSubmit={refreshTrends}><div><label htmlFor="social-trend-keyword">관심 키워드</label><div className="social-search"><Search size={18} /><input id="social-trend-keyword" placeholder="예: AI, 생산성, 로컬 여행" value={trendKeyword} maxLength={100} onChange={(event) => setTrendKeyword(event.target.value)} /></div></div><button className="social-button primary" disabled={refreshingTrends} type="submit">{refreshingTrends ? <LoaderCircle size={17} className="social-spin" /> : <Search size={17} />}{refreshingTrends ? "수집 중" : "키워드로 수집"}</button><p>키워드가 없으면 현재 트렌드를 수집합니다. YouTube·네이버 검색은 연결 설정의 API 정보가 필요합니다.</p></form>
            {trendWarnings.length > 0 && <div className="social-collection-warnings" role="status"><CircleAlert size={17} /><div><strong>일부 소스의 수집 상태를 확인하세요</strong>{trendWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
            <div className="social-section-heading"><div><h2>최근 수집 콘텐츠 · 키워드</h2><p>원본과 설명을 확인하고, 관심 있는 콘텐츠를 AI 작업실의 주제·참고자료로 가져오세요.</p></div><button className="social-button" disabled={visibleTrends.length === 0 || availableAi.length === 0 || aiBusy} onClick={patternReport}><Sparkles size={16} />패턴 리포트</button></div>
            <div className="social-source-filters" role="group" aria-label="트렌드 출처 필터">{(["all", "google_trends", "youtube", "naver_blog"] as const).map((source) => <button key={source} aria-pressed={trendSource === source} className={trendSource === source ? "active" : ""} onClick={() => setTrendSource(source)}>{source === "all" ? "전체 출처" : sourceLabels[source]}</button>)}</div>            <div className="desktop-trend-filters" role="group" aria-label="YouTube 콘텐츠 조건"><span>YouTube 조건</span>{([
              ["all", "전체"], ["short", "3분 이하 영상"], ["small_channel", "작은 채널 · 높은 조회"]
            ] as const).map(([filter, label]) => <button key={filter} type="button" aria-pressed={trendFilter === filter} className={trendFilter === filter ? "active" : ""} onClick={() => setTrendFilter(filter)}>{label}</button>)}</div>
            {trendFilter !== "all" && <p className="desktop-trend-filter-note">{trendFilter === "short" ? "원본에 길이가 제공된 3분 이하 영상입니다. 세로 형식이나 Shorts 분류가 확인된 것은 아닙니다." : "구독자가 1만 명 이하이고 조회수가 구독자 수의 5배 이상인 영상입니다. 실제 제공된 수치가 있는 결과만 표시합니다."}</p>}

            {loading && dashboard.trends.length === 0 ? <ActivitySkeleton label="트렌드를 불러오는 중입니다." showStatus/> : visibleTrends.length === 0 ? <EmptyState icon={TrendingUp} title={dashboard.trends.length ? "조건에 맞는 결과가 없어요" : "아직 수집한 트렌드가 없어요"} text={dashboard.trends.length ? "조건을 바꾸거나 관심 키워드로 새 콘텐츠를 수집하세요." : "트렌드 수집을 누르면 실제 출처의 키워드와 콘텐츠가 이곳에 표시됩니다."}><button className="social-button" disabled={refreshingTrends} onClick={() => void refreshTrends()}><RefreshCw size={16} />첫 트렌드 수집</button></EmptyState> : <div className="social-trend-list">{visibleTrends.map((trend, index) => <TrendCard key={trend.id} trend={trend} index={index} canSave={dashboard.database.connected} onSave={useTrend} onUseInAi={useTrendInAi} />)}</div>}
            <div className="social-trend-footnote"><ShieldCheck size={17} /><p>검색 결과의 순서는 인기 순위를 의미하지 않습니다. Threads·TikTok·Instagram의 실시간 인기 콘텐츠는 현재 수집하지 않으며, 각 플랫폼에서 직접 확인할 수 있습니다.</p></div>
            <div className="social-external-platforms">{(["threads", "tiktok", "instagram"] as const).map((platform) => <External key={platform} url={{ threads: "https://www.threads.com/", tiktok: "https://www.tiktok.com/", instagram: "https://www.instagram.com/" }[platform]}><PlatformMark platform={platform} small /><span>{platforms[platform].label} 열기</span><ArrowUpRight size={15} /></External>)}</div>
          </>}

          {tab === "channels" && <>
            <div className="social-channel-grid">{SOCIAL_PLATFORMS.map((platform) => {
              const channels = dashboard.channels.filter((channel) => channel.platform === platform);
              return <section className="social-channel-group" key={platform}>
                <div className="social-channel-header"><PlatformMark platform={platform} /><div><h2>{platforms[platform].label}</h2><p>{platforms[platform].hint}</p></div><small>{channels.length}개</small></div>
                {channels.map((channel) => <div className="social-channel-item" key={channel.id}>
                  <strong>{channel.name}</strong><span>{channel.handle || "핸들 미등록"}</span>
                  <div><small>{dashboard.content.filter((item) => item.channelId === channel.id).length}개 콘텐츠</small>{safeUrl(channel.url) && <External url={safeUrl(channel.url)} aria-label={`${channel.name} 채널 열기`}><ExternalLink size={15} />채널 열기</External>}</div>
                  <details className="social-channel-details">
                    <summary aria-label={`${channel.name} 저장된 채널 정보 보기 또는 숨기기`}><Eye size={14} className="channel-details-show" /><EyeOff size={14} className="channel-details-hide" /><span className="channel-details-show">저장 정보 보기</span><span className="channel-details-hide">정보 숨기기</span><small>DB 저장됨</small></summary>
                    <dl><dt>채널 이름</dt><dd>{channel.name}</dd><dt>핸들 · 계정 ID</dt><dd>{channel.handle || "등록하지 않음"}</dd><dt>저장된 채널 URL</dt><dd><code>{channel.url}</code></dd></dl>
                  </details>
                </div>)}
                {channels.length === 0 && <div className="social-channel-empty">관리할 채널을 등록하세요.</div>}
                <button className="social-channel-add" disabled={!dashboard.database.connected} onClick={() => openChannel(platform)}><Plus size={16} />채널 정보 등록</button>
              </section>;
            })}</div>
            <div className="social-section-heading"><div><h2>데이터 연결 상태</h2><p>채널 정보 등록과 플랫폼 계정 권한 연결은 별개입니다.</p></div></div>
            <div className="social-integrations">{dashboard.integrations.map((integration) => <article key={integration.id}><span className={`social-integration-indicator ${integration.status}`} /><div><h3>{integration.name}</h3><p>{integration.message}</p><div className="social-capabilities">{integration.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div></div><span className={`social-state-label ${integration.status}`}>{{ ready: "사용 가능", unconfigured: "설정 필요", manual: "직접 관리", error: "연결 확인" }[integration.status]}</span></article>)}{dashboard.integrations.length === 0 && <p className="social-muted">{loading ? "연결 상태를 확인하는 중입니다." : "연결 상태를 불러오지 못했습니다. 새로고침해 주세요."}</p>}</div>
          </>}

          {tab === "ai" && <>
            <AiDiscovery trends={dashboard.trends} loading={loading} databaseConnected={dashboard.database.connected} busy={aiBusy} references={aiReferences} onSelect={useAiMaterial} onRefresh={loadDashboard} onExplore={() => setTab("keywords")} />
            {aiSelectionNotice && <p className="social-notice success" role="status">{aiSelectionNotice}</p>}
            {aiStatusError && <div className="social-notice error" role="alert"><CircleAlert size={17} /><span>{aiStatusError}</span></div>}
            <details className="ai-provider-details"><summary>직접 작성에 사용할 로컬 AI 제공자 · 선택</summary><div className="social-ai-providers">{aiStatus.providers.map((provider) => <button className={`social-ai-provider ${aiProvider === provider.id ? "selected" : ""}`} key={provider.id} disabled={!provider.available || aiBusy} aria-pressed={aiProvider === provider.id} onClick={() => setAiProvider(provider.id)}><div><Sparkles size={18} /><strong>{provider.label}</strong><span className={provider.available ? "available" : "unavailable"}>{provider.available ? "연결됨" : "연결 필요"}</span></div><p>{provider.detail}</p><small>{provider.generationVerified ? "실제 생성 확인됨" : provider.available ? "생성 확인 전" : "연결 설정에서 AI를 연결하세요"}</small></button>)}{aiChecking && aiStatus.providers.length === 0 && <ActivitySkeleton label="AI 연결을 확인하는 중입니다." rows={2}/>}</div></details>
            {!aiChecking && availableAi.length === 0 && <div className="social-notice info"><CircleAlert size={18} /><span>로컬 AI 제공자가 없어도 주제와 자료를 선택해 ChatGPT 요청을 복사할 수 있습니다. Codexify 연결은 연결·게시 QA에서 설정하세요.</span></div>}
            <div className="social-ai-workbench"><form className="social-ai-brief" onSubmit={(event) => { event.preventDefault(); void generateAi(); }}><div className="social-section-heading"><h2>어떤 콘텐츠를 만들까요?</h2></div><label htmlFor="social-ai-platform">대상 플랫폼</label><select id="social-ai-platform" value={aiPlatform} onChange={(event) => setAiPlatform(event.target.value as SocialPlatform)} disabled={aiBusy}>{SOCIAL_PLATFORMS.map((platform) => <option key={platform} value={platform}>{platforms[platform].label}</option>)}</select><label htmlFor="social-ai-topic">주제와 작성 방향</label><textarea id="social-ai-topic" value={aiTopic} onChange={(event) => setAiTopic(event.target.value)} placeholder="예: AI로 반복 작업을 줄이는 팁 3개를 소개하는 30초 릴스. 초보자도 따라 할 수 있도록 작성해줘." rows={5} maxLength={600} required disabled={aiBusy} /><label htmlFor="social-ai-context">참고 자료와 맥락 <small>선택</small></label><textarea id="social-ai-context" value={aiContext} onChange={(event) => setAiContext(event.target.value)} placeholder="실제 출처 URL, 핵심 사실, 타깃 독자, 원하는 말투 등을 입력하세요." rows={6} maxLength={6000} disabled={aiBusy} />
              <div className="ai-reference-list" aria-label="선택한 참고자료">{aiReferences.map(item => <div className="ai-reference-item" key={item.id}><BookOpen size={16}/><span><strong>{item.trend.title}</strong><small>{item.keyword} · {sourceLabels[item.trend.source]}</small></span><button type="button" className="social-dismiss" aria-label={`참고자료 해제: ${item.trend.title}`} disabled={aiBusy} onClick={() => { setAiReferences(current => current.filter(r => r.id !== item.id)); setAiSelectionNotice("참고자료를 해제했습니다. 직접 작성한 맥락은 유지됩니다."); }}><X size={15}/></button></div>)}</div>
              <p className={`ai-context-budget${aiCompiledContext.error ? " error" : ""}`} role={aiCompiledContext.error ? "alert" : undefined}>{aiCompiledContext.error || `AI에 전달할 맥락 ${aiCompiledContext.text.length.toLocaleString()} / 6,000자 · 자료 ${aiReferences.length}개`}</p>
              {!aiCompiledContext.error && <details className="ai-context-preview"><summary>전달할 참고자료 확인</summary><pre>{aiCompiledContext.text || "선택하거나 입력한 참고자료가 없습니다."}</pre></details>}
              <div className="ai-chat-handoff"><p>ChatGPT가 작성하고 Codexify가 Studio 도구를 연결합니다. 복사만으로 생성이 시작되지는 않습니다.</p><button type="button" className="social-button primary" disabled={aiBusy || !aiTopic.trim() || Boolean(aiCompiledContext.error)} onClick={() => void copyAiBrief()}><Copy size={16}/>ChatGPT 요청 복사</button></div>
              <p className="social-form-hint">입력한 자료는 선택한 AI 제공자에게 전달됩니다. 생성 결과의 사실과 출처를 확인한 뒤 사용하세요.</p>{aiError && <p className="social-form-error" role="alert">{aiError}</p>}<div className="social-form-actions"><button className="social-button primary" type="submit" disabled={aiBusy || availableAi.length === 0 || Boolean(aiCompiledContext.error)}>{aiBusy ? <LoaderCircle size={17} className="social-spin" /> : <Sparkles size={17} />}{aiBusy ? "작성 중" : "AI로 작성"}</button></div></form><section className="social-ai-result" aria-label="AI 생성 결과"><div className="social-result-header"><h2>작성 결과</h2>{aiOutputLabel && <small>{aiOutputLabel}</small>}</div>{aiBusy && <ActivityStatus title="AI 응답을 기다리는 중" since={aiStartedAt} detail="선택한 제공자에 요청을 보냈습니다. 완료 시각이나 진행률은 제공되지 않습니다. 기존 작성 결과와 입력은 보존하고 실제 응답이 도착하면 갱신합니다."/>}{aiOutput ? <><label className="social-sr-only" htmlFor="social-ai-output">AI 결과 수정</label><textarea className="ai-complete-output" id="social-ai-output" disabled={aiBusy} value={aiOutput} onChange={(event) => setAiOutput(event.target.value)} spellCheck={false} /><div className="social-result-actions"><span>검토하고 편집한 뒤 초안으로 저장하세요.</span><div className="desktop-result-buttons"><button type="button" className="social-button" disabled={copying || aiBusy} onClick={() => {
      setCopying(true); void invoke("copy_text", { text: aiOutput }).then(() => setNotice({ tone: "success", text: "작성 결과를 클립보드에 복사했습니다." })).catch((error: unknown) => setNotice({ tone: "error", text: errorMessage(error) })).finally(() => setCopying(false));
    }}>{copying ? <LoaderCircle size={16} className="social-spin" /> : <Copy size={16} />}복사</button><button className="social-button primary" disabled={!dashboard.database.connected || aiBusy} onClick={() => openContent(undefined, { platform: aiPlatform, title: aiTopic.slice(0, 180), body: aiOutput })}><FileText size={16} />콘텐츠로 가져오기</button></div></div></> : <EmptyState icon={Sparkles} title={aiBusy ? "초안을 작성하고 있어요" : "아이디어를 초안으로 바꿔보세요"} text={aiBusy ? "결과가 도착하면 이곳에서 검토하고 수정할 수 있습니다." : "왼쪽에 주제와 참고 자료를 입력하면 채널에 맞는 결과가 이곳에 표시됩니다."} />}</section></div>
          </>}
          {tab === "settings" && <SettingsPanel onSaved={() => { void loadDashboard(); void checkAi(); }} databaseConnected={dashboard.database.connected} />}
        </main>
        <footer className="social-footer"><span>Toris Studio · Desktop · 로컬 워크스페이스</span><span>모든 일정 표시: 한국 표준시 (KST)</span></footer>
      </div>

      <dialog ref={contentDialog} className="social-dialog" onCancel={(event) => { if (saving || aiBusy) event.preventDefault(); else setContentOpen(false); }} onClose={() => setContentOpen(false)} aria-labelledby="social-content-dialog-title"><form onSubmit={saveContent} noValidate><div className="social-dialog-header"><div><h2 id="social-content-dialog-title">{contentForm.id ? "콘텐츠 수정" : "새 콘텐츠"}</h2><p>채널에 맞는 초안을 만들고 발행을 계획하세요.</p></div><button className="social-dismiss" type="button" aria-label="콘텐츠 편집 닫기" disabled={saving || aiBusy} onClick={() => setContentOpen(false)}><X size={20} /></button></div><div className="social-form-grid"><div><label htmlFor="social-content-platform">플랫폼</label><select id="social-content-platform" value={contentForm.platform} disabled={saving || aiBusy} onChange={(event) => setContentForm((current) => ({ ...current, platform: event.target.value as SocialPlatform, channelId: "" }))}>{SOCIAL_PLATFORMS.map((platform) => <option key={platform} value={platform}>{platforms[platform].label}</option>)}</select></div><div><label htmlFor="social-content-channel">채널</label><select id="social-content-channel" value={contentForm.channelId} disabled={saving || aiBusy} onChange={(event) => setContentForm((current) => ({ ...current, channelId: event.target.value }))}><option value="">채널 미지정</option>{dashboard.channels.filter((channel) => channel.platform === contentForm.platform).map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></div></div><label htmlFor="social-content-title">제목 · 아이디어</label><input id="social-content-title" value={contentForm.title} onChange={(event) => setContentForm((current) => ({ ...current, title: event.target.value }))} placeholder="콘텐츠의 핵심 아이디어를 입력하세요" maxLength={180} required disabled={saving || aiBusy} /><div className="social-body-label"><label htmlFor="social-content-body">본문 · 대본</label><button className="social-button compact" type="button" disabled={saving || aiBusy || availableAi.length === 0 || !contentForm.title.trim()} onClick={() => { setAiError(""); void generateAi(contentForm.title, contentForm.body.slice(0, 6000), "content"); }}>{aiBusy ? <LoaderCircle size={14} className="social-spin" /> : <Sparkles size={14} />}{aiBusy ? "작성 중" : "AI 초안"}</button></div><textarea id="social-content-body" value={contentForm.body} onChange={(event) => setContentForm((current) => ({ ...current, body: event.target.value }))} placeholder="아이디어, 글, 영상 대본과 참고 출처를 적어보세요" rows={8} maxLength={20000} disabled={saving || aiBusy} />{aiError && <p className="social-form-error" role="alert">{aiError}</p>}{availableAi.length === 0 && <p className="social-form-hint">AI 초안은 AI 작업실에서 연결을 설정한 뒤 사용할 수 있습니다.</p>}<div className="social-form-grid"><div><label htmlFor="social-content-status">진행 상태</label><select id="social-content-status" value={contentForm.status} disabled={saving || aiBusy} onChange={(event) => setContentForm((current) => ({ ...current, status: event.target.value as ContentStatus }))}>{CONTENT_STATUSES.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></div>{contentForm.status === "scheduled" && <div><label htmlFor="social-content-scheduled">계획 일시 (한국 시간)</label><input type="datetime-local" id="social-content-scheduled" value={contentForm.scheduledAt} onChange={(event) => setContentForm((current) => ({ ...current, scheduledAt: event.target.value }))} required disabled={saving || aiBusy} /></div>}</div>{contentForm.status === "scheduled" && <p className="social-form-hint">일정 기록용입니다. 해당 시간에 자동으로 게시하지 않습니다.</p>}{contentForm.status === "published" && <p className="social-form-hint">플랫폼에서 직접 발행한 콘텐츠의 기록입니다. 저장하면 발행 기록으로 분류됩니다.</p>}<label htmlFor="social-content-url">발행 URL <small>선택</small></label><input id="social-content-url" type="url" value={contentForm.url} onChange={(event) => setContentForm((current) => ({ ...current, url: event.target.value }))} placeholder="https://" maxLength={2000} disabled={saving || aiBusy} />{formError && <p ref={contentError} tabIndex={-1} className="social-form-error" role="alert">{formError}</p>}<div className="social-dialog-actions"><button className="social-button" type="button" disabled={saving || aiBusy} onClick={() => setContentOpen(false)}>취소</button><button className="social-button primary" type="submit" disabled={saving || aiBusy}>{saving ? <LoaderCircle size={17} className="social-spin" /> : <Check size={17} />}{saving ? "저장 중" : "콘텐츠 저장"}</button></div></form></dialog>

      <dialog ref={channelDialog} className="social-dialog small" onCancel={(event) => { if (saving) event.preventDefault(); else setChannelOpen(false); }} onClose={() => setChannelOpen(false)} aria-labelledby="social-channel-dialog-title"><form onSubmit={saveChannel} noValidate><div className="social-dialog-header"><div><h2 id="social-channel-dialog-title">채널 정보 등록</h2><p>관리할 채널의 기본 정보를 저장하세요.</p></div><button className="social-dismiss" type="button" aria-label="채널 등록 닫기" disabled={saving} onClick={() => setChannelOpen(false)}><X size={20} /></button></div><label htmlFor="social-channel-platform">플랫폼</label><select id="social-channel-platform" value={channelForm.platform} onChange={(event) => setChannelForm((current) => ({ ...current, platform: event.target.value as SocialPlatform }))} disabled={saving}>{SOCIAL_PLATFORMS.map((platform) => <option key={platform} value={platform}>{platforms[platform].label}</option>)}</select><label htmlFor="social-channel-name">채널 이름</label><input id="social-channel-name" value={channelForm.name} onChange={(event) => setChannelForm((current) => ({ ...current, name: event.target.value }))} placeholder="내 채널 이름" maxLength={120} required disabled={saving} /><label htmlFor="social-channel-handle">핸들 · 계정 ID <small>선택</small></label><input id="social-channel-handle" value={channelForm.handle} onChange={(event) => setChannelForm((current) => ({ ...current, handle: event.target.value }))} placeholder="@my_channel" maxLength={160} disabled={saving} /><label htmlFor="social-channel-url">채널 URL <small>필수</small></label><input id="social-channel-url" type="url" required value={channelForm.url} onChange={(event) => setChannelForm((current) => ({ ...current, url: event.target.value }))} placeholder="https://" maxLength={2000} disabled={saving} /><p className="social-form-hint">채널 이름과 공식 HTTPS 채널 URL을 입력하세요. 등록한 채널은 내 채널에 표시됩니다. 계정 로그인은 SNS 로그인에서 별도로 연결합니다.</p>{formError && <p ref={channelError} tabIndex={-1} className="social-form-error" role="alert">{formError}</p>}<div className="social-dialog-actions"><button className="social-button" type="button" disabled={saving} onClick={() => setChannelOpen(false)}>취소</button><button className="social-button primary" type="submit" disabled={saving}>{saving ? <LoaderCircle size={17} className="social-spin" /> : <Plus size={17} />}{saving ? "저장 중" : "채널 등록"}</button></div></form></dialog>
    </div>
  );
}
