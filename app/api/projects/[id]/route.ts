import { NextResponse } from "next/server";
import { getProject, saveProject } from "@/lib/storage/projects";
import { projectSchema } from "@/lib/video/schema";
import type { VideoProject } from "@/lib/video/types";

export const runtime = "nodejs";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const project = await getProject(id);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({ project });
}

export async function PUT(request: Request, context: Context) {
  const { id } = await context.params;
  const existing = await getProject(id);

  if (!existing) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const result = projectSchema.safeParse(await request.json());
  if (!result.success) return NextResponse.json({ error: result.error.message }, { status: 400 });
  const input = result.data;
  const project: VideoProject = {
    ...input,
    id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString()
  };

  await saveProject(project);
  return NextResponse.json({ project });
}
