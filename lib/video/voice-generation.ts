import type { VideoProject, VideoScene } from "./types";
import { updateProjectScene } from "./update-scene";

export type GeneratedSceneVoice = {
  audioPath: string;
  durationSec: number;
};

export function applyGeneratedSceneVoice(
  current: VideoProject,
  source: VideoProject,
  sceneId: string,
  voice: GeneratedSceneVoice
): VideoProject {
  if (!voice.audioPath.trim()) {
    throw new Error("Generated audio path must not be empty.");
  }
  if (!Number.isFinite(voice.durationSec) || voice.durationSec <= 0) {
    throw new Error("Generated audio duration must be positive and finite.");
  }

  if (current.id !== source.id || current.language !== source.language) return current;
  const originalScene = source.scenes.find(scene => scene.id === sceneId);
  const currentScene = current.scenes.find(scene => scene.id === sceneId);
  if (
    !originalScene ||
    !currentScene ||
    currentScene.narration !== originalScene.narration ||
    currentScene.audioPath !== originalScene.audioPath
  ) return current;

  return updateProjectScene(current, source.id, sceneId, {
    audioPath: voice.audioPath,
    durationSec: Math.max(1, Math.ceil((voice.durationSec + 0.5) * 30) / 30),
    captionCues: undefined
  });
}

export async function generateSceneVoices(
  scenes: VideoScene[],
  synthesize: (scene: VideoScene) => Promise<GeneratedSceneVoice>,
  onGenerated: (scene: VideoScene, voice: GeneratedSceneVoice) => void,
  onProgress?: (completed: number, total: number) => void,
  shouldContinue?: () => boolean
): Promise<number> {
  const pending = scenes.filter(scene => scene.narration.trim().length > 0);
  let completed = 0;
  for (const scene of pending) {
    if (shouldContinue && !shouldContinue()) break;
    const voice = await synthesize(scene);
    onGenerated(scene, voice);
    completed += 1;
    onProgress?.(completed, pending.length);
  }
  return completed;
}
