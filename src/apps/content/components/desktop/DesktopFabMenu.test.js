import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount as vueMount } from '@vue/test-utils';
import { onBeforeUnmount, reactive, ref } from 'vue';
import DesktopFabMenu from './DesktopFabMenu.vue';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import enMessages from '@/_locales/en/messages.json';
import faMessages from '@/_locales/fa/messages.json';
import jaMessages from '@/_locales/ja/messages.json';

const mocks = vi.hoisted(() => {
  // The tracker is a no-op for page listeners, but the drag engine needs its
  // window listeners to actually fire, so route only drag events through.
  const dragEvents = new Set(['mousemove', 'mouseup', 'touchmove', 'touchend']);
  return {
    mobileStore: null,
    settingsStore: null,
    effectiveProvider: 'google',
    pageEventBus: {
      emit: vi.fn(),
      subscriptions: new Set(),
      on: vi.fn((event, handler) => {
        const subscription = { event, handler };
        mocks.pageEventBus.subscriptions.add(subscription);
        subscription.cleanup = vi.fn(() => mocks.pageEventBus.subscriptions.delete(subscription));
        return subscription.cleanup;
      }),
    },
    sendMessage: vi.fn(),
    sendRegularMessage: vi.fn(),
    tracker: {
      timers: new Set(),
      resourceCleanups: new Set(),
      resourceIds: new Map(),
      groups: new Map(),
      cleanedResourceIds: [],
      cleanedGroups: [],
      clearTimer: vi.fn((timerId) => {
        clearTimeout(timerId);
        mocks.tracker.timers.delete(timerId);
      }),
      trackTimeout: vi.fn((callback, delay) => {
        const id = setTimeout(() => {
          mocks.tracker.timers.delete(id);
          callback();
        }, delay);
        mocks.tracker.timers.add(id);
        return id;
      }),
      trackResource: vi.fn((id, cleanup) => {
        if (mocks.tracker.resourceIds.has(id)) {
          throw new Error(`Resource ID already registered: ${id}`);
        }
        mocks.tracker.resourceIds.set(id, cleanup);
        mocks.tracker.resourceCleanups.add(cleanup);
      }),
      cleanupGroup: vi.fn((groupId) => {
        const group = mocks.tracker.groups.get(groupId);
        if (!group) return;
        mocks.tracker.cleanedGroups.push(groupId);
        group.timers.forEach((id) => {
          clearTimeout(id);
          mocks.tracker.timers.delete(id);
        });
        group.resourceCleanups.forEach((cleanup, id) => {
          mocks.tracker.cleanedResourceIds.push(id);
          cleanup();
          mocks.tracker.resourceCleanups.delete(cleanup);
          mocks.tracker.resourceIds.delete(id);
        });
        mocks.tracker.groups.delete(groupId);
      }),
      cleanup: vi.fn(() => {
        [...mocks.tracker.groups.keys()].forEach((groupId) => {
          mocks.tracker.cleanupGroup(groupId);
        });
        mocks.tracker.timers.forEach((id) => clearTimeout(id));
        mocks.tracker.timers.clear();
        mocks.tracker.resourceCleanups.forEach((cleanup) => cleanup());
        mocks.tracker.resourceCleanups.clear();
      }),
      addEventListener: vi.fn((target, type, handler) => {
        if (dragEvents.has(type)) target.addEventListener(type, handler);
      }),
      removeEventListener: vi.fn((target, type, handler) => {
        if (dragEvents.has(type)) target.removeEventListener(type, handler);
      }),
    },
    autoRules: null,
    mouseHoverEnabled: null,
    translations: {},
    handleError: vi.fn(),
    supportedHideScopes: new Set(['page', 'site']),
    exclusionKey: vi.fn(),
    addExclusion: vi.fn(),
    ttsStop: vi.fn().mockResolvedValue(undefined),
    storageManager: { set: vi.fn() },
    getPosition: vi.fn().mockResolvedValue({ y: 100, side: 'right' }),
  };
});

const mountedWrappers = new Set();
const mount = (...args) => {
  const wrapper = vueMount(...args);
  mountedWrappers.add(wrapper);
  return wrapper;
};

afterEach(() => {
  mountedWrappers.forEach((wrapper) => {
    if (!wrapper.vm.$.isUnmounted) wrapper.unmount();
  });
  mountedWrappers.clear();
  mocks.tracker.cleanup();
});

vi.mock('@/store/modules/mobile.js', () => ({
  useMobileStore: () => mocks.mobileStore,
}));

vi.mock('@/features/settings/stores/settings.js', () => ({
  default: () => mocks.settingsStore,
}));

vi.mock('@/composables/shared/useUnifiedI18n', () => ({
  useUnifiedI18n: () => ({ t: (key) => mocks.translations[key] ?? key }),
}));

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendMessage: mocks.sendMessage,
  sendRegularMessage: mocks.sendRegularMessage,
}));

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: mocks.pageEventBus,
  WINDOWS_MANAGER_EVENTS: {},
}));

vi.mock('@/composables/core/useResourceTracker', () => ({
  useResourceTracker: (groupId) => {
    let group = mocks.tracker.groups.get(groupId);
    if (!group) {
      group = { timers: new Set(), resourceCleanups: new Map() };
      mocks.tracker.groups.set(groupId, group);
    }
    onBeforeUnmount(() => mocks.tracker.cleanupGroup(groupId));
    return {
      ...mocks.tracker,
      trackTimeout: (callback, delay) => {
        const id = mocks.tracker.trackTimeout(callback, delay);
        group.timers.add(id);
        return id;
      },
      clearTimer: (id) => {
        mocks.tracker.clearTimer(id);
        group.timers.delete(id);
      },
      trackResource: (id, cleanup) => {
        mocks.tracker.trackResource(id, cleanup);
        group.resourceCleanups.set(id, cleanup);
      },
    };
  },
}));

vi.mock('@/features/tts/composables/useTTSSmart.js', () => ({
  useTTSSmart: () => ({
    lastText: { value: '' },
    detectedLanguage: { value: 'auto' },
    currentTTSId: { value: null },
    ttsState: { value: 'idle' },
    isPlaying: { value: false },
    isLoading: { value: false },
    stop: mocks.ttsStop,
    speak: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/features/mouse-hover/composables/useMouseHoverToggle.js', () => ({
  useMouseHoverToggle: () => ({
    isMouseHoverEnabled: mocks.mouseHoverEnabled,
    toggleMouseHover: vi.fn(),
  }),
}));

vi.mock('@/apps/content/composables/useFabSelection.js', () => ({
  default: () => ({
    pendingSelection: { value: { hasSelection: false, mode: null, text: '' } },
    triggerTranslation: vi.fn(),
  }),
}));

vi.mock('@/features/page-translation/composables/useAutoTranslateRules.js', () => ({
  useAutoTranslateRules: () => mocks.autoRules,
}));

vi.mock('@/features/exclusion/core/ExclusionChecker.js', () => ({
  default: {
    getInstance: () => ({
      getFeatureStatus: vi.fn().mockResolvedValue({
        initialized: true,
        features: {
          pageTranslation: { allowed: true },
          selectElement: { allowed: true },
          screenCapture: { allowed: true },
        },
      }),
    }),
  },
}));

vi.mock('@/shared/config/config.js', () => ({
  TranslationMode: { Page: 'page', Select_Element: 'select-element' },
  SelectionTranslationMode: { ON_FAB_CLICK: 'on-fab-click' },
  getDesktopFabPositionAsync: (...args) => mocks.getPosition(...args),
}));

vi.mock('@/features/translation/providers/ProviderManifest.js', () => ({
  findProviderById: (id) => ({ features: id === 'vajehyab' ? ['dictionary'] : ['bulk'] }),
}));

vi.mock('@/utils/browser/compatibility.js', () => ({
  deviceDetector: { isMobile: () => false },
}));

vi.mock('@/shared/config/languageConstants.js', () => ({
  getLanguageNameFromCode: () => 'English',
}));

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: mocks.storageManager,
}));

vi.mock('@/utils/ui/styleInjector.js', () => ({
  injectStylesToShadowRoot: vi.fn(),
}));

vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: () => ({ handleError: mocks.handleError }),
}));

vi.mock('@/features/desktop-fab/desktopFabExclusions.js', () => ({
  DESKTOP_FAB_EXCLUSION_PREFIX: 'desktop-fab-exclusion:v1:',
  getDesktopFabExclusionKey: (scope, url) => mocks.exclusionKey(scope, url),
  addDesktopFabExclusion: (scope, url) => mocks.addExclusion(scope, url),
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: vi.fn(() => false),
    handleContextError: vi.fn(),
  },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/** Shared component/store/transport state for every DesktopFabMenu mount. */
const setupBaseMocks = () => {
  mocks.effectiveProvider = 'google';
  vi.clearAllMocks();
  mocks.tracker.timers.forEach((id) => clearTimeout(id));
  mocks.tracker.timers.clear();
  mocks.tracker.resourceCleanups.forEach((cleanup) => cleanup());
  mocks.tracker.resourceCleanups.clear();
  mocks.tracker.resourceIds.clear();
  mocks.tracker.groups.clear();
  mocks.pageEventBus.subscriptions.clear();
  mocks.tracker.cleanedResourceIds.length = 0;
  mocks.tracker.cleanedGroups.length = 0;
  mocks.sendRegularMessage.mockResolvedValue({ success: true });
  mocks.translations = {};
  mocks.mouseHoverEnabled = ref(false);
  mocks.handleError = vi.fn();
  mocks.mobileStore = reactive({
    hasElementTranslations: false,
    isFullscreen: false,
    pageTranslationData: {
      status: 'idle',
      isTranslating: false,
      isAutoTranslating: false,
      isTranslated: false,
      translatedCount: 0,
      failedCount: 0,
      totalCount: 0,
    },
  });
  mocks.settingsStore = reactive({
    isDarkTheme: false,
    settings: {
      FAB_IDLE_OPACITY: 20,
      FAB_SIZE: '1',
      TRANSLATE_ON_TEXT_SELECTION: true,
      SHOW_MOUSE_HOVER_IN_FAB: false,
      SHOW_DESKTOP_FAB: true,
      selectionTranslationMode: 'immediate',
    },
    getEffectiveProvider: () => mocks.effectiveProvider,
    updateSettingLocally: vi.fn(),
  });
  mocks.supportedHideScopes = new Set(['page', 'site']);
  mocks.exclusionKey = vi.fn((scope) =>
    mocks.supportedHideScopes.has(scope) ? `desktop-fab-exclusion:v1:${scope}:key` : '');
  mocks.addExclusion = vi.fn(async (scope) =>
    mocks.supportedHideScopes.has(scope) ? `desktop-fab-exclusion:v1:${scope}:key` : '');
  mocks.storageManager.set.mockReset();
  mocks.ttsStop.mockReset().mockResolvedValue(undefined);
  mocks.getPosition.mockReset().mockResolvedValue({ y: 100, side: 'right' });
};

describe('DesktopFabMenu page command transport', () => {
  beforeEach(() => {
    setupBaseMocks();
    mocks.autoRules = {
      isAutoTranslateToggleVisible: ref(true), isActive: ref(false),
      hasPageRule: ref(false), hasSiteRule: ref(false), siteScopeAvailable: ref(true),
      showManageRules: ref(false),
      normalizedPageUrl: ref('https://example.com/page'), siteRule: ref(null),
      hasBroaderMatchingRule: ref(false), isFileUrl: ref(false),
      scopeActions: { togglePageScope: vi.fn(), toggleSiteScope: vi.fn() }, openManageRules: vi.fn(),
    };
  });

  it('sends PAGE_TRANSLATE through runtime with provider data', async () => {
    const wrapper = mount(DesktopFabMenu);
    const translateItem = wrapper.vm.menuItems.find(item => item.id === 'translate_page');

    translateItem.action();
    await Promise.resolve();

    expect(mocks.sendRegularMessage).toHaveBeenCalledWith({
      action: MessageActions.PAGE_TRANSLATE,
      data: { provider: 'google' },
    }, { returnFailureResponse: true });
    expect(mocks.pageEventBus.emit).not.toHaveBeenCalledWith(
      MessageActions.PAGE_TRANSLATE,
      expect.anything(),
    );
  });

  it('disables page and select-element actions when the resolved provider lacks bulk support', async () => {
    mocks.effectiveProvider = 'vajehyab';
    const wrapper = mount(DesktopFabMenu);

    expect(wrapper.vm.menuItems.find(item => item.id === 'translate_page').disabled).toBe(true);
    expect(wrapper.vm.menuItems.find(item => item.id === 'select_element').disabled).toBe(true);
  });

  it.each([
    ['PAGE_RESTORE', MessageActions.PAGE_RESTORE, { status: 'completed', isTranslated: true }],
    ['PAGE_TRANSLATE_STOP_AUTO', MessageActions.PAGE_TRANSLATE_STOP_AUTO, { status: 'translating', isTranslating: true }],
  ])('sends %s through runtime only', async (_name, action, state) => {
    mocks.mobileStore.pageTranslationData = {
      ...mocks.mobileStore.pageTranslationData,
      ...state,
    };
    const wrapper = mount(DesktopFabMenu);
    const itemId = action === MessageActions.PAGE_RESTORE ? 'restore_page' : 'page_translating_stop';
    const item = wrapper.vm.menuItems.find(menuItem => menuItem.id === itemId);

    item.action();
    await Promise.resolve();

    expect(mocks.sendRegularMessage).toHaveBeenCalledWith({ action }, { returnFailureResponse: true });
    expect(mocks.pageEventBus.emit).not.toHaveBeenCalledWith(action);
  });

  it('opens scope choices from the page secondary action and routes toggles', async () => {
    mocks.autoRules.hasPageRule.value = true;
    const wrapper = mount(DesktopFabMenu, { attachTo: document.body });
    wrapper.vm.isReady = true;
    wrapper.vm.isMenuOpen = true;
    await wrapper.vm.$nextTick();
    await wrapper.get('.fab-menu-item-secondary-btn').trigger('click');
    expect(wrapper.find('.fab-auto-translate-scopes').exists()).toBe(true);
    expect(wrapper.find('.fab-scope-separator').exists()).toBe(false);
    expect(wrapper.find('.fab-scope-note').exists()).toBe(false);
    expect(wrapper.find('.fab-scope-link').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.fab-auto-translate-scopes button').element);
    expect(wrapper.get('.fab-menu-item-secondary-btn').attributes('aria-haspopup')).toBeUndefined();
    expect(wrapper.get('.fab-menu-item-secondary-btn').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.fab-auto-translate-scopes').attributes('role')).toBe('group');
    expect(wrapper.findAll('.fab-auto-translate-scopes button')).toHaveLength(2);
    expect(wrapper.find('.fab-auto-translate-scopes button').attributes('aria-pressed')).toBe('true');
    await wrapper.find('.fab-auto-translate-scopes button').trigger('click');
    expect(mocks.autoRules.scopeActions.togglePageScope).toHaveBeenCalledOnce();

    await wrapper.get('.fab-auto-translate-scopes').trigger('keydown', { key: 'Escape' });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.fab-auto-translate-scopes').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.fab-menu-item-secondary-btn').element);
    expect(wrapper.vm.isMenuOpen).toBe(true);
    wrapper.unmount();
  });

  it('shows broader-rule guidance and returns focus to the star on Escape', async () => {
    mocks.autoRules.showManageRules.value = true;
    const wrapper = mount(DesktopFabMenu, { attachTo: document.body });
    wrapper.vm.isReady = true;
    wrapper.vm.isMenuOpen = true;
    await wrapper.vm.$nextTick();
    const star = wrapper.get('.fab-menu-item-secondary-btn');
    await star.trigger('click');

    const separator = wrapper.get('.fab-auto-translate-scopes .fab-scope-separator');
    const note = wrapper.get('.fab-auto-translate-scopes .fab-scope-note');
    const manageRules = wrapper.get('.fab-auto-translate-scopes .fab-scope-link');
    expect(separator.element.tagName).toBe('HR');
    expect(note.element.tagName).toBe('DIV');
    expect(note.element.tagName).not.toBe('BUTTON');
    expect(note.text()).toContain('auto_translate_scope_covered_note');
    expect(manageRules.element.tagName).toBe('BUTTON');
    expect(manageRules.text()).toContain('auto_translate_manage_rules');

    await manageRules.trigger('click');
    expect(mocks.autoRules.openManageRules).toHaveBeenCalledOnce();
    await manageRules.trigger('keydown', { key: 'Escape' });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.fab-auto-translate-scopes').exists()).toBe(false);
    expect(document.activeElement).toBe(star.element);
    wrapper.unmount();
  });

  it('resets the scope disclosure when the FAB closes', async () => {
    const wrapper = mount(DesktopFabMenu);
    wrapper.vm.isReady = true;
    wrapper.vm.isMenuOpen = true;
    await wrapper.vm.$nextTick();
    await wrapper.get('.fab-menu-item-secondary-btn').trigger('click');
    expect(wrapper.find('.fab-auto-translate-scopes').exists()).toBe(true);

    wrapper.vm.isMenuOpen = false;
    await wrapper.vm.$nextTick();
    expect(wrapper.vm.scopeMenuOpen).toBe(false);

    wrapper.vm.isMenuOpen = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.fab-auto-translate-scopes').exists()).toBe(false);
  });

  it.each(['0.8', '1', '1.2', '1.5'])(
    'keeps menu item content intact at FAB size %s', async (size) => {
      mocks.settingsStore.settings.FAB_SIZE = size;
      const wrapper = mount(DesktopFabMenu);
      wrapper.vm.isReady = true;
      wrapper.vm.isMenuOpen = true;
      await wrapper.vm.$nextTick();

      expect(wrapper.get('.desktop-fab-container').element.style.getPropertyValue('--fab-scale')).toBe(size);

      const translateRow = wrapper.findAll('.fab-menu-item').find(row =>
        row.get('.fab-menu-item-text').text() === 'desktop_fab_translate_page_label');
      expect(translateRow).toBeTruthy();
      expect(translateRow.get('.menu-icon-wrapper .fab-menu-icon').attributes('alt'))
        .toBe('desktop_fab_translate_page_label');
      expect(translateRow.get('.fab-menu-item-text').text()).toBe('desktop_fab_translate_page_label');
      expect(translateRow.find('.fab-menu-item-secondary-btn').exists()).toBe(true);
      wrapper.unmount();
    },
  );

  it('shows the mouse-hover toggle label for its current enabled state', async () => {
    mocks.settingsStore.settings.SHOW_MOUSE_HOVER_IN_FAB = true;
    const wrapper = mount(DesktopFabMenu);
    wrapper.vm.isReady = true;
    wrapper.vm.isMenuOpen = true;
    await wrapper.vm.$nextTick();

    const mouseHoverItem = () => wrapper.findAll('.fab-menu-item').find(row =>
      row.get('.fab-menu-item-text').text().startsWith('mouse_hover_'));
    expect(mouseHoverItem().get('.fab-menu-item-text').text()).toBe('mouse_hover_enable_label');

    mocks.mouseHoverEnabled.value = true;
    await wrapper.vm.$nextTick();
    expect(mouseHoverItem().get('.fab-menu-item-text').text()).toBe('mouse_hover_disable_label');
    wrapper.unmount();
  });

  it('keeps the page star beside its label and the scope panel after it', async () => {
    const longLabel = 'Translate this entire page with a deliberately long localized label';
    mocks.translations.desktop_fab_translate_page_label = longLabel;
    const wrapper = mount(DesktopFabMenu);
    wrapper.vm.isReady = true;
    wrapper.vm.isMenuOpen = true;
    await wrapper.vm.$nextTick();

    const translateRow = wrapper.findAll('.fab-menu-item').find(row =>
      row.get('.fab-menu-item-text').text() === longLabel);
    expect(translateRow.get('.fab-menu-item-text').text()).toBe(longLabel);
    const star = translateRow.get('.fab-menu-item-secondary-btn');
    expect(star.element.parentElement).toBe(translateRow.element);
    expect(translateRow.element.children[0].classList).toContain('menu-icon-wrapper');
    expect(translateRow.element.children[1]).toBe(translateRow.get('.fab-menu-item-text').element);

    await star.trigger('click');
    const scopePanel = translateRow.get('.fab-auto-translate-scopes');
    expect(scopePanel.element.parentElement).toBe(translateRow.element);
    expect(Array.from(translateRow.element.children).indexOf(scopePanel.element))
      .toBeGreaterThan(Array.from(translateRow.element.children).indexOf(star.element));
    wrapper.unmount();
  });
});

describe('DesktopFabMenu hide toolbar and popover', () => {
  let wrapper;
  const geometryCleanups = [];

  const openMenu = async () => {
    wrapper = mount(DesktopFabMenu, { attachTo: document.body });
    wrapper.vm.isReady = true;
    wrapper.vm.isMenuOpen = true;
    await wrapper.vm.$nextTick();
    // Let the async onMounted chain (position load, feature check, listener
    // registration) settle so wiring assertions are deterministic.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();
    await waitForListeners();
    return wrapper;
  };

  // The component registers its window listeners at the end of an async
  // onMounted chain; wait for that wiring instead of sleeping a fixed time.
  const waitForListeners = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const types = mocks.tracker.addEventListener.mock.calls.map(([, type]) => type);
      if (types.includes('resize') && types.includes('scroll') && types.includes('click')) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const eyeButton = () => wrapper.get('.fab-toolbar-hide-btn');
  const popover = () => wrapper.get('#fab-hide-popover');
  const popoverLabels = () => wrapper.findAll('#fab-hide-popover button').map((button) => button.text());

  const flushPopover = async () => {
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
  };

  const openPopover = async () => {
    await eyeButton().trigger('click');
    await flushPopover();
    return popover();
  };

  const mockRect = (box) => ({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
  });

  // jsdom has no layout: drive positionHidePopover with mocked rects and
  // viewport sizes, so these tests cover the positioning CALCULATIONS.
  const mockGeometry = ({ anchor, container, pop, vw = 1280, vh = 800, direction = null, button } = {}) => {
    const anchorRect = mockRect(anchor);
    const containerRect = mockRect(container);
    const popRect = mockRect(pop);
    // Default: the Close-for-Now button inset 6px inside the popover (5px
    // padding + 1px border). Explicit null simulates an unavailable rect
    // (zero size → the positioner falls back to zero insets).
    const buttonRect = mockRect(button === undefined
      ? { left: pop.left + 6, top: pop.top + 6, width: pop.width - 12, height: pop.height - 12 }
      : button ?? { left: 0, top: 0, width: 0, height: 0 });
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList?.contains('fab-hide-close-now')) return { ...buttonRect };
      if (this.id === 'fab-hide-popover') return { ...popRect };
      if (this.classList?.contains('fab-toolbar-hide-btn')) return { ...anchorRect };
      if (this.classList?.contains('desktop-fab-container')) return { ...containerRect };
      return mockRect({ left: 0, top: 0, width: 0, height: 0 });
    });
    const hadWidth = Object.prototype.hasOwnProperty.call(window, 'innerWidth');
    const hadHeight = Object.prototype.hasOwnProperty.call(window, 'innerHeight');
    const prevWidth = window.innerWidth;
    const prevHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: vw, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: vh, configurable: true, writable: true });
    let directionSpy = null;
    if (direction) {
      directionSpy = vi.spyOn(window, 'getComputedStyle').mockReturnValue({ direction });
    }
    const restore = () => {
      rectSpy.mockRestore();
      if (hadWidth) {
        Object.defineProperty(window, 'innerWidth', { value: prevWidth, configurable: true, writable: true });
      } else {
        delete window.innerWidth;
      }
      if (hadHeight) {
        Object.defineProperty(window, 'innerHeight', { value: prevHeight, configurable: true, writable: true });
      } else {
        delete window.innerHeight;
      }
      directionSpy?.mockRestore();
    };
    geometryCleanups.push(restore);
    return restore;
  };

  const rightDockGeometry = (overrides = {}) => ({
    anchor: { left: 1190, top: 310, width: 28, height: 28 },
    container: { left: 1150, top: 300, width: 130, height: 120 },
    pop: { left: 0, top: 0, width: 200, height: 150 },
    ...overrides,
  });

  const resizeHandlers = () => mocks.tracker.addEventListener.mock.calls
    .filter(([, type]) => type === 'resize')
    .map(([, , handler]) => handler);
  const clickOutsideHandler = () => mocks.tracker.addEventListener.mock.calls
    .find(([, type]) => type === 'click')?.[2];

  beforeEach(() => {
    setupBaseMocks();
    mocks.autoRules = {
      isAutoTranslateToggleVisible: ref(false), isActive: ref(false),
      hasPageRule: ref(false), hasSiteRule: ref(false), siteScopeAvailable: ref(true),
      showManageRules: ref(false),
      normalizedPageUrl: ref('https://example.com/page'), siteRule: ref(null),
      hasBroaderMatchingRule: ref(false), isFileUrl: ref(false),
      scopeActions: { togglePageScope: vi.fn(), toggleSiteScope: vi.fn() }, openManageRules: vi.fn(),
    };
  });

  afterEach(() => {
    while (geometryCleanups.length) geometryCleanups.pop()();
    wrapper?.unmount();
    wrapper = null;
  });

  it('renders the hide trigger as a compact toolbar strip, not a full-width row', async () => {
    await openMenu();

    const menu = wrapper.get('.desktop-fab-menu');
    expect(menu.element.firstElementChild.classList).toContain('fab-menu-toolbar');

    const toolbar = wrapper.get('.fab-menu-toolbar');
    expect(toolbar.findAll('.fab-toolbar-hide-btn')).toHaveLength(1);

    // The eye is a labelled toggle for the detached popover.
    const eye = eyeButton();
    expect(eye.element.tagName).toBe('BUTTON');
    expect(eye.attributes('type')).toBe('button');
    expect(eye.attributes('title')).toBe('desktop_fab_hide_options_toggle_label');
    expect(eye.attributes('aria-label')).toBe('desktop_fab_hide_options_toggle_label');
    expect(eye.attributes('aria-expanded')).toBe('false');
    expect(eye.attributes('aria-controls')).toBe('fab-hide-popover');
    expect(eye.find('.fab-hide-menu-icon').exists()).toBe(true);

    // No full-width hide row remains among the primary actions.
    expect(menu.element.children[1].classList).toContain('fab-menu-item');
    const labels = wrapper.findAll('.fab-menu-item-text').map((row) => row.text());
    expect(labels).not.toContain('desktop_fab_hide_fab_label');
    expect(wrapper.find('#fab-hide-options').exists()).toBe(false);
    expect(wrapper.find('.fab-hide-options').exists()).toBe(false);
    expect(wrapper.find('.fab-hide-row-trigger').exists()).toBe(false);
  });

  it('toggles the popover from the eye without touching the menu content', async () => {
    await openMenu();

    const menuClasses = () => Array.from(
      wrapper.get('.desktop-fab-menu').element.children,
      (child) => child.className,
    );
    const before = menuClasses();

    await eyeButton().trigger('click');
    await flushPopover();

    const panel = popover();
    expect(panel.attributes('role')).toBe('group');
    expect(panel.attributes('aria-label')).toBe('desktop_fab_hide_options_label');
    expect(eyeButton().attributes('aria-expanded')).toBe('true');

    // Sibling of the menu inside the container — never a descendant, so the
    // bottom-anchored menu keeps its dimensions.
    expect(panel.element.parentElement).toBe(wrapper.get('.desktop-fab-container').element);
    expect(wrapper.get('.desktop-fab-menu').element.contains(panel.element)).toBe(false);
    expect(menuClasses()).toEqual(before);

    expect(popoverLabels()).toEqual([
      'desktop_fab_hide_this_site',
      'desktop_fab_hide_this_page',
      'desktop_fab_hide_close_for_now',
    ]);

    // Toggling the eye collapses the popover but leaves the menu open — and
    // merely opening it never dismisses the FAB.
    await eyeButton().trigger('click');
    await flushPopover();
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(false);
    expect(eyeButton().attributes('aria-expanded')).toBe('false');
    expect(wrapper.vm.isMenuOpen).toBe(true);
    expect(mocks.addExclusion).not.toHaveBeenCalled();
    expect(wrapper.emitted('dismiss')).toBeUndefined();
  });

  it('omits persistent scopes the current page cannot express', async () => {
    // file:// pages can hide a single page but never a whole site
    mocks.supportedHideScopes = new Set(['page']);
    await openMenu();
    await openPopover();

    expect(popoverLabels()).toEqual([
      'desktop_fab_hide_this_page',
      'desktop_fab_hide_close_for_now',
    ]);
  });

  it('offers only Close for Now where no scope can be expressed', async () => {
    mocks.supportedHideScopes = new Set();
    await openMenu();
    await openPopover();

    expect(popoverLabels()).toEqual([
      'desktop_fab_hide_close_for_now',
    ]);
  });

  it('anchors the popover to the trailing edge above the toolbar on the right dock', async () => {
    mockGeometry(rightDockGeometry());
    await openMenu();
    await openPopover();

    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '-106px' });
  });

  it('anchors the popover to the leading edge on the left dock', async () => {
    mockGeometry({
      anchor: { left: 20, top: 310, width: 28, height: 28 },
      container: { left: 10, top: 300, width: 130, height: 120 },
      pop: { left: 0, top: 0, width: 200, height: 150 },
    });
    await openMenu();
    wrapper.vm.side = 'left';
    await openPopover();

    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '4px', top: '-106px' });
  });

  it('flips horizontally when the preferred edge would leave the viewport', async () => {
    mockGeometry({
      anchor: { left: 55, top: 310, width: 28, height: 28 },
      container: { left: 50, top: 300, width: 130, height: 120 },
      pop: { left: 0, top: 0, width: 300, height: 150 },
      vw: 400,
    });
    await openMenu();
    await openPopover();

    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-1px', top: '-106px' });
  });

  it('clamps inside the 8px viewport margin when neither horizontal edge fits', async () => {
    mockGeometry(rightDockGeometry({ vw: 1100 }));
    await openMenu();
    await openPopover();

    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-258px', top: '-106px' });
  });

  it('flips below the toolbar when there is no room above it', async () => {
    mockGeometry(rightDockGeometry({
      anchor: { left: 1190, top: 25, width: 28, height: 28 },
      container: { left: 1150, top: 20, width: 130, height: 120 },
    }));
    await openMenu();
    await openPopover();

    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '39px' });
  });

  it('clamps vertically when neither above nor below the toolbar fits', async () => {
    mockGeometry(rightDockGeometry({
      anchor: { left: 1190, top: 25, width: 28, height: 28 },
      container: { left: 1150, top: 20, width: 130, height: 120 },
      vh: 200,
    }));
    await openMenu();
    await openPopover();

    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '22px' });
  });

  it('mirrors the dock anchoring in RTL', async () => {
    mockGeometry({
      anchor: { left: 540, top: 310, width: 28, height: 28 },
      container: { left: 500, top: 300, width: 130, height: 120 },
      pop: { left: 0, top: 0, width: 200, height: 150 },
      direction: 'rtl',
    });
    await openMenu();
    await openPopover();

    // Same geometry in LTR anchors to the trailing edge (-132px); in RTL the
    // right dock hugs the leading edge instead.
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '34px', top: '-106px' });
  });

  it('recomputes the popover position on resize', async () => {
    const restore = mockGeometry(rightDockGeometry());
    await openMenu();
    await openPopover();
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '-106px' });

    // Widen the popover: the trailing-edge anchor must move with it.
    restore();
    mockGeometry(rightDockGeometry({ pop: { left: 0, top: 0, width: 240, height: 150 } }));
    expect(resizeHandlers().length).toBeGreaterThanOrEqual(2);
    resizeHandlers().forEach((handler) => handler());
    await flushPopover();

    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-166px', top: '-106px' });
  });

  it('re-anchors the popover when the dock side flips mid-session', async () => {
    mockGeometry({
      anchor: { left: 540, top: 310, width: 28, height: 28 },
      container: { left: 500, top: 300, width: 130, height: 120 },
      pop: { left: 0, top: 0, width: 200, height: 150 },
    });
    await openMenu();
    await openPopover();
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '-106px' });

    wrapper.vm.side = 'left';
    await flushPopover();
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '34px', top: '-106px' });
  });

  it('repositions the popover when the warning grows it while open', async () => {
    const nearBottom = {
      anchor: { left: 1190, top: 110, width: 28, height: 28 },
      container: { left: 1150, top: 100, width: 130, height: 120 },
    };
    const restore = mockGeometry({ ...nearBottom, pop: { left: 0, top: 0, width: 200, height: 150 } });
    await openMenu();
    await openPopover();
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '44px' });

    // The panel grows (taller content) with no anchor movement: placement must
    // not move until content actually changes.
    restore();
    mockGeometry({ ...nearBottom, pop: { left: 0, top: 0, width: 200, height: 700 } });
    await flushPopover();
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '44px' });

    mocks.settingsStore.settings.selectionTranslationMode = 'on-fab-click';
    await flushPopover();
    expect(wrapper.find('.fab-hide-warning').exists()).toBe(true);
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '-8px' });
  });

  it('repositions the popover when error feedback grows it while open', async () => {
    mocks.addExclusion = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    const nearBottom = {
      anchor: { left: 1190, top: 110, width: 28, height: 28 },
      container: { left: 1150, top: 100, width: 130, height: 120 },
    };
    const restore = mockGeometry({ ...nearBottom, pop: { left: 0, top: 0, width: 200, height: 150 } });
    await openMenu();
    await openPopover();
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '44px' });

    restore();
    mockGeometry({ ...nearBottom, pop: { left: 0, top: 0, width: 200, height: 700 } });
    await flushPopover();
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '44px' });

    await wrapper.findAll('#fab-hide-popover button').at(0).trigger('click');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await flushPopover();

    expect(wrapper.find('.fab-hide-error').exists()).toBe(true);
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '-8px' });
    expect(wrapper.vm.isMenuOpen).toBe(true);
  });

  it('tracks the toolbar anchor when the scope disclosure expands and collapses', async () => {
    mocks.autoRules.isAutoTranslateToggleVisible.value = true;
    const toolbarAt = (top) => ({
      anchor: { left: 1190, top, width: 28, height: 28 },
      container: { left: 1150, top: 300, width: 130, height: 120 },
      pop: { left: 0, top: 0, width: 200, height: 150 },
    });
    let restore = mockGeometry(toolbarAt(310));
    await openMenu();
    await openPopover();
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '-106px' });

    // The disclosure grows the bottom-anchored menu, moving the toolbar anchor
    // up; geometry alone must not move placement until the menu change lands.
    restore();
    restore = mockGeometry(toolbarAt(210));
    await flushPopover();
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '-106px' });

    await wrapper.get('.fab-menu-item-secondary-btn').trigger('click');
    await flushPopover();
    expect(wrapper.find('.fab-auto-translate-scopes').exists()).toBe(true);
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(true);
    expect(wrapper.vm.isMenuOpen).toBe(true);
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '-206px' });

    // Collapse moves the anchor back; the popover follows.
    restore();
    restore = mockGeometry(toolbarAt(310));
    await wrapper.get('.fab-menu-item-secondary-btn').trigger('click');
    await flushPopover();
    expect(wrapper.find('.fab-auto-translate-scopes').exists()).toBe(false);
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(true);
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '-106px' });
  });

  it('keeps the capped popover inside a short viewport', async () => {
    mockGeometry({
      anchor: { left: 1190, top: 110, width: 28, height: 28 },
      container: { left: 1150, top: 100, width: 130, height: 120 },
      pop: { left: 0, top: 0, width: 200, height: 584 },
      vw: 1280,
      vh: 600,
    });
    await openMenu();
    await openPopover();

    // 584px = 600px viewport minus the 8px positioning margin on both sides
    // (mirrors max-height: calc(100vh - 16px)): clamped exactly to the margins.
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-126px', top: '-92px' });
    const viewportTop = 100 + Number.parseFloat(wrapper.vm.hidePopoverStyle.top);
    const viewportBottom = viewportTop + 584;
    expect(viewportTop).toBeGreaterThanOrEqual(8);
    expect(viewportBottom).toBeLessThanOrEqual(600 - 8);
  });

  it('covers the eye band with the Close-for-Now button, not just the container', async () => {
    // Mocked button rect: Close for Now inset 6px inside the popover
    // (5px padding + 1px border). Geometry assertions on mocked rects only —
    // this is not a real-browser hit test.
    const anchorBox = { left: 1190, top: 310, width: 28, height: 28 };
    const containerBox = { left: 1150, top: 300, width: 130, height: 120 };
    const popBox = { left: 0, top: 0, width: 200, height: 150 };
    const btnBox = { left: 6, top: 6, width: 188, height: 138 };
    mockGeometry({ anchor: anchorBox, container: containerBox, pop: popBox, button: btnBox });
    await openMenu();
    await openPopover();

    // Insets shift the preferred placement off the container alignment.
    const style = wrapper.vm.hidePopoverStyle;
    expect(style).toEqual({ left: '-126px', top: '-106px' });

    const popViewportLeft = containerBox.left + Number.parseFloat(style.left);
    const popViewportTop = containerBox.top + Number.parseFloat(style.top);
    const btnViewport = {
      left: popViewportLeft + btnBox.left,
      top: popViewportTop + btnBox.top,
      right: popViewportLeft + btnBox.left + btnBox.width,
      bottom: popViewportTop + btnBox.top + btnBox.height,
    };
    const anchorViewport = {
      left: anchorBox.left,
      top: anchorBox.top,
      right: anchorBox.left + anchorBox.width,
      bottom: anchorBox.top + anchorBox.height,
    };
    expect(btnViewport.left).toBeLessThanOrEqual(anchorViewport.left);
    expect(btnViewport.right).toBeGreaterThanOrEqual(anchorViewport.right);
    expect(btnViewport.top).toBeLessThanOrEqual(anchorViewport.top);
    expect(btnViewport.bottom).toBeGreaterThanOrEqual(anchorViewport.bottom);
    // Center and bottom-right edge sample points of the anchor lie inside
    // the button rect.
    const points = [
      [anchorBox.left + 14, anchorBox.top + 14],
      [anchorViewport.right, anchorViewport.bottom],
    ];
    points.forEach(([x, y]) => {
      expect(x).toBeGreaterThanOrEqual(btnViewport.left);
      expect(x).toBeLessThanOrEqual(btnViewport.right);
      expect(y).toBeGreaterThanOrEqual(btnViewport.top);
      expect(y).toBeLessThanOrEqual(btnViewport.bottom);
    });
    // …and the covering bottom action is Close for Now.
    expect(popover().element.lastElementChild.textContent).toBe('desktop_fab_hide_close_for_now');
  });

  it('falls back to container alignment when the button rect is unavailable', async () => {
    mockGeometry({
      anchor: { left: 1190, top: 310, width: 28, height: 28 },
      container: { left: 1150, top: 300, width: 130, height: 120 },
      pop: { left: 0, top: 0, width: 200, height: 150 },
      button: null,
    });
    await openMenu();
    await openPopover();

    // Zero insets: the previous container-aligned formulas apply, and the
    // popover still opens visibly.
    expect(wrapper.vm.hidePopoverStyle).toEqual({ left: '-132px', top: '-112px' });
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(true);
    expect(wrapper.vm.isMenuOpen).toBe(true);
  });

  it('keeps Close for Now last with feedback above the actions', async () => {
    mocks.addExclusion = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    mocks.settingsStore.settings.selectionTranslationMode = 'on-fab-click';
    await openMenu();
    await openPopover();

    await wrapper.findAll('#fab-hide-popover button').at(0).trigger('click');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await flushPopover();

    // Warning and error render above the actions; Close for Now stays last.
    const children = Array.from(popover().element.children);
    const firstButtonAt = children.findIndex((el) => el.tagName === 'BUTTON');
    expect(children.findIndex((el) => el.classList.contains('fab-hide-warning')))
      .toBeLessThan(firstButtonAt);
    expect(children.findIndex((el) => el.classList.contains('fab-hide-error')))
      .toBeLessThan(firstButtonAt);
    const actions = wrapper.findAll('#fab-hide-popover button');
    expect(actions.at(-1).text()).toBe('desktop_fab_hide_close_for_now');

    // The bottom button still dismisses temporarily and closes the menu.
    await actions.at(-1).trigger('click');
    await flushPopover();
    expect(wrapper.emitted('dismiss')).toEqual([[{ scope: 'temporary' }]]);
    expect(wrapper.vm.isMenuOpen).toBe(false);
  });

  it('renders actions as adjacent siblings so separators track visibility', async () => {
    const openWithScopes = async (scopes) => {
      mocks.supportedHideScopes = new Set(scopes);
      await openMenu();
      await openPopover();
      return wrapper.findAll('#fab-hide-popover button');
    };

    // Only Close for Now: a single action, no adjacent pair for a separator.
    let actions = await openWithScopes([]);
    expect(actions).toHaveLength(1);
    expect(actions.at(0).text()).toBe('desktop_fab_hide_close_for_now');
    wrapper.unmount();
    wrapper = null;

    // Page + Close: the two actions are adjacent siblings.
    actions = await openWithScopes(['page']);
    expect(actions).toHaveLength(2);
    expect(actions.at(0).element.nextElementSibling).toBe(actions.at(1).element);
    wrapper.unmount();
    wrapper = null;

    // All three: chained adjacent siblings in order.
    actions = await openWithScopes(['page', 'site']);
    expect(actions).toHaveLength(3);
    expect(actions.at(0).element.nextElementSibling).toBe(actions.at(1).element);
    expect(actions.at(1).element.nextElementSibling).toBe(actions.at(2).element);
    expect(actions.at(-1).text()).toBe('desktop_fab_hide_close_for_now');
  });

  it('lets long hide labels wrap instead of forcing nowrap', async () => {
    mocks.translations.desktop_fab_hide_close_for_now = 'Close for now with a deliberately long localized label that must wrap';
    await openMenu();
    await openPopover();

    // DOM side of wrapping: no inline or class nowrap anywhere on the actions,
    // and the full label text renders (not truncated). The wrap itself is
    // covered by the SCSS contract (overflow-wrap: anywhere, no nowrap).
    const actions = wrapper.findAll('#fab-hide-popover button');
    expect(actions.length).toBeGreaterThan(0);
    actions.forEach((action) => {
      expect(action.attributes('style') ?? '').not.toMatch(/white-space/);
      expect(action.classes().join(' ')).not.toMatch(/nowrap/);
    });
    const closeForNow = actions.find((action) => action.text().startsWith('Close for now'));
    expect(closeForNow.text()).toContain('deliberately long');
  });

  it('moves focus into the popover on open and restores it to the eye on Escape', async () => {
    await openMenu();
    await openPopover();

    // Initial focus lands on Close for Now (the bottom action).
    const closeForNow = () => wrapper.findAll('#fab-hide-popover button')
      .find((button) => button.text() === 'desktop_fab_hide_close_for_now');
    expect(document.activeElement).toBe(closeForNow().element);

    // Native buttons: Enter/Space activation comes from the platform, and all
    // actions stay Tab/Shift+Tab reachable (no roving tabindex, no focus trap).
    const actions = wrapper.findAll('#fab-hide-popover button');
    expect(actions).toHaveLength(3);
    actions.forEach((action) => {
      expect(action.element.tagName).toBe('BUTTON');
      expect(action.attributes('type')).toBe('button');
      expect(action.attributes('tabindex')).toBeUndefined();
    });

    await popover().trigger('keydown', { key: 'Escape' });
    await flushPopover();
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(false);
    expect(document.activeElement).toBe(eyeButton().element);
    expect(wrapper.vm.isMenuOpen).toBe(true);
  });

  it('closes the menu and cleans the popover on click-away, but not on inside clicks', async () => {
    await openMenu();
    await openPopover();
    const onClickOutside = clickOutsideHandler();
    expect(typeof onClickOutside).toBe('function');

    // Clicks inside the container leave everything open.
    onClickOutside({ composedPath: () => [popover().element, wrapper.get('.desktop-fab-container').element] });
    await flushPopover();
    expect(wrapper.vm.isMenuOpen).toBe(true);
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(true);

    onClickOutside({ composedPath: () => [document.body] });
    await flushPopover();
    expect(wrapper.vm.isMenuOpen).toBe(false);
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(false);
    expect(wrapper.vm.hideMenuOpen).toBe(false);
  });

  it('cleans the popover state when the menu closes', async () => {
    await openMenu();
    await openPopover();

    wrapper.vm.isMenuOpen = false;
    await flushPopover();
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(false);
    expect(wrapper.vm.hideMenuOpen).toBe(false);
  });

  it('collapses the popover on primary row clicks without losing visible focus', async () => {
    await openMenu();
    await openPopover();

    const row = wrapper.findAll('.fab-menu-item').find(
      (item) => item.get('.fab-menu-item-text').text() === 'desktop_fab_translate_page_label',
    );
    await row.trigger('click');
    await flushPopover();

    expect(wrapper.find('#fab-hide-popover').exists()).toBe(false);
    expect(wrapper.vm.isMenuOpen).toBe(true);
    expect(wrapper.emitted('dismiss')).toBeUndefined();
    expect(document.contains(document.activeElement)).toBe(true);
  });

  it('warns only while selection translation is owned by the FAB', async () => {
    await openMenu();
    await openPopover();
    expect(wrapper.find('.fab-hide-warning').exists()).toBe(false);

    mocks.settingsStore.settings.selectionTranslationMode = 'on-fab-click';
    await wrapper.vm.$nextTick();
    expect(wrapper.get('.fab-hide-warning').text())
      .toBe('desktop_fab_hide_onfabclick_warning');

    mocks.settingsStore.settings.selectionTranslationMode = 'on-click';
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.fab-hide-warning').exists()).toBe(false);
  });

  it('emits temporary immediately and closes the menu with the popover', async () => {
    await openMenu();
    await openPopover();

    await wrapper.findAll('#fab-hide-popover button').at(2).trigger('click');
    await flushPopover();
    expect(wrapper.emitted('dismiss')).toEqual([[{ scope: 'temporary' }]]);
    expect(mocks.addExclusion).not.toHaveBeenCalled();
    expect(wrapper.vm.isMenuOpen).toBe(false);
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(false);
  });

  it('emits temporary immediately and persistent only after a successful write', async () => {
    await openMenu();
    await openPopover();

    await wrapper.findAll('#fab-hide-popover button').at(2).trigger('click');
    expect(wrapper.emitted('dismiss')).toEqual([[{ scope: 'temporary' }]]);

    // Reopen and hold the write open: the parent is told only once it lands.
    let finishWrite;
    mocks.addExclusion.mockImplementation(() => new Promise((resolve) => { finishWrite = resolve; }));
    wrapper.vm.isMenuOpen = true;
    await wrapper.vm.$nextTick();
    await openPopover();

    await wrapper.findAll('#fab-hide-popover button').at(1).trigger('click');
    await Promise.resolve();
    expect(mocks.addExclusion).toHaveBeenCalledWith('page', window.location.href);
    expect(wrapper.emitted('dismiss')).toEqual([[{ scope: 'temporary' }]]);

    finishWrite('desktop-fab-exclusion:v1:page:key');
    await Promise.resolve();
    await Promise.resolve();
    expect(wrapper.emitted('dismiss')).toEqual([
      [{ scope: 'temporary' }],
      [{ scope: 'page' }],
    ]);
  });

  it('keeps the popover open and surfaces feedback when the write fails', async () => {
    mocks.addExclusion = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    await openMenu();
    await openPopover();

    await wrapper.findAll('#fab-hide-popover button').at(0).trigger('click');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.addExclusion).toHaveBeenCalledWith('site', window.location.href);
    expect(wrapper.emitted('dismiss')).toBeUndefined();
    expect(wrapper.vm.isMenuOpen).toBe(true);
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(true);
    const alert = wrapper.get('.fab-hide-error');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toBe('desktop_fab_hide_save_failed');
    expect(mocks.handleError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: 'desktop-fab:hide-site', showToast: true }),
    );
  });

  it('surfaces feedback without dismissing when the scope cannot be expressed', async () => {
    mocks.addExclusion = vi.fn().mockResolvedValue('');
    await openMenu();
    await openPopover();

    await wrapper.findAll('#fab-hide-popover button').at(1).trigger('click');
    await Promise.resolve();
    await Promise.resolve();

    expect(wrapper.emitted('dismiss')).toBeUndefined();
    expect(wrapper.vm.isMenuOpen).toBe(true);
    expect(wrapper.find('#fab-hide-popover').exists()).toBe(true);
    expect(wrapper.get('.fab-hide-error').text()).toBe('desktop_fab_hide_scope_unsupported');
  });

  it('never writes the mode or the global FAB toggle for a dismissal', async () => {
    await openMenu();
    await openPopover();

    await wrapper.findAll('#fab-hide-popover button').at(1).trigger('click');
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalled();
    expect(mocks.settingsStore.settings.selectionTranslationMode).toBe('immediate');
    expect(mocks.settingsStore.settings.SHOW_DESKTOP_FAB).toBe(true);
  });

  it('registers viewport and reposition listeners and reports absence on unmount', async () => {
    await openMenu();

    const types = mocks.tracker.addEventListener.mock.calls.map(([, type]) => type);
    expect(types.filter((type) => type === 'resize').length).toBeGreaterThanOrEqual(2);
    expect(types.filter((type) => type === 'scroll').length).toBeGreaterThanOrEqual(2);
    expect(types).toContain('click');
    expect(mocks.tracker.trackResource).toHaveBeenCalledWith(
      expect.stringMatching(/^exclusion-sync-\d+$/), expect.any(Function),
    );

    wrapper.unmount();
    expect(wrapper.emitted('presence')?.at(-1)).toEqual([false]);
    wrapper = null;
  });
});

describe('DesktopFabMenu hide action localization', () => {
  const messageOf = (messages, key) => messages[key]?.message;

  it.each([
    ['en', enMessages],
    ['fa', faMessages],
    ['ja', jaMessages],
  ])('provides non-empty hide scope labels in %s', (_locale, messages) => {
    expect(messageOf(messages, 'desktop_fab_hide_this_site')).toMatch(/\S/);
    expect(messageOf(messages, 'desktop_fab_hide_this_page')).toMatch(/\S/);
    expect(messageOf(messages, 'desktop_fab_hide_close_for_now')).toMatch(/\S/);
  });

  it('keeps the English hide scope labels unchanged', () => {
    expect(messageOf(enMessages, 'desktop_fab_hide_this_site')).toBe('Hide on This Site');
    expect(messageOf(enMessages, 'desktop_fab_hide_this_page')).toBe('Hide on This Page');
    expect(messageOf(enMessages, 'desktop_fab_hide_close_for_now')).toBe('Close for Now');
  });
});

describe('DesktopFabMenu dismissal cleanup and drag persistence', () => {
  let wrapper;

  const autoRulesOff = () => ({
    isAutoTranslateToggleVisible: ref(false), isActive: ref(false),
    hasPageRule: ref(false), hasSiteRule: ref(false), siteScopeAvailable: ref(true),
    showManageRules: ref(false),
    normalizedPageUrl: ref('https://example.com/page'), siteRule: ref(null),
    hasBroaderMatchingRule: ref(false), isFileUrl: ref(false),
    scopeActions: { togglePageScope: vi.fn(), toggleSiteScope: vi.fn() }, openManageRules: vi.fn(),
  });

  beforeEach(() => {
    setupBaseMocks();
    mocks.autoRules = autoRulesOff();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
  });

  const settleInitialization = () => vi.waitFor(() => expect(wrapper.vm.isReady).toBe(true));

  it('stops only this instance\'s TTS when the parent unmounts it after a temporary dismissal', async () => {
    wrapper = mount(DesktopFabMenu, { attachTo: document.body });
    wrapper.vm.isReady = true;
    wrapper.vm.isMenuOpen = true;
    await wrapper.vm.$nextTick();

    await wrapper.get('.fab-toolbar-hide-btn').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    // Opening the popover must not tear anything down on its own.
    expect(mocks.ttsStop).not.toHaveBeenCalled();

    await wrapper.findAll('#fab-hide-popover button').at(2).trigger('click');
    expect(wrapper.emitted('dismiss')).toEqual([[{ scope: 'temporary' }]]);
    expect(mocks.ttsStop).not.toHaveBeenCalled();

    // The parent gate hides the FAB by unmounting this component.
    wrapper.unmount();
    wrapper = null;

    expect(mocks.ttsStop).toHaveBeenCalledTimes(1);
    expect(mocks.ttsStop).toHaveBeenCalledWith({ stopOnlyIfOwner: true });
  });

  it('reports actual root presence across readiness, fullscreen and unmount', async () => {
    wrapper = mount(DesktopFabMenu);
    wrapper.vm.isReady = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('presence')?.at(-1)).toEqual([true]);
    expect(wrapper.find('.desktop-fab-container').exists()).toBe(true);

    mocks.mobileStore.isFullscreen = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('presence')?.at(-1)).toEqual([false]);
    expect(wrapper.find('.desktop-fab-container').exists()).toBe(false);

    wrapper.unmount();
    expect(wrapper.emitted('presence')?.at(-1)).toEqual([false]);
  });

  it('renders as soon as initialization settles and applies the saved position first', async () => {
    mocks.getPosition.mockResolvedValue({ y: 230, side: 'left' });
    let resolveDependencies;
    const dependenciesReady = new Promise((resolve) => { resolveDependencies = resolve; });
    const addEventListener = mocks.tracker.addEventListener.getMockImplementation();
    let scrollListeners = 0;
    mocks.tracker.addEventListener.mockImplementation((...args) => {
      const result = addEventListener(...args);
      if (args[0] === window && args[1] === 'scroll' && ++scrollListeners === 2) {
        resolveDependencies();
      }
      return result;
    });

    try {
      wrapper = mount(DesktopFabMenu);

      // Both scroll listeners are installed after async dependencies settle and
      // immediately before the FAB becomes ready. Do not advance startup timers.
      await dependenciesReady;
      await wrapper.vm.$nextTick();

      const root = wrapper.get('.desktop-fab-container');
      expect(wrapper.vm.isReady).toBe(true);
      expect(root.classes()).toContain('is-left');
      expect(root.element.style.getPropertyValue('--fab-top')).toBe('230px');
      expect(root.classes()).toContain('is-positioning');
      // Let transition frames drain so they cannot leak into later RAF tests.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    } finally {
      wrapper?.unmount();
      wrapper = null;
      mocks.tracker.addEventListener.mockImplementation(addEventListener);
    }
  });

  it('cancels the queued positioning frame and timers on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const queuedFrames = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    const cancelRaf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      wrapper = mount(DesktopFabMenu);
      await settleInitialization();
      expect(raf).toHaveBeenCalledOnce();

      wrapper.unmount();
      wrapper = null;
      expect(cancelRaf).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      queuedFrames[0]();
      expect(raf).toHaveBeenCalledOnce();
    } finally {
      wrapper?.unmount();
      wrapper = null;
      raf.mockRestore();
      cancelRaf.mockRestore();
    }
  });

  it('keeps the double animation frame position settle and 150ms positioning delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.getPosition.mockResolvedValue({ y: -1, side: 'right' });
    let nextFrameId = 42;
    const queuedFrames = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queuedFrames.push(callback);
      return nextFrameId++;
    });
    const cancelRaf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.classList?.contains('desktop-fab-container') ? { top: 321 } : { top: 0 };
    });
    try {
      wrapper = mount(DesktopFabMenu);
      await settleInitialization();
      expect(wrapper.vm.isReady).toBe(true);
      expect(wrapper.get('.desktop-fab-container').classes()).toContain('is-positioning');
      expect(wrapper.get('.desktop-fab-container').element.style.getPropertyValue('--fab-transition')).toBe('none');
      expect(queuedFrames).toHaveLength(1);

      queuedFrames.shift()();
      expect(queuedFrames).toHaveLength(1);
      expect(rect).not.toHaveBeenCalled();
      queuedFrames.shift()();
      await wrapper.vm.$nextTick();
      expect(rect).toHaveBeenCalled();
      expect(wrapper.get('.desktop-fab-container').element.style.getPropertyValue('--fab-top')).toBe('321px');
      expect(wrapper.get('.desktop-fab-container').classes()).toContain('is-positioning');
      expect(wrapper.get('.desktop-fab-container').element.style.getPropertyValue('--fab-transition')).toBe('none');
      await vi.advanceTimersByTimeAsync(149);
      expect(wrapper.get('.desktop-fab-container').classes()).toContain('is-positioning');
      expect(wrapper.get('.desktop-fab-container').element.style.getPropertyValue('--fab-transition')).toBe('none');
      await vi.advanceTimersByTimeAsync(1);
      await wrapper.vm.$nextTick();
      expect(wrapper.get('.desktop-fab-container').classes()).not.toContain('is-positioning');
      expect(wrapper.get('.desktop-fab-container').element.style.getPropertyValue('--fab-transition')).not.toBe('none');
    } finally {
      wrapper?.unmount();
      wrapper = null;
      raf.mockRestore();
      cancelRaf.mockRestore();
      rect.mockRestore();
    }
  });

  it('keeps overlapping instances animation frame resources isolated', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let nextFrameId = 100;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => nextFrameId++);
    const cancelRaf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    let first;
    let second;
    try {
      first = mount(DesktopFabMenu);
      second = mount(DesktopFabMenu);
      const [firstGroupId, secondGroupId] = [...mocks.tracker.groups.keys()];
      expect(firstGroupId).not.toBe(secondGroupId);

      await vi.waitFor(() => expect(mocks.tracker.addEventListener.mock.calls
        .filter(([, type]) => type === 'resize')).toHaveLength(4));
      expect(mocks.pageEventBus.on.mock.calls.map(([event]) => event).sort()).toEqual([
        'FEATURE_STATUS_CHANGED',
        'FEATURE_STATUS_CHANGED',
        'sync-interaction-listeners',
        'sync-interaction-listeners',
      ]);
      expect(mocks.pageEventBus.subscriptions.size).toBe(4);
      await vi.waitFor(() => expect(first.vm.isReady && second.vm.isReady).toBe(true));
      expect(raf).toHaveBeenCalled();

      const frameResourceIds = (groupId) => [...mocks.tracker.groups.get(groupId).resourceCleanups.keys()]
        .filter((id) => String(id).includes('-frame-'));
      const groupResourceIds = (groupId) => [...mocks.tracker.groups.get(groupId).resourceCleanups.keys()];
      const firstFrames = frameResourceIds(firstGroupId);
      const secondFrames = frameResourceIds(secondGroupId);
      expect(firstFrames.length).toBeGreaterThan(0);
      expect(secondFrames.length).toBeGreaterThan(0);
      expect(firstFrames).not.toEqual(expect.arrayContaining(secondFrames));
      for (const [groupId, suffix] of [[firstGroupId, firstGroupId.split('-').at(-1)], [secondGroupId, secondGroupId.split('-').at(-1)]]) {
        expect(groupResourceIds(groupId)).toContain(`exclusion-sync-${suffix}`);
        expect(groupResourceIds(groupId)).toContain(`exclusion-re-sync-${suffix}`);
      }

      first.unmount();
      expect(mocks.tracker.cleanedResourceIds.filter((id) => String(id).includes('-frame-')))
        .toEqual(firstFrames);
      expect(mocks.tracker.cleanedGroups).toEqual([firstGroupId]);
      expect(mocks.tracker.groups.has(secondGroupId)).toBe(true);
      expect(frameResourceIds(secondGroupId)).toEqual(secondFrames);
      expect(cancelRaf).toHaveBeenCalledTimes(firstFrames.length);
      expect(mocks.pageEventBus.subscriptions.size).toBe(2);
      const secondSubscriptionCleanups = groupResourceIds(secondGroupId)
        .filter((id) => String(id).startsWith('exclusion-'))
        .map((id) => mocks.tracker.groups.get(secondGroupId).resourceCleanups.get(id));
      expect([...mocks.pageEventBus.subscriptions].map(({ cleanup }) => cleanup))
        .toEqual(expect.arrayContaining(secondSubscriptionCleanups));

      second.unmount();
      expect(cancelRaf).toHaveBeenCalledTimes(firstFrames.length + secondFrames.length);
      expect(mocks.tracker.cleanedGroups).toEqual([firstGroupId, secondGroupId]);
      expect(mocks.pageEventBus.subscriptions.size).toBe(0);
      expect([...mocks.tracker.resourceIds.keys()]).toHaveLength(0);
    } finally {
      first?.unmount();
      second?.unmount();
      raf.mockRestore();
      cancelRaf.mockRestore();
    }
  });

  it('ignores async initialization that finishes after unmount', async () => {
    let resolvePosition;
    mocks.getPosition.mockImplementation(() => new Promise((resolve) => {
      resolvePosition = resolve;
    }));
    wrapper = mount(DesktopFabMenu);
    const vm = wrapper.vm;
    await vi.waitFor(() => expect(mocks.getPosition).toHaveBeenCalledOnce());

    wrapper.unmount();
    resolvePosition({ y: 200, side: 'left' });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.tracker.addEventListener).not.toHaveBeenCalled();
    expect(mocks.tracker.trackResource).not.toHaveBeenCalled();
    expect(mocks.tracker.trackTimeout).not.toHaveBeenCalled();
    expect(vm.isReady).toBe(false);
    expect(wrapper.exists()).toBe(false);
    wrapper = null;
  });

  it('persists DESKTOP_FAB_POSITION after a drag without touching any setting', async () => {
    wrapper = mount(DesktopFabMenu, { attachTo: document.body });
    wrapper.vm.isReady = true;
    // Wait for the saved position before dispatching the drag; initialization
    // would otherwise overwrite the dragged value before stopDrag's deferred write fires.
    await vi.waitFor(() => expect(wrapper.vm.verticalPos).toBe(100));
    // Pin the drag origin so the expectation does not depend on jsdom layout.
    wrapper.vm.verticalPos = 100;
    await wrapper.vm.$nextTick();

    wrapper.get('.desktop-fab-button').element.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 150, clientX: 900 }),
    );
    // The first move clears the 5px threshold, the second repositions the FAB.
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 300, clientX: 900 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 420, clientX: 900 }));

    // Drag end defers the write by 100ms; fake only the clock, not rAF.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    window.dispatchEvent(new MouseEvent('mouseup', { clientY: 420, clientX: 900 }));
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();

    expect(mocks.storageManager.set).toHaveBeenCalledWith({
      DESKTOP_FAB_POSITION: { side: 'right', y: 220 },
    });
    // Geometry only: no other storage key, no setting write, no dismissal.
    expect(mocks.storageManager.set.mock.calls).toHaveLength(1);
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalled();
    expect(mocks.addExclusion).not.toHaveBeenCalled();
    expect(wrapper.emitted('dismiss')).toBeUndefined();
    expect(mocks.settingsStore.settings.SHOW_DESKTOP_FAB).toBe(true);
    expect(mocks.settingsStore.settings.selectionTranslationMode).toBe('immediate');
    expect(wrapper.vm.isMenuOpen).toBe(false);
  });

  it('persists the released position if unmounted before delayed drag cleanup', async () => {
    let rejectWrite;
    mocks.storageManager.set.mockImplementation(() => new Promise((_, reject) => {
      rejectWrite = reject;
    }));
    wrapper = mount(DesktopFabMenu, { attachTo: document.body });
    wrapper.vm.isReady = true;
    await wrapper.vm.$nextTick();
    await vi.waitFor(() => expect(mocks.tracker.addEventListener).toHaveBeenCalledWith(
      window, 'resize', expect.any(Function),
    ));
    wrapper.vm.verticalPos = 100;
    await wrapper.vm.$nextTick();

    wrapper.get('.desktop-fab-button').element.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 150, clientX: 900 }),
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 300, clientX: 900 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 420, clientX: 900 }));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    window.dispatchEvent(new MouseEvent('mouseup', { clientY: 420, clientX: 900 }));
    expect(mocks.storageManager.set).toHaveBeenCalledOnce();
    expect(mocks.storageManager.set).toHaveBeenCalledWith({
      DESKTOP_FAB_POSITION: { side: 'right', y: 220 },
    });

    wrapper.vm.verticalPos = 333;
    const { isDragging, wasDragged } = wrapper.vm;
    wrapper.unmount();
    wrapper = null;
    await vi.advanceTimersByTimeAsync(300);

    rejectWrite(new Error('storage unavailable'));
    await Promise.resolve();
    await Promise.resolve();
    expect(isDragging).toBe(true);
    expect(wasDragged).toBe(true);
    expect(mocks.storageManager.set).toHaveBeenCalledWith({
      DESKTOP_FAB_POSITION: { side: 'right', y: 220 },
    });
  });
});
