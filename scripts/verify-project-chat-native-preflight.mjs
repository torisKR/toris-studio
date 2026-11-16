#!/usr/bin/env node
// Read-only preflight for the native Project Chat QA (backlog 3차 #17).
//
// It only reads: git state of this checkout, the QA build manifest and binary,
// the QA-only data folder, the listening state of port 1420, the process list,
// and the enabled macOS input sources. It never starts, stops, signals, deletes,
// sends or writes anything, so it is safe to run while the user's own Toris
// Studio or another worker's dev server is running.
//
//   node scripts/verify-project-chat-native-preflight.mjs [--root DIR] [--head SHA] [--require REF]...
//
// --root     QA evidence root (default /tmp/toris-native-qa). Must not be $HOME.
// --head     the source commit the QA build must be (default: this checkout's HEAD).
// --require  a ref that must be an ancestor of --head (repeatable), e.g. c07f494.
//
// Exit 0 when every blocking check passes; 1 otherwise. Warnings never block.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAY = join(ROOT, "docs/review/project-chat-native-qa.tauri.json");
const PRODUCT_IDENTIFIER = "kr.toris.studio";

export function parseArgs(argv) {
  const out = { root: "/tmp/toris-native-qa", head: null, require: [] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!["--root", "--head", "--require"].includes(flag) || value === undefined) {
      throw new Error(`알 수 없는 인자: ${flag}`);
    }
    i++;
    if (flag === "--require") out.require.push(value);
    else out[flag.slice(2)] = value;
  }
  return out;
}

/** The single-instance socket tauri-plugin-single-instance 2.x uses on macOS. */
export function singleInstanceSocket(identifier) {
  return `/tmp/${identifier.replace(/[.-]/g, "_")}_si.sock`;
}

/** True when `child` is `parent` or inside it (both already resolved). */
export function inside(parent, child) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function run(cmd, args, cwd = ROOT) {
  // Arguments only, never a shell.
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const sha256File = path => createHash("sha256").update(readFileSync(path)).digest("hex");

export function preflight(opts) {
  const checks = [];
  const add = (name, ok, detail, blocking = true) => checks.push({ name, ok, blocking, detail });

  // 1. Source: clean checkout at the expected head, containing required commits.
  const head = run("git", ["rev-parse", "HEAD"]).out;
  const want = opts.head ? run("git", ["rev-parse", "--verify", `${opts.head}^{commit}`]).out : head;
  add("source head", Boolean(want) && head === want, `checkout ${head}, expected ${want || opts.head}`);
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"]).out;
  add("tracked files clean", dirty === "", dirty ? `${dirty.split("\n").length} changed tracked file(s)` : "clean");
  for (const ref of opts.require) {
    const ok = run("git", ["merge-base", "--is-ancestor", ref, head]).ok;
    add(`contains ${ref}`, ok, ok ? "ancestor of HEAD" : "missing from HEAD");
  }

  // 2. QA overlay isolates identifier (single-instance socket, WebKit storage, app data).
  let identifier = null;
  try { identifier = JSON.parse(readFileSync(OVERLAY, "utf8")).identifier; } catch { /* reported below */ }
  add("QA identifier differs from the product", typeof identifier === "string" && identifier !== PRODUCT_IDENTIFIER,
    `overlay identifier ${identifier}`);

  // 3. QA root is a dedicated folder, never the real home.
  const realHome = realpathSync(homedir());
  const root = existsSync(opts.root) ? realpathSync(opts.root) : resolve(opts.root);
  // The root may live under $HOME, but never be $HOME or one of its parents.
  add("QA root is not the user's home", !inside(root, realHome), root);
  const qaHome = join(root, "home");
  const store = join(qaHome, "Library/Application Support", PRODUCT_IDENTIFIER, "project-chat/projects.json");

  // 4. Build manifest ties the binary to a source head.
  const manifestPath = join(root, "build.json");
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { /* reported below */ }
  if (!manifest) {
    add("QA build manifest", false, `${manifestPath} 없음 — 아직 빌드하지 않음`, false);
  } else {
    add("manifest head equals expected head", manifest.sourceHead === want, `manifest ${manifest.sourceHead}`);
    add("manifest build was clean", manifest.sourceDirty === false, `sourceDirty=${manifest.sourceDirty}`);
    const bin = manifest.binary;
    const binOk = typeof bin === "string" && existsSync(bin) && lstatSync(bin).isFile();
    const digest = binOk ? sha256File(bin) : null;
    add("binary matches manifest sha256", binOk && digest === manifest.binarySha256,
      binOk ? `${bin} sha256 ${digest?.slice(0, 16)}…` : `${bin} 없음`);
    add("debug build (QA automation switch works only with debug_assertions)", manifest.profile === "debug",
      `profile ${manifest.profile}`);
    if (binOk) {
      const installed = "/Applications/Toris Studio.app";
      add("binary is not the installed app", !inside(installed, realpathSync(bin)), realpathSync(bin));
    }
  }

  // 5. QA data contains only QA projects (paths under the QA root). Names are not printed.
  if (existsSync(store)) {
    let projects = [];
    try { projects = JSON.parse(readFileSync(store, "utf8")).projects ?? []; } catch { /* empty */ }
    const outside = projects.filter(p => typeof p.folder !== "string" || !inside(root, resolve(p.folder)));
    add("QA store holds only QA-root projects", outside.length === 0,
      `${projects.length} project(s), ${outside.length} outside the QA root`);
  } else {
    add("QA store", true, "아직 없음(첫 실행 전)", false);
  }

  // 6. Environment, reported only.
  const port = run("lsof", ["-nP", "-iTCP:1420", "-sTCP:LISTEN", "-t"]).out;
  add("port 1420 untouched (QA build embeds its UI)", true, port ? `listening pid(s) ${port.split("\n").join(",")} — 그대로 둠` : "no listener", false);
  const procs = run("ps", ["-axo", "pid=,comm="]).out.split("\n");
  const installedPids = procs.filter(l => l.includes("/Applications/Toris Studio.app/")).map(l => l.trim().split(/\s+/)[0]);
  add("installed app processes (never touched)", true, installedPids.length ? `pid ${installedPids.join(",")}` : "not running", false);
  const qaPids = procs.filter(l => l.includes("Toris Studio QA.app/")).map(l => l.trim().split(/\s+/)[0]);
  add("QA app processes", true, qaPids.length ? `pid ${qaPids.join(",")}` : "not running", false);
  if (identifier) {
    add("QA single-instance socket", true, `${singleInstanceSocket(identifier)} ${existsSync(singleInstanceSocket(identifier)) ? "present" : "absent"}`, false);
  }
  add("product single-instance socket (separate)", true,
    `${singleInstanceSocket(PRODUCT_IDENTIFIER)} ${existsSync(singleInstanceSocket(PRODUCT_IDENTIFIER)) ? "present" : "absent"}`, false);
  const sources = run("defaults", ["read", "com.apple.HIToolbox", "AppleEnabledInputSources"]).out;
  add("Korean input source enabled", /com\.apple\.inputmethod\.Korean/.test(sources),
    /2SetKorean/.test(sources) ? "2-Set Korean" : "Korean input mode not found", false);

  return { head, expectedHead: want, root, qaHome, checks, ok: checks.every(c => c.ok || !c.blocking) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = preflight(parseArgs(process.argv.slice(2)));
  for (const c of result.checks) {
    const mark = c.ok ? "PASS" : c.blocking ? "FAIL" : "WARN";
    console.log(`${mark}  ${c.name}: ${c.detail}`);
  }
  console.log(result.ok ? "preflight ok" : "preflight failed");
  process.exitCode = result.ok ? 0 : 1;
}
