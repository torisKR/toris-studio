import { invoke } from "@tauri-apps/api/core";
import type { BridgeInvoke } from "./ai-client";

export const PUBLISH_PLATFORMS = ["youtube", "instagram", "facebook", "threads", "tiktok"] as const;
export type PublishPlatform = typeof PUBLISH_PLATFORMS[number] | "naver_blog";
export type ContentKind = "video" | "text" | "article";
export type PublicationMedia = { id: string; kind: "video" | "thumbnail"; name: string; bytes: number; mime: string; sha256: string; createdAt: string; probe: { width?: number; height?: number; durationSeconds?: number; codec?: string } };
export type PublicationOverrides = { title?: string; description?: string; tags?: string[]; hashtags?: string[] };
export type PublicationTarget = { id: string; platform: PublishPlatform; accountId: string; accountTitle: string; mode: "manual" | "scheduled" | "tiktok_inbox" | "manual_handoff"; scheduledAt?: string | null; overrides: PublicationOverrides; options: Record<string, unknown> };
export type PublishingJob = { id: string; targetId: string; revision?: number; platform?: PublishPlatform; contentKind?: ContentKind; verification?: string | null; accountId?: string; accountTitle?: string; status: string; mode: string; scheduledAt?: string | null; externalId?: string | null; url?: string | null; error?: string | null; warnings: string[]; thumbnailStatus?: string | null; updatedAt: string; retryable: boolean };
export type Publication = { id?: string; revision: number; contentKind?: ContentKind; imageMediaIds?: string[]; videoMediaId?: string | null; thumbnailMediaId?: string | null; title: string; description: string; tags: string[]; hashtags: string[]; targets: PublicationTarget[]; createdAt?: string; updatedAt?: string; jobs?: PublishingJob[] };
export type PublicationsSnapshot = { publications: Publication[]; media: PublicationMedia[]; scheduler: { paused: boolean; running: boolean; lastTickAt?: string | null; message: string } };
export type CreatorInfo = { privacyLevelOptions: string[]; commentDisabled: boolean; duetDisabled: boolean; stitchDisabled: boolean; maxVideoPostDurationSec: number; username?: string; nickname?: string };
export type PublishAccount = { platform: PublishPlatform; accountId: string; name: string; publishingAuthorized: boolean; capabilities: { video: boolean; text?: boolean; title: boolean; description: boolean; tags: boolean; hashtags: boolean; thumbnail: boolean; thumbnailFrame: boolean; draft: boolean; direct: boolean; directPublicSupported: boolean }; auditStatus?: string; apiAuditVerified?: boolean; creatorInfo?: CreatorInfo | null; directPublicSupported?: boolean };
export type PublishAccounts = { accounts: PublishAccount[]; warnings: { platform: PublishPlatform; message: string }[]; checkedAt: string };
export type PublicationCheck = { targetId: string; ready: boolean; message: string; details?: { warnings?: string[]; [key: string]: unknown } };
export type PublicationPreflight = { publicationId: string; revision: number; approvalHash: string; ready: boolean; checks: PublicationCheck[]; media: { video?: PublicationMedia | null; thumbnail?: PublicationMedia | null; images?: PublicationMedia[] } };

export const PLATFORM_LABELS: Record<PublishPlatform, string> = { youtube: "YouTube", instagram: "Instagram Reels", facebook: "Facebook Page", threads: "Threads", tiktok: "TikTok", naver_blog: "네이버 블로그 · 수동 인계" };
export const FIELD_SUPPORT: Record<PublishPlatform, string> = {
  youtube: "제목·설명·태그·PNG·JPEG 썸네일 적용. 해시태그는 설명에 포함하며 설명과 해시태그 합계는 5,000바이트 이내입니다.",
  instagram: "제목·설명·해시태그는 캡션에 적용합니다. 태그는 사용하지 않습니다. 커버는 8 MiB 이하 JPEG 이미지 또는 영상 프레임을 선택합니다.",
  facebook: "제목·설명·해시태그를 적용합니다. 태그는 사용하지 않습니다. 커버 저장 결과는 영상 게시와 따로 확인합니다.",
  threads: "제목·설명·해시태그는 본문에 적용합니다. 태그·별도 썸네일은 사용하지 않습니다.",
  tiktok: "Direct Post는 영상 캡션·커버 프레임을 적용합니다. 미심사 앱은 비공개 계정의 SELF_ONLY만 가능하며 공개 Direct(예약 포함)는 별도 심사·권한과 실제 API 허용이 필요합니다. 받은 편지함 초안은 영상만 전달하며 TikTok에서 사용자가 최종 게시합니다. 텍스트·사진·별도 썸네일은 이 릴리스에서 지원하지 않습니다.",
  naver_blog: "제목·본문·태그·첨부 이미지를 로컬 인계 폴더로 내보냅니다. 자동 게시·예약·계정 권한 검증이 아니며 사용자가 네이버에서 직접 게시합니다."
};
export const JOB_LABELS: Record<string, string> = { queued: "게시 대기", scheduled: "예약 승인됨", sending: "전송 중", processing: "플랫폼 처리 중", published: "게시 확인됨", draft_sent: "초안 전송 완료", failed: "실패", uncertain: "결과 확인 필요", needs_confirmation: "재승인 필요", needs_human_publish: "수동 게시 필요", cancelled: "취소됨" };
export function publicationApi<T>(command: string, input?: object, call: BridgeInvoke = invoke): Promise<T> {
  return call(`publication_${command}`, input === undefined ? undefined : { input }) as Promise<T>;
}
export function splitTags(value: string, hashtags = false): string[] {
  return [...new Set(value.split(hashtags ? /[,\s]+/u : /[,\n]+/u).map(item => item.trim().replace(hashtags ? /^#+/u : /$^/u, "")).filter(Boolean))];
}
export function targetContent(publication: Publication, target: PublicationTarget) {
  return { title: target.overrides.title ?? publication.title, description: target.overrides.description ?? publication.description, tags: target.overrides.tags ?? publication.tags, hashtags: target.overrides.hashtags ?? publication.hashtags };
}
export function targetCaption(publication: Publication, target: PublicationTarget): string {
  const content = targetContent(publication, target);
  return [target.platform === "youtube" ? "" : content.title, content.description, content.hashtags.map(tag => `#${tag.replace(/^#+/u, "")}`).join(" ")].filter(Boolean).join("\n\n");
}
export function newPublication(): Publication { return { revision: 0, contentKind: "video", imageMediaIds: [], title: "", description: "", tags: [], hashtags: [], targets: [] }; }
export function platformsForContent(kind: ContentKind = "video"): readonly PublishPlatform[] {
  return kind === "text" ? ["facebook", "threads", "naver_blog"] : kind === "article" ? ["naver_blog"] : PUBLISH_PLATFORMS;
}
export function publicationForKind(publication: Publication, kind: ContentKind): Publication {
  if ((publication.contentKind ?? "video") === kind) return publication;
  return { ...publication, contentKind: kind, targets: publication.targets.filter(target => platformsForContent(kind).includes(target.platform)), videoMediaId: null, thumbnailMediaId: null, imageMediaIds: [] };
}
export function newTarget(platform: PublishPlatform): PublicationTarget {
  if (platform === "naver_blog") return { id: crypto.randomUUID(), platform, accountId: "", accountTitle: "", mode: "manual_handoff", overrides: {}, options: { confirmHandoff: false } };
  return { id: crypto.randomUUID(), platform, accountId: "", accountTitle: "", mode: "manual", overrides: {}, options: platform === "youtube" ? { privacy: "private", madeForKids: false, confirmPublic: false } : platform === "tiktok" ? { mode: "direct", privacy: "", allowComments: false, allowDuet: false, allowStitch: false, commercialContent: false, brandOrganic: false, brandContent: false, musicConsent: false, publishConsent: false } : { confirmPublic: false } };
}
/** Approval is bound to the persisted revision and explicit selected destinations. */
export function submissionInput(publication: Publication, check: PublicationPreflight, confirmed: boolean) {
  if (!confirmed) throw new Error("파일과 문구, 대상 계정을 확인하고 실제 전송에 동의하세요.");
  if (!publication.id || check.publicationId !== publication.id || check.revision !== publication.revision) throw new Error("콘텐츠가 변경되었습니다. 저장 후 사전 검사를 다시 실행하세요.");
  const ids = check.checks.map(item => item.targetId);
  if (!check.ready || !check.approvalHash || !ids.length || new Set(ids).size !== ids.length || check.checks.some(item => !item.ready || !publication.targets.some(target => target.id === item.targetId))) throw new Error("선택한 모든 채널의 사전 검사를 통과해야 합니다.");
  return { publicationId: publication.id, revision: publication.revision, targetIds: ids, approvalHash: check.approvalHash, confirmed: true };
}
export function jobActions(job: PublishingJob): string[] {
  if (job.status === "needs_human_publish") return ["export_handoff", "confirm_handoff", "cancel"];
  if (["published", "draft_sent", "cancelled"].includes(job.status)) return [];
  if (["uncertain", "processing", "sending"].includes(job.status)) return ["reconcile"];
  if (job.status === "needs_confirmation") return ["review"];
  if (job.status === "failed") return job.retryable ? ["retry"] : [];
  if (["queued", "scheduled"].includes(job.status)) return ["cancel"];
  return [];
}
export function publishingError(value: unknown): string { return typeof value === "string" ? value : value instanceof Error ? value.message : "게시 작업을 처리하지 못했습니다."; }
export function kstSchedule(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) throw new Error("예약 일시를 확인하세요.");
  const date = new Date(`${value}:00+09:00`);
  if (!Number.isFinite(date.getTime()) || scheduleInput(date.toISOString()) !== value) throw new Error("예약 일시를 확인하세요.");
  return date.toISOString();
}
export function scheduleInput(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16);
}
/** Edits a draft only; persistence, preflight and explicit approval stay separate. */
export function batchSchedule(publication: Publication, targetIds: string[], firstKst: string, spacingMinutes: number, now = Date.now()): Publication {
  const selected = new Set(targetIds);
  if (!selected.size || selected.size !== targetIds.length || publication.targets.length > 20 || new Set(publication.targets.map(target => target.id)).size !== publication.targets.length || targetIds.some(id => !publication.targets.some(target => target.id === id))) throw new Error("예약할 대상을 중복 없이 선택하세요.");
  if (!Number.isInteger(spacingMinutes) || spacingMinutes < 0 || spacingMinutes > 1440) throw new Error("채널 간격은 0~1440분 정수로 입력하세요.");
  if (!Number.isFinite(now)) throw new Error("예약 기준 시간을 확인하세요.");
  const first = Date.parse(kstSchedule(firstKst) || "");
  if (!Number.isFinite(first) || first <= now) throw new Error("예약 일시는 미래로 선택하세요.");
  if (publication.targets.some(target => selected.has(target.id) && (target.platform === "naver_blog" || target.mode === "manual_handoff"))) throw new Error("네이버 수동 게시 인계는 자동 예약으로 변경할 수 없습니다.");
  if (publication.targets.some(target => selected.has(target.id) && target.mode === "tiktok_inbox")) throw new Error("TikTok 초안 전송은 일괄 예약으로 변경하지 않습니다. 대상을 제외하세요.");
  if (publication.jobs?.some(job => selected.has(job.targetId) && (job.revision == null || job.revision === publication.revision) && !["cancelled", "needs_confirmation"].includes(job.status))) throw new Error("이미 승인·전송한 작업은 일괄 예약으로 덮어쓰지 않습니다. 작업 결과를 먼저 확인하세요.");
  let index = 0;
  return { ...publication, targets: publication.targets.map(target => selected.has(target.id)
    ? { ...target, mode: "scheduled", scheduledAt: new Date(first + index++ * spacingMinutes * 60_000).toISOString() }
    : target) };
}
export function safePostUrl(value?: string | null): string | undefined {
  if (!value) return;
  try { const url = new URL(value); if (url.protocol === "https:" && !url.username && !url.password) return url.href; } catch { /* No external link for malformed platform responses. */ }
}
