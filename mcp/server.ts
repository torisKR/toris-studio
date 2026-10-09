import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { buildStudioMcpServer } from "./factory";
import { validateMcpBinding, validMcpToken } from "./local-auth";

const port = Number(process.env.MCP_PORT ?? 3100);
const host = process.env.MCP_HOST ?? "127.0.0.1";
const authToken = process.env.MCP_AUTH_TOKEN;
validateMcpBinding(host, authToken);

const handler = createMcpHandler(() => buildStudioMcpServer());
const app = createMcpExpressApp({
  host
});
const nodeHandler = toNodeHandler(handler);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "toris-studio-mcp",
    mcp: "/mcp"
  });
});

app.all("/mcp", (req, res) => {
  if (authToken && !validMcpToken(req.headers.authorization, authToken)) {
    res.status(401).json({ error: "MCP authentication required" });
    return;
  }
  void nodeHandler(req, res, req.body);
});

const server = app.listen(port, host, () => {
  console.error(
    `Toris Studio MCP listening on http://${host}:${port}/mcp`
  );
});

async function shutdown() {
  server.close();
  await handler.close();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
