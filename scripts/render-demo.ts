import { createReferenceBriefingProject } from "../lib/video/templates";
import { renderProject } from "../lib/render/render-video";
import type { VideoFormat } from "../lib/video/types";

async function main() {
  const requestedFormat =
    process.argv.slice(2).find((arg) => arg !== "--") ?? "youtube-landscape";

  if (
    requestedFormat !== "youtube-landscape" &&
    requestedFormat !== "vertical" &&
    requestedFormat !== "shorts"
  ) {
    throw new Error(
      "Usage: npm run remotion:render -- youtube-landscape|vertical|shorts"
    );
  }

  const format: VideoFormat = requestedFormat;
  const project = createReferenceBriefingProject(format);

  const result = await renderProject(project);
  console.log(result.outputLocation);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
