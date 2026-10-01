import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { buildStudioMcpServer } from "./factory";

const port = Number(process.env.MCP_PORT ?? 3100);
const host = process.env.MCP_HOST ?? "127.0.0.1";

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
