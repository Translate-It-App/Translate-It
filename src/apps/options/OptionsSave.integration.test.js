import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ref, nextTick } from 'vue';
import { useSettingsStore } from '@/features/settings/stores/settings.js';
import { CONFIG } from '@/shared/config/config.js';
import PromptTab from './tabs/PromptTab.vue';
import TTSTab from './tabs/TTSTab.vue';
import ProvidersTab from './tabs/ProvidersTab.vue';
import OptionsNavigation from '@/components/layout/OptionsNavigation.vue';

/**
 * Options save integration suite (issue #202, parts B+C follow-up).
 *
 * Real Pinia + real useSettingsStore + real PromptTab/TTSTab/OptionsNavigation.
 * Only the browser boundary (storageManager) and external services are faked.
 * A "reload" is always: unmount everything, fresh Pinia, fresh store,
 * loadSettings(), remount — never a same-store remount.
 */

// ---------------------------------------------------------------------------
// Simulated browser storage boundary with KEY-MERGE semantics.
// set() merges the payload into persisted data (like browser.storage.local);
// get() reads it back for loadSettings(). Deterministic promise control only:
// no timers, no sleeps.
// ---------------------------------------------------------------------------
const fakeBrowserStorage = vi.hoisted(() => ({
  data: {},
  gate: null,
  writeCalls: []
}));

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: {
    get: vi.fn(async (keys) => {
      const data = fakeBrowserStorage.data;
      if (keys === null || keys === undefined) {
        return JSON.parse(JSON.stringify(data));
      }
      if (typeof keys === 'string') {
        return keys in data ? { [keys]: JSON.parse(JSON.stringify(data[keys])) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((key) => {
          if (key in data) out[key] = JSON.parse(JSON.stringify(data[key]));
        });
        return out;
      }
      const out = {};
      Object.keys(keys).forEach((key) => {
        out[key] = key in data
          ? JSON.parse(JSON.stringify(data[key]))
          : keys[key];
      });
      return out;
    }),
    set: vi.fn(async (payload) => {
      const snapshot = JSON.parse(JSON.stringify(payload));
      fakeBrowserStorage.writeCalls.push(snapshot);
      if (fakeBrowserStorage.gate) {
        await fakeBrowserStorage.gate;
      }
      Object.assign(fakeBrowserStorage.data, snapshot);
      return true;
    }),
    clear: vi.fn(async () => {
      Object.keys(fakeBrowserStorage.data).forEach((key) => {
        delete fakeBrowserStorage.data[key];
      });
      return true;
    }),
    on: vi.fn(),
    off: vi.fn()
  }
}));

vi.mock('@/shared/storage/core/SecureStorage.js', () => ({
  default: {
    prepareForExport: vi.fn().mockResolvedValue({ encrypted: 'data' }),
    processImportedSettings: vi.fn().mockResolvedValue({})
  }
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: vi.fn().mockReturnValue(false),
    handleContextError: vi.fn(),
    isContentScript: vi.fn().mockReturnValue(false)
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn()
  })
}));

vi.mock('@/shared/config/settingsMigrations.js', () => ({
  runSettingsMigrations: vi.fn().mockResolvedValue({ updates: {}, logs: [], removals: [] })
}));

// Identity i18n (keys render as-is; status assertions use CSS classes).
vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key) => key,
    locale: ref('en')
  })
}));

// Router stubs (no full app/router in this suite).
const pushMock = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
    currentRoute: { value: { name: 'prompt' } }
  }),
  useRoute: () => ({
    name: 'prompt',
    query: {}
  })
}));

// ProvidersTab's drawer is driven through the OptionSlot picker stub below;
// base components, the real ProviderSelector-adjacent layers and the store
// stay real while the selection-only picker contract is held by the stub.
vi.mock('@/components/shared/ProviderSelector.vue', () => ({
  default: {
    name: 'ProviderSelector',
    props: ['modelValue', 'selectionOnly', 'excludeIds'],
    emits: ['update:modelValue'],
    template: '<select class="provider-picker-stub" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option value=""/><option value="deepl"/><option value="openai"/></select>'
  }
}));

// Background notification boundary for the Global Save flow.
const { safeSendMessageMock } = vi.hoisted(() => ({
  safeSendMessageMock: vi.fn()
}));
vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  safeSendMessage: safeSendMessageMock
}));

// TTS external-service boundaries (drawer UI + store stay real).
vi.mock('@/composables/shared/useLanguages.js', async () => {
  const { ref: vueRef } = await import('vue');
  return {
    useLanguages: () => ({
      isLoaded: vueRef(true),
      translationLanguages: vueRef([{ code: 'en', name: 'English' }]),
      loadLanguages: vi.fn().mockResolvedValue()
    })
  };
});

vi.mock('@/features/tts/composables/useTTSSmart.js', async () => {
  const { ref: vueRef } = await import('vue');
  return {
    useTTSSmart: () => ({
      speak: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(),
      isPlaying: vueRef(false),
      isLoading: vueRef(false)
    })
  };
});

vi.mock('@/features/tts/services/TTSVoiceService.js', () => ({
  ttsVoiceService: {
    getVoices: vi.fn().mockResolvedValue([
      {
        Locale: 'en-US',
        Gender: 'Female',
        ShortName: 'en-US-AriaNeural',
        FriendlyName: 'Microsoft Aria Online (Natural)'
      }
    ])
  }
}));

vi.mock('@/features/tts/services/TTSLanguageService.js', () => ({
  TTSLanguageService: {
    supportsLanguage: vi.fn().mockReturnValue(true)
  }
}));

// ---------------------------------------------------------------------------
// Harness: fresh store instances, tracked mounts, Global Save driver.
// ---------------------------------------------------------------------------
let mountedWrappers = [];

const track = (wrapper) => {
  mountedWrappers.push(wrapper);
  return wrapper;
};

const unmountAll = () => {
  mountedWrappers.forEach((wrapper) => {
    try {
      wrapper.unmount();
    } catch {
      // Already unmounted; ignore.
    }
  });
  mountedWrappers = [];
};

const freshStore = async () => {
  setActivePinia(createPinia());
  const store = useSettingsStore();
  await store.loadSettings();
  await nextTick();
  return store;
};

const reloadStore = async () => {
  unmountAll();
  return freshStore();
};

const mountTab = (component) => track(mount(component, {
  global: {
    stubs: {
      RouterLink: true,
      transition: { template: '<div><slot /></div>' }
    },
    mocks: {
      $route: { name: 'prompt' }
    }
  }
}));

const clickGlobalSave = async (nav) => {
  await nav.find('#saveSettings').trigger('click');
  await flushPromises();
};

const saveStatusClass = (nav) => nav.find('#status').classes();

describe('Options save integration (store + tabs + Global Save)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeBrowserStorage.data = {};
    fakeBrowserStorage.gate = null;
    fakeBrowserStorage.writeCalls = [];
    pushMock.mockReset();
    safeSendMessageMock.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    unmountAll();
  });

  it('(1) selector round trip persists across a fresh reload', async () => {
    const store = await freshStore();
    expect(store.validateSettings().isValid).toBe(true);

    const tab = mountTab(PromptTab);
    const nav = mountTab(OptionsNavigation);

    await tab.find('#prompt-type-select').setValue('PROMPT_TEMPLATE_AUTO');
    expect(store.settings.PROMPT_EDITOR_SELECTED_KEY).toBe('PROMPT_TEMPLATE_AUTO');

    await clickGlobalSave(nav);
    expect(saveStatusClass(nav)).toContain('status-success');
    expect(fakeBrowserStorage.data.PROMPT_EDITOR_SELECTED_KEY).toBe('PROMPT_TEMPLATE_AUTO');

    await reloadStore();
    const reloadedTab = mountTab(PromptTab);
    expect(reloadedTab.find('#prompt-type-select').element.value).toBe('PROMPT_TEMPLATE_AUTO');
  });

  it('(2) valid prompt edit round trip persists across a fresh reload', async () => {
    await freshStore();
    const tab = mountTab(PromptTab);
    const nav = mountTab(OptionsNavigation);

    const custom = 'Custom intro $_{SOURCE} $_{TARGET} body $_{TEXT}';
    await tab.find('.prompt-template-input textarea').setValue(custom);

    await clickGlobalSave(nav);
    expect(saveStatusClass(nav)).toContain('status-success');
    expect(fakeBrowserStorage.data.PROMPT_TEMPLATE).toBe(custom);

    await reloadStore();
    const reloadedTab = mountTab(PromptTab);
    expect(reloadedTab.find('.prompt-template-input textarea').element.value).toBe(custom);
  });

  it('(3) invalid prompt triggers partial save: valid persists, invalid kept as draft', async () => {
    // Seed the last-valid persisted template the partial save falls back to.
    const lastValid = 'LAST VALID $_{SOURCE} $_{TARGET} $_{PROMPT_INSTRUCTIONS} $_{TEXT}';
    fakeBrowserStorage.data.PROMPT_BASE_FIELD = lastValid;

    const store = await freshStore();
    expect(store.settings.PROMPT_BASE_FIELD).toBe(lastValid);

    const tab = mountTab(PromptTab);
    const nav = mountTab(OptionsNavigation);

    // Valid selection change plus an invalid edit of the selected template,
    // alongside an unrelated staged normal setting via the real store API.
    await tab.find('#prompt-type-select').setValue('PROMPT_BASE_FIELD');
    await tab.find('.prompt-template-input textarea').setValue('broken template without placeholders');
    store.updateSettingLocally('TARGET_LANGUAGE', 'fa');

    await clickGlobalSave(nav);

    // Warning status, not success.
    expect(saveStatusClass(nav)).toContain('status-warning');
    // Invalid template never overwrote the last valid persisted value.
    expect(fakeBrowserStorage.data.PROMPT_BASE_FIELD).toBe(lastValid);
    // The valid selection change persisted in the same operation.
    expect(fakeBrowserStorage.data.PROMPT_EDITOR_SELECTED_KEY).toBe('PROMPT_BASE_FIELD');
    // The unrelated staged normal setting persisted despite the prompt failure.
    expect(fakeBrowserStorage.data.TARGET_LANGUAGE).toBe('fa');
    // Invalid draft retained in UI and store.
    expect(store.settings.PROMPT_BASE_FIELD).toBe('broken template without placeholders');
    expect(tab.find('.prompt-template-input textarea').element.value)
      .toBe('broken template without placeholders');
  });

  it('(4) mixed prompt edit plus selector change persist in a single Save', async () => {
    const store = await freshStore();
    const tab = mountTab(PromptTab);
    const nav = mountTab(OptionsNavigation);

    await tab.find('#prompt-type-select').setValue('PROMPT_TEMPLATE_AUTO');
    const customAuto = 'Auto says $_{TARGET} with $_{TEXT} done';
    await tab.find('.prompt-template-input textarea').setValue(customAuto);
    // Unrelated staged setting via the real store local-update API (no
    // LanguagesTab mount: the target is the Global Save boundary, not input).
    store.updateSettingLocally('TARGET_LANGUAGE', 'fa');

    await clickGlobalSave(nav);
    expect(saveStatusClass(nav)).toContain('status-success');
    expect(fakeBrowserStorage.data.PROMPT_TEMPLATE_AUTO).toBe(customAuto);
    expect(fakeBrowserStorage.data.PROMPT_EDITOR_SELECTED_KEY).toBe('PROMPT_TEMPLATE_AUTO');
    expect(fakeBrowserStorage.data.TARGET_LANGUAGE).toBe('fa');

    const reloadedStore = await reloadStore();
    const reloadedTab = mountTab(PromptTab);
    expect(reloadedTab.find('#prompt-type-select').element.value).toBe('PROMPT_TEMPLATE_AUTO');
    expect(reloadedTab.find('.prompt-template-input textarea').element.value).toBe(customAuto);
    expect(reloadedStore.settings.TARGET_LANGUAGE).toBe('fa');
  });

  it('(5) TTS drawer Done stages locally with zero writes; Save persists; reload restores', async () => {
    const store = await freshStore();
    const tts = mountTab(TTSTab);
    const nav = mountTab(OptionsNavigation);

    await tts.find('#TTS_MANAGE_VOICES_BTN').trigger('click');
    await flushPromises();
    await tts.find('.voice-select-dropdown').setValue('en-US-AriaNeural');
    await tts.find('.drawer-footer-actions button').trigger('click');
    await flushPromises();

    // Staged locally, nothing written to the browser boundary.
    expect(fakeBrowserStorage.writeCalls).toHaveLength(0);
    expect(store.settings.TTS_PREFERRED_VOICES).toEqual({
      en: { edge: 'en-US-AriaNeural', google: 'default' }
    });

    await clickGlobalSave(nav);
    expect(saveStatusClass(nav)).toContain('status-success');
    expect(fakeBrowserStorage.data.TTS_PREFERRED_VOICES).toEqual({
      en: { edge: 'en-US-AriaNeural', google: 'default' }
    });

    const reloadedStore = await reloadStore();
    expect(reloadedStore.settings.TTS_PREFERRED_VOICES).toEqual({
      en: { edge: 'en-US-AriaNeural', google: 'default' }
    });
    const reloadedTts = mountTab(TTSTab);
    await reloadedTts.find('#TTS_MANAGE_VOICES_BTN').trigger('click');
    await flushPromises();
    expect(reloadedTts.find('.voice-select-dropdown').element.value).toBe('en-US-AriaNeural');
  });

  it('(6) Providers custom list stages the row checkbox and drawer ids with zero writes; Save persists; reload restores', async () => {
    const store = await freshStore();
    const tab = mountTab(ProvidersTab);
    const nav = mountTab(OptionsNavigation);

    // Enable is staged directly from the row (outside the drawer).
    await tab.find('#CUSTOM_PROVIDER_LIST_ENABLED input').setValue(true);
    expect(store.settings.CUSTOM_PROVIDER_LIST_ENABLED).toBe(true);
    expect(fakeBrowserStorage.writeCalls).toHaveLength(0);

    await tab.find('#CUSTOM_PROVIDER_LIST_MANAGE_BTN').trigger('click');
    await flushPromises();

    const drawer = tab.get('#CUSTOM_PROVIDER_LIST_DRAWER');
    expect(drawer.attributes('role')).toBe('dialog');

    // Stage: add two providers through the (stubbed) selection-only picker.
    await tab.get('.custom-list-add-row .provider-picker-stub').setValue('deepl');
    await tab.get('.custom-list-add-btn').trigger('click');
    await tab.get('.custom-list-add-row .provider-picker-stub').setValue('openai');
    await tab.get('.custom-list-add-btn').trigger('click');

    // Draft-local: still nothing written to the browser boundary, and the
    // store list only gains the ids once Done stages them.
    expect(fakeBrowserStorage.writeCalls).toHaveLength(0);

    // Done stages the ids only; the checkbox already staged the enable state.
    await drawer.get('.custom-list-drawer-footer button').trigger('click');
    await flushPromises();
    expect(store.settings.CUSTOM_PROVIDER_LIST_ENABLED).toBe(true);
    expect(store.settings.CUSTOM_PROVIDER_LIST).toEqual(['deepl', 'openai']);

    await clickGlobalSave(nav);
    expect(saveStatusClass(nav)).toContain('status-success');
    expect(fakeBrowserStorage.data.CUSTOM_PROVIDER_LIST_ENABLED).toBe(true);
    expect(fakeBrowserStorage.data.CUSTOM_PROVIDER_LIST).toEqual(['deepl', 'openai']);

    const reloadedStore = await reloadStore();
    expect(reloadedStore.settings.CUSTOM_PROVIDER_LIST_ENABLED).toBe(true);
    expect(reloadedStore.settings.CUSTOM_PROVIDER_LIST).toEqual(['deepl', 'openai']);
    const reloadedTab = mountTab(ProvidersTab);
    expect(reloadedTab.find('#CUSTOM_PROVIDER_LIST_ENABLED input').element.checked).toBe(true);
    await reloadedTab.find('#CUSTOM_PROVIDER_LIST_MANAGE_BTN').trigger('click');
    await flushPromises();
    expect(reloadedTab.get('#CUSTOM_PROVIDER_LIST_DRAWER').findAll('.custom-list-entry')).toHaveLength(2);
  });

  it('(6b) relocated provider visibility checkbox stages HIDDEN_PROVIDERS; Save persists the exact ID; reload restores', async () => {
    const store = await freshStore();
    const tab = mountTab(ProvidersTab);
    const nav = mountTab(OptionsNavigation);

    // Relocated placement: the checkbox is a direct child of the settings
    // container, above the Custom Provider List row.
    const order = ['PROVIDERS_CONFIGURE_SECTION', 'HIDDEN_PROVIDERS_CHECKBOX', 'CUSTOM_PROVIDER_LIST'];
    const nodes = order.map((id) => tab.element.querySelector(`#${id}`));
    expect(nodes).not.toContain(null);
    for (let i = 0; i < nodes.length - 1; i++) {
      expect(nodes[i].compareDocumentPosition(nodes[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(nodes[1].querySelector('input').checked).toBe(true);

    // Hide the active/default config provider ('edge'); staging is local.
    await tab.get('#HIDDEN_PROVIDERS_CHECKBOX input').setValue(false);
    expect(store.settings.TRANSLATION_API).toBe('edge');
    expect(fakeBrowserStorage.writeCalls).toHaveLength(0);

    await clickGlobalSave(nav);
    expect(saveStatusClass(nav)).toContain('status-success');
    expect(fakeBrowserStorage.data.HIDDEN_PROVIDERS).toEqual([...CONFIG.HIDDEN_PROVIDERS, 'edge']);

    const reloadedStore = await reloadStore();
    expect(reloadedStore.settings.HIDDEN_PROVIDERS).toEqual([...CONFIG.HIDDEN_PROVIDERS, 'edge']);
    const reloadedTab = mountTab(ProvidersTab);
    expect(reloadedTab.get('#HIDDEN_PROVIDERS_CHECKBOX input').element.checked).toBe(false);
  });

  it('(7) save in flight survives unmount: write started before resolve, visible after reload', async () => {
    await freshStore();
    const tab = mountTab(PromptTab);
    const nav = mountTab(OptionsNavigation);

    await tab.find('#prompt-type-select').setValue('PROMPT_TEMPLATE_AUTO');

    // Hold the browser write open; the save must still start without timers.
    let releaseWrite;
    fakeBrowserStorage.gate = new Promise((resolve) => { releaseWrite = resolve; });

    await nav.find('#saveSettings').trigger('click');
    await flushPromises();

    // Write started (call recorded with the new value) but not yet merged.
    expect(fakeBrowserStorage.writeCalls).toHaveLength(1);
    expect(fakeBrowserStorage.writeCalls[0].PROMPT_EDITOR_SELECTED_KEY).toBe('PROMPT_TEMPLATE_AUTO');
    expect(fakeBrowserStorage.data.PROMPT_EDITOR_SELECTED_KEY).not.toBe('PROMPT_TEMPLATE_AUTO');

    // Tear down mid-flight, then let the write land.
    unmountAll();
    releaseWrite();
    await flushPromises();
    await flushPromises();

    const reloadedStore = await reloadStore();
    expect(reloadedStore.settings.PROMPT_EDITOR_SELECTED_KEY).toBe('PROMPT_TEMPLATE_AUTO');
    const reloadedTab = mountTab(PromptTab);
    expect(reloadedTab.find('#prompt-type-select').element.value).toBe('PROMPT_TEMPLATE_AUTO');
  });
});
