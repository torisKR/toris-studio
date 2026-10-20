import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.env.STUDIO_BROWSER_TEST_TARGET || (process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : 'x86_64-pc-windows-msvc');
const runtime = process.env.STUDIO_BROWSER_TEST_RUNTIME || path.join(root, 'desktop/src-tauri/browser-runtime', target);
const manifest = JSON.parse(await import('node:fs/promises').then(m => m.readFile(path.join(root, 'desktop/src-tauri/resources/browser/manifest.json'), 'utf8')));
const nativeRuntime = process.env.STUDIO_BROWSER_TEST_NATIVE_RUNTIME || (target.includes('darwin') && path.basename(path.dirname(runtime)) === 'Resources' ? path.resolve(runtime, '../../Helpers/studio-browser') : runtime);
const node = path.join(nativeRuntime, target.includes('windows') ? 'node.exe' : 'node'), browser = path.join(nativeRuntime, manifest.targets[target].browserExecutable);
const prepared = await access(node).then(() => true, () => false);
test('real headed worker preserves profile, blocks auth initial/redirect/popup network and exits owned browser', { skip: !prepared && !process.env.STUDIO_BROWSER_TEST_RUNTIME, timeout: 90000 }, async () => {
    assert.ok(prepared, 'explicit extracted runtime must exist');
    let authHits = 0, profileVisits = 0, heartbeats = 0;
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(req.url);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (req.url === '/heartbeat') { heartbeats++; res.end('alive'); return; }
        if (req.url === '/safe-before-error') {
            res.end('<script>setInterval(() => fetch("/heartbeat"), 30)</script>safe');
            return;
        }
        if (req.url === '/network-error') {
            req.socket.destroy();
            return;
        }
        if (req.url.startsWith('/hop')) {
            res.writeHead(302, { location: req.url === '/hop' ? '/hop2' : '/%6f%61uth/authorize?state=fixture' });
            res.end();
            return;
        }
        if (/oauth|authorize/.test(decodeURIComponent(req.url))) {
            authHits++;
            res.end('AUTH MUST NEVER REACH PLAYWRIGHT');
            return;
        }
        if (req.url === '/popupdirect') {
            res.end('<script>window.open("/oauth/authorize?state=popupdirect")</script>');
            return;
        }
        if (req.url === '/form') {
            res.end('<form method="post" action="/oauth/authorize?state=form"><input name="fixture" value="local-only"></form><script>document.forms[0].submit()</script>');
            return;
        }
        if (req.url === '/popup') {
            res.end('<script>window.open("/hop")</script>');
            return;
        }
        if (req.url === '/profile') {
            if (req.headers.cookie === 'studio_fixture=retained')
                profileVisits++;
            res.setHeader('Set-Cookie', 'studio_fixture=retained; Max-Age=3600; SameSite=Lax');
            res.end('profile');
            return;
        }
        res.end('safe');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const profile = await mkdtemp(path.join(os.tmpdir(), 'studio-browser-fixture-'));
    const children = [];
    let id = 0;
    const start = async () => {
        const child = spawn(node, [path.join(runtime, 'worker.mjs'), '--browser', browser, '--profile', profile], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEBUG: '', PWDEBUG: '', NODE_OPTIONS: '' } });
        children.push(child);
        const events = [];
        const waiters = [];
        let stderr = '';
        child.stderr.on('data', b => { stderr += b.toString(); });
        createInterface({ input: child.stdout }).on('line', line => {
            const event = JSON.parse(line);
            events.push(event);
            for (const waiter of [...waiters])
                if (event.event === 'failed' || waiter.predicate(event)) {
                    waiters.splice(waiters.indexOf(waiter), 1);
                    clearTimeout(waiter.timer);
                    waiter.resolve(event);
                }
        });
        const wait = predicate => {
            const found = events.find(predicate);
            if (found)
                return Promise.resolve(found);
            return new Promise((resolve, reject) => { const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('fixture_event_timeout; events=' + events.map(e => [e.event, e.id, e.ok, e.error].filter(v => v !== undefined).join(':')).join(',') + '; requests=' + requests.join(',') + '; authHits=' + authHits + '; handoffs=' + events.filter(e => e.event === 'system_open').map(e => e.url).join(',') + '; ' + stderr.slice(0, 200))), 35000) }; waiters.push(waiter); });
        };
        const command = async (command, url) => { const commandId = ++id; child.stdin.write(JSON.stringify({ id: commandId, command, ...(url ? { url } : {}) }) + '\n'); return wait(e => e.id === commandId); };
        const ready = await wait(e => e.event === 'ready');
        assert.equal(ready.event, 'ready', 'worker startup failed');
        assert.equal(ready.browserVersion, manifest.chromiumVersion, 'actual bundled Chromium version');
        return { child, events, wait, command };
    };
    try {
        let worker = await start();
        const pid = worker.events.find(e => e.event === 'browser_started').pid;
        assert.ok(pid > 0);
        assert.equal((await worker.command('open', origin + '/safe-before-error')).ok, true);
        assert.equal((await worker.command('open', origin + '/network-error')).ok, true, 'broken link keeps the persistent browser and its previous tabs');
        assert.equal((await worker.command('open', origin + '/safe-after-error')).ok, true, 'same browser remains usable after network failure');
        const previousTabHeartbeats = heartbeats;
        for (let i = 0; i < 100 && heartbeats <= previousTabHeartbeats; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(heartbeats > previousTabHeartbeats, 'the previous safe tab remains alive after the broken link');
        assert.equal(worker.events.filter(e => e.event === 'browser_started').length, 1, 'network failure never replaces the browser process');
        assert.equal(worker.events.find(e => e.event === 'browser_started').pid, pid);
        assert.equal((await worker.command('open', origin + '/oauth/authorize?state=initial')).ok, true);
        assert.equal((await worker.command('open', origin + '/hop')).ok, true, 'successful OAuth handoff preserves the current browser');
        await worker.wait(e => e.event === 'system_open' && e.url.endsWith('/%6f%61uth/authorize?state=fixture'));
        await worker.command('open', origin + '/popup');
        for (let i = 0; i < 100 && requests.filter(url => url === '/hop').length < 2; i++)
            await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(requests.filter(url => url === '/hop').length, 2, 'popup redirected through fixture');
        await worker.command('open', origin + '/popupdirect');
        await worker.wait(e => e.event === 'system_open' && e.url.endsWith('state=popupdirect'));
        await worker.command('open', origin + '/form');
        await worker.wait(e => e.event === 'system_open' && e.url.endsWith('state=form'));
        await worker.command('open', origin + '/profile');
        await worker.command('shutdown');
        await worker.wait(e => e.event === 'closed');
        assert.equal(authHits, 0, `OAuth was requested in Playwright: ${requests.join(',')}`);
        assert.equal(worker.events.filter(e => e.event === 'system_open' && e.url.includes('state=fixture')).length, 1, 'redirect and popup handoff deduplicated');
        assert.ok(worker.events.every(e => !e.error || !e.error.includes(origin)), 'errors never expose URLs');
        worker = await start();
        await worker.command('open', origin + '/profile');
        assert.equal(profileVisits, 1, 'Studio profile reused');
        await worker.command('shutdown');
        await worker.wait(e => e.event === 'closed');
    }
    finally {
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
                await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 2000).unref(); });
            }
        }
        await new Promise(resolve => server.close(resolve));
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
