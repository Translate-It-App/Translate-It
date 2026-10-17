import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick, reactive, ref } from 'vue';
import TranslationWindow from './TranslationWindow.vue';
import { pageEventBus } from '@/core/PageEventBus.js';
import { DismissalManager } from '@/features/windows/managers/dismissal/DismissalManager.js';

let currentMediaQueryList = null;
let sourceResizeObservers = [];

class MockResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observe = vi.fn();
    this.disconnect = vi.fn();
    sourceResizeObservers.push(this);
  }

  trigger() {
    this.callback();
  }
}

const findResizeObserverFor = (element) =>
  sourceResizeObservers.find((observer) =>
    observer.observe.mock.calls.some(([observedElement]) => observedElement === element),
  );

const findTextareaResizeObservers = () =>
  sourceResizeObservers.filter((observer) =>
    observer.observe.mock.calls.some(([element]) =>
      element.matches?.('.ti-window-source-input'),
    ),
  );

const createSettingsStore = () => {
  const store = reactive({
    settings: {
      THEME: 'light',
      WINDOW_IS_PINNED: false,
      WINDOW_DOCK_MODE: 'none',
      WINDOW_DOCKED_WIDTH: 350,
    },
    getSetting: vi.fn(),
    updateSettingAndPersist: vi.fn(),
  });

  store.getSetting = vi.fn((key, fallback) => store.settings[key] ?? fallback);
  // Mirrors the real store: Pinia state applies synchronously, persistence
  // resolves afterwards (and rejects on storage failure).
  store.updateSettingAndPersist = vi.fn(async (key, value) => {
    store.settings[key] = value;
    return true;
  });

  return store;
};

const createMediaQueryList = (matches = false) => {
  const listeners = new Set();

  return {
    media: '(prefers-color-scheme: dark)',
    matches,
    addEventListener: vi.fn((event, handler) => {
      if (event === 'change') {
        listeners.add(handler);
      }
    }),
    removeEventListener: vi.fn((event, handler) => {
      if (event === 'change') {
        listeners.delete(handler);
      }
    }),
    addListener: vi.fn((handler) => {
      listeners.add(handler);
    }),
    removeListener: vi.fn((handler) => {
      listeners.delete(handler);
    }),
    dispatchChange(nextMatches) {
      this.matches = nextMatches;
      listeners.forEach((handler) => handler({ matches: nextMatches, media: this.media }));
    },
  };
};

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: {
    emit: vi.fn(),
  },
  WINDOWS_MANAGER_EVENTS: {
    OPEN_SETTINGS: 'open-settings',
  },
}));

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key) => key,
  }),
}));

vi.mock('@/composables/ui/usePositioning.js', () => ({
  usePositioning: () => {
    const currentPosition = ref({ x: 0, y: 0 });
    const currentDockMode = ref('none');
    globalThis.__mockCurrentDockMode = currentDockMode;

    return {
      currentPosition,
      isDragging: ref(false),
      currentDockMode,
      positionStyle: ref({}),
      startDrag: vi.fn(),
      updatePosition: vi.fn(),
      updateDockMode: vi.fn(),
      updateDockedWidth: vi.fn(),
      cleanup: vi.fn(),
    };
  },
}));

vi.mock('@/features/tts/composables/useTTSSmart.js', () => ({
  useTTSSmart: () => ({
    stopAll: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/shared/messaging/composables/useMessaging.js', () => ({
  useMessaging: vi.fn(),
}));

const { trackedDisposers } = vi.hoisted(() => ({ trackedDisposers: [] }));

vi.mock('@/composables/core/useResourceTracker.js', () => ({
  useResourceTracker: () => ({
    trackResource: vi.fn((resourceId, cleanupFn) => {
      trackedDisposers.push(cleanupFn);
    }),
    addEventListener: vi.fn((element, event, handler, options) => {
      element.addEventListener(event, handler, options);
      trackedDisposers.push(() => element.removeEventListener(event, handler));
    }),
    trackTimeout: vi.fn((callback, delay) => {
      // Functional stub: runs with fake or real timers and stays cleanable.
      const timeoutId = setTimeout(callback, delay);
      trackedDisposers.push(() => clearTimeout(timeoutId));
      return timeoutId;
    }),
  }),
}));

vi.mock('@/store/modules/mobile.js', () => ({
  useMobileStore: () => ({
    isFullscreen: false,
  }),
}));

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => globalThis.__mockSettingsStore,
}));

// Silent logger; warn is observed by the persistence-failure tests.
const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: mockLoggerWarn,
    trace: vi.fn(),
    operation: vi.fn(),
  }),
}));

vi.mock('@/core/content-scripts/chunks/lazy-styles.js', () => ({
  windowsUiStyles: '',
}));

vi.mock('@/utils/ui/styleInjector.js', () => ({
  injectStylesToShadowRoot: vi.fn(),
}));

vi.mock('@/components/shared/TranslationDisplay.vue', () => ({
  default: {
    name: 'TranslationDisplay',
    props: {
      content: { type: String, default: '' },
      mode: { type: String, default: '' },
      lastTranslation: { type: Object, default: null },
    },
    template: '<div class="translation-display-stub" />',
  },
}));

vi.mock('@/components/shared/ProviderSelector.vue', () => ({
  default: {
    name: 'ProviderSelector',
    props: {
      modelValue: { type: String, default: '' },
    },
    template: '<div class="provider-selector-stub" />',
  },
}));

vi.mock('@/components/base/LoadingSpinner.vue', () => ({
  default: {
    name: 'LoadingSpinner',
    props: {
      size: { type: String, default: '' },
    },
    template: '<div class="loading-spinner-stub" />',
  },
}));

vi.mock('@/components/shared/TTSButton.vue', () => ({
  default: {
    name: 'TTSButton',
    props: {
      text: { type: String, default: '' },
      language: { type: String, default: '' },
      isDictionary: { type: Boolean, default: false },
    },
    template: '<button class="tts-button-stub" />',
  },
}));

describe('TranslationWindow.vue', () => {
  const baseProps = {
    id: 'window-1',
    position: { x: 0, y: 0 },
    selectedText: 'expressions',
    initialTranslatedText: '表达方式',
    theme: 'light',
    isLoading: false,
    isStreaming: false,
    isError: false,
    errorType: null,
    canRetry: false,
    needsSettings: false,
    initialSize: 'normal',
    targetLanguage: 'fa',
    sourceLanguage: 'en',
    detectedSourceLanguage: 'en',
    provider: 'gemini',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    trackedDisposers.length = 0;
    sourceResizeObservers = [];
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb) => cb());
    globalThis.__mockSettingsStore = createSettingsStore();
    currentMediaQueryList = createMediaQueryList(false);
    vi.stubGlobal('matchMedia', vi.fn(() => currentMediaQueryList));
    window.windowsManagerInstance = {
      state: {
        setPinned: vi.fn(),
        setDockMode: vi.fn(),
      },
    };
  });

  it('keeps compact window rendering unchanged when translation is not dictionary mode', async () => {
    const wrapper = mount(TranslationWindow, {
      props: {
        ...baseProps,
        translationMode: null,
      },
    });

    const display = wrapper.findComponent({ name: 'TranslationDisplay' });
    expect(display.exists()).toBe(true);
    expect(display.props('mode')).toBe('compact');
    expect(display.props('lastTranslation')).toBeNull();
  });

  it('updates the open window shell when the settings theme changes', async () => {
    const wrapper = mount(TranslationWindow, {
      props: baseProps,
    });

    const windowRoot = wrapper.find('.translation-window');

    expect(windowRoot.classes()).toContain('light');
    expect(windowRoot.classes()).not.toContain('dark');

    globalThis.__mockSettingsStore.settings.THEME = 'dark';
    await nextTick();

    expect(windowRoot.classes()).toContain('dark');
    expect(windowRoot.classes()).not.toContain('light');
  });

  it('keeps pinned and docked classes intact while using live theme state', async () => {
    globalThis.__mockSettingsStore.settings.WINDOW_IS_PINNED = true;
    globalThis.__mockSettingsStore.settings.WINDOW_DOCK_MODE = 'left';

    const wrapper = mount(TranslationWindow, {
      props: baseProps,
    });

    const windowRoot = wrapper.find('.translation-window');

    expect(windowRoot.classes()).toContain('light');
    expect(windowRoot.classes()).toContain('is-pinned');
    expect(windowRoot.classes()).toContain('is-docked');
    expect(windowRoot.classes()).toContain('dock-left');
  });

  it('renders the extracted shared toolbar controls with the existing handlers', () => {
    const wrapper = mount(TranslationWindow, {
      props: baseProps,
    });

    expect(wrapper.findComponent({ name: 'TranslationWindowToolbar' }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'ProviderSelector' }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'TTSButton' }).exists()).toBe(true);
    expect(wrapper.find('.ti-action-btn[title="window_pin"]').exists()).toBe(true);
    expect(wrapper.find('.ti-action-btn[title="window_copy_translation"]').exists()).toBe(true);
    expect(wrapper.find('.ti-action-btn[title="window_show_original"]').exists()).toBe(true);
    expect(wrapper.find('.ti-detected-language-label').text()).toBe('English');
    expect(wrapper.find('.ti-action-btn[title="window_close"]').exists()).toBe(true);
    expect(wrapper.findAll('.ti-window-source-input')).toHaveLength(1);
    expect(wrapper.find('.ti-window-source-input').element.value).toBe('expressions');
    expect(wrapper.find('.ti-window-source-input').isVisible()).toBe(false);
  });

  it('shows history only for multiple snapshots, between the header and body', async () => {
    const wrapper = mount(TranslationWindow, { props: baseProps });
    const findHistory = () => wrapper.find('[data-testid="translation-window-history-subheader"]');

    expect(findHistory().exists()).toBe(false);
    await wrapper.setProps({ historyLength: 1, historyIndex: 0 });
    expect(findHistory().exists()).toBe(false);
    await wrapper.setProps({ historyLength: 12, historyIndex: 9, provider: 'deepl', historyProvider: 'googlev2' });

    const subheader = findHistory();
    expect(subheader.exists()).toBe(true);
    const rootChildren = wrapper.find('.translation-window').element.children;
    expect(rootChildren[Array.from(rootChildren).indexOf(subheader.element) - 1]).toBe(
      wrapper.find('.ti-window-header').element
    );
    expect(rootChildren[Array.from(rootChildren).indexOf(subheader.element) + 1]).toBe(
      wrapper.find('.ti-window-body').element
    );
    expect(subheader.find('.ti-window-history-divider').exists()).toBe(true);
    expect(subheader.find('[data-testid="translation-window-history-counter"]').text()).toBe('10 / 12');
    expect(subheader.find('[data-testid="translation-window-history-provider"]').text()).toBe('Google Translate');
    expect(wrapper.findComponent({ name: 'ProviderSelector' }).props('modelValue')).toBe('deepl');

    await wrapper.setProps({ historyProvider: 'deepl', historyIndex: 10 });
    expect(subheader.find('[data-testid="translation-window-history-provider"]').text()).toBe('DeepL Translate');
    expect(subheader.find('[data-testid="translation-window-history-counter"]').text()).toBe('11 / 12');
    expect(wrapper.find('[data-testid="translation-window-toolbar-provider-selector"]').exists()).toBe(true);
  });

  it('navigates history in both directions and disables the boundary buttons', async () => {
    const host = document.createElement('div');
    host.dir = 'rtl';
    document.body.append(host);
    const wrapper = mount(TranslationWindow, {
      props: { ...baseProps, historyIndex: 1, historyLength: 3 },
      attachTo: host,
    });
    const previous = wrapper.find('[data-testid="translation-window-history-previous"]');
    const next = wrapper.find('[data-testid="translation-window-history-next"]');
    expect(previous.element.compareDocumentPosition(next.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(previous.attributes('aria-label')).toBe('window_history_previous');
    expect(next.attributes('aria-label')).toBe('window_history_next');
    expect(previous.element.disabled).toBe(false);
    expect(next.element.disabled).toBe(false);

    await previous.trigger('click');
    await next.trigger('click');
    expect(pageEventBus.emit).toHaveBeenNthCalledWith(1, 'translation-window-history-navigate', {
      id: 'window-1', direction: 'previous',
    });
    expect(pageEventBus.emit).toHaveBeenNthCalledWith(2, 'translation-window-history-navigate', {
      id: 'window-1', direction: 'next',
    });

    await wrapper.setProps({ historyIndex: 0 });
    expect(previous.element.disabled).toBe(true);
    expect(next.element.disabled).toBe(false);
    await wrapper.setProps({ historyIndex: 2 });
    expect(previous.element.disabled).toBe(false);
    expect(next.element.disabled).toBe(true);
    wrapper.unmount();
    host.remove();
  });

  it('keeps the history counter width and isolates its direction', async () => {
    const { readFileSync } = await import('node:fs');
    const styles = readFileSync('src/features/windows/components/TranslationWindow.scss', 'utf8');
    const counterStyles = styles.match(/\.ti-window-history-counter\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(counterStyles).toMatch(/(?:min-width|width)\s*:\s*7ch/);
    expect(counterStyles).toMatch(/direction\s*:\s*ltr/);
    expect(counterStyles).toMatch(/unicode-bidi\s*:\s*isolate/);
    const subheaderStyles = styles.match(/\.ti-window-history-subheader\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(subheaderStyles).not.toMatch(/justify-content\s*:\s*space-between/);
    expect(subheaderStyles).toMatch(/justify-content\s*:\s*(?:flex-start|start)/);
    expect(styles).toMatch(/&:dir\(rtl\)[\s\S]*?history[^{}]*previous[^{}]*\{\s*transform:\s*none[\s\S]*?history[^{}]*\{\s*transform:\s*rotate\(180deg\)/);
  });

  it('keeps the source textarea as the only bounded original-text scrollport', async () => {
    const { readFileSync } = await import('node:fs');
    const styles = readFileSync('src/features/windows/components/TranslationWindow.scss', 'utf8');
    const originalTextStyles = styles.match(/\.ti-original-text\s*\{([^}]*)\}/)?.[1] ?? '';
    const sourceInputStyles = styles.match(/\.ti-window-source-input\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(originalTextStyles).not.toMatch(/(?:max-height|overflow-y)\s*:/);
    expect(sourceInputStyles).toMatch(/max-height\s*:\s*150px/);
    expect(sourceInputStyles).toMatch(/overflow-y\s*:\s*hidden/);
    expect(sourceInputStyles).toMatch(/&\.ti-window-source-overflow\s*\{\s*overflow-y\s*:\s*auto/);
  });

  it('measures newline, wrapping, cap, and textarea resize overflow', async () => {
    const wrapper = mount(TranslationWindow, { props: baseProps });
    const editor = wrapper.find('.ti-window-source-input').element;
    const sourceInput = wrapper.find('.ti-window-source-input');
    const setMetrics = (clientHeight, scrollHeight) => {
      Object.defineProperties(editor, {
        clientHeight: { configurable: true, value: clientHeight },
        scrollHeight: { configurable: true, value: scrollHeight },
      });
    };

    setMetrics(40, 40);
    await wrapper.find('.ti-action-btn[title="window_show_original"]').trigger('click');
    const resizeObserver = findResizeObserverFor(editor);
    expect(resizeObserver).toBeDefined();
    expect(sourceInput.classes()).not.toContain('ti-window-source-overflow');
    expect(resizeObserver.observe).toHaveBeenCalledWith(editor);

    // Mocked dimensions represent two explicit lines exceeding one line of height.
    setMetrics(40, 60);
    await sourceInput.setValue('first line\nsecond line');
    expect(sourceInput.classes()).toContain('ti-window-source-overflow');

    // A single wrapped line also exceeds the available client height.
    setMetrics(40, 80);
    await sourceInput.setValue('a long source line that wraps');
    expect(sourceInput.classes()).toContain('ti-window-source-overflow');

    // The textarea remains capped at 150px; content beyond that cap scrolls.
    setMetrics(150, 151);
    resizeObserver.trigger();
    await nextTick();
    expect(sourceInput.classes()).toContain('ti-window-source-overflow');

    // Reflow after resizing can fit the same text, then overflow again.
    setMetrics(130, 130);
    resizeObserver.trigger();
    await nextTick();
    expect(sourceInput.classes()).not.toContain('ti-window-source-overflow');
    setMetrics(150, 151);
    resizeObserver.trigger();
    await nextTick();
    expect(sourceInput.classes()).toContain('ti-window-source-overflow');

    wrapper.unmount();
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce();
  });

  it('remeasures source and history changes and hides then restores overflow state', async () => {
    const wrapper = mount(TranslationWindow, {
      props: { ...baseProps, historyIndex: 0, historyLength: 2 },
    });
    const editor = wrapper.find('.ti-window-source-input').element;
    Object.defineProperties(editor, {
      clientHeight: { configurable: true, value: 50 },
      scrollHeight: { configurable: true, value: 70 },
    });
    await wrapper.find('.ti-action-btn[title="window_show_original"]').trigger('click');
    expect(wrapper.find('.ti-window-source-input').classes()).toContain('ti-window-source-overflow');

    Object.defineProperty(editor, 'scrollHeight', { configurable: true, value: 50 });
    await wrapper.find('.ti-window-source-input').setValue('edited source');
    expect(wrapper.find('.ti-window-source-input').classes()).not.toContain('ti-window-source-overflow');

    Object.defineProperty(editor, 'scrollHeight', { configurable: true, value: 70 });
    await wrapper.setProps({ historyIndex: 1, selectedText: 'history source' });
    await flushPromises();
    expect(wrapper.find('.ti-window-source-input').classes()).toContain('ti-window-source-overflow');

    Object.defineProperty(editor, 'scrollHeight', { configurable: true, value: 50 });
    await wrapper.find('.ti-action-btn[title="window_hide_original"]').trigger('click');
    expect(wrapper.find('.ti-window-source-input').classes()).not.toContain('ti-window-source-overflow');
    await wrapper.find('.ti-action-btn[title="window_show_original"]').trigger('click');
    expect(wrapper.find('.ti-window-source-input').classes()).not.toContain('ti-window-source-overflow');
    wrapper.unmount();
  });

  it('attaches and replaces the resize observer as the textarea ref appears and disappears', async () => {
    const wrapper = mount(TranslationWindow, {
      props: { ...baseProps, initialSize: 'small' },
    });

    expect(wrapper.find('.ti-window-source-input').exists()).toBe(false);
    expect(findTextareaResizeObservers()).toHaveLength(0);

    await wrapper.setProps({ initialSize: 'normal' });
    const firstEditor = wrapper.find('.ti-window-source-input').element;
    expect(findTextareaResizeObservers()).toHaveLength(1);
    const firstObserver = findResizeObserverFor(firstEditor);
    expect(firstObserver).toBeDefined();
    expect(firstObserver.observe).toHaveBeenCalledTimes(1);
    expect(firstObserver.observe).toHaveBeenCalledWith(firstEditor);

    Object.defineProperties(firstEditor, {
      clientHeight: { configurable: true, value: 40 },
      scrollHeight: { configurable: true, value: 60 },
    });
    firstObserver.trigger();
    await nextTick();
    expect(wrapper.find('.ti-window-source-input').classes()).toContain('ti-window-source-overflow');

    await wrapper.setProps({ initialSize: 'small' });
    expect(wrapper.find('.ti-window-source-input').exists()).toBe(false);
    expect(firstObserver.disconnect).toHaveBeenCalledOnce();
    firstObserver.trigger();

    await wrapper.setProps({ initialSize: 'normal' });
    const secondEditor = wrapper.find('.ti-window-source-input').element;
    expect(secondEditor).not.toBe(firstEditor);
    expect(findTextareaResizeObservers()).toHaveLength(2);
    const secondObserver = findResizeObserverFor(secondEditor);
    expect(secondObserver).toBeDefined();
    expect(secondObserver).not.toBe(firstObserver);
    expect(secondObserver.observe).toHaveBeenCalledTimes(1);
    expect(secondObserver.observe).toHaveBeenCalledWith(secondEditor);
    Object.defineProperties(secondEditor, {
      clientHeight: { configurable: true, value: 40 },
      scrollHeight: { configurable: true, value: 40 },
    });
    await nextTick();
    expect(wrapper.find('.ti-window-source-input').classes()).not.toContain('ti-window-source-overflow');

    Object.defineProperty(firstEditor, 'scrollHeight', { configurable: true, value: 100 });
    firstObserver.trigger();
    await nextTick();
    expect(wrapper.find('.ti-window-source-input').classes()).not.toContain('ti-window-source-overflow');

    Object.defineProperty(secondEditor, 'scrollHeight', { configurable: true, value: 60 });
    secondObserver.trigger();
    await nextTick();
    expect(wrapper.find('.ti-window-source-input').classes()).toContain('ti-window-source-overflow');

    wrapper.unmount();
    expect(secondObserver.disconnect).toHaveBeenCalledOnce();
  });

  it('confirms changed source text on Enter, preserves Shift+Enter, and restores on Escape', async () => {
    const wrapper = mount(TranslationWindow, { props: baseProps });
    const editor = wrapper.find('.ti-window-source-input');
    expect(editor.attributes('dir')).toBe('auto');
    await editor.setValue('  edited source  ');
    await editor.trigger('keydown', { key: 'Enter' });
    expect(pageEventBus.emit).toHaveBeenCalledWith('translation-window-confirm-source', {
      id: 'window-1', text: '  edited source  ',
    });

    pageEventBus.emit.mockClear();
    await editor.trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(pageEventBus.emit).not.toHaveBeenCalled();
    await editor.trigger('keydown', { key: 'Escape' });
    expect(editor.element.value).toBe('expressions');
    expect(pageEventBus.emit).not.toHaveBeenCalled();
  });

  it('does not confirm unchanged, whitespace-only, or composing Enter and exposes bounded history', async () => {
    const wrapper = mount(TranslationWindow, {
      props: { ...baseProps, historyIndex: 0, historyLength: 2 },
    });
    const editor = wrapper.find('.ti-window-source-input');
    await editor.trigger('keydown', { key: 'Enter' });
    await editor.setValue('   ');
    await editor.trigger('keydown', { key: 'Enter' });
    await editor.setValue('changed');
    await editor.trigger('keydown', { key: 'Enter', isComposing: true });
    expect(pageEventBus.emit).not.toHaveBeenCalledWith('translation-window-confirm-source', expect.anything());
    const previous = wrapper.find('[data-testid="translation-window-history-previous"]');
    const next = wrapper.find('[data-testid="translation-window-history-next"]');
    expect(previous.element.disabled).toBe(true);
    expect(next.element.disabled).toBe(false);
    await next.trigger('click');
    expect(pageEventBus.emit).toHaveBeenCalledWith('translation-window-history-navigate', {
      id: 'window-1', direction: 'next',
    });
  });

  it('shows and hides the only source editor with Show/Hide Original and suppresses history when hidden', async () => {
    const wrapper = mount(TranslationWindow, {
      props: { ...baseProps, historyIndex: 0, historyLength: 2 },
    });
    expect(wrapper.find('.ti-original-text-wrapper').classes()).not.toContain('is-expanded');
    await wrapper.find('.ti-action-btn[title="window_show_original"]').trigger('click');
    expect(wrapper.find('.ti-original-text-wrapper').classes()).toContain('is-expanded');
    await wrapper.find('[data-testid="translation-window-history-next"]').trigger('click');
    expect(pageEventBus.emit).toHaveBeenCalledWith('translation-window-history-navigate', {
      id: 'window-1', direction: 'next',
    });

    pageEventBus.emit.mockClear();
    await wrapper.find('.ti-action-btn[title="window_hide_original"]').trigger('click');
    expect(wrapper.find('.ti-original-text-wrapper').classes()).not.toContain('is-expanded');
    expect(wrapper.findAll('.ti-window-source-input')).toHaveLength(1);
    expect(wrapper.find('[data-testid="translation-window-history-next"]').exists()).toBe(true);
    expect(pageEventBus.emit).not.toHaveBeenCalled();
  });

  it('resets the draft on source/history changes but not unrelated result changes', async () => {
    const wrapper = mount(TranslationWindow, { props: baseProps });
    const editor = wrapper.find('.ti-window-source-input');
    await editor.setValue('local edit');
    await wrapper.setProps({ initialTranslatedText: 'another translation' });
    expect(editor.element.value).toBe('local edit');
    await wrapper.setProps({ historyIndex: 1, selectedText: baseProps.selectedText });
    expect(editor.element.value).toBe(baseProps.selectedText);
    await editor.setValue('another local edit');
    await wrapper.setProps({ selectedText: 'restored source' });
    expect(editor.element.value).toBe('restored source');
  });

  it('discards a draft when the parent reports confirmation failure', async () => {
    const wrapper = mount(TranslationWindow, { props: baseProps });
    const editor = wrapper.find('.ti-window-source-input');
    await editor.setValue('unconfirmed source');
    await wrapper.setProps({ isError: true });
    expect(editor.element.value).toBe('expressions');
  });

  it('uses system theme for auto mode and updates without remounting', async () => {
    globalThis.__mockSettingsStore.settings.THEME = 'auto';

    const wrapper = mount(TranslationWindow, {
      props: baseProps,
    });

    const windowRoot = wrapper.find('.translation-window');

    expect(windowRoot.classes()).toContain('light');
    expect(windowRoot.classes()).not.toContain('dark');

    currentMediaQueryList.dispatchChange(true);
    await nextTick();

    expect(windowRoot.classes()).toContain('dark');
    expect(windowRoot.classes()).not.toContain('light');

    currentMediaQueryList.dispatchChange(false);
    await nextTick();

    expect(windowRoot.classes()).toContain('light');
    expect(windowRoot.classes()).not.toContain('dark');
  });

  // Shared persistence-failure helpers (used by the resize lifecycle and the
  // persistence failure handling suites).
  const collectUnhandledRejections = () => {
    const failures = [];
    const onUnhandled = (reason) => failures.push(reason);
    process.on('unhandledRejection', onUnhandled);
    return {
      failures,
      release: () => process.off('unhandledRejection', onUnhandled),
    };
  };

  // Mirrors the real store: state applies synchronously, persistence rejects.
  const rejectPersistOnce = () => {
    globalThis.__mockSettingsStore.updateSettingAndPersist.mockImplementationOnce(
      async (key, value) => {
        globalThis.__mockSettingsStore.settings[key] = value;
        throw new Error('storage failed');
      }
    );
  };

  describe('docked window resize lifecycle', () => {
    const mountDocked = () => {
      globalThis.__mockSettingsStore.settings.WINDOW_DOCK_MODE = 'left';
      globalThis.__mockSettingsStore.settings.WINDOW_DOCKED_WIDTH = 350;
      return mount(TranslationWindow, { props: baseProps });
    };

    const dispatchTouchOnDocument = (type, clientX) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: [{ clientX, clientY: 100 }] });
      document.dispatchEvent(event);
    };

    const dispatchMouseOnDocument = (type, clientX) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clientX', { value: clientX });
      document.dispatchEvent(event);
    };

    it('suppresses only the completion click of a mouse resize ending outside the window', async () => {
      const wrapper = mountDocked();
      const handle = wrapper.find('.ti-dock-resize-handle');
      const markerAtDocumentCapture = vi.fn(() => window.__TRANSLATION_WINDOW_JUST_RESIZED);
      const markerAtDocumentBubble = vi.fn(() => window.__TRANSLATION_WINDOW_JUST_RESIZED);
      document.addEventListener('click', markerAtDocumentCapture, { capture: true });

      // mousedown on the resize handle starts a protected resize session
      await handle.trigger('mousedown', { clientX: 100, clientY: 100 });
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(true);

      // Mouse released outside the window: the browser then fires a click
      // targeting HTML, which must not dismiss the docked window.
      dispatchMouseOnDocument('mousemove', 150);
      await nextTick();
      dispatchMouseOnDocument('mouseup', 150);
      await nextTick();
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(false);

      // Protection is active through the completion click (no new pointerdown
      // has happened between mouseup and the click).
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);
      // This consumer registers after mouseup but before the completion click;
      // window capture must add cleanup behind it for this dispatch.
      document.addEventListener('click', markerAtDocumentBubble);
      document.dispatchEvent(new MouseEvent('click'));
      expect(markerAtDocumentCapture).toHaveReturnedWith(true);
      expect(markerAtDocumentBubble).toHaveReturnedWith(true);
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);

      // The next pointerdown starts an independent interaction: dismissal is
      // immediate (marker already cleared, listener disarmed).
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);

      document.removeEventListener('click', markerAtDocumentCapture, { capture: true });
      document.removeEventListener('click', markerAtDocumentBubble);
      wrapper.unmount();
      trackedDisposers.forEach((cleanupFn) => cleanupFn());
    });

    it('does not let an earlier click event clear a newer resize session marker', async () => {
      const wrapper = mountDocked();
      const handle = wrapper.find('.ti-dock-resize-handle');

      // Resize A completes outside and its click is bound at window capture.
      handle.element.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, clientX: 100, clientY: 100,
      }));
      dispatchMouseOnDocument('mouseup', 150);
      const startResizeBOnCapture = () => {
        document.removeEventListener('click', startResizeBOnCapture, { capture: true });
        handle.element.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, clientX: 100, clientY: 100,
        }));
        dispatchMouseOnDocument('mouseup', 160);
      };
      document.addEventListener('click', startResizeBOnCapture, { capture: true, once: true });
      document.dispatchEvent(new MouseEvent('click'));

      // The completion event for A cannot clear B's newly generated token.
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);

      // B's own click reaches document bubble and clears synchronously.
      document.dispatchEvent(new MouseEvent('click'));
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);

      wrapper.unmount();
      trackedDisposers.forEach((cleanupFn) => cleanupFn());
    });

    it('keeps protection when a target stops propagation, then clears on pointerdown', async () => {
      const wrapper = mountDocked();
      const handle = wrapper.find('.ti-dock-resize-handle');
      await handle.trigger('mousedown', { clientX: 100, clientY: 100 });
      dispatchMouseOnDocument('mouseup', 150);

      const target = document.createElement('button');
      document.body.append(target);
      target.addEventListener('click', (event) => event.stopPropagation(), { once: true });
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);

      // The next independent interaction disarms the missed bubble cleanup.
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);
      const markerOnNextClick = vi.fn(() => window.__TRANSLATION_WINDOW_JUST_RESIZED);
      document.addEventListener('click', markerOnNextClick);
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(markerOnNextClick).toHaveReturnedWith(false);
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);
      document.removeEventListener('click', markerOnNextClick);
      target.remove();

      wrapper.unmount();
      trackedDisposers.forEach((cleanupFn) => cleanupFn());
    });

    it('keeps rapid resize sessions independent: each protects only its own completion click', async () => {
      const wrapper = mountDocked();
      const handle = wrapper.find('.ti-dock-resize-handle');

      await handle.trigger('mousedown', { clientX: 100, clientY: 100 });
      dispatchMouseOnDocument('mouseup', 150);
      await nextTick();
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);

      // Starting the next session fires a pointerdown first (real browser
      // ordering): the previous marker is cleared before the new session begins.
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);

      await handle.trigger('mousedown', { clientX: 100, clientY: 100 });
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(true);
      dispatchMouseOnDocument('mouseup', 160);
      await nextTick();
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(false);

      wrapper.unmount();
      trackedDisposers.forEach((cleanupFn) => cleanupFn());
    });

    it('applies the same event-scoped protection when a mouse resize ends inside the window', async () => {
      // attachTo: document so a mouseup on the window element really
      // bubbles to the document-level stop listener (browser ordering).
      globalThis.__mockSettingsStore.settings.WINDOW_DOCK_MODE = 'left';
      globalThis.__mockSettingsStore.settings.WINDOW_DOCKED_WIDTH = 350;
      const wrapper = mount(TranslationWindow, { props: baseProps, attachTo: document.body });
      const handle = wrapper.find('.ti-dock-resize-handle');
      const mousedown = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
      });
      handle.element.dispatchEvent(mousedown);
      expect(mousedown.defaultPrevented).toBe(true);
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(true);
      expect(document.body.style.userSelect).toBe('none');

      dispatchMouseOnDocument('mousemove', 150);
      await nextTick();
      expect(wrapper.find('.translation-window').attributes('style')).toContain('width: 400px');

      // mouseup dispatched from inside the window element (bubbles to document)
      wrapper.find('.translation-window').element.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true })
      );
      await nextTick();
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(false);
      expect(document.body.style.userSelect).toBe('');
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);

      // No stale protection: a new interaction clears it without any click.
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);

      wrapper.unmount();
      trackedDisposers.forEach((cleanupFn) => cleanupFn());
    });

    it('clears resize protection on touch cancellation so an outside click dismisses', async () => {
      const wrapper = mountDocked();
      const handle = wrapper.find('.ti-dock-resize-handle');
      const facade = { _isInShiftClickOperation: false };
      const dismissalManager = new DismissalManager(facade, {
        state: { isIconMode: false, isVisible: true, isPinned: false },
      });
      const dismissSpy = vi.spyOn(dismissalManager, 'dismiss').mockResolvedValue(undefined);
      dismissalManager._addDismissListener();

      await handle.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(true);

      dispatchTouchOnDocument('touchcancel', 150);
      await nextTick();
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(false);
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);
      expect(globalThis.__mockSettingsStore.updateSettingAndPersist).toHaveBeenCalledWith(
        'WINDOW_DOCKED_WIDTH',
        expect.any(Number)
      );

      // No pointerdown occurs between cancellation and this unrelated click.
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(dismissSpy).toHaveBeenCalledOnce();

      // Unmount clears the protection flags and capture listeners.
      document.removeEventListener('click', facade._dismissHandler, { capture: false });
      document.removeEventListener('keydown', facade._escapeKeyHandler, { capture: false });
      wrapper.unmount();
      trackedDisposers.forEach((cleanupFn) => cleanupFn());
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);
    });

    it('clears resize dismissal protection when unmounted during an active resize', async () => {
      const wrapper = mountDocked();
      const handle = wrapper.find('.ti-dock-resize-handle');
      await handle.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(true);

      wrapper.unmount();
      trackedDisposers.forEach((cleanupFn) => cleanupFn());

      // No persistent global state may survive the component.
      expect(window.__TRANSLATION_WINDOW_IS_RESIZING).toBe(false);
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(false);

      // No stale capture or bubble listeners survive unmount.
      window.__TRANSLATION_WINDOW_JUST_RESIZED = true;
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);
      document.dispatchEvent(new MouseEvent('click'));
      expect(window.__TRANSLATION_WINDOW_JUST_RESIZED).toBe(true);
      window.__TRANSLATION_WINDOW_JUST_RESIZED = false;
    });

    it('clears gesture protection for this window root on unmount', () => {
      const clearGestureFor = vi.fn();
      window.windowsManagerInstance = {
        state: { setPinned: vi.fn(), setDockMode: vi.fn() },
        clickManager: { clearGestureFor },
      };

      const wrapper = mount(TranslationWindow, { props: baseProps });
      const windowRoot = wrapper.find('.ti-window').element;
      expect(windowRoot).toBeTruthy();

      wrapper.unmount();

      expect(clearGestureFor).toHaveBeenCalledTimes(1);
      expect(clearGestureFor).toHaveBeenCalledWith(windowRoot);
    });

    it('stops resizing when a touch is cancelled', async () => {
      const wrapper = mountDocked();
      const handle = wrapper.find('.ti-dock-resize-handle');
      await handle.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
      dispatchTouchOnDocument('touchmove', 150);
      await nextTick();
      expect(wrapper.find('.translation-window').attributes('style')).toContain('width: 400px');

      dispatchTouchOnDocument('touchcancel', 150);
      await nextTick();
      expect(document.body.style.userSelect).toBe('');

      dispatchTouchOnDocument('touchmove', 250);
      await nextTick();
      expect(wrapper.find('.translation-window').attributes('style')).toContain('width: 400px');
    });

    it('removes document listeners on unmount during an active resize', async () => {
      const wrapper = mountDocked();
      const handle = wrapper.find('.ti-dock-resize-handle');
      await handle.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
      dispatchTouchOnDocument('touchmove', 150);
      await nextTick();
      expect(wrapper.find('.translation-window').attributes('style')).toContain('width: 400px');

      wrapper.unmount();
      trackedDisposers.forEach((cleanupFn) => cleanupFn());

      dispatchTouchOnDocument('touchmove', 250);
      dispatchTouchOnDocument('touchend', 250);
      expect(globalThis.__mockSettingsStore.updateSettingAndPersist).not.toHaveBeenCalledWith(
        'WINDOW_DOCKED_WIDTH',
        expect.any(Number)
      );
    });

    it('keeps a single set of document listeners across repeated resize sessions', async () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      const wrapper = mountDocked();
      const handle = wrapper.find('.ti-dock-resize-handle');
      await handle.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
      dispatchTouchOnDocument('touchmove', 150);
      dispatchTouchOnDocument('touchend', 150);
      await nextTick();
      await handle.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
      dispatchTouchOnDocument('touchmove', 160);
      await nextTick();

      const countByType = (spy, type) => spy.mock.calls.filter((call) => call[0] === type).length;
      for (const type of ['mousemove', 'mouseup', 'touchmove', 'touchend', 'touchcancel']) {
        expect(countByType(addSpy, type) - countByType(removeSpy, type)).toBe(1);
      }
      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('handles persistence rejection on resize stop without interrupting interaction', async () => {
      const { failures, release } = collectUnhandledRejections();
      try {
        const wrapper = mountDocked();
        const handle = wrapper.find('.ti-dock-resize-handle');
        await handle.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
        dispatchTouchOnDocument('touchmove', 150);
        await nextTick();

        rejectPersistOnce();
        dispatchTouchOnDocument('touchend', 150);
        await flushPromises();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Resize completes normally with the resized width staged in state.
        expect(globalThis.__mockSettingsStore.updateSettingAndPersist).toHaveBeenCalledWith(
          'WINDOW_DOCKED_WIDTH',
          400
        );
        expect(globalThis.__mockSettingsStore.settings.WINDOW_DOCKED_WIDTH).toBe(400);
        expect(wrapper.find('.translation-window').attributes('style')).toContain('width: 400px');
        // Failure is logged, not thrown: no unhandled rejection.
        expect(mockLoggerWarn).toHaveBeenCalled();
        expect(failures).toHaveLength(0);

        // Event cleanup still happens: further moves are ignored, body restored.
        expect(document.body.style.userSelect).toBe('');
        dispatchTouchOnDocument('touchmove', 250);
        await nextTick();
        expect(wrapper.find('.translation-window').attributes('style')).toContain('width: 400px');

        // Interaction uninterrupted: a new resize session still persists.
        await handle.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
        dispatchTouchOnDocument('touchmove', 160);
        dispatchTouchOnDocument('touchend', 160);
        await flushPromises();
        expect(globalThis.__mockSettingsStore.updateSettingAndPersist).toHaveBeenCalledWith(
          'WINDOW_DOCKED_WIDTH',
          460
        );
      } finally {
        release();
      }
    });
  });

  describe('settings persistence failure handling', () => {
    it('pin toggle applies immediately and handles persistence rejection without rollback', async () => {
      const { failures, release } = collectUnhandledRejections();
      try {
        const wrapper = mount(TranslationWindow, { props: baseProps });
        rejectPersistOnce();

        await wrapper.find('.ti-action-btn[title="window_pin"]').trigger('click');
        await flushPromises();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Runtime (local + manager) updates stay immediate and are kept.
        expect(globalThis.__mockSettingsStore.settings.WINDOW_IS_PINNED).toBe(true);
        expect(window.windowsManagerInstance.state.setPinned).toHaveBeenCalledWith(true);
        // Failure is logged, not thrown: no unhandled rejection, no rollback.
        expect(mockLoggerWarn).toHaveBeenCalled();
        expect(failures).toHaveLength(0);
        expect(globalThis.__mockSettingsStore.settings.WINDOW_IS_PINNED).toBe(true);
        expect(window.windowsManagerInstance.state.setPinned).toHaveBeenCalledWith(true);
      } finally {
        release();
      }
    });

    it('dock-mode change applies immediately and handles persistence rejection without rollback', async () => {
      const { failures, release } = collectUnhandledRejections();
      try {
        mount(TranslationWindow, { props: baseProps });
        rejectPersistOnce();

        globalThis.__mockCurrentDockMode.value = 'left';
        await nextTick();
        await flushPromises();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(globalThis.__mockSettingsStore.settings.WINDOW_DOCK_MODE).toBe('left');
        expect(window.windowsManagerInstance.state.setDockMode).toHaveBeenCalledWith('left');
        expect(mockLoggerWarn).toHaveBeenCalled();
        expect(failures).toHaveLength(0);
        expect(globalThis.__mockSettingsStore.settings.WINDOW_DOCK_MODE).toBe('left');
      } finally {
        release();
      }
    });

    it('a later change still persists after a persistence failure', async () => {
      const { failures, release } = collectUnhandledRejections();
      try {
        const wrapper = mount(TranslationWindow, { props: baseProps });
        rejectPersistOnce();

        await wrapper.find('.ti-action-btn[title="window_pin"]').trigger('click');
        await flushPromises();

        // Title flips while pinned; toggle back with the updated selector.
        await wrapper.find('.ti-action-btn[title="window_unpin"]').trigger('click');
        await flushPromises();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const persist = globalThis.__mockSettingsStore.updateSettingAndPersist;
        expect(persist).toHaveBeenCalledTimes(2);
        expect(persist).toHaveBeenNthCalledWith(2, 'WINDOW_IS_PINNED', false);
        expect(globalThis.__mockSettingsStore.settings.WINDOW_IS_PINNED).toBe(false);
        expect(failures).toHaveLength(0);
      } finally {
        release();
      }
    });
  });
});
