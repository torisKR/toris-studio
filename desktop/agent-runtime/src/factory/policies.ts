// Closed rules for factory text, licences and spend. Model text is data: a command,
// path or token in a spec is rejected here and is never passed to a process.

const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bfile:|\bjavascript:|\bdata:[a-z]+\//i;
const PATH_LIKE = /(^|[\s"'(=\[])(~|\.{1,2})?\/[\w.-]|[A-Za-z]:\\|\.\.[\/\\]|\\\\/;
const CODE_LIKE = /\u0060\u0060\u0060|~~~|\$\(|\$\{|<script|\b(bash|sh|python3)\s+-c\b/i;
const TOKEN_LIKE = /\b(sk-ant-|sk-or-|sk-proj-|ghp_|github_pat_|AIza)/;

/** Why a model-written field cannot be stored, or null when it is plain text. */
export function unsafeSpecText(text: string): string | null {
  if (CONTROL.test(text)) return "제어 문자가 들어 있습니다.";
  if (URL_LIKE.test(text)) return "URL을 넣을 수 없습니다.";
  if (PATH_LIKE.test(text)) return "파일 경로를 넣을 수 없습니다.";
  if (CODE_LIKE.test(text)) return "명령이나 코드를 넣을 수 없습니다.";
  if (TOKEN_LIKE.test(text)) return "비밀값처럼 보이는 문자열이 들어 있습니다.";
  return null;
}

/** Briefs may mention a reference URL. It is removed and never fetched or stored. */
export function cleanBrief(brief: string): { text: string; notes: string[]; problems: string[] } {
  if (CONTROL.test(brief)) return { text: "", notes: [], problems: ["요청에 제어 문자가 들어 있습니다."] };
  if (TOKEN_LIKE.test(brief)) return { text: "", notes: [], problems: ["요청에 비밀값처럼 보이는 문자열이 들어 있습니다."] };
  if (CODE_LIKE.test(brief)) return { text: "", notes: [], problems: ["요청에 명령을 넣을 수 없습니다."] };
  const notes = URL_LIKE.test(brief) ? ["참조 URL은 가져오지 않고 명세에서 뺐습니다."] : [];
  const text = brief.replace(URL_LIKE, " ").replace(PATH_LIKE, " ").replace(/\s+/g, " ").trim();
  if (!text) return { text: "", notes, problems: ["요청이 비어 있습니다."] };
  return { text, notes, problems: [] };
}

/** Greenfield cap. A model cannot raise it by writing a higher number. */
export const API_COST_CAP_USD = 5;

export function capApiCost<T extends { limits: { maxApiCostUsd: number } }>(spec: T): { spec: T; note: string | null } {
  if (spec.limits.maxApiCostUsd <= API_COST_CAP_USD) return { spec, note: null };
  return {
    spec: { ...spec, limits: { ...spec.limits, maxApiCostUsd: API_COST_CAP_USD } },
    note: "API 상한을 5달러로 맞췄습니다.",
  };
}

export const NOTICES = [
  "Toris Studio 팩토리 템플릿이 포함한 고지입니다. 생성 모델·입력 이미지·엔진의 이용 조건은 각각 따로 확인해야 합니다.",
  "arjun988/blender-skills: MIT. 스킬 문서이며 이 템플릿은 Blender를 자동으로 실행하지 않습니다.",
  "patch-gg/pixelfx: MIT (효과·코드). gallery/fonts 의 Patch Pixel 글꼴은 MIT 범위 밖이며 기본 배포에 넣지 않습니다.",
  "aldegad/sprite-gen: Apache-2.0 (도구 코드). 유료 모델 호출은 승인 없이 하지 않으며 다른 제공자로 자동 전환하지 않습니다.",
  "Godot Engine, Blender, Android SDK 는 각 프로젝트의 라이선스를 따릅니다.",
].join("\n");

/** Sprite-gen may call a paid model. The locked provider is the only one allowed; there is no fallback. */
export const SPRITE_PROVIDERS = ["codex", "grok", "claude"] as const;
export type SpriteProvider = (typeof SPRITE_PROVIDERS)[number];

export function spriteProviderAllowed(provider: string, locked: SpriteProvider | null): boolean {
  if (!SPRITE_PROVIDERS.includes(provider as SpriteProvider)) return false;
  if (locked && provider !== locked) return false;
  return true;
}
