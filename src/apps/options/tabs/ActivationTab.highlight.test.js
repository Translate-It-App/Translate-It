import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ActivationTab from './ActivationTab.vue';
import { useHighlightManager } from '../composables/useHighlightManager.js';

const mocks = vi.hoisted(() => ({
  route: { query: {} },
  router: { replace: vi.fn() },
  settingRefs: {},
  settingsStore: {
    settings: { WHOLE_PAGE_AUTO_TRANSLATE_RULES: [] },
    updateSettingLocally: vi.fn(),
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => mocks.router,
}));

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => mocks.settingsStore,
}));

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (key) => key }),
}));

vi.mock('../composables/useTabSettings.js', async () => {
  const { ref } = await import('vue');
  return {
    useTabSettings: () => ({
      createSetting: (key, defaultValue) => {
        const setting = ref(key === 'WHOLE_PAGE_TRANSLATION_ENABLED' ? false : defaultValue);
        mocks.settingRefs[key] = setting;
        return setting;
      },
      createProviderSetting: () => ref(''),
    }),
  };
});

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/utils/browser/compatibility.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectOS: () => 'linux' };
});

vi.mock('@/shared/config/config.js', () => ({
  CONFIG: { CONTEXT_MENU_VISIBILITY: {}, TRANSLATE_ON_TEXT_SELECTION: true, MOUSE_HOVER_TRIGGER: 'primary' },
  TranslationMode: {
    Field: 'field', Select_Element: 'select-element', Selection: 'selection',
    Page: 'page', MouseHover: 'mouse-hover',
  },
  SelectionTranslationMode: { IMMEDIATE: 'immediate', ON_CLICK: 'on-click', ON_FAB_CLICK: 'on-fab-click' },
}));

vi.mock('@/shared/logging/logConstants.js', () => ({ LOG_COMPONENTS: { UI: 'ui' } }));

describe('ActivationTab highlight reveal', () => {
  let wrapper;

  beforeEach(() => {
    mocks.route.query = { highlight: 'WHOLE_PAGE_AUTO_TRANSLATE_RULES' };
    mocks.router.replace.mockReset();
    mocks.settingRefs = {};
    mocks.settingsStore.settings = { WHOLE_PAGE_AUTO_TRANSLATE_RULES: [] };
    mocks.settingsStore.updateSettingLocally.mockReset();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    delete window.HTMLElement.prototype.scrollIntoView;
  });

  it('reveals rules while Whole Page Translation remains disabled', async () => {
    wrapper = shallowMount(ActivationTab, {
      global: {
        stubs: {
          BaseFieldset: {
            props: ['id', 'legend'],
            template: '<fieldset :id="id"><slot name="header"/><slot/></fieldset>',
          },
          BaseButton: { template: '<button><slot/></button>' },
        },
      },
    });
    await nextTick();

    const target = wrapper.get('#WHOLE_PAGE_AUTO_TRANSLATE_RULES');
    const group = target.element.closest('.sub-options-group');
    expect(group.classList.contains('open')).toBe(false);
    expect(mocks.settingRefs.WHOLE_PAGE_TRANSLATION_ENABLED.value).toBe(false);

    await useHighlightManager().checkAndHighlight();

    expect(group.classList.contains('open')).toBe(true);
    expect(mocks.settingRefs.WHOLE_PAGE_TRANSLATION_ENABLED.value).toBe(false);
    expect(mocks.settingsStore.updateSettingLocally).not.toHaveBeenCalled();
    expect(mocks.router.replace).toHaveBeenCalledWith({ query: {} });
  });
});
