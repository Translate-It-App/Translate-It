import { afterEach, describe, expect, it, vi } from 'vitest';
const getters = vi.hoisted(() => ({
  getEffectiveProviderAsync: vi.fn(), getSourceLanguageAsync: vi.fn(), getTargetLanguageAsync: vi.fn(),
  getAIContextTranslationEnabledAsync: vi.fn(), getAIConversationHistoryEnabledAsync: vi.fn(),
  getSelectElementUseTranslationFontAsync: vi.fn(), getProviderOptimizationLevelAsync: vi.fn(),
  getOpenAIModelAsync: vi.fn(), getGeminiModelAsync: vi.fn(), getWebAIApiModelAsync: vi.fn(),
  getDeepSeekApiModelAsync: vi.fn(), getCustomApiModelAsync: vi.fn(), getOpenRouterApiModelAsync: vi.fn(),
  getRequestyApiModelAsync: vi.fn(),
}));
vi.mock('@/config.js', () => getters);
import {
  captureBenchmarkMetadata,
  emitBenchmarkAcceptedClick,
  emitBenchmarkRequestDispatch,
  emitBenchmarkTerminal,
  emitBenchmarkRuntimeMetadata,
} from './liveBenchmarkProbe.js';
import { installLiveBenchmarkMetadataBridge } from './liveBenchmarkMetadataBridge.js';

const eventNames = [
  'translate-it:select-element-benchmark:accepted-click',
  'translate-it:select-element-benchmark:request-dispatch',
  'translate-it:select-element-benchmark:operation-terminal',
  'translate-it:select-element-benchmark:runtime-metadata',
];
const fixtureRoot = () => {
  const root = document.createElement('section');
  root.setAttribute('data-translate-it-live-benchmark-root', 'true');
  root.setAttribute('data-translate-it-live-benchmark-trial', 'trial-one');
  document.body.append(root);
  return root;
};

afterEach(() => {
  document.documentElement.removeAttribute('data-translate-it-live-benchmark');
  document.querySelector('[data-translate-it-live-benchmark-root]')?.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.values(getters).forEach((getter) => getter.mockReset());
});

describe('development live benchmark probe', () => {
  it('does not emit unless development and explicitly opted in', () => {
    vi.stubEnv('DEV', false);
    document.documentElement.setAttribute('data-translate-it-live-benchmark', 'true');
    const root = fixtureRoot();
    const now = vi.spyOn(performance, 'now');
    const listener = vi.fn();
    document.addEventListener(eventNames[0], listener);
    emitBenchmarkAcceptedClick({ timeStamp: 12 }, root);
    document.removeEventListener(eventNames[0], listener);
    expect(listener).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it('does not collect timestamps when development is enabled without root opt-in', () => {
    vi.stubEnv('DEV', true);
    const root = fixtureRoot();
    const now = vi.spyOn(performance, 'now');
    const listener = vi.fn();
    document.addEventListener(eventNames[2], listener);

    emitBenchmarkTerminal(root, 'successful', 'trial-one');

    document.removeEventListener(eventNames[2], listener);
    expect(now).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('emits only allowlisted timestamps and terminal enums after opt-in', () => {
    vi.stubEnv('DEV', true);
    document.documentElement.setAttribute('data-translate-it-live-benchmark', 'true');
    const root = fixtureRoot();
    const received = [];
    const listeners = eventNames.map((name) => {
      const listener = (event) => received.push([name, JSON.parse(event.detail)]);
      document.addEventListener(name, listener);
      return listener;
    });
    emitBenchmarkAcceptedClick({ timeStamp: 12, secret: 'not forwarded' }, root);
    emitBenchmarkRequestDispatch(root);
    emitBenchmarkTerminal(root, 'successful', 'trial-one');
    emitBenchmarkTerminal(root, 'raw error', 'trial-one');
    eventNames.forEach((name, index) => document.removeEventListener(name, listeners[index]));
    expect(received).toHaveLength(3);
    expect(received[0][1]).toMatchObject({ clickTimeStamp: 12 });
    expect(Object.keys(received[0][1]).sort()).toEqual(['acceptedAt', 'clickTimeStamp', 'trialId']);
    expect(received[2][1]).toMatchObject({ status: 'successful' });
  });

  it('does not correlate unmarked or disconnected targets', () => {
    vi.stubEnv('DEV', true);
    document.documentElement.setAttribute('data-translate-it-live-benchmark', 'true');
    const listener = vi.fn();
    document.addEventListener(eventNames[1], listener);
    const root = fixtureRoot();
    root.removeAttribute('data-translate-it-live-benchmark-root');
    emitBenchmarkRequestDispatch(root);
    root.setAttribute('data-translate-it-live-benchmark-root', 'true');
    root.remove();
    emitBenchmarkRequestDispatch(root);
    document.removeEventListener(eventNames[1], listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('emits only explicitly allowlisted runtime metadata for the active root', () => {
    vi.stubEnv('DEV', true);
    document.documentElement.setAttribute('data-translate-it-live-benchmark', 'true');
    const root = fixtureRoot();
    const listener = vi.fn();
    document.addEventListener(eventNames[3], listener);
    emitBenchmarkRuntimeMetadata(root, {
      provider: 'OpenAI', targetLanguage: 'fr', extractionMode: 'v3',
      sourceLanguage: 'secret', apiKey: 'never-forward',
    });
    document.removeEventListener(eventNames[3], listener);
    expect(JSON.parse(listener.mock.calls[0][0].detail)).toEqual({
      provider: 'OpenAI', sourceLanguage: 'secret', targetLanguage: 'fr', extractionMode: 'V3', trialId: 'trial-one',
    });
  });

  it('captures configured metadata through the request handler with allowlisting, mapping, failures and trial validation', async () => {
    vi.stubEnv('DEV', true);
    document.documentElement.setAttribute('data-translate-it-live-benchmark', 'true');
    const root = fixtureRoot();
    getters.getEffectiveProviderAsync.mockResolvedValue('openai');
    getters.getOpenAIModelAsync.mockResolvedValue('gpt-safe');
    getters.getProviderOptimizationLevelAsync.mockResolvedValue(4);
    getters.getSourceLanguageAsync.mockResolvedValue('en');
    getters.getTargetLanguageAsync.mockResolvedValue('fr');
    getters.getAIContextTranslationEnabledAsync.mockRejectedValue(new Error('private'));
    getters.getAIConversationHistoryEnabledAsync.mockResolvedValue(true);
    getters.getSelectElementUseTranslationFontAsync.mockResolvedValue(false);
    const received = vi.fn();
    document.addEventListener('translate-it:select-element-benchmark:configured-metadata', received);
    await captureBenchmarkMetadata({ detail: JSON.stringify({ trialId: 'trial-one', apiKey: 'evil' }) });
    root.setAttribute('data-translate-it-live-benchmark-trial', 'trial-two');
    await captureBenchmarkMetadata({ detail: JSON.stringify({ trialId: 'trial-one' }) });
    document.removeEventListener('translate-it:select-element-benchmark:configured-metadata', received);
    expect(received).toHaveBeenCalledTimes(1);
    const result = JSON.parse(received.mock.calls[0][0].detail);
    expect(result).toMatchObject({
      provider: 'openai', model: 'gpt-safe', optimizationLevel: 4,
      sourceLanguage: 'en', targetLanguage: 'fr', aiContext: null,
      conversationHistory: true, translationFont: false,
    });
    expect(result).not.toHaveProperty('apiKey');
    expect(getters.getOpenAIModelAsync).toHaveBeenCalledOnce();
    expect(getters.getGeminiModelAsync).not.toHaveBeenCalled();
  });

  it('does not serve configuration outside loopback origins', async () => {
    vi.stubEnv('DEV', true);
    vi.stubGlobal('location', { hostname: 'example.com' });
    document.documentElement.setAttribute('data-translate-it-live-benchmark', 'true');
    fixtureRoot();
    await captureBenchmarkMetadata({ detail: JSON.stringify({ trialId: 'trial-one' }) });
    expect(getters.getEffectiveProviderAsync).not.toHaveBeenCalled();
  });

  it('loads the metadata listener on request without Select Element activation', async () => {
    vi.stubEnv('DEV', true);
    const captureBenchmarkMetadata = vi.fn();
    const loadProbe = vi.fn().mockResolvedValue({ captureBenchmarkMetadata });
    installLiveBenchmarkMetadataBridge(document, loadProbe);
    const request = new CustomEvent('translate-it:select-element-benchmark:metadata-request', { detail: '{"trialId":"fresh"}' });
    document.dispatchEvent(request);
    await Promise.resolve();
    expect(loadProbe).toHaveBeenCalledOnce();
    expect(captureBenchmarkMetadata).toHaveBeenCalledWith(request);
  });

  it('does not install the metadata listener outside loopback pages', () => {
    vi.stubEnv('DEV', true);
    const targetDocument = {
      location: { hostname: 'example.com' },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    const loadProbe = vi.fn();
    installLiveBenchmarkMetadataBridge(targetDocument, loadProbe);
    expect(loadProbe).not.toHaveBeenCalled();
    expect(targetDocument.addEventListener).not.toHaveBeenCalled();
    expect(targetDocument.dispatchEvent).not.toHaveBeenCalled();
  });

  it('does not emit URL or credential-like provider models', async () => {
    vi.stubEnv('DEV', true);
    document.documentElement.setAttribute('data-translate-it-live-benchmark', 'true');
    fixtureRoot();
    getters.getEffectiveProviderAsync.mockResolvedValue('openai');
    getters.getOpenAIModelAsync.mockResolvedValue('https://service.example/api_key=secret');
    const received = vi.fn();
    document.addEventListener('translate-it:select-element-benchmark:configured-metadata', received);
    await captureBenchmarkMetadata({ detail: JSON.stringify({ trialId: 'trial-one', capturePhase: 'before-measurement' }) });
    getters.getOpenAIModelAsync.mockResolvedValue('sk-proj-abcdefghijklmnopqrstuvwxyz');
    await captureBenchmarkMetadata({ detail: JSON.stringify({ trialId: 'trial-one', capturePhase: 'before-measurement' }) });
    document.removeEventListener('translate-it:select-element-benchmark:configured-metadata', received);
    expect(received.mock.calls.map(([event]) => JSON.parse(event.detail).model)).toEqual([null, null]);
  });
});
