import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTranslateText } from './handleTranslateText.js';
import { unifiedTranslationService } from '@/core/services/translation/UnifiedTranslationService.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessageHandler } from '@/shared/messaging/core/MessageHandler.js';
import { CONFIG } from '@/shared/config/config.js';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  })
}));

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: class {
    handle = vi.fn();
  }
}));

vi.mock('@/core/services/translation/UnifiedTranslationService.js', () => ({
  unifiedTranslationService: {
    handleTranslationRequest: vi.fn()
  }
}));

describe('handleTranslateText', () => {
  const message = {
    action: 'TRANSLATE_TEXT',
    messageId: 'msg-1',
    data: { text: 'Hello', from: 'en', to: 'fa' }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('backgroundService', { translationEngine: {} });
  });

  function routeMessage(action = MessageActions.TRANSLATE_TEXT) {
    const messageHandler = new MessageHandler();
    const sendResponse = vi.fn();
    messageHandler.registerHandler(action, handleTranslateText);

    const routedResponse = messageHandler._handleMessage(
      { ...message, action },
      { id: 'sender' },
      sendResponse,
    );

    return { routedResponse, sendResponse };
  }

  it.each(['', ' ', '\n', '\t', ' \n\t '])('returns TEXT_EMPTY for scalar %j', async (text) => {
    const response = await handleTranslateText({
      ...message,
      data: { ...message.data, text },
    });

    expect(response.errorDetails.type).toBe(ErrorTypes.TEXT_EMPTY);
    expect(unifiedTranslationService.handleTranslationRequest).not.toHaveBeenCalled();
  });

  it('uses the configured global provider when no provider is supplied', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({ success: true, translatedText: 'שלום' });

    await handleTranslateText(message);

    expect(unifiedTranslationService.handleTranslationRequest.mock.calls[0][0].data.provider).toBe(CONFIG.TRANSLATION_API);
  });

  it.each([
    ['null text', { text: null }],
    ['missing text', {}],
  ])('preserves generic malformed behavior for %s', async (_label, data) => {
    const response = await handleTranslateText({
      ...message,
      data: { ...data, from: 'en', to: 'fa' },
    });

    expect(response.errorDetails.type).not.toBe(ErrorTypes.TEXT_EMPTY);
    expect(unifiedTranslationService.handleTranslationRequest).not.toHaveBeenCalled();
  });

  it('keeps legacy error string and adds sanitized canonical identity', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: false,
      error: {
        message: 'Provider failed',
        type: 'PROVIDER_ERROR',
        originalType: 'HTTP_ERROR',
        statusCode: 503,
        context: 'translate-text',
        providerName: 'Provider',
        providerId: 'provider-id',
        code: 'UPSTREAM_FAILURE',
        errorCode: 'E_UPSTREAM',
        translationOutcome: { partial: true },
        cause: 'private',
        arbitrary: { ignored: true }
      }
    });

    const response = await handleTranslateText(message);

    expect(response).toMatchObject({ success: false, error: 'Provider failed' });
    expect(response.errorDetails).toMatchObject({
      message: 'Provider failed',
      type: 'PROVIDER_ERROR',
      originalType: 'HTTP_ERROR',
      statusCode: 503,
      context: 'translate-text',
      providerName: 'Provider',
      providerId: 'provider-id',
      code: 'UPSTREAM_FAILURE',
      errorCode: 'E_UPSTREAM',
      translationOutcome: { partial: true }
    });
    expect(response.errorDetails).not.toHaveProperty('cause');
    expect(response.errorDetails).not.toHaveProperty('arbitrary');
  });

  it('keeps string-only result failures compatible', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: false,
      error: 'legacy failure'
    });

    const response = await handleTranslateText(message);

    expect(response).toEqual({
      success: false,
      error: 'Translation failed',
      errorDetails: {
        message: 'Translation failed',
        type: 'UNKNOWN'
      }
    });
  });

  it('preserves canonical identity when legacy and canonical failures conflict', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: false,
      error: {
        message: 'legacy failure',
        type: 'LEGACY_ERROR',
        context: 'legacy-context',
      },
      errorDetails: {
        message: 'canonical failure',
        type: 'API_ERROR',
        statusCode: 503,
        code: 'UPSTREAM_FAILURE',
        context: 'canonical-context',
        cause: 'private',
        arbitrary: { ignored: true },
      },
    });

    const response = await handleTranslateText(message);

    expect(response).toMatchObject({
      success: false,
      error: 'legacy failure',
      errorDetails: {
        message: 'canonical failure',
        type: 'API_ERROR',
        statusCode: 503,
        code: 'UPSTREAM_FAILURE',
        context: 'canonical-context',
      },
    });
    expect(response.errorDetails).not.toHaveProperty('cause');
    expect(response.errorDetails).not.toHaveProperty('arbitrary');
  });

  it('preserves canonical details for details-only failures', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: false,
      errorDetails: {
        message: 'Canonical failure',
        type: 'API_ERROR',
        statusCode: 503,
        code: 'UPSTREAM_FAILURE',
      },
    });

    await expect(handleTranslateText(message)).resolves.toMatchObject({
      success: false,
      error: 'Translation failed',
      errorDetails: {
        message: 'Canonical failure',
        type: 'API_ERROR',
        statusCode: 503,
        code: 'UPSTREAM_FAILURE',
      },
    });
  });

  it('falls back to legacy error when errorDetails is malformed', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: false,
      error: {
        message: 'Legacy failure',
        type: 'NETWORK_ERROR',
      },
      errorDetails: { arbitrary: true },
    });

    await expect(handleTranslateText(message)).resolves.toMatchObject({
      success: false,
      error: 'Legacy failure',
      errorDetails: {
        message: 'Legacy failure',
        type: 'NETWORK_ERROR',
      },
    });
  });

  it('adds canonical identity to catch failures without changing message', async () => {
    const error = new Error('Transport failed');
    error.type = 'NETWORK_ERROR';
    error.statusCode = 503;
    error.providerName = 'Provider';
    error.cause = 'private';
    error.arbitrary = { ignored: true };
    unifiedTranslationService.handleTranslationRequest.mockRejectedValue(error);

    const response = await handleTranslateText(message);

    expect(response.error).toBe('Transport failed');
    expect(response.errorDetails).toMatchObject({
      message: 'Transport failed',
      type: 'NETWORK_ERROR',
      statusCode: 503,
      providerName: 'Provider'
    });
    expect(response.errorDetails).not.toHaveProperty('cause');
    expect(response.errorDetails).not.toHaveProperty('arbitrary');
  });

  it('keeps success response unchanged', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: true,
      translatedText: 'سلام',
      provider: 'Provider',
      sourceLanguage: 'en',
      targetLanguage: 'fa'
    });

    await expect(handleTranslateText(message)).resolves.toEqual({
      success: true,
      translation: 'سلام',
      provider: 'Provider',
      sourceLanguage: 'en',
      targetLanguage: 'fa'
    });
  });

  it('routes the final success response through MessageHandler without ACK', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: true,
      translatedText: 'سلام',
      provider: 'Provider',
      sourceLanguage: 'en',
      targetLanguage: 'fa'
    });

    const { routedResponse, sendResponse } = routeMessage();

    await expect(routedResponse).resolves.toEqual({
      success: true,
      translation: 'سلام',
      provider: 'Provider',
      sourceLanguage: 'en',
      targetLanguage: 'fa'
    });
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('routes provider failures without ACK masking', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: false,
      error: { message: 'Provider failed', type: 'PROVIDER_ERROR' }
    });

    const { routedResponse, sendResponse } = routeMessage();

    await expect(routedResponse).resolves.toMatchObject({
      success: false,
      error: 'Provider failed',
      errorDetails: {
        message: 'Provider failed',
        type: 'PROVIDER_ERROR'
      }
    });
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('routes timeout classification without ACK masking', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: false,
      error: {
        message: 'Translation timed out',
        type: ErrorTypes.TRANSLATION_TIMEOUT
      }
    });

    const { routedResponse, sendResponse } = routeMessage();

    await expect(routedResponse).resolves.toMatchObject({
      success: false,
      error: 'Translation timed out',
      errorDetails: {
        message: 'Translation timed out',
        type: ErrorTypes.TRANSLATION_TIMEOUT
      }
    });
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('routes user cancellation classification without ACK masking', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: false,
      error: {
        message: 'Translation cancelled by user',
        type: ErrorTypes.USER_CANCELLED
      }
    });

    const { routedResponse, sendResponse } = routeMessage();

    await expect(routedResponse).resolves.toMatchObject({
      success: false,
      error: 'Translation cancelled by user',
      errorDetails: {
        message: 'Translation cancelled by user',
        type: ErrorTypes.USER_CANCELLED
      }
    });
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('does not let a streaming-shaped final result restore callback ownership', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: true,
      streaming: true,
      messageId: message.messageId,
      translatedText: 'سلام طولانی',
      provider: 'Provider',
      sourceLanguage: 'en',
      targetLanguage: 'fa'
    });

    const { routedResponse, sendResponse } = routeMessage();

    await expect(routedResponse).resolves.toEqual({
      success: true,
      translation: 'سلام طولانی',
      provider: 'Provider',
      sourceLanguage: 'en',
      targetLanguage: 'fa'
    });
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('keeps the legacy translateText alias on the final-response contract', async () => {
    unifiedTranslationService.handleTranslationRequest.mockResolvedValue({
      success: true,
      translatedText: 'سلام',
      provider: 'Provider',
      sourceLanguage: 'en',
      targetLanguage: 'fa'
    });

    const { routedResponse, sendResponse } = routeMessage('translateText');

    await expect(routedResponse).resolves.toMatchObject({
      success: true,
      translation: 'سلام'
    });
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
