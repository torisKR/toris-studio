import { assertLocalRequest } from "@/lib/security/local-request";
import { socialRepository } from "@/lib/social/server";
import { channelSchema } from "@/lib/social/schema";
import { readSocialJson, socialError, socialJson } from "@/lib/social/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const data = channelSchema.parse(await readSocialJson(request));
    return socialJson({ channel: await socialRepository().createChannel(data) }, 201);
  } catch (error) { return socialError(error); }
}
