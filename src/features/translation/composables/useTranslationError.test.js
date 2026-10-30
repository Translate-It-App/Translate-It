import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from 'vue';
import { useTranslationError } from './useTranslationError.js';
import * as ErrorDisplayStrategies from '@/shared/error-management/ErrorDisplayStrategies.js';
import { isCancellationError, matchErrorToType } from '@/shared/error-management/ErrorMatcher.js';
import { mockErrorHandlerInstance } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';

// --- Shared Mock Objects ---
const mockUseErrorHandler = {
  handleTranslationError: vi.fn(),
  getErrorForDisplay: vi.fn(),
  isRetryableError: vi.fn()
};

// --- Mocks ---

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('@/shared/logging/logConstants.js', () => ({
  LOG_COMPONENTS: { UI: 'UI' }
}));

vi.mock('@/shared/error-management/ErrorHandler.js');

vi.mock('@/core/helpers.js', () => ({
  openOptionsPage: vi.fn(() => Promise.resolve())
}));

vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: vi.fn(() => mockUseErrorHandler)
}));

vi.mock('@/shared/error-management/ErrorDisplayStrategies.js');
vi.mock('@/shared/error-management/ErrorMatcher.js');

// Helper to test composables
function withSetup(composable) {
  let result;
  const app = createApp({
    setup() {
      result = composable();
      return () => {};
    },
  });
  app.mount(document.createElement('div'));
  return [result, app];
}

describe('useTranslationError', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mock behaviors
    mockUseErrorHandler.getErrorForDisplay.mockResolvedValue({
      message: 'Displayed Error',
      timestamp: 12345
    });
    
    ErrorDisplayStrategies.getErrorDisplayStrategy.mockReturnValue({
      showToast: false,
      showInUI: true,
      errorLevel: 'detailed'
    });
    
    ErrorDisplayStrategies.shouldShowRetry.mockReturnValue(true);
    ErrorDisplayStrategies.shouldShowSettings.mockReturnValue(false);
    
    matchErrorToType.mockReturnValue('API_ERROR');
    isCancellationError.mockReturnValue(false);
    
    // Ensure mock implementation for addUIErrorListener returns a function
    mockErrorHandlerInstance.addUIErrorListener.mockReturnValue(vi.fn());
  });

  it('should initialize with default state', () => {
    const [composable] = withSetup(() => useTranslationError('popup'));

    expect(composable.hasError.value).toBe(false);
    expect(composable.errorMessage.value).toBe('');
    expect(composable.errorType.value).toBe('');
    expect(composable.canRetry.value).toBe(false);
    expect(composable.canOpenSettings.value).toBe(false);
    expect(mockErrorHandlerInstance.addUIErrorListener).toHaveBeenCalled();
  });

  it('should handle error and update state', async () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    const testError = Object.assign(new Error('raw provider detail'), {
      type: ErrorTypes.API_ERROR,
      providerName: 'provider-secret',
      statusCode: 500
    });

    await composable.handleError(testError);

    expect(composable.hasError.value).toBe(true);
    expect(composable.currentError.value).toBe(testError);
    expect(composable.errorMessage.value).toBe('ERRORS_API_ERROR');
    expect(composable.errorType.value).toBe('API_ERROR');
    expect(composable.canRetry.value).toBe(false);
    expect(composable.errorTimestamp.value).toEqual(expect.any(Number));
    
    expect(mockUseErrorHandler.handleTranslationError).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ErrorTypes.API_ERROR,
        message: 'ERRORS_API_ERROR',
        cause: testError
      }),
      'popup',
      expect.objectContaining({
        showInUI: true,
        type: ErrorTypes.API_ERROR
      })
    );
    expect(mockUseErrorHandler.handleTranslationError.mock.calls[0][0]).not.toBe(testError);
    expect(mockUseErrorHandler.handleTranslationError.mock.calls[0][0].message).not.toContain('raw provider detail');
    expect(mockUseErrorHandler.handleTranslationError.mock.calls[0][0]).not.toHaveProperty('providerName');
    expect(mockUseErrorHandler.handleTranslationError.mock.calls[0][0]).not.toHaveProperty('statusCode');
  });

  it.each([
    [ErrorTypes.HTTP_ERROR, { statusCode: 404 }, false],
    [ErrorTypes.HTTP_ERROR, { statusCode: 409 }, true],
    [ErrorTypes.SERVER_ERROR, { statusCode: 500 }, true],
    [ErrorTypes.RATE_LIMIT_REACHED, { statusCode: 429 }, false],
    [ErrorTypes.INVALID_REQUEST, { statusCode: 400 }, false],
  ])('derives canRetry from public action for %s', async (type, fields, expected) => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    const error = Object.assign(new Error(type), { type, ...fields });
    matchErrorToType.mockReturnValue(type);

    await composable.handleError(error);

    expect(composable.canRetry.value).toBe(expected);
  });

  it.each([
    [ErrorTypes.HTTP_ERROR, 400, false, false],
    [ErrorTypes.HTTP_ERROR, 404, false, false],
    [ErrorTypes.HTTP_ERROR, 408, true, false],
    [ErrorTypes.HTTP_ERROR, 409, true, false],
    [ErrorTypes.SERVER_ERROR, 500, true, false],
    [ErrorTypes.API_KEY_INVALID, undefined, false, true],
    [ErrorTypes.RATE_LIMIT_REACHED, 429, false, false],
    [ErrorTypes.API_ERROR, undefined, false, false],
  ])('derives both capabilities from public action for %s', async (type, statusCode, expectedRetry, expectedSettings) => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    const error = Object.assign(new Error(type), {
      type,
      ...(statusCode !== undefined && { statusCode }),
    });
    matchErrorToType.mockReturnValue(type);
    ErrorDisplayStrategies.shouldShowRetry.mockReturnValue(true);
    ErrorDisplayStrategies.shouldShowSettings.mockReturnValue(true);

    await composable.handleError(error);

    expect(composable.canRetry.value).toBe(expectedRetry);
    expect(composable.canOpenSettings.value).toBe(expectedSettings);
  });

  it('should ignore user cancellation errors', async () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    matchErrorToType.mockReturnValue('USER_CANCELLED');
    isCancellationError.mockReturnValue(true);
    
    await composable.handleError(new Error('cancelled'));

    expect(composable.hasError.value).toBe(false);
    expect(mockUseErrorHandler.handleTranslationError).not.toHaveBeenCalled();
  });

  it.each([ErrorTypes.USER_CANCELLED, ErrorTypes.TRANSLATION_CANCELLED])(
    'silently suppresses typed %s cancellation',
    async (type) => {
      const [composable] = withSetup(() => useTranslationError('popup'));
      const error = Object.assign(new Error('anything'), { type });
      matchErrorToType.mockReturnValue(type);
      isCancellationError.mockReturnValue(true);

      await composable.handleError(error);

      expect(composable.hasError.value).toBe(false);
      expect(mockUseErrorHandler.handleTranslationError).not.toHaveBeenCalled();
    }
  );

  it('preserves legacy untyped cancellation compatibility through ErrorMatcher', async () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    const error = new Error('Translation cancelled by user');
    matchErrorToType.mockReturnValue(ErrorTypes.USER_CANCELLED);
    isCancellationError.mockReturnValue(true);

    await composable.handleError(error);

    expect(composable.hasError.value).toBe(false);
    expect(mockUseErrorHandler.handleTranslationError).not.toHaveBeenCalled();
  });

  it('does not suppress typed provider errors containing cancellation wording', async () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    const error = Object.assign(new Error('Request cancelled by upstream provider'), {
      type: ErrorTypes.NETWORK_ERROR,
    });
    matchErrorToType.mockReturnValue(ErrorTypes.NETWORK_ERROR);
    isCancellationError.mockReturnValue(false);

    await composable.handleError(error);

    expect(mockUseErrorHandler.handleTranslationError).toHaveBeenCalled();
    expect(mockUseErrorHandler.handleTranslationError.mock.calls[0][0].message)
      .not.toContain('Request cancelled by upstream provider');
  });

  it.each([
    [ErrorTypes.API_ERROR, ErrorTypes.API_ERROR, 'raw api detail'],
    [ErrorTypes.HTTP_ERROR, ErrorTypes.HTTP_ERROR, 'raw http body'],
    [ErrorTypes.NETWORK_ERROR, ErrorTypes.NETWORK_ERROR, 'raw network detail'],
    [ErrorTypes.SERVER_ERROR, ErrorTypes.SERVER_ERROR, 'raw server detail'],
    [ErrorTypes.MODEL_OVERLOADED, ErrorTypes.MODEL_OVERLOADED, 'raw overload detail'],
    [ErrorTypes.TRANSLATION_TIMEOUT, ErrorTypes.TRANSLATION_TIMEOUT, 'raw timeout detail'],
    [ErrorTypes.API_RESPONSE_INVALID, ErrorTypes.API_RESPONSE_INVALID, 'raw response detail'],
    [ErrorTypes.JSON_PARSING_ERROR, ErrorTypes.API_RESPONSE_INVALID, 'raw parser detail'],
    [ErrorTypes.VALIDATION, ErrorTypes.TRANSLATION_FAILED, 'raw validation detail'],
    [ErrorTypes.OPERATION_TIMEOUT, ErrorTypes.TRANSLATION_TIMEOUT, 'raw operation timeout detail'],
    [undefined, ErrorTypes.TRANSLATION_FAILED, 'raw unknown detail']
  ])('sanitizes %s while preserving canonical strategy type', async (canonicalType, displayType, rawMessage) => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    const testError = Object.assign(new Error(rawMessage), {
      ...(canonicalType && { type: canonicalType }),
      ...(canonicalType === ErrorTypes.CIRCUIT_BREAKER_OPEN && {
        originalType: ErrorTypes.NETWORK_ERROR
      }),
      statusCode: 502,
      providerName: 'provider-secret',
      providerId: 'provider-id',
      code: 'UPSTREAM_SECRET',
      errorCode: 'E_SECRET',
      translationOutcome: { secret: true },
      arbitrary: { secret: true }
    });
    matchErrorToType.mockReturnValue(canonicalType || ErrorTypes.UNKNOWN);

    await composable.handleError(testError);

    const [displayError, displayContext, options] = mockUseErrorHandler.handleTranslationError.mock.calls[0];
    expect(displayContext).toBe('popup');
    expect(options.type).toBe(canonicalType || ErrorTypes.UNKNOWN);
    expect(displayError.type).toBe(displayType);
    expect(displayError.message).not.toContain(rawMessage);
    expect(displayError).not.toHaveProperty('originalType');
    expect(displayError).not.toHaveProperty('statusCode');
    expect(displayError).not.toHaveProperty('providerName');
    expect(displayError).not.toHaveProperty('providerId');
    expect(displayError).not.toHaveProperty('code');
    expect(displayError).not.toHaveProperty('errorCode');
    expect(displayError).not.toHaveProperty('translationOutcome');
    expect(displayError).not.toHaveProperty('arbitrary');
    expect(displayError.cause).toBe(testError);
    expect(Object.prototype.propertyIsEnumerable.call(displayError, 'cause')).toBe(false);
    expect(composable.errorMessage.value).not.toContain(rawMessage);
    expect(composable.errorType.value).toBe(canonicalType || ErrorTypes.UNKNOWN);
    if (canonicalType === ErrorTypes.CIRCUIT_BREAKER_OPEN) {
      expect(composable.errorMessage.value).toBe('ERRORS_CIRCUIT_BREAKER_OPEN');
    }
  });

  it.each([
    [ErrorTypes.MODEL_MISSING, 'ERRORS_MODEL_MISSING'],
    [ErrorTypes.API_KEY_MISSING, 'ERRORS_API_KEY_MISSING'],
    [ErrorTypes.API_KEY_INVALID, 'ERRORS_API_KEY_INVALID'],
    [ErrorTypes.QUOTA_EXCEEDED, 'ERRORS_QUOTA_EXCEEDED'],
    [ErrorTypes.RATE_LIMIT_REACHED, 'ERRORS_RATE_LIMIT_REACHED']
  ])('keeps useful safe message for %s', async (type, messageKey) => {
    const [composable] = withSetup(() => useTranslationError('sidepanel'));
    const testError = Object.assign(new Error('raw provider detail'), { type });
    matchErrorToType.mockReturnValue(type);

    await composable.handleError(testError);

    expect(composable.errorMessage.value).toBe(messageKey);
    expect(mockUseErrorHandler.handleTranslationError.mock.calls[0][0].message).toBe(messageKey);
  });

  it('presents a reconstructed canonical errorDetails through the public boundary', async () => {
    const { reconstructTranslationError } = await import('@/shared/messaging/core/MessagingCore.js');
    const [composable] = withSetup(() => useTranslationError('popup'));
    const canonicalError = reconstructTranslationError({
      message: 'raw timeout detail',
      type: ErrorTypes.TRANSLATION_TIMEOUT,
      statusCode: 504,
    });
    matchErrorToType.mockReturnValue(ErrorTypes.TRANSLATION_TIMEOUT);

    await composable.handleError(canonicalError);

    expect(composable.errorType.value).toBe(ErrorTypes.TRANSLATION_TIMEOUT);
    expect(composable.errorMessage.value).toBe('ERRORS_TRANSLATION_TIMEOUT');
    const [displayError, displayContext, options] = mockUseErrorHandler.handleTranslationError.mock.calls[0];
    expect(displayContext).toBe('popup');
    expect(displayError.message).toBe('ERRORS_TRANSLATION_TIMEOUT');
    expect(displayError.message).not.toContain('raw timeout detail');
    expect(displayError.cause).toBe(canonicalError);
    expect(options.type).toBe(ErrorTypes.TRANSLATION_TIMEOUT);
  });

  it('presents structured HTTP 402 as localized insufficient balance', async () => {
    const { reconstructTranslationError } = await import('@/shared/messaging/core/MessagingCore.js');
    const [composable] = withSetup(() => useTranslationError('sidepanel'));
    const canonicalError = reconstructTranslationError({
      message: 'HTTP 402',
      type: ErrorTypes.INSUFFICIENT_BALANCE,
      statusCode: 402,
    });
    matchErrorToType.mockReturnValue(ErrorTypes.INSUFFICIENT_BALANCE);

    await composable.handleError(canonicalError);

    expect(composable.errorType.value).toBe(ErrorTypes.INSUFFICIENT_BALANCE);
    expect(composable.errorMessage.value).toBe('ERRORS_INSUFFICIENT_BALANCE');
    const [displayError, displayContext, options] = mockUseErrorHandler.handleTranslationError.mock.calls[0];
    expect(displayContext).toBe('sidepanel');
    expect(displayError.message).toBe('ERRORS_INSUFFICIENT_BALANCE');
    expect(displayError.message).not.toContain('HTTP 402');
    expect(options.type).toBe(ErrorTypes.INSUFFICIENT_BALANCE);
  });

  it.each(['popup', 'sidepanel'])('preserves critical toast strategy for %s', async (context) => {
    const [composable] = withSetup(() => useTranslationError(context));
    const testError = Object.assign(new Error('raw API key detail'), {
      type: ErrorTypes.API_KEY_INVALID
    });
    matchErrorToType.mockReturnValue(ErrorTypes.API_KEY_INVALID);
    ErrorDisplayStrategies.getErrorDisplayStrategy.mockReturnValue({
      showToast: true,
      showInUI: true,
      errorLevel: 'detailed'
    });

    await composable.handleError(testError);

    expect(mockUseErrorHandler.handleTranslationError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'ERRORS_API_KEY_INVALID' }),
      context,
      expect.objectContaining({
        type: ErrorTypes.API_KEY_INVALID,
        showToast: true,
        showInUI: true
      })
    );
    expect(composable.errorMessage.value).toBe('ERRORS_API_KEY_INVALID');
  });

  it('keeps local text-too-long validation on existing presentation path', async () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    const testError = Object.assign(new Error('Text too long (5001 chars)'), {
      type: ErrorTypes.TEXT_TOO_LONG
    });
    matchErrorToType.mockReturnValue(ErrorTypes.TEXT_TOO_LONG);

    await composable.handleError(testError);

    expect(mockUseErrorHandler.getErrorForDisplay).toHaveBeenCalledWith(testError, 'popup');
    expect(mockUseErrorHandler.handleTranslationError).toHaveBeenCalledWith(
      testError,
      'popup',
      expect.objectContaining({ showInUI: true })
    );
    expect(mockUseErrorHandler.handleTranslationError.mock.calls[0][2]).not.toHaveProperty('type');
    expect(composable.errorMessage.value).toBe('Displayed Error');
  });

  it('should clear error state', async () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    
    // Set some error state
    await composable.handleError(new Error('fail'));
    expect(composable.hasError.value).toBe(true);

    composable.clearError();

    expect(composable.hasError.value).toBe(false);
    expect(composable.errorMessage.value).toBe('');
    expect(composable.errorType.value).toBe('');
    expect(composable.canRetry.value).toBe(false);
  });

  it('should execute retry callback', async () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    const retryFn = vi.fn().mockResolvedValue();
    
    // Set error state first so canRetry is true
    await composable.handleError(new Error('fail'));
    
    const retryCallback = composable.getRetryCallback(retryFn);
    await retryCallback();

    expect(composable.hasError.value).toBe(false); // Cleared before retry
    expect(retryFn).toHaveBeenCalled();
  });

  it('should execute settings callback', async () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    
    // Mock strategy to allow settings
    matchErrorToType.mockReturnValue(ErrorTypes.TEXT_TOO_LONG);
    ErrorDisplayStrategies.shouldShowSettings.mockReturnValue(true);
    await composable.handleError(Object.assign(new Error('fail'), {
      type: ErrorTypes.TEXT_TOO_LONG,
    }));
    
    const { openOptionsPage } = await import('@/core/helpers.js');

    const settingsCallback = composable.getSettingsCallback();
    settingsCallback();

    expect(openOptionsPage).toHaveBeenCalled();

    // rejected promise is handled without throwing
    openOptionsPage.mockReturnValueOnce(Promise.reject(new Error('boom')));
    expect(() => settingsCallback()).not.toThrow();
  });

  it.each([
    [409, true, true, false],
    [400, false, true, false],
  ])('keeps HTTP public echo capabilities from canRetry for status %s', (statusCode, canRetry, legacySettings, expectedSettings) => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    ErrorDisplayStrategies.shouldShowSettings.mockReturnValue(legacySettings);
    const listener = mockErrorHandlerInstance.addUIErrorListener.mock.calls[0][0];

    listener({
      context: 'translation-popup',
      message: 'HTTP error',
      type: ErrorTypes.HTTP_ERROR,
      statusCode,
      canRetry,
      timestamp: 999,
    });

    expect(composable.canRetry.value).toBe(canRetry);
    expect(composable.canOpenSettings.value).toBe(expectedSettings);
  });

  it('keeps Settings for API_KEY_INVALID public echo without legacy inference', () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    ErrorDisplayStrategies.shouldShowSettings.mockReturnValue(false);
    const listener = mockErrorHandlerInstance.addUIErrorListener.mock.calls[0][0];

    listener({
      context: 'translation-popup',
      message: 'API key invalid',
      type: ErrorTypes.API_KEY_INVALID,
      canRetry: false,
      timestamp: 999,
    });

    expect(composable.canRetry.value).toBe(false);
    expect(composable.canOpenSettings.value).toBe(true);
  });

  it('handles public echo when canonical and emitted display types differ', async () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    const error = Object.assign(new Error('raw parser detail'), {
      type: ErrorTypes.JSON_PARSING_ERROR,
    });
    matchErrorToType.mockReturnValue(ErrorTypes.JSON_PARSING_ERROR);
    ErrorDisplayStrategies.shouldShowRetry.mockReturnValue(true);
    ErrorDisplayStrategies.shouldShowSettings.mockReturnValue(true);

    await composable.handleError(error);

    const listener = mockErrorHandlerInstance.addUIErrorListener.mock.calls[0][0];
    listener({
      context: 'translation-popup',
      message: 'Invalid API response',
      type: ErrorTypes.API_RESPONSE_INVALID,
      canRetry: false,
      timestamp: 999,
    });

    expect(composable.canRetry.value).toBe(false);
    expect(composable.canOpenSettings.value).toBe(false);
  });

  it('keeps legacy capability fallback for listener events without canRetry', () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    ErrorDisplayStrategies.shouldShowRetry.mockReturnValue(true);
    ErrorDisplayStrategies.shouldShowSettings.mockReturnValue(true);
    const listener = mockErrorHandlerInstance.addUIErrorListener.mock.calls[0][0];

    listener({
      context: 'popup',
      message: 'Legacy listener error',
      type: ErrorTypes.NETWORK_ERROR,
      timestamp: 999,
    });

    expect(composable.canRetry.value).toBe(true);
    expect(composable.canOpenSettings.value).toBe(true);
  });

  it('should update state from UI error listener', async () => {
    const [composable] = withSetup(() => useTranslationError('popup'));
    
    // Get the listener that was registered
    const listener = mockErrorHandlerInstance.addUIErrorListener.mock.calls[0][0];
    
    const errorData = {
      context: ['popup'],
      message: 'Listener Error',
      type: 'NETWORK_ERROR',
      timestamp: 999
    };
    
    listener(errorData);

    expect(composable.errorMessage.value).toBe('Listener Error');
    expect(composable.errorType.value).toBe('NETWORK_ERROR');
  });

  it('should cleanup listener on unmount', () => {
    const unsubscribe = vi.fn();
    mockErrorHandlerInstance.addUIErrorListener.mockReturnValue(unsubscribe);
    
    const [, app] = withSetup(() => useTranslationError('popup'));
    
    app.unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
