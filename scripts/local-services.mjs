import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, openSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, ".toris-studio/services");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const specs = {
  web: { argv: [resolve(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3000"], match: "next-server" },
  trends: { argv: [resolve(root, "scripts/trend-worker.mjs")], match: resolve(root, "scripts/trend-worker.mjs") }
};
const action = process.argv[2] ?? "status";
if (!["start", "stop", "status"].includes(action)) throw new Error("Usage: node scripts/local-services.mjs start|stop|status");

function active(name) {
  const path = resolve(dataDir, `${name}.pid`);
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    if (!command.includes(specs[name].match)) return null;
    const cwd = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!cwd.split("\n").includes(`n${root}`)) return null;
    return pid;
  } catch { return null; }
}

for (const [name, spec] of Object.entries(specs)) {
  const pid = active(name);
  if (action === "status") { console.log(`${name}: ${pid ? `running (pid ${pid})` : "stopped"}`); continue; }
  if (action === "stop") {
    if (pid) process.kill(pid, "SIGTERM");
    const pidFile = resolve(dataDir, `${name}.pid`);
    if (existsSync(pidFile)) unlinkSync(pidFile);
    console.log(`${name}: stopped`); continue;
  }
  if (pid) { console.log(`${name}: already running (pid ${pid})`); continue; }
  if (name === "web") {
    if (!existsSync(resolve(root, ".next/BUILD_ID"))) throw new Error("Run pnpm build before starting local services.");
    try {
      const probe = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(2000) });
      if (probe) throw new Error("Port 3000 is occupied. Preserve the existing process and use pnpm dev on another port.");
    } catch (error) { if (error.message.includes("occupied")) throw error; }
  }
  const log = openSync(resolve(dataDir, `${name}.log`), "a", 0o600);
  const child = spawn(process.execPath, spec.argv, { cwd: root, detached: true, stdio: ["ignore", log, log], env: process.env });
  await new Promise((resolveStarted, reject) => { child.once("spawn", resolveStarted); child.once("error", reject); });
  writeFileSync(resolve(dataDir, `${name}.pid`), `${child.pid}\n`, { mode: 0o600 });
  closeSync(log); child.unref(); console.log(`${name}: started (pid ${child.pid})`);
}
