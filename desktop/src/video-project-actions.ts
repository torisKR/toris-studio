import type { StudioVideoProject } from "./video-idea";

/** A new editable draft with independent data and shared local media references. */
export function duplicateVideoProject(project: StudioVideoProject): StudioVideoProject {
  const now = new Date().toISOString();
  const copy = structuredClone(project);
  return { ...copy, id: crypto.randomUUID(), title: `${Array.from(project.title).slice(0, 297).join("")} 사본`, createdAt: now, updatedAt: now };
}
