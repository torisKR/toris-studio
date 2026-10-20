import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import path from 'node:path';
function zip(entries) {
    const locals = [], centrals = [];
    let offset = 0;
    for (const { name, data = '', attributes = 0 } of entries) {
        const file = Buffer.from(data), filename = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46);
        local.writeUInt32LE(0x04034b50);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc32(file), 14);
        local.writeUInt32LE(file.length, 18);
        local.writeUInt32LE(file.length, 22);
        local.writeUInt16LE(filename.length, 26);
        central.writeUInt32LE(0x02014b50);
        central.writeUInt16LE(0x0314, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc32(file), 16);
        central.writeUInt32LE(file.length, 20);
        central.writeUInt32LE(file.length, 24);
        central.writeUInt16LE(filename.length, 28);
        central.writeUInt32LE(attributes, 38);
        central.writeUInt32LE(offset, 42);
        locals.push(local, filename, file);
        centrals.push(central, filename);
        offset += 30 + filename.length + file.length;
    }
    const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, end]);
}
test('browser ZIP rejects traversal, duplicates, special files, unsafe links and size bombs', async () => {
    const module = await import('./prepare-browser.mjs').catch(() => ({}));
    assert.equal(typeof module.inspectBrowserZip, 'function');
    const inspect = entries => module.inspectBrowserZip(zip(entries), 'mac-arm64');
    assert.equal(inspect([{ name: 'chrome-mac-arm64/file', data: 'ok' }]).length, 1);
    for (const entries of [[{ name: '../escape' }], [{ name: 'chrome-mac-arm64/a' }, { name: 'chrome-mac-arm64/a' }], [{ name: 'chrome-mac-arm64/a', attributes: 0x10000000 }], [{ name: 'chrome-mac-arm64/a', data: '../../escape', attributes: 0xa0000000 }], [{ name: 'chrome-mac-arm64/A' }, { name: 'chrome-mac-arm64/a' }], [{ name: 'chrome-mac-arm64/a/' }, { name: 'chrome-mac-arm64/a' }]])
        assert.throws(() => inspect(entries));
    const bomb = zip([{ name: 'chrome-mac-arm64/a' }]);
    bomb.writeUInt32LE(0x7fffffff, 30 + Buffer.byteLength('chrome-mac-arm64/a') + 24);
    assert.throws(() => module.inspectBrowserZip(bomb, 'mac-arm64'));
});
test('pinned source artifacts have hashes, byte counts, licenses and target architecture', async () => {
    const { MANIFEST, browserOverlay } = await import('./prepare-browser.mjs');
    assert.equal(MANIFEST.nodeVersion, '24.16.0');
    assert.equal(MANIFEST.playwrightVersion, '1.63.0');
    assert.equal(MANIFEST.chromiumRevision, '1243');
    for (const [target, spec] of Object.entries(MANIFEST.targets)) {
        for (const artifact of [spec.node, spec.browser, MANIFEST.playwright]) {
            assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
            assert.ok(artifact.bytes > 0);
            assert.match(artifact.url, /^https:\/\//);
            assert.ok(artifact.license);
        }
        const overlay = browserOverlay(target);
        if (target.includes('darwin'))
            assert.deepEqual(overlay.macOS.files, { 'Helpers/studio-browser/node': `browser-runtime/${target}/node`, [`Helpers/studio-browser/chromium/chrome-${spec.platform}/Google Chrome for Testing.app`]: `browser-runtime/${target}/chromium/chrome-${spec.platform}/Google Chrome for Testing.app` });
        else
            assert.equal(Object.values(overlay.resources)[0], 'studio-browser/');
    }
});
test('installer verification refuses ambiguous candidates and ignores signatures', async () => {
    const module = await import('./prepare-browser-installer.mjs').catch(() => ({}));
    assert.equal(typeof module.installerCandidate, 'function');
    assert.equal(module.installerCandidate(['app.dmg', 'app.dmg.sig'], 'aarch64-apple-darwin'), 'app.dmg');
    assert.equal(module.installerCandidate(['app.exe', 'app.exe.sig'], 'x86_64-pc-windows-msvc'), 'app.exe');
    for (const files of [[], ['a.dmg', 'b.dmg']])
        assert.throws(() => module.installerCandidate(files, 'aarch64-apple-darwin'));
});
test('deployed Playwright Library excludes CLIs and platform installer scripts', async () => {
    const { playwrightLibraryFile } = await import('./prepare-browser.mjs');
    assert.equal(typeof playwrightLibraryFile, 'function');
    for (const name of ['package/cli.js', 'package/bin/reinstall_chrome_beta_mac.sh', 'package/bin/reinstall_chrome_stable_win.ps1', 'package/lib/xdg-open'])
        assert.equal(playwrightLibraryFile(name), false, name);
    for (const name of ['package/index.js', 'package/index.mjs', 'package/package.json', 'package/browsers.json', 'package/lib/coreBundle.js', 'package/LICENSE', 'package/NOTICE'])
        assert.equal(playwrightLibraryFile(name), true, name);
});
test('desktop builds reject an installer exceeding 512 MiB', async () => {
    const { verifyInstallerSizes } = await import('./prepare-browser.mjs');
    assert.equal(typeof verifyInstallerSizes, 'function');
    const { mkdtemp, mkdir, open, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const temp = await mkdtemp(path.join(tmpdir(), 'studio-size-'));
    try {
        await mkdir(path.join(temp, 'dmg'));
        const file = await open(path.join(temp, 'dmg/app.dmg'), 'w');
        await file.truncate(512 * 1024 * 1024 + 1);
        await file.close();
        await assert.rejects(verifyInstallerSizes(temp), /512 MiB/);
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
});
test('Mac deployment separates signed native helpers from JavaScript data resources', async () => {
    const { browserOverlay, browserStagePaths } = await import('./prepare-browser.mjs');
    const overlay = browserOverlay('aarch64-apple-darwin');
    assert.equal(Object.values(overlay.resources).includes('studio-browser/worker.mjs'), true);
    assert.equal(Object.values(overlay.resources).includes('studio-browser/node_modules/'), true);
    assert.equal(typeof browserStagePaths, 'function');
    const paths = browserStagePaths('aarch64-apple-darwin', '/tmp/Test.app');
    assert.equal(paths.nativeBase, path.join('/tmp/Test.app', 'Contents', 'Helpers', 'studio-browser'));
    assert.equal(paths.dataBase, path.join('/tmp/Test.app', 'Contents', 'Resources', 'studio-browser'));
    const win = browserStagePaths('x86_64-pc-windows-msvc', '/tmp/win');
    assert.equal(win.nativeBase, win.dataBase);
});
test('Mac browser archive auxiliary data is copied outside the signed Helpers code tree', async () => {
    const { browserOverlay } = await import('./prepare-browser.mjs');
    const overlay = browserOverlay('aarch64-apple-darwin');
    for (const name of ['ABOUT', 'resources/', 'PrivacySandboxAttestationsPreloaded/'])
        assert.equal(overlay.resources[`browser-runtime/aarch64-apple-darwin/chromium/chrome-mac-arm64/${name}`], `studio-browser/chromium/chrome-mac-arm64/${name}`);
    assert.equal(Object.values(overlay.macOS.files).some(source => source.endsWith('/chromium')), false);
});
