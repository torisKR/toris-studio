const MAX_BYTES = 32 * 1024 * 1024;
const extensions = new Set(["png", "jpg", "jpeg", "webp", "ico", "glb", "obj", "stl"]);
export function isTrustedFileUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    const hostname = url.hostname.toLowerCase();
    const additional = (process.env.TORIS_ASSET_FILE_HOSTS ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname.includes(":") || /^\d+(\.\d+){3}$/.test(hostname)) return false;
    return hostname === "oaiusercontent.com" || hostname.endsWith(".oaiusercontent.com") || additional.includes(hostname);
  } catch { return false; }
}
export async function downloadAssetFile(raw: string, fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<Buffer> {
  if (!isTrustedFileUrl(raw)) throw new Error("승인된 ChatGPT HTTPS 파일 주소만 받습니다. 다른 호스트는 로컬 관리자가 TORIS_ASSET_FILE_HOSTS에 정확한 호스트명을 등록해야 합니다.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetcher(raw, { redirect: "error", signal: controller.signal, headers: { Accept: "application/octet-stream,image/*,model/*" } });
    if (!response.ok || !response.body) throw new Error("파일 다운로드를 완료하지 못했습니다. 새 파일 참조로 다시 시도하세요.");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_BYTES) { await response.body.cancel(); throw new Error("파일은 32 MiB 이하여야 합니다."); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error("파일은 32 MiB 이하여야 합니다."); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!size) throw new Error("다운로드한 파일이 비어 있습니다.");
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof Error && /32 MiB|비어|다운로드/.test(error.message)) throw error;
    // Signed URLs and HTTP response bodies must not leak into logs or tool errors.
    throw new Error("파일 다운로드가 실패했습니다. 리디렉션 없는 새 ChatGPT 파일 참조로 다시 시도하세요.");
  } finally { clearTimeout(timer); }
}
export function inferFilename(file: { file_name?: string }, bytes: Buffer): string {
  const name = file.file_name;
  if (name) {
    if (/[\\/\u0000-\u001f]/.test(name) || name.length > 250) throw new Error("안전한 파일명을 지정하세요.");
    const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
    if (extensions.has(extension)) return name;
  }
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "chatgpt-image.png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "chatgpt-image.jpg";
  if (bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP") return "chatgpt-image.webp";
  if (bytes.length >= 6 && bytes.subarray(0,4).equals(Buffer.from([0,0,1,0]))) return "chatgpt-icon.ico";
  if (bytes.toString("ascii",0,4) === "glTF") return "chatgpt-model.glb";
  throw new Error("파일 형식을 확인하세요. OBJ·STL은 확장자가 포함된 file_name 또는 filename을 지정하세요.");
}
