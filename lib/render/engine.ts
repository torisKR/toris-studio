import type { VideoProject } from "@/lib/video/types";

export type RenderEngineName = "remotion" | "hyperframes" | "revideo";

export type RenderResult = {
  fileName: string;
  outputLocation: string;
  publicUrl: string;
};

export interface RenderEngine {
  readonly name: RenderEngineName;
  render(project: VideoProject): Promise<RenderResult>;
}

export const DEFAULT_RENDER_ENGINE: RenderEngineName = "remotion";
