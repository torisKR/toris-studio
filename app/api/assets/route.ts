import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 250 * 1024 * 1024;
const ALLOWED_PREFIXES = ["image/", "video/"];

function safeExtension(file: File) {
  const ext = path.extname(file.name).toLowerCase();
  return /^[.][a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Media file is required." },
        { status: 400 }
      );
    }

    if (!ALLOWED_PREFIXES.some((prefix) => file.type.startsWith(prefix))) {
      return NextResponse.json(
        { error: "Only image and video files are supported." },
        { status: 415 }
      );
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "Media file exceeds the 250 MB local MVP limit." },
        { status: 413 }
      );
    }

    const dir = path.join(process.cwd(), "public", "assets");
    await mkdir(dir, { recursive: true });

    const fileName = `${randomUUID()}${safeExtension(file)}`;
    const target = path.join(dir, fileName);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await writeFile(target, bytes);

    return NextResponse.json({
      mediaUrl: `/assets/${fileName}`,
      mediaType: file.type.startsWith("video/") ? "video" : "image",
      originalName: file.name,
      size: file.size
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Media upload failed"
      },
      { status: 500 }
    );
  }
}
