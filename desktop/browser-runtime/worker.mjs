import childProcess from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyUrl, createHandoff, MAX_LINE_BYTES } from './policy.mjs';

export function parseCommand(line) {
  try {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error();
    const input = JSON.parse(line);
    if (!Number.isSafeInteger(input?.id) || input.id < 0) throw new Error();
    if (input.command === 'shutdown' && Object.keys(input).every(key => ['id', 'command'].includes(key))) return { id: input.id, command: 'shutdown' };
    if (input.command !== 'open' || Object.keys(input).some(key => !['id', 'command', 'url'].includes(key))) throw new Error();
    return { id: input.id, command: 'open', url: classifyUrl(input.url).url };
  } catch { throw new Error('invalid_command'); }
}

export async function runWorker(args) {
  if (args.length !== 4 || args[0] !== '--browser' || args[2] !== '--profile' || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw new Error('invalid_arguments');
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const handoff = createHandoff(url => emit({ event: 'system_open', url }));
  let browserProcess, closed = false, stopping = false;
  const markClosed = () => { if (!closed) { closed = true; emit({ event: 'closed' }); } };
  // Playwright 1.63.0 launches Chromium in its own Unix process group. Capture
  // only this fixed executable before launch resolves, so Rust can reap the
  // owned group even if the worker crashes while Chromium is starting.
  const spawn = childProcess.spawn;
  childProcess.spawn = function(command, ...rest) {
    const child = spawn.call(this, command, ...rest);
    if (command === args[1] && child.pid) {
      browserProcess = child;
      emit({ event: 'browser_started', pid: child.pid });
      child.once('exit', () => { markClosed(); process.exitCode = 0; process.stdin.destroy(); });
    }
    return child;
  };
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright-core');
  const context = await chromium.launchPersistentContext(args[3], {
    executablePath: args[1], headless: false, chromiumSandbox: true, timeout: 30_000,
    serviceWorkers: 'block', acceptDownloads: false,
    handleSIGINT: true, handleSIGTERM: true, handleSIGHUP: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:DEBUG|PWDEBUG|NODE_OPTIONS|NODE_INSPECT_RESUME_ON_START)$/.test(name))),
  });
  childProcess.spawn = spawn;
  context.setDefaultNavigationTimeout(25_000);
  // Install at browser target level with paused auto-attach. New pages,
  // popups and their redirect chains cannot run before Fetch is enabled.
  const debuggerSession = await context.browser().newBrowserCDPSession();
  // The pinned in-process Library adapter is needed because public CDPSession
  // cannot address flattened child sessions. Fail closed if the pinned API
  // changes: never resume an unprotected page or popup.
  const internal = debuggerSession._connection?.toImpl?.(debuggerSession)?._session;
  if (typeof internal?.createChildSession !== 'function') throw new Error('policy_unavailable');
  const installing = new Set(), authNavigations = new Set(), targetSessions = new Map();
  debuggerSession.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    const session = internal.createChildSession(sessionId);
    targetSessions.set(sessionId, { session, targetId: targetInfo.targetId });
    session.on('Fetch.requestPaused', event => {
      void (async () => {
        let target;
        try { target = classifyUrl(event.request.url); } catch {
          await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); return;
        }
        if (target.auth) {
          authNavigations.add(targetInfo.targetId);
          handoff(target.url);
          await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
        } else await session.send('Fetch.continueRequest', { requestId: event.requestId });
      })().catch(() => { void context.close().catch(() => {}); });
    });
    const task = (async () => {
      if (['page', 'iframe'].includes(targetInfo.type)) await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
      await session.send('Runtime.runIfWaitingForDebugger');
    })();
    installing.add(task);
    void task.catch(() => context.close().catch(() => {})).finally(() => installing.delete(task));
  });
  debuggerSession.on('Target.detachedFromTarget', ({ sessionId }) => {
    const target = targetSessions.get(sessionId);
    if (target) { authNavigations.delete(target.targetId); target.session.dispose(); targetSessions.delete(sessionId); }
  });
  await debuggerSession.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await Promise.all([...installing]);
  context.on('close', () => { /* closed is emitted only after owned browser exit. */ });
  emit({ event: 'ready', browserPid: browserProcess?.pid, browserVersion: context.browser().version() });
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await context.close().catch(() => {});
    if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) await new Promise(resolve => browserProcess.once('exit', resolve));
    markClosed();
    process.stdin.destroy();
  };
  let pending = Buffer.alloc(0), queue = Promise.resolve();
  process.stdin.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_LINE_BYTES && !pending.includes(10)) { emit({ id: null, ok: false, error: 'invalid_command' }); void shutdown(); return; }
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
      queue = queue.then(async () => {
        let command;
        try { command = parseCommand(line.toString('utf8')); } catch { emit({ id: null, ok: false, error: 'invalid_command' }); return; }
        if (command.command === 'shutdown') { await shutdown(); emit({ id: command.id, ok: true }); return; }
        if (stopping || closed) { emit({ id: command.id, ok: false, error: 'browser_closed' }); return; }
        try {
          const target = classifyUrl(command.url);
          if (target.auth) handoff(target.url);
          else {
            const page = await context.newPage();
            const pageSession = await context.newCDPSession(page);
            const { targetInfo } = await pageSession.send('Target.getTargetInfo');
            await pageSession.detach();
            try {
              await page.goto(target.url, { waitUntil: 'domcontentloaded' });
            } catch {
              // Opening a link is successful while its browser page remains alive,
              // including native OAuth handoff and Chromium's network-error page.
              if (page.isClosed() || !context.browser()?.isConnected()) throw new Error('browser_closed');
            } finally { authNavigations.delete(targetInfo.targetId); }
          }
          emit({ id: command.id, ok: true });
        } catch { emit({ id: command.id, ok: false, error: 'open_failed' }); }
      }).catch(() => { emit({ id: null, ok: false, error: 'worker_failed' }); void shutdown(); });
    }
  });
  process.stdin.on('end', () => { void queue.finally(shutdown); });
  process.stdin.on('error', () => { void shutdown(); });
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runWorker(process.argv.slice(2)).catch(() => { process.stdout.write('{"event":"failed","error":"startup_failed"}\n'); process.exitCode = 1; });
}
