import { assertLocalRequest } from "@/lib/security/local-request";
import { aiErrorResponse, readDraftRequest } from "@/lib/ai/request";
import { aiService } from "@/lib/ai/service";

export const runtime = "nodejs";
export const maxDuration = 100;

export async function POST(request: Request) {
  try {
    assertLocalRequest(request);
    const input = await readDraftRequest(request);
    return Response.json(await aiService().generate(input), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return aiErrorResponse(error); }
}
