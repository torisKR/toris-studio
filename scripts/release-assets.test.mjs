import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { assertCompleteDraft, assertReleaseIdentity, collect, findRelease, hashResponse, PLATFORMS, preflight, publish, quarantine, version } from './release-assets.mjs';

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

async function publicationFixture(root, task) {
  const names = [...new Set(Object.values(PLATFORMS).flatMap(({ installer, updater }) => [installer, updater, `${updater}.sig`]))];
  const directory = path.join(root, 'assets');
  await mkdir(directory);
  for (const name of names) await writeFile(path.join(directory, name), 'fixture bytes');
  for (const platform of Object.keys(PLATFORMS)) await writeFile(path.join(directory, `build-${platform}.json`), '{}');
  await writeFile(path.join(directory, 'latest.json'), '{}');
  await writeFile(path.join(directory, 'SHA256SUMS'), 'fixture checksums');
  await writeFile(path.join(directory, 'DOWNLOADS.md'), 'fixture release instructions');
  await writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify({ version: '0.1.10', commit: source, files: names.map(name => ({ name })) }));
  const assetNames = [...names, ...Object.keys(PLATFORMS).map(platform => `build-${platform}.json`), 'latest.json', 'SHA256SUMS', 'DOWNLOADS.md', 'release-manifest.json'];
  const fixtureEnv = { RELEASE_VERSION: '0.1.10', RELEASE_TAG: 'v0.1.10', RELEASE_COMMIT: source, GITHUB_REPOSITORY: 'torisKR/toris-studio', RUNNER_TEMP: root, GITHUB_RUN_ID: 'fixture', GHCR_TOKEN: 'fixture-token' };
  const previous = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixtureEnv);
  try { await task(directory, assetNames); } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

test('retained draft resolves through authenticated pagination when REST tag returns 404', async () => {
  const draft = { id: 417, tag_name: 'v0.1.10', target_commitish: source, draft: true, assets: [] };
  const calls = [];
  const found = await findRelease('v0.1.10', async resource => {
    calls.push(resource);
    if (resource === 'releases/tags/v0.1.10') return null;
    if (resource.endsWith('page=1')) return Array.from({ length: 100 }, (_, index) => ({ tag_name: `v0.0.${index}` }));
    if (resource.endsWith('page=2')) return [draft];
    assert.fail('Unexpected release request');
  });
  assert.equal(found.id, 417);
  assert.equal(assertReleaseIdentity(found, 'v0.1.10', source), 417);
  assert.equal(calls.length, 3);
  for (const changed of [{ ...draft, id: 418 }, { ...draft, tag_name: 'v0.1.9' }, { ...draft, target_commitish: 'b'.repeat(40) }]) {
    assert.throws(() => assertReleaseIdentity(changed, 'v0.1.10', source, 417), /ID, tag, or source/);
  }
});

test('draft upload, promotion and quarantine use one verified release ID', async () => temporary(async root => publicationFixture(root, async (directory, assetNames) => {
  let release = null;
  let packagePushed = false;
  const transitions = [];
  const request = async (resource, options = {}) => {
    if (resource === 'releases/tags/v0.1.10') return null; // Documented draft behavior.
    if (resource === 'releases?per_page=100&page=1') return release ? [release] : [];
    if (resource === 'releases/latest') return null;
    if (resource === 'git/ref/tags/v0.1.10') return { object: { type: 'commit', sha: source } };
    assert.equal(resource, 'releases/417');
    assert.ok(release);
    if (options.method === 'PATCH') {
      assert.ok(packagePushed, 'Do not publish before OCI verification');
      transitions.push({ resource, body: options.body });
      release = { ...release, ...options.body };
    }
    return release;
  };
  const command = (program, args) => {
    if (program === 'gh' && args[1] === 'create') {
      release = { id: 417, tag_name: 'v0.1.10', target_commitish: source, draft: true, prerelease: false, assets: [] };
    } else if (program === 'gh' && args[1] === 'upload') {
      release.assets = assetNames.map(name => ({ name, size: 13 }));
    } else if (program === 'oras' && args[0] === 'push') {
      packagePushed = true;
    } else if (program === 'oras' && args[0] === 'manifest') {
      return JSON.stringify({ layers: assetNames.map(name => ({ annotations: { 'org.opencontainers.image.title': name } })) });
    } else assert.equal(program, 'oras');
    return '';
  };
  await publish(directory, { request, command, spawn: () => ({ status: 1, stderr: 'manifest unknown' }) });
  const state = JSON.parse(await readFile(path.join(root, 'toris-release-fixture.json'), 'utf8'));
  assert.equal(state.releaseId, 417);
  assert.equal(state.promoted, true);
  assert.equal(transitions[0].resource, 'releases/417');
  assert.deepEqual(transitions[0].body, { draft: false, prerelease: false, make_latest: 'true', body: 'fixture release instructions' });
  await quarantine({ request });
  assert.deepEqual(transitions[1], { resource: 'releases/417', body: { prerelease: true, make_latest: 'false' } });
  await assert.rejects(quarantine({ request: async () => ({ ...release, id: 418 }) }), /ID, tag, or source/);
  assert.equal(transitions.length, 2, 'A different release must never be quarantined');
})));

test('publisher refuses public releases and incomplete drafts before registry mutation', async () => temporary(async root => publicationFixture(root, async (directory, assetNames) => {
  const published = { id: 417, tag_name: 'v0.1.10', target_commitish: source, draft: false };
  await assert.rejects(publish(directory, {
    request: async () => published,
    command: () => assert.fail('Public releases must not be mutated'),
    spawn: () => assert.fail('Registry must not be accessed'),
  }), /already public/);
  const draft = { ...published, draft: true, assets: assetNames.slice(1).map(name => ({ name, size: 13 })) };
  assert.throws(() => assertCompleteDraft(draft, 'v0.1.10', source, 417, assetNames), /incomplete/);
  assert.throws(() => assertCompleteDraft({ ...draft, draft: false }, 'v0.1.10', source, 417, assetNames), /already public/);
})));
