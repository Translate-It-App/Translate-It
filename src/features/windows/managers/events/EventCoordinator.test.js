import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetPresentation,
  mockShowWindow,
  mockUpdateWindow,
  mockPageEventBus,
} = vi.hoisted(() => {
  const listeners = new Map();
  const pageEventBus = {
    on: vi.fn((event, callback) => {
      const eventListeners = listeners.get(event) || [];
      eventListeners.push(callback);
      listeners.set(event, eventListeners);
    }),
    off: vi.fn((event, callback) => {
      const eventListeners = listeners.get(event) || [];
      const index = eventListeners.indexOf(callback);
      if (index >= 0) eventListeners.splice(index, 1);
    }),
    emit: vi.fn((event, detail) =>
      [...(listeners.get(event) || [])].map((callback) => callback(detail)),
    ),
    reset: () => listeners.clear(),
  };

  return {
    mockGetPresentation: vi.fn(),
    mockShowWindow: vi.fn(),
    mockUpdateWindow: vi.fn(),
    mockPageEventBus: pageEventBus,
  };
});

vi.mock("../display/SelectionWindowErrorPresenter.js", () => ({
  getSelectionWindowErrorPresentation: mockGetPresentation,
}));

vi.mock("@/shared/logging/logger.js", () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("@/shared/config/config.js", () => ({
  state: {},
}));

vi.mock("@/core/PageEventBus.js", () => ({
  pageEventBus: mockPageEventBus,
  WindowsManagerEvents: {
    showWindow: mockShowWindow,
    updateWindow: mockUpdateWindow,
    dismissIcon: vi.fn(),
  },
  WINDOWS_MANAGER_EVENTS: {
    ICON_CLICKED: "windows-manager-icon-clicked",
    DISMISS_WINDOW: "windows-manager-dismiss-window",
    DISMISS_ICON: "windows-manager-dismiss-icon",
  },
}));

vi.mock("@/features/text-selection/events/SelectionEvents.js", () => ({
  SELECTION_EVENTS: {
    GLOBAL_SELECTION_TRIGGER: "global-selection-trigger",
    GLOBAL_SELECTION_CLEAR: "global-selection-clear",
    GLOBAL_SELECTION_CHANGE: "global-selection-change",
  },
}));

// The real Interaction ClickManager is used in the gesture-identity tests; its
// only non-trivial dependency (ResourceTracker/MemoryManager) is stubbed.
vi.mock("@/core/memory/ResourceTracker.js", () => ({
  default: class ResourceTracker {
    constructor() {
      this.addEventListener = vi.fn();
      this.removeEventListener = vi.fn();
    }
    cleanup() {}
  },
}));

import { EventCoordinator } from "./EventCoordinator.js";
import { ClickManager } from "../interaction/ClickManager.js";
import { getTextSelectionWindowRelay } from "../crossframe/TextSelectionWindowRelay.js";
import { pageEventBus, WINDOWS_MANAGER_EVENTS } from "@/core/PageEventBus.js";
import { SELECTION_EVENTS } from "@/features/text-selection/events/SelectionEvents.js";

describe("EventCoordinator cross-frame coordinate adjustment", () => {
  let facade;
  let coordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPageEventBus.reset();
    facade = { show: vi.fn() };
    coordinator = new EventCoordinator(facade, {
      state: {},
      crossFrameManager: { isTopFrame: true, setEventHandlers: vi.fn() },
      translationHandler: {},
      errorHandler: {},
      clickManager: { setHandlers: vi.fn() },
      themeManager: {},
      positionCalculator: {},
    });
  });

  afterEach(() => {
    mockPageEventBus.reset();
    getTextSelectionWindowRelay().destroy();
    vi.restoreAllMocks();
  });

  const stubIframes = (frames) => {
    vi.spyOn(document, "querySelectorAll").mockImplementation((selector) => {
      if (selector === "iframe") return frames;
      return [];
    });
  };

  const sourceWindow = { frame: true };

  it("adds iframeRect.left/top exactly once for a matching iframe sourceWindow", async () => {
    stubIframes([
      {
        contentWindow: sourceWindow,
        getBoundingClientRect: () => ({ left: 150, top: 300 }),
      },
    ]);

    await coordinator._handleTextSelectionWindowRequest(
      { position: { x: 100, y: 200 }, selectedText: "hello", options: {} },
      sourceWindow,
    );

    expect(facade.show).toHaveBeenCalledTimes(1);
    const [, position] = facade.show.mock.calls[0];
    expect(position.x).toBe(250); // 100 + 150, added once
    expect(position.y).toBe(500); // 200 + 300, added once
  });

  it("marks the adjusted position as viewport-relative and non-absolute", async () => {
    stubIframes([
      {
        contentWindow: sourceWindow,
        getBoundingClientRect: () => ({ left: 150, top: 300 }),
      },
    ]);

    await coordinator._handleTextSelectionWindowRequest(
      { position: { x: 100, y: 200 }, selectedText: "hello", options: {} },
      sourceWindow,
    );

    const [, position] = facade.show.mock.calls[0];
    expect(position._isViewportRelative).toBe(true);
    expect(position._isAbsolute).toBe(false);
  });

  it("does NOT add top-page scroll separately (iframeRect is already viewport-relative)", async () => {
    vi.stubGlobal("scrollX", 40);
    vi.stubGlobal("scrollY", 50);
    stubIframes([
      {
        contentWindow: sourceWindow,
        getBoundingClientRect: () => ({ left: 150, top: 300 }),
      },
    ]);

    await coordinator._handleTextSelectionWindowRequest(
      { position: { x: 100, y: 200 }, selectedText: "hello", options: {} },
      sourceWindow,
    );

    const [, position] = facade.show.mock.calls[0];
    expect(position.x).toBe(250); // not 250 + 40
    expect(position.y).toBe(500); // not 500 + 50
    vi.unstubAllGlobals();
  });

  it("passes the raw position unchanged when sourceWindow does not match any iframe", async () => {
    stubIframes([
      {
        contentWindow: { other: true },
        getBoundingClientRect: () => ({ left: 150, top: 300 }),
      },
    ]);

    await coordinator._handleTextSelectionWindowRequest(
      { position: { x: 100, y: 200 }, selectedText: "hello", options: {} },
      sourceWindow,
    );

    // Document current behavior: no fallback, no adjustment.
    const [, position] = facade.show.mock.calls[0];
    expect(position).toEqual({ x: 100, y: 200 });
    expect(position._isViewportRelative).toBeUndefined();
  });

  it("ignores the request when not running in the top frame", async () => {
    coordinator.crossFrameManager.isTopFrame = false;

    await coordinator._handleTextSelectionWindowRequest(
      { position: { x: 100, y: 200 }, selectedText: "hello", options: {} },
      sourceWindow,
    );

    expect(facade.show).not.toHaveBeenCalled();
  });
});

describe("EventCoordinator relay sink ownership", () => {
  let facade;
  let coordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPageEventBus.reset();
    facade = { show: vi.fn() };
    coordinator = new EventCoordinator(facade, {
      state: {},
      crossFrameManager: { isTopFrame: true, setEventHandlers: vi.fn() },
      translationHandler: {},
      errorHandler: {},
      clickManager: { setHandlers: vi.fn() },
      themeManager: {},
      positionCalculator: {},
    });
  });

  afterEach(() => {
    mockPageEventBus.reset();
    getTextSelectionWindowRelay().destroy();
    vi.restoreAllMocks();
  });

  it("setup registers a sink and cleanup clears exactly it", () => {
    const relay = getTextSelectionWindowRelay();
    coordinator.setup();

    const registered = relay._sink;
    expect(registered).toBeTypeOf("function");

    coordinator.cleanup();
    expect(relay._sink).toBeNull();
  });

  it("cleanup never clears a replacement sink registered after setup", () => {
    const relay = getTextSelectionWindowRelay();
    coordinator.setup();

    const replacement = vi.fn();
    relay.setSink(replacement);

    coordinator.cleanup();
    expect(relay._sink).toBe(replacement);
  });
});

describe("EventCoordinator cross-frame outside-click resize handling", () => {
  let facade;
  let coordinator;
  let state;
  let handlers;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPageEventBus.reset();
    window.__TRANSLATION_WINDOW_IS_DRAGGING = false;
    window.__TRANSLATION_WINDOW_JUST_DRAGGED = false;
    window.__TRANSLATION_WINDOW_IS_RESIZING = false;
    window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
    state = {
      hasActiveElements: true,
      isPinned: false,
      activeWindowId: "window-1",
      shouldPreventDismissal: false,
      isInitialLoadingWindow: vi.fn(() => false),
      setPendingTranslationWindow(pending) { this.shouldPreventDismissal = pending; },
      setProcessing: vi.fn(),
      setIconMode: vi.fn(),
    };
    facade = {
      dismiss: vi.fn().mockResolvedValue(undefined),
      displayManager: {
        shouldUseMobileUI: vi.fn(() => false),
        _showWindow: vi.fn().mockResolvedValue(undefined),
      },
      dismissalManager: { _removeDismissListener: vi.fn() },
    };
    coordinator = new EventCoordinator(facade, {
      state,
      crossFrameManager: {
        isTopFrame: true,
        setEventHandlers: vi.fn((registered) => { handlers = registered; }),
      },
      translationHandler: {},
      errorHandler: {},
      clickManager: {
        setHandlers: vi.fn(),
        resolveCrossFrameOutsideClick: vi.fn(() => ({ suppress: false })),
        completeIconTransition: vi.fn(() => setTimeout(() => state.setPendingTranslationWindow(false), 500)),
      },
      themeManager: {},
      positionCalculator: {},
    });
    coordinator.setup();
  });

  afterEach(() => {
    coordinator.cleanup();
    mockPageEventBus.reset();
    getTextSelectionWindowRelay().destroy();
    window.__TRANSLATION_WINDOW_IS_DRAGGING = false;
    window.__TRANSLATION_WINDOW_JUST_DRAGGED = false;
    window.__TRANSLATION_WINDOW_IS_RESIZING = false;
    window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
    vi.restoreAllMocks();
  });

  it("dismisses an independent cross-frame click after resize completion", async () => {
    window.__TRANSLATION_WINDOW_JUST_RESIZED = true;

    await handlers.onOutsideClick();

    expect(facade.dismiss).toHaveBeenCalledWith(true);
    expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);
  });

  it("allows cross-frame dismissal of a pinned initial spinner but not a completed pinned window", async () => {
    state.isPinned = true;
    state.isInitialLoadingWindow.mockReturnValue(true);
    await coordinator._handleCrossFrameOutsideClick({ data: {} });
    expect(facade.dismiss).toHaveBeenCalledTimes(1);

    facade.dismiss.mockClear();
    state.isInitialLoadingWindow.mockReturnValue(false);
    await coordinator._handleCrossFrameOutsideClick({ data: {} });
    expect(facade.dismiss).not.toHaveBeenCalled();
  });

  it("allows local dismissal of a pinned initial spinner and preserves transition protection", async () => {
    state.isPinned = true;
    state.isInitialLoadingWindow.mockReturnValue(true);
    await coordinator._handleOutsideClick();
    expect(facade.dismiss).toHaveBeenCalledTimes(1);

    facade.dismiss.mockClear();
    state.shouldPreventDismissal = true;
    await coordinator._handleOutsideClick();
    expect(facade.dismiss).not.toHaveBeenCalled();
  });

  it("resolves cross-frame gesture identity before blocking a pending transition, then allows an independent click", async () => {
    state.shouldPreventDismissal = true;
    const resolveGesture = coordinator.clickManager.resolveCrossFrameOutsideClick;

    await coordinator._handleCrossFrameOutsideClick({ data: { pointerId: 7 } });
    expect(resolveGesture).toHaveBeenCalledWith({ pointerId: 7, fromCrossDocumentGesture: undefined });
    expect(facade.dismiss).not.toHaveBeenCalled();

    state.shouldPreventDismissal = false;
    await coordinator._handleCrossFrameOutsideClick({ data: { pointerId: 8 } });
    expect(facade.dismiss).toHaveBeenCalledTimes(1);
  });

  it("blocks selection clear during transition but permits independent selection clear and outside click afterward", async () => {
    state.shouldPreventDismissal = true;
    state.isVisible = true;
    facade._selectionClearHandler();
    expect(facade.dismiss).not.toHaveBeenCalled();

    state.shouldPreventDismissal = false;
    facade._selectionClearHandler();
    expect(facade.dismiss).toHaveBeenCalledTimes(1);

    facade.dismiss.mockClear();
    state.shouldPreventDismissal = true;
    await coordinator._handleOutsideClick();
    expect(facade.dismiss).not.toHaveBeenCalled();
    state.shouldPreventDismissal = false;
    await coordinator._handleOutsideClick();
    expect(facade.dismiss).toHaveBeenCalledTimes(1);
  });

  it("blocks selection clear during the Vue icon transition", () => {
    facade._isIconToWindowTransition = true;

    facade._selectionClearHandler();

    expect(facade.dismiss).not.toHaveBeenCalled();
  });

  it("bounds Vue icon transition protection and allows the next independent cross-frame click", async () => {
    vi.useFakeTimers();
    try {
      await coordinator._handleIconClickFromVue({
        id: "icon-1", text: "selected text", position: { x: 1, y: 2 },
      });

      expect(state.shouldPreventDismissal).toBe(true);
      expect(coordinator.clickManager.completeIconTransition).toHaveBeenCalledTimes(1);

      await coordinator._handleCrossFrameOutsideClick({ data: { pointerId: 11 } });
      expect(coordinator.clickManager.resolveCrossFrameOutsideClick).toHaveBeenCalledWith({
        pointerId: 11, fromCrossDocumentGesture: undefined,
      });
      expect(facade.dismiss).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(state.shouldPreventDismissal).toBe(false);
      await coordinator._handleCrossFrameOutsideClick({ data: { pointerId: 12 } });
      expect(facade.dismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["dragging", "__TRANSLATION_WINDOW_IS_DRAGGING"],
    ["resizing", "__TRANSLATION_WINDOW_IS_RESIZING"],
  ])("preserves local %s protection for a pinned initial spinner", async (_label, flag) => {
    state.isPinned = true;
    state.isInitialLoadingWindow.mockReturnValue(true);
    window[flag] = true;

    await coordinator._handleOutsideClick();

    expect(facade.dismiss).not.toHaveBeenCalled();
  });

  it("leaves local resize-completion protection intact when a cross-frame click arrives first", async () => {
    window.__TRANSLATION_WINDOW_JUST_RESIZED = true;

    await handlers.onOutsideClick();
    await coordinator._handleOutsideClick();

    expect(facade.dismiss).toHaveBeenCalledTimes(1);
    expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);
  });

  it("keeps dismissal when the incoming relay lacks a resolve-capable manager", async () => {
    // The beforeEach coordinator uses a legacy mock clickManager without the
    // resolve API: absent identity must default to allow (no suppression).
    await handlers.onOutsideClick();
    expect(facade.dismiss).toHaveBeenCalledWith(true);
  });

  it("ignores cross-frame clicks during an active resize", async () => {
    window.__TRANSLATION_WINDOW_IS_RESIZING = true;

    await handlers.onOutsideClick();

    expect(facade.dismiss).not.toHaveBeenCalled();
  });

  it.each([
    ["dragging", "__TRANSLATION_WINDOW_IS_DRAGGING"],
    ["just dragged", "__TRANSLATION_WINDOW_JUST_DRAGGED"],
  ])("preserves cross-frame click protection when %s", async (_label, flag) => {
    window[flag] = true;

    await handlers.onOutsideClick();

    expect(facade.dismiss).not.toHaveBeenCalled();
  });
});

describe("EventCoordinator cross-frame gesture identity with a real ClickManager", () => {
  let facade;
  let state;
  let relayHandlers;
  let clickManager;
  let coordinator;

  const makePointerEvent = (type, { composedPath = [], pointerId = 1 } = {}) => {
    const event = new Event(type, { bubbles: true, composed: true });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    Object.defineProperty(event, "composedPath", {
      value: () => composedPath,
    });
    return event;
  };

  // Builds a real EventCoordinator wired to a real ClickManager, and relays
  // cross-frame outside-click payloads through the real registered handler.
  const createRealCoordinator = () => {
    facade = {
      dismiss: vi.fn().mockResolvedValue(undefined),
      displayManager: { shouldUseMobileUI: vi.fn(() => false) },
    };
    state = { hasActiveElements: true };
    clickManager = new ClickManager(
      {
        enableGlobalClickBroadcast: vi.fn(),
        disableGlobalClickBroadcast: vi.fn(),
        requestGlobalClickRelay: vi.fn(),
      },
      state,
    );
    coordinator = new EventCoordinator(facade, {
      state,
      crossFrameManager: {
        isTopFrame: true,
        setEventHandlers: vi.fn((registered) => { relayHandlers = registered; }),
      },
      translationHandler: {},
      errorHandler: {},
      clickManager,
      themeManager: {},
      positionCalculator: {},
    });
    coordinator.setup();
    return coordinator;
  };

  const relay = (fields) =>
    relayHandlers.onOutsideClick({
      data: { type: "translateit-outside-click", ...fields },
    });

  const setupWindow = () => {
    const windowEl = document.createElement("div");
    windowEl.className = "ti-window";
    const inner = document.createElement("button");
    windowEl.appendChild(inner);
    document.body.appendChild(windowEl);
    return { windowEl, inner };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPageEventBus.reset();
    window.__TRANSLATION_WINDOW_IS_DRAGGING = false;
    window.__TRANSLATION_WINDOW_JUST_DRAGGED = false;
    window.__TRANSLATION_WINDOW_IS_RESIZING = false;
    window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
    document.body.innerHTML = "";
  });

  afterEach(() => {
    coordinator?.cleanup();
    mockPageEventBus.reset();
    getTextSelectionWindowRelay().destroy();
    document.body.innerHTML = "";
    window.__TRANSLATION_WINDOW_IS_DRAGGING = false;
    window.__TRANSLATION_WINDOW_JUST_DRAGGED = false;
    window.__TRANSLATION_WINDOW_IS_RESIZING = false;
    window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
    vi.restoreAllMocks();
  });

  it("immediately dismisses an independent iframe click after a local inside click completes the gesture", async () => {
    createRealCoordinator();
    const { windowEl, inner } = setupWindow();

    // Local gesture: press inside, release inside, completion click inside.
    clickManager._onWindowPointerDown(
      makePointerEvent("pointerdown", { composedPath: [inner, windowEl], pointerId: 1 }),
    );
    clickManager._onWindowCaptureClick(new MouseEvent("click", { bubbles: true }));
    expect(clickManager._armedGesture?.completed).toBe(true);

    // Independent iframe click: not a cross-document gesture for pid 2.
    await relay({ pointerId: 2, fromCrossDocumentGesture: false });

    expect(facade.dismiss).toHaveBeenCalledTimes(1);
    expect(clickManager._armedGesture).toBeNull();
  });

  it("suppresses the matching relay of a locally completed gesture once, then dismisses the next independent click", async () => {
    createRealCoordinator();
    const { windowEl, inner } = setupWindow();

    // Firefox-like origin: press inside; the origin observes the retargeted
    // local completion click (arm completed).
    clickManager._onWindowPointerDown(
      makePointerEvent("pointerdown", { composedPath: [inner, windowEl], pointerId: 1 }),
    );
    clickManager._onWindowCaptureClick(new MouseEvent("click", { bubbles: true }));

    // Duplicate relay of our own completion click.
    await relay({ pointerId: 1, fromCrossDocumentGesture: true });
    expect(facade.dismiss).not.toHaveBeenCalled();
    expect(clickManager._armedGesture).toBeNull();

    // A subsequent independent iframe click dismisses.
    await relay({ pointerId: 5, fromCrossDocumentGesture: false });
    expect(facade.dismiss).toHaveBeenCalledTimes(1);
  });

  it("suppresses a matching relay while the arm is still pending (missed local completion)", async () => {
    createRealCoordinator();
    const { windowEl } = setupWindow();

    clickManager._onWindowPointerDown(
      makePointerEvent("pointerdown", { composedPath: [windowEl], pointerId: 1 }),
    );
    expect(clickManager.isGestureProtectionActive()).toBe(true);

    // The remote frame saw the completion click; the origin did not.
    await relay({ pointerId: 1, fromCrossDocumentGesture: true });
    expect(facade.dismiss).not.toHaveBeenCalled();
    expect(clickManager._armedGesture).toBeNull();

    // The next independent cross-frame click dismisses.
    await relay({ pointerId: 3, fromCrossDocumentGesture: false });
    expect(facade.dismiss).toHaveBeenCalledTimes(1);
  });

  it("does not suppress a flagged relay with a mismatching pid against a completed arm", async () => {
    createRealCoordinator();
    const { windowEl } = setupWindow();

    clickManager._onWindowPointerDown(
      makePointerEvent("pointerdown", { composedPath: [windowEl], pointerId: 1 }),
    );
    clickManager._onWindowCaptureClick(new MouseEvent("click", { bubbles: true }));

    await relay({ pointerId: 2, fromCrossDocumentGesture: true });

    // Stale completed arm is cleared and dismissal proceeds immediately.
    expect(facade.dismiss).toHaveBeenCalledTimes(1);
    expect(clickManager._armedGesture).toBeNull();
  });

  it("does not suppress a flagged relay without a pointerId while the arm is pending", async () => {
    createRealCoordinator();
    const { windowEl } = setupWindow();

    clickManager._onWindowPointerDown(
      makePointerEvent("pointerdown", { composedPath: [windowEl], pointerId: 1 }),
    );

    await relay({ pointerId: null, fromCrossDocumentGesture: true });

    // Flag alone must not match: the identity-less relay is allowed to
    // dismiss, and the still-pending arm is kept.
    expect(facade.dismiss).toHaveBeenCalledTimes(1);
    expect(clickManager._armedGesture?.completed).toBe(false);
    expect(clickManager.isGestureProtectionActive()).toBe(true);
  });

  it("dismisses a flagged relay when no arm exists (e.g. after pointercancel)", async () => {
    createRealCoordinator();
    const { windowEl } = setupWindow();
    clickManager._onWindowPointerDown(
      makePointerEvent("pointerdown", { composedPath: [windowEl], pointerId: 1 }),
    );
    clickManager._onWindowPointerCancel(
      makePointerEvent("pointercancel", { composedPath: [windowEl], pointerId: 1 }),
    );

    await relay({ pointerId: 1, fromCrossDocumentGesture: true });

    expect(clickManager._armedGesture).toBeNull();
    expect(facade.dismiss).toHaveBeenCalledTimes(1);
  });

  it("suppresses nothing for a relay without identity fields (legacy payload)", async () => {
    createRealCoordinator();
    const { windowEl } = setupWindow();

    clickManager._onWindowPointerDown(
      makePointerEvent("pointerdown", { composedPath: [windowEl], pointerId: 1 }),
    );

    await relay({});
    // The identity-less relay does not resolve the still-pending arm, and the
    // legacy payload still dismisses.
    expect(facade.dismiss).toHaveBeenCalledTimes(1);
    expect(clickManager.isGestureProtectionActive()).toBe(true);
  });
});

describe("EventCoordinator PageEventBus listener ownership", () => {
  let coordinators;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPageEventBus.reset();
    vi.useFakeTimers();
    coordinators = [];
  });

  afterEach(() => {
    coordinators.forEach((coordinator) => coordinator.cleanup());
    mockPageEventBus.reset();
    getTextSelectionWindowRelay().destroy();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const createCoordinator = () => {
    const state = {
      isProcessing: false,
      isVisible: false,
      isIconMode: false,
      isPinned: false,
      setProcessing: vi.fn((value) => {
        state.isProcessing = value;
      }),
      setIconMode: vi.fn((value) => {
        state.isIconMode = value;
      }),
      setPendingTranslationWindow: vi.fn((value) => {
        state.shouldPreventDismissal = value;
      }),
    };
    const facade = {
      _isIconToWindowTransition: false,
      _lastProcessedClick: null,
      dismiss: vi.fn(),
      show: vi.fn(),
      displayManager: {
        _showWindow: vi.fn().mockResolvedValue(undefined),
      },
      dismissalManager: {
        _removeDismissListener: vi.fn(),
      },
    };
    const coordinator = new EventCoordinator(facade, {
      state,
      crossFrameManager: {
        isTopFrame: true,
        setEventHandlers: vi.fn(),
      },
      translationHandler: {},
      errorHandler: {},
      clickManager: { setHandlers: vi.fn(), completeIconTransition: vi.fn() },
      themeManager: {},
      positionCalculator: {},
    });

    coordinators.push(coordinator);
    return { coordinator, facade };
  };

  it("unregisters all handlers registered by setup", () => {
    const { coordinator, facade } = createCoordinator();
    coordinator.setup();

    const registrations = [
      [WINDOWS_MANAGER_EVENTS.ICON_CLICKED, facade._iconClickHandler],
      ["translation-window-speak", facade._speakRequestHandler],
      ["translation-window-retry", facade._retryRequestHandler],
      ["translation-window-change-provider", facade._changeProviderRequestHandler],
      ["translation-window-history-navigate", facade._historyNavigateHandler],
      ["translation-window-confirm-source", facade._confirmSourceHandler],
      [WINDOWS_MANAGER_EVENTS.DISMISS_WINDOW, facade._dismissRequestHandler],
      [WINDOWS_MANAGER_EVENTS.DISMISS_ICON, facade._dismissRequestHandler],
      [SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER, facade._selectionTriggerHandler],
      [SELECTION_EVENTS.GLOBAL_SELECTION_CLEAR, facade._selectionClearHandler],
      [SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, facade._selectionChangeHandler],
    ];

    coordinator.cleanup();

    expect(pageEventBus.off).toHaveBeenCalledTimes(registrations.length);
    registrations.forEach(([event, handler]) => {
      expect(pageEventBus.off).toHaveBeenCalledWith(event, handler);
    });
    expect(facade._iconClickHandler).toBeNull();
    expect(facade._selectionChangeHandler).toBeNull();
  });

  it("handles one ICON_CLICKED after coordinator reactivation", async () => {
    const old = createCoordinator();
    old.coordinator.setup();
    old.coordinator.cleanup();

    const live = createCoordinator();
    live.coordinator.setup();

    mockPageEventBus.emit(WINDOWS_MANAGER_EVENTS.ICON_CLICKED, {
      id: "icon-1",
      text: "hello",
      position: { x: 1, y: 2 },
    });
    await Promise.resolve();

    expect(old.facade.displayManager._showWindow).not.toHaveBeenCalled();
    expect(live.facade.displayManager._showWindow).toHaveBeenCalledTimes(1);
  });

  it.each([
    [SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, "show"],
    [SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER, "show"],
  ])("routes one %s event only to live coordinator", async (event) => {
    const old = createCoordinator();
    old.coordinator.setup();
    old.coordinator.cleanup();

    const live = createCoordinator();
    live.coordinator.setup();

    mockPageEventBus.emit(event, {
      text: "hello",
      position: { x: 1, y: 2 },
      options: { immediate: true },
    });
    await Promise.resolve();

    expect(old.facade.show).not.toHaveBeenCalled();
    expect(live.facade.show).toHaveBeenCalledTimes(1);
  });

  it("makes cleanup idempotent without removing replacement listeners", async () => {
    const old = createCoordinator();
    old.coordinator.setup();
    const oldTriggerHandler = old.facade._selectionTriggerHandler;
    old.coordinator.cleanup();

    const live = createCoordinator();
    live.coordinator.setup();
    const liveTriggerHandler = live.facade._selectionTriggerHandler;

    old.coordinator.cleanup();
    mockPageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER, {
      text: "hello",
      position: { x: 1, y: 2 },
    });
    await Promise.resolve();

    expect(pageEventBus.off).toHaveBeenCalledWith(
      SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER,
      oldTriggerHandler,
    );
    expect(pageEventBus.off).not.toHaveBeenCalledWith(
      SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER,
      liveTriggerHandler,
    );
    expect(old.facade.show).not.toHaveBeenCalled();
    expect(live.facade.show).toHaveBeenCalledTimes(1);
  });
});

describe("EventCoordinator iframe window creation error boundary", () => {
  let facade;
  let coordinator;
  let errorHandler;
  let crossFrameManager;
  let state;

  beforeEach(() => {
    vi.clearAllMocks();
    errorHandler = { getErrorForUI: vi.fn() };
    state = {
      setOriginalText: vi.fn(),
      setTranslationCancelled: vi.fn(),
      setIconMode: vi.fn(),
      setVisible: vi.fn(),
      clearTranslationHistory: vi.fn(),
      setActiveWindowId: vi.fn(),
    };
    crossFrameManager = {
      isTopFrame: true,
      notifyWindowCreated: vi.fn(),
    };
    facade = {
      _startTranslationProcess: vi.fn(),
    };
    mockGetPresentation.mockResolvedValue({
      displayError: new Error("safe iframe message"),
      errorInfo: {
        message: "safe iframe message",
        type: "HTTP_ERROR",
      },
      canonicalType: "HTTP_ERROR",
    });
    coordinator = new EventCoordinator(facade, {
      state,
      crossFrameManager,
      translationHandler: {},
      errorHandler,
      clickManager: { setHandlers: vi.fn() },
      themeManager: {},
      positionCalculator: {},
    });
  });

  it("uses safe presentation while preserving iframe error payload shape", async () => {
    const canonicalError = Object.assign(
      new Error("raw iframe provider detail"),
      {
        type: "HTTP_ERROR",
        statusCode: 502,
        providerName: "Private Provider",
        providerId: "private-provider",
      },
    );
    facade._startTranslationProcess.mockRejectedValue(canonicalError);

    await coordinator._handleWindowCreationRequest({
      selectedText: "selected text",
      position: { x: 10, y: 20 },
      frameId: "frame-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(facade._startTranslationProcess).toHaveBeenCalled();
    expect(state.clearTranslationHistory).toHaveBeenCalledTimes(1);
    expect(state.setActiveWindowId).toHaveBeenCalledWith(expect.any(String));
    expect(mockShowWindow).toHaveBeenCalled();
    expect(mockGetPresentation).toHaveBeenCalledWith(
      canonicalError,
      "windows-translation",
      errorHandler,
    );
    expect(mockUpdateWindow).toHaveBeenCalledTimes(1);
    const [, payload] = mockUpdateWindow.mock.calls[0];
    expect(payload).toMatchObject({
      initialSize: "normal",
      isLoading: false,
      isStreaming: false,
      isError: true,
      errorType: "HTTP_ERROR",
      initialTranslatedText: expect.not.stringContaining("raw"),
    });
    expect(payload.initialTranslatedText).not.toContain("raw");
    expect(payload).not.toHaveProperty("canRetry");
    expect(payload).not.toHaveProperty("needsSettings");
    expect(payload).not.toHaveProperty("provider");
  });

  it("does not update iframe window when presenter excludes failure", async () => {
    facade._startTranslationProcess.mockRejectedValue(new Error("cancelled"));
    mockGetPresentation.mockResolvedValue(null);

    await coordinator._handleWindowCreationRequest({
      selectedText: "selected text",
      position: { x: 10, y: 20 },
      frameId: "frame-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mockGetPresentation).toHaveBeenCalled();
    expect(mockUpdateWindow).not.toHaveBeenCalled();
  });

  it("does not display a stale cross-frame translation result", async () => {
    facade._startTranslationProcess.mockResolvedValue({
      _requestId: 1, translatedText: "stale", provider: "provider",
    });
    facade._isCurrentTranslation = vi.fn(() => false);

    await coordinator._handleWindowCreationRequest({
      selectedText: "selected text",
      position: { x: 10, y: 20 },
      frameId: "frame-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockUpdateWindow).not.toHaveBeenCalled();
  });
});

describe("EventCoordinator retry error boundary", () => {
  let facade;
  let coordinator;
  let state;
  let translationHandler;
  let errorHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      activeWindowId: "window-1",
      originalText: "original text",
      provider: "old-provider",
    };
    state.setProvider = vi.fn((provider) => {
      state.provider = provider;
    });
    translationHandler = {
      getEffectiveProvider: vi.fn(() => "fallback-provider"),
    };
    errorHandler = {};
    facade = {
      _startTranslationProcess: vi.fn(),
    };
    coordinator = new EventCoordinator(facade, {
      state,
      crossFrameManager: { isTopFrame: true },
      translationHandler,
      errorHandler,
      clickManager: {},
      themeManager: {},
      positionCalculator: {},
    });
  });

  it.each([
    ["HTTP_ERROR", "raw retry HTTP body", "safe retry HTTP message"],
    ["API_RESPONSE_INVALID", "raw retry parser detail", "safe retry parser message"],
    [undefined, "raw retry unknown detail", "safe retry fallback message"],
  ])("sanitizes retry failure for %s", async (type, rawMessage, safeMessage) => {
    const canonicalError = new Error(rawMessage);
    if (type) canonicalError.type = type;
    facade._startTranslationProcess.mockRejectedValue(canonicalError);
    mockGetPresentation.mockResolvedValue({
      displayError: new Error(safeMessage),
      errorInfo: {
        message: safeMessage,
        type: type || "TRANSLATION_FAILED",
        canRetry: true,
        needsSettings: true,
      },
      canonicalType: type || null,
    });

    await coordinator._handleRetryRequest({
      id: "window-1",
      text: "original text",
    });

    expect(mockGetPresentation).toHaveBeenCalledTimes(1);
    expect(mockGetPresentation).toHaveBeenCalledWith(
      canonicalError,
      "windows-translation",
      errorHandler,
    );
    expect(mockUpdateWindow).toHaveBeenCalledTimes(2);
    expect(mockUpdateWindow.mock.calls[0][0]).toBe("window-1");
    expect(mockUpdateWindow.mock.calls[1]).toEqual([
      "window-1",
      expect.objectContaining({
        isLoading: false,
        isStreaming: false,
        isError: true,
        initialTranslatedText: safeMessage,
        errorType: type || "TRANSLATION_FAILED",
        canRetry: true,
        needsSettings: true,
        provider: "fallback-provider",
      }),
    ]);
    expect(mockUpdateWindow.mock.calls[1][1].initialTranslatedText).not.toContain(rawMessage);
    expect(mockShowWindow).not.toHaveBeenCalled();
  });

  it("does not emit retry error update when presenter excludes cancellation", async () => {
    const canonicalError = Object.assign(new Error("cancelled"), {
      type: "TRANSLATION_CANCELLED",
    });
    facade._startTranslationProcess.mockRejectedValue(canonicalError);
    mockGetPresentation.mockResolvedValue(null);

    await coordinator._handleRetryRequest({ id: "window-1", text: "original text" });

    expect(mockGetPresentation).toHaveBeenCalledTimes(1);
    expect(mockUpdateWindow).toHaveBeenCalledTimes(1);
    expect(mockUpdateWindow.mock.calls[0]).toEqual([
      "window-1",
      { isLoading: true, isError: false, initialTranslatedText: "" },
    ]);
    expect(mockShowWindow).not.toHaveBeenCalled();
  });

  it("keeps successful retry behavior unchanged", async () => {
    facade._startTranslationProcess.mockResolvedValue({
      translatedText: "translated text",
      sourceLanguage: "en",
      targetLanguage: "it",
      mode: "selection",
      provider: "fallback-provider",
    });

    await coordinator._handleRetryRequest({ id: "window-1", text: "original text" });

    expect(mockGetPresentation).not.toHaveBeenCalled();
    expect(mockUpdateWindow).toHaveBeenCalledTimes(2);
    expect(mockUpdateWindow.mock.calls[1]).toEqual([
      "window-1",
      expect.objectContaining({
        isLoading: false,
        isStreaming: false,
        isError: false,
        initialTranslatedText: "translated text",
        targetLanguage: "it",
        mode: "selection",
        provider: "fallback-provider",
      }),
    ]);
  });

  it("publishes current history navigation metadata on retry success", async () => {
    state.translationHistory = [{ sourceText: "restored source" }, { sourceText: "newer source" }];
    state.historyIndex = 0;
    facade._historyUpdate = vi.fn((entry) => ({
      selectedText: entry.sourceText,
      historyIndex: state.historyIndex,
      historyLength: state.translationHistory.length,
    }));
    facade._startTranslationProcess.mockResolvedValue({
      translatedText: "retried result", provider: "provider", targetLanguage: "it", mode: "selection",
    });

    await coordinator._handleRetryRequest({ id: "window-1" });

    expect(mockUpdateWindow.mock.calls[1][1]).toMatchObject({
      selectedText: "restored source",
      historyIndex: 0,
      historyLength: 2,
    });
  });
});

describe("EventCoordinator provider-change error boundary", () => {
  let facade;
  let coordinator;
  let state;
  let errorHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      activeWindowId: "window-1",
      originalText: "original text",
      provider: "old-provider",
      setProvider: vi.fn((provider) => {
        state.provider = provider;
      }),
    };
    errorHandler = {};
    facade = { _startTranslationProcess: vi.fn() };
    coordinator = new EventCoordinator(facade, {
      state,
      crossFrameManager: { isTopFrame: true },
      translationHandler: {},
      errorHandler,
      clickManager: {},
      themeManager: {},
      positionCalculator: {},
    });
  });

  it.each([
    ["API_ERROR", "raw provider API detail", "safe provider API message"],
    ["MODEL_MISSING", "raw model detail", "safe model message"],
  ])("sanitizes provider-change failure for %s", async (type, rawMessage, safeMessage) => {
    const canonicalError = Object.assign(new Error(rawMessage), { type });
    facade._startTranslationProcess.mockRejectedValue(canonicalError);
    mockGetPresentation.mockResolvedValue({
      displayError: new Error(safeMessage),
      errorInfo: {
        message: safeMessage,
        type,
        canRetry: false,
        needsSettings: type === "MODEL_MISSING",
      },
      canonicalType: type,
    });

    await coordinator._handleChangeProviderRequest({
      id: "window-1",
      provider: "new-provider",
    });

    expect(mockGetPresentation).toHaveBeenCalledTimes(1);
    expect(mockGetPresentation).toHaveBeenCalledWith(
      canonicalError,
      "windows-translation-retry",
      errorHandler,
    );
    expect(state.setProvider).toHaveBeenCalledWith("new-provider");
    expect(state.provider).toBe("new-provider");
    expect(mockUpdateWindow).toHaveBeenCalledTimes(2);
    expect(mockUpdateWindow.mock.calls[1]).toEqual([
      "window-1",
      expect.objectContaining({
        isLoading: false,
        isStreaming: false,
        isError: true,
        errorType: type,
        initialTranslatedText: safeMessage,
        canRetry: false,
        needsSettings: type === "MODEL_MISSING",
        provider: "new-provider",
      }),
    ]);
    expect(mockUpdateWindow.mock.calls[1][1].initialTranslatedText).not.toContain(rawMessage);
    expect(mockShowWindow).not.toHaveBeenCalled();
  });

  it("does not emit provider-change error update when presenter excludes context failure", async () => {
    const canonicalError = new Error("extension context invalidated");
    facade._startTranslationProcess.mockRejectedValue(canonicalError);
    mockGetPresentation.mockResolvedValue(null);

    await coordinator._handleChangeProviderRequest({
      id: "window-1",
      provider: "new-provider",
    });

    expect(mockGetPresentation).toHaveBeenCalledTimes(1);
    expect(mockUpdateWindow).toHaveBeenCalledTimes(1);
    expect(mockUpdateWindow.mock.calls[0]).toEqual([
      "window-1",
      expect.objectContaining({
        isLoading: true,
        isError: false,
        initialTranslatedText: "",
        provider: "new-provider",
      }),
    ]);
    expect(state.provider).toBe("new-provider");
  });

  it("keeps successful provider-change behavior unchanged", async () => {
    facade._startTranslationProcess.mockResolvedValue({
      translatedText: "translated with new provider",
      sourceLanguage: "en",
      targetLanguage: "fa",
      provider: "new-provider",
    });

    await coordinator._handleChangeProviderRequest({
      id: "window-1",
      provider: "new-provider",
    });

    expect(mockGetPresentation).not.toHaveBeenCalled();
    expect(mockUpdateWindow).toHaveBeenCalledTimes(2);
    expect(mockUpdateWindow.mock.calls[1]).toEqual([
      "window-1",
      expect.objectContaining({
        isLoading: false,
        isStreaming: false,
        isError: false,
        initialTranslatedText: "translated with new provider",
        provider: "new-provider",
      }),
    ]);
  });
});

describe("EventCoordinator committed source", () => {
  it("keeps edited whitespace verbatim and retry uses the committed source", async () => {
    const state = {
      activeWindowId: "window-1",
      originalText: "meaningful text",
      translationHistory: [],
      historyIndex: -1,
      setOriginalText(text) { this.originalText = text; },
    };
    const facade = {
      _startTranslationProcess: vi.fn().mockResolvedValue({
        translatedText: "translated", provider: "provider", sourceLanguage: "en", targetLanguage: "fa",
      }),
    };
    const coordinator = new EventCoordinator(facade, {
      state,
      crossFrameManager: { isTopFrame: true },
      translationHandler: {},
      errorHandler: {},
      clickManager: {},
      themeManager: {},
    });

    const edited = " meaningful text\n";
    await coordinator._handleConfirmSource({ id: "window-1", text: edited });
    expect(state.originalText).toBe(edited);
    expect(facade._startTranslationProcess).toHaveBeenCalledWith(edited, "window-1");

    facade._startTranslationProcess.mockClear();
    await coordinator._handleRetryRequest({ id: "window-1", text: "stale UI text" });
    expect(facade._startTranslationProcess).toHaveBeenCalledWith(edited, "window-1");
  });

  it("ignores empty and whitespace-only source confirmations", async () => {
    const state = { activeWindowId: "window-1", originalText: "source" };
    const facade = { _startTranslationProcess: vi.fn() };
    const coordinator = new EventCoordinator(facade, {
      state, crossFrameManager: {}, translationHandler: {}, errorHandler: {}, clickManager: {}, themeManager: {},
    });
    await coordinator._handleConfirmSource({ id: "window-1", text: "  \n " });
    expect(facade._startTranslationProcess).not.toHaveBeenCalled();
  });
});
