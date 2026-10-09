import { ZodError } from "zod";
import { SocialRecordError } from "./repository";

export async function readSocialJson(request: Request): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    throw Response.json({ code: "INVALID_CONTENT_TYPE", error: "JSON 요청이 필요합니다." }, { status: 415 });
  }
  const maxBytes = 128 * 1024;
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    throw Response.json({ code: "PAYLOAD_TOO_LARGE", error: "요청이 너무 큽니다." }, { status: 413 });
  }
  const reader = request.body?.getReader();
  if (!reader) throw Response.json({ code: "INVALID_JSON", error: "요청 본문이 필요합니다." }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw Response.json({ code: "PAYLOAD_TOO_LARGE", error: "요청이 너무 큽니다." }, { status: 413 });
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Response.json({ code: "INVALID_JSON", error: "올바른 JSON이 필요합니다." }, { status: 400 }); }
}

export function socialJson(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
export function socialError(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof ZodError) return socialJson({ code: "INVALID_INPUT", error: error.issues[0]?.message ?? "입력값을 확인하세요." }, 400);
  if (error instanceof SocialRecordError) return socialJson({ code: error.code, error: error.message }, error.code === "NOT_FOUND" ? 404 : 409);
  if (error instanceof Error && "code" in error && error.code === "REFRESH_THROTTLED") {
    return Response.json({ code: error.code, error: error.message }, { status: 429,
      headers: { "Retry-After": "30", "Cache-Control": "no-store" } });
  }
  console.error(JSON.stringify({ event: "social.api.error", code: "DATABASE_UNAVAILABLE" }));
  return socialJson({ code: "DATABASE_UNAVAILABLE", error: "로컬 DB 작업에 실패했습니다. DB 상태를 확인하고 다시 시도하세요." }, 503);
}
