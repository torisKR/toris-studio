import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { projectSchema } from "@/lib/video/schema";
import {
  getProject,
  listProjects,
  saveProject
} from "@/lib/storage/projects";
import type { VideoProject } from "@/lib/video/types";

export const runtime = "nodejs";


export async function GET() {
  return NextResponse.json({ projects: await listProjects() });
}

export async function POST(request: Request) {
  const result = projectSchema.safeParse(await request.json());
  if (!result.success) return NextResponse.json({ error: result.error.message }, { status: 400 });
  const parsed = result.data;
  const now = new Date().toISOString();
  const id = parsed.id ?? randomUUID();
  const existing = parsed.id ? await getProject(parsed.id) : null;

  const project: VideoProject = {
    ...parsed,
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  await saveProject(project);
  return NextResponse.json(
    { project },
    { status: existing ? 200 : 201 }
  );
}
