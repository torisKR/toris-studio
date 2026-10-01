"use client";

import {
  Check,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  LoaderCircle,
  Mic2,
  MonitorPlay,
  Plus,
  Save,
  Send,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { VideoPreview } from "./VideoPreview";
import { VIDEO_PRESETS } from "@/lib/video/presets";
import { VIDEO_TEMPLATES, applyTemplate } from "@/lib/video/templates";
import { evaluateVideoQuality } from "@/lib/video/quality";
import type {
  VideoFormat,
  VideoProject,
  VideoScene,
  VideoTemplateId
} from "@/lib/video/types";

type Props = {
  initialProject: VideoProject;
};

type Health = {
  storage: "local" | "supabase";
  ttsConfigured: boolean;
  ttsProvider?: string;
  ttsReason?: string | null;
  youtubeConfigured: boolean;
};

function plannerPrompt(project: VideoProject) {
  return `Toris Studio에서 영상 프로젝트를 기획해줘.

목표: ${project.title}
형식: ${VIDEO_PRESETS[project.format].label}
템플릿: ${VIDEO_TEMPLATES[project.template].name}
언어: ${project.language}

요구사항:
- 사실/의견/커뮤니티 반응을 명확히 구분
- 인트로에서 시청 이유를 8초 안에 제시
- 각 장면은 id, role, layout, eyebrow, headline, body, narration, durationSec, sourceLabel, sourceUrl, mediaType, mediaUrl, badge 구조
- role은 hook|point|proof|reaction|cost|action|outro 중 하나
- layout은 hero|split|media-focus|reaction-grid|action-card 중 하나
- 롱폼은 hook → 핵심 포인트 → 공식 근거 화면 → 사용자 반응/반론 → 비용·조건 → 실행 가능한 결론 → takeaway
- 쇼츠는 60초 이하, 8초 이하 hook → benefit/point → 실제 화면/proof → payoff → CTA
- 16:9 롱폼은 hook → context/problem → solution/demo → feature → proof → 조건/반론 → action → takeaway
- adaptive-promo 템플릿은 앱·서비스 홍보에 사용하고 문제→해결→실제 화면→결과→CTA 흐름을 우선하기
- 근거/제품 설명 장면은 가능한 실제 스크린샷·화면 녹화·B-roll을 연결하고 sourceUrl을 넣기
- 과장된 표현과 출처 없는 수치는 피하기
- 현재 프로젝트의 기존 장면을 개선해도 됨

Toris Studio MCP가 연결되어 있다면 studio_save_project 도구로 결과를 직접 저장해줘.
연결되어 있지 않다면 설명 문장 없이 완전한 VideoProject JSON만 반환해줘. project id가 없다면 생략해도 되지만 scene id는 고유 문자열로 반드시 넣어줘.`;
}

function newScene(index: number): VideoScene {
  return {
    id: `scene-${Date.now()}-${index}`,
    eyebrow: `0${index + 1} · POINT`,
    headline: "새 장면의 핵심 문장",
    body: "화면에 보일 보조 설명을 입력하세요.",
    narration: "이 장면에서 읽을 내레이션을 입력하세요.",
    durationSec: 8,
    sourceLabel: "Source",
    mediaType: "none",
    accent: "#77E0B5",
    role: "point",
    layout: "split"
  };
}

export function StudioApp({ initialProject }: Props) {
  const [project, setProject] = useState(initialProject);
  const [selectedSceneId, setSelectedSceneId] = useState(
    initialProject.scenes[0]?.id ?? ""
  );
  const [health, setHealth] = useState<Health | null>(null);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [sttLoading, setSttLoading] = useState(false);
  const [assetUploading, setAssetUploading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [renderUrl, setRenderUrl] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");

  const selectedScene = useMemo(
    () => project.scenes.find((scene) => scene.id === selectedSceneId),
    [project.scenes, selectedSceneId]
  );
  const quality = useMemo(() => evaluateVideoQuality(project), [project]);

  useEffect(() => {
    async function bootstrap() {
      try {
        const [healthResponse, projectsResponse] = await Promise.all([
          fetch("/api/health"),
          fetch("/api/projects")
        ]);

        if (healthResponse.ok) {
          setHealth((await healthResponse.json()) as Health);
        }

        if (projectsResponse.ok) {
          const data = (await projectsResponse.json()) as {
            projects: VideoProject[];
          };
          if (data.projects[0]) {
            setProject(data.projects[0]);
            setSelectedSceneId(data.projects[0].scenes[0]?.id ?? "");
          }
        }
      } catch {
        // Local preview remains usable even before APIs are ready.
      }
    }

    void bootstrap();
  }, []);

  function patchProject(patch: Partial<VideoProject>) {
    setProject((current) => ({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    }));
  }

  function patchScene(patch: Partial<VideoScene>) {
    if (!selectedScene) return;

    patchProject({
      scenes: project.scenes.map((scene) =>
        scene.id === selectedScene.id ? { ...scene, ...patch } : scene
      )
    });
  }

  function changeFormat(format: VideoFormat) {
    patchProject({ format });
    setRenderUrl("");
  }

  function resetFromTemplate(templateId: VideoTemplateId) {
    const next = applyTemplate(templateId, project);
    setProject(next);
    setSelectedSceneId(next.scenes[0]?.id ?? "");
    setRenderUrl("");
    setMessage(`${VIDEO_TEMPLATES[templateId].name} 템플릿 구조를 적용했습니다.`);
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "저장 실패");
      setProject(data.project);
      setMessage("프로젝트를 저장했습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  async function makeVoice() {
    if (!selectedScene) return;
    setTtsLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          sceneId: selectedScene.id,
          text: selectedScene.narration
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "TTS 생성 실패");
      const durationSec = Math.max(
        1,
        Number(((data.durationSec ?? selectedScene.durationSec) + 0.45).toFixed(1))
      );
      patchScene({
        audioPath: data.audioPath,
        durationSec
      });
      setMessage(`현재 장면 음성을 생성하고 길이를 ${durationSec}초로 맞췄습니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "TTS 생성 실패");
    } finally {
      setTtsLoading(false);
    }
  }

  async function transcribeAudio(file: File) {
    setSttLoading(true);
    setMessage("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("language", project.language);

      const response = await fetch("/api/stt", {
        method: "POST",
        body: form
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "STT 변환 실패");
      patchScene({ narration: data.text });
      setMessage("로컬 STT 결과를 현재 장면 내레이션에 반영했습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "STT 변환 실패");
    } finally {
      setSttLoading(false);
    }
  }

  async function uploadMedia(file: File) {
    if (!selectedScene) return;

    setAssetUploading(true);
    setMessage("");
    try {
      const form = new FormData();
      form.set("file", file);

      const response = await fetch("/api/assets", {
        method: "POST",
        body: form
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "미디어 업로드 실패");

      patchScene({
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType
      });
      setMessage(`${file.name}을(를) 현재 장면에 연결했습니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "미디어 업로드 실패");
    } finally {
      setAssetUploading(false);
    }
  }

  async function render() {
    setRendering(true);
    setMessage("Remotion 렌더링 중...");
    setYoutubeUrl("");
    try {
      const response = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "렌더 실패");
      setRenderUrl(data.render.publicUrl);
      setMessage("MP4 렌더링이 완료되었습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "렌더 실패");
    } finally {
      setRendering(false);
    }
  }

  async function uploadYouTube() {
    if (!renderUrl) return;
    setUploading(true);
    setMessage("YouTube 비공개 업로드 중...");
    try {
      const response = await fetch("/api/youtube/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: renderUrl.split("/").pop(),
          title: project.title,
          description: [
            project.subtitle ?? "",
            "",
            "Created with Toris Studio."
          ].join("\n"),
          privacyStatus: "private"
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "YouTube 업로드 실패");
      if (data.video?.id) {
        setYoutubeUrl(`https://www.youtube.com/watch?v=${data.video.id}`);
      }
      setMessage("YouTube에 비공개로 업로드했습니다.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "YouTube 업로드 실패"
      );
    } finally {
      setUploading(false);
    }
  }

  async function copyPlannerPrompt() {
    await navigator.clipboard.writeText(plannerPrompt(project));
    setMessage("ChatGPT 기획 프롬프트를 복사했습니다.");
  }

  async function importProjectJson() {
    try {
      const raw = (await navigator.clipboard.readText()).trim();
      const cleaned = raw
        .replace(/^\`\`\`(?:json)?\s*/i, "")
        .replace(/\s*\`\`\`$/, "");
      const parsed = JSON.parse(cleaned);
      const candidate = parsed.project ?? parsed;

      if (
        !candidate ||
        typeof candidate.title !== "string" ||
        !Array.isArray(candidate.scenes) ||
        candidate.scenes.length === 0 ||
        !["youtube-landscape", "vertical", "shorts"].includes(candidate.format)
      ) {
        throw new Error("VideoProject JSON 형식이 아닙니다.");
      }

      const now = new Date().toISOString();
      const candidateId =
        typeof candidate.id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          candidate.id
        )
          ? candidate.id
          : crypto.randomUUID();

      const imported: VideoProject = {
        ...project,
        ...candidate,
        id: candidateId,
        template: ["reference-briefing", "adaptive-promo"].includes(candidate.template)
          ? candidate.template
          : project.template,
        createdAt: candidate.createdAt ?? now,
        updatedAt: now
      };

      setProject(imported);
      setSelectedSceneId(imported.scenes[0]?.id ?? "");
      setRenderUrl("");
      setMessage("클립보드의 VideoProject JSON을 가져왔습니다.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `JSON 가져오기 실패: ${error.message}`
          : "JSON 가져오기 실패"
      );
    }
  }

  function addScene() {
    const scene = newScene(project.scenes.length);
    patchProject({ scenes: [...project.scenes, scene] });
    setSelectedSceneId(scene.id);
  }

  function removeScene() {
    if (!selectedScene || project.scenes.length <= 1) return;
    const next = project.scenes.filter((scene) => scene.id !== selectedScene.id);
    patchProject({ scenes: next });
    setSelectedSceneId(next[0]?.id ?? "");
  }

  const preset = VIDEO_PRESETS[project.format];

  return (
    <main className="studio">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Clapperboard size={19} />
          </div>
          <div>
            <strong>Toris Studio</strong>
            <span>local-first video automation</span>
          </div>
        </div>

        <div className="top-actions">
          <div className="runtime">
            <span className="runtime-dot" />
            {health?.storage === "supabase"
              ? "Supabase"
              : "Local storage"}
          </div>
          <button className="button ghost" onClick={copyPlannerPrompt}>
            <Sparkles size={17} />
            ChatGPT 기획
          </button>
          <button className="button ghost" onClick={importProjectJson}>
            <Copy size={17} />
            JSON 가져오기
          </button>
          <button className="button" onClick={save} disabled={saving}>
            {saving ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Save size={17} />
            )}
            저장
          </button>
        </div>
      </header>

      <section className="format-strip">
        <div>
          <span className="section-kicker">OUTPUT</span>
          <strong>하나의 프로젝트, 여러 화면비</strong>
        </div>
        <div className="format-buttons">
          {Object.values(VIDEO_PRESETS).map((item) => (
            <button
              key={item.id}
              className={
                project.format === item.id
                  ? "format-button active"
                  : "format-button"
              }
              onClick={() => changeFormat(item.id)}
            >
              <span>{item.label}</span>
              <small>
                {item.width}×{item.height}
              </small>
            </button>
          ))}
          {Object.values(VIDEO_TEMPLATES).map((template) => (
            <button
              key={template.id}
              className={
                project.template === template.id
                  ? "format-button template-button active"
                  : "format-button template-button"
              }
              onClick={() => resetFromTemplate(template.id)}
            >
              <span>{template.name}</span>
              <small>{template.bestFor}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="workspace">
        <aside className="sidebar">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">SCENES</span>
              <strong>{project.scenes.length}개 장면</strong>
            </div>
            <button className="icon-button" onClick={addScene} title="장면 추가">
              <Plus size={18} />
            </button>
          </div>

          <div className="scene-list">
            {project.scenes.map((scene, index) => (
              <button
                key={scene.id}
                className={
                  scene.id === selectedSceneId
                    ? "scene-item active"
                    : "scene-item"
                }
                onClick={() => setSelectedSceneId(scene.id)}
              >
                <span className="scene-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="scene-copy">
                  <strong>{scene.headline}</strong>
                  <small>{scene.durationSec}s · {scene.sourceLabel}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>

          <div className="connector-card">
            <div className="connector-icon">
              <WandSparkles size={19} />
            </div>
            <div>
              <strong>ChatGPT 기획 연결</strong>
              <p>
                별도 LLM API 호출 없이 MCP 또는 JSON 가져오기로 대본·기획을
                프로젝트에 반영합니다.
              </p>
            </div>
            <code>npm run mcp</code>
          </div>
        </aside>

        <section className="preview-column">
          <div className="preview-toolbar">
            <div>
              <span className="section-kicker">LIVE PREVIEW</span>
              <strong>{preset.label}</strong>
            </div>
            <span className="resolution">
              {preset.width} × {preset.height} · {preset.fps}fps
            </span>
          </div>

          <VideoPreview project={project} />

          <div className="quality-card">
            <div className="quality-summary">
              <div>
                <span className="section-kicker">QUALITY CHECK</span>
                <strong>{quality.grade} · {quality.score}/100</strong>
              </div>
              <span>{Math.round(quality.durationSec)}초 · 미디어 {Math.round(quality.mediaCoverage * 100)}% · 출처 {Math.round(quality.sourceCoverage * 100)}%</span>
            </div>
            <div className="quality-checks">
              {quality.checks.map((check) => (
                <div key={check.id} className={check.passed ? "quality-check pass" : "quality-check warn"}>
                  <span>{check.passed ? "✓" : "!"}</span>
                  <div>
                    <strong>{check.label}</strong>
                    <small>{check.detail}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="render-bar">
            <div className="render-state">
              <MonitorPlay size={19} />
              <div>
                <strong>Programmatic Render</strong>
                <span>Remotion · H.264 · AAC</span>
              </div>
            </div>
            <div className="render-actions">
              {renderUrl ? (
                <a
                  className="button ghost"
                  href={renderUrl}
                  download
                  target="_blank"
                >
                  <Download size={17} />
                  MP4
                </a>
              ) : null}
              <button
                className="button primary"
                onClick={render}
                disabled={rendering}
              >
                {rendering ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <Clapperboard size={17} />
                )}
                렌더
              </button>
              <button
                className="button"
                onClick={uploadYouTube}
                disabled={!renderUrl || uploading || !health?.youtubeConfigured}
                title={
                  health?.youtubeConfigured
                    ? "YouTube 비공개 업로드"
                    : "YouTube OAuth 환경변수가 필요합니다"
                }
              >
                {uploading ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <Upload size={17} />
                )}
                YouTube
              </button>
            </div>
          </div>

          {message ? (
            <div className="message">
              <Check size={16} />
              {message}
            </div>
          ) : null}
          {youtubeUrl ? (
            <a
              className="youtube-result"
              href={youtubeUrl}
              target="_blank"
              rel="noreferrer"
            >
              업로드 영상 열기 <ChevronRight size={16} />
            </a>
          ) : null}
        </section>

        <aside className="inspector">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">PROJECT</span>
              <strong>기획·대본</strong>
            </div>
          </div>

          <label className="field">
            <span>제목</span>
            <input
              value={project.title}
              onChange={(event) => patchProject({ title: event.target.value })}
            />
          </label>

          <label className="field">
            <span>부제</span>
            <input
              value={project.subtitle ?? ""}
              onChange={(event) =>
                patchProject({ subtitle: event.target.value })
              }
            />
          </label>

          <div className="divider" />

          {selectedScene ? (
            <>
              <div className="scene-editor-title">
                <div>
                  <span className="section-kicker">SELECTED SCENE</span>
                  <strong>{selectedScene.eyebrow}</strong>
                </div>
                <button
                  className="icon-button danger"
                  onClick={removeScene}
                  disabled={project.scenes.length <= 1}
                  title="장면 삭제"
                >
                  <Trash2 size={17} />
                </button>
              </div>

              <label className="field">
                <span>Eyebrow</span>
                <input
                  value={selectedScene.eyebrow ?? ""}
                  onChange={(event) =>
                    patchScene({ eyebrow: event.target.value })
                  }
                />
              </label>

              <label className="field">
                <span>헤드라인</span>
                <textarea
                  rows={3}
                  value={selectedScene.headline}
                  onChange={(event) =>
                    patchScene({ headline: event.target.value })
                  }
                />
              </label>

              <label className="field">
                <span>화면 설명</span>
                <textarea
                  rows={4}
                  value={selectedScene.body}
                  onChange={(event) => patchScene({ body: event.target.value })}
                />
              </label>

              <label className="field">
                <span>내레이션</span>
                <textarea
                  rows={7}
                  value={selectedScene.narration}
                  onChange={(event) =>
                    patchScene({ narration: event.target.value })
                  }
                />
              </label>

              <div className="inline-fields">
                <label className="field">
                  <span>길이(초)</span>
                  <input
                    type="number"
                    min={1}
                    max={300}
                    step={0.5}
                    value={selectedScene.durationSec}
                    onChange={(event) =>
                      patchScene({
                        durationSec: Math.max(1, Number(event.target.value))
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>출처 라벨</span>
                  <input
                    value={selectedScene.sourceLabel ?? ""}
                    onChange={(event) =>
                      patchScene({ sourceLabel: event.target.value })
                    }
                  />
                </label>
              </div>

              <label className="field">
                <span>출처 URL</span>
                <input
                  value={selectedScene.sourceUrl ?? ""}
                  onChange={(event) =>
                    patchScene({ sourceUrl: event.target.value })
                  }
                  placeholder="https://..."
                />
              </label>

              <div className="inline-fields">
                <label className="field">
                  <span>장면 역할</span>
                  <select
                    value={selectedScene.role ?? "point"}
                    onChange={(event) =>
                      patchScene({ role: event.target.value as VideoScene["role"] })
                    }
                  >
                    <option value="hook">Hook</option>
                    <option value="point">Point</option>
                    <option value="proof">Proof</option>
                    <option value="reaction">Reaction</option>
                    <option value="cost">Cost</option>
                    <option value="action">Action</option>
                    <option value="outro">Outro</option>
                  </select>
                </label>
                <label className="field">
                  <span>레이아웃</span>
                  <select
                    value={selectedScene.layout ?? "split"}
                    onChange={(event) =>
                      patchScene({ layout: event.target.value as VideoScene["layout"] })
                    }
                  >
                    <option value="hero">Hero</option>
                    <option value="split">Split</option>
                    <option value="media-focus">Media Focus</option>
                    <option value="reaction-grid">Reaction Grid</option>
                    <option value="action-card">Action Card</option>
                  </select>
                </label>
              </div>

              <div className="inline-fields">
                <label className="field">
                  <span>미디어</span>
                  <select
                    value={selectedScene.mediaType ?? "none"}
                    onChange={(event) =>
                      patchScene({
                        mediaType: event.target.value as VideoScene["mediaType"]
                      })
                    }
                  >
                    <option value="none">없음</option>
                    <option value="image">이미지</option>
                    <option value="video">영상</option>
                    <option value="screen">화면 녹화</option>
                  </select>
                </label>
                <label className="field">
                  <span>Accent</span>
                  <input
                    type="color"
                    value={selectedScene.accent ?? "#77E0B5"}
                    onChange={(event) =>
                      patchScene({ accent: event.target.value })
                    }
                  />
                </label>
              </div>

              <label className="field">
                <span>미디어 URL / public 경로</span>
                <input
                  value={selectedScene.mediaUrl ?? ""}
                  onChange={(event) =>
                    patchScene({ mediaUrl: event.target.value })
                  }
                  placeholder="/assets/screenshot.png"
                />
              </label>

              <label className="voice-button asset-button">
                {assetUploading ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <Upload size={18} />
                )}
                <span>
                  <strong>이미지 / 영상 업로드</strong>
                  <small>현재 장면의 B-roll·스크린샷·화면 녹화로 연결</small>
                </span>
                <input
                  type="file"
                  accept="image/*,video/*"
                  disabled={assetUploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadMedia(file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>

              <button
                className="voice-button"
                onClick={makeVoice}
                disabled={ttsLoading || !health?.ttsConfigured}
                title={
                  health?.ttsConfigured
                    ? "로컬 Qwen3-TTS Sohee로 현재 장면 음성 생성"
                    : health?.ttsReason ?? "Qwen3-TTS 설정이 필요합니다"
                }
              >
                {ttsLoading ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <Mic2 size={18} />
                )}
                <span>
                  <strong>Qwen3-TTS · Sohee 음성 생성</strong>
                  <small>
                    {selectedScene.audioPath
                      ? "현재 장면에 음성이 연결됨"
                      : health?.ttsConfigured
                        ? "완전 로컬 · 한국어 Sohee · MLX"
                        : health?.ttsReason ?? "TTS 설정 필요"}
                  </small>
                </span>
              </button>

              <label className="voice-button stt-button">
                {sttLoading ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <Upload size={18} />
                )}
                <span>
                  <strong>오디오 → 대본 STT</strong>
                  <small>whisper.cpp 기본 · OpenAI 호환 로컬 ASR 선택 가능</small>
                </span>
                <input
                  type="file"
                  accept="audio/*"
                  disabled={sttLoading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void transcribeAudio(file);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </>
          ) : null}

          <div className="pipeline-card">
            <span className="section-kicker">PIPELINE</span>
            <div><Sparkles size={15} /> ChatGPT 기획/MCP</div>
            <div><Mic2 size={15} /> Qwen3-TTS MLX · Local STT</div>
            <div><Clapperboard size={15} /> Remotion 렌더</div>
            <div><Send size={15} /> YouTube Data API v3</div>
          </div>
        </aside>
      </section>
    </main>
  );
}
