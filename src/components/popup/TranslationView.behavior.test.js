import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TranslationView from './TranslationView.vue'

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (key) => key })
}))

describe('TranslationView clear action', () => {
  it('keeps clear mounted, disables it while hidden, and emits only when shown', async () => {
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

    const button = wrapper.get('.ti-btn-min-clear')
    expect(button.classes()).toContain('ti-clear-hidden')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-hidden')).toBe('true')
    expect(button.attributes('tabindex')).toBe('-1')
    await button.trigger('click')
    expect(wrapper.emitted('clear')).toBeUndefined()

    await wrapper.setProps({ showClearButton: true })
    expect(wrapper.get('.ti-btn-min-clear').element).toBe(button.element)
    expect(button.classes()).not.toContain('ti-clear-hidden')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('aria-hidden')).toBe('false')
    expect(button.attributes('tabindex')).toBe('0')
    expect(button.attributes('aria-label')).toBe('popup_clear_storage_title_icon')
    expect(button.attributes('title')).toBe(button.attributes('aria-label'))
    await button.trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
    await wrapper.setProps({ showClearButton: false })
    expect(wrapper.get('.ti-btn-min-clear').element).toBe(button.element)
  })
})
