"use client";

import { Player } from "@remotion/player";
import { NewsBriefingVideo } from "@/remotion/templates/NewsBriefingVideo";
import { getDurationInFrames, getPreset } from "@/lib/video/presets";
import type { VideoProject } from "@/lib/video/types";

export function VideoPreview({ project }: { project: VideoProject }) {
  const preset = getPreset(project.format);

  return (
    <div className="preview-shell">
      <Player
        component={NewsBriefingVideo}
        inputProps={{ project }}
        durationInFrames={getDurationInFrames(project.scenes, preset.fps)}
        compositionWidth={preset.width}
        compositionHeight={preset.height}
        fps={preset.fps}
        controls
        loop
        acknowledgeRemotionLicense
        style={{
          width: "100%",
          maxWidth: preset.height > preset.width ? "min(100%, max(240px, calc((100vh - 310px) * 9 / 16)))" : undefined,
          marginInline: "auto",
          aspectRatio: `${preset.width} / ${preset.height}`,
          borderRadius: 22,
          overflow: "hidden",
          background: "#05070b"
        }}
      />
    </div>
  );
}
