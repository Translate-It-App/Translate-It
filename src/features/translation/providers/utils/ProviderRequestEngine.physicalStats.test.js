import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestLogger = vi.hoisted(() => ({
  debug: vi.fn(), debugLazy: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('@/shared/logging/logger.js', () => ({ getScopedLogger: () => requestLogger }));
vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: { getCached: vi.fn(), get: vi.fn(), set: vi.fn() },
}));
vi.mock('@/shared/config/config.js', async (importOriginal) => ({
  ...await importOriginal(), getProviderOptimizationLevelAsync: vi.fn().mockResolvedValue(5),
}));
vi.mock('@/utils/browser/compatibility.js', () => ({
  getBrowserInfoSync: () => ({ isFirefox: false, isMobile: false }),
}));
vi.mock('@/shared/proxy/ProxyManager.js', () => ({ proxyManager: { fetch: vi.fn() } }));
vi.mock('../ApiKeyManager.js', () => ({
  ApiKeyManager: { getKeys: vi.fn(), promoteKey: vi.fn(), shouldFailover: vi.fn() },
}));

// Real request engine, shared cooldown/capacity and stats; only transport/config are mocked.
import { ProviderRequestEngine } from './ProviderRequestEngine.js';
import { ApiKeyManager } from '../ApiKeyManager.js';
import { TranslationCallPurpose } from '../ProviderConstants.js';
import { rateLimitManager } from '../../core/RateLimitManager.js';
import { statsManager } from '../../core/TranslationStatsManager.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';

const provider = {
  providerName: 'PhysicalStatsProvider', providerSettingKey: 'test-keys',
  constructor: { isAI: true },
  _initializeProxy: vi.fn().mockResolvedValue({ enabled: false }),
};
const params = controller => ({
  url: 'https://example.test/translate', fetchOptions: { headers: {} },
  abortController: controller, sessionId: 'physical-stats-session',
  charCount: 10, originalCharCount: 5, updateApiKey: vi.fn(),
});
const response = status => ({
  ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Too Many Requests',
  headers: new Map([['content-type', 'application/json'], ['Retry-After', '5']]),
  clone() { return this; }, json: async () => ({ translated: 'translated' }),
});
const requestStarts = () => requestLogger.debugLazy.mock.calls
  .map(([factory]) => factory()).filter(([message]) => message.includes(' Request: '));

describe('ProviderRequestEngine physical request accounting', () => {
  let state;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.clearAllMocks();
    statsManager.reset();
    rateLimitManager.providerStates.delete(provider.providerName);
    state = rateLimitManager._initializeProvider(provider.providerName, { maxConcurrent: 1 });
    ApiKeyManager.getKeys.mockResolvedValue(['fixture-first', 'fixture-second']);
    ApiKeyManager.shouldFailover.mockReturnValue(true);
    proxyManager.fetch.mockReset().mockResolvedValue(response(200));
  });
  afterEach(() => {
    rateLimitManager.clearQueue(provider.providerName);
    rateLimitManager.providerStates.delete(provider.providerName);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not count or log an unsent failover cancelled during shared Retry-After', async () => {
    const controller = new AbortController();
    proxyManager.fetch.mockResolvedValueOnce(response(429));
    const result = rateLimitManager.executeWithRateLimit(provider.providerName,
      () => ProviderRequestEngine.executeRequest(provider, params(controller)), '', undefined,
      { signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.activeRequests).toBe(1);
    expect(proxyManager.fetch).toHaveBeenCalledTimes(1);
    expect(state.retryAt).toBe(Date.now() + 5000);
    controller.abort('document-replaced');
    expect(await result).toMatchObject({ operationAborted: true, cancellationReason: 'document-replaced' });
    expect(state.activeRequests).toBe(0);
    expect(statsManager.global).toMatchObject({ totalCalls: 1, totalChars: 10, totalOriginalChars: 5, totalErrors: 1 });
    expect(statsManager.getSessionSummary('physical-stats-session')).toMatchObject({ calls: 1, chars: 10, originalChars: 5, errors: 1 });
    expect(requestStarts()).toHaveLength(1);
    expect(ApiKeyManager.promoteKey).not.toHaveBeenCalled();
  });

  it('does not count or log a first attempt cancelled in cooldown', async () => {
    state.retryAt = Date.now() + 5000;
    const controller = new AbortController();
    const result = ProviderRequestEngine.executeRequest(provider, params(controller)).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort('user-cancelled');
    expect(await result).toMatchObject({ type: 'USER_CANCELLED' });
    expect(proxyManager.fetch).not.toHaveBeenCalled();
    expect(statsManager.global).toMatchObject({ totalCalls: 0, totalChars: 0, totalOriginalChars: 0, totalErrors: 0 });
    expect(statsManager.getSessionSummary('physical-stats-session')).toBeNull();
    expect(requestStarts()).toHaveLength(0);
  });

  it.each([true, false])('checks cancellation after async preparation for AI=%s', async isAI => {
    const controller = new AbortController();
    provider._initializeProxy.mockImplementationOnce(async () => {
      controller.abort('document-replaced');
      return { enabled: false };
    });
    const callProvider = { ...provider, constructor: { isAI } };
    await expect(ProviderRequestEngine.executeApiCall(callProvider, params(controller)))
      .rejects.toMatchObject({ operationAborted: true, cancellationReason: 'document-replaced' });
    expect(proxyManager.fetch).not.toHaveBeenCalled();
    expect(statsManager.global.totalCalls).toBe(0);
    expect(requestStarts()).toHaveLength(0);
  });

  it('checks cancellation between cooldown resolution and physical fetch', async () => {
    const controller = new AbortController();
    const waitForCooldown = rateLimitManager.waitForCooldown.bind(rateLimitManager);
    vi.spyOn(rateLimitManager, 'waitForCooldown').mockImplementationOnce(async (...args) => {
      await waitForCooldown(...args);
      controller.abort('document-replaced');
    });
    await expect(ProviderRequestEngine.executeApiCall(provider, params(controller)))
      .rejects.toMatchObject({ operationAborted: true, cancellationReason: 'document-replaced' });
    expect(proxyManager.fetch).not.toHaveBeenCalled();
    expect(statsManager.global.totalCalls).toBe(0);
    expect(requestStarts()).toHaveLength(0);
  });

  it('counts each sent failover once, excluding cooldown from physical duration', async () => {
    proxyManager.fetch.mockResolvedValueOnce(response(429)).mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return response(200);
    });
    const result = ProviderRequestEngine.executeRequest(provider, params(new AbortController()));
    await vi.advanceTimersByTimeAsync(0);
    expect(proxyManager.fetch).toHaveBeenCalledTimes(1);
    expect(statsManager.global.totalCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(proxyManager.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toEqual({ translated: 'translated' });
    expect(statsManager.global).toMatchObject({ totalCalls: 2, totalChars: 20, totalOriginalChars: 10, totalErrors: 1 });
    expect(statsManager.global.callsByPurpose[TranslationCallPurpose.PRIMARY_TRANSLATION]).toBe(2);
    expect(requestStarts()).toHaveLength(2);
    const responseLogs = requestLogger.debugLazy.mock.calls.map(([factory]) => factory())
      .filter(([message]) => message.includes(' Response: '));
    expect(responseLogs.map(([, data]) => data.duration)).toEqual([0, 25]);
    expect(ApiKeyManager.promoteKey).toHaveBeenCalledTimes(1);
  });

  it('retains intentional mock protocol accounting without sending HTTP', async () => {
    await ProviderRequestEngine.executeApiCall(provider, { ...params(), url: 'mock://translation' });
    expect(proxyManager.fetch).not.toHaveBeenCalled();
    expect(statsManager.global).toMatchObject({ totalCalls: 1, totalChars: 10, totalOriginalChars: 5 });
  });
});
