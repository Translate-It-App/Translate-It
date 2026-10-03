import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import DesktopFabMenu from './DesktopFabMenu.vue';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

const mocks = vi.hoisted(() => ({
  mobileStore: null,
  settingsStore: null,
  pageEventBus: {
    emit: vi.fn(),
    on: vi.fn(() => vi.fn()),
  },
  sendMessage: vi.fn(),
  sendRegularMessage: vi.fn(),
  tracker: {
    clearTimer: vi.fn(),
    trackTimeout: vi.fn((callback) => setTimeout(callback, 0)),
    trackResource: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  autoRules: null,
}));

vi.mock('@/store/modules/mobile.js', () => ({
  useMobileStore: () => mocks.mobileStore,
}));

vi.mock('@/features/settings/stores/settings.js', () => ({
  default: () => mocks.settingsStore,
}));

vi.mock('@/composables/shared/useUnifiedI18n', () => ({
  useUnifiedI18n: () => ({ t: (key) => key }),
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
  useResourceTracker: () => mocks.tracker,
}));

vi.mock('@/features/tts/composables/useTTSSmart.js', () => ({
  useTTSSmart: () => ({
    lastText: { value: '' },
    detectedLanguage: { value: 'auto' },
    currentTTSId: { value: null },
    ttsState: { value: 'idle' },
    isPlaying: { value: false },
    isLoading: { value: false },
    stop: vi.fn().mockResolvedValue(undefined),
    speak: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/features/mouse-hover/composables/useMouseHoverToggle.js', () => ({
  useMouseHoverToggle: () => ({
    isMouseHoverEnabled: { value: false },
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
  getDesktopFabPositionAsync: vi.fn().mockResolvedValue({ y: 100, side: 'right' }),
}));

vi.mock('@/features/translation/providers/ProviderManifest.js', () => ({
  findProviderById: () => ({ features: ['bulk'] }),
}));

vi.mock('@/utils/browser/compatibility.js', () => ({
  deviceDetector: { isMobile: () => false },
}));

vi.mock('@/shared/config/languageConstants.js', () => ({
  getLanguageNameFromCode: () => 'English',
}));

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: { set: vi.fn() },
}));

vi.mock('@/utils/ui/styleInjector.js', () => ({
  injectStylesToShadowRoot: vi.fn(),
}));

vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: () => ({ handleError: vi.fn() }),
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

describe('DesktopFabMenu page command transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendRegularMessage.mockResolvedValue({ success: true });
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
      },
      getEffectiveProvider: () => 'google',
    });
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
});
