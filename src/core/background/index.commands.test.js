import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  commandListener: null,
  eventOrder: [],
  initialize: vi.fn(),
  handleCommandEvent: vi.fn().mockResolvedValue(true),
  errorHandler: { handle: vi.fn() },
  isChrome: vi.fn(() => false),
  reconcile: vi.fn().mockResolvedValue(),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      onConnect: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    commands: {
      onCommand: {
        addListener: vi.fn(listener => {
          mocks.eventOrder.push('command-listener');
          mocks.commandListener = listener;
        }),
      },
    },
  },
}));

vi.mock('@/core/managers/core/LifecycleManager.js', () => ({
  LifecycleManager: class {
    constructor() {
      return { initialize: mocks.initialize };
    }
  },
}));
vi.mock('@/features/translation/providers/register-providers.js', () => ({ registerAllProviders: vi.fn() }));
vi.mock('@/core/services/translation/UnifiedTranslationService.js', () => ({ unifiedTranslationService: { initialize: vi.fn() } }));
vi.mock('@/shared/logging/logger.js', () => ({ getScopedLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/shared/logging/logConstants.js', () => ({ LOG_COMPONENTS: { BACKGROUND: 'background' } }));
vi.mock('@/shared/utils/environment.js', () => ({ isDevelopmentMode: () => false }));
vi.mock('@/shared/error-management/ErrorHandler.js', () => ({ ErrorHandler: { getInstance: () => mocks.errorHandler } }));
vi.mock('@/handlers/lifecycle/InstallHandler.js', () => ({ handleInstallationEvent: vi.fn() }));
vi.mock('@/core/extensionContext.js', () => ({ default: { isValidSync: () => true, isContextError: () => false } }));
vi.mock('@/shared/runtime/OffscreenRuntimeLeaseManager.js', () => ({ OFFSCREEN_IDLE_ALARM_NAME: 'offscreen-idle', offscreenRuntimeLeaseManager: {} }));
vi.mock('@/features/live-dubbing/background/LiveDubbingCoordinator.js', () => ({ liveDubbingCoordinator: { reconcile: mocks.reconcile } }));
vi.mock('@/features/live-dubbing/background/tabLifecycle.js', () => ({ registerLiveDubbingTabLifecycle: vi.fn() }));
vi.mock('@/core/browserHandlers.js', () => ({ isChrome: mocks.isChrome }));
vi.mock('@/core/memory/GlobalCleanup.js', () => ({ initializeGlobalCleanup: vi.fn() }));
vi.mock('@/core/memory/MemoryMonitor.js', () => ({ startMemoryMonitoring: vi.fn() }));
vi.mock('@/shared/logging/DebugModeBridge.js', () => ({ debugModeBridge: { initialize: vi.fn() } }));
vi.mock('@/handlers/command-handler.js', () => ({ handleCommandEvent: mocks.handleCommandEvent }));
vi.mock('./listeners/onContextMenuClicked.js', () => ({}));
vi.mock('./listeners/onNotificationClicked.js', () => ({}));
vi.mock('./listeners/onSubframeDOMContentLoaded.js', () => ({}));
vi.mock('./listeners/onSpaNavigation.js', () => ({}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('background command startup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('chrome', undefined);
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.commandListener = null;
    mocks.eventOrder.length = 0;
    mocks.isChrome.mockReturnValue(false);
    mocks.reconcile.mockReset().mockResolvedValue();
    mocks.initialize.mockImplementation(() => {
      mocks.eventOrder.push('initialize');
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('registers once before startup, waits through a retry, and dispatches pending and warm commands once each', async () => {
    const secondAttempt = deferred();
    mocks.initialize
      .mockImplementationOnce(() => {
        mocks.eventOrder.push('initialize');
        return Promise.reject(new Error('transient startup failure'));
      })
      .mockImplementationOnce(() => {
        mocks.eventOrder.push('initialize');
        return secondAttempt.promise;
      });

    await import('./index.js');

    expect(mocks.eventOrder.slice(0, 2)).toEqual(['command-listener', 'initialize']);
    expect(mocks.commandListener).toBeTypeOf('function');
    const tab = { id: 42, url: 'https://example.com/' };
    const pendingCommand = mocks.commandListener('SELECT-ELEMENT-COMMAND', tab);
    expect(mocks.handleCommandEvent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.initialize).toHaveBeenCalledTimes(2);
    expect(mocks.eventOrder.filter(event => event === 'command-listener')).toHaveLength(1);
    expect(mocks.handleCommandEvent).not.toHaveBeenCalled();

    secondAttempt.resolve();
    await pendingCommand;
    expect(mocks.handleCommandEvent).toHaveBeenCalledOnce();
    expect(mocks.handleCommandEvent).toHaveBeenCalledWith('SELECT-ELEMENT-COMMAND', tab);

    await mocks.commandListener('SELECT-ELEMENT-COMMAND', tab);
    expect(mocks.handleCommandEvent).toHaveBeenCalledTimes(2);
    expect(mocks.eventOrder.filter(event => event === 'command-listener')).toHaveLength(1);
  });

  it('settles pending commands without dispatch after startup failure', async () => {
    mocks.initialize.mockRejectedValue(new Error('permanent startup failure'));

    await import('./index.js');
    const pendingCommand = mocks.commandListener('SELECT-ELEMENT-COMMAND', { id: 42 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pendingCommand).resolves.toBeUndefined();

    expect(mocks.initialize).toHaveBeenCalledTimes(2);
    expect(mocks.handleCommandEvent).not.toHaveBeenCalled();
    expect(mocks.errorHandler.handle).toHaveBeenCalledOnce();
    expect(mocks.errorHandler.handle).toHaveBeenCalledWith(expect.any(Error), {
      context: 'background-init',
      showToast: false,
    });
  });

  it('waits for Chrome startup reconciliation before dispatching a pending command', async () => {
    const reconciliation = deferred();
    mocks.isChrome.mockReturnValue(true);
    mocks.reconcile.mockReturnValue(reconciliation.promise);

    await import('./index.js');

    expect(mocks.eventOrder.slice(0, 2)).toEqual(['command-listener', 'initialize']);
    const tab = { id: 42, url: 'https://example.com/' };
    const pendingCommand = mocks.commandListener('SELECT-ELEMENT-COMMAND', tab);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.handleCommandEvent).not.toHaveBeenCalled();
    expect(mocks.eventOrder.filter(event => event === 'command-listener')).toHaveLength(1);

    reconciliation.resolve();
    await pendingCommand;

    expect(mocks.handleCommandEvent).toHaveBeenCalledOnce();
    expect(mocks.handleCommandEvent).toHaveBeenCalledWith('SELECT-ELEMENT-COMMAND', tab);
    expect(mocks.eventOrder.filter(event => event === 'command-listener')).toHaveLength(1);
  });
});
