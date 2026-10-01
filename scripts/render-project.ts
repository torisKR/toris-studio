import { readFile } from "node:fs/promises";
import { projectSchema } from "../lib/video/schema";
import { renderProject } from "../lib/render/render-video";
import { getProject } from "../lib/storage/projects";

const args = process.argv.slice(2).filter(arg => arg !== "--");
const [source, id] = args;
if (!source || (source === "--id" && !id)) {
  throw new Error("Usage: pnpm render:project -- project.json | --id UUID");
}
const raw = source === "--id" ? await getProject(id) : JSON.parse(await readFile(source, "utf8"));
const parsed = projectSchema.parse(raw);
const now = new Date().toISOString();
const project = { ...parsed, id: parsed.id ?? crypto.randomUUID(), createdAt: raw.createdAt ?? now, updatedAt: raw.updatedAt ?? now };
console.log(JSON.stringify(await renderProject(project)));
