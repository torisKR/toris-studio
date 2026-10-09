import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCE = path.join(ROOT, 'desktop/src-tauri/resources/codexify');
const RUNTIME_OVERLAY = JSON.parse(readFileSync(path.join(ROOT, 'desktop/src-tauri/tauri.codexify.conf.json'), 'utf8'));
export const MANIFEST = JSON.parse(readFileSync(path.join(RESOURCE, 'manifest.json'), 'utf8'));
export const CLOUDFLARED_MANIFEST = JSON.parse(readFileSync(path.join(RESOURCE, '../cloudflared/manifest.json'), 'utf8'));
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 128;
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'codeload.github.com', 'go.dev', 'dl.google.com']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(message) { throw new Error(message); }
export function licenseMatches(upstream, committed) {
  // GitHub's Windows checkout stores the same upstream license with CRLF.
  return upstream.toString('utf8').replace(/\r\n/g, '\n') === committed.toString('utf8').replace(/\r\n/g, '\n');
}
export function verifyCloudflaredLicense(committed) {
  // Git's Windows checkout may change LF to CRLF; the upstream Git blob uses LF.
  const canonical = Buffer.from(committed.toString('utf8').replace(/\r\n/g, '\n'));
  const blob = createHash('sha1').update(`blob ${canonical.length}\0`).update(canonical).digest('hex');
  if (blob !== CLOUDFLARED_MANIFEST.licenseGitBlob) fail('Cloudflared LICENSE differs from the pinned upstream source.');
}
export function targetSpec(target, runtime = 'codexify') {
  if (!['codexify', 'cloudflared'].includes(runtime)) fail('Unsupported bundled runtime.');
  const manifest = runtime === 'codexify' ? MANIFEST : CLOUDFLARED_MANIFEST;
  if (!Object.hasOwn(manifest.targets, target)) fail(`Unsupported ${runtime} target: ${target}.`);
  const spec = manifest.targets[target];
  return { ...spec, target, runtime, version: manifest.version,
    directory: runtime === 'codexify' ? spec.archive.replace(/\.(tar\.gz|zip)$/, '') : '',
    licenseRequired: runtime === 'codexify',
    executable: `${runtime}${target.includes('windows') ? '.exe' : ''}`,
    maxBytes: spec.archive.endsWith('.exe') ? MAX_FILE_BYTES : MAX_ARCHIVE_BYTES,
    url: `${manifest.repository}/releases/download/${runtime === 'codexify' ? 'v' : ''}${manifest.version}/${spec.archive}` };
}
export function validateArchivePath(name) {
  if (!name || name.length > 512 || name.includes('\\') || name.includes('\0') ||
      name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '.' || part === '..') ||
      /[\x00-\x1f\x7f]/.test(name)) fail('Unsafe Codexify archive path.');
  return name;
}
function entryName(spec, name) { return `${spec.directory ? `${spec.directory}/` : ''}${name}`; }
function wantedFiles(spec) { return new Set([entryName(spec, spec.executable), ...(spec.licenseRequired === false ? [] : [entryName(spec, 'LICENSE')])]); }
function addFile(files, name, bytes, wanted) {
  if (!wanted.has(name)) return;
  if (files.has(name)) fail('Duplicate Codexify executable or license in archive.');
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) fail('Invalid Codexify archive file size.');
  files.set(name, Buffer.from(bytes));
}
function complete(files, spec) {
  const binary = files.get(entryName(spec, spec.executable));
  const license = files.get(entryName(spec, 'LICENSE'));
  if (!binary || (spec.licenseRequired !== false && !license)) fail('Archive must contain exactly the expected executable and required LICENSE.');
  return { binary, license };
}
function tarNumber(bytes) {
  const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) fail('Invalid Codexify tar size or checksum.');
  const result = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(result)) fail('Invalid Codexify tar number.');
  return result;
}
function paxFields(bytes) {
  let offset = 0;
  const fields = {};
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) fail('Invalid Codexify tar metadata.');
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d*$/.test(lengthText)) fail('Invalid Codexify tar metadata.');
    const length = Number(lengthText);
    if (length < space - offset + 4 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) fail('Invalid Codexify tar metadata.');
    const field = bytes.subarray(space + 1, offset + length - 1).toString('utf8');
    const split = field.indexOf('=');
    if (split < 1) fail('Invalid Codexify tar metadata.');
    fields[field.slice(0, split)] = field.slice(split + 1);
    offset += length;
  }
  if (fields.path) validateArchivePath(fields.path);
  if (fields.linkpath) fail('Links are not allowed in the Codexify archive.');
  return fields;
}
export function extractTar(archive, spec, { allFiles = false, maxEntries = MAX_ENTRIES, maxExpanded = MAX_EXPANDED_BYTES } = {}) {
  const bytes = gunzipSync(archive, { maxOutputLength: maxExpanded });
  const files = new Map();
  const wanted = wantedFiles(spec);
  let offset = 0, count = 0, nextPax = {}, globalPax = {};
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    if (++count > maxEntries) fail('Too many entries in Codexify archive.');
    const storedChecksum = tarNumber(header.subarray(148, 156));
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== storedChecksum) fail('Invalid Codexify tar checksum.');
    const text = field => field.toString('utf8').replace(/\0.*$/, '');
    const prefix = text(header.subarray(345, 500));
    let name = validateArchivePath(`${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`);
    const size = tarNumber(header.subarray(124, 136));
    if (size > MAX_FILE_BYTES || offset + 512 + size > bytes.length) fail('Invalid Codexify tar file size.');
    const type = header[156];
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 120 || type === 103) {
      if (size > 16 * 1024) fail('Excessive Codexify tar metadata.');
      const fields = paxFields(body);
      if (type === 120) nextPax = fields; else globalPax = { ...globalPax, ...fields };
      continue;
    }
    name = validateArchivePath(nextPax.path || globalPax.path || name);
    if ((nextPax.size || globalPax.size) && Number(nextPax.size || globalPax.size) !== size) fail('Unsupported Codexify tar metadata size.');
    nextPax = {};
    if (type === 53) { if (size !== 0) fail('Invalid Codexify tar directory.'); continue; }
    if (type !== 0 && type !== 48) fail('Only regular files and directories are allowed in Codexify archive.');
    if (allFiles) {
      if (!name.startsWith(`${spec.directory}/`)) fail('Source archive file escapes the pinned directory.');
      if (files.has(name)) fail('Duplicate source archive file.');
      files.set(name, Buffer.from(body));
    } else addFile(files, name, body, wanted);
  }
  return allFiles ? files : complete(files, spec);
}
export function extractZip(bytes, spec) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('Invalid Codexify ZIP archive.');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralOffset = bytes.readUInt32LE(end + 16);
  if (count === 0 || count > MAX_ENTRIES || count !== bytes.readUInt16LE(end + 8) || centralOffset + centralSize !== end) fail('Invalid Codexify ZIP directory.');
  const files = new Map(), wanted = wantedFiles(spec);
  let offset = centralOffset, totalExpanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail('Invalid Codexify ZIP entry.');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32);
    const attributes = bytes.readUInt32LE(offset + 38), localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > end || flags & 1 || ![0, 8].includes(method) || compressed > MAX_ARCHIVE_BYTES || expanded > MAX_FILE_BYTES || (totalExpanded += expanded) > MAX_EXPANDED_BYTES) fail('Unsupported Codexify ZIP entry.');
    const name = validateArchivePath(bytes.subarray(offset + 46, offset + 46 + nameSize).toString('utf8'));
    const unixType = (attributes >>> 16) & 0xf000;
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000) fail('Links are not allowed in Codexify ZIP archive.');
    if (bytes.readUInt16LE(offset + 34) !== 0 || localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) fail('Invalid Codexify ZIP local entry.');
    const localNameSize = bytes.readUInt16LE(localOffset + 26), localExtraSize = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameSize + localExtraSize;
    if (start + compressed > centralOffset || bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize).toString('utf8') !== name || bytes.readUInt16LE(localOffset + 8) !== method || bytes.readUInt16LE(localOffset + 6) !== flags) fail('Inconsistent Codexify ZIP local entry.');
    if (name.endsWith('/')) { if (expanded) fail('Invalid Codexify ZIP directory.'); }
    else if (wanted.has(name)) {
      const data = bytes.subarray(start, start + compressed);
      const decoded = method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_FILE_BYTES });
      if (decoded.length !== expanded || crc32(decoded) !== crc) fail('Invalid Codexify ZIP file checksum.');
      addFile(files, name, decoded, wanted);
    }
    offset = next;
  }
  if (offset !== end) fail('Invalid Codexify ZIP directory length.');
  return complete(files, spec);
}
export function extractArchive(bytes, spec) {
  if (!bytes.length || bytes.length > (spec.maxBytes || MAX_ARCHIVE_BYTES)) fail('Codexify archive exceeds the allowed size.');
  if (sha256(bytes) !== spec.sha256) fail('Codexify archive SHA256 does not match the pinned release.');
  if (spec.archive.endsWith('.exe')) return { binary: bytes };
  return spec.archive.endsWith('.zip') ? extractZip(bytes, spec) : extractTar(bytes, spec);
}
export async function downloadArchive(spec, { fetcher = fetch, timeoutMs = 60_000, maxBytes = spec.maxBytes || MAX_ARCHIVE_BYTES } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = spec.url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !DOWNLOAD_HOSTS.has(parsed.hostname)) fail('Refusing an untrusted Codexify download URL.');
    const response = await fetcher(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) fail('Codexify download redirect has no target.');
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) fail(`Codexify download returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length') || 0) > maxBytes) { await response.body.cancel(); fail('Codexify download exceeds the allowed size.'); }
    const parts = []; let length = 0;
    for await (const part of response.body) {
      length += part.length;
      if (length > maxBytes) fail('Codexify download exceeds the allowed size.');
      parts.push(Buffer.from(part));
    }
    const bytes = Buffer.concat(parts);
    if (!bytes.length || sha256(bytes) !== spec.sha256) fail('Codexify download SHA256 does not match the pinned release.');
    return bytes;
  }
  fail('Too many Codexify download redirects.');
}
export function verifyBinary(bytes, target) {
  if (target.includes('darwin')) {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (target.startsWith('aarch64') ? 0x0100000c : 0x01000007)) fail('Codexify Mach-O architecture does not match target.');
    const count = bytes.readUInt32LE(16), commandBytes = bytes.readUInt32LE(20);
    if (count > 1024 || 32 + commandBytes > bytes.length) fail('Invalid bundled Mach-O load commands.');
    let offset = 32, minimum = null;
    for (let i = 0; i < count; i++) {
      if (offset + 8 > 32 + commandBytes) fail('Invalid bundled Mach-O load command.');
      const command = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
      if (size < 8 || offset + size > 32 + commandBytes) fail('Invalid bundled Mach-O load command size.');
      if (command === 0x32) { if (size < 24) fail('Invalid Mach-O build version.'); minimum = Math.max(minimum || 0, bytes.readUInt32LE(offset + 12)); }
      if (command === 0x24) { if (size < 16) fail('Invalid Mach-O minimum version.'); minimum = Math.max(minimum || 0, bytes.readUInt32LE(offset + 8)); }
      offset += size;
    }
    if (minimum === null || minimum > 0x000c0000) fail('Bundled runtime must support macOS 12.0 or earlier.');
  } else {
    if (bytes.length < 64 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') fail('Invalid Codexify Windows executable.');
    const pe = bytes.readUInt32LE(0x3c);
    if (pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550 || bytes.readUInt16LE(pe + 4) !== 0x8664) fail('Codexify PE architecture does not match target.');
  }
}
async function safeDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Codexify output must be a real directory.');
}
async function regularFile(file, max = MAX_FILE_BYTES) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > max) fail('Codexify file must be a bounded regular file.');
  const bytes = await readFile(file);
  if (bytes.length > max) fail('Codexify file exceeds the allowed size.');
  return bytes;
}
async function atomicWrite(file, bytes, mode) {
  const scratch = await mkdtemp(path.join(path.dirname(file), '.prepare-'));
  try {
    const staged = path.join(scratch, 'file');
    await writeFile(staged, bytes, { mode });
    try { await regularFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(staged, file);
    if (process.platform !== 'win32') await chmod(file, mode);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
async function cachedDownload(spec, cache, fetcher) {
  const file = path.join(cache, spec.archive);
  let bytes;
  try { bytes = await regularFile(file, spec.maxBytes || MAX_ARCHIVE_BYTES); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes && sha256(bytes) !== spec.sha256) fail('Cached source/toolchain SHA256 does not match the pinned release.');
  if (!bytes) { bytes = await downloadArchive(spec, { fetcher }); await atomicWrite(file, bytes, 0o600); }
  return bytes;
}
async function extractSource(archive, prefix, destination, { toolchain = false } = {}) {
  const files = extractTar(archive, { directory: prefix }, { allFiles: true, maxEntries: 40_000, maxExpanded: 512 * 1024 * 1024 });
  for (const [name, bytes] of files) {
    const relative = name.slice(prefix.length + 1);
    const file = path.join(destination, relative);
    await mkdir(path.dirname(file), { recursive: true });
    const executable = toolchain && (relative.startsWith('bin/') || relative.startsWith('pkg/tool/'));
    await writeFile(file, bytes, { flag: 'wx', mode: executable ? 0o755 : 0o644 });
  }
}
function exactGo(command) {
  const result = spawnSync(command, ['version'], { encoding: 'utf8', timeout: 15_000, shell: false, env: { ...process.env, GOENV: 'off', GOTOOLCHAIN: 'local' } });
  return result.status === 0 && result.stdout.startsWith(`go version go${CLOUDFLARED_MANIFEST.goVersion} `);
}
export function cloudflaredBuild(target, { source, destination, cache, go }) {
  const spec = targetSpec(target, 'cloudflared');
  if (!target.includes('darwin') || spec.build !== 'source') fail('Cloudflared source build is restricted to macOS targets.');
  return {
    command: go,
    args: ['build', '-trimpath', '-buildvcs=false', '-mod=readonly', '-tags=netgo,osusergo',
      '-ldflags', `-X main.Version=${spec.version} -X main.BuildTime=2026-10-05-17:37UTC -X github.com/cloudflare/cloudflared/cmd/cloudflared/updater.BuiltForPackageManager=toris-studio`,
      '-o', destination, './cmd/cloudflared'],
    cwd: source,
    env: { ...process.env, GOENV: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '',
      CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: target.startsWith('aarch64') ? 'arm64' : 'amd64',
      GOPROXY: 'https://proxy.golang.org,direct', GOSUMDB: 'sum.golang.org', GOPRIVATE: '', GONOSUMDB: '', GONOPROXY: '',
      GOMODCACHE: path.join(cache, 'go-mod'), GOCACHE: path.join(cache, 'go-build'), GOPATH: path.join(cache, 'go-path') },
  };
}
async function runBounded(command, args, options) {
  const child = spawn(command, args, { ...options, shell: false, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1)); });
    if (code !== 0) fail('Pinned cloudflared source build failed.');
  } finally { clearTimeout(timer); }
}
async function prepareCloudflaredSource(target, { root, fetcher }) {
  const directory = path.join(root, 'desktop/src-tauri/binaries');
  await safeDirectory(directory);
  const cache = path.join(directory, '.cache');
  await safeDirectory(cache);
  const scratch = await mkdtemp(path.join(cache, '.cloudflared-source-'));
  try {
    let go = 'go';
    if (!exactGo(go)) {
      const host = `darwin-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
      if (process.platform !== 'darwin' || !Object.hasOwn(CLOUDFLARED_MANIFEST.toolchains, host)) fail(`Install Go ${CLOUDFLARED_MANIFEST.goVersion} to build cloudflared for macOS.`);
      const spec = { ...CLOUDFLARED_MANIFEST.toolchains[host], maxBytes: 96 * 1024 * 1024 };
      const archive = await cachedDownload(spec, cache, fetcher);
      const toolchain = path.join(scratch, 'toolchain');
      await extractSource(archive, 'go', toolchain, { toolchain: true });
      go = path.join(toolchain, 'bin/go');
      if (!exactGo(go)) fail('Pinned Go toolchain version could not be verified.');
    }
    const source = path.join(scratch, 'source');
    const archive = await cachedDownload(CLOUDFLARED_MANIFEST.sourceArchive, cache, fetcher);
    await extractSource(archive, `cloudflared-${CLOUDFLARED_MANIFEST.sourceCommit}`, source);
    const upstreamLicense = await regularFile(path.join(source, 'LICENSE'), 16 * 1024);
    if (!upstreamLicense.equals(await regularFile(path.join(root, 'desktop/src-tauri/resources/cloudflared/LICENSE'), 16 * 1024))) fail('Pinned cloudflared source LICENSE differs from the committed license.');
    const destination = path.join(scratch, 'cloudflared');
    const invocation = cloudflaredBuild(target, { source, destination, cache, go });
    console.log(`Building cloudflared ${CLOUDFLARED_MANIFEST.version} from pinned source with Go ${CLOUDFLARED_MANIFEST.goVersion}, CGO disabled (${target}).`);
    await runBounded(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env });
    const binary = await regularFile(destination);
    verifyBinary(binary, target);
    const file = path.join(directory, `cloudflared-${target}`);
    await atomicWrite(file, binary, 0o755);
    console.log(`Prepared cloudflared ${CLOUDFLARED_MANIFEST.version}; verified pinned source, architecture, and macOS 12 deployment target.`);
    return file;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function prepareTarget(target, { root = ROOT, fetcher = fetch, runtime = 'codexify' } = {}) {
  const spec = targetSpec(target, runtime);
  if (spec.build === 'source') return prepareCloudflaredSource(target, { root, fetcher });
  const directory = path.join(root, 'desktop/src-tauri/binaries');
  await safeDirectory(directory);
  const cache = path.join(directory, '.cache');
  await safeDirectory(cache);
  const cachedArchive = path.join(cache, spec.archive);
  let archive;
  try { archive = await regularFile(cachedArchive, spec.maxBytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (archive && sha256(archive) !== spec.sha256) fail('Cached Codexify archive SHA256 does not match the pinned release.');
  if (!archive) {
    archive = await downloadArchive(spec, { fetcher });
    await atomicWrite(cachedArchive, archive, 0o600);
  }
  const { binary, license } = extractArchive(archive, spec);
  verifyBinary(binary, target);
  const committedLicense = await regularFile(path.join(root, `desktop/src-tauri/resources/${runtime}/LICENSE`), 16 * 1024);
  if (license && !licenseMatches(license, committedLicense)) fail('Codexify archive LICENSE differs from the committed license.');
  if (runtime === 'cloudflared') verifyCloudflaredLicense(committedLicense);
  const file = path.join(directory, `${runtime}-${target}${target.includes('windows') ? '.exe' : ''}`);
  await atomicWrite(file, binary, 0o755);
  console.log(`Prepared ${runtime} ${spec.version} for ${target}; verified upstream SHA256 and license.`);
  return file;
}
function hostTarget() {
  const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8', shell: false });
  if (rustc.status !== 0) fail('rustc could not identify the desktop build target.');
  const target = rustc.stdout.match(/^host: (.+)$/m)?.[1];
  targetSpec(target);
  return target;
}
export function buildInvocation(args, { root = ROOT, host = hostTarget, preview = false } = {}) {
  if (args.some(arg => arg === '--config' || arg === '-c' || arg.startsWith('--config=') || /^-c.+/.test(arg))) fail('desktop:build always uses the verified Codexify bundle configuration.');
  const targetArguments = args.flatMap((arg, i) => arg === '--target' ? [args[i + 1]] : arg.startsWith('--target=') ? [arg.slice(9)] : []);
  if (targetArguments.length > 1) fail('Only one Codexify target may be built at a time.');
  const target = targetArguments.length ? targetArguments[0] : host();
  targetSpec(target);
  const config = preview ? JSON.stringify({ ...RUNTIME_OVERLAY, bundle: { ...RUNTIME_OVERLAY.bundle, createUpdaterArtifacts: false } }) : path.join(root, 'desktop/src-tauri/tauri.codexify.conf.json');
  return { target, cwd: path.join(root, 'desktop'), args: ['build', '--config', config, ...args] };
}
export async function verifyStaged(target, directory, { root = ROOT } = {}) {
  targetSpec(target);
  const mac = target.includes('darwin');
  const host = process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : '';
  for (const runtime of ['codexify', 'cloudflared']) {
    const spec = targetSpec(target, runtime);
    const binary = path.join(directory, mac ? `Contents/MacOS/${runtime}` : `${runtime}.exe`);
    const resources = path.join(directory, mac ? `Contents/Resources/${runtime}-notices` : `${runtime}-notices`);
    verifyBinary(await regularFile(binary), target);
    for (const name of ['LICENSE', 'NOTICE', 'manifest.json']) {
      if (!(await regularFile(path.join(resources, name), 32 * 1024)).equals(await regularFile(path.join(root, `desktop/src-tauri/resources/${runtime}`, name), 32 * 1024))) fail(`Bundled ${runtime} ${name} differs from the verified source.`);
    }
    if (mac) {
      const result = spawnSync('codesign', ['--verify', '--strict', binary], { encoding: 'utf8', timeout: 15_000, shell: false });
      if (result.status !== 0) fail(`Bundled ${runtime} macOS code signature is invalid.`);
    }
    if (target === host) {
      const probe = spawnSync(binary, [runtime === 'codexify' ? '--help' : '--version'], { encoding: 'utf8', timeout: 15_000, shell: false });
      if (probe.status !== 0 || !probe.stdout?.includes(runtime === 'codexify' ? 'Codexify MCP bridge' : `cloudflared version ${spec.version}`)) fail(`Bundled ${runtime} executable failed its official startup probe.`);
    }
    console.log(`Verified bundled ${runtime} ${spec.version}: ${target} executable, architecture, license, and pinned metadata.`);
  }
}
async function prepareBundled(target) { for (const runtime of ['codexify', 'cloudflared']) await prepareTarget(target, { runtime }); }
async function main([command = 'prepare', ...args]) {
  if (command === 'prepare') { if (args.length > 1) fail('Usage: prepare-codexify.mjs prepare [target]'); await prepareBundled(args[0] || hostTarget()); }
  else if (command === 'verify') { if (args.length !== 2) fail('Usage: prepare-codexify.mjs verify <target> <bundle-or-stage-directory>'); await verifyStaged(args[0], path.resolve(args[1])); }
  else if (command === 'build' || command === 'preview') {
    const invocation = buildInvocation(args, { preview: command === 'preview' });
    await prepareBundled(invocation.target);
    const require = createRequire(import.meta.url);
    const child = spawn(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...invocation.args], { cwd: invocation.cwd, stdio: 'inherit', shell: false });
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1)); });
  } else fail('Expected prepare, verify, build, or preview command.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
