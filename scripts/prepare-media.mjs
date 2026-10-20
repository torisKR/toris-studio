import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const sources=JSON.parse(await readFile(path.join(root,'desktop/src-tauri/resources/media/sources.json'),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
export function mediaOverlay(target){return {resources:{[`media-runtime/${target}/`]:'media-runtime/'}};}
export async function prepareMedia(target) {
 const folder=path.join(root,'desktop/src-tauri/media-runtime',target);
 try {await verifyMedia(folder);return;}catch{}
 const result=process.platform==='win32' ? spawnSync('C:/msys64/usr/bin/bash.exe',['-lc','bash scripts/build-media-runtime.sh "$1"','media-build',target],{cwd:root,env:{...process.env,MSYSTEM:'MINGW64',CHERE_INVOKING:'1',MSYS2_PATH_TYPE:'inherit'},stdio:'inherit',shell:false}) : spawnSync('bash',[path.join(root,'scripts/build-media-runtime.sh'),target],{stdio:'inherit',shell:false});
 if(result.status!==0) throw new Error('Pinned media runtime build failed.');
 await verifyMedia(folder);
}
export function verifyMediaBinary(bytes,target) {
 if(target.includes('darwin')) {
  if(bytes.length<32||bytes.readUInt32LE(0)!==0xfeedfacf||bytes.readUInt32LE(4)!==(target.startsWith('aarch64')?0x100000c:0x1000007))throw new Error('Media Mach-O architecture mismatch');
  const count=bytes.readUInt32LE(16),commandBytes=bytes.readUInt32LE(20);let offset=32,minimum=null;
  if(count>1024||32+commandBytes>bytes.length)throw new Error('Invalid media load commands');
  for(let i=0;i<count;i++) {
   if(offset+8>32+commandBytes)throw new Error('Invalid media load command');
   const command=bytes.readUInt32LE(offset),size=bytes.readUInt32LE(offset+4);
   if(size<8||offset+size>32+commandBytes)throw new Error('Invalid media load command size');
   if(command===0x32){if(size<24)throw new Error('Invalid media build version');minimum=Math.max(minimum??0,bytes.readUInt32LE(offset+12));}
   if(command===0x24){if(size<16)throw new Error('Invalid media minimum version');minimum=Math.max(minimum??0,bytes.readUInt32LE(offset+8));}
   offset+=size;
  }
  if(minimum===null||minimum>0x000c0000)throw new Error('Media runtime must support macOS 12.0 or earlier');
 } else {
  if(bytes.length<64||bytes.toString('ascii',0,2)!=='MZ')throw new Error('Invalid media PE');
  const pe=bytes.readUInt32LE(0x3c);
  if(pe+6>bytes.length||bytes.readUInt32LE(pe)!==0x4550||bytes.readUInt16LE(pe+4)!==0x8664)throw new Error('Media PE architecture mismatch');
 }
}
export async function verifyMedia(folder){
 const m=JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
 if(JSON.stringify(m.sources)!==JSON.stringify(sources)||m.distributionFiles?.['sources/scripts/build-media-runtime.sh']!==hash(await readFile(path.join(root,'scripts/build-media-runtime.sh'))))throw new Error('Media build inputs have changed');
 if(!['aarch64-apple-darwin','x86_64-apple-darwin','x86_64-pc-windows-msvc'].includes(m.target))throw new Error('Unknown media architecture');
 for(const [name,digest] of Object.entries(m.files)) {
  if(!/^[a-zA-Z0-9_.-]+$/.test(name) || hash(await readFile(path.join(folder,name)))!==digest) throw new Error(`Bundled media is missing or damaged: ${name}`);
 }
 for(const name of [m.target.includes('windows')?'ffmpeg.exe':'ffmpeg',m.target.includes('windows')?'ffprobe.exe':'ffprobe']){const bytes=await readFile(path.join(folder,name));verifyMediaBinary(bytes,m.target);if(m.target.includes('darwin')){const signed=spawnSync('codesign',['--verify','--strict',path.join(folder,name)],{encoding:'utf8',shell:false});if(signed.status!==0)throw new Error('Invalid media signature');}}
 if(m.ffmpeg!=='9.0.2' || !m.files['NotoSansCJKkr-Regular.otf'] || !m.files[process.platform==='win32'?'ffmpeg.exe':'ffmpeg']) throw new Error('Incomplete media manifest');
 for(const [relative,digest] of Object.entries(m.distributionFiles||{})){if(relative.split('/').some(p=>!p||p==='.'||p==='..')||!/^[-a-zA-Z0-9_./]+$/.test(relative)||hash(await readFile(path.join(folder,relative)))!==digest)throw new Error('Media corresponding source or notice damaged');}
 if(!m.distributionFiles?.['notices/Noto-OFL.txt']||!m.distributionFiles?.['sources/archives/ffmpeg-9.0.2.tar.xz'])throw new Error('Missing media redistribution sources');
 for(const name of ['ffmpeg','ffprobe']) {
  const result=spawnSync(path.join(folder,name+(process.platform==='win32'?'.exe':'')),['-version'],{encoding:'utf8',env:{...process.env,PATH:''},shell:false});
  if(result.status!==0 || !result.stdout.includes('9.0.2')) throw new Error(`Bundled ${name} failed without PATH`);
 }
 return m;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const [action,arg]=process.argv.slice(2);
 if(action==='sources') {
  await mkdir(arg,{recursive:true});
  for(const item of Object.values(sources).filter(i=>typeof i==='object')) {
   const dest=path.join(arg,item.file);let bytes;try{bytes=await readFile(dest);}catch{}
   if(!bytes || hash(bytes)!==item.sha256) {
    try {const response=await fetch(item.url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());}
    catch {const downloaded=spawnSync('curl',['--fail','--location','--proto','=https','--tlsv1.2','--max-time','180','--silent','--show-error','--url',item.url],{shell:false,maxBuffer:64*1024*1024});if(downloaded.status!==0)throw new Error(`Pinned source download failed: ${item.file}`);bytes=downloaded.stdout;}
    if(hash(bytes)!==item.sha256)throw new Error(`Source SHA256 mismatch: ${item.file}`);await writeFile(dest,bytes);
   }
  }
 } else if(action==='manifest') {
  const folder=path.join(root,'desktop/src-tauri/media-runtime',arg), suffix=arg.includes('windows')?'.exe':'';
  const files={};for(const name of [`ffmpeg${suffix}`,`ffprobe${suffix}`,'NotoSansCJKkr-Regular.otf'])files[name]=hash(await readFile(path.join(folder,name)));
  const distributionFiles={};async function walk(relative){const {readdir}=await import('node:fs/promises');for(const entry of await readdir(path.join(folder,relative),{withFileTypes:true})){const name=relative+'/'+entry.name;if(entry.isDirectory())await walk(name);else if(entry.isFile())distributionFiles[name]=hash(await readFile(path.join(folder,name)));else throw new Error('Media source links are forbidden');}}await walk('notices');await walk('sources');
  await writeFile(path.join(folder,'manifest.json'),JSON.stringify({version:1,target:arg,ffmpeg:'9.0.2',sources,files,distributionFiles},null,2));
 } else if(action==='verify') {await verifyMedia(arg);console.log('Verified bundled media without system PATH.');}
 else if(action==='prepare') await prepareMedia(arg);
 else throw new Error('Unknown media preparation operation');
}
