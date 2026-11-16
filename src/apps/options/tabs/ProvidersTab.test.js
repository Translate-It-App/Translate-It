import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
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

    const section = wrapper.find('#PROVIDERS_CONFIGURE_SECTION');
    expect(section.exists()).toBe(true);
    expect(section.classes()).toContain('primary-service-selection');

    const label = wrapper.find('#PROVIDERS_CONFIGURE_SECTION label');
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

describe('ProvidersTab.vue - Optimization level controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRouteQuery.value = {};
    mockSettingsStore.settings.TRANSLATION_API = 'googlev2';
    mockSettingsStore.settings.HIDDEN_PROVIDERS = [];
    delete mockSettingsStore.settings.PROVIDER_OPTIMIZATION_LEVELS;
    delete mockSettingsStore.settings.OPTIMIZATION_LEVEL;
    mockSettingsStore.activeConfigProvider = 'test-provider';
    mockUpdateSettingLocally.mockImplementation((key, value) => {
      mockSettingsStore.settings[key] = value;
    });
  });

  it('programmatically associates the visible label with the range input', () => {
    const wrapper = mountTab();
    const label = wrapper.get('#OPTIMIZATION_LEVELS_SECTION label');
    const input = wrapper.get('#PROVIDER_OPTIMIZATION_LEVEL');

    expect(input.attributes('type')).toBe('range');
    expect(label.attributes('for')).toBe(input.attributes('id'));
    expect(input.element.labels).toContain(label.element);
  });

  it.each([
    ['test-provider', ['opt_stable', 'opt_balanced', 'opt_fast'], 'optimization_description_traditional'],
    ['openai', ['opt_economy', 'opt_balanced', 'opt_turbo'], 'optimization_description_ai']
  ])('gives %s strategy buttons accessible names with level and description', async (provider, descriptions, descriptionKey) => {
    mockSettingsStore.activeConfigProvider = provider;
    const wrapper = mountTab();
    await nextTick();
    const buttons = wrapper.findAll('#OPTIMIZATION_LEVELS_SECTION .slider-labels button');

    expect(buttons).toHaveLength(5);
    expect(buttons.map((button) => [button.element.tagName, button.attributes('type'), button.attributes('aria-label')])).toEqual([
      ['BUTTON', 'button', `optimization_level_1, ${descriptions[0]}`],
      ['BUTTON', 'button', 'optimization_level_2'],
      ['BUTTON', 'button', `optimization_level_3, ${descriptions[1]}`],
      ['BUTTON', 'button', 'optimization_level_4'],
      ['BUTTON', 'button', `optimization_level_5, ${descriptions[2]}`]
    ]);
    expect(wrapper.get('#OPTIMIZATION_LEVELS_SECTION .opt-description').text()).toBe(descriptionKey);
    expect(wrapper.get('#OPTIMIZATION_LEVELS_SECTION .level-badge').text()).toBe('optimization_level_3');
  });

  it('restores tick button opacity when keyboard-focused', () => {
    const scss = readFileSync('src/apps/options/tabs/ProvidersTab.scss', 'utf8');
    const tickRules = scss.slice(scss.indexOf(':where(.slider-tick)'), scss.indexOf('\n      }', scss.indexOf(':where(.slider-tick)')));

    expect(tickRules).toMatch(/opacity:\s*0\.5/);
    expect(tickRules).toMatch(/:where\(:focus-visible\)\s*\{\s*opacity:\s*1;\s*\}/);
  });

  it.each([1, 2, 3, 4, 5])('selecting level %i updates the range and stages provider settings', async (level) => {
    const wrapper = mountTab();

    await wrapper.findAll('#OPTIMIZATION_LEVELS_SECTION .slider-labels button')[level - 1].trigger('click');

    expect(wrapper.get('#PROVIDER_OPTIMIZATION_LEVEL').element.value).toBe(String(level));
    expect(mockUpdateSettingLocally).toHaveBeenCalledWith('PROVIDER_OPTIMIZATION_LEVELS', { 'test-provider': level });
  });
});

describe('ProvidersTab.vue - Provider visibility checkbox placement & behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRouteQuery.value = {};
    mockSettingsStore.settings.TRANSLATION_API = 'googlev2';
    mockSettingsStore.settings.HIDDEN_PROVIDERS = [];
    mockSettingsStore.activeConfigProvider = 'test-provider';
    // Staging mirror, like the real store action: local state only, nothing
    // is persisted until Global Save.
    mockUpdateSettingLocally.mockImplementation((key, value) => {
      mockSettingsStore.settings[key] = value;
    });
  });

  const mountAndFindCheckbox = async () => {
    const wrapper = mountTab();
    await nextTick();
    return { wrapper, checkbox: wrapper.get('#HIDDEN_PROVIDERS_CHECKBOX input') };
  };

  it('renders the visibility checkbox bare: no new card/border/divider, modest spacing', () => {
    const scss = readFileSync('src/apps/options/tabs/ProvidersTab.scss', 'utf8');
    // No box/tint/divider rules for the visibility checkbox (bare look).
    expect(scss).not.toMatch(/\.provider-visibility-group\s*\{[^}]*background:/);
    expect(scss).not.toMatch(/\.provider-visibility-group[^{]*\{[^}]*border(?:-top)?:/);
    expect(scss).not.toMatch(/\.provider-visibility-group[^{]*\{[^}]*padding:/);
    // Modest gap to the Custom Provider List row via the existing token
    // spacing (one of the existing tokens, not a large custom value).
    const rowBlock = scss.slice(scss.indexOf('.custom-provider-list-row {'), scss.indexOf('.custom-list-row-main'));
    const marginMatch = rowBlock.match(/margin-top: \$spacing-([a-z]+);/);
    expect(marginMatch).toBeTruthy();
    expect(['xs', 'sm', 'md', 'lg']).toContain(marginMatch[1]);
    // Sanity: the drawer and manage animation styles stay untouched.
    expect(scss).toContain('.custom-list-manage-wrapper');
  });

  it('renders the visibility checkbox between the config selector and the Custom Provider List row', async () => {
    const { wrapper } = await mountAndFindCheckbox();

    const order = ['PROVIDERS_CONFIGURE_SECTION', 'HIDDEN_PROVIDERS_CHECKBOX', 'CUSTOM_PROVIDER_LIST', 'OPTIMIZATION_LEVELS_SECTION'];
    const nodes = order.map((id) => wrapper.element.querySelector(`#${id}`));
    expect(nodes).not.toContain(null);
    for (let i = 0; i < nodes.length - 1; i++) {
      expect(nodes[i].compareDocumentPosition(nodes[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('keeps the checkbox stable across provider switches (outside the keyed panel)', async () => {
    const { wrapper, checkbox } = await mountAndFindCheckbox();

    // The keyed fade-slide panel no longer hosts this row.
    expect(checkbox.element.closest('.provider-settings')).toBeNull();
    await wrapper.find('.provider-selector-stub').setValue('other-provider');
    await nextTick();
    expect(wrapper.get('#HIDDEN_PROVIDERS_CHECKBOX input').element === checkbox.element).toBe(true);
  });

  it('labels the checkbox through the existing i18n key (fallback text updated)', async () => {
    const { wrapper } = await mountAndFindCheckbox();

    const label = wrapper.get('#HIDDEN_PROVIDERS_CHECKBOX label');
    expect(label.text()).toBe('show_provider_in_list_label');
    expect(wrapper.text()).not.toContain('Show in provider list');
  });

  it('follows the selected provider states: toggling stages exactly the target ID', async () => {
    mockSettingsStore.settings.HIDDEN_PROVIDERS = ['test-provider'];
    const { wrapper, checkbox } = await mountAndFindCheckbox();

    // test-provider is hidden: the checkbox reflects it.
    expect(checkbox.element.checked).toBe(false);

    // Switch config panel to another provider: visible by default.
    await wrapper.find('.provider-selector-stub').setValue('other-provider');
    await nextTick();
    expect(wrapper.get('#HIDDEN_PROVIDERS_CHECKBOX input').element.checked).toBe(true);

    // Hiding stages only that ID on top of the existing list.
    await wrapper.get('#HIDDEN_PROVIDERS_CHECKBOX input').setValue(false);
    expect(mockUpdateSettingLocally).toHaveBeenCalledWith('HIDDEN_PROVIDERS', ['test-provider', 'other-provider']);
    expect(mockSettingsStore.settings.TRANSLATION_API).toBe('googlev2');
    expect(mockSettingsStore.activeConfigProvider).toBe('other-provider');

    // Back to the first provider: its hidden state persisted through the switch.
    await wrapper.find('.provider-selector-stub').setValue('test-provider');
    await nextTick();
    expect(wrapper.get('#HIDDEN_PROVIDERS_CHECKBOX input').element.checked).toBe(false);

    // Unhiding it stages the list without the target ID.
    await wrapper.get('#HIDDEN_PROVIDERS_CHECKBOX input').setValue(true);
    expect(mockUpdateSettingLocally).toHaveBeenLastCalledWith('HIDDEN_PROVIDERS', ['other-provider']);
  });

  it('stages no persistence writes for the toggle (only the local HIDDEN_PROVIDERS key)', async () => {
    const { wrapper } = await mountAndFindCheckbox();

    await wrapper.get('#HIDDEN_PROVIDERS_CHECKBOX input').setValue(false);
    const keys = mockUpdateSettingLocally.mock.calls.map((call) => call[0]);
    expect(keys).toEqual(['HIDDEN_PROVIDERS']);
  });
});
