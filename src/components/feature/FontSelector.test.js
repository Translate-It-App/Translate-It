import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import FontSelector from './FontSelector.vue'
import { systemFontDetector } from '@/shared/fonts/SystemFontDetector.js'

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (_key, fallback) => fallback }),
}))

const detectedFonts = [
  ...systemFontDetector.fallbackFonts,
  { name: 'B Nazanin', value: 'b-nazanin', category: 'other', isSystemFont: true },
]

describe('FontSelector saved font display', () => {
  let cachedFonts
  let getAvailableFonts

  beforeEach(() => {
    cachedFonts = systemFontDetector.cachedFonts
    systemFontDetector.clearCache()
    getAvailableFonts = vi.spyOn(systemFontDetector, 'getAvailableFonts')
      .mockResolvedValue(detectedFonts)
  })

  afterEach(() => {
    getAvailableFonts.mockRestore()
    systemFontDetector.cachedFonts = cachedFonts
  })

  const mountSelector = (fontFamily) => mount(FontSelector, { props: { fontFamily } })
  const placeholder = (wrapper) => wrapper.get('#font-family-search').attributes('placeholder')
  const description = (wrapper) => wrapper.get('.font-description').text()

  it('shows a saved predefined font before the dropdown is opened', () => {
    const wrapper = mountSelector('vazirmatn')

    expect(placeholder(wrapper)).toBe('Vazirmatn (Persian)')
    expect(description(wrapper)).toBe('persian')
    expect(getAvailableFonts).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:font-family')).toBeUndefined()
  })

  it('shows auto and system default selections before the dropdown is opened', () => {
    expect(placeholder(mountSelector('auto'))).toBe('Auto (Smart Detection)')
    expect(placeholder(mountSelector('system'))).toBe('System Default')
    expect(getAvailableFonts).not.toHaveBeenCalled()
  })

  it('shows a saved system font without claiming it is installed', () => {
    const wrapper = mountSelector('b-nazanin')

    expect(placeholder(wrapper)).toBe('B Nazanin')
    expect(description(wrapper)).toBe('other')
    expect(getAvailableFonts).not.toHaveBeenCalled()
  })

  it('keeps an unknown saved font value as its display name', () => {
    const wrapper = mountSelector('my-custom-font')

    expect(placeholder(wrapper)).toBe('my-custom-font')
    expect(description(wrapper)).toBe('')
    expect(wrapper.emitted('update:font-family')).toBeUndefined()
  })

  it('shows a saved font that arrives after mount', async () => {
    const wrapper = mountSelector('auto')

    await wrapper.setProps({ fontFamily: 'georgia' })

    expect(placeholder(wrapper)).toBe('Georgia')
    expect(description(wrapper)).toBe('serif')
    expect(getAvailableFonts).not.toHaveBeenCalled()
  })

  it('uses the detected font once the dropdown loads the font list', async () => {
    const wrapper = mountSelector('b-nazanin')

    await wrapper.get('#font-family-search').trigger('focus')
    await flushPromises()

    expect(getAvailableFonts).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.font-option')).toHaveLength(detectedFonts.length)
    expect(placeholder(wrapper)).toBe('B Nazanin')
    expect(description(wrapper)).toBe('other • System Font')
    expect(wrapper.emitted('update:font-family')).toBeUndefined()
  })
})
