import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeInvoke } from "../desktop/src/ai-client";
import {
  canCommitIn, commitFiles, commitMessageProblem, normalizeCommitReview, pickableFiles, reviewCommit, type CommitReview, type Thread
} from "../desktop/src/projects/project-chat-client";

const sha = "0123456789abcdef0123456789abcdef01234567";
const blob = "89abcdef0123456789abcdef0123456789abcdef";
const recorder = (reply: unknown) => {
  const calls: Array<[string, unknown]> = [];
  const call: BridgeInvoke = async (command, args) => { calls.push([command, args]); return reply; };
  return { calls, call };
};
const rawReview = {
  threadId: "t1", folder: "/Users/me/app-worktrees/abcd1234", branch: "studio/abcd1234", head: sha, more: false,
  files: [
    { path: "src/a.ts", change: "modified", fingerprint: "100644:" + blob, diff: "+a", truncated: false },
    { path: "gone.txt", change: "deleted", fingerprint: "deleted", diff: "-x", truncated: false },
    { path: "link.txt", change: "added", fingerprint: "", diff: "", truncated: false, refused: "심볼릭 링크는 커밋하지 않습니다." },
    { path: "weird.txt", change: "bogus", fingerprint: "../../etc", diff: "", truncated: false },
    { change: "modified" }
  ]
};
const thread = (branch: string | null, worktree = true): Thread => ({ id: "t1", projectId: "p1", title: "x", agent: "claude", mode: "edit", providerSession: null, createdAt: "", updatedAt: "", running: false, previewUrl: null, lastRun: null,
  worktree: worktree ? { path: "/Users/me/app-worktrees/abcd1234", branch, base: sha, linkedAt: "" } : null });

test("only Studio-made worktrees offer a commit (the host checks again)", () => {
  assert.equal(canCommitIn(thread("studio/abcd1234")), true);
  assert.equal(canCommitIn(thread("feature/login")), false, "a linked worktree of the user");
  assert.equal(canCommitIn(thread(null)), false, "detached HEAD");
  assert.equal(canCommitIn(thread(null, false)), false, "the project folder itself");
  assert.equal(canCommitIn(null), false);
});

test("a review keeps fingerprints only in the shapes the host makes and marks the rest refused", async () => {
  const { calls, call } = recorder(rawReview);
  const review = await reviewCommit("t1", call);
  assert.deepEqual(calls, [["project_chat_commit_review", { input: { threadId: "t1" } }]]);
  assert.deepEqual(review.files.map(f => [f.path, f.change, f.fingerprint, f.refused]), [
    ["src/a.ts", "modified", "100644:" + blob, null],
    ["gone.txt", "deleted", "deleted", null],
    ["link.txt", "added", "", "심볼릭 링크는 커밋하지 않습니다."],
    ["weird.txt", "modified", "", "이 파일은 커밋할 수 없습니다."]
  ]);
  assert.deepEqual(pickableFiles(review).map(f => f.path), ["src/a.ts", "gone.txt"]);
  assert.deepEqual(pickableFiles({ ...review, blocked: "staged 변경이 있습니다." }), [], "nothing is pickable while blocked");
  assert.equal(normalizeCommitReview({ ...rawReview, head: "HEAD" }), null);
  assert.equal(normalizeCommitReview({ ...rawReview, folder: "relative" }), null);
  await assert.rejects(reviewCommit("t1", recorder({}).call), /읽지 못했습니다/);
});

test("commit sends the reviewed HEAD and the shown fingerprints of the picked files only", async () => {
  const review = normalizeCommitReview(rawReview) as CommitReview;
  const { calls, call } = recorder({ cancelled: false, commit: { sha: blob, branch: "studio/abcd1234", folder: review.folder, files: ["src/a.ts"], indexUpdated: true } });
  const done = await commitFiles(review, ["src/a.ts", "gone.txt", "src/a.ts"], "제목\n\n본문", call);
  assert.deepEqual(calls, [["project_chat_commit", { input: { threadId: "t1", head: sha, message: "제목\n\n본문",
    files: [{ path: "src/a.ts", fingerprint: "100644:" + blob }, { path: "gone.txt", fingerprint: "deleted" }] } }]]);
  assert.deepEqual(done, { sha: blob, branch: "studio/abcd1234", folder: review.folder, files: ["src/a.ts"], indexUpdated: true, receiptWarning: null });

  assert.equal(await commitFiles(review, ["src/a.ts"], "x", recorder({ cancelled: true }).call), null, "OS dialog cancelled");
  await assert.rejects(commitFiles(review, ["src/a.ts"], "x", recorder({ cancelled: false, commit: { sha: "nope" } }).call), /확인하지 못했습니다/, "no fake success");

  const refused = recorder({});
  await assert.rejects(commitFiles(review, ["link.txt"], "x", refused.call), /다시 검토/);
  await assert.rejects(commitFiles(review, ["../outside.txt"], "x", refused.call), /다시 검토/);
  await assert.rejects(commitFiles(review, [], "x", refused.call), /하나 이상/);
  await assert.rejects(commitFiles(review, ["src/a.ts"], "  \n ", refused.call), /메시지/);
  await assert.rejects(commitFiles({ ...review, blocked: "에이전트가 실행 중입니다." }, ["src/a.ts"], "x", refused.call), /실행 중/);
  assert.equal(refused.calls.length, 0, "nothing reaches the host when the page already knows it is refused");
});

test("a commit whose receipt could not be kept is still a success, with the warning", async () => {
  const review = normalizeCommitReview(rawReview) as CommitReview;
  const warning = "커밋은 완료됐지만 이 대화 기록에 영수증을 남기지 못했습니다: 대화 기록을 저장하지 못했습니다.";
  const { calls, call } = recorder({ cancelled: false, commit: { sha: blob, branch: "studio/abcd1234", folder: review.folder, files: ["src/a.ts"], indexUpdated: false, receiptWarning: warning } });
  const done = await commitFiles(review, ["src/a.ts"], "x", call);
  assert.deepEqual(done, { sha: blob, branch: "studio/abcd1234", folder: review.folder, files: ["src/a.ts"], indexUpdated: false, receiptWarning: warning });
  assert.equal(calls.length, 1, "never committed again");
  // A malformed warning is dropped, never turned into a failure.
  const odd = await commitFiles(review, ["src/a.ts"], "x", recorder({ cancelled: false, commit: { sha: blob, branch: "studio/abcd1234", files: [], indexUpdated: true, receiptWarning: 42 } }).call);
  assert.equal(odd?.receiptWarning, null);
});

test("a file whose diff the host could not read is refused even when it carries a fingerprint", async () => {
  const why = "diff를 읽지 못해 변경 내용을 보여 줄 수 없어 커밋하지 않습니다: fatal: unable to read 0123";
  const review = normalizeCommitReview({ ...rawReview, files: [
    { path: "src/a.ts", change: "modified", fingerprint: "100644:" + blob, diff: "+a", truncated: false },
    { path: "src/empty.ts", change: "modified", fingerprint: "100755:" + blob, diff: "", truncated: false },
    { path: "src/unread.ts", change: "modified", fingerprint: "100644:" + blob, diff: "", truncated: false, refused: why }
  ] }) as CommitReview;
  const unread = review.files.find(f => f.path === "src/unread.ts");
  assert.equal(unread?.refused, why, "the host's reason is kept for the panel");
  assert.deepEqual(pickableFiles(review).map(f => f.path), ["src/a.ts", "src/empty.ts"], "a real empty diff stays pickable");
  const forged = recorder({});
  await assert.rejects(commitFiles(review, ["src/unread.ts"], "x", forged.call), /다시 검토/);
  assert.equal(forged.calls.length, 0);
});

test("commit message rules match the host", () => {
  assert.equal(commitMessageProblem("feat: 로그인"), "");
  assert.equal(commitMessageProblem("제목\r\n\r\n본문\t들여쓰기"), "");
  assert.match(commitMessageProblem(""), /입력/);
  assert.match(commitMessageProblem("bell\u0007"), /제어 문자/);
  assert.match(commitMessageProblem("가".repeat(1334)), /4000바이트/, "3 bytes per Hangul syllable");
  assert.equal(commitMessageProblem("가".repeat(1333)), "");
});
