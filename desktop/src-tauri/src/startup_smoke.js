// This fixed script runs only in the isolated --startup-smoke webview. The
// production index and React application are otherwise unchanged.
(() => {
  'use strict';
  const expectedNavigation = ['SNS 관리', '콘텐츠', '제작', '게시', '운영'];
  const expectedReads = ['get_dashboard', 'ai_status', 'oauth_connections', 'analytics_dispatch:status', 'get_settings', 'get_scheduler_status', 'get_keychain_status', 'get_update_status', 'browser_runtime_status'];
  const nativeFixtures = __NATIVE_FIXTURES__;
  const failures = new Set();
  const reads = new Set();
  let completed = false;
  let sent = false;
  let closedResult = null;
  let readySince = 0;
  let settingsOpened = false;
  // Replaced by Tauri's documented invoke_system API. The key never leaves this
  // closure except in the one fixed result message sent to the native runtime.
  const invokeKey = __INVOKE_KEY__;
  const fail = code => { failures.add(code); };
  addEventListener('error', event => fail(event.target === window ? 'javascript-error' : 'resource-error'), true);
  addEventListener('unhandledrejection', () => fail('unhandled-rejection'));
  const originalError = console.error;
  console.error = (...args) => { fail('console-error'); originalError.apply(console, args); };

  const fixtures = (command, args = {}) => {
    if (command === 'get_dashboard') {
      return {channels: [], content: [], trends: [], integrations: [], database: {connected: false, message: 'Isolated native startup fixture'}};
    }
    if (command === 'creation_bridge_info') {
      return {mcpExecutable: '/fixture/Toris Studio', protocolVersion: '2025-11-25', lastObservedAt: null};
    }
    if (command === 'ai_status') return {providers: [], contentModel: null, agentModel: null, image: null};
    // Settings shows the local voice engine; the isolated check never inspects Python or models.
    if (command === 'tts_status') {
      return {supported: true, state: 'stopped', owned: false, narration: false, installed: false, python: null, model: null, install: {phase: 'idle', step: '', log: []}, lastError: null, endpoint: 'http://127.0.0.1:50010', license: {commercialUse: true, model: {name: 'Qwen3-TTS-12Hz-1.7B-CustomVoice', license: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'}, runtime: [{name: 'mlx-audio', license: 'MIT'}]}};
    }
    if (command === 'oauth_connections') {
      return {connections: [], bindings: [], warnings: []};
    }
    if (command === 'analytics_dispatch') {
      if (args.input?.action === 'status') {
        return {schemaReady: false, migrationRequired: true, paused: false, jobs: [], capabilities: [], limits: {maxBytes: 5242880, maxRows: 10000, maxColumns: 100}};
      }
      if (args.input?.action === 'query') return {observations: [], hasMore: false, coverage: [], totalIsNotComputed: true};
      if (args.input?.action === 'importHistory') return {imports: []};
    }
    if (command === 'publication_list') return {publications: [], media: [], scheduler: {paused: false, running: false, message: 'Isolated native startup fixture'}};
    if (Object.prototype.hasOwnProperty.call(nativeFixtures, command)) return JSON.parse(JSON.stringify(nativeFixtures[command]));
    if (command === 'motion_request_list') return [];
    if (command === 'creation_request_list') return {requests: []};
    if (command === 'asset_command' && args.action === 'snapshot') return {assets: [], jobs: [], total: 0, libraryTotal: 0, offset: 0, limit: 100, jobTotal: 0, settings: {}};
    if (command === 'set_main_activity') return null;
    if (command === 'plugin:event|listen') return 0;
    if (command === 'plugin:event|unlisten') return null;
    fail('unexpected-ipc');
    throw new Error('Unsupported isolated startup fixture');
  };
  Object.defineProperty(window.__TAURI_INTERNALS__, 'postMessage', {
    value: Object.freeze(message => {
      if (message.cmd === 'startup_smoke_result' && closedResult && !sent) {
        sent = true;
        window.ipc.postMessage(JSON.stringify({
          cmd: 'startup_smoke_result',
          callback: message.callback,
          error: message.error,
          payload: {result: closedResult},
          options: {},
          __TAURI_INVOKE_KEY__: invokeKey
        }));
        return;
      }
      Promise.resolve().then(() => fixtures(message.cmd, message.payload)).then(
        value => {
          window.__TAURI_INTERNALS__.runCallback(message.callback, value);
          const read = message.cmd === 'analytics_dispatch' ? `analytics_dispatch:${message.payload?.input?.action}` : message.cmd;
          if (expectedReads.includes(read)) reads.add(read);
        },
        () => window.__TAURI_INTERNALS__.runCallback(message.error, 'Unsupported isolated startup fixture')
      );
    })
  });

  const isoDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const snapshot = () => {
    const navigation = [...document.querySelectorAll('nav[aria-label="주 메뉴"] button')].map(button => button.textContent.trim());
    const from = document.querySelector('input[aria-label="분석 시작일"]')?.value ?? '';
    const to = document.querySelector('input[aria-label="분석 종료일"]')?.value ?? '';
    const sns = Boolean(document.querySelector('nav[aria-label="SNS 관리 화면"]'));
    const noBoundary = !document.getElementById('startup-error-title');
    const settingsLoaded = Boolean(document.querySelector('.desktop-settings #settings-database'))
      && document.querySelector('.desktop-browser-settings')?.getAttribute('aria-busy') === 'false'
      && document.querySelector('.desktop-update')?.getAttribute('aria-busy') === 'false'
      && document.querySelector('.desktop-update-version strong')?.textContent === nativeFixtures.get_update_status.currentVersion;
    return {navigation, from, to, sns, noBoundary, settingsLoaded};
  };
  const finish = () => {
    if (completed) return;
    completed = true;
    const state = snapshot();
    closedResult = {...state, failures: [...failures], reads: [...reads].sort()};
    // Keep Tauri's actual invoke implementation. Its only native destination in
    // this builder is the closed result command above; app IPC stays local.
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    originalInvoke('startup_smoke_result', {result: closedResult}).catch(() => {});
  };
  const interval = setInterval(() => {
    const state = snapshot();
    if (!state.noBoundary) fail('startup-boundary');
    if (failures.size) { clearInterval(interval); finish(); return; }
    const shellReady = state.sns && state.noBoundary
      && state.navigation.length === expectedNavigation.length
      && expectedNavigation.every((label, index) => label === state.navigation[index])
      && isoDate(state.from) && isoDate(state.to) && state.from <= state.to;
    if (shellReady && !settingsOpened) {
      const settings = document.querySelector('nav[aria-label="앱 설정"] button');
      if (!settings) return;
      settingsOpened = true;
      settings.click();
      return;
    }
    const ready = shellReady && state.settingsLoaded
      && expectedReads.every(command => reads.has(command));
    if (!ready) { readySince = 0; return; }
    // Wait through lazy import, React effects and asynchronous fixture reads.
    if (!readySince) readySince = performance.now();
    if (performance.now() - readySince >= 1000) { clearInterval(interval); finish(); }
  }, 50);
  setTimeout(() => { if (!completed) { fail('startup-timeout'); clearInterval(interval); finish(); } }, 15000);
})();
