import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globToRegExp, mutantProblems, owners } from './harness-check.mjs';

test('globs match within and across folders', () => {
  assert.ok(globToRegExp('desktop/src/Agent*').test('desktop/src/AgentPanel.tsx'));
  assert.ok(!globToRegExp('desktop/src/Agent*').test('desktop/src/x/AgentPanel.tsx'));
  assert.ok(globToRegExp('lib/video/**').test('lib/video/a/b.ts'));
  assert.ok(globToRegExp('db/migrations/009_*').test('db/migrations/009_planner.sql'));
  assert.ok(!globToRegExp('scripts/a.mjs').test('scripts/aXmjs'), 'dots are literal');
});

test('a file is unowned unless some feature claims it', () => {
  const map = { features: [{ id: 'a', paths: ['src/**'] }, { id: 'b', paths: ['src/x.ts'] }] };
  assert.deepEqual(owners(map, 'src/x.ts'), ['a', 'b']);
  assert.deepEqual(owners(map, 'other.ts'), []);
});

test('a mutant that matches zero or many times is reported', () => {
  const files = { 'f.ts': 'a b a' };
  const read = file => { if (!(file in files)) throw new Error('missing'); return files[file]; };
  assert.deepEqual(mutantProblems([{ id: 'ok', file: 'f.ts', find: 'b' }], read), []);
  assert.match(mutantProblems([{ id: 'twice', file: 'f.ts', find: 'a' }], read)[0], /2번/);
  assert.match(mutantProblems([{ id: 'none', file: 'f.ts', find: 'z' }], read)[0], /0번/);
  assert.match(mutantProblems([{ id: 'gone', file: 'g.ts', find: 'z' }], read)[0], /없음/);
});
