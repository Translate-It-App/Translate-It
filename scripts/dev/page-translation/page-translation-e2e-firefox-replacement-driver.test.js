import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { assertFirefoxProbeModeFlags, replacementRequiredCapabilities } from './e2e-firefox/capabilities.mjs';
import { classifyReplacementFinalDom, classifyReplacementProxyRequests, replacementSourceIndexes } from './e2e-firefox/driver.mjs';
import { validateEdgeProxyRequest } from './e2e-firefox/loopback-edge-proxy.mjs';

const targetTexts = Array.from({ length: 12 }, (_, index) => `Benchmark sentence ${index + 1} has stable fixture content.`);
const sourcesB = targetTexts.map((source, index) => `Replacement benchmark sentence ${index + 1} has stable fixture content.`);
const hash = value => createHash('sha256').update(value).digest('hex');
const served = source => `fixture translation: ${source}`;

// The production batching observed in the real run accepted ten targets under
// session A and left two pending, so the partition is evidence, not a guess.
const retainedTargetIds = Array.from({ length: 10 }, (_, index) => `target-${index}`);
const acceptedTargetIds = ['target-10', 'target-11'];

function finalDom({ marker = false, owner = 'B', state = null, targets = null } = {}) {
  const prefix = marker ? '\u200e' : '';
  return {
    sessionId: 'session-B',
    postInvalidationAWrites: [],
    targets: targets ?? Array.from({ length: 12 }, (_, index) => ({
      targetId: `target-${index}`,
      owner,
      state: state ?? (retainedTargetIds.includes(`target-${index}`) ? 'retained' : 'accepted'),
      hash: hash(`${prefix}${served(retainedTargetIds.includes(`target-${index}`) ? targetTexts[index] : sourcesB[index])}`),
    })),
  };
}

const partition = { retainedTargetIds, acceptedTargetIds };

describe('Firefox Phase 2B driver helpers', () => {
  it('rejects mutually exclusive probe modes and requires the loopback proxy', () => {
    expect(assertFirefoxProbeModeFlags({ loopbackTlsProxy: true, pageTranslationReplacementE2E: true })).toBe(true);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: true, pageTranslationE2E: true, pageTranslationReplacementE2E: true })).toThrow(/exactly one/);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: true, pageTranslationStopE2E: true, pageTranslationReplacementE2E: true })).toThrow(/exactly one/);
    expect(() => assertFirefoxProbeModeFlags({ loopbackTlsProxy: false, pageTranslationReplacementE2E: true })).toThrow(/LOOPBACK_TLS_PROXY/);
    expect(replacementRequiredCapabilities).toContain('replacementSessionOwnership');
    expect(replacementRequiredCapabilities).toContain('replacementDomOwnership');
    expect(replacementRequiredCapabilities).not.toContain('staleDeliveryCheck');
  });

  it('accepts a consistent final DOM and rejects mixed marker conventions, wrong ownership and wrong hashes', () => {
    const plain = classifyReplacementFinalDom({ finalDOM: finalDom(), targetTexts, sourcesB, ...partition });
    expect(plain).toMatchObject({ ok: true, mismatches: [] });
    const marked = classifyReplacementFinalDom({ finalDOM: finalDom({ marker: true }), targetTexts, sourcesB, ...partition });
    expect(marked).toMatchObject({ ok: true, mismatches: [] });
    expect(marked.markerStyle).not.toBe(plain.markerStyle);

    const mixed = finalDom();
    mixed.targets[9] = { ...mixed.targets[9], hash: hash(`\u200e${served(targetTexts[9])}`) };
    expect(classifyReplacementFinalDom({ finalDOM: mixed, targetTexts, sourcesB, ...partition })).toMatchObject({ ok: false });
    expect(classifyReplacementFinalDom({ finalDOM: finalDom({ owner: 'A' }), targetTexts, sourcesB, ...partition })).toMatchObject({ ok: false });
    expect(classifyReplacementFinalDom({ finalDOM: finalDom({ state: 'accepted' }), targetTexts, sourcesB, ...partition })).toMatchObject({ ok: false });

    const wrongHash = finalDom();
    wrongHash.targets[3].hash = hash('something else');
    expect(classifyReplacementFinalDom({ finalDOM: wrongHash, targetTexts, sourcesB, ...partition })).toMatchObject({ ok: false });
    expect(classifyReplacementFinalDom({ finalDOM: finalDom({ targets: [] }), targetTexts, sourcesB, ...partition })).toMatchObject({ ok: false });
  });

  it('derives the retained and accepted partition from the observed evidence', () => {
    // Without evidence every target is unclassified, so nothing passes.
    expect(classifyReplacementFinalDom({ finalDOM: finalDom(), targetTexts, sourcesB })).toMatchObject({ ok: false });
    // A target outside both sets is never accepted as owned by B.
    const partial = classifyReplacementFinalDom({ finalDOM: finalDom(), targetTexts, sourcesB, retainedTargetIds, acceptedTargetIds: [] });
    expect(partial).toMatchObject({ ok: false });
    expect(partial.mismatches).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: 'target-10', reason: 'unclassified' })]));
  });

  it('requires exactly three correlated provider requests with released, aborted and released statuses', () => {
    const request = (indexes, status) => ({ requestId: `edge-request-${indexes[0]}`, method: 'POST', host: 'edge.microsoft.com', sni: 'edge.microsoft.com',
      bodyHash: hash(`body-${indexes[0]}`), sourceIndexes: indexes, status });
    const windows = [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16, 17]];
    const requests = [request(windows[0], 'released'), request(windows[1], 'aborted'), request(windows[2], 'released')];
    expect(classifyReplacementProxyRequests({ requests, expectedWindows: windows })).toMatchObject({ ok: true });
    expect(classifyReplacementProxyRequests({ requests: requests.slice(0, 2), expectedWindows: windows })).toMatchObject({ ok: false });
    expect(classifyReplacementProxyRequests({ requests: [requests[0], requests[2], requests[1]], expectedWindows: windows })).toMatchObject({ ok: false });
    expect(classifyReplacementProxyRequests({ requests: [requests[0], { ...requests[1], status: 'released' }, requests[2]], expectedWindows: windows })).toMatchObject({ ok: false });
    expect(classifyReplacementProxyRequests({ requests: [requests[0], { ...requests[1], sourceIndexes: [6, 7] }, requests[2]], expectedWindows: windows })).toMatchObject({ ok: false });
    // Without observed windows there is nothing to correlate against.
    expect(classifyReplacementProxyRequests({ requests })).toMatchObject({ ok: false });
  });

  it('maps observed Scheduler target membership to the source manifest windows', () => {
    expect(replacementSourceIndexes(['target-0', 'target-5'], 'A')).toEqual([0, 5]);
    expect(replacementSourceIndexes(['target-10', 'target-11'], 'B')).toEqual([22, 23]);
    expect(replacementSourceIndexes([], 'A')).toBe(null);
  });

  it('admits the 24-source replacement oracle while keeping Phase 1/2A strictness', () => {
    const oracle = [...targetTexts, ...sourcesB];
    expect(oracle).toHaveLength(24);
    expect(new Set(oracle).size).toBe(24);
    const body = Buffer.from(JSON.stringify(oracle.slice(12)), 'utf8');
    const accepted = validateEdgeProxyRequest({ method: 'POST', url: '/translate/translatetext?to=fr&isEnterpriseClient=false',
      headers: { host: 'edge.microsoft.com', 'content-type': 'application/json' }, body, fixtureTexts: oracle });
    expect(accepted).toMatchObject({ ok: true, sourceIndexes: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] });

    const unknown = Buffer.from(JSON.stringify(['not a fixture source']), 'utf8');
    expect(validateEdgeProxyRequest({ method: 'POST', url: '/translate/translatetext?to=fr&isEnterpriseClient=false',
      headers: { host: 'edge.microsoft.com', 'content-type': 'application/json' }, body: unknown, fixtureTexts: oracle }))
      .toMatchObject({ ok: false, reason: 'body-mismatch' });

    const descending = Buffer.from(JSON.stringify([oracle[5], oracle[1]]), 'utf8');
    expect(validateEdgeProxyRequest({ method: 'POST', url: '/translate/translatetext?to=fr&isEnterpriseClient=false',
      headers: { host: 'edge.microsoft.com', 'content-type': 'application/json' }, body: descending, fixtureTexts: oracle }))
      .toMatchObject({ ok: true });
    expect(validateEdgeProxyRequest({ method: 'POST', url: '/translate/translatetext?to=fr&isEnterpriseClient=false',
      headers: { host: 'edge.microsoft.com', 'content-type': 'application/json' }, body: descending, fixtureTexts: targetTexts }))
      .toMatchObject({ ok: false, reason: 'body-mismatch' });
  });
});
