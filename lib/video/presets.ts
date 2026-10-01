import type { VideoFormat } from "./types";

export type VideoPreset = {
  id: VideoFormat;
  label: string;
  description: string;
  width: number;
  height: number;
  fps: number;
  platform: string;
};

export const VIDEO_PRESETS: Record<VideoFormat, VideoPreset> = {
  "youtube-landscape": {
    id: "youtube-landscape",
    label: "YouTube 16:9",
    description: "롱폼 뉴스·리서치·설명 영상",
    width: 1920,
    height: 1080,
    fps: 30,
    platform: "YouTube"
  },
  vertical: {
    id: "vertical",
    label: "Vertical 9:16",
    description: "세로형 롱폼·릴스·틱톡",
    width: 1080,
    height: 1920,
    fps: 30,
    platform: "Reels / TikTok"
  },
  shorts: {
    id: "shorts",
    label: "YouTube Shorts",
    description: "60초 안팎 쇼츠 템플릿",
    width: 1080,
    height: 1920,
    fps: 30,
    platform: "YouTube Shorts"
  }
};

export function getPreset(format: VideoFormat) {
  return VIDEO_PRESETS[format];
}

export function getDurationInFrames(
  scenes: Array<{ durationSec: number }>,
  fps: number
) {
  return Math.max(
    fps,
    Math.round(scenes.reduce((sum, scene) => sum + scene.durationSec, 0) * fps)
  );
}
