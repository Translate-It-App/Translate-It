import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TranslationInputField from './TranslationInputField.vue'

vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: () => ({ handleError: vi.fn() })
}))

vi.mock('@/composables/shared/useFont.js', () => ({
  useFont: () => ({ fontStyles: {}, cssVariables: {} })
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

describe('TranslationInputField focus API', () => {
  it('focuses the connected source textarea without scrolling and safely ignores a detached one', () => {
    const wrapper = mount(TranslationInputField, {
      attachTo: document.body,
      global: { stubs: { ActionToolbar: true } }
    })
    const textarea = wrapper.get('textarea').element
    const focus = vi.spyOn(textarea, 'focus')

    expect(wrapper.vm.focusTextarea()).toBe(true)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })

    wrapper.unmount()
    expect(wrapper.vm.focusTextarea()).toBe(false)
    expect(focus).toHaveBeenCalledTimes(1)
  })
})
