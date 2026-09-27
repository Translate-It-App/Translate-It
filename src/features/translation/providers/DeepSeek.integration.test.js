import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekProvider } from './DeepSeek.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { ApiKeyManager } from './ApiKeyManager.js';

// Mock dependencies
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getBrowserInfo: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
    storage: { local: { get: vi.fn(), set: vi.fn() } }
  }
}));

vi.mock('@/shared/config/config.js', () => ({
  CONFIG: {
    DEEPSEEK_API_MODEL: 'deepseek-flash',
    DEEPSEEK_MODELS: [
      { value: 'deepseek-flash', supportsThinking: true },
      { value: 'deepseek-v4-pro', supportsThinking: true },
      { value: 'deepseek-chat', supportsThinking: false },
      { value: 'custom' },
    ],
    DEEPSEEK_THINKING_MODE_OPTIONS: [
      { value: 'disabled' },
      { value: 'low' },
      { value: 'high' },
      { value: 'max' },
    ],
  },
  getDeepSeekApiKeysAsync: vi.fn().mockResolvedValue(['ds-key-1', 'ds-key-2']),
  getDeepSeekApiUrlAsync: vi.fn().mockResolvedValue('https://api.deepseek.com/chat/completions'),
  getDeepSeekApiModelAsync: vi.fn().mockResolvedValue('deepseek-flash'),
  getDeepSeekThinkingModeAsync: vi.fn().mockResolvedValue('disabled'),
  getProviderOptimizationLevelAsync: vi.fn(() => Promise.resolve('balanced')),
}));

vi.mock('@/shared/proxy/ProxySettings.js', () => ({
  getProxySettingsAsync: vi.fn().mockResolvedValue({}),
  resolveProxyConfig: vi.fn().mockResolvedValue({})
}));

vi.mock('@/shared/proxy/ProxyManager.js', () => ({
  proxyManager: {
    fetch: vi.fn(),
    setConfig: vi.fn(),
    testConnection: vi.fn()
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

describe('DeepSeekProvider Internal Integration (Failover & Response)', () => {
  let provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DeepSeekProvider();
    
    // Mock ApiKeyManager methods directly
    vi.spyOn(ApiKeyManager, 'getKeys').mockResolvedValue(['ds-key-1', 'ds-key-2']);
    vi.spyOn(ApiKeyManager, 'shouldFailover').mockImplementation((err) => err.statusCode === 401);
    vi.spyOn(ApiKeyManager, 'promoteKey').mockResolvedValue(true);
  });

  it('should successfully call DeepSeek API and return result', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'DeepSeek Success' } }]
      }),
      headers: new Map([['content-type', 'application/json']]),
      clone: function() { return this; }
    });

    const result = await provider._callAI('system', 'Hello DeepSeek');

    expect(result).toBe('DeepSeek Success');
    expect(proxyManager.fetch).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer ds-key-1'
        })
      }),
      expect.any(Object)
    );
    expect(JSON.parse(proxyManager.fetch.mock.calls[0][1].body).thinking)
      .toEqual({ type: 'disabled' });
  });

  it('should handle failover when the first DeepSeek key is invalid', async () => {
    // 1st call: 401 Unauthorized
    proxyManager.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Invalid Key' } }),
        headers: new Map(),
        clone: function() { return this; }
      })
      // 2nd call: 200 OK
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'Recovered with Key 2' } }]
        }),
        headers: new Map([['content-type', 'application/json']]),
        clone: function() { return this; }
      });

    const result = await provider._callAI('system', 'Test');

    expect(result).toBe('Recovered with Key 2');
    expect(proxyManager.fetch).toHaveBeenCalledTimes(2);
    
    // Verify second call used key-2
    const secondCallHeaders = proxyManager.fetch.mock.calls[1][1].headers;
    expect(secondCallHeaders['Authorization']).toBe('Bearer ds-key-2');

    // Verify key-2 was promoted
    expect(ApiKeyManager.promoteKey).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'ds-key-2');
  });

  it('should handle DeepSeek specific error body in 200 OK', async () => {
    proxyManager.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        error: { message: 'Balance not enough', code: 'insufficient_balance' }
      }),
      headers: new Map([['content-type', 'application/json']]),
      clone: function() { return this; }
    });

    await expect(provider._callAI('system', 'text'))
      .rejects.toThrow('API_ERROR: Balance not enough');
  });
});
