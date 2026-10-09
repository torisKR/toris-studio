import { test } from "node:test";
import assert from "node:assert/strict";
import type { VideoProject, VideoScene } from "../lib/video/types";
import {
  applyGeneratedSceneVoice,
  generateSceneVoices,
  type GeneratedSceneVoice
} from "../lib/video/voice-generation";

function scene(id: string, narration = `${id} 내레이션`): VideoScene {
  return { id, headline: id, body: "보조 설명", narration, durationSec: 8 };
}

function project(): VideoProject {
  return {
    id: "original-project",
    title: "원본 프로젝트",
    format: "shorts",
    template: "reference-briefing",
    language: "ko",
    scenes: [
      {
        ...scene("first"),
        audioPath: "/generated/old.wav",
        captionCues: [{ startSec: 0, endSec: 1, text: "이전 자막" }]
      },
      scene("second")
    ],
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z"
  };
}

const voice: GeneratedSceneVoice = { audioPath: "/generated/new.wav", durationSec: 1.017 };

test("short narration retains the composition's one-second minimum", () => {
  const source = project();
  const result = applyGeneratedSceneVoice(source, source, "first", { ...voice, durationSec: 0.2 });
  assert.equal(result.scenes[0].durationSec, 1);
});

test("applies fractional audio duration with at least half a second of tail and preserves other edits", () => {
  const source = project();
  const current = structuredClone(source);
  current.title = "합성 중 수정한 제목";
  current.scenes[0].headline = "수정한 화면 문구";
  current.scenes[0].mediaUrl = "/assets/new.png";
  const result = applyGeneratedSceneVoice(current, source, "first", voice);

  assert.notEqual(result, current);
  assert.equal(result.title, current.title);
  assert.equal(result.scenes[0].headline, current.scenes[0].headline);
  assert.equal(result.scenes[0].mediaUrl, current.scenes[0].mediaUrl);
  assert.equal(result.scenes[0].audioPath, voice.audioPath);
  assert.equal(result.scenes[0].durationSec, 46 / 30);
  assert.ok(result.scenes[0].durationSec - voice.durationSec >= 0.5);
  assert.equal(result.scenes[0].captionCues, undefined);
  assert.equal(result.scenes[1], current.scenes[1]);
  assert.equal(current.scenes[0].audioPath, "/generated/old.wav");
  assert.equal(source.scenes[0].headline, "first");
});

test("discards delayed results after project, language, narration, audio or scene changes", async t => {
  const changes: Array<[string, (current: VideoProject) => void]> = [
    ["project switched", current => { current.id = "another-project"; }],
    ["language changed", current => { current.language = "en"; }],
    ["narration edited", current => { current.scenes[0].narration = "다른 대본"; }],
    ["audio replaced", current => { current.scenes[0].audioPath = "/assets/imported.wav"; }],
    ["audio removed", current => { current.scenes[0].audioPath = undefined; }],
    ["scene deleted", current => { current.scenes.shift(); }]
  ];
  for (const [name, change] of changes) {
    await t.test(name, () => {
      const source = project();
      const current = structuredClone(source);
      change(current);
      assert.equal(applyGeneratedSceneVoice(current, source, "first", voice), current);
    });
  }
});

test("does not attach a result to a scene absent from the request snapshot", () => {
  const source = project();
  const current = structuredClone(source);
  current.scenes.push(scene("new-scene"));
  assert.equal(applyGeneratedSceneVoice(current, source, "new-scene", voice), current);
});

test("attaches first audio when both snapshots have no existing audio", () => {
  const source = project();
  const current = structuredClone(source);
  const result = applyGeneratedSceneVoice(current, source, "second", voice);
  assert.equal(result.scenes[1].audioPath, voice.audioPath);
  assert.equal(result.scenes[0], current.scenes[0]);
});

test("rejects empty paths and invalid audio durations", () => {
  const source = project();
  for (const audioPath of ["", " \n\t "]) {
    assert.throws(() => applyGeneratedSceneVoice(source, source, "first", { ...voice, audioPath }), /path/);
  }
  for (const durationSec of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => applyGeneratedSceneVoice(source, source, "first", { ...voice, durationSec }), /duration/);
  }
});

test("skips blank narration and completes each callback before the next synthesis", async () => {
  const first = scene("first");
  const second = scene("second");
  const gate = Promise.withResolvers<GeneratedSceneVoice>();
  const events: string[] = [];
  const running = generateSceneVoices(
    [scene("blank", " \n\t "), first, scene("empty", ""), second],
    async current => {
      events.push(`synthesize:${current.id}`);
      return current.id === "first" ? gate.promise : voice;
    },
    (current, result) => {
      assert.equal(result, voice);
      events.push(`generated:${current.id}`);
    },
    (completed, total) => events.push(`progress:${completed}/${total}`)
  );
  assert.deepEqual(events, ["synthesize:first"]);
  gate.resolve(voice);
  assert.equal(await running, 2);
  assert.deepEqual(events, [
    "synthesize:first", "generated:first", "progress:1/2",
    "synthesize:second", "generated:second", "progress:2/2"
  ]);
});

test("returns zero without callbacks when there is no narration", async () => {
  const unexpected = () => { throw new Error("Unexpected callback"); };
  assert.equal(await generateSceneVoices([scene("blank", " ")], unexpected, unexpected, unexpected), 0);
});

test("preserves successful callbacks and stops after a synthesis failure", async () => {
  const attempted: string[] = [];
  const generated: string[] = [];
  const progress: number[][] = [];
  const failure = new Error("Synthesis failed");
  await assert.rejects(generateSceneVoices(
    [scene("first"), scene("second"), scene("third")],
    async current => {
      attempted.push(current.id);
      if (current.id === "second") throw failure;
      return voice;
    },
    current => { generated.push(current.id); },
    (completed, total) => { progress.push([completed, total]); }
  ), error => error === failure);
  assert.deepEqual(attempted, ["first", "second"]);
  assert.deepEqual(generated, ["first"]);
  assert.deepEqual(progress, [[1, 3]]);
});

test("checks continuation before each request and leaves an in-flight result to the guarded callback", async () => {
  let continuing = true;
  const gate = Promise.withResolvers<GeneratedSceneVoice>();
  const generated: string[] = [];
  const attempted: string[] = [];
  const running = generateSceneVoices(
    [scene("first"), scene("second")],
    async current => { attempted.push(current.id); return gate.promise; },
    current => { generated.push(current.id); },
    undefined,
    () => continuing
  );
  continuing = false;
  gate.resolve(voice);
  assert.equal(await running, 1);
  assert.deepEqual(attempted, ["first"]);
  assert.deepEqual(generated, ["first"]);

  const unexpected = () => { throw new Error("Unexpected callback"); };
  assert.equal(await generateSceneVoices([scene("first")], unexpected, unexpected, unexpected, () => false), 0);
});
