import { createHash } from "node:crypto";

export class UserError extends Error {}

export const sha1 = (value: string | Buffer) => createHash("sha1").update(value).digest("hex");
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function record(value: unknown, what = "입력"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError(`${what} 형식을 확인하세요.`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, what: string, max = 20_000, { optional = false } = {}): string {
  if (value === undefined || value === null || value === "") {
    if (optional) return "";
    throw new UserError(`${what}을(를) 입력하세요.`);
  }
  if (typeof value !== "string") throw new UserError(`${what} 형식을 확인하세요.`);
  if (value.length > max) throw new UserError(`${what}이(가) 너무 깁니다. 최대 ${max}자입니다.`);
  return value;
}

/** Keep the head and tail of long output; the middle is usually least useful in build logs. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.3);
  return `${value.slice(0, head)}\n…(${value.length - max}자 생략)…\n${value.slice(value.length - (max - head))}`;
}

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /sk-or-v1-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
];
/** Provider errors and tool logs may echo credentials; never forward them to the UI. */
export function redact(value: string, secrets: string[] = []): string {
  let out = value;
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("[숨김]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[숨김]");
  return out;
}

export function errorText(error: unknown): string {
  if (error instanceof UserError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "작업이 취소되었습니다.";
  return error instanceof Error ? error.message : String(error);
}

/** Extract the first balanced JSON object from model output (fenced or bare). */
export function parseJsonObject(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const candidate of [fenced, raw].filter((v): v is string => typeof v === "string")) {
    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { return record(JSON.parse(candidate.slice(start, i + 1)), "모델 응답"); } catch { break; }
      }
    }
  }
  throw new UserError("모델 응답에서 JSON 객체를 찾지 못했습니다.");
}

export function stringArray(value: unknown, max = 50, itemMax = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").slice(0, max).map(v => v.slice(0, itemMax));
}
