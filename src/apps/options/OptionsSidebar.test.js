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
});
