import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { VideoFormat, VideoProject } from "@/lib/video/types";
import { inspectEditingProject } from "@/lib/video/editing";

const compositionIds: Record<VideoFormat, string> = {
  "youtube-landscape": "News-Landscape",
  vertical: "News-Vertical",
  shorts: "News-Shorts"
};

function safeSlug(input: string) {
  return input
    .normalize("NFC")
    .replace(/[^a-zA-Z0-9가-힣_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "video";
}

export async function renderProject(project: VideoProject) {
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const concurrency = Number(process.env.REMOTION_CONCURRENCY || 2);
  const scale = Number(process.env.REMOTION_SCALE || 1);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("REMOTION_CONCURRENCY must be an integer from 1 to 16");
  }
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 1) {
    throw new Error("REMOTION_SCALE must be between 0.1 and 1");
  }
  const editingErrors = inspectEditingProject(project, scale).filter(issue => issue.level === "error");
  if (editingErrors.length) throw new Error(editingErrors.map(issue => `${issue.sceneId}: ${issue.message}`).join("\n"));
  // A fresh throwaway bundle sees media uploaded since the previous render.
  // Linux symlinking avoids copying every previous MP4 into the next bundle.
  const outDir = await mkdtemp(path.join(tmpdir(), "toris-render-"));
  try {
    const serveUrl = await bundle({
      entryPoint: path.join(process.cwd(), "remotion/index.ts"),
      outDir,
      symlinkPublicDir: true
    });
    const inputProps = {project, explainerOutputScale:project.editingPreset ? scale : 1};
    const composition = await selectComposition({
      serveUrl,
      id: compositionIds[project.format],
      inputProps,
      browserExecutable
    });

    const renderDir = path.join(process.cwd(), "public", "renders");
    await mkdir(renderDir, { recursive: true });

    const fileName = `${safeSlug(project.title)}-${Date.now()}${project.editingPreset ? `-${randomUUID()}` : ""}.mp4`;
    const outputLocation = path.join(renderDir, fileName);

    let reportedProgress = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation,
      inputProps,
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      browserExecutable,
      concurrency,
      // Opt-in explainer metadata already sets the target canvas; avoid post-scaling pixels.
      scale:project.editingPreset ? 1 : scale,
      onProgress: ({ progress }) => {
        const bucket = Math.floor(progress * 10);
        if (bucket > reportedProgress) {
          reportedProgress = bucket;
          console.error(`Render ${project.id}: ${bucket * 10}%`);
        }
      }
    });

    return {
      fileName,
      outputLocation,
      publicUrl: `/renders/${fileName}`
    };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
