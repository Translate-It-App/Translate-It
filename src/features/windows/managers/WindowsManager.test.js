import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create stable objects for mocks
const { mockWindowsManagerEvents, mockPageEventBus, mockDeviceDetector } = vi.hoisted(() => {
  const listeners = {};
  return {
    eventListeners: listeners,
    mockWindowsManagerEvents: {
      showWindow: vi.fn(),
      showIcon: vi.fn(),
      updateWindow: vi.fn(),
      dismissWindow: vi.fn(),
      dismissIcon: vi.fn(),
      showMobileSheet: vi.fn(),
      iconClicked: vi.fn()
    },
    mockPageEventBus: {
      on: vi.fn((event, cb) => {
        listeners[event] = cb;
      }),
      off: vi.fn((event, cb) => {
        if (listeners[event] === cb) delete listeners[event];
      }),
      emit: vi.fn(async (event, data) => {
        if (listeners[event]) {
          const res = listeners[event](data);
          if (res instanceof Promise) await res;
        }
      }),
      reset: () => Object.keys(listeners).forEach((event) => delete listeners[event]),
    },
    mockDeviceDetector: {
      shouldEnableMobileUI: vi.fn().mockReturnValue(false)
    }
  };
});

// Mock ALL dependencies
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), operation: vi.fn(), debugLazy: vi.fn()
  }))
}));

vi.mock('@/features/windows/managers/core/WindowsConfig.js', () => ({ 
  WindowsConfig: {
    TIMEOUTS: { OUTSIDE_CLICK_DELAY: 1, PENDING_WINDOW_RESET: 1, ICON_CLEANUP: 1, TRANSLATION_TIMEOUT: 1000 },
    ANIMATION: { FADE_OUT_DURATION: 1 }
  } 
}));

vi.mock('@/features/windows/managers/core/WindowsState.js', () => ({ 
  WindowsState: vi.fn().mockImplementation(function() {
    this.isVisible = false;
    this.isIconMode = false;
    this.translationHistory = [];
    this.historyIndex = -1;
    this.reset = vi.fn(() => {
      this.isVisible = false;
      this.isIconMode = false;
    });
    this.setVisible = vi.fn((v) => { this.isVisible = v; });
    this.setIconMode = vi.fn((v) => { this.isIconMode = v; });
    this.setOriginalText = vi.fn();
    this.clearTranslationHistory = vi.fn();
    this.setProvider = vi.fn();
    this.setActiveWindowId = vi.fn();
    this.setProcessing = vi.fn();
    this.clearIconClickContext = vi.fn();
    this.setIconClickContext = vi.fn();
    this.setTranslationCancelled = vi.fn();
    this.commitTranslation = vi.fn();
    this.setRequestingFrameId = vi.fn();
    this.hasActiveElements = true;
    this.iconClickContext = { iconId: 'test-icon' };
    return this;
  })
}));

vi.mock('@/features/windows/managers/crossframe/CrossFrameManager.js', () => ({ 
  CrossFrameManager: vi.fn().mockImplementation(function() {
    this.frameId = 'test-frame';
    this.setEventHandlers = vi.fn();
    this.messageRouter = { _broadcastToAllIframes: vi.fn() };
    this.isTopFrame = true;
    this.notifyWindowCreated = vi.fn();
    this.getIframeByFrameId = vi.fn().mockReturnValue(null);
    return this;
  })
}));

vi.mock('@/features/windows/managers/translation/TranslationHandler.js', () => ({ 
  TranslationHandler: vi.fn().mockImplementation(function() {
    this.performTranslation = vi.fn().mockResolvedValue({ 
      translatedText: 'translated content', sourceLanguage: 'en', targetLanguage: 'fa', provider: 'google_v2'
    });
    this.getEffectiveProvider = vi.fn().mockReturnValue('google_v2');
    this.cancelAllTranslations = vi.fn();
    return this;
  }) 
}));

vi.mock('@/features/windows/managers/interaction/ClickManager.js', () => ({ 
  ClickManager: vi.fn().mockImplementation(function() {
    this.setHandlers = vi.fn();
    this.addOutsideClickListener = vi.fn();
    this.cleanup = vi.fn();
    this.handleIconClick = vi.fn().mockReturnValue({ text: 'h', position: {x:0, y:0}, iconId: 'i' });
    this.completeIconTransition = vi.fn();
    return this;
  }) 
}));

vi.mock('@/features/windows/managers/theme/ThemeManager.js', () => ({ 
  ThemeManager: vi.fn().mockImplementation(function() {
    this.initialize = vi.fn().mockResolvedValue();
    this.getCurrentTheme = vi.fn().mockResolvedValue('light');
    this.cleanup = vi.fn();
    return this;
  }) 
}));

vi.mock('@/shared/managers/SettingsManager.js', () => ({ 
  default: { 
    get: vi.fn((key, def) => def),
    onSettingsChanged: vi.fn() 
  } 
}));

vi.mock('@/shared/config/config.js', () => ({ 
  state: {}, 
  SelectionTranslationMode: { IMMEDIATE: 'immediate', ON_FAB_CLICK: 'onFabClick', ON_CLICK: 'onClick' },
  TranslationMode: { Selection: 'selection', Dictionary: 'dictionary', ScreenCapture: 'capture' }
}));

vi.mock('@/shared/error-management/ErrorHandler.js');
vi.mock('@/shared/error-management/ErrorTypes.js', () => ({
  ErrorTypes: { API_RESPONSE_INVALID: 'API_RESPONSE_INVALID' }
}));

vi.mock('@/core/extensionContext.js', () => ({ 
  default: { isValidSync: vi.fn().mockReturnValue(true), isContextError: vi.fn().mockReturnValue(false) } 
}));

vi.mock('@/core/PageEventBus.js', () => ({
  WINDOWS_MANAGER_EVENTS: {
    SHOW_WINDOW: 'sw', UPDATE_WINDOW: 'uw', SHOW_ICON: 'si',
    DISMISS_WINDOW: 'dw', DISMISS_ICON: 'di', ICON_CLICKED: 'ic',
    SHOW_MOBILE_SHEET: 'sms', DISMISS_MOBILE_SHEET: 'dms'
  },
  WindowsManagerEvents: mockWindowsManagerEvents,
  pageEventBus: mockPageEventBus
}));

vi.mock('@/features/text-selection/events/SelectionEvents.js', () => ({ 
  SELECTION_EVENTS: { 
    GLOBAL_SELECTION_TRIGGER: 'gst',
    GLOBAL_SELECTION_CHANGE: 'gsc',
    GLOBAL_SELECTION_CLEAR: 'gsl'
  } 
}));

vi.mock('@/core/memory/ResourceTracker.js', () => ({
  default: class {
    constructor() { this.addEventListener = vi.fn(); }
    cleanup() {}
    destroy() {}
  }
}));

vi.mock('@/features/exclusion/core/ExclusionChecker.js', () => ({
  default: { getInstance: vi.fn(() => ({ isFeatureAllowed: vi.fn().mockResolvedValue(true) })) }
}));

vi.mock('@/utils/browser/compatibility.js', async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    deviceDetector: mockDeviceDetector
  };
});

vi.mock('@/shared/constants/ui.js', () => ({ UI_HOST_IDS: { MAIN: 'm', IFRAME: 'i' } }));
vi.mock('@/shared/constants/translation.js', () => ({ TRANSLATION_HTML: { ICON_ID: 'i', WINDOW_CLASS: 'w' } }));
vi.mock('@/shared/constants/mobile.js', () => ({ MOBILE_CONSTANTS: { UI_MODE: { AUTO: 'a', MOBILE: 'm', DESKTOP: 'd' }, VIEWS: { SELECTION: 's' }, SHEET_STATE: { PEEK: 'p' } } }));

vi.mock('@/features/tts/TTSFactory.js', () => {
  const tts = { speak: vi.fn().mockResolvedValue(), stop: vi.fn().mockResolvedValue(), stopAll: vi.fn().mockResolvedValue() };
  return { TTSFactory: { getTTSSmart: vi.fn().mockResolvedValue(() => tts), getTTSGlobal: vi.fn().mockResolvedValue({ TTSGlobalManager: {} }), _getInstance: () => tts } };
});

import { WindowsManager } from './WindowsManager.js';
import { TranslationHandler } from '@/features/windows/managers/translation/TranslationHandler.js';
import { SELECTION_EVENTS } from '@/features/text-selection/events/SelectionEvents.js';
import settingsManager from '@/shared/managers/SettingsManager.js';

describe('WindowsManager', () => {
  let windowsManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockPageEventBus.reset();
    WindowsManager.resetInstance();
    windowsManager = WindowsManager.getInstance();
    windowsManager.positionCalculator = { calculateAdjustedPositionForIframe: vi.fn((pos) => pos) };
  });

  afterEach(() => {
    WindowsManager.resetInstance();
    vi.useRealTimers();
  });

  it('should be a singleton', () => {
    expect(windowsManager).toBe(WindowsManager.getInstance());
  });

  it('forwards pending-show invalidation to DisplayManager', () => {
    windowsManager.displayManager.invalidatePendingShows = vi.fn().mockReturnValue(7);

    expect(windowsManager.invalidatePendingShows()).toBe(7);
    expect(windowsManager.displayManager.invalidatePendingShows).toHaveBeenCalledOnce();
  });

  it('constructs the default TranslationHandler with this manager state', () => {
    expect(TranslationHandler).toHaveBeenCalledWith(windowsManager.state);
    expect(windowsManager.translationHandler).toBeDefined();
  });

  describe('Selection Handling', () => {
    it('should emit showIcon event in onClick mode', async () => {
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'selectionTranslationMode') return 'onClick';
        return def;
      });
      await windowsManager.show('hello', { x: 1, y: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(mockWindowsManagerEvents.showIcon).toHaveBeenCalled();
    });

    it('cancels the delayed Toolbar when selection clears before UI is visible', async () => {
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'selectionTranslationMode') return 'onClick';
        return def;
      });

      await windowsManager.show('cleared selection', { x: 1, y: 1 });
      expect(windowsManager.state.isVisible).toBe(false);
      expect(windowsManager.state.isIconMode).toBe(false);
      expect(mockWindowsManagerEvents.showIcon).not.toHaveBeenCalled();

      await mockPageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CLEAR, { reason: 'selection-cleared' });
      await vi.advanceTimersByTimeAsync(100);

      expect(mockWindowsManagerEvents.showIcon).not.toHaveBeenCalled();
    });

    it('cancels a queued continuation when an external dismissal occurs', async () => {
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'selectionTranslationMode') return 'onClick';
        return def;
      });

      await windowsManager.show('pending continuation', { x: 1, y: 1 });
      expect(mockWindowsManagerEvents.showIcon).not.toHaveBeenCalled();

      await windowsManager.dismiss(false);
      await vi.advanceTimersByTimeAsync(100);

      expect(mockWindowsManagerEvents.showIcon).not.toHaveBeenCalled();
    });

    it('does not commit an in-flight internal display after a concurrent external dismissal', async () => {
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'selectionTranslationMode') return 'onClick';
        return def;
      });
      let resolveInternalDismiss;
      let dismissalCalls = 0;
      windowsManager.dismissalManager.dismiss = vi.fn(() => {
        dismissalCalls += 1;
        return dismissalCalls === 1
          ? new Promise((resolve) => { resolveInternalDismiss = resolve; })
          : Promise.resolve();
      });

      await windowsManager.show('pending continuation', { x: 1, y: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(windowsManager.dismissalManager.dismiss).toHaveBeenCalledTimes(1);
      expect(mockWindowsManagerEvents.showIcon).not.toHaveBeenCalled();

      await windowsManager.dismiss(false);
      resolveInternalDismiss();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockWindowsManagerEvents.showIcon).not.toHaveBeenCalled();
    });

    it('ignores synchronous internal cleanup echoes but honors later external selection clear', async () => {
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'selectionTranslationMode') return 'immediate';
        return def;
      });
      await windowsManager.ensureInitialized();
      windowsManager.state.isIconMode = true;
      mockWindowsManagerEvents.dismissIcon.mockImplementationOnce((id) =>
        mockPageEventBus.emit('di', { id }),
      );

      const internalRequestVersion = windowsManager.displayManager._showRequestVersion + 1;
      await windowsManager.show('replacement window', { x: 1, y: 1 });
      expect(mockWindowsManagerEvents.showWindow).toHaveBeenCalled();
      expect(windowsManager.displayManager.isCurrentShowRequest(internalRequestVersion)).toBe(true);

      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'selectionTranslationMode') return 'onClick';
        return def;
      });
      const iconsBeforeExternalClear = mockWindowsManagerEvents.showIcon.mock.calls.length;
      await windowsManager.show('queued continuation', { x: 2, y: 2 });
      await mockPageEventBus.emit('gsl', { reason: 'external-clear' });
      await vi.advanceTimersByTimeAsync(100);

      expect(mockWindowsManagerEvents.showIcon).toHaveBeenCalledTimes(iconsBeforeExternalClear);
    });

    it('should handle GLOBAL_SELECTION_CHANGE', async () => {
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'selectionTranslationMode') return 'onClick';
        if (key === 'TRANSLATE_ON_TEXT_SELECTION') return true;
        return def;
      });
      
      await mockPageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, { text: 'new', position: {x:1, y:1} });
      await vi.runAllTimersAsync();
      
      expect(mockWindowsManagerEvents.showIcon).toHaveBeenCalled();
    });

    it('should handle GLOBAL_SELECTION_CLEAR', async () => {
      // Use isIconMode which also triggers dismissal
      windowsManager.state.isIconMode = true;
      
      await mockPageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CLEAR);
      await vi.runAllTimersAsync();
      
      expect(mockWindowsManagerEvents.dismissIcon).toHaveBeenCalled();
    });

    it('should respect Ctrl requirement in IMMEDIATE mode', async () => {
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'selectionTranslationMode') return 'immediate';
        if (key === 'REQUIRE_CTRL_FOR_TEXT_SELECTION') return true;
        return def;
      });
      
      // 1. Test when Ctrl is NOT pressed (options provided but ctrlPressed false)
      await mockPageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, { 
        text: 'test', 
        position: {x:1, y:1},
        options: { ctrlPressed: false }
      });
      await vi.runAllTimersAsync();
      expect(mockWindowsManagerEvents.showWindow).not.toHaveBeenCalled();

      // 2. Test when Ctrl IS pressed
      await mockPageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, { 
        text: 'test', 
        position: {x:1, y:1},
        options: { ctrlPressed: true }
      });
      await vi.runAllTimersAsync();
      expect(mockWindowsManagerEvents.showWindow).toHaveBeenCalled();
    });
  });

  describe('Translation Flow', () => {
    it('should perform two-phase loading', async () => {
      windowsManager.translationHandler.performTranslation.mockResolvedValue({ translatedText: 'translated content' });
      const promise = windowsManager._showWindow('text', {x:1, y:1});
      expect(mockWindowsManagerEvents.showWindow).toHaveBeenCalledWith(expect.objectContaining({ isLoading: true }));
      await promise;
      expect(mockWindowsManagerEvents.updateWindow).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ isLoading: false, initialTranslatedText: 'translated content' }));
    });

    it.each([
      ['missing result', undefined],
      ['missing translatedText', { success: true }],
      ['non-string translatedText', { translatedText: 42 }],
      ['blank translatedText', { translatedText: ' \t\n' }],
      ['explicit failure with text', { success: false, translatedText: 'bad' }],
    ])('rejects %s without committing translation history', async (_label, result) => {
      windowsManager.translationHandler.performTranslation.mockResolvedValue(result);

      await expect(windowsManager._startTranslationProcess('source', 'window-1'))
        .rejects.toMatchObject({ type: 'API_RESPONSE_INVALID' });

      expect(windowsManager.state.commitTranslation).not.toHaveBeenCalled();
    });

    it.each([
      ['source-equal output', 'source'],
      ['meaningful surrounding whitespace', '  translated  '],
    ])('accepts %s unchanged', async (_label, translatedText) => {
      const result = { translatedText };
      windowsManager.translationHandler.performTranslation.mockResolvedValue(result);

      await expect(windowsManager._startTranslationProcess('source', 'window-1'))
        .resolves.toMatchObject({ translatedText });

      expect(windowsManager.state.commitTranslation).toHaveBeenCalledWith('source', result, {});
    });

    it('does not cancel a pending translation when history navigation is already at its boundary', () => {
      windowsManager.state.translationHistory = [{ sourceText: 'only entry' }];
      windowsManager.state.historyIndex = 0;
      const generation = windowsManager.state.translationGeneration;

      windowsManager._navigateTranslationHistory('window-1', 'previous');

      expect(windowsManager.state.translationGeneration).toBe(generation);
      expect(windowsManager.translationHandler.cancelAllTranslations).not.toHaveBeenCalled();
    });

    it('includes the selected history snapshot provider in navigation updates', () => {
      const entry = { sourceText: 'source', translatedText: 'result', provider: 'snapshot-provider' };
      windowsManager.state.translationHistory = [entry];
      windowsManager.state.historyIndex = -1;
      windowsManager.state.navigateHistory = vi.fn(() => {
        windowsManager.state.historyIndex = 0;
        return entry;
      });

      windowsManager._navigateTranslationHistory('window-1', 'next');

      expect(mockWindowsManagerEvents.updateWindow).toHaveBeenCalledWith('window-1', expect.objectContaining({
        provider: 'snapshot-provider',
        historyProvider: 'snapshot-provider',
        historyIndex: 0,
        historyLength: 1,
      }));
    });

    it('cleans DisplayManager delayed activation before destroy', async () => {
      const displayManager = windowsManager.displayManager;
      const cleanupSpy = vi.spyOn(displayManager, 'cleanup');

      await windowsManager._showWindow('text', { x: 1, y: 1 });
      windowsManager.destroy();
      await vi.runAllTimersAsync();

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(windowsManager.clickManager.addOutsideClickListener).not.toHaveBeenCalled();
    });
  });

  describe('Mobile', () => {
    it('should show mobile sheet', async () => {
      const { deviceDetector } = await import('@/utils/browser/compatibility.js');
      vi.mocked(deviceDetector.shouldEnableMobileUI).mockReturnValue(true);
      
      vi.mocked(settingsManager.get).mockImplementation((key, def) => {
        if (key === 'selectionTranslationMode') return 'immediate';
        return def;
      });

      await windowsManager.show('mob', {x:0, y:0});
      expect(mockWindowsManagerEvents.showMobileSheet).toHaveBeenCalled();
    });
  });

  describe('TTS', () => {
    it('should handle speak request', async () => {
      await mockPageEventBus.emit('translation-window-speak', { text: 'hi', language: 'en', isSpeaking: true });
      const { TTSFactory } = await import('@/features/tts/TTSFactory.js');
      expect(TTSFactory._getInstance().speak).toHaveBeenCalledWith('hi', 'en');
    });
  });

  describe('Cross-Frame', () => {
    it('should handle window request', async () => {
      await windowsManager._handleWindowCreationRequest({ selectedText: 'if', position: {x:0,y:0}, frameId: 'f1' });
      expect(mockWindowsManagerEvents.showWindow).toHaveBeenCalled();
    });
  });
});
