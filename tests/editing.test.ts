import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { attentionAtFrame, captionAtFrame, projectCaptionTypography, containsRect, fitMedia, fitText, focusPixels, focusDetailProjection, getMediaPanels, getEditingOutputSize, forkWithEditingPreset, getEditingLayout, inspectEditingProject, resolveCaptionCues, wrapText } from "../lib/video/editing";
import { createExplainerSample } from "../lib/video/explainer-sample";
import { createReferenceBriefingProject } from "../lib/video/templates";
import { projectSchema } from "../lib/video/schema";
import { getLocalProject, saveLocalProject } from "../lib/storage/local-project-repository";
import { ProjectExplainerFrame } from "../remotion/templates/ProjectExplainerScene";
import { EditingControls } from "../components/EditingControls";
import type { VideoFormat, VideoProject } from "../lib/video/types";
import { renderProject } from "../lib/render/render-video";

const formats: VideoFormat[] = ["youtube-landscape", "vertical", "shorts"];

test("regression: meaningful Korean words do not split when each word fits", () => {
  assert.deepEqual(wrapText("설명할 곳을 짚습니다", 624, 64), ["설명할 곳을", "짚습니다"]);
  assert.ok(!wrapText("음성 없는 6초 시각 검토 샘플입니다.", 624, 32).some(line => line === "니다."));
});

test("regression: all scenes share caption typography and important borders stay inset", () => {
  const p = createExplainerSample("shorts");
  const styles = p.scenes.map((scene, index) => {
    const html = renderToStaticMarkup(createElement(ProjectExplainerFrame, {project:p,scene:{...scene,mediaUrl:undefined},index,frame:0,fps:30}));
    assert.equal(html.includes("outline:"), false);
    const style = html.match(/<div[^>]*style="([^"]*background:#050912F2[^"]*)"/)![1];
    return style.match(/font-size:[^;]+;line-height:[^;]+/)![0];
  });
  assert.equal(new Set(styles).size, 1);
});

test("output canvases, caption typography and focus/detail geometry use integer physical pixels", () => {
  for (const format of formats) for (const scale of [1,0.5,0.25]) {
    const p = createExplainerSample(format), layout = getEditingLayout(format,scale);
    assert.deepEqual(inspectEditingProject(p,scale), []);
    const size = getEditingOutputSize(format,scale);
    assert.ok(size.width % 2 === 0 && size.height % 2 === 0);
    const type = projectCaptionTypography(p,scale);
    assert.ok(Number.isInteger(type.fontSize) && Number.isInteger(type.lineHeight));
    const panels = getMediaPanels(p.scenes[0],layout.media,scale);
    const overview = fitMedia(panels.overview,p.scenes[0].mediaSize!,"contain");
    const detail = focusDetailProjection(p.scenes[0],panels.detail!)!;
    assert.ok(containsRect(panels.overview,overview));
    assert.ok(containsRect(detail.viewport,detail.focus));
    assert.ok(detail.focus.width >= focusPixels(p.scenes[0],panels.overview)!.width * 2);
    for (const rect of [layout.safe,layout.caption,overview,panels.overview,panels.detail!,detail.viewport,detail.media,detail.focus]) assert.ok(Object.values(rect).every(Number.isInteger));
    for (const rect of [panels.overview,panels.detail!,detail.viewport,detail.focus]) assert.ok(containsRect(layout.safe,rect));
    assert.deepEqual(getMediaPanels({...p.scenes[0],focusDetail:false},layout.media,scale),{overview:layout.media});
    const htmls = p.scenes.map((scene,index)=>renderToStaticMarkup(createElement(ProjectExplainerFrame,{project:p,scene:{...scene,mediaUrl:undefined},index,frame:0,fps:30,outputScale:scale})));
    for (const html of htmls) {
      assert.ok(html.includes(`font-size:${type.fontSize}px;line-height:${type.lineHeight}px`));
      assert.ok(!/(?:left|top|width|height|font-size|line-height|padding|border-radius):[-\d]+\.\d+px/.test(html));
      assert.equal(html.includes("outline:"),false);
      assert.equal(html.includes("box-shadow:"),false);
    }
  }
  assert.throws(()=>getEditingOutputSize("shorts",0.333),/integer, even/);
});

test("detail source crop contains targets near both source edges and survives JSON roundtrip", () => {
  const p = createExplainerSample("shorts");
  for (const x of [0,0.8]) for (const y of [0,0.8]) {
    const scene = {...p.scenes[0],focusDetail:true,focusRegion:{...p.scenes[0].focusRegion!,x,y,width:0.2,height:0.2}};
    const panel = getMediaPanels(scene,getEditingLayout(p.format).media).detail!;
    const detail = focusDetailProjection(scene,panel)!;
    assert.ok(containsRect(detail.viewport,detail.focus));
    assert.ok(containsRect({x:0,y:0,...scene.mediaSize!},detail.crop));
    assert.equal(projectSchema.parse({...p,scenes:[scene]}).scenes[0].focusDetail,true);
  }
});

test("opt-in forks the plan and its nested scenes; old projects retain legacy rendering eligibility", () => {
  const old = createReferenceBriefingProject();
  const before = structuredClone(old);
  const next = forkWithEditingPreset(old, "project-explainer");
  assert.notEqual(next.id, old.id);
  assert.deepEqual(old, before);
  next.scenes[0].headline = "edited";
  assert.equal(old.scenes[0].headline, before.scenes[0].headline);
  assert.equal(projectSchema.parse(old).editingPreset, undefined);
  assert.deepEqual(inspectEditingProject(old), []);
});

test("both layouts keep integer caption/heading/media rectangles inside their authored safe areas without overlap", () => {
  for (const format of formats) {
    const layout = getEditingLayout(format);
    for (const rect of [layout.heading, layout.body, layout.media, layout.caption]) {
      assert.ok(containsRect(layout.safe, rect));
      assert.ok(Object.values(rect).every(Number.isInteger));
    }
    assert.ok(layout.media.y + layout.media.height < layout.caption.y);
    assert.ok(layout.heading.y + layout.heading.height <= layout.body.y);
    if (format !== "youtube-landscape") assert.ok(layout.body.y + layout.body.height < layout.media.y);
  }
  assert.notDeepEqual(getEditingLayout("shorts").media, getEditingLayout("youtube-landscape").media);
});

test("manual cue gaps, end-exclusive boundaries and explicit empty captions are respected at 30fps", () => {
  const scene = createExplainerSample("shorts").scenes[0];
  scene.captionCues = [{ startSec: 0.5, endSec: 1, text: "하나" }, { startSec: 1.5, endSec: 2, text: "둘" }];
  for (const [frame, expected] of [[14, ""], [15, "하나"], [29, "하나"], [30, ""], [44, ""], [45, "둘"], [60, ""]] as const) assert.equal(captionAtFrame(scene, "shorts", frame, 30), expected);
  assert.equal(captionAtFrame({ ...scene, captionCues: [] }, "shorts", 15, 30), "");
});

test("long Korean, no-space text and emoji stay complete while fallback cues fit two lines", () => {
  const text = "아주긴한국어문장과👩‍💻이모지를함께설명합니다 ".repeat(8).trim();
  assert.equal(wrapText("👩‍💻👩‍💻", 80, 32).length, 1);
  for (const format of formats) {
    const p = createExplainerSample(format), s = { ...p.scenes[0], focusRegion: undefined, captionCues: undefined, narration: text, durationSec: 30 };
    const cues = resolveCaptionCues(s, format);
    assert.equal(cues.map(c => c.text).join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
    assert.ok(cues.every(c => !fitText(c.text, getEditingLayout(format).caption, 44, getEditingLayout(format).captionMinFont, 2, 16).overflow));
    assert.ok(inspectEditingProject({ ...p, scenes: [s] }).some(i => i.level === "warning" && i.message.includes("초안")));
  }
});

test("contain projection preserves a portrait UI; cover clipping blocks an annotated target", () => {
  const p = createExplainerSample("youtube-landscape"), s = p.scenes[0], box = getEditingLayout(p.format).media;
  assert.ok(containsRect(box, fitMedia(box, s.mediaSize!, "contain")));
  const target = focusPixels(s, box)!;
  assert.ok(containsRect(box, target));
  assert.ok(Object.values(target).every(Number.isInteger));
  s.mediaFit = "cover";
  s.focusRegion = { ...s.focusRegion!, y: 0.02 };
  assert.ok(inspectEditingProject(p).some(i => i.level === "error" && i.message.includes("크롭")));
  s.mediaSize = undefined;
  assert.ok(inspectEditingProject(p).some(i => i.level === "error" && i.message.includes("원본")));
});

test("overlong text, overlapping cues and out-of-scene focus are blocked before rendering", () => {
  const p = createExplainerSample("shorts"), s = p.scenes[0];
  s.headline = "너무긴헤드라인".repeat(50);
  s.captionCues = [{ startSec: 0, endSec: 2, text: "자막".repeat(100) }, { startSec: 1, endSec: 4, text: "겹침" }];
  s.focusRegion!.endSec = 4;
  const issues = inspectEditingProject(p).filter(i => i.level === "error");
  assert.ok(issues.some(i => i.message.includes("헤드라인")));
  assert.ok(issues.some(i => i.message.includes("자막 시간")));
  assert.ok(issues.some(i => i.message.includes("2줄")));
  assert.ok(issues.some(i => i.message.includes("강조 시간")));
  s.focusRegion!.x = 0.99;
  assert.equal(projectSchema.safeParse(p).success, false);
});

test("render entry rejects unsafe caption layout before starting any browser or creating output", async () => {
  const p = createExplainerSample("shorts");
  p.scenes[0].headline = "초과".repeat(200);
  await assert.rejects(renderProject(p), /헤드라인/);
});

test("attention stays within a timed interval and still preset never animates its strength", () => {
  const s = createExplainerSample("shorts").scenes[0];
  assert.equal(attentionAtFrame(s, 14, 30, true), 0);
  assert.equal(attentionAtFrame(s, 75, 30, true), 0);
  assert.ok(attentionAtFrame(s, 15, 30, true) < attentionAtFrame(s, 30, 30, true));
  assert.equal(attentionAtFrame(s, 15, 30, false), 1);
  assert.equal(attentionAtFrame(s, 74, 30, false), 1);
});

test("frame component keeps the same caption position, font and line height across cue changes", () => {
  for (const format of formats) {
    const p = createExplainerSample(format), s = p.scenes[1];
    s.captionCues = [{ startSec: 0, endSec: 1, text: "짧은 자막" }, { startSec: 1, endSec: 3, text: "길이가 다른 자막도 고정 좌표에서 읽습니다" }];
    const a = renderToStaticMarkup(createElement(ProjectExplainerFrame, { project: p, scene: s, index: 1, frame: 0, fps: 30 }));
    const b = renderToStaticMarkup(createElement(ProjectExplainerFrame, { project: p, scene: s, index: 1, frame: 45, fps: 30 }));
    const box = getEditingLayout(format).caption, font = projectCaptionTypography(p).fontSize;
    for (const html of [a, b]) {
      assert.ok(html.includes(`left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px`));
      assert.ok(html.includes(`font-size:${font}px;line-height:${Math.ceil(font * 1.35)}px;padding:16px`));
      assert.equal(html.includes("transform:"), false);
    }
    assert.notEqual(a, b);
  }
});

test("editor exposes opt-in controls and sample projects pass both schema and layout preflight", () => {
  for (const format of formats) {
    const p = createExplainerSample(format);
    assert.equal(projectSchema.safeParse(p).success, true);
    assert.deepEqual(inspectEditingProject(p), []);
    const html = renderToStaticMarkup(createElement(EditingControls, { project: p, scene: p.scenes[0], onPreset: () => {}, patchScene: () => {} }));
    assert.ok(html.includes("project-explainer"));
    assert.ok(html.includes("자막 cue JSON"));
    assert.ok(html.includes("UI 강조 영역 JSON"));
  }
});

test("schema and local save/load roundtrip retain style, manual cues, source size and UI focus", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "toris-editing-test-"));
  const previous = process.env.TORIS_STUDIO_DATA_DIR;
  process.env.TORIS_STUDIO_DATA_DIR = dir;
  try {
    const p = createExplainerSample("shorts");
    const parsed: VideoProject = { ...p, ...projectSchema.parse(p), id: p.id };
    await saveLocalProject(parsed);
    assert.deepEqual(await getLocalProject(p.id), p);
  } finally {
    if (previous === undefined) delete process.env.TORIS_STUDIO_DATA_DIR;
    else process.env.TORIS_STUDIO_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
