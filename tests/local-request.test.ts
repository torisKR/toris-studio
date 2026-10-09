import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLocalRequest } from "../lib/security/local-request";

test("admits same-origin browser and local CLI calls", () => {
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    const origin = `http://${hostname}:3000`;
    assert.doesNotThrow(() => assertLocalRequest(new Request(`${origin}/api/ai/status`)));
    assert.doesNotThrow(() => assertLocalRequest(new Request(`${origin}/api/social/content`, { method: "POST", headers: { host: `${hostname}:3000`, origin, "sec-fetch-site": "same-origin" } })));
  }
});

test("denies DNS-rebinding, cross-site reads/writes and foreign forwarded hosts", () => {
  const attacks: Record<string, string>[] = [
    { host: "evil.example:3000" }, { host: "localhost.evil.example" },
    { origin: "https://evil.example" }, { origin: "null" },
    { origin: "http://localhost:4000" }, { referer: "https://evil.example" },
    { "sec-fetch-site": "cross-site" }, { "x-forwarded-host": "evil.example" },
    { "x-forwarded-for": "203.0.113.5" }, { "x-forwarded-for": "127.0.0.1, 203.0.113.5" },
    { host: "localhost:3000@evil.example" }, { host: "localhost:3000/path" }
  ];
  for (const headers of attacks) {
    assert.throws(() => assertLocalRequest(new Request("http://localhost:3000/api/social/dashboard", { headers })), (error: unknown) => error instanceof Response && error.status === 403);
  }
});
