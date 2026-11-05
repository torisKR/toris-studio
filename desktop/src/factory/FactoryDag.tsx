import { taskStatusLabel, type FactoryJobView } from "./factory-client";

const LABEL: Record<string, string> = {
  "spec-approved": "명세 확정",
  "scaffold-project": "뼈대",
  "game-design": "게임 설계",
  "app-design": "앱 설계",
  "character-base": "캐릭터",
  "sprite-atlas": "스프라이트",
  "vfx-export": "효과",
  "model-export": "모델",
  "gameplay-core": "플레이",
  "screen-core": "화면",
  "level-content": "레벨",
  "asset-integration": "에셋 연결",
  "lint-and-import": "가져오기",
  "headless-tests": "헤드리스",
  "android-debug-build": "Android",
  "adb-smoke-test": "기기",
  "release-review": "배포 검토",
};

const NODE_W = 148;
const NODE_H = 64;
const GAP_X = 22;
const GAP_Y = 42;
const PAD = 12;

export function taskLabel(taskId: string): string {
  return LABEL[taskId] ?? taskId;
}

function depths(jobs: FactoryJobView[]): Map<string, number> {
  const ids = new Set(jobs.map(job => job.taskId));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = (jobs.find(job => job.taskId === id)?.deps ?? []).filter(dep => ids.has(dep));
    const value = deps.length ? 1 + Math.max(...deps.map(visit)) : 0;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const job of jobs) visit(job.taskId);
  return depth;
}

export function FactoryDag({ jobs, selected, onSelect }: { jobs: FactoryJobView[]; selected: string; onSelect: (taskId: string) => void }) {
  if (!jobs.length) return <p className="factory-empty">명세 미리보기를 누르면 작업 그래프가 나타납니다. 미리보기는 모델을 호출하지 않습니다.</p>;
  const depth = depths(jobs);
  const rows: FactoryJobView[][] = [];
  for (const job of jobs) {
    const row = depth.get(job.taskId) ?? 0;
    (rows[row] ??= []).push(job);
  }
  const width = Math.max(...rows.map(row => row.length * NODE_W + Math.max(0, row.length - 1) * GAP_X), NODE_W) + PAD * 2;
  const height = rows.length * NODE_H + Math.max(0, rows.length - 1) * GAP_Y + PAD * 2;
  const pos = new Map<string, { x: number; y: number }>();
  rows.forEach((row, rowIndex) => {
    const rowWidth = row.length * NODE_W + Math.max(0, row.length - 1) * GAP_X;
    const origin = PAD + (width - PAD * 2 - rowWidth) / 2;
    row.forEach((job, index) => {
      pos.set(job.taskId, { x: origin + index * (NODE_W + GAP_X), y: PAD + rowIndex * (NODE_H + GAP_Y) });
    });
  });
  const present = new Set(jobs.map(job => job.taskId));
  return <div className="factory-dag" style={{ width, height }} role="group" aria-label="작업 그래프">
    <svg className="factory-dag-edges" width={width} height={height} aria-hidden="true">
      {jobs.flatMap(job => (job.deps ?? []).filter(dep => present.has(dep)).map(dep => {
        const from = pos.get(dep);
        const to = pos.get(job.taskId);
        if (!from || !to) return null;
        return <line key={`${dep}-${job.taskId}`} x1={from.x + NODE_W / 2} y1={from.y + NODE_H} x2={to.x + NODE_W / 2} y2={to.y} />;
      }))}
    </svg>
    {jobs.map(job => {
      const at = pos.get(job.taskId);
      if (!at) return null;
      const label = taskLabel(job.taskId);
      const state = taskStatusLabel(job.status);
      return <button
        key={job.taskId}
        type="button"
        className={`factory-node ${job.status}`}
        style={{ left: at.x, top: at.y, width: NODE_W, height: NODE_H }}
        data-status={job.status}
        data-task={job.taskId}
        aria-pressed={selected === job.taskId}
        onClick={() => onSelect(job.taskId)}
      >
        <strong>{label}</strong>
        <small>{state}</small>
      </button>;
    })}
  </div>;
}
