import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cliInvocation } from "../src/llm/cli.js";
import { projectDir } from "../src/projects.js";
import { chunkFile, collectionName } from "../src/rag/index.js";
import { LocalHashEmbedder } from "../src/rag/embed.js";
import { applyWrite, proposeEdit, proposeWrite, readProjectFile, resolveInProject } from "../src/tools/fs.js";
import { validateCommand } from "../src/tools/terminal.js";
import { parseJsonObject, redact } from "../src/util.js";
import { parseSettings } from "../src/runtime.js";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-fs-"));
  const project = path.join(root, "app");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src/a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(path.join(project, ".env"), "SECRET=1");
  mkdirSync(path.join(root, "other"));
  writeFileSync(path.join(root, "other/secret.txt"), "x");
  return { root, project };
}

test("paths stay inside the project and secrets are unreadable", () => {
  const { root, project } = fixture();
  assert.throws(() => resolveInProject(project, "../other/secret.txt"), /프로젝트 밖/);
  assert.throws(() => resolveInProject(project, "/etc/passwd"), /상대 경로/);
  assert.throws(() => resolveInProject(project, ".env"), /보호된/);
  assert.throws(() => resolveInProject(project, "keys/server.pem"), /보호된/);
  assert.throws(() => resolveInProject(project, ".git/config"), /보호된/);
  assert.throws(() => resolveInProject(project, "node_modules/x.js", { write: true }), /쓸 수 없습니다/);
  symlinkSync(path.join(root, "other"), path.join(project, "escape"));
  assert.throws(() => readProjectFile(project, "escape/secret.txt"), /밖을 가리킵니다/);
  assert.match(readProjectFile(project, "src/a.ts", 2, 2), /2\| export const b = 2;/);
  assert.throws(() => projectDir(root, "../etc"), /이름/);
  assert.match(projectDir(root, "app"), /[\\/]app$/);
  symlinkSync(project, path.join(root, "alias"));
  assert.throws(() => projectDir(root, "escape-none"), /찾을 수 없습니다/);
});

test("edits require a unique match and apply only to the reviewed version", () => {
  const { project } = fixture();
  assert.throws(() => proposeEdit(project, "src/a.ts", [{ find: "export", replace: "x" }]), /2번/);
  const proposal = proposeEdit(project, "src/a.ts", [{ find: "a = 1", replace: "a = 10" }]);
  assert.match(proposal.diff, /-export const a = 1;\n\+export const a = 10;/);
  writeFileSync(path.join(project, "src/a.ts"), "changed meanwhile\n");
  assert.throws(() => applyWrite(project, { path: proposal.rel, content: proposal.content, baseHash: proposal.baseHash }), /바뀌어/);
  const created = proposeWrite(project, "src/new.ts", "hello\n");
  assert.equal(created.baseHash, null);
  applyWrite(project, { path: created.rel, content: created.content, baseHash: created.baseHash });
  assert.equal(readFileSync(path.join(project, "src/new.ts"), "utf8"), "hello\n");
});

test("only build/test/lint commands pass validation", () => {
  assert.deepEqual(validateCommand(["pnpm", "run", "typecheck"]), ["pnpm", "run", "typecheck"]);
  assert.deepEqual(validateCommand(["cargo", "test"]), ["cargo", "test"]);
  for (const bad of [["rm", "-rf", "/"], ["npm", "install"], ["pnpm", "add", "x"], ["npx", "x"], ["sh", "-c", "x"], ["cargo", "run"], ["cargo", "fmt"], ["npm", "run", "a;rm"], ["pnpm", "run", "../x"], ["pnpm", "dlx", "x"], ["python3", "x.py"]]) {
    assert.throws(() => validateCommand(bad), Error, bad.join(" "));
  }
});

test("model JSON is extracted from fenced or chatty output", () => {
  assert.deepEqual(parseJsonObject('먼저 볼게요.\n```json\n{"action":"list_dir","args":{"path":"."}}\n```'), { action: "list_dir", args: { path: "." } });
  assert.deepEqual(parseJsonObject('ok {"a":"}{","b":{"c":1}} trailing'), { a: "}{", b: { c: 1 } });
  assert.throws(() => parseJsonObject("no json"), /JSON/);
});

test("secrets are redacted from provider and tool output", () => {
  const out = redact("key sk-ant-api03-abcdefghijklmnop and AIzaSyA1234567890abcdefghijklmnopqrstu custom-secret-value", ["custom-secret-value"]);
  assert.doesNotMatch(out, /sk-ant|AIza|custom-secret/);
});

test("chunks carry line ranges and projects never share a collection", () => {
  const content = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join("\n");
  const chunks = chunkFile("src/x.ts", content);
  assert.deepEqual(chunks.map(c => [c.startLine, c.endLine]), [[1, 60], [51, 110], [101, 130]]);
  assert.notEqual(collectionName("/Users/a/projects/one"), collectionName("/Users/a/projects/two"));
  assert.match(collectionName("/x"), /^toris_proj_[0-9a-f]{24}$/);
});

test("local embedder ranks identifier matches first", async () => {
  const e = new LocalHashEmbedder();
  const [q, hit, miss] = await e.embed(["getUserProfile", "function getUserProfile(id) { return db.user(id) }", "render the footer links"]);
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  assert.ok(dot(q, hit) > dot(q, miss));
});

test("subscription CLIs run text-only with fixed arguments", () => {
  const input = { system: "SYS", messages: [{ role: "user" as const, content: "hi" }] };
  const claude = cliInvocation("claude-cli", "sonnet", input, "/tmp/o");
  assert.ok(claude.args.includes("--tools") && claude.args[claude.args.indexOf("--tools") + 1] === "");
  assert.ok(claude.args.includes("--safe-mode") && claude.args.includes("--no-session-persistence"));
  assert.equal(claude.args[claude.args.indexOf("--system-prompt") + 1], "SYS");
  const codex = cliInvocation("codex-cli", "", input, "/tmp/o");
  assert.deepEqual(codex.args.slice(0, 5), ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"]);
  assert.ok(!codex.args.includes("-m"));
  const gemini = cliInvocation("gemini-cli", "gemini-2.5-pro", input, "/tmp/o");
  assert.equal(gemini.args[gemini.args.indexOf("--approval-mode") + 1], "plan");
});

test("settings reject remote endpoints and unknown providers", () => {
  assert.throws(() => parseSettings({ agentModel: { provider: "evil", model: "x" } }), /공급자/);
  assert.throws(() => parseSettings({ projectsRoot: "relative" }), /절대 경로/);
  const settings = parseSettings({ keys: { openai: " sk-x ", bogus: "y" }, agentModel: { provider: "claude-cli", model: "" } });
  assert.deepEqual(settings.keys, { openai: "sk-x" });
});
