import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

if (typeof WebSocket !== 'function') throw new Error('Node native WebSocket is required (Node 22+).');

const root = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(root, 'package.json'));
const domRoot = resolve(require.resolve('domtranslator'), '..');
const bridgePath = join(root, 'src/features/page-translation/PageTranslationBridge.js');
const constantsPath = join(root, 'src/features/page-translation/PageTranslationConstants.js');
const fixturePath = join(import.meta.dirname, 'fixture.js');
const [bridgeBytes, constantsBytes, fixtureSource] = await Promise.all([
  readFile(bridgePath), readFile(constantsPath), readFile(fixturePath, 'utf8'),
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bridgeHash = sha256(bridgeBytes);
const constantsHash = sha256(constantsBytes);
const harnessHash = sha256(await readFile(import.meta.filename));
const fixtureHash = sha256(Buffer.from(fixtureSource));
const originalConstants = constantsBytes.toString('utf8');
const expectedDefaults = [
  'export const PAGE_TRANSLATION_DISCOVERY_SLICE_MAX_STEPS = 100;',
  'export const PAGE_TRANSLATION_DISCOVERY_SLICE_BUDGET_MS = 8;',
];
const expectedWindowCaps = [
  'export const PAGE_TRANSLATION_VIEWPORT_WINDOW_ENUMERATION_STEPS = 100;',
  'export const PAGE_TRANSLATION_VIEWPORT_WINDOW_MAX_CANDIDATES = 100;',
  'export const PAGE_TRANSLATION_VIEWPORT_WINDOW_MAX_GEOMETRY_CHECKS = 100;',
];
for (const line of expectedDefaults) {
  if (!originalConstants.includes(line)) throw new Error(`Unexpected production constants; required: ${line}`);
}
for (const line of expectedWindowCaps) {
  if (!originalConstants.includes(line)) throw new Error(`Unexpected production window caps; required: ${line}`);
}
// The shipped defaults may change; each benchmark mode pins its own flags.
const discoveryFlagPattern = name => new RegExp(`export const ${name} = (?:true|false);`);
for (const name of ['PAGE_TRANSLATION_SLICED_DISCOVERY', 'PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY']) {
  if (!discoveryFlagPattern(name).test(originalConstants)) throw new Error(`Unexpected production constants; required flag: ${name}`);
}

const modes = (process.env.BENCH_MODES ?? 'legacy,sliced,viewport').split(',');
if (modes.length < 1 || modes.some(mode => !['legacy', 'sliced', 'viewport'].includes(mode)) || new Set(modes).size !== modes.length) {
  throw new Error('BENCH_MODES must be a unique comma-separated subset of legacy,sliced,viewport.');
}
if (modes.includes('viewport') && !discoveryFlagPattern('PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY').test(originalConstants)) {
  throw new Error('Viewport-first production flag is not ready. Run the full benchmark after core reports readiness.');
}

const samples = Number(process.env.BENCH_SAMPLES ?? 10);
const prefixNodes = Number(process.env.BENCH_PREFIX_NODES ?? 1200);
if (!Number.isInteger(samples) || samples < 1 || !Number.isInteger(prefixNodes) || prefixNodes < 200) {
  throw new Error('BENCH_SAMPLES must be >=1 and BENCH_PREFIX_NODES >=200.');
}
const fixtures = ['late-dom', 'flat'];
const latencyProfiles = [0, 50];
const binaries = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'].filter(Boolean);
const located = spawnSync('sh', ['-lc', 'command -v chromium chromium-browser google-chrome google-chrome-stable'], { encoding: 'utf8' }).stdout?.trim().split('\n') ?? [];
let binary;
for (const candidate of [...binaries, ...located]) {
  try { await access(candidate); binary = candidate; break; } catch { /* Try the next executable candidate. */ }
}
if (!binary) throw new Error('No Chrome/Chromium executable found; set CHROME_BIN.');

const profile = await mkdtemp('/tmp/opencode/page-translation-production-benchmark-');
const token = randomUUID();
let server;
let browser;
let socket;
const stop = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1200)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1000)]);
  }
};
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  delay(ms).then(() => { throw new Error(`${label} timed out after ${ms}ms`); }),
]);

const mocks = {
  '/mock/resource.js': `export default class ResourceTracker { constructor(){this.t=new Set()} trackTimeout(f,n){const id=setTimeout(()=>{this.t.delete(id);f()},n);this.t.add(id);return id} clearTimer(id){clearTimeout(id);this.t.delete(id)} cleanup(){for(const id of this.t)clearTimeout(id);this.t.clear()} }`,
  '/mock/logger.js': `export const getScopedLogger=()=>({debug(){},info(){},warn(){},error(){}});`,
  '/mock/logConstants.js': `export const LOG_COMPONENTS={PAGE_TRANSLATION:'page-translation'};`,
  '/mock/direction.js': `export const applyNodeDirection=()=>{};export const isRTL=()=>false;export const restoreElementDirection=()=>{};export const BIDI_MARKS={RLM:'\\u200f',LRM:'\\u200e'};`,
  '/mock/hover.js': `export const hoverPreviewLookup={clear(){},add(){},remove(){}};`,
  '/mock/fonts.js': `export const getTranslationFontTarget=()=>null;`,
  '/mock/ui.js': `export const NOTIFICATION_TIME={WARNING:1,FATAL:1};export const UI_HOST_IDS={TOOLTIP:'x',MAIN:'x',IFRAME:'x'};`,
  '/mock/translation.js': `export const TRANSLATION_HTML={IGNORE_CLASS:'ignore',NO_TRANSLATE_CLASS:'no-translate',NO_TRANSLATE_VALUE:'no'};`,
};
const aliases = {
  '@/core/memory/ResourceTracker.js': '/mock/resource.js',
  '@/shared/logging/logger.js': '/mock/logger.js',
  '@/shared/logging/logConstants.js': '/mock/logConstants.js',
  '@/utils/dom/DomDirectionManager.js': '/mock/direction.js',
  '@/features/shared/hover-preview/HoverPreviewLookup.js': '/mock/hover.js',
  '@/shared/fonts/TranslationFontPolicy.js': '/mock/fonts.js',
  '@/utils/dom/walkOpenShadowTree.js': '/shared/repo/src/utils/dom/walkOpenShadowTree.js',
  '@/shared/constants/ui.js': '/mock/ui.js',
  '@/shared/constants/translation.js': '/mock/translation.js',
};

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;min-height:100%;font:16px sans-serif}
  .prefix,.tail{height:20px}
  .viewport-panel{position:fixed;inset:0;z-index:2;pointer-events:auto;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(4,minmax(0,1fr));background:#fff}
  .viewport-panel p{margin:0;padding:8px;display:flex;align-items:center;justify-content:center;border:1px solid #ddd}
</style>
<script>globalThis.__benchToken=${JSON.stringify(token)}</script>
<script type="importmap">IMPORTMAP</script>
<script type="module">
  const classes={};
  for(const mode of MODES){const module=await import('/'+mode+'/repo/src/features/page-translation/PageTranslationBridge.js');classes[mode]=module.PageTranslationBridge;}
  const fixtureUrl='/fixture.js';
  const fixtureModule=await import(fixtureUrl);
  globalThis.calibrateLongTasks=()=>fixtureModule.calibrateLongTaskObserver();
  globalThis.runBenchmark=({mode,fixture,latency,prefixCount,longTaskCaptureValid})=>fixtureModule.runProductionFixture({Bridge:classes[mode],mode,fixture,latency,prefixCount,longTaskCaptureValid});
</script>`;
const importMap = {
  imports: {
    domtranslator: 'http://127.0.0.1:PORT/dom/index.js',
    'domtranslator/utils/nodes': 'http://127.0.0.1:PORT/dom/utils/nodes.js',
  },
};
for (const [specifier, route] of Object.entries(aliases)) importMap.imports[specifier] = `http://127.0.0.1:PORT${route}`;
const page = html.replace('IMPORTMAP', JSON.stringify(importMap)).replace('MODES', JSON.stringify(modes));
const mime = path => extname(path) === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
const sourceByPath = new Map([[bridgePath, bridgeBytes], [constantsPath, constantsBytes]]);

async function resolveDomModule(file) {
  for (const candidate of [file, `${file}.js`, join(file, 'index.js')]) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* Try the next module resolution form. */ }
  }
  throw new Error(`domtranslator module not found: ${file}`);
}

async function rewriteDomImports(source, file) {
  const imports = [...source.matchAll(/((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+)(['"])/g)];
  for (const match of imports) {
    const target = await resolveDomModule(resolve(file, '..', match[2]));
    const url = `/dom/${relative(domRoot, target).split(sep).join('/')}`;
    source = source.replace(match[0], `${match[1]}${url}${match[3]}`);
  }
  return source;
}

server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(page.replaceAll('PORT', String(server.address().port)));
    }
    if (url.pathname === '/fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return response.end(fixtureSource);
    }
    if (mocks[url.pathname]) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return response.end(mocks[url.pathname]);
    }
    if (url.pathname.startsWith('/dom/')) {
      const relative = url.pathname.slice('/dom/'.length);
      const file = await resolveDomModule(join(domRoot, relative));
      if (!file.startsWith(domRoot + sep)) throw new Error('Path traversal rejected');
      const source = await rewriteDomImports(await readFile(file, 'utf8'), file);
      response.writeHead(200, { 'content-type': mime(file), 'cache-control': 'no-store' });
      return response.end(source);
    }

    const match = url.pathname.match(/^\/(legacy|sliced|viewport|shared)\/(.*)$/);
    if (!match || !match[2].startsWith('repo/')) throw new Error(`Unknown route ${url.pathname}`);
    const [, mode, relative] = match;
    const file = resolve(root, relative.slice('repo/'.length));
    if (!file.startsWith(root + sep)) throw new Error('Path traversal rejected');
    const bytes = sourceByPath.get(file) ?? await readFile(file);
    if (file === bridgePath && sha256(bytes) !== bridgeHash) throw new Error('Bridge source changed during benchmark');
    if (file === constantsPath && sha256(bytes) !== constantsHash) throw new Error('Constants source changed during benchmark');

    let source = bytes.toString('utf8');
    if (file === constantsPath) {
      // Each mode pins its own discovery flags, independent of the shipped defaults.
      source = source
        .replace(/export const PAGE_TRANSLATION_SLICED_DISCOVERY = (?:true|false);/, `export const PAGE_TRANSLATION_SLICED_DISCOVERY = ${mode !== 'legacy'};`)
        .replace(/export const PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY = (?:true|false);/, `export const PAGE_TRANSLATION_VIEWPORT_FIRST_DISCOVERY = ${mode === 'viewport'};`);
    }
    response.writeHead(200, { 'content-type': mime(file), 'cache-control': 'no-store' });
    response.end(source);
  } catch (error) {
    process.stderr.write(`benchmark module server ${request.url}: ${error.stack ?? error}\n`);
    response.writeHead(500);
    response.end(String(error));
  }
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/`;
  browser = spawn(binary, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, base,
  ], { stdio: 'ignore', detached: true });
  let version;
  for (let attempt = 0; attempt < 100 && !version; attempt++) {
    if (browser.exitCode !== null) throw new Error('Isolated browser exited.');
    try {
      const [devtoolsPort] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      version = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json();
    } catch { await delay(100); }
  }
  if (!version?.webSocketDebuggerUrl) throw new Error('DevTools did not start.');
  const devtoolsPort = new URL(version.webSocketDebuggerUrl).port;
  const target = (await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json())
    .find(item => item.type === 'page' && item.url === base);
  if (!target) throw new Error('Benchmark page missing.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await withTimeout(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  }), 10_000, 'CDP connect');

  let nextId = 0;
  const pending = new Map();
  const browserErrors = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(JSON.stringify({
      text: message.params.exceptionDetails.text,
      details: message.params.exceptionDetails.exception?.description,
      url: message.params.exceptionDetails.url,
      line: message.params.exceptionDetails.lineNumber,
    }));
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warn'].includes(message.params.type)) {
      browserErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    }
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  const command = (method, params = {}, timeoutMs = 150_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command('Runtime.enable');
  const evaluate = async (expression, timeoutMs = 30_000) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result;
  };
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    try { ready = (await evaluate(`globalThis.__benchToken===${JSON.stringify(token)}&&typeof globalThis.runBenchmark==='function'`)).value === true; }
    catch { /* Browser module graph may still be loading. */ }
    if (!ready) await delay(100);
  }
  if (!ready) throw new Error(`Production Bridge browser modules did not initialize: ${browserErrors.join(' | ') || 'no browser console details'}`);

  // A separate 75ms busy task verifies observer capture; it is not a benchmark trial.
  process.stderr.write('Long-task observer calibration starting.\n');
  const longTaskCalibration = (await evaluate('globalThis.calibrateLongTasks()')).value;
  process.stderr.write(`Long-task observer calibration: ${JSON.stringify(longTaskCalibration)}\n`);
  const longTaskCaptureValid = longTaskCalibration.supported
    && longTaskCalibration.captured
    && longTaskCalibration.maxDurationMs >= 50;
  const run = async (mode, fixture, latency, sample) => {
    const result = await evaluate(`globalThis.runBenchmark(${JSON.stringify({ mode, fixture, latency, prefixCount: prefixNodes, longTaskCaptureValid })})`);
    return { ...result.value, mode, sample };
  };
  const runs = [];
  for (const fixture of fixtures) for (const latency of latencyProfiles) {
    process.stderr.write(`Benchmark fixture=${fixture} callbackDelayMs=${latency}\n`);
    for (const mode of modes) await run(mode, fixture, latency, 'warmup');
    for (let sample = 1; sample <= samples; sample++) {
      const round = [...modes];
      if (sample % 2 === 0) round.reverse();
      for (const mode of round) runs.push(await run(mode, fixture, latency, sample));
    }
  }

  const quantile = (values, q) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(q * sorted.length) - 1];
  };
  const fields = [
    'firstVisibleAcceptedWriteMs', 'visibleCompletionMs', 'allWriteCompletionMs',
    'discoveryDrainElapsedMs', 'translateInvocationElapsedMs', 'mainThreadLongTaskTotalMs', 'mainThreadLongTaskMaxMs',
  ];
  const aggregate = [];
  for (const fixture of fixtures) for (const latency of latencyProfiles) for (const mode of modes) {
    const trials = runs.filter(run => run.fixture === fixture && run.latencyMs === latency && run.mode === mode);
    const metrics = Object.fromEntries(fields.map(field => {
      const values = trials.map(trial => trial[field]);
      if (values.some(value => value === null || !Number.isFinite(value))) {
        return [field, { p50: null, p95: null, samples: values.length, available: false }];
      }
      return [field, { p50: quantile(values, 0.5), p95: quantile(values, 0.95), samples: values.length }];
    }));
    aggregate.push({
      fixture,
      providerLatencyMs: latency,
      mode,
      metrics,
      expectedTargetsPerTrial: trials.map(trial => trial.expectedEligibleTargets),
      translatedTargetsPerTrial: trials.map(trial => trial.translatedTargets),
      providerAdmissionsPerTrial: trials.map(trial => trial.providerAdmissions),
      duplicateAdmissionTrials: trials.filter(trial => trial.duplicateAdmissionIds.length).length,
      longTaskCountPerTrial: trials.map(trial => trial.mainThreadLongTaskCount),
    });
  }

  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    source: {
      head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      branch: spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      bridgeSha256: bridgeHash,
      constantsSha256: constantsHash,
      harnessSha256: harnessHash,
      fixtureSha256: fixtureHash,
    },
    browser: { binary, version: version.Browser },
    method: {
      productionPath: 'Actual PageTranslationBridge, GuardedNodesTranslator, and installed domtranslator; flags overlaid in memory by module graph.',
      providerBoundary: 'Direct deterministic Bridge callback with fixed 0ms/50ms resolution delay; no scheduler, batching, queue, or external provider transport.',
      fixture: { prefixNodes, tailNodes: 64, viewportTargets: 16, lateDom: 'fixed viewport-spanning panel follows offscreen prefix in DOM order.', flat: 'same panel precedes offscreen prefix in DOM order.' },
      targetValidation: 'All eligible prefix, tail, and viewport targets carry unique IDs; every ID must be admitted exactly once and translated exactly once.',
      sliceCaps: { maxSteps: 100, budgetMs: 8 },
      viewportWindowCaps: { enumerationSteps: 100, candidates: 100, geometryChecks: 100 },
      samplesPerModeLatencyFixture: samples,
      warmupsPerModeLatencyFixture: 1,
      ordering: 'All modes warm up before measured rounds; mode order reverses on alternating rounds.',
      firstVisibleAcceptedWrite: 'MutationObserver sees expected translated DOM text for a viewport target; not a paint metric.',
      discoveryDrain: 'Elapsed invocation-to-drain callback; legacy synchronous translate invocation duration. Not active traversal CPU time.',
      mainThreadLongTasks: 'PerformanceObserver longtask entries (browser threshold, generally >=50ms); per-trial count, maximum duration, and total duration are filtered to overlap the interval from scheduled translate invocation through last accepted write.',
      mainThreadLongTaskBoundary: 'translate() executes inside a native scheduled macrotask after setup. A task intersecting either interval boundary is counted at its full reported duration because Long Task entries cannot be split; observer delivery is drained after completion.',
      longTaskCalibration,
      longTaskCaptureValid,
      limitations: [
        'Direct callback omits PageTranslationScheduler, real queue/batch execution, and external provider transport.',
        'Only this Chrome/Chromium binary is measured.',
        'Report contains no page text.',
      ],
    },
    trialCount: runs.length,
    aggregate,
    trials: runs,
  };
  const output = resolve(process.env.BENCH_OUTPUT ?? '/tmp/opencode/page-translation-production-benchmark-final.json');
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, trialCount: report.trialCount, longTaskCalibration, longTaskCaptureValid, aggregate }, null, 2)}\n`);
} finally {
  socket?.close();
  await stop(browser);
  await new Promise(resolve => server?.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
