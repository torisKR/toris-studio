import { z } from "zod";

export const editingPresetSchema = z.enum(["project-explainer", "project-explainer-still"]);
export const sceneEditingFields = {
  focusDetail: z.boolean().optional(),
  mediaSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  explanationSteps: z.array(z.string().min(1)).min(2).max(4).optional(),
  focusRegion: z.object({
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    width: z.number().positive().max(1), height: z.number().positive().max(1),
    startSec: z.number().nonnegative(), endSec: z.number().positive(),
    label: z.string().min(1).max(48)
  }).refine(r => r.x + r.width <= 1 && r.y + r.height <= 1, "Focus must fit inside the source")
    .refine(r => r.endSec > r.startSec, "Focus end must follow start").optional()
};
