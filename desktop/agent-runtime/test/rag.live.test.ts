import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ChromaClient } from "../src/rag/chroma.js";
import { ProjectIndex, collectionName } from "../src/rag/index.js";
import { parseSettings } from "../src/runtime.js";
import { realpathSync } from "node:fs";

const CHROMA = process.env.TORIS_TEST_CHROMA_URL ?? "http://127.0.0.1:18765";

test("indexing is per project, incremental, and search never crosses projects", async t => {
  const client = new ChromaClient(CHROMA);
  if (!await client.heartbeat()) return t.skip(`ChromaDB not reachable at ${CHROMA}`);
  const root = mkdtempSync(path.join(tmpdir(), "agent-rag-"));
  for (const [name, body] of [["shop", "export function calculateCartTotal(items) { return items.reduce((s, i) => s + i.price, 0) }"], ["blog", "export function renderMarkdownPost(post) { return marked(post.body) }"]]) {
    mkdirSync(path.join(root, name, "src"), { recursive: true });
    writeFileSync(path.join(root, name, "src/main.ts"), body);
    writeFileSync(path.join(root, name, "README.md"), `# ${name}`);
  }
  const index = new ProjectIndex(parseSettings({ projectsRoot: root, chromaUrl: CHROMA }));
  try {
    const first = await index.build("shop", () => {});
    assert.equal(first.files, 2);
    assert.equal(first.changedFiles, 2);
    await index.build("blog", () => {});
    const again = await index.build("shop", () => {});
    assert.equal(again.changedFiles, 0, "unchanged files are not re-embedded");
    writeFileSync(path.join(root, "shop", "src/main.ts"), "export function applyCoupon(code) { return code }");
    assert.equal((await index.build("shop", () => {})).changedFiles, 1);
    const shopHits = await index.search("shop", "applyCoupon", 5);
    assert.ok(shopHits.every(hit => !hit.text.includes("renderMarkdownPost")));
    assert.equal(shopHits[0].path, "src/main.ts");
    assert.ok(shopHits.every(hit => !hit.text.includes("calculateCartTotal")), "replaced content was removed");
    const blogHits = await index.search("blog", "renderMarkdownPost", 5);
    assert.ok(blogHits.every(hit => !hit.text.includes("applyCoupon")));
    assert.equal((await index.status("shop")).indexed, true);
    const before = (await index.status("shop")).chunks;
    rmSync(path.join(root, "shop", "README.md"));
    await index.build("shop", () => {});
    assert.equal((await index.status("shop")).chunks, before - 1, "a deleted file's chunks are removed");
    assert.ok((await index.search("shop", "shop", 5)).every(hit => hit.path !== "README.md"));
  } finally {
    for (const name of ["shop", "blog"]) await client.drop(collectionName(realpathSync(path.join(root, name)))).catch(() => {});
  }
});
