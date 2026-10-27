#!/usr/bin/env node
// Repository harness check. Fails when:
//  - a changed (or, with --all, any tracked) file is owned by no feature in docs/harness/features.json;
//  - a mutant's "find" text does not occur exactly once in its file (it could not prove anything);
//  - a mutation run is in progress (its lock exists), so the tree may hold a mutated file.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK = path.join(ROOT, '.mutation-check.lock');

/** Minimal glob: "**" crosses folders, "*" stays within one path segment. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { out += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (ch === '*') out += '[^/]*';
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function owners(map, file) {
  return map.features.filter(feature => feature.paths.some(glob => globToRegExp(glob).test(file))).map(feature => feature.id);
}

export function mutantProblems(list, read) {
  const problems = [];
  for (const mutant of list) {
    let source;
    try { source = read(mutant.file); } catch { problems.push(`${mutant.id}: ${mutant.file} 없음`); continue; }
    const count = source.split(mutant.find).length - 1;
    if (count !== 1) problems.push(`${mutant.id}: find가 ${count}번 나옵니다 (${mutant.file})`);
  }
  return problems;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
}

function main() {
  const all = process.argv.includes('--all');
  const problems = [];
  if (existsSync(LOCK)) problems.push(`뮤테이션 검사가 진행 중입니다 (${path.basename(LOCK)}). 끝난 뒤 다시 확인하세요. 중단된 실행이라면 변경된 소스가 남았는지 git diff로 확인한 뒤 잠금 파일을 지우세요.`);
  const map = JSON.parse(readFileSync(path.join(ROOT, 'docs/harness/features.json'), 'utf8'));
  const files = all ? git(['ls-files']) : [...new Set([...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])])];
  const unowned = files.filter(file => existsSync(path.join(ROOT, file)) && !owners(map, file).length);
  for (const file of unowned) problems.push(`기능 지도에 없는 파일: ${file}`);
  const read = file => readFileSync(path.join(ROOT, file), 'utf8');
  for (const feature of map.features) for (const list of feature.mutants ?? []) problems.push(...mutantProblems(JSON.parse(read(list)), read));
  for (const line of problems) console.log(`✖ ${line}`);
  console.log(problems.length ? `\n하네스 검사 실패: ${problems.length}건` : `하네스 검사 통과 (파일 ${files.length}개, 기능 ${map.features.length}개)`);
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
