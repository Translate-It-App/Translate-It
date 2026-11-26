import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import FontSelector from './FontSelector.vue'
import { systemFontDetector } from '@/shared/fonts/SystemFontDetector.js'

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (key, fallback) => fallback || key })
}))

const detectedFonts = [
  ...systemFontDetector.fallbackFonts,
  { name: 'Verdana', value: 'verdana', category: 'other', isSystemFont: true }
]

const mountSelector = (fontFamily) => mount(FontSelector, {
  props: { fontFamily, fontSize: '14' },
  attachTo: document.body
})

describe('FontSelector', () => {
  let getAvailableFontsSpy

  beforeEach(() => {
    systemFontDetector.clearCache()
    getAvailableFontsSpy = vi.spyOn(systemFontDetector, 'getAvailableFonts')
      .mockResolvedValue(detectedFonts)
  })

  afterEach(() => {
    getAvailableFontsSpy.mockRestore()
    systemFontDetector.clearCache()
  })

  const getPlaceholder = (wrapper) => wrapper.get('#font-family-search').attributes('placeholder')
  const getDescription = (wrapper) => wrapper.get('.font-description').text()

  it.each([
    ['auto', 'Auto (Smart Detection)', 'smart'],
    ['system', 'System Default', 'system'],
    ['vazirmatn', 'Vazirmatn (Persian)', 'persian']
  ])('displays the saved %s font before the dropdown is opened', (value, name, description) => {
    const wrapper = mountSelector(value)

    expect(getPlaceholder(wrapper)).toBe(name)
    expect(getDescription(wrapper)).toBe(description)
    expect(getAvailableFontsSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('displays a saved catalog system font without claiming it is installed', () => {
    const wrapper = mountSelector('verdana')

    expect(getPlaceholder(wrapper)).toBe('Verdana')
    expect(getDescription(wrapper)).toBe('other')
    expect(getAvailableFontsSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('falls back to the saved value for unknown fonts and keeps the setting', () => {
    const wrapper = mountSelector('custom-font')

    expect(getPlaceholder(wrapper)).toBe('custom-font')
    expect(getDescription(wrapper)).toBe('')
    expect(wrapper.emitted('update:font-family')).toBeUndefined()
    wrapper.unmount()
  })

  it('uses detected font metadata after the font list loads', async () => {
    const wrapper = mountSelector('verdana')

    await wrapper.get('#font-family-search').trigger('focus')
    await flushPromises()

    expect(getAvailableFontsSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.font-option').length).toBeGreaterThan(0)
    expect(getPlaceholder(wrapper)).toBe('Verdana')
    expect(getDescription(wrapper)).toBe('other • System Font')
    expect(wrapper.emitted('update:font-family')).toBeUndefined()
    wrapper.unmount()
  })

  it('updates the displayed font when the prop changes', async () => {
    const wrapper = mountSelector('auto')

    await wrapper.setProps({ fontFamily: 'georgia' })

    expect(getPlaceholder(wrapper)).toBe('Georgia')
    expect(getDescription(wrapper)).toBe('serif')
    expect(getAvailableFontsSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
