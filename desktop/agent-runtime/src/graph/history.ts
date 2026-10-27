import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunSummary } from "./runs.js";

export const MAX_SAVED_RUNS = 30;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHASES = new Set(["queued", "thinking", "reading", "coding", "testing", "reviewing", "awaiting_approval", "done", "failed", "cancelled"]);
const AGENTS = new Set(["supervisor", "frontend", "backend", "qa"]);

/** Run logs on disk, one private JSON file per run, so they survive the app closing. */
export class RunHistory {
  constructor(private dir: string) {}

  save(run: RunSummary): void {
    const file = this.file(run.runId);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    // Write then rename, so a crash mid-write never leaves a half file behind.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(run), { mode: 0o600 });
    renameSync(temp, file);
  }

  remove(runId: string): void {
    rmSync(this.file(runId), { force: true });
  }

  /** Newest first; unreadable or foreign files are skipped, runs past the cap are deleted. */
  load(): RunSummary[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    const runs: RunSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || !RUN_ID.test(name.slice(0, -5))) continue;
      try {
        const run = JSON.parse(readFileSync(path.join(this.dir, name), "utf8")) as RunSummary;
        if (valid(run) && `${run.runId}.json` === name) runs.push(run);
      } catch { /* skip a damaged file */ }
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const old of runs.splice(MAX_SAVED_RUNS)) this.remove(old.runId);
    return runs;
  }

  private file(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error("잘못된 작업 ID입니다.");
    return path.join(this.dir, `${runId}.json`);
  }
}

function valid(run: RunSummary): boolean {
  return Boolean(run) && typeof run === "object"
    && RUN_ID.test(String(run.runId)) && PHASES.has(run.phase) && AGENTS.has(run.agent)
    && typeof run.project === "string" && typeof run.task === "string" && typeof run.summary === "string"
    && typeof run.createdAt === "string" && typeof run.updatedAt === "string"
    && Array.isArray(run.changes) && Array.isArray(run.events);
}
