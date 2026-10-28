import assert from "node:assert/strict";
import test from "node:test";
import * as client from "../desktop/src/publication-client";

const now = Date.parse("2026-10-19T00:00:00Z");

test("batch scheduling changes only selected target drafts in display order without mutating or approving", () => {
  assert.equal(typeof client.batchSchedule, "function", "batch scheduling helper must exist");
  const targets = [client.newTarget("instagram"), client.newTarget("facebook"), client.newTarget("threads")];
  targets[0].options.confirmPublic = true;
  const publication = { ...client.newPublication(), revision: 4, targets };
  const original = structuredClone(publication);
  const result = client.batchSchedule(publication, [targets[2].id, targets[0].id], "2026-10-20T09:30", 15, now);
  assert.equal(result.targets[0].mode, "scheduled");
  assert.equal(result.targets[0].scheduledAt, "2026-10-20T00:30:00.000Z");
  assert.equal(result.targets[2].scheduledAt, "2026-10-20T00:45:00.000Z");
  assert.deepEqual(result.targets[1], original.targets[1]);
  assert.deepEqual(result.targets[0].options, original.targets[0].options);
  assert.equal(result.revision, 4);
  assert.deepEqual(publication, original);
});

test("batch scheduling rejects invalid selection, intervals, elapsed dates and unsafe job states atomically", () => {
  const target = client.newTarget("threads");
  const publication = { ...client.newPublication(), revision: 2, targets: [target] };
  const apply = (ids = [target.id], start = "2026-10-20T09:30", gap = 0, value = publication) => client.batchSchedule(value, ids, start, gap, now);
  assert.equal(apply().targets[0].scheduledAt, "2026-10-20T00:30:00.000Z");
  for (const ids of [[], [target.id, target.id], ["missing"]]) assert.throws(() => apply(ids), /대상/);
  for (const gap of [-1, 0.5, 1441, NaN, Infinity]) assert.throws(() => apply([target.id], undefined, gap), /간격/);
  for (const start of ["", "invalid", "2026-10-19T09:00", "2026-10-18T09:00"]) assert.throws(() => apply([target.id], start), /일시|미래/);
  assert.throws(() => client.batchSchedule(publication, [target.id], "2026-10-20T09:30", 0, NaN), /기준/);
  assert.throws(() => apply([target.id], undefined, 0, { ...publication, targets: [{ ...target, mode: "tiktok_inbox" }] }), /초안/);
  assert.throws(() => apply([target.id], undefined, 0, { ...publication, targets: [target, target] }), /대상/);
  for (const status of ["published", "draft_sent", "queued", "scheduled", "sending", "processing", "uncertain", "failed"]) {
    const value = { ...publication, jobs: [{ id: "job", targetId: target.id, revision: 2, status, mode: "manual", warnings: [], updatedAt: "", retryable: true }] };
    assert.throws(() => apply([target.id], undefined, 0, value), /작업/);
  }
  for (const status of ["cancelled", "needs_confirmation"]) {
    const value = { ...publication, jobs: [{ id: "job", targetId: target.id, revision: 2, status, mode: "manual", warnings: [], updatedAt: "", retryable: false }] };
    assert.equal(apply([target.id], undefined, 0, value).targets[0].mode, "scheduled");
  }
  assert.equal(publication.targets[0].mode, "manual");
});

test("KST inputs reject calendar normalization and batch slots handle simultaneous starts and day boundaries", () => {
  for (const value of ["2026-02-29T10:00", "2026-02-30T10:00", "2026-04-31T10:00", "2026-10-20T24:00", "2026-10-20T10:60", "2026-1-2T10:00", "2026-10-20T10:00Z"]) assert.throws(() => client.kstSchedule(value), /일시/);
  assert.equal(client.kstSchedule("2028-02-29T09:30"), "2028-02-29T00:30:00.000Z");
  const targets = [client.newTarget("instagram"), client.newTarget("threads")];
  const publication = { ...client.newPublication(), targets };
  const ids = targets.map(target => target.id);
  assert.deepEqual(client.batchSchedule(publication, ids, "2026-10-20T23:55", 0, now).targets.map(target => target.scheduledAt), ["2026-10-20T14:55:00.000Z", "2026-10-20T14:55:00.000Z"]);
  assert.equal(client.scheduleInput(client.batchSchedule(publication, ids, "2026-10-20T23:55", 10, now).targets[1].scheduledAt), "2026-10-21T00:05");
});

test("the batch form defaults to the next whole KST hour, which batchSchedule accepts as future", () => {
  const at = Date.parse("2026-10-28T09:55:00Z"); // 18:55 KST
  assert.equal(client.nextKstHour(at), "2026-10-28T19:00");
  assert.equal(client.nextKstHour(Date.parse("2026-12-31T14:30:00Z")), "2027-01-01T00:00", "rolls over the KST year boundary");
  const target = client.newTarget("threads");
  const result = client.batchSchedule({ ...client.newPublication(), targets: [target] }, [target.id], client.nextKstHour(at), 0, at);
  assert.equal(result.targets[0].scheduledAt, "2026-10-28T10:00:00.000Z");
});

