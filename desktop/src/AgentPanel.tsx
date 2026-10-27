import { listen } from "@tauri-apps/api/event";
import { Database, FolderGit2, LoaderCircle, Play, RefreshCw, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nativeInvoke } from "./ai-client";
import { AgentRunView } from "./AgentRunView";
import { AgentSettingsCard } from "./AgentSettingsCard";
import { PHASE_LABELS, agentCall, applyEvent, bufferEarlyEvent, loadPanel, type IndexEvent, type IndexStatus, type ProjectInfo, type RunEvent, type RunSummary, type RuntimeStatus, type SettingsView } from "./agent-client";
import "./AgentPanel.css";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function AgentPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [project, setProject] = useState("");
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [indexing, setIndexing] = useState<IndexEvent | null>(null);
  const [task, setTask] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loaded = useRef(false);
  // Events can arrive before run.start returns; keep them until the run is known.
  // Both refs change synchronously in the listener, never inside a state updater.
  const early = useRef(new Map<string, RunEvent[]>());
  const known = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    setError("");
    const data = await loadPanel(nativeInvoke);
    setStatus(data.status); setView(data.settings); setProjects(data.projects);
    for (const r of data.runs) known.current.add(r.runId);
    setRuns(old => data.runs.map(r => old.find(o => o.runId === r.runId) ?? r));
    setError(data.errors.join(" · "));
  }, []);

  useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    void refresh();
  }, [active, refresh]);

  useEffect(() => {
    let live = true, stop: (() => void) | undefined;
    void listen<RunEvent | IndexEvent | { event: "runtime"; state: string }>("agent-event", ({ payload }) => {
      if (payload.event === "run") {
        if (!known.current.has(payload.runId)) {
          bufferEarlyEvent(early.current, payload);
          return;
        }
        setRuns(list => list.map(r => applyEvent(r, payload) ?? r));
      }
      else if (payload.event === "index") {
        setIndexing(payload.phase === "done" || payload.phase === "failed" ? null : payload);
        if (payload.phase === "done") { setNotice(`색인 완료: ${payload.message}`); void agentCall<IndexStatus>("index.status", { project: payload.project }).then(setIndex).catch(() => {}); }
        if (payload.phase === "failed") setError(`색인 실패: ${payload.message}`);
      }
    }, { target: { kind: "WebviewWindow", label: "main" } }).then(fn => { if (live) stop = fn; else fn(); }).catch(() => {});
    return () => { live = false; stop?.(); };
  }, []);

  useEffect(() => {
    setIndex(null);
    if (!project) return;
    void agentCall<IndexStatus>("index.status", { project }).then(setIndex).catch(e => setError(message(e)));
  }, [project]);

  async function act(label: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError(""); setNotice("");
    try { await task(); } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  const startVector = () => act("vector", async () => { await nativeInvoke("vector_db_start"); await refresh(); setNotice("로컬 ChromaDB가 준비되었습니다."); });
  const buildIndex = () => act("index", async () => { await agentCall("index.build", { project }); setIndexing({ event: "index", project, phase: "scanning", done: 0, total: 0, message: "색인을 시작했습니다." }); });
  const start = () => act("start", async () => {
    const started = await agentCall<RunSummary>("run.start", { project, task });
    const buffered = early.current.get(started.runId) ?? [];
    early.current.delete(started.runId);
    known.current.add(started.runId);
    const run = buffered.reduce<RunSummary>((acc, event) => applyEvent(acc, event) ?? acc, started);
    setRuns(list => [run, ...list.filter(r => r.runId !== run.runId)]); setCurrent(run.runId); setTask("");
  });
  const decide = (decision: "approve" | "reject", feedback: string) => act("decide", async () => {
    const run = runs.find(r => r.runId === current);
    if (!run?.pending) return;
    const next = await agentCall<RunSummary>("run.resume", { runId: run.runId, actionId: run.pending.id, decision, feedback });
    setRuns(list => list.map(r => (r.runId === next.runId ? { ...next, events: r.events.length >= next.events.length ? r.events : next.events } : r)));
  });
  const cancel = () => act("cancel", async () => { if (current) { const next = await agentCall<RunSummary>("run.cancel", { runId: current }); setRuns(list => list.map(r => (r.runId === next.runId ? next : r))); } });
  const openRun = (runId: string) => act("open", async () => { const full = await agentCall<RunSummary>("run.get", { runId }); setRuns(list => list.map(r => (r.runId === runId ? full : r))); setCurrent(runId); });

  const visible = useMemo(() => projects.filter(p => `${p.name} ${p.stacks.join(" ")}`.toLowerCase().includes(filter.toLowerCase())), [projects, filter]);
  const selected = projects.find(p => p.name === project);
  const run = runs.find(r => r.runId === current);
  const agentReady = Boolean(view?.settings.agentModel && status?.providers.find(p => p.id === view.settings.agentModel?.provider)?.available);
  if (!active) return null;

  return <div className="agent-panel" aria-label="Agent 작업실">
    <div className="agent-status-bar">
      <span className={status ? "agent-ok" : "agent-muted"}><Sparkles size={14} />런타임 {status ? `v${status.version}` : "확인 중"}</span>
      <span className={status?.chroma ? "agent-ok" : "agent-warn"}><Database size={14} />ChromaDB {status?.chroma ? "연결됨" : "꺼짐"}</span>
      {!status?.chroma && <button className="social-button compact" disabled={Boolean(busy)} onClick={() => void startVector()}>{busy === "vector" ? <LoaderCircle size={14} className="social-spin" /> : <Play size={14} />}벡터 DB 실행</button>}
      <span className="agent-muted">{status?.providers.filter(p => p.available).map(p => p.label).join(" · ") || "사용 가능한 모델 없음"}</span>
      <button className="social-button subtle icon-only" aria-label="새로고침" onClick={() => void refresh()}><RefreshCw size={15} /></button>
    </div>
    {error && <div className="social-notice error" role="alert"><span>{error}</span></div>}
    {notice && <div className="social-notice success" role="status"><span>{notice}</span></div>}

    <div className="agent-layout">
      <div className="agent-column">
        <section className="agent-card" aria-label="프로젝트">
          <div className="agent-card-head"><h2><FolderGit2 size={17} />프로젝트</h2><small>{status?.projectsRoot}</small></div>
          <label className="agent-search"><Search size={14} /><input placeholder="이름·스택 검색" value={filter} onChange={e => setFilter(e.target.value)} aria-label="프로젝트 검색" /></label>
          <ul className="agent-projects" role="listbox" aria-label="프로젝트 목록">
            {visible.map(p => <li key={p.name} role="option" aria-selected={p.name === project}><button onClick={() => setProject(p.name)}><strong>{p.name}</strong><small>{p.stacks.join(" · ") || "기타"}</small></button></li>)}
          </ul>
          {selected && <div className="agent-index">
            <p>{index ? index.stale ? "임베딩 설정이 바뀌어 다시 색인해야 합니다." : index.indexed ? `색인됨 · 청크 ${index.chunks}개` : index.chroma ? "아직 색인하지 않았습니다." : "ChromaDB가 꺼져 있습니다." : "색인 상태 확인 중"}</p>
            {indexing?.project === project ? <div className="agent-progress small" role="progressbar" aria-valuenow={indexing.total ? Math.round(indexing.done / indexing.total * 100) : 0}><span style={{ width: `${indexing.total ? indexing.done / indexing.total * 100 : 5}%` }} /><b>{indexing.message}</b></div>
              : <button className="social-button compact" disabled={!index?.chroma || Boolean(busy)} onClick={() => void buildIndex()}><Database size={14} />{index?.indexed ? "변경분 다시 색인" : "코드 색인 만들기"}</button>}
          </div>}
        </section>

        <section className="agent-card" aria-label="작업 지시">
          <h2>작업 지시</h2>
          <textarea rows={5} maxLength={20000} value={task} onChange={e => setTask(e.target.value)} placeholder={selected ? `${selected.name}에서 할 일을 적어주세요. 예: 로그인 버튼 비활성 상태 스타일을 고치고 타입 검사를 통과시켜줘.` : "먼저 프로젝트를 선택하세요."} aria-label="에이전트 작업 지시" disabled={!selected} />
          {!agentReady && <p className="agent-warn">위 모델 설정에서 에이전트 모델을 선택하고 저장하세요.</p>}
          <button className="social-button primary" disabled={!selected || !task.trim() || !agentReady || Boolean(busy)} onClick={() => void start()}>{busy === "start" ? <LoaderCircle size={15} className="social-spin" /> : <Play size={15} />}에이전트 시작</button>
          <p className="agent-hint">파일 쓰기와 명령 실행은 매번 승인을 받습니다. 빌드·테스트·린트 명령만 실행할 수 있고 설치·배포 명령은 거부됩니다.</p>
        </section>

        {runs.length > 0 && <section className="agent-card" aria-label="작업 기록"><h2>작업 기록</h2>
          <ul className="agent-history">{runs.map(r => <li key={r.runId}><button className={r.runId === current ? "active" : ""} onClick={() => void openRun(r.runId)}><strong>{r.project}</strong><span>{r.task.slice(0, 60)}</span><small data-phase={r.phase}>{PHASE_LABELS[r.phase]}</small></button></li>)}</ul>
          <p className="agent-hint">기록은 앱을 꺼도 최근 30개까지 남습니다.</p>
        </section>}
      </div>

      <div className="agent-column wide">
        {run ? <AgentRunView run={run} busy={Boolean(busy)} onDecide={decide} onCancel={() => void cancel()} />
          : <section className="agent-card agent-empty"><h2>에이전트 작업 보드</h2><p>프로젝트를 고르고 작업을 지시하면 Supervisor가 Frontend 또는 Backend Expert에게 배정합니다. 코드가 바뀌면 QA Reviewer가 빌드·테스트로 확인하고, 실패하면 Expert에게 돌려보냅니다.</p></section>}
        {view && status && <AgentSettingsCard view={view} providers={status.providers} busy={Boolean(busy)} onError={setError} onSaved={next => { setView(next); setNotice("모델 설정을 저장했습니다."); void refresh(); }} />}
      </div>
    </div>
  </div>;
}
