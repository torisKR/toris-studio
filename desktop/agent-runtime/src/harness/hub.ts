// Operations-hub workflows: weekly content drafts and ops triage.
// Both read only the data the host passed in (ctx.input), never a project folder.
// The model drafts; deterministic checks decide what is offered, and every save waits for the user's approval.
// The runtime has no database: an approved save_draft is written by the host before the run resumes.
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { ask, type RunContext } from "../graph/build.js";
import type { PendingAction } from "../protocol.js";
import { errorText } from "../util.js";
import type { CompiledWorkflow } from "./workflow.js";

export const SOCIAL_PLATFORMS = ["youtube", "threads", "naver_blog", "tiktok", "instagram", "facebook"] as const;
/** Status states that need a person; the same list the ops dashboard uses. */
export const ATTENTION = ["failing", "deploy_failed", "unhealthy", "halted", "error"] as const;
export const SOURCE_LABELS: Record<string, string> = { github_ci: "GitHub CI", github_release: "GitHub 릴리스", cloudflare: "Cloudflare 배포", http: "헬스체크", play: "Google Play" };
export const MAX_DRAFTS = 7;
export const MAX_ROUNDS = 2;
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Obj = Record<string, unknown>;
const objects = (value: unknown, max: number): Obj[] => (Array.isArray(value) ? value : []).filter((v): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v)).slice(0, max);
const str = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const replace = <T>(fallback: () => T) => Annotation<T>({ reducer: (_current, next) => next, default: fallback });
const isApproved = (action: PendingAction, decision: { actionId: string; decision: string }) => decision.actionId === action.id && decision.decision === "approve";

// ---- weekly content ----

export type ContentContext = {
  now: Date;
  channels: Array<{ id: string; platform: string; name: string }>;
  titles: string[];
  trends: Array<{ keyword: string; title: string; url: string; source: string; metric: string }>;
  schedule: string[];
};

/** Bounded, typed view of what the host sent. Anything malformed is dropped, never trusted. */
export function contentContext(input: Obj, fallbackNow = new Date()): ContentContext {
  const parsed = new Date(str(input.now, 40));
  const now = Number.isNaN(parsed.getTime()) ? fallbackNow : parsed;
  const channels = objects(input.channels, 30).map(c => ({ id: str(c.id, 40), platform: str(c.platform, 20), name: str(c.name, 120) })).filter(c => UUID.test(c.id) && (SOCIAL_PLATFORMS as readonly string[]).includes(c.platform));
  const titles = objects(input.content, 40).map(c => str(c.title, 300)).filter(Boolean);
  const trends = objects(input.trends, 30).map(t => ({ keyword: str(t.keyword, 100), title: str(t.title, 300), url: str(t.url, 2048), source: str(t.source, 30), metric: str(t.metric, 200) })).filter(t => t.url.startsWith("https://") && t.title);
  const schedule = [
    ...objects(input.events, 30).map(e => "일정 " + str(e.startsAt, 40) + " · " + str(e.title, 200)),
    ...objects(input.work, 30).map(w => "작업 " + (str(w.dueAt, 40) || "마감 없음") + " · " + str(w.title, 200)),
  ];
  return { now, channels, titles, trends, schedule };
}

export const CONTENT_SYSTEM = [
  "너는 1인 사업자의 주간 콘텐츠 기획자다. 주어진 자료만 근거로 이번 주에 올릴 SNS 콘텐츠 초안을 쓴다.",
  "규칙: 자료에 없는 수치·사실·사례를 만들지 않는다. sourceUrls에는 트렌드 목록에 있는 URL만 넣는다. 이미 있는 콘텐츠와 같은 제목은 피한다.",
  "platform은 youtube, threads, naver_blog, tiktok, instagram, facebook 중 하나. 등록된 채널이 있으면 그 플랫폼을 우선한다.",
  "suggestedAt은 지금부터 14일 안의 ISO 8601 시각(시간대 포함)이나 null. 초안은 " + MAX_DRAFTS + "개 이하, 한국어.",
  "JSON 객체 하나만 출력한다: {\"drafts\":[{\"platform\":\"threads\",\"title\":\"...\",\"body\":\"...\",\"suggestedAt\":null,\"sourceUrls\":[]}],\"summary\":\"...\"}",
].join("\n");

export function contentPrompt(context: ContentContext, task: string, feedback: string): string {
  const lines = [
    "요청: " + (task.trim() || "이번 주 콘텐츠 초안을 만들어줘."),
    "지금: " + context.now.toISOString(),
    "등록된 채널:\n" + (context.channels.map(c => "- " + c.platform + " · " + c.name).join("\n") || "(없음)"),
    "이미 있는 콘텐츠 제목:\n" + (context.titles.map(t => "- " + t).join("\n") || "(없음)"),
    "트렌드 목록(근거로 쓸 수 있는 유일한 링크):\n" + (context.trends.map(t => "- [" + t.source + "] " + t.keyword + " · " + t.title + (t.metric ? " · " + t.metric : "") + " · " + t.url).join("\n") || "(없음)"),
    "이번 주 일정과 작업:\n" + (context.schedule.join("\n") || "(없음)"),
  ];
  if (feedback) lines.push("이전 초안이 검사에서 걸렸습니다. 고쳐서 다시 쓰세요:\n" + feedback);
  return lines.join("\n\n");
}

export type ContentDraft = { platform: string; channelId: string | null; title: string; body: string; scheduledAt: string | null; sources: string[]; template: boolean };

/** Deterministic gate for model drafts. Facts outrank the model: links must come from the trend list. */
export function checkDrafts(raw: unknown, context: ContentContext): { drafts: ContentDraft[]; problems: string[] } {
  const problems: string[] = [];
  const drafts: ContentDraft[] = [];
  const known = new Set(context.trends.map(t => t.url));
  const seen = new Set(context.titles.map(t => t.toLowerCase()));
  const items = objects(raw && typeof raw === "object" ? (raw as Obj).drafts : null, 20);
  if (!items.length) problems.push("drafts 배열이 비어 있거나 형식이 다릅니다.");
  for (const [index, item] of items.entries()) {
    const n = index + 1;
    const platform = str(item.platform, 20);
    const title = str(item.title, 300);
    const body = typeof item.body === "string" ? item.body.trim() : "";
    if (!(SOCIAL_PLATFORMS as readonly string[]).includes(platform)) { problems.push("초안 " + n + ": 지원하지 않는 플랫폼 " + JSON.stringify(platform.slice(0, 20))); continue; }
    if (!title) { problems.push("초안 " + n + ": 제목이 없습니다."); continue; }
    if (!body || body.length > 29_000) { problems.push("초안 " + n + ": 본문이 없거나 29,000자를 넘습니다."); continue; }
    if (seen.has(title.toLowerCase())) { problems.push("초안 " + n + ": 이미 있는 제목입니다 (" + title.slice(0, 60) + ")."); continue; }
    seen.add(title.toLowerCase());
    const urls = (Array.isArray(item.sourceUrls) ? item.sourceUrls : []).filter((u): u is string => typeof u === "string").slice(0, 10);
    const sources = [...new Set(urls.filter(u => known.has(u)))];
    if (urls.length > sources.length) problems.push("초안 " + n + ": 근거에 없는 링크 " + (urls.length - sources.length) + "개를 뺐습니다.");
    let scheduledAt: string | null = null;
    if (item.suggestedAt !== null && item.suggestedAt !== undefined && item.suggestedAt !== "") {
      const at = new Date(str(item.suggestedAt, 40));
      const ok = !Number.isNaN(at.getTime()) && at.getTime() >= context.now.getTime() && at.getTime() <= context.now.getTime() + 14 * DAY;
      if (ok) scheduledAt = at.toISOString(); else problems.push("초안 " + n + ": 제안 시각이 14일 범위 밖이라 비웠습니다.");
    }
    const matches = context.channels.filter(c => c.platform === platform);
    drafts.push({ platform, channelId: matches.length === 1 ? matches[0].id : null, title, body: withSources(body, sources), scheduledAt, sources, template: false });
    if (drafts.length >= MAX_DRAFTS) break;
  }
  return { drafts, problems };
}

const withSources = (body: string, sources: string[]) => (sources.length ? body + "\n\n참고 자료:\n" + sources.map(u => "- " + u).join("\n") : body);

/** Model-free drafts from the top trends, clearly labelled so nobody mistakes them for AI output. */
export function templateDrafts(context: ContentContext): ContentDraft[] {
  const platform = context.channels[0]?.platform ?? "threads";
  const channelId = context.channels.filter(c => c.platform === platform).length === 1 ? context.channels[0].id : null;
  return context.trends.slice(0, 3).map(t => ({
    platform, channelId, scheduledAt: null, sources: [t.url], template: true,
    title: ("[템플릿] " + (t.keyword ? t.keyword + ": " : "") + t.title).slice(0, 300),
    body: withSources("템플릿 초안입니다. AI가 쓴 글이 아니니 내용을 직접 채우세요.\n\n주제: " + t.title + (t.metric ? "\n지표: " + t.metric : ""), [t.url]),
  }));
}

/** Exactly the fields the host's create_content accepts. */
export function contentPayload(draft: ContentDraft): Obj {
  return { platform: draft.platform, channelId: draft.channelId, title: draft.title, body: draft.body, status: "draft", scheduledAt: draft.scheduledAt, url: null };
}

// ---- ops triage ----

export type Failing = { productId: string; product: string; source: string; state: string; summary: string };

export function failingStatuses(input: Obj): Failing[] {
  const out: Failing[] = [];
  for (const product of objects(input.products, 100)) {
    const productId = str(product.id, 40);
    if (!UUID.test(productId)) continue;
    for (const s of objects(product.statuses, 10)) {
      const source = str(s.source, 30), state = str(s.state, 30);
      if (source in SOURCE_LABELS && (ATTENTION as readonly string[]).includes(state) && !out.some(f => f.productId === productId && f.source === source)) out.push({ productId, product: str(product.name, 120), source, state, summary: str(s.summary, 500) });
    }
  }
  return out;
}

export const TRIAGE_SYSTEM = [
  "너는 1인 사업자의 운영 점검 담당자다. 주어진 실패 상태만 보고 오늘 처리할 작업 목록을 우선순위대로 만든다.",
  "규칙: 목록에 없는 제품이나 상태를 만들지 않는다. productId와 source는 목록의 값을 그대로 쓴다. 원인을 단정하지 말고 확인할 순서를 notes에 적는다.",
  "priority는 1(가장 급함)~3. JSON 객체 하나만 출력한다: {\"tasks\":[{\"productId\":\"...\",\"source\":\"http\",\"priority\":1,\"notes\":\"...\"}],\"summary\":\"...\"}",
].join("\n");

export function triagePrompt(failing: Failing[], task: string): string {
  return ["요청: " + (task.trim() || "오늘 처리할 운영 작업을 정리해줘."), "실패 상태:", ...failing.map(f => "- productId=" + f.productId + " · " + f.product + " · source=" + f.source + " · " + f.state + " · " + f.summary)].join("\n");
}

export type OpsTask = { productId: string; source: string; title: string; notes: string; priority: number; template: boolean };

/** Every failing source ends up with exactly one task: the model's when it names a real one, a template otherwise. */
export function checkTriage(raw: unknown, failing: Failing[]): { tasks: OpsTask[]; problems: string[] } {
  const problems: string[] = [];
  const tasks: OpsTask[] = [];
  const title = (f: Failing) => (f.product + " · " + (SOURCE_LABELS[f.source] ?? f.source) + ": " + f.summary).slice(0, 300);
  for (const [index, item] of objects(raw && typeof raw === "object" ? (raw as Obj).tasks : null, 50).entries()) {
    const f = failing.find(x => x.productId === str(item.productId, 40) && x.source === str(item.source, 30));
    if (!f) { problems.push("작업 " + (index + 1) + ": 실패 목록에 없는 제품·상태라 뺐습니다."); continue; }
    if (tasks.some(t => t.productId === f.productId && t.source === f.source)) continue;
    const priority = [1, 2, 3].includes(Number(item.priority)) ? Number(item.priority) : 2;
    tasks.push({ productId: f.productId, source: f.source, title: title(f), notes: str(item.notes, 2000), priority, template: false });
  }
  for (const f of failing) {
    if (tasks.some(t => t.productId === f.productId && t.source === f.source)) continue;
    problems.push(f.product + " · " + (SOURCE_LABELS[f.source] ?? f.source) + "는 모델이 빠뜨려 템플릿 작업으로 넣었습니다.");
    tasks.push({ productId: f.productId, source: f.source, title: title(f), notes: "[템플릿] 상태: " + f.state + ". 최근 실행·배포 기록부터 확인하세요.", priority: 2, template: true });
  }
  tasks.sort((a, b) => a.priority - b.priority);
  return { tasks, problems };
}

// ---- graphs ----

async function offerAll(ctx: RunContext, actions: Extract<PendingAction, { kind: "save_draft" }>[]): Promise<{ saved: number; rejected: number }> {
  // All requests are shown at once; the user decides them in any order.
  const decisions = await Promise.all(actions.map(action => ctx.approve(action, action.title + " 저장 승인을 기다립니다.").then(decision => {
    const ok = isApproved(action, decision);
    ctx.emit(action.agent, "thinking", ok ? "저장했습니다: " + action.title : "거절했습니다: " + action.title, { resolved: action.id });
    return ok;
  })));
  return { saved: decisions.filter(Boolean).length, rejected: decisions.filter(ok => !ok).length };
}

const ContentState = Annotation.Root({
  task: replace(() => ""),
  rounds: replace(() => 0),
  raw: replace<unknown>(() => null),
  feedback: replace(() => ""),
  drafts: replace<ContentDraft[]>(() => []),
  retry: replace(() => false),
  summary: replace(() => ""),
  failed: replace(() => ""),
});
type ContentS = typeof ContentState.State;

export function buildWeeklyContent(ctx: RunContext): CompiledWorkflow {
  const context = contentContext(ctx.input);
  const plan = async (s: ContentS) => {
    ctx.emit("supervisor", "thinking", s.rounds ? "검사에서 걸린 부분을 고쳐 다시 씁니다." : "이번 주 콘텐츠 초안을 쓰고 있습니다.", { detail: "채널 " + context.channels.length + " · 트렌드 " + context.trends.length + " · 일정·작업 " + context.schedule.length });
    try {
      return { rounds: s.rounds + 1, raw: await ask(ctx, CONTENT_SYSTEM, [{ role: "user", content: contentPrompt(context, s.task, s.feedback) }]) };
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.emit("supervisor", "thinking", "모델 응답을 쓰지 못했습니다.", { detail: errorText(error) });
      return { rounds: MAX_ROUNDS, raw: null };
    }
  };
  const check = async (s: ContentS) => {
    ctx.emit("qa", "reviewing", "초안을 규칙으로 검사하고 있습니다.");
    const { drafts, problems } = checkDrafts(s.raw, context);
    if (drafts.length) {
      ctx.emit("qa", "reviewing", "검사 통과 " + drafts.length + "건" + (problems.length ? " · 고친 점 " + problems.length + "건" : ""), problems.length ? { detail: problems.join("\n") } : {});
      return { drafts, retry: false };
    }
    if (s.rounds < MAX_ROUNDS) {
      ctx.emit("qa", "reviewing", "통과한 초안이 없어 다시 쓰게 합니다.", { detail: problems.join("\n") });
      return { drafts: [], retry: true, feedback: problems.join("\n") };
    }
    const fallback = templateDrafts(context);
    ctx.emit("qa", "reviewing", fallback.length ? "모델 초안이 검사를 통과하지 못해 템플릿 초안 " + fallback.length + "건을 만듭니다." : "통과한 초안이 없고 템플릿을 만들 트렌드도 없습니다.", { detail: problems.join("\n") });
    return fallback.length ? { drafts: fallback, retry: false } : { drafts: [], retry: false, failed: "초안을 만들지 못했습니다. 트렌드를 수집하거나 요청을 바꿔 다시 시도하세요." };
  };
  const propose = async (s: ContentS) => {
    const actions = s.drafts.map(d => ({ kind: "save_draft" as const, id: randomUUID(), agent: "supervisor" as const, target: "social_content" as const, title: d.title, preview: d.platform + (d.scheduledAt ? " · 제안 " + d.scheduledAt : "") + "\n\n" + d.body.slice(0, 4000), payload: contentPayload(d), template: d.template, reason: d.template ? "모델 없이 만든 템플릿 초안" : "검사를 통과한 초안" }));
    const { saved, rejected } = await offerAll(ctx, actions);
    return { summary: "콘텐츠 초안 " + saved + "건 저장" + (rejected ? " · " + rejected + "건 거절" : "") + (s.drafts.some(d => d.template) ? " (템플릿)" : "") + ". 콘텐츠 플래너에서 다듬은 뒤 게시하세요." };
  };
  const finalize = async (s: ContentS) => {
    ctx.emit("supervisor", s.failed ? "failed" : "done", s.failed ? "초안을 만들지 못했습니다." : "주간 콘텐츠 작업을 마쳤습니다.", { detail: s.failed || s.summary });
    return {};
  };
  return new StateGraph(ContentState)
    .addNode("plan", plan).addNode("check", check).addNode("propose", propose).addNode("finalize", finalize)
    .addEdge(START, "plan").addEdge("plan", "check")
    .addConditionalEdges("check", (s: ContentS) => (s.retry ? "plan" : s.drafts.length ? "propose" : "finalize"), ["plan", "propose", "finalize"])
    .addEdge("propose", "finalize").addEdge("finalize", END)
    .compile() as unknown as CompiledWorkflow;
}

const OpsState = Annotation.Root({
  task: replace(() => ""),
  raw: replace<unknown>(() => null),
  tasks: replace<OpsTask[]>(() => []),
  summary: replace(() => ""),
});
type OpsS = typeof OpsState.State;

export function buildOpsTriage(ctx: RunContext): CompiledWorkflow {
  const failing = failingStatuses(ctx.input);
  const triage = async (s: OpsS) => {
    ctx.emit("supervisor", "thinking", "실패 상태 " + failing.length + "건의 우선순위를 정하고 있습니다.");
    try { return { raw: await ask(ctx, TRIAGE_SYSTEM, [{ role: "user", content: triagePrompt(failing, s.task) }]) }; }
    catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.emit("supervisor", "thinking", "모델 응답을 쓰지 못해 템플릿 작업으로 정리합니다.", { detail: errorText(error) });
      return { raw: null };
    }
  };
  const check = async (s: OpsS) => {
    const { tasks, problems } = checkTriage(s.raw, failing);
    ctx.emit("qa", "reviewing", "작업 후보 " + tasks.length + "건" + (problems.length ? " · 고친 점 " + problems.length + "건" : ""), problems.length ? { detail: problems.join("\n") } : {});
    return { tasks };
  };
  const propose = async (s: OpsS) => {
    const actions = s.tasks.map(t => ({ kind: "save_draft" as const, id: randomUUID(), agent: "supervisor" as const, target: "ops_task" as const, title: t.title, preview: "우선순위 " + t.priority + (t.notes ? "\n\n" + t.notes : ""), payload: { product: t.productId, source: t.source, notes: t.notes }, template: t.template, reason: t.template ? "모델이 빠뜨린 실패 상태" : "실패 상태와 일치하는 작업" }));
    const { saved, rejected } = await offerAll(ctx, actions);
    return { summary: "운영 작업 " + saved + "건을 일정·작업에 열었습니다" + (rejected ? " · " + rejected + "건 거절" : "") + "." };
  };
  const finalize = async (s: OpsS) => {
    ctx.emit("supervisor", "done", failing.length ? "운영 점검을 마쳤습니다." : "확인이 필요한 문제가 없습니다.", { detail: s.summary || "실패·이상 상태가 없습니다. 운영 상태에서 지금 확인을 눌러 최신 상태를 받을 수 있습니다." });
    return {};
  };
  return new StateGraph(OpsState)
    .addNode("triage", triage).addNode("check", check).addNode("propose", propose).addNode("finalize", finalize)
    .addConditionalEdges(START, () => (failing.length ? "triage" : "finalize"), ["triage", "finalize"])
    .addEdge("triage", "check").addEdge("check", "propose").addEdge("propose", "finalize").addEdge("finalize", END)
    .compile() as unknown as CompiledWorkflow;
}
