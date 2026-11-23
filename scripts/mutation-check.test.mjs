// An interrupted mutation run must put the original source back and leave nothing running.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, '.mutation-check.lock');
const waitFor = async (check, label, ms = 10_000) => {
  for (const start = Date.now(); Date.now() - start < ms; await new Promise(r => setTimeout(r, 25))) if (check()) return;
  assert.fail(`timed out waiting for ${label}`);
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} during a mutant restores the source, stops the test command and releases the lock`, async () => {
    if (existsSync(LOCK)) return test.skip?.('another mutation run holds the lock');
    const dir = mkdtempSync(path.join(tmpdir(), 'mutation-check-test-'));
    const target = path.join(dir, 'target.txt');
    const pidFile = path.join(dir, 'child.pid');
    writeFileSync(target, 'const value = "original";\n');
    // The "test command" records its pid and then hangs, like a long cargo test.
    const hang = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const list = path.join(dir, 'mutants.json');
    writeFileSync(list, JSON.stringify([{ id: 'fixture.hang', file: target, find: '"original"', replace: '"MUTATED"', cmd: ['node', '-e', hang], timeoutMs: 120_000 }]));
    const run = spawn(process.execPath, [path.join(ROOT, 'scripts/mutation-check.mjs'), list], { stdio: 'ignore' });
    await waitFor(() => existsSync(pidFile) && readFileSync(target, 'utf8').includes('MUTATED'), 'the mutant to be applied');
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    const exited = new Promise(resolve => run.on('exit', (code, sig) => resolve({ code, sig })));
    run.kill(signal);
    const result = await Promise.race([exited, new Promise(r => setTimeout(() => r('still running'), 5_000))]);
    assert.notEqual(result, 'still running', 'the runner exits promptly instead of waiting for the test command');
    assert.equal(readFileSync(target, 'utf8'), 'const value = "original";\n', 'the original source is back');
    assert.equal(existsSync(LOCK), false, 'the lock is released');
    await waitFor(() => !alive(childPid), 'the test command to be stopped', 3_000);
  });
}

// A test command that cannot start proves nothing; counting it as "killed" would be a false pass.
const notStarted = [
  ['a missing program (spawn ENOENT)', ['toris-mutation-check-no-such-command']],
  ...(process.platform === 'win32' ? [] : [['a wrapper reporting command not found (exit 127)', ['sh', '-c', 'exit 127']]]),
];
for (const [label, cmd] of notStarted) {
  test(`a mutant whose test command is ${label} is invalid, not killed`, () => {
    if (existsSync(LOCK)) return test.skip?.('another mutation run holds the lock');
    const dir = mkdtempSync(path.join(tmpdir(), 'mutation-check-test-'));
    const target = path.join(dir, 'target.txt');
    writeFileSync(target, 'const value = "original";\n');
    const list = path.join(dir, 'mutants.json');
    writeFileSync(list, JSON.stringify([{ id: 'fixture.not-started', file: target, find: '"original"', replace: '"MUTATED"', cmd }]));
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/mutation-check.mjs'), list], { encoding: 'utf8' });
    assert.equal(run.status, 1, 'the run fails');
    assert.match(run.stdout, /invalid\s+fixture\.not-started \(test command did not start: /);
    assert.doesNotMatch(run.stdout, /killed\s+fixture\.not-started/);
    assert.match(run.stdout, /0\/1 mutants killed/);
    assert.equal(readFileSync(target, 'utf8'), 'const value = "original";\n', 'the original source is back');
    assert.equal(existsSync(LOCK), false, 'the lock is released');
  });
}
