import { MotionStudio } from "./motion/MotionStudio";
import { ProductionStudio } from "./production/ProductionStudio";
import { Channel, invoke } from "@tauri-apps/api/core";
import { openRenderPreview } from "./native-windows";
import {
  ArrowRight, BookOpen, Check, CircleAlert, Clapperboard, Clock3, Copy, Download, ExternalLink, FileJson, FolderOpen,
  Hash, LoaderCircle, Mic, Play, Plus, RefreshCw, Save, Search, Sparkles, Trash2, WandSparkles, X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { VideoFormat, VideoProject, VideoScene } from "../../lib/video/types";
import { External } from "./External";
import { CreationInbox } from "./ChatGPTHandoff";
import { aiStatus as readAiStatus, contentReady, modelLabel } from "./ai-client";
import type { VideoResearchMetadata, VideoResearchPreview, VideoResearchProvider, VideoResearchResult, VideoResearchSeed, VideoResearchSource } from "./video-research";
import { ideaCategories, ideaProviderOf, motionPresets, readIdeaMetadata, readMotion, transitions, parseChart, chartText, type VideoTransition, type StudioVideoProject, type StudioVideoScene, type VideoIdeaCategory, type VideoIdeaInput, type VideoIdeaProvider, type VideoIdeaResult, type VideoMotionPreset } from "./video-idea";
import { createRenderProgressSession, initialRenderProgress, VideoRenderProgress, type VideoRenderProgressMessage } from "./video-render-progress";
import { VideoTemplateGallery } from "./VideoTemplateGallery";
import { readVideoTemplateCatalog, readVideoTemplateLibrary, readVideoTemplatePreview, type VideoTemplateDescriptor, type VideoTemplateLibrary, type VideoTemplatePreview } from "./video-templates";
import { duplicateVideoProject } from "./video-project-actions";
import { createSingleFlight } from "./desktop-interactions";
import "./VideoPanel.css";
import { applyGeneratedSceneVoice, generateSceneVoices, type GeneratedSceneVoice } from "../../lib/video/voice-generation";
import { DEFAULT_VOICE, VOICE_EMPHASIS, VOICE_QUALITY, VOICE_SPEAKERS, VOICE_STYLES, type VoiceSettings } from "../../lib/video/voice-options";
import { LocalVoice } from "./LocalVoice";

type MediaStatus = {
  ffmpegAvailable: boolean; ffprobeAvailable: boolean; fontAvailable: boolean;
  ttsConfigured: boolean; dataPath: string; renderer: string;
};
type RenderResult = { path: string; durationSec: number; format: VideoFormat; renderer: string };
type PendingProject = { kind: "new" } | { kind: "select"; project: StudioVideoProject } | { kind: "import" } | { kind: "research"; seed: VideoResearchSeed } | { kind: "template" | "duplicate"; project: StudioVideoProject };
type Notice = { text: string; tone: "success" | "error" | "info" };
type RenderOperation = { channel: Channel<VideoRenderProgressMessage> | null; session: ReturnType<typeof createRenderProgressSession> | null };
type AiStatus = { providers: Array<{ id: string; label: string; available: boolean; detail: string }>; defaultProvider: string | null };
type Props = { active: boolean; researchSeed?: VideoResearchSeed | null; onResearchSeedHandled?: (requestId: string) => void; onOpenKeywords?: () => void; onOpenSettings?: () => void };
/** A finished AI production handed to the editor as its own saved project. */
type EditorHandoff = { requestId: number; project: Record<string, unknown> };
const sourceLabels: Record<string, string> = { youtube: "YouTube", naver_blog: "네이버 블로그", google_trends: "Google 트렌드" };
const aiProviders = ["agent-model"] as const;

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
  return metadata.sources.every((source) => source && typeof source.trendId === "string" && typeof source.title === "string" && typeof source.source === "string" && Object.prototype.hasOwnProperty.call(sourceLabels, source.source) && typeof source.url === "string" && typeof source.fetchedAt === "string" && (source.description == null || typeof source.description === "string")) ? metadata as VideoResearchMetadata : null;
}

function ResearchSources({ sources }: { sources: VideoResearchSource[] }) {
  return <div className="desktop-video-research-sources">{sources.map((source) => <article key={source.trendId}><div><span>{sourceLabels[source.source] ?? source.source}</span><time dateTime={source.fetchedAt}>{projectDate(source.fetchedAt)} 수집</time></div><strong>{source.title}</strong><p>{source.description || "원본에 설명이 없습니다. 제목과 출처를 확인하세요."}</p><External url={sourceLink(source.url)}><ExternalLink size={12} />원본 확인</External></article>)}</div>;
}

function MotionPreview({ scene, format, active, disabled }: { scene: StudioVideoScene; format: VideoFormat; active: boolean; disabled: boolean }) {
  const motion = readMotion(scene.motion);
  const [playing, setPlaying] = useState(false);
  const [take, setTake] = useState(0);
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { setReduced(query.matches); setPlaying(false); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => { setPlaying(false); }, [scene.id, motion?.preset, motion?.intensity, active, reduced, disabled]);
  useEffect(() => {
    if (!playing) return;
    const stop = window.setTimeout(() => setPlaying(false), 2400);
    return () => window.clearTimeout(stop);
  }, [playing, take]);
  const accent = /^#[0-9a-f]{6}$/i.test(scene.accent ?? "") ? scene.accent : "#8AE3BB";
  const style = { "--motion-intensity": motion?.intensity ?? 0, "--motion-accent": accent } as CSSProperties;
  return <div className="desktop-video-motion-preview">
    <div className="desktop-video-motion-preview-heading"><strong>선택한 장면 미리보기</strong><button type="button" className="social-button compact" disabled={disabled || !active || !motion || motion.intensity === 0 || reduced} onClick={() => { setTake((current) => current + 1); setPlaying(true); }}><Play size={13} />{playing ? "다시 재생" : "모션 재생"}</button></div>
    <div key={`${scene.id}-${take}`} className={`desktop-video-motion-stage ${format === "youtube-landscape" ? "landscape" : "portrait"} ${motion?.preset ?? "still"} ${playing && active && !reduced ? "playing" : ""}`} style={style} aria-label={`${motion ? motionPresets[motion.preset].label : "정지 장면"} 미리보기`}>
      <div className="desktop-video-motion-grid" aria-hidden="true" /><div className="desktop-video-motion-halo" aria-hidden="true" />
      {motion?.preset === "orbit-cards" && <div className="desktop-video-motion-orbit" aria-hidden="true"><span>01</span><span>02</span><span>03</span></div>}
      <div className="desktop-video-motion-copy"><small>SCENE / {String(scene.role ?? "point").toUpperCase()}</small><h4>{scene.headline || "장면 제목을 입력하세요"}</h4><p>{scene.body || "이곳에 장면 본문이 표시됩니다."}</p></div>
    </div>
    <p className="desktop-video-motion-preview-note">{reduced ? "시스템의 모션 감소 설정에 따라 정지 화면을 표시합니다." : motion ? motionPresets[motion.preset].detail : "모션을 선택하면 이 장면의 움직임을 확인할 수 있습니다."} 미리보기의 배치와 최종 MP4의 배치는 화면 비율에 따라 달라질 수 있습니다.</p>
  </div>;
}

/** Inputs for transitions, captions and the data presets. Rust re-validates every value on save and render. */
/** Project narration voice: MLX-Narration speakers, tones and quality presets (closed choices). */
function VoiceFields({ voice, disabled, onChange }: { voice?: VoiceSettings; disabled: boolean; onChange: (voice: VoiceSettings) => void }) {
  const value = { ...DEFAULT_VOICE, ...voice };
  const set = <K extends keyof VoiceSettings>(key: K, next: VoiceSettings[K]) => onChange({ ...value, [key]: next });
  return <fieldset className="voice-settings" disabled={disabled}><legend><Mic size={14} />내레이션 음성</legend>
    <label>화자<select aria-label="내레이션 화자" value={value.speaker} onChange={event => set("speaker", event.target.value as VoiceSettings["speaker"])}>{Object.entries(VOICE_SPEAKERS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label>톤<select aria-label="내레이션 톤" value={value.style} onChange={event => set("style", event.target.value as VoiceSettings["style"])}>{Object.entries(VOICE_STYLES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label>강조 세기<select aria-label="강조 세기" value={value.emphasis} onChange={event => set("emphasis", event.target.value as VoiceSettings["emphasis"])}>{Object.entries(VOICE_EMPHASIS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label>품질<select aria-label="음성 품질" value={value.quality} onChange={event => set("quality", event.target.value as VoiceSettings["quality"])}>{Object.entries(VOICE_QUALITY).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label>문장 사이 쉼<select aria-label="문장 사이 쉼" value={value.pauseMs} onChange={event => set("pauseMs", Number(event.target.value))}>{[...new Set([0, 150, 300, 500, 800, 1200, value.pauseMs])].sort((a, b) => a - b).map(ms => <option key={ms} value={ms}>{ms}ms</option>)}</select></label>
    <p>내레이션 줄 앞에 <code>[차분한 다큐]</code> <code>[Ryan]</code> <code>[쉼:600]</code>을 붙여 줄마다 바꾸고, <code>**단어**</code>로 강조합니다. 태그와 ** 표시는 자막에 나오지 않습니다.</p>
  </fieldset>;
}

function SceneDataFields({ scene, onPatch }: { scene: StudioVideoScene; onPatch: (patch: Partial<StudioVideoScene>) => void }) {
  const preset = readMotion(scene.motion)?.preset;
  const [chartDraft, setChartDraft] = useState(() => chartText(scene.chart));
  const [chartError, setChartError] = useState("");
  useEffect(() => { setChartDraft(chartText(scene.chart)); setChartError(""); }, [scene.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = scene.countUp ?? { from: 0, to: 100, unit: "" };
  const number = (value: string, fallback: number) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; };
  return <div className="desktop-video-data-grid">
    <label>장면 전환<select value={scene.transition ?? "cut"} onChange={event => onPatch({ transition: event.target.value === "cut" ? undefined : event.target.value as VideoTransition })}>{Object.entries(transitions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label className="desktop-video-data-check"><input type="checkbox" checked={scene.burnCaptions === true} disabled={!scene.captionCues?.length} onChange={event => onPatch({ burnCaptions: event.target.checked || undefined })} />자막 cue를 영상에 새기기{!scene.captionCues?.length && <small>자막 cue가 있는 장면에서 사용할 수 있습니다.</small>}</label>
    {preset === "count-up" && <div className="desktop-video-data-row" role="group" aria-label="숫자 카운터"><label>시작값<input type="number" value={count.from} onChange={event => onPatch({ countUp: { ...count, from: number(event.target.value, count.from) } })} /></label><label>목표값<input type="number" value={count.to} onChange={event => onPatch({ countUp: { ...count, to: number(event.target.value, count.to) } })} /></label><label>단위<input value={count.unit ?? ""} maxLength={8} onChange={event => onPatch({ countUp: { ...count, unit: event.target.value } })} /></label></div>}
    {preset === "bar-chart" && <label>막대 차트 값 <small>한 줄에 "라벨: 값", 2~8줄</small><textarea rows={4} value={chartDraft} onChange={event => { setChartDraft(event.target.value); const parsed = parseChart(event.target.value); if (typeof parsed === "string") setChartError(parsed); else { setChartError(""); onPatch({ chart: parsed }); } }} aria-invalid={!!chartError} />{chartError && <span className="social-form-error" role="alert">{chartError}</span>}</label>}
    {preset === "logo-reveal" && <label>로고 파일 경로 <small>public 폴더 안의 PNG·JPEG·WebP</small><input value={scene.logoPath ?? ""} placeholder="/brand/logo.png" onChange={event => onPatch({ logoPath: event.target.value || undefined })} /></label>}
  </div>;
}

function LegacyVideoPanel({ active, researchSeed, onResearchSeedHandled, onOpenKeywords, onOpenSettings, handoff }: Props & { handoff?: EditorHandoff | null }) {
  const [projects, setProjects] = useState<StudioVideoProject[]>([]);
  const [project, setProject] = useState<StudioVideoProject | null>(null);
  const [baseline, setBaseline] = useState("");
  const [sceneId, setSceneId] = useState("");
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState<"save" | "render" | "voice" | "import" | "open" | "research" | "idea" | "export" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [render, setRender] = useState<RenderResult | null>(null);
  const [renderProgress, setRenderProgress] = useState<VideoRenderProgressMessage | null>(null);
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
  const [ideaTopic, setIdeaTopic] = useState("");
  const [ideaCategory, setIdeaCategory] = useState<VideoIdeaCategory | "">("");
  const [ideaProvider, setIdeaProvider] = useState<VideoIdeaProvider | "">("");
  const [ideaFormat, setIdeaFormat] = useState<VideoFormat>("shorts");
  const [ideaLanguage, setIdeaLanguage] = useState<VideoProject["language"]>("ko");
  const [ideaSceneCount, setIdeaSceneCount] = useState(5);
  const [ideaDuration, setIdeaDuration] = useState(45);
  const [ideaError, setIdeaError] = useState("");
  const [templates, setTemplates] = useState<VideoTemplateDescriptor[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templatePreview, setTemplatePreview] = useState<VideoTemplatePreview | null>(null);
  const [templateCatalogLoading, setTemplateCatalogLoading] = useState(false);
  const [templatePreviewLoading, setTemplatePreviewLoading] = useState(false);
  const [templateError, setTemplateError] = useState("");
  const [templateRefresh, setTemplateRefresh] = useState(0);
  const [templateLibrary, setTemplateLibrary] = useState<VideoTemplateLibrary | null>(null);
  const [templateLibraryLoading, setTemplateLibraryLoading] = useState(false);
  const [templateLibraryError, setTemplateLibraryError] = useState("");
  const libraryQueue = useRef<Promise<void>>(Promise.resolve());
  const libraryPending = useRef(0);
  const [readTemplates] = useState(() => createSingleFlight<unknown>());
  const templateAction = useRef(false);
  const exportAction = useRef(false);
  const ideaTopicField = useRef<HTMLInputElement>(null);
  const importDialog = useRef<HTMLDialogElement>(null);
  const changesDialog = useRef<HTMLDialogElement>(null);
  const initialized = useRef(false);
  const selectedProject = useRef<StudioVideoProject | null>(null);
  const selectionVersion = useRef(0);
  const previewVersion = useRef(0);
  const acceptedSeeds = useRef(new Set<string>());
  const activeResearch = useRef<VideoResearchSeed | null>(null);
  const mounted = useRef(false);
  const panelActive = useRef(active);
  const renderOperation = useRef<RenderOperation | null>(null);
  panelActive.current = active;
  const handledHandoff = useRef(0);
  const onSeedHandled = useRef(onResearchSeedHandled);
  onSeedHandled.current = onResearchSeedHandled;
  selectedProject.current = project;
  const scene = project?.scenes.find((item) => item.id === sceneId) ?? project?.scenes[0];
  const dirty = project !== null && JSON.stringify(project) !== baseline;
  const renderStale = !!render && JSON.stringify(project) !== renderVersion;
  const duration = useMemo(() => project?.scenes.reduce((sum, item) => sum + item.durationSec, 0) ?? 0, [project]);
  const projectResearch = researchMetadata(project?.research);
  const projectIdea = readIdeaMetadata(project?.idea);
  const sceneMotion = readMotion(scene?.motion);
  const availableProviders = aiProviders.filter((id) => aiStatus.providers.some((provider) => provider.id === id && provider.available));
  const preferredProvider = aiProviders.find((id) => id === aiStatus.defaultProvider && availableProviders.includes(id));
  // With no model the idea form still works: it saves a labelled template draft.
  const resolvedIdeaProvider: VideoIdeaProvider = ideaProvider === "template" ? "template" : ideaProvider && availableProviders.includes(ideaProvider) ? ideaProvider : preferredProvider ?? availableProviders[0] ?? "template";
  const canRender = !!project && !!status?.ffmpegAvailable && !!status.ffprobeAvailable && !!status.fontAvailable;
  const selectedTemplate = templates.find(item => item.id === selectedTemplateId) ?? null;
  const templateLoading = templateCatalogLoading || templatePreviewLoading;
  const templateInput = useMemo(() => selectedTemplate ? {
    templateId: selectedTemplate.id, topic: research ? researchTopic : ideaTopic,
    category: ideaCategory || selectedTemplate.categories[0], format: research ? researchFormat : ideaFormat,
    language: ideaLanguage, sceneCount: ideaSceneCount, durationSec: ideaDuration,
  } : null, [selectedTemplate, research, researchTopic, ideaTopic, ideaCategory, researchFormat, ideaFormat, ideaLanguage, ideaSceneCount, ideaDuration]);
  const templateInputKey = JSON.stringify(templateInput);
  const readyTemplateKey = useRef("");

  const runTemplateLibrary = useCallback((command: string, args = {}, current: () => boolean = () => true) => {
    libraryPending.current += 1; setTemplateLibraryLoading(true);
    libraryQueue.current = libraryQueue.current.then(async () => {
      const value = await invoke<unknown>(command, args);
      const next = readVideoTemplateLibrary(value);
      if (!next) throw new Error("템플릿 라이브러리 정보를 확인하지 못했습니다.");
      if (mounted.current && current()) { setTemplateLibrary(next); setTemplateLibraryError(""); }
    }).catch(error => { if (mounted.current && current()) setTemplateLibraryError(message(error)); })
      .finally(() => { libraryPending.current -= 1; if (mounted.current && libraryPending.current === 0) setTemplateLibraryLoading(false); });
    return libraryQueue.current;
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void runTemplateLibrary("video_template_library_get", {}, () => !disposed);
    return () => { disposed = true; };
  }, [active, templateRefresh, runTemplateLibrary]);

  useEffect(() => {
    if (!active) { setTemplateCatalogLoading(false); return; }
    let disposed = false;
    setTemplateCatalogLoading(true); setTemplateError("");
    void readTemplates(() => invoke<unknown>("video_template_catalog")).then(value => {
      if (disposed) return;
      const catalog = readVideoTemplateCatalog(value);
      if (!catalog) throw new Error("영상 템플릿 정보를 확인하지 못했습니다.");
      setTemplates(catalog);
    }).catch(error => { if (!disposed) setTemplateError(message(error)); })
      .finally(() => { if (!disposed) setTemplateCatalogLoading(false); });
    return () => { disposed = true; };
  }, [active, templateRefresh, readTemplates]);

  useEffect(() => {
    let disposed = false;
    readyTemplateKey.current = ""; setTemplatePreview(null);
    if (!active || !templateInput) { setTemplatePreviewLoading(false); return; }
    setTemplatePreviewLoading(true); setTemplateError("");
    const timer = window.setTimeout(() => {
      void invoke<unknown>("video_template_preview", { input: templateInput }).then(value => {
        if (disposed) return;
        const result = readVideoTemplatePreview(value);
        if (!result) throw new Error("영상 템플릿 미리보기를 확인하지 못했습니다.");
        readyTemplateKey.current = templateInputKey; setTemplatePreview(result);
      }).catch(error => { if (!disposed) setTemplateError(message(error)); })
        .finally(() => { if (!disposed) setTemplatePreviewLoading(false); });
    }, 250);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [active, templateInput, templateInputKey, templateRefresh]);

  const checkStatus = useCallback(async () => {
    setStatusError("");
    try { setStatus(await invoke<MediaStatus>("media_status")); }
    catch (error) { setStatus(null); setStatusError(message(error)); }
  }, []);

  const checkAi = useCallback(async () => {
    setAiChecking(true); setAiStatusError("");
    try { const model = await readAiStatus(); const available = contentReady(model); const label = modelLabel(model, model.contentModel ?? model.agentModel); setAiStatus({ providers: [{ id: "agent-model", label, available, detail: available ? `${label}로 작성합니다.` : "Agent 탭에서 콘텐츠 작성 모델을 선택하세요." }], defaultProvider: available ? "agent-model" : null }); }
    catch (error) { setAiStatus({ providers: [], defaultProvider: null }); setAiStatusError(message(error)); }
    finally { setAiChecking(false); }
  }, []);

  const loadProjects = useCallback(async () => {
    const version = selectionVersion.current;
    setLoading(true); setListError("");
    try {
      const saved = (await invoke<StudioVideoProject[]>("video_list_projects")).filter(item => !(item as unknown as {motionGraphics?:unknown}).motionGraphics);
      if (!mounted.current) return;
      setProjects((current) => version === selectionVersion.current ? saved : [...current, ...saved.filter((item) => !current.some((existing) => existing.id === item.id))]);
      if (version === selectionVersion.current && !selectedProject.current && !activeResearch.current && saved.length) {
        selectedProject.current = saved[0];
        setProject(saved[0]); setBaseline(JSON.stringify(saved[0]));
        setSceneId(saved[0].scenes[0]?.id ?? "");
      }
    } catch (error) { if (mounted.current) setListError(message(error)); }
    finally { if (mounted.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (active && !initialized.current) {
      initialized.current = true;
      void loadProjects(); void checkStatus(); void checkAi();
    }
  }, [active, loadProjects, checkStatus, checkAi]);

  // An AI production opened for editing: reuse the editor copy if it exists so earlier edits survive.
  useEffect(() => {
    if (!active || !handoff || busy || pending || importOpen || handledHandoff.current === handoff.requestId) return;
    handledHandoff.current = handoff.requestId;
    void (async () => {
      setBusy("open");
      try {
        const saved = await invoke<StudioVideoProject[]>("video_list_projects");
        const existing = saved.find(item => item.id === handoff.project.id);
        const target = existing ?? await invoke<StudioVideoProject>("video_save_project", { input: handoff.project });
        if (!mounted.current) return;
        setProjects(current => [target, ...current.filter(item => item.id !== target.id)]);
        setBusy(null);
        requestProject({ kind: "select", project: target });
        setNotice({ tone: "info", text: existing ? "이전에 편집기로 가져온 AI 영상을 열었습니다." : "AI 영상을 편집기 프로젝트로 가져왔습니다. 수정한 뒤 MP4로 다시 출력할 수 있으며, 원본 작업은 그대로 남습니다." });
      } catch (error) { if (mounted.current) { setBusy(null); setNotice({ tone: "error", text: message(error) }); } }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, handoff, busy, pending, importOpen]);

  useEffect(() => {
    if (!active || !researchSeed || busy || pending || importOpen || acceptedSeeds.current.has(researchSeed.requestId)) return;
    acceptedSeeds.current.add(researchSeed.requestId);
    if (dirty) setPending({ kind: "research", seed: researchSeed });
    else applyPending({ kind: "research", seed: researchSeed });
    onSeedHandled.current?.(researchSeed.requestId);
  }, [active, researchSeed, busy, pending, importOpen, dirty]);

  useEffect(() => () => { initialized.current = false; previewVersion.current += 1; selectionVersion.current += 1; }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const operation = renderOperation.current;
      // Channel has no public dispose API. Rust dropping it unregisters its callback;
      // replacing the handler prevents a completed native request touching this view.
      if (operation?.channel) operation.channel.onmessage = () => {};
      operation?.session?.close();
      renderOperation.current = null;
    };
  }, []);

  useEffect(() => {
    if (active && renderOperation.current?.session) setRenderProgress(renderOperation.current.session.snapshot());
  }, [active]);

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

  function selectProject(next: StudioVideoProject, saved = true) {
    selectionVersion.current += 1; selectedProject.current = next; clearResearch();
    setProject(next); setSceneId(next.scenes[0]?.id ?? "");
    setBaseline(saved ? JSON.stringify(next) : ""); setRender(null); setNotice(null);
  }

  function applyPending(action: PendingProject) {
    setPending(null);
    if (action.kind === "new") selectProject(blankProject(), false);
    else if (action.kind === "select") selectProject(action.project);
    else if (action.kind === "template" || action.kind === "duplicate") {
      selectProject(action.project, false);
      if (action.project.templateRecipe) void runTemplateLibrary("video_template_record_use", { templateId: action.project.templateRecipe.id });
      setNotice({ tone: "info", text: action.kind === "duplicate" ? "현재 편집 내용을 새 사본으로 복제했습니다. 저장하면 별도의 프로젝트로 보관됩니다." : "템플릿 구성을 편집기에 적용했습니다. 예시 본문과 내레이션을 수정한 뒤 저장하고 MP4로 출력하세요." });
    }
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

  function chooseTemplate(template: VideoTemplateDescriptor) {
    if (busy || pending || importOpen) return;
    setSelectedTemplateId(template.id);
    setIdeaFormat(template.format); setResearchFormat(template.format);
    setIdeaSceneCount(template.sampleProject.scenes.length); setIdeaDuration(template.durationSec);
    if (!ideaCategory) setIdeaCategory(template.categories[0] as VideoIdeaCategory);
    setIdeaError("");
  }

  function templateSceneCount(count: number) {
    setIdeaSceneCount(count);
    setIdeaDuration(current => Math.max(Math.max(18, count * 3), Math.min(current, count * 30)));
  }

  function favoriteTemplate(templateId: string, enabled: boolean) {
    if (busy || pending || importOpen || libraryPending.current || !templateLibrary) return;
    void runTemplateLibrary("video_template_favorite", { templateId, enabled });
  }

  function useTemplate(template: VideoTemplateDescriptor, result: VideoTemplatePreview) {
    if (busy || pending || importOpen || templateLoading || readyTemplateKey.current !== templateInputKey
      || selectedTemplateId !== template.id || result !== templatePreview) return;
    const now = new Date().toISOString();
    requestProject({ kind: "template", project: { ...result.project, id: crypto.randomUUID(), createdAt: now, updatedAt: now } });
  }

  function retryTemplates() {
    readTemplates.invalidate(); setTemplateRefresh(value => value + 1);
  }

  function submitIdea(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || pending || importOpen) return;
    setIdeaError("");
    const topic = ideaTopic.trim();
    if (!topic || !ideaCategory) { setIdeaError("영상 주제와 카테고리를 선택하세요."); return; }
    void createIdeaProject({ topic, category: ideaCategory, format: ideaFormat, provider: resolvedIdeaProvider, language: ideaLanguage, sceneCount: ideaSceneCount, durationSec: ideaDuration });
  }

  async function createIdeaProject(input: VideoIdeaInput) {
    if (busy || templateAction.current) return;
    if (input.provider !== "template" && !aiStatus.providers.some((provider) => provider.id === input.provider && provider.available)) {
      setIdeaError("선택한 AI 연결이 끊어졌습니다. AI 연결을 다시 확인하거나 템플릿 초안을 선택하세요."); return;
    }
    templateAction.current = true;
    setBusy("idea"); setIdeaError(""); setNotice(null);
    try {
      // Rust validates the model's plan (closed motion presets, bounded text) and saves it as a new project.
      const result = await invoke<VideoIdeaResult>("video_create_idea_project", { input: { ...input, templateId: selectedTemplate?.id } });
      if (!mounted.current) return;
      rememberSaved(result.project); setSceneId(result.project.scenes[0]?.id ?? ""); setRender(null);
      setResearchWarnings(result.warnings);
      setNotice({ tone: "success", text: result.provider === "template" ? "AI 없이 템플릿 초안을 만들고 저장했습니다. 장면별 문구를 직접 작성하세요." : "AI가 만든 영상 초안을 검증하고 저장했습니다. 내용을 검토한 뒤 음성과 MP4를 출력하세요." });
    } catch (error) { if (mounted.current) setIdeaError(message(error)); }
    finally { templateAction.current = false; if (mounted.current) setBusy(null); }
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
        input: { trendIds: research.trendIds, keyword: researchKeyword.trim(), topic: researchTopic.trim(), format: researchFormat, provider: researchProvider, templateId: selectedTemplateId ?? undefined }
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

  /** Local Qwen3 TTS for every scene with narration. A scene edited meanwhile keeps its edit. */
  async function generateVoices() {
    if (!project || busy) return;
    const source = project;
    const total = source.scenes.filter(item => item.narration.trim()).length;
    if (!total) { setNotice({ tone: "error", text: "음성을 만들 장면의 내레이션을 입력하세요." }); return; }
    setBusy("voice"); setNotice(null);
    let done = 0;
    try {
      done = await generateSceneVoices(source.scenes,
        scene => invoke<GeneratedSceneVoice>("video_generate_voice", { input: { projectId: source.id, sceneId: scene.id, text: scene.narration, language: source.language, voice: source.voice ?? DEFAULT_VOICE } }),
        (scene, voice) => setProject(current => current ? applyGeneratedSceneVoice(current as VideoProject, source as VideoProject, scene.id, voice) as StudioVideoProject : current),
        completed => { if (mounted.current) setNotice({ tone: "info", text: `음성 생성 중 (${completed}/${total})` }); },
        () => mounted.current);
      if (mounted.current) setNotice({ tone: "success", text: `${done}개 장면에 로컬 음성을 연결했습니다. 저장한 뒤 MP4로 출력하세요.` });
    } catch (error) { if (mounted.current) setNotice({ tone: "error", text: done ? `${done}개 장면까지 음성을 만들었습니다. ${message(error)}` : message(error) }); }
    finally { if (mounted.current) setBusy(null); }
  }

  function patchScene(patch: Partial<StudioVideoScene>) {
    if (!scene) return;
    setProject((current) => current ? {
      ...current, scenes: current.scenes.map((item) => item.id === scene.id ? { ...item, ...patch } : item)
    } : current);
  }

  function rememberSaved(saved: StudioVideoProject) {
    selectionVersion.current += 1; selectedProject.current = saved;
    setProjects((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    setProject(saved); setBaseline(JSON.stringify(saved));
  }

  async function saveProject(): Promise<boolean> {
    if (!project) return false;
    setBusy("save"); setNotice(null);
    try {
      const saved = await invoke<StudioVideoProject>("video_save_project", { input: project });
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
    if (!project || busy || renderOperation.current || !active) return;
    const operation: RenderOperation = { channel: null, session: null };
    renderOperation.current = operation;
    const current = () => mounted.current && renderOperation.current === operation;
    const visible = () => current() && panelActive.current;
    setBusy("render"); setNotice(null); setRender(null);
    try {
      setRenderProgress(initialRenderProgress(project.scenes.length));
      const saved = await invoke<StudioVideoProject>("video_save_project", { input: project });
      if (!current()) return;
      rememberSaved(saved);
      operation.session = createRenderProgressSession(saved.scenes.length, value => { if (visible()) setRenderProgress(value); });
      if (visible()) setRenderProgress(operation.session.snapshot());
      operation.channel = new Channel<VideoRenderProgressMessage>(value => {
        if (current()) operation.session?.receive(value);
      });
      const result = await invoke<RenderResult>("video_render_project", { project: saved, onProgress: operation.channel });
      if (!current()) return;
      setRender(result); setRenderVersion(JSON.stringify(saved));
      setNotice({ tone: "success", text: "Rust · FFmpeg로 MP4 출력을 완료했습니다." });
    } catch (error) { if (current()) setNotice({ tone: "error", text: message(error) }); }
    finally {
      if (operation.channel) operation.channel.onmessage = () => {};
      operation.session?.settle();
      if (current()) { renderOperation.current = null; setRenderProgress(null); setBusy(null); }
    }
  }



  async function importProject() {
    setBusy("import"); setImportError("");
    try {
      const parsed: unknown = JSON.parse(importJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("프로젝트 한 개의 VideoProject JSON을 입력하세요.");
      const now = new Date().toISOString();
      const saved = await invoke<StudioVideoProject>("video_save_project", {
        input: { ...parsed, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
      });
      rememberSaved(saved); setSceneId(saved.scenes[0]?.id ?? ""); setRender(null);
      clearResearch();
      setImportOpen(false); setImportJson("");
      setNotice({ tone: "success", text: "JSON을 새 영상 프로젝트로 가져와 저장했습니다." });
    } catch (error) { setImportError(error instanceof SyntaxError ? "JSON 문법을 확인하세요." : message(error)); }
    finally { setBusy(null); }
  }

  async function openRender(preview = false) {
    if (!render) return;
    setBusy("open");
    try {
      if (preview) await openRenderPreview(render.path);
      else await invoke("open_rendered_video", { path: render.path });
    }
    catch (error) { setNotice({ tone: "error", text: message(error) }); }
    finally { setBusy(null); }
  }

  async function exportProject(format: "json" | "markdown") {
    if (!project || busy || pending || importOpen || !active || exportAction.current) return;
    exportAction.current = true;
    setBusy("export"); setNotice(null);
    try {
      const path = await invoke<string | null>("video_export_project", { project, format });
      if (mounted.current) setNotice({ tone: "info", text: path ? `${format === "json" ? "프로젝트 JSON" : "스토리보드 Markdown"}을 저장했습니다: ${path}` : "내보내기를 취소했습니다." });
    } catch (error) { if (mounted.current) setNotice({ tone: "error", text: message(error) }); }
    finally { exportAction.current = false; if (mounted.current) setBusy(null); }
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
      <div className="desktop-video-status" aria-label="영상 처리 환경">
        <span className={status?.ffmpegAvailable ? "ready" : ""}>FFmpeg {status ? status.ffmpegAvailable ? "준비됨" : "없음" : "확인 필요"}</span>
        <span className={status?.fontAvailable ? "ready" : ""}>자막 글꼴 {status ? status.fontAvailable ? "준비됨" : "없음" : "확인 필요"}</span>
        <LocalVoice active={active} compact onRunningChange={() => void checkStatus()} />
        {status && !status.ffprobeAvailable && <span>FFprobe 없음</span>}
      </div>
      <ol className="desktop-video-flow" aria-label="영상 제작 단계"><li className={selectedTemplate || research || busy === "idea" ? "current" : ""}><span>01</span><strong>템플릿·주제 선택</strong></li><li className={project && !render && busy !== "render" ? "current" : ""}><span>02</span><strong>초안·모션 편집</strong></li><li className={render || busy === "render" ? "current" : ""}><span>03</span><strong>MP4 출력</strong></li></ol>
      <button className="social-button compact" disabled={!!busy || loading} onClick={() => { void checkStatus(); void loadProjects(); void checkAi(); }}><RefreshCw size={14} />상태 확인</button>
    </div>
    {statusError && <p className="social-form-error" role="alert">처리 환경: {statusError}</p>}
    {notice && <div className={`social-notice ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.tone === "success" ? <Check size={17} /> : <CircleAlert size={17} />}<span>{notice.text}</span><button className="social-dismiss" aria-label="영상 알림 닫기" onClick={() => setNotice(null)}><X size={15} /></button></div>}
    {researchWarnings.length > 0 && <div className="desktop-video-research-warnings" role="status"><CircleAlert size={16} /><div><strong>초안 생성 안내</strong>{researchWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}

    {templateLibraryError && <p className="social-form-error" role="alert">템플릿 라이브러리: {templateLibraryError}</p>}
    <CreationInbox active={active} kind="video" onReview={request => { if(!request.draft?.project) throw new Error("영상 초안이 없습니다."); if(dirty && !window.confirm("편집 중인 프로젝트는 유지하고 수신 초안을 새 프로젝트로 검토할까요?")) return; setImportJson(JSON.stringify(request.draft.project,null,2)); setImportError(""); setImportOpen(true); }}/>
    <VideoTemplateGallery templates={templates} selectedId={selectedTemplateId} onSelect={chooseTemplate} onUse={useTemplate} preview={templatePreview} loading={templateLoading} error={templateError} disabled={!!busy || !!pending || importOpen} active={active} onRetry={retryTemplates} library={templateLibrary} libraryLoading={templateLibraryLoading} onFavorite={favoriteTemplate} controls={selectedTemplate && <fieldset className="desktop-video-template-controls" disabled={!!busy || !!pending || importOpen}>
      <legend>내 영상으로 구성</legend>
      <label className="desktop-video-template-topic">주제<input aria-label="템플릿 영상 주제" value={research ? researchTopic : ideaTopic} maxLength={300} placeholder={selectedTemplate.sampleTopic} onChange={event => research ? setResearchTopic(event.target.value) : setIdeaTopic(event.target.value)} /></label>
      <label>카테고리<select aria-label="템플릿 카테고리" value={ideaCategory} onChange={event => setIdeaCategory(event.target.value as VideoIdeaCategory)}>{Object.entries(ideaCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>형식<select aria-label="템플릿 영상 형식" value={research ? researchFormat : ideaFormat} onChange={event => research ? setResearchFormat(event.target.value as VideoFormat) : setIdeaFormat(event.target.value as VideoFormat)}>{Object.entries(formatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>언어<select aria-label="템플릿 언어" value={ideaLanguage} onChange={event => setIdeaLanguage(event.target.value as VideoProject["language"])}><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh">中文</option></select></label>
      <label>장면 수<select aria-label="템플릿 장면 수" value={ideaSceneCount} onChange={event => templateSceneCount(Number(event.target.value))}>{[3, 4, 5, 6, 7, 8].map(count => <option key={count} value={count}>{count}장면</option>)}</select></label>
      <label>길이<select aria-label="템플릿 목표 길이" value={ideaDuration} onChange={event => setIdeaDuration(Number(event.target.value))}>{[...new Set([18, 30, 40, 45, 48, 60, 72, 90, 120, 180, ideaDuration])].filter(seconds => seconds >= Math.max(18, ideaSceneCount * 3) && seconds <= Math.min(180, ideaSceneCount * 30)).sort((a, b) => a - b).map(seconds => <option key={seconds} value={seconds}>{seconds}초</option>)}</select></label>
    </fieldset>} />

    <section className="desktop-video-idea" aria-labelledby="desktop-video-idea-title" aria-busy={busy === "idea"}>
      <div className="desktop-video-idea-heading"><div><span><WandSparkles size={15} />주제 → AI 영상 초안</span><h2 id="desktop-video-idea-title">어떤 이야기를 영상으로 만들까요?</h2><p>{selectedTemplate ? `${selectedTemplate.name}의 장면 순서와 모션에 맞춰 AI에 본문·내레이션을 요청합니다.` : "주제와 카테고리만 정하면 AI가 장면, 화면 본문, 내레이션과 모션을 구성합니다."}</p></div><span className="desktop-video-idea-defaults">{selectedTemplate?.name ?? "자유 구성"} · {ideaSceneCount}장면 · {ideaDuration}초</span></div>
      {selectedTemplate && <button type="button" className="social-button compact" disabled={!!busy || !!pending || importOpen} onClick={() => setSelectedTemplateId(null)}>템플릿 없이 직접 구성</button>}
      <form onSubmit={submitIdea}>
        <fieldset className="desktop-video-idea-fields" disabled={!!busy || !!pending || importOpen}><legend className="social-sr-only">AI 영상 기획</legend>
          <div className="desktop-video-idea-main"><label htmlFor="desktop-video-idea-topic">영상 주제<input ref={ideaTopicField} id="desktop-video-idea-topic" value={ideaTopic} required maxLength={300} placeholder="예: AI 도구로 하루 업무 시간을 줄이는 방법" onChange={(event) => setIdeaTopic(event.target.value)} /></label><label htmlFor="desktop-video-idea-category">카테고리<select id="desktop-video-idea-category" value={ideaCategory} required onChange={(event) => setIdeaCategory(event.target.value as VideoIdeaCategory)}><option value="" disabled>카테고리 선택</option>{Object.entries(ideaCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <details className="desktop-video-idea-options"><summary>영상 형식·길이·AI 선택 <span>선택사항</span></summary><div className="desktop-video-idea-options-grid"><label>영상 형식<select value={ideaFormat} onChange={(event) => setIdeaFormat(event.target.value as VideoFormat)}>{Object.entries(formatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>언어<select value={ideaLanguage} onChange={(event) => setIdeaLanguage(event.target.value as VideoProject["language"])}><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh">中文</option></select></label><label>목표 길이<select value={ideaDuration} onChange={(event) => setIdeaDuration(Number(event.target.value))}>{[...new Set([30, 45, 60, ideaDuration])].sort((a,b) => a-b).map((seconds) => <option key={seconds} value={seconds}>{seconds}초</option>)}</select></label><label>장면 수<select value={ideaSceneCount} onChange={(event) => templateSceneCount(Number(event.target.value))}>{[3, 4, 5, 6, 7, 8].map((count) => <option key={count} value={count}>{count}장면</option>)}</select></label><label className="desktop-video-idea-provider">작성 방식<select value={resolvedIdeaProvider} onChange={(event) => setIdeaProvider(event.target.value as VideoIdeaProvider)}>{aiProviders.map((id) => { const provider = aiStatus.providers.find((item) => item.id === id); return <option key={id} value={id} disabled={!provider?.available}>{provider?.label ?? "AI 모델"} · {provider?.available ? "사용 가능" : "설정 필요"}</option>; })}<option value="template">템플릿 초안 · AI 없이 장면 구조만</option></select></label></div></details>
        </fieldset>
        <div className="desktop-video-idea-footer"><div><p>{resolvedIdeaProvider === "template" ? <><Clapperboard size={13} />AI 모델 없이 장면 구조·모션만 담긴 템플릿 초안을 저장합니다.</> : <><Sparkles size={13} />{aiStatus.providers.find((provider) => provider.id === resolvedIdeaProvider)?.label ?? "AI 모델"}에 주제·카테고리를 요청합니다. 공급자의 사용 한도가 적용됩니다.</>}</p><small>초안은 검토가 필요합니다. 내레이션은 텍스트로 생성되며, 음성은 편집기의 음성 생성(로컬 Qwen3)으로 만듭니다.</small></div><button type="submit" className="social-button primary" disabled={!!busy || !!pending || importOpen || !ideaTopic.trim() || !ideaCategory}>{busy === "idea" ? <LoaderCircle size={16} className="social-spin" /> : <WandSparkles size={16} />}{busy === "idea" ? (resolvedIdeaProvider === "template" ? "템플릿 초안 저장 중" : "AI가 작성 중") : resolvedIdeaProvider === "template" ? "템플릿 초안 만들기" : "AI로 영상 초안 만들기"}<ArrowRight size={15} /></button></div>
      </form>
      {!resolvedIdeaProvider && !aiChecking && <div className="desktop-video-idea-connect" role="status"><CircleAlert size={15} /><span>{aiStatusError ? `AI 연결을 확인하지 못했습니다. ${aiStatusError}` : "사용 가능한 AI 연결이 필요합니다. 생성 실패 시 입력한 주제와 기존 영상은 그대로 보존됩니다."}</span>{onOpenSettings && <button type="button" className="social-button compact" disabled={!!busy || !!pending} onClick={onOpenSettings}>연결 설정 열기</button>}<button type="button" className="social-button compact" disabled={!!busy || aiChecking} onClick={() => void checkAi()}><RefreshCw size={13} />AI 연결 다시 확인</button></div>}
      {ideaError && <div className="desktop-video-idea-error" role="alert"><CircleAlert size={16} /><div><strong>영상을 생성하지 못했습니다.</strong><p>{ideaError}</p><p>주제와 카테고리를 수정하거나 AI 연결을 확인한 뒤 다시 생성하세요. 기존 프로젝트는 유지됩니다.</p></div></div>}
      {busy === "idea" && <p className="desktop-video-research-loading" role="status"><LoaderCircle size={16} className="social-spin" />AI가 영상 초안을 작성하고 있습니다. 완료되면 JSON을 검토·가져오기 해야 합니다.</p>}
    </section>

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
          <label>초안 생성 방식<select value={researchProvider} onChange={(event) => setResearchProvider(event.target.value as VideoResearchProvider)}><option value="local">기본 초안 · AI 없이 로컬에서 생성</option>{aiProviders.map((id) => { const provider = aiStatus.providers.find((item) => item.id === id); return <option key={id} value={id} disabled={!provider?.available}>{provider?.label ?? "AI 모델"} · {provider?.available ? "사용 가능" : "설정 필요"}</option>; })}</select></label>
        </fieldset>
        <div className="desktop-video-research-mode-note"><span>{researchProvider === "local" ? <BookOpen size={16} /> : <Sparkles size={16} />}</span><p>{researchProvider === "local" ? "제목·설명에서 기본 장면과 내레이션을 구성합니다. 외부 AI나 원본 미디어를 다운로드하지 않습니다." : "선택한 AI 모델이 저장된 자료의 문장만 발췌해 대본을 짭니다. 출처에 없는 문장이 섞이면 기본 초안으로 저장하고 알려 줍니다."}</p></div>
        {selectedTemplate && <p className="social-form-hint">{selectedTemplate.name} 적용 · {researchProvider === "local" ? "출처와 문장 순서를 유지하고 템플릿의 색상·모션을 적용합니다." : "선택한 템플릿의 장면 구성과 실제 출처를 함께 요청합니다."}</p>}
        {aiStatusError && <p className="social-form-error" role="alert">AI 연결 확인: {aiStatusError} 기본 초안은 사용할 수 있습니다.</p>}
        <div className="desktop-video-research-actions"><button type="button" className="social-button compact" disabled={!!busy || aiChecking} onClick={() => void checkAi()}>{aiChecking ? <LoaderCircle size={14} className="social-spin" /> : <RefreshCw size={14} />}AI 연결 확인</button><button type="button" className="social-button primary" disabled={!!busy || !preview.sources.length || !researchTopic.trim()} onClick={() => void createResearchProject()}>{busy === "research" ? <LoaderCircle size={16} className="social-spin" /> : researchProvider === "local" ? <Clapperboard size={16} /> : <Sparkles size={16} />}{busy === "research" ? "초안 생성·저장 중" : researchProvider === "local" ? "기본 영상 초안 생성" : "AI로 영상 대본 만들기"}<ArrowRight size={15} /></button></div>
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
        <div className="desktop-video-editor-heading"><div><h2>{project.title || "제목 없는 영상"}</h2><span>{dirty ? "저장하지 않은 변경사항" : "로컬에 저장됨"} <i />{project.scenes.length}장면 · {duration.toFixed(1)}초</span></div><div><button className="social-button compact" aria-label="영상 프로젝트 복제" disabled={!!busy || !!pending || importOpen} onClick={() => requestProject({ kind: "duplicate", project: duplicateVideoProject(project) })}><Copy size={14} />복제</button><button className="social-button compact" disabled={!!busy || !!pending || importOpen} onClick={() => void exportProject("markdown")}><Download size={14} />Markdown 내보내기</button><button className="social-button compact" disabled={!!busy || !!pending || importOpen} onClick={() => void exportProject("json")}><FileJson size={14} />JSON 내보내기</button><button className="social-button" disabled={!!busy || !dirty} onClick={() => void saveProject()}>{busy === "save" ? <LoaderCircle size={15} className="social-spin" /> : <Save size={15} />}저장</button><button className="social-button" disabled={!!busy || !status?.ttsConfigured} title={status?.ttsConfigured ? undefined : "화면 위쪽의 로컬 음성에서 켜기를 누르세요"} onClick={() => void generateVoices()}>{busy === "voice" ? <LoaderCircle size={15} className="social-spin" /> : <Mic size={15} />}{busy === "voice" ? "음성 생성 중" : "음성 생성"}</button><button className="social-button primary" disabled={!!busy || !canRender} onClick={() => void renderProject()}>{busy === "render" ? <LoaderCircle size={15} className="social-spin" /> : <Clapperboard size={15} />}{busy === "render" ? "MP4 출력 중" : "MP4 출력"}</button></div></div>
        <fieldset className="desktop-video-project-fields" disabled={!!busy}><legend className="social-sr-only">영상 기본 정보</legend><label>영상 제목<input value={project.title} maxLength={300} onChange={(event) => patchProject({ title: event.target.value })} /></label><div className="desktop-video-metadata"><label>출력 형식<select value={project.format} onChange={(event) => patchProject({ format: event.target.value as VideoFormat })}>{Object.entries(formatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>음성 언어<select value={project.language} onChange={(event) => patchProject({ language: event.target.value as VideoProject["language"] })}><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="zh">中文</option></select></label></div></fieldset>
        <VoiceFields voice={project.voice} disabled={!!busy} onChange={voice => patchProject({ voice })} />
        {projectResearch && <details className="desktop-video-saved-research"><summary><BookOpen size={15} />영상 기획에 사용한 자료 {projectResearch.sources.length}개 <span>{projectResearch.provider === "local" ? "기본 초안" : projectResearch.provider}</span></summary><p><Hash size={12} />{projectResearch.keyword || "키워드 미지정"} · {projectResearch.topic}</p><ResearchSources sources={projectResearch.sources} /><p className="desktop-video-source-review">원문 사실과 표현을 검토하고 내 관점으로 편집하세요. 원본 미디어는 복사되지 않았습니다.</p></details>}
        {projectIdea && <div className="desktop-video-saved-idea"><div><Sparkles size={15} /><strong>{projectIdea.provider === "template" ? "템플릿으로 시작한 영상 초안" : "AI가 구성한 영상 초안"}</strong><span>{ideaCategories[projectIdea.category]}</span></div><p>{projectIdea.topic}</p><small>{projectIdea.provider === "template" ? "AI 미사용" : aiStatus.providers.find((provider) => provider.id === ideaProviderOf(projectIdea.provider))?.label ?? projectIdea.provider} · {projectDate(projectIdea.createdAt)} 생성 · toris-video-motion</small><p className="desktop-video-source-review">AI가 만든 설명과 표현을 확인하고 편집하세요. 주제로 생성한 초안에는 검증된 출처가 자동으로 연결되지 않습니다.</p></div>}
        <div className="desktop-video-scenes-header"><h3>장면 편집</h3><button className="social-button compact subtle" disabled={!!busy || project.scenes.length >= 120} onClick={addScene}><Plus size={14} />장면 추가</button></div>
        <div className="desktop-video-timeline" role="group" aria-label="편집할 장면 선택">{project.scenes.map((item, index) => <button key={item.id} disabled={!!busy} aria-pressed={item.id === scene.id} className={item.id === scene.id ? "selected" : ""} onClick={() => setSceneId(item.id)}><small>{String(index + 1).padStart(2, "0")}</small><strong>{item.headline || "제목 없는 장면"}</strong><span><Clock3 size={11} />{item.durationSec}초{item.audioPath && <Mic size={11} aria-label="음성 연결됨" />}</span></button>)}</div>
        <fieldset className="desktop-video-scene-fields" disabled={!!busy}><legend className="social-sr-only">선택한 장면</legend><div className="desktop-video-scene-label"><strong>장면 {project.scenes.findIndex((item) => item.id === scene.id) + 1}</strong><button type="button" className="social-button compact subtle" disabled={project.scenes.length <= 1} onClick={removeScene}><Trash2 size={13} />장면 삭제</button></div><label>제목<input value={scene.headline} maxLength={10000} placeholder="이 장면에서 전달할 한 문장" onChange={(event) => patchScene({ headline: event.target.value })} /></label><label>화면 본문<textarea value={scene.body} maxLength={10000} rows={3} placeholder="화면에 표시할 설명" onChange={(event) => patchScene({ body: event.target.value })} /></label><div className="desktop-video-narration-label"><label htmlFor="desktop-video-narration">내레이션</label></div><textarea id="desktop-video-narration" value={scene.narration} maxLength={10000} rows={4} placeholder="AI가 작성한 내레이션 또는 직접 작성한 문장" onChange={(event) => patchScene({ narration: event.target.value })} /><div className="desktop-video-scene-bottom"><label>장면 길이 (초)<input type="number" min={.1} max={600} step={.1} value={scene.durationSec} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) patchScene({ durationSec: value }); }} /></label><div>{scene.audioPath ? <><strong><Mic size={13} />로컬 음성 연결됨</strong><code>{scene.audioPath}</code><button className="social-button compact subtle" onClick={() => patchScene({ audioPath: undefined })}>음성 연결 해제</button></> : <p>내레이션은 텍스트로 편집합니다. 기존 프로젝트에 연결된 음성 파일은 렌더에 사용합니다.</p>}</div></div>{scene.sourceLabel && <div className="desktop-video-scene-source"><BookOpen size={13} /><span>이 장면의 근거: {scene.sourceLabel}</span>{scene.sourceUrl && <External url={sourceLink(scene.sourceUrl)}><ExternalLink size={12} />원본 확인</External>}</div>}{(scene.mediaUrl || scene.captionCues?.length) && <p className="social-form-hint">원본 미디어·자막 설정을 보존합니다.{scene.mediaUrl ? ` 미디어: ${scene.mediaUrl}` : ""}{scene.captionCues?.length ? ` · 자막 ${scene.captionCues.length}개` : ""}</p>}</fieldset>
        <fieldset className="desktop-video-motion-fields" disabled={!!busy}><legend><WandSparkles size={14} />장면 모션</legend><div className="desktop-video-motion-controls"><label htmlFor="desktop-video-motion-preset">모션 스타일<select id="desktop-video-motion-preset" value={sceneMotion?.preset ?? ""} onChange={(event) => patchScene({ motion: event.target.value ? { preset: event.target.value as VideoMotionPreset, intensity: sceneMotion?.intensity ?? .6 } : undefined })}><option value="">정지 장면 · 모션 없음</option>{Object.entries(motionPresets).map(([value, preset]) => <option key={value} value={value}>{preset.label}</option>)}</select></label><label htmlFor="desktop-video-motion-intensity">모션 강도 <output htmlFor="desktop-video-motion-intensity">{Math.round((sceneMotion?.intensity ?? .6) * 100)}%</output><input id="desktop-video-motion-intensity" type="range" min={0} max={1} step={.1} value={sceneMotion?.intensity ?? .6} disabled={!sceneMotion} onChange={(event) => { if (sceneMotion) patchScene({ motion: { ...sceneMotion, intensity: Number(event.target.value) } }); }} /></label></div></fieldset>
        <fieldset className="desktop-video-motion-data" disabled={!!busy}><legend>장면 연출 데이터</legend><SceneDataFields scene={scene} onPatch={patchScene} /></fieldset>
        <MotionPreview scene={scene} format={project.format} active={active} disabled={!!busy} />
        {!canRender && status && <p className="social-form-hint desktop-video-render-hint">MP4 출력에는 로컬 FFmpeg·FFprobe와 자막 글꼴이 필요합니다. 설치 또는 경로 설정 후 상태를 다시 확인하세요.</p>}
        {busy === "render" && renderProgress && <div className="desktop-video-progress"><LoaderCircle size={15} className="social-spin" aria-hidden="true" /><VideoRenderProgress progress={renderProgress} /></div>}
        {render && <div className="desktop-video-output"><Check size={20} /><div><strong>MP4 출력 완료</strong><span>{formatLabels[render.format]} · {render.durationSec.toFixed(1)}초</span><code>{render.path}</code>{renderStale && <small>출력 이후 변경사항이 있습니다. 최신 편집 내용은 다시 출력하세요.</small>}</div><button className="social-button primary" disabled={!!busy} onClick={() => void openRender(true)}><Play size={16} />새 창에서 미리보기</button><button className="social-button" disabled={!!busy} onClick={() => void openRender()}><FolderOpen size={16} />영상 열기</button></div>}
      </div> : <div className={`social-empty desktop-video-start ${research ? "with-research" : ""}`}><Clapperboard size={34} /><strong>{research ? "소재를 확인하면 장면 편집으로 이어집니다" : "주제에서 시작하는 내 영상"}</strong><p>{research ? "위에서 형식과 초안 생성 방식을 선택하세요. 생성된 프로젝트는 로컬에 저장되며 장면별로 수정할 수 있습니다." : "주제와 카테고리로 AI 영상 초안을 만들거나, 수집한 트렌드 자료에서 시작하세요."}</p>{!research && <div className="desktop-video-start-actions"><button className="social-button primary" disabled={!!busy} onClick={() => ideaTopicField.current?.focus()}><WandSparkles size={16} />주제로 AI 영상 만들기</button>{onOpenKeywords && <button className="social-button" disabled={!!busy || loading} onClick={onOpenKeywords}><Search size={16} />키워드로 소재 찾기</button>}<button className="social-button" disabled={!!busy || loading} onClick={() => requestProject({ kind: "new" })}><Plus size={16} />직접 새 영상 만들기</button></div>}</div>}
    </div>

    <dialog ref={importDialog} className="social-dialog" aria-labelledby="desktop-video-import-title" onCancel={(event) => { if (busy) event.preventDefault(); else setImportOpen(false); }} onClose={() => setImportOpen(false)}><div className="social-dialog-header"><div><h2 id="desktop-video-import-title">영상 프로젝트 JSON 가져오기</h2><p>프로젝트 한 개를 입력하세요. 새 프로젝트로 저장됩니다.</p></div><button className="social-dismiss" disabled={!!busy} aria-label="JSON 가져오기 닫기" onClick={() => setImportOpen(false)}><X size={20} /></button></div><label htmlFor="desktop-video-import-json">VideoProject JSON</label><textarea id="desktop-video-import-json" rows={14} spellCheck={false} value={importJson} disabled={!!busy} onChange={(event) => setImportJson(event.target.value)} placeholder={'{"title":"내 영상","format":"youtube-landscape",...}'} />{importError && <p className="social-form-error" role="alert">{importError}</p>}<div className="social-dialog-actions"><button className="social-button" disabled={!!busy} onClick={() => setImportOpen(false)}>취소</button><button className="social-button primary" disabled={!!busy || !importJson.trim()} onClick={() => void importProject()}>{busy === "import" ? <LoaderCircle size={16} className="social-spin" /> : <FileJson size={16} />}가져와 저장</button></div></dialog>
    <dialog ref={changesDialog} className="social-dialog small" aria-labelledby="desktop-video-changes-title" onCancel={(event) => { if (busy) event.preventDefault(); else setPending(null); }} onClose={() => setPending(null)}><div className="social-dialog-header"><div><h2 id="desktop-video-changes-title">편집 내용을 저장할까요?</h2><p>현재 영상에 저장하지 않은 변경사항이 있습니다.</p></div></div>{notice?.tone === "error" && <p className="social-form-error" role="alert">{notice.text}</p>}<div className="social-dialog-actions desktop-video-changes-actions"><button className="social-button" disabled={!!busy} onClick={() => setPending(null)}>계속 편집</button><button className="social-button" disabled={!!busy} onClick={() => pending && applyPending(pending)}>변경사항 버리기</button><button className="social-button primary" disabled={!!busy} onClick={() => void saveAndContinue()}>{busy === "save" ? <LoaderCircle size={16} className="social-spin" /> : <Save size={16} />}저장 후 이동</button></div></dialog>
  </section>;
}

export function VideoPanel(props: Props) {
 // The tab's main view is topic → AI video. The legacy editor and motion graphics stay reachable
 // behind a secondary control and mount only once opened (no background IPC from hidden editors).
 const [mode,setMode]=useState<"production"|"legacy"|"graphics">("production");
 const [opened,setOpened]=useState({legacy:false,graphics:false});
 const [handoff,setHandoff]=useState<EditorHandoff|null>(null);
 const show=(next:"production"|"legacy"|"graphics")=>{if(next!=="production")setOpened(o=>({...o,[next]:true}));setMode(next);};
 const editInEditor=(project:Record<string,unknown>)=>{setHandoff(h=>({requestId:(h?.requestId??0)+1,project}));show("legacy");};
 useEffect(()=>{if(props.researchSeed){setOpened(o=>({...o,legacy:true}));setMode("legacy");}},[props.researchSeed]);
 const others=<><button type="button" aria-pressed={mode==="legacy"} onClick={()=>show("legacy")}>직접 편집</button><button type="button" aria-pressed={mode==="graphics"} onClick={()=>show("graphics")}>모션 그래픽</button></>;
 return <>
  {mode!=="production"&&<nav className="video-mode-back" aria-label="영상 제작 모드"><button type="button" onClick={()=>show("production")}><ArrowRight size={14} style={{transform:"rotate(180deg)"}} aria-hidden="true"/>주제 → AI 영상</button>{others}</nav>}
  <div hidden={mode!=="production"}><ProductionStudio active={props.active&&mode==="production"} onOpenSettings={props.onOpenSettings} onEditInEditor={editInEditor}/><nav className="video-alt-modes" aria-label="영상 제작 모드"><span>다른 방식으로 만들기</span>{others}</nav></div>
  <div hidden={mode!=="legacy"}>{opened.legacy&&<LegacyVideoPanel {...props} handoff={handoff} active={props.active&&mode==="legacy"}/>}</div>
  <div hidden={mode!=="graphics"}>{opened.graphics&&<MotionStudio active={props.active&&mode==="graphics"}/>}</div>
 </>;
}
