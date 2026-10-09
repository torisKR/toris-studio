import { assertLocalRequest } from "@/lib/security/local-request";
import { socialRepository } from "@/lib/social/server";
import { contentPatchSchema, recordIdSchema } from "@/lib/social/schema";
import { readSocialJson, socialError, socialJson } from "@/lib/social/http";

export const runtime = "nodejs";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertLocalRequest(request);
    const { id } = await context.params;
    recordIdSchema.parse(id);
    const patch = contentPatchSchema.parse(await readSocialJson(request));
    return socialJson({ content: await socialRepository().updateContent(id, patch) });
  } catch (error) { return socialError(error); }
}
