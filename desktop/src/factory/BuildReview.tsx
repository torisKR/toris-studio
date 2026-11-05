import { gateLabel, gateStatusLabel, verdictLabel, type FactoryReport } from "./factory-client";

export function BuildReview({ report }: { report: FactoryReport }) {
  return <div aria-label="빌드와 검증">
    <h2>검증 · {verdictLabel(report.verdict)}</h2>
    <p>{report.template ? "이 명세는 규칙으로 만들었습니다. AI 결과가 아닙니다." : `모델 명세 · ${report.provider || "공급자 없음"} ${report.model}`}</p>
    <p className="factory-note">기록된 API 지출 ${report.costUsd.toFixed(2)}. 실행하지 않은 Android·에셋 검사는 통과가 아닙니다. 서명과 스토어 제출은 이 화면에서 실행하지 않습니다.</p>
    <ul className="factory-list">
      {report.gates.map(gate => <li key={gate.name} className={`factory-gate ${gate.status}`} data-status={gate.status}><strong>{gateLabel(gate.name)}</strong><small className="factory-status">{gateStatusLabel(gate.status)}{gate.required ? "" : " · 선택"}</small><small>{gate.detail}</small></li>)}
    </ul>
    {report.problems.length > 0 && <ul className="factory-list">{report.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
  </div>;
}
