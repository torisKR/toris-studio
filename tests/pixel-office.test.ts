import assert from "node:assert/strict";
import test from "node:test";
import { DESK_SPOTS, ROLE_LOOK, SCENE, TRAY_SPOT, pixelPaths, walkPlan } from "../desktop/src/pixel-office";
import { LOOKS, PALETTE } from "../desktop/src/pixel-sprites";

test("every sprite frame is a clean grid of known palette colors", () => {
  for (const [name, look] of Object.entries(LOOKS)) {
    for (const [frame, rows] of Object.entries({ stand: look.stand, stride: look.stride })) {
      assert.equal(rows.length, look.stand.length, `${name}.${frame} height`);
      for (const row of rows) {
        assert.equal(row.length, rows[0].length, `${name}.${frame} width: "${row}"`);
        for (const ch of row) assert.ok(ch === "." || ch in PALETTE || ch in look.colors, `${name}.${frame} unknown color "${ch}"`);
      }
    }
    assert.notDeepEqual(look.stand, look.stride, `${name} walks with two different leg frames`);
  }
});

test("each role has its own person: PM and QA are late-30s, the experts are young", () => {
  assert.deepEqual(ROLE_LOOK, { supervisor: "man30s", qa: "woman30s", frontend: "youngWoman", backend: "youngMan" });
  assert.equal(new Set(Object.values(ROLE_LOOK)).size, 4);
  const faces = Object.values(LOOKS).map(l => l.stand.slice(0, 8).join("|"));
  assert.equal(new Set(faces).size, 4, "four different faces and hair");
});

test("pixels become one path per color with horizontal runs merged", () => {
  const paths = pixelPaths(["AAB", ".A."], { A: "#111", B: "#222" });
  assert.deepEqual(paths, [
    { fill: "#111", d: "M0 0h2v1h-2zM1 1h1v1h-1z" },
    { fill: "#222", d: "M2 0h1v1h-1z" },
  ]);
  assert.deepEqual(pixelPaths(["..."], { A: "#111" }), [], "transparent pixels draw nothing");
});

test("the agent who hands work over walks to the other desk and back", () => {
  assert.deepEqual(walkPlan({ from: "backend", to: "qa", kind: "report", seq: 5, label: "" }), { walker: "backend", from: DESK_SPOTS.backend.seat, to: DESK_SPOTS.qa.visit });
  assert.deepEqual(walkPlan({ from: "backend", to: "user", kind: "approval", seq: 4, label: "" }), { walker: "backend", from: DESK_SPOTS.backend.seat, to: TRAY_SPOT });
  // The user does not walk; the PM fetches the order from the tray.
  assert.deepEqual(walkPlan({ from: "user", to: "supervisor", kind: "order", seq: 1, label: "" }), { walker: "supervisor", from: DESK_SPOTS.supervisor.seat, to: TRAY_SPOT });
});

test("every spot is inside the scene and no two desks share a seat", () => {
  const spots = [...Object.values(DESK_SPOTS).flatMap(s => [s.seat, s.visit]), TRAY_SPOT];
  for (const p of spots) assert.ok(p.x >= 0 && p.y >= 0 && p.x + 12 <= SCENE.width && p.y + 18 <= SCENE.height, JSON.stringify(p));
  assert.equal(new Set(Object.values(DESK_SPOTS).map(s => `${s.seat.x},${s.seat.y}`)).size, 4);
});
