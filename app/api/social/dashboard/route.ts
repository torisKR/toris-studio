import { assertLocalRequest } from "@/lib/security/local-request";
import { getSocialDashboard } from "@/lib/social/server";
import { socialError, socialJson } from "@/lib/social/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try { assertLocalRequest(request); return socialJson(await getSocialDashboard()); }
  catch (error) { return socialError(error); }
}
