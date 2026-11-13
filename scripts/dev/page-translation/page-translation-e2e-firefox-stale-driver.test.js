import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assertFirefoxProbeModeFlags, replacementRequiredCapabilities, staleSuccessRequiredCapabilities } from './e2e-firefox/capabilities.mjs';
import { classifyReplacementProxyRequests, classifyStaleReplyHash, replacementSourceIndexes, STALE_SUCCESS_HOLD_WINDOW_MS } from './e2e-firefox/driver.mjs';

const targetTexts = Array.from({ length: 12 }, (_, index) => `Benchmark sentence ${index + 1} has stable fixture content.`);
const hash = value => createHash('sha256').update(value).digest('hex');
const served = source => `fixture translation: ${source}`;

// The stale batch membership is evidence, not a guess: production accepted
// ten targets under session A, so the stale A2 batch holds the remaining two.
const staleTargetIds = ['target-10', 'target-11'];

describe('Firefox Phase 2C stale-reply evidence', () => {
  it('accepts the plain oracle convention and the consistent U+200E-prefixed convention', () => {
    const plain = classifyStaleReplyHash({
      targetIds: staleTargetIds, targetTexts,
      replyItemCount: staleTargetIds.length,
      replyHash: hash(JSON.stringify(staleTargetIds.map(id => served(targetTexts[Number(id.slice(7))])))),
    });
    expect(plain).toMatchObject({ ok: true, markerStyle: 0 });
    const marked = classifyStaleReplyHash({
      targetIds: staleTargetIds, targetTexts,
      replyItemCount: staleTargetIds.length,
      replyHash: hash(JSON.stringify(staleTargetIds.map(id => `\u200e${served(targetTexts[Number(id.slice(7))])}`))),
    });
    expect(marked).toMatchObject({ ok: true, markerStyle: 1 });
    // Case-insensitive hex is still the same hash.
    expect(classifyStaleReplyHash({
      targetIds: staleTargetIds, targetTexts, replyItemCount: staleTargetIds.length,
      replyHash: plain.replyHash?.toUpperCase?.() ?? hash(JSON.stringify(staleTargetIds.map(id => served(targetTexts[Number(id.slice(7))])))).toUpperCase(),
    })).toMatchObject({ ok: true });
  });

  it('rejects a wrong hash, wrong item count, wrong membership and malformed evidence', () => {
    const wrongText = classifyStaleReplyHash({
      targetIds: staleTargetIds, targetTexts, replyItemCount: staleTargetIds.length,
      replyHash: hash(JSON.stringify(staleTargetIds.map(id => `fixture translation: not-the-oracle`))),
    });
    expect(wrongText).toMatchObject({ ok: false, reason: 'reply-hash' });
    // A B-source translation is never a valid stale A reply.
    const bSource = classifyStaleReplyHash({
      targetIds: staleTargetIds, targetTexts: targetTexts.map((source, index) => `Replacement benchmark sentence ${index + 1} has stable fixture content.`),
      replyItemCount: staleTargetIds.length,
      replyHash: hash(JSON.stringify(staleTargetIds.map(id => served(targetTexts[Number(id.slice(7))])))),
    });
    expect(bSource).toMatchObject({ ok: false });
    expect(classifyStaleReplyHash({ targetIds: staleTargetIds, targetTexts, replyItemCount: 3, replyHash: hash('x') })).toMatchObject({ ok: false, reason: 'shape' });
    expect(classifyStaleReplyHash({ targetIds: [], targetTexts, replyItemCount: 0, replyHash: hash('x') })).toMatchObject({ ok: false, reason: 'shape' });
    expect(classifyStaleReplyHash({ targetIds: staleTargetIds, targetTexts: targetTexts.slice(11), replyItemCount: 2, replyHash: hash('x') })).toMatchObject({ ok: false, reason: 'shape' });
    expect(classifyStaleReplyHash({ targetIds: ['target-1', 'target-1'], targetTexts, replyItemCount: 2, replyHash: hash('x') })).toMatchObject({ ok: false, reason: 'shape' });
    expect(classifyStaleReplyHash({ targetIds: staleTargetIds, targetTexts, replyItemCount: staleTargetIds.length, replyHash: 'not-a-hash' })).toMatchObject({ ok: false, reason: 'shape' });
    expect(classifyStaleReplyHash({ targetIds: staleTargetIds, targetTexts, replyItemCount: staleTargetIds.length })).toMatchObject({ ok: false, reason: 'shape' });
  });
});

describe('Firefox Phase 2C proxy classification', () => {
  const request = (indexes, status) => ({ requestId: `edge-request-${indexes[0]}`, method: 'POST', host: 'edge.microsoft.com', sni: 'edge.microsoft.com',
    bodyHash: hash(`body-${indexes[0]}`), sourceIndexes: indexes, status });
  const windows = [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16, 17]];

  it('requires all three stale-mode requests to be released successes', () => {
    const requests = [request(windows[0], 'released'), request(windows[1], 'released'), request(windows[2], 'released')];
    expect(classifyReplacementProxyRequests({ requests, expectedWindows: windows, expectedStatuses: ['released', 'released', 'released'] })).toMatchObject({ ok: true });
    // An aborted request is NOT stale success and must fail the classification.
    expect(classifyReplacementProxyRequests({ requests: [requests[0], request(windows[1], 'aborted'), requests[2]], expectedWindows: windows, expectedStatuses: ['released', 'released', 'released'] }))
      .toMatchObject({ ok: false });
    expect(classifyReplacementProxyRequests({ requests: [requests[0], request(windows[1], 'held'), requests[2]], expectedWindows: windows, expectedStatuses: ['released', 'released', 'released'] }))
      .toMatchObject({ ok: false });
  });

  it('fails the stale mode on a retry (a fourth request) or missing statuses', () => {
    const requests = [request(windows[0], 'released'), request(windows[1], 'released'), request(windows[2], 'released')];
    expect(classifyReplacementProxyRequests({ requests: [...requests, request(windows[1], 'released')], expectedWindows: windows, expectedStatuses: ['released', 'released', 'released'] }))
      .toMatchObject({ ok: false, reason: 'shape' });
    expect(classifyReplacementProxyRequests({ requests, expectedWindows: windows, expectedStatuses: ['released', 'released'] }))
      .toMatchObject({ ok: false, reason: 'statuses' });
    expect(classifyReplacementProxyRequests({ requests, expectedWindows: windows, expectedStatuses: 'all-released' }))
      .toMatchObject({ ok: false, reason: 'statuses' });
    expect(classifyReplacementProxyRequests({ requests: requests.slice(0, 2), expectedWindows: windows, expectedStatuses: ['released', 'released', 'released'] }))
      .toMatchObject({ ok: false, reason: 'shape' });
    expect(classifyReplacementProxyRequests({ requests, expectedWindows: null, expectedStatuses: ['released', 'released', 'released'] }))
      .toMatchObject({ ok: false, reason: 'windows' });
  });

  it('keeps the Phase 2B default of released / aborted / released', () => {
    const phase2b = [request(windows[0], 'released'), request(windows[1], 'aborted'), request(windows[2], 'released')];
    expect(classifyReplacementProxyRequests({ requests: phase2b, expectedWindows: windows })).toMatchObject({ ok: true });
    expect(classifyReplacementProxyRequests({ requests: [phase2b[0], request(windows[1], 'released'), phase2b[2]], expectedWindows: windows }))
      .toMatchObject({ ok: false });
  });
});

describe('Firefox Phase 2C mode flags and required capabilities', () => {
  it('is mutually exclusive with the other modes and requires the loopback proxy', () => {
    expect(assertFirefoxProbeModeFlags({ loopbackTlsProxy: true, pageTranslationStaleSuccessE2E: true })).toBe(true);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: true, pageTranslationStaleSuccessE2E: true, pageTranslationE2E: true })).toThrow(/exactly one/);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: true, pageTranslationStaleSuccessE2E: true, pageTranslationStopE2E: true })).toThrow(/exactly one/);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: true, pageTranslationStaleSuccessE2E: true, pageTranslationReplacementE2E: true })).toThrow(/exactly one/);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: false, pageTranslationStaleSuccessE2E: true })).toThrow(/STALE_SUCCESS requires FIREFOX_E2E_LOOPBACK_TLS_PROXY/);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: true, pageTranslationStaleSuccessE2E: 'yes' })).toThrow(/booleans/);
  });

  it('keeps the existing Phase 1/2A/2B flag rules intact', () => {
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: true, phase1E2E: true, pageTranslationStopE2E: true })).toThrow(/Phase 1 page E2E or Phase 2A/);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: true, pageTranslationE2E: true, pageTranslationReplacementE2E: true })).toThrow(/exactly one/);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: false, pageTranslationReplacementE2E: true })).toThrow(/REPLACEMENT requires/);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: false, pageTranslationE2E: true })).toThrow(/PAGE_TRANSLATION requires/);
  });

  it('requires the three stale-proof capabilities and drops the abort capability', () => {
    for (const name of ['staleSuccessfulReply', 'staleReplyHeld', 'staleSchedulerRejection']) {
      expect(staleSuccessRequiredCapabilities).toContain(name);
    }
    expect(staleSuccessRequiredCapabilities).not.toContain('heldRequestAbort');
    expect(staleSuccessRequiredCapabilities).toContain('replacementSessionOwnership');
    expect(staleSuccessRequiredCapabilities).toContain('replacementDomOwnership');
    expect(staleSuccessRequiredCapabilities).toContain('cleanup');
    for (const name of ['isolation', 'fixture', 'bidiSession', 'runtimeBridge', 'loopbackTlsProxy', 'schedulerBatchCorrelation']) {
      expect(staleSuccessRequiredCapabilities).toContain(name);
    }
    // Phase 2B stays intact and keeps its abort gate.
    expect(replacementRequiredCapabilities).toContain('heldRequestAbort');
    expect(replacementRequiredCapabilities).not.toContain('staleSuccessfulReply');
    expect(STALE_SUCCESS_HOLD_WINDOW_MS).toBe(6000);
  });

  it('maps stale A targets to the A source manifest window', () => {
    expect(replacementSourceIndexes(staleTargetIds, 'A')).toEqual([10, 11]);
    expect(replacementSourceIndexes(['target-0'], 'B')).toEqual([12]);
  });
});
