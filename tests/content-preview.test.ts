import assert from "node:assert/strict";
import test from "node:test";
import { plainPreview } from "../desktop/src/content-preview";

test("content card previews hide Markdown markers but keep the words", () => {
  const body = "**검토용 초안** · Rust 기반 여부\n\n### 제목 후보 3개\n1. Rust 기반 Toris Studio\n- __굵게__ 와 \x60코드\x60\n> 인용";
  assert.equal(plainPreview(body), "검토용 초안 · Rust 기반 여부\n제목 후보 3개\n1. Rust 기반 Toris Studio\n굵게 와 코드\n인용");
});

test("plain text and arithmetic stay untouched", () => {
  assert.equal(plainPreview("2 * 3 = 6, a_b_c"), "2 * 3 = 6, a_b_c");
});

