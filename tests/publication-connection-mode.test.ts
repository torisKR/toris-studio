import assert from "node:assert/strict";
import test from "node:test";
import { connectionMode } from "../desktop/src/sns/SnsConnections";

const view = (available: Record<string, boolean>, clients: Record<string, { mode: string | null; builtinAvailable: boolean }> = {}) => ({ available, naverSearch: false, clients });

test("connection mode: own app if saved, else Toris (broker or built-in Google), else own app", () => {
  assert.deepEqual(connectionMode(null, "tiktok"), { offer: false, mode: "developer", stored: null }, "no broker answer: developer form only");
  assert.equal(connectionMode(view({ tiktok: true }), "tiktok").mode, "toris");
  assert.equal(connectionMode(view({ tiktok: true }, { tiktok: { mode: "developer", builtinAvailable: false } }), "tiktok").mode, "developer", "a saved own app wins");
  assert.equal(connectionMode(view({ tiktok: false }, { tiktok: { mode: "toris", builtinAvailable: false } }), "tiktok").offer, false, "a Toris record with the broker down offers nothing new");
  assert.equal(connectionMode(view({}, { youtube: { mode: null, builtinAvailable: true } }), "youtube").mode, "google_builtin");
  assert.equal(connectionMode(view({}, { youtube: { mode: null, builtinAvailable: false } }), "youtube").offer, false);
});
