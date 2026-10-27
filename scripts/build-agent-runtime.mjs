#!/usr/bin/env node
// Bundles desktop/agent-runtime into one self-contained ESM file shipped as a Tauri resource.
import { build } from 'esbuild';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'desktop/src-tauri/resources/agent-runtime');
const OUT = path.join(OUT_DIR, 'agent.mjs');
const MAX_BUNDLE = 16 * 1024 * 1024;

export async function buildAgentRuntime() {
  await mkdir(OUT_DIR, { recursive: true });
  await build({
    entryPoints: [path.join(ROOT, 'desktop/agent-runtime/src/main.ts')],
    outfile: OUT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: false,
    legalComments: 'eof',
    logLevel: 'warning',
    // Some dependencies still call require(); give the ESM bundle a real one.
    banner: { js: "import { createRequire as __agentRequire } from 'node:module'; const require = __agentRequire(import.meta.url);" },
  });
  const size = (await stat(OUT)).size;
  if (size > MAX_BUNDLE) throw new Error(`Agent runtime bundle is ${size} bytes; limit is ${MAX_BUNDLE}.`);
  const digest = createHash('sha256').update(await readFile(OUT)).digest('hex');
  await writeFile(path.join(OUT_DIR, 'agent.mjs.sha256'), `${digest}\n`);
  console.log(`Built agent runtime: ${path.relative(ROOT, OUT)} (${(size / 1024).toFixed(0)} KiB, sha256 ${digest.slice(0, 12)})`);
  return { path: OUT, sha256: digest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildAgentRuntime();
