import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedFileUrl, downloadAssetFile, inferFilename } from "../mcp/asset-files";
import { assetFileSchema, registerAssetTools } from "../mcp/assets";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

test("asset MCP descriptors include non-destructive resize and shared preset discovery",()=>{
  const names:string[]=[];
  const schemas=new Map<string,z.ZodType>();
  const server={registerTool:(name:string,config:{inputSchema:z.ZodType})=>{names.push(name);schemas.set(name,config.inputSchema);}} as unknown as McpServer;
  registerAssetTools(server);
  assert.ok(names.includes("studio_asset_resize"));
  assert.ok(names.includes("studio_asset_presets"));
  const input={title:"favicon",project:"App",purpose:"project",width:32,height:32,format:"ico",presetId:"favicon-32",backgroundColor:"#123456",backgroundMode:"solid"};
  const parsed=schemas.get("studio_asset_request")!.parse(input) as Record<string,unknown>;
  assert.equal(parsed.presetId,"favicon-32");
  assert.equal(parsed.backgroundColor,"#123456");
});

test("MCP file inputs declare the complete official file schema",()=>{
  const schema=z.toJSONSchema(assetFileSchema);
  assert.deepEqual(schema.required,["download_url","file_id"]);
  for(const name of ["download_url","file_id","mime_type","file_name"])assert.ok(schema.properties?.[name]);
});
test("asset download only trusts exact approved HTTPS hosts without credentials or alternate ports",()=>{
  assert.ok(isTrustedFileUrl("https://files.oaiusercontent.com/file.png?sig=test"));
  for(const url of ["http://files.oaiusercontent.com/a","file:///etc/passwd","https://127.0.0.1/a","https://files.oaiusercontent.com.evil.test/a","https://user:pass@files.oaiusercontent.com/a","https://files.oaiusercontent.com:8443/a"])assert.equal(isTrustedFileUrl(url),false,url);
});
test("file download rejects redirects, missing bodies and oversize without returning untrusted bytes",async()=>{
  const url="https://files.oaiusercontent.com/a";
  await assert.rejects(downloadAssetFile(url,async()=>new Response(null,{status:302,headers:{location:"http://127.0.0.1"}})),/다운로드/);
  await assert.rejects(downloadAssetFile(url,async()=>new Response("large",{headers:{"content-length":String(33*1024*1024)}})),/32/);
  const bytes=await downloadAssetFile(url,async(_url,options)=>{assert.equal(options?.redirect,"error");return new Response(new Uint8Array([1,2,3]));});
  assert.deepEqual([...bytes],[1,2,3]);
});
test("file names use declared names or actual format signatures, never path traversal",()=>{
  assert.equal(inferFilename({file_name:"배경.png"},Buffer.from([1])),"배경.png");
  assert.equal(inferFilename({},Buffer.from([137,80,78,71,13,10,26,10])),"chatgpt-image.png");
  assert.throws(()=>inferFilename({file_name:"../../secret.png"},Buffer.from([1])),/파일명/);
  assert.throws(()=>inferFilename({},Buffer.from("unknown")),/형식/);
});
