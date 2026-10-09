"use client";

import { useState } from "react";
import { EDITING_PRESETS, inspectEditingProject } from "@/lib/video/editing";
import { projectSchema } from "@/lib/video/schema";
import type { EditingPresetId, VideoProject, VideoScene } from "@/lib/video/types";

function MediaSizeInputs({ scene, onChange }: { scene: VideoScene; onChange: (size: VideoScene["mediaSize"]) => void }) {
  const [width, setWidth] = useState(scene.mediaSize?.width.toString() ?? "");
  const [height, setHeight] = useState(scene.mediaSize?.height.toString() ?? "");
  const commit = (w: string, h: string) => {
    if (Number.isInteger(Number(w)) && Number(w) > 0 && Number.isInteger(Number(h)) && Number(h) > 0) onChange({ width: Number(w), height: Number(h) });
    else onChange(undefined);
  };
  return <div className="inline-fields">
    <label className="field"><span>원본 미디어 가로 (px)</span><input type="number" min={1} step={1} value={width} onChange={e => { setWidth(e.target.value); commit(e.target.value, height); }} /></label>
    <label className="field"><span>원본 미디어 세로 (px)</span><input type="number" min={1} step={1} value={height} onChange={e => { setHeight(e.target.value); commit(width, e.target.value); }} /></label>
  </div>;
}

export function EditingControls({ project, scene, onPreset, patchScene }: {
  project: VideoProject; scene?: VideoScene;
  onPreset: (preset: EditingPresetId | undefined) => void;
  patchScene: (patch: Partial<VideoScene>) => void;
}) {
  const [error, setError] = useState("");
  const issues = inspectEditingProject(project);
  return <section aria-label="편집 스타일">
    <label className="field"><span>재사용 편집 프리셋</span>
      <select value={project.editingPreset ?? ""} onChange={e => onPreset((e.target.value || undefined) as EditingPresetId | undefined)}>
        <option value="">기존 디자인</option>
        {Object.entries(EDITING_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
      </select>
    </label>
    {!project.editingPreset ? <p>새 스타일을 선택하면 원본을 보존한 새 프로젝트로 편집합니다.</p> : <>
      <p>고정 자막 · 안전영역 · 화면비별 레이아웃. 실제 UI는 전체 표시를 권장합니다.</p>
      {scene ? <>
        <label className="field"><span>설명 단계 (한 줄에 하나, 2~4개)</span>
          <textarea key={`${scene.id}-steps-${scene.explanationSteps?.join("|")}`} rows={4} defaultValue={scene.explanationSteps?.join("\n") ?? ""} onBlur={e => {
            const steps = e.target.value.split("\n").map(s => s.trim()).filter(Boolean);
            if (steps.length && (steps.length < 2 || steps.length > 4)) { setError("설명 단계는 2~4개로 입력하세요."); return; }
            patchScene({ explanationSteps: steps.length ? steps : undefined }); setError("");
          }} />
        </label>
        <MediaSizeInputs key={scene.id} scene={scene} onChange={mediaSize => patchScene({ mediaSize })} />
        <label className="field"><span>전체 UI 옆에 설명 대상 상세 창 표시</span><input type="checkbox" checked={scene.focusDetail !== false} onChange={e => patchScene({ focusDetail:e.target.checked })} /></label>
        <label className="field"><span>자막 cue JSON (장면 기준 초 · [] 숨김 · 빈칸 자동 초안)</span>
          <textarea key={`${scene.id}-captions-${JSON.stringify(scene.captionCues)}`} rows={6} defaultValue={scene.captionCues ? JSON.stringify(scene.captionCues, null, 2) : ""} onBlur={e => {
            try {
              const captionCues = e.target.value.trim() ? JSON.parse(e.target.value) : undefined;
              const candidate = projectSchema.parse({ ...project, scenes: [{ ...scene, captionCues }] });
              const problems = inspectEditingProject(candidate as VideoProject).filter(i => i.level === "error" && i.message.includes("자막"));
              if (problems.length) throw new Error(problems[0].message);
              patchScene({ captionCues }); setError("");
            } catch (reason) { setError(reason instanceof Error ? reason.message : "자막 JSON을 확인하세요."); }
          }} />
        </label>
        <label className="field"><span>UI 강조 영역 JSON (원본 기준 0~1 좌표)</span>
          <textarea key={`${scene.id}-focus-${JSON.stringify(scene.focusRegion)}`} rows={6} placeholder={'{"x":0.1,"y":0.2,"width":0.4,"height":0.2,"startSec":1,"endSec":3,"label":"이 버튼"}'} defaultValue={scene.focusRegion ? JSON.stringify(scene.focusRegion, null, 2) : ""} onBlur={e => {
            try {
              const focusRegion = e.target.value.trim() ? JSON.parse(e.target.value) : undefined;
              projectSchema.parse({ ...project, scenes: [{ ...scene, focusRegion }] });
              patchScene({ focusRegion }); setError("");
            } catch (reason) { setError(reason instanceof Error ? reason.message : "UI 강조 JSON을 확인하세요."); }
          }} />
        </label>
      </> : null}
      {issues.length ? <ul>{issues.map((issue, i) => <li key={i}>{issue.sceneId} · {issue.level === "error" ? "수정 필요" : "확인"}: {issue.message}</li>)}</ul> : <p>자막·UI 강조 좌표 사전검사 통과. 최종 렌더 프레임도 확인하세요.</p>}
    </>}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
