import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyMediaBinary, mediaBuildCommand, sources } from './prepare-media.mjs';
import * as media from './prepare-media.mjs';
test('download failure reports HTTP and curl status without leaking URL or stderr',async()=>{
 assert.equal(typeof media.downloadSource,'function');
 const secret='credential-must-not-appear';
 await assert.rejects(media.downloadSource({file:'zlib.tar.gz',url:`https://example.invalid/?token=${secret}`},{
  fetchSource:async()=>({ok:false,status:404}),
  runCurl:()=>({status:22,stderr:Buffer.from(secret)})
 }),error=>{assert.match(error.message,/fetch HTTP 404/);assert.match(error.message,/curl exit 22/);assert.doesNotMatch(error.message,new RegExp(secret));return true;});
});
test('network errors and curl spawn failures do not expose exception contents',async()=>{
 const secret='sensitive-url-query';
 await assert.rejects(media.downloadSource({file:'source.tar.gz',url:`https://user:pass@example.invalid/?q=${secret}`},{
  fetchSource:async()=>{throw new Error(secret);},
  runCurl:()=>({status:null,error:new Error(secret),stderr:Buffer.from(secret)})
 }),error=>{assert.match(error.message,/fetch network error; curl could not execute/);assert.doesNotMatch(error.message,new RegExp(secret));assert.doesNotMatch(error.message,/user:pass/);return true;});
});
test('curl fallback returns downloaded bytes when fetch fails',async()=>{
 const bytes=Buffer.from('source');
 const result=await media.downloadSource({file:'source',url:'https://example.invalid/source'},{fetchSource:async()=>{throw Error('network');},runCurl:()=>({status:0,stdout:bytes})});
 assert.deepEqual(result,bytes);
});
test('zlib source uses the official archived release and retains its pinned checksum',()=>{
 assert.equal(sources.zlib.url,'https://zlib.net/fossils/zlib-1.3.2.tar.gz');
 assert.equal(sources.zlib.sha256,'bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16');
});
test('Windows builds use the selected MSYS installation and discard inherited Git path-conversion overrides',()=>{
 const input={TORIS_MSYS2_ROOT:'D:/tools/msys64',MSYS_NO_PATHCONV:'1',MSYS2_ARG_CONV_EXCL:'*'};
 const build=mediaBuildCommand('x86_64-pc-windows-msvc','win32',input);
 assert.equal(build.command,'D:\\tools\\msys64\\usr\\bin\\bash.exe');assert.match(build.args[1],/exec \/usr\/bin\/bash/);
 assert.equal(build.env.MSYS_NO_PATHCONV,undefined);assert.equal(build.env.MSYS2_ARG_CONV_EXCL,undefined);assert.equal(input.MSYS_NO_PATHCONV,'1');
});
function macho(cpu=0x100000c,minimum=0xc0000) {
 const b=Buffer.alloc(56);b.writeUInt32LE(0xfeedfacf);b.writeUInt32LE(cpu,4);b.writeUInt32LE(1,16);b.writeUInt32LE(24,20);b.writeUInt32LE(0x32,32);b.writeUInt32LE(24,36);b.writeUInt32LE(minimum,44);return b;
}
test('media binaries preserve macOS 12 support for both architectures',()=>{
 verifyMediaBinary(macho(),'aarch64-apple-darwin');verifyMediaBinary(macho(0x1000007),'x86_64-apple-darwin');
 assert.throws(()=>verifyMediaBinary(macho(0x100000c,0xd0000),'aarch64-apple-darwin'),/12.0/);
 assert.throws(()=>verifyMediaBinary(macho(),'x86_64-apple-darwin'),/architecture/);
});
test('media binaries reject missing version commands and truncated Mach-O or PE files',()=>{
 const b=macho();b.writeUInt32LE(0,16);assert.throws(()=>verifyMediaBinary(b,'aarch64-apple-darwin'),/12.0/);
 assert.throws(()=>verifyMediaBinary(macho().subarray(0,50),'aarch64-apple-darwin'),/load commands/);
 assert.throws(()=>verifyMediaBinary(Buffer.alloc(10),'x86_64-pc-windows-msvc'),/PE/);
});
