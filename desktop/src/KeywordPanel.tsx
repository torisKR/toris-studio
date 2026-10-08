import { invoke } from "@tauri-apps/api/core";
import { ArrowLeftRight, ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, CircleAlert, Clock3, Database, ExternalLink, FileSearch, Hash, History, LoaderCircle, Play, RefreshCw, Search, ShieldCheck, Video, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { External } from "./External";
import type { KeywordContent, KeywordCrawler, KeywordCrawlResult, KeywordRun, KeywordSearchMode, KeywordSearchResult, KeywordSource, KeywordStatus } from "./types";
import "./KeywordPanel.css";

type Props = { active?: boolean; databaseConnected?: boolean; onOpenSettings?: () => void; onChanged?: () => void };
type Direction = "keyword" | "content";
type SearchInput = { query: string; mode: KeywordSearchMode; source: KeywordSource; limit: number; offset: number };
const PAGE_SIZE = 25;
const sourceNames: Record<string, string> = { all: "전체 출처", youtube: "YouTube", naver_blog: "네이버 블로그", google_trends: "Google 트렌드" };
const fieldNames = { title: "제목", description: "설명", observed_query: "실제 검색어", source_topic: "기존 수집 주제", body: "원문 본문" };

function failure(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "키워드 탐색을 처리하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.";
}
function date(value: string | null) {
  if (!value) return "원본 날짜 미제공";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "일시 확인 필요" : new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed);
}
function sourceUrl(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
function sourceHost(value: string) {
  try { return new URL(value).hostname; } catch { return "주소 확인 필요"; }
}
function videoId(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const id = url.hostname === "youtu.be" ? url.pathname.slice(1) : ["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(url.hostname)
      ? url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:shorts|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1] : null;
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

function KeywordVideo({ item }: { item: KeywordContent }) {
  const id = videoId(item.trend.url);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [missingThumbnail, setMissingThumbnail] = useState(false);
  const version = useRef(0);
  useEffect(() => () => { version.current += 1; }, []);
  async function play() {
    if (!id) return;
    const request = ++version.current;
    setLoading(true); setError("");
    try {
      const prepared = new URL(await invoke<string>("prepare_youtube_embed", { videoId: id }));
      if (prepared.protocol !== "http:" || prepared.hostname !== "127.0.0.1" || !prepared.port || prepared.username || prepared.password) throw new Error("안전한 영상 재생 주소를 확인하지 못했습니다.");
      if (request === version.current) setUrl(prepared.href);
    } catch (reason) { if (request === version.current) setError(failure(reason)); }
    finally { if (request === version.current) setLoading(false); }
  }
  return <div className="keyword-video-wrap"><div className="keyword-video">{url ? <><iframe src={url} title={`${item.trend.title} · YouTube 영상`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /><button type="button" className="keyword-video-close" aria-label="영상 재생 닫기" onClick={() => { version.current += 1; setUrl(null); setLoading(false); }}><X size={17} /></button></> : id ? <button type="button" className="keyword-video-play" disabled={loading} onClick={() => void play()} aria-label={`${item.trend.title} 영상 재생`}>{!missingThumbnail && <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" onError={() => setMissingThumbnail(true)} />}<span>{loading ? <LoaderCircle size={23} className="social-spin" /> : <Play size={23} fill="currentColor" />}</span><small>{loading ? "플레이어 준비 중" : "영상 재생"}</small></button> : <div className="keyword-video-missing"><Video size={25} /><span>원본 링크에서 영상을 확인하세요.</span></div>}</div>{error && <p className="keyword-inline-error" role="alert">{error} 원본 보기로 확인할 수 있습니다.</p>}</div>;
}

export function KeywordPanel({ active = true, databaseConnected = true, onOpenSettings, onChanged }: Props) {
  const [direction, setDirection] = useState<Direction>("keyword");
  const [mode, setMode] = useState<KeywordSearchMode>("local");
  const [source, setSource] = useState<KeywordSource>("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<KeywordStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [result, setResult] = useState<KeywordSearchResult | null>(null);
  const [lastInput, setLastInput] = useState<SearchInput | null>(null);
  const [runs, setRuns] = useState<KeywordRun[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selected, setSelected] = useState<KeywordContent | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [selectionNotice, setSelectionNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"official" | "crawl" | "cancel" | "prepare" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [crawl, setCrawl] = useState<KeywordCrawlResult | null>(null);
  const [bodyOpen, setBodyOpen] = useState(false);
  const mounted = useRef(true);
  const searchVersion = useRef(0);
  const statusVersion = useRef(0);
  const detailVersion = useRef(0);
  const operationVersion = useRef(0);
  const activeOperation = useRef<{ version: number; kind: "official" | "crawl" | "prepare" } | null>(null);
  const cancelInFlight = useRef(false);
  const onChangedRef = useRef(onChanged);
  const lastInputRef = useRef<SearchInput | null>(null);
  const selectedId = useRef<string | null>(null);
  const currentResult = useRef<KeywordSearchResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const locked = busy !== null || status?.running === true;
  const dbReady = databaseConnected && status?.databaseConnected !== false;
  const selectedBody = crawl?.text ?? selected?.body ?? "";
  const selectedBodyDate = crawl?.observedAt ?? selected?.crawledAt ?? null;
  const keywordGroups = useMemo(() => {
    const observed = new Map<string, Set<string>>();
    const extracted = new Map<string, Set<string>>();
    for (const item of result?.items ?? []) {
      for (const keyword of item.observedKeywords) {
        if (!observed.has(keyword.keyword)) observed.set(keyword.keyword, new Set());
        observed.get(keyword.keyword)!.add(item.trend.id);
      }
      for (const keyword of item.extractedKeywords) {
        if (!extracted.has(keyword.keyword)) extracted.set(keyword.keyword, new Set());
        extracted.get(keyword.keyword)!.add(item.trend.id);
      }
    }
    const entries = (map: Map<string, Set<string>>) => [...map].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], "ko")).slice(0, 18).map(([keyword, ids]) => ({ keyword, count: ids.size }));
    return { observed: entries(observed), extracted: entries(extracted) };
  }, [result]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; searchVersion.current += 1; statusVersion.current += 1; detailVersion.current += 1; operationVersion.current += 1; };
  }, []);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  const refreshStatus = useCallback(async () => {
    const version = ++statusVersion.current;
    const [statusResult, runResult] = await Promise.allSettled([invoke<KeywordStatus>("get_keyword_status"), invoke<KeywordRun[]>("get_keyword_runs")]);
    if (!mounted.current || version !== statusVersion.current) return;
    if (statusResult.status === "fulfilled") { setStatus(statusResult.value); setStatusError(""); }
    else setStatusError(failure(statusResult.reason));
    if (runResult.status === "fulfilled") { setRuns(runResult.value); setHistoryError(""); }
    else setHistoryError(failure(runResult.reason));
  }, []);

  const search = useCallback(async (input: SearchInput) => {
    const version = ++searchVersion.current;
    const operation = input.mode === "official" ? ++operationVersion.current : null;
    setLoading(true); setNotice(null); setSelectionNotice("");
    if (operation !== null) { activeOperation.current = { version: operation, kind: "official" }; setBusy("official"); }
    try {
      const next = await invoke<KeywordSearchResult>("search_keywords", { input });
      if (!mounted.current || version !== searchVersion.current) return;
      currentResult.current = next; lastInputRef.current = input; setResult(next); setLastInput(input);
      if (selectedId.current && !next.items.some((item) => item.trend.id === selectedId.current)) {
        detailVersion.current += 1; selectedId.current = null;
        setSelected(null); setDetailLoading(false); setDetailError(""); setCrawl(null); setBodyOpen(false);
        setSelectionNotice("선택했던 콘텐츠는 현재 검색 결과에 없습니다. 저장된 원본은 삭제되지 않았습니다.");
      } else if (selectedId.current) {
        detailVersion.current += 1;
        const refreshed = next.items.find((item) => item.trend.id === selectedId.current);
        setSelected((current) => refreshed ? { ...current, ...refreshed, body: current?.body, crawledAt: current?.crawledAt, crawlEngine: current?.crawlEngine } : null);
        setDetailLoading(false); setDetailError("");
      }
      if (input.mode === "official") {
        setNotice({ tone: next.warnings.length ? "info" : "success", text: `${next.total}개 콘텐츠가 검색 조건과 일치합니다. 저장 여부와 소스별 수집 상태는 아래 안내를 확인하세요.` });
        onChangedRef.current?.();
      }
    } catch (reason) {
      if (mounted.current && version === searchVersion.current) setNotice({ tone: "error", text: `${failure(reason)}${currentResult.current ? " 이전 조회 결과를 유지했습니다." : ""}` });
    } finally {
      if (mounted.current && version === searchVersion.current) {
        setLoading(false);
        if (operation !== null && activeOperation.current?.version === operation) { activeOperation.current = null; if (!cancelInFlight.current) setBusy(null); }
      }
      if (input.mode === "official" && mounted.current) await refreshStatus();
    }
  }, [refreshStatus]);

  useEffect(() => {
    if (!active) return;
    void refreshStatus();
    if (databaseConnected && !activeOperation.current && !cancelInFlight.current) {
      void search({ query: currentResult.current?.query ?? "", mode: "local", source: lastInputRef.current?.source ?? "all", limit: PAGE_SIZE, offset: lastInputRef.current?.offset ?? 0 });
    }
  }, [active, databaseConnected, refreshStatus, search]);

  useEffect(() => {
    if (!active || !status?.running || busy === "prepare") return;
    const timer = setTimeout(() => void refreshStatus(), 2500);
    return () => clearTimeout(timer);
  }, [active, status, busy, refreshStatus]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || loading || !dbReady) return;
    if (mode === "official" && !query.trim()) { setNotice({ tone: "error", text: "새 콘텐츠를 수집할 검색어를 입력하세요." }); inputRef.current?.focus(); return; }
    if (/[\u0000-\u001f\u007f]/.test(query.trim())) { setNotice({ tone: "error", text: "검색어는 줄바꿈 없이 입력하세요." }); inputRef.current?.focus(); return; }
    await search({ query: query.trim(), mode, source, limit: PAGE_SIZE, offset: 0 });
  }
  function chooseKeyword(keyword: string) {
    if (locked || loading || !dbReady) return;
    setDirection("keyword"); setQuery(keyword); setMode("local");
    void search({ query: keyword, mode: "local", source, limit: PAGE_SIZE, offset: 0 });
  }
  async function chooseContent(item: KeywordContent) {
    const version = ++detailVersion.current;
    selectedId.current = item.trend.id; setSelected(item); setDetailLoading(true); setDetailError(""); setSelectionNotice(""); setCrawl(null); setBodyOpen(false);
    try {
      const next = await invoke<KeywordContent>("get_content_keywords", { input: { trendId: item.trend.id } });
      if (mounted.current && version === detailVersion.current) setSelected({ ...next, matches: item.matches });
    } catch (reason) { if (mounted.current && version === detailVersion.current) setDetailError(`${failure(reason)} 목록에 불러온 정보는 아래에 유지했습니다.`); }
    finally { if (mounted.current && version === detailVersion.current) setDetailLoading(false); }
  }
  async function cancel() {
    if (cancelInFlight.current) return;
    cancelInFlight.current = true; setBusy("cancel");
    try {
      await invoke("cancel_keyword_search");
      if (!mounted.current) return;
      searchVersion.current += 1; operationVersion.current += 1;
      activeOperation.current = null;
      setLoading(false); setBusy(null);
      setNotice({ tone: "info", text: "수집 중단을 요청했습니다. 이전 조회 결과는 유지했습니다." });
    } catch (reason) {
      if (mounted.current) {
        setNotice({ tone: "error", text: failure(reason) });
        setBusy(activeOperation.current?.kind ?? null);
        setLoading(activeOperation.current?.kind === "official");
      }
    } finally { cancelInFlight.current = false; if (mounted.current) await refreshStatus(); }
  }
  async function crawlContent(engine: KeywordCrawler) {
    if (!selected || locked || !dbReady) return;
    const id = selected.trend.id;
    const operation = ++operationVersion.current;
    activeOperation.current = { version: operation, kind: "crawl" };
    setBusy("crawl"); setNotice(null);
    try {
      const next = await invoke<KeywordCrawlResult>("crawl_keyword_content", { input: { trendId: id, engine } });
      if (!mounted.current || operation !== operationVersion.current) return;
      if (selectedId.current === id) { setCrawl(next); setBodyOpen(true); }
      setNotice({ tone: next.warnings.length ? "info" : "success", text: `${engine}로 원문을 수집했습니다. 본문에서 추출한 키워드와 실제 검색어는 구분해서 표시합니다.` });
      onChangedRef.current?.();
    } catch (reason) { if (mounted.current && operation === operationVersion.current) setNotice({ tone: "error", text: failure(reason) }); }
    finally { if (mounted.current && operation === operationVersion.current) { activeOperation.current = null; if (!cancelInFlight.current) setBusy(null); await refreshStatus(); } }
  }

  async function prepareCrawler() {
    if (locked) return;
    const operation = ++operationVersion.current;
    activeOperation.current = { version: operation, kind: "prepare" };
    setBusy("prepare"); setNotice({ tone: "info", text: "로컬 Crawl4AI 수집기를 준비합니다. 처음 시작하면 이미지를 내려받아 최대 3분이 걸릴 수 있습니다." });
    try {
      const prepared = await invoke<{ ok: boolean; message: string }>("start_keyword_crawler");
      if (!mounted.current || operation !== operationVersion.current) return;
      setNotice({ tone: prepared.ok ? "success" : "error", text: prepared.message });
    } catch (reason) { if (mounted.current && operation === operationVersion.current) setNotice({ tone: "error", text: failure(reason) }); }
    finally { if (mounted.current && operation === operationVersion.current) { activeOperation.current = null; setBusy(null); await refreshStatus(); } }
  }

  return <div className="keyword-explorer" aria-busy={loading || detailLoading || busy === "crawl"}>
    <div className="keyword-direction" role="group" aria-label="키워드 탐색 방향">
      <button type="button" aria-pressed={direction === "keyword"} className={direction === "keyword" ? "active" : ""} onClick={() => setDirection("keyword")}><Search size={18} /><span><strong>키워드로 콘텐츠 찾기</strong><small>어떤 검색어에 어떤 콘텐츠가 보일까요?</small></span><ChevronRight size={17} /></button>
      <span className="keyword-direction-connector"><ArrowLeftRight size={19} aria-hidden="true" /></span>
      <button type="button" aria-pressed={direction === "content"} className={direction === "content" ? "active" : ""} onClick={() => setDirection("content")}><FileSearch size={18} /><span><strong>콘텐츠에서 키워드 찾기</strong><small>제목·설명·원문의 근거를 확인하세요.</small></span><ChevronRight size={17} /></button>
    </div>

    <form className="keyword-search-panel" onSubmit={(event) => void submit(event)}>
      <div className="keyword-search-heading"><span><Search size={17} />{direction === "keyword" ? "관심 키워드" : "콘텐츠 제목 또는 키워드"}</span><div role="group" aria-label="키워드 검색 범위"><button type="button" className={mode === "local" ? "active" : ""} aria-pressed={mode === "local"} disabled={locked} onClick={() => setMode("local")}><Database size={13} />저장 자료</button><button type="button" className={mode === "official" ? "active" : ""} aria-pressed={mode === "official"} disabled={locked} onClick={() => setMode("official")}><RefreshCw size={13} />새 콘텐츠 수집</button></div></div>
      <div className="keyword-search-fields"><label className="keyword-query"><span className="social-sr-only">키워드 또는 콘텐츠 제목</span><Search size={18} aria-hidden="true" /><input ref={inputRef} aria-label="키워드 또는 콘텐츠 제목" value={query} maxLength={100} placeholder={mode === "local" ? "저장 자료에서 찾기 · 비워두면 전체" : "예: AI 생산성, 서울 주말 여행"} onChange={(event) => setQuery(event.target.value)} disabled={locked} />{query && <button type="button" disabled={locked} aria-label="키워드 입력 초기화" onClick={() => { setQuery(""); inputRef.current?.focus(); }}><X size={15} /></button>}</label><label className="keyword-source"><span className="social-sr-only">키워드 수집 출처</span><select value={source} disabled={locked} onChange={(event) => setSource(event.target.value as KeywordSource)}>{["all", "youtube", "naver_blog", "google_trends"].map((item) => <option key={item} value={item}>{sourceNames[item]}</option>)}</select></label><button className="social-button primary" type="submit" disabled={locked || loading || !dbReady}>{loading ? <LoaderCircle size={17} className="social-spin" /> : <Search size={17} />}{loading ? "검색 중" : mode === "official" ? "검색하고 수집" : "저장 자료 검색"}</button>{locked && busy !== "prepare" && <button className="social-button" type="button" disabled={busy === "cancel"} onClick={() => void cancel()}>{busy === "cancel" ? "중단 확인 중" : "수집 중단"}</button>}</div>
      <p className="keyword-search-hint">{mode === "local" ? "네트워크 요청 없이 로컬 DB의 제목·설명·실제 검색어·수집한 본문 앞부분 3,000자에서 찾습니다." : "YouTube Data API · 네이버 검색 API · Google 트렌드 RSS에서 원본 결과를 수집합니다. Google 전체 웹 검색은 포함하지 않습니다."}</p>
      <div className="keyword-environment"><div className="keyword-source-status" aria-label="수집 API 설정 상태">{status?.sources.map((item) => <span key={item.id} className={item.configured ? "ready" : ""}><i />{sourceNames[item.id] ?? item.name}<small>{item.configured ? item.id === "google_trends" ? "RSS 사용 가능" : "설정됨" : "미설정"}</small></span>)}</div><button type="button" className="keyword-text-action" disabled={locked} onClick={() => void prepareCrawler()}>{busy === "prepare" ? <LoaderCircle size={13} className="social-spin" /> : <BookOpen size={13} />}{busy === "prepare" ? "로컬 수집기 준비 중" : status?.engines.some((item) => item.id === "crawl4ai" && item.available) ? "로컬 수집기 다시 확인" : "로컬 Crawl4AI 시작"}</button></div>
    </form>

    {notice && <div className={`keyword-feedback ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}><CircleAlert size={17} /><span>{notice.text}</span></div>}
    {statusError && <div className="keyword-feedback error" role="alert"><CircleAlert size={17} /><span>{statusError}</span><button type="button" onClick={() => void refreshStatus()}>연결 다시 확인</button></div>}
    {!dbReady && <div className="keyword-feedback info"><Database size={17} /><span>로컬 DB에 연결하면 저장 자료를 검색하고 새 수집 결과를 보관할 수 있습니다.</span><button type="button" onClick={onOpenSettings}>연결 설정</button></div>}
    {result?.warnings.length ? <div className="keyword-warnings" role="status"><CircleAlert size={17} /><div><strong>수집 상태</strong>{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div> : null}

    <div className="keyword-workspace">
      <section className="keyword-results" aria-labelledby="keyword-results-title">
        <div className="keyword-section-heading"><div><span className="keyword-kicker">Keyword ↔ Content</span><h2 id="keyword-results-title">{direction === "keyword" ? "키워드에 연결된 콘텐츠" : "키워드를 살펴볼 콘텐츠"}</h2></div><button type="button" className="keyword-text-action" disabled={locked || loading || !dbReady} onClick={() => void search({ query: lastInput?.query ?? "", mode: "local", source: lastInput?.source ?? "all", limit: PAGE_SIZE, offset: lastInput?.offset ?? 0 })}><RefreshCw size={14} />다시 조회</button></div>
        {result && <div className="keyword-result-summary"><strong>{result.total.toLocaleString("ko-KR")}<small>개 일치</small></strong><span>{result.query ? `“${result.query}”` : "전체 저장 자료"}<i />{sourceNames[lastInput?.source ?? "all"]}<i />{result.mode === "official" ? "수집 후 로컬 조회" : "로컬 DB 조회"}</span><time dateTime={result.searchedAt}>{date(result.searchedAt)}</time></div>}
        {result && <p className="keyword-scope-note">로컬 자료 {result.libraryCount.toLocaleString("ko-KR")}개 중 최근 {result.indexLimit.toLocaleString("ko-KR")}개까지 검색 · 현재 페이지 {result.items.length}개{result.truncated ? " · 검색 범위를 넘는 자료가 있어 전체 DB 결과와 다를 수 있습니다." : ""}</p>}
        {direction === "keyword" && result && Boolean(keywordGroups.observed.length || keywordGroups.extracted.length) && <div className="keyword-map"><div><strong><Hash size={14} />실제 검색으로 연결된 키워드</strong><small>현재 페이지의 콘텐츠 수 · 클릭해서 로컬 검색</small></div>{keywordGroups.observed.length ? <div className="keyword-pills">{keywordGroups.observed.map((item) => <button type="button" key={item.keyword} disabled={locked || loading || !dbReady} onClick={() => chooseKeyword(item.keyword)}>#{item.keyword}<span>{item.count}</span></button>)}</div> : <p>이 페이지에는 확인된 검색어 연결 기록이 없습니다.</p>}{keywordGroups.extracted.length > 0 && <details><summary>콘텐츠에서 추출한 단어 <span>{keywordGroups.extracted.length}개 표시</span></summary><div className="keyword-pills extracted">{keywordGroups.extracted.map((item) => <button type="button" key={item.keyword} disabled={locked || loading || !dbReady} onClick={() => chooseKeyword(item.keyword)}>{item.keyword}<span>{item.count}</span></button>)}</div><small>실제 검색 노출이 확인된 키워드가 아닙니다.</small></details>}</div>}
        {selectionNotice && <p className="keyword-selection-notice" role="status">{selectionNotice}</p>}
        {loading && <div className="keyword-loading" role="status"><LoaderCircle size={19} className="social-spin" />{busy === "official" ? "선택한 출처에서 검색 결과를 수집하고 있습니다. 이전 결과는 아래에 유지됩니다." : "로컬 검색 결과를 불러오고 있습니다."}</div>}
        {!result && !loading ? <div className="keyword-empty"><Search size={27} /><strong>{dbReady ? "자료를 불러오지 못했습니다" : "키워드 탐색을 준비하세요"}</strong><p>{dbReady ? "다시 조회하거나 검색어를 입력해서 시도하세요." : "연결 설정에서 로컬 DB를 시작하세요."}</p></div> : result && !result.items.length && !loading ? <div className="keyword-empty"><FileSearch size={27} /><strong>{result.libraryCount ? "일치하는 콘텐츠가 없습니다" : "아직 수집한 콘텐츠가 없습니다"}</strong><p>{result.libraryCount ? "검색어와 출처를 바꾸거나 새 콘텐츠 수집을 선택하세요." : "관심 키워드를 입력하고 새 콘텐츠를 수집해보세요."}</p>{result.query && <button type="button" className="social-button compact" onClick={() => { setQuery(""); setSource("all"); setMode("local"); void search({ query: "", mode: "local", source: "all", limit: PAGE_SIZE, offset: 0 }); }} disabled={locked || !dbReady}>전체 저장 자료 보기</button>}</div> : <div className="keyword-content-list">{result?.items.map((item) => <article key={item.trend.id} className={`keyword-content-card ${selected?.trend.id === item.trend.id ? "selected" : ""}`}><button type="button" className="keyword-content-select" aria-pressed={selected?.trend.id === item.trend.id} aria-label={`${item.trend.title} 키워드 근거 보기`} disabled={busy === "crawl"} onClick={() => void chooseContent(item)}><span className={`keyword-content-source ${item.trend.source}`}>{item.trend.source === "youtube" ? <Video size={17} /> : item.trend.source === "naver_blog" ? "N" : "G"}</span><span className="keyword-content-copy"><span>{sourceNames[item.trend.source]}<i />{sourceHost(item.trend.url)}</span><strong>{item.trend.title}</strong><span className="keyword-card-description">{item.trend.details?.description || "원본에서 설명을 제공하지 않았습니다."}</span></span><ChevronRight size={16} /></button><div className="keyword-card-footer"><span>{item.observedKeywords.length ? `확인된 검색어 ${item.observedKeywords.length}개` : "검색어 연결 미확인"}</span><span>추출 단어 {item.extractedKeywords.length}개</span><time dateTime={item.trend.fetchedAt}>{date(item.trend.fetchedAt)} 수집</time></div></article>)}</div>}
        {result && result.total > PAGE_SIZE && lastInput && <div className="keyword-pagination"><button type="button" className="social-button compact" disabled={loading || locked || lastInput.offset === 0} onClick={() => void search({ ...lastInput, mode: "local", offset: Math.max(0, lastInput.offset - PAGE_SIZE) })}><ChevronLeft size={15} />이전</button><span>{lastInput.offset + 1}–{Math.min(lastInput.offset + result.items.length, result.total)} / {result.total}</span><button type="button" className="social-button compact" disabled={loading || locked || lastInput.offset + PAGE_SIZE >= result.total} onClick={() => void search({ ...lastInput, mode: "local", offset: lastInput.offset + PAGE_SIZE })}>다음<ChevronRight size={15} /></button></div>}
      </section>

      <aside className="keyword-detail" aria-labelledby="keyword-detail-title"><div className="keyword-section-heading"><div><span className="keyword-kicker">Evidence</span><h2 id="keyword-detail-title">콘텐츠와 키워드의 연결 근거</h2></div><BookOpen size={19} /></div>{selected ? <div className="keyword-detail-body">{detailLoading && <p className="keyword-loading" role="status"><LoaderCircle size={16} className="social-spin" />저장된 근거 확인 중</p>}{detailError && <p className="keyword-inline-error" role="alert">{detailError}</p>}<div className="keyword-detail-source"><span>{sourceNames[selected.trend.source]}</span><span>{sourceHost(selected.trend.url)}</span></div><h3>{selected.trend.title}</h3>{selected.trend.source === "youtube" && <KeywordVideo key={selected.trend.id} item={selected} />}<p className="keyword-detail-description">{selected.trend.details?.description || "수집한 원본에는 설명이 없습니다."}</p><External url={sourceUrl(selected.trend.url)} className="keyword-original"><ExternalLink size={14} />원본 콘텐츠 보기<ArrowUpRight size={13} /></External><dl className="keyword-dates"><div><dt>원본 발행</dt><dd><time dateTime={selected.trend.publishedAt ?? undefined}>{date(selected.trend.publishedAt)}</time></dd></div><div><dt>수집 시각</dt><dd><time dateTime={selected.trend.fetchedAt}>{date(selected.trend.fetchedAt)}</time></dd></div></dl>
        <section className="keyword-evidence-section"><h4><Search size={15} />실제 검색어로 발견된 기록</h4>{selected.observedKeywords.length ? selected.observedKeywords.map((item, index) => <div className="keyword-observation" key={`${item.keyword}-${item.observedAt}-${index}`}><button type="button" className="keyword-evidence-word" disabled={loading || locked || !dbReady} onClick={() => chooseKeyword(item.keyword)}>#{item.keyword}<ArrowUpRight size={13} /></button><span>{sourceNames[item.source] ?? item.source} · {date(item.observedAt)}</span>{item.rank != null && <small>이 앱의 출처별 결과 {item.rank}번째 · 해당 수집 시점</small>}</div>) : <p>실제 검색으로 연결된 키워드 기록이 없습니다. 아래 추출 단어만으로 검색 노출을 판단할 수 없습니다.</p>}</section>
        {selected.originalKeyword && <p className="keyword-legacy-topic"><Hash size={12} />기존 수집 주제: {selected.originalKeyword}<small>실제 검색어 기록과 구분합니다.</small></p>}
        {selected.matches.length > 0 && <section className="keyword-evidence-section"><h4><Hash size={15} />현재 검색어가 일치한 부분</h4><div className="keyword-match-list">{selected.matches.map((match, index) => <div key={`${match.field}-${index}`}><strong>{fieldNames[match.field]}</strong><span>{match.terms.join(" · ")}</span></div>)}</div></section>}
        <section className="keyword-evidence-section"><h4><FileSearch size={15} />콘텐츠에서 추출한 단어</h4><p>제목·설명·수집한 본문에 등장하는 단어입니다. 검색량이나 인기 점수는 아닙니다.</p>{(crawl?.extractedKeywords ?? selected.extractedKeywords).length ? <div className="keyword-pills extracted">{(crawl?.extractedKeywords ?? selected.extractedKeywords).slice(0, 24).map((item) => <button type="button" key={item.keyword} disabled={loading || locked || !dbReady} onClick={() => chooseKeyword(item.keyword)}>{item.keyword}<span title="원문에서 등장한 횟수">{item.occurrences}회</span></button>)}</div> : <p>추출할 텍스트가 부족합니다. 원문 수집으로 본문을 확인할 수 있습니다.</p>}</section>
        <section className="keyword-evidence-section keyword-crawl"><h4><BookOpen size={15} />선택한 콘텐츠의 원문 수집</h4><p>등록한 로컬 크롤러로 이 콘텐츠 한 건을 처리합니다.</p><div className="keyword-crawler-buttons">{(["crawl4ai", "firecrawl"] as const).map((engine) => { const available = status?.engines.find((item) => item.id === engine)?.available === true; return <button type="button" key={engine} className="social-button compact" disabled={!available || locked || !dbReady} onClick={() => void crawlContent(engine)} title={available ? `${engine}로 선택한 원문 수집` : engine === "firecrawl" ? "Firecrawl은 보안 검증 후 사용할 수 있습니다" : "로컬 크롤러를 시작하세요"}>{busy === "crawl" ? <LoaderCircle size={14} className="social-spin" /> : <BookOpen size={14} />}{engine}<span className={available ? "ready" : ""}>{available ? "연결됨" : engine === "firecrawl" ? "검증 대기" : "미연결"}</span></button>; })}</div>{!status?.engines.some((engine) => engine.id === "crawl4ai" && engine.available) && <button type="button" className="keyword-text-action" disabled={locked} onClick={() => void prepareCrawler()}><BookOpen size={13} />로컬 Crawl4AI 시작</button>}{selectedBody && <><button type="button" className="keyword-body-toggle" aria-expanded={bodyOpen} onClick={() => setBodyOpen((open) => !open)}>{bodyOpen ? "원문 접기" : "수집한 원문 보기"}<span>{selectedBody.length.toLocaleString("ko-KR")}자 · {selectedBodyDate ? date(selectedBodyDate) : "본문 수집 시각 미제공"}</span></button>{bodyOpen && <pre className="keyword-crawled-body">{selectedBody}</pre>}{crawl?.warnings.map((warning, index) => <p className="keyword-inline-error" key={index}>{warning}</p>)}</>}</section>
      </div> : <div className="keyword-empty keyword-detail-empty"><ArrowLeftRight size={31} /><strong>콘텐츠를 선택하면 연결이 보여요</strong><p>검색된 콘텐츠를 눌러 실제 검색어, 추출 단어, 원문 날짜를 함께 확인하세요.</p><div><span><Search size={15} />키워드</span><ArrowLeftRight size={14} /><span><BookOpen size={15} />콘텐츠</span></div></div>}</aside>
    </div>

    <section className="keyword-history"><button type="button" className="keyword-history-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}><History size={17} /><strong>검색·수집 이력</strong><span>최근 불러온 {runs.length}건</span><ChevronRight size={16} className={historyOpen ? "expanded" : ""} /></button>{historyOpen && <div className="keyword-history-body">{historyError && <p className="keyword-inline-error" role="alert">{historyError}</p>}{runs.length ? runs.map((run) => <details className="keyword-history-run" key={run.id}><summary><span><strong>{run.query || "전체 검색"}</strong><small>{sourceNames[run.source]} · {date(run.searchedAt)}</small></span><span>{run.resultCount}개 발견</span></summary><p>아래 숫자는 이 앱이 수집·정렬한 출처별 결과 순서입니다.</p>{run.results.map((item, index) => <div className="keyword-history-result" key={`${item.url}-${index}`}><span>{sourceNames[item.source] ?? item.source} · 결과 {item.rank}번째</span><External url={sourceUrl(item.url)}>{item.title}<ArrowUpRight size={12} /></External></div>)}<button type="button" className="keyword-text-action" disabled={locked || loading || !dbReady} onClick={() => { setQuery(run.query); setMode("local"); setSource(run.source); void search({ query: run.query, source: run.source, mode: "local", limit: PAGE_SIZE, offset: 0 }); }}><Search size={13} />이 검색어로 저장 자료 찾기</button></details>) : <p className="keyword-history-none">아직 저장한 검색·수집 이력이 없습니다.</p>}</div>}</section>
    <div className="keyword-local-footnote"><ShieldCheck size={17} /><p>이 앱의 결과 순서는 검색 엔진의 순위나 유입 순위를 의미하지 않습니다. 추출 단어와 실제 검색어를 구분하며, Threads·TikTok·Instagram의 실시간 검색 결과는 현재 수집하지 않습니다.</p><span><Clock3 size={13} />한국 시간</span></div>
  </div>;
}
