import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, Check, ChevronRight, CircleAlert, Clock3, Database, ExternalLink, Globe2, History, LoaderCircle, RefreshCw, Search, Settings2, ShieldCheck, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { External } from "./External";
import type { OpalRun, OpalStatus } from "./types";

const OPAL_HOME = "https://opal.google/";
const OPAL_FAQ = "https://developers.google.com/opal/faq";
const platformLabels: Record<string, string> = {
  youtube: "YouTube", threads: "Threads", naver_blog: "네이버 블로그",
  tiktok: "TikTok", instagram: "Instagram"
};
type Notice = { tone: "success" | "error"; text: string };
type Props = { active?: boolean; databaseConnected?: boolean; onOpenSettings?: () => void };

function failure(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Opal 탐색을 처리하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.";
}
function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "일시 확인 필요" : new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(parsed);
}
function sourceUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
function sourceHost(value: string) {
  try { return new URL(value).hostname; } catch { return "출처 주소 확인 필요"; }
}
function validWorkflow(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["opal.google", "opal.google.com", "opal.withgoogle.com"].includes(url.hostname)
      && !url.username && !url.password && (!url.port || url.port === "443");
  } catch { return false; }
}

export function OpalPanel({ active = true, databaseConnected = true, onOpenSettings }: Props) {
  const [status, setStatus] = useState<OpalStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [runs, setRuns] = useState<OpalRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [workflowUrl, setWorkflowUrl] = useState("");
  const [asidePath, setAsidePath] = useState("");
  const [account, setAccount] = useState("u0");
  const [setupOpen, setSetupOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"configure" | "run" | "open" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const mounted = useRef(true);
  const queryVersion = useRef(0);
  const configDirty = useRef(false);
  const initialConfigLoaded = useRef(false);
  const topicField = useRef<HTMLTextAreaElement>(null);
  const workflowField = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const running = busy === "run" || status?.runActive === true;
  const locked = busy !== null || running;
  const selectedRun = runs.find((run) => run.id === selectedId) ?? null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; queryVersion.current += 1; };
  }, []);

  const refresh = useCallback(async () => {
    const version = ++queryVersion.current;
    setLoading(true);
    const [statusResult, historyResult] = await Promise.allSettled([
      invoke<OpalStatus>("get_opal_status"), invoke<OpalRun[]>("get_opal_runs")
    ]);
    if (!mounted.current || version !== queryVersion.current) return;
    if (statusResult.status === "fulfilled") {
      const next = statusResult.value;
      setStatus(next); setStatusError("");
      if (!configDirty.current) {
        setWorkflowUrl(next.workflowUrl ?? ""); setAccount(next.account);
      }
      if (!initialConfigLoaded.current) {
        setSetupOpen(!next.workflowUrl || !next.cliAvailable);
        initialConfigLoaded.current = true;
      }
    } else { setStatusError(failure(statusResult.reason)); }
    if (historyResult.status === "fulfilled") {
      const next = [...historyResult.value].sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt));
      setRuns(next); setHistoryError("");
      setSelectedId((current) => current && next.some((run) => run.id === current) ? current : next[0]?.id ?? null);
    } else { setHistoryError(failure(historyResult.reason)); }
    setLoading(false);
  }, []);

  useEffect(() => { if (active) void refresh(); }, [active, refresh]);
  useEffect(() => {
    if (!active || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => void poll(), 2500);
    };
    timer = setTimeout(() => void poll(), 2500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, running, refresh]);

  useEffect(() => {
    if (notice && active) feedback.current?.focus({ preventScroll: true });
  }, [notice, active]);

  async function configure(event: FormEvent) {
    event.preventDefault();
    if (locked) return;
    const url = workflowUrl.trim();
    if (!validWorkflow(url)) {
      setNotice({ tone: "error", text: "Opal에서 만든 워크플로의 HTTPS 주소를 입력하세요. opal.google, opal.google.com, opal.withgoogle.com 주소를 사용할 수 있습니다." });
      workflowField.current?.focus(); return;
    }
    if (!/^u(?:[0-9]|[1-9][0-9])$/.test(account.trim())) {
      setNotice({ tone: "error", text: "Aside 계정은 u0부터 u99까지의 계정 ID를 입력하세요." }); return;
    }
    setBusy("configure"); setNotice(null); queryVersion.current += 1;
    try {
      const next = await invoke<OpalStatus>("configure_opal", { input: {
        workflowUrl: url, account: account.trim(), ...(asidePath.trim() ? { asidePath: asidePath.trim() } : {})
      } });
      if (!mounted.current) return;
      queryVersion.current += 1;
      configDirty.current = false;
      setStatus(next); setStatusError(""); setWorkflowUrl(next.workflowUrl ?? ""); setAccount(next.account); setAsidePath("");
      setNotice({ tone: "success", text: next.available ? "Opal 연결 설정을 저장했습니다. 주제를 입력해 키워드 탐색을 시작하세요." : `Opal 연결 설정을 저장했습니다. ${next.reason ?? "실행 환경을 확인하세요."}` });
      if (next.available) setSetupOpen(false);
    } catch (error) {
      if (mounted.current) setNotice({ tone: "error", text: failure(error) });
    } finally { if (mounted.current) { setBusy(null); setLoading(false); } }
  }

  async function research(event: FormEvent) {
    event.preventDefault();
    if (locked || !status?.available || statusError || !databaseConnected) return;
    if (!topic.trim()) {
      setNotice({ tone: "error", text: "탐색할 주제를 입력하세요. 예: AI 생산성, K-POP 숏폼, 서울 주말 여행" });
      topicField.current?.focus(); return;
    }
    if (/[\u0000-\u001f\u007f]/.test(topic.trim())) {
      setNotice({ tone: "error", text: "관심 주제는 줄바꿈 없이 한 줄로 입력하세요." });
      topicField.current?.focus(); return;
    }
    setBusy("run"); setNotice(null);
    try {
      const result = await invoke<OpalRun>("run_opal_research", { input: { topic: topic.trim(), lookbackDays: 7 } });
      if (!mounted.current) return;
      setRuns((current) => [result, ...current.filter((run) => run.id !== result.id)]);
      setSelectedId(result.id); setHistoryError("");
      setNotice({ tone: "success", text: `${result.keywords.length}개 키워드와 출처를 확인하고 탐색 결과를 로컬 DB에 저장했습니다.` });
    } catch (error) {
      if (mounted.current) setNotice({ tone: "error", text: failure(error) });
    } finally {
      if (mounted.current) { await refresh(); setBusy(null); }
    }
  }

  async function openWorkflow() {
    if (locked) return;
    setBusy("open"); setNotice(null);
    try {
      await invoke("open_external", { url: status?.workflowUrl ?? OPAL_HOME, browser: "aside" });
      if (mounted.current) setNotice({ tone: "success", text: "Opal을 브라우저에서 열었습니다. 탐색에 사용할 Google 계정으로 로그인하세요." });
    } catch (error) {
      if (mounted.current) setNotice({ tone: "error", text: failure(error) });
    } finally { if (mounted.current) setBusy(null); }
  }

  return <div className="desktop-opal">
    <section className="desktop-opal-connection" aria-label="Opal 연결 상태">
      <div className="desktop-opal-connection-title"><span className="desktop-opal-mark" aria-hidden="true"><Sparkles size={23} /></span><div><strong>Google Labs · Opal</strong><p>탐색은 Google Opal에서 실행하고 결과는 로컬 DB에 저장합니다.</p></div><span className={`desktop-opal-state${status?.available && !statusError ? " ready" : ""}`}>{statusError ? "연결 확인 필요" : status === null ? "확인 중" : running ? "탐색 진행 중" : status.available ? "탐색 준비됨" : "설정 필요"}</span></div>
      <div className="desktop-opal-connection-footer"><div><span>{status?.cliAvailable ? <Check size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}{status === null ? "Aside 확인 중" : status.cliAvailable ? "Aside CLI 확인됨" : "Aside CLI 필요"}</span><span><ExternalLink size={13} aria-hidden="true" />{status?.workflowUrl ? "워크플로 저장됨" : "워크플로 미등록"}</span></div><button type="button" className="social-button compact subtle" disabled={loading || busy === "configure"} onClick={() => void refresh()}><RefreshIcon spinning={loading} />상태 새로고침</button></div>
    </section>

    {statusError && <div className="social-notice error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{statusError}</span></div>}
    {notice && <div ref={feedback} tabIndex={-1} className={`social-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "success" ? <Check size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}<span>{notice.text}</span></div>}
    {!statusError && status?.reason && !status.available && <div className="desktop-opal-setup-hint"><CircleAlert size={16} aria-hidden="true" /><span>{status.reason}</span><button type="button" onClick={() => setSetupOpen(true)}>연결 설정 확인<ChevronRight size={14} aria-hidden="true" /></button></div>}

    <div className="desktop-opal-layout">
      <div className="desktop-opal-research-column">
        <form className="desktop-opal-research" onSubmit={research} noValidate aria-busy={running}>
          <div className="desktop-opal-section-title"><Search size={20} aria-hidden="true" /><div><h2>어떤 주제를 탐색할까요?</h2><p>지금 만드는 콘텐츠의 주제나 관심 분야를 입력하세요.</p></div></div>
          <label htmlFor="opal-topic">관심 주제</label><textarea ref={topicField} id="opal-topic" rows={3} value={topic} maxLength={200} disabled={running} onChange={(event) => setTopic(event.target.value)} placeholder="예: AI 생산성, K-POP 숏폼, 서울 주말 여행" aria-describedby="opal-topic-help" />
          <div className="desktop-opal-scope" aria-label="탐색 범위"><span><Globe2 size={14} aria-hidden="true" />한국 · KR</span><span><Clock3 size={14} aria-hidden="true" />최근 7일</span><span><Database size={14} aria-hidden="true" />로컬 DB 저장</span></div>
          <p id="opal-topic-help" className="desktop-opal-privacy"><ShieldCheck size={14} aria-hidden="true" />입력한 주제와 탐색 범위를 Google Opal에 전달합니다.</p>
          {!databaseConnected && <div className="desktop-opal-db-hint"><span>결과를 저장하려면 로컬 DB를 연결하세요.</span>{onOpenSettings && <button type="button" onClick={onOpenSettings}>DB 연결 설정<ArrowUpRight size={14} aria-hidden="true" /></button>}</div>}
          <div className="desktop-opal-research-actions"><button type="button" className="social-button" disabled={locked} onClick={() => void openWorkflow()}><ExternalLink size={16} aria-hidden="true" />Opal에서 열기</button><button type="submit" className="social-button primary" disabled={locked || !status?.available || !!statusError || !databaseConnected}>{running ? <LoaderCircle size={17} className="social-spin" aria-hidden="true" /> : <Search size={17} aria-hidden="true" />}{running ? "탐색 중" : "키워드 탐색"}</button></div>
          {running && <div className="desktop-opal-progress" role="status"><LoaderCircle size={18} className="social-spin" aria-hidden="true" /><p>Aside에서 Opal 탐색을 진행하고 있습니다.<br /><span>결과를 확인하고 로컬 DB에 저장할 때까지 기다려주세요.</span></p></div>}
        </form>

        <details className="desktop-opal-configuration" open={setupOpen} onToggle={(event) => setSetupOpen(event.currentTarget.open)}>
          <summary><Settings2 size={16} aria-hidden="true" /><span>Opal 연결 설정</span><small>{status?.workflowUrl ? "저장된 워크플로 변경" : "처음 연결할 때 설정"}</small><ChevronRight size={15} aria-hidden="true" /></summary>
          <form onSubmit={configure} noValidate><p>Opal에서 만든 탐색 워크플로의 주소를 등록하세요. 로그인 세션은 Aside가 관리합니다.</p><label htmlFor="opal-workflow-url">탐색 워크플로 URL</label><input ref={workflowField} id="opal-workflow-url" type="url" value={workflowUrl} maxLength={2000} disabled={locked} onChange={(event) => { configDirty.current = true; setWorkflowUrl(event.target.value); }} placeholder="https://opal.google/…" spellCheck={false} autoComplete="off" /><div className="desktop-opal-config-grid"><div><label htmlFor="opal-aside-account">Aside 계정</label><input id="opal-aside-account" value={account} maxLength={3} disabled={locked} onChange={(event) => { configDirty.current = true; setAccount(event.target.value); }} placeholder="u0" autoComplete="off" spellCheck={false} /><small>u0부터 u99까지의 계정 ID</small></div><div><label htmlFor="opal-aside-path">Aside CLI 경로 <small>선택</small></label><input id="opal-aside-path" value={asidePath} maxLength={2000} disabled={locked} onChange={(event) => { configDirty.current = true; setAsidePath(event.target.value); }} placeholder="기존 경로 유지 또는 자동 찾기" spellCheck={false} autoComplete="off" /><small>비워 두면 저장된 실행 경로를 유지합니다.</small></div></div><div className="desktop-opal-config-actions"><button type="button" className="social-button" disabled={locked} onClick={() => void openWorkflow()}><ExternalLink size={14} aria-hidden="true" />Opal 열기</button><button type="submit" className="social-button" disabled={locked}>{busy === "configure" ? <LoaderCircle size={16} className="social-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{busy === "configure" ? "저장 중" : "연결 저장"}</button></div></form>
        </details>

        <section className="desktop-opal-results" aria-labelledby="opal-result-title"><div className="desktop-opal-result-heading"><div><h2 id="opal-result-title">{selectedRun ? selectedRun.topic : "탐색 결과"}</h2><p>{selectedRun ? `${date(selectedRun.generatedAt)} · 한국 · 최근 ${selectedRun.lookbackDays}일` : "출처가 있는 키워드와 플랫폼별 활용 방향을 확인하세요."}</p></div>{selectedRun && <span>{selectedRun.keywords.length}개 키워드</span>}</div>
          {selectedRun ? <><p className="desktop-opal-summary">{selectedRun.summary}</p><div className="desktop-opal-keywords">{selectedRun.keywords.map((keyword, index) => <article key={`${keyword.keyword}-${index}`} className="desktop-opal-keyword"><div className="desktop-opal-keyword-heading"><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><h3>{keyword.keyword}</h3></div><p>{keyword.rationale}</p><div className="desktop-opal-platforms" aria-label="활용 플랫폼">{keyword.platforms.map((platform, platformIndex) => <span key={`${platform}-${platformIndex}`}>{platformLabels[platform] ?? platform}</span>)}</div><div className="desktop-opal-sources"><strong>탐색 출처</strong>{keyword.sources.map((source, sourceIndex) => <div key={`${source.url}-${sourceIndex}`}><External url={sourceUrl(source.url)}><span>{source.title}</span><ArrowUpRight size={14} aria-hidden="true" /></External><small>{sourceHost(source.url)}{source.publishedAt && ` · ${date(source.publishedAt)}`}</small></div>)}</div></article>)}</div><p className="desktop-opal-result-note">출처 주소와 결과 형식을 확인한 탐색 결과입니다. 활용 전에 원문의 사실과 맥락을 확인하세요.</p></> : <div className="desktop-opal-empty"><Search size={29} aria-hidden="true" /><strong>{loading ? "저장된 탐색을 불러오는 중입니다" : "첫 키워드 탐색을 시작하세요"}</strong><p>관심 주제를 입력하면 키워드, 활용 플랫폼, 참고 출처가 이곳에 표시됩니다.</p></div>}
        </section>
      </div>

      <aside className="desktop-opal-history" aria-labelledby="opal-history-title"><div className="desktop-opal-history-heading"><h2 id="opal-history-title"><History size={17} aria-hidden="true" />탐색 이력</h2><span>{runs.length}회</span></div><p>로컬 DB에 저장된 최근 최대 30회 탐색을 표시합니다.</p>{historyError && <div className="desktop-opal-history-error" role="alert">{historyError}{runs.length > 0 && <span>이전 조회 결과가 표시됩니다.</span>}</div>}{runs.length > 0 ? <div className="desktop-opal-history-list" role="group" aria-label="저장된 탐색 선택">{runs.map((run) => <button type="button" key={run.id} className={selectedRun?.id === run.id ? "selected" : ""} aria-pressed={selectedRun?.id === run.id} onClick={() => setSelectedId(run.id)}><strong>{run.topic}</strong><time dateTime={run.generatedAt}>{date(run.generatedAt)}</time><span>{run.keywords.length}개 키워드<ChevronRight size={14} aria-hidden="true" /></span></button>)}</div> : <div className="desktop-opal-history-empty"><Database size={21} aria-hidden="true" /><span>{loading ? "이력 확인 중" : "아직 저장된 탐색이 없습니다."}</span></div>}</aside>
    </div>

    <div className="desktop-opal-service-note"><Clock3 size={17} aria-hidden="true" /><p>Google은 Opal 서비스를 2026년 11월 17일 종료할 예정입니다. 워크플로의 프롬프트를 미리 백업하세요. 저장된 탐색 결과는 로컬 DB에서 계속 확인할 수 있습니다.<External url={OPAL_FAQ}>Google 공식 안내<ArrowUpRight size={13} aria-hidden="true" /></External></p></div>
  </div>;
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return <RefreshCw size={14} className={spinning ? "social-spin" : ""} aria-hidden="true" />;
}
