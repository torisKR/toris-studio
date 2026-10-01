import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createDevDay30 } from "../lib/video/devday-30";
import { saveProject } from "../lib/storage/projects";

await mkdir("public/generated/devday-30", { recursive: true });
await mkdir(".toris-studio/devday-30/evidence", { recursive: true });
const audio = [];
for (const id of ["codex", "mcp"]) {
  const source = `public/devday-2026/audio/${id}.wav`;
  const output = `public/generated/devday-30/${id}.wav`;
  // Keep each entire utterance at its original speed, including pauses.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", source, "-af", "loudnorm=I=-16:TP=-1.5:LRA=9", "-ar", "48000", output]);
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output], { encoding: "utf8" }));
  audio.push({ source, output, duration, sourceSha256: createHash("sha256").update(await readFile(source)).digest("hex"), speed: 1, trimmed: false });
}
const stamp = (seconds: number) => {
  const ms = Math.round(seconds * 1000);
  return `00:00:${String(Math.floor(ms / 1000)).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
for (const destination of ["instagram", "youtube"] as const) {
  const project = createDevDay30(destination);
  await saveProject(project);
  await writeFile(`.toris-studio/devday-30/${destination}.json`, JSON.stringify(project, null, 2));
  const cues: string[] = [];
  let offset = 0;
  for (const scene of project.scenes) {
    for (const cue of scene.captionCues ?? []) cues.push(`${cues.length + 1}\n${stamp(offset + cue.startSec)} --> ${stamp(offset + cue.endSec)}\n${cue.text}\n`);
    offset += scene.durationSec;
  }
  await writeFile(`.toris-studio/devday-30/${destination}.srt`, cues.join("\n"));
  console.log(`${destination}: ${offset}s, saved ${project.id}`);
}
await writeFile(".toris-studio/devday-30/provenance.json", JSON.stringify({
  totalFrames: 900, fps: 30, durationSec: 30, hookSec: [0, 3], ctaSec: [25, 30], audio,
  missingNarration: ["hook", "cta"],
  captionMethod: "Whole sentences/clauses, source text retained; cue boundary estimates checked against recording pauses. Not word-level ASR alignment.",
  connectedActions: { instagramDm: false, youtubeRelatedVideo: false },
  distribution: "Review only. Not published. Library upload remains blocked."
}, null, 2));
