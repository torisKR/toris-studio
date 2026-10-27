#!/usr/bin/env node
// One entry point for "is this change done?". fast: types and unit tests.
// full: fast + Rust tests, mutation checks and browser UI checks.
// Steps run one after another so their output stays readable; the first failure stops the run.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARGO = ['--manifest-path', 'desktop/src-tauri/Cargo.toml', '--no-default-features'];

export const STEPS = {
  fast: [
    ['harness map and mutants', 'node', ['scripts/harness-check.mjs']],
    ['harness tooling tests', 'node', ['--test', 'scripts/harness-check.test.mjs']],
    ['web and desktop types', 'pnpm', ['-s', 'typecheck']],
    ['desktop UI types', 'pnpm', ['exec', 'tsc', '--project', 'desktop/tsconfig.json', '--noEmit']],
    ['agent runtime types', 'pnpm', ['-s', 'agent:typecheck']],
    ['unit tests', 'pnpm', ['-s', 'test']],
    ['agent runtime tests and evals', 'pnpm', ['-s', 'agent:test']],
  ],
  full: [
    ['rust tests', 'cargo', ['test', ...CARGO]],
    ['agent runtime mutants', 'node', ['scripts/mutation-check.mjs', 'desktop/agent-runtime/test/mutants.json']],
    ['rust mutants', 'node', ['scripts/mutation-check.mjs', 'desktop/src-tauri/tests/mutants.json']],
    ['agent UI check', 'node', ['scripts/verify-agent-ui.mjs']],
    ['agent UI mutants', 'node', ['scripts/mutation-check.mjs', 'desktop/agent-runtime/test/ui-mutants.json']],
    ['planner UI check', 'node', ['scripts/verify-planner-ui.mjs']],
    ['ops UI check', 'node', ['scripts/verify-ops-ui.mjs']],
  ],
};

function main() {
  const level = process.argv[2] === 'full' ? 'full' : 'fast';
  const steps = level === 'full' ? [...STEPS.fast, ...STEPS.full] : STEPS.fast;
  const started = Date.now();
  for (const [index, [label, command, args]] of steps.entries()) {
    console.log(`\n▶ [${index + 1}/${steps.length}] ${label}: ${command} ${args.join(' ')}`);
    const run = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    if (run.status !== 0) {
      console.error(`\n✖ ${label} 실패 (exit ${run.status ?? run.signal}). 나머지 단계는 실행하지 않았습니다.`);
      process.exit(run.status || 1);
    }
  }
  console.log(`\n✔ verify ${level}: ${steps.length}단계 통과 (${Math.round((Date.now() - started) / 1000)}초)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
