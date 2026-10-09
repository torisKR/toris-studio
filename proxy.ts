import { NextResponse, type NextRequest } from "next/server";
import { assertLocalRequest } from "@/lib/security/local-request";

export function proxy(request: NextRequest) {
  try {
    assertLocalRequest(request);
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } catch (error) {
    return error instanceof Response ? error : Response.json({ error: "접근이 차단되었습니다." }, { status: 403 });
  }
}

export const config = { matcher: ["/api/:path*", "/renders/:path*", "/assets/:path*", "/generated/:path*"] };
