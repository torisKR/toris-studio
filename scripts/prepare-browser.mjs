import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCE = path.join(ROOT, 'desktop/src-tauri/resources/browser');
export const MANIFEST = JSON.parse(readFileSync(path.join(RESOURCE, 'manifest.json'), 'utf8'));
const MAX_ARCHIVE = 256 * 1024 * 1024, MAX_FILE = 384 * 1024 * 1024, MAX_EXPANDED = 768 * 1024 * 1024, MAX_ENTRIES = 20000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
function safeName(name) {
    if (!name || name.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(name) || name.startsWith('/') || name.split('/').some(p => p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
        fail('Unsafe browser archive path.');
    return name;
}
function linksFor(platform) {
    const root = `chrome-${platform}/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/`;
    return new Map(Object.entries({ Resources: 'Versions/Current/Resources', 'Versions/Current': MANIFEST.chromiumVersion, Libraries: 'Versions/Current/Libraries', 'Google Chrome for Testing Framework': 'Versions/Current/Google Chrome for Testing Framework', Helpers: 'Versions/Current/Helpers' }).map(([name, target]) => [root + name, target]));
}
function zipEntries(bytes, { prefix, allowedLinks = new Map() }) {
    if (!bytes.length || bytes.length > MAX_ARCHIVE)
        fail('Browser archive size exceeds limit.');
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
        if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
            end = i;
            break;
        }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
        fail('Invalid browser ZIP.');
    const count = bytes.readUInt16LE(end + 10), central = bytes.readUInt32LE(end + 16);
    if (!count || count > MAX_ENTRIES || count !== bytes.readUInt16LE(end + 8) || central + bytes.readUInt32LE(end + 12) !== end)
        fail('Invalid browser ZIP directory.');
    let offset = central, total = 0;
    const entries = [], seen = new Set(), ranges = [];
    for (let i = 0; i < count; i++) {
        if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
            fail('Invalid browser ZIP entry.');
        const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), nameSize = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), attributes = bytes.readUInt32LE(offset + 38), local = bytes.readUInt32LE(offset + 42), next = offset + 46 + nameSize + extra + comment;
        if (next > end || flags & 1 || ![0, 8].includes(method) || size > MAX_FILE || (total += size) > MAX_EXPANDED || bytes.readUInt16LE(offset + 34) !== 0)
            fail('Unsupported browser ZIP entry or size.');
        const name = safeName(bytes.subarray(offset + 46, offset + 46 + nameSize).toString('utf8'));
        if (!name.startsWith(prefix + '/'))
            fail('Browser ZIP escapes pinned root.');
        const key = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
        if (seen.has(key))
            fail('Duplicate browser ZIP path.');
        seen.add(key);
        const type = (attributes >>> 16) & 0xf000, mode = (attributes >>> 16) & 0o777;
        if (type && ![0x8000, 0x4000, 0xa000].includes(type))
            fail('Special browser ZIP file.');
        if (local + 30 > central || bytes.readUInt32LE(local) !== 0x04034b50)
            fail('Invalid browser ZIP local entry.');
        const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localName + localExtra;
        if (start + compressed > central || bytes.subarray(local + 30, local + 30 + localName).toString('utf8') !== name || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method)
            fail('Inconsistent browser ZIP entry.');
        ranges.push([local, start + compressed]);
        const decode = () => {
            const data = bytes.subarray(start, start + compressed), decoded = method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_FILE });
            if (decoded.length !== size || crc32(decoded) !== crc)
                fail('Browser ZIP checksum mismatch.');
            return decoded;
        };
        const directory = name.endsWith('/');
        if (directory && (size || type === 0xa000))
            fail('Invalid browser ZIP directory.');
        let link = null;
        if (type === 0xa000) {
            link = decode().toString('utf8');
            if (allowedLinks.get(name) !== link)
                fail('Unsafe browser ZIP link.');
        }
        entries.push({ name, size, mode, directory, link, decode });
        offset = next;
    }
    if (offset !== end)
        fail('Invalid browser ZIP directory length.');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++)
        if (ranges[i][0] < ranges[i - 1][1])
            fail('Overlapping browser ZIP entries.');
    for (const entry of entries) {
        const components = entry.name.replace(/\/$/, '').split('/');
        for (let j = 1; j < components.length; j++) {
            const parent = components.slice(0, j).join('/').toLowerCase();
            const found = entries.find(e => e.name.replace(/\/$/, '').toLowerCase() === parent);
            if (found && !found.directory)
                fail('Browser archive descends through a file or link.');
        }
    }
    return entries;
}
export function inspectBrowserZip(bytes, platform) {
    if (!['mac-arm64', 'mac-x64', 'win64'].includes(platform))
        fail('Unsupported browser platform.');
    return zipEntries(bytes, { prefix: `chrome-${platform}`, allowedLinks: platform.startsWith('mac') ? linksFor(platform) : new Map() });
}
function tarFiles(archive, prefix, select) {
    const bytes = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED }), files = new Map();
    let offset = 0, count = 0;
    const names = new Set();
    const text = b => b.toString('utf8').replace(/\0.*$/s, '');
    const number = b => {
        const value = text(b).trim();
        if (!/^[0-7]+$/.test(value))
            fail('Invalid runtime tar number.');
        return parseInt(value, 8);
    };
    while (offset + 512 <= bytes.length) {
        const h = bytes.subarray(offset, offset + 512);
        if (h.every(v => v === 0))
            break;
        if (++count > MAX_ENTRIES)
            fail('Too many runtime tar entries.');
        let sum = 0;
        for (let i = 0; i < 512; i++)
            sum += i >= 148 && i < 156 ? 32 : h[i];
        if (number(h.subarray(148, 156)) !== sum)
            fail('Runtime tar checksum mismatch.');
        const name = safeName((text(h.subarray(345, 500)) ? text(h.subarray(345, 500)) + '/' : '') + text(h.subarray(0, 100))), size = number(h.subarray(124, 136)), type = h[156];
        if (!name.startsWith(prefix + '/') || size > MAX_FILE || offset + 512 + size > bytes.length)
            fail('Invalid runtime tar path or size.');
        if (names.has(name))
            fail('Duplicate runtime tar path.');
        names.add(name);
        if (select(name)) {
            if (type !== 0 && type !== 48)
                fail('Selected runtime file must be regular.');
            files.set(name, Buffer.from(bytes.subarray(offset + 512, offset + 512 + size)));
        }
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}
export function browserOverlay(target) {
    if (!Object.hasOwn(MANIFEST.targets, target))
        fail('Unsupported browser target.');
    const source = `browser-runtime/${target}`;
    if (!target.includes('darwin'))
        return { resources: { [source + '/']: 'studio-browser/' } };
    const chromeRoot = `chromium/chrome-${MANIFEST.targets[target].platform}`;
    const dataFiles = ['worker.mjs', 'policy.mjs', 'node_modules/', 'manifest.json', 'NODE-LICENSE', 'PLAYWRIGHT-LICENSE', 'PLAYWRIGHT-NOTICE', 'NOTICE', `${chromeRoot}/ABOUT`, `${chromeRoot}/PrivacySandboxAttestationsPreloaded/`, `${chromeRoot}/resources/`];
    return {
        macOS: { files: { 'Helpers/studio-browser/node': `${source}/node`, [`Helpers/studio-browser/${chromeRoot}/Google Chrome for Testing.app`]: `${source}/${chromeRoot}/Google Chrome for Testing.app` } },
        resources: Object.fromEntries(dataFiles.map(name => [`${source}/${name}`, `studio-browser/${name}`])),
    };
}
async function cached(spec, cache) {
    const file = path.join(cache, spec.archive);
    let bytes;
    try {
        const s = await lstat(file);
        if (!s.isFile() || s.isSymbolicLink())
            fail('Runtime cache must be regular.');
        bytes = await readFile(file);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    if (!bytes) {
        const url = new URL(spec.url);
        if (url.protocol !== 'https:' || !['nodejs.org', 'registry.npmjs.org', 'storage.googleapis.com'].includes(url.hostname))
            fail('Untrusted browser source.');
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
        if (!response.ok || !response.body)
            fail('Browser runtime download failed.');
        const parts = [];
        let length = 0;
        for await (const part of response.body) {
            if ((length += part.length) > spec.bytes)
                fail('Runtime download exceeds pinned size.');
            parts.push(Buffer.from(part));
        }
        bytes = Buffer.concat(parts);
    }
    if (bytes.length !== spec.bytes || hash(bytes) !== spec.sha256)
        fail('Runtime artifact size or SHA256 mismatch.');
    try {
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    return bytes;
}
async function writeRegular(file, bytes, mode = 0o644) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { flag: 'wx', mode }); }
export function verifyBrowserBinary(bytes, target) {
    if (target.includes('darwin')) {
        if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (target.startsWith('aarch64') ? 0x0100000c : 0x01000007))
            fail('Browser Mach-O architecture mismatch.');
    }
    else {
        const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : 0;
        if (bytes.subarray(0, 2).toString() !== 'MZ' || pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664)
            fail('Browser PE architecture mismatch.');
    }
}
export function playwrightLibraryFile(name) {
    return name.startsWith('package/') && !name.startsWith('package/bin/') && !['package/cli.js', 'package/lib/xdg-open'].includes(name) && !/\.(?:sh|ps1|cmd|bat)$/.test(name);
}
export async function prepareBrowser(target, { root = ROOT, sign = true } = {}) {
    const spec = MANIFEST.targets[target];
    if (!spec)
        fail('Unsupported browser target.');
    const base = path.join(root, 'desktop/src-tauri/browser-runtime'), cache = path.join(base, '.cache');
    await mkdir(cache, { recursive: true });
    const scratch = await mkdtemp(path.join(base, '.prepare-'));
    let destination = path.join(base, target);
    try {
        const nodeBytes = await cached(spec.node, cache), nodePrefix = spec.node.archive.replace(/\.(tar\.gz|zip)$/, ''), nodeName = target.includes('windows') ? 'node.exe' : 'bin/node';
        const selected = name => [`${nodePrefix}/${nodeName}`, `${nodePrefix}/LICENSE`].includes(name);
        const nodeFiles = spec.node.archive.endsWith('.zip') ? new Map(zipEntries(nodeBytes, { prefix: nodePrefix }).filter(e => selected(e.name)).map(e => [e.name, e.decode()])) : tarFiles(nodeBytes, nodePrefix, selected);
        const binary = nodeFiles.get(`${nodePrefix}/${nodeName}`), license = nodeFiles.get(`${nodePrefix}/LICENSE`);
        if (!binary || !license)
            fail('Node executable or license missing.');
        verifyBrowserBinary(binary, target);
        await writeRegular(path.join(scratch, target.includes('windows') ? 'node.exe' : 'node'), binary, 0o755);
        await writeRegular(path.join(scratch, 'NODE-LICENSE'), license);
        const pw = tarFiles(await cached(MANIFEST.playwright, cache), 'package', playwrightLibraryFile);
        for (const [name, data] of pw) {
            const relative = name.slice('package/'.length);
            await writeRegular(path.join(scratch, 'node_modules/playwright-core', relative), data);
        }
        const packageJson = JSON.parse(pw.get('package/package.json'));
        if (packageJson.version !== MANIFEST.playwrightVersion)
            fail('Playwright version mismatch.');
        const registry = JSON.parse(pw.get('package/browsers.json'));
        const chromium = registry.browsers.find(b => b.name === 'chromium');
        if (chromium?.revision !== MANIFEST.chromiumRevision || chromium?.browserVersion !== MANIFEST.chromiumVersion)
            fail('Pinned Playwright browser mismatch.');
        for (const [source, dest] of [['LICENSE', 'PLAYWRIGHT-LICENSE'], ['NOTICE', 'PLAYWRIGHT-NOTICE']])
            await writeRegular(path.join(scratch, dest), pw.get('package/' + source));
        const browser = inspectBrowserZip(await cached(spec.browser, cache), spec.platform);
        for (const entry of browser) {
            const file = path.join(scratch, 'chromium', entry.name);
            if (entry.directory) {
                await mkdir(file, { recursive: true });
                continue;
            }
            if (entry.link)
                continue;
            await writeRegular(file, entry.decode(), entry.mode & 0o111 ? 0o755 : 0o644);
        }
        for (const entry of browser.filter(e => e.link))
            await symlink(entry.link, path.join(scratch, 'chromium', entry.name));
        if (spec.platform.startsWith('mac') && browser.filter(e => e.link).length !== 5)
            fail('Mac browser must preserve exactly five upstream relative links.');
        verifyBrowserBinary(await readFile(path.join(scratch, spec.browserExecutable)), target);
        for (const name of ['worker.mjs', 'policy.mjs'])
            await cp(path.join(root, 'desktop/browser-runtime', name), path.join(scratch, name));
        for (const name of ['manifest.json', 'NOTICE'])
            await cp(path.join(root, 'desktop/src-tauri/resources/browser', name), path.join(scratch, name));
        if (target.includes('darwin') && sign)
            await signBrowserTree(scratch);
        try {
            const s = await lstat(destination);
            if (!s.isDirectory() || s.isSymbolicLink())
                fail('Browser destination must be real directory.');
            await rm(destination, { recursive: true });
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        await rename(scratch, destination);
        console.log(`Prepared isolated browser runtime ${target}; verified three upstream archives, versions, architecture and licenses.`);
        return destination;
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000, shell: false });
    if (result.status !== 0)
        fail(`${command} failed to verify browser runtime: ${(result.stderr || result.error?.code || "unknown").trim().slice(0, 1000)}`);
    return result;
}
async function tree(directory) {
    const out = [];
    for (const e of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, e.name);
        if (e.isSymbolicLink())
            continue;
        if (e.isDirectory()) {
            out.push(...await tree(file));
            out.push(file);
        }
        else if (e.isFile())
            out.push(file);
    }
    return out;
}
export async function signBrowserTree(directory) {
    if (process.platform !== 'darwin')
        fail('Mac browser signing requires macOS.');
    const identity = process.env.APPLE_SIGNING_IDENTITY || '-';
    const entitlements = path.join(directory, '.node-entitlements.plist');
    await writeFile(entitlements, '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
    try {
        for (const file of (await tree(directory)).sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
            const s = await lstat(file);
            let macho = false;
            if (s.isFile()) {
                const handle = await import('node:fs/promises').then(m => m.open(file, 'r'));
                try {
                    const b = Buffer.alloc(4);
                    await handle.read(b, 0, 4, 0);
                    macho = [0xfeedfacf, 0xcafebabe, 0xbebafeca].includes(b.readUInt32LE(0));
                }
                finally {
                    await handle.close();
                }
            }
            if (!macho && !/\.(app|framework)$/.test(file))
                continue;
            let entitlementFile = null;
            if (path.basename(file) === 'node')
                entitlementFile = entitlements;
            else if (macho) {
                const original = spawnSync('codesign', ['-d', '--entitlements', '-', file], { encoding: 'utf8', timeout: 15000, shell: false });
                if (original.status === 0 && original.stdout.includes('<plist')) {
                    entitlementFile = path.join(directory, '.chrome-entitlements.plist');
                    await writeFile(entitlementFile, original.stdout.slice(original.stdout.indexOf('<?xml') >= 0 ? original.stdout.indexOf('<?xml') : original.stdout.indexOf('<plist')));
                }
            }
            if (file.includes('/chromium/') && (file.includes('/MacOS/') || file.endsWith('.app'))) {
                entitlementFile = path.join(directory, '.chrome-entitlements.plist');
                await writeFile(entitlementFile, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>');
            }
            const args = ['--force', '--sign', identity, '--options', 'runtime'];
            if (identity !== '-')
                args.push('--timestamp');
            if (entitlementFile)
                args.push('--entitlements', entitlementFile);
            run('codesign', [...args, file]);
        }
        run('codesign', ['--verify', '--deep', '--strict', path.join(directory, 'chromium', (await readdir(path.join(directory, 'chromium'))).find(name => name.startsWith('chrome-mac-')), 'Google Chrome for Testing.app')]);
    }
    finally {
        await rm(entitlements, { force: true });
        await rm(path.join(directory, '.chrome-entitlements.plist'), { force: true });
    }
}
export async function verifyInstallerSizes(bundleDirectory) {
    for (const folder of ['dmg', 'nsis', 'macos']) {
        let names;
        try {
            names = await readdir(path.join(bundleDirectory, folder));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                continue;
            throw error;
        }
        for (const name of names.filter(name => /\.(?:dmg|exe|app\.tar\.gz)$/.test(name))) {
            const stat = await lstat(path.join(bundleDirectory, folder, name));
            if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 512 * 1024 * 1024)
                fail('Installer must be a regular file no larger than 512 MiB.');
        }
    }
}
export function browserStagePaths(target, directory) {
    if (!Object.hasOwn(MANIFEST.targets, target))
        fail('Unsupported browser target.');
    return target.includes('darwin')
        ? { nativeBase: path.join(directory, 'Contents/Helpers/studio-browser'), dataBase: path.join(directory, 'Contents/Resources/studio-browser') }
        : { nativeBase: path.join(directory, 'studio-browser'), dataBase: path.join(directory, 'studio-browser') };
}
export async function verifyBrowserStaged(target, directory) {
    const spec = MANIFEST.targets[target];
    if (!spec)
        fail('Unsupported browser target.');
    const { nativeBase, dataBase: base } = browserStagePaths(target, directory);
    verifyBrowserBinary(await readFile(path.join(nativeBase, target.includes('windows') ? 'node.exe' : 'node')), target);
    verifyBrowserBinary(await readFile(path.join(nativeBase, spec.browserExecutable)), target);
    for (const name of ['manifest.json', 'NOTICE'])
        if (!(await readFile(path.join(base, name))).equals(await readFile(path.join(RESOURCE, name))))
            fail('Bundled browser notices mismatch.');
    for (const name of ['node_modules/playwright-core/bin', 'node_modules/playwright-core/cli.js', 'node_modules/playwright-core/lib/xdg-open', 'node_modules/npm', 'npm', 'npx', 'pnpm', 'firefox', 'webkit', 'chromium-headless-shell']) {
        try {
            await lstat(path.join(base, name));
            fail('Bundled browser contains a forbidden installer, package manager or unused browser.');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    const pkg = JSON.parse(await readFile(path.join(base, 'node_modules/playwright-core/package.json')));
    if (pkg.version !== MANIFEST.playwrightVersion)
        fail('Bundled Playwright version mismatch.');
    for (const [name, expected] of [['NODE-LICENSE', spec.nodeLicenseSha256], ['PLAYWRIGHT-LICENSE', MANIFEST.playwright.licenseSha256], ['PLAYWRIGHT-NOTICE', MANIFEST.playwright.noticeSha256], [`chromium/chrome-${spec.platform}/ABOUT`, spec.browserAboutSha256]])
        if (hash(await readFile(path.join(base, name))) !== expected)
            fail('Bundled browser license or ABOUT mismatch.');
    for (const name of ['worker.mjs', 'policy.mjs'])
        if (!(await readFile(path.join(base, name))).equals(await readFile(path.join(ROOT, 'desktop/browser-runtime', name))))
            fail('Bundled browser worker differs from reviewed source.');
    if (target.includes('darwin')) {
        if ((await readdir(nativeBase)).some(name => !['node', 'chromium'].includes(name)))
            fail('Mac native Helpers must contain only Node and Chromium.');
        for (const [name, value] of linksFor(spec.platform)) {
            const { readlink } = await import('node:fs/promises');
            if (await readlink(path.join(nativeBase, 'chromium', name)) !== value)
                fail('Bundled Mac browser link mismatch.');
        }
        run('codesign', ['--verify', '--strict', path.join(nativeBase, 'node')]);
        run('codesign', ['--verify', '--deep', '--strict', path.join(nativeBase, 'chromium', `chrome-${spec.platform}`, 'Google Chrome for Testing.app')]);
    }
    const host = process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : '';
    if (host === target) {
        if (run(path.join(nativeBase, target.includes('windows') ? 'node.exe' : 'node'), ['--version']).stdout.trim() !== `v${MANIFEST.nodeVersion}`)
            fail('Bundled Node version mismatch.');
    }
    console.log(`Verified staged browser runtime ${target}: pinned versions, architectures, notices${target.includes('darwin') ? ', relative links and signatures' : ''}.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [command, target, directory] = process.argv.slice(2);
    const task = command === 'prepare' ? prepareBrowser(target) : command === 'verify' ? verifyBrowserStaged(target, path.resolve(directory)) : Promise.reject(new Error('Expected prepare <target> or verify <target> <stage>.'));
    task.catch(error => { console.error(error.message); process.exitCode = 1; });
}
