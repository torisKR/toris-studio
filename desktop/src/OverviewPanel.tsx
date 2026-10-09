import { useMemo, useState } from "react";
import {
  ArrowRight, ArrowUpRight, AtSign, CalendarClock, Camera, Check,
  ChevronRight, Database, FileText, Music2, NotebookPen, Plus,
  Search, Settings2, Sparkles, TrendingUp, Video
} from "lucide-react";
import { BrandAtmosphere } from "./BrandAtmosphere";
import { External } from "./External";
import { CONTENT_STATUSES, SOCIAL_PLATFORMS } from "./types";
import type { ContentStatus, SocialContent, SocialDashboard, SocialPlatform, SocialTrend } from "./types";
import "./OverviewPanel.css";

export type OverviewRoute = "content" | "trends" | "channels" | "youtube" | "oauth" | "ai" | "settings" | "keywords";

type Props = {
  dashboard: SocialDashboard;
  loading: boolean;
  aiChecking: boolean;
  availableAiCount: number;
  onNavigate: (route: OverviewRoute) => void;
  onCreate: (platform?: SocialPlatform) => void;
  onEdit: (content: SocialContent) => void;
  onAddChannel: (platform: SocialPlatform) => void;
  onSaveTrend: (trend: SocialTrend, platform?: SocialPlatform) => void;
  onUseInAi?: (trend: SocialTrend) => void;
};

const platformInfo = {
  youtube: { name: "YouTube", icon: Video, letter: "Y" },
  threads: { name: "Threads", icon: AtSign, letter: "@" },
  naver_blog: { name: "네이버 블로그", icon: NotebookPen, letter: "N" },
  tiktok: { name: "TikTok", icon: Music2, letter: "T" },
  instagram: { name: "Instagram", icon: Camera, letter: "I" }
};
const statusNames: Record<ContentStatus, string> = { draft: "초안", ready: "검토 완료", scheduled: "발행 계획", published: "발행 기록" };
const sourceNames = { youtube: "YouTube", naver_blog: "네이버", google_trends: "Google 트렌드" };
const countFormat = new Intl.NumberFormat("ko-KR");

function dateLabel(value: string | null, time = false) {
  if (!value) return "일정 미정";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "일시 확인 필요";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "short", day: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) }).format(date);
}

function timestamp(value: string) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function externalUrl(value: string) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : undefined;
  } catch { return undefined; }
}

export function OverviewPanel({ dashboard, loading, aiChecking, availableAiCount, onNavigate, onCreate, onEdit, onAddChannel, onSaveTrend, onUseInAi }: Props) {
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<SocialPlatform | "all">("all");
  const [trendOrder, setTrendOrder] = useState<"recent" | "views">("recent");
  const [statusFilter, setStatusFilter] = useState<ContentStatus | "all">("all");
  const selectedPlatform = platform === "all" ? undefined : platform;
  const query = search.trim().toLocaleLowerCase();
  const filteredContent = useMemo(() => dashboard.content.filter((content) =>
    (platform === "all" || content.platform === platform) &&
    `${content.title} ${content.body}`.toLocaleLowerCase().includes(query)
  ).sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt)), [dashboard.content, platform, query]);
  const visibleContent = filteredContent.filter((item) => statusFilter === "all" || item.status === statusFilter).slice(0, 4);
  const filteredTrends = useMemo(() => dashboard.trends.filter((trend) =>
    (platform === "all" || trend.source === platform) &&
    `${trend.title} ${trend.keyword} ${trend.details?.channelTitle ?? ""}`.toLocaleLowerCase().includes(query)
  ), [dashboard.trends, platform, query]);
  const visibleTrends = useMemo(() => trendOrder === "views"
    ? filteredTrends.filter((trend) => trend.source === "youtube" && trend.details?.viewCount !== undefined)
      .sort((a, b) => (b.details?.viewCount ?? 0) - (a.details?.viewCount ?? 0)).slice(0, 5)
    : [...filteredTrends].sort((a, b) => timestamp(b.fetchedAt) - timestamp(a.fetchedAt)).slice(0, 5), [filteredTrends, trendOrder]);
  const filteredChannels = dashboard.channels.filter((channel) =>
    (platform === "all" || channel.platform === platform) &&
    `${channel.name} ${channel.handle}`.toLocaleLowerCase().includes(query));
  const keywordCount = new Set(dashboard.trends.map((trend) => trend.keyword.trim()).filter(Boolean)).size;
  const nextScheduled = dashboard.content.filter((content) => content.status === "scheduled" && content.scheduledAt)
    .sort((a, b) => timestamp(a.scheduledAt!) - timestamp(b.scheduledAt!))[0];
  const lastCollected = dashboard.trends.reduce<string | null>((latest, trend) => !latest || timestamp(trend.fetchedAt) > timestamp(latest) ? trend.fetchedAt : latest, null);
  const isInitialLoading = loading && dashboard.channels.length === 0 && dashboard.content.length === 0 && dashboard.trends.length === 0;
  const noResults = Boolean(query || platform !== "all") && !filteredContent.length && !filteredTrends.length && !filteredChannels.length;

  return <div className="studio-overview" aria-busy={loading}>
    <section className="studio-masthead" aria-labelledby="studio-masthead-title">
      <div className="studio-masthead-copy">
        <span className="studio-eyebrow"><span />Creator workspace</span>
        <h2 id="studio-masthead-title">다음 콘텐츠의 시작,<br /><em>내 작업실에서.</em></h2>
        <p>발견한 키워드를 아이디어로, 아이디어를 콘텐츠로.<br className="studio-desktop-break" /> 다섯 채널의 작업을 한곳에서 이어가세요.</p>
        <div className="studio-masthead-actions">
          <button type="button" className="social-button primary" disabled={!dashboard.database.connected} onClick={() => onCreate(selectedPlatform)}><Plus size={17} />새 콘텐츠 만들기</button>
          <button type="button" className="studio-text-action" onClick={() => onNavigate("trends")}>트렌드 둘러보기<ArrowUpRight size={16} /></button>
        </div>
      </div>
      <div className="studio-masthead-art"><BrandAtmosphere /></div>
    </section>

    <section className="studio-summary" aria-label="실제 저장 데이터 현황">
      {[
        { label: "저장한 콘텐츠", value: dashboard.content.length, hint: "불러온 콘텐츠 기준", route: "content" as const },
        { label: "등록한 채널", value: dashboard.channels.length, hint: `불러온 등록 정보 · ${new Set(dashboard.channels.map((channel) => channel.platform)).size}개 플랫폼`, route: "channels" as const },
        { label: "기존 수집 주제", value: keywordCount, hint: `불러온 수집 결과 ${dashboard.trends.length}개 기준`, route: "keywords" as const },
        { label: "발행 계획", value: dashboard.content.filter((content) => content.status === "scheduled").length, hint: nextScheduled ? `불러온 일정 중 ${dateLabel(nextScheduled.scheduledAt, true)}` : "불러온 콘텐츠의 발행 계획", route: "content" as const }
      ].map((metric) => <button type="button" className="studio-summary-item" key={metric.label} onClick={() => onNavigate(metric.route)}><span>{metric.label}<ArrowUpRight size={13} /></span>{isInitialLoading ? <span className="studio-skeleton studio-skeleton-number" /> : <strong>{dashboard.database.connected || (metric.route === "keywords" && dashboard.trends.length > 0) ? <>{countFormat.format(metric.value)}<small>개</small></> : "—"}</strong>}<small>{dashboard.database.connected || (metric.route === "keywords" && dashboard.trends.length > 0) ? metric.hint : "DB 연결 후 확인할 수 있습니다"}</small></button>)}
    </section>

    <div className="studio-discovery-bar">
      <label className="studio-unified-search"><Search size={18} aria-hidden="true" /><input aria-label="오버뷰 콘텐츠·채널·키워드 검색" aria-describedby="studio-search-scope" placeholder="콘텐츠, 채널, 키워드 검색" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={120} />{search && <button type="button" onClick={() => setSearch("")} aria-label="오버뷰 검색 초기화">초기화</button>}</label>
      <div className="studio-platform-switch" role="group" aria-label="오버뷰 플랫폼 필터"><button type="button" className={platform === "all" ? "active" : ""} aria-pressed={platform === "all"} onClick={() => setPlatform("all")}>전체</button>{SOCIAL_PLATFORMS.map((item) => { const Icon = platformInfo[item].icon; return <button type="button" key={item} aria-label={`${platformInfo[item].name} 필터`} title={platformInfo[item].name} className={platform === item ? "active" : ""} aria-pressed={platform === item} onClick={() => setPlatform(item)}><Icon size={17} /><span>{platformInfo[item].name}</span></button>; })}</div>
    </div>
    <p id="studio-search-scope" className="studio-search-scope">현황과 검색은 현재 불러온 콘텐츠·채널·수집 결과를 기준으로 표시합니다.</p>
    {noResults && <div className="studio-no-results" role="status"><Search size={18} /><span>일치하는 콘텐츠·채널·키워드가 없습니다.</span><button type="button" onClick={() => { setSearch(""); setPlatform("all"); }}>검색과 필터 초기화</button></div>}

    <div className="studio-overview-columns">
      <div className="studio-overview-primary">
        <section className="studio-section studio-content-overview" aria-labelledby="studio-content-title">
          <div className="studio-section-heading"><div><span className="studio-section-kicker">My content</span><h2 id="studio-content-title">이어갈 작업</h2></div><button type="button" className="studio-text-action" onClick={() => onNavigate("content")}>플래너 열기<ChevronRight size={15} /></button></div>
          <div className="studio-status-tabs" role="group" aria-label="오버뷰 콘텐츠 상태 필터"><button type="button" className={statusFilter === "all" ? "active" : ""} aria-pressed={statusFilter === "all"} onClick={() => setStatusFilter("all")}>전체 <span>{filteredContent.length}</span></button>{CONTENT_STATUSES.map((status) => <button type="button" key={status} className={statusFilter === status ? "active" : ""} aria-pressed={statusFilter === status} onClick={() => setStatusFilter(status)}>{statusNames[status]}<span>{filteredContent.filter((content) => content.status === status).length}</span></button>)}</div>
          {isInitialLoading ? <div className="studio-row-skeletons" role="status" aria-label="저장 콘텐츠 불러오는 중">{[0, 1, 2].map((row) => <div key={row}><span className="studio-skeleton studio-skeleton-icon" /><span className="studio-skeleton studio-skeleton-line" /></div>)}</div> : visibleContent.length ? <div className="studio-content-rows">{visibleContent.map((content) => { const Icon = platformInfo[content.platform].icon; return <button type="button" className="studio-content-row" key={content.id} onClick={() => onEdit(content)}><span className={`studio-platform-icon ${content.platform}`}><Icon size={18} /></span><span className="studio-content-row-copy"><strong>{content.title}</strong><span>{platformInfo[content.platform].name} · {dashboard.channels.find((channel) => channel.id === content.channelId)?.name ?? "채널 미지정"}</span></span><span className={`studio-content-status ${content.status}`}>{statusNames[content.status]}</span><time dateTime={content.status === "scheduled" ? content.scheduledAt ?? undefined : content.updatedAt}>{dateLabel(content.status === "scheduled" ? content.scheduledAt : content.updatedAt)}</time><ArrowUpRight size={15} /></button>; })}</div> : <div className="studio-inline-empty"><FileText size={23} /><strong>{dashboard.content.length ? "조건에 맞는 작업이 없어요" : "첫 번째 아이디어를 남겨보세요"}</strong><p>{dashboard.content.length ? "플랫폼이나 진행 상태를 바꾸면 다른 작업을 볼 수 있습니다." : "제목 하나로 시작해도 좋아요. 본문과 발행 계획은 나중에 이어갈 수 있습니다."}</p><button type="button" className="social-button compact" disabled={!dashboard.database.connected} onClick={() => onCreate(selectedPlatform)}><Plus size={15} />초안 만들기</button></div>}
          <div className="studio-content-footnote"><CalendarClock size={14} /><span>발행 계획은 한국 시간으로 기록하며, 자동 게시하지 않습니다.</span></div>
        </section>

        <section className="studio-section studio-trend-overview" aria-labelledby="studio-trend-title">
          <div className="studio-section-heading"><div><span className="studio-section-kicker">Discovery feed</span><h2 id="studio-trend-title">발견한 콘텐츠 · 키워드</h2></div><button type="button" className="studio-text-action" onClick={() => onNavigate("trends")}>전체 탐색<ChevronRight size={15} /></button></div>
          <div className="studio-trend-toolbar"><div role="group" aria-label="오버뷰 수집 결과 정렬"><button type="button" className={trendOrder === "recent" ? "active" : ""} aria-pressed={trendOrder === "recent"} onClick={() => setTrendOrder("recent")}>최근 수집</button><button type="button" className={trendOrder === "views" ? "active" : ""} aria-pressed={trendOrder === "views"} onClick={() => setTrendOrder("views")}>YouTube 조회수</button></div><span>{lastCollected ? `${dateLabel(lastCollected, true)} 마지막 수집` : "수집 기록 없음"}</span></div>
          {trendOrder === "views" && <p className="studio-ranking-note">수집된 YouTube 영상 중 실제 조회수 순서입니다.</p>}
          {isInitialLoading ? <div className="studio-row-skeletons" role="status" aria-label="수집 키워드 불러오는 중">{[0, 1, 2].map((row) => <div key={row}><span className="studio-skeleton studio-skeleton-icon" /><span className="studio-skeleton studio-skeleton-line" /></div>)}</div> : visibleTrends.length ? <ol className="studio-discovery-rows">{visibleTrends.map((trend, index) => <li className="studio-discovery-row" key={trend.id}><span className={`studio-discovery-source ${trend.source}`} aria-label={sourceNames[trend.source]}>{trendOrder === "views" ? String(index + 1).padStart(2, "0") : trend.source === "youtube" ? <Video size={18} /> : trend.source === "naver_blog" ? "N" : "G"}</span><div className="studio-discovery-copy"><External url={externalUrl(trend.url)}><strong>{trend.title}</strong><ArrowUpRight size={13} /></External><span>{sourceNames[trend.source]}<i />#{trend.keyword}<i />{dateLabel(trend.fetchedAt)}</span></div><div className="studio-discovery-metric">{trend.details?.viewCount !== undefined ? <><strong>{countFormat.format(trend.details.viewCount)}</strong><span>조회수</span></> : trend.metric ? <><strong>{trend.metric}</strong><span>원본 수치</span></> : <span>검색 결과</span>}</div><div className="studio-discovery-actions">{onUseInAi && <button type="button" className="studio-save-idea" onClick={() => onUseInAi(trend)} aria-label={`${trend.title} AI 작업실에서 사용`} title="AI 작업실에서 사용"><Sparkles size={16} /></button>}<button type="button" className="studio-save-idea" disabled={!dashboard.database.connected} onClick={() => onSaveTrend(trend, selectedPlatform)} aria-label={`${trend.title} 아이디어로 저장`} title="아이디어로 저장"><Plus size={16} /></button></div></li>)}</ol> : <div className="studio-inline-empty"><TrendingUp size={23} /><strong>{dashboard.trends.length ? "조건에 맞는 수집 결과가 없어요" : "다음 아이디어를 발견해보세요"}</strong><p>{trendOrder === "views" ? "실제 조회수가 있는 YouTube 영상을 수집하거나 최근 수집으로 전환하세요." : "트렌드 탐색에서 Google·YouTube·네이버의 원본 결과를 수집할 수 있습니다."}</p><button type="button" className="social-button compact" onClick={() => onNavigate("trends")}>트렌드 탐색<ArrowRight size={14} /></button></div>}
        </section>
      </div>

      <aside className="studio-overview-secondary" aria-label="채널과 작업 환경">
        <section className="studio-section studio-platform-overview" aria-labelledby="studio-platform-title">
          <div className="studio-section-heading"><div><span className="studio-section-kicker">Your channels</span><h2 id="studio-platform-title">채널 상태</h2></div><button type="button" className="studio-text-action" onClick={() => onNavigate("channels")} aria-label="채널 전체 관리"><ArrowUpRight size={17} /></button></div>
          <p className="studio-section-description">등록 정보와 수집 API 상태를 확인하세요.</p>
          <div className="studio-channel-rows">{SOCIAL_PLATFORMS.map((item) => {
            const Icon = platformInfo[item].icon;
            const channels = dashboard.channels.filter((channel) => channel.platform === item);
            const matchingChannels = filteredChannels.filter((channel) => channel.platform === item);
            const displayedChannel = query ? matchingChannels[0] : channels[0];
            const integration = dashboard.integrations.find((entry) => entry.id === item);
            const apiState = loading ? "확인 중" : integration?.status === "ready" ? "수집 API 설정됨" : integration?.status === "manual" ? "직접 관리" : integration?.status === "error" ? "수집 연결 확인" : "수집 API 미설정";
            const isMuted = (platform !== "all" && platform !== item) || (query && !matchingChannels.length);
            return <div className={`studio-channel-row${isMuted ? " muted" : ""}`} key={item}>
              <span className={`studio-platform-icon ${item}`}><Icon size={18} /></span>
              <div>
                <strong>{platformInfo[item].name}</strong>
                <span>{loading ? "등록 정보 확인 중" : query ? displayedChannel?.name ?? "일치하는 채널 없음" : displayedChannel ? `${channels.length}개 등록 · ${displayedChannel.name}` : "채널 미등록"}</span>
                {query && !loading && <small>검색 일치 {matchingChannels.length}개 / 등록 {channels.length}개</small>}
                <small className={integration?.status === "ready" ? "configured" : ""}><span />{apiState}</small>
              </div>
              <button type="button" onClick={() => channels.length ? onNavigate("channels") : onAddChannel(item)} disabled={!dashboard.database.connected && !channels.length} aria-label={channels.length ? `${platformInfo[item].name} 채널 관리` : `${platformInfo[item].name} 채널 등록`} title={channels.length ? "채널 관리" : "채널 등록"}>{channels.length ? <ChevronRight size={16} /> : <Plus size={16} />}</button>
            </div>;
          })}</div>
          <button type="button" className="studio-login-action" onClick={() => onNavigate("oauth")}>SNS 로그인과 만료 상태 확인<ArrowRight size={14} /></button>
        </section>

        <section className="studio-workflow-shortcut" aria-labelledby="studio-ai-shortcut-title"><span className="studio-shortcut-symbol"><Sparkles size={20} /></span><span className="studio-section-kicker">AI workspace</span><h2 id="studio-ai-shortcut-title">관찰을 초안으로.</h2><p>주제와 참고 자료를 바탕으로 채널에 맞는 글과 대본을 작성하세요.</p><div className="studio-shortcut-state"><span className={availableAiCount ? "ready" : ""} />{aiChecking ? "AI 연결 확인 중" : availableAiCount ? `${availableAiCount}개 AI 제공자 사용 가능` : "AI 연결을 설정하세요"}</div><button type="button" className="studio-text-action" onClick={() => onNavigate(availableAiCount ? "ai" : "settings")}>{availableAiCount ? "AI 작업실 열기" : "연결 설정 열기"}<ArrowUpRight size={16} /></button></section>

        <div className="studio-local-state"><span className={`studio-local-icon${dashboard.database.connected ? " connected" : ""}`}>{dashboard.database.connected ? <Check size={17} /> : <Database size={17} />}</span><div><strong>{loading ? "작업 환경 확인 중" : dashboard.database.connected ? "내 기기에 저장되는 작업" : "로컬 DB 연결이 필요해요"}</strong><p>{dashboard.database.connected ? "콘텐츠·채널·키워드를 로컬 DB에 보관합니다." : "연결 설정에서 DB를 시작하고 저장을 준비하세요."}</p></div><button type="button" aria-label="작업 환경 연결 설정" onClick={() => onNavigate("settings")}><Settings2 size={16} /></button></div>
      </aside>
    </div>
  </div>;
}
