import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = async name => (await readFile(new URL(`../${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

function job(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line === `  ${name}:`);
  assert.ok(start >= 0, `Missing job ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

test('publication gate uses isolated DB and browser fixtures without publishing secrets', async () => {
  const workflow = await source('.github/workflows/publication-checks.yml');
  assert.match(workflow, /^on:\n  workflow_call:/m);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /TORIS_TEST_PG_BIN:/);
  assert.match(workflow, /TORIS_TEST_SCRATCH=/);
  assert.match(workflow, /TORIS_PUBLICATION_UI_ARTIFACTS=/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /--lib publishing_adapters/);
  assert.match(workflow, /node scripts\/verify-publication-db\.mjs/);
  assert.match(workflow, /node scripts\/verify-publication-ui\.mjs/);
  assert.doesNotMatch(workflow, /secrets:\s*inherit|TAURI_SIGNING_PRIVATE_KEY|GHCR_TOKEN/);
  assert.doesNotMatch(workflow, /systemctl (?:start|restart) postgresql|--env-file=\.env/);
});

test('main and signed releases cannot skip the reusable publication gate', async () => {
  const desktop = await source('.github/workflows/desktop.yml');
  const release = await source('.github/workflows/desktop-release.yml');
  for (const workflow of [desktop, release]) {
    assert.match(job(workflow, 'publication-safety'), /uses: \.\/\.github\/workflows\/publication-checks\.yml/);
    assert.doesNotMatch(job(workflow, 'publication-safety'), /secrets:/);
  }
  assert.match(job(desktop, 'native'), /needs: \[security, contracts, publication-safety\]/);
  assert.match(job(release, 'native'), /needs: \[prepare, publication-safety\]/);
  assert.match(desktop, /node --test scripts\/publication-release-contract\.test\.mjs/);
  for (const pattern of [
    'scripts/publication-release-contract.test.mjs',
    'scripts/verify-publication-*.mjs',
    '.github/workflows/publication-checks.yml',
  ]) {
    assert.equal(desktop.split(`'${pattern}'`).length - 1, 2, `${pattern} must trigger both push and pull_request`);
  }
});

test('signed releases audit the locked dependencies before any packaging or publication', async () => {
  const release = await source('.github/workflows/desktop-release.yml');
  const prepare = job(release, 'prepare');
  assert.match(prepare, /pnpm install --frozen-lockfile/);
  assert.match(prepare, /pnpm audit --audit-level=low/);
  assert.match(prepare, /pnpm test/);
  assert.doesNotMatch(prepare, /continue-on-error: true|pnpm audit[^\n]*(?:\|\| true|--ignore)/);
  assert.match(job(release, 'native'), /needs: \[prepare, publication-safety\]/);
});
