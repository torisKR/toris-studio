import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SettingsPanel } from "./SettingsPanel";
import { PublicationPanel } from "./PublicationPanel";
import { VideoPanel } from "./VideoPanel";
import { DesktopCommandMenu } from "./DesktopCommandMenu";
import { createSingleFlight } from "./desktop-interactions";
import { beginMainActivity } from "./native-windows";
import { type CreationRequest } from "./creation-client";
import { CreationInbox } from "./ChatGPTHandoff";
import { aiStatus as readAiStatus, contentReady, generateText, modelLabel } from "./ai-client";
import type { AiStatus as ModelStatus } from "./ai-client";
import { AgentPanel } from "./AgentPanel";
import { PlannerPanel } from "./PlannerPanel";
import { OpsPanel } from "./OpsPanel";
import { SnsWorkspace } from "./sns/SnsWorkspace";
import { OperationTray } from "./OperationTray";
import { MAIN_SECTIONS, sectionFor, sectionItems, restoreView, rememberView, type View, type Section } from "./workspace-navigation";
import "./Workspace.css";
import { AssetStudio } from "./assets/AssetStudio";
import { plainPreview } from "./content-preview";
import { AiDiscovery } from "./AiDiscovery";
import { BookOpen } from "lucide-react";
import { ActivityStatus, ActivitySkeleton } from "./ActivityStatus";
import { applyMaterial, materialFromTrend, composeContext, chatBrief } from "./ai-discovery";
import type { AiMaterial, AiSelectionMode } from "./ai-discovery";
import { KeywordPanel } from "./KeywordPanel";
import { External } from "./External";
import { ContentBoard } from "./ContentBoard";
import {
  ArrowRight, ArrowUpRight, AtSign, CalendarClock, CalendarDays, Check, ChevronRight,
  CircleAlert, Clapperboard, Copy, Database, ExternalLink, Eye, EyeOff, FileText, Camera as Instagram,
  LayoutDashboard, LoaderCircle, Music2, NotebookPen, Play, Plus, RefreshCw,
  Search, Send, Settings2, ShieldCheck, Sparkles, TrendingUp, Users, X, Video as Youtube
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { CONTENT_STATUSES, SOCIAL_PLATFORMS } from "./types";
import type {
  ContentStatus, SocialChannel, SocialContent, SocialDashboard as DashboardData,
  SocialPlatform, SocialTrend, TrendRefreshResult, TrendSource
} from "./types";

type Tab = View;
type AiProvider = {
  id: string; label: string; configured: boolean; available: boolean;
  detail: string; models?: string[]; authenticated?: boolean; generationVerified?: boolean;
};
type AiStatus = { providers: AiProvider[]; defaultProvider: string | null; model: ModelStatus | null };
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
  instagram: { label: "Instagram", icon: Instagram, hint: "릴스 · 피드" },
  facebook: { label: "Facebook Page", icon: Users, hint: "페이지 · 릴스" },
  naver_clip: { label: "네이버 클립", icon: Play, hint: "클립 · 수동 관리" },
  x: { label: "X", icon: AtSign, hint: "글 · 수동 관리" }
} satisfies Record<SocialPlatform, { label: string; icon: typeof Youtube; hint: string }>;
const statusLabels: Record<ContentStatus, string> = {
  draft: "초안", ready: "검토 완료", scheduled: "발행 계획", published: "발행 기록"
};
const sourceLabels: Record<TrendSource, string> = {
  google_trends: "Google 트렌드", youtube: "YouTube", naver_blog: "네이버 블로그"
};
const tabs = ([...MAIN_SECTIONS.flatMap(item => sectionItems(item.id)), ...sectionItems("settings")]);
const sectionIcons = { sns: Users, content: FileText, creation: Clapperboard, publications: Send, operations: CalendarDays, settings: Settings2 };
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
  const [tab, updateTab] = useState<Tab>(() => { try { return restoreView(localStorage.getItem("toris.workspace.view")); } catch { return "sns"; } });
  const rememberedViews = useRef<Partial<Record<Section, View>>>({});
  const setTab = (next: Tab) => { if (next !== tab) window.scrollTo({ top: 0 }); requestAnimationFrame(() => document.querySelector<HTMLElement>(".social-page-heading h1")?.focus({preventScroll:true})); rememberedViews.current = rememberView(rememberedViews.current, next); updateTab(next); try { localStorage.setItem("toris.workspace.view", next); } catch {} };
  const section = sectionFor(tab);
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
  const [assetQueueRequest, setAssetQueueRequest] = useState(0);
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
  const [aiStatus, setAiStatus] = useState<AiStatus>({ providers: [], defaultProvider: null, model: null });
  const [aiStatusError, setAiStatusError] = useState("");
  const [aiChecking, setAiChecking] = useState(true);
  const [aiPlatform, setAiPlatform] = useState<SocialPlatform>("youtube");
  const [aiTopic, setAiTopic] = useState("");
  const [aiContext, setAiContext] = useState("");
  const [aiOutput, setAiOutput] = useState("");
  const [aiOutputLabel, setAiOutputLabel] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [copying, setCopying] = useState(false);
  const [publicationSeed, setPublicationSeed] = useState<{title:string;description:string;key:number} | null>(null);
  const contentDialog = useRef<HTMLDialogElement>(null);
  const channelDialog = useRef<HTMLDialogElement>(null);
  const noticeRegion = useRef<HTMLDivElement>(null);
  const contentError = useRef<HTMLParagraphElement>(null);
  const channelError = useRef<HTMLParagraphElement>(null);
  const alive = useRef(false);
  const lifecycle = useRef(0);
  const dashboardRequest = useRef(0);
  const aiRequest = useRef(0);
  const [readDashboard] = useState(() => createSingleFlight<DashboardData>());
  const [readAiProfile] = useState(() => createSingleFlight<ModelStatus>());

  const loadDashboard = useCallback(async () => {
    if (!alive.current) return;
    const owner = lifecycle.current, request = ++dashboardRequest.current;
    const current = () => alive.current && owner === lifecycle.current && request === dashboardRequest.current;
    setLoading(true); setLoadError("");
    try { const value = await readDashboard(() => invoke<DashboardData>("get_dashboard")); if (current()) setDashboard(value); }
    catch (error) { if (current()) setLoadError(errorMessage(error)); }
    finally { if (current()) setLoading(false); }
  }, [readDashboard]);

  const checkAi = useCallback(async () => {
    if (!alive.current) return;
    const owner = lifecycle.current, request = ++aiRequest.current;
    const current = () => alive.current && owner === lifecycle.current && request === aiRequest.current;
    setAiChecking(true); setAiStatusError("");
    try {
      const model = await readAiProfile(() => readAiStatus());
      if (!current()) return;
      const ready = contentReady(model);
      const choice = model.contentModel ?? model.agentModel;
      setAiStatus({ providers: [{ id: "content", label: modelLabel(model, choice), configured: Boolean(choice), available: ready, detail: ready ? modelLabel(model, choice) + "로 작성합니다." : choice ? "선택한 모델을 사용할 수 없습니다. Agent에서 키·로그인을 확인하세요." : "Agent의 모델 설정에서 콘텐츠 작성 모델을 선택하세요." }], defaultProvider: ready ? "content" : null, model });
    } catch (error) { if (current()) setAiStatusError(errorMessage(error)); }
    finally { if (current()) setAiChecking(false); }
  }, [readAiProfile]);

  useEffect(() => {
    alive.current = true; lifecycle.current += 1;
    void loadDashboard(); void checkAi();
    return () => { alive.current = false; lifecycle.current += 1; dashboardRequest.current += 1; aiRequest.current += 1; };
  }, [loadDashboard, checkAi]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen("browser-runtime-error", () => {
      if (active) setNotice({ tone: "error", text: "브라우저 종료를 확인하지 못했습니다. 연결 설정에서 브라우저 상태를 확인하세요. 전용 브라우저 재실행이 차단됩니다." });
    }, { target: { kind: "WebviewWindow", label: "main" } }).then(stop => { if (active) unlisten = stop; else stop(); }).catch(() => {});
    return () => { active = false; unlisten?.(); };
  }, []);

  const nativeActivity = saving || refreshingTrends || aiBusy || loading || aiChecking;
  const nativeActivityLabel = saving ? "로컬 DB에 저장 중" : refreshingTrends ? "콘텐츠 수집 중" : aiBusy ? "AI 작성 중" : loading ? "워크스페이스 불러오는 중" : aiChecking ? "AI 모델 확인 중" : "";
  useEffect(() => nativeActivity ? beginMainActivity() : undefined, [nativeActivity]);

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
  async function sendAiBrief() {
    if (aiBusy) return;
    setAiError(""); setAiBusy(true);
    try {
      if (aiOutput && !window.confirm("현재 편집한 결과를 새 AI 초안으로 바꿀까요?")) return;
      const result = await generateText(chatBrief(aiPlatform, aiTopic, aiContext, aiReferences));
      setAiOutput(result.text); setAiOutputLabel(modelLabel(aiStatus.model, { provider: result.provider, model: result.model }) + " 작성 · 검토 후 사용");
      setAiSelectionNotice("AI 초안을 받았습니다. 사실과 표현을 검토한 뒤 사용하세요.");
    } catch (error) { setAiError(errorMessage(error)); }
    finally { setAiBusy(false); }
  }
  async function reviewText(request: CreationRequest) {
    if (!request.draft?.text) throw new Error("수신한 문구가 없습니다.");
    if (aiOutput && !window.confirm("현재 편집한 결과를 수신 초안으로 바꿔 검토할까요?")) return;
    setAiOutput(request.draft.text); setAiOutputLabel("수신 초안 · 검토·편집 후 저장");
  }

  function renderContentCard(item: SocialContent) {
    return <article className="social-content-card" key={item.id}><div className="social-card-platform"><PlatformMark platform={item.platform} small /><span>{platforms[item.platform].label}</span><span className="social-card-account">{dashboard.channels.find((channel) => channel.id === item.channelId)?.name ?? "채널 미지정"}</span></div><button className="social-card-edit" onClick={() => openContent(item)}><h3>{item.title}</h3><p>{plainPreview(item.body) || "본문을 작성해 아이디어를 구체화하세요."}</p></button><div className="social-card-footer"><span>{item.status === "scheduled" ? <CalendarClock size={13} /> : <FileText size={13} />}{formatDate(item.status === "scheduled" ? item.scheduledAt : item.updatedAt, item.status === "scheduled")}</span>{safeUrl(item.url) ? <External url={safeUrl(item.url)} aria-label={`${item.title} 발행 링크 열기`}><ExternalLink size={14} /></External> : <button aria-label={`${item.title} 수정`} onClick={() => openContent(item)}><ArrowRight size={14} /></button>}</div></article>;
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
    event.preventDefault(); if (saving) return; setFormError("");
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
      readDashboard.invalidate(); dashboardRequest.current += 1; setLoading(false);
      setDashboard((current) => ({ ...current, content: [content, ...current.content.filter((item) => item.id !== content.id)] }));
      setContentOpen(false);
      setNotice({ tone: "success", text: contentForm.status === "scheduled" ? "발행 계획을 로컬 DB에 저장했습니다. 계획 일시에 자동 발행하지는 않습니다." : "콘텐츠를 로컬 DB에 저장했습니다." });
    } catch (error) { setFormError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  async function saveChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (saving) return; setFormError("");
    if (!channelForm.name.trim()) { setFormError("채널 이름을 입력하세요. 저장하지 않았습니다."); return; }
    if (!channelForm.url.trim()) { setFormError("채널 URL은 필수입니다. 선택한 SNS의 공식 HTTPS 채널 주소를 입력하세요."); return; }
    if (!event.currentTarget.checkValidity()) { setFormError("채널 URL을 https://로 시작하는 전체 주소로 입력하세요. 저장하지 않았습니다."); return; }
    setSaving(true);
    try {
      const channel = await invoke<SocialChannel>("create_channel", { input: { ...channelForm, name: channelForm.name.trim(), handle: channelForm.handle.trim(), url: channelForm.url.trim() } });
      readDashboard.invalidate(); dashboardRequest.current += 1; setLoading(false);
      setDashboard((current) => ({ ...current, channels: [channel, ...current.channels] }));
      setChannelOpen(false); setTab("sns"); setNotice({ tone: "success", text: `${channel.name} 채널을 로컬 DB에 저장했습니다. 계정 권한은 SNS 관리의 연결·권한에서 설정하세요.` });
    } catch (error) { setFormError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  async function refreshTrends(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault(); if (refreshingTrends) return; setRefreshingTrends(true); setTrendWarnings([]);
    try {
      const result = await invoke<TrendRefreshResult>("refresh_trends", { keyword: trendKeyword.trim() || null });
      readDashboard.invalidate(); dashboardRequest.current += 1; setLoading(false);
      setDashboard(result.dashboard); setTrendWarnings(result.warnings);
      setNotice({ tone: result.saved ? "success" : "info", text: result.collected
        ? `${result.collected}개의 콘텐츠·키워드를 수집했습니다.${result.saved ? " 로컬 DB에 저장했습니다." : " DB에 저장하지 못했습니다."}`
        : "새로 수집된 결과가 없습니다. 수집 소스의 연결 상태를 확인하세요." });
    } catch (error) { setNotice({ tone: "error", text: errorMessage(error) }); }
    finally { setRefreshingTrends(false); }
  }

  function aiFromContent() {
    setAiTopic(contentForm.title); setAiContext(contentForm.body.slice(0, 6000)); setAiReferences([]); setContentOpen(false); setTab("ai");
    setAiSelectionNotice("콘텐츠를 문구 작성 자료로 가져왔습니다. 참고자료를 확인한 뒤 AI로 작성을 누르세요.");
  }

  function patternReport() {
    const topic = "실제 수집된 최근 콘텐츠·키워드 10개의 공통 패턴과 내 채널에 적용할 콘텐츠 아이디어를 분석해줘.";
    const context = visibleTrends.map((trend, index) => `${index + 1}. 출처: ${sourceLabels[trend.source]}\n키워드: ${trend.keyword}\n제목: ${trend.title}\n원본 수치: ${trend.metric ?? "제공되지 않음"}\n조회수: ${trend.details?.viewCount ?? "제공되지 않음"}\n채널: ${trend.details?.channelTitle ?? "제공되지 않음"}\n구독자: ${trend.details?.subscriberCount ?? "제공되지 않음"}\n길이: ${trend.details?.durationSeconds ?? "제공되지 않음"}초\n링크: ${trend.url}\n수집: ${trend.fetchedAt}`).join("\n\n") +
      "\n\n위 제목과 출처 정보만 근거로 사용해줘. 원문을 읽었다고 주장하지 말고 사실과 추정을 구분해줘. 수치가 없는 검색 결과를 인기 순위로 해석하지 말아줘. 도입 훅, 주제, 표현 형식의 공통점을 분석하고 각 플랫폼 아이디어와 검증할 가설을 제안해줘.";
    setAiTopic(topic); setAiContext(context.slice(0, 6000)); setAiReferences([]); setAiOutput(""); setTab("ai");
    setAiSelectionNotice("패턴 분석 자료를 준비했습니다. AI로 작성을 누르면 Agent 탭의 콘텐츠 작성 모델로 분석합니다.");
  }

  function useTrend(trend: SocialTrend, selectedPlatform?: SocialPlatform) {
    const platform = selectedPlatform ?? (trend.source === "youtube" || trend.source === "naver_blog" ? trend.source : undefined);
    openContent(undefined, { ...(platform ? { platform } : {}), title: trend.keyword || trend.title, body: `참고 콘텐츠: ${trend.title}\n출처: ${trend.url}` });
  }

  const viewTitle = tabs.find(item => item.id === tab)?.label ?? "SNS 관리";
  const sectionLabel = MAIN_SECTIONS.find(item => item.id === section)?.label ?? "설정";
  const viewDescription = { sns: "채널의 성과와 다음 작업을 확인하세요.", publications: "문구와 파일·계정을 검토하고 승인된 게시와 결과를 관리하세요.", content: "아이디어와 초안을 모으고 다음 발행을 계획하세요.", trends: "실제 출처에서 다음 콘텐츠 아이디어를 찾으세요.", keywords: "키워드와 콘텐츠 원문 근거를 연결하세요.", ai: "자료를 골라 Agent의 콘텐츠 작성 모델로 초안을 만들고 검토하세요.", planner: "오늘과 이번 주 일정, 열린 작업, 게시 예약을 보고 Studio 전용 Google 캘린더와 동기화하세요.", ops: "앱·웹·서비스의 CI, 배포, 헬스체크, Play 심사 상태를 읽기 전용으로 보고 문제는 작업으로 넘기세요.", agent: "프로젝트 코드 작업과 주간 콘텐츠·운영 점검 워크플로를 에이전트에게 맡기고 변경과 저장을 승인하세요.", assets: "이미지와 에셋을 규격에 맞추고 재사용하세요.", video: "영상과 모션을 편집하고 로컬 MP4로 출력하세요.", settings: "로컬 데이터와 브라우저·앱을 설정하세요." }[tab];

  return (
    <div className="social-workspace">
      <a className="social-skip-link" href="#social-main">본문으로 이동</a>
      <aside className="social-sidebar" aria-label="워크스페이스 메뉴">
        <button type="button" onClick={() => setTab("sns")} className="social-brand" aria-label="Toris Studio SNS 관리"><span className="social-brand-mark"><img src="./brand/toris-logo.png" alt="" width={40} height={40} /></span><span><strong>Toris Studio</strong><small>Creator workspace</small></span></button>
        <nav className="social-nav" aria-label="주 메뉴">
          {MAIN_SECTIONS.map(item => { const Icon = sectionIcons[item.id]; return <button key={item.id} type="button" title={item.label} className={section === item.id ? "active" : ""} aria-current={section === item.id ? "page" : undefined} onClick={() => setTab(rememberedViews.current[item.id] ?? sectionItems(item.id)[0].id)}><Icon size={19}/><span>{item.label}</span></button>; })}
        </nav>
        <nav className="workspace-settings-nav social-nav" aria-label="앱 설정"><button className={section === "settings" ? "active" : ""} title="설정" onClick={() => setTab("settings")}><Settings2 size={19}/><span>설정</span></button></nav>
        <div className="social-sidebar-bottom" title="콘텐츠는 로컬 DB에 저장됩니다. AI 요청 시 입력한 내용은 선택한 모델 공급자에게 전달됩니다."><ShieldCheck size={16} /><strong>내 기기에 저장</strong><p>AI 요청 내용만 선택한 모델 공급자에게 전달됩니다.</p></div>
      </aside>

      <div className="social-shell">
        <header className="social-topbar"><span className="social-breadcrumb">{sectionLabel !== viewTitle && <><button type="button" onClick={() => setTab(sectionItems(section)[0].id)}>{sectionLabel}</button><ChevronRight size={14} aria-hidden="true" /></>}<strong>{viewTitle}</strong></span><div className="social-topbar-context"><DesktopCommandMenu items={tabs} onNavigate={setTab} />{nativeActivity && <span className="desktop-native-activity" role="status"><LoaderCircle size={14} className="social-spin" aria-hidden="true" />{nativeActivityLabel}</span>}<div className={`social-db-state ${dashboard.database.connected ? "connected" : ""}`}><span className="social-db-dot" /><span>{loading ? "DB 확인 중" : dashboard.database.connected ? "로컬 DB 연결됨" : "DB 연결 필요"}</span></div><OperationTray onNavigate={(view, focus) => { if (focus === "queue") setAssetQueueRequest(n => n + 1); setTab(view); }}/></div></header>
        <main id="social-main" className="social-main" tabIndex={-1}>
          <div className="social-page-heading"><div><h1 tabIndex={-1}>{viewTitle}</h1><p>{viewDescription}</p></div><div className="social-heading-actions"><button className="social-button subtle icon-only" aria-label="워크스페이스 새로고침" disabled={loading} onClick={() => { setAssetRefreshKey(key => key + 1); void loadDashboard(); void checkAi(); }}><RefreshCw size={17} className={loading ? "social-spin" : ""}/></button>{tab === "content" && <button className="social-button primary" disabled={!dashboard.database.connected} onClick={() => openContent()}><Plus size={17}/>새 콘텐츠</button>}</div></div>
          {sectionItems(section).length > 1 && <nav className="workspace-subnav" aria-label={`${MAIN_SECTIONS.find(item => item.id === section)?.label ?? "설정"} 화면`}>{sectionItems(section).map(item => <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>}
          {notice && <div ref={noticeRegion} tabIndex={-1} className={`social-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "success" ? <Check size={18} /> : <CircleAlert size={18} />}<span>{notice.text}</span><button className="social-dismiss" aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={16} /></button></div>}
          {tab !== "assets" && loadError && <div className="social-notice error" role="alert"><CircleAlert size={18} /><span>{loadError}</span><button className="social-button compact" onClick={() => void loadDashboard()}>다시 시도</button></div>}
          {tab !== "assets" && !loading && !dashboard.database.connected && <div className="social-notice info"><Database size={18} /><span>{dashboard.database.message} 채널·콘텐츠 저장은 DB 연결 후 사용할 수 있습니다.</span><button className="social-button compact" onClick={() => setTab("settings")}>연결 설정</button></div>}

          <div hidden={tab !== "sns"}><SnsWorkspace active={tab === "sns"} dashboard={dashboard} refreshKey={assetRefreshKey} onAddChannel={openChannel} onCreate={(channel) => openContent(undefined, { platform: channel.platform, channelId: channel.id })} onNavigate={setTab} onChanged={() => void loadDashboard()}/></div>

          <div hidden={tab !== "publications"}><PublicationPanel active={tab === "publications"} refreshKey={assetRefreshKey} seed={publicationSeed} onOpenOAuth={() => setTab("sns")} onOpenAgent={() => setTab("agent")} onOpenAssets={() => setTab("assets")} /></div>
          <div hidden={tab !== "assets"}><AssetStudio active={tab === "assets"} refreshKey={assetRefreshKey} queueRequest={assetQueueRequest} /></div>
          <div hidden={tab !== "video"}><VideoPanel active={tab === "video"} onOpenSettings={() => setTab("settings")} onOpenKeywords={() => setTab("keywords")} /></div>
          <div hidden={tab !== "agent"}><AgentPanel active={tab === "agent"} /></div>
          <div hidden={tab !== "planner"}><PlannerPanel active={tab === "planner"} databaseConnected={dashboard.database.connected} onOpenPublications={() => setTab("publications")} /></div>
          <div hidden={tab !== "ops"}><OpsPanel active={tab === "ops"} databaseConnected={dashboard.database.connected} onOpenPlanner={() => setTab("planner")} /></div>
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
            <div className="social-section-heading"><div><h2>최근 수집 콘텐츠 · 키워드</h2><p>원본과 설명을 확인하고, 관심 있는 콘텐츠를 AI 작업실의 주제·참고자료로 가져오세요.</p></div><button className="social-button" disabled={visibleTrends.length === 0 || aiBusy} onClick={patternReport}><Sparkles size={16} />패턴 리포트</button></div>
            <div className="social-source-filters" role="group" aria-label="트렌드 출처 필터">{(["all", "google_trends", "youtube", "naver_blog"] as const).map((source) => <button key={source} aria-pressed={trendSource === source} className={trendSource === source ? "active" : ""} onClick={() => setTrendSource(source)}>{source === "all" ? "전체 출처" : sourceLabels[source]}</button>)}</div>            <div className="desktop-trend-filters" role="group" aria-label="YouTube 콘텐츠 조건"><span>YouTube 조건</span>{([
              ["all", "전체"], ["short", "3분 이하 영상"], ["small_channel", "작은 채널 · 높은 조회"]
            ] as const).map(([filter, label]) => <button key={filter} type="button" aria-pressed={trendFilter === filter} className={trendFilter === filter ? "active" : ""} onClick={() => setTrendFilter(filter)}>{label}</button>)}</div>
            {trendFilter !== "all" && <p className="desktop-trend-filter-note">{trendFilter === "short" ? "원본에 길이가 제공된 3분 이하 영상입니다. 세로 형식이나 Shorts 분류가 확인된 것은 아닙니다." : "구독자가 1만 명 이하이고 조회수가 구독자 수의 5배 이상인 영상입니다. 실제 제공된 수치가 있는 결과만 표시합니다."}</p>}

            {loading && dashboard.trends.length === 0 ? <ActivitySkeleton label="트렌드를 불러오는 중입니다." showStatus/> : visibleTrends.length === 0 ? <EmptyState icon={TrendingUp} title={dashboard.trends.length ? "조건에 맞는 결과가 없어요" : "아직 수집한 트렌드가 없어요"} text={dashboard.trends.length ? "조건을 바꾸거나 관심 키워드로 새 콘텐츠를 수집하세요." : "트렌드 수집을 누르면 실제 출처의 키워드와 콘텐츠가 이곳에 표시됩니다."}><button className="social-button" disabled={refreshingTrends} onClick={() => void refreshTrends()}><RefreshCw size={16} />첫 트렌드 수집</button></EmptyState> : <div className="social-trend-list">{visibleTrends.map((trend, index) => <TrendCard key={trend.id} trend={trend} index={index} canSave={dashboard.database.connected} onSave={useTrend} onUseInAi={useTrendInAi} />)}</div>}
            <div className="social-trend-footnote"><ShieldCheck size={17} /><p>검색 결과의 순서는 인기 순위를 의미하지 않습니다. Threads·TikTok·Instagram의 실시간 인기 콘텐츠는 현재 수집하지 않으며, 각 플랫폼에서 직접 확인할 수 있습니다.</p></div>
            <div className="social-external-platforms">{(["threads", "tiktok", "instagram"] as const).map((platform) => <External key={platform} url={{ threads: "https://www.threads.com/", tiktok: "https://www.tiktok.com/", instagram: "https://www.instagram.com/" }[platform]}><PlatformMark platform={platform} small /><span>{platforms[platform].label} 열기</span><ArrowUpRight size={15} /></External>)}</div>
          </>}

          <div hidden={tab !== "ai"}>
            <AiDiscovery trends={dashboard.trends} loading={loading} databaseConnected={dashboard.database.connected} busy={aiBusy} references={aiReferences} onSelect={useAiMaterial} onRefresh={loadDashboard} onExplore={() => setTab("keywords")}/>
            {aiSelectionNotice && <p className="social-notice info" role="status">{aiSelectionNotice}</p>}
            <div className="social-ai-workbench"><form className="social-ai-brief" onSubmit={event => { event.preventDefault(); void sendAiBrief(); }}>
              <h2>어떤 콘텐츠를 만들까요?</h2><label>대상 플랫폼<select value={aiPlatform} onChange={event => setAiPlatform(event.target.value as SocialPlatform)}>{SOCIAL_PLATFORMS.map(platform => <option key={platform} value={platform}>{platforms[platform].label}</option>)}</select></label>
              <label>주제와 작성 방향<textarea rows={4} value={aiTopic} maxLength={600} required onChange={event => setAiTopic(event.target.value)}/></label><label>참고 자료와 맥락<textarea rows={6} value={aiContext} maxLength={6000} onChange={event => setAiContext(event.target.value)}/></label>
              {aiReferences.map(item => <div className="workspace-inline-heading" key={item.id}><span>{item.trend.title}</span><button type="button" className="social-button compact" onClick={() => setAiReferences(current => current.filter(r => r.id !== item.id))}>참고자료 해제</button></div>)}
              <p className="social-form-hint">{aiCompiledContext.error || `전달할 자료 ${aiCompiledContext.text.length.toLocaleString()} / 6,000자`}</p><button type="submit" className="social-button primary" disabled={aiBusy || !aiTopic.trim() || !!aiCompiledContext.error}>{aiBusy ? <LoaderCircle size={16} className="social-spin"/> : <Sparkles size={16}/>}{aiBusy ? "작성 중" : availableAi.length ? "AI로 작성" : "모델 설정 필요"}</button>
              {aiError && <p className="social-form-error" role="alert">{aiError}</p>}
            </form><section className="social-ai-result"><h2>받은 문구 검토</h2><p className="social-muted">{aiOutputLabel || "초안을 선택하거나 결과를 직접 붙여넣으세요."}</p><label htmlFor="social-ai-manual-output">문구 · 직접 편집</label><textarea id="social-ai-manual-output" rows={12} value={aiOutput} onChange={event => setAiOutput(event.target.value)}/><div className="workspace-inline-actions"><button className="social-button" disabled={!aiOutput.trim() || !dashboard.database.connected} onClick={() => openContent(undefined, { platform: aiPlatform, title: aiTopic.slice(0, 180), body: aiOutput })}>콘텐츠로 저장</button><button className="social-button primary" disabled={!aiOutput.trim()} onClick={() => { setPublicationSeed({ title: aiTopic.slice(0,180), description: aiOutput, key: Date.now() }); setTab("publications"); }}>게시 초안으로</button></div></section></div>
            <CreationInbox active={tab === "ai"} kind="text" onReview={reviewText}/>
          </div>
          {tab === "settings" && <SettingsPanel onSaved={() => { void loadDashboard(); void checkAi(); }} databaseConnected={dashboard.database.connected} />}
        </main>
        <footer className="social-footer"><span>Toris Studio · Desktop · 로컬 워크스페이스</span><span>모든 일정 표시: 한국 표준시 (KST)</span></footer>
      </div>

      <dialog ref={contentDialog} className="social-dialog" onCancel={(event) => { if (saving || aiBusy) event.preventDefault(); else setContentOpen(false); }} onClose={() => setContentOpen(false)} aria-labelledby="social-content-dialog-title"><form onSubmit={saveContent} noValidate><div className="social-dialog-header"><div><h2 id="social-content-dialog-title">{contentForm.id ? "콘텐츠 수정" : "새 콘텐츠"}</h2><p>채널에 맞는 초안을 만들고 발행을 계획하세요.</p></div><button className="social-dismiss" type="button" aria-label="콘텐츠 편집 닫기" disabled={saving || aiBusy} onClick={() => setContentOpen(false)}><X size={20} /></button></div><div className="social-form-grid"><div><label htmlFor="social-content-platform">플랫폼</label><select id="social-content-platform" value={contentForm.platform} disabled={saving || aiBusy} onChange={(event) => setContentForm((current) => ({ ...current, platform: event.target.value as SocialPlatform, channelId: "" }))}>{SOCIAL_PLATFORMS.map((platform) => <option key={platform} value={platform}>{platforms[platform].label}</option>)}</select></div><div><label htmlFor="social-content-channel">채널</label><select id="social-content-channel" value={contentForm.channelId} disabled={saving || aiBusy} onChange={(event) => setContentForm((current) => ({ ...current, channelId: event.target.value }))}><option value="">채널 미지정</option>{dashboard.channels.filter((channel) => channel.platform === contentForm.platform).map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></div></div><label htmlFor="social-content-title">제목 · 아이디어</label><input id="social-content-title" value={contentForm.title} onChange={(event) => setContentForm((current) => ({ ...current, title: event.target.value }))} placeholder="콘텐츠의 핵심 아이디어를 입력하세요" maxLength={180} required disabled={saving || aiBusy} /><div className="social-body-label"><label htmlFor="social-content-body">본문 · 대본</label><button className="social-button compact" type="button" disabled={saving || aiBusy || !contentForm.title.trim()} onClick={aiFromContent}>{aiBusy ? <LoaderCircle size={14} className="social-spin" /> : <Sparkles size={14} />}{aiBusy ? "작성 중" : "AI 초안"}</button></div><textarea id="social-content-body" value={contentForm.body} onChange={(event) => setContentForm((current) => ({ ...current, body: event.target.value }))} placeholder="아이디어, 글, 영상 대본과 참고 출처를 적어보세요" rows={8} maxLength={20000} disabled={saving || aiBusy} />{aiError && <p className="social-form-error" role="alert">{aiError}</p>}{availableAi.length === 0 && <p className="social-form-hint">ChatGPT 작성 요청은 AI 작업실에서 대화에 전달하고 응답을 가져올 수 있습니다.</p>}<div className="social-form-grid"><div><label htmlFor="social-content-status">진행 상태</label><select id="social-content-status" value={contentForm.status} disabled={saving || aiBusy} onChange={(event) => setContentForm((current) => ({ ...current, status: event.target.value as ContentStatus }))}>{CONTENT_STATUSES.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></div>{contentForm.status === "scheduled" && <div><label htmlFor="social-content-scheduled">계획 일시 (한국 시간)</label><input type="datetime-local" id="social-content-scheduled" value={contentForm.scheduledAt} onChange={(event) => setContentForm((current) => ({ ...current, scheduledAt: event.target.value }))} required disabled={saving || aiBusy} /></div>}</div>{contentForm.status === "scheduled" && <p className="social-form-hint">일정 기록용입니다. 해당 시간에 자동으로 게시하지 않습니다.</p>}{contentForm.status === "published" && <p className="social-form-hint">플랫폼에서 직접 발행한 콘텐츠의 기록입니다. 저장하면 발행 기록으로 분류됩니다.</p>}<label htmlFor="social-content-url">발행 URL <small>선택</small></label><input id="social-content-url" type="url" value={contentForm.url} onChange={(event) => setContentForm((current) => ({ ...current, url: event.target.value }))} placeholder="https://" maxLength={2000} disabled={saving || aiBusy} />{formError && <p ref={contentError} tabIndex={-1} className="social-form-error" role="alert">{formError}</p>}<div className="social-dialog-actions"><button className="social-button" type="button" disabled={saving || aiBusy} onClick={() => setContentOpen(false)}>취소</button><button className="social-button primary" type="submit" disabled={saving || aiBusy}>{saving ? <LoaderCircle size={17} className="social-spin" /> : <Check size={17} />}{saving ? "저장 중" : "콘텐츠 저장"}</button></div></form></dialog>

      <dialog ref={channelDialog} className="social-dialog small" onCancel={(event) => { if (saving) event.preventDefault(); else setChannelOpen(false); }} onClose={() => setChannelOpen(false)} aria-labelledby="social-channel-dialog-title"><form onSubmit={saveChannel} noValidate><div className="social-dialog-header"><div><h2 id="social-channel-dialog-title">채널 정보 등록</h2><p>관리할 채널의 기본 정보를 저장하세요.</p></div><button className="social-dismiss" type="button" aria-label="채널 등록 닫기" disabled={saving} onClick={() => setChannelOpen(false)}><X size={20} /></button></div><label htmlFor="social-channel-platform">플랫폼</label><select id="social-channel-platform" value={channelForm.platform} onChange={(event) => setChannelForm((current) => ({ ...current, platform: event.target.value as SocialPlatform }))} disabled={saving}>{SOCIAL_PLATFORMS.map((platform) => <option key={platform} value={platform}>{platforms[platform].label}</option>)}</select><label htmlFor="social-channel-name">채널 이름</label><input id="social-channel-name" value={channelForm.name} onChange={(event) => setChannelForm((current) => ({ ...current, name: event.target.value }))} placeholder="내 채널 이름" maxLength={120} required disabled={saving} /><label htmlFor="social-channel-handle">핸들 · 계정 ID <small>선택</small></label><input id="social-channel-handle" value={channelForm.handle} onChange={(event) => setChannelForm((current) => ({ ...current, handle: event.target.value }))} placeholder="@my_channel" maxLength={160} disabled={saving} /><label htmlFor="social-channel-url">채널 URL <small>필수</small></label><input id="social-channel-url" type="url" required value={channelForm.url} onChange={(event) => setChannelForm((current) => ({ ...current, url: event.target.value }))} placeholder="https://" maxLength={2000} disabled={saving} /><p className="social-form-hint">채널 이름과 공식 HTTPS 채널 URL을 입력하세요. 등록한 채널은 내 채널에 표시됩니다. 계정 로그인과 분석·게시 권한은 SNS 관리의 연결·권한에서 연결합니다.</p>{formError && <p ref={channelError} tabIndex={-1} className="social-form-error" role="alert">{formError}</p>}<div className="social-dialog-actions"><button className="social-button" type="button" disabled={saving} onClick={() => setChannelOpen(false)}>취소</button><button className="social-button primary" type="submit" disabled={saving}>{saving ? <LoaderCircle size={17} className="social-spin" /> : <Plus size={17} />}{saving ? "저장 중" : "채널 등록"}</button></div></form></dialog>
    </div>
  );
}
