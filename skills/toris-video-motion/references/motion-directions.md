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

Use safe margins in both portrait and landscape frames. Choose motion according to the scene's message, rather than animating every element at once. Native timing is deterministic; the AI chooses a preset and bounded strength, not renderer instructions. A short script and a readable hold are more useful than compressed text.

The editor's motion preview is explicitly illustrative, runs only when requested, and stops under reduced-motion settings. The exported video intentionally contains the selected motion. Review early, middle, and late frames from the real export; CSS preview success is not MP4 evidence.
