import { nativeInvoke, type BridgeInvoke } from "../ai-client";
import type { HostedAssistant, SendReceipt, SnsHandoff, SnsImport, SnsPlatform, SnsPost, SnsRequest } from "./types";

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const str = (value: unknown) => typeof value === "string" ? value : "";

/** Same platforms and limits as the native `reason_sns::PLATFORMS`. */
export const SNS_PLATFORMS: ReadonlyArray<{ id: SnsPlatform; label: string; limit: number; manual: boolean }> = [
  { id: "youtube", label: "YouTube", limit: 5000, manual: false },
  { id: "instagram", label: "Instagram", limit: 2200, manual: false },
  { id: "facebook", label: "Facebook", limit: 5000, manual: false },
  { id: "threads", label: "Threads", limit: 500, manual: false },
  { id: "tiktok", label: "TikTok", limit: 2200, manual: false },
  { id: "naver_blog", label: "네이버 블로그", limit: 20000, manual: true },
  { id: "naver_clip", label: "네이버 클립", limit: 1000, manual: true },
  { id: "x", label: "X", limit: 280, manual: true }
];
export const HOSTED_ASSISTANTS: ReadonlyArray<{ id: HostedAssistant; label: string }> = [
  { id: "muse", label: "Muse" }, { id: "dots", label: "OpenAI Dots" }, { id: "grok", label: "Grok Bot" }
];
const platformInfo = (id: string) => SNS_PLATFORMS.find(p => p.id === id);
export const platformLabel = (id: string) => platformInfo(id)?.label ?? id;
export const platformLimit = (id: string) => platformInfo(id)?.limit ?? 0;
export const isManualPlatform = (id: string) => platformInfo(id)?.manual ?? true;

/** Text plus the `#tag` suffix Studio appends (characters, as the host counts them). */
export function postLength(text: string, hashtags: string[]): number {
  return [...text.trim()].length + hashtags.reduce((sum, tag) => sum + [...tag].length + 2, 0);
}
/** Splits "#a #b, c" into ["a", "b", "c"]; the host re-validates every tag. */
export function parseHashtags(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map(tag => tag.replace(/^#+/, "").trim()).filter(Boolean))];
}

/** Display preview only. The host validates the raw message again before importing. */
export function snsRequest(value: unknown): SnsRequest | null {
  const r = rec(value);
  if (r.schema !== "toris-studio.sns.v1" || !str(r.requestId) || !str(r.title).trim() || !Array.isArray(r.posts)) return null;
  const posts: SnsPost[] = [];
  for (const raw of r.posts) {
    const p = rec(raw);
    if (!platformInfo(str(p.platform)) || !str(p.text).trim() || posts.some(x => x.platform === p.platform)) return null;
    const hashtags = Array.isArray(p.hashtags) ? p.hashtags.filter((t): t is string => typeof t === "string") : [];
    posts.push({ platform: p.platform as SnsPlatform, text: str(p.text), hashtags, ...(str(p.title) ? { title: str(p.title) } : {}) });
  }
  if (!posts.length || posts.length > 8) return null;
  const media = rec(r.media);
  return {
    schema: "toris-studio.sns.v1", requestId: str(r.requestId), title: str(r.title), posts,
    media: (media.kind === "videoJob" || media.kind === "media") && str(media.id) ? { kind: media.kind, id: str(media.id) } : null,
    scheduleAt: str(r.scheduleAt) || null
  };
}
export function snsImport(value: unknown): SnsImport | null {
  const r = rec(value);
  if (r.state !== "pending" && r.state !== "imported") return null;
  const platforms = (Array.isArray(r.platforms) ? r.platforms : []).filter((p): p is SnsPlatform => typeof p === "string" && !!platformInfo(p));
  const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
  return { state: r.state, platforms, contentDrafts: count(r.contentDrafts), publicationDrafts: count(r.publicationDrafts), mediaAttached: r.mediaAttached === true, updatedAt: str(r.updatedAt) };
}

const messageId = (value: string) => {
  const clean = value.trim();
  if (!clean || clean.length > 1024 || /[\x00-\x1f\x7f]/.test(clean)) throw new Error("메시지를 확인하세요.");
  return clean;
};

/** `<input type="datetime-local">` value (local time) -> RFC 3339 with offset, or null. */
export function localToRfc3339(local: string): string | null {
  if (!local) return null;
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) throw new Error("예약 희망 시간을 확인하세요.");
  const offset = -date.getTimezoneOffset(), sign = offset >= 0 ? "+" : "-", abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
/** RFC 3339 -> `datetime-local` value in this computer's time zone. */
export function rfc3339ToLocal(raw: string | null): string {
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type SnsImportInput = { messageId: string; title: string; posts: SnsPost[]; scheduleAt: string | null; attachMedia: boolean };
export async function importSnsRequest(input: SnsImportInput, call: BridgeInvoke = nativeInvoke): Promise<{ reused: boolean; import: SnsImport; warning: string | null }> {
  if (!input.posts.length) throw new Error("가져올 플랫폼을 하나 이상 고르세요.");
  for (const post of input.posts) {
    const limit = platformLimit(post.platform);
    if (!post.text.trim()) throw new Error(platformLabel(post.platform) + " 본문을 입력하세요.");
    if (postLength(post.text, post.hashtags) > limit) throw new Error(`${platformLabel(post.platform)} 본문과 해시태그를 합쳐 ${limit.toLocaleString("ko-KR")}자 이하로 줄이세요.`);
  }
  const payload = {
    messageId: messageId(input.messageId), title: input.title.trim(), attachMedia: input.attachMedia,
    posts: input.posts.map(p => ({ platform: p.platform, text: p.text, hashtags: p.hashtags, ...(p.title?.trim() ? { title: p.title.trim() } : {}) })),
    ...(input.scheduleAt ? { scheduleAt: input.scheduleAt } : {})
  };
  const result = rec(await call("reason_network_import_sns", { input: payload }));
  const imported = snsImport(result.import);
  if (!imported) throw new Error("가져온 결과를 확인하지 못했습니다. 받은 요청을 새로고침하세요.");
  return { reused: result.reused === true, import: imported, warning: str(result.warning) || null };
}
export async function sendSnsResult(id: string, call: BridgeInvoke = nativeInvoke): Promise<SendReceipt> {
  const raw = rec(await call("reason_network_send_sns_result", { input: { messageId: messageId(id) } })).messageIds;
  const ids = (Array.isArray(raw) ? raw : []).filter((v): v is string => typeof v === "string" && !!v);
  if (!ids.length) throw new Error("전송 결과를 확인하지 못했습니다. 중복 전송 전에 받은 편지함을 확인하세요.");
  return { messageIds: ids };
}
export async function createSnsHandoff(assistant: HostedAssistant, brief: string, platforms: SnsPlatform[], call: BridgeInvoke = nativeInvoke): Promise<SnsHandoff> {
  const text = brief.trim();
  if (!HOSTED_ASSISTANTS.some(a => a.id === assistant)) throw new Error("어시스턴트를 고르세요.");
  if (!text || [...text].length > 4000) throw new Error("SNS 기획 요청은 1~4,000자로 입력하세요.");
  if (!platforms.length) throw new Error("기획할 플랫폼을 하나 이상 고르세요.");
  const r = rec(await call("reason_network_sns_handoff", { input: { assistant, brief: text, platforms } }));
  if (!/^TS-[0-9A-F]{10}$/.test(str(r.code)) || !str(r.prompt)) throw new Error("전달문을 만들지 못했습니다. 다시 시도하세요.");
  return { code: str(r.code), assistant: str(r.assistant), prompt: str(r.prompt) };
}

export const SNS_REQUEST_EXAMPLE = JSON.stringify({
  schema: "toris-studio.sns.v1", requestId: "sns-demo-001", title: "단월 업데이트 홍보",
  posts: [
    { platform: "threads", text: "단월에 새로운 장비와 성장 시스템이 추가됐어요. 오늘 저녁 업데이트에서 확인해 보세요.", hashtags: ["단월", "업데이트"] },
    { platform: "instagram", text: "새로운 장비, 새로운 성장. 단월 업데이트 소식을 영상으로 정리했어요.", hashtags: ["단월", "게임업데이트", "모바일게임"] },
    { platform: "x", text: "단월 업데이트: 새 장비와 성장 시스템을 만나 보세요.", hashtags: ["단월"] }
  ],
  scheduleAt: "2026-06-01T19:00:00+09:00"
}, null, 2);
