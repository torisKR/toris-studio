import type { VideoProject, VideoScene } from './types';

/** Async media results must target their original project and scene, while
 * preserving edits made while the request was in flight. */
export function updateProjectScene(current: VideoProject, projectId: string, sceneId: string, patch: Partial<VideoScene>): VideoProject {
  if (current.id !== projectId || !current.scenes.some(scene => scene.id === sceneId)) return current;
  return {
    ...current,
    updatedAt: new Date().toISOString(),
    scenes: current.scenes.map(scene => scene.id === sceneId ? { ...scene, ...patch } : scene)
  };
}
