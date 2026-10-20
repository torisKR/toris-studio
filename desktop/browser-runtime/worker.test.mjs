import test from 'node:test';
import assert from 'node:assert/strict';

test('bounded protocol accepts only known commands and never echoes malformed input', async () => {
  const worker = await import('./worker.mjs').catch(() => ({}));
  assert.equal(typeof worker.parseCommand, 'function');
  assert.deepEqual(worker.parseCommand('{"id":1,"command":"open","url":"https://example.com"}'), { id: 1, command: 'open', url: 'https://example.com/' });
  for (const line of ['{', JSON.stringify({id:1,command:'evaluate',script:'secret'}), JSON.stringify({id:1,command:'open',url:'file:///secret'}), JSON.stringify({id:1,command:'open',url:'https://a:b@example.com'}), 'a'.repeat(65537)]) assert.throws(() => worker.parseCommand(line), /invalid_command/);
});
test('worker entry point runs through macOS temporary-directory or file aliases', async () => {
 const {mkdtemp,symlink,rm}=await import('node:fs/promises');
 const {spawnSync}=await import('node:child_process');
 const {tmpdir}=await import('node:os');
 const path=await import('node:path');const {fileURLToPath}=await import('node:url');
 const temp=await mkdtemp(path.join(tmpdir(),'studio-worker-entry-'));
 try {const alias=path.join(temp,'alias.mjs');await symlink(fileURLToPath(new URL('./worker.mjs',import.meta.url)),alias);const child=spawnSync(process.execPath,[alias],{encoding:'utf8',timeout:5000});assert.equal(child.status,1);assert.deepEqual(JSON.parse(child.stdout),{event:'failed',error:'startup_failed'});}
 finally{await rm(temp,{recursive:true,force:true});}
});
