import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const featureManagerMock = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  checkForUrlChange: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/core/managers/content/FeatureManager.js', () => ({
  FeatureManager: { getInstance: () => featureManagerMock },
}));

import { ContentScriptCore } from './ContentScriptCore.js';
import { IFrameContentScriptCore } from './IFrameContentScriptCore.js';

describe('Vue infrastructure frame contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete window.translateItContentCore;
    delete window.featureManager;
  });

  it('main content core exposes Vue infrastructure loading', () => {
    const core = ContentScriptCore();
    expect(typeof core.loadVueApp).toBe('function');
    expect(core.vueLoaded).toBe(false);
  });

  it('registers SPA navigation in core messaging', async () => {
    const core = ContentScriptCore();
    const messageHandler = { registerHandler: vi.fn() };
    core.messageHandler = messageHandler;

    await core.registerCoreHandlers();

    const registration = messageHandler.registerHandler.mock.calls.find(
      ([action]) => action === 'SPA_NAVIGATION'
    );
    expect(registration).toBeDefined();

    const navigationCursor = { documentEpoch: 1, routeRevision: 2, url: 'https://example.com/new-route' };
    await registration[1]({ data: { navigationCursor } });

    expect(featureManagerMock.initialize).toHaveBeenCalledOnce();
    expect(featureManagerMock.checkForUrlChange).toHaveBeenCalledExactlyOnceWith({
      navigationCursor, navigationUnavailable: undefined,
    });
  });

  it('iframe content core does not expose Vue loading', () => {
    const core = IFrameContentScriptCore();
    expect(core.loadVueApp).toBeUndefined();
    expect(core.vueLoaded).toBe(false);
  });

  it('iframe content core registers and handles SPA navigation locally', async () => {
    const core = IFrameContentScriptCore();
    const messageHandler = { registerHandler: vi.fn() };
    core.messageHandler = messageHandler;

    core.registerCoreHandlers();

    const registration = messageHandler.registerHandler.mock.calls.find(
      ([action]) => action === 'SPA_NAVIGATION'
    );
    expect(registration).toBeDefined();

    const navigationCursor = { documentEpoch: 2, routeRevision: 1, url: 'https://frame.example.com/#two' };
    await registration[1]({ data: { navigationCursor } });

    expect(featureManagerMock.initialize).toHaveBeenCalledOnce();
    expect(featureManagerMock.checkForUrlChange).toHaveBeenCalledExactlyOnceWith({
      navigationCursor, navigationUnavailable: undefined,
    });
  });

  it('iframe loadFeature("vue") resolves null without mounting Vue', async () => {
    const iframeCore = IFrameContentScriptCore();
    window.translateItContentCore = iframeCore;

    const result = await iframeCore.loadFeature('vue');

    expect(result).toBeNull();
  });
});
