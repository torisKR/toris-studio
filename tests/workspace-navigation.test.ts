import test from "node:test";
import assert from "node:assert/strict";
import { sectionFor, restoreView, sectionItems, rememberView, MAIN_SECTIONS } from "../desktop/src/workspace-navigation";

test("retired coding and split connection screens restore into the SNS workspace", () => {
  for (const retired of ["coding", "oauth", "integrations", "youtube", "channels", "overview", "invalid"])
    assert.equal(restoreView(retired), "sns");
  assert.equal(restoreView("video"), "video");
  assert.equal(sectionFor("trends"), "content");
  assert.equal(sectionFor("assets"), "creation");
  assert.deepEqual(MAIN_SECTIONS.map(item => item.id), ["sns", "content", "creation", "publications", "operations"]);
  assert.equal(sectionFor("agent"), "creation");
  assert.equal(sectionFor("planner"), "operations");
  assert.equal(sectionFor("ops"), "operations");
  for (const view of ["agent", "planner", "ops"]) assert.equal(restoreView(view), view);
});

test("switching sections restores the last screen without changing another section", () => {
  const memory = rememberView({}, "keywords");
  const updated = rememberView(memory, "video");
  assert.equal(updated.content, "keywords");
  assert.equal(updated.creation, "video");
  assert.equal(sectionItems("creation").length, 4);
  assert.deepEqual(sectionItems("operations").map(item => item.id), ["planner", "ops"]);
});
