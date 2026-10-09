import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import { buildInvocation, cloudflaredBuild, CLOUDFLARED_MANIFEST, downloadArchive, extractArchive, extractTar, extractZip, licenseMatches, MANIFEST, prepareTarget, targetSpec, validateArchivePath, verifyBinary, verifyCloudflaredLicense, verifyStaged } from './prepare-codexify.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function tar(entries) {
  const chunks = [];
  for (const { name, data = Buffer.alloc(0), type = 48 } of entries) {
    const bytes = Buffer.from(data), header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000755\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156); header[156] = type;
    header.write('ustar\0', 257, 6, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data = Buffer.alloc(0), attributes = 0 } of entries) {
    const file = Buffer.from(data), filename = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(file), 14); local.writeUInt32LE(file.length, 18); local.writeUInt32LE(file.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(file), 16); central.writeUInt32LE(file.length, 20); central.writeUInt32LE(file.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(attributes, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, file); centrals.push(central, filename); offset += 30 + filename.length + file.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function required(spec) { return [{ name: `${spec.directory}/${spec.executable}`, data: 'binary fixture' }, { name: `${spec.directory}/LICENSE`, data: 'license fixture' }]; }
async function temporary(task) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'toris-runtime-test-'));
  try { await task(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('release targets are exact and desktop builds always include the runtime overlay', () => {
  for (const target of Object.keys(MANIFEST.targets)) {
    assert.match(targetSpec(target).url, /^https:\/\/github\.com\/devnoname120\/codexify\/releases\/download\/v1\.7\.0\//);
    assert.match(targetSpec(target, 'cloudflared').url, /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/2026\.10\.0\//);
    assert.equal(targetSpec(target).sha256.length, 64);
  }
  for (const target of ['x86_64-unknown-linux-gnu', '../../other', 'aarch64-apple-darwin;id', '__proto__']) assert.throws(() => targetSpec(target), /Unsupported/);
  const root = path.resolve('fixture-root');
  const invocation = buildInvocation(['--ci', '--target', 'x86_64-apple-darwin', '--bundles', 'app,dmg'], { root, host: () => assert.fail('Explicit target must win') });
  assert.equal(invocation.target, 'x86_64-apple-darwin');
  assert.deepEqual(invocation.args.slice(1, 3), ['--config', path.join(root, 'desktop/src-tauri/tauri.codexify.conf.json')]);
  const forwarded = buildInvocation(['--', '--release'], { root, host: () => 'aarch64-apple-darwin' });
  assert.ok(forwarded.args.indexOf('--config') < forwarded.args.indexOf('--'), 'Cargo passthrough must not swallow the runtime overlay');
  assert.equal(buildInvocation([], { root, host: () => 'aarch64-apple-darwin' }).target, 'aarch64-apple-darwin');
  for (const args of [['--config', 'unsafe.json'], ['--config={}'], ['-c', 'unsafe.json'], ['-cunsafe.json'], ['--target'], ['--target=x86_64-apple-darwin', '--target=aarch64-apple-darwin']]) assert.throws(() => buildInvocation(args));
});

test('official preview preserves both runtimes and licenses while disabling only updater artifact generation', () => {
  const invocation = buildInvocation(['--ci', '--target', 'aarch64-apple-darwin'], { preview: true });
  const overlay = JSON.parse(invocation.args[2]);
  assert.deepEqual(overlay.bundle.externalBin, ['binaries/codexify', 'binaries/cloudflared']);
  assert.equal(Object.keys(overlay.bundle.resources).length, 6);
  const binaries = new Set(overlay.bundle.externalBin.map(file => path.basename(file)));
  for (const [source, destination] of Object.entries(overlay.bundle.resources)) {
    const runtime = source.split('/')[1];
    assert.ok(destination.startsWith(`${runtime}-notices/`));
    assert.equal(binaries.has(destination.split('/')[0]), false, 'Resource directories must not collide with Unix sidecar executables in Tauri staging');
  }
  assert.equal(overlay.bundle.createUpdaterArtifacts, false);
  assert.deepEqual(Object.keys(overlay).sort(), ['$schema', 'bundle']);
  assert.deepEqual(Object.keys(overlay.bundle).sort(), ['createUpdaterArtifacts', 'externalBin', 'resources']);
  for (const option of [['--config', 'unsafe.json'], ['--config={}']]) assert.throws(() => buildInvocation(option, { preview: true }));
});

test('archive paths reject traversal, absolute Windows paths, controls, and links', () => {
  assert.equal(validateArchivePath('release/docs/reference.md'), 'release/docs/reference.md');
  for (const name of ['../file', 'release/../../file', '/file', 'C:/file', '\\server\\file', 'release/./file', 'release\\file', 'release/\0file', 'release/\nfile']) assert.throws(() => validateArchivePath(name), /Unsafe/);
  const spec = targetSpec('aarch64-apple-darwin');
  assert.throws(() => extractTar(tar([{ name: 'outside', type: 50 }, ...required(spec)]), spec), /regular files/);
});

test('tar extracts only the exact executable and LICENSE and rejects missing/duplicate/traversal entries', () => {
  const spec = targetSpec('aarch64-apple-darwin');
  const entries = [...required(spec), { name: `${spec.directory}/README.md`, data: 'not shipped' }];
  const result = extractTar(tar(entries), spec);
  assert.deepEqual(Object.keys(result), ['binary', 'license']);
  assert.equal(result.binary.toString(), 'binary fixture');
  assert.equal(result.license.toString(), 'license fixture');
  assert.throws(() => extractTar(tar([entries[0]]), spec), /required LICENSE/);
  assert.throws(() => extractTar(tar([...entries, entries[0]]), spec), /Duplicate/);
  assert.throws(() => extractTar(tar([...entries, { name: '../ignored-data', data: 'unsafe' }]), spec), /Unsafe/);
  let record = ' path=../escaped\n';
  for (let length = record.length; ; ) { const next = record.length + String(length).length; if (next === length) { record = `${length}${record}`; break; } length = next; }
  assert.throws(() => extractTar(tar([{ name: 'PaxHeader', type: 120, data: record }, ...entries]), spec), /Unsafe/);
});

test('ZIP checks the exact local names, CRC, links, duplicate and ignored traversal entries', () => {
  const spec = targetSpec('x86_64-pc-windows-msvc');
  const entries = required(spec);
  assert.equal(extractZip(zip(entries), spec).binary.toString(), 'binary fixture');
  assert.throws(() => extractZip(zip([...entries, entries[0]]), spec), /Duplicate/);
  assert.throws(() => extractZip(zip([...entries, { name: '../outside', data: 'ignored' }]), spec), /Unsafe/);
  assert.throws(() => extractZip(zip([{ ...entries[0], attributes: 0xa0000000 }, entries[1]]), spec), /Links/);
  const corrupted = zip(entries); corrupted[30 + Buffer.byteLength(entries[0].name)] ^= 1;
  assert.throws(() => extractZip(corrupted, spec), /checksum/);
  const conflicting = zip(entries); conflicting[30] = 88;
  assert.throws(() => extractZip(conflicting, spec), /Inconsistent/);
});

test('archive pin fails before extraction and oversized compressed content stays bounded', () => {
  const spec = targetSpec('aarch64-apple-darwin'), bytes = tar(required(spec));
  assert.throws(() => extractArchive(bytes, spec), /SHA256/);
  assert.equal(extractArchive(bytes, { ...spec, sha256: digest(bytes) }).license.toString(), 'license fixture');
  assert.throws(() => extractArchive(bytes, { ...spec, maxBytes: bytes.length - 1 }), /allowed size/);
});

test('Cloudflare direct EXE and flat tar use the same fixed target and checksum validation', () => {
  const spec = targetSpec('aarch64-apple-darwin', 'cloudflared');
  const bytes = tar([{ name: 'cloudflared', data: 'cloudflared fixture' }]);
  assert.equal(extractArchive(bytes, { ...spec, sha256: digest(bytes) }).binary.toString(), 'cloudflared fixture');
  const direct = targetSpec('x86_64-pc-windows-msvc', 'cloudflared'), executable = Buffer.from('direct fixture');
  assert.equal(extractArchive(executable, { ...direct, sha256: digest(executable) }).binary.toString(), 'direct fixture');
  assert.equal(direct.version, CLOUDFLARED_MANIFEST.version);
});

test('Windows archive license CRLF preserves exact upstream text while modified notices are rejected', () => {
  assert.equal(licenseMatches(Buffer.from('MIT License\r\nCopyright author\r\n'), Buffer.from('MIT License\nCopyright author\n')), true);
  assert.equal(licenseMatches(Buffer.from('MIT License\r\nCopyright other\r\n'), Buffer.from('MIT License\nCopyright author\n')), false);
  assert.equal(licenseMatches(Buffer.from('MIT License\n Copyright author\n'), Buffer.from('MIT License\nCopyright author\n')), false);
});

test('Cloudflare pinned Git blob accepts Windows CRLF checkout and rejects modified license text', async () => {
  const committed = await readFile(new URL('../desktop/src-tauri/resources/cloudflared/LICENSE', import.meta.url));
  const windows = Buffer.from(committed.toString('utf8').replace(/\r?\n/g, '\r\n'));
  assert.doesNotThrow(() => verifyCloudflaredLicense(windows));
  assert.doesNotThrow(() => verifyCloudflaredLicense(Buffer.from(windows.toString('utf8').replace(/\r\n/g, '\n'))));
  const modified = Buffer.from(windows.toString('utf8').replace('Apache License', 'Changed License'));
  assert.throws(() => verifyCloudflaredLicense(modified), /pinned upstream source/);
  assert.throws(() => verifyCloudflaredLicense(Buffer.concat([windows, Buffer.from(' ')])), /pinned upstream source/);
});

test('download refuses HTTP errors, untrusted redirects, excess bodies and mismatched SHA256 without network access', async () => {
  const bytes = Buffer.from('official fixture');
  const spec = { ...targetSpec('aarch64-apple-darwin'), sha256: digest(bytes) };
  assert.equal((await downloadArchive(spec, { fetcher: async () => new Response(bytes) })).toString(), bytes.toString());
  await assert.rejects(downloadArchive(spec, { fetcher: async () => new Response('404', { status: 404 }) }), /HTTP 404/);
  await assert.rejects(downloadArchive(spec, { fetcher: async () => new Response('different') }), /SHA256/);
  await assert.rejects(downloadArchive(spec, { fetcher: async () => new Response(bytes), maxBytes: 3 }), /allowed size/);
  await assert.rejects(downloadArchive(spec, { fetcher: async () => new Response(bytes, { headers: { 'content-length': '9999' } }), maxBytes: 3 }), /allowed size/);
  await assert.rejects(downloadArchive(spec, { fetcher: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }) }), /untrusted/);
  let calls = 0;
  await assert.rejects(downloadArchive(spec, { fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: spec.url } }); } }), /Too many/);
  assert.equal(calls, 4);
  await assert.rejects(downloadArchive({ ...spec, url: 'https://github.com@evil.example/file' }, { fetcher: () => assert.fail('Must refuse before fetching') }), /untrusted/);
  await assert.rejects(downloadArchive(spec, { timeoutMs: 1, fetcher: async (_url, { signal }) => {
    await new Promise(resolve => setTimeout(resolve, 10)); signal.throwIfAborted(); return new Response(bytes);
  } }), { name: 'TimeoutError' });
});

test('architecture verification rejects accidental Intel/ARM swaps and malformed Windows files', () => {
  const macho = Buffer.alloc(64); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(0x0100000c, 4);
  macho.writeUInt32LE(1, 16); macho.writeUInt32LE(24, 20); macho.writeUInt32LE(0x32, 32); macho.writeUInt32LE(24, 36); macho.writeUInt32LE(0xc0000, 44);
  verifyBinary(macho, 'aarch64-apple-darwin');
  assert.throws(() => verifyBinary(macho, 'x86_64-apple-darwin'), /architecture/);
  macho.writeUInt32LE(0xf0000, 44); assert.throws(() => verifyBinary(macho, 'aarch64-apple-darwin'), /macOS 12/);
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68);
  verifyBinary(pe, 'x86_64-pc-windows-msvc');
  pe.writeUInt16LE(0x14c, 68); assert.throws(() => verifyBinary(pe, 'x86_64-pc-windows-msvc'), /architecture/);
});

test('Mac source builds pin the toolchain, disable CGO and enforce go.sum for both CPU architectures', () => {
  for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
    const invocation = cloudflaredBuild(target, { source: '/fixture/source', destination: '/fixture/binary', cache: '/fixture/cache', go: '/fixture/go' });
    assert.equal(invocation.env.CGO_ENABLED, '0');
    assert.equal(invocation.env.GOARCH, target.startsWith('aarch64') ? 'arm64' : 'amd64');
    assert.equal(invocation.env.GOTOOLCHAIN, 'local');
    assert.equal(invocation.env.GOSUMDB, 'sum.golang.org');
    assert.ok(invocation.args.includes('-mod=readonly'));
    assert.ok(invocation.args.includes('-tags=netgo,osusergo'));
    assert.match(invocation.args[invocation.args.indexOf('-ldflags') + 1], /BuiltForPackageManager=toris-studio/);
  }
  assert.throws(() => cloudflaredBuild('x86_64-pc-windows-msvc', {}), /restricted/);
});

test('source and toolchain extraction reject files outside the exact pinned prefix and symlinks', () => {
  const spec = { directory: 'cloudflared-pinned' };
  const entries = [{ name: 'cloudflared-pinned/go.mod', data: 'module fixture' }];
  assert.equal(extractTar(tar(entries), spec, { allFiles: true }).size, 1);
  assert.throws(() => extractTar(tar([...entries, { name: 'other/go.mod', data: 'outside' }]), spec, { allFiles: true }), /escapes/);
  assert.throws(() => extractTar(tar([{ name: 'cloudflared-pinned/link', type: 50 }]), spec, { allFiles: true }), /regular files/);
});

test('cached archive tampering and symlink outputs fail before any executable is written', async () => temporary(async root => {
  const target = 'aarch64-apple-darwin', directory = path.join(root, 'desktop/src-tauri/binaries');
  await mkdir(path.join(directory, '.cache'), { recursive: true });
  await writeFile(path.join(directory, '.cache', targetSpec(target).archive), 'tampered cache');
  await assert.rejects(prepareTarget(target, { root, fetcher: () => assert.fail('Do not replace a failed pin silently') }), /Cached.*SHA256/);
  await assert.rejects(readFile(path.join(directory, `codexify-${target}`)), /ENOENT/);
  if (process.platform === 'win32') return; // Windows symlink creation requires an elevated privilege.
  await rm(directory, { recursive: true }); await mkdir(path.join(root, 'elsewhere'));
  await symlink(path.join(root, 'elsewhere'), directory);
  await assert.rejects(prepareTarget(target, { root, fetcher: () => assert.fail('Refuse output before downloading') }), /real directory/);
}));

test('release validation fails if the bundled executable or license/manifest is missing', async () => temporary(async root => {
  await assert.rejects(verifyStaged('x86_64-pc-windows-msvc', root), /ENOENT/);
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68);
  await writeFile(path.join(root, 'codexify.exe'), pe);
  await assert.rejects(verifyStaged('x86_64-pc-windows-msvc', root), /ENOENT/);
}));
