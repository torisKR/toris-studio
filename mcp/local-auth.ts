import { createHash, timingSafeEqual } from "node:crypto";
export function validateMcpBinding(host: string, token: string | undefined): void {
  const local = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!local && (!token || token.length < 32)) throw new Error("외부 MCP 바인딩에는 32자 이상의 MCP_AUTH_TOKEN이 필요합니다. 기본 127.0.0.1 바인딩 또는 인증된 로컬 터널을 사용하세요.");
  if (token && token.length < 32) throw new Error("MCP_AUTH_TOKEN은 32자 이상이어야 합니다.");
}
export function validMcpToken(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return timingSafeEqual(createHash("sha256").update(header.slice(7)).digest(), createHash("sha256").update(token).digest());
}
