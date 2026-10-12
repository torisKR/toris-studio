import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { createRenderProgressSession, initialRenderProgress, nextRenderProgress, renderProgressLabel, VideoRenderProgress, type VideoRenderProgressMessage } from "../desktop/src/video-render-progress";

const event = (stage: VideoRenderProgressMessage["stage"], completedScenes: number, totalScenes = 5): VideoRenderProgressMessage => ({ stage, completedScenes, totalScenes });

test("progress counts only native-completed scenes, including zero before the first scene", () => {
  let progress = initialRenderProgress(5);
  assert.deepEqual(progress, event("preparing", 0));
  progress = nextRenderProgress(progress, event("rendering", 0));
  assert.equal(renderProgressLabel(progress), "장면 렌더링 · 0/5장면 완료");
  progress = nextRenderProgress(progress, event("rendering", 2));
  assert.equal(renderProgressLabel(progress), "장면 렌더링 · 2/5장면 완료");
  assert.throws(() => initialRenderProgress(0), /장면/);
});

test("joining and native completion wait for the durable command result", () => {
  const joining = nextRenderProgress(initialRenderProgress(5), event("joining", 5));
  assert.equal(renderProgressLabel(joining), "최종 MP4 합치는 중");
  const completed = nextRenderProgress(joining, event("completed", 5));
  assert.equal(renderProgressLabel(completed), "출력 파일 확인 중");
  for (const progress of [joining, completed]) {
    const markup = renderToStaticMarkup(createElement(VideoRenderProgress, { progress }));
    assert.match(markup, /max="5" value="5"/);
    assert.doesNotMatch(markup, /MP4 출력 완료|100%/);
  }
});

test("invalid, regressing and different-project counts cannot replace real progress", () => {
  const current = event("rendering", 2);
  for (const value of [null, {}, event("rendering", 1), event("rendering", 6), event("rendering", 3, 7), event("preparing", 0), event("joining", 4), event("completed", 4), event("rendering", 2.5), { ...current, stage: "published" }]) {
    assert.equal(nextRenderProgress(current, value), current);
  }
});

test("progress markup exposes exact scene counts and explicitly separates final output", () => {
  const markup = renderToStaticMarkup(createElement(VideoRenderProgress, { progress: event("rendering", 2) }));
  assert.match(markup, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(markup, /<progress max="5" value="2" aria-label="완료한 장면 수"/);
  assert.match(markup, /2\/5장면 완료/);
  assert.match(markup, /최종 MP4 저장 완료는 별도로 확인/);
  assert.match(markup, /전체 작업 시간의 진행률은 아닙니다/);
});

test("failure settlement clears progress and a late completed event cannot resurrect it", () => {
  const observed: Array<VideoRenderProgressMessage | null> = [];
  const failed = createRenderProgressSession(5, value => observed.push(value));
  failed.receive(event("rendering", 2));
  failed.settle();
  failed.receive(event("completed", 5));
  failed.settle();
  assert.deepEqual(observed, [event("rendering", 2), null]);
  const retry = createRenderProgressSession(5, value => observed.push(value));
  assert.deepEqual(retry.snapshot(), event("preparing", 0));
  retry.receive(event("rendering", 0));
  failed.receive(event("completed", 5));
  assert.deepEqual(observed.at(-1), event("rendering", 0));
});

test("closed request listeners ignore callbacks and hidden views can restore latest real counts", () => {
  let visible = true;
  let displayed = initialRenderProgress(5);
  const session = createRenderProgressSession(5, value => { if (visible && value) displayed = value; });
  session.receive(event("rendering", 1));
  visible = false;
  session.receive(event("rendering", 3));
  assert.equal(displayed.completedScenes, 1);
  visible = true;
  displayed = session.snapshot();
  assert.equal(displayed.completedScenes, 3);
  session.close();
  session.receive(event("completed", 5));
  assert.deepEqual(session.snapshot(), event("rendering", 3));
  assert.equal(displayed.completedScenes, 3);
});

test("native video menu and persistent panel render in the desktop app", async () => {
  // CSS has no server execution. Render the actual App tree without mounting effects
  // or invoking native services; do not replace the VideoPanel with a placeholder.
  const hooks = registerHooks({ load(url, context, nextLoad) {
    return new URL(url).pathname.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : nextLoad(url, context);
  } });
  try {
    const { App } = await tsImport("../desktop/src/App.tsx", { parentURL: import.meta.url, tsconfig: new URL("../desktop/tsconfig.json", import.meta.url).pathname });
    const markup = renderToStaticMarkup(createElement(App));
    assert.match(markup, /영상 제작/);
    assert.match(markup, /<div hidden=""><section class="desktop-video" aria-label="영상 스튜디오"/);
    assert.match(markup, /ChatGPT에 영상 초안 요청/);
    const source = readFileSync(new URL("../desktop/src/App.tsx", import.meta.url), "utf8");
    assert.match(source, /id: "video", label: "영상 제작", icon: Clapperboard, group: "제작"/);
    assert.match(source, /<div hidden=\{tab !== "video"\}><VideoPanel active=\{tab === "video"\} onOpenSettings=\{\(\) => setTab\("settings"\)\} onOpenKeywords=\{\(\) => setTab\("keywords"\)\}/);
  } finally { hooks.deregister(); }
});
