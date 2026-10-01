import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { synthesizeWithQwen3Tts } from "@/lib/tts/qwen3-local";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  projectId: z.string().min(1),
  sceneId: z.string().min(1),
  text: z.string().min(1),
  speaker: z.string().optional(),
  instruct: z.string().optional(),
  temperature: z.number().min(0.1).max(1.5).optional()
});

function safePart(value: string) {
  return value.replace(/[^a-zA-Z0-9가-힣_-]+/g, "-").slice(0, 80);
}

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const synthesis = await synthesizeWithQwen3Tts({
      text: input.text,
      speaker: input.speaker,
      instruct: input.instruct,
      temperature: input.temperature
    });

    const projectPart = safePart(input.projectId);
    const scenePart = safePart(input.sceneId);
    const dir = path.join(
      process.cwd(),
      "public",
      "generated",
      projectPart
    );
    await mkdir(dir, { recursive: true });

    const fileName = `${scenePart}.${synthesis.format}`;
    const target = path.join(dir, fileName);
    await writeFile(target, synthesis.audio);

    return NextResponse.json({
      audioPath: `/generated/${projectPart}/${fileName}`,
      durationSec: synthesis.durationSec,
      provider: synthesis.provider,
      speaker: synthesis.speaker,
      sampleRate: synthesis.sampleRate
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "TTS failed"
      },
      { status: 500 }
    );
  }
}
