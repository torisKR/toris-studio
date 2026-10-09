import { Composition } from "remotion";
import { NewsBriefingVideo } from "./templates/NewsBriefingVideo";
import { SeniorClubPromoVideo } from "./templates/SeniorClubPromoVideo";
import { DevDay2026Shorts } from "./templates/DevDay2026Shorts";
import { DEVDAY_2026_TOTAL_SECONDS } from "../lib/video/devday-2026";
import { createReferenceBriefingProject } from "../lib/video/templates";
import { getDurationInFrames, VIDEO_PRESETS } from "../lib/video/presets";
import type { VideoFormat, VideoProject } from "../lib/video/types";
import { getEditingOutputSize } from "../lib/video/editing";

const compositionByFormat: Array<{
  id: string;
  format: VideoFormat;
}> = [
  { id: "News-Landscape", format: "youtube-landscape" },
  { id: "News-Vertical", format: "vertical" },
  { id: "News-Shorts", format: "shorts" }
];

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="DevDay2026-Shorts"
        component={DevDay2026Shorts}
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={Math.round(DEVDAY_2026_TOTAL_SECONDS * 30)}
      />
      <Composition
        id="SeniorClub-Shorts"
        component={SeniorClubPromoVideo}
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={1375}
      />
      {compositionByFormat.map(({ id, format }) => {
        const preset = VIDEO_PRESETS[format];
        const defaultProject = createReferenceBriefingProject(format);

        return (
          <Composition
            key={id}
            id={id}
            component={NewsBriefingVideo}
            width={preset.width}
            height={preset.height}
            fps={preset.fps}
            durationInFrames={getDurationInFrames(defaultProject.scenes, preset.fps)}
            defaultProps={{ project: defaultProject }}
            calculateMetadata={({ props }) => {
              const {project,explainerOutputScale = 1} = props as {project:VideoProject;explainerOutputScale?:number};
              return {
                durationInFrames: getDurationInFrames(project.scenes, preset.fps),
                ...(project.editingPreset ? getEditingOutputSize(format,explainerOutputScale) : {}),
                props: { project }
              };
            }}
          />
        );
      })}
    </>
  );
};
