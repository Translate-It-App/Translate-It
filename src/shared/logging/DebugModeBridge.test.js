import { afterEach, describe, expect, it, vi } from 'vitest';

const { storageGet, storageOn, setEnabled, setGlobalDebugOverride, setComponentLogLevel, setErrorDebugMode } = vi.hoisted(() => ({
  storageGet: vi.fn(), storageOn: vi.fn(), setEnabled: vi.fn(),
  setGlobalDebugOverride: vi.fn(), setComponentLogLevel: vi.fn(), setErrorDebugMode: vi.fn(),
}));
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

vi.mock('./SafeConsole.js', () => ({ safeConsole: { setEnabled } }));
vi.mock('./logger.js', () => ({ getScopedLogger: () => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}) }));
vi.mock('./GlobalDebugState.js', () => ({ setGlobalDebugOverride, setComponentLogLevel }));
vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: { getInstance: () => ({ setDebugMode: setErrorDebugMode }) },
}));

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: { get: storageGet, on: storageOn },
}));

describe('DebugModeBridge offscreen settings handoff', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.chrome;
    Object.defineProperty(window, 'location', originalLocation);
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('only serves sanitized logging preferences to the exact offscreen document', async () => {
    globalThis.chrome = {
      runtime: {
        id: 'extension-id',
        getURL: (path) => `chrome-extension://extension-id/${path}`,
      },
    };
    storageGet.mockResolvedValue({
      DEBUG_MODE: true,
      COMPONENT_LOG_LEVELS: { LiveDubbing: 3, Unknown: 2, Core: 99 },
      API_KEY: 'private',
    });
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const handler = new DebugModeBridge().getHandlerMappings().OFFSCREEN_LOGGING_SETTINGS_GET;
    const maliciousSender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/popup.html' };

    await expect(handler({}, maliciousSender)).resolves.toEqual({ success: false, error: 'OFFSCREEN_UNAUTHORIZED' });
    expect(storageGet).not.toHaveBeenCalled();

    await expect(handler({}, {
      id: 'extension-id',
      url: 'chrome-extension://extension-id/src/html/offscreen.html',
    })).resolves.toEqual({
      DEBUG_MODE: true,
      COMPONENT_LOG_LEVELS: { LiveDubbing: 3 },
    });
    expect(storageGet).toHaveBeenCalledOnce();
    expect(storageGet).toHaveBeenCalledWith({ DEBUG_MODE: false, COMPONENT_LOG_LEVELS: {} });
  });

  it('sends logging changes as targeted offscreen updates', async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    globalThis.chrome = { runtime: { id: 'extension-id', sendMessage } };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();
    bridge.context = 'background';

    bridge.handleDebugModeChange(true);
    bridge.handleComponentLogLevelsChange({ LiveDubbing: 2, Unknown: 3 });

    expect(sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      action: 'OFFSCREEN_LOGGING_SETTINGS_UPDATED',
      data: { DEBUG_MODE: true },
    });
    expect(sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      action: 'OFFSCREEN_LOGGING_SETTINGS_UPDATED',
      data: { COMPONENT_LOG_LEVELS: { LiveDubbing: 2 } },
    });
  });

  it('keeps storage listeners in popup contexts but not offscreen', async () => {
    storageGet.mockImplementation(async (defaults) => defaults);
    globalThis.chrome = { runtime: { sendMessage: vi.fn(async () => ({})) } };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');

    const popupBridge = new DebugModeBridge();
    popupBridge.context = 'popup';
    await popupBridge.initialize();
    await vi.waitFor(() => expect(storageOn).toHaveBeenCalledWith('change', expect.any(Function)));

    storageOn.mockClear();
    const offscreenBridge = new DebugModeBridge();
    offscreenBridge.context = 'offscreen';
    await offscreenBridge.initialize();
    expect(storageOn).not.toHaveBeenCalled();
  });

  it('detects an offscreen URL when runtime has no getManifest capability', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'chrome-extension://extension-id/src/html/offscreen.html' },
    });
    globalThis.chrome = { runtime: { sendMessage: vi.fn(async () => ({
      DEBUG_MODE: true, COMPONENT_LOG_LEVELS: {},
    })) } };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();
    expect(bridge.context).toBe('offscreen');
  });

  it('does not probe getManifest for a windowed offscreen URL', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'chrome-extension://extension-id/src/html/offscreen.html' },
    });
    const getManifest = vi.fn(() => { throw new Error('runtime probe failed'); });
    globalThis.chrome = { runtime: { getManifest } };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');

    expect(new DebugModeBridge().context).toBe('offscreen');
    expect(getManifest).not.toHaveBeenCalled();
  });

  it('returns an explicit failure when settings storage is unavailable', async () => {
    storageGet.mockRejectedValue(new Error('private storage failure'));
    globalThis.chrome = {
      runtime: {
        id: 'extension-id',
        getURL: (path) => `chrome-extension://extension-id/${path}`,
      },
    };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const handler = new DebugModeBridge().getHandlerMappings().OFFSCREEN_LOGGING_SETTINGS_GET;
    const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/html/offscreen.html' };

    await expect(handler({}, sender)).resolves.toEqual({
      success: false,
      error: 'OFFSCREEN_LOGGING_SETTINGS_UNAVAILABLE',
    });
    expect(storageGet).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, [], {}, { DEBUG_MODE: true },
    { success: false, error: 'FAILED', DEBUG_MODE: true, COMPONENT_LOG_LEVELS: {} },
    { success: true, DEBUG_MODE: true, COMPONENT_LOG_LEVELS: {} },
  ])('does not mark malformed settings response initialized (%s)', async (response) => {
    globalThis.chrome = { runtime: { sendMessage: vi.fn(async () => response) } };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();
    bridge.context = 'offscreen';
    await expect(bridge.initialize()).resolves.toBe(false);
    expect(bridge.isInitialized).toBe(false);
  });

  it('retries transient response failures with bounded attempts', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ DEBUG_MODE: true, COMPONENT_LOG_LEVELS: {} });
    globalThis.chrome = { runtime: { sendMessage } };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();
    bridge.context = 'offscreen';
    const initialization = bridge.initialize();
    await expect(initialization).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(bridge.isInitialized).toBe(true);
  });

  it('exhausts three attempts and permits a later explicit initialization', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ DEBUG_MODE: false, COMPONENT_LOG_LEVELS: {} });
    globalThis.chrome = { runtime: { sendMessage } };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();
    bridge.context = 'offscreen';
    const first = bridge.initialize();
    await vi.runAllTimersAsync();
    await expect(first).resolves.toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(bridge.isInitialized).toBe(false);
    await expect(bridge.initialize()).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('deduplicates concurrent initialization and cancels retry backoff on cleanup', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockRejectedValue(new Error('transient'));
    globalThis.chrome = { runtime: { sendMessage } };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();
    bridge.context = 'offscreen';
    const initialization = bridge.initialize();
    expect(bridge.initialize()).toBe(initialization);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    bridge.cleanup();
    await expect(initialization).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(sendMessage).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each([
    ['GlobalDebugState import', 'global'],
    ['ErrorHandler import', 'error'],
  ])('does not let an old application resume after the %s', async (_boundary, boundary) => {
    let releaseImport;
    let markImportEntered;
    const importEntered = new Promise((resolve) => { markImportEntered = resolve; });
    const importGate = new Promise((resolve) => { releaseImport = resolve; });
    vi.resetModules();
    vi.doMock('./GlobalDebugState.js', async () => {
      if (boundary === 'global') {
        markImportEntered();
        await importGate;
      }
      return { setGlobalDebugOverride };
    });
    vi.doMock('@/shared/error-management/ErrorHandler.js', async () => {
      if (boundary === 'error') await importGate;
      return { ErrorHandler: { getInstance: () => ({ setDebugMode: setErrorDebugMode }) } };
    });

    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();
    bridge.context = 'offscreen';
    const oldApplication = bridge.applyDebugMode(true);

    if (boundary === 'global') {
      await importEntered;
    } else {
      await vi.waitFor(() => expect(setGlobalDebugOverride).toHaveBeenCalledWith(true));
    }

    bridge.handleDebugModeChange(false);
    releaseImport();
    await oldApplication;
    await vi.waitFor(() => expect(setErrorDebugMode).toHaveBeenCalledWith(false));

    expect(bridge.currentDebugMode).toBe(false);
    expect(setEnabled).toHaveBeenLastCalledWith(false);
    expect(setGlobalDebugOverride).toHaveBeenLastCalledWith(false);
    expect(setErrorDebugMode).toHaveBeenLastCalledWith(false);
    if (boundary === 'global') expect(setGlobalDebugOverride).not.toHaveBeenCalledWith(true);
    expect(setErrorDebugMode).not.toHaveBeenCalledWith(true);
  });
});

describe('DebugModeBridge storage initialization', () => {
  afterEach(() => {
    delete globalThis.browser;
    delete globalThis.chrome;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('reads both logging settings in one StorageCore request and applies their values', async () => {
    storageGet.mockResolvedValue({ DEBUG_MODE: true, COMPONENT_LOG_LEVELS: { Core: 3 } });
    vi.doMock('./GlobalDebugState.js', () => ({ setGlobalDebugOverride, setComponentLogLevel }));
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();

    await expect(bridge.initialize()).resolves.toBe(true);
    expect(storageGet).toHaveBeenCalledOnce();
    expect(storageGet).toHaveBeenCalledWith({ DEBUG_MODE: false, COMPONENT_LOG_LEVELS: {} });
    expect(bridge.currentDebugMode).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(setGlobalDebugOverride).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(setComponentLogLevel).toHaveBeenCalledWith('Core', 3));
  });

  it('uses defaults when StorageCore returns no stored values', async () => {
    storageGet.mockResolvedValue({});
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();

    await expect(bridge.initialize()).resolves.toBe(true);
    expect(bridge.currentDebugMode).toBe(false);
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(setComponentLogLevel).not.toHaveBeenCalled();
    expect(storageGet).toHaveBeenCalledOnce();
  });

  it('falls back to one batched browser storage read when StorageCore is unavailable', async () => {
    storageGet.mockRejectedValue(new Error('StorageCore unavailable'));
    const fallbackGet = vi.fn().mockResolvedValue({ DEBUG_MODE: true, COMPONENT_LOG_LEVELS: { Core: 2 } });
    globalThis.browser = { storage: { local: { get: fallbackGet } } };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();

    await expect(bridge.initialize()).resolves.toBe(true);
    expect(storageGet).toHaveBeenCalledOnce();
    expect(fallbackGet).toHaveBeenCalledOnce();
    expect(fallbackGet).toHaveBeenCalledWith({ DEBUG_MODE: false, COMPONENT_LOG_LEVELS: {} });
    expect(bridge.currentDebugMode).toBe(true);
  });

  it('falls back to defaults when both storage APIs fail', async () => {
    storageGet.mockRejectedValue(new Error('StorageCore unavailable'));
    globalThis.browser = { storage: { local: { get: vi.fn().mockRejectedValue(new Error('browser storage unavailable')) } } };
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();

    await expect(bridge.initialize()).resolves.toBe(true);
    expect(bridge.currentDebugMode).toBe(false);
    expect(setEnabled).toHaveBeenCalledWith(false);
  });

  it('keeps failed initialization retryable and installs logging updates after success', async () => {
    const invalidSettings = {};
    Object.defineProperty(invalidSettings, 'DEBUG_MODE', { get: () => { throw new Error('invalid response'); } });
    storageGet.mockResolvedValueOnce(invalidSettings).mockResolvedValue({ DEBUG_MODE: false, COMPONENT_LOG_LEVELS: {} });
    const { DebugModeBridge } = await import('./DebugModeBridge.js');
    const bridge = new DebugModeBridge();

    await expect(bridge.initialize()).resolves.toBe(false);
    expect(bridge.isInitialized).toBe(false);
    await expect(bridge.initialize()).resolves.toBe(true);
    expect(storageGet).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(storageOn).toHaveBeenCalledWith('change', expect.any(Function)));
    const listener = storageOn.mock.calls.at(-1)[1];
    listener({ DEBUG_MODE: true, COMPONENT_LOG_LEVELS: { Core: 3 } });
    await vi.waitFor(() => {
      expect(setGlobalDebugOverride).toHaveBeenCalledWith(true);
    });
    expect(setEnabled).toHaveBeenLastCalledWith(true);
  });
});
