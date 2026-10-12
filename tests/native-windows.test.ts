import assert from "node:assert/strict";
import test from "node:test";
import { createActivityReporter } from "../desktop/src/native-windows";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("native activity serializes writes and keeps the latest StrictMode lifecycle state", async () => {
  const calls: boolean[] = [];
  const pending: Array<() => void> = [];
  const activity = createActivityReporter(active => {
    calls.push(active);
    return new Promise<void>(resolve => pending.push(resolve));
  });
  activity.set(true);
  await settle();
  assert.deepEqual(calls, [true]);
  activity.set(false);
  activity.set(true);
  pending.shift()!();
  await settle();
  assert.deepEqual(calls, [true], "cleanup followed by remount must not publish a stale false");
  activity.set(false);
  await settle();
  assert.deepEqual(calls, [true, false]);
  activity.set(true);
  assert.deepEqual(calls, [true, false], "at most one write may be pending");
  pending.shift()!();
  await settle();
  assert.deepEqual(calls, [true, false, true]);
  pending.shift()!();
  await settle();
});

test("one component cannot clear another activity and release is idempotent", async () => {
  const calls: boolean[] = [];
  const activity = createActivityReporter(async active => { calls.push(active); });
  const first = activity.begin(), second = activity.begin();
  await settle();
  assert.deepEqual(calls, [true]);
  first(); first(); activity.set(false);
  await settle();
  assert.deepEqual(calls, [true]);
  second();
  await settle();
  assert.deepEqual(calls, [true, false]);
  activity.set(true);
  const third = activity.begin();
  await settle();
  third();
  await settle();
  assert.equal(calls.at(-1), true, "aggregate activity survives token release");
  activity.set(false);
  await settle();
  assert.equal(calls.at(-1), false);
});

test("activity registrations are bounded and released registrations are reusable", async () => {
  const calls: boolean[] = [];
  const activity = createActivityReporter(async active => { calls.push(active); });
  const releases = Array.from({ length: 128 }, () => activity.begin());
  const overflow = activity.begin();
  await settle();
  for (const release of releases) release();
  await settle();
  assert.deepEqual(calls, [true, false], "overflow must not retain an unbounded token");
  overflow();
  const next = activity.begin();
  await settle();
  assert.equal(calls.at(-1), true);
  next();
  await settle();
  assert.equal(calls.at(-1), false);
});

test("failed native activity writes do not loop and a future update retries", async () => {
  const calls: boolean[] = [];
  const activity = createActivityReporter(async active => {
    calls.push(active);
    if (calls.length === 1) throw new Error("fixture failure");
  });
  activity.set(true);
  await settle();
  await settle();
  assert.deepEqual(calls, [true]);
  activity.set(true);
  await settle();
  assert.deepEqual(calls, [true, true]);
  activity.set(false);
  await settle();
  assert.deepEqual(calls, [true, true, false]);
});
