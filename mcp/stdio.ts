import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildStudioMcpServer } from "./factory";

void serveStdio(() => buildStudioMcpServer());

console.error("Toris Studio MCP is listening on stdio");
