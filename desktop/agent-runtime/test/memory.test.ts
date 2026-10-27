import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { requestJson } from "../src/llm/http.js";
import { ChromaClient } from "../src/rag/chroma.js";
import { runCommand } from "../src/tools/terminal.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/**
 * LangGraph runs every node inside an async context. A timer created in that
 * context keeps the whole run (graph, model, file list) alive until it fires,
 * so a request must not leave its timeout timer behind after it finishes.
 */
async function contextIsFreedAfter(call: () => Promise<unknown>): Promise<boolean> {
  const storage = new AsyncLocalStorage<{ payload: string }>();
  let ref!: WeakRef<object>;
  await (async () => {
    const store = { payload: "run".repeat(100_000) };
    ref = new WeakRef(store);
    await storage.run(store, call);
  })();
  for (let i = 0; i < 10; i++) { gc(); await new Promise(resolve => setTimeout(resolve, 5)); }
  return ref.deref() === undefined;
}

test("finished ChromaDB and model requests do not keep the run's context alive", async t => {
  // Only this module's own timers are measured; a real socket pool adds its own.
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  const url = "http://127.0.0.1:18765";
  assert.equal(await contextIsFreedAfter(() => new ChromaClient(url).heartbeat()), true, "ChromaDB request");
  assert.equal(await contextIsFreedAfter(() => requestJson({ url, headers: {} }, { method: "GET" }, [])), true, "model request");
  const run = new AbortController();
  assert.equal(await contextIsFreedAfter(() => requestJson({ url, headers: {} }, { method: "GET" }, [], run.signal)), true, "model request with a run signal");
});

test("a command that fails to start leaves no listener on the run's signal", async () => {
  const run = new AbortController();
  await assert.rejects(runCommand(["toris-no-such-binary"], tmpdir(), [], [], run.signal), /실행하지 못했습니다/);
  assert.equal(getEventListeners(run.signal, "abort").length, 0);
  await runCommand([process.execPath, "-e", "0"], tmpdir(), [], [], run.signal);
  assert.equal(getEventListeners(run.signal, "abort").length, 0, "a finished command also cleans up");
});

test("a model request still stops when the run is cancelled", async t => {
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  const run = new AbortController();
  const pending = requestJson({ url: "http://127.0.0.1:1", headers: {} }, { method: "GET" }, [], run.signal);
  run.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
