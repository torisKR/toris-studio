import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openRenderPreview } from "../native-windows";

/**
 * IPC client for the video-production contract (docs/VIDEO_PRODUCTION.md).
 * Every command name below matches the contract exactly. Responses are normalized
 * defensively because the Rust side owns the schema; unknown fields are ignored.
 */
export type ProductionAspect = "9:16" | "16:9" | "1:1";
export type ProductionStyle = "realistic" | "cinematic" | "animation" | "documentary";
export type ProductionQuality = "preview" | "standard" | "high";
export type SubtitleStyle = "shorts-bold" | "clean-bottom" | "none";
export type BgmKind = "none" | "ambient" | "pulse";
export type JobStatus = "planning" | "awaiting_approval" | "running" | "paused" | "failed" | "cancelled" | "done";
export type AssetStatus = "pending" | "running" | "done" | "failed" | "stale";
export type StageId = "plan" | "storyboard" | "scenes" | "voice" | "subtitles" | "edit" | "qa" | "done";
/** "waiting" = the storyboard stage is waiting for the user's approval. */
export type StageStatus = AssetStatus | "waiting";
export type Transition = "cut" | "fade" | "dip";

export type ProductionInput = {
  topic: string; durationSec: number; aspect: ProductionAspect; style: ProductionStyle; narration: boolean;
  subtitleStyle: SubtitleStyle; bgm: BgmKind; quality: ProductionQuality; engine: string;
  /** Narration speaker (lib/video/voice-options VOICE_SPEAKERS key). Sent only when narration is on. */
  speaker?: string;
};
export type StageState = { id: StageId; status: StageStatus; done: number; total: number; message?: string; error?: string };
export type StoryboardScene = {
  id: string; order: number; durationSec: number; script: string; narration: string; caption: string;
  prompt: string; negativePrompt?: string; transition: Transition;
};
export type Storyboard = {
  title: string; story: string; style: { look: string; palette: string; consistency: string };
  scenes: StoryboardScene[];
  /** true when the plan came from the deterministic template (no AI model). */
  template?: boolean;
};
export type SceneAsset = { status: AssetStatus; path?: string; error?: string };
export type ProductionScene = { id: string; order: number; video: SceneAsset; voice: SceneAsset };
export type QaCheck = { id: string; label: string; passed: boolean; detail?: string };
export type ProvenanceLicense = { name: string; license: string; url?: string };
export type Provenance = { commercialUse: boolean; narrationRights?: "conditional" | "none"; engine?: string; revision?: string; licenses: ProvenanceLicense[]; planner?: string; notes: string[] };
export type Size = { width: number; height: number };
export type FinalVideo = { path: string; durationSec: number; width?: number; height?: number; sizeBytes?: number };
export type ProductionJob = {
  id: string; createdAt: string; updatedAt: string; status: JobStatus; settings: ProductionInput;
  stages: StageState[]; storyboard: Storyboard | null; scenes: ProductionScene[];
  generation?: Size & { frames?: number; steps?: number }; output?: Size;
  final: FinalVideo | null; qa: QaCheck[]; provenance: Provenance | null;
  error: { stage?: StageId; message: string } | null;
  /** Validated VideoProject the existing editor can open (done jobs only). */
  editProject?: Record<string, unknown> | null;
};
export type ProductionJobSummary = { id: string; title: string; topic: string; status: JobStatus; updatedAt: string; durationSec?: number; aspect?: ProductionAspect };
export type EngineInstall = { phase: "idle" | "running" | "done" | "failed"; step?: string; done?: number; total?: number; error?: string };
export type EngineInfo = {
  id: string; label: string; installed: boolean; supported: boolean; license: string; commercialUse: boolean;
  revision?: string; sizeGb?: number; memoryGb?: number; enabled: boolean; reason?: string; install?: EngineInstall;
};
export type EngineStatus = { engines: EngineInfo[]; ttsInstalled: boolean | null; ffmpegReady: boolean | null };
export type ProductionEvent = { jobId: string; stage: StageId; sceneId?: string; kind: "progress" | "state" | "log"; done: number; total: number; message: string };

export const STAGES: ReadonlyArray<{ id: StageId; label: string }> = [
  { id: "plan", label: "기획" }, { id: "storyboard", label: "스토리보드 확인" }, { id: "scenes", label: "장면 생성" },
  { id: "voice", label: "나레이션" }, { id: "subtitles", label: "자막" }, { id: "edit", label: "편집" },
  { id: "qa", label: "품질 검사" }, { id: "done", label: "완료" }
];
const JOB_STATUSES: readonly JobStatus[] = ["planning", "awaiting_approval", "running", "paused", "failed", "cancelled", "done"];
const ASSET_STATUSES: readonly AssetStatus[] = ["pending", "running", "done", "failed", "stale"];

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const str = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const opt = (value: unknown) => typeof value === "string" && value ? value : undefined;
const num = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const optNum = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const errorText = (value: unknown) => typeof value === "string" ? value || undefined : opt(rec(value).message);

function assetStatus(value: unknown): AssetStatus {
  return ASSET_STATUSES.includes(value as AssetStatus) ? value as AssetStatus : "pending";
}
function stageStatus(value: unknown): StageStatus {
  return value === "waiting" || value === "awaiting_approval" ? "waiting" : assetStatus(value);
}
function asset(value: unknown): SceneAsset {
  const r = rec(value);
  return { status: assetStatus(r.status), path: opt(r.path) ?? opt(r.file), error: errorText(r.error) };
}
function size(value: unknown): Size | undefined {
  const r = rec(value);
  return optNum(r.width) && optNum(r.height) ? { width: num(r.width), height: num(r.height) } : undefined;
}

function normalizeStoryboard(value: unknown): Storyboard | null {
  const r = rec(value);
  if (!Array.isArray(r.scenes)) return null;
  const style = rec(r.style);
  return {
    title: str(r.title), story: str(r.story),
    style: { look: str(style.look), palette: str(style.palette), consistency: str(style.consistency) },
    scenes: r.scenes.map((raw, index) => {
      const s = rec(raw);
      return {
        id: str(s.id, "scene-" + (index + 1)), order: num(s.order, index + 1), durationSec: num(s.durationSec, 5),
        script: str(s.script), narration: str(s.narration), caption: str(s.caption), prompt: str(s.prompt),
        ...(typeof s.negativePrompt === "string" ? { negativePrompt: s.negativePrompt } : {}),
        transition: s.transition === "fade" || s.transition === "dip" ? s.transition : "cut"
      } as StoryboardScene;
    }),
    ...(r.template === true ? { template: true } : {})
  };
}

/** Exactly the contract's storyboard fields: the validator rejects unknown keys such as the UI-only template flag. */
export function storyboardForApproval(board: Storyboard): Omit<Storyboard, "template"> {
  return {
    title: board.title.trim(), story: board.story,
    style: { look: board.style.look, palette: board.style.palette, consistency: board.style.consistency },
    scenes: board.scenes.map(scene => ({
      id: scene.id, order: scene.order, durationSec: scene.durationSec, script: scene.script, narration: scene.narration,
      caption: scene.caption, prompt: scene.prompt, ...(scene.negativePrompt !== undefined ? { negativePrompt: scene.negativePrompt } : {}), transition: scene.transition
    }))
  };
}

export function normalizeJob(value: unknown): ProductionJob {
  const r = rec(value);
  const id = str(r.id) || str(r.jobId);
  if (!id) throw new Error("영상 작업 정보를 읽지 못했습니다.");
  const s = rec(r.settings ?? r.input ?? r.request);
  const stagesRaw = r.stages;
  const stages = STAGES.map(({ id: stage }) => {
    const raw = Array.isArray(stagesRaw)
      ? rec(stagesRaw.find(item => rec(item).id === stage || rec(item).stage === stage))
      : rec(rec(stagesRaw)[stage]);
    return { id: stage, status: stageStatus(raw.status), done: num(raw.done), total: num(raw.total), message: opt(raw.message), error: errorText(raw.error) };
  });
  const finalRaw = rec(r.final);
  const finalPath = opt(finalRaw.path) ?? opt(r.finalPath);
  const qaRaw = Array.isArray(r.qa) ? r.qa : list(rec(r.qa).checks);
  const provenanceRaw = r.provenance && typeof r.provenance === "object" ? rec(r.provenance) : null;
  const errorRaw = r.error;
  const error = errorText(errorRaw);
  const gen = size(r.generation);
  return {
    id, createdAt: str(r.createdAt), updatedAt: str(r.updatedAt) || str(r.createdAt),
    status: JOB_STATUSES.includes(r.status as JobStatus) ? r.status as JobStatus : "planning",
    settings: {
      topic: str(s.topic) || str(r.topic), durationSec: num(s.durationSec, 30), aspect: (["9:16", "16:9", "1:1"].includes(s.aspect as string) ? s.aspect : "9:16") as ProductionAspect,
      style: (str(s.style) || "cinematic") as ProductionStyle, narration: s.narration !== false, subtitleStyle: (str(s.subtitleStyle) || "shorts-bold") as SubtitleStyle,
      bgm: (str(s.bgm) || "none") as BgmKind, quality: (str(s.quality) || "preview") as ProductionQuality, engine: str(s.engine), speaker: opt(s.speaker)
    },
    stages, storyboard: normalizeStoryboard(r.storyboard),
    scenes: list(r.scenes).map((raw, index) => { const scene = rec(raw); return { id: str(scene.id, "scene-" + (index + 1)), order: num(scene.order, index + 1), video: asset(scene.video), voice: asset(scene.voice) }; }),
    generation: gen ? { ...gen, frames: optNum(rec(r.generation).frames), steps: optNum(rec(r.generation).steps) } : undefined,
    output: size(r.output),
    final: finalPath ? { path: finalPath, durationSec: num(finalRaw.durationSec), width: optNum(finalRaw.width), height: optNum(finalRaw.height), sizeBytes: optNum(finalRaw.sizeBytes) } : null,
    qa: qaRaw.map((raw, index) => { const c = rec(raw); return { id: str(c.id, "check-" + index), label: str(c.label) || str(c.id, "검사 " + (index + 1)), passed: c.passed === true || c.ok === true, detail: opt(c.detail) ?? opt(c.message) }; }),
    provenance: provenanceRaw ? {
      commercialUse: provenanceRaw.commercialUse === true, narrationRights: provenanceRaw.narrationRights === "conditional" ? "conditional" : provenanceRaw.narrationRights === "none" ? "none" : undefined, engine: opt(provenanceRaw.engine), revision: opt(provenanceRaw.revision),
      licenses: list(provenanceRaw.licenses).map(raw => { const l = rec(raw); return { name: str(l.name), license: str(l.license), url: opt(l.url) }; }).filter(l => l.name),
      planner: opt(provenanceRaw.planner) ?? opt(rec(provenanceRaw.ai).model), notes: list(provenanceRaw.notes).filter((n): n is string => typeof n === "string")
    } : null,
    error: error ? { message: error, stage: (opt(rec(errorRaw).stage) as StageId | undefined) } : null,
    editProject: r.editProject && typeof r.editProject === "object" && !Array.isArray(r.editProject) ? r.editProject as Record<string, unknown> : null
  };
}

export function normalizeSummaries(value: unknown): ProductionJobSummary[] {
  const items = Array.isArray(value) ? value : list(rec(value).jobs);
  return items.flatMap(raw => {
    const r = rec(raw); const id = str(r.id) || str(r.jobId);
    if (!id) return [];
    const s = rec(r.settings);
    const topic = str(r.topic) || str(s.topic);
    return [{
      id, topic, title: str(r.title) || str(rec(r.storyboard).title) || topic || "제목 없는 영상",
      status: JOB_STATUSES.includes(r.status as JobStatus) ? r.status as JobStatus : "planning",
      updatedAt: str(r.updatedAt) || str(r.createdAt), durationSec: optNum(r.durationSec) ?? optNum(s.durationSec),
      aspect: (opt(r.aspect) ?? opt(s.aspect)) as ProductionAspect | undefined
    }];
  });
}

function readiness(value: unknown, keys: string[]): boolean | null {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") return null;
  const r = rec(value);
  for (const key of keys) if (typeof r[key] === "boolean") return r[key] as boolean;
  return null;
}

/** Rust sends { weights, code }; older fixtures send a single string. */
function licenseLabel(value: unknown): string {
  if (typeof value === "string" && value) return value;
  const r = rec(value);
  const parts = [opt(r.weights) && "가중치 " + str(r.weights), opt(r.code) && "코드 " + str(r.code)].filter(Boolean);
  return parts.length ? parts.join(" · ") : "라이선스 미상";
}

export function normalizeEngineStatus(value: unknown): EngineStatus {
  const r = rec(value);
  return {
    engines: list(r.engines).flatMap(raw => {
      const e = rec(raw); const id = str(e.id);
      if (!id) return [];
      const install = rec(e.install);
      const phase = install.phase;
      return [{
        id, label: str(e.label, id), installed: e.installed === true, supported: e.supported !== false, license: licenseLabel(e.license),
        commercialUse: e.commercialUse === true, revision: opt(e.revision), sizeGb: optNum(e.sizeGb), memoryGb: optNum(e.memoryGb),
        enabled: e.enabled !== false, reason: opt(e.reason),
        install: phase === "running" || phase === "done" || phase === "failed" || phase === "idle"
          ? { phase, step: opt(install.step), done: optNum(install.done), total: optNum(install.total), error: errorText(install.error) } : undefined
      }];
    }),
    ttsInstalled: readiness(r.tts, ["installed", "available", "ready"]),
    ffmpegReady: readiness(r.ffmpeg, ["available", "installed", "ready"])
  };
}

/** Commands may return the updated job; otherwise the caller re-reads it. */
function maybeJob(value: unknown): ProductionJob | null {
  try { return value && typeof value === "object" && (rec(value).id || rec(value).jobId) && rec(value).status ? normalizeJob(value) : null; }
  catch { return null; }
}

export const productionApi = {
  engineStatus: async () => normalizeEngineStatus(await invoke("production_engine_status")),
  installEngine: (engine: string) => invoke("production_engine_install", { input: { engine } }),
  create: async (input: ProductionInput) => normalizeJob(await invoke("production_create", { input: { ...input } })),
  list: async () => normalizeSummaries(await invoke("production_list")),
  get: async (jobId: string) => normalizeJob(await invoke("production_get", { input: { jobId } })),
  approve: async (jobId: string, storyboard?: Storyboard) => maybeJob(await invoke("production_approve", { input: storyboard ? { jobId, storyboard: storyboardForApproval(storyboard) } : { jobId } })),
  pause: async (jobId: string) => maybeJob(await invoke("production_pause", { input: { jobId } })),
  resume: async (jobId: string) => maybeJob(await invoke("production_resume", { input: { jobId } })),
  cancel: async (jobId: string) => maybeJob(await invoke("production_cancel", { input: { jobId } })),
  retry: async (jobId: string, stage: StageId, sceneId?: string) => maybeJob(await invoke("production_retry", { input: sceneId ? { jobId, sceneId, stage } : { jobId, stage } })),
  openFinal: async (jobId: string) => {
    const opened = await invoke<{ path?: string }>("production_open_final", { input: { jobId } });
    if (opened?.path) await openRenderPreview(opened.path);
    return opened;
  },
  saveVideo: (jobId: string) => invoke<{ saved: string | null }>("production_save_video", { input: { jobId } }),
  publicationDraft: (jobId: string) => invoke<unknown>("production_publication_draft", { input: { jobId } })
};

/** Local media URL for a job-owned file, using the same asset protocol as other panels. */
export function mediaSrc(path: string | undefined): string {
  if (!path) return "";
  try { return convertFileSrc(path); } catch { return ""; }
}

