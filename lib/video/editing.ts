import { getPreset } from "./presets";
import type { EditingPresetId, VideoFormat, VideoProject, VideoScene } from "./types";

export type PixelRect = { x: number; y: number; width: number; height: number };
export const EDITING_PRESETS: Record<EditingPresetId, { label: string; motion: boolean }> = {
  "project-explainer": { label: "프로젝트 설명 · UI 강조 모션", motion: true },
  "project-explainer-still": { label: "프로젝트 설명 · 정지형", motion: false }
};

/** Author-designed working margins, not measured from the reference channel. */
export function getEditingOutputSize(format: VideoFormat, scale = 1) {
  const preset = getPreset(format), width = preset.width * scale, height = preset.height * scale;
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 1 ||
    !Number.isInteger(width) || !Number.isInteger(height) || width % 2 || height % 2) {
    throw new Error("Explainer output must have integer, even H.264 dimensions (scale 0.1–1)");
  }
  return { width, height };
}

export function getEditingLayout(format: VideoFormat, scale = 1) {
  getEditingOutputSize(format, scale);
  const portrait = format !== "youtube-landscape";
  const base = portrait ? {
    safe: { x: 72, y: 156, width: 864, height: 1452 },
    heading: { x: 72, y: 216, width: 864, height: 240 },
    body: { x: 72, y: 480, width: 864, height: 144 },
    media: { x: 72, y: 672, width: 864, height: 656 },
    caption: { x: 72, y: 1392, width: 864, height: 144 },
    headingFont: 64, bodyFont: 32, captionFont: 44, captionMinFont: 36
  } : {
    safe: { x: 96, y: 60, width: 1728, height: 960 },
    heading: { x: 96, y: 192, width: 624, height: 288 },
    body: { x: 96, y: 504, width: 624, height: 192 },
    media: { x: 792, y: 144, width: 1032, height: 648 },
    caption: { x: 240, y: 864, width: 1440, height: 120 },
    headingFont: 64, bodyFont: 32, captionFont: 40, captionMinFont: 28
  };
  const rect = (r: PixelRect): PixelRect => {
    const x = Math.round(r.x * scale), y = Math.round(r.y * scale);
    return {x, y, width: Math.round((r.x + r.width) * scale) - x, height: Math.round((r.y + r.height) * scale) - y};
  };
  return {safe:rect(base.safe), heading:rect(base.heading), body:rect(base.body), media:rect(base.media), caption:rect(base.caption),
    headingFont:Math.round(base.headingFont * scale), bodyFont:Math.round(base.bodyFont * scale),
    captionFont:Math.round(base.captionFont * scale), captionMinFont:Math.round(base.captionMinFont * scale)};
}

export function containsRect(outer: PixelRect, inner: PixelRect) {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

const glyphs = (text: string) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), s => s.segment);
// Conservative width budget. Actual font/frame inspection remains required on the render host.
const units = (s: string) => s === " " ? 0.5 : /^[\x00-\x7f]+$/.test(s) ? 1.05 : 1.25;
export function wrapText(text: string, width: number, fontSize: number) {
  const lines: string[] = [];
  if (!text.trim()) return lines;
  const measure = (s: string) => glyphs(s).reduce((sum, g) => sum + units(g) * fontSize, 0);
  for (const paragraph of text.trim().split(/\r?\n/)) {
    let current = "";
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= width) { current = candidate; continue; }
      if (current) { lines.push(current); current = ""; }
      if (measure(word) <= width) { current = word; continue; }
      // An unbroken token wider than the entire box still needs a lossless fallback.
      for (const char of glyphs(word)) {
        if (current && measure(current + char) > width) { lines.push(current); current = ""; }
        current += char;
      }
    }
    if (current || !paragraph.trim()) lines.push(current);
  }
  return lines;
}

export function fitText(text: string, box: PixelRect, maxFont: number, minFont: number, maxLines: number, padding = 0) {
  for (let font = maxFont; font >= minFont; font--) {
    const lines = wrapText(text, box.width - padding * 2, font);
    const lineHeight = Math.ceil(font * 1.35);
    if (lines.length <= maxLines && lines.length * lineHeight <= box.height - padding * 2) {
      return { lines, fontSize: font, lineHeight, overflow: false };
    }
  }
  return { lines: wrapText(text, box.width - padding * 2, minFont), fontSize: minFont, lineHeight: Math.ceil(minFont * 1.35), overflow: true };
}

export function resolveCaptionCues(scene: VideoScene, format: VideoFormat): NonNullable<VideoScene["captionCues"]> {
  // Explicit empty array suppresses captions. Manual timing is never redistributed.
  if (scene.captionCues !== undefined) return scene.captionCues;
  const layout = getEditingLayout(format);
  const lines = wrapText(scene.narration.replace(/\s+/g, " "), layout.caption.width - 48, layout.captionMinFont);
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += 2) chunks.push(lines.slice(i, i + 2).join("\n"));
  return chunks.map((text, i) => ({ text, startSec: i * scene.durationSec / chunks.length, endSec: (i + 1) * scene.durationSec / chunks.length }));
}

export function captionAtFrame(scene: VideoScene, format: VideoFormat, frame: number, fps: number) {
  return resolveCaptionCues(scene, format).find(c => frame >= Math.round(c.startSec * fps) && frame < Math.round(c.endSec * fps))?.text ?? "";
}

export function captionFontSize(scene: VideoScene, format: VideoFormat, scale = 1) {
  const layout = getEditingLayout(format, scale);
  return resolveCaptionCues(scene, format).reduce((font, cue) => Math.min(font,
    fitText(cue.text, layout.caption, layout.captionFont, layout.captionMinFont, 2, Math.round(16 * scale)).fontSize), layout.captionFont);
}

/** One typography budget across every scene/cue, recomputed in actual output pixels. */
export function projectCaptionTypography(project: VideoProject, scale = 1) {
  const fontSize = project.scenes.reduce((font, scene) => Math.min(font, captionFontSize(scene, project.format, scale)), getEditingLayout(project.format, scale).captionFont);
  return {fontSize, lineHeight:Math.ceil(fontSize * 1.35)};
}

export function fitMedia(box: PixelRect, source: { width: number; height: number }, fit: "contain" | "cover") {
  const scale = (fit === "cover" ? Math.max : Math.min)(box.width / source.width, box.height / source.height);
  const width = Math.round(source.width * scale), height = Math.round(source.height * scale);
  return { x: box.x + Math.round((box.width - width) / 2), y: box.y + Math.round((box.height - height) / 2), width, height };
}

export function focusPixels(scene: VideoScene, box: PixelRect): PixelRect | undefined {
  if (!scene.focusRegion || !scene.mediaSize) return undefined;
  const media = fitMedia(box, scene.mediaSize, scene.mediaFit ?? "contain");
  return projectFocusPixels(scene, media);
}

export function projectFocusPixels(scene: VideoScene, media: PixelRect): PixelRect | undefined {
  if (!scene.focusRegion) return undefined;
  const r = scene.focusRegion;
  const x = Math.round(media.x + r.x * media.width), y = Math.round(media.y + r.y * media.height);
  return { x, y, width: Math.round(media.x + (r.x + r.width) * media.width) - x, height: Math.round(media.y + (r.y + r.height) * media.height) - y };
}

/** The overview remains complete; the labelled detail is an additional source crop. */
export function getMediaPanels(scene: VideoScene, box: PixelRect, scale = 1) {
  if (!scene.focusRegion || !scene.mediaSize || !scene.mediaUrl || scene.mediaType === "none" || scene.focusDetail === false) return {overview:box};
  const inset = Math.round(24 * scale), gap = Math.round(16 * scale), label = Math.round(60 * scale);
  const width = box.width - inset * 2, overviewWidth = Math.round((width - gap) * 0.36);
  const overview = {x:box.x + inset, y:box.y + label, width:overviewWidth, height:box.height - label - inset};
  return {overview, detail:{x:overview.x + overview.width + gap, y:overview.y, width:width - overview.width - gap, height:overview.height}};
}

export function focusDetailProjection(scene: VideoScene, box: PixelRect) {
  if (!scene.focusRegion || !scene.mediaSize) return undefined;
  const r = scene.focusRegion, size = scene.mediaSize;
  const w = Math.min(1, Math.max(0.4, r.width * 2.5)), h = Math.min(1, Math.max(0.22, r.height * 2.5));
  const width = Math.max(1,Math.round(w * size.width)), height = Math.max(1,Math.round(h * size.height));
  const crop = {x:Math.min(size.width - width,Math.round(Math.max(0,r.x + r.width / 2 - w / 2) * size.width)),
    y:Math.min(size.height - height,Math.round(Math.max(0,r.y + r.height / 2 - h / 2) * size.height)),width,height};
  const viewport = fitMedia(box, crop, "contain");
  const sx = viewport.width / crop.width, sy = viewport.height / crop.height;
  const x = viewport.x + Math.round(-crop.x * sx), y = viewport.y + Math.round(-crop.y * sy);
  const media = {x,y,width:viewport.x + Math.round((size.width - crop.x) * sx) - x,height:viewport.y + Math.round((size.height - crop.y) * sy) - y};
  return {crop, viewport, media, focus:projectFocusPixels(scene, media)!};
}

export function attentionAtFrame(scene: VideoScene, frame: number, fps: number, motion: boolean) {
  const r = scene.focusRegion;
  if (!r || frame < Math.round(r.startSec * fps) || frame >= Math.round(r.endSec * fps)) return 0;
  if (!motion) return 1;
  const duration = Math.max(1, Math.round(r.endSec * fps) - Math.round(r.startSec * fps));
  const elapsed = frame - Math.round(r.startSec * fps);
  return Math.min(1, (elapsed + 1) / Math.min(8, duration), (duration - elapsed) / Math.min(8, duration));
}

export type EditingIssue = { sceneId: string; level: "error" | "warning"; message: string };
export function inspectEditingProject(project: VideoProject, scale = 1): EditingIssue[] {
  if (!project.editingPreset) return [];
  const layout = getEditingLayout(project.format, scale), fps = getPreset(project.format).fps;
  const px = (n: number) => Math.round(n * scale), typography = projectCaptionTypography(project, scale);
  const issues: EditingIssue[] = [];
  for (const scene of project.scenes) {
    const add = (level: EditingIssue["level"], message: string) => issues.push({ sceneId: scene.id, level, message });
    for (const [name, text, box, max, min, lines] of [
      ["헤드라인", scene.headline, layout.heading, layout.headingFont, px(40), 3],
      ["설명", scene.body, layout.body, layout.bodyFont, px(24), 4]
    ] as const) if (fitText(text, box, max, min, lines).overflow) add("error", `${name}이 고정 영역을 넘습니다. 문장을 줄이세요.`);
    if (scene.narration.trim() && scene.captionCues === undefined) add("warning", "자막은 균등 분배 초안입니다. 실제 음성에 맞춰 cue 시간을 확인하세요.");
    let end = 0;
    for (const cue of resolveCaptionCues(scene, project.format)) {
      if (cue.startSec < end || cue.endSec <= cue.startSec || cue.endSec > scene.durationSec || Math.round(cue.endSec * fps) <= Math.round(cue.startSec * fps)) add("error", "자막 시간이 겹치거나 장면/프레임 범위를 넘습니다.");
      end = cue.endSec;
      if (fitText(cue.text, layout.caption, typography.fontSize, typography.fontSize, 2, px(16)).overflow) add("error", "자막이 고정 2줄 영역을 넘습니다. cue를 나누세요.");
    }
    const hasMedia = Boolean(scene.mediaUrl && scene.mediaType && scene.mediaType !== "none");
    if (hasMedia && !scene.mediaSize) add("warning", "원본 미디어 크기가 없어 크롭/강조 좌표를 검증할 수 없습니다.");
    if (hasMedia && scene.mediaFit === "cover") add("warning", "가득 채움은 원본 일부를 자릅니다. 실제 UI가 잘리지 않는지 확인하세요.");
    if (scene.focusRegion) {
      if (!hasMedia || !scene.mediaSize) add("error", "UI 강조에는 미디어와 원본 가로·세로 크기가 필요합니다.");
      if (scene.focusRegion.endSec > scene.durationSec) add("error", "UI 강조 시간이 장면을 넘습니다.");
      const panels = getMediaPanels(scene, layout.media, scale), target = focusPixels(scene, panels.overview);
      if (target && (!containsRect(panels.overview, target) || target.width < 4 || target.height < 4)) add("error", "UI 강조 영역이 크롭되거나 너무 작습니다. contain 또는 강조 좌표를 수정하세요.");
      const detail = panels.detail && focusDetailProjection(scene, panels.detail);
      if (detail && !containsRect(detail.viewport, detail.focus)) add("error", "상세 확대 창에서 UI 강조가 잘립니다. 원본 좌표를 확인하세요.");
    }
    for (const step of scene.explanationSteps ?? []) if (fitText(step, { x: 0, y: 0, width: layout.media.width - px(112), height: px(70) }, px(32), px(24), 2).overflow) add("error", "설명 단계 문장이 카드 영역을 넘습니다.");
  }
  return issues;
}

/** Enabling a style creates a new project ID so saving preserves the original plan. */
export function forkWithEditingPreset(project: VideoProject, editingPreset: EditingPresetId): VideoProject {
  const now = new Date().toISOString();
  return { ...structuredClone(project), id: crypto.randomUUID(), editingPreset, title: `${project.title} · 설명 편집`, createdAt: now, updatedAt: now };
}
