import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SidepanelLayout from './SidepanelLayout.vue'

const mocks = vi.hoisted(() => ({
  openHistoryPanel: vi.fn(),
  closeHistoryPanel: vi.fn(),
  setHistoryPanelOpen: vi.fn(),
  loadSettings: vi.fn().mockResolvedValue(undefined),
  sessionGet: vi.fn(),
  sessionRemove: vi.fn().mockResolvedValue(undefined),
  addListener: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => ({ isInitialized: true, settings: { TRANSLATION_API: 'googlev2' }, loadSettings: mocks.loadSettings })
}))

vi.mock('@/features/translation/stores/translation.js', () => ({
  useTranslationStore: () => ({ currentTranslation: null })
}))

vi.mock('@/features/history/composables/useHistory.js', () => ({
  useHistory: () => ({
    openHistoryPanel: mocks.openHistoryPanel,
    closeHistoryPanel: mocks.closeHistoryPanel,
    setHistoryPanelOpen: mocks.setHistoryPanelOpen
  })
}))

vi.mock('@/composables/shared/useErrorHandler.js', () => ({ useErrorHandler: vi.fn() }))
vi.mock('@/shared/logging/logger.js', () => ({ getScopedLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) }))
vi.mock('@/shared/logging/logConstants.js', () => ({ LOG_COMPONENTS: { UI: 'ui' } }))

vi.mock('./components/SidepanelHistory.vue', () => ({ default: { name: 'SidepanelHistory', props: ['isVisible'], template: '<div />' } }))
vi.mock('./components/SidepanelToolbar.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./components/SidepanelMainContent.vue', () => ({
  default: {
    template: '<div />',
    methods: { initializeSessionState: vi.fn().mockResolvedValue(undefined) }
  }
}))

const intentKey = (windowId) => `__translateItSidepanelPendingIntent:${windowId}`

describe('SidepanelLayout pending history intent', () => {
  let sessionData

  beforeEach(() => {
    vi.clearAllMocks()
    sessionData = {}
    mocks.sessionGet.mockImplementation(async (key) => ({ [key]: sessionData[key] }))
    mocks.sessionRemove.mockImplementation(async (key) => { delete sessionData[key] })
    globalThis.browser.tabs.query.mockResolvedValue([{ id: 1, windowId: 7 }])
    globalThis.browser.storage.session = { get: mocks.sessionGet, remove: mocks.sessionRemove }
    globalThis.browser.storage.onChanged = { addListener: mocks.addListener, removeListener: mocks.removeListener }
  })

  it('opens History on initialization and removes the consumed intent first', async () => {
    sessionData[intentKey(7)] = { action: 'open-history' }
    const wrapper = mount(SidepanelLayout)
    await flushPromises()

    expect(mocks.sessionRemove).toHaveBeenCalledWith(intentKey(7))
    expect(mocks.sessionRemove.mock.invocationCallOrder[0]).toBeLessThan(mocks.openHistoryPanel.mock.invocationCallOrder[0])
    expect(mocks.openHistoryPanel).toHaveBeenCalledOnce()
    expect(wrapper.findComponent({ name: 'SidepanelHistory' }).props('isVisible')).toBe(true)
    wrapper.unmount()
  })

  it('opens History when an intent arrives while mounted', async () => {
    const wrapper = mount(SidepanelLayout)
    await flushPromises()
    const listener = mocks.addListener.mock.calls[0][0]

    sessionData[intentKey(7)] = { action: 'open-history' }
    listener({ [intentKey(7)]: { newValue: sessionData[intentKey(7)] } }, 'session')
    await flushPromises()

    expect(mocks.openHistoryPanel).toHaveBeenCalledOnce()
    expect(wrapper.findComponent({ name: 'SidepanelHistory' }).props('isVisible')).toBe(true)
    expect(mocks.sessionRemove).toHaveBeenCalledWith(intentKey(7))
    wrapper.unmount()
    expect(mocks.removeListener).toHaveBeenCalledWith(listener)
  })

  it('leaves History closed when there is no pending intent', async () => {
    mount(SidepanelLayout)
    await flushPromises()

    expect(mocks.openHistoryPanel).not.toHaveBeenCalled()
    expect(mocks.sessionRemove).not.toHaveBeenCalled()
  })

  it('ignores and does not remove an intent belonging to another window', async () => {
    sessionData[intentKey(8)] = { action: 'open-history' }
    const wrapper = mount(SidepanelLayout)
    await flushPromises()

    const listener = mocks.addListener.mock.calls[0][0]
    listener({ [intentKey(8)]: { newValue: sessionData[intentKey(8)] } }, 'session')
    await flushPromises()

    expect(mocks.openHistoryPanel).not.toHaveBeenCalled()
    expect(mocks.sessionGet).toHaveBeenCalledWith(intentKey(7))
    expect(mocks.sessionRemove).not.toHaveBeenCalled()
    expect(sessionData[intentKey(8)]).toEqual({ action: 'open-history' })
    wrapper.unmount()
  })
})
