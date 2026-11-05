// Artifact identity is a project-relative path plus a hash. Callers never treat a
// model string as a filesystem path.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { UserError } from "../util.js";

const RELATIVE = /^(?:[A-Za-z0-9]|\.[A-Za-z])[A-Za-z0-9./_-]{0,180}$/;

export function assertProjectRelative(relative: string): string {
  if (!RELATIVE.test(relative) || relative.includes("..") || relative.includes("//") || relative.endsWith("/")) throw new UserError("산출물 경로를 확인하세요.");
  return relative;
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fingerprint(relative: string, bytes: Buffer | string): string {
  return `${assertProjectRelative(relative)}:${sha256(bytes)}`;
}

export function parseFingerprint(value: string): { relative: string; sha256: string } | null {
  const split = value.lastIndexOf(":");
  if (split < 1) return null;
  const relative = value.slice(0, split);
  const digest = value.slice(split + 1);
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  try { assertProjectRelative(relative); } catch { return null; }
  return { relative, sha256: digest };
}

/** True when the file is still inside the project and its bytes match the recorded hash. */
export function fingerprintMatches(projectDir: string, value: string): boolean {
  const parsed = parseFingerprint(value);
  if (!parsed) return false;
  const root = realpathSync(projectDir);
  const absolute = path.resolve(root, parsed.relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return false;
  if (!existsSync(absolute)) return false;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  const real = realpathSync(absolute);
  if (real !== root && !real.startsWith(root + path.sep)) return false;
  return sha256(readFileSync(real)) === parsed.sha256;
}
