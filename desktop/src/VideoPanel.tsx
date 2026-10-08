import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRight, BookOpen, Check, CircleAlert, Clapperboard, Clock3, ExternalLink, FileJson, FolderOpen,
  Hash, LoaderCircle, Mic, Plus, RefreshCw, Save, Search, Sparkles, Trash2, X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VideoFormat, VideoProject, VideoScene } from "../../lib/video/types";
import { External } from "./External";
import type { ResearchVideoProject, VideoResearchMetadata, VideoResearchPreview, VideoResearchProvider, VideoResearchResult, VideoResearchSeed, VideoResearchSource } from "./video-research";
import "./VideoPanel.css";

type MediaStatus = {
  ffmpegAvailable: boolean; ffprobeAvailable: boolean; fontAvailable: boolean;
  ttsConfigured: boolean; dataPath: string; renderer: string;
};
type RenderResult = { path: string; durationSec: number; format: VideoFormat; renderer: string };
type VoiceResult = { audioPath: string; durationSec: number; sampleRate: number; speaker: string; provider: string };
type PendingProject = { kind: "new" } | { kind: "select"; project: ResearchVideoProject } | { kind: "import" } | { kind: "research"; seed: VideoResearchSeed };
type Notice = { text: string; tone: "success" | "error" | "info" };
type AiStatus = { providers: Array<{ id: string; label: string; available: boolean; detail: string }>; defaultProvider: string | null };
type Props = { active: boolean; researchSeed?: VideoResearchSeed | null; onResearchSeedHandled?: (requestId: string) => void; onOpenKeywords?: () => void };
const sourceLabels: Record<string, string> = { youtube: "YouTube", naver_blog: "네이버 블로그", google_trends: "Google 트렌드" };
const aiProviders = ["opencodex", "teamclaude", "claude-cli"] as const;

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

function sourceLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function researchMetadata(value: unknown): VideoResearchMetadata | null {
  if (!value || typeof value !== "object") return null;
  const metadata = value as Partial<VideoResearchMetadata>;
  if (metadata.version !== 1 || typeof metadata.keyword !== "string" || typeof metadata.topic !== "string" || typeof metadata.provider !== "string" || !Array.isArray(metadata.sources) || metadata.sources.length > 5) return null;
  return metadata.sources.every((source) => source && typeof source.trendId === "string" && typeof source.title === "string" && typeof source.source === "string" && Object.hasOwn(sourceLabels, source.source) && typeof source.url === "string" && typeof source.fetchedAt === "string" && (source.description == null || typeof source.description === "string")) ? metadata as VideoResearchMetadata : null;
}

function ResearchSources({ sources }: { sources: VideoResearchSource[] }) {
  return <div className="desktop-video-research-sources">{sources.map((source) => <article key={source.trendId}><div><span>{sourceLabels[source.source] ?? source.source}</span><time dateTime={source.fetchedAt}>{projectDate(source.fetchedAt)} 수집</time></div><strong>{source.title}</strong><p>{source.description || "원본에 설명이 없습니다. 제목과 출처를 확인하세요."}</p><External url={sourceLink(source.url)}><ExternalLink size={12} />원본 확인</External></article>)}</div>;
}

export function VideoPanel({ active, researchSeed, onResearchSeedHandled, onOpenKeywords }: Props) {
  const [projects, setProjects] = useState<ResearchVideoProject[]>([]);
  const [project, setProject] = useState<ResearchVideoProject | null>(null);
  const [baseline, setBaseline] = useState("");
  const [sceneId, setSceneId] = useState("");
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState<"save" | "render" | "voice" | "import" | "open" | "research" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [render, setRender] = useState<RenderResult | null>(null);
  const [renderVersion, setRenderVersion] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState("");
  const [pending, setPending] = useState<PendingProject | null>(null);
  const [research, setResearch] = useState<VideoResearchSeed | null>(null);
  const [preview, setPreview] = useState<VideoResearchPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [researchTopic, setResearchTopic] = useState("");
  const [researchKeyword, setResearchKeyword] = useState("");
  const [researchFormat, setResearchFormat] = useState<VideoFormat>("shorts");
  const [researchProvider, setResearchProvider] = useState<VideoResearchProvider>("local");
  const [researchWarnings, setResearchWarnings] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus>({ providers: [], defaultProvider: null });
  const [aiStatusError, setAiStatusError] = useState("");
  const [aiChecking, setAiChecking] = useState(false);
  const importDialog = useRef<HTMLDialogElement>(null);
  const changesDialog = useRef<HTMLDialogElement>(null);
  const initialized = useRef(false);
  const selectedProject = useRef<ResearchVideoProject | null>(null);
  const selectionVersion = useRef(0);
  const previewVersion = useRef(0);
  const acceptedSeeds = useRef(new Set<string>());
  const activeResearch = useRef<VideoResearchSeed | null>(null);
  const onSeedHandled = useRef(onResearchSeedHandled);
  onSeedHandled.current = onResearchSeedHandled;
  selectedProject.current = project;
  const scene = project?.scenes.find((item) => item.id === sceneId) ?? project?.scenes[0];
  const dirty = project !== null && JSON.stringify(project) !== baseline;
  const renderStale = !!render && JSON.stringify(project) !== renderVersion;
  const duration = useMemo(() => project?.scenes.reduce((sum, item) => sum + item.durationSec, 0) ?? 0, [project]);
  const projectResearch = researchMetadata(project?.research);
  const canRender = !!project && !!status?.ffmpegAvailable && !!status.ffprobeAvailable && !!status.fontAvailable;

  const checkStatus = useCallback(async () => {
    setStatusError("");
    try { setStatus(await invoke<MediaStatus>("media_status")); }
    catch (error) { setStatus(null); setStatusError(message(error)); }
  }, []);

  const checkAi = useCallback(async () => {
    setAiChecking(true); setAiStatusError("");
    try { setAiStatus(await invoke<AiStatus>("ai_status")); }
    catch (error) { setAiStatus({ providers: [], defaultProvider: null }); setAiStatusError(message(error)); }
    finally { setAiChecking(false); }
  }, []);

  const loadProjects = useCallback(async () => {
    const version = selectionVersion.current;
    setLoading(true); setListError("");
    try {
      const saved = await invoke<ResearchVideoProject[]>("video_list_projects");
      setProjects((current) => version === selectionVersion.current ? saved : [...current, ...saved.filter((item) => !current.some((existing) => existing.id === item.id))]);
      if (version === selectionVersion.current && !selectedProject.current && !activeResearch.current && saved.length) {
        selectedProject.current = saved[0];
        setProject(saved[0]); setBaseline(JSON.stringify(saved[0]));
        setSceneId(saved[0].scenes[0]?.id ?? "");
      }
    } catch (error) { setListError(message(error)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (active && !initialized.current) {
      initialized.current = true;
      void loadProjects(); void checkStatus(); void checkAi();
    }
  }, [active, loadProjects, checkStatus, checkAi]);

  useEffect(() => {
    if (!active || !researchSeed || busy || pending || importOpen || acceptedSeeds.current.has(researchSeed.requestId)) return;
    acceptedSeeds.current.add(researchSeed.requestId);
    if (dirty) setPending({ kind: "research", seed: researchSeed });
    else applyPending({ kind: "research", seed: researchSeed });
    onSeedHandled.current?.(researchSeed.requestId);
  }, [active, researchSeed, busy, pending, importOpen, dirty]);

  useEffect(() => () => { previewVersion.current += 1; selectionVersion.current += 1; }, []);

  useEffect(() => {
    if (importOpen) importDialog.current?.showModal();
    else importDialog.current?.close();
  }, [importOpen]);
  useEffect(() => {
    if (pending) changesDialog.current?.showModal();
    else changesDialog.current?.close();
  }, [pending]);

  function clearResearch() {
    previewVersion.current += 1;
    activeResearch.current = null;
    setResearch(null); setPreview(null); setPreviewLoading(false); setPreviewError(""); setResearchWarnings([]);
  }

  function selectProject(next: ResearchVideoProject, saved = true) {
    selectionVersion.current += 1; selectedProject.current = next; clearResearch();
    setProject(next); setSceneId(next.scenes[0]?.id ?? "");
    setBaseline(saved ? JSON.stringify(next) : ""); setRender(null); setNotice(null);
  }

  function applyPending(action: PendingProject) {
    setPending(null);
    if (action.kind === "new") selectProject(blankProject(), false);
    else if (action.kind === "select") selectProject(action.project);
    else if (action.kind === "research") {
      selectionVersion.current += 1; selectedProject.current = null;
      activeResearch.current = action.seed;
      setProject(null); setBaseline(""); setRender(null); setNotice(null);
      setResearch(action.seed); setResearchKeyword(action.seed.keyword ?? ""); setResearchTopic(action.seed.topic ?? "");
      setResearchProvider("local"); setResearchFormat("shorts"); setResearchWarnings([]);
      void loadResearchPreview(action.seed);
    }
    else { setImportError(""); setImportOpen(true); }
  }

  async function loadResearchPreview(seed: VideoResearchSeed) {
    const version = ++previewVersion.current;
    setPreview(null); setPreviewLoading(true); setPreviewError("");
    try {
      const result = await invoke<VideoResearchPreview>("video_research_preview", {
        input: { trendIds: seed.trendIds, keyword: seed.keyword, topic: seed.topic }
      });
      if (version !== previewVersion.current) return;
      setPreview(result);
      if (!seed.keyword) setResearchKeyword(result.keyword);
      if (!seed.topic) setResearchTopic(result.topic);
    } catch (error) { if (version === previewVersion.current) setPreviewError(message(error)); }
    finally { if (version === previewVersion.current) setPreviewLoading(false); }
  }

  async function createResearchProject() {
    if (!research || !preview?.sources.length || busy) return;
    if (researchProvider !== "local" && !aiStatus.providers.some((provider) => provider.id === researchProvider && provider.available)) {
      setNotice({ tone: "error", text: "선택한 AI 연결을 확인하거나 기본 초안을 선택하세요." }); return;
    }
    setBusy("research"); setNotice(null); setResearchWarnings([]);
    try {
      const result = await invoke<VideoResearchResult>("video_create_research_project", {
        input: { trendIds: research.trendIds, keyword: researchKeyword.trim(), topic: researchTopic.trim(), format: researchFormat, provider: researchProvider }
      });
      clearResearch(); rememberSaved(result.project); setSceneId(result.project.scenes[0]?.id ?? ""); setRender(null);
      setResearchWarnings(result.warnings);
      const providerLabel = result.provider === "local" ? "로컬 기본 초안" : aiStatus.providers.find((provider) => provider.id === result.provider)?.label ?? result.provider;
      setNotice({ tone: result.warnings.length ? "info" : "success", text: `${providerLabel}으로 새 영상 프로젝트를 만들고 저장했습니다. 장면과 출처를 검토한 뒤 MP4로 출력하세요.` });
    } catch (error) { setNotice({ tone: "error", text: message(error) }); }
    finally { setBusy(null); }
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

  function rememberSaved(saved: ResearchVideoProject) {
    selectionVersion.current += 1; selectedProject.current = saved;
    setProjects((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    setProject(saved); setBaseline(JSON.stringify(saved));
  }

  async function saveProject(): Promise<boolean> {
    if (!project) return false;
    setBusy("save"); setNotice(null);
    try {
      const saved = await invoke<ResearchVideoProject>("video_save_project", { input: project });
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
      const saved = await invoke<ResearchVideoProject>("video_save_project", { input: project });
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
      const saved = await invoke<ResearchVideoProject>("video_save_project", {
        input: { ...parsed, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
      });
      rememberSaved(saved); setSceneId(saved.scenes[0]?.id ?? ""); setRender(null);
      clearResearch();
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
      <button className="social-button compact" disabled={!!busy || loading} onClick={() => { void checkStatus(); void loadProjects(); void checkAi(); }}><RefreshCw size={14} />상태 확인</button>
    </div>
    <div className="desktop-video-status" aria-label="영상 처리 환경">
      <span className={status?.ffmpegAvailable ? "ready" : ""}>FFmpeg {status ? status.ffmpegAvailable ? "준비됨" : "없음" : "확인 필요"}</span>
      <span className={status?.fontAvailable ? "ready" : ""}>자막 글꼴 {status ? status.fontAvailable ? "준비됨" : "없음" : "확인 필요"}</span>
      <span className={status?.ttsConfigured ? "ready" : ""}>Qwen 로컬 TTS {status ? status.ttsConfigured ? "주소 설정됨" : "연결 미설정" : "확인 필요"}</span>
      {status && !status.ffprobeAvailable && <span>FFprobe 없음</span>}
    </div>
    {statusError && <p className="social-form-error" role="alert">처리 환경: {statusError}</p>}
    {notice && <div className={`social-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "success" ? <Check size={17} /> : <CircleAlert size={17} />}<span>{notice.text}</span><button className="social-dismiss" aria-label="영상 알림 닫기" onClick={() => setNotice(null)}><X size={15} /></button></div>}
    {researchWarnings.length > 0 && <div className="desktop-video-research-warnings" role="status"><CircleAlert size={16} /><div><strong>초안 생성 안내</strong>{researchWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}

    <ol className="desktop-video-flow" aria-label="영상 제작 단계"><li className={research ? "current" : ""}><span>01</span><strong>소재·출처 확인</strong></li><li className={project && !render ? "current" : ""}><span>02</span><strong>초안·장면 편집</strong></li><li className={render ? "current" : ""}><span>03</span><strong>MP4 출력</strong></li></ol>

    {research && <section className="desktop-video-research" aria-labelledby="desktop-video-research-title" aria-busy={previewLoading || busy === "research"}>
      <div className="desktop-video-research-heading"><div><span><BookOpen size={14} />트렌드 → 내 영상</span><h2 id="desktop-video-research-title">선택한 자료로 영상 기획하기</h2><p>로컬 DB의 원본 정보를 확인합니다. 생성 버튼을 누르기 전에는 AI에 자료를 보내지 않습니다.</p></div><button type="button" className="social-dismiss" disabled={!!busy} aria-label="영상 소재 닫기" onClick={clearResearch}><X size={19} /></button></div>
      {previewLoading && <p className="desktop-video-research-loading" role="status"><LoaderCircle size={18} className="social-spin" />저장된 콘텐츠와 출처를 확인하고 있습니다.</p>}
      {previewError && <div className="desktop-video-research-error" role="alert"><p>{previewError}</p><button className="social-button compact" disabled={!!busy} onClick={() => void loadResearchPreview(research)}><RefreshCw size={14} />소재 다시 확인</button><button className="social-button compact" disabled={!!busy} onClick={onOpenKeywords}><Search size={14} />키워드 탐색으로 이동</button></div>}
      {preview && <>
        <div className="desktop-video-research-source-heading"><strong>영상의 근거 자료 <span>{preview.sources.length}개</span></strong><small>새 프로젝트에 제목·설명·출처가 함께 저장됩니다.</small></div>
        <ResearchSources sources={preview.sources} />
        {preview.warnings.length > 0 && <div className="desktop-video-research-warnings">{preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        <fieldset className="desktop-video-research-fields" disabled={!!busy}><legend className="social-sr-only">영상 기획 설정</legend>
          <label>영상 주제<input value={researchTopic} maxLength={300} placeholder="영상에서 다룰 주제" onChange={(event) => setResearchTopic(event.target.value)} /></label>
          <div className="desktop-video-research-grid"><label><span><Hash size={12} />관심 키워드</span><input value={researchKeyword} maxLength={100} placeholder="예: AI 생산성" onChange={(event) => setResearchKeyword(event.target.value)} /></label><label>영상 형식<select value={researchFormat} onChange={(event) => setResearchFormat(event.target.value as VideoFormat)}>{Object.entries(formatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <label>초안 생성 방식<select value={researchProvider} onChange={(event) => setResearchProvider(event.target.value as VideoResearchProvider)}><option value="local">기본 초안 · AI 없이 로컬에서 생성</option>{aiProviders.map((id) => { const provider = aiStatus.providers.find((item) => item.id === id); return <option key={id} value={id} disabled={!provider?.available}>{provider?.label ?? (id === "opencodex" ? "OpenCodex" : id === "teamclaude" ? "TeamClaude" : "Claude Code")} · {provider?.available ? "연결됨" : "연결 필요"}</option>; })}</select></label>
        </fieldset>
        <div className="desktop-video-research-mode-note"><span>{researchProvider === "local" ? <BookOpen size={16} /> : <Sparkles size={16} />}</span><p>{researchProvider === "local" ? "제목·설명에서 기본 장면과 내레이션을 구성합니다. 외부 AI나 원본 미디어를 다운로드하지 않습니다." : `선택한 ${aiStatus.providers.find((item) => item.id === researchProvider)?.label ?? researchProvider}에 주제와 근거 자료를 보내 대본을 만듭니다. 연결 서비스의 사용량이 적용되며, AI 생성에 실패하면 기본 초안과 안내를 표시합니다.`}</p></div>
        {aiStatusError && <p className="social-form-error" role="alert">AI 연결 확인: {aiStatusError} 기본 초안은 사용할 수 있습니다.</p>}
        <div className="desktop-video-research-actions"><button type="button" className="social-button compact" disabled={!!busy || aiChecking} onClick={() => void checkAi()}>{aiChecking ? <LoaderCircle size={14} className="social-spin" /> : <RefreshCw size={14} />}AI 연결 확인</button><button type="button" className="social-button primary" disabled={!!busy || !preview.sources.length || !researchTopic.trim()} onClick={() => void createResearchProject()}>{busy === "research" ? <LoaderCircle size={16} className="social-spin" /> : researchProvider === "local" ? <Clapperboard size={16} /> : <Sparkles size={16} />}{busy === "research" ? "초안 생성·저장 중" : researchProvider === "local" ? "기본 영상 초안 생성" : "AI로 영상 대본 생성"}<ArrowRight size={15} /></button></div>
        {busy === "research" && <p className="desktop-video-research-loading" role="status">새 프로젝트를 생성해 로컬에 저장합니다. 완료되면 장면 편집기가 열립니다.</p>}
      </>}
    </section>}

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
        {projectResearch && <details className="desktop-video-saved-research"><summary><BookOpen size={15} />영상 기획에 사용한 자료 {projectResearch.sources.length}개 <span>{projectResearch.provider === "local" ? "기본 초안" : projectResearch.provider}</span></summary><p><Hash size={12} />{projectResearch.keyword || "키워드 미지정"} · {projectResearch.topic}</p><ResearchSources sources={projectResearch.sources} /><p className="desktop-video-source-review">원문 사실과 표현을 검토하고 내 관점으로 편집하세요. 원본 미디어는 복사되지 않았습니다.</p></details>}
        <div className="desktop-video-scenes-header"><h3>장면 편집</h3><button className="social-button compact subtle" disabled={!!busy || project.scenes.length >= 120} onClick={addScene}><Plus size={14} />장면 추가</button></div>
        <div className="desktop-video-timeline" role="group" aria-label="편집할 장면 선택">{project.scenes.map((item, index) => <button key={item.id} disabled={!!busy} aria-pressed={item.id === scene.id} className={item.id === scene.id ? "selected" : ""} onClick={() => setSceneId(item.id)}><small>{String(index + 1).padStart(2, "0")}</small><strong>{item.headline || "제목 없는 장면"}</strong><span><Clock3 size={11} />{item.durationSec}초{item.audioPath && <Mic size={11} aria-label="음성 연결됨" />}</span></button>)}</div>
        <fieldset className="desktop-video-scene-fields" disabled={!!busy}><legend className="social-sr-only">선택한 장면</legend><div className="desktop-video-scene-label"><strong>장면 {project.scenes.findIndex((item) => item.id === scene.id) + 1}</strong><button type="button" className="social-button compact subtle" disabled={project.scenes.length <= 1} onClick={removeScene}><Trash2 size={13} />장면 삭제</button></div><label>제목<input value={scene.headline} maxLength={10000} placeholder="이 장면에서 전달할 한 문장" onChange={(event) => patchScene({ headline: event.target.value })} /></label><label>화면 본문<textarea value={scene.body} maxLength={10000} rows={3} placeholder="화면에 표시할 설명" onChange={(event) => patchScene({ body: event.target.value })} /></label><div className="desktop-video-narration-label"><label htmlFor="desktop-video-narration">내레이션</label><button className="social-button compact" disabled={!status?.ttsConfigured || !scene.narration.trim()} onClick={() => void generateVoice()}>{busy === "voice" ? <LoaderCircle size={13} className="social-spin" /> : <Mic size={13} />}{busy === "voice" ? "음성 생성 중" : "이 장면 음성 생성"}</button></div><textarea id="desktop-video-narration" value={scene.narration} maxLength={10000} rows={4} placeholder="Qwen 로컬 TTS로 읽을 문장" onChange={(event) => patchScene({ narration: event.target.value })} /><div className="desktop-video-scene-bottom"><label>장면 길이 (초)<input type="number" min={.1} max={600} step={.1} value={scene.durationSec} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) patchScene({ durationSec: value }); }} /></label><div>{scene.audioPath ? <><strong><Mic size={13} />로컬 음성 연결됨</strong><code>{scene.audioPath}</code><button className="social-button compact subtle" onClick={() => patchScene({ audioPath: undefined })}>음성 연결 해제</button></> : <p>장면 음성 생성은 연결된 Qwen 서비스에서 추론합니다. macOS의 MLX 실행 여부는 해당 로컬 서비스 설정을 따릅니다.</p>}</div></div>{scene.sourceLabel && <div className="desktop-video-scene-source"><BookOpen size={13} /><span>이 장면의 근거: {scene.sourceLabel}</span>{scene.sourceUrl && <External url={sourceLink(scene.sourceUrl)}><ExternalLink size={12} />원본 확인</External>}</div>}{(scene.mediaUrl || scene.captionCues?.length) && <p className="social-form-hint">원본 미디어·자막 설정을 보존합니다.{scene.mediaUrl ? ` 미디어: ${scene.mediaUrl}` : ""}{scene.captionCues?.length ? ` · 자막 ${scene.captionCues.length}개` : ""}</p>}</fieldset>
        {!canRender && status && <p className="social-form-hint desktop-video-render-hint">MP4 출력에는 로컬 FFmpeg·FFprobe와 자막 글꼴이 필요합니다. 설치 또는 경로 설정 후 상태를 다시 확인하세요.</p>}
        {busy === "render" && <p className="desktop-video-progress" role="status"><LoaderCircle size={15} className="social-spin" />프로젝트를 저장하고 장면을 MP4로 합치고 있습니다. 영상 길이에 따라 수 분이 걸릴 수 있습니다.</p>}
        {render && <div className="desktop-video-output"><Check size={20} /><div><strong>MP4 출력 완료</strong><span>{formatLabels[render.format]} · {render.durationSec.toFixed(1)}초</span><code>{render.path}</code>{renderStale && <small>출력 이후 변경사항이 있습니다. 최신 편집 내용은 다시 출력하세요.</small>}</div><button className="social-button" disabled={!!busy} onClick={() => void openRender()}><FolderOpen size={16} />영상 열기</button></div>}
      </div> : <div className={`social-empty desktop-video-start ${research ? "with-research" : ""}`}><Clapperboard size={34} /><strong>{research ? "소재를 확인하면 장면 편집으로 이어집니다" : "트렌드에서 시작하는 내 영상"}</strong><p>{research ? "위에서 형식과 초안 생성 방식을 선택하세요. 생성된 프로젝트는 로컬에 저장되며 장면별로 수정할 수 있습니다." : "키워드 탐색에서 콘텐츠를 선택해 근거가 있는 영상 초안을 만들거나, 새 장면을 직접 편집하세요."}</p>{!research && <div className="desktop-video-start-actions">{onOpenKeywords && <button className="social-button primary" disabled={!!busy || loading} onClick={onOpenKeywords}><Search size={16} />키워드로 소재 찾기</button>}<button className="social-button" disabled={!!busy || loading} onClick={() => requestProject({ kind: "new" })}><Plus size={16} />직접 새 영상 만들기</button></div>}</div>}
    </div>

    <dialog ref={importDialog} className="social-dialog" aria-labelledby="desktop-video-import-title" onCancel={(event) => { if (busy) event.preventDefault(); else setImportOpen(false); }} onClose={() => setImportOpen(false)}><div className="social-dialog-header"><div><h2 id="desktop-video-import-title">영상 프로젝트 JSON 가져오기</h2><p>프로젝트 한 개를 입력하세요. 새 프로젝트로 저장됩니다.</p></div><button className="social-dismiss" disabled={!!busy} aria-label="JSON 가져오기 닫기" onClick={() => setImportOpen(false)}><X size={20} /></button></div><label htmlFor="desktop-video-import-json">VideoProject JSON</label><textarea id="desktop-video-import-json" rows={14} spellCheck={false} value={importJson} disabled={!!busy} onChange={(event) => setImportJson(event.target.value)} placeholder={'{"title":"내 영상","format":"youtube-landscape",...}'} />{importError && <p className="social-form-error" role="alert">{importError}</p>}<div className="social-dialog-actions"><button className="social-button" disabled={!!busy} onClick={() => setImportOpen(false)}>취소</button><button className="social-button primary" disabled={!!busy || !importJson.trim()} onClick={() => void importProject()}>{busy === "import" ? <LoaderCircle size={16} className="social-spin" /> : <FileJson size={16} />}가져와 저장</button></div></dialog>
    <dialog ref={changesDialog} className="social-dialog small" aria-labelledby="desktop-video-changes-title" onCancel={(event) => { if (busy) event.preventDefault(); else setPending(null); }} onClose={() => setPending(null)}><div className="social-dialog-header"><div><h2 id="desktop-video-changes-title">편집 내용을 저장할까요?</h2><p>현재 영상에 저장하지 않은 변경사항이 있습니다.</p></div></div>{notice?.tone === "error" && <p className="social-form-error" role="alert">{notice.text}</p>}<div className="social-dialog-actions desktop-video-changes-actions"><button className="social-button" disabled={!!busy} onClick={() => setPending(null)}>계속 편집</button><button className="social-button" disabled={!!busy} onClick={() => pending && applyPending(pending)}>변경사항 버리기</button><button className="social-button primary" disabled={!!busy} onClick={() => void saveAndContinue()}>{busy === "save" ? <LoaderCircle size={16} className="social-spin" /> : <Save size={16} />}저장 후 이동</button></div></dialog>
  </section>;
}
