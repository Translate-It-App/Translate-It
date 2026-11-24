import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRuntime = vi.hoisted(() => ({
  providerLevels: new Map()
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getBrowserInfo: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
    storage: { local: { get: vi.fn(), set: vi.fn() } }
  }
}));

vi.mock('@/shared/error-management/ErrorMatcher.js');

vi.mock('@/shared/config/config.js', () => ({
  getProviderOptimizationLevelAsync: vi.fn(async (providerName) => {
    return mockRuntime.providerLevels.get(providerName) ?? 1;
  }),
}));

vi.mock('@/features/translation/core/ProviderConfigurations.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PROVIDER_CONFIGURATIONS: {
      IntegrationProvider: {
        rateLimit: { maxConcurrent: 1, delayBetweenRequests: 0 }
      }
    },
    getProviderConfiguration: vi.fn((providerName, level) => providerName === 'IntegrationProvider'
      ? { rateLimit: { maxConcurrent: 1, delayBetweenRequests: 0 } }
      : actual.getProviderConfiguration(providerName, level))
  };
});

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

import { RateLimitManager } from './RateLimitManager.js';
import { getProviderConfiguration } from '@/features/translation/core/ProviderConfigurations.js';
import { isFatalError } from '@/shared/error-management/ErrorMatcher.js';
import { isLocalDeterministicValidationError } from '@/shared/error-management/ValidationPolicy.js';

describe('RateLimitManager real-policy integration', () => {
  let manager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRuntime.providerLevels.clear();
    mockRuntime.providerLevels.set('IntegrationProvider', 1);

    isFatalError.mockImplementation((err) => err.message === 'FATAL');

    RateLimitManager.instance = null;
    manager = new RateLimitManager();
    manager._initializeProvider('IntegrationProvider', { maxConcurrent: 1, delayBetweenRequests: 0 });
  });

  it('real ValidationPolicy rejects TEXT_TOO_LONG without health penalty', async () => {
    const state = manager.providerStates.get('IntegrationProvider');
    const textTooLongError = Object.assign(new Error('text is too long'), { type: 'TEXT_TOO_LONG' });

    await expect(
      manager.executeWithRateLimit('IntegrationProvider', () => Promise.reject(textTooLongError))
    ).rejects.toBe(textTooLongError);

    expect(isLocalDeterministicValidationError).toBeInstanceOf(Function);
    expect(isLocalDeterministicValidationError(textTooLongError)).toBe(true);
    expect(state.performanceStats.failedRequests).toBe(0);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.isCircuitOpen).toBe(false);
    expect(state.activeRequests).toBe(0);
  });

  it('real ValidationPolicy allows NETWORK_ERROR health accounting', async () => {
    const state = manager.providerStates.get('IntegrationProvider');
    const networkError = Object.assign(new Error('failed to fetch'), { type: 'NETWORK_ERROR' });

    try {
      await manager.executeWithRateLimit('IntegrationProvider', () => Promise.reject(networkError));
    } catch { /* ignore */ }

    expect(isLocalDeterministicValidationError(networkError)).toBe(false);
    expect(state.performanceStats.failedRequests).toBe(1);
    expect(state.consecutiveFailures).toBe(1);
  });

  it('real ValidationPolicy: repeated TEXT_TOO_LONG never opens circuit', async () => {
    const state = manager.providerStates.get('IntegrationProvider');
    const textTooLongError = Object.assign(new Error('text is too long'), { type: 'TEXT_TOO_LONG' });

    for (let i = 0; i < 10; i++) {
      try {
        await manager.executeWithRateLimit('IntegrationProvider', () => Promise.reject(textTooLongError));
      } catch { /* ignore */ }
    }

    expect(state.isCircuitOpen).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.performanceStats.failedRequests).toBe(0);
  });

  it('shares DeepSeek Level 3 physical concurrency across Page and Subtitle calls', async () => {
    mockRuntime.providerLevels.set('DeepSeek', 3);
    manager.providerStates.delete('DeepSeek');
    const state = manager._initializeProvider('DeepSeek', getProviderConfiguration('DeepSeek', 3).rateLimit, {
      isManualConfig: false,
      optimizationLevel: 3,
      configSource: 'fresh-load',
    });
    expect(state.config.maxConcurrent).toBe(3);

    let active = 0;
    let peak = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [
      manager.executeWithRateLimit('DeepSeek', async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
      }, 'Page Translation', undefined, { mode: 'page' }),
      manager.executeWithRateLimit('DeepSeek', async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
      }, 'Subtitle Translation', undefined, { mode: 'subtitle' }),
      manager.executeWithRateLimit('DeepSeek', async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
      }, 'Page Translation', undefined, { mode: 'page' }),
      manager.executeWithRateLimit('DeepSeek', async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
      }, 'Subtitle Translation', undefined, { mode: 'subtitle' }),
    ];

    await vi.waitFor(() => expect(peak).toBe(3));
    expect(state.activeRequests).toBe(3);
    release();
    await Promise.all(calls);

    expect(peak).toBe(3);
    expect(state.activeRequests).toBe(0);
  });
});
