import assert from "node:assert/strict";
import test from "node:test";
import { duplicateVideoProject } from "../desktop/src/video-project-actions";
import type { StudioVideoProject } from "../desktop/src/video-idea";

const project: StudioVideoProject = {
  id: "source-project", title: "원본 영상", format: "shorts", template: "adaptive-promo", language: "ko",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  templateRecipe: { version: 1, id: "quick-explainer", name: "설명 영상" },
  scenes: [{ id: "scene-1", headline: "원본 제목", body: "원본 본문", narration: "원본 음성", durationSec: 5, mediaType: "image", mediaUrl: "media/example.png", motion: { preset: "stagger-rise", intensity: .5 } }],
};

test("duplicating a project generates independent drafts and retains media and recipe", () => {
  const first = duplicateVideoProject(project), second = duplicateVideoProject(project);
  assert.notEqual(first.id, project.id);
  assert.notEqual(first.id, second.id);
  assert.equal(first.title, "원본 영상 사본");
  assert.equal(first.scenes[0].mediaUrl, project.scenes[0].mediaUrl);
  assert.deepEqual(first.templateRecipe, project.templateRecipe);
  first.scenes[0].headline = "복제한 장면 편집";
  if (first.templateRecipe) first.templateRecipe.name = "다른 이름";
  assert.equal(project.scenes[0].headline, "원본 제목");
  assert.equal(second.scenes[0].headline, "원본 제목");
  assert.equal(project.templateRecipe?.name, "설명 영상");
});

test("duplicated title stays within native character limit including non-BMP text", () => {
  const copy = duplicateVideoProject({ ...project, title: "🎬".repeat(300) });
  assert.equal(Array.from(copy.title).length, 300);
  assert.ok(copy.title.endsWith(" 사본"));
});
