import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorTypes } from "@/shared/error-management/ErrorTypes.js";
import { DisplayManager } from "./DisplayManager.js";

const mocks = vi.hoisted(() => ({
  events: {
    showWindow: vi.fn(),
    updateWindow: vi.fn(),
    showMobileSheet: vi.fn(),
  },
  messageRouter: {
    _broadcastToAllIframes: vi.fn(),
  },
  getPresentation: vi.fn(),
}));

vi.mock("@/shared/logging/logger.js", () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock("@/shared/logging/logConstants.js", () => ({
  LOG_COMPONENTS: { WINDOWS: "windows" },
}));

vi.mock("../core/WindowsConfig.js", () => ({
  WindowsConfig: {
    TIMEOUTS: {
      OUTSIDE_CLICK_DELAY: 1,
    },
  },
}));

vi.mock("@/core/PageEventBus.js", () => ({
  WindowsManagerEvents: mocks.events,
}));

vi.mock("@/shared/managers/SettingsManager.js", () => ({
  default: { get: vi.fn((key, fallback) => fallback) },
}));

vi.mock("@/shared/config/config.js", () => ({
  SelectionTranslationMode: {
    IMMEDIATE: "immediate",
    ON_CLICK: "onClick",
    ON_FAB_CLICK: "onFabClick",
  },
  TranslationMode: {
    ScreenCapture: "screenCapture",
  },
}));

vi.mock("@/core/extensionContext.js", () => ({
  default: {
    isValidSync: vi.fn(() => true),
  },
}));

vi.mock("@/utils/browser/compatibility.js", () => ({
  deviceDetector: { shouldEnableMobileUI: vi.fn(() => false) },
}));

vi.mock("@/features/exclusion/core/ExclusionChecker.js", () => ({
  default: {
    getInstance: vi.fn(() => ({
      isFeatureAllowed: vi.fn().mockResolvedValue(true),
    })),
  },
}));

vi.mock("@/shared/constants/mobile.js", () => ({
  MOBILE_CONSTANTS: {
    UI_MODE: { AUTO: "auto", MOBILE: "mobile", DESKTOP: "desktop" },
    VIEWS: { SELECTION: "selection" },
    SHEET_STATE: { PEEK: "peek" },
  },
}));

vi.mock("./SelectionWindowErrorPresenter.js", () => ({
  getSelectionWindowErrorPresentation: mocks.getPresentation,
}));

const createState = () => ({
  isProcessing: false,
  isVisible: false,
  isIconMode: false,
  isPinned: false,
  dockMode: "none",
  activeWindowId: null,
  originalText: null,
  provider: "original-provider",
  translationHistory: [],
  historyIndex: -1,
  isTranslationCancelled: false,
  pendingTranslationWindow: false,
  hasActiveElements: true,
  setActiveWindowId: vi.fn((id) => {
    state.activeWindowId = id;
  }),
  setOriginalText: vi.fn((text) => { state.originalText = text; }),
  setTranslationCancelled: vi.fn(),
  setVisible: vi.fn(),
  setIconMode: vi.fn(),
  setProcessing: vi.fn(),
  setProvider: vi.fn(),
  clearTranslationHistory: vi.fn(() => {
    state.translationHistory = [];
    state.historyIndex = -1;
    state.provider = null;
  }),
});

let state;
let facade;
let errorHandler;
let translationHandler;
let manager;

const canonicalError = (type = ErrorTypes.API_ERROR) =>
  Object.assign(new Error(`raw ${type} detail`), {
    type,
    statusCode: 502,
    providerName: "Private Provider",
    providerId: "private-provider",
  });

const safePresentation = (overrides = {}) => ({
  displayError: Object.assign(new Error("safe localized message"), {
    type: ErrorTypes.API_ERROR,
  }),
  errorInfo: {
    message: "safe localized message",
    type: ErrorTypes.API_ERROR,
    canRetry: true,
    needsSettings: true,
  },
  canonicalType: ErrorTypes.API_ERROR,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state = createState();
  facade = {
    _isIconToWindowTransition: false,
    _lastDismissedText: null,
    _lastDismissTime: 0,
    dismiss: vi.fn().mockResolvedValue(),
    _addDismissListener: vi.fn(),
    _startTranslationProcess: vi.fn().mockRejectedValue(canonicalError()),
    _isCurrentTranslation: vi.fn(() => true),
    _historyUpdate: vi.fn((entry) => entry ? {
      selectedText: entry.sourceText,
      historyIndex: state.historyIndex,
      historyLength: state.translationHistory.length,
    } : {}),
  };
  errorHandler = {
    getErrorForUI: vi.fn(),
    handle: vi.fn().mockResolvedValue(),
  };
  translationHandler = {
    getEffectiveProvider: vi.fn(() => "fallback-provider"),
    cancelAllTranslations: vi.fn(),
  };
  manager = new DisplayManager(facade, {
    state,
    crossFrameManager: {
      frameId: "frame-1",
      isTopFrame: true,
      messageRouter: mocks.messageRouter,
    },
    translationHandler,
    errorHandler,
    clickManager: { addOutsideClickListener: vi.fn() },
    themeManager: { currentTheme: "dark" },
  });
  mocks.getPresentation.mockResolvedValue(safePresentation());
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("DisplayManager Selection Window error boundary", () => {
  it("sanitizes desktop initial failure and updates same window once", async () => {
    const error = canonicalError(ErrorTypes.HTTP_ERROR);
    facade._startTranslationProcess.mockRejectedValue(error);

    await manager._showWindow("selected text", { x: 10, y: 20 });

    const windowId = mocks.events.showWindow.mock.calls[0][0].id;
    expect(mocks.getPresentation).toHaveBeenCalledWith(
      error,
      "windows-translation",
      errorHandler,
    );
    expect(mocks.events.updateWindow).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateWindow).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({
        isLoading: false,
        isStreaming: false,
        isError: true,
        initialTranslatedText: "safe localized message",
        errorType: ErrorTypes.API_ERROR,
        canRetry: true,
        needsSettings: true,
        provider: "fallback-provider",
      }),
    );
    expect(
      mocks.events.updateWindow.mock.calls[0][1].initialTranslatedText,
    ).not.toContain("raw");
  });

  it("clears prior history and provider before creating an independent window", async () => {
    facade._startTranslationProcess.mockResolvedValue({
      translatedText: "new result", provider: "new-provider", sourceLanguage: "en", targetLanguage: "fa",
    });

    await manager._showWindow("new source", { x: 10, y: 20 });

    expect(state.clearTranslationHistory).toHaveBeenCalledTimes(1);
    expect(state.provider).toBeNull();
    expect(mocks.events.showWindow.mock.calls[0][0]).toMatchObject({ historyIndex: -1, historyLength: 0 });
  });

  it("publishes history metadata after an initial successful translation", async () => {
    facade._startTranslationProcess.mockImplementation(async (sourceText) => {
      state.translationHistory = [{ sourceText, translatedText: "result" }];
      state.historyIndex = 0;
      return { translatedText: "result", provider: "provider", sourceLanguage: "en", targetLanguage: "fa" };
    });

    await manager._showWindow("initial source", { x: 10, y: 20 });

    expect(mocks.events.updateWindow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ selectedText: "initial source", historyIndex: 0, historyLength: 1 }),
    );
  });

  it.each(["pinned", "docked"])("publishes advancing history metadata on successful %s-window reuses", async (reuseMode) => {
    state.isVisible = true;
    if (reuseMode === "pinned") state.isPinned = true;
    else state.dockMode = "right";
    state.activeWindowId = "pinned-window";
    state.originalText = "initial source";
    facade._startTranslationProcess.mockImplementation(async (sourceText) => {
      state.translationHistory.push({ sourceText, translatedText: `result:${sourceText}` });
      state.historyIndex = state.translationHistory.length - 1;
      return { translatedText: `result:${sourceText}`, provider: "provider" };
    });

    await manager.show("first source", { x: 10, y: 20 });
    await manager.show("second source", { x: 30, y: 40 });

    const successfulUpdates = mocks.events.updateWindow.mock.calls.filter(([, payload]) => payload.isLoading === false);
    expect(successfulUpdates).toHaveLength(2);
    expect(successfulUpdates.map(([id]) => id)).toEqual(["pinned-window", "pinned-window"]);
    expect(successfulUpdates.map(([, payload]) => [payload.selectedText, payload.historyIndex, payload.historyLength])).toEqual([
      ["first source", 0, 1],
      ["second source", 1, 2],
    ]);
  });

  it("cancels delayed click activation during cleanup", async () => {
    await manager._showWindow("selected text", { x: 10, y: 20 });

    manager.cleanup();
    manager.cleanup();
    await vi.runAllTimersAsync();

    expect(manager.clickManager.addOutsideClickListener).not.toHaveBeenCalled();
  });

  it("activates outside-click handling once after the delay", async () => {
    await manager._showWindow("selected text", { x: 10, y: 20 });
    await vi.advanceTimersByTimeAsync(1);

    expect(manager.clickManager.addOutsideClickListener).toHaveBeenCalledTimes(1);
    expect(mocks.messageRouter._broadcastToAllIframes).toHaveBeenCalledTimes(1);
  });

  it("replaces pending activation when a newer window is shown", async () => {
    const firstShow = manager._showWindow("first text", { x: 10, y: 20 });
    const secondShow = manager._showWindow("second text", { x: 30, y: 40 });

    await Promise.all([firstShow, secondShow]);
    await vi.advanceTimersByTimeAsync(1);

    expect(manager.clickManager.addOutsideClickListener).toHaveBeenCalledTimes(1);
    expect(mocks.messageRouter._broadcastToAllIframes).toHaveBeenCalledTimes(1);
  });

  it("cancels pending activation during icon-to-window transition", async () => {
    await manager._showWindow("initial text", { x: 10, y: 20 });
    facade._isIconToWindowTransition = true;
    await manager._showWindow("transition text", { x: 30, y: 40 });
    await vi.advanceTimersByTimeAsync(1);

    expect(manager.clickManager.addOutsideClickListener).not.toHaveBeenCalled();
    expect(mocks.messageRouter._broadcastToAllIframes).not.toHaveBeenCalled();
  });

  it("uses safe presentation for existing-window update and preserves action fields", async () => {
    state.activeWindowId = "existing-window";
    state.originalText = "old text";
    const error = canonicalError(ErrorTypes.API_RESPONSE_INVALID);
    facade._startTranslationProcess.mockRejectedValue(error);

    await manager._updateExistingWindow("new text");

    expect(mocks.getPresentation).toHaveBeenCalledWith(
      error,
      "windows-translation",
      errorHandler,
    );
    expect(mocks.events.updateWindow).toHaveBeenCalledTimes(2);
    expect(mocks.events.updateWindow.mock.calls[1]).toEqual([
      "existing-window",
      expect.objectContaining({
        initialTranslatedText: "safe localized message",
        errorType: ErrorTypes.API_ERROR,
        canRetry: true,
        needsSettings: true,
      }),
    ]);
    expect(
      mocks.events.updateWindow.mock.calls[1][1].initialTranslatedText,
    ).not.toContain("raw");
  });

  it("keeps the failed reused-window source instead of restoring history source", async () => {
    state.activeWindowId = "existing-window";
    state.translationHistory = [{ sourceText: "old history source" }];
    state.historyIndex = 0;
    facade._startTranslationProcess.mockRejectedValue(canonicalError());

    await manager._updateExistingWindow("new committed source");

    expect(state.originalText).toBe("new committed source");
    expect(mocks.events.updateWindow.mock.calls[1][1]).not.toHaveProperty("selectedText");
    expect(facade._historyUpdate).not.toHaveBeenCalled();
  });

  it("sanitizes mobile sheet error payload without creating a toast", async () => {
    const error = canonicalError(ErrorTypes.NETWORK_ERROR);
    facade._startTranslationProcess.mockRejectedValue(error);

    await manager._showMobileSheet("selected text");

    expect(mocks.getPresentation).toHaveBeenCalledWith(
      error,
      "mobile-translation",
      errorHandler,
    );
    expect(mocks.events.showMobileSheet).toHaveBeenCalledTimes(2);
    const errorPayload = mocks.events.showMobileSheet.mock.calls[1][0];
    expect(errorPayload).toMatchObject({
      isLoading: false,
      isStreaming: false,
      isError: true,
      error: "safe localized message",
    });
    expect(errorPayload.error).not.toContain("raw");
    expect(errorHandler.handle).not.toHaveBeenCalled();
  });

  it("passes adapted Error to legacy ErrorHandler without visible UI", async () => {
    const error = canonicalError(ErrorTypes.API_ERROR);
    const presentation = safePresentation();
    mocks.getPresentation.mockResolvedValue(presentation);

    await manager._handleTranslationError(error, "selected text", {
      x: 10,
      y: 20,
    });

    expect(errorHandler.handle).toHaveBeenCalledWith(
      presentation.displayError,
      {
        type: ErrorTypes.API_ERROR,
        context: "windows-manager-translate",
        isSilent: true,
        showInUI: false,
      },
    );
    expect(errorHandler.handle).not.toHaveBeenCalledWith(
      error,
      expect.anything(),
    );
    expect(mocks.events.showWindow).toHaveBeenCalledTimes(1);
    expect(mocks.events.showWindow.mock.calls[0][0].initialTranslatedText).toBe(
      "safe localized message",
    );
  });

  it("does not emit error UI when presenter excludes failure", async () => {
    mocks.getPresentation.mockResolvedValue(null);
    facade._startTranslationProcess.mockRejectedValue(
      canonicalError(ErrorTypes.TRANSLATION_CANCELLED),
    );

    await manager._showWindow("selected text", { x: 10, y: 20 });

    expect(mocks.events.showWindow).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateWindow).not.toHaveBeenCalled();
  });
});
