import assert from "node:assert/strict";
import { test } from "node:test";
import { RunManager } from "../src/graph/runs.js";
import { checkStoryboard, fitNarration, productionInput, sceneCount, templateStoryboard, unsafeText, type ProductionInput, type ProductionResult } from "../src/harness/production.js";
import { defaultWorkflows } from "../src/harness/registry.js";
import { RoleModel } from "../src/harness/testing.js";
import { parseSettings } from "../src/runtime.js";
import type { ChatModel } from "../src/llm/types.js";

const ROLES: Array<[string, string]> = [["storyboard", "영상 스토리보드 작가"]];
const SOURCE = { template: false, provider: "ollama", model: "scripted" };
const input: ProductionInput = { topic: "아침 루틴으로 집중력 높이기", durationSec: 15, aspect: "9:16", style: "cinematic", narration: true, language: "ko", visual: "ai" };
const CONSISTENCY = "same young woman in a grey hoodie, warm morning light";

type Draft = { title: string; story: string; style: Record<string, string>; scenes: Array<Record<string, unknown>>; [key: string]: unknown };
function draft(seconds = [5, 5, 5]): Draft {
  return {
    title: "아침 루틴 3가지",
    story: "잠에서 깨어 물을 마시고 창문을 열고 계획을 적는다.",
    style: { look: "cinematic film look, shallow depth of field", palette: "warm amber tones", consistency: CONSISTENCY },
    scenes: seconds.map((durationSec, i) => ({
      id: "s" + (i + 1), order: i + 1, durationSec,
      script: "장면 " + (i + 1) + " 대본", narration: "아침에 물 한 잔을 마셔요.", caption: "물 한 잔",
      prompt: "a woman drinking a glass of water by the window, " + CONSISTENCY, negativePrompt: "text, watermark, blurry",
      transition: i ? "fade" : "cut",
    })),
  };
}
const json = (value: unknown) => JSON.stringify(value);
const settings = () => parseSettings({ projectsRoot: "/nonexistent-root-for-test", chromaUrl: "http://127.0.0.1:9" });

async function runWorkflow(model: ChatModel | null, host: Record<string, unknown> = input) {
  const factory = model ? () => model : () => { throw new Error("Agent 탭의 모델 설정에서 사용할 모델을 선택하세요."); };
  const events: Array<{ phase: string; message: string }> = [];
  const manager = new RunManager(settings, event => events.push(event as never), factory);
  const run = manager.start("", "", "video-production", host);
  await manager.settled(run.runId);
  const view = manager.get(run.runId);
  manager.shutdown();
  return { view, events, result: JSON.parse(view.summary) as ProductionResult };
}

test("host input is validated and extra keys are dropped", () => {
  const ok = productionInput({ ...input, subtitleStyle: "none", engine: "wan2.1-t2v-1.3b", language: undefined });
  assert.deepEqual(ok.input, input, "unknown host keys are dropped and language defaults to ko");
  for (const bad of [{ durationSec: 9 }, { durationSec: 121 }, { durationSec: 15.5 }, { aspect: "4:3" }, { style: "anime" }, { narration: "yes" }, { language: "en" }, { topic: "" }, { topic: "가".repeat(301) }, { topic: "주제\u0007" }]) {
    assert.equal(productionInput({ ...input, ...bad }).input, null, JSON.stringify(bad));
  }
  assert.deepEqual([10, 11, 15, 30, 60, 120].map(d => sceneCount(d)), [2, 3, 3, 6, 12, 12]);
  assert.deepEqual([10, 15, 30, 60].map(d => sceneCount(d, "stock")), [3, 5, 9, 12], "stock cuts follow production.rs scene_count");
});

test("a valid storyboard is accepted and the shared style phrase reaches every prompt", () => {
  const raw = draft();
  raw.scenes[1].prompt = "close-up of a hand opening a window";
  const { storyboard, problems } = checkStoryboard(raw, input, SOURCE);
  assert.deepEqual(problems, []);
  assert.ok(storyboard);
  assert.equal(storyboard.template, false);
  assert.equal(storyboard.scenes.length, 3);
  assert.ok(storyboard.scenes.every(scene => scene.prompt.includes(CONSISTENCY)));
  assert.equal(storyboard.scenes.reduce((sum, scene) => sum + scene.durationSec, 0), 15);
});

test("unknown fields, URLs, paths, code fences and control characters are rejected", () => {
  const cases: Array<[string, (d: Draft) => void, RegExp]> = [
    ["unknown root field", d => { d.voice = "x"; }, /voice/],
    ["unknown scene field", d => { d.scenes[0].ffmpeg = "-vf x"; }, /ffmpeg/],
    ["unknown style field", d => { d.style.filter = "x"; }, /filter/],
    ["url", d => { d.scenes[0].caption = "자세히는 https://example.com"; }, /URL/],
    ["bare www", d => { d.story = "www.example.com 참고"; }, /URL/],
    ["absolute path", d => { d.scenes[1].script = "/Users/toris/.ssh/id_rsa 읽기"; }, /경로/],
    ["parent path", d => { d.scenes[1].prompt = "load ../../secret.mp4, " + CONSISTENCY; }, /경로/],
    ["windows path", d => { d.title = "C:\\Windows 열기"; }, /경로/],
    ["code fence", d => { d.scenes[2].script = "\u0060\u0060\u0060js\nalert(1)\n\u0060\u0060\u0060"; }, /코드/],
    ["shell substitution", d => { d.scenes[2].prompt = "a sunrise $(rm -rf ~), " + CONSISTENCY; }, /코드|경로/],
    ["control char", d => { d.scenes[0].narration = "물\u0000 마시기"; }, /제어 문자/],
    ["bidi override", d => { d.scenes[0].caption = "자막\u202E"; }, /제어 문자/],
    ["bad transition", d => { d.scenes[0].transition = "wipe"; }, /transition/],
    ["korean prompt", d => { d.scenes[0].prompt = "창가에서 물을 마시는 여자, " + CONSISTENCY; }, /영어/],
    ["prompt too long", d => { d.scenes[0].prompt = "a ".repeat(301); }, /600/],
    ["scene too short", d => { d.scenes[0].durationSec = 1; d.scenes[1].durationSec = 9; }, /durationSec/],
    ["duplicate id", d => { d.scenes[1].id = "s1"; }, /중복/],
    ["bad id", d => { d.scenes[1].id = "../s2"; }, /id/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const raw = draft();
    mutate(raw);
    const { storyboard, problems } = checkStoryboard(raw, input, SOURCE);
    assert.equal(storyboard, null, name);
    assert.match(problems.join("\n"), pattern, name);
  }
  assert.equal(unsafeText("profile: 아침형 인간"), null, "ordinary colons are fine");
  assert.equal(unsafeText("50/50 비율"), null, "a slash inside a word is not a path");
});

test("scene count and durations follow the requested length", () => {
  assert.match(checkStoryboard(draft([5, 10]), input, SOURCE).problems.join(), /3개여야/);
  assert.match(checkStoryboard(draft([5, 5, 7]), input, SOURCE).problems.join(), /합계가 17초/);
  assert.ok(checkStoryboard(draft([5, 5, 6]), input, SOURCE).storyboard, "±1s is allowed");
  assert.ok(checkStoryboard(draft([4.5, 5, 5]), input, SOURCE).storyboard);
  for (const durationSec of [10, 11, 15, 29, 37, 60, 61, 119, 120]) {
    const board = templateStoryboard({ ...input, durationSec });
    assert.equal(board.scenes.length, sceneCount(durationSec));
    assert.equal(board.scenes.reduce((sum, scene) => sum + scene.durationSec, 0), durationSec, durationSec + "s template sums exactly");
    assert.ok(board.scenes.every(scene => scene.durationSec >= 2 && scene.durationSec <= 12));
    const { template: _t, provider: _p, model: _m, ...body } = board;
    assert.deepEqual(checkStoryboard(body, { ...input, durationSec }, SOURCE).problems, [], durationSec + "s template passes the same gate");
  }
});

test("korean narration must be readable at 7.5 chars per second: trimmed by sentence or rejected", () => {
  assert.deepEqual(fitNarration("짧은 문장입니다.", 2), { text: "짧은 문장입니다.", trimmed: false });
  const trimmed = fitNarration("아침에 물 한 잔을 마셔요. 그리고 창문을 열어 바람을 들이고 오늘 할 일을 적어 보세요.", 3);
  assert.deepEqual(trimmed, { text: "아침에 물 한 잔을 마셔요.", trimmed: true });
  assert.equal(fitNarration("가".repeat(16), 2), null, "one sentence longer than 15 chars cannot fit 2 seconds");
  const raw = draft();
  raw.scenes[0].narration = "아침에 물 한 잔을 마셔요. " + "그리고 창문을 열어 바람을 들이고 오늘 해야 할 일을 차근차근 적어 보세요.";
  const kept = checkStoryboard(raw, input, SOURCE);
  assert.equal(kept.storyboard?.scenes[0].narration, "아침에 물 한 잔을 마셔요.");
  assert.match(kept.notes.join(), /줄였습니다/);
  raw.scenes[0].narration = "가".repeat(40);
  assert.match(checkStoryboard(raw, input, SOURCE).problems.join(), /너무 깁니다/);
  raw.scenes[0].narration = "";
  assert.match(checkStoryboard(raw, input, SOURCE).problems.join(), /나레이션이 없습니다/);
  assert.equal(checkStoryboard(raw, { ...input, narration: false }, SOURCE).storyboard?.scenes[0].narration, "", "narration off clears it");
});

test("workflow: a valid storyboard is accepted on the first try", async () => {
  const model = new RoleModel({ storyboard: [json(draft())] }, ROLES);
  const { view, result, events } = await runWorkflow(model);
  assert.equal(view.phase, "done");
  assert.equal(result.template, false);
  assert.equal(result.storyboard?.template, false);
  assert.equal(result.provider, "ollama");
  assert.equal(result.model, "scripted");
  assert.deepEqual(result.problems, []);
  assert.equal(model.count("storyboard"), 1);
  assert.match(model.calls[0].input.messages[0].content, /정확히 3개/);
  assert.ok(events.some(e => e.phase === "done" && /승인하세요/.test(e.message)));
  assert.ok(events.every(e => e.phase !== "awaiting_approval"), "no approvals inside this workflow");
});

test("workflow: a rejected draft is retried once with the problems", async () => {
  const bad = draft();
  bad.scenes[0].url = "https://example.com/a.mp4";
  bad.scenes[1].prompt = "/etc/passwd";
  const model = new RoleModel({ storyboard: [json(bad), json(draft())] }, ROLES);
  const { view, result } = await runWorkflow(model);
  assert.equal(view.phase, "done");
  assert.equal(result.template, false);
  assert.equal(model.count("storyboard"), 2);
  const retry = model.calls[1].input.messages[0].content;
  assert.match(retry, /검사에서 걸렸습니다/);
  assert.match(retry, /url/);
  assert.match(result.problems.join("\n"), /^1차: /m, "the first round's problems are reported");
  assert.deepEqual(model.leftovers(), []);
});

test("workflow: a second failure yields a labelled template", async () => {
  const model = new RoleModel({ storyboard: [json(draft([5, 5])), json({ ...draft(), extra: true })] }, ROLES);
  const { view, result, events } = await runWorkflow(model);
  assert.equal(view.phase, "done");
  assert.equal(model.count("storyboard"), 2, "re-asked exactly once");
  assert.equal(result.template, true);
  assert.equal(result.storyboard?.template, true);
  assert.equal(result.provider, "", "a template never names the model as its author");
  assert.equal(result.model, "");
  assert.match(result.storyboard?.title ?? "", /^\[템플릿\]/);
  assert.match(result.problems.join("\n"), /1차: .*3개여야[\s\S]*2차: .*extra/);
  assert.ok(events.some(e => /템플릿 스토리보드/.test(e.message)));
});

test("workflow: without a model the template is labelled and built from topic + style", async () => {
  const { view, result } = await runWorkflow(null, { ...input, style: "documentary", durationSec: 30 });
  assert.equal(view.phase, "done");
  assert.equal(result.template, true);
  const board = result.storyboard;
  assert.ok(board);
  assert.match(board.story, /모델이 쓴 내용이 아니니/);
  assert.equal(board.scenes.length, 6);
  assert.equal(board.scenes.reduce((sum, scene) => sum + scene.durationSec, 0), 30);
  assert.ok(board.scenes.every(scene => scene.script.startsWith("[템플릿]") && scene.prompt.includes(input.topic) && /documentary/.test(scene.prompt)));
  assert.ok(board.scenes.every(scene => fitNarration(scene.narration, scene.durationSec)?.trimmed === false), "template narration is readable in time");
  assert.match(result.problems.join(), /모델: .*모델 설정/);
});

test("workflow: invalid host input fails without calling the model", async () => {
  const model = new RoleModel({}, ROLES);
  const { view, result } = await runWorkflow(model, { ...input, durationSec: 500 });
  assert.equal(view.phase, "failed");
  assert.equal(result.storyboard, null);
  assert.match(result.problems.join(), /durationSec/);
  assert.equal(model.calls.length, 0);
});

test("template topics never smuggle URLs or paths into prompts", () => {
  const board = templateStoryboard({ ...input, topic: "주제 https://evil.example/x ../../etc /tmp/a \u0060\u0060\u0060" });
  for (const scene of board.scenes) assert.equal(unsafeText(scene.prompt), null, scene.prompt);
  assert.equal(unsafeText(board.title), null);
});

test("the workflow is registered without a project", () => {
  const info = defaultWorkflows().list().find(w => w.id === "video-production");
  assert.equal(info?.needsProject, false);
});


const stockInput: ProductionInput = { ...input, topic: "법의 허점을 노린 천재 건축가의 아파트 Vancouver House", durationSec: 15, style: "documentary", visual: "stock" };
function stockDraft(): Draft {
  return {
    title: "법의 허점을 노린 천재 건축가의 아파트",
    headline: { top: "법의 허점(?)을 노린", bottom: "천재 건축가의 아파트" },
    story: "다리 옆 땅의 규제를 피해 위로 갈수록 넓어지는 건물.",
    style: { look: "documentary photo", palette: "natural", consistency: "real photos" },
    scenes: [0, 1, 2, 3, 4].map(i => ({
      id: "s" + (i + 1), order: i + 1, durationSec: 3, script: "장면", narration: "다리에서 30m 떨어져야 했어요.", caption: "최소 30m 떨어져야",
      prompt: "", transition: "cut", search: i === 0 ? "Vancouver House tower!" : "granville bridge vancouver", emphasis: i === 1 ? ["30m", "없는단어"] : [],
      camera: "pan-up", stat: i === 1 ? { value: "30m", label: "다리와의 최소 거리" } : null,
    })),
  };
}

test("stock shorts: search words, headline, highlighted words and number cards pass the gate", () => {
  const { storyboard, problems, notes } = checkStoryboard(stockDraft(), stockInput, SOURCE);
  assert.deepEqual(problems, []);
  assert.ok(storyboard);
  assert.deepEqual(storyboard.headline, { top: "법의 허점(?)을 노린", bottom: "천재 건축가의 아파트" });
  assert.equal(storyboard.scenes[0].search, "vancouver house tower", "search words are cleaned the way the host cleans them");
  assert.deepEqual(storyboard.scenes[1].emphasis, ["30m"], "a highlighted word must appear in the caption or narration");
  assert.match(notes.join(), /강조 단어/);
  assert.deepEqual(storyboard.scenes[1].stat, { value: "30m", label: "다리와의 최소 거리" });
  assert.equal(storyboard.scenes[0].prompt, "", "stock scenes need no AI prompt");
  const missing = stockDraft();
  missing.scenes[2].search = "서울";
  assert.match(checkStoryboard(missing, stockInput, SOURCE).problems.join(), /search: 영어로 써야/);
  missing.scenes[2].search = "!!";
  assert.match(checkStoryboard(missing, stockInput, SOURCE).problems.join(), /search에 사진 검색용 영어 단어/);
  const camera = stockDraft();
  camera.scenes[0].camera = "spin";
  assert.ok(checkStoryboard(camera, stockInput, SOURCE).problems.length, "camera is a closed list");
  const aiBoard = stockDraft();
  assert.ok(checkStoryboard(aiBoard, { ...stockInput, visual: "ai", durationSec: 15 }, SOURCE).problems.length, "AI scenes still need prompts");
});

test("stock template: Latin topic words become search words and the template stays labelled", () => {
  const board = templateStoryboard(stockInput);
  assert.equal(board.template, true);
  assert.equal(board.scenes.length, sceneCount(15, "stock"));
  assert.ok(board.scenes.every(scene => scene.search === "vancouver house" && scene.prompt === ""));
  assert.equal(board.headline?.top, "[템플릿]");
  const { template: _t, provider: _p, model: _m, ...body } = board;
  assert.deepEqual(checkStoryboard(body, stockInput, SOURCE).problems, [], "stock template passes the same gate");
});

test("workflow: stock shorts use the shorts writer prompt", async () => {
  const model = new RoleModel({ storyboard: [json(stockDraft())] }, [["storyboard", "정보형 한국어 쇼츠의 작가"]]);
  const { view, result } = await runWorkflow(model, stockInput);
  assert.equal(view.phase, "done");
  assert.equal(result.storyboard?.scenes.length, 5);
  assert.match(model.calls[0].input.messages[0].content, /사진 장면이니 3~4초/);
});
