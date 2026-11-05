import type { FactoryJobView } from "./factory-client";

const ASSET_TASKS = ["sprite-atlas", "vfx-export", "model-export", "character-base"];

export function AssetReview({ jobs }: { jobs: FactoryJobView[] }) {
  const assets = jobs.filter(job => ASSET_TASKS.includes(job.taskId));
  return <section className="factory-card" aria-label="에셋 검수">
    <h2>에셋</h2>
    {assets.length === 0 ? <p>이 명세에는 에셋 작업이 없습니다.</p> : <ul className="factory-list">
      {assets.map(job => <li key={job.taskId}><strong>{job.taskId}</strong><small className={`factory-status ${job.status}`}>{job.status}</small><small>{job.message || "아직 기록이 없습니다."}</small></li>)}
    </ul>}
    <p>이미지가 없거나 도구를 실행하지 않았으면 통과로 표시하지 않습니다. Patch Pixel 글꼴은 포함하지 않습니다.</p>
  </section>;
}
