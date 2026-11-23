import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepLTranslateProvider } from './DeepLTranslate.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { ApiKeyManager } from './ApiKeyManager.js';
import { ProviderRequestEngine } from './utils/ProviderRequestEngine.js';
import { QueueManager } from '@/features/translation/core/QueueManager.js';
import { RateLimitManager } from '@/features/translation/core/RateLimitManager.js';
import { getProviderLanguageCode } from '@/shared/config/languageConstants.js';

const deeplConfigMocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getApiTier: vi.fn(),
  getFormality: vi.fn(),
  getFreeApiUrl: vi.fn(),
  getProApiUrl: vi.fn(),
  getAIContextEnabled: vi.fn(),
  getAIHistoryEnabled: vi.fn(),
}));
const deepLLanguageDiscoveryMock = vi.hoisted(() => ({ fetch: vi.fn(), fetchFailover: vi.fn() }));
const deepLDiscoveryActual = vi.hoisted(() => ({ current: null }));

vi.mock('./DeepLLanguageDiscovery.js', async (importOriginal) => {
  const actual = await importOriginal();
  deepLDiscoveryActual.current = actual;
  return {
  fetchDeepLLanguageCatalog: deepLLanguageDiscoveryMock.fetch,
  fetchDeepLLanguageCatalogWithKeyFailover: (...args) => deepLLanguageDiscoveryMock.fetchFailover(...args),
  matchDeepLFormality: (catalog, tag) => {
    const normalizedTag = tag.toLowerCase().replace(/_/g, '-');
    const resolvedTag = normalizedTag === 'zh-cn' ? 'zh-hans' : normalizedTag;
    return catalog.find(entry => entry.normalizedTag === resolvedTag)?.features?.formalitySupport ?? 'unknown';
  },
  matchDeepLTagHandling: (catalog, sourceTag, targetTag) => {
    const normalize = (tag) => String(tag ?? '').toLowerCase().replace(/_/g, '-').trim();
    const isAutoSource = !normalize(sourceTag) || normalize(sourceTag) === 'auto';
    const check = (tag, direction) => {
      const normalizedTag = normalize(tag);
      const resolvedTag = normalizedTag === 'zh-cn'
        ? (direction === 'source' ? 'zh' : 'zh-hans')
        : normalizedTag === 'zh-tw'
          ? (direction === 'source' ? 'zh' : 'zh-hant')
          : normalizedTag;
      const entry = catalog.find(item => item.normalizedTag === resolvedTag);
      if (!entry) return 'unknown';
      if (entry.metadataValid === false) return 'unknown';
      return entry.features?.tagHandlingSupport ?? 'unknown';
    };
    const targetResult = check(targetTag, 'target');
    if (isAutoSource) return targetResult;
    const sourceResult = check(sourceTag, 'source');
    if (sourceResult === 'supported' && targetResult === 'supported') return 'supported';
    if (sourceResult === 'unknown' || targetResult === 'unknown') return 'unknown';
    return 'unsupported';
  },
  };
});

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  resolveProxyConfig: vi.fn(async () => ({})),
}));

vi.mock('@/shared/config/config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getDeeplApiKeysAsync: deeplConfigMocks.getApiKeys,
    getDeeplApiTierAsync: deeplConfigMocks.getApiTier,
    getDeeplFormalityAsync: deeplConfigMocks.getFormality,
    getDeeplFreeApiUrlAsync: deeplConfigMocks.getFreeApiUrl,
    getDeeplProApiUrlAsync: deeplConfigMocks.getProApiUrl,
    getAIContextTranslationEnabledAsync: deeplConfigMocks.getAIContextEnabled,
    getAIConversationHistoryEnabledAsync: deeplConfigMocks.getAIHistoryEnabled,
  };
});

vi.mock('webextension-polyfill', () => ({ default: { storage: { local: { get: vi.fn(), set: vi.fn() } } } }));
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ init: vi.fn(), debug: vi.fn(), debugLazy: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

const proxyFetch = vi.hoisted(() => vi.fn());
vi.mock('@/shared/proxy/ProxyManager.js', () => ({
  proxyManager: { fetch: proxyFetch, setConfig: vi.fn() },
}));

const createJsonResponse = (status, body, statusText = `HTTP ${status}`) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  headers: new Map([['content-type', 'application/json']]),
  clone() { return this; },
  json: async () => body,
});

const createMalformedJsonResponse = () => {
  const createResponse = () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map([['content-type', 'application/json']]),
    clone: createResponse,
    json: async () => {
      throw new SyntaxError('Unexpected token in JSON');
    },
  });

  return createResponse();
};

const tagCatalog = (sourceSupport = 'supported', targetSupport = 'supported') => ([
  { normalizedTag: 'en', metadataValid: true, status: 'stable', usableAsSource: true, usableAsTarget: true, features: { tagHandlingSupport: sourceSupport } },
  { normalizedTag: 'fa', metadataValid: true, status: 'stable', usableAsSource: true, usableAsTarget: true, features: { tagHandlingSupport: targetSupport } },
  { normalizedTag: 'de', metadataValid: true, status: 'stable', usableAsSource: true, usableAsTarget: true, features: { tagHandlingSupport: 'supported' } },
]);

describe('DeepLTranslateProvider response contract', () => {
  let provider;

  beforeEach(() => {
    proxyFetch.mockReset();
    deeplConfigMocks.getApiKeys.mockReset().mockResolvedValue(['key']);
    deeplConfigMocks.getApiTier.mockReset().mockResolvedValue('free');
    deeplConfigMocks.getFormality.mockReset().mockResolvedValue('default');
    deepLLanguageDiscoveryMock.fetch.mockReset();
    deepLLanguageDiscoveryMock.fetchFailover.mockReset()
      .mockImplementation((options) => deepLLanguageDiscoveryMock.fetch(options));
    deeplConfigMocks.getFreeApiUrl.mockReset().mockResolvedValue('https://api-free.deepl.test/translate');
    deeplConfigMocks.getProApiUrl.mockReset().mockResolvedValue('https://api.deepl.test/translate');
    deeplConfigMocks.getAIContextEnabled.mockReset().mockResolvedValue(false);
    deeplConfigMocks.getAIHistoryEnabled.mockReset().mockResolvedValue(false);
    provider = new DeepLTranslateProvider();
    vi.spyOn(provider, '_getConfig').mockResolvedValue({
      apiKey: 'key',
      apiTier: 'free',
      apiUrl: 'https://api.deepl.test',
    });
    vi.spyOn(provider, '_initializeProxy').mockResolvedValue(null);
  });

  const runWithRuntime = async (keys, apiTier, callback) => {
    const apiKey = keys.find(key => apiTier === 'pro' ? !key.endsWith(':fx') : true) || '';
    const apiUrl = apiTier === 'pro'
      ? 'https://api.deepl.test/translate'
      : 'https://api-free.deepl.test/translate';
    provider._getConfig.mockResolvedValue({ apiKey, apiTier, apiUrl });

    const getKeysSpy = vi.spyOn(ApiKeyManager, 'getKeys').mockResolvedValue(keys);
    const promoteKeySpy = vi.spyOn(ApiKeyManager, 'promoteKey').mockResolvedValue();
    const executeRequestSpy = vi.spyOn(provider, '_executeRequest')
      .mockImplementation(params => ProviderRequestEngine.executeRequest(provider, params));

    try {
      return await callback({ apiUrl, getKeysSpy, promoteKeySpy, executeRequestSpy });
    } finally {
      getKeysSpy.mockRestore();
      promoteKeySpy.mockRestore();
      executeRequestSpy.mockRestore();
    }
  };

  describe('language mapping', () => {
    it.each([
      ['zh', 'ZH'],
      ['zh-cn', 'ZH'],
      ['zh-tw', 'ZH'],
      ['zh-Hans', 'ZH'],
      ['zh-Hant', 'ZH'],
    ])('maps Chinese source %s to %s in the request body', async (sourceLang, expectedSource) => {
      await runWithRuntime(['key'], 'free', async () => {
        proxyFetch.mockResolvedValue(createJsonResponse(200, { translations: [{ text: 'translated' }] }, 'OK'));

        await expect(provider._translateChunk(['source'], sourceLang, 'en', 'selection', null, 0, 1, 0, 1, {}))
          .resolves.toEqual(['translated']);

        const body = proxyFetch.mock.calls[0][1].body;
        expect(body.get('source_lang')).toBe(expectedSource);
      });
    });

    it.each([
      ['zh', 'ZH'],
      ['zh-cn', 'ZH-HANS'],
      ['ZH_CN', 'ZH-HANS'],
      ['zh-tw', 'ZH-HANT'],
      ['en-US', 'en-US'],
      ['pt-BR', 'PT-BR'],
      ['pt_BR', 'PT-BR'],
    ])('maps Chinese target %s to %s in the request body', async (targetLang, expectedTarget) => {
      await runWithRuntime(['key'], 'free', async () => {
        proxyFetch.mockResolvedValue(createJsonResponse(200, { translations: [{ text: 'translated' }] }, 'OK'));

        await expect(provider._translateChunk(['source'], 'en', targetLang, 'selection', null, 0, 1, 0, 1, {}))
          .resolves.toEqual(['translated']);

        const body = proxyFetch.mock.calls[0][1].body;
        expect(body.get('target_lang')).toBe(expectedTarget);
      });
    });

    it.each([
      ['en', 'de'],
      ['fa', 'en'],
      ['ar', 'en'],
      ['de', 'en'],
    ])('preserves pre-directional mapping for %s to %s', async (sourceLang, targetLang) => {
      const expectedSource = getProviderLanguageCode(sourceLang, 'DEEPL');
      const expectedTarget = getProviderLanguageCode(targetLang, 'DEEPL');

      await runWithRuntime(['key'], 'free', async () => {
        proxyFetch.mockResolvedValue(createJsonResponse(200, { translations: [{ text: 'translated' }] }, 'OK'));

        await expect(provider._translateChunk(['source'], sourceLang, targetLang, 'selection', null, 0, 1, 0, 1, {}))
          .resolves.toEqual(['translated']);

        const body = proxyFetch.mock.calls[0][1].body;
        expect(body.get('source_lang')).toBe(expectedSource);
        expect(body.get('target_lang')).toBe(expectedTarget);
      });
    });

    it('omits source_lang for auto-detection', async () => {
      await runWithRuntime(['key'], 'free', async () => {
        proxyFetch.mockResolvedValue(createJsonResponse(200, { translations: [{ text: 'translated' }] }, 'OK'));

        await expect(provider._translateChunk(['source'], 'auto', 'en', 'selection', null, 0, 1, 0, 1, {}))
          .resolves.toEqual(['translated']);

        const body = proxyFetch.mock.calls[0][1].body;
        expect(body.has('source_lang')).toBe(false);
      });
    });
  });

  describe('formality', () => {
    const supportedCatalog = [{ normalizedTag: 'de', features: { formalitySupport: 'supported' } }];

    const runFormality = async (preference, catalogResult, target = 'de') => {
      deeplConfigMocks.getFormality.mockResolvedValue(preference);
      if (catalogResult instanceof Error) deepLLanguageDiscoveryMock.fetch.mockRejectedValue(catalogResult);
      else deepLLanguageDiscoveryMock.fetch.mockResolvedValue({ catalog: catalogResult });
      vi.spyOn(provider, '_executeRequest').mockImplementation(async params => {
        capturedBody = params.fetchOptions.body;
        return params.extractResponse({ translations: [{ text: 'translated' }] });
      });
      await provider._translateChunk(['source'], 'en', target, 'selection', null, 0, 1, 0, 1, {});
      return capturedBody;
    };
    let capturedBody;

    it('sends strict values only for a confirmed target, including beta targets', async () => {
      const body = await runFormality('more', [{ ...supportedCatalog[0], normalizedTag: 'ace' }], 'ace');
      expect(body.get('formality')).toBe('more');
      expect(deepLLanguageDiscoveryMock.fetch).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'key', apiTier: 'free' }));
    });

    it('resolves saved zh-cn target alias for strict formality and preserves source zh-tw mapping', async () => {
      const catalog = [{ normalizedTag: 'zh-hans', features: { formalitySupport: 'supported' } }];
      deeplConfigMocks.getFormality.mockResolvedValue('more');
      deepLLanguageDiscoveryMock.fetch.mockResolvedValue({ catalog });
      vi.spyOn(provider, '_executeRequest').mockImplementation(async params => {
        capturedBody = params.fetchOptions.body;
        return params.extractResponse({ translations: [{ text: 'translated' }] });
      });

      await provider._translateChunk(['source'], 'ZH_TW', 'zh_cn', 'selection', null, 0, 1, 0, 1, {});

      expect(capturedBody.get('source_lang')).toBe('ZH');
      expect(capturedBody.get('target_lang')).toBe('ZH-HANS');
      expect(capturedBody.get('formality')).toBe('more');
      expect(capturedBody.has('enable_beta_languages')).toBe(false);
    });

    it.each([
      ['unsupported', [{ normalizedTag: 'de', features: { formalitySupport: 'unsupported' } }]],
      ['offline', new Error('offline')],
    ])('omits strict formality when target capability is %s', async (_label, catalog) => {
      const body = await runFormality('less', catalog);
      expect(body.has('formality')).toBe(false);
    });

    it.each(['prefer_more', 'prefer_less'])('sends preference %s without capability lookup', async preference => {
      const body = await runFormality(preference, new Error('offline'));
      expect(body.get('formality')).toBe(preference);
      expect(deepLLanguageDiscoveryMock.fetch).not.toHaveBeenCalled();
    });

    it('omits default formality and deprecated beta request parameter', async () => {
      const body = await runFormality('default', new Error('offline'));
      expect(body.has('formality')).toBe(false);
      expect(body.has('enable_beta_languages')).toBe(false);
    });

    it.each([
      ['user-cancelled', { type: ErrorTypes.USER_CANCELLED }],
      ['document-replaced', { name: 'AbortError', operationAborted: true, cancellationReason: 'document-replaced' }],
    ])('preserves %s cancellation while metadata discovery is pending', async (reason, expected) => {
      deeplConfigMocks.getFormality.mockResolvedValue('more');
      let resolveDiscovery;
      deepLLanguageDiscoveryMock.fetch.mockReturnValue(new Promise(resolve => { resolveDiscovery = resolve; }));
      const controller = new AbortController();
      const request = provider._translateChunk(['source'], 'en', 'de', 'selection', controller, 0, 1, 0, 1, {});
      await vi.waitFor(() => expect(deepLLanguageDiscoveryMock.fetch).toHaveBeenCalled());

      controller.abort(reason);
      resolveDiscovery({ catalog: supportedCatalog });

      await expect(request).rejects.toMatchObject(expected);
      expect(proxyFetch).not.toHaveBeenCalled();
    });

    it('prioritizes cancellation when metadata transport rejects with a network TypeError', async () => {
      deeplConfigMocks.getFormality.mockResolvedValue('more');
      const controller = new AbortController();
      deepLLanguageDiscoveryMock.fetch.mockImplementation(async () => {
        controller.abort('operation-abort');
        throw new TypeError('Failed to fetch');
      });

      await expect(provider._translateChunk(['source'], 'en', 'de', 'selection', controller, 0, 1, 0, 1, {}))
        .rejects.toMatchObject({ name: 'AbortError', operationAborted: true, cancellationReason: 'operation-abort' });
      expect(proxyFetch).not.toHaveBeenCalled();
    });

    it('omits strict formality after first-key discovery denial while translation failover succeeds', async () => {
      deeplConfigMocks.getFormality.mockResolvedValue('more');
      deepLLanguageDiscoveryMock.fetch.mockRejectedValue(new Error('discovery denied'));
      await runWithRuntime(['bad-key', 'good-key'], 'free', async () => {
        proxyFetch
          .mockResolvedValueOnce(createJsonResponse(401, { detail: 'Invalid API key' }, 'Unauthorized'))
          .mockResolvedValueOnce(createJsonResponse(200, { translations: [{ text: 'translated' }] }, 'OK'));

        await expect(provider._translateChunk(['source'], 'en', 'de', 'selection', null, 0, 1, 0, 1, {}))
          .resolves.toEqual(['translated']);
        expect(proxyFetch).toHaveBeenCalledTimes(2);
        expect(proxyFetch.mock.calls[0][1].body.has('formality')).toBe(false);
        expect(proxyFetch.mock.calls[1][1].body.has('formality')).toBe(false);
      });
    });

    it('sends strict formality on concurrent translations sharing one in-flight discovery', async () => {
      deeplConfigMocks.getFormality.mockResolvedValue('more');
      let resolveDiscovery;
      const discoveryGate = new Promise(resolve => { resolveDiscovery = resolve; });
      deepLLanguageDiscoveryMock.fetch.mockReturnValue(discoveryGate);
      const bodies = [];
      vi.spyOn(provider, '_executeRequest').mockImplementation(async params => {
        bodies.push(params.fetchOptions.body);
        return params.extractResponse({ translations: [{ text: 'translated' }] });
      });

      const first = provider._translateChunk(['first'], 'en', 'de', 'selection', null, 0, 1, 0, 1, {});
      const second = provider._translateChunk(['second'], 'en', 'de', 'selection', null, 0, 1, 0, 1, {});
      await vi.waitFor(() => expect(deepLLanguageDiscoveryMock.fetch).toHaveBeenCalledTimes(2));
      resolveDiscovery({ catalog: supportedCatalog });

      await expect(first).resolves.toEqual(['translated']);
      await expect(second).resolves.toEqual(['translated']);
      expect(bodies).toHaveLength(2);
      expect(bodies[0].get('formality')).toBe('more');
      expect(bodies[1].get('formality')).toBe('more');
    });
  });

  describe('runtime key policy', () => {
    it('selects first Pro-compatible key without changing endpoint tier', async () => {
      provider._getConfig.mockRestore();
      deeplConfigMocks.getApiKeys.mockResolvedValue(['free-key:fx', 'pro-key-1', 'pro-key-2']);
      deeplConfigMocks.getApiTier.mockResolvedValue('pro');

      await expect(provider._getConfig()).resolves.toEqual({
        apiKey: 'pro-key-1',
        apiTier: 'pro',
        apiUrl: 'https://api.deepl.test/translate',
        apiKeys: ['free-key:fx', 'pro-key-1', 'pro-key-2'],
      });
    });

    it('returns missing-key configuration when Pro has no compatible keys', async () => {
      provider._getConfig.mockRestore();
      deeplConfigMocks.getApiKeys.mockResolvedValue(['free-key:fx']);
      deeplConfigMocks.getApiTier.mockResolvedValue('pro');

      await expect(provider._getConfig()).resolves.toMatchObject({
        apiKey: '',
        apiTier: 'pro',
        apiUrl: 'https://api.deepl.test/translate',
      });
    });

    it('keeps unsuffixed and :fx keys eligible for Free tier', () => {
      const context = { apiTier: 'free' };

      expect(provider.isApiKeyCandidateEligible('free-key:fx', context)).toBe(true);
      expect(provider.isApiKeyCandidateEligible('unsuffixed-key', context)).toBe(true);
    });

    it('rejects only :fx keys for Pro tier candidates', () => {
      const context = { apiTier: 'pro' };

      expect(provider.isApiKeyCandidateEligible('free-key:fx', context)).toBe(false);
      expect(provider.isApiKeyCandidateEligible('pro-key', context)).toBe(true);
    });

    it.each([
      [401, ErrorTypes.API_KEY_INVALID, true],
      [401, ErrorTypes.HTTP_ERROR, false],
      [403, ErrorTypes.FORBIDDEN_ERROR, false],
      [456, ErrorTypes.DEEPL_QUOTA_EXCEEDED, false],
      [429, ErrorTypes.RATE_LIMIT_REACHED, false],
      [529, ErrorTypes.RATE_LIMIT_REACHED, false],
      [500, ErrorTypes.SERVER_ERROR, false],
      [undefined, ErrorTypes.NETWORK_ERROR, false],
    ])('rotates only canonical HTTP 401 API_KEY_INVALID errors', (statusCode, type, expected) => {
      expect(provider.shouldFailoverApiKey({ statusCode, type })).toBe(expected);
    });
  });

  describe('runtime failover', () => {
    it('rotates invalid first key, preserves request, and promotes successful key', async () => {
      await runWithRuntime(['bad-key', 'good-key'], 'free', async ({ apiUrl, promoteKeySpy }) => {
        proxyFetch
          .mockResolvedValueOnce(createJsonResponse(401, { detail: 'Invalid API key' }, 'Unauthorized'))
          .mockResolvedValueOnce(createJsonResponse(200, { translations: [{ text: 'translated' }] }, 'OK'));

        await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
          .resolves.toEqual(['translated']);

        expect(proxyFetch).toHaveBeenCalledTimes(2);
        const firstRequest = proxyFetch.mock.calls[0];
        const secondRequest = proxyFetch.mock.calls[1];
        expect(firstRequest[0]).toBe(apiUrl);
        expect(secondRequest[0]).toBe(apiUrl);
        expect(firstRequest[1].headers.Authorization).toBe('DeepL-Auth-Key bad-key');
        expect(secondRequest[1].headers.Authorization).toBe('DeepL-Auth-Key good-key');
        expect(secondRequest[1].body).toBe(firstRequest[1].body);
        expect(promoteKeySpy).toHaveBeenCalledWith('DEEPL_API_KEY', 'good-key');
      });
    });

    it('preserves API_KEY_INVALID after all compatible keys fail', async () => {
      await runWithRuntime(['bad-key-1', 'bad-key-2'], 'free', async ({ promoteKeySpy }) => {
        proxyFetch
          .mockResolvedValueOnce(createJsonResponse(401, { detail: 'Invalid API key' }, 'Unauthorized'))
          .mockResolvedValueOnce(createJsonResponse(401, { detail: 'Invalid API key' }, 'Unauthorized'));

        await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
          .rejects.toMatchObject({ type: ErrorTypes.API_KEY_INVALID, statusCode: 401 });

        expect(proxyFetch).toHaveBeenCalledTimes(2);
        expect(promoteKeySpy).not.toHaveBeenCalled();
      });
    });

    it.each([
      [403, ErrorTypes.FORBIDDEN_ERROR, 'Forbidden'],
      [456, ErrorTypes.DEEPL_QUOTA_EXCEEDED, 'Quota exceeded'],
      [429, ErrorTypes.RATE_LIMIT_REACHED, 'Too Many Requests'],
      [529, ErrorTypes.RATE_LIMIT_REACHED, 'Too Many Requests'],
      [400, ErrorTypes.HTTP_ERROR, 'Invalid parameter'],
      [422, ErrorTypes.HTTP_ERROR, 'Invalid parameter'],
      [500, ErrorTypes.SERVER_ERROR, 'Internal Server Error'],
    ])('does not rotate DeepL key for HTTP %s', async (statusCode, type, message) => {
      await runWithRuntime(['first-key', 'second-key'], 'free', async ({ promoteKeySpy }) => {
        proxyFetch.mockResolvedValue(createJsonResponse(statusCode, { detail: message }, message));

        await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
          .rejects.toMatchObject({ type, statusCode });

        expect(proxyFetch).toHaveBeenCalledTimes(1);
        expect(promoteKeySpy).not.toHaveBeenCalled();
      });
    });

    it('does not rotate network failures', async () => {
      await runWithRuntime(['first-key', 'second-key'], 'free', async ({ promoteKeySpy }) => {
        proxyFetch.mockRejectedValue(new TypeError('NetworkError: Failed to fetch'));

        await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
          .rejects.toMatchObject({ type: ErrorTypes.NETWORK_ERROR });

        expect(proxyFetch).toHaveBeenCalledTimes(1);
        expect(promoteKeySpy).not.toHaveBeenCalled();
      });
    });

    it('skips :fx keys for Pro while keeping endpoint fixed', async () => {
      await runWithRuntime(['free-key:fx', 'pro-key-1', 'pro-key-2'], 'pro', async ({ apiUrl, promoteKeySpy }) => {
        proxyFetch
          .mockResolvedValueOnce(createJsonResponse(401, { detail: 'Invalid API key' }, 'Unauthorized'))
          .mockResolvedValueOnce(createJsonResponse(200, { translations: [{ text: 'translated' }] }, 'OK'));

        await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
          .resolves.toEqual(['translated']);

        expect(proxyFetch).toHaveBeenCalledTimes(2);
        expect(proxyFetch.mock.calls[0][0]).toBe(apiUrl);
        expect(proxyFetch.mock.calls[1][0]).toBe(apiUrl);
        expect(proxyFetch.mock.calls[0][1].headers.Authorization).toBe('DeepL-Auth-Key pro-key-1');
        expect(proxyFetch.mock.calls[1][1].headers.Authorization).toBe('DeepL-Auth-Key pro-key-2');
        expect(promoteKeySpy).toHaveBeenCalledWith('DEEPL_API_KEY', 'pro-key-2');
      });
    });

    it('isolates tier context across concurrent requests on one provider instance', async () => {
      const keys = ['free-key:fx', 'pro-key-1', 'pro-key-2'];
      const keyReadResolvers = [];
      let resolveBothKeyReads;
      const bothKeyReads = new Promise(resolve => {
        resolveBothKeyReads = resolve;
      });
      const getKeysSpy = vi.spyOn(ApiKeyManager, 'getKeys').mockImplementation(() => new Promise(resolve => {
        keyReadResolvers.push(resolve);
        if (keyReadResolvers.length === 2) resolveBothKeyReads();
      }));
      const promoteKeySpy = vi.spyOn(ApiKeyManager, 'promoteKey').mockResolvedValue();
      const eligibilitySpy = vi.spyOn(provider, 'isApiKeyCandidateEligible');
      provider._getConfig
        .mockResolvedValueOnce({
          apiKey: 'pro-key-1',
          apiTier: 'pro',
          apiUrl: 'https://api.deepl.test/translate',
        })
        .mockResolvedValueOnce({
          apiKey: 'free-key:fx',
          apiTier: 'free',
          apiUrl: 'https://api-free.deepl.test/translate',
        });

      const attempts = new Map();
      proxyFetch.mockImplementation(async (_url, options) => {
        const source = options.body.get('text');
        const attempt = (attempts.get(source) || 0) + 1;
        attempts.set(source, attempt);
        const authorization = options.headers.Authorization;

        if (source === 'pro-source' && authorization === 'DeepL-Auth-Key pro-key-1' && attempt === 1) {
          return createJsonResponse(401, { detail: 'Invalid API key' }, 'Unauthorized');
        }
        if (source === 'pro-source' && authorization === 'DeepL-Auth-Key pro-key-2') {
          return createJsonResponse(200, { translations: [{ text: 'pro-translated' }] }, 'OK');
        }
        if (source === 'free-source' && authorization === 'DeepL-Auth-Key free-key:fx' && attempt === 1) {
          return createJsonResponse(401, { detail: 'Invalid API key' }, 'Unauthorized');
        }
        if (source === 'free-source' && authorization === 'DeepL-Auth-Key pro-key-1') {
          return createJsonResponse(200, { translations: [{ text: 'free-translated' }] }, 'OK');
        }

        throw new Error(`Unexpected ${source} request authorization: ${authorization}`);
      });

      const proRequest = provider._translateChunk(['pro-source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {});
      const freeRequest = provider._translateChunk(['free-source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {});

      try {
        await bothKeyReads;

        // Resolve Free first while Pro remains suspended at key retrieval.
        keyReadResolvers[1](keys);
        await expect(freeRequest).resolves.toEqual(['free-translated']);

        keyReadResolvers[0](keys);
        await expect(proRequest).resolves.toEqual(['pro-translated']);

        expect(eligibilitySpy).toHaveBeenCalledWith('free-key:fx', { apiTier: 'pro' });
        expect(eligibilitySpy).toHaveBeenCalledWith('free-key:fx', { apiTier: 'free' });
        expect(proxyFetch.mock.calls
          .filter(([, options]) => options.body.get('text') === 'pro-source')
          .map(([, options]) => options.headers.Authorization))
          .toEqual(['DeepL-Auth-Key pro-key-1', 'DeepL-Auth-Key pro-key-2']);
        expect(proxyFetch.mock.calls
          .filter(([, options]) => options.body.get('text') === 'free-source')
          .map(([, options]) => options.headers.Authorization))
          .toEqual(['DeepL-Auth-Key free-key:fx', 'DeepL-Auth-Key pro-key-1']);
        expect(promoteKeySpy).toHaveBeenCalledWith('DEEPL_API_KEY', 'pro-key-2');
        expect(promoteKeySpy).toHaveBeenCalledWith('DEEPL_API_KEY', 'pro-key-1');
      } finally {
        getKeysSpy.mockRestore();
        promoteKeySpy.mockRestore();
        eligibilitySpy.mockRestore();
      }
    });

    it('fails safely without a request when Pro has only :fx keys', async () => {
      provider._getConfig.mockResolvedValue({
        apiKey: '',
        apiTier: 'pro',
        apiUrl: 'https://api.deepl.test/translate',
      });

      await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
        .rejects.toMatchObject({ type: ErrorTypes.API_KEY_MISSING });
      expect(proxyFetch).not.toHaveBeenCalled();
    });

    it('keeps :fx as the first eligible Free-tier key', async () => {
      await runWithRuntime(['free-key:fx', 'unsuffixed-key'], 'free', async () => {
        proxyFetch.mockResolvedValue(createJsonResponse(200, { translations: [{ text: 'translated' }] }, 'OK'));

        await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
          .resolves.toEqual(['translated']);

        expect(proxyFetch).toHaveBeenCalledTimes(1);
        expect(proxyFetch.mock.calls[0][1].headers.Authorization).toBe('DeepL-Auth-Key free-key:fx');
      });
    });

    it('resolves a fresh proxy snapshot for each physical key attempt', async () => {
      const firstProxy = { enabled: true, host: 'proxy-first' };
      const secondProxy = { enabled: true, host: 'proxy-second' };
      provider._initializeProxy
        .mockReset()
        .mockResolvedValueOnce(firstProxy)
        .mockResolvedValueOnce(secondProxy);

      await runWithRuntime(['bad-key', 'good-key'], 'free', async () => {
        proxyFetch
          .mockResolvedValueOnce(createJsonResponse(401, { detail: 'Invalid API key' }, 'Unauthorized'))
          .mockResolvedValueOnce(createJsonResponse(200, { translations: [{ text: 'translated' }] }, 'OK'));

        await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
          .resolves.toEqual(['translated']);

        expect(provider._initializeProxy).toHaveBeenCalledTimes(2);
        expect(proxyFetch.mock.calls[0][2]).toBe(firstProxy);
        expect(proxyFetch.mock.calls[1][2]).toBe(secondProxy);
      });
    });

    it('stops before second key when cancellation follows first failure', async () => {
      const abortController = new AbortController();

      await runWithRuntime(['bad-key', 'good-key'], 'free', async ({ promoteKeySpy }) => {
        proxyFetch.mockImplementationOnce(async () => {
          abortController.abort('user-cancelled');
          return createJsonResponse(401, { detail: 'Invalid API key' }, 'Unauthorized');
        });

        await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', abortController, 0, 1, 0, 1, {}))
          .rejects.toMatchObject({ type: ErrorTypes.USER_CANCELLED });

        expect(proxyFetch).toHaveBeenCalledTimes(1);
        expect(promoteKeySpy).not.toHaveBeenCalled();
      });
    });
  });

  const translate = async (response, texts = ['source'], options = {}) => {
    vi.spyOn(provider, '_executeRequest').mockImplementation(async (options) => options.extractResponse(response));
    return provider._translateChunk(texts, 'en', 'fa', 'selection', null, 0, texts.length, 0, 1, options);
  };

  const requestSizeError = (message = 'HTTP 400: request is too long', statusCode = 400) => Object.assign(
    new Error(message),
    { type: ErrorTypes.HTTP_ERROR, statusCode },
  );

  it('accepts valid source-equal output', async () => {
    await expect(translate({ translations: [{ text: 'URL' }] }, ['URL'])).resolves.toEqual(['URL']);
  });

  it('returns ordered valid multi-item translations with blank input preserved', async () => {
    await expect(translate({ translations: [{ text: 'one translated' }, { text: 'two translated' }] }, ['one', ' ', 'two']))
      .resolves.toEqual(['one translated', '', 'two translated']);
  });

  it('writes one detected source when all reported sources agree', async () => {
    const options = { providerMetadataRef: { metadata: {} } };

    await translate({
      translations: [
        { text: 'one translated', detected_source_language: 'EN' },
        { text: 'two translated', detected_source_language: 'en' },
      ],
    }, ['one', 'two'], options);

    expect(options.providerMetadataRef.metadata.detectedLanguage).toBe('en');
    expect(provider).not.toHaveProperty('lastDetectedLanguage');
  });

  it('does not publish conflicting or missing detected sources', async () => {
    const conflictingOptions = { providerMetadataRef: { metadata: {} } };
    await translate({
      translations: [
        { text: 'one translated', detected_source_language: 'en' },
        { text: 'two translated', detected_source_language: 'de' },
      ],
    }, ['one', 'two'], conflictingOptions);
    expect(conflictingOptions.providerMetadataRef.metadata).toEqual({});

    const missingOptions = { providerMetadataRef: { metadata: {} } };
    await translate({ translations: [{ text: 'translated' }] }, ['source'], missingOptions);
    expect(missingOptions.providerMetadataRef.metadata).toEqual({});
  });

  it.each([
    ['missing translations', {}],
    ['blank item', { translations: [{ text: '  ' }] }],
    ['wrong cardinality', { translations: [{ text: 'one' }] }],
  ])('throws API_RESPONSE_INVALID for %s', async (_label, response) => {
    const options = { providerMetadataRef: { metadata: {} } };
    await expect(translate(response, ['one', 'two'], options)).rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
    expect(options.providerMetadataRef.metadata).toEqual({});
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty array', []],
  ])('rejects unexpected final %s result with API_RESPONSE_INVALID', async (_label, response) => {
    vi.spyOn(provider, '_executeRequest').mockResolvedValue(response);

    await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
      .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
  });

  it.each([
    [ErrorTypes.NETWORK_ERROR],
    [ErrorTypes.USER_CANCELLED],
    [ErrorTypes.TRANSLATION_TIMEOUT],
  ])('preserves %s failures from transport', async (type) => {
    const error = Object.assign(new Error(type), { type });
    vi.spyOn(provider, '_executeRequest').mockRejectedValue(error);

    await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
      .rejects.toMatchObject({ type });
  });

  it('rejects malformed successful JSON without key failover or source substitution', async () => {
    await runWithRuntime(['bad-key', 'good-key'], 'free', async ({ promoteKeySpy, executeRequestSpy }) => {
      proxyFetch.mockResolvedValue(createMalformedJsonResponse());

      await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
        .rejects.toMatchObject({
          type: ErrorTypes.JSON_PARSING_ERROR,
          statusCode: 200,
          providerName: 'DeepLTranslate',
        });

      expect(proxyFetch).toHaveBeenCalledTimes(1);
      expect(executeRequestSpy).toHaveBeenCalledTimes(1);
      expect(promoteKeySpy).not.toHaveBeenCalled();
    });
  });

  it.each([
    [529, ErrorTypes.RATE_LIMIT_REACHED, 'Too Many Requests'],
    [500, ErrorTypes.SERVER_ERROR, 'Internal Server Error'],
    [400, ErrorTypes.HTTP_ERROR, 'Bad Request'],
  ])('classifies DeepL HTTP %s as %s while preserving request metadata', async (statusCode, type, statusText) => {
    proxyFetch.mockResolvedValue({
      ok: false,
      status: statusCode,
      statusText,
      headers: { get: () => 'application/json' },
      clone() { return this; },
      json: async () => ({ message: statusText }),
    });

    await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
      .rejects.toMatchObject({
        type,
        statusCode,
        context: 'deepltranslate-translate-chunk',
        providerName: 'DeepLTranslate',
      });
  });

  it.each([
    ['current source wording', "Bad request. Reason: Value for 'source_lang' not supported."],
    ['current target wording', "Bad request. Reason: Value for 'target_lang' not supported."],
    ['alternate source token wording', 'source_lang is not supported'],
    ['alternate target token wording', 'target_lang is not supported'],
    ['human-readable source wording', 'Unsupported source language'],
    ['human-readable target wording', 'Unsupported target language'],
    ['normalized case and punctuation', 'SOURCE_LANG   IS NOT SUPPORTED!'],
    ['double-quoted target wording', 'Value for "target_lang" is not supported.'],
  ])('classifies %s as LANGUAGE_PAIR_NOT_SUPPORTED without fallback', async (_caseName, message) => {
    await runWithRuntime(['first-key', 'second-key'], 'free', async ({ promoteKeySpy }) => {
      proxyFetch.mockResolvedValue(createJsonResponse(400, { detail: message }, 'Bad Request'));

      await expect(provider._translateChunk(
        ['first', 'second'],
        'en',
        'de',
        'selection',
        null,
        0,
        2,
        0,
        1,
        {},
      )).rejects.toMatchObject({
        type: ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED,
        statusCode: 400,
        context: 'deepltranslate-translate-chunk',
        providerName: 'DeepLTranslate',
        message,
      });

      expect(proxyFetch).toHaveBeenCalledTimes(1);
      expect(promoteKeySpy).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['unsupported response_format', 'Unsupported response_format'],
    ['unsupported option', 'Unsupported option'],
    ['invalid target language', 'Invalid target language'],
    ['language detection failure', 'Language detection failed'],
    ['generic unsupported request', 'Request not supported'],
  ])('keeps %s as generic HTTP_ERROR', async (_caseName, message) => {
    await runWithRuntime(['key'], 'free', async ({ promoteKeySpy }) => {
      proxyFetch.mockResolvedValue(createJsonResponse(400, { detail: message }, 'Bad Request'));

      await expect(provider._translateChunk(['source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
        .rejects.toMatchObject({
          type: ErrorTypes.HTTP_ERROR,
          statusCode: 400,
        });

      expect(proxyFetch).toHaveBeenCalledTimes(1);
      expect(promoteKeySpy).not.toHaveBeenCalled();
    });
  });

  it('keeps unsupported language terminal through QueueManager', async () => {
    await runWithRuntime(['key'], 'free', async () => {
      proxyFetch.mockResolvedValue(createJsonResponse(400, { detail: 'source_lang is not supported' }, 'Bad Request'));

      const queueManager = QueueManager.getInstance();
      const request = vi.fn(() => provider._translateChunk(
        ['source'],
        'en',
        'fa',
        'selection',
        null,
        0,
        1,
        0,
        1,
        {},
      ));

      await expect(queueManager.enqueue('deepl-language-pair-test', request))
        .rejects.toMatchObject({ type: ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED });

      expect(request).toHaveBeenCalledTimes(1);
      expect(proxyFetch).toHaveBeenCalledTimes(1);
      expect(queueManager.retryTimeouts.size).toBe(0);
    });
  });

  it('rejects the parent when a recursive HTTP-400 split child fails', async () => {
    const http400 = requestSizeError();
    let calls = 0;
    vi.spyOn(provider, '_executeRequest').mockImplementation(async (options) => {
      calls++;
      if (calls === 1 || calls === 3) throw http400;
      return options.extractResponse({ translations: [{ text: 'first translated' }] });
    });

    await expect(provider._translateChunk(['first', 'second'], 'en', 'fa', 'selection', null, 0, 2, 0, 1, {}))
      .rejects.toThrow('HTTP 400');
    expect(calls).toBe(3);
  });

  it('translates recursive split children sequentially and preserves result order', async () => {
    let calls = 0;
    vi.spyOn(provider, '_executeRequest').mockImplementation(async options => {
      calls++;
      if (calls === 1) throw requestSizeError();
      const text = options.fetchOptions.body.get('text');
      return options.extractResponse({ translations: [{ text: `translated ${text}` }] });
    });

    await expect(provider._translateChunk(['first', 'second'], 'en', 'fa', 'selection', null, 0, 2, 0, 1, {}))
      .resolves.toEqual(['translated first', 'translated second']);
    expect(calls).toBe(3);
  });

  it('does not start the second split child after the first child fails', async () => {
    const network = Object.assign(new Error('network failed'), { type: ErrorTypes.NETWORK_ERROR });
    let calls = 0;
    vi.spyOn(provider, '_executeRequest').mockImplementation(async () => {
      calls++;
      if (calls === 1) throw requestSizeError();
      throw network;
    });

    await expect(provider._translateChunk(['first', 'second'], 'en', 'fa', 'selection', null, 0, 2, 0, 1, {}))
      .rejects.toBe(network);
    expect(calls).toBe(2);
  });

  it('does not start the second split child when the first child completes after cancellation', async () => {
    const controller = new AbortController();
    let calls = 0;
    vi.spyOn(provider, '_executeRequest').mockImplementation(async options => {
      calls++;
      if (calls === 1) throw requestSizeError();
      controller.abort('user-cancelled');
      return options.extractResponse({ translations: [{ text: 'translated first' }] });
    });

    await expect(provider._translateChunk(['first', 'second'], 'en', 'fa', 'selection', controller, 0, 2, 0, 1, {}))
      .rejects.toMatchObject({ type: ErrorTypes.USER_CANCELLED });
    expect(calls).toBe(2);
  });

  it('keeps physical DeepL requests within the limiter capacity during concurrent splits', async () => {
    const limiter = RateLimitManager.getInstance();
    const providerName = provider.providerName;
    const priorState = limiter.providerStates.get(providerName);
    limiter.providerStates.delete(providerName);
    const state = limiter._initializeProvider(providerName, { maxConcurrent: 2, delayBetweenRequests: 0 });
    state.config = { ...state.config, maxConcurrent: 2, delayBetweenRequests: 0 };
    state.isManualConfig = true;
    let active = 0;
    let maximumActive = 0;
    const childArrivals = [];
    let releaseChildren;
    const childGate = new Promise(resolve => { releaseChildren = resolve; });
    let resolveFirstPair;
    const firstPair = new Promise(resolve => { resolveFirstPair = resolve; });

    try {
      await runWithRuntime(['key'], 'free', async () => {
      proxyFetch.mockImplementation(async (_url, options) => {
        const texts = options.body.getAll('text');
        if (texts.length > 1) return createJsonResponse(400, { message: 'HTTP request is too long' }, 'Bad Request');
        active++;
        maximumActive = Math.max(maximumActive, active);
        childArrivals.push(options.body.get('text'));
        if (childArrivals.length === 2) resolveFirstPair();
        try {
          await childGate;
          return createJsonResponse(200, { translations: [{ text: `translated ${texts[0]}` }] }, 'OK');
        } finally {
          active--;
        }
      });

      const executeOuter = text => provider._executeWithRateLimit(
        () => provider._translateChunk([`${text}-one`, `${text}-two`], 'en', 'fa', 'selection', null, 0, 2, 0, 1, {}),
        `deepl-split-${text}`,
      );
      const first = executeOuter('alpha');
      const second = executeOuter('beta');
      try {
        await firstPair;
        expect(childArrivals).toEqual(['alpha-one', 'beta-one']);
        expect(childArrivals).not.toContain('alpha-two');
        expect(childArrivals).not.toContain('beta-two');
        expect(active).toBe(2);
        expect(maximumActive).toBe(2);
        expect(state.activeRequests).toBe(2);
        releaseChildren();
        await expect(Promise.all([first, second])).resolves.toEqual([
          ['translated alpha-one', 'translated alpha-two'],
          ['translated beta-one', 'translated beta-two'],
        ]);
        expect(maximumActive).toBeLessThanOrEqual(2);
        expect(state.activeRequests).toBe(0);
      } finally {
        releaseChildren();
        await Promise.allSettled([first, second]);
      }
      });

      expect(state.activeRequests).toBe(0);
    } finally {
      releaseChildren();
      if (state.nextProcessTimer) clearTimeout(state.nextProcessTimer);
      for (const queue of Object.values(state.queues)) {
        for (const request of queue) {
          request.cleanupAbort?.();
          request.reject(new Error('DeepL limiter test cleanup'));
        }
        queue.length = 0;
      }
      if (priorState) limiter.providerStates.set(providerName, priorState);
      else limiter.providerStates.delete(providerName);
    }
  });

  it('waits for a concurrent DeepL Retry-After before recursive request-size recovery fetches', async () => {
    vi.useFakeTimers();
    const limiter = RateLimitManager.getInstance();
    const providerName = provider.providerName;
    const priorState = limiter.providerStates.get(providerName);
    limiter.providerStates.delete(providerName);
    const state = limiter._initializeProvider(providerName, { maxConcurrent: 2, delayBetweenRequests: 0 });
    state.config = { ...state.config, maxConcurrent: 2, delayBetweenRequests: 0 };
    state.isManualConfig = true;
    let releaseFirstRecovery;
    const firstRecoveryResponse = new Promise(resolve => { releaseFirstRecovery = resolve; });
    let resolveFirstRecoveryStarted;
    const firstRecoveryStarted = new Promise(resolve => { resolveFirstRecoveryStarted = resolve; });
    const physicalCalls = [];

    try {
      await runWithRuntime(['key'], 'free', async () => {
        proxyFetch.mockImplementation(async (_url, options) => {
          const texts = options.body.getAll('text');
          physicalCalls.push(texts);
          if (texts.length > 1) {
            return createJsonResponse(400, { message: 'HTTP request is too long' }, 'Bad Request');
          }
          if (texts[0] === 'rate-limit-batch') {
            return {
              ...createJsonResponse(429, { message: 'Too Many Requests' }, 'Too Many Requests'),
              headers: { get: name => name.toLowerCase() === 'retry-after' ? '10' : null },
            };
          }
          if (texts[0] === 'recovery-one') {
            resolveFirstRecoveryStarted();
            return firstRecoveryResponse;
          }
          return createJsonResponse(200, { translations: [{ text: `translated ${texts[0]}` }] }, 'OK');
        });

        const recovery = provider._executeWithRateLimit(
          () => provider._translateChunk(['recovery-one', 'recovery-two'], 'en', 'fa', 'page', null, 0, 2, 0, 1, {}),
          'deepl-page-recovery',
        );
        await firstRecoveryStarted;
        const rateLimited = provider._executeWithRateLimit(
          () => provider._translateChunk(['rate-limit-batch'], 'en', 'fa', 'page', null, 0, 1, 0, 1, {}),
          'deepl-page-rate-limit',
        );

        await expect(rateLimited).rejects.toMatchObject({ type: ErrorTypes.RATE_LIMIT_REACHED, retryAt: expect.any(Number) });
        expect(state.retryAt).toBe(Date.now() + 10000);
        releaseFirstRecovery(createJsonResponse(200, { translations: [{ text: 'translated recovery-one' }] }, 'OK'));
        await vi.advanceTimersByTimeAsync(0);

        expect(physicalCalls).toEqual([
          ['recovery-one', 'recovery-two'],
          ['recovery-one'],
          ['rate-limit-batch'],
        ]);
        await vi.advanceTimersByTimeAsync(9999);
        expect(physicalCalls).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1);
        await expect(recovery).resolves.toEqual(['translated recovery-one', 'translated recovery-two']);
        expect(physicalCalls).toHaveLength(4);
        expect(state.activeRequests).toBe(0);
      });
    } finally {
      releaseFirstRecovery(createJsonResponse(200, { translations: [{ text: 'cleanup' }] }, 'OK'));
      if (state.nextProcessTimer) clearTimeout(state.nextProcessTimer);
      for (const queue of Object.values(state.queues)) {
        for (const request of queue) {
          request.cleanupAbort?.();
          request.reject(new Error('DeepL cooldown test cleanup'));
        }
        queue.length = 0;
      }
      if (priorState) limiter.providerStates.set(providerName, priorState);
      else limiter.providerStates.delete(providerName);
      vi.useRealTimers();
    }
  });

  it('cancels DeepL recovery waiting on shared cooldown and releases its physical slot', async () => {
    vi.useFakeTimers();
    const limiter = RateLimitManager.getInstance();
    const providerName = provider.providerName;
    const priorState = limiter.providerStates.get(providerName);
    limiter.providerStates.delete(providerName);
    const state = limiter._initializeProvider(providerName, { maxConcurrent: 2, delayBetweenRequests: 0 });
    state.config = { ...state.config, maxConcurrent: 2, delayBetweenRequests: 0 };
    state.isManualConfig = true;
    let releaseFirstRecovery;
    const firstRecoveryResponse = new Promise(resolve => { releaseFirstRecovery = resolve; });
    let resolveFirstRecoveryStarted;
    const firstRecoveryStarted = new Promise(resolve => { resolveFirstRecoveryStarted = resolve; });
    let resolveRecoveryOneFinished;
    const recoveryOneFinished = new Promise(resolve => { resolveRecoveryOneFinished = resolve; });
    const controller = new AbortController();
    const physicalCalls = [];

    try {
      await runWithRuntime(['key'], 'free', async () => {
        proxyFetch.mockImplementation(async (_url, options) => {
          const texts = options.body.getAll('text');
          physicalCalls.push(texts);
          if (texts.length > 1) return createJsonResponse(400, { message: 'HTTP request is too long' }, 'Bad Request');
          if (texts[0] === 'rate-limit-batch') {
            return {
              ...createJsonResponse(429, { message: 'Too Many Requests' }, 'Too Many Requests'),
              headers: { get: name => name.toLowerCase() === 'retry-after' ? '10' : null },
            };
          }
          if (texts[0] === 'recovery-one') {
            resolveFirstRecoveryStarted();
            const response = await firstRecoveryResponse;
            resolveRecoveryOneFinished();
            return response;
          }
          return createJsonResponse(200, { translations: [{ text: `translated ${texts[0]}` }] }, 'OK');
        });

        const recovery = provider._executeWithRateLimit(
          () => provider._translateChunk(['recovery-one', 'recovery-two'], 'en', 'fa', 'page', controller, 0, 2, 0, 1, {}),
          'deepl-page-cancelled-recovery',
          null,
          { abortController: controller },
        );
        await firstRecoveryStarted;
        const rateLimited = provider._executeWithRateLimit(
          () => provider._translateChunk(['rate-limit-batch'], 'en', 'fa', 'page', null, 0, 1, 0, 1, {}),
          'deepl-page-cancel-rate-limit',
        );

        await expect(rateLimited).rejects.toMatchObject({ type: ErrorTypes.RATE_LIMIT_REACHED });
        releaseFirstRecovery(createJsonResponse(200, { translations: [{ text: 'translated recovery-one' }] }, 'OK'));
        await recoveryOneFinished;
        await vi.advanceTimersByTimeAsync(0);
        expect(physicalCalls).toHaveLength(3);

        controller.abort('user-cancelled');
        await expect(recovery).rejects.toMatchObject({ type: ErrorTypes.USER_CANCELLED });
        expect(physicalCalls).toHaveLength(3);
        expect(state.activeRequests).toBe(0);
      });
    } finally {
      releaseFirstRecovery(createJsonResponse(200, { translations: [{ text: 'cleanup' }] }, 'OK'));
      controller.abort('user-cancelled');
      if (state.nextProcessTimer) clearTimeout(state.nextProcessTimer);
      for (const queue of Object.values(state.queues)) {
        for (const request of queue) {
          request.cleanupAbort?.();
          request.reject(new Error('DeepL cooldown cancellation test cleanup'));
        }
        queue.length = 0;
      }
      if (priorState) limiter.providerStates.set(providerName, priorState);
      else limiter.providerStates.delete(providerName);
      vi.useRealTimers();
    }
  });

  it('releases limiter capacity after DeepL recovery succeeds, fails, or is cancelled', async () => {
    const limiter = RateLimitManager.getInstance();
    const providerName = provider.providerName;
    const priorState = limiter.providerStates.get(providerName);
    limiter.providerStates.delete(providerName);
    const state = limiter._initializeProvider(providerName, {
      maxConcurrent: 1,
      delayBetweenRequests: 0,
      circuitBreakThreshold: 10,
      adaptiveBackoff: { enabled: false },
    });
    state.config = { ...state.config, maxConcurrent: 1, delayBetweenRequests: 0, adaptiveBackoff: { enabled: false } };
    state.isManualConfig = true;

    try {
      await runWithRuntime(['key'], 'free', async () => {
        for (const scenario of ['success', 'failure', 'cancelled']) {
          proxyFetch.mockClear();
          let physicalActive = 0;
          const childTexts = [];
          let releaseChild;
          const childGate = new Promise(resolve => { releaseChild = resolve; });
          let releaseSibling;
          const siblingGate = new Promise(resolve => { releaseSibling = resolve; });
          let resolveChildStarted;
          const childStarted = new Promise(resolve => { resolveChildStarted = resolve; });
          let resolvePhysicalIdle;
          const physicalIdle = new Promise(resolve => { resolvePhysicalIdle = resolve; });
          let releaseSentinel;
          const sentinelGate = new Promise(resolve => { releaseSentinel = resolve; });
          let resolveSentinelStarted;
          const sentinelStarted = new Promise(resolve => { resolveSentinelStarted = resolve; });
          let physicalAtSentinelStart;
          const controller = new AbortController();

          proxyFetch.mockImplementation(async (_url, options) => {
            const texts = options.body.getAll('text');
            if (texts.length > 1) {
              return createJsonResponse(400, { message: 'HTTP request is too long' }, 'Bad Request');
            }

            const text = texts[0];
            childTexts.push(text);
            physicalActive++;
            resolveChildStarted();
            try {
              await (scenario === 'failure' && text === 'second' ? siblingGate : childGate);
              if (scenario === 'cancelled') controller.abort('user-cancelled');
              if (scenario === 'failure') {
                throw new TypeError('NetworkError: Failed to fetch');
              }
              return createJsonResponse(200, { translations: [{ text: `translated ${text}` }] }, 'OK');
            } finally {
              physicalActive--;
              if (physicalActive === 0) resolvePhysicalIdle();
            }
          });

          const operation = provider._executeWithRateLimit(
            () => provider._translateChunk(
              ['first', 'second'], 'en', 'fa', 'selection', controller, 0, 2, 0, 1, {},
            ),
            `deepl-recovery-${scenario}`,
            null,
            { abortController: controller },
          );
          let operationOutcome;
          operation.then(
            value => { operationOutcome = { value }; },
            error => { operationOutcome = { error }; },
          );

          try {
            await childStarted;
            const sentinel = provider._executeWithRateLimit(async () => {
              physicalAtSentinelStart = physicalActive;
              resolveSentinelStarted();
              await sentinelGate;
              return 'sentinel';
            }, `deepl-recovery-sentinel-${scenario}`);
            await Promise.resolve();
            expect(Object.values(state.queues).flat()).toHaveLength(1);

            releaseChild();
            await sentinelStarted;
            await Promise.allSettled([operation]);

            expect(physicalAtSentinelStart).toBe(0);
            if (scenario === 'success') {
              expect(childTexts).toEqual(['first', 'second']);
              expect(operationOutcome).toEqual({ value: ['translated first', 'translated second'] });
              expect(proxyFetch).toHaveBeenCalledTimes(3);
            } else if (scenario === 'failure') {
              expect(childTexts).toEqual(['first']);
              expect(operationOutcome.error).toMatchObject({ type: ErrorTypes.NETWORK_ERROR });
              expect(proxyFetch).toHaveBeenCalledTimes(2);
            } else {
              expect(childTexts).toEqual(['first']);
              expect(operationOutcome.error).toMatchObject({ type: ErrorTypes.USER_CANCELLED });
              expect(proxyFetch).toHaveBeenCalledTimes(2);
            }

            releaseSentinel();
            await expect(sentinel).resolves.toBe('sentinel');
            expect(state.activeRequests).toBe(0);
          } finally {
            releaseChild();
            releaseSibling();
            releaseSentinel();
            await Promise.allSettled([operation]);
            await physicalIdle;
          }
        }
      });
    } finally {
      if (state.nextProcessTimer) clearTimeout(state.nextProcessTimer);
      for (const queue of Object.values(state.queues)) {
        for (const request of queue) {
          request.cleanupAbort?.();
          request.reject(new Error('DeepL limiter test cleanup'));
        }
        queue.length = 0;
      }
      if (priorState) limiter.providerStates.set(providerName, priorState);
      else limiter.providerStates.delete(providerName);
    }
  });

  it('rejects the parent when a sequential fallback item fails', async () => {
    const http400 = requestSizeError();
    const network = Object.assign(new Error('network failed'), { type: ErrorTypes.NETWORK_ERROR });
    let calls = 0;
    vi.spyOn(provider, '_executeRequest').mockImplementation(async (options) => {
      calls++;
      if (calls === 1) throw http400;
      if (calls === 2) return options.extractResponse({ translations: [{ text: 'first translated' }] });
      throw network;
    });

    await expect(provider._translateChunk(['first', 'second'], 'en', 'fa', 'selection', null, 3, 2, 0, 1, {}))
      .rejects.toMatchObject({ type: ErrorTypes.NETWORK_ERROR });
    expect(calls).toBe(3);
  });

  it('does not split generic HTTP 400 without request-size evidence', async () => {
    const error = Object.assign(new Error('Invalid parameter'), {
      type: ErrorTypes.HTTP_ERROR,
      statusCode: 400,
      providerName: 'DeepLTranslate',
    });
    let calls = 0;
    vi.spyOn(provider, '_executeRequest').mockImplementation(async () => {
      calls++;
      throw error;
    });

    await expect(provider._translateChunk(['first', 'second'], 'en', 'fa', 'selection', null, 0, 2, 0, 1, {}))
      .rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it.each([
    [ErrorTypes.API_KEY_INVALID, 401],
    [ErrorTypes.TEXT_EMPTY, 400],
  ])('does not split deterministic %s errors', async (type, statusCode) => {
    const error = Object.assign(new Error('HTTP 400: deterministic failure'), {
      type,
      statusCode,
    });
    let calls = 0;
    vi.spyOn(provider, '_executeRequest').mockImplementation(async () => {
      calls++;
      throw error;
    });

    await expect(provider._translateChunk(['first', 'second'], 'en', 'fa', 'selection', null, 0, 2, 0, 1, {}))
      .rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it('does not split a single-item request-size failure', async () => {
    const error = requestSizeError();
    let calls = 0;
    vi.spyOn(provider, '_executeRequest').mockImplementation(async () => {
      calls++;
      throw error;
    });

    await expect(provider._translateChunk(['single'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
      .rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it.each([400, 422])('recovers from a top-level request-size message on HTTP %s', async (statusCode) => {
    const response = (status, body, statusText) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers: { get: () => 'application/json' },
      clone() { return this; },
      json: async () => body,
    });

    proxyFetch
      .mockResolvedValueOnce(response(statusCode, { message: 'HTTP request is too long' }, 'Bad Request'))
      .mockResolvedValue(response(200, { translations: [{ text: 'translated' }] }, 'OK'));

    await expect(provider._translateChunk(
      ['first', 'second'],
      'en',
      'fa',
      'selection',
      null,
      0,
      2,
      0,
      1,
      {},
    )).resolves.toEqual(['translated', 'translated']);

    expect(proxyFetch).toHaveBeenCalledTimes(3);
  });

  it('accepts a response that preserves prepared XML placeholders', async () => {
    deepLLanguageDiscoveryMock.fetch.mockResolvedValue({ catalog: tagCatalog() });
    vi.spyOn(provider, '_executeRequest').mockImplementation(async (options) => {
      expect(options.fetchOptions.body.getAll('text')).toEqual(['before <x id="SUB_TOKEN" /> after']);
      expect(options.fetchOptions.body.get('tag_handling')).toBe('xml');
      return options.extractResponse({ translations: [{ text: 'translated <x id="SUB_TOKEN" /> text' }] });
    });

    await expect(provider._translateChunk(['before @@SUB_TOKEN@@ after'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
      .resolves.toEqual(['translated @@SUB_TOKEN@@text']);
  });

  it('preserves literal XML-looking text on the plain-text path', async () => {
    deepLLanguageDiscoveryMock.fetch.mockRejectedValue(new Error('offline'));
    const source = '< > & &amp; &lt; &gt; &#38; &#x26; mixed\u0001 text';
    vi.spyOn(provider, '_executeRequest').mockImplementation(async options => {
      expect(options.fetchOptions.body.getAll('text')).toEqual(['< > & &amp; &lt; &gt; &#38; &#x26; mixed text']);
      expect(options.fetchOptions.body.has('tag_handling')).toBe(false);
      return options.extractResponse({ translations: [{ text: 'literal <br/> &lt; &amp;' }] });
    });

    await expect(provider._translateChunk([source], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
      .resolves.toEqual(['literal <br/> &lt; &amp;']);
  });

  it('escapes original text and restores placeholders in generated XML mode', async () => {
    deepLLanguageDiscoveryMock.fetch.mockResolvedValue({ catalog: tagCatalog() });
    vi.spyOn(provider, '_executeRequest').mockImplementation(async options => {
      expect(options.fetchOptions.body.getAll('text')).toEqual([
        'before &lt; &amp;amp; &gt; <x id="SUB_TOKEN" /><br id="SUB_NL_LINE" />after',
      ]);
      expect(options.fetchOptions.body.get('tag_handling')).toBe('xml');
      return options.extractResponse({ translations: [{
        text: 'translated &lt; &amp;amp; <x id="SUB_TOKEN" /><br id="SUB_NL_LINE" /> text',
      }] });
    });

    await expect(provider._translateChunk(
      ['before < &amp; > @@SUB_TOKEN@@@@SUB_NL_LINE@@after'],
      'en', 'fa', 'selection', null, 0, 1, 0, 1, {},
    )).resolves.toEqual(['translated < &amp; @@SUB_TOKEN@@@@SUB_NL_LINE@@text']);
  });

  it('rejects XML placeholder corruption without returning source text', async () => {
    deepLLanguageDiscoveryMock.fetch.mockResolvedValue({ catalog: tagCatalog() });
    vi.spyOn(provider, '_executeRequest').mockImplementation(async (options) =>
      options.extractResponse({ translations: [{ text: 'translated text without placeholder' }] })
    );

    await expect(provider._translateChunk(['before @@SUB_TOKEN@@ after'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
      .rejects.toMatchObject({ type: ErrorTypes.API_RESPONSE_INVALID });
  });

  describe('xml tag handling capability', () => {
    const runMarkupTranslation = async (texts, source = 'en', target = 'fa') => {
      let capturedBody;
      const executeRequestSpy = vi.spyOn(provider, '_executeRequest').mockImplementation(async (options) => {
        capturedBody = options.fetchOptions.body;
        return options.extractResponse({ translations: texts.map(() => ({ text: 'translated <x id="SUB_TOKEN" /> text' })) });
      });
      const result = await provider._translateChunk(texts, source, target, 'selection', null, 0, texts.length, 0, 1, {});
      return { result, capturedBody, executeRequestSpy };
    };

    it('sends tag_handling=xml with splitting_tags for a supported pair', async () => {
      deepLLanguageDiscoveryMock.fetch.mockResolvedValue({ catalog: tagCatalog() });

      const { capturedBody } = await runMarkupTranslation(['before @@SUB_TOKEN@@ after']);

      expect(deepLLanguageDiscoveryMock.fetch).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'key', apiTier: 'free' }));
      expect(capturedBody.get('tag_handling')).toBe('xml');
      expect(capturedBody.get('splitting_tags')).toBe('n1,n2,br');
    });

    it('sends tag_handling=xml for auto source with a supported target', async () => {
      deepLLanguageDiscoveryMock.fetch.mockResolvedValue({ catalog: tagCatalog() });
      let capturedBody;
      vi.spyOn(provider, '_executeRequest').mockImplementation(async (options) => {
        capturedBody = options.fetchOptions.body;
        return options.extractResponse({ translations: [{ text: 'translated <x id="SUB_TOKEN" /> text' }] });
      });

      await provider._translateChunk(['before @@SUB_TOKEN@@ after'], 'auto', 'fa', 'selection', null, 0, 1, 0, 1, {});

      expect(capturedBody.has('source_lang')).toBe(false);
      expect(capturedBody.get('tag_handling')).toBe('xml');
      expect(capturedBody.get('splitting_tags')).toBe('n1,n2,br');
    });

    it('omits xml params and throws LANGUAGE_PAIR_NOT_SUPPORTED for an unsupported target', async () => {
      deepLLanguageDiscoveryMock.fetch.mockResolvedValue({ catalog: tagCatalog('supported', 'unsupported') });
      const executeRequestSpy = vi.spyOn(provider, '_executeRequest');

      await expect(provider._translateChunk(['before @@SUB_TOKEN@@ after'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
        .rejects.toMatchObject({ type: ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED });

      expect(executeRequestSpy).not.toHaveBeenCalled();
    });

    it('fails fast on unknown capability metadata instead of plain-text fallback', async () => {
      deepLLanguageDiscoveryMock.fetch.mockResolvedValue({
        catalog: [
          { normalizedTag: 'en', features: {} },
          { normalizedTag: 'fa', features: {} },
        ],
      });
      const executeRequestSpy = vi.spyOn(provider, '_executeRequest');

      await expect(provider._translateChunk(['before @@SUB_TOKEN@@ after'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
        .rejects.toMatchObject({ type: ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED });

      expect(executeRequestSpy).not.toHaveBeenCalled();
    });

    it('fails fast when capability metadata cannot be fetched for markup texts', async () => {
      deepLLanguageDiscoveryMock.fetch.mockRejectedValue(new Error('offline'));
      const executeRequestSpy = vi.spyOn(provider, '_executeRequest');

      await expect(provider._translateChunk(['before @@SUB_TOKEN@@ after'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
        .rejects.toMatchObject({ type: ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED });

      expect(executeRequestSpy).not.toHaveBeenCalled();
    });

    it('allows the plain-text path without tag_handling when markup-free texts lack metadata', async () => {
      deepLLanguageDiscoveryMock.fetch.mockRejectedValue(new Error('offline'));
      let capturedBody;
      vi.spyOn(provider, '_executeRequest').mockImplementation(async (options) => {
        capturedBody = options.fetchOptions.body;
        return options.extractResponse({ translations: [{ text: 'translated' }] });
      });

      await expect(provider._translateChunk(['plain source'], 'en', 'fa', 'selection', null, 0, 1, 0, 1, {}))
        .resolves.toEqual(['translated']);

      expect(capturedBody.has('tag_handling')).toBe(false);
      expect(capturedBody.has('splitting_tags')).toBe(false);
    });
  });

  describe('capability discovery key failover', () => {
    const discoveryPayload = [
      { lang: 'EN', name: 'English', usable_as_source: true, usable_as_target: true, status: 'stable', features: { tag_handling: {} } },
      { lang: 'FA', name: 'Persian', usable_as_source: true, usable_as_target: true, status: 'stable', features: { tag_handling: {} } },
      { lang: 'DE', name: 'German', usable_as_source: true, usable_as_target: true, status: 'stable', features: { formality: { status: 'stable' }, tag_handling: {} } },
    ];
    const discoveryCalls = () => proxyFetch.mock.calls.filter(([url]) => String(url).includes('/v3/languages'));
    const translateCalls = () => proxyFetch.mock.calls.filter(([url]) => !String(url).includes('/v3/languages'));

    const useRealFailover = () => {
      deepLDiscoveryActual.current.clearDeepLLanguageCatalogCache();
      deepLLanguageDiscoveryMock.fetchFailover.mockImplementation(
        (options) => deepLDiscoveryActual.current.fetchDeepLLanguageCatalogWithKeyFailover(options),
      );
    };

    it('fails over discovery past an invalid first key, sending XML and preserving formality', async () => {
      deeplConfigMocks.getFormality.mockResolvedValue('more');
      useRealFailover();

      await runWithRuntime(['bad-key-1', 'good-key-1'], 'free', async ({ promoteKeySpy }) => {
        provider._getConfig.mockResolvedValue({
          apiKey: 'bad-key-1',
          apiTier: 'free',
          apiUrl: 'https://api.deepl.test',
          apiKeys: ['bad-key-1', 'good-key-1'],
        });
        proxyFetch.mockImplementation(async (url, options) => {
          if (String(url).includes('/v3/languages')) {
            const auth = options?.headers?.Authorization;
            if (auth === 'DeepL-Auth-Key bad-key-1') return { ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) };
            if (auth === 'DeepL-Auth-Key good-key-1') return { ok: true, status: 200, json: async () => discoveryPayload };
            throw new Error(`unexpected discovery authorization: ${auth}`);
          }
          const auth = options?.headers?.Authorization;
          if (auth === 'DeepL-Auth-Key bad-key-1') return createJsonResponse(401, { detail: 'Invalid API key' }, 'Unauthorized');
          if (auth === 'DeepL-Auth-Key good-key-1') {
            return createJsonResponse(200, { translations: [{ text: 'translated <x id="SUB_TOKEN" /> text' }] }, 'OK');
          }
          throw new Error(`unexpected translate authorization: ${auth}`);
        });

        await expect(provider._translateChunk(['before @@SUB_TOKEN@@ after'], 'en', 'de', 'selection', null, 0, 1, 0, 1, {}))
          .resolves.toEqual(['translated @@SUB_TOKEN@@text']);

        // Discovery probed the dead first key (401) then succeeded on the
        // second key; the dead key cached nothing, the good key did.
        expect(discoveryCalls().length).toBeGreaterThanOrEqual(2);
        expect(discoveryCalls()[0][1].headers.Authorization).toBe('DeepL-Auth-Key bad-key-1');
        expect(new Set(discoveryCalls().map(([, options]) => options.headers.Authorization))).toEqual(
          new Set(['DeepL-Auth-Key bad-key-1', 'DeepL-Auth-Key good-key-1']),
        );
        expect(deepLDiscoveryActual.current.getCachedDeepLLanguageCatalog('bad-key-1')).toBeNull();
        expect(deepLDiscoveryActual.current.getCachedDeepLLanguageCatalog('good-key-1').catalog).toHaveLength(3);

        // Translation failed over the same way and sent both capabilities.
        expect(translateCalls()).toHaveLength(2);
        const sentBody = translateCalls().at(-1)[1].body;
        expect(sentBody.get('formality')).toBe('more');
        expect(sentBody.get('tag_handling')).toBe('xml');
        expect(sentBody.get('splitting_tags')).toBe('n1,n2,br');
        expect(promoteKeySpy).toHaveBeenCalledWith('DEEPL_API_KEY', 'good-key-1');
      });
    });

    it('fails fast without translating when every discovery key returns 401', async () => {
      useRealFailover();
      provider._getConfig.mockResolvedValue({
        apiKey: 'bad-key-1',
        apiTier: 'free',
        apiUrl: 'https://api.deepl.test',
        apiKeys: ['bad-key-1', 'bad-key-2'],
      });
      proxyFetch.mockImplementation(async (url) => {
        if (String(url).includes('/v3/languages')) return { ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) };
        throw new Error('translate must not be called when capability discovery fails on all keys');
      });

      await expect(provider._translateChunk(['before @@SUB_TOKEN@@ after'], 'en', 'de', 'selection', null, 0, 1, 0, 1, {}))
        .rejects.toMatchObject({ type: ErrorTypes.LANGUAGE_PAIR_NOT_SUPPORTED });

      expect(discoveryCalls()).toHaveLength(2);
      expect(translateCalls()).toHaveLength(0);
      expect(deepLDiscoveryActual.current.getCachedDeepLLanguageCatalog('bad-key-1')).toBeNull();
      expect(deepLDiscoveryActual.current.getCachedDeepLLanguageCatalog('bad-key-2')).toBeNull();
    });
  });
});
