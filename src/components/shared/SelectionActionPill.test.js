import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import SelectionActionPill from './SelectionActionPill.vue'

describe('SelectionActionPill.vue', () => {
  it('renders the shared translate and TTS selection buttons', () => {
    const wrapper = mount(SelectionActionPill, {
      props: {
        showTranslate: true,
        showTts: true,
        translateTitle: 'Translate selected text',
        translateAriaLabel: 'Translate selected text',
        ttsTitle: 'Speak text',
        ttsAriaLabel: 'Speak text',
        ttsState: 'idle'
      }
    })

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].classes()).toContain('ti-icon-btn--translate')
    expect(buttons[1].classes()).not.toContain('ti-icon-btn--translate')
    expect(wrapper.find('.ti-translation-icon').exists()).toBe(true)
    expect(wrapper.find('.ti-icon-btn__svg').exists()).toBe(true)
  })

  it('emits translate and TTS actions exactly once with the originating click event', async () => {
    const wrapper = mount(SelectionActionPill, {
      props: {
        showTranslate: true,
        showTts: true,
        translateTitle: 'Translate selected text',
        translateAriaLabel: 'Translate selected text',
        ttsTitle: 'Speak text',
        ttsAriaLabel: 'Speak text',
        ttsState: 'idle'
      }
    })

    const buttons = wrapper.findAll('button')
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
    buttons[0].element.dispatchEvent(clickEvent)
    await buttons[1].trigger('click')

    expect(wrapper.emitted('translate')).toHaveLength(1)
    expect(wrapper.emitted('translate')[0]).toEqual([clickEvent])
    expect(wrapper.emitted('tts')).toEqual([[]])
  })

  it.each(['Enter', ' '])('emits the originating %s key event and prevents its default action', async (key) => {
    const wrapper = mount(SelectionActionPill, {
      props: { showTranslate: true, showTts: false }
    })
    const keyEvent = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })

    wrapper.find('.ti-icon-btn--translate').element.dispatchEvent(keyEvent)

    expect(keyEvent.defaultPrevented).toBe(true)
    expect(wrapper.emitted('translate')).toHaveLength(1)
    expect(wrapper.emitted('translate')[0]).toEqual([keyEvent])
  })

  it('renders only the Translate button when showTts is false', () => {
    const wrapper = mount(SelectionActionPill, {
      props: {
        showTranslate: true,
        showTts: false
      }
    })

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].classes()).toContain('ti-icon-btn--translate')
  })

  it('renders only the TTS button when showTranslate is false', () => {
    const wrapper = mount(SelectionActionPill, {
      props: {
        showTranslate: false,
        showTts: true
      }
    })

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].classes()).not.toContain('ti-icon-btn--translate')
  })

  it('honors the kebab-cased show-tts attribute used by consumers', () => {
    const wrapper = mount(SelectionActionPill, {
      props: {
        showTranslate: true,
        'show-tts': false
      }
    })

    expect(wrapper.findAll('button')).toHaveLength(1)
  })

  it('does not import the WindowsManager stack', () => {
    const source = readFileSync('src/components/shared/SelectionActionPill.vue', 'utf8')

    expect(source).not.toContain('@/features/windows')
    expect(source).not.toContain('src/features/windows')
    expect(source).toMatch(/import ['"]\.\/SelectionActionPill\.scss['"]/)
  })
})
