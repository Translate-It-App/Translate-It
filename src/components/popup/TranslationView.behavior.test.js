import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TranslationView from './TranslationView.vue'

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (key) => key })
}))

describe('TranslationView clear action', () => {
  it('renders the labeled clear action only when enabled and preserves its event', async () => {
    const wrapper = mount(TranslationView, {
      props: {
        translation: {},
        showClearButton: false
      },
      global: {
        stubs: {
          ProviderSelector: true,
          LanguageSelector: true,
          TranslationForm: true,
          MaskIcon: true
        }
      }
    })

    expect(wrapper.find('.ti-btn-min-clear').exists()).toBe(false)
    await wrapper.setProps({ showClearButton: true })
    const button = wrapper.get('.ti-btn-min-clear')
    expect(button.attributes('aria-label')).toBe('popup_clear_storage_title_icon')
    expect(button.attributes('title')).toBe(button.attributes('aria-label'))
    await button.trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })
})
