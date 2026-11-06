import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureAttachedTarget, createPipeTransport, launchChrome } from './page-translation-e2e-benchmark/chrome.mjs';

const transports = [];
afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
});

const makeTransport = () => {
  const chromeToClient = new PassThrough();
  const clientToChrome = new PassThrough();
  const transport = createPipeTransport(chromeToClient, clientToChrome, { timeoutMs: 500 });
  transports.push(transport);
  return { transport, chromeToClient, clientToChrome };
};

const readFrame = stream => new Promise(resolveFrame => {
  let buffered = '';
  const onData = chunk => {
    buffered += chunk.toString();
    const end = buffered.indexOf('\0');
    if (end === -1) return;
    stream.off('data', onData);
    resolveFrame(buffered.slice(0, end));
  };
  stream.on('data', onData);
});

describe('Chrome DevTools pipe transport', () => {
  it('frames partial NUL-delimited responses and forwards session events', async () => {
    const { transport, chromeToClient, clientToChrome } = makeTransport();
    const framePromise = readFrame(clientToChrome);
    const responsePromise = transport.send('Runtime.evaluate', { expression: '1' }, 'session-7');
    const command = JSON.parse(await framePromise);
    expect(command).toMatchObject({ id: 1, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'session-7' });

    const eventPromise = new Promise(resolveEvent => transport.onEvent(resolveEvent));
    chromeToClient.write(Buffer.from('{"method":"Runtime.executionContextCreated","params":{"context":{"id":3}},"session'));
    chromeToClient.write(Buffer.from('Id":"session-7"}\0{"id":1,"result":{"result":{"value":1}}}\0'));
    await expect(responsePromise).resolves.toEqual({ result: { value: 1 } });
    await expect(eventPromise).resolves.toEqual({
      method: 'Runtime.executionContextCreated',
      params: { context: { id: 3 } },
      sessionId: 'session-7',
    });
  });

  it('rejects protocol errors, times out requests, and rejects pending calls on close', async () => {
    const { transport, chromeToClient, clientToChrome } = makeTransport();
    const errorFrame = readFrame(clientToChrome);
    const failed = transport.send('Runtime.fail');
    const failure = JSON.parse(await errorFrame);
    chromeToClient.write(`${JSON.stringify({ id: failure.id, error: { code: -32000, message: 'expected failure' } })}\0`);
    await expect(failed).rejects.toMatchObject({ code: -32000, message: 'expected failure' });

    const timeoutFrame = readFrame(clientToChrome);
    const timedOut = transport.send('Runtime.neverReplies', {}, undefined, 15);
    await timeoutFrame;
    await expect(timedOut).rejects.toThrow('Runtime.neverReplies timed out');

    const pendingFrame = readFrame(clientToChrome);
    const pending = transport.send('Runtime.pending');
    await pendingFrame;
    transport.close(new Error('test shutdown'));
    await expect(pending).rejects.toThrow('test shutdown');
  });
});

describe('pre-start target guard', () => {
  it('does not resume an attached worker when guard setup fails', async () => {
    const send = vi.fn().mockResolvedValue({});
    const setupError = new Error('Fetch.enable failed');
    await expect(configureAttachedTarget({
      targetInfo: { type: 'service_worker' }, sessionId: 'worker-session', send,
      onEvent: vi.fn(), onAttachedTarget: async () => { throw setupError; },
    })).rejects.toBe(setupError);
    expect(send).not.toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', expect.anything(), 'worker-session');
  });
});

const waitUntil = async (fn, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Chrome smoke condition timed out after ${timeoutMs}ms.`);
};

describe('Chrome launch failure cleanup', () => {
  it('preserves the original spawn error when the binary is missing', async () => {
    const extensionPath = await mkdtemp(join(tmpdir(), 'chrome-e2e-invalid-binary-'));
    let launchError;
    try {
      await launchChrome({ extensionPath, binary: join(tmpdir(), `missing-chrome-${process.pid}-${Date.now()}`) });
    } catch (error) {
      launchError = error;
    } finally {
      await rm(extensionPath, { recursive: true, force: true });
    }
    expect(launchError).toBeInstanceOf(Error);
    expect(launchError.message).toMatch(/ENOENT|not found/);
    expect(launchError.message).not.toContain('did not exit after SIGKILL');
  });
});

describe('real Chrome unpacked-extension smoke', () => {
  it.skipIf(process.env.RUN_CHROME_EXTENSION_SMOKE !== '1')('loads an MV3 extension and observes its service worker and content-script context', async () => {
    const extensionPath = await mkdtemp(join(tmpdir(), 'chrome-e2e-extension-smoke-'));
    const server = createServer((request, response) => {
      if (request.url !== '/') { response.writeHead(404); return response.end(); }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head></head><body>Local extension context smoke</body></html>');
    });
    let chrome;
    let smokeError;
    try {
      await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        name: 'Local CDP extension smoke',
        version: '1.0.0',
        background: { service_worker: 'worker.js' },
        permissions: ['storage'],
        host_permissions: ['http://127.0.0.1/*'],
        content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_idle' }],
      }));
      await writeFile(join(extensionPath, 'worker.js'), `chrome.runtime.onMessage.addListener((message, sender, sendResponse) => { if (message?.smoke) sendResponse({ ok: true, id: chrome.runtime.id, senderUrl: sender.url }); });`);
      await writeFile(join(extensionPath, 'content.js'), `chrome.runtime.sendMessage({ smoke: true }).then(result => { document.documentElement.dataset.extensionSmoke = result?.ok && result.id === chrome.runtime.id ? 'ok' : 'failed'; }).catch(() => { document.documentElement.dataset.extensionSmoke = 'failed'; });`);
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
      });

      chrome = await launchChrome({ extensionPath: resolve(extensionPath) });
      expect(chrome.extensionId).toMatch(/^[a-p]{32}$/);
      expect(chrome.metadata.extensionId).toBe(chrome.extensionId);
      expect(chrome.metadata.browserVersion).toMatch(/^Chrome\//);

      const { targetId } = await chrome.send('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/` });
      const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true });
      const extensionContexts = [];
      const unsubscribe = chrome.onEvent(event => {
        if (event.method !== 'Runtime.executionContextCreated' || event.sessionId !== sessionId) return;
        const context = event.params.context;
        if (context.origin === `chrome-extension://${chrome.extensionId}`) extensionContexts.push(context);
      });
      await chrome.send('Runtime.enable', {}, sessionId);
      const smokeValue = () => chrome.send('Runtime.evaluate', {
        expression: 'document.documentElement.dataset.extensionSmoke || ""',
        returnByValue: true,
      }, sessionId).then(result => result.result?.value);
      await waitUntil(async () => (await smokeValue()) === 'ok');
      unsubscribe();

      const targets = await chrome.send('Target.getTargets');
      expect(targets.targetInfos).toContainEqual(expect.objectContaining({
        type: 'service_worker',
        url: `chrome-extension://${chrome.extensionId}/worker.js`,
      }));
      expect(extensionContexts.length).toBeGreaterThan(0);
      expect(extensionContexts.some(context => context.auxData?.isDefault === false)).toBe(true);
    } catch (error) {
      smokeError = error;
    }
    const cleanupErrors = [];
    const attemptCleanup = async cleanup => {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    };
    await Promise.all([
      attemptCleanup(() => chrome?.close()),
      attemptCleanup(() => new Promise((resolveClose, rejectClose) => {
        if (!server.listening) return resolveClose();
        server.close(error => error ? rejectClose(error) : resolveClose());
      })),
      attemptCleanup(() => rm(extensionPath, { recursive: true, force: true })),
    ]);
    if (smokeError && cleanupErrors.length) {
      throw new AggregateError([smokeError, ...cleanupErrors], `Chrome smoke failed (${smokeError.message}) and ${cleanupErrors.length} cleanup action(s) failed.`, { cause: smokeError });
    }
    if (smokeError) throw smokeError;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Chrome smoke cleanup failed in ${cleanupErrors.length} action(s).`);
  }, 45_000);
});
