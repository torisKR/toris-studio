import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/storage/supabase";
import {
  isYoutubeClientConfigured,
  isYoutubeConnected
} from "@/lib/youtube/auth";
import { getQwen3TtsConfiguration } from "@/lib/tts/qwen3-local";

export const runtime = "nodejs";

export async function GET() {
  const tts = await getQwen3TtsConfiguration();

  return NextResponse.json({
    ok: true,
    storage: isSupabaseConfigured() ? "supabase" : "local",
    ttsConfigured: tts.configured,
    ttsProvider: tts.provider,
    ttsReason: tts.reason,
    sttConfigured: Boolean(process.env.STT_BASE_URL),
    youtubeClientConfigured: isYoutubeClientConfigured(),
    youtubeConnected: isYoutubeConnected(),
    youtubeConfigured: isYoutubeConnected()
  });
}
