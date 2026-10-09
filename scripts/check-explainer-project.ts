import { readFile } from "node:fs/promises";
import { projectSchema } from "../lib/video/schema";
import { inspectEditingProject } from "../lib/video/editing";
import type { VideoProject } from "../lib/video/types";

if (!process.argv[2]) throw new Error("Usage: node --import tsx scripts/check-explainer-project.ts project.json");
const project = projectSchema.parse(JSON.parse(await readFile(process.argv[2], "utf8")));
const issues = inspectEditingProject(project as VideoProject);
console.log(JSON.stringify({ editingPreset: project.editingPreset ?? "legacy", issues }, null, 2));
if (issues.some(i => i.level === "error")) process.exitCode = 1;
