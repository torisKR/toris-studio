import { createTwoFilesPatch } from "diff";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UserError, sha256 } from "../util.js";

export const MAX_READ_BYTES = 256 * 1024;
export const MAX_WRITE_BYTES = 512 * 1024;
const MAX_LIST = 400;

/** Paths an agent may never read or write, even inside a project. */
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|mobileprovision)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.npmrc|\.netrc|\.pypirc|credentials(\.json)?|service-account.*\.json|.*secret.*\.json)$/i;
const BLOCKED_DIR = /(^|\/)(\.git|\.ssh|\.aws|\.gnupg)(\/|$)/;
const NO_WRITE_DIR = /(^|\/)(node_modules|target|dist|build|\.next|\.venv|vendor|Pods)(\/|$)/;
export const IGNORED_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".next", ".turbo", ".venv", "venv", "vendor", "Pods", "coverage", ".dart_tool", ".gradle", ".idea", ".cache", "__pycache__", ".godot"]);

function normalize(relative: string): string {
  if (typeof relative !== "string" || !relative.trim() || relative.length > 1000 || relative.includes("\0")) throw new UserError("파일 경로를 확인하세요.");
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) throw new UserError("프로젝트 기준 상대 경로만 사용할 수 있습니다.");
  const clean = path.posix.normalize(relative.replace(/\\/g, "/")).replace(/^\.\/+/, "");
  if (clean === ".." || clean.startsWith("../")) throw new UserError("프로젝트 밖의 경로는 사용할 수 없습니다.");
  return clean === "." ? "" : clean;
}

/** Resolve a project-relative path; symlinks may not lead outside the project. */
export function resolveInProject(projectRoot: string, relative: string, { write = false } = {}): { abs: string; rel: string } {
  const rel = normalize(relative);
  if (rel && (SECRET_FILE.test(rel) || BLOCKED_DIR.test(rel))) throw new UserError(`보호된 파일은 사용할 수 없습니다: ${rel}`);
  if (write && NO_WRITE_DIR.test(rel)) throw new UserError(`빌드 산출물·의존성 폴더에는 쓸 수 없습니다: ${rel}`);
  const root = realpathSync(projectRoot);
  const abs = path.join(root, rel);
  let probe = abs;
  while (!existsSync(probe)) probe = path.dirname(probe);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new UserError("심볼릭 링크가 프로젝트 밖을 가리킵니다.");
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
    const target = realpathSync(abs);
    if (target !== root && !target.startsWith(root + path.sep)) throw new UserError("심볼릭 링크가 프로젝트 밖을 가리킵니다.");
  }
  return { abs, rel };
}

export function readProjectFile(projectRoot: string, relative: string, startLine?: number, endLine?: number): string {
  const { abs, rel } = resolveInProject(projectRoot, relative);
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new UserError(`파일이 없습니다: ${rel}`);
  if (stat.size > MAX_READ_BYTES * 4) throw new UserError(`파일이 너무 큽니다 (${stat.size} bytes): ${rel}`);
  const content = readFileSync(abs, "utf8");
  if (content.includes("\0")) throw new UserError(`바이너리 파일은 읽을 수 없습니다: ${rel}`);
  const lines = content.split("\n");
  const from = Math.max(1, Math.floor(startLine ?? 1));
  const to = Math.min(lines.length, Math.floor(endLine ?? lines.length));
  const numbered = lines.slice(from - 1, to).map((line, i) => `${String(from + i).padStart(5)}| ${line}`).join("\n");
  return numbered.length > MAX_READ_BYTES ? `${numbered.slice(0, MAX_READ_BYTES)}\n…(잘림: startLine/endLine으로 나눠 읽으세요)` : numbered;
}

export function listProjectDir(projectRoot: string, relative = "."): string {
  const { abs, rel } = resolveInProject(projectRoot, relative || ".");
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new UserError(`폴더가 없습니다: ${rel || "."}`);
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter(e => !(e.isDirectory() && IGNORED_DIRS.has(e.name)) && !SECRET_FILE.test(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const shown = entries.slice(0, MAX_LIST).map(e => (e.isDirectory() ? `${e.name}/` : e.name));
  return [...shown, ...(entries.length > MAX_LIST ? [`…외 ${entries.length - MAX_LIST}개`] : [])].join("\n") || "(빈 폴더)";
}

/** Fixed-string search through git-tracked (or walked) text files. */
export function grepProject(projectRoot: string, pattern: string, files: string[], maxHits = 80): string {
  if (!pattern || pattern.length > 200) throw new UserError("검색어를 확인하세요.");
  const needle = pattern.toLowerCase();
  const hits: string[] = [];
  for (const rel of files) {
    if (hits.length >= maxHits) break;
    let content: string;
    try { content = readFileSync(path.join(projectRoot, rel), "utf8"); } catch { continue; }
    if (content.length > MAX_READ_BYTES * 2 || content.includes("\0")) continue;
    content.split("\n").forEach((line, i) => {
      if (hits.length < maxHits && line.toLowerCase().includes(needle)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
    });
  }
  return hits.length ? hits.join("\n") : "일치하는 줄이 없습니다.";
}

/** Text files of a project, git-aware when possible so .gitignore is respected. */
export function projectFiles(projectRoot: string, limit = 6000): string[] {
  let files: string[] = [];
  if (existsSync(path.join(projectRoot, ".git"))) {
    try {
      files = execFileSync("git", ["-C", projectRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20_000 })
        .split("\0").filter(Boolean);
    } catch { files = []; }
  }
  if (!files.length) {
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (files.length >= limit) return;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(path.join(dir, entry.name), rel); }
        else if (entry.isFile()) files.push(rel);
      }
    };
    walk(projectRoot, "");
  }
  return files.filter(rel => !SECRET_FILE.test(rel) && !BLOCKED_DIR.test(rel) && !rel.split("/").some(part => IGNORED_DIRS.has(part))).slice(0, limit);
}

export type ProposedWrite = { rel: string; content: string; diff: string; baseHash: string | null };

export function proposeWrite(projectRoot: string, relative: string, content: string): ProposedWrite {
  if (typeof content !== "string") throw new UserError("파일 내용을 확인하세요.");
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new UserError("한 번에 쓸 수 있는 파일 크기(512KB)를 넘었습니다.");
  const { abs, rel } = resolveInProject(projectRoot, relative, { write: true });
  const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  if (before !== null && statSync(abs).isDirectory()) throw new UserError(`폴더에는 쓸 수 없습니다: ${rel}`);
  if (before === content) throw new UserError(`변경 사항이 없습니다: ${rel}`);
  const diff = createTwoFilesPatch(before === null ? "/dev/null" : `a/${rel}`, `b/${rel}`, before ?? "", content, undefined, undefined, { context: 3 });
  return { rel, content, diff, baseHash: before === null ? null : sha256(before) };
}

export function proposeEdit(projectRoot: string, relative: string, edits: Array<{ find: string; replace: string }>): ProposedWrite {
  const { abs, rel } = resolveInProject(projectRoot, relative, { write: true });
  if (!existsSync(abs)) throw new UserError(`수정할 파일이 없습니다: ${rel}. 새 파일은 write_file을 사용하세요.`);
  let content = readFileSync(abs, "utf8");
  if (!Array.isArray(edits) || !edits.length || edits.length > 30) throw new UserError("edits는 1~30개의 {find, replace} 배열이어야 합니다.");
  for (const [i, edit] of edits.entries()) {
    if (typeof edit?.find !== "string" || typeof edit?.replace !== "string" || !edit.find) throw new UserError(`edits[${i}] 형식을 확인하세요.`);
    const count = content.split(edit.find).length - 1;
    if (count !== 1) throw new UserError(`edits[${i}].find가 ${count}번 나옵니다. 정확히 1번 나오는 고유한 문자열을 사용하세요.`);
    content = content.replace(edit.find, () => edit.replace);
  }
  return proposeWrite(projectRoot, rel, content);
}

/** Apply only if the file is still exactly what the user reviewed. */
export function applyWrite(projectRoot: string, proposal: { path: string; content: string; baseHash: string | null }): void {
  const { abs, rel } = resolveInProject(projectRoot, proposal.path, { write: true });
  const current = existsSync(abs) ? sha256(readFileSync(abs, "utf8")) : null;
  if (current !== proposal.baseHash) throw new UserError(`승인 후 파일이 바뀌어 적용하지 않았습니다: ${rel}. 다시 확인하세요.`);
  mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.toris-agent-${process.pid}.tmp`;
  writeFileSync(temp, proposal.content, { mode: existsSync(abs) ? statSync(abs).mode : 0o644 });
  renameSync(temp, abs);
}
