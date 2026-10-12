import type { VideoFormat } from "../../lib/video/types";
import { readMotion, type StudioVideoProject, type VideoMotion } from "./video-idea";

export type VideoTemplateBeat = { label: string; intent: string; motion: VideoMotion };
export type VideoTemplateDescriptor = {
  id: string; name: string; tagline: string; description: string; categories: string[];
  format: VideoFormat; durationSec: number; accent: string; sampleTopic: string;
  beats: VideoTemplateBeat[]; sampleProject: StudioVideoProject;
};
export type VideoTemplatePreview = { project: StudioVideoProject; prompt: string; warnings: string[] };
export type VideoTemplateLibrary = { version: 1; favorites: string[]; recent: string[] };
export type VideoTemplateLibraryView = "all" | "favorites" | "recent";
export type VideoTemplatePreviewInput = {
  templateId: string; topic?: string; category?: string; format?: VideoFormat;
  language?: StudioVideoProject["language"]; sceneCount?: number; durationSec?: number;
};
export const templateFormatLabels: Record<VideoFormat, string> = {
  "youtube-landscape": "가로 16:9", vertical: "세로 9:16", shorts: "Shorts 9:16"
};
const formats: readonly string[] = ["youtube-landscape", "vertical", "shorts"];
const languages: readonly string[] = ["ko", "ja", "zh", "en"];
const renderTemplates: readonly string[] = ["reference-briefing", "adaptive-promo"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, nonempty = true): value is string => typeof value === "string" && value.length <= max && (!nonempty || value.trim().length > 0);
const number = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const id = (value: unknown): value is string => text(value, 64) && /^[a-z][a-z0-9-]+$/.test(value);
const color = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const stringList = (value: unknown, max: number, itemMax: number): value is string[] => Array.isArray(value) && value.length <= max && value.every((item) => text(item, itemMax));

function isProject(value: unknown): value is StudioVideoProject {
  if (!record(value) || !text(value.id, 128) || !text(value.title, 500) || !text(value.createdAt, 64) || !text(value.updatedAt, 64)
    || typeof value.format !== "string" || !formats.includes(value.format)
    || typeof value.language !== "string" || !languages.includes(value.language)
    || typeof value.template !== "string" || !renderTemplates.includes(value.template)
    || !Array.isArray(value.scenes) || value.scenes.length < 1 || value.scenes.length > 24) return false;
  const seen = new Set<string>();
  if (!value.scenes.every((scene) => {
    if (!record(scene) || !text(scene.id, 128) || seen.has(scene.id) || !text(scene.headline, 1000, false)
      || !text(scene.body, 10000, false) || !text(scene.narration, 10000, false) || !number(scene.durationSec, .1, 600)
      || (scene.accent != null && !color(scene.accent)) || (scene.motion != null && !readMotion(scene.motion))) return false;
    seen.add(scene.id);
    return true;
  }) || !sceneAtElapsed(value.scenes as Array<{ durationSec: number }>, 0)) return false;
  if (value.templateRecipe != null) {
    const recipe = value.templateRecipe;
    if (!record(recipe) || recipe.version !== 1 || !id(recipe.id) || !text(recipe.name, 256)) return false;
  }
  return true;
}

/** Reject malformed IPC data before it reaches the gallery or the editor. */
export function readVideoTemplateCatalog(value: unknown): VideoTemplateDescriptor[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (!record(item) || !id(item.id) || seen.has(item.id) || !text(item.name, 256) || !text(item.tagline, 500)
      || !text(item.description, 2000) || !stringList(item.categories, 12, 100) || item.categories.length < 1
      || typeof item.format !== "string" || !formats.includes(item.format) || !number(item.durationSec, .1, 3600)
      || !color(item.accent) || !text(item.sampleTopic, 500) || !Array.isArray(item.beats)
      || item.beats.length < 1 || item.beats.length > 24 || !item.beats.every((beat) => record(beat)
        && text(beat.label, 256) && text(beat.intent, 2000) && !!readMotion(beat.motion)) || !isProject(item.sampleProject)) return null;
    seen.add(item.id);
  }
  return value as VideoTemplateDescriptor[];
}

export function readVideoTemplatePreview(value: unknown): VideoTemplatePreview | null {
  return record(value) && isProject(value.project) && text(value.prompt, 50000, false) && stringList(value.warnings, 24, 2000)
    ? value as VideoTemplatePreview : null;
}

export function readVideoTemplateLibrary(value: unknown): VideoTemplateLibrary | null {
  if (!record(value) || value.version !== 1) return null;
  for (const field of [value.favorites, value.recent]) {
    if (!Array.isArray(field) || field.length > 32 || !field.every(id) || new Set(field).size !== field.length) return null;
  }
  return value as VideoTemplateLibrary;
}

export function templatesForLibraryView(templates: readonly VideoTemplateDescriptor[], library: VideoTemplateLibrary | null, view: VideoTemplateLibraryView): VideoTemplateDescriptor[] {
  if (view === "all") return [...templates];
  if (!library) return [];
  if (view === "favorites") {
    const favorites = new Set(library.favorites);
    return templates.filter((template) => favorites.has(template.id));
  }
  const catalog = new Map(templates.map((template) => [template.id, template]));
  return library.recent.flatMap((templateId) => { const template = catalog.get(templateId); return template ? [template] : []; });
}

export type ScenePosition = { index: number; startSec: number; endSec: number; elapsedSec: number; progress: number; totalSec: number };

/** Scene intervals are [start, end); exactly the final end remains on the last scene. */
export function sceneAtElapsed(scenes: ReadonlyArray<{ durationSec: number }>, elapsedSec: number): ScenePosition | null {
  if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > 24 || !Number.isFinite(elapsedSec)
    || !scenes.every((scene) => record(scene) && number(scene.durationSec, .1, 600))) return null;
  const totalSec = scenes.reduce((total, scene) => total + scene.durationSec, 0);
  if (totalSec > 3600) return null;
  const elapsed = Math.min(Math.max(0, elapsedSec), totalSec);
  let startSec = 0;
  for (let index = 0; index < scenes.length; index++) {
    const endSec = startSec + scenes[index].durationSec;
    if (elapsed < endSec || index === scenes.length - 1) {
      return { index, startSec, endSec, elapsedSec: elapsed, progress: (elapsed - startSec) / scenes[index].durationSec, totalSec };
    }
    startSec = endSec;
  }
  return null;
}

export function sceneStartSeconds(scenes: ReadonlyArray<{ durationSec: number }>, index: number): number {
  return !!sceneAtElapsed(scenes, 0) && Number.isInteger(index) && index >= 0 && index < scenes.length
    ? scenes.slice(0, index).reduce((total, scene) => total + scene.durationSec, 0) : 0;
}

/** Keep first/last beats and distribute the middle exactly as Rust's beat_at. */
export function templateBeatAt<T>(beats: readonly T[], index: number, sceneCount: number): T | undefined {
  if (!Array.isArray(beats) || beats.length < 1 || !Number.isInteger(index) || !Number.isInteger(sceneCount)
    || sceneCount < 1 || index < 0 || index >= sceneCount) return undefined;
  if (index === 0) return beats[0];
  if (index + 1 === sceneCount) return beats[beats.length - 1];
  if (beats.length < 3) return beats[Math.min(index, beats.length - 1)];
  const middle = beats.length - 2;
  const position = Math.min(Math.floor((index - 1) * middle / (sceneCount - 2)), middle - 1);
  return beats[position + 1];
}

export function formatPreviewTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
