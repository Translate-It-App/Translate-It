import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick, reactive, ref } from 'vue';
import ProvidersTab from './ProvidersTab.vue';

// Mock vue-router (useRoute for the tab, useRouter for useHighlightManager)
const currentRouteQuery = ref({});
vi.mock('vue-router', () => ({
  useRoute: () => ({
    query: currentRouteQuery.value
  }),
  useRouter: () => ({
    push: vi.fn()
  })
}));

// Mock unified i18n with identity translation so raw keys are observable
vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key) => key
  })
}));

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key) => key
  })
}));

// Mock settings store: config-panel selection only, global API fixed
const mockUpdateSettingLocally = vi.fn();
const mockSettingsStore = reactive({
  settings: {
    TRANSLATION_API: 'googlev2',
    HIDDEN_PROVIDERS: []
  },
  activeConfigProvider: 'test-provider',
  updateSettingLocally: mockUpdateSettingLocally
});

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => mockSettingsStore
}));

// Stub ProviderSelector: v-model passthrough without provider internals
vi.mock('@/components/shared/ProviderSelector.vue', () => ({
  default: {
    name: 'ProviderSelector',
    props: {
      modelValue: { type: String, default: '' }
    },
    emits: ['update:modelValue'],
    template: '<select class="provider-selector-stub" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option value="test-provider">test</option><option value="other-provider">other</option></select>'
  }
}));

// Mock highlight manager with hoisted spies: reveal assertions observe
// activeConfigProvider synchronously on mount (OptionsLayout owns
// checkAndHighlight execution, so it must stay uncalled here), while
// missing-highlight assertions use fake timers to flush the watcher's
// 600ms window with no real-wait fragility.
const highlightMocks = vi.hoisted(() => ({
  checkAndHighlight: vi.fn(),
  highlightElement: vi.fn()
}));
vi.mock('../composables/useHighlightManager.js', () => ({
  useHighlightManager: () => highlightMocks
}));

// Mock logger to avoid console noise
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn()
  })
}));

const mountedWrappers = [];
const mountTab = () => {
  const wrapper = mount(ProvidersTab);
  mountedWrappers.push(wrapper);
  return wrapper;
};

afterEach(async () => {
  await vi.dynamicImportSettled();
  await flushPromises();
  while (mountedWrappers.length) mountedWrappers.pop().unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ProvidersTab.vue - Config-panel selector labeling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRouteQuery.value = {};
    mockSettingsStore.settings.TRANSLATION_API = 'googlev2';
    mockSettingsStore.settings.HIDDEN_PROVIDERS = [];
    mockSettingsStore.activeConfigProvider = 'test-provider';
  });

  it('renders the ProvidersTab-specific label key, not the shared global key', () => {
    const wrapper = mountTab();

    const label = wrapper.find('.primary-service-selection label');
    expect(label.exists()).toBe(true);
    expect(label.text()).toBe('providers_configure_label');
    expect(label.text()).not.toBe('translation_api_label');
  });

  it('selector change updates activeConfigProvider and leaves TRANSLATION_API untouched', async () => {
    const wrapper = mountTab();

    await wrapper.find('.provider-selector-stub').setValue('other-provider');
    await flushPromises();

    expect(mockSettingsStore.activeConfigProvider).toBe('other-provider');
    expect(mockSettingsStore.settings.TRANSLATION_API).toBe('googlev2');
  });

  it('computed selector reflects the store-managed config provider', async () => {
    const wrapper = mountTab();

    expect(wrapper.find('.provider-selector-stub').element.value).toBe('test-provider');

    mockSettingsStore.activeConfigProvider = 'other-provider';
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.provider-selector-stub').element.value).toBe('other-provider');
    expect(mockSettingsStore.settings.TRANSLATION_API).toBe('googlev2');
  });

  it('routes ?highlight=CUSTOM_API_COMPATIBILITY_CHECK to the custom provider', async () => {
    vi.useFakeTimers();
    currentRouteQuery.value = { highlight: 'CUSTOM_API_COMPATIBILITY_CHECK' };
    mountTab();
    await nextTick();

    expect(mockSettingsStore.activeConfigProvider).toBe('custom');
    vi.advanceTimersByTime(1000);
  });

  it('route-driven compat-check switch does NOT trigger the CUSTOM_API_URL missing-highlight', async () => {
    vi.useFakeTimers();
    currentRouteQuery.value = { highlight: 'CUSTOM_API_COMPATIBILITY_CHECK' };
    mountTab();
    await nextTick();

    expect(mockSettingsStore.activeConfigProvider).toBe('custom');
    // Flush the watcher's 600ms missing-highlight window: the suppressed
    // watcher must stay silent (spotlight execution belongs to OptionsLayout).
    vi.advanceTimersByTime(1000);
    expect(highlightMocks.highlightElement).not.toHaveBeenCalledWith('CUSTOM_API_URL');
    expect(highlightMocks.highlightElement).not.toHaveBeenCalled();
  });

  it('manual provider change still highlights the first missing setting', async () => {
    vi.useFakeTimers();
    mountTab();
    await nextTick();
    expect(highlightMocks.highlightElement).not.toHaveBeenCalled();

    mockSettingsStore.activeConfigProvider = 'custom';
    await nextTick();
    vi.advanceTimersByTime(600);

    expect(highlightMocks.highlightElement).toHaveBeenCalledWith('CUSTOM_API_URL');
  });

  it('pre-active custom route load leaks no suppression into the next manual change', async () => {
    vi.useFakeTimers();
    mockSettingsStore.activeConfigProvider = 'custom';
    currentRouteQuery.value = { highlight: 'CUSTOM_API_COMPATIBILITY_CHECK' };
    mountTab();
    await nextTick();

    expect(mockSettingsStore.activeConfigProvider).toBe('custom');
    vi.advanceTimersByTime(1000);
    expect(highlightMocks.highlightElement).not.toHaveBeenCalled();

    // A later manual change must highlight normally (no leaked suppression).
    mockSettingsStore.activeConfigProvider = 'deepl';
    await nextTick();
    vi.advanceTimersByTime(600);

    expect(highlightMocks.highlightElement).toHaveBeenCalledWith('DEEPL_API_KEY');
  });

  it('while-mounted highlight navigation reveals its provider without executing the spotlight', async () => {
    vi.useFakeTimers();
    mountTab();
    await nextTick();
    expect(mockSettingsStore.activeConfigProvider).toBe('test-provider');

    // In-place mutation: the vue-router mock snapshots `query` at useRoute()
    // time, so a same-object update is how a while-mounted navigation is
    // simulated (the watcher shape is identical for real-router updates).
    currentRouteQuery.value.highlight = 'CUSTOM_API_COMPATIBILITY_CHECK';
    await nextTick();

    expect(mockSettingsStore.activeConfigProvider).toBe('custom');
    vi.advanceTimersByTime(1000);
    expect(highlightMocks.highlightElement).not.toHaveBeenCalled();
    expect(highlightMocks.checkAndHighlight).not.toHaveBeenCalled();
  });

  it('never executes route-driven spotlight itself (OptionsLayout owns checkAndHighlight)', async () => {
    vi.useFakeTimers();
    currentRouteQuery.value = { highlight: 'CUSTOM_API_COMPATIBILITY_CHECK' };
    mountTab();
    await nextTick();
    vi.advanceTimersByTime(2000);

    currentRouteQuery.value.highlight = 'DEEPL_API_KEY';
    await nextTick();
    vi.advanceTimersByTime(2000);

    expect(mockSettingsStore.activeConfigProvider).toBe('deepl');
    expect(highlightMocks.checkAndHighlight).not.toHaveBeenCalled();
  });

  it('keeps existing required-setting highlight routing unchanged', async () => {
    vi.useFakeTimers();
    currentRouteQuery.value = { highlight: 'DEEPL_API_KEY' };
    mountTab();
    await nextTick();

    expect(mockSettingsStore.activeConfigProvider).toBe('deepl');
    // Required-setting routes keep the watcher's missing-highlight path.
    vi.advanceTimersByTime(600);
    expect(highlightMocks.highlightElement).toHaveBeenCalledWith('DEEPL_API_KEY');
  });

  it('leaves custom provider validation metadata unmodified', async () => {
    const { getProviderManifest } = await import('@/features/translation/providers/ProviderManifest.js');
    const custom = getProviderManifest().find((p) => p.id === 'custom');

    expect(custom.requiredSettings).toEqual(['CUSTOM_API_URL', 'CUSTOM_API_MODEL']);
    expect(custom.requiredSettings).not.toContain('CUSTOM_API_COMPATIBILITY_CHECK');
  });
});

describe('ProvidersTab.vue - Live Dubbing provider separation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRouteQuery.value = {};
    mockSettingsStore.settings.TRANSLATION_API = 'google';
    mockSettingsStore.settings.HIDDEN_PROVIDERS = [];
    mockSettingsStore.activeConfigProvider = 'google';
  });

  it('keeps translation provider selection independent of LIVE_DUBBING_PROVIDER', () => {
    const wrapper = mountTab();

    expect(wrapper.find('.primary-service-selection').exists()).toBe(true);
    // LIVE_DUBBING_PROVIDER was removed from the Providers UI; its persistence
    // and selection live behind the dedicated Live Dubbing control in Popup.
    expect(wrapper.find('#LIVE_DUBBING_PROVIDER').exists()).toBe(false);
    expect(mockSettingsStore.settings.TRANSLATION_API).toBe('google');
  });
});
