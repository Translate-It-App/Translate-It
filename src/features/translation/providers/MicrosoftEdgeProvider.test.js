import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock extension polyfill before anything else
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getBrowserInfo: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
    storage: { local: { get: vi.fn(), set: vi.fn() } }
  }
}));

import { MicrosoftEdgeProvider } from './MicrosoftEdgeProvider.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';

// Mock dependencies
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    debugLazy: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    operation: vi.fn(),
    performance: vi.fn(),
  })
}));

vi.mock("@/shared/config/config.js", () => ({
  CONFIG: {
    MICROSOFT_EDGE_TRANSLATE_URL: 'https://edge.microsoft.com/translate/translatetext'
  },
  TranslationMode: {
    Page: 'page-translation-batch',
    Select_Element: 'select-element',
    PDF: 'pdf-translation'
  },
  getProviderOptimizationLevelAsync: vi.fn(() => Promise.resolve('balanced')),
}));

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  getProxySettingsAsync: vi.fn().mockResolvedValue({}),
  resolveProxyConfig: vi.fn().mockResolvedValue({})
}));

// Partial mock for language constants
vi.mock("@/shared/config/languageConstants.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getProviderLanguageCode: vi.fn((lang) => {
      if (lang.toLowerCase() === 'en-us') return 'en';
      return lang;
    })
  };
});

vi.mock("./utils/TraditionalTextProcessor.js", () => ({
  getTextInfo: vi.fn((item) => {
    if (typeof item === 'string') return { text: item, length: item.length };
    const text = item?.t || item?.text || '';
    return { text: String(text), length: String(text).length };
  }),
  TraditionalTextProcessor: {
    calculateTraditionalCharCount: vi.fn(() => 10)
  }
}));

describe('MicrosoftEdgeProvider', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new MicrosoftEdgeProvider();
  });

  const mockResponse = (providerInstance, response, statusCode = 200) => vi
    .spyOn(providerInstance, '_executeRequest')
    .mockImplementation(async (options) => options.extractResponse(response, statusCode));

  describe('_getLangCode', () => {
    it('should return null for auto-detect', () => {
      expect(provider._getLangCode('auto')).toBeNull();
    });

    it('should normalize language codes to base code or mapped code', () => {
      expect(provider._getLangCode('en-US')).toBe('en');
    });
  });

  describe('_translateChunk', () => {
    it('should send the current Edge request contract for explicit source language', async () => {
      const executeMock = mockResponse(provider, '[{"translations":[{"text":"سلام"}]}]');
      const options = { providerMetadataRef: { metadata: {} } };

      await expect(provider._translateChunk(
        ['Hello'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, options
      )).resolves.toEqual(['سلام']);

      const request = executeMock.mock.calls[0][0];
      const requestUrl = new URL(request.url);
      expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(
        'https://edge.microsoft.com/translate/translatetext'
      );
      expect(requestUrl.searchParams.get('isEnterpriseClient')).toBe('false');
      expect(requestUrl.searchParams.get('to')).toBe('fa');
      expect(requestUrl.searchParams.get('from')).toBe('en');
      expect(requestUrl.searchParams.has('api-version')).toBe(false);
      expect(requestUrl.searchParams.has('includeSentenceLength')).toBe(false);
      expect(request.fetchOptions.method).toBe('POST');
      expect(request.fetchOptions.credentials).toBe('omit');
      expect(request.fetchOptions.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(request.fetchOptions.headers).not.toHaveProperty('Authorization');
      expect(JSON.parse(request.fetchOptions.body)).toEqual(['Hello']);
    });

    it('should omit from for auto-detect and send multiple text strings', async () => {
      const executeMock = mockResponse(provider, [
        { translations: [{ text: 'سلام' }] },
        { translations: [{ text: 'دنیا' }] }
      ]);

      await expect(provider._translateChunk(
        ['Hello', 'World'], 'auto', 'fa', 'selection', null
      )).resolves.toEqual(['سلام', 'دنیا']);

      const request = executeMock.mock.calls[0][0];
      const requestUrl = new URL(request.url);
      expect(requestUrl.searchParams.get('isEnterpriseClient')).toBe('false');
      expect(requestUrl.searchParams.get('to')).toBe('fa');
      expect(requestUrl.searchParams.has('from')).toBe(false);
      expect(JSON.parse(request.fetchOptions.body)).toEqual(['Hello', 'World']);
    });

    it('should publish detected language metadata when provided', async () => {
      mockResponse(
        provider,
        '[{"translations":[{"text":"سلام"}],"detectedLanguage":{"language":"EN"}}]'
      );
      const options = { providerMetadataRef: { metadata: {} } };

      await provider._translateChunk(['Hello'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, options);

      expect(options.providerMetadataRef.metadata.detectedLanguage).toBe('en');
    });

    it('should throw JSON_PARSING_ERROR for invalid raw JSON', async () => {
      mockResponse(provider, 'not-json');

      await expect(provider._translateChunk(['Hello'], 'en', 'fa', 'selection', null))
        .rejects.toMatchObject({
          type: 'JSON_PARSING_ERROR',
          statusCode: 200,
          context: 'edge-translate-chunk'
        });
    });

    it('should not invent detected language metadata when it is absent', async () => {
      mockResponse(provider, [{ translations: [{ text: 'سلام' }] }]);
      const options = { providerMetadataRef: { metadata: {} } };

      await provider._translateChunk(['Hello'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, options);

      expect(options.providerMetadataRef.metadata).toEqual({});
    });

    it('should preserve existing metadata when detected language is absent', async () => {
      mockResponse(provider, [{ translations: [{ text: 'سلام' }] }]);
      const options = { providerMetadataRef: { metadata: { detectedLanguage: 'fr' } } };

      await provider._translateChunk(['Hello'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, options);

      expect(options.providerMetadataRef.metadata.detectedLanguage).toBe('fr');
    });

    it('should throw API_RESPONSE_INVALID for malformed API response', async () => {
      mockResponse(provider, { unexpected: 'shape' });
      const options = { providerMetadataRef: { metadata: {} } };

      await expect(provider._translateChunk(
        ['Hello'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, options
      )).rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
      expect(options.providerMetadataRef.metadata).toEqual({});
    });

    it.each([
      ['empty translations array', [{ translations: [] }]],
      ['empty translated text', [{ translations: [{ text: '' }] }]],
      ['whitespace-only translated text', [{ translations: [{ text: '   ' }] }]],
    ])('throws API_RESPONSE_INVALID for %s instead of returning empty output', async (_label, response) => {
      mockResponse(provider, response);

      await expect(provider._translateChunk(['Hello'], 'en', 'fa', 'selection', null))
        .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
    });

    it('accepts identity translation where translated text equals source', async () => {
      mockResponse(provider, [{ translations: [{ text: 'URL' }] }]);

      await expect(provider._translateChunk(['URL'], 'en', 'fa', 'selection', null))
        .resolves.toEqual(['URL']);
    });

    it('should throw API_RESPONSE_INVALID when a translation item lacks translations', async () => {
      mockResponse(provider, [
        { translations: [{ text: 'سلام' }] },
        { missing: 'translations field' }
      ]);

      await expect(provider._translateChunk(['Hello', 'World'], 'en', 'fa', 'selection', null))
        .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
    });

    it('rejects an Edge response with the wrong logical item cardinality', async () => {
      vi.spyOn(provider, '_createChunks').mockResolvedValue([{ texts: ['Hello', 'World'] }]);
      vi.spyOn(provider, '_executeWithRateLimit').mockImplementation(task => task({}));
      vi.spyOn(provider, '_translateChunk').mockResolvedValue(['سلام']);

      await expect(provider._traditionalBatchTranslate(
        ['Hello', 'World'], 'en', 'fa', 'page'
      )).rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
    });

    it('should retry without from when source language is rejected', async () => {
      const executeMock = vi.spyOn(provider, '_executeRequest');
      executeMock
        .mockRejectedValueOnce(Object.assign(new Error('The source language is not valid'), {
          type: 'HTTP_ERROR',
          statusCode: 400,
        }))
        .mockImplementationOnce(async (options) => options.extractResponse([
          { translations: [{ text: 'سلام' }] }
        ]));

      const result = await provider._translateChunk(['Hello'], 'invalid-lang', 'fa', 'selection', null);

      expect(result).toEqual(['سلام']);
      expect(executeMock).toHaveBeenCalledTimes(2);
      expect(new URL(executeMock.mock.calls[0][0].url).searchParams.get('from')).toBe('invalid-lang');
      expect(new URL(executeMock.mock.calls[1][0].url).searchParams.has('from')).toBe(false);
    });

    it('does not send the auto-detect fallback after cancellation of the rejected-source request', async () => {
      const abortController = new AbortController();
      const fetchMock = vi.spyOn(proxyManager, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Map([['content-type', 'application/json']]),
        json: async () => {
          abortController.abort('user-cancelled');
          return { error: { message: 'The source language is not valid' } };
        },
        clone() { return this; },
      });

      try {
        await expect(provider._translateChunk(
          ['Hello'], 'invalid-lang', 'fa', 'page', abortController
        )).rejects.toMatchObject({ name: 'AbortError', type: 'USER_CANCELLED' });

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0][1].signal).toBe(abortController.signal);
      } finally {
        fetchMock.mockRestore();
      }
    });
  });
});
