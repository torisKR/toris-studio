import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createExplainerSample } from "../lib/video/explainer-sample";
import { inspectEditingProject } from "../lib/video/editing";
import { projectSchema } from "../lib/video/schema";
import type { VideoFormat } from "../lib/video/types";

const image = await readFile("public/senior-club/home.png");
if (image.readUInt32BE(16) !== 1080 || image.readUInt32BE(20) !== 1920) throw new Error("Sample screenshot dimensions changed; review source and focus coordinates.");
const root = path.resolve(".toris-studio/explainer-samples");
await mkdir(root, { recursive: true });
const dir = await mkdtemp(path.join(root, "run-"));
const reports = [];
for (const format of ["youtube-landscape", "vertical", "shorts"] satisfies VideoFormat[]) {
  const project = createExplainerSample(format);
  projectSchema.parse(project);
  const issues = inspectEditingProject(project);
  if (issues.some(i => i.level === "error")) throw new Error(JSON.stringify(issues));
  await writeFile(path.join(dir, `${format}.json`), JSON.stringify(project, null, 2), { flag: "wx" });
  reports.push({ format, issues, audio: "silent visual draft", durationSec: 6 });
}
await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ source: "public/senior-club/home.png", sha256: createHash("sha256").update(image).digest("hex"), reports }, null, 2), { flag: "wx" });
console.log(dir);
