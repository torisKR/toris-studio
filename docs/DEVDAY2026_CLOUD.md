# DevDay 2026 — cloud production record

Official sources were read on 2026-10-01. Content is prepared in `scripts/prepare-devday.ts`, then saved as ordinary `VideoProject` JSON and rendered through `lib/render/render-video.ts` → `News-*` composition → `NewsBriefingVideo`. The editor uses that same React component. No pre-existing MP4 is copied into these outputs.

| Source | Facts used | Qualifications |
|---|---|---|
| [DevDay recap](https://openai.com/index/devday-2026-recap/) | cloud environments, MCP events, Space/Pages, Astra Ultrafast | Events is a proposed specification. Plan and app support vary. Slides and Sol Ultrafast are described as upcoming. |
| [Introducing dots](https://openai.com/index/introducing-dots/) | Astra, own cloud computer, connected apps | Eligible-market rollout, admin opt-in for enterprise beta, plan usage still applies to Work/Codex tasks. |
| [GPT-6.1 Sol](https://openai.com/index/introducing-gpt-6-1-sol/) | $2 input / $0.10 cached input / $10 output per million tokens | Standard API prices, not subscription prices or an Ultrafast price. Work/Codex/API availability does not imply regular Chat availability. |
| [Codex Cloud](https://learn.chatgpt.com/docs/cloud) | reusable development environments | This Studio run demonstrates a development workflow; it is not an OpenAI product UI demo. |

The launch recap describes Astra Ultrafast as up to 8x faster token generation in Codex and up to 6x in the API. The video explicitly does not promise an 8x improvement in end-to-end job completion. It does not assert one definitive price or plan entitlement where summaries and plan-specific documentation might differ.

“From answering to working systems,” the proposed content workflow, and the recommended small-task evaluation are Toris interpretation, not direct announcements or user research. No invented community reactions are presented.

## Inputs and provenance

- Six Korean WAVs already tracked in base commit ae3d38d under `public/devday-2026/audio/` are used. Upstream documentation identifies Qwen3-TTS MLX/Sohee. This run does not claim to have synthesized those files on Linux.
- Local FFmpeg loudness normalization produces new ignored WAVs; source hashes are retained in the input manifest.
- Existing SVG diagrams were visually inspected. They are concept illustrations, not official screenshots.
- The long-form includes an actual local Toris Studio editor screenshot, explicitly identified as Toris Studio rather than OpenAI UI.
- Supplied Library manuscript and edit ZIP could not be materialized in this container through the supported download procedure, including the permitted local-destination retry. They were not used.
- Container fetches to OpenAI pages and Hugging Face were blocked by the proxy (HTTP 403). Official text was available through web browsing, but official product screenshot assets and a new voice model were not available locally.

## Output status

- Shorts/Reels vertical master: 59.43 seconds, Korean source narration throughout, authored graphics, larger burned-in captions. The two editable format projects share a story and can use one vertical MP4. Narration timings are text-weighted estimates and need listening review.
- Long-form: 191.43 seconds, **editing review draft**. Six source-narrated segments alternate with six new explanation segments whose Korean script/captions are present but audio is missing. The frame eyebrow marks these segments as waiting for narration.
- These are not declared publication-approved videos: actual OpenAI product screens, fresh full-length narration, and final human listening review remain outstanding.

All runtime outputs are ignored by Git. See `LINUX.md` for run and render commands and persistent paths. No remote push, PR, deployment, social publishing, paid inference, OAuth grant, or secret storage was performed.

## 30-second social review versions (supersede the 59-second short)

`pnpm exec tsx scripts/prepare-devday-30.ts` saves two ordinary Studio projects:
Instagram `b2150d8a-f2ec-4be4-bfa9-0981c63b9c11`, YouTube `b2150d8a-f2ec-4be4-bfa9-0981c63b9c12`.
Each has a 3-second visual hook, two complete narrated explanations (10 + 12 seconds), and a 5-second visual CTA. Only the last scene differs. Both are review drafts: the new hook and CTA have no recorded voice, DM and related-video destinations are not configured, and no external publication has occurred. Middle narration reuses the repository's complete Codex and MCP WAVs, normalizes loudness without trimming/time stretching, and retains the original words. Sentence captions use measured pauses, not forced alignment. Graphics are explanatory SVGs, not official product screenshots.

Render each through the same composition used by the Studio Player:

```sh
REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium pnpm render:project -- .toris-studio/devday-30/instagram.json
REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium pnpm render:project -- .toris-studio/devday-30/youtube.json
```

At 1080×1920, principal text reserves 88px left, 224px right, 220px top and 360px bottom. These are conservative editorial margins; platform overlays vary. Speech-only SRT files deliberately omit the silent visual hook and CTA. Provenance, logs and evidence live under ignored `.toris-studio/devday-30/`; generated audio lives under ignored `public/generated/devday-30/`.

Library transfer remains blocked: the official batch helper failed during hosted tools/list with `network`; no new Library IDs were issued. The previously failed helper must not be replaced by a direct create call. The separate longform remains a review draft with six missing narration sections until authorized source media can be materialized or local synthesis becomes available.
