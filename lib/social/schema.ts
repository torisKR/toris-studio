import { z } from "zod";
import { CONTENT_STATUSES, SOCIAL_PLATFORMS } from "./types";

const httpsUrl = z.string().trim().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "인증 정보 없는 HTTPS 주소를 입력하세요.");
const optionalUrl = z.union([httpsUrl, z.literal(""), z.null()]).optional()
  .transform((value) => value || null);
const nullableId = z.union([z.uuid(), z.literal(""), z.null()]).optional()
  .transform((value) => value || null);
const datetime = z.union([z.iso.datetime({ offset: true }), z.literal(""), z.null()]).optional()
  .transform((value) => value || null);

export const channelSchema = z.object({
  platform: z.enum(SOCIAL_PLATFORMS),
  name: z.string().trim().min(1).max(120),
  handle: z.string().trim().max(200).default(""),
  url: httpsUrl,
}).strict();

const contentShape = {
  platform: z.enum(SOCIAL_PLATFORMS),
  channelId: nullableId,
  title: z.string().trim().min(1).max(300),
  body: z.string().max(30000),
  status: z.enum(CONTENT_STATUSES),
  scheduledAt: datetime,
  url: optionalUrl,
};

export const contentSchema = z.object(contentShape).strict().superRefine((data, ctx) => {
  if (data.status === "scheduled" && !data.scheduledAt) {
    ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "예약 관리에는 시간을 입력하세요." });
  }
  if (data.status === "published" && !data.url) {
    ctx.addIssue({ code: "custom", path: ["url"], message: "게시 완료 기록에는 게시물 URL이 필요합니다." });
  }
});

export const contentPatchSchema = z.object(contentShape).partial().strict().refine(
  (value) => Object.keys(value).length > 0, "변경할 필드가 필요합니다.",
);
export const refreshSchema = z.object({ keyword: z.string().trim().min(1).max(100).optional() }).strict();
export const recordIdSchema = z.uuid();
