import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  coreCtor: vi.fn(),
  initContentCore: vi.fn().mockResolvedValue(true),
  setupTrusted: vi.fn(),
  getURL: vi.fn((p) => `moz-extension://test/${p}`),
}));

vi.mock('webextension-polyfill', () => ({
  default: { runtime: { getURL: mocks.getURL } },
}));
vi.mock('@/shared/vue/vue-utils.js', () => ({
  setupTrustedTypesCompatibility: mocks.setupTrusted,
}));
vi.mock('./IFrameContentScriptCore.js', () => ({
  IFrameContentScriptCore: class {
    constructor(options) { mocks.coreCtor(options); this.initialized = false; }
  },
}));
vi.mock('./contentStartup.js', () => ({
  initializeContentCore: mocks.initContentCore,
}));

describe('index-iframe entry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.coreCtor.mockClear();
    mocks.initContentCore.mockResolvedValue(true);
    mocks.getURL.mockImplementation((p) => `moz-extension://test/${p}`);
    delete window.translateItContentCore;
    delete window.translateItContentScriptCore;
    delete window.translateItContentScriptLoaded;
    delete window._translateItBootstrapPromise;
    window.translateItContentScriptInitializing = false;
    Object.defineProperty(window, 'top', { configurable: true, value: {} });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'https://example.com/frame.html', protocol: 'https:', host: 'example.com' },
    });
    document.documentElement.classList.remove('translate-it-ui-frame');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 });
  });

  it('does not run when window === top (not iframe)', async () => {
    Object.defineProperty(window, 'top', { configurable: true, value: window });
    await import('./index-iframe.js');
    expect(mocks.coreCtor).not.toHaveBeenCalled();
  });

  it('bootstraps a messaging-only core for tiny frames', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 256 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 60 });
    await import('./index-iframe.js');
    await vi.waitFor(() => expect(mocks.coreCtor).toHaveBeenCalledOnce());
    expect(mocks.coreCtor).toHaveBeenCalledWith({ tinyFrame: true });
    await vi.waitFor(() => expect(mocks.initContentCore).toHaveBeenCalledOnce());
  });

  it('creates a normal core for regular frames', async () => {
    await import('./index-iframe.js');
    await vi.waitFor(() => expect(mocks.coreCtor).toHaveBeenCalledOnce());
    expect(mocks.coreCtor).toHaveBeenCalledWith({ tinyFrame: false });
  });

  it('does not run when isExtensionFrame', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'moz-extension://abc/frame.html', protocol: 'moz-extension:', host: 'abc' },
    });
    await import('./index-iframe.js');
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.coreCtor).not.toHaveBeenCalled();
  });

  it('does not run when already loaded', async () => {
    window.translateItContentScriptLoaded = true;
    await import('./index-iframe.js');
    expect(mocks.coreCtor).not.toHaveBeenCalled();
  });

  it('creates core and routes to initializeContentCore when allowed', async () => {
    await import('./index-iframe.js');
    await vi.waitFor(() => expect(mocks.coreCtor).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.initContentCore).toHaveBeenCalledOnce());
    const coreArg = mocks.initContentCore.mock.calls[0][0];
    expect(coreArg).toBeTruthy();
    expect(window.translateItContentCore).toBe(coreArg);
  });
});
