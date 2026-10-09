/** Admission for this single-user, loopback-only installation. Never a cloud auth substitute. */
export function assertLocalRequest(request: Request): void {
  const deny = () => { throw Response.json({ error: "로컬 Studio에서만 접근할 수 있습니다." }, { status: 403, headers: { "Cache-Control": "no-store" } }); };
  const url = new URL(request.url);
  const authority = request.headers.get("host") ?? url.host;
  let hostUrl: URL;
  try { hostUrl = new URL(`${url.protocol}//${authority}`); } catch { return deny(); }
  if (!isLoopbackHostname(hostUrl.hostname) || hostUrl.host !== authority.toLowerCase() || hostUrl.pathname !== "/" || hostUrl.username || hostUrl.password) deny();
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost && forwardedHost.toLowerCase() !== hostUrl.host) deny();
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor && forwardedFor.split(",").some(ip => !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip.trim()))) deny();
  if (request.headers.get("sec-fetch-site") === "cross-site") deny();
  for (const header of ["origin", "referer"]) {
    const value = request.headers.get(header);
    if (!value) continue;
    try {
      const source = new URL(value);
      if (source.origin !== hostUrl.origin || source.username || source.password) deny();
    } catch { deny(); }
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());
}
