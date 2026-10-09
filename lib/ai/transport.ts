import { AiError } from "./types";

export async function boundedJson(response: Response, maxBytes = 262144): Promise<unknown> {
  const advertised = Number(response.headers.get("content-length"));
  if (advertised > maxBytes) {
    await response.body?.cancel();
    throw new AiError("PROVIDER_RESPONSE_INVALID", "AI 제공자의 응답이 허용 크기를 초과했습니다.", 502);
  }
  if (!response.body) throw new AiError("PROVIDER_RESPONSE_INVALID", "AI 제공자의 응답이 비어 있습니다.", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new AiError("PROVIDER_RESPONSE_INVALID", "AI 제공자의 응답이 허용 크기를 초과했습니다.", 502);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch {
      throw new AiError("PROVIDER_RESPONSE_INVALID", "AI 제공자가 올바른 JSON 응답을 반환하지 않았습니다.", 502);
    }
  } finally { reader.releaseLock(); }
}

export async function gatewayFetch(
  fetcher: typeof fetch, url: string, apiKey: string | undefined, timeoutMs: number,
  init: RequestInit = {},
): Promise<unknown> {
  try {
    const response = await fetcher(url, {
      ...init,
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...init.headers },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new AiError("PROVIDER_AUTH_REQUIRED", "로컬 AI 게이트웨이 인증을 확인해 주세요.", 503);
      }
      if (response.status === 429) throw new AiError("PROVIDER_RATE_LIMITED", "AI 제공자의 사용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.", 429);
      throw new AiError("PROVIDER_UNAVAILABLE", "AI 제공자가 요청을 처리하지 못했습니다. 로컬 게이트웨이 상태를 확인해 주세요.", 503);
    }
    return await boundedJson(response);
  } catch (error) {
    if (error instanceof AiError) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new AiError("PROVIDER_TIMEOUT", "AI 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.", 504);
    }
    throw new AiError("PROVIDER_UNREACHABLE", "로컬 AI 게이트웨이에 연결할 수 없습니다. 실행 상태를 확인해 주세요.");
  }
}
