// Durable factory jobs. The agent run history cannot resume a killed process;
// this store can, and it is the only source of truth for factory tasks.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UserError } from "../util.js";
import { jobKey, type TaskId, type TaskStatus } from "./planner.js";
import { SLUG } from "./spec.js";

export const ADAPTER_VERSION = "factory-1";
export const SPEC_REVISION = 1;

export type FactoryJob = {
  key: string;
  project: string;
  specRevision: number;
  taskId: TaskId;
  inputHash: string;
  adapterVersion: string;
  status: TaskStatus;
  artifactHashes: string[];
  attempts: number;
  maxAttempts: number;
  paid: boolean;
  providerJobId: string;
  approval: "automatic" | "explicit";
  message: string;
  updatedAt: string;
};

export function factoryStoreDir(projectsRoot: string): string {
  if (!path.isAbsolute(projectsRoot)) throw new UserError("프로젝트 폴더는 절대 경로여야 합니다.");
  return path.join(projectsRoot, ".toris-factory", "jobs");
}

export function newJob(project: string, taskId: TaskId, inputHash: string, maxAttempts: number, approval: FactoryJob["approval"]): FactoryJob {
  return {
    key: jobKey(project, SPEC_REVISION, taskId, inputHash, ADAPTER_VERSION),
    project,
    specRevision: SPEC_REVISION,
    taskId,
    inputHash,
    adapterVersion: ADAPTER_VERSION,
    status: "queued",
    artifactHashes: [],
    attempts: 0,
    maxAttempts,
    paid: false,
    providerJobId: "",
    approval,
    message: "",
    updatedAt: new Date().toISOString(),
  };
}

const FILE_NAME = /^[a-z][a-z0-9-]{1,39}__[a-z0-9-]{1,40}\.json$/;

function jobPath(dir: string, project: string, taskId: TaskId): string {
  if (!SLUG.test(project)) throw new UserError("프로젝트 이름을 확인하세요.");
  return path.join(dir, `${project}__${taskId}.json`);
}

export class JobStore {
  constructor(private dir: string) {}

  load(project?: string): FactoryJob[] {
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return []; }
    const jobs: FactoryJob[] = [];
    for (const name of names) {
      if (!FILE_NAME.test(name)) continue;
      if (project && !name.startsWith(project + "__")) continue;
      try {
        const parsed = JSON.parse(readFileSync(path.join(this.dir, name), "utf8")) as FactoryJob;
        if (parsed && typeof parsed.taskId === "string" && typeof parsed.project === "string") jobs.push(parsed);
      } catch { /* a torn file is ignored; the task is recreated from the spec */ }
    }
    return jobs;
  }

  save(job: FactoryJob): void {
    mkdirSync(this.dir, { recursive: true });
    const destination = jobPath(this.dir, job.project, job.taskId);
    const temporary = destination + ".tmp";
    writeFileSync(temporary, JSON.stringify({ ...job, updatedAt: new Date().toISOString() }));
    renameSync(temporary, destination);
  }
}

/**
 * A killed process leaves jobs in `running`. Finished files are reused.
 * A paid call without a provider job id is not sent again until a person approves.
 */
export function reconcileJobs(jobs: FactoryJob[], matches: (fingerprint: string) => boolean, now = new Date().toISOString()): { jobs: FactoryJob[]; warnings: string[] } {
  const warnings: string[] = [];
  const nextJobs = jobs.map(job => {
    const active = job.status === "running" || job.status === "interrupted";
    if (!active) return job;
    const next: FactoryJob = { ...job, updatedAt: now };
    if (job.artifactHashes.length > 0 && job.artifactHashes.every(matches)) {
      next.status = "passed";
      next.message = "이미 만든 산출물을 해시로 확인했습니다.";
      return next;
    }
    if (job.paid) {
      next.status = "waiting_approval";
      next.message = "유료 호출이 끊겼고 제공자 작업 번호로 결과를 확인할 수 없어 다시 결제하지 않았습니다. 중복 결제될 수 있으니 승인 뒤에만 재시도하세요.";
      warnings.push(next.message);
      return next;
    }
    if (job.attempts < job.maxAttempts) {
      next.status = "queued";
      next.message = "중단된 작업을 다시 대기열에 넣었습니다.";
      return next;
    }
    next.status = "failed";
    next.message = "재시도 횟수를 넘겼습니다.";
    return next;
  });
  return { jobs: nextJobs, warnings };
}
