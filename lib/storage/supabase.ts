import { createClient } from "@supabase/supabase-js";
import type { VideoProject } from "@/lib/video/types";

function getServerSecret() {
  return (
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    ""
  );
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getServerSecret();

  if (!url || !key) return null;

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      getServerSecret()
  );
}

export async function listSupabaseProjects(): Promise<VideoProject[]> {
  const supabase = getAdminClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("video_projects")
    .select("payload")
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => row.payload as VideoProject);
}

export async function getSupabaseProject(
  id: string
): Promise<VideoProject | null> {
  const supabase = getAdminClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("video_projects")
    .select("payload")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data ? (data.payload as VideoProject) : null;
}

export async function saveSupabaseProject(project: VideoProject) {
  const supabase = getAdminClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const { error } = await supabase.from("video_projects").upsert(
    {
      id: project.id,
      title: project.title,
      format: project.format,
      language: project.language,
      payload: project,
      updated_at: project.updatedAt
    },
    { onConflict: "id" }
  );

  if (error) throw error;
  return project;
}
