/**
 * Rate Limit Manager - Intelligent request throttling with priority-based scheduling
 * Combines advanced stability (Circuit Breaker, Adaptive Backoff) with
 * priority-based queuing (HIGH, NORMAL, LOW).
 */

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { registryIdToName, isProviderType, ProviderTypes } from '@/features/translation/providers/ProviderConstants.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import {
  isFatalError,
  isConfigError,
  isProviderRequestSizeError,
  isDeterministicClientHttpError,
  matchErrorToType,
} from '@/shared/error-management/ErrorMatcher.js';
import { isLocalDeterministicValidationError } from '@/shared/error-management/ValidationPolicy.js';
import { PROVIDER_CONFIGURATIONS, getProviderConfiguration } from '@/features/translation/core/ProviderConfigurations.js';
import { getProviderOptimizationLevelAsync } from '@/shared/config/config.js';

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'RateLimitManager');

const LEGACY_ADAPTIVE_BACKOFF = Object.freeze({
  enabled: true,
  baseMultiplier: 2,
  maxMultiplier: 10,
  resetAfterSuccess: 1,
});

const EXPLICIT_ADAPTIVE_BACKOFF_DEFAULTS = Object.freeze({
  enabled: true,
  baseMultiplier: 2,
  maxDelay: 30000,
  resetAfterSuccess: 1,
});

const DEFAULT_CIRCUIT_BREAK_THRESHOLD = 5;
const MAX_TIMER_DELAY = 2_147_483_647;
const RATE_LIMIT_BACKOFF_BASE_MS = 2000;

function resolveCircuitBreakThreshold(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 1
    ? value
    : DEFAULT_CIRCUIT_BREAK_THRESHOLD;
}

function getAdaptiveBackoffConfig(config = {}) {
  const raw = config.adaptiveBackoff;
  if (!raw || typeof raw !== 'object') {
    return { ...LEGACY_ADAPTIVE_BACKOFF, explicit: false };
  }

  const baseMultiplier = Number(raw.baseMultiplier);
  const maxDelay = Number(raw.maxDelay);
  const resetAfterSuccess = Number(raw.resetAfterSuccess);

  return {
    explicit: true,
    enabled: raw.enabled !== false,
    baseMultiplier: Number.isFinite(baseMultiplier) && baseMultiplier > 1
      ? baseMultiplier
      : EXPLICIT_ADAPTIVE_BACKOFF_DEFAULTS.baseMultiplier,
    maxDelay: Number.isFinite(maxDelay) && maxDelay > 0
      ? maxDelay
      : EXPLICIT_ADAPTIVE_BACKOFF_DEFAULTS.maxDelay,
    resetAfterSuccess: Number.isFinite(resetAfterSuccess) && resetAfterSuccess >= 1
      ? resetAfterSuccess
      : EXPLICIT_ADAPTIVE_BACKOFF_DEFAULTS.resetAfterSuccess,
  };
}

function createAbortError(signal, message = 'Request aborted') {
  const isUserAbort = signal?.aborted
    && (signal.reason === 'user-cancelled' || signal.reason === 'user_cancelled');
  const error = new Error(isUserAbort ? 'Request cancelled' : message);
  error.name = 'AbortError';

  if (isUserAbort) {
    error.type = ErrorTypes.USER_CANCELLED;
    error.isCancelled = true;
  } else {
    error.operationAborted = true;
    error.cancellationReason = typeof signal?.reason === 'string'
      && signal.reason
      && signal.reason !== 'timeout'
      ? signal.reason
      : 'operation-abort';
  }

  return error;
}

/**
 * Priority levels for translation requests
 */
export const TranslationPriority = {
  HIGH: 10,   // Interactive UI (Popup, Sidepanel, Selection)
  NORMAL: 5,  // Default/Standard requests
  LOW: 1,     // Background tasks (Whole Page Translation)
};

export class RateLimitManager {
  constructor() {
    if (RateLimitManager.instance) {
      return RateLimitManager.instance;
    }
    
    this.providerStates = new Map();
    RateLimitManager.instance = this;
    
    // Initialize default configs
    this.reloadConfigurations();
    logger.debug('RateLimitManager initialized with priority support');
  }
  
  static getInstance() {
    if (!RateLimitManager.instance) {
      RateLimitManager.instance = new RateLimitManager();
    }
    return RateLimitManager.instance;
  }

  /**
   * Reset or load configurations from ProviderConfigurations
   */
  async reloadConfigurations() {
    for (const name of Object.keys(PROVIDER_CONFIGURATIONS)) {
      const level = await getProviderOptimizationLevelAsync(name);
      const optimizedConfig = getProviderConfiguration(name, level);
      const existing = this.providerStates.get(name);
      if (existing) {
        if (existing.isManualConfig) continue;
        // Retain live requests, queued work and cooldowns while applying new limits.
        existing.config = { ...existing.config, ...optimizedConfig.rateLimit };
        existing.isManualConfig = false;
        existing.optimizationLevel = level;
        existing.configSource = 'fresh-load';
        existing.circuitBreakThreshold = resolveCircuitBreakThreshold(optimizedConfig.errorHandling?.circuitBreakThreshold);
        this._processQueue(name);
        continue;
      }
      this._initializeProvider(name, optimizedConfig.rateLimit, {
        isManualConfig: false,
        optimizationLevel: level,
        configSource: 'fresh-load',
        circuitBreakThreshold: optimizedConfig.errorHandling?.circuitBreakThreshold,
      });
    }
  }

  /**
   * Initialize or get provider state
   * Optimized to fetch configuration if not present
   */
  async _initializeProviderWithLevel(providerName) {
    if (this.providerStates.has(providerName)) {
      return this.providerStates.get(providerName);
    }

    const level = await getProviderOptimizationLevelAsync(providerName);
    const optimizedConfig = getProviderConfiguration(providerName, level);

    return this._initializeProvider(providerName, optimizedConfig.rateLimit, {
      isManualConfig: false,
      optimizationLevel: level,
      configSource: 'fresh-load',
      circuitBreakThreshold: optimizedConfig.errorHandling?.circuitBreakThreshold,
    });
  }

  /**
   * Initialize or get provider state
   */
  _initializeProvider(providerName, config = {}, options = {}) {
    if (this.providerStates.has(providerName)) {
      return this.providerStates.get(providerName);
    }
    
    // Default safe configuration if none provided
    const safeDefault = { maxConcurrent: 2, delayBetweenRequests: 200 };
    const isManualConfig = options.isManualConfig ?? (Object.keys(options).length === 0);
    
    const state = {
      config: { ...safeDefault, ...config },
      isManualConfig,
      optimizationLevel: options.optimizationLevel ?? null,
      configSource: options.configSource || (isManualConfig ? 'manual' : 'fresh-load'),
      activeRequests: 0,
      lastRequestTime: 0,
      retryAt: 0,
      queues: {
        [TranslationPriority.HIGH]: [],
        [TranslationPriority.NORMAL]: [],
        [TranslationPriority.LOW]: []
      },
      isProcessingQueue: false,
      // Circuit breaker
      consecutiveFailures: 0,
      isCircuitOpen: false,
      circuitOpenTime: 0,
      circuitBreakThreshold: resolveCircuitBreakThreshold(
        options.circuitBreakThreshold ?? config.circuitBreakThreshold
      ),
      circuitRecoveryTime: 30000,
      // Adaptive backoff
      currentBackoffMultiplier: 1,
      successfulRequestsSinceBackoff: 0,
      // Performance monitoring (Crucial for AI providers)
      performanceStats: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalWaitTime: 0,
        totalProcessingTime: 0,
        averageWaitTime: 0,
        averageRequestTime: 0,
        requestsPerMinute: 0,
        successRate: 100,
        lastPerformanceReset: Date.now()
      }
    };
    
    this.providerStates.set(providerName, state);
    return state;
  }

  /**
   * Execute task with rate limiting and priority
   */
  async executeWithRateLimit(providerName, task, context = "", priority = TranslationPriority.NORMAL, options = {}) {
    // Resolve registry ID to name if necessary
    const name = registryIdToName(providerName) || providerName;

    // Refresh state and configuration only if it doesn't exist
    const state = await this._initializeProviderWithLevel(name);
    
    // Keep runtime limiter aligned with the latest optimization level unless a manual override is active.
    if (!state.isManualConfig) {
      const currentLevel = await getProviderOptimizationLevelAsync(name);
      if (state.optimizationLevel !== currentLevel) {
        const latestConfig = getProviderConfiguration(name, currentLevel);
        state.config = { ...state.config, ...latestConfig.rateLimit };
        state.optimizationLevel = currentLevel;
        state.configSource = 'fresh-runtime';

        logger.debug(
          `[RateLimitManager] Refreshed ${name} rate limits ` +
          `(level=${currentLevel}, maxConcurrent=${state.config.maxConcurrent}, source=${state.configSource})`
        );
      }
    }

    // Check circuit breaker
    if (this._isCircuitOpen(state)) {
      throw this._createCircuitOpenError(name, state);
    }

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const abortSignal = options.abortController?.signal;

      // Ensure priority is valid
      const targetPriority = [TranslationPriority.HIGH, TranslationPriority.NORMAL, TranslationPriority.LOW].includes(priority)
        ? priority : TranslationPriority.NORMAL;

      const request = { 
        task, 
        resolve, 
        reject, 
        context, 
        priority: targetPriority, 
        options, // Store metadata for stats
        enqueuedAt: startTime 
      };

      // Handle early cancellation while in queue
      if (abortSignal) {
        const onAbort = () => {
          // Find and remove from queue if still there
          const queue = state.queues[targetPriority];
          const index = queue.indexOf(request);
          if (index !== -1) {
            queue.splice(index, 1);
            request.cleanupAbort();
            reject(createAbortError(abortSignal, 'Request aborted while in queue'));
          }
        };
        request.cleanupAbort = () => abortSignal.removeEventListener('abort', onAbort);
        abortSignal.addEventListener('abort', onAbort, { once: true });
        
        // If already aborted
        if (abortSignal.aborted) {
          request.cleanupAbort();
          reject(createAbortError(abortSignal, 'Request aborted before enqueuing'));
          return;
        }
      }
      
      state.queues[targetPriority].push(request);
      this._processQueue(name);
    });
  }

  /**
   * Main queue processing logic - respects priorities (HIGH > NORMAL > LOW)
   */
  _processQueue(providerName) {
    const state = this.providerStates.get(providerName);
    if (!state) return;

    // Stop processing if circuit is open
    if (this._isCircuitOpen(state)) {
      this._rejectQueue(state, this._createCircuitOpenError(providerName, state));
      return;
    }

    // While we have capacity and pending requests, start them
    while (state.activeRequests < state.config.maxConcurrent) {
      if (!this._hasPendingRequests(state)) break;
      // Check delay between requests
      const now = Date.now();
      const baseDelay = state.config.delayBetweenRequests || 0;
      const adaptiveBackoff = getAdaptiveBackoffConfig(state.config);
      const effectiveDelay = baseDelay * (state.currentBackoffMultiplier || 1);
      const adjustedDelay = adaptiveBackoff.enabled === false
        ? baseDelay
        : adaptiveBackoff.explicit
          ? Math.min(effectiveDelay, adaptiveBackoff.maxDelay)
          : Math.min(effectiveDelay, baseDelay * adaptiveBackoff.maxMultiplier);
      const timeSinceLast = now - state.lastRequestTime;

      const cooldownWait = Math.max(0, adjustedDelay - timeSinceLast, state.retryAt - now);
      if (cooldownWait > 0) {
        if (state.nextProcessTimer) clearTimeout(state.nextProcessTimer);
        state.nextProcessTimer = setTimeout(() => this._processQueue(providerName), Math.min(cooldownWait, MAX_TIMER_DELAY));
        break; 
      }

      // Get next request by priority
      const nextRequest = this._getNextRequest(state);
      if (!nextRequest) break;
      nextRequest.cleanupAbort?.();

      // Update state and execute
      state.activeRequests++;
      state.lastRequestTime = Date.now();
      
      const waitTime = Date.now() - nextRequest.enqueuedAt;
      state.performanceStats.totalWaitTime += waitTime;
      state.performanceStats.totalRequests++;

      // Execute without blocking the loop
      this._executeRequest(state, nextRequest, providerName, nextRequest.options);
    }
  }

  _hasPendingRequests(state) {
    return state.queues[TranslationPriority.HIGH].length > 0 ||
           state.queues[TranslationPriority.NORMAL].length > 0 ||
           state.queues[TranslationPriority.LOW].length > 0;
  }

  _getNextRequest(state) {
    if (state.queues[TranslationPriority.HIGH].length > 0) return state.queues[TranslationPriority.HIGH].shift();
    if (state.queues[TranslationPriority.NORMAL].length > 0) return state.queues[TranslationPriority.NORMAL].shift();
    if (state.queues[TranslationPriority.LOW].length > 0) return state.queues[TranslationPriority.LOW].shift();
    return null;
  }

  _rejectQueue(state, error) {
    const isCircuitBreaker = error.message?.includes('Circuit breaker open');
    
    [TranslationPriority.HIGH, TranslationPriority.NORMAL, TranslationPriority.LOW].forEach(p => {
      while (state.queues[p].length > 0) {
        const req = state.queues[p].shift();
        req.cleanupAbort?.();
        
        const rejection = isCircuitBreaker
          ? this._copyCircuitError(error)
          : error;
        req.reject(rejection);
      }
    });
  }

  _createCircuitOpenError(providerName, state) {
    const lastError = state.lastCircuitError;
    const reason = lastError ? `: ${lastError.message || lastError}` : '';
    const error = new Error(`Circuit breaker open for ${providerName}. Too many failures${reason}`);
    error.type = ErrorTypes.CIRCUIT_BREAKER_OPEN;
    error.providerName = providerName;

    if (lastError) {
      error.originalType = lastError.type || matchErrorToType(lastError);
      if (lastError.statusCode) error.statusCode = lastError.statusCode;
    }

    return error;
  }

  _copyCircuitError(error) {
    const rejection = new Error(error.message);
    for (const field of ['type', 'originalType', 'statusCode', 'providerName']) {
      if (error[field] !== undefined) rejection[field] = error[field];
    }
    return rejection;
  }

  async _executeRequest(state, request, providerName, options = {}) {
    const requestStartTime = Date.now();
    
    // Check if aborted before starting
    if (request.options?.abortController?.signal?.aborted) {
      state.activeRequests--; // Decrease because it was increased before calling _executeRequest
      request.reject(createAbortError(request.options.abortController.signal, 'Request aborted before execution'));
      // Immediately process next to keep concurrency high
      this._processQueue(providerName);
      return;
    }

    try {
      const result = await request.task(options);
      const duration = Date.now() - requestStartTime;
      
      // Success record
      state.performanceStats.successfulRequests++;
      state.performanceStats.totalProcessingTime += duration;
      this._recordSuccess(state);
      
      request.resolve(result);
    } catch (error) {
      // Don't count cancellations as failures
      const isCancellation = error.name === 'AbortError' ||
                           error.operationAborted ||
                           error.isCancelled || 
                           error.message?.includes('cancelled') ||
                           error.message?.includes('aborted');
      
      if (!isCancellation && (!isLocalDeterministicValidationError(error) || isProviderRequestSizeError(error))) {
        this._recordFailure(state, error, providerName);
      }
      
      request.reject(error);
    } finally {
      state.activeRequests--;
      this._updateDerivedStats(state);
      
      // Process next in queue IMMEDIATELY to preserve strict priority and concurrency
      this._processQueue(providerName);
    }
  }

  /**
   * Update calculated metrics for AI providers
   */
  _updateDerivedStats(state) {
    const stats = state.performanceStats;
    const totalProcessed = stats.successfulRequests + stats.failedRequests;
    
    if (totalProcessed > 0) {
      stats.successRate = (stats.successfulRequests / totalProcessed) * 100;
      stats.averageWaitTime = stats.totalWaitTime / stats.totalRequests;
    }
    
    if (stats.successfulRequests > 0) {
      stats.averageRequestTime = stats.totalProcessingTime / stats.successfulRequests;
    }

    const timeSinceReset = (Date.now() - stats.lastPerformanceReset) / 60000; // in minutes
    if (timeSinceReset > 0) {
      stats.requestsPerMinute = stats.totalRequests / timeSinceReset;
    }
  }

  _isCircuitOpen(state) {
    if (!state.isCircuitOpen) return false;
    const now = Date.now();
    if (now - state.circuitOpenTime > state.circuitRecoveryTime) {
      state.isCircuitOpen = false;
      state.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  _recordSuccess(state) {
    const isCoolingDown = state.isCircuitOpen
      && Date.now() - state.circuitOpenTime <= state.circuitRecoveryTime;

    state.consecutiveFailures = 0;
    if (!isCoolingDown) state.isCircuitOpen = false;

    const adaptiveBackoff = getAdaptiveBackoffConfig(state.config);
    if (adaptiveBackoff.enabled !== false
        && adaptiveBackoff.resetAfterSuccess > 1
        && state.currentBackoffMultiplier > 1) {
      state.successfulRequestsSinceBackoff++;
      if (state.successfulRequestsSinceBackoff < adaptiveBackoff.resetAfterSuccess) return;
    }

    state.currentBackoffMultiplier = 1;
    state.successfulRequestsSinceBackoff = 0;
  }

  _recordFailure(state, error, providerName) {
    state.performanceStats.failedRequests++;
    
    // Request fatality and provider-health eligibility are separate decisions.
    // Configuration/account failures and ambiguous request denials must not
    // count as provider-health evidence.
    const isConfig = isConfigError(error);
    const isProviderRequestSize = isProviderRequestSizeError(error);
    const isDeterministicClientHttp = isDeterministicClientHttpError(error);
    const isProviderHttpTextEmpty = error?.type === ErrorTypes.TEXT_EMPTY
      && [400, 422].includes(error?.statusCode);
    const isForbidden = error?.type === ErrorTypes.FORBIDDEN_ERROR;
    const isRequestLocalProviderFailure = [
      ErrorTypes.API_ENDPOINT_INVALID,
      ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED,
    ].includes(error?.type);
    const isSocksProxyTimeout = error?.transportFailure === 'socks-proxy-timeout';
    const isProviderHealthFailure = !isSocksProxyTimeout
      && !isConfig
      && error?.type !== ErrorTypes.INVALID_REQUEST
      && !isProviderRequestSize
      && !isDeterministicClientHttp
      && !isProviderHttpTextEmpty
      && !isForbidden
      && !isRequestLocalProviderFailure;
    if (isProviderHealthFailure) {
      state.consecutiveFailures++;
    }
    
    // Adaptive Backoff: canonical rate-limit errors own rate-limit backoff.
    // Status-only fallback is limited to unclassified 429s entering this layer.
    const isRateLimit = error?.type === ErrorTypes.RATE_LIMIT_REACHED
      || (!error?.type && Number(error?.statusCode) === 429);
    const adaptiveBackoff = getAdaptiveBackoffConfig(state.config);
    if (isRateLimit && adaptiveBackoff.enabled !== false) {
      state.currentBackoffMultiplier = adaptiveBackoff.explicit
        ? state.currentBackoffMultiplier * adaptiveBackoff.baseMultiplier
        : Math.min(state.currentBackoffMultiplier * adaptiveBackoff.baseMultiplier, adaptiveBackoff.maxMultiplier);
      state.successfulRequestsSinceBackoff = 0;
      logger.warn(`Rate limit detected for ${providerName}, increasing backoff to ${state.currentBackoffMultiplier}x`);
    }
    if (isRateLimit) this.notifyRateLimit(providerName, error);

    // Provider-health-eligible fatal errors open the circuit immediately. Fatality
    // alone is not sufficient because request-local INVALID_REQUEST,
    // FORBIDDEN_ERROR, endpoint/language failures, and provider HTTP TEXT_EMPTY
    // are terminal for their requests but say nothing about provider health.
    const isFatal = isFatalError(error);

    if ((isFatal && isProviderHealthFailure) || state.consecutiveFailures >= state.circuitBreakThreshold) {
      if (!state.isCircuitOpen) {
        state.isCircuitOpen = true;
        state.circuitOpenTime = Date.now();
        state.lastCircuitError = error; // Store the error that caused the break
        logger.error(`Circuit breaker OPENED for ${providerName} ${isFatal ? '(FATAL ERROR) ' : ''}after ${state.consecutiveFailures} failures. Error: ${error.message || error}`);
      }
    }
  }

  /** Share physical 429 deadlines, including errors consumed by API-key failover. */
  notifyRateLimit(providerName, error) {
    const name = registryIdToName(providerName) || providerName;
    const state = this.providerStates.get(name);
    if (!state || (error?.type !== ErrorTypes.RATE_LIMIT_REACHED
        && (error?.type || Number(error?.statusCode) !== 429))) return;

    const adaptiveBackoff = getAdaptiveBackoffConfig(state.config);
    const isAI = isProviderType(name, ProviderTypes.AI) || isProviderType(name, ProviderTypes.CUSTOM);
    const baseDelay = state.config.delayBetweenRequests || (isAI ? RATE_LIMIT_BACKOFF_BASE_MS : 0);
    const clientDelay = adaptiveBackoff.enabled === false ? 0 : Math.min(
      baseDelay * state.currentBackoffMultiplier,
      adaptiveBackoff.explicit ? adaptiveBackoff.maxDelay : baseDelay * adaptiveBackoff.maxMultiplier
    );
    state.retryAt = Math.max(state.retryAt, Date.now() + clientDelay,
      Number.isFinite(error.retryAt) ? error.retryAt : 0);
  }

  /** Wait inside an existing slot; acquiring another slot here would deadlock at limit one. */
  async waitForCooldown(providerName, signal) {
    const name = registryIdToName(providerName) || providerName;
    const state = this.providerStates.get(name);
    while (true) {
      if (signal?.aborted) throw createAbortError(signal);
      const delay = (state?.retryAt || 0) - Date.now();
      if (delay <= 0) return;
      await new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(delay, MAX_TIMER_DELAY));
        const onAbort = () => {
          clearTimeout(timer);
          cleanup();
          reject(createAbortError(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  /**
   * API for AI Providers to monitor performance
   */
  getPerformanceStats(providerName) {
    const state = this.providerStates.get(providerName);
    if (!state) {
      return { 
        averageWaitTime: 0, averageRequestTime: 0, requestsPerMinute: 0, 
        successRate: 0, totalPending: 0, active: 0 
      };
    }
    
    this._updateDerivedStats(state);
    
    const q = state.queues;
    const totalPending = q[TranslationPriority.HIGH].length + 
                         q[TranslationPriority.NORMAL].length + 
                         q[TranslationPriority.LOW].length;
                         
    return {
      ...state.performanceStats,
      active: state.activeRequests,
      totalPending
    };
  }

  clearQueue(providerName) {
    const state = this.providerStates.get(providerName);
    if (state) {
      this._rejectQueue(state, new Error("Queue cleared"));
      if (state.nextProcessTimer) clearTimeout(state.nextProcessTimer);
    }
  }

  /**
   * Clear pending requests for a specific messageId across all providers
   * @param {string} messageId - Optional message ID to filter by
   */
  clearPendingRequests(messageId = null) {
    logger.debug(`Clearing pending requests${messageId ? ` for messageId: ${messageId}` : ''}`);
    
    for (const state of this.providerStates.values()) {
      [TranslationPriority.HIGH, TranslationPriority.NORMAL, TranslationPriority.LOW].forEach(p => {
        const queue = state.queues[p];
        const remaining = [];
        
        for (const request of queue) {
          const reqMessageId = request.options?.messageId || request.options?.abortController?.messageId;
          
          if (!messageId || reqMessageId === messageId) {
            request.cleanupAbort?.();
            request.reject(createAbortError(null, messageId ? 'Request cancelled' : 'All requests cleared'));
          } else {
            remaining.push(request);
          }
        }
        
        state.queues[p] = remaining;
      });
    }
  }
}

export const rateLimitManager = RateLimitManager.getInstance();
