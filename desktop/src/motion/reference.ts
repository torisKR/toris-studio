import { invoke } from "@tauri-apps/api/core";

/**
 * Motion references (desktop/src-tauri/src/motion_reference.rs): the closed "feel" of a motion
 * graphic. The window only shows and picks them; Rust validates, extracts and stores.
 */
export type ReferenceOrigin = "builtin" | "project" | "media";
export type MotionReference = {
  id: string; name: string; origin: ReferenceOrigin;
  source: { kind?: "image" | "video"; width?: number; height?: number; durationSec?: number } | null;
  palette: { background: string; surface: string; text: string; accent: string; accent2: string };
  type: { headline: number; body: number };
  composition: "center" | "left-rail" | "panel";
  motion: { enter: "fade" | "rise" | "slide" | "zoom"; accent: "draw" | "fade" | "zoom" | "none"; exit: "none" | "fade-out" };
  decor: "none" | "underline" | "ring" | "block";
  rhythm: { firstDelay: number; stagger: number; sceneSec: number };
  notes: string[];
};
export type ReferenceList = { references: MotionReference[]; skipped: number };

export const DEFAULT_REFERENCE_ID = "builtin-midnight-data";
export const COMPOSITION_LABELS = { center: "가운데 정렬", "left-rail": "왼쪽 선 정렬", panel: "패널 위 글자" } as const;
export const ORIGIN_LABELS = { builtin: "기본", project: "내 모션 프로젝트", media: "이미지·영상 색" } as const;

const COLOR = /^#[0-9A-Fa-f]{6}$/;
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const str = (value: unknown) => typeof value === "string" ? value : "";
const num = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Entry pace shown to people: the stagger between elements. */
export function paceLabel(reference: Pick<MotionReference, "rhythm">): "빠름" | "보통" | "느림" {
  return reference.rhythm.stagger <= 0.25 ? "빠름" : reference.rhythm.stagger <= 0.45 ? "보통" : "느림";
}
/** Media references measure colour only; speed and layout come from the base reference. */
export function measuredColorsOnly(reference: Pick<MotionReference, "origin">): boolean {
  return reference.origin === "media";
}

export function normalizeReference(value: unknown): MotionReference | null {
  const r = rec(value);
  const palette = rec(r.palette);
  const colors = ["background", "surface", "text", "accent", "accent2"].map(key => str(palette[key]));
  if (!str(r.id) || !str(r.name) || !colors.every(color => COLOR.test(color))) return null;
  const origin = (["builtin", "project", "media"] as const).find(o => o === r.origin);
  if (!origin) return null;
  const type = rec(r.type), motion = rec(r.motion), rhythm = rec(r.rhythm), source = rec(r.source);
  return {
    id: str(r.id), name: str(r.name), origin,
    source: r.source ? { kind: source.kind === "video" ? "video" : source.kind === "image" ? "image" : undefined, width: num(source.width, 0) || undefined, height: num(source.height, 0) || undefined, durationSec: num(source.durationSec, 0) || undefined } : null,
    palette: { background: colors[0], surface: colors[1], text: colors[2], accent: colors[3], accent2: colors[4] },
    type: { headline: num(type.headline, 96), body: num(type.body, 44) },
    composition: r.composition === "left-rail" || r.composition === "panel" ? r.composition : "center",
    motion: {
      enter: (["fade", "rise", "slide", "zoom"] as const).find(v => v === motion.enter) ?? "fade",
      accent: (["draw", "fade", "zoom", "none"] as const).find(v => v === motion.accent) ?? "fade",
      exit: motion.exit === "fade-out" ? "fade-out" : "none"
    },
    decor: (["none", "underline", "ring", "block"] as const).find(v => v === r.decor) ?? "none",
    rhythm: { firstDelay: num(rhythm.firstDelay, 0.3), stagger: num(rhythm.stagger, 0.35), sceneSec: num(rhythm.sceneSec, 4) },
    notes: Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === "string") : []
  };
}
export function normalizeReferenceList(value: unknown): ReferenceList {
  const r = rec(value);
  const references = (Array.isArray(r.references) ? r.references : []).map(normalizeReference).filter((x): x is MotionReference => !!x);
  return { references, skipped: num(r.skipped, 0) };
}

export const referenceApi = {
  list: async () => normalizeReferenceList(await invoke("motion_reference_list")),
  fromProject: async (project: unknown, name: string) => normalizeReference(await invoke("motion_reference_from_project", { input: { project, name } })),
  /** Opens the OS file picker in Rust; null when the person cancelled. */
  fromMedia: async (name: string, base: string) => {
    const result = rec(await invoke("motion_reference_from_media", { input: { name, base } }));
    return result.cancelled === true ? null : normalizeReference(result);
  },
  remove: (id: string) => invoke("motion_reference_delete", { input: { id } })
};
