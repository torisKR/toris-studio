import assert from "node:assert/strict";
import test from "node:test";
import { validateMcpBinding, validMcpToken } from "../mcp/local-auth";
test("MCP may bind to loopback without a token, but never publicly without strong authentication",()=>{
  assert.doesNotThrow(()=>validateMcpBinding("127.0.0.1",undefined));
  assert.throws(()=>validateMcpBinding("0.0.0.0",undefined),/MCP_AUTH_TOKEN/);
  assert.throws(()=>validateMcpBinding("0.0.0.0","short"),/32/);
  assert.doesNotThrow(()=>validateMcpBinding("0.0.0.0","a".repeat(32)));
});
test("MCP token comparison requires the exact Bearer value",()=>{
  const token="x".repeat(32);
  assert.ok(validMcpToken(`Bearer ${token}`,token));
  assert.equal(validMcpToken(undefined,token),false);
  assert.equal(validMcpToken(`Bearer ${token}extra`,token),false);
  assert.equal(validMcpToken(`Basic ${token}`,token),false);
});
