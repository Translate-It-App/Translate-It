import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterProvider } from './OpenRouter.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { ApiKeyManager } from './ApiKeyManager.js';

// Mock dependencies
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getBrowserInfo: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
    storage: { local: { get: vi.fn(), set: vi.fn() } }
  }
}));

vi.mock('@/shared/config/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getOpenRouterApiKeysAsync: vi.fn().mockResolvedValue(['key-1', 'key-2']),
  getOpenRouterApiModelAsync: vi.fn().mockResolvedValue('openai/gpt-6-luna'),
  getProviderOptimizationLevelAsync: vi.fn(() => Promise.resolve('balanced')),
}));

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  getProxySettingsAsync: vi.fn().mockResolvedValue({}),
  resolveProxyConfig: vi.fn().mockResolvedValue({})
}));

vi.mock('@/shared/proxy/ProxyManager.js', () => ({
  proxyManager: {
    fetch: vi.fn(),
    setConfig: vi.fn()
  }
}));

vi.mock('./utils/AIConversationHelper.js', () => ({
  AIConversationHelper: {
    getConversationParticipation: vi.fn().mockResolvedValue(false),
    claimNextTurn: vi.fn().mockResolvedValue(1),
    getConversationMessages: vi.fn().mockResolvedValue({ messages: [] }),
    updateSessionHistory: vi.fn().mockResolvedValue(true)
  }
}));

vi.mock('../../core/TranslationStatsManager.js', () => ({
  statsManager: {
    recordRequest: vi.fn(() => ({ globalCallId: 1, sessionCallId: 1 })),
    recordError: vi.fn(),
    recordSuccess: vi.fn(),
  }
}));

describe('OpenRouter Internal Integration (Failover & Headers)', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenRouterProvider();
    
    // Mock ApiKeyManager methods directly to test the flow through ProviderRequestEngine
    vi.spyOn(ApiKeyManager, 'getKeys').mockResolvedValue(['key-1', 'key-2']);
    vi.spyOn(ApiKeyManager, 'shouldFailover').mockImplementation((err) => err.statusCode === 401 || err.message.includes('API_KEY'));
    vi.spyOn(ApiKeyManager, 'promoteKey').mockResolvedValue(true);
  });

  it('should include required OpenRouter headers and return successful result', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Success' } }]
      }),
      headers: new Map([['content-type', 'application/json']]),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'text');

    expect(result).toBe('Success');
    
    // Verify mandatory OpenRouter headers
    const fetchOptions = proxyManager.fetch.mock.calls[0][1];
    expect(fetchOptions.headers['HTTP-Referer']).toBe('https://github.com/Translate-It');
    expect(fetchOptions.headers['X-Title']).toBe('Translate-It Extension');
    expect(fetchOptions.headers['Authorization']).toBe('Bearer key-1');
  });

  it('should failover to second key when first key is unauthorized', async () => {
    // 1st call: 401 Unauthorized
    proxyManager.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Invalid API Key' } }),
        headers: new Map(),
        clone: function() { return this; }
      })
      // 2nd call: 200 OK
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Recovered' } }]
        }),
        headers: new Map([['content-type', 'application/json']]),
        clone: function() { return this; }
      });

    const result = await provider._callAI('system', 'text');

    expect(result).toBe('Recovered');
    
    // Check that it was called twice
    expect(proxyManager.fetch).toHaveBeenCalledTimes(2);
    
    // Verify it switched to key-2
    expect(proxyManager.fetch.mock.calls[1][1].headers['Authorization']).toBe('Bearer key-2');

    // Verify key-2 was promoted as the new working key
    expect(ApiKeyManager.promoteKey).toHaveBeenCalledWith('OPENROUTER_API_KEY', 'key-2');
  });

  it('should throw error when all keys fail', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Expired' } }),
      headers: new Map(),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text'))
      .rejects.toThrow('Expired');
    
    expect(proxyManager.fetch).toHaveBeenCalledTimes(2); // Attempted both key-1 and key-2
  });
});
