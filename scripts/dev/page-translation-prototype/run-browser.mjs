import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (typeof WebSocket !== 'function') throw new Error('Node with native WebSocket is required (Node 22+).');
const candidates = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome', '/usr/lib/chromium/chromium', '/snap/bin/chromium'].filter(Boolean);
const located = spawnSync('sh', ['-lc', 'command -v chromium chromium-browser google-chrome google-chrome-stable'], { encoding: 'utf8' }).stdout?.trim().split('\n') ?? [];
let binary;
for (const candidate of [...candidates, ...located]) { try { await access(candidate); binary = candidate; break; } catch {} }
if (!binary) throw new Error('No supported Chrome/Chromium executable found; set CHROME_BIN to an installed browser binary.');
const profileRoot = '/tmp/opencode';
await access(profileRoot);
const profile = await mkdtemp(join(profileRoot, 'page-translation-benchmark-'));
const serverPath = fileURLToPath(new URL('./serve.mjs', import.meta.url));
let server;
let browser;
let socket;
const stopChild = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1500)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1000)]);
  }
};
const timeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

try {
  server = spawn(process.execPath, [serverPath], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: '0' } });
  let serverOutput = '';
  const baseUrl = await timeout(new Promise((resolve, reject) => {
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', (chunk) => {
      serverOutput += chunk;
      const match = serverOutput.match(/Fixture server listening at (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) resolve(match[1]);
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Fixture server exited early (${code}).`)));
  }), 10000, 'Loopback server startup');
  const ready = await fetch(baseUrl);
  if (!ready.ok || !(await ready.text()).includes('benchmark-root')) throw new Error('Owned fixture server did not serve the expected fixture page.');

  browser = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, baseUrl], { stdio: 'ignore' });
  let browserError;
  browser.once('error', (error) => { browserError = error; });
  let version;
  for (let attempt = 0; attempt < 80 && !version; attempt += 1) {
    if (browserError) throw browserError;
    if (browser.exitCode !== null || browser.signalCode !== null) throw new Error('Isolated browser exited before DevTools became ready.');
    try {
      const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch { await delay(100); }
  }
  if (!version?.webSocketDebuggerUrl) throw new Error('Could not connect to the isolated browser DevTools endpoint.');
  const cdpPort = new URL(version.webSocketDebuggerUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page' && target.url === baseUrl);
  if (!page) throw new Error('The isolated browser did not open the owned fixture page.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await timeout(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  }), 10000, 'DevTools websocket connection');

  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  const command = (method, params = {}, ms = 10000) => new Promise((resolve, reject) => {
    const commandId = ++id;
    const timer = setTimeout(() => { pending.delete(commandId); reject(new Error(`DevTools ${method} timed out.`)); }, ms);
    pending.set(commandId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: commandId, method, params }));
  });
  await command('Runtime.enable');
  let readyInPage = false;
  for (let attempt = 0; attempt < 50 && !readyInPage; attempt += 1) {
    const response = await command('Runtime.evaluate', { expression: 'typeof TranslateItPageBenchmark === "object" && typeof TranslateItViewportPrototype === "object"', returnByValue: true });
    readyInPage = response.result.value === true;
    if (!readyInPage) await delay(100);
  }
  if (!readyInPage) throw new Error('Fixture page scripts did not become ready.');
  const response = await command('Runtime.evaluate', {
    expression: 'TranslateItPageBenchmark.run({samples:5})', awaitPromise: true, returnByValue: true,
  }, 120000);
  if (response.exceptionDetails) throw new Error(`Fixture benchmark failed: ${response.exceptionDetails.text}`);
  if (!response.result.value) throw new Error('Fixture benchmark returned no aggregate result.');
  process.stdout.write(`${JSON.stringify(response.result.value, null, 2)}\n`);
} finally {
  socket?.close();
  await Promise.all([stopChild(browser), stopChild(server)]);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
