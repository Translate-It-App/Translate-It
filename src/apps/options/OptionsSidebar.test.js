import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import OptionsSidebar from './OptionsSidebar.vue';

const mockT = vi.fn((key, fallback) =>
  key === 'options_description' ? 'Translate the web, your way.' : (fallback ?? key),
);

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: mockT,
  }),
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('OptionsSidebar.vue', () => {
  it('renders the canonical tagline via options_description, not the Store description key', () => {
    const wrapper = mount(OptionsSidebar, {
      global: {
        stubs: {
          ThemeSelector: true,
          InterfaceLocaleSelector: true,
        },
      },
    });

    const tagline = wrapper.find('.sidebar-header p');
    expect(tagline.exists()).toBe(true);
    expect(tagline.text()).toBe('Translate the web, your way.');

    const requestedKeys = mockT.mock.calls.map((call) => call[0]);
    expect(requestedKeys).toContain('options_description');
    expect(requestedKeys).not.toContain('description');
  });

  it('renders all five header control groups in a single .sidebar-content row, in order', () => {
    const wrapper = mount(OptionsSidebar, {
      global: {
        stubs: {
          ThemeSelector: true,
          InterfaceLocaleSelector: true,
        },
      },
    });

    // DOM presence/order only: jsdom cannot measure layout.
    const rows = wrapper.find('.sidebar-content').element.children;
    expect(rows[0].className).toContain('sidebar-header');
    expect(rows[1].className).toContain('theme-controls');
    expect(rows[2].className).toContain('localization-controls');
    expect(rows[3].id).toBe('SUBTITLE_TRANSLATOR');
    expect(rows[4].id).toBe('PDF_TRANSLATOR');

    // 1. Brand header: h1 + version span.
    expect(wrapper.find('.sidebar-header h1').exists()).toBe(true);
    expect(wrapper.find('.sidebar-header .header-logo-link span').exists()).toBe(true);

    // 2. Theme controls section.
    const theme = wrapper.findComponent({ name: 'ThemeSelector' });
    expect(theme.exists()).toBe(true);
    expect(theme.element.closest('.theme-controls')).not.toBeNull();

    // 3. Localization controls with dropdown-mode selector inside .mobile-only.
    const localeSelectors = wrapper.findAllComponents({ name: 'InterfaceLocaleSelector' });
    expect(localeSelectors).toHaveLength(2);
    const dropdown = localeSelectors.find((selector) => selector.attributes('mode') === 'dropdown');
    expect(dropdown).toBeTruthy();
    expect(dropdown.element.closest('.mobile-only')).not.toBeNull();
    expect(dropdown.element.closest('.localization-controls')).not.toBeNull();

    // 4-5. Both app-link anchors.
    expect(wrapper.find('#SUBTITLE_TRANSLATOR').exists()).toBe(true);
    expect(wrapper.find('#PDF_TRANSLATOR').exists()).toBe(true);
  });
});
