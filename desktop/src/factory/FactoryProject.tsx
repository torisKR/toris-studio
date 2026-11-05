import type { FactoryJobView, FactorySpecView } from "./factory-client";

export function FactoryProject({ spec, jobs, notes }: { spec: FactorySpecView; jobs: FactoryJobView[]; notes: string[] }) {
  return <section className="factory-card" aria-label="제작 명세">
    <h2>{spec.title}</h2>
    <p>{spec.kind === "app" ? "앱" : "게임"} · {spec.target.engine} · {spec.target.view} · {spec.design.orientation} · {spec.slug}</p>
    <p>기능 {spec.features.join(", ")} · 캐릭터 {spec.assets.characters} · 효과 {spec.assets.vfx} · 모델 {spec.assets.models} · API 상한 ${spec.limits.maxApiCostUsd}</p>
    {notes.length > 0 && <ul className="factory-list">{notes.map(note => <li key={note}>{note}</li>)}</ul>}
    <ol className="factory-list" aria-label="작업 순서">
      {jobs.map(job => <li key={job.taskId}><strong>{job.taskId}</strong><small className={`factory-status ${job.status}`}>{job.status}</small>{job.message && <small>{job.message}</small>}</li>)}
    </ol>
  </section>;
}
