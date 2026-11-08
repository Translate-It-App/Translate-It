import { describe, expect, it, vi } from 'vitest';
import { createSuccessfulReplyGate } from './page-translation-e2e-benchmark/successful-reply-gate.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function message(sessionId = 'session-A', messageId = 'batch-A', action = 'PAGE_TRANSLATE_BATCH') {
  return { action, messageId, data: { sessionId } };
}

function gateFor(options = {}) {
  return createSuccessfulReplyGate({ sessionId: 'session-A', messageId: 'batch-A', timeoutMs: 100, ...options });
}

describe('successful reply gate', () => {
  it('holds only the exact action, session, and message and passes unmatched promises through unchanged', async () => {
    const captured = deferred();
    const gate = gateFor({ onEvent: event => { if (event.type === 'captured') captured.resolve(); } });
    const source = deferred();
    const wrongSession = Promise.resolve({ success: true });
    const wrongMessage = Promise.resolve({ success: true });
    const wrongAction = Promise.resolve({ success: true });

    expect(gate.intercept(message('session-B'), wrongSession)).toBe(wrongSession);
    expect(gate.intercept(message('session-A', 'batch-B'), wrongMessage)).toBe(wrongMessage);
    expect(gate.intercept(message('session-A', 'batch-A', 'OTHER'), wrongAction)).toBe(wrongAction);
    expect(gate.snapshot().status).toBe('armed');

    const matching = gate.intercept(message(), source.promise);
    expect(gate.snapshot()).toMatchObject({ status: 'pending', pending: true, timer: true });
    const response = { success: true };
    source.resolve(response);
    await captured.promise;
    expect(gate.release()).toBe(true);
    await expect(matching).resolves.toBe(response);
  });

  it('returns the original successful response unchanged after one explicit release', async () => {
    const captured = deferred();
    const gate = gateFor({ onEvent: event => { if (event.type === 'captured') captured.resolve(); } });
    const response = { success: true, translatedText: 'secret result' };
    const intercepted = gate.intercept(message(), Promise.resolve(response));

    await captured.promise;
    expect(gate.snapshot()).toMatchObject({ status: 'captured', captured: true, released: false, settled: false, pending: true, timer: true });
    expect(gate.release()).toBe(true);
    expect(gate.release()).toBe(false);
    await expect(intercepted).resolves.toBe(response);
    expect(gate.snapshot()).toMatchObject({ status: 'released', captured: true, released: true, settled: true, pending: false, timer: false });
  });

  it('fails closed on a duplicate matching invocation and drains the first captured response', async () => {
    const captured = deferred();
    const gate = gateFor({ onEvent: event => { if (event.type === 'captured') captured.resolve(); } });
    const response = { success: true };
    const intercepted = gate.intercept(message(), Promise.resolve(response));
    await captured.promise;

    const duplicate = Promise.resolve({ success: true, source: 'duplicate' });
    expect(gate.intercept(message(), duplicate)).toBe(duplicate);
    await expect(intercepted).resolves.toBe(response);
    expect(gate.snapshot()).toMatchObject({ status: 'failed', captured: true, released: false, pending: false, timer: false, error: 'duplicate matching invocation' });
    expect(gate.release()).toBe(false);
  });

  it('forwards original failure responses without holding them', async () => {
    const gate = gateFor();
    const response = { success: false, hasError: true, error: 'provider failure' };
    const source = Promise.resolve(response);
    const intercepted = gate.intercept(message(), source);

    expect(intercepted).not.toBe(source);
    await expect(intercepted).resolves.toBe(response);
    expect(gate.snapshot()).toMatchObject({ status: 'failed', captured: false, released: false, settled: true, pending: false, timer: false });
  });

  it('records a non-success reply as failed-to-capture while preserving its object', async () => {
    const gate = gateFor();
    const response = { success: true, hasError: 'provider rejected the response' };
    const intercepted = gate.intercept(message(), Promise.resolve(response));

    await expect(intercepted).resolves.toBe(response);
    expect(gate.snapshot()).toMatchObject({ status: 'failed', captured: false, settled: true, pending: false, timer: false });
    expect(gate.snapshot().error).toContain('not a successful response');
  });

  it('preserves original rejection identity and fails closed for unsupported selected values', async () => {
    const rejectionGate = gateFor();
    const originalError = new Error('original provider rejection');
    const rejected = rejectionGate.intercept(message(), Promise.reject(originalError));
    await expect(rejected).rejects.toBe(originalError);
    expect(rejectionGate.snapshot()).toMatchObject({ status: 'failed', settled: true, pending: false, timer: false });

    const unsupportedGate = gateFor();
    const unsupported = { then() {} };
    expect(unsupportedGate.intercept(message(), unsupported)).toBe(unsupported);
    expect(unsupportedGate.snapshot()).toMatchObject({ status: 'failed', captured: false, pending: false, timer: false });
    expect(unsupportedGate.snapshot().error).toContain('native Promise');
  });

  it('times out before source success without changing the eventual genuine reply', async () => {
    vi.useFakeTimers();
    try {
      const source = deferred();
      const gate = gateFor({ timeoutMs: 25 });
      const intercepted = gate.intercept(message(), source.promise);

      await vi.advanceTimersByTimeAsync(25);
      expect(gate.snapshot()).toMatchObject({ status: 'timed-out', pending: true, settled: false, timer: false });
      const response = { success: true, translatedText: 'late but genuine' };
      source.resolve(response);
      await expect(intercepted).resolves.toBe(response);
      expect(gate.snapshot()).toMatchObject({ status: 'timed-out', captured: false, settled: true, pending: false, timer: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a captured reply, opens the barrier, and rejects later release', async () => {
    vi.useFakeTimers();
    try {
      const captured = deferred();
      const gate = gateFor({ timeoutMs: 25, onEvent: event => { if (event.type === 'captured') captured.resolve(); } });
      const response = { success: true };
      const intercepted = gate.intercept(message(), Promise.resolve(response));
      await captured.promise;

      await vi.advanceTimersByTimeAsync(25);
      await expect(intercepted).resolves.toBe(response);
      expect(gate.snapshot()).toMatchObject({ status: 'timed-out', captured: true, released: false, settled: true, pending: false, timer: false });
      expect(gate.release()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close before source success prevents a future hold and close after capture drains it', async () => {
    const preCloseGate = gateFor();
    const source = deferred();
    const preClosed = preCloseGate.intercept(message(), source.promise);
    expect(preCloseGate.close('harness teardown')).toBe(true);
    expect(preCloseGate.close('again')).toBe(false);
    const preCloseResponse = { success: true };
    source.resolve(preCloseResponse);
    await expect(preClosed).resolves.toBe(preCloseResponse);
    expect(preCloseGate.snapshot()).toMatchObject({ status: 'closed', captured: false, settled: true, pending: false, timer: false, error: 'harness teardown' });

    const captured = deferred();
    const postCloseGate = gateFor({ onEvent: event => { if (event.type === 'captured') captured.resolve(); } });
    const response = { success: true };
    const postClosed = postCloseGate.intercept(message(), Promise.resolve(response));
    await captured.promise;
    expect(postCloseGate.close('cleanup')).toBe(true);
    await expect(postClosed).resolves.toBe(response);
    expect(postCloseGate.snapshot()).toMatchObject({ status: 'closed', captured: true, released: false, settled: true, pending: false, timer: false, error: 'cleanup' });
    expect(postCloseGate.snapshot().events.map(event => event.type)).toContain('closed');
  });

  it('forwards a response without holding after the gate was closed before interception', async () => {
    const gate = gateFor();
    gate.close('already tearing down');
    const source = Promise.resolve({ success: true });
    expect(gate.intercept(message(), source)).toBe(source);
    expect(gate.snapshot()).toMatchObject({ status: 'closed', captured: false, pending: false, timer: false });
  });

  it('does not leak reply payloads into bounded event snapshots', async () => {
    const captured = deferred();
    const gate = gateFor({ onEvent: event => { if (event.type === 'captured') captured.resolve(); } });
    const response = { success: true, translatedText: 'private translation payload' };
    let deliveredCount = 0;
    const intercepted = gate.intercept(message(), Promise.resolve(response)).then(value => {
      deliveredCount++;
      return value;
    });
    await captured.promise;
    const snapshot = gate.snapshot();
    expect(snapshot).toMatchObject({ status: 'captured', captured: true, released: false, settled: false, pending: true, timer: true });
    expect(JSON.stringify(snapshot)).not.toContain(response.translatedText);
    expect(snapshot.descriptor).toEqual({ action: 'PAGE_TRANSLATE_BATCH', sessionId: 'session-A', messageId: 'batch-A' });
    expect(gate.release()).toBe(true);
    await expect(intercepted).resolves.toBe(response);
    expect(deliveredCount).toBe(1);
    expect(gate.snapshot()).toMatchObject({ status: 'released', settled: true, pending: false, timer: false });
    expect(gate.snapshot().events.map(event => event.type)).not.toContain('timeout');
  });
});
