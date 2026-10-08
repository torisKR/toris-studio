import { invoke } from "@tauri-apps/api/core";
import {
  Check, CircleAlert, Clapperboard, Clock3, FileJson, FolderOpen,
  LoaderCircle, Mic, Plus, RefreshCw, Save, Trash2, X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VideoFormat, VideoProject, VideoScene } from "../../lib/video/types";
import "./VideoPanel.css";

type MediaStatus = {
  ffmpegAvailable: boolean; ffprobeAvailable: boolean; fontAvailable: boolean;
  ttsConfigured: boolean; dataPath: string; renderer: string;
};
type RenderResult = { path: string; durationSec: number; format: VideoFormat; renderer: string };
type VoiceResult = { audioPath: string; durationSec: number; sampleRate: number; speaker: string; provider: string };
type PendingProject = { kind: "new" } | { kind: "select"; project: VideoProject } | { kind: "import" };
type Notice = { text: string; tone: "success" | "error" | "info" };

const formatLabels: Record<VideoFormat, string> = {
  "youtube-landscape": "YouTube · 가로 16:9", vertical: "세로 9:16", shorts: "Shorts · 세로 9:16"
};

function message(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "요청을 처리하지 못했습니다.";
}

function newScene(): VideoScene {
  return {
    id: `scene-${crypto.randomUUID()}`, headline: "", body: "", narration: "",
    durationSec: 5, mediaType: "none", accent: "#8AE3BB", layout: "hero", role: "point"
  };
}

function blankProject(): VideoProject {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), title: "새 영상", subtitle: "", format: "youtube-landscape",
    template: "reference-briefing", language: "ko", scenes: [newScene()], createdAt: now, updatedAt: now
  };
}

function projectDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "날짜 없음" : new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "short", day: "numeric"
  }).format(date);
}

export function VideoPanel({ active }: { active: boolean }) {
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [project, setProject] = useState<VideoProject | null>(null);
  const [baseline, setBaseline] = useState("");
  const [sceneId, setSceneId] = useState("");
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState<"save" | "render" | "voice" | "import" | "open" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [render, setRender] = useState<RenderResult | null>(null);
  const [renderVersion, setRenderVersion] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState("");
  const [pending, setPending] = useState<PendingProject | null>(null);
  const importDialog = useRef<HTMLDialogElement>(null);
  const changesDialog = useRef<HTMLDialogElement>(null);
  const initialized = useRef(false);
  const selectedProject = useRef<VideoProject | null>(null);
  selectedProject.current = project;
  const scene = project?.scenes.find((item) => item.id === sceneId) ?? project?.scenes[0];
  const dirty = project !== null && JSON.stringify(project) !== baseline;
  const renderStale = !!render && JSON.stringify(project) !== renderVersion;
  const duration = useMemo(() => project?.scenes.reduce((sum, item) => sum + item.durationSec, 0) ?? 0, [project]);
  const canRender = !!project && !!status?.ffmpegAvailable && !!status.ffprobeAvailable && !!status.fontAvailable;

  const checkStatus = useCallback(async () => {
    setStatusError("");
    try { setStatus(await invoke<MediaStatus>("media_status")); }
    catch (error) { setStatus(null); setStatusError(message(error)); }
  }, []);

  const loadProjects = useCallback(async () => {
    setLoading(true); setListError("");
    try {
      const saved = await invoke<VideoProject[]>("video_list_projects");
      setProjects(saved);
      if (!selectedProject.current && saved.length) {
        setProject(saved[0]); setBaseline(JSON.stringify(saved[0]));
        setSceneId(saved[0].scenes[0]?.id ?? "");
      }
    } catch (error) { setListError(message(error)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (active && !initialized.current) {
      initialized.current = true;
      void loadProjects(); void checkStatus();
    }
  }, [active, loadProjects, checkStatus]);

  useEffect(() => {
    if (importOpen) importDialog.current?.showModal();
    else importDialog.current?.close();
  }, [importOpen]);
  useEffect(() => {
    if (pending) changesDialog.current?.showModal();
    else changesDialog.current?.close();
  }, [pending]);

  function selectProject(next: VideoProject, saved = true) {
    setProject(next); setSceneId(next.scenes[0]?.id ?? "");
    setBaseline(saved ? JSON.stringify(next) : ""); setRender(null); setNotice(null);
  }

  function applyPending(action: PendingProject) {
    setPending(null);
    if (action.kind === "new") selectProject(blankProject(), false);
    else if (action.kind === "select") selectProject(action.project);
    else { setImportError(""); setImportOpen(true); }
  }

  function requestProject(action: PendingProject) {
    if (busy) return;
    if (action.kind === "select" && action.project.id === project?.id) return;
    if (dirty) setPending(action);
    else applyPending(action);
  }

  function patchProject(patch: Partial<VideoProject>) {
    setProject((current) => current ? { ...current, ...patch } : current);
  }

  function patchScene(patch: Partial<VideoScene>) {
    if (!scene) return;
    setProject((current) => current ? {
      ...current, scenes: current.scenes.map((item) => item.id === scene.id ? { ...item, ...patch } : item)
    } : current);
  }

  function rememberSaved(saved: VideoProject) {
    setProjects((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    setProject(saved); setBaseline(JSON.stringify(saved));
  }

  async function saveProject(): Promise<boolean> {
    if (!project) return false;
    setBusy("save"); setNotice(null);
    try {
      const saved = await invoke<VideoProject>("video_save_project", { input: project });
      rememberSaved(saved);
      setNotice({ tone: "success", text: "영상 프로젝트를 로컬 파일에 저장했습니다." });
      return true;
    } catch (error) { setNotice({ tone: "error", text: message(error) }); return false; }
    finally { setBusy(null); }
  }

  async function saveAndContinue() {
    const action = pending;
    if (action && await saveProject()) applyPending(action);
  }

  async function renderProject() {
    if (!project) return;
    setBusy("render"); setNotice(null); setRender(null);
    try {
      const saved = await invoke<VideoProject>("video_save_project", { input: project });
      rememberSaved(saved);
      const result = await invoke<RenderResult>("video_render_project", { project: saved });
      setRender(result); setRenderVersion(JSON.stringify(saved));
      setNotice({ tone: "success", text: "Rust · FFmpeg로 MP4 출력을 완료했습니다." });
    } catch (error) { setNotice({ tone: "error", text: message(error) }); }
    finally { setBusy(null); }
  }

  async function generateVoice() {
    if (!project || !scene?.narration.trim()) return;
    setBusy("voice"); setNotice(null);
    try {
      const result = await invoke<VoiceResult>("video_generate_voice", {
        input: { projectId: project.id, sceneId: scene.id, text: scene.narration, language: project.language }
      });
      patchScene({ audioPath: result.audioPath, durationSec: Math.max(scene.durationSec, Math.ceil((result.durationSec + .35) * 10) / 10) });
      setNotice({ tone: "success", text: `선택한 장면의 음성을 생성했습니다. ${result.durationSec.toFixed(1)}초 · ${result.provider}. 프로젝트를 저장하면 음성 연결이 보관됩니다.` });
    } catch (error) { setNotice({ tone: "error", text: message(error) }); }
    finally { setBusy(null); }
  }

  async function importProject() {
    setBusy("import"); setImportError("");
    try {
      const parsed: unknown = JSON.parse(importJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("프로젝트 한 개의 VideoProject JSON을 입력하세요.");
      const now = new Date().toISOString();
      const saved = await invoke<VideoProject>("video_save_project", {
        input: { ...parsed, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
      });
      rememberSaved(saved); setSceneId(saved.scenes[0]?.id ?? ""); setRender(null);
      setImportOpen(false); setImportJson("");
      setNotice({ tone: "success", text: "JSON을 새 영상 프로젝트로 가져와 저장했습니다." });
    } catch (error) { setImportError(error instanceof SyntaxError ? "JSON 문법을 확인하세요." : message(error)); }
    finally { setBusy(null); }
  }

  async function openRender() {
    if (!render) return;
    setBusy("open");
    try { await invoke("open_rendered_video", { path: render.path }); }
    catch (error) { setNotice({ tone: "error", text: message(error) }); }
    finally { setBusy(null); }
  }

  function addScene() {
    const next = newScene();
    patchProject({ scenes: [...(project?.scenes ?? []), next] }); setSceneId(next.id);
  }

  function removeScene() {
    if (!project || !scene || project.scenes.length <= 1) return;
    const remaining = project.scenes.filter((item) => item.id !== scene.id);
    patchProject({ scenes: remaining }); setSceneId(remaining[0].id);
  }

  return <section className="desktop-video" aria-label="영상 스튜디오">
    <div className="desktop-video-engine">
      <Clapperboard size={20} aria-hidden="true" />
      <div><strong>Rust · FFmpeg</strong><p>장면의 제목·본문과 로컬 미디어, 자막, 음성을 합쳐 MP4로 출력합니다. 웹 편집기의 애니메이션 대신 고정 슬라이드로 렌더링합니다.</p></div>
      <button className="social-button compact" disabled={!!busy || loading} onClick={() => { void checkStatus(); void loadProjects(); }}><RefreshCw size={14} />상태 확인</button>
    </div>
    <div className="desktop-video-status" aria-label="영상 처리 환경">
      <span className={status?.ffmpegAvailable ? "ready" : ""}>FFmpeg {status ? status.ffmpegAvailable ? "준비됨" : "없음" : "확인 필요"}</span>
      <span className={status?.fontAvailable ? "ready" : ""}>자막 글꼴 {status ? status.fontAvailable ? "준비됨" : "없음" : "확인 필요"}</span>
      <span className={status?.ttsConfigured ? "ready" : ""}>Qwen 로컬 TTS {status ? status.ttsConfigured ? "주소 설정됨" : "연결 미설정" : "확인 필요"}</span>
      {status && !status.ffprobeAvailable && <span>FFprobe 없음</span>}
    </div>
    {statusError && <p className="social-form-error" role="alert">처리 환경: {statusError}</p>}
    {notice && <div className={`social-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "success" ? <Check size={17} /> : <CircleAlert size={17} />}<span>{notice.text}</span><button className="social-dismiss" aria-label="영상 알림 닫기" onClick={() => setNotice(null)}><X size={15} /></button></div>}

    <div className="desktop-video-workbench">
      <aside className="desktop-video-library" aria-label="저장한 영상 프로젝트">
        <div className="desktop-video-library-heading"><h2>내 영상 <small>{projects.length}</small></h2><button className="social-button compact icon-only" aria-label="새 영상 프로젝트" disabled={!!busy} onClick={() => requestProject({ kind: "new" })}><Plus size={17} /></button></div>
        <button className="social-button subtle desktop-video-import" disabled={!!busy} onClick={() => requestProject({ kind: "import" })}><FileJson size={15} />JSON 가져오기</button>
        {listError && <p className="social-form-error" role="alert">{listError}</p>}
        {loading && projects.length === 0 ? <div className="desktop-video-library-empty" role="status"><LoaderCircle className="social-spin" size={20} />프로젝트 불러오는 중</div> : <div className="desktop-video-project-list">
          {projects.map((item) => <button key={item.id} disabled={!!busy} aria-pressed={item.id === project?.id} className={item.id === project?.id ? "selected" : ""} onClick={() => requestProject({ kind: "select", project: item })}><strong>{item.title}</strong><span>{formatLabels[item.format]} · {item.scenes.length}장면</span><small>{projectDate(item.updatedAt)} 저장</small></button>)}
          {!projects.length && <div className="desktop-video-library-empty"><Clapperboard size={25} /><span>아직 저장한 영상이 없습니다.</span><button className="social-button compact" onClick={() => requestProject({ kind: "new" })}><Plus size={14} />첫 영상 만들기</button></div>}
        </div>}
        <p className="desktop-video-library-path">{status?.dataPath ?? "프로젝트는 로컬 작업 폴더에 저장됩니다."}</p>
      </aside>

      {project && scene ? <div className="desktop-video-editor">
        <div className="desktop-video-editor-heading"><div><h2>{project.title || "제목 없는 영상"}</h2><span>{dirty ? "저장하지 않은 변경사항" : "로컬에 저장됨"} <i />{project.scenes.length}장면 · {duration.toFixed(1)}초</span></div><div><button className="social-button" disabled={!!busy || !dirty} onClick={() => void saveProject()}>{busy === "save" ? <LoaderCircle size={15} className="social-spin" /> : <Save size={15} />}저장</button><button className="social-button primary" disabled={!!busy || !canRender} onClick={() => void renderProject()}>{busy === "render" ? <LoaderCircle size={15} className="social-spin" /> : <Clapperboard size={15} />}{busy === "render" ? "MP4 출력 중" : "MP4 출력"}</button></div></div>
        <fieldset className="desktop-video-project-fields" disabled={!!busy}><legend className="social-sr-only">영상 기본 정보</legend><label>영상 제목<input value={project.title} maxLength={300} onChange={(event) => patchProject({ title: event.target.value })} /></label><div className="desktop-video-metadata"><label>출력 형식<select value={project.format} onChange={(event) => patchProject({ format: event.target.value as VideoFormat })}>{Object.entries(formatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>음성 언어<select value={project.language} onChange={(event) => patchProject({ language: event.target.value as VideoProject["language"] })}><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh">中文</option></select></label></div></fieldset>
        <div className="desktop-video-scenes-header"><h3>장면 편집</h3><button className="social-button compact subtle" disabled={!!busy || project.scenes.length >= 120} onClick={addScene}><Plus size={14} />장면 추가</button></div>
        <div className="desktop-video-timeline" role="group" aria-label="편집할 장면 선택">{project.scenes.map((item, index) => <button key={item.id} disabled={!!busy} aria-pressed={item.id === scene.id} className={item.id === scene.id ? "selected" : ""} onClick={() => setSceneId(item.id)}><small>{String(index + 1).padStart(2, "0")}</small><strong>{item.headline || "제목 없는 장면"}</strong><span><Clock3 size={11} />{item.durationSec}초{item.audioPath && <Mic size={11} aria-label="음성 연결됨" />}</span></button>)}</div>
        <fieldset className="desktop-video-scene-fields" disabled={!!busy}><legend className="social-sr-only">선택한 장면</legend><div className="desktop-video-scene-label"><strong>장면 {project.scenes.findIndex((item) => item.id === scene.id) + 1}</strong><button type="button" className="social-button compact subtle" disabled={project.scenes.length <= 1} onClick={removeScene}><Trash2 size={13} />장면 삭제</button></div><label>제목<input value={scene.headline} maxLength={10000} placeholder="이 장면에서 전달할 한 문장" onChange={(event) => patchScene({ headline: event.target.value })} /></label><label>화면 본문<textarea value={scene.body} maxLength={10000} rows={3} placeholder="화면에 표시할 설명" onChange={(event) => patchScene({ body: event.target.value })} /></label><div className="desktop-video-narration-label"><label htmlFor="desktop-video-narration">내레이션</label><button className="social-button compact" disabled={!status?.ttsConfigured || !scene.narration.trim()} onClick={() => void generateVoice()}>{busy === "voice" ? <LoaderCircle size={13} className="social-spin" /> : <Mic size={13} />}{busy === "voice" ? "음성 생성 중" : "이 장면 음성 생성"}</button></div><textarea id="desktop-video-narration" value={scene.narration} maxLength={10000} rows={4} placeholder="Qwen 로컬 TTS로 읽을 문장" onChange={(event) => patchScene({ narration: event.target.value })} /><div className="desktop-video-scene-bottom"><label>장면 길이 (초)<input type="number" min={.1} max={600} step={.1} value={scene.durationSec} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) patchScene({ durationSec: value }); }} /></label><div>{scene.audioPath ? <><strong><Mic size={13} />로컬 음성 연결됨</strong><code>{scene.audioPath}</code><button className="social-button compact subtle" onClick={() => patchScene({ audioPath: undefined })}>음성 연결 해제</button></> : <p>장면 음성 생성은 연결된 Qwen 서비스에서 추론합니다. macOS의 MLX 실행 여부는 해당 로컬 서비스 설정을 따릅니다.</p>}</div></div>{(scene.mediaUrl || scene.captionCues?.length) && <p className="social-form-hint">원본 미디어·자막 설정을 보존합니다.{scene.mediaUrl ? ` 미디어: ${scene.mediaUrl}` : ""}{scene.captionCues?.length ? ` · 자막 ${scene.captionCues.length}개` : ""}</p>}</fieldset>
        {!canRender && status && <p className="social-form-hint desktop-video-render-hint">MP4 출력에는 로컬 FFmpeg·FFprobe와 자막 글꼴이 필요합니다. 설치 또는 경로 설정 후 상태를 다시 확인하세요.</p>}
        {busy === "render" && <p className="desktop-video-progress" role="status"><LoaderCircle size={15} className="social-spin" />프로젝트를 저장하고 장면을 MP4로 합치고 있습니다. 영상 길이에 따라 수 분이 걸릴 수 있습니다.</p>}
        {render && <div className="desktop-video-output"><Check size={20} /><div><strong>MP4 출력 완료</strong><span>{formatLabels[render.format]} · {render.durationSec.toFixed(1)}초</span><code>{render.path}</code>{renderStale && <small>출력 이후 변경사항이 있습니다. 최신 편집 내용은 다시 출력하세요.</small>}</div><button className="social-button" disabled={!!busy} onClick={() => void openRender()}><FolderOpen size={16} />영상 열기</button></div>}
      </div> : <div className="social-empty desktop-video-start"><Clapperboard size={34} /><strong>장면에서 시작하는 내 영상</strong><p>기존 프로젝트를 선택하거나 새 영상을 만드세요. 제목과 내레이션을 직접 다듬고 로컬에서 MP4를 출력할 수 있습니다.</p><button className="social-button primary" disabled={!!busy || loading} onClick={() => requestProject({ kind: "new" })}><Plus size={16} />새 영상 만들기</button></div>}
    </div>

    <dialog ref={importDialog} className="social-dialog" aria-labelledby="desktop-video-import-title" onCancel={(event) => { if (busy) event.preventDefault(); else setImportOpen(false); }} onClose={() => setImportOpen(false)}><div className="social-dialog-header"><div><h2 id="desktop-video-import-title">영상 프로젝트 JSON 가져오기</h2><p>프로젝트 한 개를 입력하세요. 새 프로젝트로 저장됩니다.</p></div><button className="social-dismiss" disabled={!!busy} aria-label="JSON 가져오기 닫기" onClick={() => setImportOpen(false)}><X size={20} /></button></div><label htmlFor="desktop-video-import-json">VideoProject JSON</label><textarea id="desktop-video-import-json" rows={14} spellCheck={false} value={importJson} disabled={!!busy} onChange={(event) => setImportJson(event.target.value)} placeholder={'{"title":"내 영상","format":"youtube-landscape",...}'} />{importError && <p className="social-form-error" role="alert">{importError}</p>}<div className="social-dialog-actions"><button className="social-button" disabled={!!busy} onClick={() => setImportOpen(false)}>취소</button><button className="social-button primary" disabled={!!busy || !importJson.trim()} onClick={() => void importProject()}>{busy === "import" ? <LoaderCircle size={16} className="social-spin" /> : <FileJson size={16} />}가져와 저장</button></div></dialog>
    <dialog ref={changesDialog} className="social-dialog small" aria-labelledby="desktop-video-changes-title" onCancel={(event) => { if (busy) event.preventDefault(); else setPending(null); }} onClose={() => setPending(null)}><div className="social-dialog-header"><div><h2 id="desktop-video-changes-title">편집 내용을 저장할까요?</h2><p>현재 영상에 저장하지 않은 변경사항이 있습니다.</p></div></div>{notice?.tone === "error" && <p className="social-form-error" role="alert">{notice.text}</p>}<div className="social-dialog-actions desktop-video-changes-actions"><button className="social-button" disabled={!!busy} onClick={() => setPending(null)}>계속 편집</button><button className="social-button" disabled={!!busy} onClick={() => pending && applyPending(pending)}>변경사항 버리기</button><button className="social-button primary" disabled={!!busy} onClick={() => void saveAndContinue()}>{busy === "save" ? <LoaderCircle size={16} className="social-spin" /> : <Save size={16} />}저장 후 이동</button></div></dialog>
  </section>;
}
