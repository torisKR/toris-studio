---
name: toris-video-motion
description: Plan editable AI video scenes from a topic and category for Toris Studio, using its six supported Rust motion presets and structured scene JSON.
---

# Toris video motion

Use this skill when creating topic-led videos in Toris Studio or extending its motion scene renderer. The desktop app runs the bundled planner prompt as its fixed system instructions; AI chooses content and preset IDs, while Rust renders the motion.

Read [the planner prompt](references/planner-prompt.txt) for the exact AI output contract. Read [motion directions](references/motion-directions.md) when selecting a visual rhythm or reviewing the generated result.

Collect a topic and one category: education, tech, business, lifestyle, entertainment, or news. Keep the default Korean Shorts format, five scenes, and 45 seconds unless the user chooses another supported setting. Use the app's configured AI provider; an unavailable provider or invalid response must surface as a failure, without presenting a local template as AI output.

The output is an editable project with headlines, body text, narration text, durations, and motion selections. Narration text is a script; an audio file requires the separate local TTS step. Review factual claims before publishing. Topic-only generation has no verified source material; do not invent quotations, statistics, citations, or recent events.

Use only the six motion IDs supported by the renderer. Do not emit code, shell commands, filter strings, external assets, or arbitrary file paths. Rust owns timing and easing. The editor preview is illustrative; inspect exported MP4 frames to assess actual motion and readability. Preserve existing projects and manual edits when generating a new project.

For implementation, keep the prompt, backend validation, UI options, and Rust presets aligned. Validate the skill's frontmatter, mock the provider contract, test malformed results without persistence, and render representative presets with the real FFmpeg binary. Do not infer live AI, TTS, or native-window success from a fixture.
