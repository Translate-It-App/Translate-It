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

  it('emits translate and TTS actions exactly once', async () => {
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
    await buttons[0].trigger('click')
    await buttons[1].trigger('click')

    expect(wrapper.emitted('translate')).toEqual([[]])
    expect(wrapper.emitted('tts')).toEqual([[]])
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
    expect(source).toContain("import './SelectionActionPill.scss'")
  })
})
