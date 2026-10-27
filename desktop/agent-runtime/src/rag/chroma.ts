import { UserError, withTimeout } from "../util.js";

const REQUEST_TIMEOUT_MS = 120_000;
const BASE_PATH = "/api/v2/tenants/default_tenant/databases/default_database";

/** Minimal client for the Chroma v2 REST API; only a loopback server is accepted. */
export class ChromaClient {
  private origin: string;
  constructor(raw: string) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new UserError("ChromaDB 주소를 확인하세요."); }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password) {
      throw new UserError("ChromaDB는 이 컴퓨터의 http://127.0.0.1 주소만 사용할 수 있습니다.");
    }
    this.origin = url.origin;
  }

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const { status, ok, raw } = await withTimeout(REQUEST_TIMEOUT_MS, undefined, async signal => {
      let response: globalThis.Response;
      try {
        response = await fetch(`${this.origin}${route}`, {
          method,
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
          redirect: "error",
        });
      } catch {
        throw new UserError("ChromaDB에 연결하지 못했습니다. Agent 탭에서 벡터 DB 컨테이너를 실행하세요.");
      }
      return { status: response.status, ok: response.ok, raw: await response.text() };
    });
    if (!ok) throw new UserError(`ChromaDB 요청 실패 (${status}): ${raw.slice(0, 200)}`);
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  async heartbeat(): Promise<boolean> {
    try { await this.call("GET", "/api/v2/heartbeat"); return true; } catch { return false; }
  }
  async getOrCreate(name: string, metadata: Record<string, string | number>): Promise<{ id: string; metadata: Record<string, unknown> | null }> {
    return this.call("POST", `${BASE_PATH}/collections`, { name, get_or_create: true, metadata: { "hnsw:space": "cosine", ...metadata } });
  }
  async find(name: string): Promise<{ id: string; metadata: Record<string, unknown> | null } | null> {
    try { return await this.call("GET", `${BASE_PATH}/collections/${encodeURIComponent(name)}`); } catch { return null; }
  }
  async drop(name: string): Promise<void> {
    await this.call("DELETE", `${BASE_PATH}/collections/${encodeURIComponent(name)}`);
  }
  async upsert(id: string, rows: { ids: string[]; embeddings: number[][]; documents: string[]; metadatas: Array<Record<string, string | number>> }): Promise<void> {
    if (rows.ids.length) await this.call("POST", `${BASE_PATH}/collections/${id}/upsert`, rows);
  }
  async deleteWhere(id: string, where: Record<string, unknown>): Promise<void> {
    await this.call("POST", `${BASE_PATH}/collections/${id}/delete`, { where });
  }
  async metadatas(id: string, limit: number, offset: number): Promise<Array<Record<string, unknown>>> {
    const value = await this.call<{ metadatas: Array<Record<string, unknown>> }>("POST", `${BASE_PATH}/collections/${id}/get`, { include: ["metadatas"], limit, offset });
    return value.metadatas ?? [];
  }
  async count(id: string): Promise<number> {
    return this.call<number>("GET", `${BASE_PATH}/collections/${id}/count`);
  }
  async query(id: string, embedding: number[], n: number): Promise<Array<{ document: string; metadata: Record<string, unknown>; distance: number }>> {
    const value = await this.call<{ documents: string[][]; metadatas: Array<Array<Record<string, unknown>>>; distances: number[][] }>(
      "POST", `${BASE_PATH}/collections/${id}/query`, { query_embeddings: [embedding], n_results: n, include: ["documents", "metadatas", "distances"] },
    );
    return (value.documents?.[0] ?? []).map((document, i) => ({ document, metadata: value.metadatas?.[0]?.[i] ?? {}, distance: value.distances?.[0]?.[i] ?? 1 }));
  }
}
