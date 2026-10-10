import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRuntime = vi.hoisted(() => ({
  providerLevels: new Map()
}));

// Mock extension polyfill before anything else
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getBrowserInfo: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
    storage: { local: { get: vi.fn(), set: vi.fn() } }
  }
}));

// Mock ErrorMatcher
vi.mock('@/shared/error-management/ErrorMatcher.js');

// Mock ValidationPolicy
vi.mock('@/shared/error-management/ValidationPolicy.js', () => ({
  isLocalDeterministicValidationError: vi.fn(() => false)
}));

import { RateLimitManager, TranslationPriority } from './RateLimitManager.js';
import {
  isConfigError,
  isFatalError,
  isProviderRequestSizeError,
  isDeterministicClientHttpError,
} from '@/shared/error-management/ErrorMatcher.js';
import { isLocalDeterministicValidationError } from '@/shared/error-management/ValidationPolicy.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';

// Mock dependencies
vi.mock('@/shared/config/config.js', () => ({
  getProviderOptimizationLevelAsync: vi.fn(async (providerName) => {
    return mockRuntime.providerLevels.get(providerName) ?? 1;
  }),
}));

vi.mock('@/features/translation/core/ProviderConfigurations.js', () => ({
  PROVIDER_CONFIGURATIONS: {
    TestProvider: {
      rateLimit: { maxConcurrent: 1, delayBetweenRequests: 0 }
    },
    WebAI: {
      rateLimit: {
        maxConcurrent: 2,
        delayBetweenRequests: 0,
        modeOverrides: {
          select_element: {
            maxConcurrent: 2,
          }
        }
      }
    }
  },
  getProviderConfiguration: vi.fn((providerName, level) => {
    const numericLevel = Number(level) || 1;
    const maxConcurrent = providerName === 'WebAI'
      ? (numericLevel >= 5 ? 4 : numericLevel >= 4 ? 3 : 2)
      : (numericLevel >= 5 ? 4 : numericLevel >= 4 ? 3 : 1);

    return {
      rateLimit: {
        maxConcurrent,
        delayBetweenRequests: 0,
        modeOverrides: {
          select_element: {
            maxConcurrent: 8,
          },
        },
      },
      ...(providerName === 'BingTranslate' && {
        errorHandling: { circuitBreakThreshold: 3 },
      }),
    };
  })
}));

// Mock logger
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

describe('RateLimitManager', () => {
  let manager;
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRuntime.providerLevels.clear();
    mockRuntime.providerLevels.set('TestProvider', 1);
    mockRuntime.providerLevels.set('ConcurrentProvider', 1);
    mockRuntime.providerLevels.set('WebAI', 3);

    // Default mock behavior for ErrorMatcher
    isFatalError.mockImplementation((err) => err.message === 'FATAL');
    isConfigError.mockReturnValue(false);
    isProviderRequestSizeError.mockImplementation((error) => {
      const statusCode = Number(error?.statusCode);
      const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
      return error?.type === ErrorTypes.HTTP_ERROR
        && (statusCode === 413
          || ((statusCode === 400 || statusCode === 422)
            && /\btoo\s+long\b|\bmaximum\s+length\b|\bcontext\s+length\b/.test(message)));
    });
    isDeterministicClientHttpError.mockImplementation((error) => {
      return error?.type === ErrorTypes.HTTP_ERROR
        && [400, 404, 422].includes(Number(error?.statusCode));
    });

    // Reset singleton instance for clean tests
    RateLimitManager.instance = null;
    manager = new RateLimitManager();

    // Pre-initialize provider state
    manager._initializeProvider('TestProvider', { maxConcurrent: 1, delayBetweenRequests: 0 });
  });

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  describe('shared capacity and cooldown', () => {
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

    it('keeps a cancelled live task in its slot until the transport settles, and removes queued listeners', async () => {
      const live = deferred();
      const controller = new AbortController();
      const first = manager.executeWithRateLimit('TestProvider', () => live.promise, '', TranslationPriority.LOW, { abortController: controller });
      await settle();
      controller.abort('user-cancelled');
      const queuedController = new AbortController();
      const removeListener = vi.spyOn(queuedController.signal, 'removeEventListener');
      const cancelledTask = vi.fn();
      const cancelled = manager.executeWithRateLimit('TestProvider', cancelledTask, '', TranslationPriority.LOW, { abortController: queuedController });
      await settle();
      queuedController.abort('user-cancelled');
      await expect(cancelled).rejects.toMatchObject({ type: ErrorTypes.USER_CANCELLED });
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      const nextTask = vi.fn(() => 'next');
      const next = manager.executeWithRateLimit('TestProvider', nextTask);
      await settle();
      expect(manager.getPerformanceStats('TestProvider')).toMatchObject({ active: 1, totalPending: 1 });
      expect(nextTask).not.toHaveBeenCalled();
      live.resolve('late');
      await first;
      await expect(next).resolves.toBe('next');
      expect(cancelledTask).not.toHaveBeenCalled();
      expect(manager.getPerformanceStats('TestProvider').active).toBe(0);
    });

    it('clears pending work without resetting live accounting', async () => {
      const live = deferred();
      const first = manager.executeWithRateLimit('TestProvider', () => live.promise);
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const pending = manager.executeWithRateLimit('TestProvider', () => 'cleared', '', TranslationPriority.NORMAL, { abortController: controller });
      await settle();
      manager.clearQueue('TestProvider');
      await expect(pending).rejects.toThrow('Queue cleared');
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      const nextTask = vi.fn(() => 'next');
      const next = manager.executeWithRateLimit('TestProvider', nextTask);
      await settle();
      expect(manager.getPerformanceStats('TestProvider').active).toBe(1);
      expect(nextTask).not.toHaveBeenCalled();
      live.resolve();
      await first;
      await expect(next).resolves.toBe('next');
      expect(manager.getPerformanceStats('TestProvider').active).toBe(0);
    });

    it('retains state when reload lowers capacity below the live count', async () => {
      await manager.reloadConfigurations();
      mockRuntime.providerLevels.set('WebAI', 5);
      await manager.reloadConfigurations();
      const state = manager.providerStates.get('WebAI');
      const live = Array.from({ length: 4 }, () => deferred());
      const requests = live.map(item => manager.executeWithRateLimit('WebAI', () => item.promise));
      await settle();
      expect(state.activeRequests).toBe(4);
      mockRuntime.providerLevels.set('WebAI', 3);
      await manager.reloadConfigurations();
      expect(manager.providerStates.get('WebAI')).toBe(state);
      expect(state.config.maxConcurrent).toBe(2);
      const nextTask = vi.fn(() => 'next');
      const next = manager.executeWithRateLimit('WebAI', nextTask);
      await settle();
      live[0].resolve(); live[1].resolve();
      await Promise.all(requests.slice(0, 2));
      expect(nextTask).not.toHaveBeenCalled();
      live[2].resolve();
      await requests[2];
      await expect(next).resolves.toBe('next');
      live[3].resolve(); await requests[3];
      expect(state.activeRequests).toBe(0);
    });

    it('shares Retry-After with siblings and retries even when an in-flight sibling succeeds', async () => {
      vi.useFakeTimers();
      try {
        const state = manager._initializeProvider('Shared429', { maxConcurrent: 2, delayBetweenRequests: 0 });
        const live = deferred();
        const rateLimitError = Object.assign(new Error('429'), { type: ErrorTypes.RATE_LIMIT_REACHED, statusCode: 429, retryAt: Date.now() + 10000 });
        const failed = manager.executeWithRateLimit('Shared429', () => Promise.reject(rateLimitError));
        const sibling = manager.executeWithRateLimit('Shared429', () => live.promise);
        await expect(failed).rejects.toBe(rateLimitError);
        const tasks = [vi.fn(() => 'queued sibling'), vi.fn(() => 'retry')];
        const queued = tasks.map(task => manager.executeWithRateLimit('Shared429', task));
        live.resolve('success'); await sibling;
        expect(state.currentBackoffMultiplier).toBe(1);
        await vi.advanceTimersByTimeAsync(9999);
        tasks.forEach(task => expect(task).not.toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(1);
        await expect(Promise.all(queued)).resolves.toEqual(['queued sibling', 'retry']);
        expect(state.activeRequests).toBe(0);
      } finally { vi.useRealTimers(); }
    });

    it('uses bounded client backoff for zero-delay providers without Retry-After', async () => {
      vi.useFakeTimers();
      try {
        const state = manager._initializeProvider('Custom', {
          maxConcurrent: 1, delayBetweenRequests: 0,
          adaptiveBackoff: { enabled: true, baseMultiplier: 2, maxDelay: 3000 },
        });
        const error = Object.assign(new Error('429'), { type: ErrorTypes.RATE_LIMIT_REACHED });
        await expect(manager.executeWithRateLimit('Custom', () => Promise.reject(error))).rejects.toBe(error);
        expect(state.retryAt - Date.now()).toBe(3000);
        const task = vi.fn(() => 'next');
        const next = manager.executeWithRateLimit('Custom', task);
        await vi.advanceTimersByTimeAsync(2999);
        expect(task).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(next).resolves.toBe('next');
      } finally { vi.useRealTimers(); }
    });

    it('does not overflow long shared deadlines and releases cancellation listeners', async () => {
      vi.useFakeTimers();
      try {
        const state = manager._initializeProvider('Long429', { maxConcurrent: 1, delayBetweenRequests: 0 });
        manager.notifyRateLimit('Long429', { type: ErrorTypes.RATE_LIMIT_REACHED, retryAt: Date.now() + 2_147_483_648 });
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
        const wait = manager.waitForCooldown('Long429', controller.signal);
        const task = vi.fn(() => 'next');
        const queued = manager.executeWithRateLimit('Long429', task);
        await vi.advanceTimersByTimeAsync(2_147_483_647);
        expect(task).not.toHaveBeenCalled();
        controller.abort('user-cancelled');
        await expect(wait).rejects.toMatchObject({ type: ErrorTypes.USER_CANCELLED });
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
        await vi.advanceTimersByTimeAsync(1);
        await expect(queued).resolves.toBe('next');
        expect(state.activeRequests).toBe(0);
      } finally { vi.useRealTimers(); }
    });
  });

  describe('provider circuit threshold configuration', () => {
    it('uses Bing explicit threshold and opens after third eligible failure', async () => {
      const state = await manager._initializeProviderWithLevel('BingTranslate');

      expect(state.circuitBreakThreshold).toBe(3);

      for (let attempt = 0; attempt < 3; attempt++) {
        manager._recordFailure(
          state,
          Object.assign(new Error('Bing server failure'), { type: ErrorTypes.SERVER_ERROR }),
          'BingTranslate'
        );
      }

      expect(state.isCircuitOpen).toBe(true);

      const task = vi.fn().mockResolvedValue('unexpected');
      await expect(manager.executeWithRateLimit('BingTranslate', task))
        .rejects.toMatchObject({ type: ErrorTypes.CIRCUIT_BREAKER_OPEN });
      expect(task).not.toHaveBeenCalled();
    });

    it('keeps default threshold for providers without explicit override', async () => {
      const state = await manager._initializeProviderWithLevel('TestProvider');

      expect(state.circuitBreakThreshold).toBe(5);
    });

    it.each([0, -1, 1.5, NaN, Infinity, '3'])('falls back for invalid explicit threshold %p', (threshold) => {
      const state = manager._initializeProvider('InvalidThresholdProvider', {
        maxConcurrent: 1,
        delayBetweenRequests: 0,
      }, { circuitBreakThreshold: threshold });

      expect(state.circuitBreakThreshold).toBe(5);
    });
  });

  describe('Priority Queueing', () => {
    it('should execute HIGH priority tasks before NORMAL and LOW', async () => {
      const executionOrder = [];
      manager._initializeProvider('TestProvider', { maxConcurrent: 1, delayBetweenRequests: 0 });

      // 1. Block the queue with a long-running task
      let resolveBlocker;
      const blockerTask = () => new Promise(resolve => { resolveBlocker = resolve; });
      const blockerPromise = manager.executeWithRateLimit('TestProvider', blockerTask, '', TranslationPriority.NORMAL);

      // Give a tiny bit of time for the blocker to actually start and set resolveBlocker
      await new Promise(r => setTimeout(r, 10));

      // 2. Enqueue others while blocked
      const results = [];
      const addTask = (name, priority) => {
        manager.executeWithRateLimit('TestProvider', async () => {
          executionOrder.push(name);
          return name;
        }, '', priority).then(res => results.push(res));
      };

      addTask('LOW_TASK', TranslationPriority.LOW);
      addTask('NORMAL_TASK', TranslationPriority.NORMAL);
      addTask('HIGH_TASK', TranslationPriority.HIGH);

      // 3. Unblock and wait
      resolveBlocker();
      await blockerPromise;
      
      // Wait for all tasks to finish
      await new Promise(r => setTimeout(r, 100));

      // Order should be: Blocker (not in executionOrder) -> HIGH -> NORMAL -> LOW
      expect(executionOrder).toEqual(['HIGH_TASK', 'NORMAL_TASK', 'LOW_TASK']);
    });
  });

  describe('Circuit Breaker', () => {
    it('keeps circuit open when an in-flight success arrives during cooldown', async () => {
      vi.useFakeTimers();
      try {
        const state = manager._initializeProvider('CooldownProvider', {
          maxConcurrent: 2,
          delayBetweenRequests: 0,
          adaptiveBackoff: {
            enabled: true,
            baseMultiplier: 2,
            maxDelay: 1000,
            resetAfterSuccess: 2,
          },
        });
        state.circuitBreakThreshold = 1;
        state.circuitRecoveryTime = 30000;
        state.currentBackoffMultiplier = 2;

        let rejectFirst;
        let resolveSecond;
        const firstTask = vi.fn(() => new Promise((resolve, reject) => {
          rejectFirst = reject;
        }));
        const secondTask = vi.fn(() => new Promise(resolve => {
          resolveSecond = resolve;
        }));

        const firstRequest = manager.executeWithRateLimit('CooldownProvider', firstTask);
        const secondRequest = manager.executeWithRateLimit('CooldownProvider', secondTask);
        await Promise.resolve();
        await Promise.resolve();

        expect(firstTask).toHaveBeenCalledTimes(1);
        expect(secondTask).toHaveBeenCalledTimes(1);

        const openingError = Object.assign(new Error('network failure'), {
          type: ErrorTypes.NETWORK_ERROR,
        });
        rejectFirst(openingError);
        await expect(firstRequest).rejects.toBe(openingError);
        expect(state.isCircuitOpen).toBe(true);
        const openingTime = state.circuitOpenTime;

        resolveSecond('in-flight success');
        await expect(secondRequest).resolves.toBe('in-flight success');
        expect(state.isCircuitOpen).toBe(true);
        expect(state.circuitOpenTime).toBe(openingTime);
        expect(state.lastCircuitError).toBe(openingError);
        expect(state.successfulRequestsSinceBackoff).toBe(1);
        expect(state.currentBackoffMultiplier).toBe(2);

        const blockedTask = vi.fn().mockResolvedValue('blocked');
        await expect(manager.executeWithRateLimit('CooldownProvider', blockedTask))
          .rejects.toMatchObject({
            type: ErrorTypes.CIRCUIT_BREAKER_OPEN,
            originalType: ErrorTypes.NETWORK_ERROR,
          });
        expect(blockedTask).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(30001);

        const recoveryTask = vi.fn().mockResolvedValue('recovered');
        await expect(manager.executeWithRateLimit('CooldownProvider', recoveryTask))
          .resolves.toBe('recovered');
        expect(recoveryTask).toHaveBeenCalledTimes(1);
        expect(state.isCircuitOpen).toBe(false);
        expect(state.currentBackoffMultiplier).toBe(1);
        expect(state.successfulRequestsSinceBackoff).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not count insufficient balance as transient circuit failure', async () => {
      const error = Object.assign(new Error('No credits remaining'), {
        type: ErrorTypes.INSUFFICIENT_BALANCE,
        statusCode: 429,
      });
      isFatalError.mockReturnValue(true);
      isConfigError.mockImplementation(candidate => candidate?.type === ErrorTypes.INSUFFICIENT_BALANCE);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      const state = manager.providerStates.get('TestProvider');
      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.isCircuitOpen).toBe(false);
    });

    it('does not count invalid requests and allows the next operation', async () => {
      const error = Object.assign(new Error('Invalid request parameters'), {
        type: ErrorTypes.INVALID_REQUEST,
        statusCode: 400,
      });
      isFatalError.mockReturnValue(true);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      const state = manager.providerStates.get('TestProvider');
      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.isCircuitOpen).toBe(false);

      const nextTask = vi.fn().mockResolvedValue('healthy');
      await expect(manager.executeWithRateLimit('TestProvider', nextTask)).resolves.toBe('healthy');
      expect(nextTask).toHaveBeenCalledTimes(1);
    });

    it.each([
      ErrorTypes.API_ENDPOINT_INVALID,
      ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED,
    ])('keeps request-local %s out of provider health and allows the next operation', async (type) => {
      const error = Object.assign(new Error(type), { type });
      const state = manager.providerStates.get('TestProvider');
      isFatalError.mockReturnValue(true);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.isCircuitOpen).toBe(false);

      const nextTask = vi.fn().mockResolvedValue('healthy');
      await expect(manager.executeWithRateLimit('TestProvider', nextTask)).resolves.toBe('healthy');
      expect(nextTask).toHaveBeenCalledTimes(1);
    });

    it('keeps SOCKS timeout transport failures out of provider health', async () => {
      const error = Object.assign(new Error('SOCKS proxy connection timed out'), {
        type: ErrorTypes.NETWORK_ERROR,
        transportFailure: 'socks-proxy-timeout',
      });
      const state = manager.providerStates.get('TestProvider');
      isFatalError.mockReturnValue(true);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.isCircuitOpen).toBe(false);
    });

    it('keeps ordinary NETWORK_ERROR provider-health behavior unchanged', async () => {
      const error = Object.assign(new Error('Network failure'), {
        type: ErrorTypes.NETWORK_ERROR,
      });
      const state = manager.providerStates.get('TestProvider');
      isFatalError.mockReturnValue(true);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(1);
    });

    it('keeps fatal FORBIDDEN_ERROR out of provider health and allows the next operation', async () => {
      const error = Object.assign(new Error('Access denied'), {
        type: ErrorTypes.FORBIDDEN_ERROR,
        statusCode: 403,
      });
      const state = manager.providerStates.get('TestProvider');
      isFatalError.mockReturnValue(true);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.isCircuitOpen).toBe(false);

      const nextTask = vi.fn().mockResolvedValue('healthy');
      await expect(manager.executeWithRateLimit('TestProvider', nextTask)).resolves.toBe('healthy');
      expect(nextTask).toHaveBeenCalledTimes(1);
    });

    it.each([400, 422])('keeps HTTP %s TEXT_EMPTY out of provider health while recording failure', async (statusCode) => {
      const error = Object.assign(new Error('Text is empty'), {
        type: ErrorTypes.TEXT_EMPTY,
        statusCode,
      });
      isFatalError.mockReturnValue(true);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      const state = manager.providerStates.get('TestProvider');
      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.isCircuitOpen).toBe(false);

      const nextTask = vi.fn().mockResolvedValue('healthy');
      await expect(manager.executeWithRateLimit('TestProvider', nextTask)).resolves.toBe('healthy');
      expect(nextTask).toHaveBeenCalledTimes(1);
    });

    it.each([
      [400, true],
      [404, true],
      [422, true],
      [409, false],
    ])('keeps HTTP %s deterministic-client predicate expectation', (statusCode, expected) => {
      const error = { type: ErrorTypes.HTTP_ERROR, statusCode };
      expect(isDeterministicClientHttpError(error)).toBe(expected);
    });

    it.each([400, 404, 422])('excludes HTTP %s from provider health and allows the next operation', async (statusCode) => {
      const error = Object.assign(new Error(`HTTP ${statusCode}`), {
        type: ErrorTypes.HTTP_ERROR,
        statusCode,
      });
      const state = manager.providerStates.get('TestProvider');
      isFatalError.mockImplementation((candidate) => candidate === error || candidate?.statusCode === 404);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.isCircuitOpen).toBe(false);

      const nextTask = vi.fn().mockResolvedValue('healthy');
      await expect(manager.executeWithRateLimit('TestProvider', nextTask)).resolves.toBe('healthy');
      expect(nextTask).toHaveBeenCalledTimes(1);
    });

    it('keeps HTTP 409 provider-health accounting unchanged', async () => {
      const error = Object.assign(new Error('Conflict'), {
        type: ErrorTypes.HTTP_ERROR,
        statusCode: 409,
      });
      const state = manager.providerStates.get('TestProvider');
      isFatalError.mockReturnValue(false);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(1);
      expect(state.isCircuitOpen).toBe(false);
    });

    it('still counts genuine SERVER_ERROR provider health failures', async () => {
      const error = Object.assign(new Error('Server failure'), {
        type: ErrorTypes.SERVER_ERROR,
        statusCode: 500,
      });
      const state = manager.providerStates.get('TestProvider');
      isFatalError.mockReturnValue(false);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(1);
      expect(state.isCircuitOpen).toBe(false);
    });

    it.each([
      [400, 'request is too long'],
      [422, 'maximum context length exceeded'],
      [413, 'Payload Too Large'],
    ])('records HTTP %s remote-size failure without health penalty', async (statusCode, message) => {
      const error = Object.assign(new Error(message), {
        type: ErrorTypes.HTTP_ERROR,
        statusCode,
      });
      isFatalError.mockReturnValue(false);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      const state = manager.providerStates.get('TestProvider');
      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.isCircuitOpen).toBe(false);

      const nextTask = vi.fn().mockResolvedValue('healthy');
      await expect(manager.executeWithRateLimit('TestProvider', nextTask)).resolves.toBe('healthy');
      expect(nextTask).toHaveBeenCalledTimes(1);
    });

    it('preserves HTTP 402 semantic type when opening circuit', async () => {
      const error = Object.assign(new Error('HTTP 402'), {
        type: ErrorTypes.INSUFFICIENT_BALANCE,
        statusCode: 402,
      });
      isFatalError.mockReturnValue(true);

      await expect(manager.executeWithRateLimit(
        'TestProvider',
        () => Promise.reject(error)
      )).rejects.toBe(error);

      expect(manager.providerStates.get('TestProvider').lastCircuitError).toBe(error);
      expect(error.type).toBe(ErrorTypes.INSUFFICIENT_BALANCE);
    });

    it('should open the circuit after 5 consecutive failures', async () => {
      const failingTask = () => Promise.reject(new Error('API Error'));
      
      // Send 5 failing requests
      for (let i = 0; i < 5; i++) {
        try {
          await manager.executeWithRateLimit('TestProvider', failingTask);
        } catch {
          // Ignore planned errors
        }
      }

      // 6th request should fail immediately with Circuit Breaker error
      await expect(manager.executeWithRateLimit('TestProvider', () => Promise.resolve('ok')))
        .rejects.toThrow(/Circuit breaker open/);
    });

    it('should open circuit immediately on fatal errors', async () => {
      // Circuit breaker is already opened by the previous failure if we set consecutiveFailures correctly
      // But for this test, let's just use a fresh error that is marked as fatal
      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(new Error('FATAL')));
      } catch {
        // ignore
      }

      await expect(manager.executeWithRateLimit('TestProvider', () => Promise.resolve('ok')))
        .rejects.toThrow(/Circuit breaker open/);
    });

    it('preserves provider identity and original cause on circuit rejection', async () => {
      const state = manager.providerStates.get('TestProvider');
      const serverError = Object.assign(new Error('HTTP 500'), {
        type: 'SERVER_ERROR',
        statusCode: 500,
      });
      state.isCircuitOpen = true;
      state.circuitOpenTime = Date.now();
      state.lastCircuitError = serverError;

      await expect(manager.executeWithRateLimit('TestProvider', () => Promise.resolve('ok')))
        .rejects.toMatchObject({
          type: 'CIRCUIT_BREAKER_OPEN',
          originalType: 'SERVER_ERROR',
          statusCode: 500,
         providerName: 'TestProvider',
         });
    });

    it.each([
      ['server', ErrorTypes.SERVER_ERROR, 500],
      ['network', ErrorTypes.NETWORK_ERROR, undefined],
    ])('keeps %s circuit rejections out of cancellation classification', async (_label, originalType, statusCode) => {
      const state = manager.providerStates.get('TestProvider');
      const circuitError = Object.assign(new Error('Circuit breaker open for TestProvider'), {
        type: ErrorTypes.CIRCUIT_BREAKER_OPEN,
        originalType,
        ...(statusCode === undefined ? {} : { statusCode }),
        providerName: 'TestProvider',
      });
      const reject = vi.fn();
      state.queues[TranslationPriority.NORMAL].push({ reject });

      manager._rejectQueue(state, circuitError);

      const [rejection] = reject.mock.calls[0];
      expect(rejection).toMatchObject({ type: ErrorTypes.CIRCUIT_BREAKER_OPEN, originalType });
      expect(rejection.name).not.toBe('AbortError');
      expect(rejection.isCancelled).not.toBe(true);
      if (statusCode === undefined) expect(rejection).not.toHaveProperty('statusCode');
      else expect(rejection.statusCode).toBe(statusCode);
    });
  });

  describe('Abort provenance', () => {
    const createDeferred = () => {
      let resolve;
      const promise = new Promise((res) => { resolve = res; });
      return { promise, resolve };
    };

    const blockQueue = async () => {
      const blocker = createDeferred();
      const blockerPromise = manager.executeWithRateLimit('TestProvider', () => blocker.promise);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { blocker, blockerPromise };
    };

    it('preserves explicit user cancellation for queued requests', async () => {
      const { blocker, blockerPromise } = await blockQueue();
      const controller = new AbortController();
      const request = manager.executeWithRateLimit('TestProvider', () => 'not-run', '', TranslationPriority.NORMAL, {
        abortController: controller,
      });

      controller.abort('user-cancelled');

      await expect(request).rejects.toMatchObject({
        type: ErrorTypes.USER_CANCELLED,
        isCancelled: true,
      });
      blocker.resolve();
      await blockerPromise;
    });

    it.each([['timeout', (controller) => controller.abort('timeout')], ['bare', (controller) => controller.abort()]])(
      'classifies queued %s abort as an internal operation abort', async (_label, abort) => {
        const { blocker, blockerPromise } = await blockQueue();
        const controller = new AbortController();
        const request = manager.executeWithRateLimit('TestProvider', () => 'not-run', '', TranslationPriority.NORMAL, {
          abortController: controller,
        });

        abort(controller);

        const error = await request.catch((caughtError) => caughtError);
        expect(error).toMatchObject({
          operationAborted: true,
          cancellationReason: 'operation-abort',
        });
        expect(error.type).not.toBe(ErrorTypes.USER_CANCELLED);
        expect(error.isCancelled).not.toBe(true);
        blocker.resolve();
        await blockerPromise;
      }
    );

    it('classifies already-aborted signals before enqueue as internal operation abort', async () => {
      const controller = new AbortController();
      controller.abort();

      const error = await manager.executeWithRateLimit('TestProvider', () => 'not-run', '', TranslationPriority.NORMAL, {
        abortController: controller,
      }).catch((caughtError) => caughtError);
      expect(error).toMatchObject({
        operationAborted: true,
        cancellationReason: 'operation-abort',
      });
      expect(error.type).not.toBe(ErrorTypes.USER_CANCELLED);
      expect(error.isCancelled).not.toBe(true);
    });

    it('classifies pre-start abort as an internal operation abort', async () => {
      const controller = new AbortController();
      const state = manager.providerStates.get('TestProvider');
      const request = {
        options: { abortController: controller },
        reject: vi.fn(),
      };
      controller.abort('timeout');

      state.activeRequests++;
      await manager._executeRequest(state, request, 'TestProvider');

      const [error] = request.reject.mock.calls[0];
      expect(error).toMatchObject({
        operationAborted: true,
        cancellationReason: 'operation-abort',
      });
      expect(error.type).not.toBe(ErrorTypes.USER_CANCELLED);
      expect(error.isCancelled).not.toBe(true);
    });

    it('classifies cleanup cancellation without signal as an internal operation abort', async () => {
      const state = manager.providerStates.get('TestProvider');
      const reject = vi.fn();
      state.queues[TranslationPriority.NORMAL].push({
        options: { messageId: 'cleanup-abort' },
        reject,
      });

      manager.clearPendingRequests('cleanup-abort');

      const [error] = reject.mock.calls[0];
      expect(error).toMatchObject({
        operationAborted: true,
        cancellationReason: 'operation-abort',
      });
      expect(error.type).not.toBe(ErrorTypes.USER_CANCELLED);
      expect(error.isCancelled).not.toBe(true);
    });
  });

  describe('Concurrency Control', () => {
    it('should respect maxConcurrent limit', async () => {
      manager._initializeProvider('ConcurrentProvider', { maxConcurrent: 2, delayBetweenRequests: 0 });
      
      let activeCount = 0;
      let maxSeenActive = 0;

      const task = async () => {
        activeCount++;
        maxSeenActive = Math.max(maxSeenActive, activeCount);
        await new Promise(r => setTimeout(r, 50)); // Hold request
        activeCount--;
      };

      // Start 5 requests
      const promises = Array(5).fill(0).map(() => 
        manager.executeWithRateLimit('ConcurrentProvider', task)
      );

      await Promise.all(promises);
      expect(maxSeenActive).toBe(2);
    });

    it('should refresh runtime concurrency when optimization level changes', async () => {
      manager._initializeProvider('WebAI', { maxConcurrent: 2, delayBetweenRequests: 0 }, {
        isManualConfig: false,
        optimizationLevel: 3,
        configSource: 'fresh-load'
      });

      let activeCount = 0;
      let maxSeenActive = 0;

      const task = async () => {
        activeCount++;
        maxSeenActive = Math.max(maxSeenActive, activeCount);
        await sleep(30);
        activeCount--;
      };

      mockRuntime.providerLevels.set('WebAI', 3);
      const initialRun = Array.from({ length: 4 }, () => manager.executeWithRateLimit('WebAI', task));
      await Promise.all(initialRun);
      expect(maxSeenActive).toBe(2);

      activeCount = 0;
      maxSeenActive = 0;

      mockRuntime.providerLevels.set('WebAI', 5);
      const refreshedRun = Array.from({ length: 5 }, () => manager.executeWithRateLimit('WebAI', task));
      await Promise.all(refreshedRun);
      expect(maxSeenActive).toBe(4);
    });

    it('should enforce provider-level concurrency despite a larger mode override', async () => {
      mockRuntime.providerLevels.set('WebAI', 3);

      let activeCount = 0;
      let maxSeenActive = 0;
      const task = async () => {
        activeCount++;
        maxSeenActive = Math.max(maxSeenActive, activeCount);
        await sleep(20);
        activeCount--;
      };

      await Promise.all(Array.from({ length: 4 }, (_, index) => manager.executeWithRateLimit(
        'WebAI',
        task,
        '',
        TranslationPriority.NORMAL,
        { mode: index % 2 === 0 ? 'select_element' : 'popup' },
      )));

      expect(maxSeenActive).toBe(2);
      expect(manager.providerStates.has('WebAI')).toBe(true);
    });

    it('should share one provider budget across translation modes', async () => {
      mockRuntime.providerLevels.set('WebAI', 3);

      let activeCount = 0;
      let maxSeenActive = 0;
      const task = async () => {
        activeCount++;
        maxSeenActive = Math.max(maxSeenActive, activeCount);
        await sleep(20);
        activeCount--;
      };

      const selectRequests = Array.from({ length: 2 }, () => manager.executeWithRateLimit(
        'WebAI', task, '', TranslationPriority.NORMAL, { mode: 'select_element' }
      ));
      const popupRequests = Array.from({ length: 2 }, () => manager.executeWithRateLimit(
        'WebAI', task, '', TranslationPriority.NORMAL, { mode: 'popup' }
      ));

      await Promise.all([...selectRequests, ...popupRequests]);

      expect(maxSeenActive).toBe(2);
      expect([...manager.providerStates.keys()]).toEqual(['TestProvider', 'WebAI']);
    });

    it('should preserve manual override configs without refreshing them', async () => {
      manager._initializeProvider('ManualProvider', { maxConcurrent: 1, delayBetweenRequests: 0 }, {
        isManualConfig: true,
        optimizationLevel: 3,
        configSource: 'manual'
      });

      mockRuntime.providerLevels.set('ManualProvider', 5);

      let activeCount = 0;
      let maxSeenActive = 0;

      const task = async () => {
        activeCount++;
        maxSeenActive = Math.max(maxSeenActive, activeCount);
        await sleep(20);
        activeCount--;
      };

      const promises = Array.from({ length: 3 }, () => manager.executeWithRateLimit('ManualProvider', task));
      await Promise.all(promises);

      expect(maxSeenActive).toBe(1);
    });
  });

  describe('Adaptive Backoff', () => {
    it('uses canonical RATE_LIMIT_REACHED identity for adaptive backoff', async () => {
      const state = manager.providerStates.get('TestProvider');
      expect(state.currentBackoffMultiplier).toBe(1);

      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(
          Object.assign(new Error('temporarily unavailable'), { type: ErrorTypes.RATE_LIMIT_REACHED })
        ));
      } catch {
        // ignore
      }

      expect(state.currentBackoffMultiplier).toBe(2);
    });

    it('does not use quota wording from unrelated canonical errors', async () => {
      const state = manager.providerStates.get('TestProvider');
      const error = Object.assign(new Error('quota is unavailable'), {
        type: ErrorTypes.INSUFFICIENT_BALANCE,
        statusCode: 429,
      });
      isConfigError.mockReturnValueOnce(true);

      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(error));
      } catch {
        // ignore
      }

      expect(state.currentBackoffMultiplier).toBe(1);
      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.isCircuitOpen).toBe(false);
    });

    it('uses configured multiplier progression and success reset threshold', async () => {
      const state = manager._initializeProvider('ConfiguredProvider', {
        maxConcurrent: 1,
        delayBetweenRequests: 0,
        adaptiveBackoff: {
          enabled: true,
          baseMultiplier: 1.5,
          maxDelay: 2500,
          resetAfterSuccess: 2,
        },
      });
      const rateLimitError = Object.assign(new Error('temporarily unavailable'), {
        type: ErrorTypes.RATE_LIMIT_REACHED,
      });

      manager._recordFailure(state, rateLimitError, 'ConfiguredProvider');
      manager._recordFailure(state, rateLimitError, 'ConfiguredProvider');
      expect(state.currentBackoffMultiplier).toBe(2.25);

      manager._recordSuccess(state);
      expect(state.currentBackoffMultiplier).toBe(2.25);
      manager._recordSuccess(state);
      expect(state.currentBackoffMultiplier).toBe(1);
    });

    it('caps effective dispatch delay in milliseconds', async () => {
      vi.useFakeTimers();
      try {
        const state = manager._initializeProvider('CappedProvider', {
          maxConcurrent: 1,
          delayBetweenRequests: 1000,
          adaptiveBackoff: {
            enabled: true,
            baseMultiplier: 2,
            maxDelay: 2500,
            resetAfterSuccess: 1,
          },
        });
        const error = Object.assign(new Error('temporarily unavailable'), {
          type: ErrorTypes.RATE_LIMIT_REACHED,
        });
        manager._recordFailure(state, error, 'CappedProvider');
        manager._recordFailure(state, error, 'CappedProvider');
        state.lastRequestTime = Date.now();

        const task = vi.fn().mockResolvedValue('ok');
        const result = manager.executeWithRateLimit('CappedProvider', task);
        await Promise.resolve();

        expect(task).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2499);
        expect(task).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe('ok');
        expect(task).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves zero effective delay for Google-style configuration', async () => {
      const state = manager._initializeProvider('GoogleStyleProvider', {
        maxConcurrent: 1,
        delayBetweenRequests: 0,
        adaptiveBackoff: {
          enabled: true,
          baseMultiplier: 1.5,
          maxDelay: 10000,
          resetAfterSuccess: 2,
        },
      });
      const error = Object.assign(new Error('temporarily unavailable'), {
        type: ErrorTypes.RATE_LIMIT_REACHED,
      });
      manager._recordFailure(state, error, 'GoogleStyleProvider');

      const task = vi.fn().mockResolvedValue('ok');
      await expect(manager.executeWithRateLimit('GoogleStyleProvider', task)).resolves.toBe('ok');
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('does not increase backoff when adaptive backoff is disabled', async () => {
      const state = manager._initializeProvider('DisabledBackoffProvider', {
        maxConcurrent: 1,
        delayBetweenRequests: 1000,
        adaptiveBackoff: { enabled: false, baseMultiplier: 1.5, maxDelay: 2500, resetAfterSuccess: 2 },
      });
      const error = Object.assign(new Error('temporarily unavailable'), {
        type: ErrorTypes.RATE_LIMIT_REACHED,
      });

      manager._recordFailure(state, error, 'DisabledBackoffProvider');

      expect(state.currentBackoffMultiplier).toBe(1);
    });

    it('preserves legacy multiplier cap when adaptive configuration is missing', async () => {
      vi.useFakeTimers();
      try {
        const state = manager._initializeProvider('LegacyProvider', {
          maxConcurrent: 1,
          delayBetweenRequests: 1000,
        });
        state.circuitBreakThreshold = 99;
        const error = Object.assign(new Error('temporarily unavailable'), {
          type: ErrorTypes.RATE_LIMIT_REACHED,
        });

        for (let i = 0; i < 5; i++) {
          manager._recordFailure(state, error, 'LegacyProvider');
        }

        expect(state.currentBackoffMultiplier).toBe(10);
        state.lastRequestTime = Date.now();
        const task = vi.fn().mockResolvedValue('ok');
        const result = manager.executeWithRateLimit('LegacyProvider', task);
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(9999);
        expect(task).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe('ok');
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves zero effective delay for legacy configuration', async () => {
      const state = manager._initializeProvider('LegacyZeroDelayProvider', {
        maxConcurrent: 1,
        delayBetweenRequests: 0,
      });
      const error = Object.assign(new Error('temporarily unavailable'), {
        type: ErrorTypes.RATE_LIMIT_REACHED,
      });
      manager._recordFailure(state, error, 'LegacyZeroDelayProvider');

      const task = vi.fn().mockResolvedValue('ok');
      await expect(manager.executeWithRateLimit('LegacyZeroDelayProvider', task)).resolves.toBe('ok');
      expect(task).toHaveBeenCalledTimes(1);
    });

    it('normalizes partial adaptive configuration per field', () => {
      const state = manager._initializeProvider('PartialProvider', {
        maxConcurrent: 1,
        delayBetweenRequests: 1000,
        adaptiveBackoff: {
          enabled: true,
          baseMultiplier: 1.5,
        },
      });
      const error = Object.assign(new Error('temporarily unavailable'), {
        type: ErrorTypes.RATE_LIMIT_REACHED,
      });

      manager._recordFailure(state, error, 'PartialProvider');

      expect(state.currentBackoffMultiplier).toBe(1.5);
    });
  });

  describe('TEXT_TOO_LONG deterministic validation', () => {
    beforeEach(() => {
      isLocalDeterministicValidationError.mockImplementation(
        (err) => err?.type === 'TEXT_TOO_LONG'
      );
    });

    it('rejects TEXT_TOO_LONG to caller', async () => {
      const textTooLongError = Object.assign(new Error('text is too long'), { type: 'TEXT_TOO_LONG' });
      const failingTask = () => Promise.reject(textTooLongError);

      await expect(manager.executeWithRateLimit('TestProvider', failingTask))
        .rejects.toBe(textTooLongError);
    });

    it('does not increment failedRequests for TEXT_TOO_LONG', async () => {
      const state = manager.providerStates.get('TestProvider');
      const textTooLongError = Object.assign(new Error('text is too long'), { type: 'TEXT_TOO_LONG' });

      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(textTooLongError));
      } catch { /* ignore */ }

      expect(state.performanceStats.failedRequests).toBe(0);
    });

    it('does not increment consecutiveFailures for TEXT_TOO_LONG', async () => {
      const state = manager.providerStates.get('TestProvider');
      const textTooLongError = Object.assign(new Error('text is too long'), { type: 'TEXT_TOO_LONG' });

      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(textTooLongError));
      } catch { /* ignore */ }

      expect(state.consecutiveFailures).toBe(0);
    });

    it('does not change circuit state for TEXT_TOO_LONG', async () => {
      const state = manager.providerStates.get('TestProvider');
      const textTooLongError = Object.assign(new Error('text is too long'), { type: 'TEXT_TOO_LONG' });

      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(textTooLongError));
      } catch { /* ignore */ }

      expect(state.isCircuitOpen).toBe(false);
    });

    it('releases active request count after TEXT_TOO_LONG', async () => {
      const state = manager.providerStates.get('TestProvider');
      const textTooLongError = Object.assign(new Error('text is too long'), { type: 'TEXT_TOO_LONG' });

      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(textTooLongError));
      } catch { /* ignore */ }

      expect(state.activeRequests).toBe(0);
    });

    it('repeated TEXT_TOO_LONG never opens circuit', async () => {
      const state = manager.providerStates.get('TestProvider');
      const textTooLongError = Object.assign(new Error('text is too long'), { type: 'TEXT_TOO_LONG' });

      for (let i = 0; i < 10; i++) {
        try {
          await manager.executeWithRateLimit('TestProvider', () => Promise.reject(textTooLongError));
        } catch { /* ignore */ }
      }

      expect(state.isCircuitOpen).toBe(false);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.performanceStats.failedRequests).toBe(0);
    });

    it('processes queued tasks after TEXT_TOO_LONG rejection', async () => {
      const state = manager.providerStates.get('TestProvider');
      const textTooLongError = Object.assign(new Error('text is too long'), { type: 'TEXT_TOO_LONG' });
      let callCount = 0;

      const task = () => {
        callCount++;
        if (callCount === 1) return Promise.reject(textTooLongError);
        return Promise.resolve('task2-ok');
      };

      const p1 = manager.executeWithRateLimit('TestProvider', task).catch(() => {});
      const p2 = manager.executeWithRateLimit('TestProvider', task);

      await Promise.all([p1, p2]);

      expect(state.activeRequests).toBe(0);
      expect(state.isCircuitOpen).toBe(false);
      expect(state.performanceStats.failedRequests).toBe(0);
      await expect(p2).resolves.toBe('task2-ok');
    });

    it('still increments health counters for NETWORK_ERROR', async () => {
      isLocalDeterministicValidationError.mockReturnValue(false);
      const state = manager.providerStates.get('TestProvider');
      const networkError = Object.assign(new Error('failed to fetch'), { type: 'NETWORK_ERROR' });

      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(networkError));
      } catch { /* ignore */ }

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(1);
    });

    it('retains existing behavior for SERVER_ERROR', async () => {
      isLocalDeterministicValidationError.mockReturnValue(false);
      const state = manager.providerStates.get('TestProvider');
      const serverError = Object.assign(new Error('internal server error'), { type: 'SERVER_ERROR' });

      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(serverError));
      } catch { /* ignore */ }

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(1);
    });

    it('retains existing rate-limit health behavior for DeepL HTTP 529', async () => {
      isLocalDeterministicValidationError.mockReturnValue(false);
      const state = manager.providerStates.get('TestProvider');
      const rateLimitError = Object.assign(new Error('rate limit'), {
        type: ErrorTypes.RATE_LIMIT_REACHED,
        statusCode: 529,
      });

      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(rateLimitError));
      } catch { /* ignore */ }

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(1);
    });

    it('retains existing behavior for API_RESPONSE_INVALID', async () => {
      isLocalDeterministicValidationError.mockReturnValue(false);
      const state = manager.providerStates.get('TestProvider');
      const apiError = Object.assign(new Error('invalid response'), { type: 'API_RESPONSE_INVALID' });

      try {
        await manager.executeWithRateLimit('TestProvider', () => Promise.reject(apiError));
      } catch { /* ignore */ }

      expect(state.performanceStats.failedRequests).toBe(1);
      expect(state.consecutiveFailures).toBe(1);
    });
  });
});
