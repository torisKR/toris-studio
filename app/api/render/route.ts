import { NextResponse } from "next/server";
import { renderProject } from "@/lib/render/render-video";
import type { VideoProject } from "@/lib/video/types";
import { projectSchema } from "@/lib/video/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { project } = (await request.json()) as { project: VideoProject };

    const validated = projectSchema.safeParse(project);
    if (!validated.success) {
      return NextResponse.json(
        { error: validated.error.message },
        { status: 400 }
      );
    }

    const render = await renderProject(project);
    return NextResponse.json({ render });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unknown render error"
      },
      { status: 500 }
    );
  }
}
