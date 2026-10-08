import type { VideoFormat, VideoProject } from "../../lib/video/types";

export type VideoResearchSeed = {
  requestId: string;
  trendIds: string[];
  keyword?: string;
  topic?: string;
};

export type VideoResearchSource = {
  trendId: string;
  source: string;
  title: string;
  url: string;
  description?: string | null;
  fetchedAt: string;
};

export type VideoResearchProvider = "local" | "opencodex" | "teamclaude" | "claude-cli";

export type VideoResearchPreview = {
  sources: VideoResearchSource[];
  keyword: string;
  topic: string;
  warnings: string[];
};

export type VideoResearchMetadata = {
  version: 1;
  keyword: string;
  topic: string;
  provider: string;
  createdAt: string;
  sources: VideoResearchSource[];
  reviewRequired: boolean;
};

export type ResearchVideoProject = VideoProject & { research?: VideoResearchMetadata };
export type VideoResearchResult = {
  project: ResearchVideoProject;
  provider: string;
  warnings: string[];
};

export type VideoResearchInput = {
  trendIds: string[];
  keyword?: string;
  topic?: string;
  format: VideoFormat;
  provider: VideoResearchProvider;
};
