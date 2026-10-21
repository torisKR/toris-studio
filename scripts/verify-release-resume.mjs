import {appendFile, readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPOSITORY = 'torisKR/toris-studio';
export const WORKFLOW = '.github/workflows/desktop-release.yml';
export const CONFIG_PATH = 'desktop/src-tauri/tauri.conf.json';
export const REQUIRED_JOBS = [
  'prepare',
  'publication-safety / verify',
  'native (macos-latest, aarch64-apple-darwin, darwin-aarch64, app,dmg)',
  'native (macos-15-intel, x86_64-apple-darwin, darwin-x86_64, app,dmg)',
  'native (windows-latest, x86_64-pc-windows-msvc, windows-x86_64, nsis)',
];
export const RELEASE_ARTIFACTS = ['release-darwin-aarch64', 'release-darwin-x86_64', 'release-windows-x86_64'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
function fail(message) { throw new Error(message); }

export function parseRunId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !positiveInteger(Number(value))) fail('Source run ID must contain only a positive safe integer.');
  return Number(value);
}

function validateRun(runId, run) {
  if (!positiveInteger(runId) || run?.id !== runId) fail('Source workflow run ID does not match.');
  if (run.repository?.full_name !== REPOSITORY || run.head_repository?.full_name !== REPOSITORY
      || !positiveInteger(run.repository?.id) || run.head_repository?.id !== run.repository.id) fail('Source run must belong to the original repository, not a fork.');
  if (run.path !== WORKFLOW || run.event !== 'workflow_dispatch' || run.head_branch !== 'main') fail('Source must be the main-branch manually dispatched desktop release workflow.');
  if (typeof run.head_sha !== 'string' || !SHA.test(run.head_sha) || !positiveInteger(run.run_attempt)) fail('Source run must identify an exact lowercase commit and attempt.');
}

export function flattenPages(pages, key) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 100) fail('GitHub pagination is incomplete or exceeds its limit.');
  const expected = pages[0]?.total_count;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > 10000) fail('GitHub result count is invalid.');
  const items = [];
  for (const page of pages) {
    if (page?.total_count !== expected || !Array.isArray(page[key])) fail('GitHub pagination changed while reading provenance.');
    items.push(...page[key]);
  }
  if (items.length !== expected) fail('GitHub pagination did not return every provenance record.');
  return items;
}

/** Pure provenance validation. It never downloads artifacts or reads user state. */
export function validateResume({runId, run, jobs, artifacts, originalConfig, currentConfig, sourceIsAncestor, now = Date.now()}) {
  validateRun(runId, run);
  if (sourceIsAncestor !== true) fail('Original build source must be an ancestor of the checked-out recovery source.');
  if (!(typeof originalConfig === 'string' || Buffer.isBuffer(originalConfig))
      || !(typeof currentConfig === 'string' || Buffer.isBuffer(currentConfig))
      || !Buffer.from(originalConfig).equals(Buffer.from(currentConfig))) fail('Recovery Tauri configuration must be byte-identical to the signed build configuration.');
  let config;
  try { config = JSON.parse(originalConfig.toString()); } catch { fail('Original Tauri configuration is invalid JSON.'); }
  if (typeof config?.version !== 'string' || config.version.length > 64 || !STABLE.test(config.version)) fail('Original build must have a stable release version.');
  const updater = config.plugins?.updater;
  if (config.bundle?.createUpdaterArtifacts !== true || updater?.requireSignedVersion !== true
      || updater.allowDowngrades !== false || typeof updater.pubkey !== 'string' || !updater.pubkey.trim()
      || JSON.stringify(updater.endpoints) !== JSON.stringify([`https://github.com/${REPOSITORY}/releases/latest/download/latest.json`])) fail('Original signed updater configuration is required.');

  if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > 10000) fail('Source job provenance is missing.');
  const knownNames = new Set([...REQUIRED_JOBS, 'publish']);
  const latest = new Map(), seenIds = new Set(), seenAttempts = new Set();
  for (const job of jobs) {
    if (!knownNames.has(job?.name)) fail('Unexpected job in the original desktop release workflow.');
    if (!positiveInteger(job.id) || seenIds.has(job.id) || job.run_id !== runId
        || job.head_sha !== run.head_sha || job.head_branch !== 'main'
        || !positiveInteger(job.run_attempt) || job.run_attempt > run.run_attempt) fail('Job identity does not match the original build source.');
    const key = `${job.name}:${job.run_attempt}`;
    if (seenAttempts.has(key)) fail('Job attempt provenance is ambiguous.');
    seenIds.add(job.id); seenAttempts.add(key);
    if (!latest.has(job.name) || latest.get(job.name).run_attempt < job.run_attempt) latest.set(job.name, job);
  }
  for (const name of REQUIRED_JOBS) {
    const job = latest.get(name);
    if (job?.status !== 'completed' || job.conclusion !== 'success') fail('Every required preparation, publication safety and native job must have succeeded in its latest attempt.');
  }
  const publication = latest.get('publish');
  if (publication?.status !== 'completed' || publication.conclusion !== 'failure') fail('Only a completed failed publish job may enter publish-only recovery.');

  if (!Array.isArray(artifacts) || artifacts.length > 10000 || !Number.isFinite(now)) fail('Artifact provenance is invalid.');
  const releaseArtifacts = [];
  for (const artifact of artifacts) {
    if (typeof artifact?.name !== 'string') fail('Artifact name is invalid.');
    if (artifact.name.startsWith('release-')) releaseArtifacts.push(artifact);
  }
  if (releaseArtifacts.length !== RELEASE_ARTIFACTS.length) fail('Exactly three signed release artifacts are required.');
  const ids = new Set(), names = new Set(), digests = new Set();
  let totalBytes = 0;
  for (const artifact of releaseArtifacts) {
    if (!RELEASE_ARTIFACTS.includes(artifact.name) || names.has(artifact.name)
        || !positiveInteger(artifact.id) || ids.has(artifact.id)) fail('Release artifact identities must be unique and match the three native platforms.');
    const source = artifact.workflow_run;
    if (source?.id !== runId || source.head_sha !== run.head_sha || source.head_branch !== 'main'
        || source.repository_id !== run.repository.id || source.head_repository_id !== run.head_repository.id) fail('Release artifact belongs to a different run, source or repository.');
    if (artifact.expired !== false || typeof artifact.expires_at !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(artifact.expires_at)
        || !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= now) fail('Release artifacts must be unexpired.');
    if (typeof artifact.digest !== 'string' || !DIGEST.test(artifact.digest) || digests.has(artifact.digest)) fail('Release artifacts need unique SHA256 archive digests.');
    if (!positiveInteger(artifact.size_in_bytes) || artifact.size_in_bytes >= MAX_BYTES) fail('Each release artifact must be nonempty and smaller than 2 GiB.');
    totalBytes += artifact.size_in_bytes;
    ids.add(artifact.id); names.add(artifact.name); digests.add(artifact.digest);
  }
  if (totalBytes >= MAX_BYTES) fail('Aggregate release artifacts must be smaller than 2 GiB.');
  return {
    runId, source: run.head_sha, version: config.version,
    artifacts: RELEASE_ARTIFACTS.map(name => {
      const artifact = releaseArtifacts.find(value => value.name === name);
      return {id: artifact.id, name, digest: artifact.digest, sizeInBytes: artifact.size_in_bytes};
    }),
  };
}

function command(program, args, {cwd = ROOT, allowedStatuses = [0]} = {}) {
  const result = spawnSync(program, args, {cwd, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024});
  if (result.error || !allowedStatuses.includes(result.status)) fail(`Unable to read ${program === 'gh' ? 'GitHub release provenance' : 'Git source provenance'}.`);
  return {status: result.status, stdout: result.stdout};
}
function decodeJson(value) {
  try { return JSON.parse(value); } catch { fail('GitHub returned invalid provenance JSON.'); }
}

export async function verifyReleaseResume(input, {root = ROOT, env = process.env, execute = command} = {}) {
  const runId = parseRunId(input);
  if ((env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== REPOSITORY)
      || (env.GITHUB_REF && env.GITHUB_REF !== 'refs/heads/main')
      || (env.GITHUB_EVENT_NAME && env.GITHUB_EVENT_NAME !== 'workflow_dispatch')) fail('Release recovery must run from the original repository main branch by manual dispatch.');
  if (typeof env.RUNNER_TEMP !== 'string' || !path.isAbsolute(env.RUNNER_TEMP) || /[\r\n\0]/.test(env.RUNNER_TEMP)) fail('A safe absolute RUNNER_TEMP is required for the validated manifest.');
  const get = (resource, paginated = false) => {
    const args = ['api', '--hostname', 'github.com', '--method', 'GET',
      ...(paginated ? ['--paginate', '--slurp'] : []), resource];
    return decodeJson(execute('gh', args, {cwd: root}).stdout);
  };
  const run = get(`repos/${REPOSITORY}/actions/runs/${runId}`);
  validateRun(runId, run);
  const jobs = flattenPages(get(`repos/${REPOSITORY}/actions/runs/${runId}/jobs?filter=all&per_page=100`, true), 'jobs');
  const artifacts = flattenPages(get(`repos/${REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`, true), 'artifacts');
  const originalConfig = execute('git', ['show', `${run.head_sha}:${CONFIG_PATH}`], {cwd: root}).stdout;
  const ancestor = execute('git', ['merge-base', '--is-ancestor', run.head_sha, 'HEAD'], {cwd: root, allowedStatuses: [0, 1]}).status === 0;
  const currentConfig = await readFile(path.join(root, CONFIG_PATH));
  const manifest = validateResume({runId, run, jobs, artifacts, originalConfig, currentConfig, sourceIsAncestor: ancestor});
  const manifestPath = path.join(env.RUNNER_TEMP, 'toris-release-resume.json');
  // Exclusive creation rejects stale files and symlinks. No file or Actions
  // environment is written until every provenance and source check has passed.
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  const tag = `v${manifest.version}`;
  if (env.GITHUB_ENV) await appendFile(env.GITHUB_ENV, `RELEASE_VERSION=${manifest.version}\nRELEASE_TAG=${tag}\nRELEASE_COMMIT=${manifest.source}\nRELEASE_RESUME_MANIFEST=${manifestPath}\n`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `version=${manifest.version}\ntag=${tag}\ncommit=${manifest.source}\nsource_run_id=${manifest.runId}\nartifact_ids=${manifest.artifacts.map(value => value.id).join(',')}\n`);
  return {manifest, manifestPath};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/verify-release-resume.mjs SOURCE_RUN_ID');
    process.exitCode = 1;
  } else verifyReleaseResume(process.argv[2]).then(({manifest, manifestPath}) => {
    console.log(JSON.stringify({verified: true, runId: manifest.runId, source: manifest.source, version: manifest.version, artifactCount: manifest.artifacts.length, manifestPath}));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
