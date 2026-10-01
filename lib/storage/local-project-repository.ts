import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoProject } from "@/lib/video/types";

type ProjectStore = {
  projects: VideoProject[];
};

const EMPTY_STORE: ProjectStore = { projects: [] };

function getDataFile() {
  const configured = process.env.TORIS_STUDIO_DATA_DIR ?? ".toris-studio";
  const base = path.isAbsolute(configured)
    ? configured
    : path.join(/* turbopackIgnore: true */ process.cwd(), configured);
  return {
    base,
    file: path.join(base, "projects.json")
  };
}

async function readStore(): Promise<ProjectStore> {
  const { file } = getDataFile();
  try {
    const raw = await readFile(/* turbopackIgnore: true */ file, "utf8");
    const parsed = JSON.parse(raw) as ProjectStore;
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_STORE;
    }
    throw error;
  }
}

async function writeStore(store: ProjectStore) {
  const { base, file } = getDataFile();
  await mkdir(base, { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2), "utf8");
}

export async function listLocalProjects() {
  const store = await readStore();
  return [...store.projects].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

export async function getLocalProject(id: string) {
  const store = await readStore();
  return store.projects.find((project) => project.id === id) ?? null;
}

export async function saveLocalProject(project: VideoProject) {
  const store = await readStore();
  const next = store.projects.filter((item) => item.id !== project.id);
  next.push(project);
  await writeStore({ projects: next });
  return project;
}
