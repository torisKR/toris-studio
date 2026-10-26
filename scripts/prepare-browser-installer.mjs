import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowserStaged, MANIFEST } from './prepare-browser.mjs';
import { verifyStaged } from './prepare-runtime.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { throw new Error(message); };
export function installerCandidate(names, target) {
    if (!Object.hasOwn(MANIFEST.targets, target))
        fail('Unsupported installer target.');
    const extension = target.includes('darwin') ? '.dmg' : '.exe';
    const candidates = names.filter(name => name.endsWith(extension));
    if (candidates.length !== 1)
        fail('Expected exactly one installer for extraction verification.');
    return candidates[0];
}
async function run(command, args, { env = process.env, timeout = 180000 } = {}) {
    const child = spawn(command, args, { shell: false, stdio: 'inherit', env });
    const timer = setTimeout(() => child.kill(), timeout);
    try {
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1)); });
        if (code !== 0)
            fail('Installer extraction or browser fixture failed.');
    }
    finally {
        clearTimeout(timer);
    }
}
async function findRuntime(directory, depth = 0) {
    if (depth > 10)
        fail('Installer runtime nesting exceeds limit.');
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
            fail('Unexpected Windows installer link.');
        if (!entry.isDirectory())
            continue;
        const file = path.join(directory, entry.name);
        if (entry.name === 'studio-browser')
            found.push(file);
        else
            found.push(...await findRuntime(file, depth + 1));
    }
    return found;
}
export async function verifyBrowserInstaller(target, bundleDirectory, { execute = true } = {}) {
    const nativeTarget = process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : process.platform === 'win32' && process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : '';
    if (execute && target !== nativeTarget)
        fail('Installer execution verification requires the matching native OS and architecture.');
    const directory = path.join(bundleDirectory, target.includes('darwin') ? 'dmg' : 'nsis');
    const installer = path.join(directory, installerCandidate(await readdir(directory), target));
    const stat = await lstat(installer);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 512 * 1024 * 1024)
        fail('Installer must be a regular file no larger than 512 MiB.');
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'studio-browser-installer-'));
    try {
        let stage, runtime;
        if (target.includes('darwin')) {
            const mount = path.join(scratch, 'mount');
            await mkdir(mount);
            let attached = false;
            try {
                await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-quiet', '-mountpoint', mount, installer]);
                attached = true;
                const apps = (await readdir(mount)).filter(name => name.endsWith('.app'));
                if (apps.length !== 1)
                    fail('Disk image must contain exactly one app.');
                stage = path.join(scratch, apps[0]);
                await cp(path.join(mount, apps[0]), stage, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
            }
            finally {
                if (attached)
                    await run('hdiutil', ['detach', '-quiet', mount]);
            }
            runtime = path.join(stage, 'Contents/Resources/studio-browser');
            await run('codesign', ['--verify', '--deep', '--strict', stage]);
        }
        else {
            const extracted = path.join(scratch, 'extracted');
            await mkdir(extracted);
            await run(process.platform === 'darwin' ? '7zz' : '7z', ['x', '-y', `-o${extracted}`, installer]);
            const candidates = await findRuntime(extracted);
            if (candidates.length !== 1)
                fail('Installer must contain exactly one Studio browser runtime.');
            runtime = candidates[0];
            stage = path.dirname(runtime);
        }
        await verifyStaged(target, stage);
        await verifyBrowserStaged(target, stage);
        if (execute)
            await run(process.execPath, ['--test', path.join(ROOT, 'desktop/browser-runtime/fixture.test.mjs')], { env: { ...process.env, STUDIO_BROWSER_TEST_RUNTIME: runtime, STUDIO_BROWSER_TEST_TARGET: target } });
        console.log(`Verified re-extracted installer ${target}: pinned bundled runtimes${execute ? ' and real headed browser fixture' : ' (static checks only; no native execution)'}.`);
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [target, bundle, option] = process.argv.slice(2);
    if (option && option !== '--static-only')
        throw new Error('Unknown installer verifier option.');
    verifyBrowserInstaller(target, path.resolve(bundle), { execute: option !== '--static-only' }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
