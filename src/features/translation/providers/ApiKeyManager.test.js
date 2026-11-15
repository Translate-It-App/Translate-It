import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyManager } from './ApiKeyManager.js';
import { ProviderRegistryIds } from './ProviderConstants.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';

const { mockLogger, mockProxyFetch, mockResolveProxyConfig, mockProxyManager } = vi.hoisted(() => {
  const mockProxyFetch = vi.fn();
  return {
    mockLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    mockProxyFetch,
    mockResolveProxyConfig: vi.fn(),
    mockProxyManager: { config: null, fetch: mockProxyFetch }
  };
});

// Mock storageManager
const mockStorage = new Map();
vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: {
    get: vi.fn(keys => {
      const result = {};
      Object.keys(keys).forEach(key => {
        result[key] = mockStorage.get(key) || keys[key];
      });
      return Promise.resolve(result);
    }),
    set: vi.fn(data => {
      Object.entries(data).forEach(([key, value]) => {
        mockStorage.set(key, value);
      });
      return Promise.resolve();
    })
  }
}));

// Mock logger
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => mockLogger
}));

vi.mock('@/shared/proxy/ProxyManager.js', () => ({
  proxyManager: mockProxyManager
}));

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  resolveProxyConfig: mockResolveProxyConfig
}));

describe('ApiKeyManager', () => {
  const createProxyConfig = (overrides = {}) => ({
    enabled: false,
    type: 'http',
    host: '',
    port: 8080,
    auth: { username: '', password: '' },
    ...overrides
  });

  const createDeepLUsageResponse = (body = { character_count: 0, character_limit: 500000 }) => ({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body)
  });

  const createDeepLUsageParseFailureResponse = (status = 200, message = 'Unexpected end of JSON input') => ({
    ok: true,
    status,
    json: vi.fn().mockRejectedValue(new SyntaxError(message))
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.clear();
    mockProxyManager.config = null;
    mockResolveProxyConfig.mockResolvedValue(createProxyConfig());
  });

  describe('Key Parsing and Stringifying', () => {
    it('should parse newline-separated keys correctly', () => {
      const keyString = 'key1\n  key2  \n\nkey3';
      const keys = ApiKeyManager.parseKeys(keyString);
      expect(keys).toEqual(['key1', 'key2', 'key3']);
    });

    it('should return empty array for invalid input', () => {
      expect(ApiKeyManager.parseKeys(null)).toEqual([]);
      expect(ApiKeyManager.parseKeys('')).toEqual([]);
    });

    it('should stringify array of keys back to newline-separated string', () => {
      const keys = ['key1', 'key2'];
      expect(ApiKeyManager.stringifyKeys(keys)).toBe('key1\nkey2');
    });
  });

  describe('Storage Interaction', () => {
    it('should get keys from storage', async () => {
      mockStorage.set('API_KEY', 'gemini1\ngemini2');
      const keys = await ApiKeyManager.getKeys('API_KEY');
      expect(keys).toEqual(['gemini1', 'gemini2']);
    });

    it('should return empty array if no keys in storage', async () => {
      const keys = await ApiKeyManager.getKeys('NON_EXISTENT');
      expect(keys).toEqual([]);
    });

    it('does not log API key material when loading keys', async () => {
      const secret = 'secret-api-key-value';
      mockStorage.set('API_KEY', `${secret}\nsecond-secret-api-key`);

      await ApiKeyManager.getKeys('API_KEY');

      const loggedValues = [
        ...mockLogger.debug.mock.calls,
        ...mockLogger.info.mock.calls,
        ...mockLogger.warn.mock.calls,
        ...mockLogger.error.mock.calls
      ].flat().join(' ');

      expect(loggedValues).not.toContain(secret);
      expect(loggedValues).not.toContain(secret.slice(0, 4));
      expect(loggedValues).not.toContain(secret.slice(-4));
      expect(mockLogger.info).not.toHaveBeenCalled();
    });
  });

  describe('Key Promotion', () => {
    it('should move successful key to the front and save it', async () => {
      mockStorage.set('OPENAI_KEY', 'key_old\nkey_new');
      
      await ApiKeyManager.promoteKey('OPENAI_KEY', 'key_new');
      
      const savedValue = mockStorage.get('OPENAI_KEY');
      expect(savedValue).toBe('key_new\nkey_old');
    });

    it('should not change anything if key is already at the front', async () => {
      mockStorage.set('OPENAI_KEY', 'key1\nkey2');
      await ApiKeyManager.promoteKey('OPENAI_KEY', 'key1');
      expect(mockStorage.get('OPENAI_KEY')).toBe('key1\nkey2');
    });
  });

  describe('Failover Logic', () => {
    it('should trigger failover for specific error types', () => {
      expect(ApiKeyManager.shouldFailover({ type: ErrorTypes.API_KEY_INVALID })).toBe(true);
      expect(ApiKeyManager.shouldFailover({ type: ErrorTypes.QUOTA_EXCEEDED })).toBe(true);
      expect(ApiKeyManager.shouldFailover({ type: ErrorTypes.NETWORK_ERROR })).toBe(false);
    });
  });

  describe('Key Reordering', () => {
    it('should test and reorder keys: valid first, then invalid', async () => {
      mockStorage.set('GEMINI_KEY', 'invalid_key\nvalid_key');
      
      // Mock the internal test function
      // Since ApiKeyManager uses dynamic imports and private-like static methods, 
      // we mock the specific test function on the class
      vi.spyOn(ApiKeyManager, '_testGeminiKey').mockImplementation(async (key) => {
        return key === 'valid_key';
      });

      const result = await ApiKeyManager.testAndReorderKeys('GEMINI_KEY', ProviderRegistryIds.GEMINI);

      expect(result.valid).toEqual(['valid_key']);
      expect(result.invalid).toEqual(['invalid_key']);
      
      // Check storage: valid should be first now
      expect(mockStorage.get('GEMINI_KEY')).toBe('valid_key\ninvalid_key');
    });
  });

  describe('Provider ID Dispatch', () => {
    it.each([
      [ProviderRegistryIds.OPENAI, '_testOpenAIKey', ['secret-key', {}]],
      [ProviderRegistryIds.GEMINI, '_testGeminiKey', ['secret-key', {}]],
      [ProviderRegistryIds.DEEPSEEK, '_testDeepSeekKey', ['secret-key', {}]],
      [ProviderRegistryIds.OPENROUTER, '_testOpenRouterKey', ['secret-key', {}]],
      [ProviderRegistryIds.REQUESTY, '_testRequestyKey', ['secret-key', {}]],
      [ProviderRegistryIds.CHEAPERINFERENCE, '_testCheaperInferenceKey', ['secret-key', {}]],
       [ProviderRegistryIds.DEEPL, '_testDeepLKey', ['secret-key', {}]]
    ])('dispatches %s to its validator', async (providerId, validator, expectedArgs) => {
      const testValidator = vi.spyOn(ApiKeyManager, validator).mockResolvedValue(true);

      const result = await ApiKeyManager.testKeysDirect('secret-key', providerId);

      expect(testValidator).toHaveBeenCalledWith(...expectedArgs);
      expect(result).toMatchObject({
        valid: ['secret-key'],
        invalid: [],
        allInvalid: false
      });
      testValidator.mockRestore();
    });

    it('dispatches custom registry ID to custom validation', async () => {
      const testCustomKeys = vi.spyOn(ApiKeyManager, '_testCustomKeys')
        .mockResolvedValue({ allInvalid: false });
      const context = { apiUrl: 'https://example.com/v1/chat/completions', apiModel: 'local-model' };

      await ApiKeyManager.testKeysDirect('', ProviderRegistryIds.CUSTOM, context);

      expect(testCustomKeys).toHaveBeenCalledWith([], context);
      testCustomKeys.mockRestore();
    });

    it('passes DeepL tier context to direct validation', async () => {
      const testValidator = vi.spyOn(ApiKeyManager, '_testDeepLKey').mockResolvedValue(true);

      await ApiKeyManager.testKeysDirect('secret-key', ProviderRegistryIds.DEEPL, { apiTier: 'pro' });

      expect(testValidator).toHaveBeenCalledWith('secret-key', { apiTier: 'pro' });
      testValidator.mockRestore();
    });

    it.each(['unknown-provider', 'OpenAI', 'Gemini', 'DeepSeek', 'OpenRouter', 'Requesty', 'CheaperInference', 'DeepL', 'Custom'])('returns unknown-provider result for unsupported provider ID %s', async (providerId) => {
        const result = await ApiKeyManager.testKeysDirect('secret-key', providerId);

        expect(result).toMatchObject({
          valid: [],
          invalid: ['secret-key'],
          allInvalid: true,
          messageKey: 'api_test_unknown_provider',
          params: { provider: providerId }
        });
      });
  });

  describe('Proxy Snapshot Validation', () => {
    it('passes current enabled settings when global proxy config is unset', async () => {
      const currentProxy = createProxyConfig({
        enabled: true,
        type: 'socks',
        host: 'proxy-b',
        port: 9000,
        auth: { username: 'user-b', password: 'password-b' }
      });
      mockProxyManager.config = null;
      mockResolveProxyConfig.mockResolvedValue(currentProxy);
      mockProxyFetch.mockResolvedValue({ ok: true, status: 200 });

      await expect(ApiKeyManager._testOpenAIKey('secret-key')).resolves.toBe(true);

      expect(mockResolveProxyConfig).toHaveBeenCalledTimes(1);
      expect(mockProxyFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({ method: 'GET' }),
        currentProxy
      );
    });

    it('passes persisted proxy settings instead of stale global config', async () => {
      const staleProxy = createProxyConfig({ enabled: true, host: 'proxy-a', port: 8000 });
      const currentProxy = createProxyConfig({ enabled: true, host: 'proxy-b', port: 9000 });
      mockProxyManager.config = staleProxy;
      mockResolveProxyConfig.mockResolvedValue(currentProxy);
      mockProxyFetch.mockResolvedValue({ ok: true, status: 200 });

      await expect(ApiKeyManager._testOpenAIKey('secret-key')).resolves.toBe(true);

      expect(mockProxyFetch.mock.calls[0][2]).toBe(currentProxy);
      expect(mockProxyFetch.mock.calls[0][2]).not.toBe(staleProxy);
    });

    it('passes disabled persisted settings instead of stale enabled config', async () => {
      const staleProxy = createProxyConfig({ enabled: true, host: 'proxy-a', port: 8000 });
      const disabledProxy = createProxyConfig();
      mockProxyManager.config = staleProxy;
      mockResolveProxyConfig.mockResolvedValue(disabledProxy);
      mockProxyFetch.mockResolvedValue({ ok: true, status: 200 });

      await expect(ApiKeyManager._testOpenAIKey('secret-key')).resolves.toBe(true);

      expect(mockProxyFetch.mock.calls[0][2]).toBe(disabledProxy);
      expect(mockProxyFetch.mock.calls[0][2]).not.toBe(staleProxy);
    });

    it('resolves current settings after a normal provider updates global config', async () => {
      const providerProxy = createProxyConfig({ enabled: true, host: 'provider-proxy', port: 8000 });
      const currentProxy = createProxyConfig({ enabled: true, host: 'current-proxy', port: 9000 });
      mockProxyManager.config = providerProxy;
      mockResolveProxyConfig.mockResolvedValue(currentProxy);
      mockProxyFetch.mockResolvedValue({ ok: true, status: 200 });

      await expect(ApiKeyManager._testDeepSeekKey('secret-key')).resolves.toBe(true);

      expect(mockResolveProxyConfig).toHaveBeenCalledTimes(1);
      expect(mockProxyFetch.mock.calls[0][2]).toBe(currentProxy);
    });

    it('resolves a current proxy snapshot for one DeepL validation request', async () => {
      const staleProxy = createProxyConfig({ enabled: true, host: 'proxy-stale', port: 8000 });
      const currentProxy = createProxyConfig({ enabled: true, host: 'proxy-current', port: 9000 });
      mockProxyManager.config = staleProxy;
      mockResolveProxyConfig.mockResolvedValue(currentProxy);
      mockProxyFetch.mockResolvedValue(createDeepLUsageResponse());

      await expect(ApiKeyManager._testDeepLKey('pro-key', { apiTier: 'pro' })).resolves.toBe(true);

      expect(mockResolveProxyConfig).toHaveBeenCalledTimes(1);
      expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      expect(mockProxyFetch.mock.calls[0][0]).toBe('https://api.deepl.com/v2/usage');
      expect(mockProxyFetch.mock.calls[0][2]).toBe(currentProxy);
      expect(mockProxyFetch.mock.calls[0][2]).not.toBe(staleProxy);
    });

    describe('DeepL usage validation', () => {
      it.each([
        ['Free suffix overrides selected Pro tier', 'abc:fx', 'pro', 'https://api-free.deepl.com/v2/usage'],
        ['selected Free tier', 'free-key', 'free', 'https://api-free.deepl.com/v2/usage'],
        ['selected Pro tier', 'pro-key', 'pro', 'https://api.deepl.com/v2/usage'],
      ])('selects endpoint for %s', async (_label, key, apiTier, expectedUrl) => {
        mockProxyFetch.mockResolvedValue(createDeepLUsageResponse());

        await expect(ApiKeyManager._testDeepLKey(key, { apiTier })).resolves.toBe(true);

        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
        const [url, options] = mockProxyFetch.mock.calls[0];
        expect(url).toBe(expectedUrl);
        expect(options).toMatchObject({
          method: 'GET',
          headers: { 'Authorization': `DeepL-Auth-Key ${key}` }
        });
        expect(options).not.toHaveProperty('body');
      });

      it('uses the canonical Free default for an invalid tier', async () => {
        mockProxyFetch.mockResolvedValue(createDeepLUsageResponse());

        await expect(ApiKeyManager._testDeepLKey('unknown-tier-key', { apiTier: 'enterprise' }))
          .resolves.toBe(true);

        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
        expect(mockProxyFetch.mock.calls[0][0]).toBe('https://api-free.deepl.com/v2/usage');
      });

      it.each([
        ['minimum usage object', { character_count: 0, character_limit: 500000 }],
        ['usage object with optional fields', {
          character_count: 123,
          character_limit: 1000000,
          products: [{ product: 'text', count: 123 }],
          api_key_character_count: 123,
        }],
      ])('accepts %s', async (_label, body) => {
        mockProxyFetch.mockResolvedValue(createDeepLUsageResponse(body));

        await expect(ApiKeyManager._testDeepLKey('pro-key', { apiTier: 'pro' })).resolves.toBe(true);
        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['empty object', {}],
        ['array', []],
        ['null', null],
        ['string count', { character_count: '123', character_limit: 1000000 }],
        ['fractional count', { character_count: 123.5, character_limit: 1000000 }],
        ['negative count', { character_count: -1, character_limit: 1000000 }],
        ['missing limit', { character_count: 123 }],
        ['non-number limit', { character_count: 123, character_limit: null }],
      ])('rejects invalid successful payload: %s', async (_label, body) => {
        mockProxyFetch.mockResolvedValue(createDeepLUsageResponse(body));

        await expect(ApiKeyManager._testDeepLKey('pro-key', { apiTier: 'pro' })).resolves.toBe(false);
        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['malformed JSON', 200, 'Unexpected token { in JSON at position 0'],
        ['HTML response', 200, 'Unexpected token < in JSON at position 0'],
        ['empty 204 response', 204, 'Unexpected end of JSON input'],
      ])('rejects %s', async (_label, status, message) => {
        mockProxyFetch.mockResolvedValue(createDeepLUsageParseFailureResponse(status, message));

        await expect(ApiKeyManager._testDeepLKey('pro-key', { apiTier: 'pro' })).resolves.toBe(false);
        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      });

      it.each([400, 401, 429, 456, 500, 529])('does not probe alternate endpoint after HTTP %s', async (status) => {
        mockProxyFetch.mockResolvedValue({ ok: false, status });

        await expect(ApiKeyManager._testDeepLKey('pro-key', { apiTier: 'pro' })).resolves.toBe(false);

        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
        expect(mockProxyFetch.mock.calls[0][0]).toBe('https://api.deepl.com/v2/usage');
      });

      it('returns false when the selected endpoint request throws', async () => {
        mockProxyFetch.mockRejectedValue(new Error('network failure'));

        await expect(ApiKeyManager._testDeepLKey('pro-key', { apiTier: 'pro' })).resolves.toBe(false);
        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      });

      it('uses persisted tier for testAndReorderKeys', async () => {
        mockStorage.set('DEEPL_API_KEY', 'pro-key');
        mockStorage.set('DEEPL_API_TIER', 'pro');
        const testValidator = vi.spyOn(ApiKeyManager, '_testDeepLKey').mockResolvedValue(true);

        const result = await ApiKeyManager.testAndReorderKeys('DEEPL_API_KEY', ProviderRegistryIds.DEEPL);

        expect(testValidator).toHaveBeenCalledWith('pro-key', { apiTier: 'pro' });
        expect(result).toMatchObject({ valid: ['pro-key'], invalid: [], allInvalid: false });
        testValidator.mockRestore();
      });

      it('keeps :fx override through testAndReorderKeys', async () => {
        mockStorage.set('DEEPL_API_KEY', 'abc:fx');
        mockStorage.set('DEEPL_API_TIER', 'pro');
        mockProxyFetch.mockResolvedValue(createDeepLUsageResponse());

        await expect(ApiKeyManager.testAndReorderKeys('DEEPL_API_KEY', ProviderRegistryIds.DEEPL))
          .resolves.toMatchObject({ valid: ['abc:fx'], allInvalid: false });

        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
        expect(mockProxyFetch.mock.calls[0][0]).toBe('https://api-free.deepl.com/v2/usage');
      });
    });
  });

  describe('DeepSeek key testing endpoint safety', () => {
    it.each([undefined, '', 'https://api.deepseek.com/chat/completions'])(
      'keeps the official models test for URL %s', async apiUrl => {
        mockProxyFetch.mockResolvedValue({ ok: true, status: 200 });

        await expect(ApiKeyManager._testDeepSeekKey('secret-key', { apiUrl })).resolves.toBe(true);

        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
        expect(mockProxyFetch.mock.calls[0][0]).toBe('https://api.deepseek.com/models');
        expect(mockProxyFetch.mock.calls[0][1]).toMatchObject({
          method: 'GET', headers: { Authorization: 'Bearer secret-key' }
        });
      }
    );

    it('tests a supported custom completion URL directly and only sends the credential there', async () => {
      mockProxyFetch.mockResolvedValue({ ok: true, status: 200 });
      const url = 'https://self-hosted.example/api/v1/chat/completions';

      await expect(ApiKeyManager._testDeepSeekKey('secret-key', { apiUrl: url, apiModel: 'local-model' }))
        .resolves.toBe(true);

      expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      expect(mockProxyFetch.mock.calls[0][0]).toBe(url);
      expect(mockProxyFetch.mock.calls[0][1]).toMatchObject({
        method: 'POST',
        headers: { Authorization: 'Bearer secret-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'local-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 })
      });
      expect(mockProxyFetch.mock.calls[0][0]).not.toContain('api.deepseek.com');
    });

    it.each([
      'not a URL',
      'https://user:password@example.com/v1/chat/completions',
      'https://example.com/v1/chat/completions?token=value',
      'https://example.com/v1/completions',
      'http://example.com/v1/chat/completions'
    ])('rejects unsafe or unsupported custom URL without a request (%s)', async apiUrl => {
      await expect(ApiKeyManager._testDeepSeekKey('secret-key', { apiUrl })).resolves.toBe(false);
      expect(mockProxyFetch).not.toHaveBeenCalled();
    });

    it('keeps multi-key result ordering and does not leak keys in logs or errors', async () => {
      const secret = 'secret-key-one';
      const validator = vi.spyOn(ApiKeyManager, '_testDeepSeekKey').mockImplementation(async key => key === 'secret-key-two');

      const result = await ApiKeyManager.testKeysDirect(
        `${secret}\nsecret-key-two`,
        ProviderRegistryIds.DEEPSEEK,
        { apiUrl: 'https://self-hosted.example/v1/chat/completions', apiModel: 'local-model' }
      );

      expect(result).toMatchObject({
        valid: ['secret-key-two'], invalid: [secret], allInvalid: false,
        reorderedString: 'secret-key-two\nsecret-key-one',
        messageKey: 'api_test_result_partial', params: { valid: 1, invalid: 1 }
      });
      const loggedOutput = JSON.stringify([
        ...mockLogger.debug.mock.calls,
        ...mockLogger.info.mock.calls,
        ...mockLogger.warn.mock.calls,
        ...mockLogger.error.mock.calls
      ]);
      expect(loggedOutput).not.toContain(secret);
      expect(loggedOutput).not.toContain('secret-key-two');
      validator.mockRestore();
    });

    it('does not expose a credential when a network request throws', async () => {
      const secret = 'never-log-this-key';
      mockProxyFetch.mockRejectedValue(new Error(`request failed: ${secret}`));

      const result = await ApiKeyManager.testKeysDirect(secret, ProviderRegistryIds.DEEPSEEK, {
        apiUrl: 'https://self-hosted.example/v1/chat/completions', apiModel: 'local-model'
      });

      expect(result).toMatchObject({ allInvalid: true, invalid: [secret] });
      const loggedOutput = JSON.stringify([
        ...mockLogger.debug.mock.calls,
        ...mockLogger.info.mock.calls,
        ...mockLogger.warn.mock.calls,
        ...mockLogger.error.mock.calls
      ]);
      expect(loggedOutput).not.toContain(secret);
    });
  });

  describe('Custom Provider Testing', () => {
    const context = {
      apiUrl: 'https://example.com/v1/chat/completions',
      apiModel: 'local-model'
    };

    const modelsResponse = (data) => ({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(data)
    });

    const chatResponse = (ok = true, status = ok ? 200 : 500) => ({
      ok,
      status,
      json: vi.fn().mockResolvedValue({})
    });

    it('tests anonymous Custom connectivity without Authorization', async () => {
      mockProxyFetch.mockResolvedValue(modelsResponse({ data: [{ id: 'local-model' }] }));

      const result = await ApiKeyManager.testKeysDirect('', ProviderRegistryIds.CUSTOM, context);

      expect(result).toMatchObject({ allInvalid: false, messageKey: 'api_test_custom_connection_success' });
      expect(mockProxyFetch).toHaveBeenCalledWith(
        'https://example.com/v1/models',
        expect.objectContaining({ method: 'GET', headers: {} }),
        expect.objectContaining({ enabled: false, type: 'http', host: '', port: 8080 })
      );
    });

    it('sends Authorization when testing a configured Custom key', async () => {
      mockProxyFetch.mockResolvedValue(modelsResponse({ data: [{ id: 'local-model' }] }));

      const result = await ApiKeyManager.testKeysDirect('secret-key', ProviderRegistryIds.CUSTOM, context);

      expect(result.allInvalid).toBe(false);
      expect(mockProxyFetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer secret-key' });
    });

    it('requires configured URL and model before making a remote request', async () => {
      const result = await ApiKeyManager.testKeysDirect('', ProviderRegistryIds.CUSTOM, { apiUrl: '', apiModel: '' });

      expect(result).toMatchObject({ allInvalid: true, messageKey: 'api_test_custom_config_missing' });
      expect(mockProxyFetch).not.toHaveBeenCalled();
    });

    it('requires exact configured model membership from a standard models response', async () => {
      mockProxyFetch.mockResolvedValue(modelsResponse({ data: [{ id: 'local-model-v2' }] }));

      const result = await ApiKeyManager.testKeysDirect('', ProviderRegistryIds.CUSTOM, context);

      expect(result).toMatchObject({ allInvalid: true, messageKey: 'api_test_custom_model_not_found' });
      expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['malformed JSON', { ok: true, status: 200, json: vi.fn().mockRejectedValue(new Error('invalid json')) }],
      ['nonstandard shape', { ok: true, status: 200, json: vi.fn().mockResolvedValue({ models: [{ id: 'local-model' }] }) }],
      ['404', { ok: false, status: 404, json: vi.fn().mockResolvedValue({}) }],
      ['405', { ok: false, status: 405, json: vi.fn().mockResolvedValue({}) }]
    ])('falls back to configured model chat test for %s models response', async (_name, modelsFailure) => {
      mockProxyFetch
        .mockResolvedValueOnce(modelsFailure)
        .mockResolvedValueOnce(chatResponse());

      const result = await ApiKeyManager.testKeysDirect('', ProviderRegistryIds.CUSTOM, context);
      const chatRequest = mockProxyFetch.mock.calls[1];

      expect(result.allInvalid).toBe(false);
      expect(mockProxyFetch).toHaveBeenCalledTimes(2);
      expect(mockProxyFetch.mock.calls[0][0]).toBe('https://example.com/v1/models');
      expect(chatRequest[0]).toBe('https://example.com/v1/chat/completions');
      expect(JSON.parse(chatRequest[1].body)).toMatchObject({
        model: 'local-model',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      });
      expect(JSON.stringify(chatRequest[1].body)).not.toContain('gpt-3.5-turbo');
    });

    it('does not fall back after genuine authentication failure', async () => {
      mockProxyFetch.mockResolvedValue({ ok: false, status: 401, json: vi.fn() });

      const result = await ApiKeyManager.testKeysDirect('secret-key', ProviderRegistryIds.CUSTOM, context);

      expect(result.allInvalid).toBe(true);
      expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    });

    it('resolves a fresh snapshot for each Custom fallback request', async () => {
      const firstProxy = createProxyConfig({ enabled: true, host: 'proxy-first', port: 8000 });
      const secondProxy = createProxyConfig({ enabled: true, host: 'proxy-second', port: 9000 });
      mockResolveProxyConfig
        .mockResolvedValueOnce(firstProxy)
        .mockResolvedValueOnce(secondProxy);
      mockProxyFetch
        .mockResolvedValueOnce({ ok: false, status: 404, json: vi.fn().mockResolvedValue({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({}) });

      await expect(ApiKeyManager._testCustomConnection('', context)).resolves.toMatchObject({ valid: true });

      expect(mockResolveProxyConfig).toHaveBeenCalledTimes(2);
      expect(mockProxyFetch).toHaveBeenCalledTimes(2);
      expect(mockProxyFetch.mock.calls[0][2]).toBe(firstProxy);
      expect(mockProxyFetch.mock.calls[1][2]).toBe(secondProxy);
    });
  });
});
