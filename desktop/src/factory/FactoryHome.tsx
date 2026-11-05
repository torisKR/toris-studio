import { LoaderCircle, Play, Sparkles, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { RunSummary } from "../agent-client";
import { BuildReview } from "./BuildReview";
import { FactoryDag } from "./FactoryDag";
import { FactoryProject } from "./FactoryProject";
import { FactoryTaskDetail } from "./FactoryRun";
import { factoryCancel, factoryDecide, factoryJobs, factoryPreview, factoryStart, factoryStatus, parseFactoryReport, type FactoryJobView, type FactoryReport } from "./factory-client";
import "./Factory.css";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function FactoryHome({ active, onOpenAgent }: { active: boolean; onOpenAgent: () => void }) {
  const [brief, setBrief] = useState("도트풍 무협 로그라이트 게임 만들어줘. 16:9 가로 Android, 한 캐릭터, 세 적, 공격/회피/경험치/게임오버.");
  const [kind, setKind] = useState<"game" | "app">("game");
  const [view, setView] = useState<"2d" | "3d" | "ui">("2d");
  const [orientation, setOrientation] = useState<"landscape" | "portrait">("landscape");
  const [preview, setPreview] = useState<FactoryReport | null>(null);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [jobs, setJobs] = useState<FactoryJobView[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active || !run || run.phase === "done" || run.phase === "failed" || run.phase === "cancelled") return;
    const timer = setInterval(() => {
      void factoryStatus(run.runId).then(setRun).catch(cause => setError(messageOf(cause)));
      void factoryJobs().then(data => setJobs(data.jobs)).catch(() => {});
    }, 1200);
    return () => clearInterval(timer);
  }, [active, run]);

  if (!active) return null;
  const parsed = run?.summary ? parseFactoryReport(run.summary) : null;
  const report = parsed ?? preview;
  const board = report?.jobs.length ? report.jobs : jobs;
  const selectedJob = board.find(job => job.taskId === selected) ?? null;
  const request = { brief, kind, view: kind === "app" ? "ui" as const : view, orientation };
  const waiting = run?.approvals.find(action => action.kind === "factory_gate" && action.title === selected) ?? null;

  async function act(label: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError("");
    try { await task(); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(""); }
  }

  return <div className="factory-layout" role="region" aria-label="앱·게임 팩토리">
    {error && <div className="social-notice error" role="alert"><span>{error}</span></div>}
    <div className="factory-console">
      <form className="factory-card" onSubmit={event => { event.preventDefault(); void act("start", async () => { const started = await factoryStart(request); setRun(started); }); }}>
        <h2>요청</h2>
        <label>요청<textarea rows={5} maxLength={2000} value={brief} onChange={event => setBrief(event.target.value)} required aria-label="제작 요청" /></label>
        <label>종류<select value={kind} onChange={event => setKind(event.target.value === "app" ? "app" : "game")} aria-label="제작 종류"><option value="game">Android 게임</option><option value="app">Android 앱</option></select></label>
        <label>화면<select value={kind === "app" ? "ui" : view} disabled={kind === "app"} onChange={event => setView(event.target.value === "3d" ? "3d" : "2d")} aria-label="화면 형식"><option value="2d">2D</option><option value="3d">3D</option><option value="ui">UI</option></select></label>
        <label>방향<select value={orientation} onChange={event => setOrientation(event.target.value === "portrait" ? "portrait" : "landscape")} aria-label="화면 방향"><option value="landscape">가로</option><option value="portrait">세로</option></select></label>
        <div className="factory-actions">
          <button type="button" className="social-button" disabled={Boolean(busy) || !brief.trim()} onClick={() => void act("preview", async () => setPreview(await factoryPreview(request)))}>{busy === "preview" ? <LoaderCircle size={15} className="social-spin" /> : <Sparkles size={15} />}명세 미리보기</button>
          <button type="submit" className="social-button primary" disabled={Boolean(busy) || !brief.trim()}>{busy === "start" ? <LoaderCircle size={15} className="social-spin" /> : <Play size={15} />}팩토리 시작</button>
          <button type="button" className="social-button" onClick={onOpenAgent}>모델 설정</button>
        </div>
        <p className="factory-note">미리보기는 규칙으로 만든 명세입니다. 시작 후 Agent 모델의 JSON이 검사를 통과하면 그 명세를 쓰고, 아니면 템플릿이라고 표시합니다. 유료 API, 기기 설치, 서명, 스토어 제출은 자동으로 하지 않습니다.</p>
        {report?.spec && <FactoryProject spec={report.spec} notes={report.notes} />}
      </form>
      <section className="factory-card" aria-label="작업 DAG">
        <div className="factory-actions">
          <h2>작업</h2>
          {run && run.phase !== "done" && run.phase !== "failed" && run.phase !== "cancelled" && <button type="button" className="social-button" disabled={Boolean(busy)} onClick={() => void act("cancel", async () => setRun(await factoryCancel(run.runId)))}><Square size={14} />중단</button>}
        </div>
        <div className="factory-dag-wrap"><FactoryDag jobs={board} selected={selected} onSelect={setSelected} /></div>
        <FactoryTaskDetail job={selectedJob} action={waiting} busy={Boolean(busy)} onDecide={(action, decision, feedback) => void act("decide", async () => { if (!run) return; setRun(await factoryDecide(run.runId, action, decision, feedback)); })} />
        {run && <WaitingTasks run={run} selected={selected} onSelect={setSelected} />}
      </section>
      <section className="factory-card" aria-label="검증 게이트">
        {report ? <BuildReview report={report} /> : <div><h2>검증</h2><p className="factory-empty">실행하지 않은 Android·에셋 검사는 통과로 표시하지 않습니다.</p></div>}
      </section>
    </div>
  </div>;
}

function WaitingTasks({ run, selected, onSelect }: { run: RunSummary; selected: string; onSelect: (taskId: string) => void }) {
  const others = run.approvals.flatMap(action => action.kind === "factory_gate" && action.title !== selected ? [action] : []);
  if (!others.length) return null;
  return <div className="factory-actions">
    {others.map(action => <button key={action.id} type="button" className="social-button" onClick={() => onSelect(action.title)}>승인 대기 · {action.title}</button>)}
  </div>;
}
