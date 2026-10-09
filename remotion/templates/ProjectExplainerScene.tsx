import { AbsoluteFill, Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { CSSProperties } from "react";
import { attentionAtFrame, captionAtFrame, projectCaptionTypography, EDITING_PRESETS, fitMedia, fitText, focusPixels, focusDetailProjection, getMediaPanels, getEditingLayout, type PixelRect } from "../../lib/video/editing";
import { getPreset } from "../../lib/video/presets";
import type { VideoProject, VideoScene } from "../../lib/video/types";

const source = (url: string) => /^https?:\/\//i.test(url) ? url : staticFile(url.replace(/^\//, ""));
const rectStyle = (r: PixelRect): CSSProperties => ({ position: "absolute", left: r.x, top: r.y, width: r.width, height: r.height, boxSizing: "border-box" });

function TextBox({ text, box, max, min, lines, padding = 0, style, region }: {
  text: string; box: PixelRect; max: number; min: number; lines: number; padding?: number; style?: CSSProperties; region?: string;
}) {
  const fit = fitText(text, box, max, min, lines, padding);
  return <div data-editing-region={region} style={{ ...rectStyle(box), fontSize: fit.fontSize, lineHeight: `${fit.lineHeight}px`, padding, whiteSpace: "pre", fontWeight: 700, ...style }}>{fit.lines.join("\n")}</div>;
}

function SceneMedia({scene, box}: {scene:VideoScene; box:PixelRect}) {
  return scene.mediaType === "video" || scene.mediaType === "screen"
    ? <OffthreadVideo muted src={source(scene.mediaUrl!)} style={rectStyle(box)} />
    : <Img src={source(scene.mediaUrl!)} style={rectStyle(box)} />;
}

/** Opt-in scene: captions and UI never inherit camera/entrance transforms. */
export function ProjectExplainerFrame({ project, scene, index, frame, fps, outputScale = 1 }: { project: VideoProject; scene: VideoScene; index: number; frame: number; fps: number; outputScale?:number }) {
  const layout = getEditingLayout(project.format, outputScale), px = (n:number) => Math.round(n * outputScale);
  const motion = EDITING_PRESETS[project.editingPreset!].motion;
  const accent = scene.accent ?? "#77E0B5";
  const caption = captionAtFrame(scene, project.format, frame, fps);
  const typography = projectCaptionTypography(project, outputScale);
  const attention = attentionAtFrame(scene, frame, fps, motion);
  const hasMedia = Boolean(scene.mediaUrl && scene.mediaType && scene.mediaType !== "none");
  const panels = getMediaPanels(scene, layout.media, outputScale);
  const target = focusPixels(scene, panels.overview);
  const fittedMedia = scene.mediaSize ? fitMedia(panels.overview, scene.mediaSize, scene.mediaFit ?? "contain") : panels.overview;
  const detail = panels.detail && focusDetailProjection(scene, panels.detail);
  const steps = scene.explanationSteps ?? [];
  const activeStep = Math.min(steps.length - 1, Math.floor(frame / Math.max(1, scene.durationSec * fps) * steps.length));
  const relative = (r:PixelRect, parent:PixelRect):PixelRect => ({...r,x:r.x - parent.x,y:r.y - parent.y});
  const highlight = (r:PixelRect, region:string) => attention > 0 ? <div key={region} data-editing-region={region} style={{...rectStyle(r), border:`${Math.min(px(4),r.width,r.height)}px solid ${accent}`,borderRadius:px(8),opacity:attention,overflow:"hidden"}}>
    <div style={{position:"absolute",inset:0,border:`${Math.max(1,px(2))}px solid #F7F9FC`,boxSizing:"border-box",borderRadius:px(4)}} />
    <div style={{position:"absolute",left:Math.max(0,Math.min(r.width - px(20),px(24 * attention))),top:Math.max(0,Math.min(r.height - px(20),px(24 * attention))),width:px(12),height:px(12),borderRadius:px(6),background:"#F7F9FC",border:"1px solid #080D18",boxSizing:"border-box"}} />
  </div> : null;

  return <AbsoluteFill style={{ color: "#F7F9FC", background: "#080D18", fontFamily: '"Noto Sans CJK KR", Pretendard, sans-serif', overflow: "hidden" }}>
    <AbsoluteFill style={{ backgroundImage: "linear-gradient(#1B2637 1px, transparent 1px), linear-gradient(90deg, #1B2637 1px, transparent 1px)", backgroundSize: `${px(48)}px ${px(48)}px`, opacity: 0.35 }} />
    <div style={{ ...rectStyle({ x: layout.safe.x, y: layout.safe.y, width: layout.safe.width, height:px(44) }), borderLeft: `${px(6)}px solid ${accent}`, paddingLeft:px(18), fontSize:px(24), lineHeight:`${px(36)}px`, fontWeight: 700, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
      {String(index + 1).padStart(2, "0")} / {String(project.scenes.length).padStart(2, "0")} · {attention ? scene.focusRegion?.label : scene.eyebrow ?? scene.sourceLabel ?? "PROJECT WALKTHROUGH"}
    </div>
    <TextBox region="heading" text={scene.headline} box={layout.heading} max={layout.headingFont} min={px(40)} lines={3} style={{ fontWeight: 900, color: "#FFFFFF" }} />
    <TextBox region="body" text={scene.body} box={layout.body} max={layout.bodyFont} min={px(24)} lines={4} style={{ color: "#B7C6DA", fontWeight: 500 }} />
    <div data-editing-region="media" style={{...rectStyle(layout.media),background:"#101A2A",borderRadius:px(24),overflow:"hidden"}} />
    {hasMedia ? <>
      {detail ? <>
        <div style={{...rectStyle({x:panels.overview.x,y:layout.media.y + px(16),width:panels.overview.width,height:px(36)}),fontSize:px(24),fontWeight:700}}>전체 UI</div>
        <div style={{...rectStyle({x:panels.detail!.x,y:layout.media.y + px(16),width:panels.detail!.width,height:px(36)}),fontSize:px(24),fontWeight:700}}>부분 확대</div>
      </> : null}
      <div data-editing-region="overview" style={{...rectStyle(panels.overview),overflow:"hidden"}}>
        {scene.mediaSize ? <SceneMedia scene={scene} box={relative(fittedMedia,panels.overview)} /> : (scene.mediaType === "video" || scene.mediaType === "screen"
          ? <OffthreadVideo muted src={source(scene.mediaUrl!)} style={{width:"100%",height:"100%",objectFit:scene.mediaFit ?? "contain"}} />
          : <Img src={source(scene.mediaUrl!)} style={{width:"100%",height:"100%",objectFit:scene.mediaFit ?? "contain"}} />)}
      </div>
      {detail ? <div data-editing-region="detail" style={{...rectStyle(detail.viewport),overflow:"hidden",borderRadius:px(8)}}><SceneMedia scene={scene} box={relative(detail.media,detail.viewport)} /></div> : null}
    </> : steps.length ? <div style={rectStyle(layout.media)}>{steps.map((step, i) => {
          const rowHeight = Math.floor((layout.media.height - px(96)) / steps.length);
          const row = { x:px(32), y:px(32) + i * rowHeight, width:layout.media.width - px(64), height:rowHeight - px(20) };
          const active = !motion || activeStep === i;
          return <div key={i} data-editing-region={`step-${i+1}`} style={{...rectStyle(row),border:`${px(2)}px solid ${active ? accent : "#304259"}`,borderRadius:px(16),background:active ? "#1B3144" : "#152235"}}>
            <div style={{position:"absolute",left:px(24),top:px(12),color:accent,fontSize:px(20),fontWeight:800}}>STEP {i + 1}</div>
            <TextBox text={step} box={{x:px(24),y:px(42),width:row.width - px(48),height:px(70)}} max={px(32)} min={px(24)} lines={2} />
          </div>;
        })}</div> : <div style={{...rectStyle(layout.media),display:"grid",placeItems:"center",fontSize:px(28),color:"#9CB1CA"}}>실제 화면 또는 설명 단계를 연결하세요</div>}
    {target ? highlight(target,"focus-overview") : null}
    {detail ? highlight(detail.focus,"focus-detail") : null}
    <div data-editing-region="media-border" style={{...rectStyle(layout.media),border:`${Math.max(1,px(2))}px solid #2B3F58`,borderRadius:px(24),pointerEvents:"none"}} />
    {caption ? <TextBox region="caption" text={caption} box={layout.caption} max={typography.fontSize} min={typography.fontSize} lines={2} padding={px(16)} style={{background:"#050912F2",borderRadius:px(16),textAlign:"center",fontWeight:800,lineHeight:`${typography.lineHeight}px`}} /> : null}
  </AbsoluteFill>;
}

export function ProjectExplainerScene(props: { project: VideoProject; scene: VideoScene; index: number }) {
  const frame = useCurrentFrame();
  const {fps,width} = useVideoConfig();
  return <ProjectExplainerFrame {...props} frame={frame} fps={fps} outputScale={width / getPreset(props.project.format).width} />;
}
