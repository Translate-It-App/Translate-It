import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranslationHandler } from './TranslationHandler.js';
import { settingsManager } from '@/shared/managers/SettingsManager.js';
import { registerTranslation, sendUnifiedTranslation } from '@/shared/messaging/core/ContentScriptIntegration.js';
import { pageEventBus, WINDOWS_MANAGER_EVENTS } from '@/core/PageEventBus.js';

// Mock ALL dependencies
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    operation: vi.fn()
  }))
}));

vi.mock('../core/WindowsConfig.js', () => ({
  WindowsConfig: {
    TIMEOUTS: {
      TRANSLATION_TIMEOUT: 30000
    }
  }
}));

vi.mock('@/utils/messaging/messageId.js', () => ({
  generateTranslationMessageId: vi.fn().mockReturnValue('mock-msg-id')
}));

vi.mock('@/shared/config/config.js', () => ({
  CONFIG: {
    POPUP_MAX_CHARS: 5000,
    SIDEPANEL_MAX_CHARS: 10000,
    SELECTION_MAX_CHARS: 5000,
    SELECT_ELEMENT_MAX_CHARS: 300000,
  },
  getSelectionMaxCharsAsync: vi.fn(() => Promise.resolve(5000)),
  TranslationMode: {
    Selection: 'selection',
    Dictionary_Translation: 'dictionary'
  }
}));

vi.mock('@/features/translation/providers/ProviderConstants.js', () => ({
  ProviderRegistryIds: {
    GOOGLE_V2: 'google_v2'
  }
}));

vi.mock('@/shared/managers/SettingsManager.js', () => ({
  settingsManager: {
    get: vi.fn().mockImplementation((key, def) => def)
  }
}));

vi.mock('@/shared/constants/core.js', () => ({
  AUTO_DETECT_VALUE: 'auto'
}));

vi.mock('@/shared/messaging/core/ContentScriptIntegration.js', () => ({
  registerTranslation: vi.fn(),
  sendUnifiedTranslation: vi.fn(),
  cancelTranslation: vi.fn()
}));

vi.mock('@/shared/messaging/core/MessageActions.js', () => ({
  MessageActions: {
    TRANSLATE: 'TRANSLATE'
  }
}));

vi.mock('@/shared/utils/text/textAnalysis.js', () => ({
  isSingleWordOrShortPhrase: vi.fn().mockReturnValue(false)
}));

vi.mock('@/shared/error-management/ErrorHandler.js');

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isValidSync: vi.fn().mockReturnValue(true),
    isContentScript: vi.fn().mockReturnValue(true)
  }
}));

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: {
    emit: vi.fn()
  },
  WINDOWS_MANAGER_EVENTS: {
    UPDATE_WINDOW: 'UPDATE_WINDOW'
  },
  WindowsManagerEvents: {
    updateWindow: vi.fn((id, detail) => pageEventBus.emit('UPDATE_WINDOW', { id, ...detail }))
  }
}));

describe('TranslationHandler', () => {
  let handler;

  beforeEach(() => {
    vi.clearAllMocks();
    registerTranslation.mockImplementation(() => {});
    vi.useFakeTimers();
    handler = new TranslationHandler();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize', () => {
    expect(handler).toBeDefined();
    expect(handler.activeRequests.size).toBe(0);
  });

  it('should resolve the correct provider based on settings', () => {
    settingsManager.get.mockImplementation((key, def) => {
      if (key === 'TRANSLATION_API') return 'bing';
      return def;
    });

    const provider = handler.getEffectiveProvider('hello');
    expect(provider).toBe('bing');
  });

  it('should prioritize manual override for provider', () => {
    const provider = handler.getEffectiveProvider('hello', { provider: 'deepl' });
    expect(provider).toBe('deepl');
  });

  it('should handle direct translation result from sendUnifiedTranslation', async () => {
    const mockResult = { success: true, translatedText: 'سلام', sourceLanguage: 'en', targetLanguage: 'fa', streaming: false };
    sendUnifiedTranslation.mockResolvedValue(mockResult);

    const result = await handler.performTranslation('hello');

    expect(result.translatedText).toBe('سلام');
    expect(sendUnifiedTranslation).toHaveBeenCalled();
  });

  it('keeps request identity callbacks out of the serialized translation payload', async () => {
    sendUnifiedTranslation.mockResolvedValue({
      success: true, translatedText: 'translated', streaming: false,
    });
    const isCurrent = vi.fn(() => true);

    await handler.performTranslation('hello', { windowId: 'window-1', isCurrent });

    const outbound = sendUnifiedTranslation.mock.calls[0][0].data;
    expect(outbound.options).not.toHaveProperty('isCurrent');
    const containsFunction = (value) => {
      if (typeof value === 'function') return true;
      if (!value || typeof value !== 'object') return false;
      return Object.values(value).some(containsFunction);
    };
    expect(containsFunction(outbound)).toBe(false);
  });

  it('should handle streaming translation result', async () => {
    // 1. Setup sendUnifiedTranslation to return streaming status
    sendUnifiedTranslation.mockResolvedValue({ success: true, streaming: true });

    // 2. Setup registerTranslation to simulate streaming updates and completion
    registerTranslation.mockImplementation((id, callbacks) => {
      // Simulate streaming update
      setTimeout(() => {
        callbacks.onStreamUpdate({ data: ['سلام'] });
      }, 10);
      
      // Simulate streaming end
      setTimeout(() => {
        callbacks.onStreamEnd({ success: true, sourceLanguage: 'en', targetLanguage: 'fa' });
      }, 20);
    });

    const translationPromise = handler.performTranslation('hello', { windowId: 'win-123' });

    // Fast-forward timers to complete the stream
    await vi.runAllTimersAsync();

    const result = await translationPromise;

    expect(result.translatedText).toBe('سلام');
    expect(pageEventBus.emit).toHaveBeenCalledWith(WINDOWS_MANAGER_EVENTS.UPDATE_WINDOW, expect.objectContaining({
      id: 'win-123',
      initialTranslatedText: 'سلام'
    }));
  });

  it('should handle translation timeout', async () => {
    sendUnifiedTranslation.mockResolvedValue({ success: true, streaming: true });
    // Don't simulate any streaming callbacks to force timeout

    const translationPromise = handler.performTranslation('hello');
    
    // Create the rejection expectation promise BEFORE advancing timers
    const rejectionExpectation = expect(translationPromise).rejects.toThrow('Translation timeout');

    // Fast-forward to trigger timeout
    await vi.advanceTimersByTimeAsync(31000);

    // Now await the expectation
    await rejectionExpectation;
  });

  it('should handle cancellation', async () => {
    sendUnifiedTranslation.mockResolvedValue({ success: true, streaming: true });
    
    const translationPromise = handler.performTranslation('hello');
    
    // Cancel it
    handler.cancelTranslation('mock-msg-id');

    const result = await translationPromise;
    expect(result.cancelled).toBe(true);
  });

  it('ignores a direct response that arrives after cancellation and cleans request timers', async () => {
    let resolveSend;
    sendUnifiedTranslation.mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
    const pending = handler.performTranslation('hello');
    handler.cancelTranslation('mock-msg-id');
    resolveSend({ success: true, translatedText: 'late result', streaming: false });
    await expect(pending).resolves.toMatchObject({ cancelled: true });
    expect(handler.getActiveRequestCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans the timeout after a successful stream', async () => {
    let callbacks;
    registerTranslation.mockImplementation((id, registeredCallbacks) => { callbacks = registeredCallbacks; });
    sendUnifiedTranslation.mockResolvedValue({ success: true, streaming: true });
    const pending = handler.performTranslation('hello');
    callbacks.onStreamEnd({ success: true });
    await expect(pending).resolves.toMatchObject({ translatedText: '' });
    expect(handler.getActiveRequestCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should handle translation error message', async () => {
    const message = {
      messageId: 'mock-msg-id',
      data: { error: { message: 'API Error' } }
    };
    
    // Start translation
    sendUnifiedTranslation.mockResolvedValue({ success: true, streaming: true });
    const promise = handler.performTranslation('hello');
    
    // Simulate result arrival (via handleTranslationResult fallback)
    handler.handleTranslationResult(message);
    
    await expect(promise).rejects.toThrow('API Error');
  });

  it('reconstructs direct result DTO errors with canonical identity', () => {
    const request = {
      reject: vi.fn(),
      resolve: vi.fn(),
      timeout: setTimeout(() => {}, 1000),
      startTime: Date.now()
    };
    handler.activeRequests.set('dto-error', request);
    const error = {
      message: 'Provider failed',
      type: 'PROVIDER_ERROR',
      originalType: 'HTTP_ERROR',
      statusCode: 502,
      context: 'selection-window',
      providerName: 'Provider',
      providerId: 'provider-id',
      code: 'UPSTREAM_FAILURE',
      errorCode: 'E_UPSTREAM',
      cause: 'private',
      arbitrary: { ignored: true }
    };

    expect(handler.handleTranslationResult({ messageId: 'dto-error', data: { error } })).toBe(true);

    const reconstructed = request.reject.mock.calls[0][0];
    expect(reconstructed).toBeInstanceOf(Error);
    expect(reconstructed).toMatchObject({
      message: 'Provider failed',
      type: 'PROVIDER_ERROR',
      originalType: 'HTTP_ERROR',
      statusCode: 502,
      context: 'selection-window',
      providerName: 'Provider',
      providerId: 'provider-id',
      code: 'UPSTREAM_FAILURE',
      errorCode: 'E_UPSTREAM'
    });
    expect(reconstructed).not.toHaveProperty('cause');
    expect(reconstructed).not.toHaveProperty('arbitrary');
  });

  it('prefers canonical errorDetails over conflicting legacy error', () => {
    const request = {
      reject: vi.fn(),
      resolve: vi.fn(),
      timeout: setTimeout(() => {}, 1000),
      startTime: Date.now()
    };
    handler.activeRequests.set('canonical-error', request);

    expect(handler.handleTranslationResult({
      messageId: 'canonical-error',
      data: {
        error: { message: 'legacy failure', type: 'LEGACY_ERROR' },
        errorDetails: {
          message: 'canonical failure',
          type: 'PROVIDER_ERROR',
          statusCode: 503,
          providerName: 'Provider',
          code: 'UPSTREAM_FAILURE',
          errorCode: 'E_UPSTREAM',
          translationOutcome: { partial: true }
        }
      }
    })).toBe(true);

    expect(request.reject).toHaveBeenCalledWith(expect.objectContaining({
      message: 'canonical failure',
      type: 'PROVIDER_ERROR',
      statusCode: 503,
      providerName: 'Provider',
      code: 'UPSTREAM_FAILURE',
      errorCode: 'E_UPSTREAM',
      translationOutcome: { partial: true }
    }));
    expect(handler.activeRequests.has('canonical-error')).toBe(false);
  });

  it('rejects details-only failures and cleans up the active request', () => {
    const request = {
      reject: vi.fn(),
      resolve: vi.fn(),
      timeout: setTimeout(() => {}, 1000),
      startTime: Date.now()
    };
    handler.activeRequests.set('details-only', request);

    expect(handler.handleTranslationResult({
      messageId: 'details-only',
      data: {
        errorDetails: {
          message: 'details-only failure',
          type: 'MODEL_NOT_FOUND'
        }
      }
    })).toBe(true);

    expect(request.reject).toHaveBeenCalledWith(expect.objectContaining({
      message: 'details-only failure',
      type: 'MODEL_NOT_FOUND'
    }));
    expect(handler.activeRequests.has('details-only')).toBe(false);
  });

  it('falls back to legacy error when errorDetails is malformed', () => {
    const request = {
      reject: vi.fn(),
      resolve: vi.fn(),
      timeout: setTimeout(() => {}, 1000),
      startTime: Date.now()
    };
    handler.activeRequests.set('malformed-details', request);

    expect(handler.handleTranslationResult({
      messageId: 'malformed-details',
      data: {
        error: { message: 'legacy failure', type: 'LEGACY_ERROR' },
        errorDetails: { arbitrary: true }
      }
    })).toBe(true);

    expect(request.reject).toHaveBeenCalledWith(expect.objectContaining({
      message: 'legacy failure',
      type: 'LEGACY_ERROR'
    }));
    expect(handler.activeRequests.has('malformed-details')).toBe(false);
  });

  it('preserves false behavior when result has neither error nor translatedText', () => {
    const request = {
      reject: vi.fn(),
      resolve: vi.fn(),
      timeout: setTimeout(() => {}, 1000),
      startTime: Date.now()
    };
    handler.activeRequests.set('empty-result', request);

    expect(handler.handleTranslationResult({
      messageId: 'empty-result',
      data: { success: false }
    })).toBe(false);
    expect(handler.activeRequests.has('empty-result')).toBe(true);

    handler._cleanupRequest('empty-result');
  });

  it('preserves translatedText success resolution', () => {
    const request = {
      reject: vi.fn(),
      resolve: vi.fn(),
      timeout: setTimeout(() => {}, 1000),
      startTime: Date.now()
    };
    handler.activeRequests.set('success-result', request);

    expect(handler.handleTranslationResult({
      messageId: 'success-result',
      data: {
        translatedText: 'translated',
        sourceLanguage: 'en',
        targetLanguage: 'fa'
      }
    })).toBe(true);

    expect(request.resolve).toHaveBeenCalledWith(expect.objectContaining({
      translatedText: 'translated',
      sourceLanguage: 'en',
      targetLanguage: 'fa'
    }));
    expect(handler.activeRequests.has('success-result')).toBe(false);
  });

  it('reconstructs stream-end DTO errors and preserves cancellation behavior', async () => {
    let callbacks;
    registerTranslation.mockImplementation((id, registeredCallbacks) => {
      callbacks = registeredCallbacks;
    });
    sendUnifiedTranslation.mockResolvedValue({ success: true, streaming: true });

    const translationPromise = handler.performTranslation('hello');
    callbacks.onStreamEnd({
      success: false,
      error: {
        message: 'Cancelled',
        type: 'USER_CANCELLED',
        originalType: 'ABORT_ERROR',
        statusCode: 499,
        providerName: 'Provider',
        providerId: 'provider-id',
        code: 'USER_ABORT',
        errorCode: 'E_ABORT'
      }
    });

    await expect(translationPromise).rejects.toMatchObject({
      message: 'Cancelled',
      type: 'USER_CANCELLED',
      originalType: 'ABORT_ERROR',
      statusCode: 499,
      providerName: 'Provider',
      providerId: 'provider-id',
      code: 'USER_ABORT',
      errorCode: 'E_ABORT'
    });
  });

  it('prefers canonical errorDetails over legacy error on stream end', async () => {
    let callbacks;
    registerTranslation.mockImplementation((id, registeredCallbacks) => {
      callbacks = registeredCallbacks;
    });
    sendUnifiedTranslation.mockResolvedValue({ success: true, streaming: true });

    const translationPromise = handler.performTranslation('hello');
    callbacks.onStreamEnd({
      success: false,
      error: { message: 'legacy failure', type: 'LEGACY_ERROR' },
      errorDetails: { message: 'canonical failure', type: 'MODEL_NOT_FOUND' }
    });

    await expect(translationPromise).rejects.toMatchObject({
      message: 'canonical failure',
      type: 'MODEL_NOT_FOUND'
    });
  });

  it('falls back to legacy error when stream-end errorDetails is malformed', async () => {
    let callbacks;
    registerTranslation.mockImplementation((id, registeredCallbacks) => {
      callbacks = registeredCallbacks;
    });
    sendUnifiedTranslation.mockResolvedValue({ success: true, streaming: true });

    const translationPromise = handler.performTranslation('hello');
    callbacks.onStreamEnd({
      success: false,
      error: { message: 'legacy failure', type: 'LEGACY_ERROR' },
      errorDetails: { arbitrary: true }
    });

    await expect(translationPromise).rejects.toMatchObject({
      message: 'legacy failure',
      type: 'LEGACY_ERROR'
    });
  });
});
