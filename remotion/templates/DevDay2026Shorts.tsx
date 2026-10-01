import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import { Audio } from "@remotion/media";
import type { CSSProperties } from "react";
import {
  DEVDAY_2026_SCENES,
  DEVDAY_2026_SOURCE,
  type DevDayScene
} from "../../lib/video/devday-2026";

function assetPath(value: string) {
  return staticFile(value.replace(/^\//, ""));
}

function captionChunks(text: string) {
  const sentences =
    text.match(/[^.!?]+[.!?]?/g)?.map((item) => item.trim()).filter(Boolean) ??
    [text];

  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= 34) {
      chunks.push(sentence);
      continue;
    }

    const pieces = sentence
      .split(/(?<=[,·])\s*/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (pieces.length > 1) {
      chunks.push(...pieces);
      continue;
    }

    const midpoint = Math.floor(sentence.length / 2);
    let split = sentence.lastIndexOf(" ", midpoint);
    if (split < 10) split = sentence.indexOf(" ", midpoint);
    if (split > 0) {
      chunks.push(sentence.slice(0, split).trim(), sentence.slice(split).trim());
    } else {
      chunks.push(sentence);
    }
  }
  return chunks;
}

function StarField({ accent }: { accent: string }) {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 300], [0, 34], {
    extrapolateRight: "clamp"
  });

  const stars = Array.from({ length: 44 }, (_, index) => {
    const x = (index * 197 + 83) % 1080;
    const y = (index * 271 + 127) % 1920;
    const size = 2 + (index % 4);
    const opacity = 0.14 + (index % 5) * 0.07;
    return { x, y, size, opacity };
  });

  return (
    <>
      <div
        style={{
          position: "absolute",
          width: 680,
          height: 680,
          right: -260,
          top: 80,
          borderRadius: "50%",
          background: accent,
          filter: "blur(190px)",
          opacity: 0.11
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 520,
          height: 520,
          left: -220,
          bottom: 80,
          borderRadius: "50%",
          background: accent,
          filter: "blur(190px)",
          opacity: 0.07
        }}
      />
      {stars.map((star, index) => (
        <div
          key={index}
          style={{
            position: "absolute",
            left: star.x,
            top: star.y + drift * ((index % 3) - 1),
            width: star.size,
            height: star.size,
            borderRadius: "50%",
            background: index % 7 === 0 ? accent : "#ffffff",
            opacity: star.opacity
          }}
        />
      ))}
    </>
  );
}

function Metric({
  value,
  label,
  accent
}: {
  value: string;
  label: string;
  accent: string;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        padding: "20px 26px",
        borderRadius: 24,
        border: `1px solid ${accent}55`,
        background: `${accent}14`,
        minWidth: 210
      }}
    >
      <strong
        style={{
          fontSize: 58,
          lineHeight: 1,
          color: accent,
          letterSpacing: "-0.05em"
        }}
      >
        {value}
      </strong>
      <span
        style={{
          marginTop: 9,
          fontSize: 15,
          fontWeight: 800,
          letterSpacing: ".11em",
          color: "rgba(255,255,255,.5)"
        }}
      >
        {label}
      </span>
    </div>
  );
}

function DevDaySceneCard({ scene, index }: { scene: DevDayScene; index: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const totalFrames = Math.round(scene.durationSec * fps);
  const enter = spring({
    frame,
    fps,
    config: { damping: 18, stiffness: 115, mass: 0.9 }
  });
  const titleY = interpolate(enter, [0, 1], [52, 0]);
  const assetScale = interpolate(frame, [0, totalFrames], [1.035, 1], {
    extrapolateRight: "clamp"
  });
  const assetRotate = interpolate(frame, [0, totalFrames], [-1.2, 1.2], {
    extrapolateRight: "clamp"
  });
  const fadeOut = interpolate(
    frame,
    [Math.max(0, totalFrames - 10), totalFrames - 1],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const captions = captionChunks(scene.narration);
  const captionIndex = Math.min(
    captions.length - 1,
    Math.floor((frame / Math.max(1, totalFrames)) * captions.length)
  );

  const isHook = scene.id === "hook";

  return (
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(145deg,#04060A 0%,#090D14 55%,#05070B 100%)",
        color: "#F7F9FC",
        fontFamily:
          '"Pretendard Variable", Pretendard, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        overflow: "hidden",
        opacity: fadeOut
      }}
    >
      <StarField accent={scene.accent} />

      <div
        style={{
          position: "absolute",
          top: 52,
          left: 58,
          right: 58,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          zIndex: 10
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 850,
            letterSpacing: ".12em",
            color: scene.accent
          }}
        >
          {scene.kicker}
        </div>
        <div
          style={{
            fontSize: 16,
            fontWeight: 750,
            color: "rgba(255,255,255,.35)"
          }}
        >
          {String(index + 1).padStart(2, "0")} /{" "}
          {String(DEVDAY_2026_SCENES.length).padStart(2, "0")}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 58,
          right: 58,
          top: isHook ? 170 : 150,
          transform: `translateY(${titleY}px)`,
          zIndex: 8
        }}
      >
        <h1
          style={{
            margin: 0,
            maxWidth: 930,
            whiteSpace: "pre-line",
            fontSize: isHook ? 78 : 70,
            lineHeight: 1.08,
            letterSpacing: "-.055em",
            fontWeight: 900,
            wordBreak: "keep-all"
          }}
        >
          {scene.title}
        </h1>

        <p
          style={{
            margin: "26px 0 0",
            maxWidth: 900,
            fontSize: 28,
            lineHeight: 1.5,
            fontWeight: 600,
            letterSpacing: "-.025em",
            color: "rgba(247,249,252,.62)",
            wordBreak: "keep-all"
          }}
        >
          {scene.body}
        </p>

        {scene.metric && scene.metricLabel ? (
          <div style={{ marginTop: 28 }}>
            <Metric
              value={scene.metric}
              label={scene.metricLabel}
              accent={scene.accent}
            />
          </div>
        ) : null}
      </div>

      <div
        style={{
          position: "absolute",
          left: isHook ? 125 : 105,
          right: isHook ? 125 : 105,
          top: isHook ? 670 : scene.metric ? 790 : 665,
          height: isHook ? 790 : scene.metric ? 655 : 790,
          display: "grid",
          placeItems: "center"
        }}
      >
        <Img
          src={assetPath(scene.asset)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            transform: `scale(${assetScale}) rotate(${assetRotate}deg)`,
            filter: "drop-shadow(0 32px 70px rgba(0,0,0,.38))"
          }}
        />
      </div>

      <div
        style={{
          position: "absolute",
          left: 54,
          right: 54,
          bottom: 118,
          display: "flex",
          justifyContent: "center",
          zIndex: 20
        }}
      >
        <div
          style={{
            maxWidth: 930,
            padding: "16px 24px",
            borderRadius: 18,
            background: "rgba(2,4,8,.82)",
            border: "1px solid rgba(255,255,255,.09)",
            boxShadow: "0 18px 50px rgba(0,0,0,.32)",
            fontSize: 31,
            lineHeight: 1.42,
            textAlign: "center",
            fontWeight: 760,
            letterSpacing: "-.026em",
            wordBreak: "keep-all"
          }}
        >
          {captions[captionIndex]}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 58,
          right: 58,
          bottom: 48,
          display: "grid",
          gap: 12
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 20,
            color: "rgba(255,255,255,.32)",
            fontSize: 14,
            fontWeight: 700
          }}
        >
          <span>Source · GeekNews GN#34505 / OpenAI DevDay 2026</span>
          <span>TORIS STUDIO</span>
        </div>
        <div
          style={{
            height: 4,
            borderRadius: 999,
            background: "rgba(255,255,255,.07)",
            overflow: "hidden"
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${((index + 1) / DEVDAY_2026_SCENES.length) * 100}%`,
              borderRadius: 999,
              background: scene.accent
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
}

export function DevDay2026Shorts() {
  const { fps } = useVideoConfig();
  let from = 0;

  return (
    <AbsoluteFill style={{ background: "#04060A" }}>
      {DEVDAY_2026_SCENES.map((scene, index) => {
        const durationInFrames = Math.max(1, Math.round(scene.durationSec * fps));
        const start = from;
        from += durationInFrames;

        return (
          <Sequence
            key={scene.id}
            from={start}
            durationInFrames={durationInFrames}
          >
            <DevDaySceneCard scene={scene} index={index} />
            <Audio
              src={staticFile(`devday-2026/audio/${scene.id}.wav`)}
              volume={1}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
