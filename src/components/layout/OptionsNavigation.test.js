import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, reactive, computed } from 'vue';
import OptionsNavigation from './OptionsNavigation.vue';
import { storageManager } from '@/shared/storage/core/StorageCore.js';

// Mock vue-router
const pushMock = vi.fn();
const currentRouteName = ref('languages');
const currentRouteFullPath = ref('/languages');
const locale = ref('en');
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
    currentRoute: computed(() => ({ name: currentRouteName.value, fullPath: currentRouteFullPath.value }))
  })
}));

// Mock useUnifiedI18n composable
vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key) => key,
    locale
  })
}));

// Mock settings store
const mockValidateSettings = vi.fn();
const mockSaveSettings = vi.fn();
const mockSettingsStore = reactive({
  settings: {
    TRANSLATION_API: 'google',
    MODE_PROVIDERS: {},
    PROMPT_TEMPLATE: 'valid template $_{SOURCE} $_{TARGET} $_{TEXT}'
  },
  validateSettings: mockValidateSettings,
  saveAllSettings: mockSaveSettings
});

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => mockSettingsStore
}));

// Mock safeSendMessage
const { safeSendMessageMock } = vi.hoisted(() => ({
  safeSendMessageMock: vi.fn()
}))
vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  safeSendMessage: safeSendMessageMock
}));

// Mock storageManager safely
vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: {
    get: vi.fn(),
    set: vi.fn()
  }
}));

describe('OptionsNavigation.vue - Save Validation UX & Partial Save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRouteName.value = 'languages';
    currentRouteFullPath.value = '/languages';
    mockSettingsStore.settings = {
      TRANSLATION_API: 'google',
      MODE_PROVIDERS: {},
      PROMPT_TEMPLATE: 'original valid template $_{SOURCE} $_{TARGET} $_{TEXT}'
    };
    
    vi.mocked(storageManager.get).mockResolvedValue({
      PROMPT_TEMPLATE: 'last persisted template $_{SOURCE} $_{TARGET} $_{TEXT}'
    });
    vi.mocked(storageManager.set).mockResolvedValue(true);
    mockSaveSettings.mockResolvedValue(true);
    safeSendMessageMock.mockResolvedValue({ success: true });
  });

  it('valid settings allows save successfully', async () => {
    mockValidateSettings.mockReturnValue({ isValid: true, errors: [] });
    const savedEventListener = vi.fn();
    window.addEventListener('options-settings-saved', savedEventListener);
    
    const wrapper = mount(OptionsNavigation, {
      global: {
        stubs: {
          RouterLink: true
        },
        mocks: {
          $route: {
            name: 'languages'
          }
        }
      }
    });

    const saveButton = wrapper.find('#saveSettings');
    expect(saveButton.exists()).toBe(true);
    
    await saveButton.trigger('click');
    await flushPromises();
    
    expect(mockValidateSettings).toHaveBeenCalled();
    expect(mockSaveSettings).toHaveBeenCalled();
    expect(safeSendMessageMock).toHaveBeenCalledWith(
      {
        action: 'SETTINGS_UPDATED',
        timestamp: expect.any(Number)
      },
      'settings-notification'
    );
    expect(savedEventListener).toHaveBeenCalledTimes(1);
    expect(wrapper.find('#status').text()).toBe('OPTIONS_STATUS_SAVED_SUCCESS');

    window.removeEventListener('options-settings-saved', savedEventListener);
  });

  it('prompt-only validation error triggers partial save and restores draft', async () => {
    // 1. Setup mock validation failure for prompts only
    mockValidateSettings.mockReturnValue({ 
      isValid: false, 
      errors: ['prompt:PROMPT_TEMPLATE:validation_prompt_template_empty'] 
    });

    // Set draft invalid value in local store state
    mockSettingsStore.settings.PROMPT_TEMPLATE = 'invalid draft template';

    const wrapper = mount(OptionsNavigation, {
      global: {
        stubs: {
          RouterLink: true
        },
        mocks: {
          $route: {
            name: 'languages'
          }
        }
      }
    });

    // Monitor the value of the settings during the actual save call
    let valueDuringSave = null;
    mockSaveSettings.mockImplementation(() => {
      valueDuringSave = mockSettingsStore.settings.PROMPT_TEMPLATE;
      return Promise.resolve(true);
    });

    // Setup custom event listener for redirect / validation feedback
    const customEventListener = vi.fn();
    window.addEventListener('options-trigger-validation-feedback', customEventListener);

    const saveButton = wrapper.find('#saveSettings');
    await saveButton.trigger('click');
    await flushPromises();

    // Save should run!
    expect(mockSaveSettings).toHaveBeenCalled();
    expect(mockSaveSettings).toHaveBeenCalledWith();
    expect(safeSendMessageMock).toHaveBeenCalledWith(
      {
        action: 'SETTINGS_UPDATED',
        timestamp: expect.any(Number)
      },
      'settings-notification'
    );

    // Persisted payload during the save should have reverted to last persisted value
    expect(valueDuringSave).toBe('last persisted template $_{SOURCE} $_{TARGET} $_{TEXT}');

    // UI/Store state should be restored to the user's invalid draft
    expect(mockSettingsStore.settings.PROMPT_TEMPLATE).toBe('invalid draft template');

    // Warning status should be shown
    expect(wrapper.find('#status').text()).toBe('OPTIONS_STATUS_SAVED_WITH_PROMPT_ERRORS');
    expect(wrapper.find('#status').classes()).toContain('status-warning');

    // Redirect to prompt tab and focus should still happen
    expect(pushMock).toHaveBeenCalledWith({ name: 'prompt' });
    expect(customEventListener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { field: 'prompt', promptKey: 'PROMPT_TEMPLATE' }
      })
    );

    window.removeEventListener('options-trigger-validation-feedback', customEventListener);
  });

  it('valid persistence stays successful when notification rejects', async () => {
    mockValidateSettings.mockReturnValue({ isValid: true, errors: [] });
    safeSendMessageMock.mockRejectedValue(new Error('notification failed'));

    const savedEventListener = vi.fn();
    window.addEventListener('options-settings-saved', savedEventListener);

    const wrapper = mount(OptionsNavigation, {
      global: {
        stubs: {
          RouterLink: true
        },
        mocks: {
          $route: {
            name: 'languages'
          }
        }
      }
    });

    await wrapper.find('#saveSettings').trigger('click');
    await flushPromises();

    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(safeSendMessageMock).toHaveBeenCalledTimes(1);
    expect(savedEventListener).toHaveBeenCalledTimes(1);
    expect(wrapper.find('#status').text()).toBe('OPTIONS_STATUS_SAVED_SUCCESS');
    expect(wrapper.find('#status').classes()).toContain('status-success');

    window.removeEventListener('options-settings-saved', savedEventListener);
  });

  it('valid persistence stays successful when notification is unconfirmed', async () => {
    mockValidateSettings.mockReturnValue({ isValid: true, errors: [] });
    safeSendMessageMock.mockResolvedValue(null);

    const savedEventListener = vi.fn();
    window.addEventListener('options-settings-saved', savedEventListener);

    const wrapper = mount(OptionsNavigation, {
      global: {
        stubs: {
          RouterLink: true
        },
        mocks: {
          $route: {
            name: 'languages'
          }
        }
      }
    });

    await wrapper.find('#saveSettings').trigger('click');
    await flushPromises();

    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(savedEventListener).toHaveBeenCalledTimes(1);
    expect(wrapper.find('#status').text()).toBe('OPTIONS_STATUS_SAVED_SUCCESS');
    expect(wrapper.find('#status').classes()).toContain('status-success');

    window.removeEventListener('options-settings-saved', savedEventListener);
  });

  it('partial persistence keeps warning when notification rejects', async () => {
    mockValidateSettings.mockReturnValue({
      isValid: false,
      errors: ['prompt:PROMPT_TEMPLATE:validation_prompt_template_empty']
    });
    mockSettingsStore.settings.PROMPT_TEMPLATE = 'invalid draft template';
    mockSaveSettings.mockImplementation(() => Promise.resolve(true));
    safeSendMessageMock.mockRejectedValue(new Error('notification failed'));

    const savedEventListener = vi.fn();
    window.addEventListener('options-settings-saved', savedEventListener);

    const wrapper = mount(OptionsNavigation, {
      global: {
        stubs: {
          RouterLink: true
        },
        mocks: {
          $route: {
            name: 'languages'
          }
        }
      }
    });

    await wrapper.find('#saveSettings').trigger('click');
    await flushPromises();

    expect(mockSaveSettings).toHaveBeenCalledWith();
    expect(mockSettingsStore.settings.PROMPT_TEMPLATE).toBe('invalid draft template');
    expect(wrapper.find('#status').text()).toBe('OPTIONS_STATUS_SAVED_WITH_PROMPT_ERRORS');
    expect(wrapper.find('#status').classes()).toContain('status-warning');
    expect(pushMock).toHaveBeenCalledWith({ name: 'prompt' });
    expect(savedEventListener).not.toHaveBeenCalled();

    window.removeEventListener('options-settings-saved', savedEventListener);
  });

  it('partial persistence keeps warning when notification is unconfirmed', async () => {
    mockValidateSettings.mockReturnValue({
      isValid: false,
      errors: ['prompt:PROMPT_TEMPLATE:validation_prompt_template_empty']
    });
    mockSettingsStore.settings.PROMPT_TEMPLATE = 'invalid draft template';
    mockSaveSettings.mockImplementation(() => Promise.resolve(true));
    safeSendMessageMock.mockResolvedValue(null);

    const savedEventListener = vi.fn();
    window.addEventListener('options-settings-saved', savedEventListener);

    const wrapper = mount(OptionsNavigation, {
      global: {
        stubs: {
          RouterLink: true
        },
        mocks: {
          $route: {
            name: 'languages'
          }
        }
      }
    });

    await wrapper.find('#saveSettings').trigger('click');
    await flushPromises();

    expect(mockSaveSettings).toHaveBeenCalledWith();
    expect(mockSettingsStore.settings.PROMPT_TEMPLATE).toBe('invalid draft template');
    expect(wrapper.find('#status').text()).toBe('OPTIONS_STATUS_SAVED_WITH_PROMPT_ERRORS');
    expect(wrapper.find('#status').classes()).toContain('status-warning');
    expect(pushMock).toHaveBeenCalledWith({ name: 'prompt' });
    expect(savedEventListener).not.toHaveBeenCalled();

    window.removeEventListener('options-settings-saved', savedEventListener);
  });

  it('mixed validation errors (prompt + non-prompt) completely blocks save', async () => {
    // Set current route name to prompt, so redirect to languages is forced to trigger
    currentRouteName.value = 'prompt';

    // Return both prompt error and language error
    mockValidateSettings.mockReturnValue({ 
      isValid: false, 
      errors: [
        'validation_source_language_empty',
        'prompt:PROMPT_TEMPLATE:validation_prompt_template_empty'
      ] 
    });
    
    const wrapper = mount(OptionsNavigation, {
      global: {
        stubs: {
          RouterLink: true
        },
        mocks: {
          $route: {
            name: 'prompt'
          }
        }
      }
    });

    const saveButton = wrapper.find('#saveSettings');
    await saveButton.trigger('click');
    await flushPromises();
    
    // Save should NOT run
    expect(mockSaveSettings).not.toHaveBeenCalled();
    
    // Status should be set to validation_source_language_empty error (non-prompt error)
    expect(wrapper.find('#status').text()).toBe('validation_source_language_empty');
    expect(wrapper.find('#status').classes()).toContain('status-error');

    // Redirect should go to languages tab
    expect(pushMock).toHaveBeenCalledWith({ name: 'languages' });
  });

  it('save failure during temporary swap restores invalid draft values', async () => {
    mockValidateSettings.mockReturnValue({ 
      isValid: false, 
      errors: ['prompt:PROMPT_TEMPLATE:validation_prompt_template_empty'] 
    });

    mockSettingsStore.settings.PROMPT_TEMPLATE = 'invalid draft template';
    
    // Save operation throws an error
    mockSaveSettings.mockRejectedValue(new Error('Save failed'));

    const wrapper = mount(OptionsNavigation, {
      global: {
        stubs: {
          RouterLink: true
        },
        mocks: {
          $route: {
            name: 'languages'
          }
        }
      }
    });

    const saveButton = wrapper.find('#saveSettings');
    await saveButton.trigger('click');
    await flushPromises();

    // Save was attempted
    expect(mockSaveSettings).toHaveBeenCalled();
    expect(safeSendMessageMock).not.toHaveBeenCalled();

    // Draft is restored even after save failure
    expect(mockSettingsStore.settings.PROMPT_TEMPLATE).toBe('invalid draft template');
    
    // Status is set to failure
    expect(wrapper.find('#status').text()).toBe('OPTIONS_STATUS_SAVED_FAILED');
    expect(wrapper.find('#status').classes()).toContain('status-error');
  });

  it('valid save failure does not send settings notification', async () => {
    mockValidateSettings.mockReturnValue({ isValid: true, errors: [] });
    mockSaveSettings.mockRejectedValue(new Error('Save failed'));

    const wrapper = mount(OptionsNavigation, {
      global: {
        stubs: {
          RouterLink: true
        },
        mocks: {
          $route: {
            name: 'languages'
          }
        }
      }
    });

    await wrapper.find('#saveSettings').trigger('click');
    await flushPromises();

    expect(mockSaveSettings).toHaveBeenCalled();
    expect(safeSendMessageMock).not.toHaveBeenCalled();
    expect(wrapper.find('#status').text()).toBe('OPTIONS_STATUS_SAVED_FAILED');
    expect(wrapper.find('#status').classes()).toContain('status-error');
    expect(wrapper.find('#status').attributes('role')).toBe('alert');
    expect(wrapper.find('#status').classes()).toContain('is-visible');
    expect(wrapper.find('#status').attributes('aria-atomic')).toBe('true');
  });

  it('keeps one accessible toast host and clears each feedback state at its specified duration', async () => {
    vi.useFakeTimers();
    const settleSave = async () => {
      const settling = flushPromises();
      await vi.advanceTimersByTimeAsync(0);
      await settling;
    };
    const cases = [
      {
        type: 'success', role: 'status', duration: 2000,
        setup: () => {
          mockValidateSettings.mockReturnValue({ isValid: true, errors: [] });
          mockSaveSettings.mockResolvedValue(true);
        }
      },
      {
        type: 'warning', role: 'status', duration: 3000,
        setup: () => {
          mockValidateSettings.mockReturnValue({ isValid: false, errors: ['prompt:PROMPT_TEMPLATE:validation_prompt_template_empty'] });
          mockSettingsStore.settings.PROMPT_TEMPLATE = 'invalid draft template';
          mockSaveSettings.mockResolvedValue(true);
        }
      },
      {
        type: 'error', role: 'alert', duration: 5000,
        setup: () => mockValidateSettings.mockReturnValue({ isValid: false, errors: ['validation_source_language_empty'] })
      },
      {
        type: 'error', role: 'alert', duration: 3000,
        setup: () => {
          mockValidateSettings.mockReturnValue({ isValid: true, errors: [] });
          mockSaveSettings.mockRejectedValue(new Error('Save failed'));
        }
      }
    ];

    try {
      for (const { type, role, duration, setup } of cases) {
        vi.clearAllMocks();
        mockSettingsStore.settings = {
          TRANSLATION_API: 'google',
          MODE_PROVIDERS: {},
          PROMPT_TEMPLATE: 'valid template $_{SOURCE} $_{TARGET} $_{TEXT}'
        };
        vi.mocked(storageManager.get).mockResolvedValue({
          PROMPT_TEMPLATE: 'last persisted template $_{SOURCE} $_{TARGET} $_{TEXT}'
        });
        mockSaveSettings.mockResolvedValue(true);
        safeSendMessageMock.mockResolvedValue({ success: true });
        setup();

        const wrapper = mount(OptionsNavigation, {
          global: {
            stubs: { RouterLink: true },
            mocks: { $route: { name: 'languages' } }
          }
        });
        await wrapper.find('#saveSettings').trigger('click');
        await settleSave();

        const status = wrapper.find('#status');
        const actionArea = wrapper.find('.tabs-action-area');
        expect(wrapper.findAll('#status')).toHaveLength(1);
        expect(status.classes()).toContain(`status-${type}`);
        expect(status.classes()).toContain('is-visible');
        expect(status.attributes('role')).toBe(role);
        expect(status.attributes('aria-atomic')).toBe('true');
        expect(wrapper.find('nav').element.contains(status.element)).toBe(false);
        expect(actionArea.element.contains(status.element)).toBe(false);
        expect(actionArea.findAll('#saveSettings')).toHaveLength(1);
        expect(actionArea.element.children).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(duration - 1);
        expect(status.classes()).toContain('is-visible');
        await vi.advanceTimersByTimeAsync(1);
        await wrapper.vm.$nextTick();
        expect(status.text()).toBe('');
        expect(status.classes()).not.toContain('is-visible');
        wrapper.unmount();
        vi.clearAllTimers();
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('OptionsNavigation.vue - navigation overflow behavior', () => {
  let resizeObserverCallback;
  let resizeObserverInstance;
  let mountedWrappers;

  const mountNavigation = (route = { name: currentRouteName.value, fullPath: currentRouteFullPath.value }) => {
    const parent = document.createElement('div');
    parent.className = 'options-main';
    document.body.append(parent);
    const wrapper = mount(OptionsNavigation, {
      attachTo: parent,
      global: {
        stubs: {
          RouterLink: { template: '<a v-bind="$attrs"><slot /></a>' }
        },
        mocks: { $route: route }
      }
    });
    mountedWrappers.push(wrapper);
    return { wrapper, parent };
  };

  const setRect = (element, { left, right }) => {
    element.getBoundingClientRect = () => ({ left, right, top: 0, bottom: 20, width: right - left, height: 20 });
    element.scrollIntoView = vi.fn();
  };

  const configureGeometry = (wrapper, { viewport = [0, 100], links, scrollWidth = 100, clientWidth = 100 } = {}) => {
    const nav = wrapper.find('nav').element;
    const navLinks = wrapper.findAll('nav a');
    setRect(nav, { left: viewport[0], right: viewport[1] });
    Object.defineProperties(nav, {
      scrollWidth: { configurable: true, value: scrollWidth },
      clientWidth: { configurable: true, value: clientWidth }
    });
    navLinks.forEach((link, index) => setRect(link.element, links?.[index] ?? { left: index * 20, right: index * 20 + 20 }));
    return nav;
  };

  beforeEach(() => {
    mountedWrappers = [];
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.stubGlobal('requestAnimationFrame', callback => { callback(); return 1; });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { resizeObserverCallback = callback; resizeObserverInstance = this; }
      observe = vi.fn();
      disconnect = vi.fn();
    });
    locale.value = 'en';
    currentRouteName.value = 'languages';
    currentRouteFullPath.value = '/languages';
  });

  afterEach(() => {
    mountedWrappers.forEach(wrapper => wrapper.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('keeps the save/status action outside one links-only navigation and has no arrows without overflow', async () => {
    const { wrapper, parent } = mountNavigation();
    await flushPromises();
    configureGeometry(wrapper);
    await wrapper.find('nav').trigger('scroll');

    expect(wrapper.findAll('nav')).toHaveLength(1);
    expect(wrapper.findAll('nav a')).toHaveLength(12);
    expect(wrapper.findAll('nav [aria-current="page"]')).toHaveLength(1);
    expect(wrapper.find('nav [aria-current="page"]').text()).toBe('languages_tab_title');
    expect(wrapper.findAll('#status')).toHaveLength(1);
    expect(wrapper.findAll('#saveSettings')).toHaveLength(1);
    expect(wrapper.find('.tabs-action-area').findAll('#saveSettings')).toHaveLength(1);
    expect(wrapper.find('.tabs-action-area').element.children).toHaveLength(1);
    expect(wrapper.find('nav').element.contains(wrapper.find('#status').element)).toBe(false);
    expect(wrapper.find('nav').element.contains(wrapper.find('#saveSettings').element)).toBe(false);
    expect(wrapper.findAll('.tab-scroll-arrow')).toHaveLength(0);
    expect(wrapper.find('nav').classes()).not.toContain('has-previous');
    expect(wrapper.find('nav').classes()).not.toContain('has-next');
    wrapper.unmount();
    parent.remove();
  });

  it('shows directional arrows/fades for clipped edges and updates after scroll and resize', async () => {
    const { wrapper, parent } = mountNavigation();
    await flushPromises();
    const links = wrapper.findAll('nav a');
    configureGeometry(wrapper, {
      scrollWidth: 300, clientWidth: 100,
      links: links.map((_, index) => ({ left: index === 0 ? -10 : 110 + index * 10, right: index === 0 ? 20 : 140 + index * 10 }))
    });
    resizeObserverCallback();
    await flushPromises();
    expect(wrapper.find('.tab-scroll-arrow.previous').exists()).toBe(true);
    expect(wrapper.find('.tab-scroll-arrow.next').exists()).toBe(true);
    expect(wrapper.find('nav').classes()).toContain('has-previous');
    expect(wrapper.find('nav').classes()).toContain('has-next');

    links.forEach((link, index) => setRect(link.element, { left: index * 30, right: index * 30 + 20 }));
    await wrapper.find('nav').trigger('scroll');
    expect(wrapper.find('.tab-scroll-arrow.previous').exists()).toBe(false);
    expect(wrapper.find('.tab-scroll-arrow.next').exists()).toBe(true);
    expect(wrapper.find('nav').classes()).not.toContain('has-previous');

    links.forEach((link, index) => setRect(link.element, { left: index * 30, right: index * 30 + 20 }));
    setRect(links.at(-1).element, { left: 80, right: 110 });
    resizeObserverCallback();
    await flushPromises();
    expect(wrapper.find('.tab-scroll-arrow.next').exists()).toBe(true);
    links.forEach((link, index) => setRect(link.element, { left: index * 20, right: index * 20 + 20 }));
    links.at(-1).element.getBoundingClientRect = () => ({ left: 80, right: 100, top: 0, bottom: 20, width: 20, height: 20 });
    resizeObserverCallback();
    await flushPromises();
    expect(wrapper.find('.tab-scroll-arrow.previous').exists()).toBe(false);
    expect(wrapper.find('.tab-scroll-arrow.next').exists()).toBe(false);
    wrapper.unmount();
    parent.remove();
  });

  it('scrolls to the nearest clipped tab and reveals only the clipped active tab on route/locale changes', async () => {
    const route = reactive({ name: 'languages', fullPath: '/languages' });
    const { wrapper, parent } = mountNavigation(route);
    await flushPromises();
    const links = wrapper.findAll('nav a');
    configureGeometry(wrapper, {
      scrollWidth: 400, clientWidth: 100,
      links: links.map((_, index) => index === 0 ? { left: -15, right: 15 } : index === 1 ? { left: 85, right: 115 } : { left: 120 + index * 20, right: 140 + index * 20 })
    });
    resizeObserverCallback();
    await flushPromises();
    links.forEach(link => link.element.scrollIntoView.mockClear());
    await wrapper.find('.tab-scroll-arrow.next').trigger('click');
    expect(links[1].element.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ inline: 'nearest' }));
    expect(links.at(-1).element.scrollIntoView).not.toHaveBeenCalled();

    links.forEach(link => link.element.scrollIntoView.mockClear());
    route.name = 'providers';
    route.fullPath = '/providers';
    currentRouteName.value = 'providers';
    currentRouteFullPath.value = '/providers';
    await flushPromises();
    expect(links[1].element.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(links.filter((link, index) => index !== 1).some(link => link.element.scrollIntoView.mock.calls.length)).toBe(false);

    links.forEach(link => link.element.scrollIntoView.mockClear());
    locale.value = 'fr';
    await flushPromises();
    expect(links[1].element.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(links.filter((link, index) => index !== 1).some(link => link.element.scrollIntoView.mock.calls.length)).toBe(false);
    wrapper.unmount();
    parent.remove();
  });

  it('does not auto-reveal during ResizeObserver updates, but does on a real viewport width change', async () => {
    const { wrapper, parent } = mountNavigation();
    await flushPromises();
    const links = wrapper.findAll('nav a');
    const nav = configureGeometry(wrapper, {
      scrollWidth: 300, clientWidth: 100,
      links: links.map((_, index) => ({ left: index * 20, right: index * 20 + 15 }))
    });

    // Seed the resize-width guard while the active tab is visible.
    window.dispatchEvent(new Event('resize'));
    links[0].element.scrollIntoView.mockClear();

    // Simulate manual scrolling with the active tab clipped off the left edge.
    setRect(links[0].element, { left: -20, right: -5 });
    setRect(links.at(-1).element, { left: 80, right: 100 });
    resizeObserverCallback();
    await flushPromises();
    expect(wrapper.find('.tab-scroll-arrow.previous').exists()).toBe(true);
    expect(links[0].element.scrollIntoView).not.toHaveBeenCalled();

    // A resize event without a viewport width change must not reveal it either.
    window.dispatchEvent(new Event('resize'));
    expect(links[0].element.scrollIntoView).not.toHaveBeenCalled();

    // A genuine width change restores the active-tab reveal behavior.
    nav.getBoundingClientRect = () => ({ left: 0, right: 120, top: 0, bottom: 20, width: 120, height: 20 });
    Object.defineProperty(nav, 'clientWidth', { configurable: true, value: 120 });
    window.dispatchEvent(new Event('resize'));
    expect(links[0].element.scrollIntoView).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    parent.remove();
  });

  it('teleports the toast to the options overlay and keeps it outside raised content', async () => {
    mockValidateSettings.mockReturnValue({ isValid: true, errors: [] });
    mockSaveSettings.mockResolvedValue(true);
    safeSendMessageMock.mockResolvedValue({ success: true });

    const overlay = document.createElement('div');
    overlay.className = 'extension-options rtl';
    const layout = document.createElement('div');
    layout.className = 'options-layout';
    const main = document.createElement('main');
    main.className = 'options-main';
    const content = document.createElement('div');
    content.className = 'tab-content-container';
    const dropdown = document.createElement('div');
    dropdown.className = 'ti-dropdown-open';
    content.append(dropdown);
    main.append(content);
    layout.append(main);
    overlay.append(layout);
    document.body.append(overlay);

    const wrapper = mount(OptionsNavigation, {
      attachTo: main,
      global: {
        stubs: { RouterLink: { template: '<a v-bind="$attrs"><slot /></a>' } },
        mocks: { $route: { name: 'languages' } }
      }
    });
    mountedWrappers.push(wrapper);
    await flushPromises();

    const actionArea = wrapper.find('.tabs-action-area');
    actionArea.element.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 56, width: 100, height: 56 });
    resizeObserverCallback();
    await flushPromises();
    await wrapper.find('#saveSettings').trigger('click');
    await flushPromises();

    const status = overlay.querySelector('#status');
    expect(document.querySelectorAll('#status')).toHaveLength(1);
    expect(status.parentElement).toBe(overlay);
    expect(overlay.querySelectorAll('.options-navigation nav #status')).toHaveLength(0);
    expect(overlay.querySelectorAll('.tab-content-container #status')).toHaveLength(0);
    expect(status.textContent).toBe('OPTIONS_STATUS_SAVED_SUCCESS');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.classList.contains('is-visible')).toBe(true);
    expect(status.getAttribute('aria-atomic')).toBe('true');
    expect(wrapper.find('.tabs-action-area').findAll('#saveSettings')).toHaveLength(1);
    expect(wrapper.find('.tabs-action-area').element.contains(status)).toBe(false);
    expect(overlay.style.getPropertyValue('--mobile-action-height')).toBe('56px');
    expect(status.closest('.extension-options')).toBe(overlay);
    expect(main.closest('.extension-options')).toBe(overlay);

    dropdown.classList.add('is-open');
    expect(overlay.querySelectorAll('#status')).toHaveLength(1);
    expect(status.classList.contains('is-visible')).toBe(true);
    expect(status.textContent).toBe('OPTIONS_STATUS_SAVED_SUCCESS');

    // Toast content cannot change the measured Save dock height.
    resizeObserverCallback();
    expect(overlay.style.getPropertyValue('--mobile-action-height')).toBe('56px');
    wrapper.unmount();
    expect(overlay.querySelector('#status')).toBeNull();
    expect(overlay.style.getPropertyValue('--mobile-action-height')).toBe('');
    expect(resizeObserverInstance.disconnect).toHaveBeenCalledTimes(1);
    overlay.remove();
  });

  it('uses RTL previous/next geometry and measures/removes action height on the shared parent', async () => {
    const { wrapper, parent } = mountNavigation();
    await flushPromises();
    const links = wrapper.findAll('nav a');
    configureGeometry(wrapper, {
      viewport: [0, 100], scrollWidth: 300, clientWidth: 100,
      links: links.map((_, index) => index === 0 ? { left: 80, right: 120 } : index === 11 ? { left: -20, right: 20 } : { left: 30, right: 70 })
    });
    vi.stubGlobal('getComputedStyle', () => ({ direction: 'rtl' }));
    const action = wrapper.find('.tabs-action-area').element;
    setRect(action, { left: 0, right: 100 });
    action.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 44, width: 100, height: 44 });
    resizeObserverCallback();
    await flushPromises();
    expect(wrapper.find('.tab-scroll-arrow.previous').exists()).toBe(true);
    expect(wrapper.find('.tab-scroll-arrow.next').exists()).toBe(true);
    expect(parent.style.getPropertyValue('--mobile-action-height')).toBe('44px');

    // RTL previous follows the first clipped item; next follows the last clipped item.
    links.forEach(link => link.element.scrollIntoView.mockClear());
    await wrapper.find('.tab-scroll-arrow.previous').trigger('click');
    expect(links[0].element.scrollIntoView).toHaveBeenCalledTimes(1);
    await wrapper.find('.tab-scroll-arrow.next').trigger('click');
    expect(links[11].element.scrollIntoView).toHaveBeenCalledTimes(1);

    action.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 61, width: 100, height: 61 });
    resizeObserverCallback();
    expect(parent.style.getPropertyValue('--mobile-action-height')).toBe('61px');
    expect(wrapper.find('.options-navigation').element.closest('.options-main')).toBe(parent);
    wrapper.unmount();
    expect(parent.querySelector('.options-navigation')).toBeNull();
    expect(resizeObserverInstance.disconnect).toHaveBeenCalledTimes(1);
    expect(parent.style.getPropertyValue('--mobile-action-height')).toBe('');
    parent.remove();
  });
});
