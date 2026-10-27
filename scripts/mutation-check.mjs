#!/usr/bin/env node
// Mutation check: each mutant breaks one behavior on purpose; its test must FAIL.
// A mutant that still passes means the test never proved that behavior (TDD "watch it fail").
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// One mutation run at a time: two runs over the same files can leave a mutant in the tree.
const LOCK = path.join(ROOT, '.mutation-check.lock');
try { closeSync(openSync(LOCK, 'wx')); }
catch { console.error(`다른 뮤테이션 검사가 실행 중입니다 (${path.basename(LOCK)}). 끝난 뒤 다시 실행하세요.`); process.exit(2); }
let restore = null;
const release = () => { if (restore) { restore(); restore = null; } rmSync(LOCK, { force: true }); };
process.on('exit', release);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { release(); process.exit(130); });
const list = JSON.parse(readFileSync(path.join(ROOT, process.argv[2] ?? 'desktop/agent-runtime/test/mutants.json'), 'utf8'));
const only = process.argv[3];
const results = [];
for (const mutant of list.filter(m => !only || m.id.startsWith(only))) {
  const file = path.join(ROOT, mutant.file);
  const original = readFileSync(file, 'utf8');
  const count = original.split(mutant.find).length - 1;
  if (count !== 1) { results.push({ id: mutant.id, status: 'invalid', note: `find matched ${count} times` }); continue; }
  writeFileSync(file, original.replace(mutant.find, () => mutant.replace));
  restore = () => writeFileSync(file, original);
  try {
    const [command, ...args] = mutant.cmd ?? ['node', '--import', 'tsx', '--test', mutant.test];
    const run = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: mutant.timeoutMs ?? 120_000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    results.push({ id: mutant.id, status: run.status === 0 ? 'SURVIVED' : 'killed' });
  } finally {
    restore();
    restore = null;
  }
}
for (const r of results) console.log(`${r.status === 'killed' ? '✔' : '✖'} ${r.status.padEnd(8)} ${r.id}${r.note ? ` (${r.note})` : ''}`);
const bad = results.filter(r => r.status !== 'killed');
console.log(`\n${results.length - bad.length}/${results.length} mutants killed`);
process.exit(bad.length ? 1 : 0);
