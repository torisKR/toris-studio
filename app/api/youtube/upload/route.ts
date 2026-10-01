import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { uploadYouTubeVideo } from "@/lib/youtube/client";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  fileName: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  tags: z.array(z.string()).optional(),
  privacyStatus: z.enum(["private", "unlisted", "public"]).default("private")
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const safeFile = path.basename(input.fileName);
    const filePath = path.join(process.cwd(), "public", "renders", safeFile);

    const video = await uploadYouTubeVideo({
      filePath,
      title: input.title,
      description: input.description,
      tags: input.tags,
      privacyStatus: input.privacyStatus
    });

    return NextResponse.json({ video });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "YouTube upload failed"
      },
      { status: 500 }
    );
  }
}
