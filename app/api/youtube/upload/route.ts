import path from "node:path";
import { NextResponse } from "next/server";
import { uploadYouTubeVideo } from "@/lib/youtube/client";
import { assertLocalRequest } from "@/lib/security/local-request";
import { readUploadRequest, uploadFailure } from "@/lib/youtube/upload-validation";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const input = await readUploadRequest(request);
    const filePath = path.join(process.cwd(), "public", "renders", input.fileName);

    const video = await uploadYouTubeVideo({
      filePath,
      title: input.title,
      description: input.description,
      tags: input.tags,
      privacyStatus: input.privacyStatus
    });

    return NextResponse.json({ video }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Response) return error;
    const failure = uploadFailure(error);
    console.error(JSON.stringify({ event: "youtube.upload.error", code: failure.code }));
    return NextResponse.json(
      { error: failure.message, code: failure.code },
      { status: failure.status, headers: { "Cache-Control": "no-store" } }
    );
  }
}
