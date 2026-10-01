import {
  getLocalProject,
  listLocalProjects,
  saveLocalProject
} from "./local-project-repository";
import {
  getSupabaseProject,
  isSupabaseConfigured,
  listSupabaseProjects,
  saveSupabaseProject
} from "./supabase";
import type { VideoProject } from "@/lib/video/types";

export async function listProjects() {
  return isSupabaseConfigured()
    ? listSupabaseProjects()
    : listLocalProjects();
}

export async function getProject(id: string) {
  return isSupabaseConfigured()
    ? getSupabaseProject(id)
    : getLocalProject(id);
}

export async function saveProject(project: VideoProject) {
  return isSupabaseConfigured()
    ? saveSupabaseProject(project)
    : saveLocalProject(project);
}
