import assert from "node:assert/strict";
import { test } from "node:test";

test("daily collection uses 07:00 Korean time and skips an already completed day", async () => {
  const { shouldCollect, koreaDay } = await import("../scripts/trend-worker.mjs");
  const before = new Date("2026-10-07T21:59:59Z");
  const after = new Date("2026-10-07T22:00:00Z");
  assert.equal(koreaDay(after), "2026-10-08");
  assert.equal(shouldCollect(before, ""), false);
  assert.equal(shouldCollect(after, "2026-10-07"), true);
  assert.equal(shouldCollect(after, "2026-10-08"), false);
});
