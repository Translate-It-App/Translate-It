import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';

export function createPipeTransport(readable, writable, { timeoutMs = 10_000 } = {}) {
  let nextId = 0;
  let buffered = Buffer.alloc(0);
  let closed = false;
  let closeError = null;
  const pending = new Map();
  const listeners = new Set();

  const close = (error = new Error('Chrome DevTools pipe closed.')) => {
    if (closed) return;
    closed = true;
    closeError = error;
    readable.off('data', onData);
    readable.off('end', onEnd);
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(closeError);
    }
    pending.clear();
    listeners.clear();
  };

  const onError = error => {
    if (!closed) close(error);
  };
  const onEnd = () => close(new Error('Chrome DevTools pipe ended.'));
  const onData = chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    let delimiter;
    while ((delimiter = buffered.indexOf(0)) !== -1) {
      const frame = buffered.subarray(0, delimiter);
      buffered = buffered.subarray(delimiter + 1);
      let message;
      try {
        message = JSON.parse(frame.toString('utf8'));
      } catch (error) {
        close(new Error(`Invalid Chrome DevTools pipe JSON: ${error.message}`));
        return;
      }
      if (message.id !== undefined) {
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) {
          const error = new Error(message.error.message ?? 'Chrome DevTools command failed.');
          error.code = message.error.code;
          error.data = message.error.data;
          request.reject(error);
        } else {
          request.resolve(message.result);
        }
        continue;
      }
      if (typeof message.method === 'string') {
        const event = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
        for (const listener of listeners) listener(event);
      }
    }
  };

  readable.on('data', onData);
  readable.on('error', onError);
  readable.once('end', onEnd);
  writable.on('error', onError);

  return {
    send(method, params = {}, sessionId, requestTimeoutMs = timeoutMs) {
      if (closed) return Promise.reject(closeError ?? new Error('Chrome DevTools pipe is closed.'));
      const id = ++nextId;
      const command = { id, method, params };
      if (sessionId !== undefined) command.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome DevTools ${method} timed out after ${requestTimeoutMs}ms.`));
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          writable.write(`${JSON.stringify(command)}\0`, error => {
            if (!error) return;
            const request = pending.get(id);
            if (!request) return;
            pending.delete(id);
            clearTimeout(request.timer);
            request.reject(error);
          });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    onEvent(listener) {
      if (closed) throw closeError ?? new Error('Chrome DevTools pipe is closed.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  };
}

const waitForExit = (child, timeoutMs) => new Promise(resolvePromise => {
  if (child.exitCode !== null || child.signalCode !== null) return resolvePromise(true);
  const finish = exited => {
    clearTimeout(timer);
    child.off('exit', onExit);
    resolvePromise(exited);
  };
  const onExit = () => finish(true);
  const timer = setTimeout(() => finish(false), timeoutMs);
  child.once('exit', onExit);
});

export async function configureAttachedTarget({ onAttachedTarget, targetInfo, sessionId, send, onEvent }) {
  await onAttachedTarget({ targetInfo, sessionId, send, onEvent });
  await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
}

export async function launchChrome({ extensionPath, binary = '/usr/bin/google-chrome-stable', commandTimeoutMs = 15_000, onAttachedTarget } = {}) {
  if (typeof extensionPath !== 'string' || !isAbsolute(extensionPath)) {
    throw new TypeError('extensionPath must be an absolute path to an unpacked extension directory.');
  }
  const unpackedPath = resolve(extensionPath);
  if (!(await stat(unpackedPath)).isDirectory()) throw new TypeError('extensionPath must be a directory.');

  const profilePath = await mkdtemp(resolve(tmpdir(), 'page-translation-e2e-chrome-'));
  const child = spawn(binary, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profilePath}`,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  const transport = createPipeTransport(child.stdio[4], child.stdio[3], { timeoutMs: commandTimeoutMs });
  let closePromise;
  let extensionId;
  let browserVersion;
  const attachErrors = [];
  const targetSetup = new Map();

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      transport.close(new Error('Chrome driver closed.'));
      let exitError;
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        if (!(await waitForExit(child, 2_000))) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          if (!(await waitForExit(child, 2_000))) exitError = new Error('Chrome process did not exit after SIGKILL.');
        }
      }
      await rm(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (exitError) throw exitError;
    })();
    return closePromise;
  };

  child.once('exit', (code, signal) => {
    transport.close(new Error(`Chrome exited (${code ?? signal ?? 'unknown'}).`));
  });
  child.once('error', error => transport.close(error));

  try {
    const version = await transport.send('Browser.getVersion');
    browserVersion = version.product;
    if (onAttachedTarget) {
      transport.onEvent(event => {
        if (event.method !== 'Target.attachedToTarget' || !event.params.waitingForDebugger) return;
        const sessionId = event.params.sessionId;
        const targetInfo = event.params.targetInfo;
        const setup = configureAttachedTarget({ onAttachedTarget, targetInfo, sessionId, send: transport.send, onEvent: transport.onEvent });
        targetSetup.set(targetInfo?.targetId, setup);
        setup.catch(error => { attachErrors.push(`${targetInfo?.type}: ${error.message}`); });
      });
      await transport.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'service_worker', exclude: false }, { exclude: true }],
      });
    }
    const loaded = await transport.send('Extensions.loadUnpacked', { path: unpackedPath });
    extensionId = loaded?.id ?? loaded?.extensionId;
    if (onAttachedTarget) {
      const deadline = Date.now() + commandTimeoutMs;
      let targetInfo;
      while (Date.now() < deadline) {
        if (attachErrors.length) throw new Error(`Failed to install pre-start target guard: ${attachErrors[0]}`);
        targetInfo = (await transport.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${extensionId}/worker.js`);
        if (targetInfo && targetSetup.has(targetInfo.targetId)) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      if (!targetInfo || !targetSetup.has(targetInfo.targetId)) throw new Error('MV3 service worker did not reach guarded startup before timeout.');
      await targetSetup.get(targetInfo.targetId);
      if (attachErrors.length) throw new Error(`Failed to install pre-start target guard: ${attachErrors[0]}`);
    }
    return {
      send: transport.send,
      onEvent: transport.onEvent,
      close,
      extensionId,
      metadata: { binary, browserVersion, extensionId, extensionPath: unpackedPath, get stderr() { return stderr.trim(); }, get attachErrors() { return [...attachErrors]; } },
    };
  } catch (error) {
    let cleanupError;
    try { await close(); } catch (closeError) { cleanupError = closeError; }
    const detail = stderr.trim();
    const message = `Failed to launch Chrome/load unpacked extension: ${error.message}${detail ? `\n${detail}` : ''}`;
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], `${message}\nChrome cleanup also failed: ${cleanupError.message}`, { cause: error });
    }
    throw new Error(message, { cause: error });
  }
}
