import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyMediaBinary } from './prepare-media.mjs';
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
