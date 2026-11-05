// GameSpec / AppSpec. The model may propose JSON. Only a schema-and-policy pass becomes a plan.
// Unknown fields, commands, paths and tokens are rejected, not executed.
import { z } from "zod";
import { API_COST_CAP_USD, capApiCost, cleanBrief, unsafeSpecText } from "./policies.js";

export const SCHEMA_VERSION = 1 as const;
export const KINDS = ["game", "app"] as const;
export const ENGINES = ["godot", "kotlin"] as const;
export const VIEWS = ["2d", "3d", "ui"] as const;
export const GENRES = ["action-rpg", "defense", "strategy", "fishing", "horror", "utility", "productivity"] as const;
export const ART_STYLES = ["pixel-16bit", "pixel-8bit", "lowpoly", "material"] as const;
export const ORIENTATIONS = ["landscape", "portrait"] as const;
export const FEATURES = ["combat", "dodge", "xp", "game-over", "npc-dialogue", "quest", "inventory", "save-load", "tutorial", "settings", "list", "form"] as const;
export const MONETIZATION = ["none-in-mvp", "ads-later", "iap-later"] as const;
export const ACCEPTANCE = ["boot-to-menu", "tutorial-playable", "save-restores", "android-debug-apk", "screen-opens"] as const;
export const SLUG = /^[a-z][a-z0-9-]{1,39}$/;

const Feature = z.enum(FEATURES);
const SpecObject = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.enum(KINDS),
  slug: z.string().regex(SLUG),
  title: z.string().trim().min(1).max(40),
  target: z.object({
    platform: z.literal("android"),
    engine: z.enum(ENGINES),
    view: z.enum(VIEWS),
  }).strict(),
  design: z.object({
    genre: z.enum(GENRES),
    artStyle: z.enum(ART_STYLES),
    orientation: z.enum(ORIENTATIONS),
  }).strict(),
  features: z.array(Feature).min(1).max(8),
  assets: z.object({
    characters: z.number().int().min(0).max(12),
    maps: z.number().int().min(0).max(8),
    vfx: z.number().int().min(0).max(16),
    models: z.number().int().min(0).max(8),
  }).strict(),
  monetization: z.object({
    ads: z.enum(MONETIZATION),
    iap: z.enum(MONETIZATION),
  }).strict(),
  limits: z.object({
    maxApiCostUsd: z.number().min(0).max(25),
    maxAttemptsPerTask: z.number().int().min(1).max(3),
    maxConcurrentHeavyJobs: z.literal(1),
  }).strict(),
  acceptance: z.array(z.enum(ACCEPTANCE)).min(1).max(6),
}).strict();

export type FactorySpec = z.infer<typeof SpecObject>;
export type FactoryKind = (typeof KINDS)[number];
export type FactoryHints = { kind?: FactoryKind; view?: (typeof VIEWS)[number]; orientation?: (typeof ORIENTATIONS)[number] };

const ROOT_KEYS = ["schemaVersion", "kind", "slug", "title", "target", "design", "features", "assets", "monetization", "limits", "acceptance"];
const NESTED: Record<string, string[]> = {
  target: ["platform", "engine", "view"],
  design: ["genre", "artStyle", "orientation"],
  assets: ["characters", "maps", "vfx", "models"],
  monetization: ["ads", "iap"],
  limits: ["maxApiCostUsd", "maxAttemptsPerTask", "maxConcurrentHeavyJobs"],
};

const InputObject = z.object({
  brief: z.string().trim().min(1).max(2000).optional(),
  kind: z.enum(KINDS).optional(),
  view: z.enum(VIEWS).optional(),
  orientation: z.enum(ORIENTATIONS).optional(),
  resumeProject: z.string().regex(SLUG).optional(),
  opinion: z.string().trim().max(500).optional(),
  applyOpinion: z.boolean().optional(),
}).strict();
export type FactoryInput = z.infer<typeof InputObject>;

function issues(error: z.ZodError): string[] {
  return error.issues.slice(0, 12).map(issue => (issue.path.length ? issue.path.map(String).join(".") + ": " : "") + issue.message);
}

function extraKeys(value: unknown, allowed: string[]): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).filter(key => !allowed.includes(key));
}

/** Rejects fields the schema does not name, before any plan is built. */
export function unknownSpecFields(raw: unknown): string[] {
  const root = extraKeys(raw, ROOT_KEYS);
  const problems = root.map(key => key + ": 허용되지 않은 필드입니다.");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return problems;
  const record = raw as Record<string, unknown>;
  for (const [key, allowed] of Object.entries(NESTED)) problems.push(...extraKeys(record[key], allowed).map(child => `${key}.${child}: 허용되지 않은 필드입니다.`));
  return problems;
}

export function policyProblems(spec: FactorySpec, kind: FactoryKind): string[] {
  const problems: string[] = [];
  const title = unsafeSpecText(spec.title);
  if (title) problems.push("title: " + title);
  if (spec.kind !== kind) problems.push("워크플로 종류와 명세 종류가 다릅니다.");
  if (spec.kind === "game" && spec.target.engine !== "godot") problems.push("게임 엔진은 godot 입니다.");
  if (spec.kind === "app" && (spec.target.engine !== "kotlin" || spec.target.view !== "ui" || spec.design.artStyle !== "material")) problems.push("앱은 kotlin UI 입니다.");
  if (spec.target.view === "2d" && ((spec.design.artStyle !== "pixel-16bit" && spec.design.artStyle !== "pixel-8bit") || spec.assets.models !== 0)) problems.push("2D는 픽셀 스타일이며 3D 모델 수가 0이어야 합니다.");
  if (spec.target.view === "3d" && (spec.design.artStyle !== "lowpoly" || spec.assets.models < 1)) problems.push("3D는 로우폴리이며 모델이 하나 이상이어야 합니다.");
  if (spec.kind === "app" && (spec.assets.characters !== 0 || spec.assets.maps !== 0 || spec.assets.vfx !== 0 || spec.assets.models !== 0)) problems.push("앱 명세에는 게임 에셋 수를 넣지 않습니다.");
  if (new Set(spec.features).size !== spec.features.length) problems.push("기능이 중복됩니다.");
  if (new Set(spec.acceptance).size !== spec.acceptance.length) problems.push("완료 기준이 중복됩니다.");
  if (spec.kind === "game" && (!spec.acceptance.includes("boot-to-menu") || !spec.acceptance.includes("android-debug-apk"))) problems.push("게임 완료 기준에 메뉴 기동과 디버그 APK가 없습니다.");
  if (spec.kind === "app" && (!spec.acceptance.includes("screen-opens") || !spec.acceptance.includes("android-debug-apk"))) problems.push("앱 완료 기준에 화면 기동과 디버그 APK가 없습니다.");
  if (spec.limits.maxConcurrentHeavyJobs !== 1) problems.push("무거운 작업은 한 번에 하나만 실행합니다.");
  return problems;
}

export function acceptModelSpec(raw: unknown, kind: FactoryKind): { spec: FactorySpec | null; problems: string[]; notes: string[] } {
  const unknown = unknownSpecFields(raw);
  if (unknown.length) return { spec: null, problems: unknown, notes: [] };
  const parsed = SpecObject.safeParse(raw);
  if (!parsed.success) return { spec: null, problems: issues(parsed.error), notes: [] };
  const problems = policyProblems(parsed.data, kind);
  if (problems.length) return { spec: null, problems, notes: [] };
  const capped = capApiCost(parsed.data);
  const notes = [capped.note, parsed.data.monetization.ads !== "none-in-mvp" || parsed.data.monetization.iap !== "none-in-mvp" ? "광고·결제는 자동 구현하지 않습니다." : null].filter((note): note is string => Boolean(note));
  return { spec: capped.spec, problems: [], notes };
}

const TOKEN_RULES: Array<[RegExp, string]> = [
  [/무협|wuxia/i, "wuxia"],
  [/로그라이트|roguelite/i, "roguelite"],
  [/디펜스|defense|타워/i, "defense"],
  [/낚시|fishing/i, "fishing"],
  [/호러|horror|공포/i, "horror"],
  [/전략|strategy/i, "strategy"],
  [/rpg|알피지/i, "rpg"],
];

function slugFrom(text: string, kind: FactoryKind): string {
  const tokens: string[] = [];
  for (const [pattern, token] of TOKEN_RULES) if (pattern.test(text) && !tokens.includes(token)) tokens.push(token);
  const joined = (tokens.length ? tokens.join("-") : kind).slice(0, 40).replace(/-$/, "");
  return SLUG.test(joined) ? joined : kind;
}

function titleFrom(text: string): string {
  const sentence = (text.split(/[.!?。\n]/)[0] ?? text).replace(/\s+/g, " ").trim();
  const title = sentence.slice(0, 40).trim() || (sentence ? "새 프로젝트" : "새 프로젝트");
  return unsafeSpecText(title) ? "새 프로젝트" : title;
}

function countOf(text: string, rules: Array<[RegExp, number]>, fallback: number): number {
  for (const [pattern, count] of rules) if (pattern.test(text)) return count;
  return fallback;
}

/** Deterministic spec from the brief. Labelled as a template by the caller, never as a model result. */
export function templateSpec(brief: string, hints: FactoryHints, fallbackKind: FactoryKind): { spec: FactorySpec; notes: string[] } {
  const notes: string[] = [];
  const kind = hints.kind ?? fallbackKind;
  let view = hints.view ?? (kind === "app" ? "ui" : /3d|로우폴리|입체/i.test(brief) ? "3d" : "2d");
  if (kind === "app" && view !== "ui") { view = "ui"; notes.push("앱은 UI 화면으로 맞췄습니다."); }
  if (kind === "game" && view === "ui") { view = "2d"; notes.push("게임은 2D 화면으로 맞췄습니다."); }
  const orientation = hints.orientation ?? (/세로|portrait/i.test(brief) ? "portrait" : kind === "app" ? "portrait" : "landscape");
  const artStyle = view === "3d" ? "lowpoly" : view === "ui" ? "material" : /8\s*비트|8bit/i.test(brief) ? "pixel-8bit" : "pixel-16bit";
  const genre = kind === "app"
    ? (/할\s*일|메모|생산/i.test(brief) ? "productivity" : "utility")
    : view === "3d" && /호러|horror|공포/i.test(brief) ? "horror"
      : /디펜스|타워/i.test(brief) ? "defense"
        : /전략/i.test(brief) ? "strategy"
          : /낚시/i.test(brief) ? "fishing"
            : "action-rpg";
  const heroes = 1;
  const foes = countOf(brief, [[/세\s*(적|마리)|적\s*셋|세\s*명/, 3], [/두\s*(적|마리)|적\s*둘/, 2], [/한\s*적|적\s*하나/, 1]], 0);
  const characters = view === "2d" ? Math.min(12, heroes + foes) : 0;
  const features: FactorySpec["features"] = [];
  const acceptance: FactorySpec["acceptance"] = [];
  if (kind === "app") {
    features.push("list", "form", "settings");
    acceptance.push("screen-opens", "android-debug-apk");
  } else {
    features.push("tutorial");
    if (/공격|전투|combat/i.test(brief)) features.push("combat");
    if (/회피|dodge/i.test(brief)) features.push("dodge");
    if (/경험치|xp/i.test(brief)) features.push("xp");
    if (/게임\s*오버|game\s*over/i.test(brief)) features.push("game-over");
    if (/저장|save/i.test(brief)) features.push("save-load");
    acceptance.push("boot-to-menu", "tutorial-playable", "android-debug-apk");
    if (/저장|save/i.test(brief)) acceptance.push("save-restores");
  }
  const spec: FactorySpec = {
    schemaVersion: SCHEMA_VERSION,
    kind,
    slug: slugFrom(brief, kind),
    title: titleFrom(brief),
    target: { platform: "android", engine: kind === "app" ? "kotlin" : "godot", view },
    design: { genre, artStyle, orientation },
    features: [...new Set(features)].slice(0, 8),
    assets: {
      characters,
      maps: view === "2d" ? 1 : 0,
      vfx: view === "2d" && features.includes("combat") ? 2 : 0,
      models: view === "3d" ? 1 : 0,
    },
    monetization: { ads: "none-in-mvp", iap: "none-in-mvp" },
    limits: { maxApiCostUsd: API_COST_CAP_USD, maxAttemptsPerTask: 3, maxConcurrentHeavyJobs: 1 },
    acceptance: [...acceptance],
  };
  const problems = policyProblems(spec, kind);
  if (problems.length) throw new Error(problems.join(" "));
  return { spec, notes };
}

export function factoryInput(raw: unknown): { input: FactoryInput | null; problems: string[]; notes: string[] } {
  const parsed = InputObject.safeParse(raw && typeof raw === "object" ? raw : {});
  if (!parsed.success) return { input: null, problems: issues(parsed.error), notes: [] };
  if (!parsed.data.brief && !parsed.data.resumeProject) return { input: null, problems: ["요청을 입력하세요."], notes: [] };
  if (!parsed.data.brief) return { input: parsed.data, problems: [], notes: [] };
  const cleaned = cleanBrief(parsed.data.brief);
  if (cleaned.problems.length) return { input: null, problems: cleaned.problems, notes: cleaned.notes };
  const opinion = parsed.data.opinion?.trim() ?? "";
  if (opinion) {
    const reason = unsafeSpecText(opinion);
    if (reason) return { input: null, problems: ["의견: " + reason], notes: [] };
  }
  const applyOpinion = Boolean(opinion) && parsed.data.applyOpinion === true;
  return {
    input: { ...parsed.data, brief: cleaned.text, ...(opinion ? { opinion, applyOpinion } : { opinion: undefined, applyOpinion: undefined }) },
    problems: [],
    notes: cleaned.notes,
  };
}
