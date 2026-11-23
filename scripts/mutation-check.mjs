#!/usr/bin/env node
// Mutation check: each mutant breaks one behavior on purpose; its test must FAIL.
// A mutant that still passes means the test never proved that behavior (TDD "watch it fail").
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// One mutation run at a time: two runs over the same files can leave a mutant in the tree.
const LOCK = path.join(ROOT, '.mutation-check.lock');
try { closeSync(openSync(LOCK, 'wx')); }
catch { console.error(`다른 뮤테이션 검사가 실행 중입니다 (${path.basename(LOCK)}). 끝난 뒤 다시 실행하세요.`); process.exit(2); }
let restore = null;
let child = null;
/** Stops the running test command and everything it started (its own process group). */
const stopChild = () => {
  if (!child || child.exitCode !== null) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
};
const release = () => { stopChild(); if (restore) { restore(); restore = null; } rmSync(LOCK, { force: true }); };
process.on('exit', release);
// Signal handlers run right away now that the loop awaits: the mutant never stays in the source.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { release(); process.exit(130); });
const list = JSON.parse(readFileSync(path.resolve(ROOT, process.argv[2] ?? 'desktop/agent-runtime/test/mutants.json'), 'utf8'));
const only = process.argv[3];
const results = [];
// A test command that never ran proves nothing: a missing program (spawn error) or, behind a wrapper
// such as `timeout` or a pnpm script, the shell's 126 (not executable) / 127 (command not found).
const NOT_STARTED = { 126: 'exit 126: command not executable', 127: 'exit 127: command not found' };
/** Resolves { code } when the test ran, or { notStarted: reason } when its command could not start. */
function runTest(command, args, timeoutMs) {
  return new Promise(resolve => {
    child = spawn(command, args, { cwd: ROOT, stdio: 'ignore', detached: process.platform !== 'win32', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    const timer = setTimeout(stopChild, timeoutMs);
    child.on('error', error => { clearTimeout(timer); child = null; resolve({ notStarted: `${command}: ${error.code ?? error.message}` }); });
    child.on('exit', code => { clearTimeout(timer); child = null; resolve(NOT_STARTED[code] ? { notStarted: NOT_STARTED[code] } : { code: code ?? 1 }); });
  });
}
for (const mutant of list.filter(m => !only || m.id.startsWith(only))) {
  const file = path.resolve(ROOT, mutant.file);
  const original = readFileSync(file, 'utf8');
  const count = original.split(mutant.find).length - 1;
  if (count !== 1) { results.push({ id: mutant.id, status: 'invalid', note: `find matched ${count} times` }); continue; }
  restore = () => writeFileSync(file, original);
  writeFileSync(file, original.replace(mutant.find, () => mutant.replace));
  try {
    const [command, ...args] = mutant.cmd ?? ['node', '--import', 'tsx', '--test', mutant.test];
    const { code, notStarted } = await runTest(command, args, mutant.timeoutMs ?? 120_000);
    results.push(notStarted ? { id: mutant.id, status: 'invalid', note: `test command did not start: ${notStarted}` }
      : { id: mutant.id, status: code === 0 ? 'SURVIVED' : 'killed' });
  } finally {
    restore();
    restore = null;
  }
}
for (const r of results) console.log(`${r.status === 'killed' ? '✔' : '✖'} ${r.status.padEnd(8)} ${r.id}${r.note ? ` (${r.note})` : ''}`);
const bad = results.filter(r => r.status !== 'killed');
console.log(`\n${results.length - bad.length}/${results.length} mutants killed`);
process.exit(bad.length ? 1 : 0);
