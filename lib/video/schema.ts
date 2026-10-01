import { z } from "zod";

export const projectSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  format: z.enum(["youtube-landscape", "vertical", "shorts"]),
  template: z.enum(["reference-briefing", "adaptive-promo"]),
  language: z.enum(["ko", "ja", "zh", "en"]),
  scenes: z.array(
    z.object({
      id: z.string().min(1),
      eyebrow: z.string().optional(),
      headline: z.string(),
      body: z.string(),
      narration: z.string(),
      durationSec: z.number().positive(),
      sourceLabel: z.string().optional(),
      sourceUrl: z.string().optional(),
      mediaType: z.enum(["none", "image", "video", "screen"]).optional(),
      mediaUrl: z.string().optional(),
      audioPath: z.string().optional(),
      accent: z.string().optional(),
      role: z.enum(["hook", "point", "proof", "reaction", "cost", "action", "outro"]).optional(),
      layout: z.enum(["hero", "split", "media-focus", "reaction-grid", "action-card", "social-hook", "social-point", "social-cta"]).optional(),
      badge: z.string().optional(),
      mediaFit: z.enum(["contain", "cover"]).optional(),
      captionCues: z.array(z.object({
        startSec: z.number().nonnegative(),
        endSec: z.number().positive(),
        text: z.string()
      }).refine(cue => cue.endSec > cue.startSec, "Caption end must follow start")).optional()
    })
  ).min(1)
});
