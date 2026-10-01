import {
  AbsoluteFill,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import { Audio } from "@remotion/media";
import type { CSSProperties, ReactNode } from "react";
import type { VideoProject, VideoScene } from "../../lib/video/types";
import { SocialFocusScene } from "./SocialFocusScene";

type Props = { project: VideoProject };

function mediaSource(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  return staticFile(url.replace(/^\//, ""));
}

function makeCaptionChunks(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let current = "";

  for (const token of normalized.split(" ")) {
    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function GlassCard({
  children,
  style
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        border: "1px solid rgba(255,255,255,.11)",
        background: "linear-gradient(145deg, rgba(255,255,255,.08), rgba(255,255,255,.025))",
        boxShadow: "0 30px 90px rgba(0,0,0,.34)",
        ...style
      }}
    >
      {children}
    </div>
  );
}

function MediaFrame({
  scene,
  vertical,
  scale
}: {
  scene: VideoScene;
  vertical: boolean;
  scale: number;
}) {
  const radius = vertical ? 38 : 28;
  const hasMedia = Boolean(
    scene.mediaUrl && scene.mediaType && scene.mediaType !== "none"
  );

  if (!hasMedia) {
    return (
      <GlassCard
        style={{
          width: "100%",
          height: "100%",
          borderRadius: radius,
          overflow: "hidden",
          position: "relative",
          transform: `scale(${scale})`
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 22% 20%, rgba(119,224,181,.2), transparent 30%), radial-gradient(circle at 74% 70%, rgba(138,216,255,.18), transparent 32%), #0B1018"
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "9%",
            right: "9%",
            top: "10%",
            height: "12%",
            display: "flex",
            gap: 12
          }}
        >
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              style={{
                flex: item === 1 ? 1.8 : 1,
                borderRadius: 18,
                background: "rgba(255,255,255,.055)"
              }}
            />
          ))}
        </div>
        <div
          style={{
            position: "absolute",
            left: "9%",
            right: "9%",
            top: "27%",
            bottom: "10%",
            borderRadius: 26,
            border: "1px solid rgba(255,255,255,.08)",
            background: "rgba(255,255,255,.025)",
            padding: "8%"
          }}
        >
          <div
            style={{
              color: scene.accent ?? "#77E0B5",
              fontWeight: 850,
              letterSpacing: ".14em",
              fontSize: vertical ? 24 : 18
            }}
          >
            {scene.badge ?? scene.sourceLabel ?? "SOURCE"}
          </div>
          <div
            style={{
              marginTop: 28,
              width: "78%",
              height: 18,
              borderRadius: 999,
              background: "rgba(255,255,255,.13)"
            }}
          />
          <div
            style={{
              marginTop: 16,
              width: "58%",
              height: 18,
              borderRadius: 999,
              background: "rgba(255,255,255,.08)"
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "8%",
              right: "8%",
              bottom: "10%",
              height: "35%",
              borderRadius: 24,
              background:
                `linear-gradient(135deg, ${scene.accent ?? "#77E0B5"}30, rgba(255,255,255,.025))`
            }}
          />
        </div>
      </GlassCard>
    );
  }

  const src = mediaSource(scene.mediaUrl!);
  const common: CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: scene.mediaFit ?? "contain",
    transform: scene.mediaFit === "cover" ? `scale(${scale})` : undefined
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        borderRadius: radius,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,.12)",
        boxShadow: "0 30px 90px rgba(0,0,0,.4)",
        background: "#080B11"
      }}
    >
      {scene.mediaType === "video" || scene.mediaType === "screen" ? (
        <OffthreadVideo muted src={src} style={common} />
      ) : (
        <Img src={src} style={common} />
      )}
    </div>
  );
}

function HeadlineBlock({
  scene,
  vertical,
  lift,
  align = "left"
}: {
  scene: VideoScene;
  vertical: boolean;
  lift: number;
  align?: "left" | "center";
}) {
  const center = align === "center";
  return (
    <section
      style={{
        transform: `translateY(${lift}px)`,
        textAlign: align,
        maxWidth: center ? (vertical ? 900 : 1280) : vertical ? 900 : 820,
        margin: center ? "0 auto" : undefined
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 14,
          marginBottom: vertical ? 26 : 20,
          padding: vertical ? "10px 16px" : "8px 13px",
          borderRadius: 999,
          border: `1px solid ${scene.accent ?? "#77E0B5"}55`,
          background: `${scene.accent ?? "#77E0B5"}14`,
          color: scene.accent ?? "#77E0B5",
          fontSize: vertical ? 22 : 16,
          fontWeight: 850,
          letterSpacing: ".08em"
        }}
      >
        {scene.sourceLabel ?? scene.eyebrow ?? "BRIEFING"}
      </div>
      <h1
        style={{
          margin: 0,
          fontSize: center
            ? vertical
              ? 82
              : 82
            : vertical
              ? 72
              : 62,
          lineHeight: 1.08,
          letterSpacing: "-0.052em",
          fontWeight: 900,
          wordBreak: "keep-all"
        }}
      >
        {scene.headline}
      </h1>
      <p
        style={{
          margin: vertical ? "30px 0 0" : "24px 0 0",
          fontSize: vertical ? 31 : 25,
          lineHeight: 1.52,
          letterSpacing: "-0.025em",
          color: "rgba(247,249,252,.68)",
          wordBreak: "keep-all"
        }}
      >
        {scene.body}
      </p>
    </section>
  );
}

function ReactionGrid({
  scene,
  vertical
}: {
  scene: VideoScene;
  vertical: boolean;
}) {
  const items = [
    { label: "EXPECTATION", text: "시간 절감 · 반복 업무 자동화" },
    { label: "CONCERN", text: "비용 · 권한 · 실패 시 통제" },
    { label: "CHECK", text: "실사용 로그로 효과 검증" }
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: vertical ? "1fr" : "repeat(3, 1fr)",
        gap: vertical ? 18 : 20
      }}
    >
      {items.map((item, index) => (
        <GlassCard
          key={item.label}
          style={{
            borderRadius: vertical ? 28 : 22,
            padding: vertical ? "28px 30px" : "28px",
            minHeight: vertical ? 120 : 210,
            transform: `translateY(${index * 8}px)`
          }}
        >
          <div
            style={{
              color: index === 0 ? scene.accent : "rgba(247,249,252,.44)",
              fontSize: vertical ? 20 : 15,
              fontWeight: 850,
              letterSpacing: ".12em"
            }}
          >
            {item.label}
          </div>
          <div
            style={{
              marginTop: vertical ? 14 : 28,
              fontSize: vertical ? 30 : 27,
              lineHeight: 1.3,
              fontWeight: 780,
              letterSpacing: "-.035em"
            }}
          >
            {item.text}
          </div>
        </GlassCard>
      ))}
    </div>
  );
}

function ActionCard({
  scene,
  vertical
}: {
  scene: VideoScene;
  vertical: boolean;
}) {
  const actions = ["작은 업무 1개 선택", "시간·실패율 기록", "월 비용과 비교"];
  return (
    <GlassCard
      style={{
        borderRadius: vertical ? 36 : 28,
        padding: vertical ? "34px" : "36px 40px"
      }}
    >
      {actions.map((action, index) => (
        <div
          key={action}
          style={{
            display: "flex",
            alignItems: "center",
            gap: vertical ? 22 : 18,
            padding: vertical ? "20px 0" : "16px 0",
            borderBottom:
              index === actions.length - 1
                ? "none"
                : "1px solid rgba(255,255,255,.08)"
          }}
        >
          <div
            style={{
              width: vertical ? 52 : 42,
              height: vertical ? 52 : 42,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              flex: "0 0 auto",
              background: scene.accent ?? "#77E0B5",
              color: "#07100D",
              fontSize: vertical ? 23 : 18,
              fontWeight: 900
            }}
          >
            {index + 1}
          </div>
          <span
            style={{
              fontSize: vertical ? 30 : 25,
              fontWeight: 760,
              letterSpacing: "-.03em"
            }}
          >
            {action}
          </span>
        </div>
      ))}
    </GlassCard>
  );
}

function Scene({
  scene,
  index,
  sceneCount,
  projectTitle
}: {
  scene: VideoScene;
  index: number;
  sceneCount: number;
  projectTitle: string;
}) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const vertical = height > width;
  const totalFrames = Math.max(1, Math.round(scene.durationSec * fps));
  const enter = spring({
    fps,
    frame,
    config: { damping: 18, stiffness: 125, mass: 0.9 }
  });
  const lift = interpolate(enter, [0, 1], [44, 0]);
  const fadeOut = interpolate(
    frame,
    [Math.max(0, totalFrames - 10), totalFrames - 1],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const scale = interpolate(frame, [0, totalFrames], [1.045, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad)
  });
  const pagePad = vertical ? 64 : 82;
  const captions = makeCaptionChunks(scene.narration, vertical ? 24 : 42);
  const captionIndex = Math.min(
    Math.max(0, captions.length - 1),
    Math.floor((frame / totalFrames) * captions.length)
  );
  const caption = scene.captionCues
    ? scene.captionCues.find(cue => frame / fps >= cue.startSec && frame / fps < cue.endSec)?.text ?? ""
    : captions[captionIndex] ?? "";
  const layout = scene.layout ?? "split";

  let content: ReactNode;
  if (layout === "hero") {
    content = (
      <div
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          padding: vertical ? "0 20px 220px" : "0 100px 110px"
        }}
      >
        <HeadlineBlock scene={scene} vertical={vertical} lift={lift} align="center" />
      </div>
    );
  } else if (layout === "media-focus") {
    content = (
      <div
        style={{
          display: "grid",
          gridTemplateRows: vertical ? "auto 1fr" : undefined,
          gridTemplateColumns: vertical ? undefined : ".72fr 1.28fr",
          gap: vertical ? 36 : 54,
          alignItems: "center",
          height: "100%",
          paddingBottom: vertical ? 190 : 92
        }}
      >
        <HeadlineBlock scene={scene} vertical={vertical} lift={lift} />
        <div style={{ height: vertical ? 780 : 650 }}>
          <MediaFrame scene={scene} vertical={vertical} scale={scale} />
        </div>
      </div>
    );
  } else if (layout === "reaction-grid") {
    content = (
      <div
        style={{
          display: "grid",
          gridTemplateRows: "auto auto",
          gap: vertical ? 42 : 52,
          alignContent: "center",
          height: "100%",
          paddingBottom: vertical ? 190 : 92
        }}
      >
        <HeadlineBlock scene={scene} vertical={vertical} lift={lift} />
        <ReactionGrid scene={scene} vertical={vertical} />
      </div>
    );
  } else if (layout === "action-card") {
    content = (
      <div
        style={{
          display: "grid",
          gridTemplateRows: vertical ? "auto auto" : undefined,
          gridTemplateColumns: vertical ? undefined : "1fr .92fr",
          gap: vertical ? 42 : 60,
          alignItems: "center",
          height: "100%",
          paddingBottom: vertical ? 190 : 92
        }}
      >
        <HeadlineBlock scene={scene} vertical={vertical} lift={lift} />
        <ActionCard scene={scene} vertical={vertical} />
      </div>
    );
  } else {
    content = (
      <div
        style={{
          display: "grid",
          gridTemplateRows: vertical ? "auto 1fr" : undefined,
          gridTemplateColumns: vertical ? undefined : "1fr .92fr",
          gap: vertical ? 40 : 64,
          alignItems: "center",
          height: "100%",
          paddingBottom: vertical ? 190 : 92
        }}
      >
        <HeadlineBlock scene={scene} vertical={vertical} lift={lift} />
        <div style={{ height: vertical ? 700 : 600 }}>
          <MediaFrame scene={scene} vertical={vertical} scale={scale} />
        </div>
      </div>
    );
  }

  return (
    <AbsoluteFill
      style={{
        color: "#F7F9FC",
        background:
          "radial-gradient(circle at 10% 0%, rgba(74,98,132,.26), transparent 38%), linear-gradient(135deg,#05070B 0%,#0B1019 58%,#080A0F 100%)",
        fontFamily:
          '"Pretendard Variable", Pretendard, "Noto Sans CJK KR", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: pagePad,
        overflow: "hidden",
        opacity: fadeOut
      }}
    >
      <div
        style={{
          position: "absolute",
          width: vertical ? 620 : 720,
          height: vertical ? 620 : 720,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${scene.accent ?? "#77E0B5"}, transparent 70%)`,
          opacity: 0.08,
          right: vertical ? -300 : -220,
          top: vertical ? 80 : -320
        }}
      />
      <header
        style={{
          height: 46,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: vertical ? 21 : 16,
          letterSpacing: ".14em",
          color: "rgba(247,249,252,.46)",
          fontWeight: 750
        }}
      >
        <span>{scene.eyebrow ?? "TORIS STUDIO"}</span>
        <span>
          {String(index + 1).padStart(2, "0")} / {String(sceneCount).padStart(2, "0")}
        </span>
      </header>

      <div style={{ flex: 1 }}>{content}</div>

      {caption ? (
        <div
          style={{
            position: "absolute",
            left: pagePad,
            right: pagePad,
            bottom: vertical ? 240 : 90,
            display: "flex",
            justifyContent: "center"
          }}
        >
          <div
            style={{
              maxWidth: vertical ? 900 : 1220,
              padding: vertical ? "16px 24px" : "12px 20px",
              borderRadius: vertical ? 18 : 14,
              background: "rgba(3,5,9,.8)",
              border: "1px solid rgba(255,255,255,.1)",
              boxShadow: "0 16px 50px rgba(0,0,0,.35)",
              fontSize: vertical ? 44 : 36,
              lineHeight: 1.42,
              letterSpacing: "-.025em",
              fontWeight: 760,
              textAlign: "center"
            }}
          >
            {caption}
          </div>
        </div>
      ) : null}

      <footer
        style={{
          position: "absolute",
          left: pagePad,
          right: pagePad,
          bottom: vertical ? 44 : 34,
          display: "grid",
          gap: 12
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            color: "rgba(247,249,252,.36)",
            fontSize: vertical ? 19 : 15
          }}
        >
          <span>{projectTitle}</span>
          <span>{scene.sourceLabel ?? (scene.sourceUrl ? "SOURCE LINK" : "TORIS STUDIO")}</span>
        </div>
        <div
          style={{
            height: 4,
            borderRadius: 999,
            overflow: "hidden",
            background: "rgba(255,255,255,.07)"
          }}
        >
          <div
            style={{
              width: `${((index + 1) / sceneCount) * 100}%`,
              height: "100%",
              borderRadius: 999,
              background: scene.accent ?? "#77E0B5"
            }}
          />
        </div>
      </footer>
    </AbsoluteFill>
  );
}

export function NewsBriefingVideo({ project }: Props) {
  const { fps } = useVideoConfig();
  let cursor = 0;

  return (
    <AbsoluteFill style={{ background: "#05070B" }}>
      {project.scenes.map((scene, index) => {
        const from = cursor;
        const duration = Math.max(1, Math.round(scene.durationSec * fps));
        cursor += duration;
        return (
          <Sequence key={scene.id} from={from} durationInFrames={duration}>
            {scene.layout?.startsWith("social-") ? <SocialFocusScene scene={scene} /> : <Scene
              scene={scene}
              index={index}
              sceneCount={project.scenes.length}
              projectTitle={project.title}
            />}
            {scene.audioPath ? (
              <Audio src={mediaSource(scene.audioPath)} volume={1} />
            ) : null}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
