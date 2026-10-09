import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerAssetTools } from "./assets";

// A least-privilege endpoint for Secure MCP Tunnel: no video, DB, or AI-provider tools.
void serveStdio(() => {
  const server = new McpServer({ name: "toris-studio-assets", version: "0.1.0" });
  registerAssetTools(server);
  return server;
});
console.error("Toris Studio asset-only MCP is listening on stdio");
