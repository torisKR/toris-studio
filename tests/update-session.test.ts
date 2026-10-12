import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { createUpdateSession, type UpdateStatus } from "../desktop/src/update-session";

const status = (revision: number, phase: UpdateStatus["phase"] = "downloading"): UpdateStatus => ({
  revision, phase, configured: true, currentVersion: "0.1.21", availableVersion: "0.2.0", notes: null,
  publishedAt: null, downloadedBytes: revision * 10, totalBytes: 100, message: "synthetic status", canCancel: phase === "downloading",
});

function harness(subscribe: (receive: (value: UpdateStatus) => void) => Promise<() => void>, read: () => Promise<UpdateStatus>) {
  const observed: UpdateStatus[] = [];
  let errors = 0, ready = 0;
  const connections: boolean[] = [];
  const session = createUpdateSession({ subscribe, read, onStatus: value => observed.push(value), onReadError: () => errors++,
    onReady: () => ready++, onConnected: value => connections.push(value) });
  return { session, observed, connections, errors: () => errors, ready: () => ready };
}

test("bootstrap subscribes before snapshot and late registration is immediately released after unmount", async () => {
  const registration = Promise.withResolvers<() => void>();
  let reads = 0, releases = 0;
  let receive!: (value: UpdateStatus) => void;
  const view = harness(handler => { receive = handler; return registration.promise; }, async () => { reads++; return status(1); });
  assert.equal(reads, 0);
  view.session.dispose();
  receive(status(3));
  registration.resolve(() => releases++);
  await view.session.ready;
  view.session.dispose();
  assert.equal(releases, 1);
  assert.equal(reads, 0);
  assert.deepEqual(view.observed, []);
  assert.deepEqual(view.connections, []);
});

test("events and action results cannot regress the authoritative native revision", async () => {
  const snapshot = Promise.withResolvers<UpdateStatus>();
  const view = harness(async () => () => {}, () => snapshot.promise);
  await Promise.resolve();
  view.session.receive(status(8, "ready"));
  snapshot.resolve(status(5));
  await view.session.ready;
  view.session.receive(status(7));
  view.session.receive(status(8, "ready"));
  view.session.receive(status(9, "installing"));
  assert.deepEqual(view.observed.map(value => [value.revision, value.phase]), [[8, "ready"], [9, "installing"]]);
  view.session.dispose();
});

test("slow status reads remain single-flight and complete without retaining the read lock", async () => {
  let reads = 0;
  const pending = Promise.withResolvers<UpdateStatus>();
  const view = harness(async () => () => {}, () => { reads++; return reads === 1 ? pending.promise : Promise.resolve(status(2)); });
  await Promise.resolve();
  await Promise.all([view.session.refresh(), view.session.refresh(), view.session.refresh()]);
  assert.equal(reads, 1);
  pending.resolve(status(1));
  await view.session.ready;
  await view.session.refresh();
  assert.equal(reads, 2);
  assert.deepEqual(view.observed.map(value => value.revision), [1, 2]);
  view.session.dispose();
});

test("a disposed old view cannot update a replacement view or settle its bootstrap", async () => {
  const pending = Promise.withResolvers<UpdateStatus>();
  const old = harness(async () => () => {}, () => pending.promise);
  await Promise.resolve();
  old.session.dispose();
  const next = harness(async () => () => {}, async () => status(3, "available"));
  await next.session.ready;
  pending.resolve(status(1));
  await old.session.ready;
  assert.equal(old.ready(), 0);
  assert.deepEqual(old.observed, []);
  assert.deepEqual(next.observed.map(value => value.phase), ["available"]);
  next.session.dispose();
});

test("failed subscription falls back to reads; failed reads allow a user retry", async () => {
  let reads = 0;
  const view = harness(async () => { throw new Error("synthetic listener failure"); }, async () => {
    if (++reads === 1) throw new Error("synthetic read failure");
    return status(1, "available");
  });
  await view.session.ready;
  assert.deepEqual(view.connections, [false]);
  assert.equal(view.errors(), 1);
  assert.equal(view.ready(), 1);
  await view.session.refresh();
  assert.equal(reads, 2);
  assert.equal(view.observed[0].phase, "available");
  view.session.dispose();
});

test("a late failed read cannot replace newer progress with a stale error", async () => {
  const pending = Promise.withResolvers<UpdateStatus>();
  const view = harness(async () => () => {}, () => pending.promise);
  await Promise.resolve();
  view.session.receive(status(4));
  pending.reject(new Error("late synthetic failure"));
  await view.session.ready;
  assert.equal(view.errors(), 0);
  assert.equal(view.observed[0].revision, 4);
  view.session.dispose();
});

test("actual updater panel exposes bootstrap loading without calling native services", async () => {
  const hooks = registerHooks({ load(url, context, nextLoad) {
    return new URL(url).pathname.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : nextLoad(url, context);
  } });
  try {
    const { UpdatePanel } = await tsImport("../desktop/src/UpdatePanel.tsx", { parentURL: import.meta.url, tsconfig: new URL("../desktop/tsconfig.json", import.meta.url).pathname });
    const markup = renderToStaticMarkup(createElement(UpdatePanel));
    assert.match(markup, /aria-busy="true"/);
    assert.match(markup, /업데이트 상태 확인 중/);
    assert.match(markup, /공식 GitHub 릴리스/);
    assert.match(markup, /disabled=""/);
  } finally { hooks.deregister(); }
});
