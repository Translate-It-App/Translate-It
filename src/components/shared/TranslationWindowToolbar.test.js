import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import TranslationWindowToolbar from './TranslationWindowToolbar.vue';
import { readFileSync } from 'node:fs';

let resizeObservers;
class MockResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.elements = new Set();
    this.disconnect = vi.fn(() => this.elements.clear());
    this.observe = vi.fn((element) => this.elements.add(element));
    this.unobserve = vi.fn((element) => this.elements.delete(element));
    resizeObservers.push(this);
  }
}

beforeEach(() => {
  resizeObservers = [];
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const setLabelDimensions = (element, { scrollWidth, clientWidth }) => {
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, value: scrollWidth },
    clientWidth: { configurable: true, value: clientWidth },
  });
};

vi.mock('@/components/shared/ProviderSelector.vue', () => ({
  default: {
    name: 'ProviderSelector',
    props: {
      modelValue: { type: String, default: '' },
      mode: { type: String, default: '' },
      isGlobal: { type: Boolean, default: false },
      allowDefault: { type: Boolean, default: false },
      allowSetDefault: { type: Boolean, default: false },
      onlyConfigured: { type: Boolean, default: false },
      requiredFeature: { type: String, default: '' },
    },
    template: `
      <button
        class="provider-selector-stub"
        @click="$emit('update:modelValue', 'deepl')"
      >
        provider
      </button>
    `,
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
    template: `
      <div class="tts-button-stub">
        <button class="tts-start" @click="$emit('tts-started', { text })">start</button>
        <button class="tts-stop" @click="$emit('tts-stopped')">stop</button>
        <button class="tts-error" @click="$emit('tts-error', 'boom')">error</button>
        <button class="tts-state" @click="$emit('state-changed', 'playing')">state</button>
      </div>
    `,
  },
}));

vi.mock('@/components/shared/IconButton.vue', () => ({
  default: {
    name: 'IconButton',
    inheritAttrs: true,
    props: ['icon', 'title', 'alt'],
    template: '<button v-bind="$attrs" :title="title" :aria-label="alt"></button>',
  },
}));

describe('TranslationWindowToolbar.vue', () => {
  const baseProps = {
    provider: 'googlev2',
    theme: 'light',
    isPinned: false,
    showOriginal: false,
    isDictionary: false,
    ttsText: 'hello',
    ttsLanguage: 'en',
    targetLanguageLabel: 'Persian',
    detectedLanguageLabel: 'English',
    pinTitle: 'window_pin',
    copyTitle: 'window_copy_translation',
    originalTitle: 'window_show_original',
    closeTitle: 'window_close',
    providerSelectorMode: 'icon-only',
    providerSelectorIsGlobal: false,
    providerSelectorAllowDefault: false,
    providerSelectorAllowSetDefault: true,
    providerSelectorOnlyConfigured: true,
    providerSelectorRequiredFeature: 'translation',
    historyIndex: 0,
    historyLength: 2,
    historyPreviousTitle: 'Previous',
    historyNextTitle: 'Next',
  };

  it('renders the shared window controls and labels', () => {
    const wrapper = mount(TranslationWindowToolbar, {
      props: baseProps,
    });

    expect(wrapper.findComponent({ name: 'ProviderSelector' }).props('mode')).toBe('icon-only');
    expect(wrapper.findComponent({ name: 'ProviderSelector' }).props('isGlobal')).toBe(false);
    expect(wrapper.findComponent({ name: 'ProviderSelector' }).props('allowDefault')).toBe(false);
    expect(wrapper.findComponent({ name: 'ProviderSelector' }).props('allowSetDefault')).toBe(true);
    expect(wrapper.findComponent({ name: 'ProviderSelector' }).props('onlyConfigured')).toBe(true);
    expect(wrapper.find('.provider-selector-stub').exists()).toBe(true);
    expect(wrapper.find('.tts-button-stub').exists()).toBe(true);
    expect(wrapper.find('.ti-action-btn[title="window_pin"]').exists()).toBe(true);
    expect(wrapper.find('.ti-action-btn[title="window_copy_translation"]').exists()).toBe(true);
    expect(wrapper.find('.ti-action-btn[title="window_show_original"]').exists()).toBe(true);
    expect(wrapper.find('.ti-target-language-label').text()).toBe('Persian');
    expect(wrapper.find('.ti-detected-language-label').text()).toBe('English');
    expect(wrapper.find('.ti-action-btn[title="window_close"]').exists()).toBe(true);
    expect(wrapper.find('.ti-action-btn[title*="dock"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="translation-window-history-previous"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="translation-window-history-next"]').exists()).toBe(false);
  });

  it('keeps long language labels constrained beside fixed controls in RTL and narrow layouts', () => {
    const wrapper = mount(TranslationWindowToolbar, {
      props: {
        ...baseProps,
        targetLanguageLabel: 'An exceptionally long target language name',
        detectedLanguageLabel: 'An exceptionally long detected language name',
      },
      attrs: { dir: 'rtl' },
    });
    const styles = readFileSync('src/components/shared/TranslationWindowToolbar.scss', 'utf8');

    expect(wrapper.attributes('dir')).toBe('rtl');
    expect(wrapper.find('[data-testid="translation-window-toolbar-target-language"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="translation-window-toolbar-detected-language"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="translation-window-toolbar-close"]').attributes('aria-label')).toBe('window_close');
    expect(wrapper.findAll('.ti-action-btn')).toHaveLength(4);
    expect(styles).toMatch(/\.ti-header-close\s*\{[^}]*gap:\s*4px/);
    expect(styles).toMatch(/\.ti-header-actions\s*\{[^}]*flex:\s*0 0 auto\s*!important/);
    expect(styles).toMatch(/\.ti-header-close\s*\{[^}]*flex:\s*1 1 auto\s*!important/);
    expect(styles).toMatch(/&:has\(\.ti-target-language-label, \.ti-detected-language-label\)\s*\{[^}]*column-gap:\s*4px/);
    expect(styles).toMatch(/\.ti-target-language-label,[\s\S]*?\.ti-detected-language-label\s*\{[^}]*min-width:\s*0/);
    expect(styles).toMatch(/\.ti-target-language-label,[\s\S]*?\.ti-detected-language-label\s*\{[^}]*max-width:\s*80px/);
    expect(styles).toMatch(/\.ti-window\.is-docked \.ti-header-close\s*\{[\s\S]*?\.ti-target-language-label,[\s\S]*?\.ti-detected-language-label\s*\{[^}]*max-width:\s*none\s*;/);
    expect(styles).toMatch(/\.ti-action-btn,[\s\S]*?width:\s*28px[\s\S]*?flex:\s*0 0 28px/);
  });

  it('adds and removes independent native titles as labels truncate, change, and appear', async () => {
    const wrapper = mount(TranslationWindowToolbar, {
      props: baseProps,
      attrs: { dir: 'rtl' },
    });
    const target = wrapper.find('.ti-target-language-label').element;
    const detected = wrapper.find('.ti-detected-language-label').element;
    setLabelDimensions(target, { scrollWidth: 120, clientWidth: 50 });
    setLabelDimensions(detected, { scrollWidth: 50, clientWidth: 50 });
    const observer = resizeObservers[0];
    observer.callback();
    await wrapper.vm.$nextTick();

    expect(target.title).toBe('Persian');
    expect(detected.hasAttribute('title')).toBe(false);
    expect(observer.observe).toHaveBeenCalledWith(target);
    expect(observer.observe).toHaveBeenCalledWith(detected);

    setLabelDimensions(target, { scrollWidth: 51, clientWidth: 50 });
    setLabelDimensions(detected, { scrollWidth: 80, clientWidth: 50 });
    observer.callback();
    await wrapper.vm.$nextTick();
    expect(target.hasAttribute('title')).toBe(false);
    expect(detected.title).toBe('English');

    setLabelDimensions(target, { scrollWidth: 120, clientWidth: 50 });
    await wrapper.setProps({ targetLanguageLabel: 'Persian (updated)' });
    await wrapper.vm.$nextTick();
    expect(target.title).toBe('Persian (updated)');

    await wrapper.setProps({ detectedLanguageLabel: '' });
    expect(observer.unobserve).toHaveBeenCalledWith(detected);
    await wrapper.setProps({ detectedLanguageLabel: 'French' });
    const reappeared = wrapper.find('.ti-detected-language-label').element;
    setLabelDimensions(reappeared, { scrollWidth: 90, clientWidth: 50 });
    observer.callback();
    await wrapper.vm.$nextTick();
    expect(reappeared.title).toBe('French');
    expect(observer.observe).toHaveBeenCalledWith(reappeared);

    wrapper.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it('does not prevent label pointer or mouse events from bubbling', async () => {
    const wrapper = mount(TranslationWindowToolbar, { props: baseProps });
    const bubbled = vi.fn();
    wrapper.element.addEventListener('mousedown', bubbled);
    wrapper.element.addEventListener('pointerdown', bubbled);
    await wrapper.find('.ti-target-language-label').trigger('mousedown');
    await wrapper.find('.ti-target-language-label').trigger('pointerdown');
    expect(bubbled).toHaveBeenCalledTimes(2);
  });

  it('emits toolbar events exactly once', async () => {
    const wrapper = mount(TranslationWindowToolbar, {
      props: baseProps,
    });

    const providerSelector = wrapper.findComponent({ name: 'ProviderSelector' });
    providerSelector.vm.$emit('update:modelValue', 'deepl');
    providerSelector.vm.$emit('provider-change', 'deepl');
    expect(wrapper.emitted('provider-change')).toEqual([['deepl']]);

    await wrapper.find('.ti-action-btn[title="window_pin"]').trigger('click');
    expect(wrapper.emitted('toggle-pin')).toEqual([[]]);

    await wrapper.find('.ti-action-btn[title="window_copy_translation"]').trigger('click');
    expect(wrapper.emitted('copy')).toEqual([[]]);

    await wrapper.find('.tts-start').trigger('click');
    expect(wrapper.emitted('tts-started')).toEqual([[{ text: 'hello' }]]);

    await wrapper.find('.tts-stop').trigger('click');
    expect(wrapper.emitted('tts-stopped')).toEqual([[]]);

    await wrapper.find('.tts-error').trigger('click');
    expect(wrapper.emitted('tts-error')).toEqual([['boom']]);

    await wrapper.find('.tts-state').trigger('click');
    expect(wrapper.emitted('tts-state-changed')).toEqual([['playing']]);

    await wrapper.find('.ti-action-btn[title="window_show_original"]').trigger('click');
    expect(wrapper.emitted('toggle-original')).toEqual([[]]);

    await wrapper.find('.ti-action-btn[title="window_close"]').trigger('click');
    expect(wrapper.emitted('close')).toEqual([[]]);

    expect(wrapper.find('[data-testid="translation-window-toolbar-provider-selector"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="translation-window-history-previous"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="translation-window-history-next"]').exists()).toBe(false);
  });

  it('keeps provider dedupe state isolated between toolbar instances', () => {
    const first = mount(TranslationWindowToolbar, {
      props: baseProps,
    });
    const second = mount(TranslationWindowToolbar, {
      props: baseProps,
    });

    const firstSelector = first.findComponent({ name: 'ProviderSelector' });
    const secondSelector = second.findComponent({ name: 'ProviderSelector' });

    firstSelector.vm.$emit('update:modelValue', 'deepl');
    firstSelector.vm.$emit('provider-change', 'deepl');
    secondSelector.vm.$emit('update:modelValue', 'openai');
    secondSelector.vm.$emit('provider-change', 'openai');

    expect(first.emitted('provider-change')).toEqual([['deepl']]);
    expect(second.emitted('provider-change')).toEqual([['openai']]);
  });

  it('does not import the WindowsManager stack', () => {
    const source = readFileSync('src/components/shared/TranslationWindowToolbar.vue', 'utf8');

    expect(source).not.toContain('@/features/windows');
    expect(source).not.toContain('src/features/windows');
    expect(source).toMatch(/import ['"]\.\/TranslationWindowToolbar\.scss['"]/);
  });
});
