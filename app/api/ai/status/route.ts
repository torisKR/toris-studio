import { assertLocalRequest } from "@/lib/security/local-request";
import { aiErrorResponse } from "@/lib/ai/request";
import { aiService } from "@/lib/ai/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    return Response.json(await aiService().status(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return aiErrorResponse(error); }
}
