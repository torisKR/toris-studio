import { assertLocalRequest } from "@/lib/security/local-request";
import { socialRepository } from "@/lib/social/server";
import { contentSchema } from "@/lib/social/schema";
import { readSocialJson, socialError, socialJson } from "@/lib/social/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const data = contentSchema.parse(await readSocialJson(request));
    return socialJson({ content: await socialRepository().createContent(data) }, 201);
  } catch (error) { return socialError(error); }
}
