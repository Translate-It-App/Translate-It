import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendMessage, sendRegularMessage } from './UnifiedMessaging.js';
import browser from 'webextension-polyfill';
import ExtensionContextManager from '@/core/extensionContext.js';
import * as contextCore from '@/core/contextCore.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { TRANSLATION_BATCH_EXECUTION_TIMEOUT_MS } from '@/shared/constants/translation.js';

// Mock dependencies
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      sendMessage: vi.fn(),
      getURL: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({})
      },
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    }
  }
}));

vi.mock('@/core/contextCore.js', () => ({
  isValidSync: vi.fn().mockReturnValue(true),
  isContextError: vi.fn().mockReturnValue(false),
  isPermanentContextInvalidation: vi.fn().mockReturnValue(false),
  isTransientMessagingError: vi.fn().mockReturnValue(false),
  contextState: { isInvalidated: false, notificationShown: false },
  getActiveEnvironment: vi.fn().mockReturnValue('popup'),
  ENVIRONMENTS: {
    BACKGROUND: 'background',
    CONTENT: 'content',
    POPUP: 'popup',
    SIDEPANEL: 'sidepanel',
    OPTIONS: 'options',
    OFFSCREEN: 'offscreen'
  }
}));

vi.mock('@/core/extensionContext.js', () => {
  const mock = {
    isValidSync: vi.fn().mockReturnValue(true),
    isContextError: vi.fn().mockReturnValue(false),
    handleContextError: vi.fn(),
    safeSendMessage: vi.fn().mockResolvedValue({ success: true }),
    isExtensionContextValid: vi.fn().mockReturnValue(true),
  };
  return {
    default: mock,
    ...mock
  };
});

vi.mock('./UnifiedTranslationCoordinator.js', () => ({
  unifiedTranslationCoordinator: {
    coordinateTranslation: vi.fn()
  }
}));

vi.mock('./StreamingTimeoutManager.js', () => ({
  streamingTimeoutManager: {
    shouldContinue: vi.fn().mockReturnValue(true),
    getOperationState: vi.fn().mockReturnValue(null)
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn()
  })
}));

// Mock ErrorHandler using central mocks
vi.mock('@/shared/error-management/ErrorHandler.js');

describe('UnifiedMessaging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    contextCore.isValidSync.mockReturnValue(true);
    contextCore.isContextError.mockReturnValue(false);
    contextCore.isPermanentContextInvalidation.mockReturnValue(false);
    ExtensionContextManager.isValidSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.selectElementHandlingESC;
  });

  describe('sendRegularMessage', () => {
    it('should send a message and return the response on success', async () => {
      const message = { action: 'PING', messageId: '1' };
      const expectedResponse = { success: true, data: 'pong' };
      browser.runtime.sendMessage.mockResolvedValue(expectedResponse);

      const promise = sendRegularMessage(message);
      const response = await promise;

      expect(browser.runtime.sendMessage).toHaveBeenCalledWith(message);
      expect(response).toEqual(expectedResponse);
    });

    it('resolves unrelated messages while Select Element ESC flag is set', async () => {
      const message = { action: 'PING' };
      const expectedResponse = { success: true, data: 'pong' };
      browser.runtime.sendMessage.mockReturnValue(
        new Promise(resolve => setTimeout(() => resolve(expectedResponse), 100))
      );
      window.selectElementHandlingESC = true;

      const promise = sendRegularMessage(message);
      await vi.advanceTimersByTimeAsync(100);

      await expect(promise).resolves.toEqual(expectedResponse);
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith(message);
    });

    it('does not cancel delayed Select Element deactivation from ESC flag', async () => {
      const message = { action: 'deactivateSelectElementMode' };
      const expectedResponse = { success: true, active: false };
      browser.runtime.sendMessage.mockReturnValue(
        new Promise(resolve => setTimeout(() => resolve(expectedResponse), 100))
      );
      window.selectElementHandlingESC = true;

      const promise = sendRegularMessage(message);
      await vi.advanceTimersByTimeAsync(100);

      await expect(promise).resolves.toEqual(expectedResponse);
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith(message);
    });

    it('should throw an error if the operation times out', async () => {
      const message = { action: 'PING', messageId: 'timeout-test' };
      browser.runtime.sendMessage.mockReturnValue(new Promise(() => {})); // Never resolves

      const promise = sendRegularMessage(message, { timeout: 100 });
      
      vi.advanceTimersByTime(150);
      
      await expect(promise).rejects.toThrow(/timed out/);
    });

    it('cancels only the timed-out page batch message and preserves the cancellation payload', async () => {
      const pendingResponses = [];
      browser.runtime.sendMessage.mockImplementation((message) => {
        if (message.action === 'CANCEL_TRANSLATION') return Promise.resolve({ success: true });
        return new Promise((resolve) => pendingResponses.push(resolve));
      });

      const timedOut = sendRegularMessage(
        { action: 'page-translate-batch', messageId: 'page-timeout' },
        { timeout: 100 }
      );
      const stillPending = sendRegularMessage(
        { action: 'page-translate-batch', messageId: 'page-pending' },
        { timeout: 200 }
      );
      const timeoutExpectation = expect(timedOut).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(100);
      await timeoutExpectation;
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'CANCEL_TRANSLATION',
        data: { messageId: 'page-timeout', reason: 'Translation timed out', timeout: true }
      });
      expect(browser.runtime.sendMessage.mock.calls.filter(([message]) => message.action === 'CANCEL_TRANSLATION'))
        .toHaveLength(1);

      pendingResponses[1]({ success: true });
      await expect(stillPending).resolves.toEqual({ success: true });
    });

    it('does not cancel a successful page batch response', async () => {
      browser.runtime.sendMessage.mockResolvedValue({ success: true });

      await expect(sendRegularMessage(
        { action: 'page-translate-batch', messageId: 'page-success' },
        { timeout: 100 }
      )).resolves.toEqual({ success: true });
      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('allows a page batch to complete after the former 60-second transport timeout', async () => {
      const message = { action: 'page-translate-batch', messageId: 'page-over-60s' };
      browser.runtime.sendMessage.mockReturnValue(new Promise((resolve) => {
        setTimeout(() => resolve({ success: true }), 60001);
      }));

      const promise = sendRegularMessage(message);
      await vi.advanceTimersByTimeAsync(60001);

      await expect(promise).resolves.toEqual({ success: true });
      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('times out an unresponsive Page background after the execution budget and allowance', async () => {
      browser.runtime.sendMessage.mockImplementation((message) => (
        message.action === 'CANCEL_TRANSLATION'
          ? Promise.resolve({ success: true })
          : new Promise(() => {})
      ));

      const promise = sendRegularMessage({
        action: 'page-translate-batch',
        messageId: 'page-background-unresponsive'
      });
      let settled = false;
      promise.then(
        () => { settled = true; },
        () => { settled = true; }
      );
      const timeoutExpectation = expect(promise).rejects.toMatchObject({
        type: ErrorTypes.OPERATION_TIMEOUT
      });

      await vi.advanceTimersByTimeAsync(TRANSLATION_BATCH_EXECUTION_TIMEOUT_MS + 29999);
      expect(settled).toBe(false);
      expect(browser.runtime.sendMessage.mock.calls.filter(([message]) => message.action === 'CANCEL_TRANSLATION'))
        .toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      await timeoutExpectation;
      expect(settled).toBe(true);

      const cancellationCalls = browser.runtime.sendMessage.mock.calls.filter(
        ([message]) => message.action === 'CANCEL_TRANSLATION'
      );
      expect(cancellationCalls).toHaveLength(1);
      expect(cancellationCalls[0][0]).toEqual({
        action: 'CANCEL_TRANSLATION',
        data: {
          messageId: 'page-background-unresponsive',
          reason: 'Translation timed out',
          timeout: true
        }
      });
    });

    it('does not cancel a page batch for other errors or explicit user cancellation', async () => {
      browser.runtime.sendMessage.mockRejectedValue(new Error('Runtime failed'));
      await expect(sendRegularMessage({ action: 'page-translate-batch', messageId: 'page-error' }))
        .rejects.toThrow('Runtime failed');
      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);

      const { streamingTimeoutManager } = await import('./StreamingTimeoutManager.js');
      streamingTimeoutManager.shouldContinue.mockReturnValue(false);
      streamingTimeoutManager.getOperationState.mockReturnValue({
        isCancelled: true,
        hasTimedOut: false,
        isCompleted: false
      });
      try {
        await expect(sendRegularMessage({ action: 'page-translate-batch', messageId: 'page-cancelled' }))
          .rejects.toMatchObject({ type: ErrorTypes.USER_CANCELLED });
        expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
      } finally {
        streamingTimeoutManager.shouldContinue.mockReturnValue(true);
        streamingTimeoutManager.getOperationState.mockReturnValue(null);
      }
    });

    it('does not settle a timed-out page batch again when its original response arrives late', async () => {
      let resolveOriginal;
      browser.runtime.sendMessage.mockImplementation((message) => {
        if (message.action === 'CANCEL_TRANSLATION') return Promise.resolve({ success: true });
        return new Promise((resolve) => { resolveOriginal = resolve; });
      });

      const promise = sendRegularMessage(
        { action: 'page-translate-batch', messageId: 'page-late' },
        { timeout: 100 }
      );
      const settlements = [];
      promise.then(
        (value) => settlements.push({ value }),
        (error) => settlements.push({ error })
      );
      const timeoutExpectation = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(100);
      await timeoutExpectation;

      resolveOriginal({ success: true, late: true });
      await Promise.resolve();
      expect(settlements).toHaveLength(1);
      expect(settlements[0].error).toMatchObject({ type: ErrorTypes.OPERATION_TIMEOUT });
      expect(browser.runtime.sendMessage.mock.calls.filter(([message]) => message.action === 'CANCEL_TRANSLATION'))
        .toHaveLength(1);
    });

    it('continues cancelling a generic translation when its operation times out', async () => {
      browser.runtime.sendMessage.mockImplementation((message) => (
        message.action === 'CANCEL_TRANSLATION'
          ? Promise.resolve({ success: true })
          : new Promise(() => {})
      ));

      const promise = sendRegularMessage(
        { action: 'TRANSLATE', messageId: 'translation-timeout' },
        { timeout: 100 }
      );
      const timeoutExpectation = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(100);
      await timeoutExpectation;

      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'CANCEL_TRANSLATION',
        data: { messageId: 'translation-timeout', reason: 'Translation timed out', timeout: true }
      });
    });

    it('should throw an error if response.success is false', async () => {
      const message = { action: 'FAIL', messageId: '2' };
      browser.runtime.sendMessage.mockResolvedValue({ 
        success: false, 
        error: { message: 'Something went wrong', type: 'API_ERROR' } 
      });

      await expect(sendRegularMessage(message)).rejects.toThrow('Something went wrong');
    });

    it('returns resolved failure responses when explicitly requested', async () => {
      const response = {
        success: false,
        reason: 'busy_or_done',
        responses: [{ success: false, reason: 'busy_or_done' }],
      };
      browser.runtime.sendMessage.mockResolvedValue(response);

      await expect(sendRegularMessage({ action: 'page-translate' }, {
        returnFailureResponse: true,
      })).resolves.toBe(response);
    });

    it('throws marked transport failures even when resolved failures are enabled', async () => {
      const response = {
        success: false,
        error: 'Content script not available',
        isTransportFailure: true,
        responses: [],
      };
      browser.runtime.sendMessage.mockResolvedValue(response);

      await expect(sendRegularMessage({ action: 'page-translate' }, {
        returnFailureResponse: true,
      })).rejects.toThrow('Content script not available');
    });

    it('does not swallow runtime rejection when resolved failures are enabled', async () => {
      const runtimeError = new Error('Receiving end does not exist');
      browser.runtime.sendMessage.mockRejectedValue(runtimeError);

      await expect(sendRegularMessage({ action: 'page-translate' }, {
        returnFailureResponse: true,
      })).rejects.toBe(runtimeError);
    });

    it('keeps transient receiver failures recoverable for later requests', async () => {
      const runtimeError = new Error('Receiving end does not exist');
      contextCore.isContextError.mockReturnValue(true);
      contextCore.isPermanentContextInvalidation.mockReturnValue(false);
      browser.runtime.sendMessage
        .mockRejectedValueOnce(runtimeError)
        .mockResolvedValueOnce({ success: true, recovered: true });

      const failed = await sendRegularMessage({ action: 'PING', messageId: 'receiver-missing' });
      const recovered = await sendRegularMessage({ action: 'PING', messageId: 'receiver-recovered' });

      expect(failed).toMatchObject({ success: false, isContextInvalidated: false });
      expect(recovered).toEqual({ success: true, recovered: true });
      expect(contextCore.isValidSync).toHaveBeenCalled();
    });

    it('does not swallow timeout when resolved failures are enabled', async () => {
      browser.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

      const promise = sendRegularMessage({ action: 'page-translate' }, {
        returnFailureResponse: true,
        timeout: 100,
      });
      const expectation = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(150);

      await expectation;
    });

    it('does not swallow invalid context when resolved failures are enabled', async () => {
      contextCore.isValidSync.mockReturnValue(false);

      await expect(sendRegularMessage({ action: 'page-translate' }, {
        returnFailureResponse: true,
      })).rejects.toMatchObject({
        type: ErrorTypes.EXTENSION_CONTEXT_INVALIDATED,
      });
    });

    it('reconstructs canonical error identity and drops transport metadata', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        message: 'envelope message',
        type: 'ENVELOPE_TYPE',
        statusCode: 418,
        messageId: 'response-id',
        streaming: true,
        translatedText: 'leak',
        provider: 'top-level-provider',
        sourceLanguage: 'en',
        targetLanguage: 'fa',
        error: {
          message: 'canonical message',
          type: 'API_ERROR',
          originalType: 'HTTP_ERROR',
          statusCode: 503,
          context: 'translation',
          providerName: 'Provider',
          providerId: 'provider-id',
          code: 'UPSTREAM_FAILURE',
          errorCode: 'E_UPSTREAM',
          operationAborted: true,
          cancellationReason: 'operation-abort',
          translationOutcome: { committedParentCount: 1 },
          isFatal: true,
          cancelled: true,
          alreadyHandled: true,
          cause: new Error('unsafe cause'),
          originalError: { message: 'unsafe original' },
          stack: 'unsafe stack',
          arbitrary: { secret: true }
        }
      });

      const rejection = sendRegularMessage({ action: 'TRANSLATE' });
      await expect(rejection).rejects.toThrow('canonical message');
      try {
        await rejection;
      } catch (error) {
        expect(error).toMatchObject({
          message: 'canonical message',
          type: 'API_ERROR',
          originalType: 'HTTP_ERROR',
          statusCode: 503,
          context: 'translation',
          providerName: 'Provider',
          providerId: 'provider-id',
          code: 'UPSTREAM_FAILURE',
          errorCode: 'E_UPSTREAM',
          operationAborted: true,
          cancellationReason: 'operation-abort',
          translationOutcome: { committedParentCount: 1 }
        });
        expect(error).not.toHaveProperty('success');
        expect(error).not.toHaveProperty('messageId');
        expect(error).not.toHaveProperty('streaming');
        expect(error).not.toHaveProperty('translatedText');
        expect(error).not.toHaveProperty('provider');
        expect(error).not.toHaveProperty('sourceLanguage');
        expect(error).not.toHaveProperty('targetLanguage');
        expect(error).not.toHaveProperty('isFatal');
        expect(error).not.toHaveProperty('cancelled');
        expect(error).not.toHaveProperty('isCancelled');
        expect(error).not.toHaveProperty('alreadyHandled');
        expect(error).not.toHaveProperty('cause');
        expect(error).not.toHaveProperty('originalError');
        expect(error).not.toHaveProperty('arbitrary');
      }
    });

    it.each([
      [undefined, 'lifecycle-cleanup'],
      [ErrorTypes.TRANSLATION_TIMEOUT, 'operation-abort'],
    ])('reconstructs %s internal abort provenance from response DTO', async (type, cancellationReason) => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        error: {
          message: 'Translation operation aborted',
          ...(type ? { type } : {}),
          operationAborted: true,
          cancellationReason,
        },
      });

      const rejection = sendRegularMessage({ action: 'TRANSLATE' });
      await expect(rejection).rejects.toMatchObject({
        ...(type ? { type } : {}),
        operationAborted: true,
        cancellationReason,
      });
    });

    it('keeps canonical error fields authoritative over conflicting envelope fields', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        message: 'wrong envelope message',
        type: 'WRONG_ENVELOPE_TYPE',
        statusCode: 401,
        error: {
          message: 'canonical message',
          type: 'API_ERROR',
          statusCode: 503
        }
      });

      const rejection = sendRegularMessage({ action: 'FAIL' });
      await expect(rejection).rejects.toThrow('canonical message');
      await rejection.catch((error) => {
        expect(error.message).toBe('canonical message');
        expect(error.type).toBe('API_ERROR');
        expect(error.statusCode).toBe(503);
      });
    });

    it('reconstructs HTTP 402 as insufficient balance', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        error: 'HTTP 402',
        errorDetails: {
          message: 'HTTP 402',
          type: ErrorTypes.INSUFFICIENT_BALANCE,
          statusCode: 402,
        },
      });

      const rejection = sendRegularMessage({ action: 'TRANSLATE' });
      await expect(rejection).rejects.toMatchObject({
        type: ErrorTypes.INSUFFICIENT_BALANCE,
        statusCode: 402,
      });
    });

    it('reconstructs string response errors', async () => {
      browser.runtime.sendMessage.mockResolvedValue({ success: false, error: 'String failure' });

      await expect(sendRegularMessage({ action: 'FAIL' })).rejects.toThrow('String failure');
    });

    it('reconstructs top-level errorDetails when legacy error is a string', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        error: 'raw legacy provider message',
        errorDetails: {
          message: 'canonical message',
          type: 'MODEL_NOT_FOUND',
          originalType: 'PROVIDER_ERROR',
          statusCode: 404,
          context: 'translate-text',
          providerName: 'Provider',
          providerId: 'provider-id',
          code: 'MODEL_MISSING',
          errorCode: 'E_MODEL',
          translationOutcome: { partial: true },
          arbitrary: { ignored: true }
        }
      });

      const rejection = sendRegularMessage({ action: 'TRANSLATE_TEXT' });
      await expect(rejection).rejects.toThrow('canonical message');
      await rejection.catch((error) => {
        expect(error).toMatchObject({
          message: 'canonical message',
          type: 'MODEL_NOT_FOUND',
          originalType: 'PROVIDER_ERROR',
          statusCode: 404,
          context: 'translate-text',
          providerName: 'Provider',
          providerId: 'provider-id',
          code: 'MODEL_MISSING',
          errorCode: 'E_MODEL',
          translationOutcome: { partial: true }
        });
        expect(error.message).not.toBe('raw legacy provider message');
        expect(error).not.toHaveProperty('arbitrary');
      });
    });

    it('reconstructs errorDetails when no legacy error is present', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        errorDetails: {
          message: 'canonical failure',
          type: 'NETWORK_ERROR',
          statusCode: 503
        }
      });

      await expect(sendRegularMessage({ action: 'TRANSLATE_TEXT' })).rejects.toMatchObject({
        message: 'canonical failure',
        type: 'NETWORK_ERROR',
        statusCode: 503
      });
    });

    it('keeps canonical errorDetails authoritative over structured response.error', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        error: {
          message: 'response error',
          type: 'RESPONSE_ERROR',
          statusCode: 400
        },
        errorDetails: {
          message: 'secondary details',
          type: 'DETAILS_ERROR',
          statusCode: 500,
          providerName: 'Provider',
          translationOutcome: { partial: true }
        }
      });

      await expect(sendRegularMessage({ action: 'TRANSLATE_TEXT' })).rejects.toMatchObject({
        message: 'secondary details',
        type: 'DETAILS_ERROR',
        statusCode: 500,
        providerName: 'Provider',
        translationOutcome: { partial: true }
      });
    });

    it('preserves an empty canonical errorDetails message over legacy error', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        error: { message: 'legacy failure', type: 'LEGACY_ERROR' },
        errorDetails: { message: '', type: 'PROVIDER_ERROR' }
      });

      await expect(sendRegularMessage({ action: 'TRANSLATE_TEXT' })).rejects.toMatchObject({
        message: '',
        type: 'PROVIDER_ERROR'
      });
    });

    it('preserves an empty message in details-only failures', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        errorDetails: { message: '', type: 'PROVIDER_ERROR' }
      });

      await expect(sendRegularMessage({ action: 'TRANSLATE_TEXT' })).rejects.toMatchObject({
        message: '',
        type: 'PROVIDER_ERROR'
      });
    });

    it('preserves an empty message from an object-valued legacy error', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        error: { message: '', type: 'PROVIDER_ERROR' }
      });

      await expect(sendRegularMessage({ action: 'TRANSLATE_TEXT' })).rejects.toMatchObject({
        message: '',
        type: 'PROVIDER_ERROR'
      });
    });

    it('falls back to legacy error when errorDetails is malformed', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        error: 'legacy failure',
        errorDetails: { arbitrary: true }
      });

      await expect(sendRegularMessage({ action: 'TRANSLATE_TEXT' })).rejects.toMatchObject({
        message: 'legacy failure'
      });
    });

    it.each([
      ['object error', { error: 'nested error' }, 'nested error'],
      ['object reason', { reason: 'reason failure' }, 'reason failure'],
      ['object statusText', { statusText: 'status failure' }, 'status failure'],
      ['top-level message', {}, 'top-level failure', { message: 'top-level failure' }],
      ['top-level statusText', {}, 'status failure', { statusText: 'status failure' }]
    ])('preserves %s message fallback', async (_name, error, expected, envelope = {}) => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        ...envelope,
        error
      });

      await expect(sendRegularMessage({ action: 'FAIL' })).rejects.toThrow(expected);
    });

    it('uses technical fallback for missing or malformed errors', async () => {
      browser.runtime.sendMessage
        .mockResolvedValueOnce({
          success: false,
          error: { arbitrary: { nested: true }, partialResults: ['unsafe'] }
        })
        .mockResolvedValueOnce({ success: false });

      const malformedRejection = sendRegularMessage({ action: 'FAIL' });
      await expect(malformedRejection).rejects.toThrow('Unknown technical error');
      await malformedRejection.catch((error) => {
        expect(error).not.toHaveProperty('arbitrary');
        expect(error).not.toHaveProperty('partialResults');
      });

      await expect(sendRegularMessage({ action: 'FAIL' })).rejects.toThrow('Unknown technical error');
    });

    it('preserves live-dubbing START failure structure on the thrown error', async () => {
      const failure = {
        success: false,
        error: 'LIVE_DUBBING_START_FAILED',
        retryable: true,
        cleanupPending: true,
        status: {
          sessionId: 'session-1',
          tabId: 42,
          providerId: 'gemini',
          targetLanguage: 'en',
          status: 'ERROR',
          startedAt: 1,
          lastError: 'LIVE_DUBBING_START_FAILED',
          eventSequence: 2,
          streamId: 'secret-stream',
          bootstrap: { secret: 'secret-bootstrap' },
        },
        streamId: 'secret-stream',
        transcript: 'secret words',
        arbitrary: { nested: 'drop me' },
      };
      browser.runtime.sendMessage.mockResolvedValue(failure);

      const rejection = sendRegularMessage({ action: 'START_LIVE_DUBBING' });
      await expect(rejection).rejects.toThrow('LIVE_DUBBING_START_FAILED');
      await rejection.catch((error) => {
        expect(error.data).toMatchObject({
          success: false,
          error: 'LIVE_DUBBING_START_FAILED',
          retryable: true,
          cleanupPending: true,
          status: {
            sessionId: 'session-1',
            tabId: 42,
            providerId: 'gemini',
            targetLanguage: 'en',
            status: 'ERROR',
            startedAt: 1,
            lastError: 'LIVE_DUBBING_START_FAILED',
            eventSequence: 2,
          },
        });
        expect(error.data.status).not.toHaveProperty('streamId');
        expect(error.data.status).not.toHaveProperty('bootstrap');
        expect(error.data).not.toHaveProperty('streamId');
        expect(error.data).not.toHaveProperty('transcript');
        expect(error.data).not.toHaveProperty('arbitrary');
        expect(JSON.stringify(error.data)).not.toContain('secret');
      });
    });

    it('never forwards providerDiagnostic values into live-dubbing error.data', async () => {
      // code/terminalCategory are open provider vocabulary with no closed
      // canonical token enum, so even pattern-valid secret-shaped strings
      // must not cross; the popup keys guidance off lastError + providerId.
      const failure = {
        success: false,
        error: 'LIVE_DUBBING_START_FAILED',
        retryable: true,
        cleanupPending: true,
        status: {
          sessionId: 'session-1',
          tabId: 42,
          providerId: 'gemini',
          targetLanguage: 'en',
          status: 'ERROR',
          startedAt: 1,
          lastError: 'LIVE_DUBBING_START_FAILED',
          eventSequence: 2,
        },
        providerDiagnostic: {
          stage: 'secret-stage-value',
          code: 'sk-secret-value',
          closeCode: 1006,
          wasClean: false,
          terminalCategory: 'raw-provider-payload',
          malformedAt: 'JSON_PARSE',
          wsOpen: true,
          setupSent: true,
          setupComplete: false,
        },
      };
      browser.runtime.sendMessage.mockResolvedValue(failure);

      const rejection = sendRegularMessage({ action: 'START_LIVE_DUBBING' });
      await expect(rejection).rejects.toThrow('LIVE_DUBBING_START_FAILED');
      await rejection.catch((error) => {
        expect(error.data).not.toHaveProperty('providerDiagnostic');
        expect(JSON.stringify(error.data)).not.toContain('secret-stage-value');
        expect(JSON.stringify(error.data)).not.toContain('sk-secret-value');
        expect(JSON.stringify(error.data)).not.toContain('raw-provider-payload');
        // Lifecycle fields still survive alongside the omission.
        expect(error.data).toMatchObject({
          success: false,
          error: 'LIVE_DUBBING_START_FAILED',
          retryable: true,
          cleanupPending: true,
          status: { sessionId: 'session-1', status: 'ERROR' },
        });
      });
    });

    it('preserves live-dubbing STOP failure structure across aliases', async () => {
      const failure = {
        success: false,
        error: 'STOP_FAILED',
        retryable: true,
        cleanupPending: true,
        status: {
          sessionId: 'session-1',
          tabId: 42,
          providerId: 'openai',
          targetLanguage: 'en-US',
          status: 'STOPPING',
          startedAt: 1,
          lastError: 'STOP_FAILED',
          eventSequence: 3,
        },
      };
      browser.runtime.sendMessage.mockResolvedValue(failure);

      await expect(sendRegularMessage({ action: 'LIVE_DUBBING_STOP' }))
        .rejects.toMatchObject({
          message: 'STOP_FAILED',
          data: {
            success: false,
            error: 'STOP_FAILED',
            retryable: true,
            cleanupPending: true,
            status: { sessionId: 'session-1', status: 'STOPPING' },
          },
        });
    });

    it('attaches no failure context to non-live-dubbing actions', async () => {
      browser.runtime.sendMessage.mockResolvedValue({
        success: false,
        error: 'Some failure',
        retryable: true,
        status: { sessionId: 'unrelated' },
      });

      await sendRegularMessage({ action: 'FAIL' }).catch((error) => {
        expect(error.message).toBe('Some failure');
        expect(error).not.toHaveProperty('data');
      });
    });

    it('returns restricted-page failures unchanged', async () => {
      const response = {
        success: false,
        isRestrictedPage: true,
        error: { message: 'restricted' },
        arbitrary: { preserved: true }
      };
      browser.runtime.sendMessage.mockResolvedValue(response);

      await expect(sendRegularMessage({ action: 'FAIL' })).resolves.toBe(response);
    });

    it('leaves rejected runtime errors unchanged', async () => {
      const runtimeError = Object.assign(new Error('Runtime failed'), {
        type: 'RUNTIME_ERROR',
        arbitrary: { preserved: true }
      });
      browser.runtime.sendMessage.mockRejectedValue(runtimeError);

      await expect(sendRegularMessage({ action: 'FAIL' })).rejects.toBe(runtimeError);
    });

    it('maps explicit cancelled lifecycle state to USER_CANCELLED before sending', async () => {
      const { streamingTimeoutManager } = await import('./StreamingTimeoutManager.js');
      streamingTimeoutManager.shouldContinue.mockReturnValue(false);
      streamingTimeoutManager.getOperationState.mockReturnValue({
        isCancelled: true,
        hasTimedOut: false,
        isCompleted: false
      });

      try {
        await expect(sendRegularMessage({ action: 'TRANSLATE', messageId: 'cancelled' }))
          .rejects.toMatchObject({ type: ErrorTypes.USER_CANCELLED });
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
      } finally {
        streamingTimeoutManager.shouldContinue.mockReturnValue(true);
        streamingTimeoutManager.getOperationState.mockReturnValue(null);
      }
    });

    it('maps explicit timed-out lifecycle state to TRANSLATION_TIMEOUT before sending', async () => {
      const { streamingTimeoutManager } = await import('./StreamingTimeoutManager.js');
      streamingTimeoutManager.shouldContinue.mockReturnValue(false);
      streamingTimeoutManager.getOperationState.mockReturnValue({
        isCancelled: false,
        hasTimedOut: true,
        isCompleted: false
      });

      try {
        await expect(sendRegularMessage({ action: 'TRANSLATE', messageId: 'timed-out' }))
          .rejects.toMatchObject({ type: ErrorTypes.TRANSLATION_TIMEOUT });
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
      } finally {
        streamingTimeoutManager.shouldContinue.mockReturnValue(true);
        streamingTimeoutManager.getOperationState.mockReturnValue(null);
      }
    });

    it('does not fabricate terminal identity for unknown lifecycle state', async () => {
      const { streamingTimeoutManager } = await import('./StreamingTimeoutManager.js');
      streamingTimeoutManager.shouldContinue.mockReturnValue(false);
      streamingTimeoutManager.getOperationState.mockReturnValue(null);
      const response = { success: true, data: 'continued' };
      browser.runtime.sendMessage.mockResolvedValue(response);

      try {
        await expect(sendRegularMessage({ action: 'TRANSLATE', messageId: 'unknown-state' }))
          .resolves.toBe(response);
      } finally {
        streamingTimeoutManager.shouldContinue.mockReturnValue(true);
      }
    });

    it('maps explicit timed-out lifecycle state during polling', async () => {
      const { streamingTimeoutManager } = await import('./StreamingTimeoutManager.js');
      streamingTimeoutManager.shouldContinue
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);
      streamingTimeoutManager.getOperationState.mockReturnValue({
        isCancelled: false,
        hasTimedOut: true,
        isCompleted: false
      });
      browser.runtime.sendMessage.mockReturnValue(new Promise(() => {}));

      try {
        const promise = sendRegularMessage({ action: 'TRANSLATE', messageId: 'poll-timeout' });
        const expectation = expect(promise).rejects.toMatchObject({ type: ErrorTypes.TRANSLATION_TIMEOUT });
        await vi.advanceTimersByTimeAsync(50);

        await expectation;
      } finally {
        streamingTimeoutManager.shouldContinue.mockReturnValue(true);
        streamingTimeoutManager.getOperationState.mockReturnValue(null);
      }
    });

    it('should throw if extension context is invalidated', async () => {
      contextCore.isValidSync.mockReturnValue(false);
      const message = { action: 'PING' };

      await expect(sendRegularMessage(message)).rejects.toThrow('Extension context invalidated');
    });
  });

  describe('sendMessage (Unified Routing)', () => {
    it('should route non-translation actions directly to sendRegularMessage', async () => {
      const message = { action: 'GET_SETTINGS' };
      browser.runtime.sendMessage.mockResolvedValue({ success: true });

      await sendMessage(message);

      expect(browser.runtime.sendMessage).toHaveBeenCalled();
    });

    it('preserves typed user cancellation from the coordinator', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const cancellation = Object.assign(new Error('Translation cancelled by user'), {
        type: ErrorTypes.USER_CANCELLED,
      });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(cancellation);

      await expect(sendMessage({ action: 'TRANSLATE', messageId: 'cancelled' }))
        .rejects.toBe(cancellation);
      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('propagates internal operation abort without creating fallback work', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const operationAbort = Object.assign(new Error('Translation operation aborted'), {
        operationAborted: true,
        cancellationReason: 'document-replaced',
      });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(operationAbort);

      const rejection = sendMessage({ action: 'TRANSLATE', messageId: 'document-replaced' });
      await expect(rejection).rejects.toBe(operationAbort);
      await rejection.catch((error) => {
        expect(error).toMatchObject({
          operationAborted: true,
          cancellationReason: 'document-replaced',
        });
      });
      expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ messageId: expect.stringMatching(/^fb-/) })
      );
    });

    it('does not fabricate cancellation for a generic coordinator failure', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const { streamingTimeoutManager } = await import('./StreamingTimeoutManager.js');
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(new Error('generic failure'));
      streamingTimeoutManager.shouldContinue.mockReturnValue(true);
      browser.runtime.sendMessage.mockResolvedValue({ success: true, fallback: true });

      await expect(sendMessage({ action: 'TRANSLATE', messageId: 'completed' }))
        .resolves.toMatchObject({ success: true, fallback: true });
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: expect.stringMatching(/^fb-/) })
      );
    });

    it.each(['fb-generated', 'fallback-legacy'])(
      'does not probe status for fallback request ID %s',
      async (messageId) => {
        const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
        const timeout = Object.assign(new Error('Translation timed out'), {
          type: ErrorTypes.TRANSLATION_TIMEOUT,
        });
        unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(timeout);
        browser.runtime.sendMessage.mockResolvedValue({ success: true, recovered: true });

        await expect(sendMessage({ action: 'TRANSLATE', messageId }))
          .resolves.toMatchObject({ success: true, recovered: true });

        expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: 'CHECK_TRANSLATION_STATUS' }),
        );
      },
    );

    it('does not fallback after terminal rate limit for an explicit provider', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const terminalError = Object.assign(new Error('Rate limit exhausted'), {
        type: ErrorTypes.RATE_LIMIT_REACHED,
        statusCode: 429,
        providerName: 'OpenAI',
        errorDetails: { retryable: false },
      });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(terminalError);

      const message = {
        action: 'TRANSLATE',
        messageId: 'openai-rate-limit',
        data: { provider: 'openai', text: 'Test' },
      };

      await expect(sendMessage(message)).rejects.toBe(terminalError);
      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('does not start fallback operation for terminal SERVER_ERROR', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const serverError = Object.assign(new Error('HTTP 500'), {
        type: ErrorTypes.SERVER_ERROR,
        statusCode: 500,
      });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(serverError);

      await expect(sendMessage({ action: 'TRANSLATE', messageId: 'server-error' }))
        .rejects.toBe(serverError);
      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it.each([ErrorTypes.TEXT_EMPTY, ErrorTypes.TEXT_TOO_LONG])(
      'propagates deterministic %s without fallback',
      async (errorType) => {
        const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
        const deterministicError = Object.assign(new Error(errorType), { type: errorType });
        unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(deterministicError);

        await expect(sendMessage({ action: 'TRANSLATE', messageId: `local-${errorType}` }))
          .rejects.toBe(deterministicError);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
      },
    );

    it.each([400, 422])(
      'does not fallback for deterministic HTTP_ERROR %s',
      async (statusCode) => {
        const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
        const deterministicError = Object.assign(new Error(`HTTP ${statusCode}`), {
          type: ErrorTypes.HTTP_ERROR,
          statusCode,
        });
        unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(deterministicError);

        await expect(sendMessage({ action: 'TRANSLATE', messageId: `http-${statusCode}` }))
          .rejects.toBe(deterministicError);
        expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
      },
    );

    it.each([
      [400, 'request is too long'],
      [422, 'maximum context length exceeded'],
      [413, 'Payload Too Large'],
    ])('does not fallback for request-size HTTP_ERROR %s', async (statusCode, message) => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const requestSizeError = Object.assign(new Error(message), {
        type: ErrorTypes.HTTP_ERROR,
        statusCode,
      });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(requestSizeError);

      await expect(sendMessage({ action: 'TRANSLATE', messageId: `size-${statusCode}` }))
        .rejects.toBe(requestSizeError);
      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('keeps HTTP_ERROR 409 fallback-eligible', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const conflictError = Object.assign(new Error('Conflict'), {
        type: ErrorTypes.HTTP_ERROR,
        statusCode: 409,
      });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(conflictError);
      browser.runtime.sendMessage.mockResolvedValue({ success: true, recovered: true });

      await expect(sendMessage({ action: 'TRANSLATE', messageId: 'http-409' }))
        .resolves.toMatchObject({ success: true, recovered: true });
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: expect.stringMatching(/^fb-/) }),
      );
    });

    it.each([
      ErrorTypes.INVALID_REQUEST,
      ErrorTypes.API_ENDPOINT_INVALID,
      ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED,
    ])('keeps fatal %s fallback-terminal', async (errorType) => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const fatalError = Object.assign(new Error(errorType), { type: errorType });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(fatalError);

      await expect(sendMessage({ action: 'TRANSLATE', messageId: `fatal-${errorType}` }))
        .rejects.toBe(fatalError);
      expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('probes status and falls back for typed TRANSLATION_TIMEOUT', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const timeout = Object.assign(new Error('Translation timed out'), {
        type: ErrorTypes.TRANSLATION_TIMEOUT,
      });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(timeout);
      browser.runtime.sendMessage
        .mockResolvedValueOnce({ completed: false })
        .mockResolvedValueOnce({ success: true, recovered: true });

      await expect(sendMessage({ action: 'TRANSLATE', messageId: 'timeout' }))
        .resolves.toMatchObject({ success: true, recovered: true });
      expect(browser.runtime.sendMessage).toHaveBeenNthCalledWith(1, {
        action: 'CHECK_TRANSLATION_STATUS',
        data: { messageId: 'timeout' }
      });
    });

    it('preserves authoritative timeout over incidental operation abort metadata', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const timeout = Object.assign(new Error('Translation timed out'), {
        type: ErrorTypes.TRANSLATION_TIMEOUT,
        operationAborted: true,
        cancellationReason: 'operation-abort',
      });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(timeout);
      browser.runtime.sendMessage
        .mockResolvedValueOnce({ completed: false })
        .mockResolvedValueOnce({ success: true, recovered: true });

      await expect(sendMessage({ action: 'TRANSLATE', messageId: 'timeout-with-abort' }))
        .resolves.toMatchObject({ success: true, recovered: true });
      expect(browser.runtime.sendMessage).toHaveBeenNthCalledWith(1, {
        action: 'CHECK_TRANSLATION_STATUS',
        data: { messageId: 'timeout-with-abort' }
      });
    });

    it('probes status and falls back for typed OPERATION_TIMEOUT', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const timeout = Object.assign(new Error('Operation timed out'), {
        type: ErrorTypes.OPERATION_TIMEOUT,
      });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(timeout);
      browser.runtime.sendMessage
        .mockResolvedValueOnce({ completed: false })
        .mockResolvedValueOnce({ success: true, recovered: true });

      await expect(sendMessage({ action: 'TRANSLATE', messageId: 'operation-timeout' }))
        .resolves.toMatchObject({ success: true, recovered: true });
      expect(browser.runtime.sendMessage).toHaveBeenNthCalledWith(1, {
        action: 'CHECK_TRANSLATION_STATUS',
        data: { messageId: 'operation-timeout' }
      });
    });

    it('does not probe status for explicit NETWORK_ERROR timeout wording', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      const networkError = Object.assign(new Error('upstream request timed out'), {
        type: ErrorTypes.NETWORK_ERROR,
      });
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(networkError);
      browser.runtime.sendMessage.mockResolvedValue({ success: true, recovered: true });

      await expect(sendMessage({ action: 'TRANSLATE', messageId: 'network-timeout-wording' }))
        .resolves.toMatchObject({ success: true, recovered: true });
      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CHECK_TRANSLATION_STATUS' })
      );
    });

    it('probes status for an untyped legacy timeout', async () => {
      const { unifiedTranslationCoordinator } = await import('./UnifiedTranslationCoordinator.js');
      unifiedTranslationCoordinator.coordinateTranslation.mockRejectedValueOnce(
        new Error('Translation timed out')
      );
      browser.runtime.sendMessage.mockResolvedValueOnce({
        completed: true,
        results: ['recovered']
      });

      await expect(sendMessage({ action: 'TRANSLATE', messageId: 'legacy-timeout' }))
        .resolves.toEqual(['recovered']);
      expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'CHECK_TRANSLATION_STATUS',
        data: { messageId: 'legacy-timeout' }
      });
    });
  });
});
