import assert from "node:assert/strict";
import test from "node:test";
import { formatPreviewTime, readVideoTemplateCatalog, readVideoTemplateLibrary, readVideoTemplatePreview, sceneAtElapsed, sceneStartSeconds, templateBeatAt, templatesForLibraryView } from "../desktop/src/video-templates";

function project() {
  return {
    id: "sample-project", title: "새 습관을 만드는 방법", format: "shorts", template: "reference-briefing", language: "ko",
    createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z",
    templateRecipe: { version: 1, id: "knowledge-short", name: "지식 전달" },
    scenes: [
      { id: "one", headline: "한 가지씩 시작하세요", body: "작은 습관으로 바꾸는 하루", narration: "하루에 하나부터 시작해 보세요.", durationSec: 2, accent: "#8AE3BB", motion: { preset: "kinetic-title", intensity: .6 } },
      { id: "two", headline: "두 번째 장면", body: "다음 행동을 제시합니다.", narration: "이제 다음 행동으로 이어갑니다.", durationSec: 3, accent: "#8AE3BB", motion: { preset: "slide-reveal", intensity: .4 } }
    ]
  };
}
function catalog() {
  return [{ id: "knowledge-short", name: "지식 전달", tagline: "핵심 정보로 시작하는 짧은 영상", description: "문제와 해결을 장면으로 나눕니다.", categories: ["education"], format: "shorts", durationSec: 5, accent: "#8AE3BB", sampleTopic: "습관 만들기", beats: [{ label: "도입", intent: "시선을 모으는 핵심 문장", motion: { preset: "kinetic-title", intensity: .6 } }], sampleProject: project() }];
}

test("template catalog accepts the native descriptor and preview contracts", () => {
  assert.equal(readVideoTemplateCatalog(catalog())?.[0].sampleProject.scenes.length, 2);
  assert.equal(readVideoTemplatePreview({ project: project(), prompt: "이 구성으로 내 주제의 초안을 작성하세요.", warnings: [] })?.project.title, "새 습관을 만드는 방법");
});

test("catalog rejects malformed or duplicate descriptors and unsafe CSS colors", () => {
  assert.equal(readVideoTemplateCatalog(null), null);
  assert.equal(readVideoTemplateCatalog([]), null);
  assert.equal(readVideoTemplateCatalog([catalog()[0], catalog()[0]]), null);
  assert.equal(readVideoTemplateCatalog([{ ...catalog()[0], accent: "url(https://invalid.example/image)" }]), null);
  assert.equal(readVideoTemplateCatalog([{ ...catalog()[0], format: "unsupported" }]), null);
  assert.equal(readVideoTemplateCatalog([{ ...catalog()[0], categories: [null] }]), null);
});

test("catalog rejects untrusted motion and invalid scene durations", () => {
  const invalidBeat = catalog();
  invalidBeat[0].beats[0].motion.preset = "constructor";
  assert.equal(readVideoTemplateCatalog(invalidBeat), null);
  const invalidProject = catalog();
  invalidProject[0].sampleProject.scenes[0].durationSec = Number.NaN;
  assert.equal(readVideoTemplateCatalog(invalidProject), null);
  const duplicateScene = catalog();
  duplicateScene[0].sampleProject.scenes[1].id = "one";
  assert.equal(readVideoTemplateCatalog(duplicateScene), null);
});

test("preview rejects malformed warnings, oversized payloads and recipe metadata", () => {
  assert.equal(readVideoTemplatePreview({ project: project(), prompt: "", warnings: [false] }), null);
  assert.equal(readVideoTemplatePreview({ project: project(), prompt: "a".repeat(50001), warnings: [] }), null);
  assert.equal(readVideoTemplatePreview({ project: { ...project(), templateRecipe: { version: 2, id: "knowledge-short", name: "지식" } }, prompt: "", warnings: [] }), null);
  assert.equal(readVideoTemplatePreview({ project: { ...project(), scenes: [] }, prompt: "", warnings: [] }), null);
});

test("storyboard timing follows actual scene durations and exact boundaries", () => {
  const scenes = [{ durationSec: 2 }, { durationSec: 3 }, { durationSec: 7 }];
  assert.deepEqual(sceneAtElapsed(scenes, 0), { index: 0, startSec: 0, endSec: 2, elapsedSec: 0, progress: 0, totalSec: 12 });
  assert.equal(sceneAtElapsed(scenes, 1.999)?.index, 0);
  assert.equal(sceneAtElapsed(scenes, 2)?.index, 1);
  assert.equal(sceneAtElapsed(scenes, 3.5)?.progress, .5);
  assert.equal(sceneAtElapsed(scenes, 5)?.index, 2);
  assert.equal(sceneAtElapsed(scenes, 12)?.progress, 1);
  assert.equal(sceneAtElapsed(scenes, 99)?.elapsedSec, 12);
  assert.equal(sceneAtElapsed(scenes, -1)?.elapsedSec, 0);
});

test("storyboard rejects nonfinite, zero, negative and unbounded durations", () => {
  for (const scenes of [[], [{ durationSec: 0 }], [{ durationSec: -1 }], [{ durationSec: Number.NaN }], [{ durationSec: 601 }], Array.from({ length: 25 }, () => ({ durationSec: 1 })), Array.from({ length: 7 }, () => ({ durationSec: 600 }))]) {
    assert.equal(sceneAtElapsed(scenes, 0), null);
  }
  assert.equal(sceneAtElapsed([{ durationSec: 2 }], Number.POSITIVE_INFINITY), null);
});

test("scene seeking and time labels remain deterministic", () => {
  const scenes = [{ durationSec: 2 }, { durationSec: 3 }, { durationSec: 7 }];
  assert.equal(sceneStartSeconds(scenes, 2), 5);
  assert.equal(sceneStartSeconds(scenes, -1), 0);
  assert.equal(sceneStartSeconds(scenes, 99), 0);
  assert.equal(sceneStartSeconds([{ durationSec: Number.NaN }, { durationSec: 1 }], 1), 0);
  assert.equal(formatPreviewTime(65.5), "1:05");
  assert.equal(formatPreviewTime(Number.NaN), "0:00");
});

test("three-scene previews preserve the native intro, middle and final beat intent", () => {
  const beats = Array.from({ length: 5 }, (_, index) => ({ label: `장면 ${index}`, intent: `의도 ${index}` }));
  assert.deepEqual(Array.from({ length: 3 }, (_, index) => templateBeatAt(beats, index, 3)?.label), ["장면 0", "장면 1", "장면 4"]);
  assert.equal(templateBeatAt(beats, 2, 3)?.intent, "의도 4");
});

test("eight-scene previews distribute native middle beats without replacing the final beat", () => {
  const beats = ["intro", "concept", "example", "application", "outro"];
  assert.deepEqual(Array.from({ length: 8 }, (_, index) => templateBeatAt(beats, index, 8)), ["intro", "concept", "concept", "example", "example", "application", "application", "outro"]);
  assert.equal(templateBeatAt(beats, -1, 8), undefined);
  assert.equal(templateBeatAt([], 0, 8), undefined);
  assert.equal(templateBeatAt(beats, 8, 8), undefined);
});

test("expanded ten-template catalogs pass the same native descriptor validation", () => {
  const templates = Array.from({ length: 10 }, (_, index) => ({ ...catalog()[0], id: `original-template-${index}`, sampleProject: { ...project(), id: `sample-${index}`, templateRecipe: { version: 1, id: `original-template-${index}`, name: `템플릿 ${index}` } } }));
  assert.equal(readVideoTemplateCatalog(templates)?.length, 10);
  assert.equal(readVideoTemplateCatalog(Array.from({ length: 33 }, (_, index) => ({ ...templates[0], id: `template-${index}` }))), null);
});

test("native template library validates persisted version, IDs, uniqueness and bounds", () => {
  const valid = { version: 1, favorites: ["knowledge-short"], recent: ["product-demo", "knowledge-short"] };
  assert.deepEqual(readVideoTemplateLibrary(valid), valid);
  assert.deepEqual(readVideoTemplateLibrary({ version: 1, favorites: [], recent: [] }), { version: 1, favorites: [], recent: [] });
  for (const invalid of [null, {}, { ...valid, version: 2 }, { ...valid, favorites: "knowledge-short" }, { ...valid, recent: [null] }, { ...valid, favorites: ["../file"] }, { ...valid, recent: ["knowledge-short", "knowledge-short"] }, { ...valid, favorites: Array.from({ length: 33 }, (_, index) => `template-${index}`) }]) {
    assert.equal(readVideoTemplateLibrary(invalid), null);
  }
});

test("favorite view preserves catalog order while recent view follows last-use order", () => {
  const templates = readVideoTemplateCatalog(Array.from({ length: 10 }, (_, index) => ({ ...catalog()[0], id: `template-${index}` })))!;
  const library = { version: 1 as const, favorites: ["template-7", "template-2", "removed-template"], recent: ["template-7", "removed-template", "template-2", "template-9"] };
  assert.deepEqual(templatesForLibraryView(templates, library, "favorites").map(({ id }) => id), ["template-2", "template-7"]);
  assert.deepEqual(templatesForLibraryView(templates, library, "recent").map(({ id }) => id), ["template-7", "template-2", "template-9"]);
  assert.equal(templatesForLibraryView(templates, library, "all").length, 10);
  assert.deepEqual(templatesForLibraryView(templates, null, "favorites"), []);
  assert.deepEqual(templatesForLibraryView(templates, { version: 1, favorites: [], recent: [] }, "recent"), []);
});
