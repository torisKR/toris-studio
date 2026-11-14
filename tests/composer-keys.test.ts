import assert from "node:assert/strict";
import test from "node:test";
import { IME_KEY_CODE, isSendEnter, type ComposerKey } from "../desktop/src/projects/composer-keys";

const enter = (over: Partial<ComposerKey> = {}): ComposerKey => ({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...over });

/** Replays an event sequence through the same rule the composer uses and counts sends. */
function sends(sequence: Array<{ type: "compositionstart" | "compositionend" } | { type: "keydown"; key: ComposerKey }>) {
  let count = 0;
  for (const event of sequence) if (event.type === "keydown" && isSendEnter(event.key)) count++;
  return count;
}

test("a plain Enter sends; Shift+Enter and other keys do not", () => {
  assert.equal(isSendEnter(enter()), true);
  assert.equal(isSendEnter(enter({ shiftKey: true })), false);
  assert.equal(isSendEnter(enter({ key: "a", keyCode: 65 })), false);
  assert.equal(isSendEnter(enter({ key: "Process", keyCode: IME_KEY_CODE })), false);
});

test("Enter while composing does not send (Chromium order: keydown before compositionend)", () => {
  assert.equal(isSendEnter(enter({ isComposing: true, keyCode: IME_KEY_CODE })), false);
  assert.equal(isSendEnter(enter({ isComposing: true })), false);
  assert.equal(sends([
    { type: "compositionstart" },
    { type: "keydown", key: enter({ isComposing: true, keyCode: IME_KEY_CODE }) },
    { type: "compositionend" }
  ]), 0);
});

test("the IME's confirming Enter after compositionend does not send (WebKit order, keyCode 229)", () => {
  assert.equal(isSendEnter(enter({ isComposing: false, keyCode: IME_KEY_CODE })), false);
  assert.equal(sends([
    { type: "compositionstart" },
    { type: "compositionend" },
    { type: "keydown", key: enter({ keyCode: IME_KEY_CODE }) }
  ]), 0);
});

test("after the composition ends, a separate Enter sends exactly once in either order", () => {
  for (const confirming of [enter({ isComposing: true, keyCode: IME_KEY_CODE }), enter({ keyCode: IME_KEY_CODE })]) {
    assert.equal(sends([
      { type: "compositionstart" },
      ...(confirming.isComposing ? [{ type: "keydown" as const, key: confirming }, { type: "compositionend" as const }] : [{ type: "compositionend" as const }, { type: "keydown" as const, key: confirming }]),
      { type: "keydown", key: enter() }
    ]), 1);
  }
});

test("Shift+Enter during or after a composition only adds a line", () => {
  assert.equal(sends([
    { type: "compositionstart" },
    { type: "keydown", key: enter({ shiftKey: true, isComposing: true, keyCode: IME_KEY_CODE }) },
    { type: "compositionend" },
    { type: "keydown", key: enter({ shiftKey: true }) }
  ]), 0);
});

test("no time-based blocking: an Enter right after compositionend that the IME did not use still sends", () => {
  assert.equal(sends([{ type: "compositionstart" }, { type: "compositionend" }, { type: "keydown", key: enter() }]), 1);
});
