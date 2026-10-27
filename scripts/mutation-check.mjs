#!/usr/bin/env node
// Mutation check: each mutant breaks one behavior on purpose; its test must FAIL.
// A mutant that still passes means the test never proved that behavior (TDD "watch it fail").
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const list = JSON.parse(readFileSync(path.join(ROOT, process.argv[2] ?? 'desktop/agent-runtime/test/mutants.json'), 'utf8'));
const only = process.argv[3];
const results = [];
for (const mutant of list.filter(m => !only || m.id.startsWith(only))) {
  const file = path.join(ROOT, mutant.file);
  const original = readFileSync(file, 'utf8');
  const count = original.split(mutant.find).length - 1;
  if (count !== 1) { results.push({ id: mutant.id, status: 'invalid', note: `find matched ${count} times` }); continue; }
  writeFileSync(file, original.replace(mutant.find, () => mutant.replace));
  try {
    const [command, ...args] = mutant.cmd ?? ['node', '--import', 'tsx', '--test', mutant.test];
    const run = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: mutant.timeoutMs ?? 120_000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    results.push({ id: mutant.id, status: run.status === 0 ? 'SURVIVED' : 'killed' });
  } finally {
    writeFileSync(file, original);
  }
}
for (const r of results) console.log(`${r.status === 'killed' ? '✔' : '✖'} ${r.status.padEnd(8)} ${r.id}${r.note ? ` (${r.note})` : ''}`);
const bad = results.filter(r => r.status !== 'killed');
console.log(`\n${results.length - bad.length}/${results.length} mutants killed`);
process.exit(bad.length ? 1 : 0);
