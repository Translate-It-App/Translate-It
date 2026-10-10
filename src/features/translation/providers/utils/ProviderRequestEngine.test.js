import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Mock dependencies at TOP LEVEL (hoisted)
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getBrowserInfo: vi.fn() },
    storage: { local: { get: vi.fn(), set: vi.fn() } }
  }
}));

vi.mock('../ApiKeyManager.js', () => ({
  ApiKeyManager: {
    getKeys: vi.fn(),
    promoteKey: vi.fn(),
    shouldFailover: vi.fn(),
  }
}));

vi.mock('@/shared/proxy/ProxyManager.js', () => ({
  proxyManager: {
    fetch: vi.fn(),
  }
}));

vi.mock('../../core/TranslationStatsManager.js', () => ({
  statsManager: {
    recordRequest: vi.fn(() => ({ globalCallId: 1, sessionCallId: 1 })),
    recordError: vi.fn(),
  }
}));

vi.mock('@/features/translation/core/RateLimitManager.js', () => ({
  rateLimitManager: {
    waitForCooldown: vi.fn().mockResolvedValue(),
    notifyRateLimit: vi.fn(),
  },
}));

// Mock browser compatibility to avoid real navigator/UA calls
vi.mock('@/utils/browser/compatibility.js', () => ({
  getBrowserInfoSync: vi.fn(() => ({ isFirefox: false, isMobile: false })),
  detectOS: vi.fn(() => 'LINUX'),
  OS_PLATFORMS: {
    MAC: 'MAC',
    WINDOWS: 'WINDOWS',
    LINUX: 'LINUX',
    UNKNOWN: 'UNKNOWN'
  }
}));

import { ProviderRequestEngine } from './ProviderRequestEngine.js';
import { TranslationCallPurpose } from '../ProviderConstants.js';
import { ApiKeyManager } from '../ApiKeyManager.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { getBrowserInfoSync } from '@/utils/browser/compatibility.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { rateLimitManager } from '@/features/translation/core/RateLimitManager.js';

const createProxyConfig = (host = 'proxy.test') => ({
  enabled: true,
  type: 'http',
  host,
  port: 8080,
  auth: { username: `${host}-user`, password: `${host}-password` },
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const createMalformedJsonResponse = (status = 200, withClone = true) => {
  const createResponse = () => {
    const response = {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : `HTTP ${status}`,
      headers: new Map([['content-type', 'application/json']]),
      json: vi.fn(async () => {
        throw new SyntaxError('Unexpected token in JSON');
      }),
    };

    if (withClone) response.clone = createResponse;
    return response;
  };

  return createResponse();
};

describe('ProviderRequestEngine', () => {
  const mockProvider = {
    providerName: 'TestProvider',
    providerSettingKey: 'test_key_setting',
    _initializeProxy: vi.fn().mockResolvedValue(createProxyConfig()),
  };

  const mockExtractResponse = vi.fn((data) => data.translated);

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider._initializeProxy.mockReset().mockResolvedValue(createProxyConfig());
    delete mockProvider.classifyProviderHttpError;
    delete mockProvider.shouldFailoverApiKey;
    delete mockProvider.isApiKeyCandidateEligible;
    delete mockProvider.constructor;
  });

  describe('successful JSON response classification', () => {
    it.each([true, false])('classifies malformed successful JSON with clone=%s', async (withClone) => {
      proxyManager.fetch.mockResolvedValue(createMalformedJsonResponse(200, withClone));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        extractResponse: mockExtractResponse,
        context: 'json-parse-test',
      }).catch(value => value);

      expect(error).toMatchObject({
        message: 'Provider response contains invalid JSON',
        type: ErrorTypes.JSON_PARSING_ERROR,
        statusCode: 200,
        context: 'json-parse-test',
        providerName: 'TestProvider',
      });
      expect(mockExtractResponse).not.toHaveBeenCalled();
    });

    it.each([
      [400, ErrorTypes.HTTP_ERROR],
      [401, ErrorTypes.API_KEY_INVALID],
      [429, ErrorTypes.RATE_LIMIT_REACHED],
      [500, ErrorTypes.SERVER_ERROR],
    ])('preserves HTTP %s classification with malformed JSON body', async (status, type) => {
      proxyManager.fetch.mockResolvedValue(createMalformedJsonResponse(status));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        extractResponse: mockExtractResponse,
        context: 'malformed-http-body-test',
      }).catch(value => value);

      expect(error).toMatchObject({
        type,
        statusCode: status,
        context: 'malformed-http-body-test',
        providerName: 'TestProvider',
      });
    });
  });

  describe('HTTP error classification hook', () => {
    const httpErrorResponse = (body, status = 400, statusText = 'Bad Request', extraHeaders = {}) => ({
      ok: false,
      status,
      statusText,
      headers: new Map([
        ['content-type', 'application/json'],
        ...Object.entries(extraHeaders),
      ]),
      json: async () => body,
      clone() { return this; },
    });

    it('reports physical AI 429 before key failover can consume it, and waits before fetch', async () => {
      mockProvider.constructor = { isAI: true };
      const pendingCooldown = deferred();
      rateLimitManager.waitForCooldown.mockReturnValueOnce(pendingCooldown.promise);
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({}, 429, 'Too Many Requests', { 'Retry-After': '5' }));
      const controller = new AbortController();
      const request = ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com', fetchOptions: { headers: {} }, abortController: controller,
      });
      await Promise.resolve(); await Promise.resolve();
      expect(rateLimitManager.waitForCooldown).toHaveBeenCalledWith('TestProvider', controller.signal);
      expect(proxyManager.fetch).not.toHaveBeenCalled();
      pendingCooldown.resolve();
      await expect(request).rejects.toMatchObject({ type: ErrorTypes.RATE_LIMIT_REACHED });
      expect(rateLimitManager.notifyRateLimit).toHaveBeenCalledWith('TestProvider', expect.objectContaining({
        type: ErrorTypes.RATE_LIMIT_REACHED, statusCode: 429, retryAt: expect.any(Number),
      }));
    });

    it('does not publish a non-rate-limit AI HTTP error as a cooldown', async () => {
      mockProvider.constructor = { isAI: true };
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({}, 401, 'Unauthorized'));
      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com', fetchOptions: { headers: {} },
      })).rejects.toMatchObject({ type: ErrorTypes.API_KEY_INVALID });
      expect(rateLimitManager.notifyRateLimit).not.toHaveBeenCalled();
    });

    it('normalizes Retry-After seconds on canonical rate-limit errors', async () => {
      vi.useFakeTimers();
      const now = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(now);
      proxyManager.fetch.mockResolvedValue(
        httpErrorResponse({}, 429, 'Too Many Requests', { 'Retry-After': '5' })
      );

      try {
        const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
        }).catch(value => value);

        expect(error).toMatchObject({
          type: ErrorTypes.RATE_LIMIT_REACHED,
          statusCode: 429,
          retryAt: now.getTime() + 5000,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('normalizes Retry-After HTTP dates', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const retryAt = Date.parse('Thu, 01 Jan 2026 00:00:05 GMT');
      proxyManager.fetch.mockResolvedValue(
        httpErrorResponse({}, 429, 'Too Many Requests', { 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' })
      );

      try {
        const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
        }).catch(value => value);

        expect(error.retryAt).toBe(retryAt);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(['', '-5', 'not-a-delay'])('ignores invalid Retry-After value %j', async (retryAfter) => {
      proxyManager.fetch.mockResolvedValue(
        httpErrorResponse({}, 429, 'Too Many Requests', { 'Retry-After': retryAfter })
      );

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error.type).toBe(ErrorTypes.RATE_LIMIT_REACHED);
      expect(error).not.toHaveProperty('retryAt');
    });

    it('ignores past Retry-After dates', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
      proxyManager.fetch.mockResolvedValue(
        httpErrorResponse({}, 429, 'Too Many Requests', { 'Retry-After': 'Thu, 01 Jan 2026 00:00:00 GMT' })
      );

      try {
        const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
        }).catch(value => value);

        expect(error).not.toHaveProperty('retryAt');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not attach Retry-After to unrelated HTTP failures', async () => {
      proxyManager.fetch.mockResolvedValue(
        httpErrorResponse({}, 500, 'Server Error', { 'Retry-After': '5' })
      );

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error.type).toBe(ErrorTypes.SERVER_ERROR);
      expect(error).not.toHaveProperty('retryAt');
    });

    it('passes only bounded structured fields to provider hook', async () => {
      const classifyProviderHttpError = vi.fn(() => ErrorTypes.API_RESPONSE_INVALID);
      mockProvider.classifyProviderHttpError = classifyProviderHttpError;
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({
        code: 4001,
        type: 'top-level-type',
        detail: 'must not be passed',
        arbitrary: { secret: true },
        error: {
          code: 'nested-code',
          type: 'nested-type',
          message: 'must not be passed',
        },
      }));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        context: 'hook-test',
      })).rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });

      expect(classifyProviderHttpError).toHaveBeenCalledWith({
        statusCode: 400,
        topLevelCode: 4001,
        nestedErrorCode: 'nested-code',
        topLevelType: 'top-level-type',
        nestedErrorType: 'nested-type',
      });
      expect(Object.isFrozen(classifyProviderHttpError.mock.calls[0][0])).toBe(true);
      expect(classifyProviderHttpError.mock.calls[0][0]).not.toHaveProperty('detail');
      expect(classifyProviderHttpError.mock.calls[0][0]).not.toHaveProperty('error');
      expect(classifyProviderHttpError.mock.calls[0][0]).not.toHaveProperty('arbitrary');
    });

    it('preserves top-level provider message and code on the canonical error', async () => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({
        message: 'Request size limit exceeded',
        code: 'some_code',
      }));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error).toMatchObject({
        message: 'Request size limit exceeded',
        type: ErrorTypes.HTTP_ERROR,
        statusCode: 400,
        code: 'some_code',
      });
    });

    it.each([400, 422])('does not use a top-level classification-looking message for generic HTTP %s classification', async (statusCode) => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({ message: 'Invalid API key' }, statusCode, 'Bad Request'));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error).toMatchObject({
        type: ErrorTypes.HTTP_ERROR,
        statusCode,
        message: 'Invalid API key',
      });
    });

    it.each([
      ['object', { message: { secret: true } }],
      ['overlong string', { message: 'x'.repeat(2049) }],
    ])('does not expose unsafe top-level %s provider messages', async (_label, body) => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse(body));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error.message).toBe('Bad Request');
    });

    it.each([
      ['nested error message', {
        error: { message: 'Nested provider failure', code: 'nested-code' },
      }, 'Nested provider failure'],
      ['detail precedence', {
        detail: 'Detailed provider failure',
        message: 'Top-level provider failure',
        error: { message: 'Nested provider failure', code: 'nested-code' },
      }, 'Detailed provider failure'],
    ])('preserves existing %s handling', async (_label, body, message) => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse(body));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error).toMatchObject({ message, code: 'nested-code' });
    });

    it('preserves a top-level string error message', async () => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({ error: 'specific provider error' }));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error).toMatchObject({
        message: 'specific provider error',
        type: ErrorTypes.HTTP_ERROR,
        statusCode: 400,
      });
    });

    it.each([
      ['detail precedence over string error', {
        detail: 'Detailed provider failure',
        error: 'String provider failure',
        message: 'Top-level provider failure',
      }, 'Detailed provider failure'],
      ['nested message precedence over string error', {
        error: { message: 'Nested provider failure', code: 'nested-code' },
      }, 'Nested provider failure'],
      ['string error precedence over top-level message', {
        error: 'String provider failure',
        message: 'Top-level provider failure',
      }, 'String provider failure'],
      ['top-level message unchanged without string error', {
        message: 'Top-level provider failure',
      }, 'Top-level provider failure'],
    ])('keeps precedence for %s', async (_label, body, message) => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse(body));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error.message).toBe(message);
    });

    it.each([
      ['empty string', { error: '' }],
      ['whitespace string', { error: '   ' }],
      ['number', { error: 123 }],
      ['null', { error: null }],
      ['array', { error: ['unsafe'] }],
      ['object without message', { error: { code: 'no-message' } }],
    ])('falls back safely for %s top-level error', async (_label, body) => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse(body));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error.message).toBe('Bad Request');
    });

    it('keeps an over-limit top-level string error bounded', async () => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({ error: 'x'.repeat(2049) }));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error.message).toBe('Bad Request');
    });

    it.each([
      ['overlong string', { code: 'x'.repeat(129) }],
      ['object', { code: { unsafe: true } }],
      ['array', { code: ['unsafe'] }],
      ['unsafe number', { code: Number.MAX_SAFE_INTEGER + 1 }],
    ])('drops %s provider code from the canonical error', async (_label, body) => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse(body));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch(value => value);

      expect(error).not.toHaveProperty('code');
    });

    it('excludes absent, non-scalar, and overlong provider fields', async () => {
      const classifyProviderHttpError = vi.fn(() => null);
      mockProvider.classifyProviderHttpError = classifyProviderHttpError;
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({
        code: { invalid: true },
        type: 'x'.repeat(129),
        error: {
          code: ['invalid'],
          type: 503,
        },
      }));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      })).rejects.toBeDefined();

      expect(classifyProviderHttpError).toHaveBeenCalledWith({
        statusCode: 400,
        nestedErrorType: 503,
      });
    });

    it('uses hook type before ErrorMatcher classification', async () => {
      mockProvider.classifyProviderHttpError = vi.fn(() => ErrorTypes.MODEL_MISSING);
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({}, 404, 'Not Found'));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        context: 'hook-precedence',
      })).rejects.toMatchObject({
        type: ErrorTypes.MODEL_MISSING,
        statusCode: 404,
        context: 'hook-precedence',
        providerName: 'TestProvider',
        message: 'Not Found',
      });
    });

    it.each(['OpenAI', 'Gemini', 'OpenRouter', 'DeepSeek', 'WebAI'])(
      'classifies generic %s AI 404 as HTTP_ERROR',
      async (providerName) => {
        const aiProvider = {
          ...mockProvider,
          providerName,
          constructor: { type: 'ai' },
        };
        proxyManager.fetch.mockResolvedValue(httpErrorResponse({
          error: { message: 'model not found' },
        }, 404, 'Not Found'));

        await expect(ProviderRequestEngine.executeApiCall(aiProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
        })).rejects.toMatchObject({
          type: ErrorTypes.HTTP_ERROR,
          statusCode: 404,
          providerName,
        });
      },
    );

    it.each([null, undefined])('falls back to ErrorMatcher for %s hook result', async (result) => {
      mockProvider.classifyProviderHttpError = vi.fn(() => result);
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({ error: { message: 'Invalid API key' } }, 401, 'Unauthorized'));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      })).rejects.toMatchObject({
        type: ErrorTypes.API_KEY_INVALID,
        statusCode: 401,
      });
    });

    it('falls back to ErrorMatcher when provider hook throws', async () => {
      mockProvider.classifyProviderHttpError = vi.fn(() => {
        throw new Error('hook failure');
      });
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({}, 400, 'Bad Request'));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      })).rejects.toMatchObject({
        type: ErrorTypes.HTTP_ERROR,
        statusCode: 400,
      });
    });

    it('attaches only canonical provider code to the thrown error', async () => {
      mockProvider.classifyProviderHttpError = vi.fn(() => ErrorTypes.HTTP_ERROR);
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({
        code: 'provider-code',
        type: 'provider-type',
        error: { code: 'nested-code', type: 'nested-type' },
      }));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch((value) => value);

      expect(error).toMatchObject({
        message: 'Bad Request',
        type: ErrorTypes.HTTP_ERROR,
        statusCode: 400,
        providerName: 'TestProvider',
        code: 'nested-code',
      });
      expect(error).not.toHaveProperty('topLevelCode');
      expect(error).not.toHaveProperty('nestedErrorCode');
      expect(error).not.toHaveProperty('providerErrorInfo');
      expect(error).not.toHaveProperty('errorCode');
    });

    it('keeps providers without hook on existing ErrorMatcher path', async () => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({
        error: { message: 'Invalid API key', code: 'invalid_api_key' },
      }, 401, 'Unauthorized'));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        context: 'existing-path',
      })).rejects.toMatchObject({
        message: 'Invalid API key',
        type: ErrorTypes.API_KEY_INVALID,
        statusCode: 401,
        context: 'existing-path',
        providerName: 'TestProvider',
        code: 'invalid_api_key',
      });
    });

    it.each([
      [400, 'request is too long'],
      [422, 'maximum context length exceeded'],
      [413, 'Payload Too Large'],
    ])('preserves HTTP %s remote-size errors as HTTP_ERROR', async (status, message) => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse({ error: { message } }, status, message));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      })).rejects.toMatchObject({
        type: ErrorTypes.HTTP_ERROR,
        statusCode: status,
      });
    });

    it.each([
      ['top-level provider type', { type: 'payment_required_error' }],
      ['nested provider type', { error: { type: 'payment_required_error' } }],
    ])('classifies HTTP 402 as insufficient balance despite %s', async (_label, body) => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse(body, 402, 'Payment Required'));

      const error = await ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      }).catch((value) => value);

      expect(error).toMatchObject({
        message: 'Payment Required',
        type: ErrorTypes.INSUFFICIENT_BALANCE,
        statusCode: 402,
        providerName: 'TestProvider',
      });
      expect(error.type).not.toBe('payment_required_error');
      expect(error).not.toHaveProperty('providerErrorInfo');
      expect(error).not.toHaveProperty('errorCode');
    });

    it.each([
      [401, ErrorTypes.API_KEY_INVALID],
      [403, ErrorTypes.FORBIDDEN_ERROR],
      [429, ErrorTypes.RATE_LIMIT_REACHED],
      [500, ErrorTypes.SERVER_ERROR],
      [503, ErrorTypes.SERVER_ERROR],
    ])('keeps HTTP %s canonical when provider type is arbitrary', async (status, expectedType) => {
      proxyManager.fetch.mockResolvedValue(httpErrorResponse(
        { type: 'payment_required_error' },
        status,
        `HTTP ${status}`
      ));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
      })).rejects.toMatchObject({ type: expectedType, statusCode: status });
    });
  });

  describe('executeRequest - Failover Logic', () => {
    it.each([
      ['invalid key', 'API_ERROR: Invalid API key', ErrorTypes.API_KEY_INVALID],
      ['insufficient balance', 'API_ERROR: Insufficient balance', ErrorTypes.INSUFFICIENT_BALANCE],
      ['quota exceeded', 'API_ERROR: Quota exceeded', ErrorTypes.QUOTA_EXCEEDED],
    ])('normalizes an untyped %s envelope before failover', async (_label, message, type) => {
      ApiKeyManager.getKeys.mockResolvedValue(['key-a', 'key-b']);
      ApiKeyManager.shouldFailover.mockImplementation(error => error.type === type);
      const firstError = new Error(message);
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall')
        .mockRejectedValueOnce(firstError)
        .mockResolvedValueOnce('translated');
      const updateApiKey = vi.fn();

      try {
        await expect(ProviderRequestEngine.executeRequest(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
          extractResponse: mockExtractResponse,
          updateApiKey,
        })).resolves.toBe('translated');

        expect(firstError.type).toBe(type);
        expect(apiCallSpy).toHaveBeenCalledTimes(2);
        expect(ApiKeyManager.shouldFailover).toHaveBeenCalledWith(firstError);
        expect(updateApiKey).toHaveBeenCalledWith('key-b', expect.any(Object));
        expect(ApiKeyManager.promoteKey).toHaveBeenCalledWith('test_key_setting', 'key-b');
      } finally {
        apiCallSpy.mockRestore();
      }
    });

    it('does not rotate keys for an untyped generic API error envelope', async () => {
      ApiKeyManager.getKeys.mockResolvedValue(['key-a', 'key-b']);
      ApiKeyManager.shouldFailover.mockReturnValue(false);
      const error = new Error('API_ERROR: Unknown provider failure');
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall').mockRejectedValue(error);
      const updateApiKey = vi.fn();

      try {
        await expect(ProviderRequestEngine.executeRequest(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
          extractResponse: mockExtractResponse,
          updateApiKey,
        })).rejects.toBe(error);

        expect(error.type).toBe(ErrorTypes.TRANSLATION_ERROR);
        expect(apiCallSpy).toHaveBeenCalledTimes(1);
        expect(ApiKeyManager.shouldFailover).toHaveBeenCalledWith(error);
        expect(updateApiKey).not.toHaveBeenCalled();
      } finally {
        apiCallSpy.mockRestore();
      }
    });

    it('passes normalized type to a provider failover hook', async () => {
      ApiKeyManager.getKeys.mockResolvedValue(['key-a', 'key-b']);
      const shouldFailoverApiKey = vi.fn(error => error.type === ErrorTypes.API_KEY_INVALID);
      mockProvider.shouldFailoverApiKey = shouldFailoverApiKey;
      const error = new Error('API_ERROR: Invalid API key');
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall')
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce('translated');

      try {
        await expect(ProviderRequestEngine.executeRequest(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
          extractResponse: mockExtractResponse,
          updateApiKey: vi.fn(),
        })).resolves.toBe('translated');

        expect(shouldFailoverApiKey).toHaveBeenCalledWith(expect.objectContaining({
          type: ErrorTypes.API_KEY_INVALID,
        }));
      } finally {
        apiCallSpy.mockRestore();
      }
    });

    it.each([undefined, 'INVALID_PURPOSE'])('normalizes %p purpose to primary before physical accounting', async (callPurpose) => {
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall').mockResolvedValue('translated');
      try {
        await ProviderRequestEngine.executeRequest(mockProvider, {
          url: 'https://api.test.com', fetchOptions: { headers: {} }, extractResponse: mockExtractResponse, callPurpose
        });
        expect(apiCallSpy).toHaveBeenCalledWith(mockProvider, expect.objectContaining({ callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION }));
      } finally {
        apiCallSpy.mockRestore();
      }
    });
    it('should failover to the second key if the first one fails with a retryable error', async () => {
      // 1. Setup: Two keys available
      const keys = ['bad-key', 'good-key'];
      ApiKeyManager.getKeys.mockResolvedValue(keys);
      ApiKeyManager.shouldFailover.mockReturnValue(true);

      // 2. Mock fetch: First call fails (401), second call succeeds (200)
      proxyManager.fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ error: { message: 'Invalid Key' } }),
          headers: new Map(),
          clone: function() { return this; }
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ translated: 'سلام' }),
          headers: new Map([['content-type', 'application/json']]),
          clone: function() { return this; }
        });

      const updateApiKey = vi.fn();
      
      // 3. Execute request
      const result = await ProviderRequestEngine.executeRequest(mockProvider, {
        url: 'https://api.test.com/translate?key=bad-key',
        fetchOptions: { 
          method: 'POST', 
          headers: { 'Authorization': 'Bearer bad-key' } 
        },
        extractResponse: mockExtractResponse,
        updateApiKey,
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY
      });

      // 4. Verification
      expect(result).toBe('سلام');
      expect(proxyManager.fetch).toHaveBeenCalledTimes(2);
      
      // Check if updateApiKey was called with the second key
      expect(updateApiKey).toHaveBeenCalledWith('good-key', expect.any(Object));
      expect(ApiKeyManager.shouldFailover).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
      
      // Check if the working key was promoted
      expect(ApiKeyManager.promoteKey).toHaveBeenCalledWith('test_key_setting', 'good-key');
      const { statsManager } = await import('../../core/TranslationStatsManager.js');
      expect(statsManager.recordRequest).toHaveBeenCalledTimes(2);
      expect(statsManager.recordError).toHaveBeenCalledTimes(1);
      expect(statsManager.recordRequest.mock.calls.every(([, , , , purpose]) => purpose === TranslationCallPurpose.STRUCTURED_RECOVERY)).toBe(true);
      expect(statsManager.recordError).toHaveBeenCalledWith('TestProvider', null, TranslationCallPurpose.STRUCTURED_RECOVERY);
    });

    it('uses provider failover eligibility when provider supplies a hook', async () => {
      const firstError = Object.assign(new Error('Invalid key'), {
        type: ErrorTypes.API_KEY_INVALID,
        statusCode: 401,
      });
      const shouldFailoverApiKey = vi.fn(error => error.statusCode === 401);
      mockProvider.shouldFailoverApiKey = shouldFailoverApiKey;
      ApiKeyManager.getKeys.mockResolvedValue(['bad-key', 'good-key']);
      ApiKeyManager.shouldFailover.mockReturnValue(true);
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall')
        .mockRejectedValueOnce(firstError)
        .mockResolvedValueOnce('translated');
      const updateApiKey = vi.fn();

      try {
        await expect(ProviderRequestEngine.executeRequest(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
          extractResponse: mockExtractResponse,
          updateApiKey,
        })).resolves.toBe('translated');

        expect(shouldFailoverApiKey).toHaveBeenCalledWith(firstError);
        expect(ApiKeyManager.shouldFailover).not.toHaveBeenCalled();
        expect(updateApiKey).toHaveBeenCalledWith('good-key', expect.any(Object));
      } finally {
        apiCallSpy.mockRestore();
      }
    });

    it('filters candidates before rotation and promotes filtered-list key actually used', async () => {
      mockProvider.isApiKeyCandidateEligible = vi.fn((key, context) => context.apiTier === 'pro' && !key.endsWith(':fx'));
      ApiKeyManager.getKeys.mockResolvedValue(['bad-key', 'free-key:fx', 'good-key']);
      ApiKeyManager.shouldFailover.mockReturnValue(true);
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall')
        .mockRejectedValueOnce(Object.assign(new Error('Invalid key'), {
          type: ErrorTypes.API_KEY_INVALID,
          statusCode: 401,
        }))
        .mockResolvedValueOnce('translated');
      const updateApiKey = vi.fn();

      try {
        await expect(ProviderRequestEngine.executeRequest(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
          extractResponse: mockExtractResponse,
          updateApiKey,
          apiKeyFailoverContext: { apiTier: 'pro' },
        })).resolves.toBe('translated');

        expect(mockProvider.isApiKeyCandidateEligible).toHaveBeenCalledWith('free-key:fx', { apiTier: 'pro' });
        expect(updateApiKey).toHaveBeenCalledWith('good-key', expect.any(Object));
        expect(ApiKeyManager.promoteKey).toHaveBeenCalledWith('test_key_setting', 'good-key');
      } finally {
        apiCallSpy.mockRestore();
      }
    });

    it('uses admission-time keys when settings change during failover', async () => {
      ApiKeyManager.getKeys.mockResolvedValueOnce(['bad-key', 'good-key']);
      ApiKeyManager.shouldFailover.mockReturnValue(true);
      const firstAttempt = deferred();
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall')
        .mockImplementationOnce(() => firstAttempt.promise)
        .mockResolvedValueOnce('translated');
      const updateApiKey = vi.fn();

      try {
        const request = ProviderRequestEngine.executeRequest(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
          extractResponse: mockExtractResponse,
          updateApiKey,
        });
        await vi.waitFor(() => expect(apiCallSpy).toHaveBeenCalledTimes(1));
        ApiKeyManager.getKeys.mockResolvedValue(['new-key']);
        firstAttempt.reject(Object.assign(new Error('Invalid key'), { type: ErrorTypes.API_KEY_INVALID }));

        await expect(request).resolves.toBe('translated');
        expect(updateApiKey).toHaveBeenCalledWith('good-key', expect.any(Object));
        expect(ApiKeyManager.promoteKey).toHaveBeenCalledWith('test_key_setting', 'good-key');
        expect(ApiKeyManager.getKeys).toHaveBeenCalledTimes(1);
      } finally {
        apiCallSpy.mockRestore();
      }
    });

    it('preserves three-key failover order after settings change', async () => {
      ApiKeyManager.getKeys.mockResolvedValueOnce(['key-A', 'key-B', 'key-C']);
      ApiKeyManager.shouldFailover.mockReturnValue(true);
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall')
        .mockRejectedValueOnce(Object.assign(new Error('A failed'), { type: ErrorTypes.API_KEY_INVALID }))
        .mockRejectedValueOnce(Object.assign(new Error('B failed'), { type: ErrorTypes.API_KEY_INVALID }))
        .mockResolvedValueOnce('translated');
      const updateApiKey = vi.fn((key) => {
        if (key === 'key-B') ApiKeyManager.getKeys.mockResolvedValue(['new-key']);
      });

      try {
        await expect(ProviderRequestEngine.executeRequest(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
          extractResponse: mockExtractResponse,
          updateApiKey,
        })).resolves.toBe('translated');

        expect(updateApiKey.mock.calls.map(([key]) => key)).toEqual(['key-B', 'key-C']);
        expect(ApiKeyManager.promoteKey).toHaveBeenCalledWith('test_key_setting', 'key-C');
        expect(ApiKeyManager.getKeys).toHaveBeenCalledTimes(1);
      } finally {
        apiCallSpy.mockRestore();
      }
    });

    it('next request captures new keys after settings change', async () => {
      ApiKeyManager.getKeys.mockResolvedValueOnce(['old-bad', 'old-good']);
      ApiKeyManager.shouldFailover.mockReturnValue(true);
      const firstSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall')
        .mockRejectedValueOnce(Object.assign(new Error('old-bad failed'), { type: ErrorTypes.API_KEY_INVALID }))
        .mockResolvedValueOnce('first');
      const firstUpdate = vi.fn();
      await expect(ProviderRequestEngine.executeRequest(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        extractResponse: mockExtractResponse,
        updateApiKey: firstUpdate,
      })).resolves.toBe('first');
      expect(firstUpdate).toHaveBeenCalledWith('old-good', expect.any(Object));
      firstSpy.mockRestore();
      vi.clearAllMocks();
      ApiKeyManager.shouldFailover.mockReturnValue(true);
      ApiKeyManager.getKeys.mockResolvedValueOnce(['new-bad', 'new-good']);
      const secondSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall')
        .mockRejectedValueOnce(Object.assign(new Error('new-bad failed'), { type: ErrorTypes.API_KEY_INVALID }))
        .mockResolvedValueOnce('second');
      const secondUpdate = vi.fn();
      await expect(ProviderRequestEngine.executeRequest(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        extractResponse: mockExtractResponse,
        updateApiKey: secondUpdate,
      })).resolves.toBe('second');
      expect(secondUpdate).toHaveBeenCalledWith('new-good', expect.any(Object));
      expect(ApiKeyManager.promoteKey).toHaveBeenLastCalledWith('test_key_setting', 'new-good');
      secondSpy.mockRestore();
    });

    it.each([
      [403, ErrorTypes.FORBIDDEN_ERROR],
      [456, ErrorTypes.DEEPL_QUOTA_EXCEEDED],
      [429, ErrorTypes.RATE_LIMIT_REACHED],
      [529, ErrorTypes.RATE_LIMIT_REACHED],
      [400, ErrorTypes.HTTP_ERROR],
      [422, ErrorTypes.HTTP_ERROR],
      [500, ErrorTypes.SERVER_ERROR],
    ])('does not rotate when provider hook rejects HTTP %s', async (statusCode, type) => {
      mockProvider.shouldFailoverApiKey = vi.fn(() => false);
      ApiKeyManager.getKeys.mockResolvedValue(['first-key', 'second-key']);
      ApiKeyManager.shouldFailover.mockReturnValue(true);
      const error = Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, type });
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall').mockRejectedValue(error);
      const updateApiKey = vi.fn();

      try {
        await expect(ProviderRequestEngine.executeRequest(mockProvider, {
          url: 'https://api.test.com',
          fetchOptions: { headers: {} },
          extractResponse: mockExtractResponse,
          updateApiKey,
        })).rejects.toBe(error);

        expect(apiCallSpy).toHaveBeenCalledTimes(1);
        expect(mockProvider.shouldFailoverApiKey).toHaveBeenCalledWith(error);
        expect(ApiKeyManager.shouldFailover).not.toHaveBeenCalled();
        expect(updateApiKey).not.toHaveBeenCalled();
      } finally {
        apiCallSpy.mockRestore();
      }
    });

    it('should capture a fresh proxy snapshot for each physical failover attempt', async () => {
      const firstSnapshot = createProxyConfig('proxy-first');
      const secondSnapshot = createProxyConfig('proxy-second');
      mockProvider._initializeProxy
        .mockResolvedValueOnce(firstSnapshot)
        .mockResolvedValueOnce(secondSnapshot);
      ApiKeyManager.getKeys.mockResolvedValue(['bad-key', 'good-key']);
      ApiKeyManager.shouldFailover.mockReturnValue(true);

      const response = (ok, body) => ({
        ok,
        status: ok ? 200 : 401,
        statusText: ok ? 'OK' : 'Unauthorized',
        json: async () => body,
        headers: new Map([['content-type', 'application/json']]),
        clone() { return this; },
      });
      proxyManager.fetch
        .mockResolvedValueOnce(response(false, { error: { message: 'Invalid key' } }))
        .mockResolvedValueOnce(response(true, { translated: 'translated' }));

      const result = await ProviderRequestEngine.executeRequest(mockProvider, {
        url: 'https://api.test.com/translate?key=bad-key',
        fetchOptions: { method: 'POST', headers: {} },
        extractResponse: mockExtractResponse,
        updateApiKey: vi.fn(),
      });

      expect(result).toBe('translated');
      expect(mockProvider._initializeProxy).toHaveBeenCalledTimes(2);
      expect(proxyManager.fetch.mock.calls[0][2]).toBe(firstSnapshot);
      expect(proxyManager.fetch.mock.calls[1][2]).toBe(secondSnapshot);
    });

    it('does not delay key failover for Retry-After from the first key', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      ApiKeyManager.getKeys.mockResolvedValue(['bad-key', 'good-key']);
      ApiKeyManager.shouldFailover.mockReturnValue(true);
      proxyManager.fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: async () => ({}),
          headers: new Map([
            ['content-type', 'application/json'],
            ['Retry-After', '120'],
          ]),
          clone() { return this; },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ translated: 'ok' }),
          headers: new Map([['content-type', 'application/json']]),
          clone() { return this; },
        });

      try {
        await expect(ProviderRequestEngine.executeRequest(mockProvider, {
          url: 'https://api.test.com/translate?key=bad-key',
          fetchOptions: { headers: {} },
          extractResponse: mockExtractResponse,
          updateApiKey: vi.fn(),
        })).resolves.toBe('ok');
        expect(proxyManager.fetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should throw error immediately if shouldFailover is false', async () => {
      ApiKeyManager.getKeys.mockResolvedValue(['key1', 'key2']);
      ApiKeyManager.shouldFailover.mockReturnValue(false); // Don't retry for this error

      proxyManager.fetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ message: 'Fatal Error' }),
        headers: new Map(),
        clone: function() { return this; }
      });

      await expect(ProviderRequestEngine.executeRequest(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        extractResponse: mockExtractResponse,
        updateApiKey: vi.fn()
      })).rejects.toThrow('Fatal Error');

      expect(proxyManager.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['missing purpose', undefined, TranslationCallPurpose.PRIMARY_TRANSLATION],
      ['invalid purpose', 'OTHER', TranslationCallPurpose.PRIMARY_TRANSLATION],
      ['recovery purpose', TranslationCallPurpose.STRUCTURED_RECOVERY, TranslationCallPurpose.STRUCTURED_RECOVERY],
    ])('should forward normalized %s to every physical call', async (_label, callPurpose, expectedPurpose) => {
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall').mockResolvedValue('translated');

      await ProviderRequestEngine.executeRequest(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        extractResponse: mockExtractResponse,
        callPurpose,
      });

      expect(apiCallSpy).toHaveBeenCalledWith(mockProvider, expect.objectContaining({ callPurpose: expectedPurpose }));
      apiCallSpy.mockRestore();
    });

    it('should preserve recovery purpose across key failover', async () => {
      ApiKeyManager.getKeys.mockResolvedValue(['bad-key', 'good-key']);
      ApiKeyManager.shouldFailover.mockReturnValue(true);
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall')
        .mockRejectedValueOnce(Object.assign(new Error('bad key'), { type: 'API_ERROR' }))
        .mockResolvedValueOnce('translated');

      await ProviderRequestEngine.executeRequest(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        extractResponse: mockExtractResponse,
        updateApiKey: vi.fn(),
        callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
      });

      expect(apiCallSpy).toHaveBeenCalledTimes(2);
      expect(apiCallSpy.mock.calls.every(([, params]) => params.callPurpose === TranslationCallPurpose.STRUCTURED_RECOVERY)).toBe(true);
      apiCallSpy.mockRestore();
    });

    it.each([
      ['user cancellation', Object.assign(new Error('cancelled'), { type: ErrorTypes.USER_CANCELLED })],
      ['operation abort', Object.assign(new Error('aborted'), { name: 'AbortError', operationAborted: true, cancellationReason: 'operation-abort' })],
    ])('does not fail over after %s', async (_label, error) => {
      ApiKeyManager.getKeys.mockResolvedValue(['key1', 'key2']);
      ApiKeyManager.shouldFailover.mockReturnValue(true);
      const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall').mockRejectedValue(error);

      await expect(ProviderRequestEngine.executeRequest(mockProvider, {
        url: 'https://api.test.com',
        fetchOptions: { headers: {} },
        extractResponse: mockExtractResponse,
        updateApiKey: vi.fn(),
      })).rejects.toBe(error);

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      apiCallSpy.mockRestore();
    });
  });

  describe('prepareHeaders', () => {
    it('should remove chrome-specific headers on Firefox', () => {
      // Set mock to Firefox
      getBrowserInfoSync.mockReturnValue({ isFirefox: true, isMobile: false });

      const inputHeaders = {
        'Content-Type': 'application/json',
        'Sec-Fetch-Mode': 'cors',
        'Referer': 'https://google.com'
      };

      const result = ProviderRequestEngine.prepareHeaders(inputHeaders, 'TestProvider');
      
      expect(result['Content-Type']).toBe('application/json');
      expect(result['Sec-Fetch-Mode']).toBeUndefined();
      expect(result['Referer']).toBeUndefined();
    });
  });

  describe('Error Accounting', () => {
    const baseParams = () => ({
      url: 'https://api.test.com',
      fetchOptions: { headers: {} },
      extractResponse: mockExtractResponse,
      context: 'test',
      sessionId: 's1',
      charCount: 10,
      originalCharCount: 5
    });

    it.each([
      [undefined, TranslationCallPurpose.PRIMARY_TRANSLATION],
      [null, TranslationCallPurpose.PRIMARY_TRANSLATION],
      ['', TranslationCallPurpose.PRIMARY_TRANSLATION],
      ['UNKNOWN', TranslationCallPurpose.PRIMARY_TRANSLATION],
      [TranslationCallPurpose.PRIMARY_TRANSLATION, TranslationCallPurpose.PRIMARY_TRANSLATION],
      [TranslationCallPurpose.STRUCTURED_RECOVERY, TranslationCallPurpose.STRUCTURED_RECOVERY],
      [TranslationCallPurpose.PARENT_RECOVERY, TranslationCallPurpose.PARENT_RECOVERY],
    ])('attributes direct physical %p purpose as %s', async (callPurpose, expectedPurpose) => {
      proxyManager.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        clone() { return this; },
        json: async () => ({ translated: 'translated' })
      });
      const { statsManager } = await import('../../core/TranslationStatsManager.js');

      await ProviderRequestEngine.executeApiCall(mockProvider, { ...baseParams(), callPurpose });

      expect(statsManager.recordRequest).toHaveBeenCalledWith(
        'TestProvider',
        's1',
        10,
        5,
        expectedPurpose
      );
    });

    it('should record exactly one error for a non-cancellation transport failure and rethrow', async () => {
      proxyManager.fetch.mockRejectedValue(new TypeError('NetworkError: Failed to fetch'));
      const { statsManager } = await import('../../core/TranslationStatsManager.js');

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, baseParams()))
        .rejects.toThrow('NetworkError');

      expect(statsManager.recordRequest).toHaveBeenCalledTimes(1);
      expect(statsManager.recordError).toHaveBeenCalledTimes(1);
      expect(statsManager.recordRequest).toHaveBeenCalledWith('TestProvider', 's1', 10, 5, TranslationCallPurpose.PRIMARY_TRANSLATION);
      expect(statsManager.recordError).toHaveBeenCalledWith('TestProvider', 's1', TranslationCallPurpose.PRIMARY_TRANSLATION);
    });

    it('preserves typed SOCKS timeout provenance through request classification', async () => {
      const error = Object.assign(new Error('SOCKS proxy connection timed out'), {
        type: ErrorTypes.NETWORK_ERROR,
        transportFailure: 'socks-proxy-timeout',
        cause: new Error('native timeout'),
      });
      proxyManager.fetch.mockRejectedValue(error);

      await expect(ProviderRequestEngine.executeRequest(mockProvider, baseParams()))
        .rejects.toBe(error);

      expect(error.type).toBe(ErrorTypes.NETWORK_ERROR);
      expect(error.transportFailure).toBe('socks-proxy-timeout');
      expect(error.cause).toBeDefined();
    });

    it('preserves explicit user cancellation without sending an already-aborted call', async () => {
      const controller = new AbortController();
      controller.abort('user-cancelled');
      proxyManager.fetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
      const { statsManager } = await import('../../core/TranslationStatsManager.js');

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, { ...baseParams(), abortController: controller }))
        .rejects.toMatchObject({ type: ErrorTypes.USER_CANCELLED });

      expect(proxyManager.fetch).not.toHaveBeenCalled();
      expect(statsManager.recordRequest).not.toHaveBeenCalled();
      expect(statsManager.recordError).not.toHaveBeenCalled();
    });

    it('classifies a bare aborted signal as an internal operation abort', async () => {
      const controller = new AbortController();
      controller.abort();
      proxyManager.fetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, { ...baseParams(), abortController: controller }))
        .rejects.toMatchObject({
          operationAborted: true,
          cancellationReason: 'operation-abort',
        });
    });

    it('preserves internal abort provenance from the signal reason', async () => {
      const controller = new AbortController();
      controller.abort('document-replaced');
      proxyManager.fetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        ...baseParams(),
        abortController: controller,
      })).rejects.toMatchObject({
        operationAborted: true,
        cancellationReason: 'document-replaced',
      });
    });

    it('classifies AbortError with a non-aborted signal as an internal operation abort', async () => {
      const controller = new AbortController();
      proxyManager.fetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, { ...baseParams(), abortController: controller }))
        .rejects.toMatchObject({
          operationAborted: true,
          cancellationReason: 'operation-abort',
        });
    });

    it('classifies controller-less AbortError as an internal operation abort', async () => {
      proxyManager.fetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      await expect(ProviderRequestEngine.executeApiCall(mockProvider, baseParams()))
        .rejects.toMatchObject({
          operationAborted: true,
          cancellationReason: 'operation-abort',
        });
    });

    describe('typed AbortError provenance', () => {
      it.each([
        [ErrorTypes.TRANSLATION_TIMEOUT, true],
        [ErrorTypes.NETWORK_ERROR, true],
        [ErrorTypes.HTTP_ERROR, true],
        [ErrorTypes.SERVER_ERROR, true],
        [ErrorTypes.USER_CANCELLED, false],
        [ErrorTypes.TRANSLATION_CANCELLED, false],
      ])('preserves authoritative %s AbortError identity and stats semantics', async (type, recordsError) => {
        const error = Object.assign(new Error(type), {
          name: 'AbortError',
          type,
        });
        proxyManager.fetch.mockRejectedValue(error);
        const { statsManager } = await import('../../core/TranslationStatsManager.js');

        await expect(ProviderRequestEngine.executeApiCall(mockProvider, baseParams()))
          .rejects.toBe(error);

        expect(error).toMatchObject({ name: 'AbortError', type });
        expect(error.operationAborted).toBeUndefined();
        expect(statsManager.recordRequest).toHaveBeenCalledTimes(1);
        expect(statsManager.recordError).toHaveBeenCalledTimes(recordsError ? 1 : 0);
      });

      it('preserves typed AbortError metadata and identity', async () => {
        const cause = new Error('native timeout');
        const error = Object.assign(new Error('typed network failure'), {
          name: 'AbortError',
          type: ErrorTypes.NETWORK_ERROR,
          statusCode: 503,
          providerName: 'Source Provider',
          providerId: 'source-provider',
          code: 'NETWORK_TIMEOUT',
          errorCode: 'E_NETWORK',
          transportFailure: 'provider-timeout',
          cause,
          context: 'original-context',
          customMetadata: { preserved: true },
        });
        proxyManager.fetch.mockRejectedValue(error);

        await expect(ProviderRequestEngine.executeApiCall(mockProvider, baseParams()))
          .rejects.toBe(error);

        expect(error).toMatchObject({
          type: ErrorTypes.NETWORK_ERROR,
          statusCode: 503,
          providerName: 'Source Provider',
          providerId: 'source-provider',
          code: 'NETWORK_TIMEOUT',
          errorCode: 'E_NETWORK',
          transportFailure: 'provider-timeout',
          cause,
          context: 'original-context',
          customMetadata: { preserved: true },
        });
      });

      it.each([
        ErrorTypes.TRANSLATION_TIMEOUT,
        ErrorTypes.NETWORK_ERROR,
      ])('preserves operation-abort control with typed %s', async (type) => {
        const error = Object.assign(new Error(type), {
          name: 'AbortError',
          type,
          operationAborted: true,
          cancellationReason: 'document-replaced',
        });
        proxyManager.fetch.mockRejectedValue(error);
        const { statsManager } = await import('../../core/TranslationStatsManager.js');

        await expect(ProviderRequestEngine.executeApiCall(mockProvider, baseParams()))
          .rejects.toBe(error);

        expect(error).toMatchObject({
          type,
          operationAborted: true,
          cancellationReason: 'document-replaced',
        });
        expect(statsManager.recordError).not.toHaveBeenCalled();
      });

      it('keeps executeRequest operation-abort short-circuit for typed AbortError', async () => {
        const error = Object.assign(new Error('typed network failure'), {
          name: 'AbortError',
          type: ErrorTypes.NETWORK_ERROR,
          operationAborted: true,
        });
        const apiCallSpy = vi.spyOn(ProviderRequestEngine, 'executeApiCall').mockRejectedValue(error);

        try {
          await expect(ProviderRequestEngine.executeRequest(mockProvider, {
            ...baseParams(),
            extractResponse: mockExtractResponse,
          })).rejects.toBe(error);
          expect(apiCallSpy).toHaveBeenCalledTimes(1);
        } finally {
          apiCallSpy.mockRestore();
        }
      });

      it.each([
        ErrorTypes.TRANSLATION_ERROR,
        ErrorTypes.TRANSLATION_FAILED,
        ErrorTypes.UNKNOWN,
      ])('continues normalizing generic %s AbortError with internal signal', async (type) => {
        const controller = new AbortController();
        controller.abort('document-replaced');
        const error = Object.assign(new Error(type), {
          name: 'AbortError',
          type,
        });
        proxyManager.fetch.mockRejectedValue(error);

        await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
          ...baseParams(),
          abortController: controller,
        })).rejects.toMatchObject({
          operationAborted: true,
          cancellationReason: 'document-replaced',
        });
      });

      it.each([
        ErrorTypes.TRANSLATION_ERROR,
        ErrorTypes.TRANSLATION_FAILED,
        ErrorTypes.UNKNOWN,
      ])('continues normalizing generic %s AbortError with user signal', async (type) => {
        const controller = new AbortController();
        controller.abort('user-cancelled');
        const error = Object.assign(new Error(type), {
          name: 'AbortError',
          type,
        });
        proxyManager.fetch.mockRejectedValue(error);

        await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
          ...baseParams(),
          abortController: controller,
        })).rejects.toMatchObject({ type: ErrorTypes.USER_CANCELLED });
      });

      it('keeps timeout signal reason as generic operation abort', async () => {
        const controller = new AbortController();
        controller.abort('timeout');
        proxyManager.fetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

        await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
          ...baseParams(),
          abortController: controller,
        })).rejects.toMatchObject({
          operationAborted: true,
          cancellationReason: 'operation-abort',
        });
      });

      it('preserves failover-eligible typed AbortError through executeRequest', async () => {
        const error = Object.assign(new Error('Invalid API key'), {
          name: 'AbortError',
          type: ErrorTypes.API_KEY_INVALID,
        });
        ApiKeyManager.getKeys.mockResolvedValue(['bad-key', 'good-key']);
        ApiKeyManager.shouldFailover.mockReturnValue(true);
        proxyManager.fetch
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/json']]),
            clone() { return this; },
            json: async () => ({ translated: 'translated' }),
          });
        const updateApiKey = vi.fn();
        const { statsManager } = await import('../../core/TranslationStatsManager.js');

        await expect(ProviderRequestEngine.executeRequest(mockProvider, {
          ...baseParams(),
          updateApiKey,
        })).resolves.toBe('translated');

        expect(proxyManager.fetch).toHaveBeenCalledTimes(2);
        expect(ApiKeyManager.shouldFailover).toHaveBeenCalledWith(error);
        expect(updateApiKey).toHaveBeenCalledWith('good-key', expect.any(Object));
        expect(statsManager.recordError).toHaveBeenCalledTimes(1);
      });
    });

    it('attributes a recovery transport failure to recovery exactly once', async () => {
      proxyManager.fetch.mockRejectedValue(new TypeError('NetworkError: Failed to fetch'));
      const { statsManager } = await import('../../core/TranslationStatsManager.js');
      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        ...baseParams(), callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY
      })).rejects.toThrow('NetworkError');
      expect(statsManager.recordRequest).toHaveBeenCalledWith('TestProvider', 's1', 10, 5, TranslationCallPurpose.STRUCTURED_RECOVERY);
      expect(statsManager.recordError).toHaveBeenCalledWith('TestProvider', 's1', TranslationCallPurpose.STRUCTURED_RECOVERY);
    });

    it('attributes parent recovery transport calls to parent recovery', async () => {
      proxyManager.fetch.mockRejectedValue(new TypeError('NetworkError: Failed to fetch'));
      const { statsManager } = await import('../../core/TranslationStatsManager.js');
      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        ...baseParams(), callPurpose: TranslationCallPurpose.PARENT_RECOVERY
      })).rejects.toThrow('NetworkError');
      expect(statsManager.recordRequest).toHaveBeenCalledWith('TestProvider', 's1', 10, 5, TranslationCallPurpose.PARENT_RECOVERY);
      expect(statsManager.recordError).toHaveBeenCalledWith('TestProvider', 's1', TranslationCallPurpose.PARENT_RECOVERY);
    });

    it('attributes a recovery abort without recording a recovery error', async () => {
      proxyManager.fetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
      const { statsManager } = await import('../../core/TranslationStatsManager.js');
      await expect(ProviderRequestEngine.executeApiCall(mockProvider, {
        ...baseParams(), callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY
      })).rejects.toMatchObject({
        operationAborted: true,
        cancellationReason: 'operation-abort',
      });
      expect(statsManager.recordRequest).toHaveBeenCalledWith('TestProvider', 's1', 10, 5, TranslationCallPurpose.STRUCTURED_RECOVERY);
      expect(statsManager.recordError).not.toHaveBeenCalled();
    });
  });
});
