import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  browserAPI: null,
  logger: {
    debug: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/composables/core/useBrowserAPI.js', async () => {
  const { ref } = await import('vue')
  if (!mocks.browserAPI) mocks.browserAPI = ref(null)
  return { useBrowserAPI: () => ({ api: mocks.browserAPI }) }
})

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (key) => key })
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => mocks.logger
}))

import ConfigureShortcutButton from './ConfigureShortcutButton.vue'

const createBrowserApi = (browserName = 'Chrome') => ({
  commands: {
    getAll: vi.fn().mockResolvedValue([]),
    openShortcutSettings: vi.fn().mockResolvedValue(undefined)
  },
  runtime: {
    getBrowserInfo: vi.fn().mockResolvedValue({ name: browserName }),
    getURL: vi.fn((path) => path)
  },
  tabs: {
    create: vi.fn().mockResolvedValue(undefined)
  }
})

describe('ConfigureShortcutButton', () => {
  let wrapper

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.browserAPI.value = createBrowserApi()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  const mountButton = () => {
    wrapper = mount(ConfigureShortcutButton, {
      props: { commandName: 'SELECT-ELEMENT-COMMAND' },
      global: {
        stubs: {
          BaseButton: {
            props: ['disabled'],
            emits: ['click'],
            template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
          }
        }
      }
    })
    return wrapper
  }

  it('opens native Firefox shortcut settings', async () => {
    const browserApi = createBrowserApi('Firefox')
    mocks.browserAPI.value = browserApi

    await mountButton().find('button').trigger('click')

    expect(browserApi.commands.openShortcutSettings).toHaveBeenCalledOnce()
    expect(browserApi.tabs.create).not.toHaveBeenCalled()
    expect(browserApi.runtime.getURL).not.toHaveBeenCalled()
  })

  it('opens Chrome shortcut settings URL outside Firefox', async () => {
    const browserApi = createBrowserApi('Chrome')
    mocks.browserAPI.value = browserApi

    await mountButton().find('button').trigger('click')

    expect(browserApi.tabs.create).toHaveBeenCalledWith({
      url: 'chrome://extensions/shortcuts'
    })
    expect(browserApi.commands.openShortcutSettings).not.toHaveBeenCalled()
  })

  it('logs Firefox shortcut API failures without opening a legacy options URL', async () => {
    const browserApi = createBrowserApi('Firefox')
    const error = new Error('shortcut settings unavailable')
    browserApi.commands.openShortcutSettings.mockRejectedValue(error)
    mocks.browserAPI.value = browserApi

    await mountButton().find('button').trigger('click')

    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Failed to open shortcuts page:',
      error
    )
    expect(browserApi.tabs.create).not.toHaveBeenCalled()
    expect(browserApi.runtime.getURL).not.toHaveBeenCalled()
  })
})
