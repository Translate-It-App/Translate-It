import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive, ref, nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import SubtitleApp from './SubtitleApp.vue';
import { PublicTranslationErrorActions } from '@/shared/error-management/PublicTranslationError.js';

const { openOptionsPageMock, useSubtitleTranslationMock } = vi.hoisted(() => ({
  openOptionsPageMock: vi.fn(),
  useSubtitleTranslationMock: vi.fn(),
}));

const { loggerErrorMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/core/helpers.js', () => ({
  openOptionsPage: (...args) => openOptionsPageMock(...args),
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      onMessage: {
        addListener: vi.fn(),
      },
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
    },
  },
}));

vi.mock('@/features/subtitle-translation/composables/useSubtitleTranslation.js', () => ({
  useSubtitleTranslation: useSubtitleTranslationMock,
}));

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key, fallback) => fallback ?? key,
  }),
}));

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => reactive({
    settings: {
      THEME: 'light',
      TRANSLATION_API: 'googlev2',
      TARGET_LANGUAGE: 'en',
      DEEPL_BETA_LANGUAGES_ENABLED: false,
    },
    isDarkTheme: false,
    isInitialized: true,
    loadSettings: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/features/translation/providers/ProviderManifest.js', () => ({
  findProviderById: vi.fn(() => ({
    features: ['subtitle'],
  })),
}));

vi.mock('@/features/translation/utils/providerValidator.js', () => ({
  isProviderConfigured: vi.fn(() => true),
}));

vi.mock('@/utils/ui/theme.js', () => ({
  applyTheme: vi.fn(),
}));

vi.mock('@/composables/core/useResourceTracker.js', () => ({
  useResourceTracker: () => ({
    addEventListener: vi.fn(),
  }),
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    error: loggerErrorMock,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('@/features/subtitle-translation/components/SubtitleFileDropzone.vue', () => ({
  default: {
    emits: ['update:modelValue', 'file-loaded'],
    template: `
      <button
        class="subtitle-dropzone-stub"
        @click="$emit('update:modelValue', { name: 'sample.srt' }); $emit('file-loaded', '1\\n00:00:00,000 --> 00:00:01,000\\nHello')"
      />
    `,
  },
}));

vi.mock('@/features/subtitle-translation/components/SubtitleProgressPanel.vue', () => ({
  default: {
    template: '<div />',
  },
}));

vi.mock('@/features/subtitle-translation/components/SubtitleViewer.vue', () => ({
  default: {
    template: '<div />',
  },
}));

vi.mock('@/components/shared/LanguageSelector.vue', () => ({
  default: {
    template: '<div />',
  },
}));

vi.mock('@/components/shared/ProviderSelector.vue', () => ({
  default: {
    template: '<div />',
  },
}));

vi.mock('@/apps/options/components/ThemeSelector.vue', () => ({
  default: {
    template: '<div />',
  },
}));

vi.mock('@iconify/vue', () => ({
  Icon: {
    template: '<i />',
  },
}));

describe('SubtitleApp', () => {
  let subtitleState;

  const mountSubtitleApp = () => mount(SubtitleApp, {
    attachTo: document.body,
    global: {
      stubs: {
        transition: false,
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loggerErrorMock.mockReset();
    subtitleState = {
      status: ref('idle'),
      progress: ref({}),
      error: ref(''),
      errorAction: ref(null),
      currentFile: ref(null),
      cues: ref([]),
      startTranslation: vi.fn(),
      cancelTranslation: vi.fn(),
      downloadResult: vi.fn(),
      cleanup: vi.fn(),
    };
    useSubtitleTranslationMock.mockReturnValue(subtitleState);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        media: '(prefers-color-scheme: dark)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it('renders the decorative multicolor subtitle SVG and preserves header content/actions', async () => {
    subtitleState.status.value = 'completed';
    subtitleState.currentFile.value = { name: 'sample.srt' };
    const wrapper = mountSubtitleApp();

    await nextTick();

    const header = wrapper.find('.app-header');
    const logoImage = header.find('.logo img');
    expect(logoImage.attributes('src')).toMatch(/^data:image\/svg\+xml,/);
    expect(logoImage.attributes('alt')).toBe('');
    expect(logoImage.attributes('aria-hidden')).toBe('true');
    expect(header.find('h1').text()).toBe('Subtitle Translator');
    expect(header.find('.logo-text span').text()).toBe('Powered by Translate It');
    expect(header.text()).not.toContain('mdi:closed-caption-outline');
    expect(header.find('.report-link').text()).toContain('Report Issue');
    expect(header.find('.header-actions').exists()).toBe(true);

    wrapper.unmount();
  });

  it('opens provider settings through the anchor-aware options helper', async () => {
    openOptionsPageMock.mockResolvedValue({ success: true });
    const wrapper = mountSubtitleApp();

    await flushPromises();
    await nextTick();

    await wrapper.find('button.subtitle-dropzone-stub').trigger('click');
    await flushPromises();
    await nextTick();

    await wrapper.find('button.settings-link-btn').trigger('click');

    expect(openOptionsPageMock).toHaveBeenCalledTimes(1);
    expect(openOptionsPageMock).toHaveBeenCalledWith('providers');
  });

  it('logs when provider settings opening fails', async () => {
    openOptionsPageMock.mockResolvedValue({ success: false, error: 'failed to open' });
    const wrapper = mountSubtitleApp();

    await flushPromises();
    await nextTick();

    await wrapper.find('button.subtitle-dropzone-stub').trigger('click');
    await flushPromises();
    await nextTick();

    await wrapper.find('button.settings-link-btn').trigger('click');

    expect(openOptionsPageMock).toHaveBeenCalledWith('providers');
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to open provider settings:', 'failed to open');
  });

  it('shows only Try Again for RETRY and preserves retry behavior', async () => {
    subtitleState.status.value = 'error';
    subtitleState.error.value = 'Safe subtitle error';
    subtitleState.errorAction.value = PublicTranslationErrorActions.RETRY;

    const wrapper = mountSubtitleApp();

    await nextTick();

    expect(wrapper.findAll('.step-error button').map(button => button.text())).toEqual(['Try Again']);

    await wrapper.find('.step-error button.primary-btn').trigger('click');
    expect(subtitleState.status.value).toBe('idle');

    wrapper.unmount();
  });

  it('shows provider settings and Back to Setup for OPEN_SETTINGS', async () => {
    const selectedFile = { name: 'sample.srt' };
    const parsedCues = [{ index: 1, text: 'Hello' }];
    subtitleState.status.value = 'error';
    subtitleState.error.value = 'Provider configuration required';
    subtitleState.errorAction.value = PublicTranslationErrorActions.OPEN_SETTINGS;
    subtitleState.currentFile.value = selectedFile;
    subtitleState.cues.value = parsedCues;
    openOptionsPageMock.mockResolvedValue({ success: true });

    const wrapper = mountSubtitleApp();

    await nextTick();

    const buttons = wrapper.findAll('.step-error button');
    expect(buttons.map(button => button.text())).toEqual(['Configure Providers', 'Back to Setup']);

    await buttons[0].trigger('click');
    expect(openOptionsPageMock).toHaveBeenCalledWith('providers');

    await buttons[1].trigger('click');
    expect(subtitleState.status.value).toBe('idle');
    expect(subtitleState.currentFile.value).toEqual(selectedFile);
    expect(subtitleState.cues.value).toEqual(parsedCues);
    expect(subtitleState.cleanup).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it.each([
    [PublicTranslationErrorActions.RETRY_LATER],
    [null],
  ])('shows only Back to Setup for %s', async (action) => {
    subtitleState.status.value = 'error';
    subtitleState.error.value = 'Safe subtitle error';
    subtitleState.errorAction.value = action;

    const wrapper = mountSubtitleApp();

    await nextTick();

    const buttons = wrapper.findAll('.step-error button');
    expect(buttons.map(button => button.text())).toEqual(['Back to Setup']);
    expect(wrapper.find('.step-error button.primary-btn').exists()).toBe(false);

    await buttons[0].trigger('click');
    expect(subtitleState.status.value).toBe('idle');

    wrapper.unmount();
  });
});
