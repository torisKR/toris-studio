import { createHash } from 'node:crypto';
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'torisKR/toris-studio';
export const PACKAGE = 'ghcr.io/toriskr/toris-studio/desktop';
export const PLATFORMS = {
  'darwin-aarch64': { installer: 'Toris-Studio-macOS-arm64.dmg', updater: 'Toris-Studio-macOS-arm64.app.tar.gz', folder: 'macos' },
  'darwin-x86_64': { installer: 'Toris-Studio-macOS-x64.dmg', updater: 'Toris-Studio-macOS-x64.app.tar.gz', folder: 'macos' },
  'windows-x86_64': { installer: 'Toris-Studio-Windows-x64-setup.exe', updater: 'Toris-Studio-Windows-x64-setup.exe', folder: 'nsis' },
};
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[a-f0-9]{40}$/;
const PUBLIC_FILES = new Set([
  ...Object.values(PLATFORMS).flatMap(({ installer, updater }) => [installer, updater, `${updater}.sig`]),
  ...Object.keys(PLATFORMS).map(platform => `build-${platform}.json`),
  'latest.json', 'release-manifest.json', 'SHA256SUMS', 'DOWNLOADS.md',
]);

function fail(message) { throw new Error(message); }
export function version(value) {
  if (!STABLE_VERSION.test(value ?? '')) fail('Release version must be stable SemVer, for example 0.1.7.');
  return value;
}
function commit(value) {
  if (!COMMIT.test(value ?? '')) fail('Release source must be an exact 40-character Git commit.');
  return value;
}
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', shell: false, ...options });
  if (result.error || result.status !== 0) fail(`${program} failed${result.stderr ? `: ${result.stderr.trim()}` : '.'}`);
  return result.stdout?.trim() ?? '';
}
function releaseContext() {
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== REPOSITORY) fail('Publishing is restricted to the Toris Studio repository.');
  const releaseVersion = version(process.env.RELEASE_VERSION);
  if (process.env.RELEASE_TAG !== `v${releaseVersion}`) fail('Release tag does not match version.');
  return { releaseVersion, tag: `v${releaseVersion}`, source: commit(process.env.RELEASE_COMMIT) };
}
function newerThan(candidate, current) {
  const left = version(candidate).split('.').map(BigInt);
  const right = version(current).split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}
export async function preflight(env = process.env, root = process.cwd()) {
  const config = JSON.parse(await readFile(path.join(root, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const desktopPackage = JSON.parse(await readFile(path.join(root, 'desktop/package.json'), 'utf8'));
  const cargo = await readFile(path.join(root, 'desktop/src-tauri/Cargo.toml'), 'utf8');
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const releaseVersion = version(env.INPUT_VERSION || env.GITHUB_REF_NAME?.replace(/^v/, ''));
  if (config.version !== releaseVersion || desktopPackage.version !== releaseVersion || cargoVersion !== releaseVersion) fail('Desktop package, Cargo, Tauri, and release versions must match.');
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF !== `refs/tags/v${releaseVersion}`) fail('A release push must be a matching version tag.');
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF !== 'refs/heads/main') fail('Manual releases must run from main.');
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim()) fail('TAURI_SIGNING_PRIVATE_KEY Actions secret is required. No release was published.');
  if (config.bundle?.createUpdaterArtifacts !== true || !config.plugins?.updater?.pubkey?.trim() || config.plugins?.updater?.requireSignedVersion !== true) fail('Updater artifacts, a persistent public key, and requireSignedVersion must be configured.');
  const endpoints = config.plugins.updater.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 1 || endpoints[0] !== `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`) fail('Updater feed must point to the fixed public Toris Studio release.');
  const source = commit(env.GITHUB_SHA);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `version=${releaseVersion}\ntag=v${releaseVersion}\ncommit=${source}\n`);
  console.log(`Release v${releaseVersion}: source ${source}; signing key present (value hidden).`);
  return { version: releaseVersion, tag: `v${releaseVersion}`, commit: source };
}
export async function collect(platform, bundleRoot, destination, env = process.env) {
  const specification = PLATFORMS[platform];
  if (!specification) fail('Unsupported release platform.');
  const releaseVersion = version(env.RELEASE_VERSION);
  const source = commit(env.RELEASE_COMMIT);
  async function exactlyOne(folder, suffix) {
    const entries = (await readdir(path.join(bundleRoot, folder))).filter(name => name.endsWith(suffix));
    if (entries.length !== 1) fail(`Expected exactly one ${folder}/*${suffix}, found ${entries.length}.`);
    const file = path.join(bundleRoot, folder, entries[0]);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 512 * 1024 * 1024) fail('Bundle must be a nonempty regular file under 512 MiB.');
    return file;
  }
  const installer = await exactlyOne(platform.startsWith('darwin') ? 'dmg' : 'nsis', platform.startsWith('darwin') ? '.dmg' : '.exe');
  const updater = platform.startsWith('darwin') ? await exactlyOne('macos', '.app.tar.gz') : installer;
  const signature = `${updater}.sig`;
  const signatureStat = await lstat(signature);
  if (!signatureStat.isFile() || signatureStat.isSymbolicLink() || signatureStat.size === 0 || signatureStat.size > 8192) fail('Updater signature is missing or invalid.');
  await mkdir(destination, { recursive: true });
  await copyFile(installer, path.join(destination, specification.installer));
  if (updater !== installer) await copyFile(updater, path.join(destination, specification.updater));
  await copyFile(signature, path.join(destination, `${specification.updater}.sig`));
  await writeFile(path.join(destination, `build-${platform}.json`), `${JSON.stringify({
    schemaVersion: 1, platform, version: releaseVersion, commit: source,
    macOSSigning: platform.startsWith('darwin') ? (env.APPLE_SIGNING_IDENTITY && env.APPLE_SIGNING_IDENTITY !== '-' ? 'developer-id' : 'ad-hoc') : null,
  }, null, 2)}\n`);
  console.log(`Collected ${platform}: installer, updater, signature, and source metadata.`);
}
async function files(directory) {
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    if (!PUBLIC_FILES.has(name)) fail(`Unexpected release file ${name}; refusing to upload.`);
    const stat = await lstat(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) fail('Release assets must be nonempty regular files.');
  }
  return names;
}
async function notes(directory) {
  const { releaseVersion, tag } = releaseContext();
  const manifest = JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  const base = `https://github.com/${REPOSITORY}/releases/download/${tag}`;
  const adhoc = manifest.builds.some(build => build.macOSSigning === 'ad-hoc');
  const body = `Toris Studio ${releaseVersion}\n\nmacOS와 Windows 설치 파일입니다. 기존 앱의 ‘업데이트 확인’으로 서명 검증 후 업데이트할 수 있습니다.\n\n` +
    Object.entries(PLATFORMS).map(([platform, spec]) => `- [${platform === 'darwin-aarch64' ? 'Mac Apple Silicon' : platform === 'darwin-x86_64' ? 'Mac Intel' : 'Windows 64비트'} 다운로드](${base}/${spec.installer})`).join('\n') +
    `\n\n[쉬운 다운로드 안내](https://toriskr.github.io/toris-studio/) · [SHA256SUMS](${base}/SHA256SUMS)\n\nGitHub Packages: \`${PACKAGE}:${releaseVersion}\`\n` +
    (adhoc ? '\n현재 Mac 빌드는 ad-hoc 서명입니다. 첫 실행에 macOS 보안 승인이 필요할 수 있으며, 빌드 교체 후 키체인 승인이 유지되는 보장은 Developer ID 서명 설정이 필요합니다.\n' : '') +
    '\nWindows 설치 프로그램은 Tauri 업데이트 서명을 검증합니다. Windows Authenticode 인증서는 별도 설정이며 미설정 시 SmartScreen 확인이 표시될 수 있습니다.\n';
  await writeFile(path.join(directory, 'DOWNLOADS.md'), body);
}
async function api(resource, { allowMissing = false, method = 'GET', body } = {}) {
  if (!process.env.GH_TOKEN) fail('GitHub publication token is missing.');
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${resource}`, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: {
    Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  } });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) fail(`GitHub API returned HTTP ${response.status}.`);
  return response.json();
}
// REST's tag endpoint excludes drafts. Authenticated listing includes drafts;
// fix the exact numeric ID before any upload or publication transition.
export async function findRelease(tag, request = api) {
  if (tag !== `v${version(tag?.slice(1))}`) fail('Invalid release tag.');
  const published = await request(`releases/tags/${tag}`, { allowMissing: true });
  if (published) return published;
  for (let page = 1; page <= 20; page++) {
    const releases = await request(`releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) fail('Invalid GitHub release listing.');
    const matching = releases.filter(release => release.tag_name === tag);
    if (matching.length > 1) fail('Release tag is ambiguous; refusing publication.');
    if (matching.length === 1) return matching[0];
    if (releases.length < 100) return null;
  }
  fail('Release listing limit exceeded; refusing duplicate draft creation.');
}
export function assertReleaseIdentity(release, tag, source, id = release?.id) {
  if (!Number.isSafeInteger(id) || id <= 0 || release?.id !== id ||
      release.tag_name !== tag || release.target_commitish !== source) {
    fail('Release ID, tag, or source changed; refusing publication.');
  }
  return id;
}
export function assertCompleteDraft(release, tag, source, id, assetNames) {
  assertReleaseIdentity(release, tag, source, id);
  if (release.draft !== true || !Array.isArray(release.assets) ||
      release.assets.length !== assetNames.length ||
      !assetNames.every(name => release.assets.some(asset => asset.name === name && asset.size > 0))) {
    fail('Draft upload is incomplete or already public; refusing publication.');
  }
}
async function packageDoesNotExist() {
  const response = await fetch('https://api.github.com/users/torisKR/packages/container/toris-studio%2Fdesktop', { headers: {
    Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  } });
  if (response.status === 404) return true;
  if (!response.ok) fail(`Cannot inspect GitHub Package visibility: HTTP ${response.status}.`);
  return false;
}
function publicationStatePath() {
  return path.join(process.env.RUNNER_TEMP || '/tmp', `toris-release-${process.env.GITHUB_RUN_ID || 'local'}.json`);
}
export async function publish(directory, { request = api, command = run, spawn = spawnSync } = {}) {
  const { releaseVersion, tag, source } = releaseContext();
  const assetNames = await files(directory);
  if (!assetNames.includes('latest.json') || !assetNames.includes('SHA256SUMS') || !assetNames.includes('release-manifest.json')) fail('Verified aggregate manifest and checksums are required.');
  const manifest = JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  if (manifest.version !== releaseVersion || manifest.commit !== source || manifest.files.length !== 8) fail('Verified release manifest does not match source/version.');
  const existing = await findRelease(tag, request);
  if (existing && !existing.draft) fail('This version is already public. Publish a new version instead of replacing signed assets.');
  if (existing && existing.target_commitish !== source) fail('Existing draft belongs to a different source commit.');
  const stable = await request('releases/latest', { allowMissing: true });
  if (stable && !newerThan(releaseVersion, stable.tag_name.replace(/^v/, ''))) fail('Stable release must advance the current public version.');
  let gitReference = await request(`git/ref/tags/${tag}`, { allowMissing: true });
  if (gitReference) {
    let object = gitReference.object;
    for (let depth = 0; object.type === 'tag' && depth < 4; depth++) object = (await request(`git/tags/${object.sha}`)).object;
    if (object.type !== 'commit' || object.sha !== source) fail('Existing release tag points to a different source commit.');
  }
  // A newly created draft can be absent from the listing briefly. Bind the
  // exact numeric ID from the creation response instead of rediscovering it.
  const created = existing ?? await request('releases', { method: 'POST', body: {
    tag_name: tag, target_commitish: source, draft: true, prerelease: false, make_latest: 'false',
    name: `Toris Studio ${releaseVersion}`, body: await readFile(path.join(directory, 'DOWNLOADS.md'), 'utf8'),
  } });
  const releaseId = assertReleaseIdentity(created, tag, source);
  if (created.draft !== true) fail('This release is already public; refusing upload.');
  const state = { tag, source, releaseId, touched: true, promoted: false };
  await writeFile(publicationStatePath(), JSON.stringify(state));
  command('gh', ['release', 'upload', tag, ...assetNames.map(name => path.join(directory, name)), '--repo', REPOSITORY, '--clobber']);
  assertCompleteDraft(await request(`releases/${releaseId}`), tag, source, releaseId, assetNames);
  if (!process.env.GHCR_TOKEN) fail('GitHub Packages token is missing. Draft remains unpublished.');
  command('oras', ['login', 'ghcr.io', '--username', process.env.GITHUB_ACTOR || 'torisKR', '--password-stdin'], { input: process.env.GHCR_TOKEN, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const reference = `${PACKAGE}:${releaseVersion}`;
    const priorPackage = spawn('oras', ['manifest', 'fetch', reference], { encoding: 'utf8', shell: false });
    let packageExists = false;
    if (priorPackage.status === 0) {
      packageExists = true;
      const prior = JSON.parse(priorPackage.stdout);
      if (prior.annotations?.['org.opencontainers.image.revision'] !== source || prior.layers?.length !== assetNames.length) fail('Package version already exists with different source or assets; use a new release version.');
      for (const name of assetNames) {
        const digest = `sha256:${createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex')}`;
        if (!prior.layers.some(layer => layer.annotations?.['org.opencontainers.image.title'] === name && layer.digest === digest)) fail('Package version already contains different bytes; use a new release version.');
      }
    } else if (!/not found|404|manifest unknown/i.test(priorPackage.stderr ?? '')) {
      // GHCR may answer "denied" for the first push to a package that does not exist yet.
      // Only permit creation if the authenticated GitHub package API confirms its absence.
      if (!await packageDoesNotExist()) fail('Cannot inspect existing Package; refusing to overwrite it.');
    }
    if (!packageExists) command('oras', ['push', reference, '--artifact-type', 'application/vnd.toris.studio.desktop.v1', '--annotation', `org.opencontainers.image.source=https://github.com/${REPOSITORY}`, '--annotation', `org.opencontainers.image.version=${releaseVersion}`, '--annotation', `org.opencontainers.image.revision=${source}`, ...assetNames.map(name => `${name}:application/octet-stream`)], { cwd: path.resolve(directory) });
    const fetched = JSON.parse(command('oras', ['manifest', 'fetch', reference]));
    if (fetched.layers?.length !== assetNames.length || !assetNames.every(name => fetched.layers.some(layer => layer.annotations?.['org.opencontainers.image.title'] === name))) fail('GitHub Package manifest is incomplete; draft remains unpublished.');
    assertCompleteDraft(await request(`releases/${releaseId}`), tag, source, releaseId, assetNames);
    await writeFile(publicationStatePath(), JSON.stringify({ ...state, promotionAttempted: true }));
    const published = await request(`releases/${releaseId}`, { method: 'PATCH', body: {
      draft: false, prerelease: false, make_latest: 'true', body: await readFile(path.join(directory, 'DOWNLOADS.md'), 'utf8'),
    } });
    assertReleaseIdentity(published, tag, source, releaseId);
    if (published.draft || published.prerelease) fail('Release promotion did not complete.');
    await writeFile(publicationStatePath(), JSON.stringify({ ...state, promoted: true }));
    console.log(`Published ${tag}: GitHub Releases and ${reference}.`);
  } finally {
    command('oras', ['logout', 'ghcr.io']);
  }
}
export async function hashResponse(response, limit = 512 * 1024 * 1024) {
  if (!response.ok || !response.body) fail(`Public download returned HTTP ${response.status}.`);
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) fail('Public download exceeds allowed size.');
    digest.update(chunk);
  }
  return { sha256: digest.digest('hex'), size };
}
async function verifyLive(directory) {
  const { releaseVersion, tag, source } = releaseContext();
  const state = JSON.parse(await readFile(publicationStatePath(), 'utf8'));
  if (state.tag !== tag || state.source !== source || !state.promoted) fail('This run did not promote the release.');
  const expected = JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  const base = `https://github.com/${REPOSITORY}/releases/download/${tag}`;
  const release = await api(`releases/${state.releaseId}`);
  assertReleaseIdentity(release, tag, source, state.releaseId);
  if (release.draft || release.prerelease) fail('Release is not public stable.');
  for (const file of expected.files) {
    const actual = await hashResponse(await fetch(`${base}/${file.name}`, { signal: AbortSignal.timeout(180_000) }));
    if (actual.sha256 !== file.sha256 || actual.size !== file.size) fail(`Public checksum differs for ${file.name}.`);
  }
  const expectedFeed = await readFile(path.join(directory, 'latest.json'), 'utf8');
  let feedMatches = false;
  // GitHub's latest redirect may briefly cache the preceding release after promotion.
  for (let attempt = 0; attempt < 6 && !feedMatches; attempt++) {
    const response = await fetch(`https://github.com/${REPOSITORY}/releases/latest/download/latest.json`, { signal: AbortSignal.timeout(30_000), cache: 'no-store' });
    if (response.ok) feedMatches = await response.text() === expectedFeed;
    if (!feedMatches && attempt < 5) await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  if (!feedMatches) fail('Latest updater feed does not match the verified complete release.');
  console.log(`Verified public installers, update signatures, checksums, and latest.json for ${tag}.`);
}
export async function quarantine({ request = api } = {}) {
  let state;
  try { state = JSON.parse(await readFile(publicationStatePath(), 'utf8')); } catch { console.log('No release created by this run; nothing to quarantine.'); return; }
  const { tag, source } = releaseContext();
  if (state.tag !== tag || state.source !== source || !(state.promoted || state.promotionAttempted)) return;
  const release = await request(`releases/${state.releaseId}`);
  assertReleaseIdentity(release, tag, source, state.releaseId);
  if (release.draft || release.prerelease) return;
  const quarantined = await request(`releases/${state.releaseId}`, { method: 'PATCH', body: { prerelease: true, make_latest: 'false' } });
  assertReleaseIdentity(quarantined, tag, source, state.releaseId);
  if (!quarantined.prerelease) fail('Failed release was not removed from the stable channel.');
  console.log(`Marked ${tag} prerelease after failed public verification. It is excluded from stable latest downloads; no previous version was changed.`);
}
async function summary(directory) {
  const { releaseVersion, tag } = releaseContext();
  let status = 'Build or publication failed; inspect job logs.';
  try {
    const release = await findRelease(tag);
    status = release ? release.draft ? 'Draft retained: public downloads were not promoted.' : release.prerelease ? 'Verification failed: release removed from the stable channel.' : 'Complete public release published.' : status;
  } catch { /* The failure's diagnostic is already in the workflow step. */ }
  const content = `## Toris Studio ${releaseVersion}\n\n${status}\n\n[GitHub Release](https://github.com/${REPOSITORY}/releases/tag/${tag}) · [Download page](https://toriskr.github.io/toris-studio/)\n\nGitHub Packages: \`${PACKAGE}:${releaseVersion}\`\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, content);
  console.log(status);
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'preflight') await preflight();
  else if (command === 'preview-config') await writeFile(args[0], JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  else if (command === 'collect') await collect(...args);
  else if (command === 'notes') await notes(args[0]);
  else if (command === 'publish') await publish(args[0]);
  else if (command === 'verify-live') await verifyLive(args[0]);
  else if (command === 'quarantine') await quarantine();
  else if (command === 'summary') await summary(args[0]);
  else fail('Unknown release command.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
