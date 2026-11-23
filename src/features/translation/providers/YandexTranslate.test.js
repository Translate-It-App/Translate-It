import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { YandexTranslateProvider } from './YandexTranslate.js';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn() } },
    storage: { local: { get: vi.fn(), set: vi.fn() } }
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    operation: vi.fn(),
    performance: vi.fn()
  })
}));

vi.mock('@/shared/config/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getYandexTranslateUrlAsync: vi.fn(() => Promise.resolve('https://translate.yandex.net/api/v1/tr.json/translate')),
  getProviderOptimizationLevelAsync: vi.fn(() => Promise.resolve('balanced')),
}));

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  getProxySettingsAsync: vi.fn().mockResolvedValue({}),
  resolveProxyConfig: vi.fn().mockResolvedValue({})
}));

describe('YandexTranslateProvider output contract', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new YandexTranslateProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runResponse = (sources, translations, lang = 'en-fa', options = { providerMetadataRef: { metadata: {} } }) => {
    vi.spyOn(provider, '_executeRequest').mockImplementation(async (options) => options.extractResponse({
      code: 200,
      text: translations,
      lang
    }));

    return provider._translateChunk(sources, 'en', 'fa', 'selection', null, 0, sources.length, 0, 1, options);
  };

  it.each(['', '   ', '\n\t', null, undefined])('rejects unusable output for nonblank source: %j', async (translatedItem) => {
    await expect(runResponse(['A'], [translatedItem]))
      .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
  });

  it.each(['', '   '])('rejects invalid middle output: %j', async (translatedItem) => {
    await expect(runResponse(['A', 'B', 'C'], ['A2', translatedItem, 'C2']))
      .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
  });

  it('rejects shorter response arrays', async () => {
    await expect(runResponse(['A', 'B', 'C'], ['A2', 'B2']))
      .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
  });

  it('rejects extra response entries', async () => {
    await expect(runResponse(['A', 'B'], ['A2', 'B2', 'unexpected']))
      .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
  });

  it.each([null, {}, { text: ['A2'] }, { code: 200, text: 'A2' }])(
    'rejects malformed response payloads: %j',
    async payload => {
      vi.spyOn(provider, '_executeRequest').mockImplementation(async options => options.extractResponse(payload));
      await expect(provider._translateChunk(['A'], 'en', 'fa', 'selection', null, 0, 1, 0, 1))
        .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });
    }
  );

  it('rejects a JSON API error code as an invalid response and preserves that body code', async () => {
    vi.spyOn(provider, '_executeRequest').mockImplementation(async options => options.extractResponse({
      code: 401,
      text: ['A2'],
      lang: 'en-fa',
    }));

    await expect(provider._translateChunk(['A'], 'en', 'fa', 'selection', null, 0, 1, 0, 1))
      .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID', statusCode: 401 });
  });

  it('sends Yandex translation as URL-encoded lang and repeated text fields with the required query parameters', async () => {
    vi.spyOn(provider, '_executeRequest').mockImplementation(async options => options.extractResponse({
      code: 200,
      text: ['A2', 'B2'],
      lang: 'en-fa',
    }));
    const sources = ['A', 'B'];

    await provider._translateChunk(sources, 'en', 'fa', 'selection', null, 0, 2, 0, 1);

    const request = provider._executeRequest.mock.calls[0][0];
    const url = new URL(request.url);
    expect(request.fetchOptions.method).toBe('POST');
    expect(request.fetchOptions.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(request.fetchOptions.body).toBeInstanceOf(URLSearchParams);
    expect(request.fetchOptions.body.get('lang')).toBe('en-fa');
    expect(request.fetchOptions.body.getAll('text')).toEqual(sources);
    expect(url.searchParams.get('id')).toMatch(/^[a-f0-9]{32}-0-0$/);
    expect(url.searchParams.get('srv')).toBe('android');
  });

  it.each(['', '   '])('preserves blank source slots: %j', async (blankSource) => {
    const sources = [blankSource, 'A'];
    await expect(runResponse(sources, [sources[0], 'A2'])).resolves.toEqual([sources[0], 'A2']);
  });

  it('accepts identity translation', async () => {
    await expect(runResponse(['URL'], ['URL'])).resolves.toEqual(['URL']);
  });

  it('preserves detected language for valid output', async () => {
    const options = { providerMetadataRef: { metadata: {} } };
    await runResponse(['A'], ['A2'], 'en-fa', options);

    expect(options.providerMetadataRef.metadata.detectedLanguage).toBe('en');
    expect(provider).not.toHaveProperty('lastDetectedLanguage');
  });

  it('does not update detected language for invalid output', async () => {
    const options = { providerMetadataRef: { metadata: {} } };

    await expect(runResponse(['A'], [''], 'en-fa', options))
      .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });

    expect(options.providerMetadataRef.metadata).toEqual({});
    expect(provider).not.toHaveProperty('lastDetectedLanguage');
  });
});
