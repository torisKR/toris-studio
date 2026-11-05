import type { FactorySpecView } from "./factory-client";

export function FactoryProject({ spec, notes }: { spec: FactorySpecView; notes: string[] }) {
  return <section aria-label="제작 명세">
    <h2>{spec.title}</h2>
    <p>{spec.kind === "app" ? "앱" : "게임"} · {spec.target.engine} · {spec.target.view} · {spec.design.orientation} · {spec.slug}</p>
    <p>기능 {spec.features.join(", ")} · 캐릭터 {spec.assets.characters} · 효과 {spec.assets.vfx} · 모델 {spec.assets.models} · API 상한 ${spec.limits.maxApiCostUsd}</p>
    {notes.length > 0 && <ul className="factory-list">{notes.map(note => <li key={note}>{note}</li>)}</ul>}
  </section>;
}
