import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from 'sass';
import postcss from 'postcss';
import TranslationDisplay from './TranslationDisplay.vue';
import { SimpleMarkdown } from '@/shared/utils/text/markdown.js';
import { TranslationMode } from '@/shared/config/config.js';
const pronunciationMarkdown = [
  'Expression',
  '',
  '**UK** : `/ɪkˈspreʃnz/`    **US** : `/ɪkˈspreʃnz/`',
  '',
  '- **Noun**: Expression, phrase, wording',
  '- **Synonyms**: Phrase, wording, statement',
].join('\n');
const settingsMock = vi.hoisted(() => ({ dark: false }));

vi.mock('@/composables/shared/useTextDirection.js', () => ({
  useTextDirection: (contentRef) => {
    const text = typeof contentRef?.value === 'string' ? contentRef.value : '';
    const rtlCount = (text.match(/[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
    const direction = rtlCount > 0 ? 'rtl' : 'ltr';

    return {
      direction: ref(direction),
      textAlign: ref(direction === 'rtl' ? 'right' : 'left'),
    };
  },
}));

vi.mock('@/composables/shared/useFont.js', () => ({
  useFont: () => ({
    fontStyles: ref({}),
    cssVariables: ref({}),
  }),
}));

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key) => key,
    locale: ref('en'),
  }),
}));

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => ({
    get isDarkTheme() {
      return settingsMock.dark;
    },
  }),
}));

vi.mock('@/features/text-actions/components/ActionToolbar.vue', () => ({
  default: {
    name: 'ActionToolbar',
    template: '<div class="action-toolbar-stub" />',
  },
}));

describe('TranslationDisplay.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.dark = false;
  });

  const mountDisplay = async (props) => {
    const wrapper = mount(TranslationDisplay, {
      props: {
        showToolbar: false,
        enableMarkdown: true,
        ...props,
      },
    });

    await nextTick();
    return wrapper;
  };

  it('shows loading only before streaming and shares it across display modes', async () => {
    for (const mode of ['standard', 'compact', 'popup', 'sidepanel', 'selection', 'mobile']) {
      const wrapper = await mountDisplay({ mode, isLoading: true, isStreaming: false });

      expect(wrapper.find('.ti-translation-loading-indicator').exists(), mode).toBe(true);
      expect(wrapper.find('.ti-translation-content').exists(), mode).toBe(false);
      wrapper.unmount();
    }
  });

  it('follows the dark-theme setting while showing the loading indicator', async () => {
    const wrapper = await mountDisplay({ isLoading: true });
    expect(wrapper.classes()).not.toContain('theme-dark');

    settingsMock.dark = true;
    wrapper.vm.$forceUpdate();
    await nextTick();

    expect(wrapper.classes()).toContain('theme-dark');
    expect(wrapper.find('.ti-translation-loading-indicator').exists()).toBe(true);
  });

  it('does not show the loader during streaming, with or without a partial result', async () => {
    for (const content of ['', 'partial translation']) {
      const wrapper = await mountDisplay({ isLoading: true, isStreaming: true, content });

      expect(wrapper.find('.ti-translation-loading-indicator').exists()).toBe(false);
      expect(wrapper.find('.ti-translation-content').exists()).toBe(true);
      if (content) expect(wrapper.find('.ti-translation-content').text()).toContain(content);
      wrapper.unmount();
    }
  });

  it('moves from loading through streaming to successful content without retaining the loader', async () => {
    const wrapper = await mountDisplay({ isLoading: true });
    expect(wrapper.find('.ti-translation-loading-indicator').exists()).toBe(true);

    await wrapper.setProps({ isStreaming: true, content: 'partial' });
    expect(wrapper.find('.ti-translation-loading-indicator').exists()).toBe(false);
    expect(wrapper.find('.ti-translation-content').text()).toContain('partial');

    await wrapper.setProps({ isLoading: false, isStreaming: false, content: 'complete' });
    expect(wrapper.find('.ti-translation-loading-indicator').exists()).toBe(false);
    expect(wrapper.find('.ti-translation-content').text()).toContain('complete');
  });

  it('suppresses previous content and errors while pending, then shows errors or cancellation reset', async () => {
    const wrapper = await mountDisplay({ content: 'previous result' });
    expect(wrapper.find('.ti-translation-content').text()).toContain('previous result');

    await wrapper.setProps({ isLoading: true, isStreaming: false, error: 'previous error' });
    expect(wrapper.find('.ti-translation-loading-indicator').exists()).toBe(true);
    expect(wrapper.find('.ti-translation-content').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('previous error');

    await wrapper.setProps({ isLoading: false, error: 'translation failed', content: '' });
    expect(wrapper.find('.ti-translation-loading-indicator').exists()).toBe(false);
    expect(wrapper.find('.error-message').text()).toContain('translation failed');

    await wrapper.setProps({ isLoading: true, error: '', content: '' });
    expect(wrapper.find('.ti-translation-loading-indicator').exists()).toBe(true);
    await wrapper.setProps({ isLoading: false, isStreaming: false, content: '', error: '' });
    expect(wrapper.find('.ti-translation-loading-indicator').exists()).toBe(false);
    expect(wrapper.find('.placeholder-message').exists()).toBe(true);
  });

  it('keeps toolbar predicates and emits no loading-state events', async () => {
    const wrapper = await mountDisplay({ content: 'result', isLoading: false, showToolbar: true });
    expect(wrapper.find('.action-toolbar-stub').exists()).toBe(true);

    await wrapper.setProps({ isLoading: true });
    expect(wrapper.find('.action-toolbar-stub').exists()).toBe(false);
    expect(Object.keys(wrapper.emitted())).toEqual([]);

    await wrapper.setProps({ isLoading: false, content: '', showToolbar: true });
    expect(wrapper.find('.action-toolbar-stub').exists()).toBe(false);
  });

  it('structurally routes current display consumers through the shared component', () => {
    const consumers = [
      'src/components/popup/TranslationForm.vue',
      'src/apps/sidepanel/components/SidepanelMainContent.vue',
      'src/apps/pdf/components/PdfWindowsHost.vue',
      'src/features/windows/components/TranslationWindow.vue',
      'src/apps/content/components/mobile/views/InputView.vue',
      'src/apps/content/components/mobile/views/SelectionView.vue',
      'src/apps/content/components/MouseHoverTooltip.vue',
    ];

    for (const file of consumers) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source, file).toMatch(/import\s+TranslationDisplay\s+from\s+["'][^"']*components\/shared\/TranslationDisplay\.vue["']/);
      expect(source, file).toMatch(/<TranslationDisplay\b/);
    }
  });

  it('keeps the normal loading overlay geometry while making only popup, sidepanel, and window loading surfaces transparent', () => {
    const cssPath = resolve(process.cwd(), 'src/components/shared/TranslationDisplay.scss');
    const root = postcss.parse(compile(cssPath, {
      importers: [{
        findFileUrl(url) {
          if (url.startsWith('@/')) return new URL(`file://${resolve(process.cwd(), 'src', url.slice(2))}`);
          return null;
        },
      }],
    }).css);
    const rules = [];
    root.walkRules((rule) => rules.push(rule));
    const declarationFor = (selector, property) => rules
      .filter((rule) => rule.selectors?.includes(selector))
      .flatMap((rule) => rule.nodes.filter((node) => node.type === 'decl' && node.prop === property).map((node) => node.value));

    expect(declarationFor('.ti-translation-display.is-loading', 'min-height')).toContain('120px');
    expect(declarationFor('.ti-translation-display.is-loading .ti-loading-overlay', 'position')).toContain('absolute');
    expect(declarationFor('.ti-translation-display.is-loading .ti-loading-overlay', 'width')).toContain('100%');
    expect(declarationFor('.ti-translation-display.is-loading .ti-loading-overlay', 'height')).toContain('100%');

    const transparentRules = rules.filter((rule) => rule.nodes.some((node) =>
      node.type === 'decl' && node.value === 'transparent' && ['background', 'background-color', 'border', 'border-color'].includes(node.prop)));
    const selectorText = transparentRules.map(({ selector }) => selector).join(',');
    expect(selectorText).toContain('.popup-mode.is-loading');
    expect(selectorText).toContain('.sidepanel-mode.is-loading');
    expect(selectorText).toContain('.ti-window-translation-display.is-loading');
    expect(selectorText).not.toMatch(/\.(?:standard|selection|mobile|compact)-mode\.is-loading/);
  });

  it('renders normalized Google bold-label markdown through the modern marked path', async () => {
    const renderSpy = vi.spyOn(SimpleMarkdown, 'render');
    const wrapper = await mountDisplay({
      content: 'بله\n\n**Pronunciation**: /yes/\n\n**Definitions**:\n- (علامت تعجب) used to give an affirmative response.\n\n**Examples**:\n- you think I perhaps killed Westbourne, yes?',
      lastTranslation: {
        mode: TranslationMode.Dictionary_Translation,
      },
    });

    expect(renderSpy).not.toHaveBeenCalled();
    const markdown = wrapper.find('.simple-markdown');
    expect(markdown.exists()).toBe(true);
    const directParagraphs = Array.from(markdown.element.children).filter((el) => el.tagName === 'P');
    expect(directParagraphs[0].getAttribute('dir')).toBe('rtl');
    expect(directParagraphs[1].getAttribute('dir')).toBe('ltr');
    expect(markdown.find('p.md-label-paragraph').attributes('dir')).toBe('ltr');
    expect(markdown.find('ul.md-label-list > li').attributes('dir')).toBe('ltr');
  });

  it('keeps pronunciation labels and IPA text on the same rendered line', async () => {
    const wrapper = await mountDisplay({
      content: pronunciationMarkdown,
      lastTranslation: {
        mode: TranslationMode.Dictionary_Translation,
      },
    });

    const paragraphs = wrapper.findAll('.simple-markdown > p');
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);

    const pronunciationLine = paragraphs[1];
    expect(pronunciationLine.text().replace(/\s+/g, ' ')).toContain('UK : /ɪkˈspreʃnz/ US : /ɪkˈspreʃnz/');
    expect(pronunciationLine.findAll('strong')).toHaveLength(2);
    expect(pronunciationLine.findAll('code')).toHaveLength(2);
    expect(pronunciationLine.html()).toContain('<code>/ɪkˈspreʃnz/</code>');
    expect(pronunciationLine.html()).not.toContain('<br>');
    expect(pronunciationLine.attributes('dir')).toBe('ltr');
  });

  it('renders Vajehyab markdown-like output through the modern marked path', async () => {
    const renderSpy = vi.spyOn(SimpleMarkdown, 'render');
    const wrapper = await mountDisplay({
      content: '### سلام [salām]\n*اسم*\n\n---\n\n**معنی (لغت‌نامه عمید)**:\nدرود، تحیت',
      lastTranslation: {
        mode: TranslationMode.Dictionary_Translation,
      },
    });

    expect(renderSpy).not.toHaveBeenCalled();
    const markdown = wrapper.find('.simple-markdown');
    expect(markdown.exists()).toBe(true);
    expect(markdown.find('h3').text()).toBe('سلام [salām]');
    expect(markdown.find('em').text()).toBe('اسم');
    expect(markdown.find('strong').text()).toBe('معنی (لغت‌نامه عمید)');
    expect(markdown.find('h3').attributes('dir')).toBe('rtl');
    expect(markdown.find('strong').element.parentElement?.getAttribute('dir')).toBe('rtl');
  });

  it('marks label paragraphs followed by lists for tighter spacing', async () => {
    const wrapper = await mountDisplay({
      content: 'بله\n\n**Pronunciation**: /yes/\n\n**Definitions**:\n- (علامت تعجب) used to give an affirmative response.',
      lastTranslation: {
        mode: TranslationMode.Dictionary_Translation,
      },
    });

    const group = wrapper.find('.md-label-list-group');
    const paragraph = group.find('p.md-label-paragraph');
    const list = group.find('ul.md-label-list');

    expect(group.exists()).toBe(true);
    expect(paragraph.exists()).toBe(true);
    expect(paragraph.text()).toBe('Definitions:');
    expect(list.exists()).toBe(true);
    expect(list.text()).toContain('used to give an affirmative response.');
    expect(list.element.firstChild?.nodeType).toBe(Node.ELEMENT_NODE);
    expect(paragraph.attributes('dir')).toBe('ltr');
    expect(list.attributes('dir')).toBe('ltr');
    expect(list.find('li').attributes('dir')).toBe('ltr');
  });

  it('does not add label spacing classes for ordinary paragraph/list content', async () => {
    const wrapper = await mountDisplay({
      content: 'Intro text\n\n- item',
      lastTranslation: null,
    });

    expect(wrapper.find('.md-label-list-group').exists()).toBe(false);
    expect(wrapper.find('p.md-label-paragraph').exists()).toBe(false);
    expect(wrapper.find('ul.md-label-list').exists()).toBe(false);
  });

  it('falls back to SimpleMarkdown for legacy one-line concatenated output', async () => {
    const renderSpy = vi
      .spyOn(SimpleMarkdown, 'render')
      .mockImplementation(() => {
        const el = document.createElement('div');
        el.className = 'simple-markdown';
        el.innerHTML = '<p>translation</p>';
        return el;
      });

    const wrapper = await mountDisplay({
      content: 'translation **Noun**: hello, hi',
      lastTranslation: {
        mode: TranslationMode.Dictionary_Translation,
      },
    });

    expect(renderSpy).toHaveBeenCalled();
    expect(wrapper.find('.simple-markdown').exists()).toBe(true);
    expect(wrapper.find('.simple-markdown').text()).toBe('translation');
  });

  it('falls back to SimpleMarkdown for same-line multi-label legacy output', async () => {
    const renderSpy = vi
      .spyOn(SimpleMarkdown, 'render')
      .mockImplementation(() => {
        const el = document.createElement('div');
        el.className = 'simple-markdown';
        el.innerHTML = '<p>UK: hello US: hi</p>';
        return el;
      });

    const wrapper = await mountDisplay({
      content: '**UK**: hello **US**: hi',
      lastTranslation: {
        mode: TranslationMode.Dictionary_Translation,
      },
    });

    expect(renderSpy).toHaveBeenCalled();
    expect(wrapper.find('.simple-markdown').text()).toBe('UK: hello US: hi');
  });

  it('falls back to SimpleMarkdown for plain Label: content only in dictionary mode', async () => {
    const renderSpy = vi
      .spyOn(SimpleMarkdown, 'render')
      .mockImplementation(() => {
        const el = document.createElement('div');
        el.className = 'simple-markdown';
        el.innerHTML = '<p>Noun: test, experiment</p>';
        return el;
      });

    const dictionaryWrapper = await mountDisplay({
      content: 'Noun: test, experiment',
      lastTranslation: {
        mode: TranslationMode.Dictionary_Translation,
      },
    });

    expect(renderSpy).toHaveBeenCalled();
    expect(dictionaryWrapper.find('.simple-markdown').text()).toBe('Noun: test, experiment');

    renderSpy.mockClear();

    const normalWrapper = await mountDisplay({
      content: 'Noun: test, experiment',
      lastTranslation: null,
    });

    expect(renderSpy).not.toHaveBeenCalled();
    expect(normalWrapper.find('.simple-markdown').exists()).toBe(true);
    expect(normalWrapper.find('.simple-markdown').text()).toBe('Noun: test, experiment');
  });

  it('preserves the simple-markdown wrapper in the rendered HTML', async () => {
    const wrapper = await mountDisplay({
      content: '**Noun**: test, experiment',
      lastTranslation: {
        mode: TranslationMode.Dictionary_Translation,
      },
    });

    expect(wrapper.find('.simple-markdown').exists()).toBe(true);
  });

  it('neutralizes unsafe links and removes their href', async () => {
    const wrapper = await mountDisplay({
      content: '[Click](javascript:alert(1))',
      lastTranslation: null,
    });

    expect(wrapper.find('.simple-markdown').exists()).toBe(true);
    expect(wrapper.find('a').exists()).toBe(false);
    expect(wrapper.text()).toContain('Click');
    expect(wrapper.html()).not.toContain('javascript:');
  });

  it('strips raw HTML XSS attributes from rendered content', async () => {
    const wrapper = await mountDisplay({
      content: '<img src=x onerror=alert(1)>',
      lastTranslation: null,
    });

    expect(wrapper.html()).not.toContain('onerror');
    expect(wrapper.html()).not.toContain('alert(1)');
    expect(wrapper.element.querySelector('[onerror]')).toBeNull();
  });

  it('keeps safe links with target blank and noopener noreferrer', async () => {
    const wrapper = await mountDisplay({
      content: '[Click](https://example.com)',
      lastTranslation: null,
    });

    const link = wrapper.find('a');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('https://example.com');
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('rel')).toBe('noopener noreferrer');
  });

  it('renders a code block (pre) inside simple-markdown', async () => {
    const wrapper = await mountDisplay({
      content: '```js\nconst x = 1;\n```',
      lastTranslation: null,
    });
    expect(wrapper.find('.simple-markdown pre').exists()).toBe(true);
    expect(wrapper.find('.simple-markdown pre code').exists()).toBe(true);
  });

  it('renders plain text with line breaks as br tags or paragraphs', async () => {
    const wrapper = await mountDisplay({
      content: 'Line 1\nLine 2',
      enableMarkdown: false,
    });
    expect(wrapper.html()).toContain('Line 1<br>Line 2');
  });
});
