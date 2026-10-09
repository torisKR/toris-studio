import { z } from "zod";
import { AI_PLATFORMS, AiError, type DraftInput } from "./types";

const draftSchema = z.object({
  provider: z.enum(["opencodex", "teamclaude", "claude-cli"]).optional(),
  platform: z.enum(AI_PLATFORMS),
  topic: z.string().trim().min(1).max(600),
  context: z.string().trim().max(6000).optional(),
  model: z.string().trim().min(1).max(160).optional(),
}).strict();

export async function readDraftRequest(request: Request): Promise<DraftInput> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AiError("INVALID_CONTENT_TYPE", "JSON 형식으로 요청해 주세요.", 415);
  }
  const maxBytes = 24576;
  if (Number(request.headers.get("content-length")) > maxBytes) throw new AiError("REQUEST_TOO_LARGE", "AI 요청 크기가 제한을 초과했습니다.", 413);
  if (!request.body) throw new AiError("INVALID_REQUEST", "AI 초안 주제를 입력해 주세요.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const deadline = Date.now() + 5000;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AiError("REQUEST_TIMEOUT", "AI 요청 수신 시간이 초과되었습니다.", 408)), Math.max(1, deadline - Date.now()));
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await Promise.race([reader.read(), timeout]); } finally { clearTimeout(timer); }
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) throw new AiError("REQUEST_TOO_LARGE", "AI 요청 크기가 제한을 초과했습니다.", 413);
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AiError("INVALID_REQUEST", "올바른 JSON 요청이 필요합니다.", 400); }
    const parsed = draftSchema.safeParse(body);
    if (!parsed.success) throw new AiError("INVALID_REQUEST", "플랫폼, 주제(1~600자), 참고자료(6000자 이하)를 확인해 주세요.", 400);
    return parsed.data;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export function aiErrorResponse(error: unknown): Response {
  if (error instanceof Response) return error;
  if (error instanceof AiError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  return Response.json({ error: "AI 요청 처리에 실패했습니다. 로컬 제공자 상태를 확인해 주세요.", code: "AI_FAILED" }, { status: 500, headers: { "Cache-Control": "no-store" } });
}
