import { assertLocalRequest } from "@/lib/security/local-request";
import { refreshSocialTrends } from "@/lib/social/server";
import { refreshSchema } from "@/lib/social/schema";
import { readSocialJson, socialError, socialJson } from "@/lib/social/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const { keyword } = refreshSchema.parse(await readSocialJson(request));
    return socialJson(await refreshSocialTrends(keyword));
  } catch (error) { return socialError(error); }
}
