import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = resolve(root, ".toris-studio/services");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const stateFile = resolve(stateDir, "trends.json");
const origin = process.env.TORIS_STUDIO_API_URL ?? "http://127.0.0.1:3000";
const base = new URL(origin);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !["http:", "https:"].includes(base.protocol) || base.username || base.password) {
  throw new Error("Trend worker requires a local Studio URL.");
}

export function koreaDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function shouldCollect(date, lastDay) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(date));
  return hour >= 7 && koreaDay(date) !== lastDay;
}

async function collect() {
  const response = await fetch(new URL("/api/social/trends/refresh", base), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(90_000)
  });
  const result = await response.json();
  if (!response.ok || !result.saved) throw new Error("트렌드 수집 또는 DB 저장 실패. Studio와 DB 상태를 확인하세요.");
  const status = { lastDay: koreaDay(), lastSuccessAt: new Date().toISOString(), collected: result.collected, warnings: result.warnings ?? [] };
  writeFileSync(stateFile, JSON.stringify(status, null, 2), { mode: 0o600 });
  console.log(`${status.lastSuccessAt} saved ${status.collected} trend references`);
  return status.lastDay;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let lastDay = "";
  if (existsSync(stateFile)) {
    const { readFileSync } = await import("node:fs");
    try { lastDay = JSON.parse(readFileSync(stateFile, "utf8")).lastDay ?? ""; } catch { /* corrupt status is safe to regenerate */ }
  }
  if (process.argv.includes("--once")) {
    try { await collect(); } catch (error) { console.error(error.message); process.exitCode = 1; }
  } else {
    console.log("Toris trend worker: daily 07:00 Asia/Seoul, retries every 5 minutes; requires this Mac to be awake.");
    let busy = false;
    const tick = async () => {
      if (busy || !shouldCollect(new Date(), lastDay)) return;
      busy = true;
      try { lastDay = await collect(); } catch { console.error(`${new Date().toISOString()} collection failed; retry in 5 minutes`); }
      finally { busy = false; }
    };
    await tick();
    setInterval(tick, 5 * 60 * 1000);
  }
}
