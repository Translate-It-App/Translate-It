import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { pageEventBus, WINDOWS_MANAGER_EVENTS, WindowsManagerEvents } from '@/core/PageEventBus.js';
import { useWindowsManager } from '../composables/useWindowsManager.js';
import { EventCoordinator } from '../managers/events/EventCoordinator.js';
import TranslationIcon from './TranslationIcon.vue';
import { usePositioning } from '@/composables/ui/usePositioning.js';
import { ClickManager } from '../managers/interaction/ClickManager.js';
import { SimpleTextSelectionHandler } from '@/features/text-selection/handlers/SimpleTextSelectionHandler.js';
import { WindowsConfig } from '@/features/windows/managers/core/WindowsConfig.js';

const testMocks = vi.hoisted(() => ({
  initializePosition: vi.fn(),
  speak: vi.fn().mockResolvedValue(true),
  stop: vi.fn().mockResolvedValue(true),
  tts: null,
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/composables/ui/usePositioning.js', () => ({
  usePositioning: vi.fn((position) => ({
    positionStyle: ref({ left: `${position.x}px`, top: `${position.y}px` }),
    initializePosition: testMocks.initializePosition,
    cleanup: vi.fn(),
  })),
}));

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (key) => key }),
}));

vi.mock('@/store/modules/mobile.js', () => ({
  useMobileStore: () => ({ isFullscreen: false }),
}));

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => ({
    settings: { SHOW_TTS_ICON_IN_TOOLBAR: true, SHOW_TRANSLATE_ICON_IN_TOOLBAR: true },
    isDarkTheme: false,
  }),
}));

vi.mock('@/features/tts/composables/useTTSSmart.js', () => ({
  useTTSSmart: () => {
    if (!testMocks.tts) testMocks.tts = {
      ttsState: ref('idle'), lastText: ref(''), currentTTSId: ref(null), detectedLanguage: ref(null),
      errorMessage: ref(''), speak: testMocks.speak, stop: testMocks.stop,
    };
    return testMocks.tts;
  },
}));

vi.mock('@/composables/core/useResourceTracker.js', () => ({
  useResourceTracker: () => ({
    trackResource: vi.fn(), trackTimeout: vi.fn(), addEventListener: vi.fn(),
  }),
}));

vi.mock('@/utils/ui/styleInjector.js', () => ({ injectStylesToShadowRoot: vi.fn() }));

describe('TranslationIcon selection-position event flow', () => {
  const wrappers = [];
  let manager;
  let coordinator;
  let iconClickListener;
  let originalWindowsManagerInstance;

  const createHarness = () => defineComponent({
    setup() {
      return () => h('div', manager.translationIcons.value.map((icon) => h(TranslationIcon, {
        key: icon.id,
        id: icon.id,
        text: icon.text,
        position: icon.position,
        selectionPosition: icon.selectionPosition,
        onClick: manager.onTranslationIconClick,
      })));
    },
  });

  afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    if (iconClickListener) pageEventBus.off(WINDOWS_MANAGER_EVENTS.ICON_CLICKED, iconClickListener);
    manager?.cleanupEventListeners();
    coordinator?.cleanup();
    manager = null;
    coordinator = null;
    iconClickListener = null;
    window.pageEventBus = undefined;
    if (originalWindowsManagerInstance === undefined) delete window.windowsManagerInstance;
    else window.windowsManagerInstance = originalWindowsManagerInstance;
    originalWindowsManagerInstance = undefined;
    vi.clearAllTimers();
    testMocks.initializePosition.mockClear();
    testMocks.speak.mockClear();
    testMocks.stop.mockClear();
    if (testMocks.tts) {
      testMocks.tts.ttsState.value = 'idle';
      testMocks.tts.lastText.value = '';
      testMocks.tts.currentTTSId.value = null;
    }
    delete window.__translateItPendingSelectionContinuationToken;
    delete window.__translateItClickContinuationRelayToken;
    vi.useRealTimers();
  });

  function setupFlow() {
    vi.useFakeTimers();
    originalWindowsManagerInstance = window.windowsManagerInstance;
    window.pageEventBus = pageEventBus;
    manager = useWindowsManager();
    manager.setupEventListeners();

    const selectionPosition = { x: 12, y: 24, _isViewportRelative: false };
    const toolbarPosition = { x: 80, y: 100, _isViewportRelative: false };
    const state = {
      isProcessing: false,
      setProcessing: vi.fn(),
      setPendingTranslationWindow: vi.fn(),
    };
    const facade = {
      _isIconToWindowTransition: false,
      _lastProcessedClick: null,
      state,
      dismissalManager: { _removeDismissListener: vi.fn() },
      displayManager: { _showWindow: vi.fn().mockResolvedValue(undefined) },
    };
    coordinator = new EventCoordinator(facade, {
      state,
      crossFrameManager: {},
      translationHandler: {},
      errorHandler: {},
      clickManager: { completeIconTransition: vi.fn() },
      themeManager: {},
    });
    iconClickListener = (detail) => coordinator._handleIconClickFromVue(detail);
    pageEventBus.on(WINDOWS_MANAGER_EVENTS.ICON_CLICKED, iconClickListener);

    const mountIcon = async () => {
      const wrapper = mount(createHarness());
      wrappers.push(wrapper);
      wrapper.findComponent(TranslationIcon).vm.animateIn();
      await flushPromises();
      await nextTick();
      return wrapper;
    };

    return { selectionPosition, toolbarPosition, facade, mountIcon };
  }

  it('carries the matching icon selection position from display event through Translate to the window', async () => {
    const { selectionPosition, toolbarPosition, facade, mountIcon } = setupFlow();

    WindowsManagerEvents.showIcon({ id: 'icon-cursor', text: 'selected', position: toolbarPosition, selectionPosition });
    const icon = manager.translationIcons.value[0];
    expect(icon).toMatchObject({ position: toolbarPosition, selectionPosition });

    const wrapper = await mountIcon();
    expect(usePositioning).toHaveBeenCalledWith(toolbarPosition, expect.any(Object));
    await wrapper.get('button').trigger('click');
    await Promise.resolve();

    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('selected', selectionPosition);
  });

  it.each(['Enter', ' '])('uses the selection position for Translate activated with %s', async (key) => {
    const { selectionPosition, toolbarPosition, facade, mountIcon } = setupFlow();

    WindowsManagerEvents.showIcon({ id: 'icon-keyboard', text: 'selected', position: toolbarPosition, selectionPosition });
    const wrapper = await mountIcon();
    await wrapper.get('.ti-icon-btn--translate').trigger('keydown', { key });
    await Promise.resolve();

    expect(usePositioning).toHaveBeenCalledWith(toolbarPosition, expect.any(Object));
    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('selected', selectionPosition);
  });

  it('uses the rendered toolbar bounds for pointer Translate activation', async () => {
    const { selectionPosition, toolbarPosition, facade, mountIcon } = setupFlow();
    WindowsManagerEvents.showIcon({ id: 'icon-pointer', text: 'selected', position: toolbarPosition, selectionPosition });
    const wrapper = await mountIcon();
    vi.spyOn(wrapper.findComponent(TranslationIcon).element, 'getBoundingClientRect').mockReturnValue({
      left: 120, right: 200, top: 40, bottom: 72, width: 80, height: 32,
    });

    const click = new MouseEvent('click', { bubbles: true, detail: 1 });
    wrapper.get('.ti-icon-btn--translate').element.dispatchEvent(click);
    await Promise.resolve();

    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('selected', expect.objectContaining({
      x: 160, y: 80, _isViewportRelative: true,
      _toolbarRect: expect.objectContaining({ left: 120, bottom: 72 }),
    }));
  });

  it.each([
    ['zero width', { left: 120, right: 120, top: 40, bottom: 72, width: 0, height: 32 }],
    ['zero height', { left: 120, right: 200, top: 40, bottom: 40, width: 80, height: 0 }],
    ['NaN coordinate', { left: Number.NaN, right: 200, top: 40, bottom: 72, width: 80, height: 32 }],
    ['infinite dimension', { left: 120, right: 200, top: 40, bottom: 72, width: 80, height: Number.POSITIVE_INFINITY }],
    ['missing coordinate', { left: 120, right: 200, top: 40, width: 80, height: 32 }],
  ])('uses the semantic selection anchor for a pointer click with %s toolbar bounds', async (_label, rect) => {
    const { selectionPosition, toolbarPosition, facade, mountIcon } = setupFlow();
    WindowsManagerEvents.showIcon({ id: 'icon-invalid-rect', text: 'selected', position: toolbarPosition, selectionPosition });
    const wrapper = await mountIcon();
    vi.spyOn(wrapper.findComponent(TranslationIcon).element, 'getBoundingClientRect').mockReturnValue(rect);

    wrapper.get('.ti-icon-btn--translate').element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await Promise.resolve();

    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('selected', selectionPosition);
  });

  it('uses semantic selection after a canceled pointer interaction and a detail-zero click', async () => {
    const { selectionPosition, toolbarPosition, facade, mountIcon } = setupFlow();
    WindowsManagerEvents.showIcon({ id: 'icon-canceled-pointer', text: 'selected', position: toolbarPosition, selectionPosition });
    const wrapper = await mountIcon();
    vi.spyOn(wrapper.findComponent(TranslationIcon).element, 'getBoundingClientRect').mockReturnValue({
      left: 120, right: 200, top: 40, bottom: 72, width: 80, height: 32,
    });

    const button = wrapper.get('.ti-icon-btn--translate').element;
    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    pointerDown.preventDefault();
    button.dispatchEvent(pointerDown);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    await Promise.resolve();

    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('selected', selectionPosition);
  });

  it('uses the rendered toolbar bounds when no original toolbar position exists', async () => {
    const { selectionPosition, facade, mountIcon } = setupFlow();
    WindowsManagerEvents.showIcon({
      id: 'icon-no-toolbar-position', text: 'selected', position: selectionPosition, selectionPosition,
    });
    const wrapper = await mountIcon();
    vi.spyOn(wrapper.findComponent(TranslationIcon).element, 'getBoundingClientRect').mockReturnValue({
      left: 120, right: 200, top: 40, bottom: 72, width: 80, height: 32,
    });

    wrapper.get('.ti-icon-btn--translate').element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await Promise.resolve();

    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('selected', expect.objectContaining({
      x: 160, y: 80, _isViewportRelative: true,
    }));
  });

  it('falls back to the displayed position for icons without a selection position', async () => {
    const { toolbarPosition, facade, mountIcon } = setupFlow();

    WindowsManagerEvents.showIcon({ id: 'icon-keyboard', text: 'selected', position: toolbarPosition });
    expect(manager.translationIcons.value[0].selectionPosition).toEqual(toolbarPosition);

    const wrapper = await mountIcon();
    await wrapper.get('button').trigger('click');
    await Promise.resolve();

    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('selected', toolbarPosition);
  });

  it('uses a safe viewport position for keyboard activation without a selection anchor', async () => {
    const { facade, mountIcon } = setupFlow();
    const fragmentPoint = { x: 34, y: 56, _isViewportRelative: false };

    WindowsManagerEvents.showIcon({
      id: 'icon-fragment-only', text: 'full selected text', position: fragmentPoint,
      selectionPosition: null,
    });
    expect(manager.translationIcons.value[0]).toMatchObject({
      text: 'full selected text', position: fragmentPoint, selectionPosition: null,
    });

    const wrapper = await mountIcon();
    expect(usePositioning).toHaveBeenCalledWith(fragmentPoint, expect.any(Object));
    await wrapper.get('.ti-icon-btn--translate').trigger('keydown', { key: 'Enter' });
    await Promise.resolve();

    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('full selected text', {
      x: Math.max(WindowsConfig.POSITIONING.VIEWPORT_MARGIN,
        (window.innerWidth - WindowsConfig.POSITIONING.POPUP_WIDTH) / 2),
      y: Math.max(WindowsConfig.POSITIONING.VIEWPORT_MARGIN,
        (window.innerHeight - WindowsConfig.POSITIONING.POPUP_HEIGHT) / 2),
      _isViewportRelative: true,
    });
    expect(facade.displayManager._showWindow).not.toHaveBeenCalledWith('full selected text', fragmentPoint);
  });

  it('uses the rendered toolbar bounds for pointer activation with an explicit null anchor', async () => {
    const { facade, mountIcon } = setupFlow();
    const fragmentPoint = { x: 34, y: 56, _isViewportRelative: false };
    WindowsManagerEvents.showIcon({
      id: 'icon-pointer-null-anchor', text: 'selected', position: fragmentPoint,
      selectionPosition: null,
    });
    const wrapper = await mountIcon();
    vi.spyOn(wrapper.findComponent(TranslationIcon).element, 'getBoundingClientRect').mockReturnValue({
      left: 120, right: 200, top: 40, bottom: 72, width: 80, height: 32,
    });

    wrapper.get('.ti-icon-btn--translate').element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1 }),
    );
    await Promise.resolve();

    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('selected', expect.objectContaining({
      x: 160, y: 80, _isViewportRelative: true,
      _toolbarRect: expect.objectContaining({ left: 120, bottom: 72 }),
    }));
    expect(facade.displayManager._showWindow).not.toHaveBeenCalledWith('selected', fragmentPoint);
  });

  it('uses a safe viewport position for pointer activation when toolbar bounds are invalid', async () => {
    const { facade, mountIcon } = setupFlow();
    const fragmentPoint = { x: 34, y: 56, _isViewportRelative: false };
    WindowsManagerEvents.showIcon({
      id: 'icon-pointer-invalid-bounds', text: 'full selected text', position: fragmentPoint,
      selectionPosition: null,
    });
    const wrapper = await mountIcon();
    vi.spyOn(wrapper.findComponent(TranslationIcon).element, 'getBoundingClientRect').mockReturnValue({
      left: 120, right: 120, top: 40, bottom: 72, width: 0, height: 32,
    });

    wrapper.get('.ti-icon-btn--translate').element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1 }),
    );
    await Promise.resolve();

    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('full selected text', {
      x: Math.max(WindowsConfig.POSITIONING.VIEWPORT_MARGIN,
        (window.innerWidth - WindowsConfig.POSITIONING.POPUP_WIDTH) / 2),
      y: Math.max(WindowsConfig.POSITIONING.VIEWPORT_MARGIN,
        (window.innerHeight - WindowsConfig.POSITIONING.POPUP_HEIGHT) / 2),
      _isViewportRelative: true,
    });
    expect(facade.displayManager._showWindow).not.toHaveBeenCalledWith('full selected text', fragmentPoint);
  });

  it('keeps the mounted Toolbar through a verified third-click continuation and dismisses on the next outside click', async () => {
    vi.useFakeTimers();
    window.pageEventBus = pageEventBus;
    manager = useWindowsManager();
    manager.setupEventListeners();
    const token = { originFrameId: 'source-frame', sequence: 17 };
    const firstCursor = { x: 20, y: 30 };
    const selectionPosition = { x: 11, y: 22 };
    const state = {
      isIconMode: true,
      selectionContinuationToken: token,
      hasActiveElements: true,
      isPinned: false,
      shouldPreventDismissal: false,
      activeWindowId: 'toolbar-window',
      isInitialLoadingWindow: vi.fn(() => false),
    };
    const outsideDismiss = vi.fn();
    const crossFrame = {
      frameId: 'top-frame', isTopFrame: true,
      enableGlobalClickBroadcast: vi.fn(), disableGlobalClickBroadcast: vi.fn(),
      requestGlobalClickRelay: vi.fn(),
    };
    const clickManager = new ClickManager(crossFrame, state);
    clickManager.setHandlers({ onOutsideClick: outsideDismiss, onIconClick: vi.fn() });
    clickManager.addOutsideClickListener();

    WindowsManagerEvents.showIcon({
      id: 'stable-toolbar', text: 'word', position: firstCursor,
      selectionPosition, selectionContinuationToken: token,
    });
    const wrapper = mount(createHarness());
    wrappers.push(wrapper);
    await flushPromises();
    await nextTick();
    const firstComponent = wrapper.findComponent(TranslationIcon);
    firstComponent.vm.animateIn();
    await nextTick();
    const originalDom = firstComponent.element;

    testMocks.tts.currentTTSId.value = 'tts-word';
    await firstComponent.findAll('.ti-icon-btn')[1].trigger('click');
    await flushPromises();
    testMocks.tts.ttsState.value = 'playing';

    const paragraph = document.createElement('p');
    const span = document.createElement('span');
    const selectedNode = document.createTextNode('word then rest');
    span.append(selectedNode);
    paragraph.append(span);
    document.body.append(paragraph);
    const wordRange = document.createRange();
    wordRange.setStart(selectedNode, 0);
    wordRange.setEnd(selectedNode, 4);
    const paragraphRange = document.createRange();
    paragraphRange.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(wordRange);
    window.iframeClickManager = { crossFrameManager: { frameId: token.originFrameId } };
    vi.spyOn(window, 'top', 'get').mockReturnValue(window);
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(0);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(0);
    const selectionHandler = new SimpleTextSelectionHandler();
    selectionHandler._lastSelectionRange = wordRange.cloneRange();
    selectionHandler._lastSelectionTarget = span;
    selectionHandler._activeSelectionToken = token;
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 3 });
    Object.defineProperty(mouseDown, 'target', { value: paragraph });
    selectionHandler.handleMouseDown(mouseDown);
    selection.removeAllRanges();
    selection.addRange(paragraphRange);
    const mouseUp = new MouseEvent('mouseup', {
      bubbles: true, button: 0, detail: 3, clientX: 70, clientY: 70,
    });
    Object.defineProperty(mouseUp, 'target', { value: paragraph });
    selectionHandler.handleMouseUp(mouseUp);
    expect(selectionHandler._toolbarReleaseCandidate).toMatchObject({ interactionId: 1, x: 70, y: 70 });
    paragraph.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 3, button: 0 }));
    expect(selectionHandler._selectionContinuationToken).toEqual(token);
    expect(window.__translateItPendingSelectionContinuationToken).toBeNull();
    expect(outsideDismiss).not.toHaveBeenCalled();
    expect(selectionHandler._consumeToolbarReleasePosition(
      'word then rest', selectionHandler._selectionContinuationToken,
    )).toEqual({
      x: 70, y: 80, _isViewportRelative: false,
    });

    const positioningCallsBeforeContinuation = testMocks.initializePosition.mock.calls.length;
    WindowsManagerEvents.showIcon({
      id: 'stable-toolbar', text: 'full paragraph',
      selectionPosition: { x: 55, y: 66 }, selectionContinuationToken: token,
    });
    await nextTick();

    const updatedComponent = wrapper.findComponent(TranslationIcon);
    expect(updatedComponent.vm.$).toBe(firstComponent.vm.$);
    expect(updatedComponent.element).toBe(originalDom);
    expect(updatedComponent.props('text')).toBe('full paragraph');
    expect(manager.translationIcons.value[0]).toMatchObject({
      id: 'stable-toolbar', text: 'full paragraph', position: firstCursor,
      selectionPosition: { x: 55, y: 66 },
    });
    expect(testMocks.initializePosition).toHaveBeenCalledTimes(positioningCallsBeforeContinuation);
    expect(testMocks.stop).toHaveBeenCalled();

    const positioningCalls = testMocks.initializePosition.mock.calls.length;
    WindowsManagerEvents.showIcon({
      id: 'stable-toolbar', text: 'full paragraph', selectionPosition: { x: 55, y: 66 },
      selectionContinuationToken: token,
    });
    await nextTick();
    expect(manager.translationIcons.value[0].position).toEqual(firstCursor);
    expect(testMocks.initializePosition).toHaveBeenCalledTimes(positioningCalls);

    const translateDetails = [];
    const captureTranslate = (detail) => translateDetails.push(detail);
    pageEventBus.on(WINDOWS_MANAGER_EVENTS.ICON_CLICKED, captureTranslate);
    await updatedComponent.find('.ti-icon-btn--translate').trigger('click');
    expect(translateDetails.at(-1)).toMatchObject({
      id: 'stable-toolbar', text: 'full paragraph', position: { x: 55, y: 66 },
    });

    vi.spyOn(updatedComponent.element, 'getBoundingClientRect').mockReturnValue({
      left: 120, right: 200, top: 40, bottom: 72, width: 80, height: 32,
    });
    updatedComponent.find('.ti-icon-btn--translate').element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1 }),
    );
    await Promise.resolve();
    expect(translateDetails.at(-1)).toMatchObject({
      id: 'stable-toolbar', text: 'full paragraph', position: expect.objectContaining({
      x: 160, y: 80, _isViewportRelative: true,
      }),
    });

    const pointerPosition = translateDetails.at(-1).position;
    await updatedComponent.find('.ti-icon-btn--translate').trigger('keydown', { key: 'Enter' });
    await Promise.resolve();
    expect(translateDetails.at(-1)).toMatchObject({
      id: 'stable-toolbar', text: 'full paragraph', position: { x: 55, y: 66 },
    });
    expect(translateDetails.at(-1).position).not.toEqual(pointerPosition);
    pageEventBus.off(WINDOWS_MANAGER_EVENTS.ICON_CLICKED, captureTranslate);

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, button: 0 }));
    expect(outsideDismiss).toHaveBeenCalledTimes(1);

    clickManager.cleanup();
    selectionHandler._clearAllTimers();
    selectionHandler.destroy();
    paragraph.remove();
    delete window.iframeClickManager;
  });

  it('stops loading TTS on text replacement and ignores the old speak result', async () => {
    const { toolbarPosition, mountIcon } = setupFlow();
    let resolveSpeak;
    WindowsManagerEvents.showIcon({ id: 'pending-tts', text: 'old word', position: toolbarPosition });
    const wrapper = await mountIcon();
    const icon = wrapper.findComponent(TranslationIcon);
    testMocks.tts.ttsState.value = 'idle';
    testMocks.tts.currentTTSId.value = null;
    testMocks.speak.mockImplementationOnce(() => {
      testMocks.tts.ttsState.value = 'loading';
      return new Promise((resolve) => { resolveSpeak = resolve; });
    });
    testMocks.stop.mockImplementation(async () => {
      testMocks.tts.ttsState.value = 'idle';
      testMocks.tts.currentTTSId.value = null;
      return true;
    });
    await icon.findAll('.ti-icon-btn')[1].trigger('click');
    expect(testMocks.speak).toHaveBeenCalledWith('old word', 'auto');

    WindowsManagerEvents.showIcon({ id: 'pending-tts', text: 'new paragraph', position: { x: 40, y: 50 } });
    await nextTick();
    await flushPromises();
    expect(testMocks.stop).toHaveBeenCalled();

    testMocks.tts.currentTTSId.value = 'stale-tts-id';
    testMocks.tts.ttsState.value = 'playing';
    resolveSpeak(true);
    await flushPromises();

    expect(icon.props('text')).toBe('new paragraph');
    expect(icon.find('.ti-icon-btn--playing').exists()).toBe(false);
  });

  it('mounts one Toolbar at the owning mouse release position while restore invalidation is pending', async () => {
    const { mountIcon, selectionPosition } = setupFlow();
    let resolveInvalidation;
    const invalidationResult = new Promise((resolve) => { resolveInvalidation = resolve; });
    const textNode = document.createTextNode('same selection');
    const target = document.createElement('span');
    target.append(textNode);
    document.body.append(target);
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = {
      anchorNode: textNode,
      rangeCount: 1,
      toString: () => 'same selection',
      getRangeAt: () => range,
    };
    const processSelection = vi.fn(async (_text, _selection, options) => {
      if (options.pendingDisplayRestore) {
        WindowsManagerEvents.dismissIcon('pending-toolbar');
        WindowsManagerEvents.showIcon({
          id: 'restored-toolbar',
          text: 'same selection',
          position: options.toolbarPosition,
          selectionPosition,
        });
        return true;
      }
      return false;
    });
    const handler = new SimpleTextSelectionHandler();
    handler.isActive = true;
    handler.selectionManager = { processSelection };
    handler._lastSelectionRange = range.cloneRange();
    handler._lastSelectionText = 'same selection';
    handler._lastSelectionTarget = target;
    vi.spyOn(window, 'getSelection').mockReturnValue(selection);
    vi.spyOn(handler, 'getWindowsManager').mockReturnValue({
      invalidatePendingShows: vi.fn(() => invalidationResult),
    });
    vi.spyOn(handler, 'isSelectElementModeActive').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInTextField').mockReturnValue(false);
    vi.spyOn(handler, 'isSelectionInsideUI').mockReturnValue(false);
    vi.spyOn(handler, '_detectSelectionType').mockReturnValue('default');
    vi.spyOn(handler, '_startSelectionPreservation').mockImplementation(() => {});

    WindowsManagerEvents.showIcon({
      id: 'pending-toolbar',
      text: 'same selection',
      position: { x: 3, y: 4 },
      selectionPosition,
    });
    const wrapper = await mountIcon();
    try {
      handler.handleMouseDown({
        button: 0, shiftKey: false, ctrlKey: false, metaKey: false,
        isTrusted: true, composedPath: () => [],
      });
      const mouseUp = new MouseEvent('mouseup', { button: 0, clientX: 25, clientY: 35 });
      Object.defineProperty(mouseUp, 'target', { value: target });
      handler.handleMouseUp(mouseUp);
      const owner = handler.processSelection();

      expect(handler._toolbarReleaseCandidate).not.toBeNull();
      await handler.processSelection();
      expect(processSelection).not.toHaveBeenCalled();
      expect(handler._toolbarReleaseCandidate).not.toBeNull();

      resolveInvalidation({
        valid: true, cancelledPendingDisplay: true, canRestore: true, requestVersion: 31,
      });
      await owner;
      await nextTick();
      await flushPromises();

      expect(processSelection).toHaveBeenCalledTimes(1);
      expect(processSelection.mock.calls[0][2]).toMatchObject({
        pendingDisplayRestore: { canRestore: true, requestVersion: 31 },
        toolbarPosition: { x: 25, y: 45, _isViewportRelative: false },
      });
      expect(manager.translationIcons.value).toHaveLength(1);
      expect(manager.translationIcons.value[0]).toMatchObject({
        id: 'restored-toolbar',
        position: { x: 25, y: 45, _isViewportRelative: false },
        selectionPosition,
      });
      expect(wrapper.findAllComponents(TranslationIcon)).toHaveLength(1);
      expect(usePositioning).toHaveBeenCalledWith(
        { x: 25, y: 45, _isViewportRelative: false },
        expect.any(Object),
      );
    } finally {
      handler._clearAllTimers();
      handler.destroy();
      target.remove();
    }
  });
});
