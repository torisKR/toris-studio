import { AbsoluteFill, Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { VideoScene } from "../../lib/video/types";

export const SOCIAL_SAFE_AREA = { left: 88, right: 224, top: 220, bottom: 360 };

export function getSocialCaption(scene: VideoScene, time: number) {
  // An explicit empty list suppresses captions; importing new audio clears the
  // old cues and falls back to the current narration until timings are edited.
  if (scene.captionCues !== undefined) {
    return scene.captionCues.find(cue => time >= cue.startSec && time < cue.endSec)?.text ?? "";
  }
  const chunks: string[] = [];
  let current = "";
  for (const word of scene.narration.trim().split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > 26) {
      chunks.push(current);
      current = word;
    } else current = candidate;
  }
  if (current) chunks.push(current);
  const index = Math.min(chunks.length - 1, Math.floor(Math.max(0, time) / scene.durationSec * chunks.length));
  return chunks[index] ?? "";
}

/** Deliberately reserves the right icon rail and bottom caption/navigation area.
 * These are conservative editorial margins, not a platform guarantee.
 */
export function SocialFocusScene({ scene }: { scene: VideoScene }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const time = frame / fps;
  const emphasis = scene.layout === "social-hook" || scene.layout === "social-cta";
  const caption = getSocialCaption(scene, time);
  const accent = emphasis ? "#8EFFCA" : "#A8BED8";
  const media = scene.mediaType && scene.mediaType !== "none" && scene.mediaUrl && (/^https?:\/\//i.test(scene.mediaUrl) ? scene.mediaUrl : staticFile(scene.mediaUrl.replace(/^\//, "")));
  return (
    <AbsoluteFill style={{ background: "linear-gradient(155deg,#101c22,#05090e 68%)", color: "#F4F8FA", fontFamily: '"Noto Sans CJK KR", sans-serif' }}>
      <div style={{ position: "absolute", left: 58, top: 220, bottom: 360, width: 5, background: emphasis ? "#8EFFCA" : "#294154" }} />
      <section data-social-safe-content style={{ position: "absolute", ...SOCIAL_SAFE_AREA, display: "flex", flexDirection: "column", justifyContent: emphasis ? "center" : "flex-start" }}>
        <div style={{ color: accent, fontSize: 25, fontWeight: 700, letterSpacing: "0.06em", marginBottom: emphasis ? 42 : 28 }}>{scene.eyebrow}</div>
        <h1 style={{ margin: 0, whiteSpace: "pre-line", wordBreak: "keep-all", fontSize: emphasis ? (scene.layout === "social-hook" ? 110 : 84) : 62, fontWeight: 900, letterSpacing: "-0.045em", lineHeight: 1.2 }}>
          {scene.headline}
        </h1>
        {scene.body && <p style={{ whiteSpace: "pre-line", wordBreak: "keep-all", fontSize: emphasis ? 28 : 27, lineHeight: 1.6, color: "#A4B3BE", marginTop: 32 }}>{scene.body}</p>}
        {!emphasis && media && <div style={{ width: "100%", height: 500, marginTop: 30, flexShrink: 0, overflow: "hidden" }}>
          {scene.mediaType === "video" || scene.mediaType === "screen"
            ? <OffthreadVideo muted src={media} style={{ objectFit: scene.mediaFit ?? "contain", width: "100%", height: "100%" }} />
            : <Img src={media} style={{ objectFit: scene.mediaFit ?? "contain", width: "100%", height: "100%" }} />}
        </div>}
        {emphasis && <div style={{ width: scene.layout === "social-hook" ? 130 : 230, height: 10, marginTop: 48, borderRadius: 5, background: accent }} />}
      </section>
      {!emphasis && caption && <div data-social-caption style={{ position: "absolute", left: 88, right: 224, bottom: 382, padding: "20px 24px", background: "#03070B", border: "1px solid #294154", borderRadius: 18, fontSize: 38, lineHeight: 1.5, fontWeight: 700, textAlign: "left", whiteSpace: "pre-line", wordBreak: "keep-all" }}>{caption}</div>}
      <div style={{ position: "absolute", left: 88, right: 224, bottom: 286, fontSize: 22, color: "#7D919F", lineHeight: 1.6 }}>TORIS STUDIO · 검토용 · 외부 게시 전</div>
    </AbsoluteFill>
  );
}
