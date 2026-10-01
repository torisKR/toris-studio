import { mkdir } from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { VideoFormat, VideoProject } from "@/lib/video/types";

const compositionIds: Record<VideoFormat, string> = {
  "youtube-landscape": "News-Landscape",
  vertical: "News-Vertical",
  shorts: "News-Shorts"
};

let bundlePromise: Promise<string> | null = null;

function getBundle() {
  if (!bundlePromise) {
    bundlePromise = bundle({
      entryPoint: path.join(process.cwd(), "remotion/index.ts"),
      webpackOverride: (config) => config
    });
  }
  return bundlePromise;
}

function safeSlug(input: string) {
  return input
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9가-힣_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "video";
}

export async function renderProject(project: VideoProject) {
  const serveUrl = await getBundle();
  const inputProps = { project };
  const composition = await selectComposition({
    serveUrl,
    id: compositionIds[project.format],
    inputProps
  });

  const renderDir = path.join(process.cwd(), "public", "renders");
  await mkdir(renderDir, { recursive: true });

  const fileName = `${safeSlug(project.title)}-${Date.now()}.mp4`;
  const outputLocation = path.join(renderDir, fileName);

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation,
    inputProps,
    pixelFormat: "yuv420p",
    audioCodec: "aac"
  });

  return {
    fileName,
    outputLocation,
    publicUrl: `/renders/${fileName}`
  };
}
