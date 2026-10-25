import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { pageEventBus, WINDOWS_MANAGER_EVENTS, WindowsManagerEvents } from '@/core/PageEventBus.js';
import { useWindowsManager } from '../composables/useWindowsManager.js';
import { EventCoordinator } from '../managers/events/EventCoordinator.js';
import TranslationIcon from './TranslationIcon.vue';
import { usePositioning } from '@/composables/ui/usePositioning.js';

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/composables/ui/usePositioning.js', () => ({
  usePositioning: vi.fn((position) => ({
    positionStyle: ref({ left: `${position.x}px`, top: `${position.y}px` }),
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
  useTTSSmart: () => ({
    ttsState: ref('idle'), lastText: ref(''), currentTTSId: ref(null), detectedLanguage: ref(null),
    errorMessage: ref(''), speak: vi.fn().mockResolvedValue(true), stop: vi.fn().mockResolvedValue(true),
  }),
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
      const icon = manager.translationIcons.value[0];
      const Harness = defineComponent({
        render: () => h(TranslationIcon, {
          id: icon.id,
          text: icon.text,
          position: icon.position,
          selectionPosition: icon.selectionPosition,
          onClick: manager.onTranslationIconClick,
        }),
      });
      const wrapper = mount(Harness);
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

  it('falls back to the displayed position for icons without a selection position', async () => {
    const { toolbarPosition, facade, mountIcon } = setupFlow();

    WindowsManagerEvents.showIcon({ id: 'icon-keyboard', text: 'selected', position: toolbarPosition });
    expect(manager.translationIcons.value[0].selectionPosition).toEqual(toolbarPosition);

    const wrapper = await mountIcon();
    await wrapper.get('button').trigger('click');
    await Promise.resolve();

    expect(facade.displayManager._showWindow).toHaveBeenCalledWith('selected', toolbarPosition);
  });
});
