import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getProject,
  listProjects,
  saveProject
} from "@/lib/storage/projects";
import type { VideoProject } from "@/lib/video/types";

export const runtime = "nodejs";

const projectSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  format: z.enum(["youtube-landscape", "vertical", "shorts"]),
  template: z.enum(["reference-briefing", "adaptive-promo"]),
  language: z.enum(["ko", "ja", "zh", "en"]),
  scenes: z.array(
    z.object({
      id: z.string().min(1),
      eyebrow: z.string().optional(),
      headline: z.string(),
      body: z.string(),
      narration: z.string(),
      durationSec: z.number().positive(),
      sourceLabel: z.string().optional(),
      sourceUrl: z.string().optional(),
      mediaType: z.enum(["none", "image", "video", "screen"]).optional(),
      mediaUrl: z.string().optional(),
      audioPath: z.string().optional(),
      accent: z.string().optional(),
      role: z.enum(["hook", "point", "proof", "reaction", "cost", "action", "outro"]).optional(),
      layout: z.enum(["hero", "split", "media-focus", "reaction-grid", "action-card"]).optional(),
      badge: z.string().optional()
    })
  )
});

export async function GET() {
  return NextResponse.json({ projects: await listProjects() });
}

export async function POST(request: Request) {
  const parsed = projectSchema.parse(await request.json());
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
