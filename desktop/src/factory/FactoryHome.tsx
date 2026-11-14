import { LoaderCircle, Play, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { PHASE_LABELS, type RunSummary } from "../agent-client";
import { AssetReview } from "./AssetReview";
import { BuildReview } from "./BuildReview";
import { FactoryProject } from "./FactoryProject";
import { FactoryRun } from "./FactoryRun";
import { factoryCancel, factoryDecide, factoryJobs, factoryPreview, factoryRuns, factoryStart, factoryStatus, parseFactoryReport, type FactoryJobView, type FactoryReport } from "./factory-client";
import "./Factory.css";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function FactoryHome({ active, onOpenAgent }: { active: boolean; onOpenAgent: () => void }) {
  const [brief, setBrief] = useState("도트풍 무협 로그라이트 게임 만들어줘. 16:9 가로 Android, 한 캐릭터, 세 적, 공격/회피/경험치/게임오버.");
  const [kind, setKind] = useState<"game" | "app">("game");
  const [view, setView] = useState<"2d" | "3d" | "ui">("2d");
  const [orientation, setOrientation] = useState<"landscape" | "portrait">("landscape");
  const [preview, setPreview] = useState<FactoryReport | null>(null);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [jobs, setJobs] = useState<FactoryJobView[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    let live = true;
    const refresh = () => void factoryRuns().then(list => {
      if (!live) return;
      setRuns(list);
      setRun(current => current ?? list[0] ?? null);
    }).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [active]);

  useEffect(() => {
    if (!active || !run?.runId) return;
    let live = true;
    void factoryStatus(run.runId).then(next => { if (live) setRun(next); }).catch(cause => { if (live) setError(messageOf(cause)); });
    return () => { live = false; };
  }, [active, run?.runId]);

  useEffect(() => {
    if (!active || !run || run.phase === "done" || run.phase === "failed" || run.phase === "cancelled") return;
    const timer = setInterval(() => {
      void factoryStatus(run.runId).then(setRun).catch(cause => setError(messageOf(cause)));
      void factoryJobs().then(data => setJobs(data.jobs)).catch(() => {});
    }, 1200);
    return () => clearInterval(timer);
  }, [active, run]);

  if (!active) return null;
  const report = run?.summary ? parseFactoryReport(run.summary) : preview;
  const request = { brief, kind, view: kind === "app" ? "ui" as const : view, orientation };

  async function act(label: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError("");
    try { await task(); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(""); }
  }

  return <div className="factory-layout" role="region" aria-label="앱·게임 팩토리">
    {error && <div className="social-notice error" role="alert"><span>{error}</span></div>}
    {runs.length > 0 && <section className="factory-card" aria-label="팩토리 작업 목록">
      <h2>팩토리 작업</h2>
      <p>휴대폰에서 시작한 작업도 여기에서 열어 승인과 진행 상태를 확인할 수 있습니다.</p>
      <ul className="factory-list">{runs.map(item => <li key={item.runId}>
        <button type="button" className="social-button compact" aria-pressed={run?.runId === item.runId} onClick={() => void act("open", async () => setRun(await factoryStatus(item.runId)))}>
          {PHASE_LABELS[item.phase]} · {item.runId}
        </button>
      </li>)}</ul>
    </section>}
    <div className="factory-grid">
      <form className="factory-card" onSubmit={event => { event.preventDefault(); void act("start", async () => { const started = await factoryStart(request); setRun(started); }); }}>
        <h2>무엇을 만들까요?</h2>
        <label>요청<textarea rows={5} maxLength={2000} value={brief} onChange={event => setBrief(event.target.value)} required aria-label="제작 요청" /></label>
        <label>종류<select value={kind} onChange={event => setKind(event.target.value === "app" ? "app" : "game")} aria-label="제작 종류"><option value="game">Android 게임</option><option value="app">Android 앱</option></select></label>
        <label>화면<select value={kind === "app" ? "ui" : view} disabled={kind === "app"} onChange={event => setView(event.target.value === "3d" ? "3d" : "2d")} aria-label="화면 형식"><option value="2d">2D</option><option value="3d">3D</option><option value="ui">UI</option></select></label>
        <label>방향<select value={orientation} onChange={event => setOrientation(event.target.value === "portrait" ? "portrait" : "landscape")} aria-label="화면 방향"><option value="landscape">가로</option><option value="portrait">세로</option></select></label>
        <div className="factory-actions">
          <button type="button" className="social-button" disabled={Boolean(busy) || !brief.trim()} onClick={() => void act("preview", async () => setPreview(await factoryPreview(request)))}>{busy === "preview" ? <LoaderCircle size={15} className="social-spin" /> : <Sparkles size={15} />}명세 미리보기</button>
          <button type="submit" className="social-button primary" disabled={Boolean(busy) || !brief.trim()}>{busy === "start" ? <LoaderCircle size={15} className="social-spin" /> : <Play size={15} />}팩토리 시작</button>
          <button type="button" className="social-button" onClick={onOpenAgent}>모델 설정</button>
        </div>
        <p>미리보기는 규칙으로 만든 명세입니다. 시작 후 Agent 모델의 JSON이 검사를 통과하면 그 명세를 쓰고, 아니면 템플릿이라고 표시합니다. 유료 API, 기기 설치, 서명, 스토어 제출은 자동으로 하지 않습니다.</p>
      </form>
      {report?.spec && <FactoryProject spec={report.spec} jobs={report.jobs.length ? report.jobs : jobs} notes={report.notes} />}
    </div>
    {run && <FactoryRun run={run} busy={Boolean(busy)} onCancel={() => void act("cancel", async () => setRun(await factoryCancel(run.runId)))} onDecide={(action, decision, feedback) => void act("decide", async () => setRun(await factoryDecide(run.runId, action, decision, feedback)))} />}
    {(report || jobs.length > 0) && <div className="factory-grid"><AssetReview jobs={report?.jobs.length ? report.jobs : jobs} />{report && <BuildReview report={report} />}</div>}
    </div>;
}
