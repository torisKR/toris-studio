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

## Production motion scenes (graphics v1 layouts + references)

The topic → video production pipeline has a third scene source, `visual: "motion"`, that is separate from the six presets above. There the planner picks one closed layout per scene — `title`, `stat`, `list`, `quote` — and writes only the words; `desktop/src-tauri/src/motion_scene.rs` (`LAYOUTS`, `build`) decides positions, sizes, colours and timing and returns a `scene.graphics` v1 scene that the Rust CPU compositor renders. `motion_scene.rs` is the alignment source: the planner prompt (`MOTION_SYSTEM` in `desktop/agent-runtime/src/harness/production.ts`), the Zod schema, Rust `validate_storyboard`, the storyboard select (`MOTION_LAYOUT_LABELS`) and `build` must list the same layouts in the same order; a runtime test compares them. Do not emit the six preset IDs into production storyboards, and do not add a layout in one place only.

The look comes from a motion reference (`motion_reference.rs`): palette, two type sizes, composition, entrance/accent/exit vocabulary, decor and rhythm, all closed values. References are built in, extracted by code from a saved motion project, or measured from a local image/video's colours (speed and layout are then the base reference's, and the reference says so). A job keeps a snapshot of its reference. Reference text never enters system rules; Motion Studio sends its tokens as data and rejects drafts whose colours leave the palette. Motion jobs support 9:16 and 16:9 only and never run the video engine. Check exported frames for the caption band and readability, as above.
