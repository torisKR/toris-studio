import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { projectDir } from "../projects.js";
import type { RuntimeSettings } from "../protocol.js";
import { projectFiles } from "../tools/fs.js";
import { UserError, sha1 } from "../util.js";
import { ChromaClient } from "./chroma.js";
import { createEmbedder, type Embedder } from "./embed.js";

const TEXT_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro", "rs", "go", "py", "rb", "java", "kt", "kts", "swift", "dart", "gd", "cs", "c", "h", "cpp", "hpp",
  "sql", "prisma", "graphql", "gql", "proto", "css", "scss", "html", "md", "mdx", "json", "toml", "yaml", "yml", "sh", "ps1",
]);
const SKIP_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|.*\.min\.(js|css)|.*\.map)$/;
const MAX_FILE_BYTES = 200 * 1024;
const CHUNK_LINES = 60;
const OVERLAP = 10;
const BATCH = 64;
const MAX_CHUNKS = 40_000;

export type Chunk = { id: string; path: string; startLine: number; endLine: number; text: string };

export function chunkFile(rel: string, content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - OVERLAP) {
    const body = lines.slice(start, start + CHUNK_LINES).join("\n");
    if (body.trim()) chunks.push({ id: sha1(`${rel}:${start + 1}`), path: rel, startLine: start + 1, endLine: Math.min(lines.length, start + CHUNK_LINES), text: `// ${rel}:${start + 1}\n${body}` });
    if (start + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

/** One collection per real project path, so two projects can never share results. */
export function collectionName(realProjectPath: string): string {
  return `toris_proj_${sha1(realProjectPath).slice(0, 24)}`;
}

export type IndexProgress = (phase: "scanning" | "embedding" | "done", done: number, total: number, message: string) => void;

export class ProjectIndex {
  constructor(private settings: RuntimeSettings) {}
  private client() { return new ChromaClient(this.settings.chromaUrl); }

  private async collection(project: string, embedder: Embedder, create: boolean) {
    const dir = realpathSync(projectDir(this.settings.projectsRoot, project));
    const name = collectionName(dir);
    const client = this.client();
    let existing = await client.find(name);
    if (existing && existing.metadata?.embedder !== embedder.id) {
      if (!create) return { client, dir, id: null as string | null, stale: true };
      await client.drop(name);
      existing = null;
    }
    if (!existing && !create) return { client, dir, id: null as string | null, stale: false };
    const created = existing ?? await client.getOrCreate(name, { project, path: dir, embedder: embedder.id });
    return { client, dir, id: created.id, stale: false };
  }

  async status(project: string): Promise<{ indexed: boolean; chunks: number; stale: boolean; embedder: string; chroma: boolean }> {
    const embedder = createEmbedder(this.settings);
    const client = this.client();
    if (!await client.heartbeat()) return { indexed: false, chunks: 0, stale: false, embedder: embedder.id, chroma: false };
    const { id, stale } = await this.collection(project, embedder, false);
    return { indexed: Boolean(id), chunks: id ? await client.count(id) : 0, stale, embedder: embedder.id, chroma: true };
  }

  /** Incremental: unchanged files (same content hash) are skipped; removed files are deleted. */
  async build(project: string, progress: IndexProgress, signal?: AbortSignal): Promise<{ files: number; chunks: number; changedFiles: number }> {
    const embedder = createEmbedder(this.settings);
    const { client, dir, id } = await this.collection(project, embedder, true);
    if (!id) throw new UserError("인덱스 컬렉션을 만들지 못했습니다.");
    progress("scanning", 0, 0, "파일 목록을 확인하고 있습니다.");
    const files = projectFiles(dir).filter(rel => TEXT_EXT.has(path.extname(rel).slice(1).toLowerCase()) && !SKIP_FILE.test(rel));
    const known = new Map<string, string>();
    for (let offset = 0; ; offset += 1000) {
      const page = await client.metadatas(id, 1000, offset);
      for (const meta of page) if (typeof meta.path === "string" && typeof meta.fileHash === "string") known.set(meta.path, meta.fileHash);
      if (page.length < 1000) break;
    }
    const current = new Set<string>();
    const pending: Chunk[] = [];
    const hashes = new Map<string, string>();
    for (const rel of files) {
      const abs = path.join(dir, rel);
      const stat = statSync(abs, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const content = readFileSync(abs, "utf8");
      if (content.includes("\0")) continue;
      current.add(rel);
      const fileHash = sha1(content);
      if (known.get(rel) === fileHash) continue;
      hashes.set(rel, fileHash);
      pending.push(...chunkFile(rel, content));
      if (pending.length > MAX_CHUNKS) throw new UserError(`프로젝트가 너무 큽니다 (청크 ${MAX_CHUNKS}개 초과).`);
    }
    for (const rel of [...known.keys()].filter(rel => !current.has(rel) || hashes.has(rel))) await client.deleteWhere(id, { path: rel });
    for (let i = 0; i < pending.length; i += BATCH) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const batch = pending.slice(i, i + BATCH);
      const embeddings = await embedder.embed(batch.map(c => c.text), signal);
      if (embeddings.length !== batch.length) throw new UserError("임베딩 결과 개수가 맞지 않습니다.");
      await client.upsert(id, {
        ids: batch.map(c => c.id),
        embeddings,
        documents: batch.map(c => c.text),
        metadatas: batch.map(c => ({ path: c.path, startLine: c.startLine, endLine: c.endLine, fileHash: hashes.get(c.path) ?? "" })),
      });
      progress("embedding", Math.min(i + BATCH, pending.length), pending.length, `${Math.min(i + BATCH, pending.length)}/${pending.length} 청크 저장`);
    }
    const chunks = await client.count(id);
    progress("done", pending.length, pending.length, `파일 ${current.size}개 · 청크 ${chunks}개 (변경 ${hashes.size}개 파일)`);
    return { files: current.size, chunks, changedFiles: hashes.size };
  }

  async search(project: string, query: string, k = 8): Promise<Array<{ path: string; startLine: number; endLine: number; score: number; text: string }>> {
    if (!query.trim()) throw new UserError("검색어를 입력하세요.");
    const embedder = createEmbedder(this.settings);
    const { client, id, stale } = await this.collection(project, embedder, false);
    if (stale) throw new UserError("임베딩 설정이 바뀌었습니다. 이 프로젝트를 다시 색인하세요.");
    if (!id) throw new UserError("이 프로젝트는 아직 색인되지 않았습니다. Agent 탭에서 색인을 만드세요.");
    const [vector] = await embedder.embed([query]);
    const rows = await client.query(id, vector, Math.min(20, Math.max(1, k)));
    return rows.map(row => ({
      path: String(row.metadata.path ?? ""), startLine: Number(row.metadata.startLine ?? 0), endLine: Number(row.metadata.endLine ?? 0),
      score: Math.round((1 - row.distance) * 1000) / 1000, text: row.document,
    }));
  }
}
