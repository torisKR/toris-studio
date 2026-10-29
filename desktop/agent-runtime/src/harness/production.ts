// Video production, storyboard stage: topic → storyboard JSON for the Rust production job.
// Input comes only from ctx.input sent by the Rust host; the runtime never touches files or commands.
// The model drafts; deterministic checks decide. Without a usable draft the result is a labelled template.
// No approvals here: the host shows the storyboard to the user before any scene is generated.
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { ask, type RunContext } from "../graph/build.js";
import { errorText } from "../util.js";
import type { CompiledWorkflow } from "./workflow.js";

export const ASPECTS = ["9:16", "16:9", "1:1"] as const;
export const STYLES = ["realistic", "cinematic", "animation", "documentary"] as const;
export const TRANSITIONS = ["cut", "fade", "dip"] as const;
/** Scene source: licence-cleared stock photo with motion graphics, or a local AI clip. */
export const VISUALS = ["stock", "ai"] as const;
/** Ken Burns moves the Rust composer knows (desktop/src-tauri/src/production.rs CAMERAS). */
export const CAMERAS = ["zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up"] as const;
export const MAX_ROUNDS = 2;
/** Korean characters per second a viewer can follow while listening. */
export const NARRATION_RATE = 7.5;
/** Allowed gap between the sum of scene durations and the requested length. */
export const DURATION_TOLERANCE = 1;

/** Stock photo cuts are about 3.5 s like shorts; AI clips about 5 s. Same rule as production.rs scene_count. */
export const sceneCount = (durationSec: number, visual: (typeof VISUALS)[number] = "ai") =>
  visual === "stock" ? Math.min(12, Math.max(3, Math.ceil(durationSec / 3.5))) : Math.min(12, Math.max(2, Math.ceil(durationSec / 5)));

// ---- input ----

const Input = z.object({
  topic: z.string().trim().min(1).max(300),
  durationSec: z.number().int().min(10).max(120),
  aspect: z.enum(ASPECTS),
  style: z.enum(STYLES),
  narration: z.boolean(),
  language: z.literal("ko").default("ko"),
  visual: z.enum(VISUALS).default("ai"),
});
export type ProductionInput = z.infer<typeof Input>;

/** Bounded view of the host's settings. Unknown keys are dropped; a bad value fails the run. */
export function productionInput(raw: unknown): { input: ProductionInput | null; problems: string[] } {
  const parsed = Input.safeParse(raw);
  if (!parsed.success) return { input: null, problems: issues(parsed.error) };
  const topic = parsed.data.topic;
  if (CONTROL.test(topic)) return { input: null, problems: ["topic: 제어 문자가 들어 있습니다."] };
  return { input: parsed.data, problems: [] };
}

// ---- text rules ----

const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bfile:|\bjavascript:|\bdata:[a-z]+\//i;
const PATH_LIKE = /(^|[\s"'(=\[])(~|\.{1,2})?\/[\w.-]|[A-Za-z]:\\|\.\.[\/\\]|\\\\/;
const CODE_LIKE = /\u0060\u0060\u0060|~~~|\$\(|\$\{|<script/i;
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/g;

/** Why a model-written field cannot be shown or passed on, or null when it is plain text. */
export function unsafeText(text: string): string | null {
  if (CONTROL.test(text)) return "제어 문자가 들어 있습니다.";
  if (URL_LIKE.test(text)) return "URL을 넣을 수 없습니다.";
  if (PATH_LIKE.test(text)) return "파일 경로를 넣을 수 없습니다.";
  if (CODE_LIKE.test(text)) return "코드 블록이나 명령을 넣을 수 없습니다.";
  return null;
}

export const hangulCount = (text: string) => text.match(HANGUL)?.length ?? 0;

const text = (max: number, min = 0) => z.string().trim()
  .min(min, min ? "비어 있습니다." : undefined)
  .max(max, max + "자를 넘습니다.")
  .superRefine((value, check) => { const reason = unsafeText(value); if (reason) check.addIssue({ code: "custom", message: reason }); });
const english = (max: number, min = 0) => text(max, min)
  .superRefine((value, check) => { if (hangulCount(value)) check.addIssue({ code: "custom", message: "영어로 써야 합니다." }); });

const Scene = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "id는 영문·숫자·-·_ 40자 이하입니다."),
  order: z.number().int().min(1).max(12),
  durationSec: z.number().min(2).max(12),
  script: text(600, 1),
  narration: text(400),
  caption: text(160),
  prompt: text(600),
  negativePrompt: english(300).optional(),
  transition: z.enum(TRANSITIONS),
  // Stock-photo shorts only: photo search words, highlighted caption words, camera move, number card.
  search: english(80).optional(),
  emphasis: z.array(text(12, 1)).max(3, "강조 단어는 3개까지입니다.").optional(),
  camera: z.enum(CAMERAS).optional(),
  stat: z.strictObject({ value: text(12, 1), label: text(24) }).nullable().optional(),
});
const StoryboardDraft = z.strictObject({
  title: text(120, 1),
  headline: z.strictObject({ top: text(18), bottom: text(18) }).optional(),
  story: text(1200),
  style: z.strictObject({ look: english(300, 1), palette: english(200), consistency: english(400, 1) }),
  scenes: z.array(Scene).min(2).max(12),
});

export type Stat = { value: string; label: string };
export type StoryboardScene = {
  id: string; order: number; durationSec: number; script: string; narration: string; caption: string; prompt: string; negativePrompt?: string; transition: (typeof TRANSITIONS)[number];
  search?: string; emphasis?: string[]; camera?: (typeof CAMERAS)[number]; stat?: Stat | null;
};
export type Storyboard = {
  title: string;
  headline?: { top: string; bottom: string };
  story: string;
  style: { look: string; palette: string; consistency: string };
  scenes: StoryboardScene[];
  /** Same three fields the Rust validator accepts, so the host can store the storyboard as is. */
  template: boolean;
  provider: string;
  model: string;
};
export type Source = { template: boolean; provider: string; model: string };

function issues(error: z.ZodError): string[] {
  return error.issues.slice(0, 12).map(issue => (issue.path.length ? issue.path.map(String).join(".") + ": " : "") + issue.message);
}

/** Keeps whole sentences up to the readable length; null when even the first sentence is too long. */
export function fitNarration(narration: string, seconds: number): { text: string; trimmed: boolean } | null {
  const limit = Math.floor(seconds * NARRATION_RATE);
  if (hangulCount(narration) <= limit) return { text: narration, trimmed: false };
  let kept = "";
  for (const sentence of narration.match(/[^.!?。…]+[.!?。…]*\s*/g) ?? []) {
    if (hangulCount(kept + sentence) > limit) break;
    kept += sentence;
  }
  return kept.trim() ? { text: kept.trim(), trimmed: true } : null;
}

/**
 * Deterministic gate for a storyboard. Problems reject the draft; notes are fixes that kept it.
 * Rules match desktop/src-tauri/src/production.rs validate_storyboard and are stricter where the contract asks.
 */
export function checkStoryboard(raw: unknown, input: ProductionInput, source: Source): { storyboard: Storyboard | null; problems: string[]; notes: string[] } {
  const parsed = StoryboardDraft.safeParse(raw);
  if (!parsed.success) return { storyboard: null, problems: issues(parsed.error), notes: [] };
  const draft = parsed.data;
  const problems: string[] = [];
  const notes: string[] = [];
  const stock = input.visual === "stock";
  const expected = sceneCount(input.durationSec, input.visual);
  if (draft.scenes.length !== expected) problems.push("장면 수가 " + draft.scenes.length + "개입니다. " + input.durationSec + "초 영상은 " + expected + "개여야 합니다.");
  const ids = new Set<string>();
  const topic = input.topic.toLowerCase();
  const consistency = draft.style.consistency;
  const scenes: StoryboardScene[] = [];
  for (const [index, scene] of [...draft.scenes].sort((a, b) => a.order - b.order).entries()) {
    const n = index + 1;
    if (ids.has(scene.id)) { problems.push(n + "번 장면: id " + scene.id + "가 중복됩니다."); continue; }
    ids.add(scene.id);
    if (stock) {
      // Photo search words must still be plain English after the host's cleaning (letters, digits, spaces, hyphens).
      const search = (scene.search ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, " ").trim().split(/\s+/).slice(0, 8).join(" ");
      if (search.length < 2) { problems.push(n + "번 장면: search에 사진 검색용 영어 단어 2~8개를 넣어야 합니다."); continue; }
      scene.search = search;
      const caption = scene.caption;
      const emphasis = (scene.emphasis ?? []).filter(word => caption.includes(word) || scene.narration.includes(word));
      if ((scene.emphasis ?? []).length !== emphasis.length) notes.push(n + "번 장면: 자막에 없는 강조 단어를 뺐습니다.");
      scene.emphasis = emphasis;
    } else if (!scene.prompt.trim()) { problems.push(n + "번 장면: prompt가 비어 있습니다."); continue; }
    // Visual prompts are English; quoting the topic itself is allowed.
    if (hangulCount(scene.prompt.toLowerCase().split(topic).join(" "))) { problems.push(n + "번 장면: prompt는 영어로 화면만 묘사해야 합니다."); continue; }
    let prompt = scene.prompt;
    if (!stock && !prompt.toLowerCase().includes(consistency.toLowerCase())) {
      const joined = prompt.replace(/[\s.,;]+$/, "") + ", " + consistency;
      if (joined.length > 600) { problems.push(n + "번 장면: 공통 스타일 문구를 넣으면 prompt가 600자를 넘습니다."); continue; }
      prompt = joined;
    }
    let narration = "";
    if (input.narration) {
      if (!scene.narration || !hangulCount(scene.narration)) { problems.push(n + "번 장면: 한국어 나레이션이 없습니다."); continue; }
      const fit = fitNarration(scene.narration, scene.durationSec);
      if (!fit) { problems.push(n + "번 장면: 나레이션이 " + scene.durationSec + "초에 읽기에 너무 깁니다 (초당 " + NARRATION_RATE + "자 이하)."); continue; }
      if (fit.trimmed) notes.push(n + "번 장면: 나레이션이 길어 " + scene.durationSec + "초 안에 읽을 수 있게 문장 단위로 줄였습니다.");
      narration = fit.text;
    }
    scenes.push({
      id: scene.id, order: n, durationSec: Math.round(scene.durationSec * 10) / 10, script: scene.script, narration, caption: scene.caption, prompt,
      ...(scene.negativePrompt ? { negativePrompt: scene.negativePrompt } : {}), transition: scene.transition,
      ...(stock ? { search: scene.search, emphasis: scene.emphasis ?? [], camera: scene.camera ?? CAMERAS[index % CAMERAS.length], stat: scene.stat ?? null } : {}),
    });
  }
  const total = scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  if (!problems.length && Math.abs(total - input.durationSec) > DURATION_TOLERANCE) problems.push("장면 길이 합계가 " + total + "초입니다. " + input.durationSec + "초 ±" + DURATION_TOLERANCE + "초로 맞춰야 합니다.");
  if (problems.length) return { storyboard: null, problems, notes };
  const headline = stock ? { headline: draft.headline ?? { top: "", bottom: draft.title.slice(0, 18) } } : {};
  return { storyboard: { title: draft.title, ...headline, story: draft.story, style: draft.style, scenes, ...source }, problems: [], notes };
}

// ---- prompts ----

export const STORYBOARD_SYSTEM = [
  "너는 짧은 AI 영상의 영상 스토리보드 작가다. 주제 하나로 장면별 대본·나레이션·자막·영상 프롬프트를 쓴다.",
  "규칙: 주어진 주제만 다루고 사실·수치·인물·브랜드를 지어내지 않는다. 어떤 필드에도 URL, 파일 경로, 코드, 명령을 넣지 않는다.",
  "prompt는 영어 600자 이하로 화면에 보이는 것(피사체·동작·배경·카메라·빛)만 묘사하고 글자·자막·로고는 넣지 않는다. 모든 prompt에 style.consistency 문구를 그대로 넣는다.",
  "style.look·palette·consistency·negativePrompt는 영어, title·story·script·narration·caption은 한국어로 쓴다.",
  "transition은 cut, fade, dip 중 하나. id는 영문·숫자·-·_. 아래 필드 외에는 넣지 않는다.",
  "JSON 객체 하나만 출력한다: {\"title\":\"...\",\"story\":\"...\",\"style\":{\"look\":\"...\",\"palette\":\"...\",\"consistency\":\"...\"},\"scenes\":[{\"id\":\"s1\",\"order\":1,\"durationSec\":5,\"script\":\"...\",\"narration\":\"...\",\"caption\":\"...\",\"prompt\":\"...\",\"negativePrompt\":\"...\",\"transition\":\"cut\"}]}",
].join("\n");

/** Stock-photo shorts like the reference channels: two-line hook title, 3~4 s cuts, highlighted words, number cards. */
export const STOCK_SYSTEM = [
  "너는 정보형 한국어 쇼츠의 작가다. 실제 사진 위에 자막과 모션 그래픽을 얹는 영상을 기획한다.",
  "규칙: 주어진 주제만 다루고 사실·수치·인물·브랜드를 지어내지 않는다. 확실하지 않은 숫자는 쓰지 않는다. 어떤 필드에도 URL, 파일 경로, 코드, 명령을 넣지 않는다.",
  "headline.top과 headline.bottom은 화면 위에 고정되는 두 줄 제목이다. 각 18자 이하, 궁금증을 만드는 훅으로 쓴다(예: top \"법의 허점(?)을 노린\", bottom \"천재 건축가의 아파트\").",
  "장면마다 search에 그 장면 사진을 찾을 영어 검색어 2~6단어를 쓴다. 고유명사(건물·도시 이름)는 영어 표기로 넣는다. 뉴스·방송 화면, 유명인 얼굴, 로고를 찾는 검색어는 쓰지 않는다.",
  "caption은 화면 자막 한 줄(20자 이하), narration은 읽을 문장이다. emphasis에는 caption에 실제로 나오는 핵심 단어를 0~2개 넣는다(노란색 강조).",
  "숫자가 핵심인 장면에만 stat을 넣는다: {\"value\":\"30m\",\"label\":\"다리와의 최소 거리\"}. 아니면 null.",
  "camera는 zoom-in, zoom-out, pan-left, pan-right, pan-up 중 하나로 장면마다 바꾼다. prompt는 빈 문자열로 둔다.",
  "첫 장면은 질문이나 반전으로 시작하고, 마지막 장면은 결론이나 한 줄 정리로 끝낸다. transition은 cut, fade, dip 중 하나. id는 영문·숫자·-·_. 아래 필드 외에는 넣지 않는다.",
  "JSON 객체 하나만 출력한다: {\"title\":\"...\",\"headline\":{\"top\":\"...\",\"bottom\":\"...\"},\"story\":\"...\",\"style\":{\"look\":\"documentary photo\",\"palette\":\"natural\",\"consistency\":\"real photos\"},\"scenes\":[{\"id\":\"s1\",\"order\":1,\"durationSec\":3.5,\"script\":\"...\",\"narration\":\"...\",\"caption\":\"...\",\"prompt\":\"\",\"transition\":\"cut\",\"search\":\"...\",\"emphasis\":[\"...\"],\"camera\":\"zoom-in\",\"stat\":null}]}",
].join("\n");

export function storyboardPrompt(input: ProductionInput, task: string, feedback: string): string {
  const count = sceneCount(input.durationSec, input.visual);
  const lines = [
    "주제: " + input.topic,
    "영상 길이: " + input.durationSec + "초 · 화면 비율 " + input.aspect + " · 스타일 " + input.style,
    "장면 수: 정확히 " + count + "개. 장면 길이는 2~12초, 합계는 " + input.durationSec + "초(±" + DURATION_TOLERANCE + "초)." + (input.visual === "stock" ? " 사진 장면이니 3~4초 단위로 빠르게 넘긴다." : ""),
    input.narration
      ? "나레이션: 한국어. 장면 길이 1초당 한글 " + NARRATION_RATE + "자 이하(5초 장면이면 " + Math.floor(5 * NARRATION_RATE) + "자 이하)."
      : "나레이션: 없음. narration은 빈 문자열로 둔다.",
  ];
  if (task.trim()) lines.push("추가 요청: " + task.trim().slice(0, 500));
  if (feedback) lines.push("이전 스토리보드가 검사에서 걸렸습니다. 고쳐서 다시 쓰세요:\n" + feedback);
  return lines.join("\n");
}

// ---- template ----

const STYLE_LOOK: Record<ProductionInput["style"], { look: string; palette: string }> = {
  realistic: { look: "photorealistic footage, natural light, realistic textures", palette: "natural colors" },
  cinematic: { look: "cinematic film look, dramatic lighting, shallow depth of field", palette: "teal and orange color grade" },
  animation: { look: "high quality 3D animation, soft shading", palette: "vibrant pastel colors" },
  documentary: { look: "documentary footage, handheld camera", palette: "natural muted colors" },
};
const TEMPLATE_CONSISTENCY = "same main subject and setting in every scene, consistent lighting and color grading";
const BEATS = ["opening establishing wide shot", "medium shot of the main subject", "close-up detail shot", "slow tracking shot following the action", "wide shot showing the surroundings", "over-the-shoulder view of the subject"];

/** Topic text that is safe to quote inside prompts and template fields. */
function plainTopic(topic: string): string {
  return topic
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\S*:\/\/\S*|\bwww\.\S*|file:\S*|javascript:\S*/gi, " ")
    .replace(/\u0060{3,}|~{3,}|\$\(|\$\{|<script/gi, " ")
    .replace(/(^|\s)(~|\.{1,2})?\/\S*|[A-Za-z]:\\\S*|\.\.[\/\\]|\\\\/g, " ")
    .replace(/\s+/g, " ").trim() || "주제";
}

/** Model-free storyboard from topic + style. Labelled everywhere so nobody mistakes it for AI output. */
export function templateStoryboard(input: ProductionInput): Storyboard {
  const topic = plainTopic(input.topic);
  const short = topic.length > 12 ? topic.slice(0, 12) + "…" : topic;
  const { look, palette } = STYLE_LOOK[input.style];
  const stock = input.visual === "stock";
  const count = sceneCount(input.durationSec, input.visual);
  const base = Math.floor(input.durationSec / count);
  // Latin words in the topic (brand or place names) are the only search words a template can know.
  const latin = topic.toLowerCase().replace(/[^a-z0-9- ]+/g, " ").trim().split(/\s+/).filter(w => w.length > 1).slice(0, 4).join(" ");
  const extra = input.durationSec - base * count;
  const scenes: StoryboardScene[] = Array.from({ length: count }, (_, i) => {
    const beat = i === count - 1 ? "closing wide shot, calm ending" : BEATS[i % BEATS.length];
    return {
      id: "s" + (i + 1),
      order: i + 1,
      durationSec: base + (i < extra ? 1 : 0),
      script: "[템플릿] " + (i === 0 ? "도입" : i === count - 1 ? "마무리" : "전개 " + i) + " 장면입니다. AI가 쓴 대본이 아니니 직접 채우세요.",
      // Short enough for the 3-second scenes an 11-second video gets (≤ 22 Korean chars).
      narration: input.narration ? "템플릿 나레이션 " + (i + 1) + "번입니다." : "",
      caption: short,
      prompt: stock ? "" : (beat + " about \"" + topic + "\", " + look + ", " + palette + ", " + TEMPLATE_CONSISTENCY).slice(0, 600),
      transition: i === 0 ? "cut" : "fade",
      // Without a model, photos are searched only by Latin words in the topic; otherwise the scene gets a drawn card.
      ...(stock ? { search: latin, emphasis: [], camera: CAMERAS[i % CAMERAS.length], stat: null } : {}),
    };
  });
  return {
    title: ("[템플릿] " + topic).slice(0, 120),
    ...(stock ? { headline: { top: "[템플릿]", bottom: short } } : {}),
    story: ("템플릿 스토리보드입니다. 모델이 쓴 내용이 아니니 장면 대본·나레이션·프롬프트를 직접 고친 뒤 승인하세요. 주제: " + topic).slice(0, 1200),
    style: { look, palette, consistency: TEMPLATE_CONSISTENCY },
    scenes,
    template: true,
    provider: "",
    model: "",
  };
}

// ---- graph ----

const replace = <T>(fallback: () => T) => Annotation<T>({ reducer: (_current, next) => next, default: fallback });

const ProductionState = Annotation.Root({
  task: replace(() => ""),
  rounds: replace(() => 0),
  raw: replace<unknown>(() => null),
  feedback: replace(() => ""),
  storyboard: replace<Storyboard | null>(() => null),
  retry: replace(() => false),
  problems: replace<string[]>(() => []),
  summary: replace(() => ""),
});
type ProductionS = typeof ProductionState.State;

/** What the host reads from run.summary. */
export type ProductionResult = { storyboard: Storyboard | null; template: boolean; provider: string; model: string; problems: string[] };

export function buildVideoProduction(ctx: RunContext): CompiledWorkflow {
  const { input, problems: inputProblems } = productionInput(ctx.input);
  const source: Source = { template: false, provider: ctx.model.provider, model: ctx.model.model };
  const plan = async (s: ProductionS) => {
    if (!input) return {};
    ctx.emit("supervisor", "thinking", s.rounds ? "검사에서 걸린 부분을 고쳐 스토리보드를 다시 씁니다." : "스토리보드를 쓰고 있습니다.", { detail: input.durationSec + "초 · " + input.aspect + " · " + input.style + " · 장면 " + sceneCount(input.durationSec, input.visual) + "개" + (input.visual === "stock" ? " · 사진 쇼츠" : "") });
    try {
      return { rounds: s.rounds + 1, raw: await ask(ctx, input.visual === "stock" ? STOCK_SYSTEM : STORYBOARD_SYSTEM, [{ role: "user", content: storyboardPrompt(input, s.task, s.feedback) }]) };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const reason = errorText(error);
      ctx.emit("supervisor", "thinking", "모델 응답을 쓰지 못했습니다.", { detail: reason });
      return { rounds: MAX_ROUNDS, raw: null, problems: [...s.problems, "모델: " + reason] };
    }
  };
  const check = async (s: ProductionS) => {
    if (!input) return {};
    ctx.emit("qa", "reviewing", "스토리보드를 규칙으로 검사하고 있습니다.");
    const result = s.raw === null ? { storyboard: null, problems: [], notes: [] } : checkStoryboard(s.raw, input, source);
    const round = (lines: string[]) => lines.map(line => s.rounds + "차: " + line);
    if (result.storyboard) {
      ctx.emit("qa", "reviewing", "검사 통과 · 장면 " + result.storyboard.scenes.length + "개" + (result.notes.length ? " · 고친 점 " + result.notes.length + "건" : ""), result.notes.length ? { detail: result.notes.join("\n") } : {});
      return { storyboard: result.storyboard, retry: false, problems: [...s.problems, ...round(result.notes)] };
    }
    const problems = [...s.problems, ...round(result.problems)];
    if (s.rounds < MAX_ROUNDS) {
      ctx.emit("qa", "reviewing", "스토리보드가 검사를 통과하지 못해 다시 쓰게 합니다.", { detail: result.problems.join("\n") });
      return { retry: true, feedback: result.problems.join("\n"), problems };
    }
    ctx.emit("qa", "reviewing", "모델 스토리보드를 쓸 수 없어 템플릿 스토리보드를 만듭니다.", { detail: problems.join("\n") || "모델 응답이 없습니다." });
    return { storyboard: templateStoryboard(input), retry: false, problems };
  };
  const finalize = async (s: ProductionS) => {
    const storyboard = s.storyboard;
    const template = storyboard?.template ?? false;
    const result: ProductionResult = { storyboard, template, provider: template ? "" : storyboard ? source.provider : "", model: template ? "" : storyboard ? source.model : "", problems: input ? s.problems : inputProblems };
    const summary = JSON.stringify(result);
    if (!storyboard) ctx.emit("supervisor", "failed", "제작 설정이 올바르지 않아 스토리보드를 만들지 못했습니다.", { detail: summary });
    else ctx.emit("supervisor", "done", template ? "템플릿 스토리보드를 만들었습니다. AI가 쓴 내용이 아니니 직접 고친 뒤 승인하세요." : "스토리보드를 만들었습니다. 검토한 뒤 승인하세요.", { detail: summary });
    return { summary };
  };
  return new StateGraph(ProductionState)
    .addNode("plan", plan).addNode("check", check).addNode("finalize", finalize)
    .addConditionalEdges(START, () => (input ? "plan" : "finalize"), ["plan", "finalize"])
    .addEdge("plan", "check")
    .addConditionalEdges("check", (s: ProductionS) => (s.retry ? "plan" : "finalize"), ["plan", "finalize"])
    .addEdge("finalize", END)
    .compile() as unknown as CompiledWorkflow;
}

