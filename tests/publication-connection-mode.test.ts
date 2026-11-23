import assert from "node:assert/strict";
import test from "node:test";
import { connectionMode, torisNote } from "../desktop/src/sns/SnsConnections";

const view = (available: Record<string, boolean>, clients: Record<string, { mode: string | null }> = {}) => ({ available, naverSearch: false, clients });

test("connection mode: own app if saved, else Toris 연결 when the broker serves the platform, else own app", () => {
  assert.deepEqual(connectionMode(null, "tiktok"), { offer: false, mode: "developer", stored: null }, "no broker answer: developer form only");
  assert.equal(connectionMode(view({ tiktok: true }), "tiktok").mode, "toris");
  assert.equal(connectionMode(view({ tiktok: true }, { tiktok: { mode: "developer" } }), "tiktok").mode, "developer", "a saved own app wins");
  assert.equal(connectionMode(view({ tiktok: false }, { tiktok: { mode: "toris" } }), "tiktok").offer, false, "a Toris record with the broker down offers nothing new");
  assert.equal(connectionMode(view({ youtube: true }), "youtube").mode, "toris", "Google is a Toris platform when the broker serves it");
  assert.equal(connectionMode(view({ youtube: false }, { youtube: { mode: null } }), "youtube").offer, false, "no built-in Google client without the broker");
});

test("Toris 연결 note: Google warns about the unverified-app screen, the search key and shared revocation", () => {
  const google = torisNote("youtube");
  assert.ok(google.includes("확인되지 않은 앱 경고가 나올 수 있습니다"), google);
  assert.ok(google.includes("YouTube Data API 키"), google);
  assert.ok(google.includes("Google Calendar 권한도 함께 철회"), google);
  assert.ok(!torisNote("tiktok").includes("확인되지 않은 앱"), "only Google shows its unverified-app screen");
  assert.ok(torisNote("tiktok").includes("클라이언트 비밀 값은 입력하지 않습니다"));
});
