import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import DashboardView from './DashboardView.vue';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';

const mocks = vi.hoisted(() => {
  const pageEventBus = {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };

  if (typeof window !== 'undefined') {
    window.pageEventBus = pageEventBus;
  }

  return {
    pageEventBus,
    mobileStore: null,
    settingsStore: null,
  sendMessage: vi.fn(),
  sendRegularMessage: vi.fn(),
  handleError: vi.fn(),
  };
});

vi.mock('@/store/modules/mobile.js', () => ({
  useMobileStore: () => mocks.mobileStore,
}));

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => mocks.settingsStore,
}));

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (_key, fallback) => fallback || _key }),
}));

vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: () => ({ handleError: mocks.handleError }),
}));

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendMessage: mocks.sendMessage,
  sendRegularMessage: mocks.sendRegularMessage,
}));

vi.mock('@/core/PageEventBus.js', () => ({
  WINDOWS_MANAGER_EVENTS: { OPEN_SETTINGS: 'open-options-page' },
  pageEventBus: mocks.pageEventBus,
}));

vi.mock('@/features/text-selection/events/SelectionEvents.js', () => ({
  SELECTION_EVENTS: {
    GLOBAL_SELECTION_CHANGE: 'global-selection-change',
    GLOBAL_SELECTION_CLEAR: 'global-selection-clear',
  },
}));

vi.mock('@/shared/constants/mobile.js', () => ({
  MOBILE_CONSTANTS: {
    VIEWS: {
      PAGE_TRANSLATION: 'page-translation',
      INPUT: 'input',
      HISTORY: 'history',
    },
  },
}));

vi.mock('@/shared/config/config.js', () => ({
  CONFIG: { TRANSLATION_API: 'edge' },
  TranslationMode: {
    Page: 'page',
    Select_Element: 'select-element',
  },
}));

vi.mock('@/features/tts/composables/useTTSSmart.js', () => ({
  useTTSSmart: () => ({
    isPlaying: { value: false },
    isLoading: { value: false },
    stop: vi.fn(),
    speak: vi.fn(),
  }),
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
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

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: vi.fn(() => false),
    handleContextError: vi.fn(),
  },
}));

describe('DashboardView page command transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendRegularMessage.mockResolvedValue({ success: true });
    mocks.mobileStore = reactive({
      hasElementTranslations: false,
      pageTranslationData: {
        isTranslating: false,
        isAutoTranslating: false,
        isTranslated: false,
      },
      navigate: vi.fn(),
      closeSheet: vi.fn(),
      resetSelectionData: vi.fn(),
    });
    mocks.settingsStore = reactive({
      isDarkTheme: false,
      settings: {
        MODE_PROVIDERS: { page: 'google', 'select-element': 'edge' },
        TRANSLATION_API: 'google',
        MOBILE_PAGE_TRANSLATION_AUTO_CLOSE: false,
      },
    });
  });

  it('sends PAGE_TRANSLATE through runtime without emitting command bus event', async () => {
    const wrapper = mount(DashboardView);

    await wrapper.get('.ti-m-action-btn').trigger('click');

    expect(mocks.sendRegularMessage).toHaveBeenCalledWith({
      action: MessageActions.PAGE_TRANSLATE,
      data: { provider: 'google' },
    }, { returnFailureResponse: true });
    expect(mocks.pageEventBus.emit).not.toHaveBeenCalledWith(
      MessageActions.PAGE_TRANSLATE,
      expect.anything(),
    );
  });

  it('uses CONFIG when the mode and global providers are absent', async () => {
    delete mocks.settingsStore.settings.MODE_PROVIDERS;
    delete mocks.settingsStore.settings.TRANSLATION_API;
    const wrapper = mount(DashboardView);

    await wrapper.get('.ti-m-action-btn').trigger('click');

    expect(mocks.sendRegularMessage).toHaveBeenCalledWith({
      action: MessageActions.PAGE_TRANSLATE,
      data: { provider: 'edge' },
    }, { returnFailureResponse: true });
  });

  it('resolves and dispatches the mode-specific provider for Select Element', async () => {
    const wrapper = mount(DashboardView);
    const selectButton = wrapper.findAll('.ti-m-action-btn')[1];

    await selectButton.trigger('click');

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      action: MessageActions.ACTIVATE_SELECT_ELEMENT_MODE,
      data: { provider: 'edge' },
    });
  });

  it('rejects an unsupported mode provider using shared validation', async () => {
    mocks.settingsStore.settings.MODE_PROVIDERS.page = 'gemini';
    const wrapper = mount(DashboardView);

    expect(wrapper.findAll('.ti-m-action-btn')[0].classes()).toContain('is-disabled');
    await wrapper.findAll('.ti-m-action-btn')[0].trigger('click');

    expect(mocks.sendRegularMessage).not.toHaveBeenCalled();
    expect(mocks.handleError).toHaveBeenCalled();
  });
});
