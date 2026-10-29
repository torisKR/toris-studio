import { listen } from "@tauri-apps/api/event";
import {
  Check, CircleAlert, Clapperboard, Download, ExternalLink, History, ImageIcon, LoaderCircle, Mic, Pause, PencilLine, Play, Plus, RefreshCw, Search, Send, Square, WandSparkles, X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import { VOICE_SPEAKERS } from "../../../lib/video/voice-options";
import {
  mediaSrc, productionApi, STAGES,
  CAMERAS, type Camera, type EngineInfo, type EngineStatus, type ImageCandidate, type ProductionEvent, type ProductionJob, type ProductionJobSummary, type StageId, type StageStatus, type Storyboard, type StoryboardScene
} from "./production-client";
import {
  ASPECTS, ASSET_STATUS_LABELS, BGMS, CAMERA_LABELS, composerInput, LAYOUTS, VISUALS, composerProblem, CUSTOM_MAX, CUSTOM_MIN, DURATION_PRESETS, durationOf, errorMessage,
  generationSize, initialComposer, JOB_STATUS_LABELS, outputSize, PROMPT_MAX, QUALITIES, sceneCount, shortDate, sizeText, storyboardProblem, STYLES, SUBTITLES, usableEngine,
  type ComposerState
} from "./production-model";
import "./ProductionStudio.css";

type Props = { active: boolean; onOpenSettings?: () => void; onEditInEditor?: (project: Record<string, unknown>) => void };
type Notice = { text: string; tone: "success" | "error" | "info" };
const POLL_MS = 1200;
const live = (job: ProductionJob | null) => !!job && (job.status === "planning" || job.status === "running");

/** Explicit label/control pair: a wrapping label would fold the selected option into the accessible name. */
function Field({ id, label, hint, className, children }: { id: string; label: string; hint?: ReactElement; className?: string; children: (id: string) => ReactElement }) {
  return <div className={"production-field" + (className ? " " + className : "")}><label htmlFor={id}>{label}{hint && <> {hint}</>}</label>{children(id)}</div>;
}

/** Stage state as the user should read it: the storyboard waits for approval, and a finished job marks "완료". */
function shownStatus(job: ProductionJob, id: StageId, status: StageStatus): StageStatus {
  if (id === "storyboard" && job.status === "awaiting_approval") return "waiting";
  if (id === "done" && job.status === "done") return "done";
  if (job.status === "failed" && job.error?.stage === id && status !== "done") return "failed";
  return status;
}

function EngineCard({ engine, busy, onInstall }: { engine: EngineInfo; busy: boolean; onInstall: () => void }) {
  const install = engine.install;
  const running = install?.phase === "running";
  return <div className="production-engine-card" role="group" aria-label="영상 엔진 설치 필요">
    <div>
      <strong>{engine.label} 설치가 필요합니다</strong>
      <p>
        {engine.sizeGb != null && <>내려받기 약 {engine.sizeGb}GB · </>}
        {engine.memoryGb != null && <>메모리 {engine.memoryGb}GB 사용 · </>}
        라이선스 {engine.license}{engine.commercialUse ? " · 상업적 이용 가능" : ""}
      </p>
      {running && <div className="production-install-progress" role="status">
        <span>{install?.step || "설치 중"}{install?.total ? " · " + (install.done ?? 0) + "/" + install.total : ""}</span>
        {install?.total ? <progress max={install.total} value={install.done ?? 0} aria-label="엔진 설치 진행" /> : <progress aria-label="엔진 설치 진행" />}
      </div>}
      {install?.phase === "failed" && <p className="production-error-text" role="alert">{install.error ?? "엔진을 설치하지 못했습니다."}</p>}
    </div>
    <button type="button" className="social-button" disabled={busy || running} onClick={onInstall}>
      {running || busy ? <LoaderCircle size={16} className="social-spin" /> : <Download size={16} />}{running ? "설치 중" : install?.phase === "failed" ? "다시 설치" : "엔진 설치"}
    </button>
  </div>;
}

function Composer({ state, setState, engines, engineError, busy, onCreate, onInstall, onRetryEngines, onOpenSettings }: {
  state: ComposerState; setState: (update: (state: ComposerState) => ComposerState) => void; engines: EngineStatus | null; engineError: string;
  busy: string | null; onCreate: () => void; onInstall: (engine: string) => void; onRetryEngines: () => void; onOpenSettings?: () => void;
}) {
  const patch = (value: Partial<ComposerState>) => setState(current => ({ ...current, ...value }));
  const problem = composerProblem(state, engines);
  const engine = engines?.engines.find(item => item.id === state.engine);
  const seconds = durationOf(state);
  const generation = generationSize(state.aspect, state.quality);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem && !busy) onCreate(); };
  return <form className="production-composer" onSubmit={submit} aria-label="AI 영상 기획">
    <div className="production-topic">
      <label htmlFor="production-topic">영상 주제</label>
      <textarea id="production-topic" rows={3} maxLength={300} value={state.topic} aria-describedby="production-topic-hint" placeholder="예: 2050년 미래 서울을 보여주는 30초 시네마틱 쇼츠" onChange={event => patch({ topic: event.target.value })} />
      <small id="production-topic-hint">주제 한 줄이면 기획, 스토리보드, 장면 영상, 나레이션, 자막, 편집까지 이어서 만듭니다. 장면을 만들기 전에 스토리보드를 먼저 확인합니다.</small>
    </div>
    <fieldset className="production-chips production-visual"><legend>장면 소스</legend>
      {Object.entries(VISUALS).map(([value, label]) => <label key={value}><input type="radio" name="production-visual" checked={state.visual === value} onChange={() => patch({ visual: value as ComposerState["visual"] })} />{label}</label>)}
      <small>{state.visual === "stock"
        ? "주제에 맞는 사진을 Openverse·Wikimedia Commons에서 찾습니다. CC0·퍼블릭 도메인·CC BY만 쓰고 뉴스·방송 화면은 뺍니다. 출처는 영상과 게시글에 자동으로 넣습니다."
        : "이 Mac에서 Wan2.1로 장면 영상을 직접 만듭니다. 장면 하나에 약 3분 걸립니다."}</small>
    </fieldset>
    <div className="production-options">
      <fieldset className="production-chips"><legend>길이</legend>
        {DURATION_PRESETS.map(value => <label key={value}><input type="radio" name="production-duration" checked={state.duration === value} onChange={() => patch({ duration: value })} />{value}초</label>)}
        <label><input type="radio" name="production-duration" checked={state.duration === "custom"} onChange={() => patch({ duration: "custom" })} />직접</label>
        {state.duration === "custom" && <label className="production-custom">직접 길이(초)<input type="number" min={CUSTOM_MIN} max={CUSTOM_MAX} step={1} value={state.customSec} aria-invalid={seconds === null} onChange={event => patch({ customSec: event.target.value })} /></label>}
        <small>{seconds === null ? CUSTOM_MIN + "~" + CUSTOM_MAX + "초 사이로 정하세요." : "장면 " + sceneCount(seconds, state.visual) + "개로 나눕니다."}</small>
      </fieldset>
      <fieldset className="production-chips"><legend>화면 비율</legend>
        {Object.entries(ASPECTS).map(([value, label]) => <label key={value}><input type="radio" name="production-aspect" checked={state.aspect === value} onChange={() => patch({ aspect: value as ComposerState["aspect"] })} />{label}</label>)}
      </fieldset>
      <fieldset className="production-chips"><legend>화면 구성</legend>
        {Object.entries(LAYOUTS).map(([value, label]) => <label key={value}><input type="radio" name="production-layout" checked={state.layout === value} onChange={() => patch({ layout: value as ComposerState["layout"] })} />{label}</label>)}
      </fieldset>
      <fieldset className="production-chips"><legend>스타일</legend>
        {Object.entries(STYLES).map(([value, label]) => <label key={value}><input type="radio" name="production-style" checked={state.style === value} onChange={() => patch({ style: value as ComposerState["style"] })} />{label}</label>)}
      </fieldset>
      {state.visual === "ai" && <fieldset className="production-chips"><legend>품질</legend>
        {Object.entries(QUALITIES).map(([value, label]) => <label key={value}><input type="radio" name="production-quality" checked={state.quality === value} onChange={() => patch({ quality: value as ComposerState["quality"] })} />{label}</label>)}
        <p className="production-resolution" aria-live="polite"><span>생성 해상도 <b>{sizeText(generation)}</b></span><span aria-hidden="true">→</span><span>출력 <b>{sizeText(outputSize(state.aspect))}</b></span><small>{generation.frames}프레임 · {generation.steps}단계</small></p>
      </fieldset>}
      <fieldset className="production-voice"><legend>나레이션·자막·음악</legend>
        <label className="production-switch"><input type="checkbox" role="switch" checked={state.narration} onChange={event => patch({ narration: event.target.checked })} />나레이션 넣기</label>
        {state.narration && <Field id="production-speaker" label="화자">{id => <select id={id} value={state.speaker} onChange={event => patch({ speaker: event.target.value })}>{Object.entries(VOICE_SPEAKERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</Field>}
        <Field id="production-subtitles" label="자막 스타일">{id => <select id={id} value={state.subtitleStyle} onChange={event => patch({ subtitleStyle: event.target.value as ComposerState["subtitleStyle"] })}>{Object.entries(SUBTITLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</Field>
        <Field id="production-bgm" label="배경 음악">{id => <select id={id} value={state.bgm} onChange={event => patch({ bgm: event.target.value as ComposerState["bgm"] })}>{Object.entries(BGMS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</Field>
      </fieldset>
      {state.visual === "ai" && <fieldset className="production-engine"><legend>영상 엔진</legend>
        {engineError ? <div className="production-inline-error" role="alert"><p>{engineError}</p><button type="button" className="social-button compact" onClick={onRetryEngines}><RefreshCw size={15} />다시 확인</button></div>
          : !engines ? <p className="production-muted" role="status"><LoaderCircle size={14} className="social-spin" />엔진 상태를 확인하는 중입니다.</p>
          : <>
            <Field id="production-engine" label="엔진">{id => <select id={id} value={state.engine} onChange={event => patch({ engine: event.target.value })}>
              {engines.engines.map(item => <option key={item.id} value={item.id} disabled={!usableEngine(item)}>{item.label}{!usableEngine(item) ? " · 사용 불가: " + (item.reason ?? "지원하지 않는 환경") : !item.installed ? " · 설치 필요" : ""}</option>)}
            </select>}</Field>
            {engine && <p className="production-badges">{engine.commercialUse && <span className="ok">상업적 이용 가능</span>}<span>{engine.license}</span>{engine.installed && <span className="ok"><Check size={12} />설치됨</span>}</p>}
            {engines.engines.filter(item => !usableEngine(item)).map(item => <small key={item.id} className="production-disabled-engine">{item.label}: {item.reason ?? "이 환경에서 사용할 수 없습니다."}</small>)}
            {engines.ffmpegReady === false && <p className="production-error-text">FFmpeg가 없어 편집 단계를 실행할 수 없습니다.{onOpenSettings && <button type="button" className="production-link" onClick={onOpenSettings}>설정 열기</button>}</p>}
            {state.narration && engines.ttsInstalled === false && <p className="production-muted">로컬 음성 엔진이 설치되지 않았습니다. 나레이션 단계에서 설치가 필요합니다.{onOpenSettings && <button type="button" className="production-link" onClick={onOpenSettings}>설정에서 설치</button>}</p>}
          </>}
      </fieldset>}
    </div>
    {state.visual === "stock" && state.narration && engines?.ttsInstalled === false && <p className="production-muted">로컬 음성 엔진이 설치되지 않았습니다. 나레이션 단계에서 설치가 필요합니다.{onOpenSettings && <button type="button" className="production-link" onClick={onOpenSettings}>설정에서 설치</button>}</p>}
    {state.visual === "ai" && engine && usableEngine(engine) && !engine.installed && <EngineCard engine={engine} busy={busy === "install"} onInstall={() => onInstall(engine.id)} />}
    <div className="production-submit">
      <button type="submit" className="social-button primary production-primary" disabled={!!problem || !!busy} aria-describedby="production-create-reason">
        {busy === "create" ? <LoaderCircle size={17} className="social-spin" /> : <WandSparkles size={17} />}{busy === "create" ? "영상 생성 요청 중" : "영상 생성"}
      </button>
      <p id="production-create-reason" className={problem ? "production-muted" : "production-ready"}>{problem ?? (state.visual === "stock" ? "스토리보드와 장면별 사진 후보를 먼저 보여 드립니다. 확인한 뒤 영상을 만듭니다." : "스토리보드를 먼저 만들고, 확인한 뒤 장면 생성을 시작합니다.")}</p>
    </div>
  </form>;
}

function Stepper({ job, busy, onRetry }: { job: ProductionJob; busy: boolean; onRetry: (stage: StageId) => void }) {
  const shown = job.stages.map(stage => ({ ...stage, status: shownStatus(job, stage.id, stage.status) }));
  const completed = shown.filter(stage => stage.status === "done").length;
  const current = shown.find(stage => stage.status === "running" || stage.status === "waiting" || stage.status === "failed");
  return <section className="production-progress" aria-labelledby="production-progress-title">
    <div className="production-section-heading"><h3 id="production-progress-title">제작 단계</h3><span role="status" aria-live="polite">{completed}/{STAGES.length} 단계 완료{current ? " · " + STAGES.find(s => s.id === current.id)?.label + " " + ASSET_STATUS_LABELS[current.status] : ""}</span></div>
    <ol className="production-stepper">
      {shown.map((stage, index) => {
        const label = STAGES[index].label;
        const error = stage.error ?? (job.error && (job.error.stage === stage.id || !job.error.stage) ? job.error.message : undefined);
        return <li key={stage.id} className={"is-" + stage.status} aria-current={current?.id === stage.id ? "step" : undefined}>
          <span className="production-step-dot" aria-hidden="true">{stage.status === "done" ? <Check size={13} /> : stage.status === "running" ? <LoaderCircle size={13} className="social-spin" /> : stage.status === "failed" ? <X size={13} /> : index + 1}</span>
          <div>
            <strong>{label}</strong>
            <small>{ASSET_STATUS_LABELS[stage.status]}{stage.total > 0 ? " · " + stage.done + "/" + stage.total : ""}</small>
            {stage.status === "running" && stage.total > 0 && <progress max={stage.total} value={stage.done} aria-label={label + " 진행 " + stage.done + "/" + stage.total} />}
            {stage.status === "running" && stage.message && <small className="production-step-message">{stage.message}</small>}
            {stage.status === "failed" && <div className="production-step-error" role="alert">
              <p>{error ?? "이 단계를 완료하지 못했습니다."}</p>
              <button type="button" className="social-button compact" disabled={busy || job.status === "cancelled"} onClick={() => onRetry(stage.id)}><RefreshCw size={14} />다시 시도<span className="social-sr-only"> · {label}</span></button>
            </div>}
          </div>
        </li>;
      })}
    </ol>
  </section>;
}

const SOURCE_NAMES: Record<string, string> = { flickr: "Flickr", wikimedia: "Wikimedia Commons", stocksnap: "StockSnap", rawpixel: "Rawpixel", nasa: "NASA" };

function PhotoPicker({ scene, candidates, busy, onPick, onSearch }: { scene: StoryboardScene; candidates: ImageCandidate[]; busy: boolean; onPick: (id: string) => void; onSearch: (query: string) => void }) {
  const [query, setQuery] = useState(scene.search ?? "");
  const picked = scene.imageId ?? candidates[0]?.id;
  return <div className="production-photos">
    <div className="production-photo-search">
      <label htmlFor={"production-search-" + scene.id}>사진 검색어 <small>영어</small></label>
      <input id={"production-search-" + scene.id} lang="en" value={query} maxLength={80} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (query.trim()) onSearch(query); } }} />
      <button type="button" className="social-button compact" disabled={busy || !query.trim()} onClick={() => onSearch(query)}>{busy ? <LoaderCircle size={14} className="social-spin" /> : <Search size={14} />}다시 찾기<span className="social-sr-only"> · 장면 {scene.order}</span></button>
    </div>
    {candidates.length ? <div className="production-photo-grid" role="radiogroup" aria-label={"장면 " + scene.order + " 사진"}>
      {candidates.map(c => <button key={c.id} type="button" role="radio" aria-checked={picked === c.id} className="production-photo" onClick={() => onPick(c.id)}
        aria-label={(c.title || "사진") + " · " + c.creator + " · " + c.license}>
        <img src={mediaSrc(c.preview)} alt="" loading="lazy" />
        <span>{c.license}{c.attributionRequired ? " · 출처 표시" : ""}</span>
        {picked === c.id && <Check size={14} className="production-photo-check" aria-hidden="true" />}
      </button>)}
    </div> : <p className="production-muted production-no-photo"><ImageIcon size={14} />맞는 사진을 찾지 못했습니다. 검색어를 바꿔 보세요. 사진 없이 승인하면 자막을 크게 넣은 그래픽 장면으로 만듭니다.</p>}
    {(() => { const c = candidates.find(item => item.id === picked); return c ? <small className="production-photo-credit">{c.creator} · {SOURCE_NAMES[c.source] ?? c.source} · {c.license}</small> : null; })()}
  </div>;
}

function StoryboardReview({ job, draft, setDraft, busy, onApprove, onSearch }: { job: ProductionJob; draft: Storyboard; setDraft: (board: Storyboard) => void; busy: string | null; onApprove: () => void; onSearch: (sceneId: string, query: string) => void }) {
  const problem = storyboardProblem(draft);
  const stock = job.settings.visual === "stock";
  const total = draft.scenes.reduce((sum, scene) => sum + (Number.isFinite(scene.durationSec) ? scene.durationSec : 0), 0);
  const patchScene = (id: string, value: Partial<StoryboardScene>) => setDraft({ ...draft, scenes: draft.scenes.map(scene => scene.id === id ? { ...scene, ...value } : scene) });
  return <section className="production-review" aria-labelledby="production-review-title">
    <div className="production-section-heading">
      <h3 id="production-review-title">스토리보드 확인</h3>
      {job.storyboard?.template && <span className="production-template-badge">템플릿 초안 · AI 미사용</span>}
    </div>
    <p className="production-muted">장면을 만들기 전에 제목과 장면별 내용을 고칠 수 있습니다. 승인하면 이 내용 그대로 장면을 생성합니다.</p>
    <Field id="production-storyboard-title" label="영상 제목" className="production-review-title">{id => <input id={id} value={draft.title} maxLength={120} onChange={event => setDraft({ ...draft, title: event.target.value })} />}</Field>
    {job.settings.layout === "card" && <div className="production-headline" aria-label="상단 고정 제목">
      <Field id="production-headline-top" label="상단 제목 1줄 (흰색)">{id => <input id={id} value={draft.headline?.top ?? ""} maxLength={18} onChange={event => setDraft({ ...draft, headline: { top: event.target.value, bottom: draft.headline?.bottom ?? "" } })} />}</Field>
      <Field id="production-headline-bottom" label="상단 제목 2줄 (노란색)">{id => <input id={id} value={draft.headline?.bottom ?? ""} maxLength={18} onChange={event => setDraft({ ...draft, headline: { top: draft.headline?.top ?? "", bottom: event.target.value } })} />}</Field>
    </div>}
    {draft.story && <p className="production-story">{draft.story}</p>}
    <ol className="production-review-scenes">
      {draft.scenes.map(scene => <li key={scene.id}>
        <fieldset aria-label={"장면 " + scene.order + " 편집"} className={stock ? "is-stock" : undefined}>
          <legend>장면 {scene.order}</legend>
          <Field id={"production-narration-" + scene.id} label="나레이션" className="production-narration-field">{id => <textarea id={id} rows={3} value={scene.narration} onChange={event => patchScene(scene.id, { narration: event.target.value })} />}</Field>
          <Field id={"production-caption-" + scene.id} label="자막">{id => <input id={id} value={scene.caption} maxLength={120} onChange={event => patchScene(scene.id, { caption: event.target.value })} />}</Field>
          {stock ? <>
            <Field id={"production-emphasis-" + scene.id} label="강조 단어 (노란색)" hint={<small>쉼표로 구분 · 2개까지</small>}>{id => <input id={id} value={(scene.emphasis ?? []).join(", ")} onChange={event => patchScene(scene.id, { emphasis: event.target.value.split(",").map(w => w.trim()).filter(Boolean).slice(0, 3) })} />}</Field>
            <Field id={"production-camera-" + scene.id} label="사진 움직임">{id => <select id={id} value={scene.camera ?? "zoom-in"} onChange={event => patchScene(scene.id, { camera: event.target.value as Camera })}>{CAMERAS.map(c => <option key={c} value={c}>{CAMERA_LABELS[c]}</option>)}</select>}</Field>
            <Field id={"production-stat-" + scene.id} label="숫자 카드" hint={<small>비우면 없음</small>}>{id => <input id={id} value={scene.stat?.value ?? ""} maxLength={12} placeholder="예: 30m" onChange={event => patchScene(scene.id, { stat: event.target.value.trim() ? { value: event.target.value, label: scene.stat?.label ?? "" } : null })} />}</Field>
            <PhotoPicker scene={scene} candidates={job.candidates[scene.id] ?? []} busy={busy === "search-" + scene.id}
              onPick={imageId => patchScene(scene.id, { imageId })} onSearch={query => { patchScene(scene.id, { search: query }); onSearch(scene.id, query); }} />
          </> : <Field id={"production-prompt-" + scene.id} label="영상 프롬프트" hint={<small>영문 · {scene.prompt.length}/{PROMPT_MAX}</small>}>{id => <textarea id={id} rows={3} value={scene.prompt} lang="en" aria-invalid={scene.prompt.length > PROMPT_MAX || !scene.prompt.trim()} onChange={event => patchScene(scene.id, { prompt: event.target.value })} />}</Field>}
          <Field id={"production-duration-" + scene.id} label="길이(초)">{id => <input id={id} type="number" min={2} max={12} step={1} value={scene.durationSec} onChange={event => patchScene(scene.id, { durationSec: Number(event.target.value) })} />}</Field>
        </fieldset>
      </li>)}
    </ol>
    <div className="production-submit">
      <button type="button" className="social-button primary production-primary" disabled={!!problem || !!busy} aria-describedby="production-approve-reason" onClick={onApprove}>
        {busy === "approve" ? <LoaderCircle size={17} className="social-spin" /> : <Play size={17} />}이대로 생성
      </button>
      <p id="production-approve-reason" className="production-muted">{problem ?? "장면 " + draft.scenes.length + "개 · 합계 " + total + "초"}</p>
    </div>
  </section>;
}

function SceneGrid({ job, busy, onRetry }: { job: ProductionJob; busy: boolean; onRetry: (stage: StageId, sceneId: string) => void }) {
  const locked = busy || job.status === "cancelled" || job.status === "planning" || job.status === "awaiting_approval";
  return <section className="production-scenes" aria-labelledby="production-scenes-title">
    <div className="production-section-heading"><h3 id="production-scenes-title">장면</h3><span>{job.scenes.filter(scene => scene.video.status === "done").length}/{job.scenes.length} 장면 완료</span></div>
    <ul>
      {job.scenes.map(scene => {
        const board = job.storyboard?.scenes.find(item => item.id === scene.id);
        const src = scene.video.status === "done" ? mediaSrc(scene.video.path) : "";
        const still = scene.video.kind === "stock" || scene.video.kind === "graphic";
        return <li key={scene.id}><article aria-label={"장면 " + scene.order} className={"production-scene is-" + scene.video.status}>
          <div className={"production-scene-media aspect-" + job.settings.aspect.replace(":", "x")}>
            {src && still ? <img src={src} alt={"장면 " + scene.order + " 사진"} className={"production-kenburns cam-" + (board?.camera ?? "zoom-in")} />
              : src ? <video src={src} muted playsInline controls preload="metadata" aria-label={"장면 " + scene.order + " 미리보기"} />
              : <span>{scene.video.status === "running" ? <LoaderCircle size={18} className="social-spin" /> : scene.video.status === "failed" ? <CircleAlert size={18} /> : <Clapperboard size={18} />}{ASSET_STATUS_LABELS[scene.video.status]}</span>}
          </div>
          <header><strong>장면 {scene.order}</strong>{board && <span>{board.durationSec}초</span>}</header>
          {board && <p>{board.caption || board.narration || board.script}</p>}
          <dl>
            <div><dt>{still ? "사진" : "영상"}</dt><dd className={"is-" + scene.video.status}>{ASSET_STATUS_LABELS[scene.video.status]}</dd></div>
            {job.settings.narration && <div><dt>나레이션</dt><dd className={"is-" + scene.voice.status}>{ASSET_STATUS_LABELS[scene.voice.status]}</dd></div>}
          </dl>
          {(scene.video.error || scene.voice.error) && <p className="production-error-text" role="alert">{scene.video.error ?? scene.voice.error}</p>}
          <div className="production-scene-actions">
            <button type="button" className="social-button compact" disabled={locked || scene.video.status === "running"} onClick={() => onRetry("scenes", scene.id)}><RefreshCw size={14} />{scene.video.kind === "stock" ? "다른 사진으로" : "장면 재생성"}<span className="social-sr-only"> · 장면 {scene.order}</span></button>
            {job.settings.narration && <button type="button" className="social-button compact" disabled={locked || scene.voice.status === "running"} onClick={() => onRetry("voice", scene.id)}><Mic size={14} />나레이션 다시<span className="social-sr-only"> · 장면 {scene.order}</span></button>}
          </div>
        </article></li>;
      })}
    </ul>
  </section>;
}

function Result({ job, busy, onOpen, onSave, onDraft, onEdit }: { job: ProductionJob; busy: string | null; onOpen: () => void; onSave: () => void; onDraft: () => void; onEdit?: () => void }) {
  const final = job.final!;
  const generation = job.generation ?? generationSize(job.settings.aspect, job.settings.quality);
  const output = final.width && final.height ? { width: final.width, height: final.height } : job.output ?? outputSize(job.settings.aspect);
  const passed = job.qa.filter(check => check.passed).length;
  return <section className="production-result" aria-labelledby="production-result-title">
    <div className="production-section-heading"><h3 id="production-result-title">완성 영상</h3><span className="ok"><Check size={13} />완료</span></div>
    <div className="production-result-body">
      <div className={"production-final aspect-" + job.settings.aspect.replace(":", "x")}><video src={mediaSrc(final.path)} controls playsInline preload="metadata" aria-label="완성 영상 재생" /></div>
      <div className="production-result-info">
        <dl className="production-facts">
          {job.settings.visual === "ai" && <div><dt>생성 해상도</dt><dd>{sizeText(generation)}</dd></div>}
          <div><dt>출력 해상도</dt><dd>{sizeText(output)}</dd></div>
          <div><dt>길이</dt><dd>{Math.round(final.durationSec * 10) / 10}초</dd></div>
          {final.sizeBytes != null && <div><dt>파일 크기</dt><dd>{(final.sizeBytes / 1024 ** 2).toFixed(1)} MiB</dd></div>}
        </dl>
        <div className="production-qa">
          <h4>품질 검사 <small>{passed}/{job.qa.length} 통과</small></h4>
          {job.qa.length ? <ul>{job.qa.map(check => <li key={check.id} className={check.passed ? "ok" : "bad"}>{check.passed ? <Check size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}<span>{check.passed ? "통과" : "실패"} · {check.label}{check.detail ? <small> {check.detail}</small> : null}</span></li>)}</ul> : <p className="production-muted">품질 검사 기록이 없습니다.</p>}
        </div>
        {job.provenance && <div className="production-provenance">
          <h4>라이선스·출처</h4>
          {job.provenance.commercialUse && <p className="production-badges"><span className="ok">영상 상업적 이용 가능</span>{job.provenance.narrationRights === "conditional" && <span className="warn">나레이션 화자 권리 조건부</span>}</p>}
          <ul>{job.provenance.licenses.map(item => <li key={item.name + item.license}>{item.name} · {item.license}</li>)}</ul>
          {job.provenance.planner && <small>기획: {job.provenance.planner}</small>}
          {job.storyboard?.template && <small>스토리보드: 템플릿 초안 · AI 미사용</small>}
          {job.provenance.credits.length > 0 && <details className="production-credits"><summary>사진 출처 {job.provenance.credits.length}건 · 게시글 설명에 자동으로 들어갑니다</summary><ul>{job.provenance.credits.map(c => <li key={c}>{c}</li>)}</ul></details>}
          {job.provenance.notes.map(note => <small key={note}>{note}</small>)}
        </div>}
        <div className="production-result-actions">
          <button type="button" className="social-button" disabled={!!busy} onClick={onOpen}><ExternalLink size={16} />새 창에서 보기</button>
          <button type="button" className="social-button" disabled={!!busy} onClick={onSave}><Download size={16} />MP4 저장</button>
          {onEdit && <button type="button" className="social-button" disabled={!!busy} onClick={onEdit}><PencilLine size={16} />편집기에서 다듬기</button>}
          <button type="button" className="social-button primary" disabled={!!busy} aria-describedby="production-draft-hint" onClick={onDraft}>{busy === "draft" ? <LoaderCircle size={16} className="social-spin" /> : <Send size={16} />}SNS 게시 초안 만들기</button>
        </div>
        <small id="production-draft-hint" className="production-muted">초안만 만듭니다. 실제 게시는 발행 화면에서 승인한 뒤에 진행됩니다.</small>
      </div>
    </div>
  </section>;
}

export function ProductionStudio({ active, onOpenSettings, onEditInEditor }: Props) {
  const [composer, setComposer] = useState<ComposerState>(initialComposer);
  const [engines, setEngines] = useState<EngineStatus | null>(null);
  const [engineError, setEngineError] = useState("");
  const [jobs, setJobs] = useState<ProductionJobSummary[]>([]);
  const [jobsError, setJobsError] = useState("");
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [job, setJob] = useState<ProductionJob | null>(null);
  const [draft, setDraft] = useState<Storyboard | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const jobId = useRef<string | null>(null);
  const draftFor = useRef<string | null>(null);
  const readSeq = useRef(0);
  const started = useRef(false);

  const refreshEngines = useCallback(async () => {
    try {
      const status = await productionApi.engineStatus();
      setEngines(status); setEngineError("");
      setComposer(current => current.engine && status.engines.some(item => item.id === current.engine && usableEngine(item)) ? current
        : { ...current, engine: status.engines.find(usableEngine)?.id ?? "" });
    } catch (error) { setEngineError(errorMessage(error)); }
  }, []);
  const refreshJobs = useCallback(async () => {
    try { setJobs(await productionApi.list()); setJobsError(""); }
    catch (error) { setJobsError(errorMessage(error)); }
    finally { setJobsLoaded(true); }
  }, []);
  const readJob = useCallback(async (id: string) => {
    const seq = ++readSeq.current;
    const next = await productionApi.get(id);
    if (seq === readSeq.current && jobId.current === id) setJob(next);
  }, []);
  const showJob = useCallback((next: ProductionJob | null) => { if (next && next.id === jobId.current) { readSeq.current++; setJob(next); } }, []);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    void refreshEngines(); void refreshJobs();
  }, [active, refreshEngines, refreshJobs]);

  const installing = !!engines?.engines.some(item => item.install?.phase === "running");
  useEffect(() => {
    if (!active || !installing) return;
    const timer = window.setInterval(() => void refreshEngines(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, installing, refreshEngines]);

  const polling = active && live(job);
  const currentId = job?.id;
  useEffect(() => {
    if (!polling || !currentId) return;
    const timer = window.setInterval(() => { void readJob(currentId).catch(() => {}); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling, currentId, readJob]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let stop: (() => void) | undefined;
    void listen<ProductionEvent>("production-event", ({ payload }) => {
      if (!alive || !payload || payload.jobId !== jobId.current) return;
      if (payload.kind === "progress") {
        setJob(current => current && current.id === payload.jobId ? {
          ...current, stages: current.stages.map(stage => stage.id === payload.stage
            ? { ...stage, done: payload.done, total: payload.total, message: payload.message || stage.message, status: stage.status === "pending" || stage.status === "stale" ? "running" : stage.status }
            : stage)
        } : current);
      } else if (payload.kind === "state") void readJob(payload.jobId).catch(() => {});
    }).then(unlisten => { if (alive) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { alive = false; stop?.(); };
  }, [active, readJob]);

  const status = job?.status;
  useEffect(() => {
    if (job && status === "awaiting_approval" && job.storyboard) {
      if (draftFor.current !== job.id) { draftFor.current = job.id; setDraft(structuredClone(job.storyboard)); }
    } else if (status !== "awaiting_approval") { draftFor.current = null; setDraft(null); }
  }, [job, status]);
  useEffect(() => { if (status === "done" || status === "failed" || status === "cancelled" || status === "awaiting_approval") void refreshJobs(); }, [status, currentId, refreshJobs]);
  useEffect(() => { setConfirmCancel(false); }, [status, currentId]);

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label); setNotice(null);
    try { await action(); }
    catch (error) { setNotice({ tone: "error", text: errorMessage(error) }); }
    finally { setBusy(null); }
  }, []);
  const apply = useCallback(async (id: string, request: Promise<ProductionJob | null>) => {
    const next = await request;
    if (next) showJob(next); else await readJob(id);
  }, [readJob, showJob]);

  const create = () => void run("create", async () => {
    const created = await productionApi.create(composerInput(composer));
    jobId.current = created.id; draftFor.current = null; setDraft(null); setJob(created);
    void refreshJobs();
  });
  const open = (id: string) => void run("open", async () => {
    jobId.current = id; draftFor.current = null; setDraft(null);
    const next = await productionApi.get(id);
    if (jobId.current === id) setJob(next);
  });
  const startNew = () => { jobId.current = null; readSeq.current++; draftFor.current = null; setDraft(null); setJob(null); setNotice(null); };
  const install = (engine: string) => void run("install", async () => { await productionApi.installEngine(engine); await refreshEngines(); });
  const approve = () => { if (job && draft) void run("approve", () => apply(job.id, productionApi.approve(job.id, draft))); };
  const searchImages = (sceneId: string, query: string) => { if (job) void run("search-" + sceneId, async () => {
    const next = await productionApi.findImages(job.id, sceneId, query);
    showJob(next);
    const first = next.candidates[sceneId]?.[0]?.id;
    setDraft(current => current ? { ...current, scenes: current.scenes.map(scene => scene.id === sceneId ? { ...scene, search: query, ...(first ? { imageId: first } : {}) } : scene) } : current);
  }); };
  const retry = (stage: StageId, sceneId?: string) => { if (job) void run("retry", () => apply(job.id, productionApi.retry(job.id, stage, sceneId))); };
  const pause = () => { if (job) void run("pause", () => apply(job.id, productionApi.pause(job.id))); };
  const resume = () => { if (job) void run("resume", () => apply(job.id, productionApi.resume(job.id))); };
  const cancel = () => { if (job) void run("cancel", async () => { await apply(job.id, productionApi.cancel(job.id)); void refreshJobs(); }); };
  const openFinal = () => { if (job) void run("open-final", async () => { await productionApi.openFinal(job.id); }); };
  const saveFinal = () => { if (job) void run("save", async () => {
    const result = await productionApi.saveVideo(job.id);
    setNotice(result?.saved ? { tone: "success", text: "MP4를 저장했습니다: " + result.saved } : { tone: "info", text: "저장을 취소했습니다. 원본은 작업 폴더에 남아 있습니다." });
  }); };
  const publicationDraft = () => { if (job) void run("draft", async () => {
    await productionApi.publicationDraft(job.id);
    setNotice({ tone: "success", text: "SNS 게시 초안을 만들었습니다. 아직 게시되지 않았으며, 발행 화면에서 승인해야 게시됩니다." });
  }); };

  const summary = useMemo(() => job ? [job.settings.durationSec + "초", ASPECTS[job.settings.aspect] ?? job.settings.aspect, STYLES[job.settings.style] ?? job.settings.style, QUALITIES[job.settings.quality] ?? job.settings.quality].join(" · ") : "", [job]);
  const canPause = job && (job.status === "running" || job.status === "planning");
  const canCancel = job && job.status !== "done" && job.status !== "cancelled";

  return <section className="production" aria-labelledby="production-title" aria-busy={busy === "create" || busy === "open"}>
    <header className="production-heading">
      <div>
        <span className="production-eyebrow"><WandSparkles size={14} />주제 → AI 영상</span>
        <h2 id="production-title">{job ? job.storyboard?.title || job.settings.topic || "AI 영상" : "어떤 영상을 만들까요?"}</h2>
        <p>{job ? summary + " · " + JOB_STATUS_LABELS[job.status] : "주제를 적고 영상 생성을 누르면 기획한 대로 장면 영상, 나레이션, 자막, 편집까지 진행합니다."}</p>
      </div>
      {job && <div className="production-controls" role="group" aria-label="작업 제어">
        {canPause && <button type="button" className="social-button compact" disabled={!!busy} onClick={pause}><Pause size={15} />일시정지</button>}
        {job.status === "paused" && <button type="button" className="social-button compact" disabled={!!busy} onClick={resume}><Play size={15} />계속</button>}
        {canCancel && !confirmCancel && <button type="button" className="social-button compact" disabled={!!busy} onClick={() => setConfirmCancel(true)}><Square size={14} />취소</button>}
        {canCancel && confirmCancel && <span className="production-confirm" role="group" aria-label="작업 취소 확인">
          <span>작업을 취소할까요?</span>
          <button type="button" className="social-button compact danger" disabled={!!busy} onClick={cancel}>작업 취소</button>
          <button type="button" className="social-button compact" disabled={!!busy} onClick={() => setConfirmCancel(false)}>계속 진행</button>
        </span>}
        <button type="button" className="social-button compact" disabled={!!busy} onClick={startNew}><Plus size={15} />새 영상</button>
      </div>}
    </header>
    {notice && <p className={"production-notice " + notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}<button type="button" className="production-dismiss" aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={14} /></button></p>}
    <div className="production-layout">
      <div className="production-main">
        {!job && <Composer state={composer} setState={setComposer} engines={engines} engineError={engineError} busy={busy} onCreate={create} onInstall={install} onRetryEngines={() => void refreshEngines()} onOpenSettings={onOpenSettings} />}
        {job && <>
          <Stepper job={job} busy={!!busy} onRetry={stage => retry(stage)} />
          {job.status === "cancelled" && <p className="production-notice info" role="status">이 작업은 취소되었습니다. 새 영상으로 다시 시작할 수 있습니다.</p>}
          {job.status === "paused" && <p className="production-notice info" role="status">일시정지했습니다. 계속을 누르면 멈춘 단계부터 이어서 진행합니다.</p>}
          {job.status === "planning" && <p className="production-muted production-planning" role="status"><LoaderCircle size={15} className="social-spin" />주제를 바탕으로 기획과 스토리보드를 만들고 있습니다.</p>}
          {job.status === "awaiting_approval" && draft && <StoryboardReview job={job} draft={draft} setDraft={setDraft} busy={busy} onApprove={approve} onSearch={searchImages} />}
          {job.status === "done" && job.final && <Result job={job} busy={busy} onOpen={openFinal} onSave={saveFinal} onDraft={publicationDraft}
            onEdit={onEditInEditor && job.editProject ? () => onEditInEditor(job.editProject!) : undefined} />}
          {job.scenes.length > 0 && job.status !== "awaiting_approval" && job.status !== "planning" && <SceneGrid job={job} busy={!!busy} onRetry={(stage, sceneId) => retry(stage, sceneId)} />}
        </>}
      </div>
      <aside className="production-jobs" aria-labelledby="production-jobs-title">
        <div className="production-section-heading"><h3 id="production-jobs-title"><History size={14} />최근 작업</h3><button type="button" className="production-icon" aria-label="최근 작업 새로고침" onClick={() => void refreshJobs()}><RefreshCw size={14} /></button></div>
        {jobsError && <p className="production-error-text" role="alert">{jobsError}</p>}
        {!jobsError && jobsLoaded && !jobs.length && <p className="production-muted">아직 만든 영상이 없습니다. 첫 주제를 적어 보세요.</p>}
        <ul>{jobs.map(item => <li key={item.id}><button type="button" aria-current={job?.id === item.id ? "true" : undefined} disabled={busy === "open"} onClick={() => open(item.id)}>
          <strong>{item.title}</strong>
          <span className={"production-status is-" + item.status}>{JOB_STATUS_LABELS[item.status]}</span>
          <small>{shortDate(item.updatedAt)}{item.durationSec ? " · " + item.durationSec + "초" : ""}{item.aspect ? " · " + item.aspect : ""}</small>
        </button></li>)}</ul>
      </aside>
    </div>
  </section>;
}

