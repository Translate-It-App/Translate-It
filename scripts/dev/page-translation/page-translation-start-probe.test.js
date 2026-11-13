import { afterEach, describe, expect, it, vi } from 'vitest';
import { wrapPageTranslationStart } from './e2e-benchmark/page-translation-start-probe.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

afterEach(() => vi.restoreAllMocks());

describe('PageTranslationManager.translatePage benchmark wrapper', () => {
  it('traces Chrome-style entry synchronously and records actual start and settlement times without changing return semantics', async () => {
    const times = [10, 20, 30, 40];
    vi.spyOn(Date, 'now').mockImplementation(() => times.shift());
    const first = deferred();
    const second = deferred();
    const error = new Error('original rejection');
    const manager = {};
    const args = [{ isAuto: true, targetLanguage: 'fr' }];
    const original = vi.fn()
      .mockImplementationOnce(function (...values) { expect(this).toBe(manager); expect(values).toEqual(args); return first.promise; })
      .mockImplementationOnce(function () { expect(this).toBe(manager); return second.promise; });
    const events = [];
    const report = vi.fn();
    manager.translatePage = wrapPageTranslationStart(original, {
      isProbeStart: () => false,
      report,
      onStart(_manager, callArgs, at) { events.push({ name: 'manager.translatePage.entry', at, isAuto: callArgs[0].isAuto, targetLanguage: callArgs[0].targetLanguage }); },
      onSettled(_manager, _callArgs, at, endedAt, result, failure) { events.push({ name: 'settled', at, endedAt, result, failure }); },
    });

    const firstCall = manager.translatePage(...args);
    expect(firstCall).toBe(first.promise);
    expect(events).toEqual([{ name: 'manager.translatePage.entry', at: 10, isAuto: true, targetLanguage: 'fr' }]);
    first.resolve({ success: true });
    await firstCall;
    expect(events[1]).toMatchObject({ name: 'settled', at: 10, endedAt: 20, result: { success: true }, failure: null });

    const failedCall = manager.translatePage({ isAuto: false, targetLanguage: 'de' });
    expect(failedCall).toBe(second.promise);
    expect(events[2]).toMatchObject({ name: 'manager.translatePage.entry', at: 30, isAuto: false, targetLanguage: 'de' });
    second.reject(error);
    await expect(failedCall).rejects.toBe(error);
    expect(events[3]).toMatchObject({ name: 'settled', at: 30, endedAt: 40, failure: error });
    expect(report).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledTimes(2);
  });

  it('reports actual opt-in success and failure once, awaits the acknowledgement, and preserves the exact result', async () => {
    const result = { success: true, messageId: 'page-translate-real-session' };
    const reportAck = deferred();
    const reportEntered = deferred();
    const original = vi.fn(async () => result);
    const evidence = [];
    let settled = null;
    const manager = { translatePage: null };
    manager.translatePage = wrapPageTranslationStart(original, {
      isProbeStart: options => options?.provider === 'edge' && options?.targetLanguage === 'fr',
      report(item) { evidence.push(item); reportEntered.resolve(); return reportAck.promise; },
      onSettled(_manager, _args, _at, _endedAt, value, failure) { settled = { value, failure }; },
    });
    let callResolved = false;
    const call = manager.translatePage({ provider: 'edge', targetLanguage: 'fr' });
    call.then(() => { callResolved = true; });
    await reportEntered.promise;

    expect(evidence).toEqual([{ success: true, sessionId: result.messageId, code: null }]);
    expect(settled).toEqual({ value: result, failure: null });
    expect(callResolved).toBe(false);
    reportAck.resolve({ accepted: true });
    await expect(call).resolves.toBe(result);
    expect(evidence).toHaveLength(1);

    const failedResult = { success: false, reason: 'private page detail' };
    const failedEvidence = [];
    const failedOriginal = vi.fn(async () => failedResult);
    const failed = wrapPageTranslationStart(failedOriginal, {
      isProbeStart: options => options?.provider === 'edge' && options?.targetLanguage === 'fr',
      report(item) { failedEvidence.push(item); return Promise.resolve({ accepted: true }); },
    });
    await expect(failed({ provider: 'edge', targetLanguage: 'fr' })).resolves.toBe(failedResult);
    expect(failedEvidence).toEqual([{ success: false, sessionId: null, code: 'PROTOCOL_ERROR' }]);
    expect(JSON.stringify(failedEvidence)).not.toContain('private page detail');
    expect(failedOriginal).toHaveBeenCalledOnce();
  });
});
