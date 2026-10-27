# Motion directions

## References and adaptation

- [OpenChamber showreel](https://data.openchamber.dev/opus-5-5-videos/v/himanshutwtxs-2103495232637882858) presents a short motion portfolio exercise. It informs a brief opening and varied scene rhythm; its footage and author's prompt are not bundled.
- [Motion examples](https://nondev-thinking.web.app/motion/) provide visual vocabulary for text entrances, layered reveals, restrained drift, and orbital arrangements. The implementation uses original Rust compositions; it does not bundle the site's HyperFrames or Three.js examples.

The following directions are Toris Studio's own renderer contract, not a claim to reproduce every reference effect.

| Preset | Purpose | Timing direction |
|---|---|---|
| kinetic-title | Opening hook | Ease out on the headline, then reveal the body after it settles. |
| stagger-rise | Explanation | Offset the headline and body entrances; hold reading space. |
| slide-reveal | New point | One lateral entrance, then a stable reading interval. |
| focus-pulse | Takeaway | Small, slow scale emphasis; no rapid flashing. |
| parallax-pan | Calm continuity | Separate background drift from the foreground text. |
| orbit-cards | Creative interlude | Orbit decorative cards while preserving the text's position. |

### Editor presets with user data

These presets are chosen in the editor, not by the AI planner. Their numbers, labels and logo come from the user, and Rust draws every pixel; the planner prompt keeps the six presets above so a model never invents chart values or counts.

| Preset | Purpose | Scene data (Rust bounds) |
|---|---|---|
| lower-third | Name strap / speaker label | none |
| count-up | A single key number | `countUp` {from, to, unit ≤8 chars, decimals 0–2}, finite, \|value\| ≤ 1e12 |
| bar-chart | Compare 2–8 values | `chart` [{label ≤16 chars, value ≥ 0}] |
| progress-steps | Numbered steps | body sentences become cards that light up in order |
| quote-card | A quote or key sentence | none |
| logo-reveal | Brand sign-off | `logoPath`: PNG/JPEG/WebP inside the project's public folder, ≤ 8 MB |

Every scene may also set `transition` (cut, fade, dip) and, when it has `captionCues`, `burnCaptions: true` to draw the cues into the frame.

Use safe margins in both portrait and landscape frames. Choose motion according to the scene's message, rather than animating every element at once. Native timing is deterministic; the AI chooses a preset and bounded strength, not renderer instructions. A short script and a readable hold are more useful than compressed text.

The editor's motion preview is explicitly illustrative, runs only when requested, and stops under reduced-motion settings. The exported video intentionally contains the selected motion. Review early, middle, and late frames from the real export; CSS preview success is not MP4 evidence.
