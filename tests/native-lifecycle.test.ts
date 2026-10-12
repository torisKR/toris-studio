import assert from "node:assert/strict";
import test from "node:test";
import { createDisposalScope, createPanelReadGate } from "../desktop/src/native-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test("a native listener registered after unmount is immediately unregistered exactly once", async () => {
  const registration = deferred<() => void>();
  const scope = createDisposalScope();
  let calls = 0;
  const waiting = registration.promise.then(scope.add);
  scope.dispose();
  registration.resolve(() => { ++calls; });
  const release = await waiting;
  release(); scope.dispose();
  assert.equal(calls, 1);
  assert.equal(scope.active(), false);
});

test("disposal invalidates callbacks first and releases in reverse order even if one fails", () => {
  const scope = createDisposalScope();
  const calls: string[] = [];
  scope.add(() => { assert.equal(scope.active(), false); calls.push("renderer"); });
  scope.add(() => { calls.push("listener"); throw new Error("native window gone"); });
  scope.add(() => { calls.push("observer"); });
  scope.dispose(); scope.dispose();
  assert.deepEqual(calls, ["observer", "listener", "renderer"]);
});

test("a manually released resource is not released again on teardown", () => {
  const scope = createDisposalScope();
  let calls = 0;
  const release = scope.add(() => { ++calls; });
  release(); release(); scope.dispose();
  assert.equal(calls, 1);
});

test("async Tauri unlisten failures are consumed during both ordinary and late disposal", async () => {
  const scope = createDisposalScope();
  let calls = 0;
  const unlisten = async () => { ++calls; throw new Error("native unregister rejected"); };
  scope.add(unlisten);
  scope.dispose();
  scope.add(unlisten);
  // The Node test runner also treats an unhandled rejection as a test failure.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
});

test("owned polling stops immediately when the panel scope closes", context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const scope = createDisposalScope();
  let calls = 0;
  const timer = setInterval(() => { ++calls; }, 5000);
  scope.add(() => clearInterval(timer));
  context.mock.timers.tick(5000);
  assert.equal(calls, 1);
  scope.dispose();
  context.mock.timers.tick(20000);
  assert.equal(calls, 1);
});

test("single-flight reads skip hidden panels and reopen without the old read holding a lock", () => {
  const gate = createPanelReadGate();
  assert.equal(gate.begin(), null);
  gate.activate();
  const old = gate.begin()!;
  assert.equal(gate.begin(), null);
  gate.deactivate();
  assert.equal(old.current(), false);
  assert.equal(gate.begin(), null);
  gate.activate();
  const fresh = gate.begin()!;
  assert.equal(fresh.current(), true);
  old.finish();
  assert.equal(gate.begin(), null, "old finally must not unlock the reopened panel's read");
  fresh.finish();
  assert.ok(gate.begin());
});

test("a delayed publication read cannot start its second IPC request after hiding", async () => {
  const gate = createPanelReadGate();
  const first = deferred<string>();
  let secondCalls = 0;
  let displayed = "";
  gate.activate();
  const load = (async () => {
    const request = gate.begin()!;
    try {
      const snapshot = await first.promise;
      if (!request.current()) return;
      displayed = snapshot;
      ++secondCalls;
    } finally { request.finish(); }
  })();
  gate.deactivate();
  first.resolve("old snapshot");
  await load;
  assert.equal(displayed, "");
  assert.equal(secondCalls, 0);
});

test("an old integration response cannot replace a new activation's response", async () => {
  const gate = createPanelReadGate();
  const slow = deferred<string>();
  let displayed = "";
  gate.activate();
  const old = gate.begin()!;
  const reading = slow.promise.then(value => { if (old.current()) displayed = value; }).finally(old.finish);
  gate.deactivate(); gate.activate();
  const current = gate.begin()!;
  if (current.current()) displayed = "new account status";
  current.finish();
  slow.resolve("old account status");
  await reading;
  assert.equal(displayed, "new account status");
});
