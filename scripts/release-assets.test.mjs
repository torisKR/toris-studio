import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { collect, hashResponse, PLATFORMS, preflight, version } from './release-assets.mjs';

async function temporary(task) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'toris-release-test-'));
  try { return await task(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const source = 'a'.repeat(40);

test('release version rejects shell content and prerelease channels', () => {
  assert.equal(version('0.1.7'), '0.1.7');
  for (const input of ['v0.1.7', '01.2.3', '0.1.7-rc1', '0.1.7\n', '$(id)', '']) assert.throws(() => version(input));
});

test('preflight refuses absent private signing key and inconsistent desktop version', async () => temporary(async root => {
  await mkdir(path.join(root, 'desktop/src-tauri'), { recursive: true });
  const config = { version: '0.1.7', bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: 'public-key', requireSignedVersion: true, endpoints: ['https://github.com/torisKR/toris-studio/releases/latest/download/latest.json'] } } };
  await writeFile(path.join(root, 'desktop/src-tauri/tauri.conf.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'desktop/package.json'), JSON.stringify({ version: '0.1.7' }));
  await writeFile(path.join(root, 'desktop/src-tauri/Cargo.toml'), '[package]\nversion = "0.1.7"\n');
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.1.7', GITHUB_REF_NAME: 'v0.1.7', GITHUB_SHA: source };
  await assert.rejects(preflight(env, root), /signing.*secret/i);
  await assert.rejects(preflight({ ...env, INPUT_VERSION: '0.1.8', TAURI_SIGNING_PRIVATE_KEY: 'test-presence-only' }, root), /versions must match/);
  await assert.rejects(preflight({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature', TAURI_SIGNING_PRIVATE_KEY: 'test-presence-only' }, root), /run from main/);
}));

test('collector keeps canonical signed NSIS artifacts and excludes private files', async () => temporary(async root => {
  const bundle = path.join(root, 'bundle');
  const destination = path.join(root, 'assets');
  await mkdir(path.join(bundle, 'nsis'), { recursive: true });
  await writeFile(path.join(bundle, 'nsis/app_0.1.7_x64-setup.exe'), 'installer fixture');
  await writeFile(path.join(bundle, 'nsis/app_0.1.7_x64-setup.exe.sig'), 'signature fixture');
  await writeFile(path.join(bundle, 'private-signing-key'), 'never collect');
  await collect('windows-x86_64', bundle, destination, { RELEASE_VERSION: '0.1.7', RELEASE_COMMIT: source });
  assert.equal(await readFile(path.join(destination, PLATFORMS['windows-x86_64'].installer), 'utf8'), 'installer fixture');
  await assert.rejects(readFile(path.join(destination, 'private-signing-key')));
  const build = JSON.parse(await readFile(path.join(destination, 'build-windows-x86_64.json'), 'utf8'));
  assert.equal(build.commit, source);
}));

test('collector rejects missing signature and symbolic links', async () => temporary(async root => {
  const bundle = path.join(root, 'bundle');
  await mkdir(path.join(bundle, 'nsis'), { recursive: true });
  await writeFile(path.join(root, 'external.exe'), 'external');
  await symlink(path.join(root, 'external.exe'), path.join(bundle, 'nsis/app.exe'));
  await assert.rejects(collect('windows-x86_64', bundle, path.join(root, 'assets'), { RELEASE_VERSION: '0.1.7', RELEASE_COMMIT: source }), /regular file/);
}));

test('public download verification rejects HTTP errors and excessive bodies', async () => {
  await assert.rejects(hashResponse(new Response('missing', { status: 404 })), /HTTP 404/);
  await assert.rejects(hashResponse(new Response('1234'), 3), /allowed size/);
  assert.equal((await hashResponse(new Response('test'))).sha256, '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
});
