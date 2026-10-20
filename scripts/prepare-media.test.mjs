import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyMediaBinary, mediaBuildCommand } from './prepare-media.mjs';
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
