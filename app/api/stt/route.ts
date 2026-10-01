import { NextResponse } from "next/server";
import { transcribeLocalAudio } from "@/lib/stt/local-stt";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const language = String(form.get("language") ?? "ko");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Audio file is required." },
        { status: 400 }
      );
    }

    const text = await transcribeLocalAudio({
      file,
      fileName: file.name || "audio.wav",
      language
    });

    return NextResponse.json({ text });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "STT failed"
      },
      { status: 500 }
    );
  }
}
