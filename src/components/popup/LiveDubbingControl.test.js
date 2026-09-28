import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import LiveDubbingControl from './LiveDubbingControl.vue'

const sendMessage = vi.hoisted(() => vi.fn())
let runtimeListener

// Mutable i18n lookup so tests can override individual keys to prove that
// rendered strings resolve through t() rather than being hardcoded.
const mockI18nMap = vi.hoisted(() => ({
  live_dubbing_provider_bootstrap_gemini_error: 'Unable to initialize Gemini Live Dubbing. Check your Gemini API key and connection, then try again.',
  live_dubbing_provider_bootstrap_openai_error: 'Unable to initialize OpenAI Live Dubbing. Check your OpenAI API key and connection, then try again.',
  live_dubbing_provider_setup_failed_error: 'Unable to connect to the selected provider. Check your connection and configuration, then try again.',
  live_dubbing_offscreen_lost_error: 'Live Dubbing stopped unexpectedly. Start it again.'
}))
const mockI18nSnapshot = vi.hoisted(() => ({ ...mockI18nMap }))
const here = dirname(fileURLToPath(import.meta.url))
const liveDubbingControlScss = readFileSync(resolve(here, 'LiveDubbingControl.scss'), 'utf8')

vi.mock('@/shared/messaging/composables/useMessaging.js', () => ({
  useMessaging: () => ({ sendMessage })
}))

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key, fallback) => mockI18nMap[key] || fallback || key
  })
}))

vi.mock('webextension-polyfill', () => ({
  default: { runtime: { getURL: (path) => path } }
}))

/** Mount and flush the initial status + any dependent queries (e.g. volume). */
const mountAndFlush = async (props = {}) => {
  const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de', ...props } })
  await Promise.resolve()
  await wrapper.vm.$nextTick()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
  return wrapper
}

/** Flush all pending microtasks + nextTick for a wrapper. */
const flushPromises = async (wrapper) => {
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

describe('LiveDubbingControl', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    runtimeListener = null
    vi.stubGlobal('browser', {
      runtime: {
        id: 'extension-id',
        getURL: (path = '') => `chrome-extension://extension-id/${path}`,
        onMessage: {
          addListener: vi.fn(listener => { runtimeListener = listener }),
          removeListener: vi.fn()
        }
      }
    })
    sendMessage.mockReset()
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
      if (action === 'START_LIVE_DUBBING') return Promise.resolve({ status: 'running', sessionId: 'session-1' })
      return Promise.resolve({ status: 'idle' })
    })
    // Restore any per-test i18n overrides so map mutations never leak.
    for (const key of Object.keys(mockI18nMap)) {
      if (!(key in mockI18nSnapshot)) delete mockI18nMap[key]
    }
    Object.assign(mockI18nMap, mockI18nSnapshot)
  })

  it('disables waveform animation for reduced-motion users', () => {
    const reducedMotionRule = liveDubbingControlScss.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none;/
    )?.[0]

    expect(reducedMotionRule).toBeTruthy()
  })

  it('queries status and sends target language and resolved session on start/stop', async () => {
    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(sendMessage).toHaveBeenCalledWith({ action: 'GET_LIVE_DUBBING_STATUS' })

    await wrapper.find('button').trigger('click')
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'START_LIVE_DUBBING',
      data: { targetLanguage: 'de', providerId: 'gemini' }
    })

    await Promise.resolve()
    await wrapper.find('button').trigger('click')
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'STOP_LIVE_DUBBING',
      data: { sessionId: 'session-1' }
    })
  })

  it('applies startDisabled only to START, not STOP or cleanup', async () => {
    const wrapper = await mountAndFlush({ startDisabled: true })
    const startButton = () => wrapper.find('button[aria-label="Start live dubbing"]')

    expect(startButton().attributes('disabled')).toBeDefined()

    await wrapper.setProps({ startDisabled: false })
    expect(startButton().attributes('disabled')).toBeUndefined()

    await startButton().trigger('click')
    await flushPromises(wrapper)
    await flushPromises(wrapper)
    await wrapper.setProps({ startDisabled: true })

    expect(wrapper.find('button[aria-label="Stop live dubbing"]').attributes('disabled'))
      .toBeUndefined()

    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        return Promise.resolve({ status: 'ERROR', sessionId: 'retained-session', lastError: 'Capture failed' })
      }
      return Promise.resolve({ status: 'idle' })
    })
    const cleanupWrapper = await mountAndFlush({ startDisabled: true })

    expect(cleanupWrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled'))
      .toBeDefined()
    expect(cleanupWrapper.find('button[aria-label="Clean up live dubbing"]').attributes('disabled'))
      .toBeUndefined()
  })

  it('emits status-resolved once after the initial status query succeeds', async () => {
    const wrapper = await mountAndFlush()

    expect(wrapper.emitted('status-resolved')).toEqual([[]])

    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
      id: 'extension-id', url: 'chrome-extension://extension-id/'
    })
    await flushPromises(wrapper)

    expect(wrapper.emitted('status-resolved')).toEqual([[]])
  })

  it('does not emit status-resolved after the initial status query fails', async () => {
    sendMessage.mockImplementationOnce(() => Promise.reject(new Error('status unavailable')))
    const wrapper = await mountAndFlush()

    expect(wrapper.emitted('status-resolved')).toBeUndefined()
  })

  it('offers cleanup for retained incomplete sessions and blocks start', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        return Promise.resolve({ status: 'ERROR', sessionId: 'retained-session', lastError: 'Capture failed' })
      }
      if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    const cleanupButton = wrapper.find('button[aria-label="Clean up live dubbing"]')
    expect(cleanupButton.exists()).toBe(true)
    expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Capture failed')

    await cleanupButton.trigger('click')
    expect(sendMessage).toHaveBeenLastCalledWith({
      action: 'STOP_LIVE_DUBBING',
      data: { sessionId: 'retained-session' }
    })
  })

  it('keeps cleanup enabled after stop failure and retries with retained session', async () => {
    let stopAttempts = 0
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        return Promise.resolve({ status: 'ERROR', sessionId: 'retained-session', lastError: 'Capture failed' })
      }
      if (action === 'STOP_LIVE_DUBBING') {
        stopAttempts += 1
        return stopAttempts === 1
          ? Promise.reject(new Error('Background transport failed'))
          : Promise.resolve({ status: 'idle' })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    const cleanupButton = () => wrapper.find('button[aria-label="Clean up live dubbing"]')
    await cleanupButton().trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(cleanupButton().exists()).toBe(true)
    expect(wrapper.text()).toContain('Background transport failed')

    await cleanupButton().trigger('click')
    expect(sendMessage).toHaveBeenLastCalledWith({
      action: 'STOP_LIVE_DUBBING',
      data: { sessionId: 'retained-session' }
    })
    expect(cleanupButton().exists()).toBe(false)
  })

  it('retains session and offers cleanup after a structured START failure', async () => {
    const retained = {
      status: 'ERROR',
      sessionId: 'session-9',
      providerId: 'gemini',
      lastError: 'LIVE_DUBBING_START_FAILED'
    }
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
      if (action === 'START_LIVE_DUBBING') {
        const failure = {
          success: false,
          error: 'LIVE_DUBBING_START_FAILED',
          retryable: true,
          cleanupPending: true,
          status: retained,
          providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: 'GEMINI_LIVE_REMOTE_ERROR' }
        }
        return Promise.reject(Object.assign(new Error('LIVE_DUBBING_START_FAILED'), { data: failure }))
      }
      if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    // Failed START with a retained session stays stoppable, never clean idle.
    expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()
    const cleanupButton = wrapper.find('button[aria-label="Clean up live dubbing"]')
    expect(cleanupButton.exists()).toBe(true)
    expect(wrapper.text()).toContain('LIVE_DUBBING_START_FAILED')

    await cleanupButton.trigger('click')
    expect(sendMessage).toHaveBeenLastCalledWith({
      action: 'STOP_LIVE_DUBBING',
      data: { sessionId: 'session-9' }
    })

    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('button[aria-label="Start live dubbing"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="Clean up live dubbing"]').exists()).toBe(false)
  })

  it('keeps retained error session provider for guidance across prop flips', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
      if (action === 'START_LIVE_DUBBING') {
        const failure = {
          success: false,
          error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE',
          retryable: true,
          cleanupPending: true,
          status: {
            status: 'ERROR',
            sessionId: 'session-1',
            providerId: 'openai',
            lastError: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE'
          }
        }
        return Promise.reject(Object.assign(new Error('LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE'), { data: failure }))
      }
      if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de', providerId: 'openai' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Unable to initialize OpenAI Live Dubbing.')
    sendMessage.mockClear()

    // A future provider change never alters the authoritative active identity.
    await wrapper.setProps({ providerId: 'gemini' })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'START_LIVE_DUBBING' }))
    expect(wrapper.text()).toContain('Unable to initialize OpenAI Live Dubbing.')
    expect(wrapper.text()).not.toContain('Unable to initialize Gemini Live Dubbing.')
    expect(wrapper.find('button[aria-label="Clean up live dubbing"]').exists()).toBe(true)

    await wrapper.find('button[aria-label="Clean up live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    // Session cleared — the next START uses the current prop.
    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    expect(sendMessage).toHaveBeenLastCalledWith({
      action: 'START_LIVE_DUBBING',
      data: { targetLanguage: 'de', providerId: 'gemini' }
    })
  })

  it('reconstructs retained cleanup on close/reopen from authoritative STATUS', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        return Promise.resolve({ status: { status: 'ERROR', sessionId: 'retained-session', lastError: 'Capture failed' } })
      }
      if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
      return Promise.resolve({ status: 'idle' })
    })

    const first = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await first.vm.$nextTick()
    expect(first.find('button[aria-label="Clean up live dubbing"]').exists()).toBe(true)
    first.unmount()

    const second = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await second.vm.$nextTick()
    expect(second.find('button[aria-label="Clean up live dubbing"]').exists()).toBe(true)

    await second.find('button[aria-label="Clean up live dubbing"]').trigger('click')
    expect(sendMessage).toHaveBeenLastCalledWith({
      action: 'STOP_LIVE_DUBBING',
      data: { sessionId: 'retained-session' }
    })
  })

  it.each([
    ['PREPARING_CAPTURE', 'Preparing capture…'],
    ['CONNECTING_PROVIDER', 'Connecting to provider…'],
    ['RUNNING', 'Running'],
    ['STOPPING', 'Stopping…']
  ])('presents the authoritative %s status', async (status, label) => {
    sendMessage.mockImplementation(({ action }) => (
      action === 'GET_LIVE_DUBBING_STATUS'
        ? Promise.resolve({ status: { status, sessionId: 'session-1' } })
        : Promise.resolve({ status: { status, sessionId: 'session-1' } })
    ))

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe(label)
  })

  it('names the cleanup action for an ERROR status with a retained session', async () => {
    // UI state is authoritative for presentation: ERROR + retained session and
    // no error detail still names the required cleanup action.
    mockI18nMap.live_dubbing_status_cleanup = 'Bereinigung erforderlich'
    sendMessage.mockImplementation(({ action }) => (
      action === 'GET_LIVE_DUBBING_STATUS'
        ? Promise.resolve({ status: { status: 'ERROR', sessionId: 'session-1' } })
        : Promise.resolve({ status: 'idle' })
    ))

    const wrapper = await mountAndFlush()

    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Bereinigung erforderlich')
  })

  it('resolves the Start label and accessible name through i18n', async () => {
    mockI18nMap.live_dubbing_action_start = 'Démarrer'
    mockI18nMap.live_dubbing_action_start_aria_label = 'Démarrer la traduction vocale'
    const wrapper = await mountAndFlush()

    const start = wrapper.find('button[aria-label="Démarrer la traduction vocale"]')
    expect(start.exists()).toBe(true)
    expect(start.text()).toContain('Démarrer')
  })

  it('resolves the Stop label and accessible name through i18n in the running state', async () => {
    mockI18nMap.live_dubbing_action_stop = 'Arrêter'
    mockI18nMap.live_dubbing_action_stop_aria_label = 'Arrêter la traduction vocale'
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        return Promise.resolve({ status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini' } })
      }
      return Promise.resolve({ status: 'idle' })
    })
    const wrapper = await mountAndFlush()

    const stop = wrapper.find('button[aria-label="Arrêter la traduction vocale"]')
    expect(stop.exists()).toBe(true)
    expect(stop.text()).toContain('Arrêter')
  })

  it('resolves the Clean up label and accessible name through i18n for a retained session', async () => {
    mockI18nMap.live_dubbing_action_cleanup = 'Nettoyer'
    mockI18nMap.live_dubbing_action_cleanup_aria_label = 'Nettoyer la traduction vocale'
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        return Promise.resolve({ status: 'ERROR', sessionId: 'retained-session', lastError: 'Capture failed' })
      }
      if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
      return Promise.resolve({ status: 'idle' })
    })
    const wrapper = await mountAndFlush()

    const cleanupButtons = wrapper.findAll('button[aria-label="Nettoyer la traduction vocale"]')
    expect(cleanupButtons.length).toBeGreaterThan(0)
    expect(cleanupButtons[0].text()).toContain('Nettoyer')
  })

  it.each([
    ['idle', { status: 'idle' }, 'live_dubbing_status_idle', 'Bereit'],
    ['loading', 'PENDING', 'live_dubbing_status_loading', 'Wird geprüft'],
    ['PREPARING_CAPTURE', { status: { status: 'PREPARING_CAPTURE', sessionId: 's1' } }, 'live_dubbing_status_preparing_capture', 'Wird vorbereitet'],
    ['CONNECTING_PROVIDER', { status: { status: 'CONNECTING_PROVIDER', sessionId: 's1' } }, 'live_dubbing_status_connecting_provider', 'Wird verbunden'],
    ['RUNNING', { status: { status: 'RUNNING', sessionId: 's1' } }, 'live_dubbing_status_running', 'Läuft'],
    ['STOPPING', { status: { status: 'STOPPING', sessionId: 's1' } }, 'live_dubbing_status_stopping', 'Wird gestoppt'],
    ['ERROR', { status: { status: 'ERROR' } }, 'live_dubbing_status_error', 'Fehler'],
    ['unavailable', { available: false }, 'live_dubbing_status_unavailable', 'Nicht verfügbar'],
    ['cleanup', { status: 'ERROR', sessionId: 'retained', lastError: 'x' }, 'live_dubbing_status_cleanup', 'Bereinigung erforderlich']
  ])('resolves the %s status text through i18n', async (state, response, key, label) => {
    mockI18nMap[key] = label
    if (response === 'PENDING') {
      // Status query never resolves: the control stays in its initial loading
      // state. The loading text is gated by a small presentation delay, so
      // the timer must elapse before the label is visible.
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(() => new Promise(() => {}))
        const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
        await wrapper.vm.$nextTick()

        // Before the delay: blank — neither "Ready" nor the loading label.
        expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('')

        vi.advanceTimersByTime(150)
        await wrapper.vm.$nextTick()

        // After the delay: the loading label becomes visible.
        expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe(label)
      } finally {
        vi.useRealTimers()
      }
      return
    }
    sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
      ? Promise.resolve(response)
      : Promise.resolve({ status: 'idle' }))
    const wrapper = await mountAndFlush()

    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe(label)
  })

  it('does not flash the initial loading status when status resolves quickly', async () => {
    vi.useFakeTimers()
    sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
      ? Promise.resolve({ status: 'idle' })
      : Promise.resolve({ status: 'idle' }))

    const wrapper = await mountAndFlush()

    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Ready')
    vi.advanceTimersByTime(150)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Ready')
    expect(wrapper.text()).not.toContain('Checking availability…')
    wrapper.unmount()
  })

  it('reveals slow initial loading only while the status query is pending', async () => {
    vi.useFakeTimers()
    let resolveStatus
    sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
      ? new Promise(resolve => { resolveStatus = resolve })
      : Promise.resolve({ status: 'idle' }))

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.pendingStatusReveal).toBe(true)
    expect(wrapper.vm.isInitialStatusLoadingVisible).toBe(false)
    // Hidden window: blank, not "Ready" — and Start stays disabled.
    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('')
    expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()

    vi.advanceTimersByTime(149)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('')

    vi.advanceTimersByTime(1)
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.isInitialStatusLoadingVisible).toBe(true)
    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Checking availability…')
    // Behavioral loading is independent of presentation visibility: Start is
    // still disabled while the GET is unresolved.
    expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()

    resolveStatus({ status: 'idle' })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    expect(wrapper.vm.pendingStatusReveal).toBe(false)
    expect(wrapper.vm.isInitialStatusLoadingVisible).toBe(false)
    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Ready')
    wrapper.unmount()
  })

  it('does not debounce status refreshes after the initial query', async () => {
    vi.useFakeTimers()
    let statusReads = 0
    let resolveRefresh
    sendMessage.mockImplementation(({ action }) => {
      if (action !== 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
      statusReads += 1
      return statusReads === 1
        ? Promise.resolve({ status: 'idle' })
        : new Promise(resolve => { resolveRefresh = resolve })
    })

    const wrapper = await mountAndFlush()
    expect(vi.getTimerCount()).toBe(0)

    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
      id: 'extension-id', url: 'chrome-extension://extension-id/'
    })
    await Promise.resolve()
    expect(statusReads).toBe(2)
    expect(vi.getTimerCount()).toBe(0)

    resolveRefresh({ status: { status: 'RUNNING', sessionId: 'refresh-session' } })
    await flushPromises(wrapper)
    await flushPromises(wrapper)
    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Running')
    wrapper.unmount()
  })

  it('clears the initial loading reveal timer on unmount', async () => {
    vi.useFakeTimers()
    let resolveStatus
    sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
      ? new Promise(resolve => { resolveStatus = resolve })
      : Promise.resolve({ status: 'idle' }))

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    expect(wrapper.vm.pendingStatusReveal).toBe(true)
    expect(vi.getTimerCount()).toBe(1)

    wrapper.unmount()
    expect(wrapper.vm.pendingStatusReveal).toBe(false)
    expect(wrapper.vm.isInitialStatusLoadingVisible).toBe(false)
    expect(vi.getTimerCount()).toBe(0)

    resolveStatus({ status: 'idle' })
    await Promise.resolve()
    await Promise.resolve()
    expect(wrapper.vm.isInitialStatusLoadingVisible).toBe(false)
  })

  it('resolves volume labels through i18n', async () => {
    mockI18nMap.live_dubbing_volume_original_label = 'Original (i18n)'
    mockI18nMap.live_dubbing_volume_dubbed_label = 'Dubbed (i18n)'
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
      if (action === 'START_LIVE_DUBBING') {
        return Promise.resolve({ status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 } })
      }
      return Promise.resolve({ status: 'idle' })
    })
    const wrapper = await mountAndFlush()
    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    const labels = wrapper.findAll('.ti-live-dubbing-control-volume-label')
    expect(labels.map((label) => label.text())).toEqual(['Original (i18n)', 'Dubbed (i18n)'])
  })

  it('gives the Live Dubbing section a localized accessible name', async () => {
    mockI18nMap.popup_view_live_dubbing = 'Dubbing (i18n)'
    const wrapper = await mountAndFlush()

    expect(wrapper.find('section.ti-live-dubbing-control').attributes('aria-label')).toBe('Dubbing (i18n)')
  })

  it('presents safe background errors without remapping status', async () => {
    sendMessage.mockResolvedValue({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE'
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Error')
    expect(wrapper.text()).toContain('Unable to initialize Gemini Live Dubbing.')
  })

  it('disables start for an unsupported background response', async () => {
    sendMessage.mockResolvedValue({ success: false, error: 'LIVE_DUBBING_UNSUPPORTED' })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Live dubbing is not supported in this browser.')
  })

  it('presents OpenAI bootstrap failure for an OpenAI session', async () => {
    sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
      ? Promise.resolve({ status: { status: 'ERROR', sessionId: 'session-1', providerId: 'openai', lastError: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' } })
      : Promise.resolve({ status: 'idle' }))

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de', providerId: 'openai' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Unable to initialize OpenAI Live Dubbing.')
    expect(wrapper.text()).not.toContain('Unable to initialize Gemini Live Dubbing.')
  })

  it('keeps active session provider for error guidance after prop flips to Gemini', async () => {
    sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
      ? Promise.resolve({ status: { status: 'ERROR', sessionId: 'session-1', providerId: 'openai', lastError: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' } })
      : Promise.resolve({ status: 'idle' }))

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de', providerId: 'gemini' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Unable to initialize OpenAI Live Dubbing.')
    expect(wrapper.text()).not.toContain('Unable to initialize Gemini Live Dubbing.')
  })

  it.each([
    ['gemini', 'gemini'],
    ['openai', 'openai']
  ])('START sends providerId: %s when prop is %s', async (prop, expected) => {
    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de', providerId: prop } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'START_LIVE_DUBBING',
      data: { targetLanguage: 'de', providerId: expected }
    })
  })

  it('retains active OpenAI session through prop flip and uses new provider after session ends', async () => {
    let stopCallCount = 0
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
      if (action === 'START_LIVE_DUBBING') {
        return Promise.resolve({ status: { status: 'RUNNING', sessionId: 'session-1', providerId: 'openai' } })
      }
      if (action === 'STOP_LIVE_DUBBING') {
        stopCallCount += 1
        if (stopCallCount === 1) {
          return Promise.resolve({
            status: { status: 'ERROR', sessionId: 'session-1', providerId: 'openai', lastError: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' }
          })
        }
        return Promise.resolve({ status: 'idle' })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de', providerId: 'openai' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    // Phase 1: Start an openai session
    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Running')
    sendMessage.mockClear()

    // Phase 2: Flip prop to gemini — no restart, no mutation
    await wrapper.setProps({ providerId: 'gemini' })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'START_LIVE_DUBBING' }))
    expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Running')
    expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)

    // Phase 3: Stop encounters provider error — feedback uses OpenAI despite gemini prop
    await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Unable to initialize OpenAI Live Dubbing.')
    expect(wrapper.text()).not.toContain('Unable to initialize Gemini Live Dubbing.')
    expect(wrapper.find('button[aria-label="Clean up live dubbing"]').exists()).toBe(true)

    // Phase 4: Cleanup the retained session — session ends
    await wrapper.find('button[aria-label="Clean up live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    // Phase 5: Session cleared — next start uses gemini
    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'START_LIVE_DUBBING',
      data: { targetLanguage: 'de', providerId: 'gemini' }
    }))
  })

  it('shows a reopened idle terminal outcome without blocking Start', async () => {
    sendMessage.mockResolvedValue({
      success: true,
      status: 'idle',
      terminalOutcome: {
        providerId: 'gemini',
        error: 'PROVIDER_SESSION_ENDED',
        occurredAt: 123,
        providerDiagnostic: { raw: 'must not render' }
      }
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(browser.runtime.onMessage.addListener).toHaveBeenCalledWith(runtimeListener)
    expect(browser.runtime.onMessage.addListener.mock.invocationCallOrder[0])
      .toBeLessThan(sendMessage.mock.invocationCallOrder[0])
    expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('PROVIDER_SESSION_ENDED')
    expect(wrapper.text()).not.toContain('must not render')
  })

  it('maps a reopened Offscreen loss outcome without blocking Start', async () => {
    sendMessage.mockResolvedValue({
      status: null,
      terminalOutcome: {
        providerId: 'gemini',
        error: 'LIVE_DUBBING_OFFSCREEN_LOST',
        occurredAt: 123
      }
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Clean up live dubbing"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Live Dubbing stopped unexpectedly. Start it again.')
    expect(wrapper.text()).not.toContain('LIVE_DUBBING_OFFSCREEN_LOST')
    expect(wrapper.text()).not.toContain('Offscreen')
    expect(wrapper.text()).not.toContain('tabCapture')
    expect(wrapper.text()).not.toContain('document')
  })

  it('ignores unsafe terminal error prose and provider diagnostics', async () => {
    sendMessage.mockResolvedValue({
      status: 'idle',
      terminalOutcome: {
        providerId: 'gemini',
        error: 'Provider session ended.',
        occurredAt: 123,
        providerDiagnostic: { raw: 'must not render' }
      }
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.terminalOutcome).toBe(null)
    expect(wrapper.text()).not.toContain('Provider session ended.')
    expect(wrapper.text()).not.toContain('must not render')
  })

  it('presents direct bootstrap failure as Gemini i18n guidance', async () => {
    sendMessage.mockResolvedValue({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE'
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Unable to initialize Gemini Live Dubbing.')
    expect(wrapper.text()).toContain('Gemini API key')
  })

  it('presents direct bootstrap failure as OpenAI i18n guidance', async () => {
    sendMessage.mockResolvedValue({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE'
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de', providerId: 'openai' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Unable to initialize OpenAI Live Dubbing.')
    expect(wrapper.text()).toContain('OpenAI API key')
  })

  it('renders retained ERROR bootstrap as provider-specific guidance after reopen', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        return Promise.resolve({
          status: { status: 'ERROR', sessionId: 'retained-session', providerId: 'gemini', lastError: 'LIVE_DUBBING_PROVIDER_BOOTSTRAP_UNAVAILABLE' }
        })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const first = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await first.vm.$nextTick()
    expect(first.text()).toContain('Unable to initialize Gemini Live Dubbing.')
    first.unmount()

    const second = mount(LiveDubbingControl, { props: { targetLanguage: 'de', providerId: 'openai' } })
    await Promise.resolve()
    await second.vm.$nextTick()

    // Retained session provider (gemini) wins over the prop (openai).
    expect(second.text()).toContain('Unable to initialize Gemini Live Dubbing.')
    expect(second.text()).not.toContain('Unable to initialize OpenAI Live Dubbing.')
    second.unmount()
  })

  it('renders SETUP_FAILED as generic i18n guidance', async () => {
    sendMessage.mockResolvedValue({
      success: false,
      error: 'LIVE_DUBBING_PROVIDER_SETUP_FAILED'
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Unable to connect to the selected provider.')
  })

  it('never renders providerDiagnostic.code in error output', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
      if (action === 'START_LIVE_DUBBING') {
        return Promise.reject(Object.assign(new Error('LIVE_DUBBING_START_FAILED'), {
          data: {
            success: false,
            error: 'LIVE_DUBBING_START_FAILED',
            status: { status: 'ERROR', sessionId: 's1', providerId: 'gemini', lastError: 'LIVE_DUBBING_START_FAILED' },
            providerDiagnostic: { stage: 'CONNECT_PROVIDER', code: 'GEMINI_LIVE_REMOTE_ERROR' }
          }
        }))
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('GEMINI_LIVE_REMOTE_ERROR')
    expect(wrapper.text()).not.toContain('CONNECT_PROVIDER')
  })

  it('treats an authenticated terminal notification as invalidation and re-reads status', async () => {
    let statusReads = 0
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        statusReads += 1
        return Promise.resolve(statusReads === 1
          ? { status: { status: 'RUNNING', sessionId: 'session-1' } }
          : { status: 'idle', terminalOutcome: { providerId: 'gemini', error: 'PROVIDER_SESSION_ENDED', occurredAt: 2 } })
      }
      return Promise.resolve({ status: { status: 'RUNNING', sessionId: 'session-1' } })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)

    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: { error: 'do not render' } }, {
      id: 'extension-id', url: 'chrome-extension://extension-id/'
    })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(statusReads).toBe(2)
    expect(wrapper.find('button[aria-label="Start live dubbing"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('PROVIDER_SESSION_ENDED')
    expect(wrapper.text()).not.toContain('do not render')
  })

  it('ignores invalid or untrusted terminal notifications', async () => {
    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    const initialReads = sendMessage.mock.calls.filter(([message]) => message.action === 'GET_LIVE_DUBBING_STATUS').length

    runtimeListener({ action: 'OTHER_ACTION', data: {} }, { id: 'extension-id' })
    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, { id: 'other-id' })
    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, { id: 'extension-id', documentId: 'popup' })

    expect(sendMessage.mock.calls.filter(([message]) => message.action === 'GET_LIVE_DUBBING_STATUS')).toHaveLength(initialReads)
  })

  it('ignores a stale terminal outcome from another provider when no session is active', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        return Promise.resolve({
          status: 'idle',
          terminalOutcome: { providerId: 'gemini', error: 'STALE_GEMINI_FAILURE', occurredAt: 1 }
        })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de', providerId: 'openai' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    // Ownership untouched: the outcome is still stored exactly as received.
    expect(wrapper.vm.terminalOutcome?.error).toBe('STALE_GEMINI_FAILURE')
    // Presentation only: another provider's stale outcome never renders.
    expect(wrapper.find('.ti-live-dubbing-control-error').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('STALE_GEMINI_FAILURE')
  })

  it('keeps rendering a terminal outcome from the current provider with no session', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        return Promise.resolve({
          status: 'idle',
          terminalOutcome: { providerId: 'gemini', error: 'STALE_GEMINI_FAILURE', occurredAt: 1 }
        })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de', providerId: 'gemini' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.ti-live-dubbing-control-error').text()).toContain('STALE_GEMINI_FAILURE')
  })

  it('still respects the authoritative outcome while a session is active', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 'session-1', providerId: 'gemini' },
          terminalOutcome: { providerId: 'openai', error: 'ACTIVE_SESSION_OUTCOME', occurredAt: 2 }
        })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de', providerId: 'gemini' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    // Active session: authoritative outcome adopted regardless of provider match.
    expect(wrapper.vm.terminalOutcome?.error).toBe('ACTIVE_SESSION_OUTCOME')
    expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
  })

  it('removes the exact runtime listener on unmount', async () => {
    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    wrapper.unmount()

    expect(browser.runtime.onMessage.removeListener).toHaveBeenCalledWith(runtimeListener)
  })

  it('keeps cleanup pending when notification status retains a session', async () => {
    let statusReads = 0
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        statusReads += 1
        return Promise.resolve(statusReads === 1
          ? { status: 'idle' }
          : {
              status: { status: 'ERROR', sessionId: 'retained-session', lastError: 'Cleanup is required.' },
              terminalOutcome: { providerId: 'gemini', error: 'PROVIDER_SESSION_ENDED', occurredAt: 3 }
            })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
      id: 'extension-id', url: 'chrome-extension://extension-id/'
    })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('button[aria-label="Clean up live dubbing"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Cleanup is required.')
  })

  it('does not let a late notification read overwrite a newer start', async () => {
    let resolveNotificationStatus
    let statusReads = 0
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        statusReads += 1
        return statusReads === 1 ? Promise.resolve({ status: 'idle' }) : new Promise(resolve => {
          resolveNotificationStatus = resolve
        })
      }
      if (action === 'START_LIVE_DUBBING') return Promise.resolve({ status: 'running', sessionId: 'new-session' })
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
      id: 'extension-id', url: 'chrome-extension://extension-id/'
    })
    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    resolveNotificationStatus({ status: { status: 'ERROR', sessionId: 'old-session', lastError: 'stale' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('stale')
  })

  it('clears historical outcome only after a successful new start', async () => {
    sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
      ? Promise.resolve({ status: 'idle', terminalOutcome: { providerId: 'gemini', error: 'OLD_OUTCOME', occurredAt: 1 } })
      : Promise.resolve({ status: 'running', sessionId: 'new-session' }))

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('OLD_OUTCOME')
  })

  it('does not clear historical outcome when a new start fails', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
        status: 'idle',
        terminalOutcome: { providerId: 'gemini', error: 'PREVIOUS_TERMINAL_FAILURE', occurredAt: 1 }
      })
      const failure = { success: false, error: 'START_FAILED', status: 'idle', terminalOutcome: {
        providerId: 'gemini', error: 'PREVIOUS_TERMINAL_FAILURE', occurredAt: 1
      } }
      return Promise.reject(Object.assign(new Error('START_FAILED'), { data: failure }))
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.terminalOutcome.error).toBe('PREVIOUS_TERMINAL_FAILURE')
    expect(wrapper.text()).toContain('START_FAILED')
  })

  it('does not resurrect history when notification status clears it during a pending start', async () => {
    let resolveStart
    let statusReads = 0
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        statusReads += 1
        return statusReads === 1
          ? Promise.resolve({
              status: 'idle',
              terminalOutcome: { providerId: 'gemini', error: 'OLD_OUTCOME', occurredAt: 1 }
            })
          : Promise.resolve({
              status: { status: 'RUNNING', sessionId: 'session-1' },
              terminalOutcome: null
            })
      }
      if (action === 'START_LIVE_DUBBING') return new Promise(resolve => { resolveStart = resolve })
      if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle', terminalOutcome: null })
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')

    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
      id: 'extension-id', url: 'chrome-extension://extension-id/'
    })
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.terminalOutcome).toBe(null)

    resolveStart({ status: 'running', sessionId: 'late-session' })
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.terminalOutcome).toBe(null)
    expect(wrapper.text()).not.toContain('OLD_OUTCOME')
  })


  // ── Finding 1: START-from-idle volume recovery ──────────────────────────────

  it('recovers volume after START-from-idle: ORIGINAL_VOLUME query fires and slider resolves', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
      if (action === 'START_LIVE_DUBBING') return Promise.resolve({
        status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
      })
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
        success: true, originalVolume: 0.75
      })
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = await mountAndFlush()
    // Idle: no volume control shown
    expect(wrapper.find('.ti-live-dubbing-control-volume').exists()).toBe(false)

    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // Volume control visible and resolved to 75%
    expect(wrapper.find('.ti-live-dubbing-control-volume').exists()).toBe(true)
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('75%')
    expect(wrapper.find('#ti-live-dubbing-volume').attributes('disabled')).toBeUndefined()
  })

  // ── Finding 2: resetVolumeState invalidation ────────────────────────────────

  it('invalidates in-flight GET_ORIGINAL_VOLUME when STOP begins', async () => {
    let resolveGetVolume
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
      if (action === 'START_LIVE_DUBBING') return Promise.resolve({
        status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
      })
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
        return new Promise(resolve => { resolveGetVolume = resolve })
      }
      if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = await mountAndFlush()

    // START - triggers slow volume query
    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await flushPromises(wrapper)

    // STOP - should invalidate in-flight volume query
    await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
    await flushPromises(wrapper)

    // Late resolution - should be discarded
    resolveGetVolume({ success: true, originalVolume: 0.5 })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // Session cleared - volume control hidden
    expect(wrapper.find('.ti-live-dubbing-control-volume').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Start live dubbing"]').exists()).toBe(true)
  })

  it('invalidates in-flight GET_ORIGINAL_VOLUME when session fence changes A to B', async () => {
    let resolveGetVolumeA
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
      if (action === 'START_LIVE_DUBBING') return Promise.resolve({
        status: { status: 'RUNNING', sessionId: 'sA', providerId: 'gemini', eventSequence: 1 }
      })
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
        return new Promise(resolve => { resolveGetVolumeA = resolve })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = await mountAndFlush()

    // START with session A - triggers slow volume query
    await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
    await flushPromises(wrapper)

    // Simulate external session change (B) via the message handler
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
        status: { status: 'RUNNING', sessionId: 'sB', providerId: 'gemini', eventSequence: 2 }
      })
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
        success: true, originalVolume: 0.3
      })
      return Promise.resolve({ status: 'idle' })
    })

    // Trigger status re-read which changes the session
    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
      id: 'extension-id', url: 'chrome-extension://extension-id/'
    })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // Late resolution from session A - should be discarded
    resolveGetVolumeA({ success: true, originalVolume: 0.9 })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // Volume reflects session B query (0.3), not session A (0.9)
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('30%')
  })

  // ── Finding 3: eventSequence-only fence regression ──────────────────────────

  it('detects eventSequence-only fence change and re-queries volume', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
        status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
      })
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
        success: true, originalVolume: 0.4
      })
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = await mountAndFlush()
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('40%')

    // Update mock: same sessionId/providerId but different eventSequence
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
        status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 2 }
      })
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
        success: true, originalVolume: 0.6
      })
      return Promise.resolve({ status: 'idle' })
    })

    // Trigger a status re-read that changes only eventSequence
    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
      id: 'extension-id', url: 'chrome-extension://extension-id/'
    })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // Volume should reflect the re-queried value (0.6)
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('60%')
  })

  // ── Finding 4: Unmount duplicate send ───────────────────────────────────────

  it('flushes unsent volume snapshot exactly once on unmount', async () => {
    vi.useFakeTimers()
    try {
      let setCallCount = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          setCallCount += 1
          return Promise.resolve({
            success: true, originalVolume: 0.8, ignored: false, superseded: false
          })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      // Simulate volume input (creates pending shot, starts throttle timer)
      const slider = wrapper.find('#ti-live-dubbing-volume')
      await slider.setValue(80)
      await flushPromises(wrapper)

      // Unmount BEFORE throttle fires
      wrapper.unmount()

      // flushPendingVolumeSend clears the timer and sends the unsent snapshot once
      expect(setCallCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not resend dispatched volume snapshot on unmount', async () => {
    vi.useFakeTimers()
    try {
      let setCallCount = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          setCallCount += 1
          return Promise.resolve({
            success: true, originalVolume: 0.8, ignored: false, superseded: false
          })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      // Simulate volume input
      const slider = wrapper.find('#ti-live-dubbing-volume')
      await slider.setValue(80)
      await flushPromises(wrapper)

      // Let the throttle fire - sends the snapshot
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(setCallCount).toBe(1)

      // Unmount - should NOT resend because pendingVolumeShot was already consumed
      wrapper.unmount()
      await flushPromises(wrapper)

      expect(setCallCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Finding 5: Retry gating ─────────────────────────────────────────────────

  it('persistent session mismatch results in exactly 1 refresh and 1 retry max', async () => {
    let getVolumeCalls = 0
    let getStatusCalls = 0
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        getStatusCalls += 1
        return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
      }
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
        getVolumeCalls += 1
        return Promise.resolve({
          success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH'
        })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = await mountAndFlush()
    await flushPromises(wrapper)

    // The initial volume query fires from mount, gets mismatch,
    // triggers 1 refresh + 1 retry
    await flushPromises(wrapper)
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // At most 3 getVolume calls: initial + 1 retry (depth 0 -> refresh -> depth 1)
    expect(getVolumeCalls).toBeLessThanOrEqual(3)
    // At most 2 status refreshes: 1 from initial mismatch recovery
    expect(getStatusCalls).toBeLessThanOrEqual(2)
  })

  it('mid-recovery lifecycle move discards stale refresh result', async () => {
    let resolveStatus
    let getVolumeCalls = 0
    let getStatusCalls = 0

    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        getStatusCalls += 1
        if (getStatusCalls === 2) {
          return new Promise(resolve => { resolveStatus = resolve })
        }
        return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
      }
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
        getVolumeCalls += 1
        if (getVolumeCalls === 1) {
          return Promise.resolve({
            success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH'
          })
        }
        return Promise.resolve({ success: true, originalVolume: 0.5 })
      }
      if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = await mountAndFlush()
    await flushPromises(wrapper)

    // STOP triggers a new operation generation, making the recovery stale
    await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
    await flushPromises(wrapper)

    // Resolve the stalled status refresh - generation changed, so discard
    resolveStatus({
      status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
    })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // Only the initial volume query should have fired
    expect(getVolumeCalls).toBe(1)
  })

  // ── Finding 6: Local STOP gating ────────────────────────────────────────────

  it('no SET volume scheduled after local STOP begins', async () => {
    vi.useFakeTimers()
    try {
      let setCallCount = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          setCallCount += 1
          return Promise.resolve({
            success: true, originalVolume: 0.8, ignored: false, superseded: false
          })
        }
        if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      // Input volume - creates pending shot + throttle timer
      const slider = wrapper.find('#ti-live-dubbing-volume')
      await slider.setValue(80)
      await flushPromises(wrapper)

      // STOP clears the throttle timer via resetVolumeState
      await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
      await flushPromises(wrapper)

      // Advance past the throttle interval - timer should be cancelled
      vi.advanceTimersByTime(200)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // No SET should have been sent because stop() cancelled the timer
      expect(setCallCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Finding 7: Latest-wins tests ────────────────────────────────────────────

  it('latest-wins: old SET success does not overwrite newer value', async () => {
    vi.useFakeTimers()
    try {
      let resolveSetA
      let setCallCount = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          setCallCount += 1
          if (setCallCount === 1) {
            // Slow A - in flight
            return new Promise(resolve => { resolveSetA = resolve })
          }
          // Fast B - resolves quickly with newer volume
          return Promise.resolve({
            success: true, originalVolume: 0.8, ignored: false, superseded: false
          })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      // Input A (0.3) - throttle fires, SET A in flight
      const slider = wrapper.find('#ti-live-dubbing-volume')
      await slider.setValue(30)
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)

      // Input B (0.8) - throttle fires, SET B sent
      await slider.setValue(80)
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // B committed first
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')

      // Late resolution of A (success) - generation stale, discarded
      resolveSetA({ success: true, originalVolume: 0.3 })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // A did NOT overwrite B
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')
    } finally {
      vi.useRealTimers()
    }
  })

  it('latest-wins: old SET failure does not rollback newer value', async () => {
    vi.useFakeTimers()
    try {
      let resolveSetA
      let setCallCount = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          setCallCount += 1
          if (setCallCount === 1) {
            // Slow A - in flight
            return new Promise(resolve => { resolveSetA = resolve })
          }
          // Fast B - succeeds
          return Promise.resolve({
            success: true, originalVolume: 0.8, ignored: false, superseded: false
          })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      // Input A (0.3) - throttle fires, SET A in flight
      const slider = wrapper.find('#ti-live-dubbing-volume')
      await slider.setValue(30)
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)

      // Input B (0.8) - throttle fires, SET B sent
      await slider.setValue(80)
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')

      // Late failure of A - generation stale, discarded (no rollback)
      resolveSetA({ success: false, error: 'SOME_ERROR' })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // A failure did NOT rollback B
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')
    } finally {
      vi.useRealTimers()
    }
  })

  it('latest-wins: old SET superseded does not affect newer value', async () => {
    vi.useFakeTimers()
    try {
      let resolveSetA
      let setCallCount = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          setCallCount += 1
          if (setCallCount === 1) {
            // Slow A - in flight
            return new Promise(resolve => { resolveSetA = resolve })
          }
          // Fast B - succeeds
          return Promise.resolve({
            success: true, originalVolume: 0.8, ignored: false, superseded: false
          })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      // Input A (0.3) - throttle fires, SET A in flight
      const slider = wrapper.find('#ti-live-dubbing-volume')
      await slider.setValue(30)
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)

      // Input B (0.8) - throttle fires, SET B sent
      await slider.setValue(80)
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')

      // Late superseded of A - generation stale, discarded
      resolveSetA({ success: true, ignored: true, superseded: true })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // Superseded A did NOT affect B
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces rapid volume inputs within a throttle cycle', async () => {
    vi.useFakeTimers()
    try {
      let setCallCount = 0
      let lastSetVolume = null
      sendMessage.mockImplementation(({ action, data }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          setCallCount += 1
          lastSetVolume = data?.volume
          return Promise.resolve({
            success: true, originalVolume: lastSetVolume, ignored: false, superseded: false
          })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      // Rapid inputs within one throttle cycle - only the last value sent
      const slider = wrapper.find('#ti-live-dubbing-volume')
      await slider.setValue(10)
      await slider.setValue(50)
      await slider.setValue(90)
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // Only one SET sent with the coalesced (last) value
      expect(setCallCount).toBe(1)
      expect(lastSetVolume).toBe(0.9)
    } finally {
      vi.useRealTimers()
    }
  })
  // ── Finding 8: Latest-wins at input time (A resolves BEFORE B dispatched) ──

  it.each([
    ['A success cannot overwrite B', { success: true, originalVolume: 0.3 }],
    ['A failure cannot rollback B', { success: false, error: 'SOME_ERROR' }],
    ['A superseded does not affect B', { success: true, ignored: true, superseded: true }],
  ])('latest-wins at input time: %s', async (_label, aResponse) => {
    vi.useFakeTimers()
    try {
      let resolveSetA
      let setCallCount = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          setCallCount += 1
          if (setCallCount === 1) {
            // Slow A — in flight
            return new Promise(resolve => { resolveSetA = resolve })
          }
          // Fast B — succeeds
          return Promise.resolve({
            success: true, originalVolume: 0.8, ignored: false, superseded: false
          })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      // Input A (0.3) — generation bumped at input time, throttle fires
      const slider = wrapper.find('#ti-live-dubbing-volume')
      await slider.setValue(30)
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)
      expect(setCallCount).toBe(1)

      // Input B (0.8) — generation bumped to N+1, new throttle timer starts
      await slider.setValue(80)
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')

      // A resolves BEFORE B's timer fires — generation stale, discarded
      resolveSetA(aResponse)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // Display still shows B (optimistic) — A's response did not touch state
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')

      // B's timer fires — SET B dispatched with generation N+1
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // B confirmed at 80%
      expect(setCallCount).toBe(2)
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')
    } finally {
      vi.useRealTimers()
    }
  })

  it('latest-wins at input time: A mismatch cannot start stale recovery that replaces B state', async () => {
    vi.useFakeTimers()
    try {
      let resolveSetA
      let setCallCount = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          setCallCount += 1
          if (setCallCount === 1) {
            return new Promise(resolve => { resolveSetA = resolve })
          }
          return Promise.resolve({
            success: true, originalVolume: 0.8, ignored: false, superseded: false
          })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      const slider = wrapper.find('#ti-live-dubbing-volume')
      await slider.setValue(30)
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)

      // Input B — generation bumped
      await slider.setValue(80)

      // A resolves with mismatch — generation stale, discarded before recovery
      resolveSetA({ success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // B still optimistic, no stale recovery overwrote state
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')

      // B dispatches and confirms
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Volume functional tests ────────────────────────────────────────────────

  describe('Volume control', () => {
    it('volume control is hidden when idle', async () => {
      const wrapper = await mountAndFlush()
      expect(wrapper.find('.ti-live-dubbing-control-volume').exists()).toBe(false)
    })

    it('reads and displays volume for active RUNNING session', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.65
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      expect(wrapper.find('.ti-live-dubbing-control-volume').exists()).toBe(true)
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('65%')
      expect(wrapper.find('#ti-live-dubbing-volume').attributes('disabled')).toBeUndefined()
    })

    it('recovers non-zero runtime volume on popup reopen', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.42
        })
        return Promise.resolve({ status: 'idle' })
      })

      const first = await mountAndFlush()
      expect(first.find('.ti-live-dubbing-control-volume-value').text()).toBe('42%')
      first.unmount()

      const second = await mountAndFlush()
      expect(second.find('.ti-live-dubbing-control-volume-value').text()).toBe('42%')
    })

    it('shows dash and disables slider when volume query fails with non-mismatch error', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: false, error: 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE'
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      expect(wrapper.find('.ti-live-dubbing-control-volume').exists()).toBe(true)
      expect(wrapper.find('#ti-live-dubbing-volume').attributes('disabled')).toBeDefined()
    })

    it.each([
      [0, '0%'],
      [0.3, '30%'],
      [0.5, '50%'],
      [0.75, '75%'],
      [1, '100%'],
    ])('converts backend volume %s to display %s', async (input, expected) => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: input
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe(expected)
    })

    it('immediately displays optimistic volume on slider input', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('50%')

      await wrapper.find('#ti-live-dubbing-volume').setValue(75)
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('75%')
    })

    it('successful SET confirmation commits backend volume', async () => {
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(({ action, data }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
          })
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            return Promise.resolve({
              success: true, originalVolume: data.volume, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        await wrapper.find('#ti-live-dubbing-volume').setValue(90)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('90%')
      } finally {
        vi.useRealTimers()
      }
    })

    it('SET failure rolls back desiredVolume to last confirmed', async () => {
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
          })
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            return Promise.resolve({ success: false, error: 'GENERIC_FAIL' })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        await wrapper.find('#ti-live-dubbing-volume').setValue(80)
        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')

        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('50%')
      } finally {
        vi.useRealTimers()
      }
    })

    it('transport rejection rolls back desiredVolume to last confirmed', async () => {
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
          })
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            return Promise.reject(new Error('transport failed'))
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        await wrapper.find('#ti-live-dubbing-volume').setValue(80)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('50%')
      } finally {
        vi.useRealTimers()
      }
    })

    it('superseded SET response is non-error with no rollback', async () => {
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
          })
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            return Promise.resolve({ success: true, ignored: true, superseded: true })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        await wrapper.find('#ti-live-dubbing-volume').setValue(80)
        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')

        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // Superseded: no rollback, optimistic 80% preserved (no commit either)
        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')
        expect(wrapper.find('.ti-live-dubbing-control-volume-error').exists()).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('ORIGINAL_AUDIO_UNAVAILABLE shows inline error and does not stop session', async () => {
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
          })
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            return Promise.resolve({
              success: false, error: 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE'
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        await wrapper.find('#ti-live-dubbing-volume').setValue(80)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // Rolls back and shows inline error
        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('50%')
        expect(wrapper.find('.ti-live-dubbing-control-volume-error').exists()).toBe(true)
        expect(wrapper.find('.ti-live-dubbing-control-volume-error').text()).toBe('Original audio unavailable')

        // Session still running — not terminal
        expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
        expect(wrapper.find('.ti-live-dubbing-control-error').exists()).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('volume control disappears after session teardown', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      expect(wrapper.find('.ti-live-dubbing-control-volume').exists()).toBe(true)

      await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.find('.ti-live-dubbing-control-volume').exists()).toBe(false)
    })

    it.each([
      ['PREPARING_CAPTURE', true],
      ['CONNECTING_PROVIDER', true],
      ['RUNNING', true],
      ['STOPPING', false],
      ['ERROR', false],
    ])('volume is %s controllable in %s status', async (status, controllable) => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status, sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      const hasVolume = wrapper.find('.ti-live-dubbing-control-volume').exists()
      if (controllable) {
        expect(hasVolume).toBe(true)
        expect(wrapper.find('#ti-live-dubbing-volume').attributes('disabled')).toBeUndefined()
      } else {
        expect(hasVolume).toBe(false)
      }
    })

    it('sends volume operations with recovered descriptor, not current provider prop', async () => {
      sendMessage.mockImplementation(({ action, data }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'openai', eventSequence: 3 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          return Promise.resolve({
            success: true, originalVolume: data.volume, ignored: false, superseded: false,
          })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush({ providerId: 'gemini' })
      await flushPromises(wrapper)

      vi.useFakeTimers()
      try {
        await wrapper.find('#ti-live-dubbing-volume').setValue(80)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // SET used the descriptor's provider (openai), not the prop (gemini)
        const setCall = sendMessage.mock.calls.find(([m]) => m.action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME')
        expect(setCall[0].data.providerId).toBe('openai')
        expect(setCall[0].data.sessionId).toBe('s1')
        expect(setCall[0].data.eventSequence).toBe(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('volume operations do not send START_LIVE_DUBBING', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.7, ignored: false, superseded: false
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      const startCallsBefore = sendMessage.mock.calls.filter(([m]) => m.action === 'START_LIVE_DUBBING').length

      vi.useFakeTimers()
      try {
        await wrapper.find('#ti-live-dubbing-volume').setValue(70)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        const startCallsAfter = sendMessage.mock.calls.filter(([m]) => m.action === 'START_LIVE_DUBBING').length
        expect(startCallsAfter).toBe(startCallsBefore)
      } finally {
        vi.useRealTimers()
      }
    })

    it('lifecycle and volume generation counters are independent', async () => {
      let getVolumeCalls = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          getVolumeCalls += 1
          return Promise.resolve({ success: true, originalVolume: 0.5 })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)
      const volumeAfterMount = getVolumeCalls

      // A same-fence notification triggers queryStatus but does NOT re-read volume
      // because the fence is unchanged — volume generation is independent of lifecycle.
      runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
        id: 'extension-id', url: 'chrome-extension://extension-id/'
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(getVolumeCalls).toBe(volumeAfterMount)
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('50%')
    })

    it('same-fence status refresh does not re-query volume', async () => {
      let getVolumeCalls = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          getVolumeCalls += 1
          return Promise.resolve({ success: true, originalVolume: 0.5 })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)
      const initialCalls = getVolumeCalls

      // Trigger status refresh with SAME fence — should not re-read
      runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
        id: 'extension-id', url: 'chrome-extension://extension-id/'
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // No additional volume read because fence didn't change
      expect(getVolumeCalls).toBe(initialCalls)
    })
  })

  // ── Defect 1: fence A→B invalidates stale state ──────────────────────────

  it('fence A→B invalidates stale confirmed state and re-queries', async () => {
    let getVolumeCalls = 0
    let resolveGetVolumeB
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
        status: { status: 'RUNNING', sessionId: 'sA', providerId: 'gemini', eventSequence: 1 }
      })
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
        getVolumeCalls += 1
        return Promise.resolve({ success: true, originalVolume: 0.4 })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = await mountAndFlush()
    await flushPromises(wrapper)
    // Session A resolved at 40%
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('40%')
    const callsAfterA = getVolumeCalls

    // Simulate fence change A→B via a slow queryOriginalVolume for B
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
        status: { status: 'RUNNING', sessionId: 'sB', providerId: 'gemini', eventSequence: 2 }
      })
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
        getVolumeCalls += 1
        return new Promise(resolve => { resolveGetVolumeB = resolve })
      }
      return Promise.resolve({ status: 'idle' })
    })

    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
      id: 'extension-id', url: 'chrome-extension://extension-id/'
    })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // Volume invalidated: display shows dash, slider disabled while B pends
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('—')
    expect(wrapper.find('#ti-live-dubbing-volume').attributes('disabled')).toBeDefined()

    // B's original volume query resolves with different value
    resolveGetVolumeB({ success: true, originalVolume: 0.75 })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // Session B value shown, not session A's 40%
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('75%')
    expect(getVolumeCalls).toBeGreaterThan(callsAfterA)
  })

  it('fence A→B: B query failure does not retain A confirmed state', async () => {
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
        status: { status: 'RUNNING', sessionId: 'sA', providerId: 'gemini', eventSequence: 1 }
      })
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
        return Promise.resolve({ success: true, originalVolume: 0.4 })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = await mountAndFlush()
    await flushPromises(wrapper)
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('40%')

    // Fence A→B, B query fails
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
        status: { status: 'RUNNING', sessionId: 'sB', providerId: 'gemini', eventSequence: 2 }
      })
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
        return Promise.resolve({ success: false, error: 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE' })
      }
      return Promise.resolve({ status: 'idle' })
    })

    runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
      id: 'extension-id', url: 'chrome-extension://extension-id/'
    })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // A's 40% is NOT retained — invalidated state (dash + disabled)
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('—')
    expect(wrapper.find('#ti-live-dubbing-volume').attributes('disabled')).toBeDefined()
  })

  // ── Defect 2: recovery doesn't outrank newer input ───────────────────────

  it('recovery does not outrank newer user input', async () => {
    vi.useFakeTimers()
    try {
      let setCallCount = 0
      let getStatusCalls = 0
      let resolveStatus
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          getStatusCalls += 1
          // Second status read (from recovery) is slow
          if (getStatusCalls === 2) {
            return new Promise(resolve => { resolveStatus = resolve })
          }
          return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
          })
        }
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          return Promise.resolve({ success: true, originalVolume: 0.5 })
        }
        if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          setCallCount += 1
          if (setCallCount === 1) {
            // First SET (A=80%) returns mismatch → triggers recovery
            return Promise.resolve({ success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' })
          }
          // Second SET (B=60%) succeeds
          return Promise.resolve({
            success: true, originalVolume: 0.6, ignored: false, superseded: false
          })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('50%')

      // Input A=80% → throttle fires → SET A dispatched → mismatch response
      const slider = wrapper.find('#ti-live-dubbing-volume')
      await slider.setValue(80)
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // A mismatch triggers recovery (status read #2 is slow, in flight)
      expect(getStatusCalls).toBe(2)

      // User inputs B=60% while recovery is pending → generation bumped
      await slider.setValue(60)
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('60%')

      // Recovery status resolves — generation was bumped by user input,
      // so recovery discards result (no retry)
      resolveStatus({
        status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // User's 60% still displayed — recovery did not overwrite
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('60%')

      // User's SET for B dispatched normally
      vi.advanceTimersByTime(100)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(setCallCount).toBe(2)
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('60%')
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Race: mismatch recovery discovers A→B, watcher must own B read ────────

  it('mismatch recovery discovers fence A→B: exactly one GET_ORIGINAL_VOLUME for B resolves slider', async () => {
    let resolveStatus
    let getVolumeCalls = 0
    let getStatusCalls = 0
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        getStatusCalls += 1
        if (getStatusCalls === 2) {
          // Second STATUS (from recovery) reveals fence B — held until flushed
          return new Promise(resolve => { resolveStatus = resolve })
        }
        return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 'sA', providerId: 'gemini', eventSequence: 1 }
        })
      }
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
        getVolumeCalls += 1
        if (getVolumeCalls === 1) {
          return Promise.resolve({ success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' })
        }
        return Promise.resolve({ success: true, originalVolume: 0.65 })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = await mountAndFlush()
    await flushPromises(wrapper)

    // Mount: STATUS → sA, GET_ORIGINAL_VOLUME → mismatch → enters recovery.
    // Recovery STATUS (#2) is held pending.
    expect(getStatusCalls).toBe(2)
    const volumeCallsAfterMount = getVolumeCalls

    // Resolve recovery STATUS → fence changes to B → watcher owns B read.
    resolveStatus({
      status: { status: 'RUNNING', sessionId: 'sB', providerId: 'gemini', eventSequence: 2 }
    })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // Exactly one GET_ORIGINAL_VOLUME for B (the watcher's read)
    expect(getVolumeCalls).toBe(volumeCallsAfterMount + 1)

    // B's volume resolves the slider — not stuck at dash
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('65%')
    expect(wrapper.find('#ti-live-dubbing-volume').attributes('disabled')).toBeUndefined()
  })

  it('mismatch recovery discovers fence A→B: B query failure does not restore A confirmed', async () => {
    let resolveStatus
    let getVolumeCalls = 0
    sendMessage.mockImplementation(({ action }) => {
      if (action === 'GET_LIVE_DUBBING_STATUS') {
        if (getVolumeCalls <= 1) {
          // First STATUS returns A (immediate); recovery STATUS reveals B (held)
          return getVolumeCalls === 0
            ? Promise.resolve({
                status: { status: 'RUNNING', sessionId: 'sA', providerId: 'gemini', eventSequence: 1 }
              })
            : new Promise(resolve => { resolveStatus = resolve })
        }
        return Promise.resolve({
          status: { status: 'RUNNING', sessionId: 'sB', providerId: 'gemini', eventSequence: 2 }
        })
      }
      if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
        getVolumeCalls += 1
        if (getVolumeCalls === 1) {
          // A returns mismatch → triggers recovery
          return Promise.resolve({ success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' })
        }
        // B query fails (audio unavailable)
        return Promise.resolve({ success: false, error: 'LIVE_DUBBING_ORIGINAL_AUDIO_UNAVAILABLE' })
      }
      return Promise.resolve({ status: 'idle' })
    })

    const wrapper = await mountAndFlush()
    await flushPromises(wrapper)

    // Resolve recovery status → fence changes to B
    resolveStatus({
      status: { status: 'RUNNING', sessionId: 'sB', providerId: 'gemini', eventSequence: 2 }
    })
    await flushPromises(wrapper)
    await flushPromises(wrapper)

    // B's query failed — slider disabled, not showing A's old value
    expect(wrapper.find('#ti-live-dubbing-volume').attributes('disabled')).toBeDefined()
    // No restored A value (A never resolved successfully)
    expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('—')
  })

  // Dubbed Volume mirrors the Original Volume runtime contract while keeping
  // request generations, throttling, recovery, and failure state independent.

  describe('Dubbed Volume', () => {
    const DUBBED_SLIDER_SELECTOR = '#ti-live-dubbing-dubbed-volume'
    const getDubbedSlider = (wrapper) => wrapper.find(DUBBED_SLIDER_SELECTOR)
    // The Dubbed value span is the second `.ti-live-dubbing-control-volume-value`
    // (the first belongs to the Original lane).
    const getDubbedValue = (wrapper) => wrapper.findAll('.ti-live-dubbing-control-volume-value')[1]
    const dubbedValueText = (wrapper) => getDubbedValue(wrapper).text()
    const runningStatus = (sessionId = 's1', eventSequence = 1) => ({
      status: { status: 'RUNNING', sessionId, providerId: 'gemini', eventSequence }
    })

    it.each([
      'PREPARING_CAPTURE',
      'CONNECTING_PROVIDER',
      'RUNNING',
    ])('dubbed slider renders for a controllable %s session', async (status) => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({
          status: { status, sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      expect(getDubbedSlider(wrapper).exists()).toBe(true)
    })

    it('runtime GET initializes the dubbed slider correctly', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
          success: true, dubbedVolume: 0.42
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(getDubbedSlider(wrapper).element.value).toBe('42')
      expect(dubbedValueText(wrapper)).toBe('42%')
      expect(getDubbedSlider(wrapper).attributes('disabled')).toBeUndefined()
    })

    it('UI 30 maps to backend 0.3', async () => {
      vi.useFakeTimers()
      try {
        let setVolume = null
        sendMessage.mockImplementation(({ action, data }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            setVolume = data?.volume
            return Promise.resolve({
              success: true, dubbedVolume: setVolume, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        await getDubbedSlider(wrapper).setValue(30)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(setVolume).toBe(0.3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('backend 0.75 maps to UI 75', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
          success: true, dubbedVolume: 0.75
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(getDubbedSlider(wrapper).element.value).toBe('75')
      expect(dubbedValueText(wrapper)).toBe('75%')
    })

    it('default new session displays 100', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
          success: true, dubbedVolume: 1
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(getDubbedSlider(wrapper).element.value).toBe('100')
      expect(dubbedValueText(wrapper)).toBe('100%')
    })

    it('immediately displays optimistic dubbed volume on slider input', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
          success: true, dubbedVolume: 0.5
        })
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)
      expect(dubbedValueText(wrapper)).toBe('50%')

      await getDubbedSlider(wrapper).setValue(75)
      // No throttle advance: optimistic UI must already reflect the new value.
      expect(dubbedValueText(wrapper)).toBe('75%')
    })

    it('coalesces rapid dubbed inputs within a throttle cycle', async () => {
      vi.useFakeTimers()
      try {
        let setCallCount = 0
        let lastSetVolume = null
        sendMessage.mockImplementation(({ action, data }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            setCallCount += 1
            lastSetVolume = data?.volume
            return Promise.resolve({
              success: true, dubbedVolume: lastSetVolume, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        // Rapid inputs within one throttle cycle — only the last value is sent.
        const slider = getDubbedSlider(wrapper)
        await slider.setValue(10)
        await slider.setValue(30)
        await slider.setValue(50)
        await slider.setValue(70)
        await slider.setValue(90)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(setCallCount).toBe(1)
        expect(lastSetVolume).toBe(0.9)
      } finally {
        vi.useRealTimers()
      }
    })

    it('newest dubbed input wins across throttle cycles', async () => {
      vi.useFakeTimers()
      try {
        const sentVolumes = []
        sendMessage.mockImplementation(({ action, data }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            sentVolumes.push(data?.volume)
            return Promise.resolve({
              success: true, dubbedVolume: data?.volume, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        const slider = getDubbedSlider(wrapper)
        await slider.setValue(30)
        vi.advanceTimersByTime(80)
        await flushPromises(wrapper)
        await slider.setValue(60)
        vi.advanceTimersByTime(80)
        await flushPromises(wrapper)
        await slider.setValue(90)
        vi.advanceTimersByTime(80)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(sentVolumes).toEqual([0.3, 0.6, 0.9])
        expect(dubbedValueText(wrapper)).toBe('90%')
      } finally {
        vi.useRealTimers()
      }
    })

    it('stale dubbed response cannot overwrite newer input', async () => {
      vi.useFakeTimers()
      try {
        let resolveSetA
        let setCallCount = 0
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            setCallCount += 1
            if (setCallCount === 1) {
              // Slow A — in flight.
              return new Promise(resolve => { resolveSetA = resolve })
            }
            // Fast B — resolves with the newer volume.
            return Promise.resolve({
              success: true, dubbedVolume: 0.8, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        const slider = getDubbedSlider(wrapper)
        await slider.setValue(30)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)

        await slider.setValue(80)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // B committed first.
        expect(dubbedValueText(wrapper)).toBe('80%')

        // Late resolution of A (success) — generation stale, discarded.
        resolveSetA({ success: true, dubbedVolume: 0.3 })
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // A did NOT overwrite B.
        expect(dubbedValueText(wrapper)).toBe('80%')
      } finally {
        vi.useRealTimers()
      }
    })

    it('dubbed failure rolls back and resyncs to the committed value', async () => {
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            return Promise.resolve({
              success: false, error: 'LIVE_DUBBING_DUBBED_AUDIO_UNAVAILABLE', dubbedVolume: 0.7
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        await getDubbedSlider(wrapper).setValue(80)
        expect(dubbedValueText(wrapper)).toBe('80%')

        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // Failure responses never commit: rollback target is last-confirmed (50%),
        // even though the failure payload carries a `dubbedVolume` field.
        expect(dubbedValueText(wrapper)).toBe('50%')
        expect(wrapper.find('.ti-live-dubbing-control-volume-error').exists()).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('dubbed session mismatch performs bounded recovery', async () => {
      vi.useFakeTimers()
      try {
        let getDubbedVolumeCalls = 0
        let getStatusCalls = 0
        let setCallCount = 0
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') {
            getStatusCalls += 1
            return Promise.resolve(runningStatus())
          }
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') {
            getDubbedVolumeCalls += 1
            // Initial read succeeds; the post-recovery retry mismatches again.
            return getDubbedVolumeCalls === 1
              ? Promise.resolve({ success: true, dubbedVolume: 0.5 })
              : Promise.resolve({ success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' })
          }
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            setCallCount += 1
            return Promise.resolve({ success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        const statusCallsAfterMount = getStatusCalls
        const dubbedCallsAfterMount = getDubbedVolumeCalls

        await getDubbedSlider(wrapper).setValue(80)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(setCallCount).toBe(1)
        // Exactly one lifecycle refresh …
        expect(getStatusCalls).toBe(statusCallsAfterMount + 1)
        // … and exactly one retry read, which mismatches again and stops (depth 1).
        expect(getDubbedVolumeCalls).toBe(dubbedCallsAfterMount + 1)
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        expect(getDubbedVolumeCalls).toBe(dubbedCallsAfterMount + 1)
        expect(getStatusCalls).toBe(statusCallsAfterMount + 1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('lifecycle fence change recovers the dubbed watcher and discards old pending ops', async () => {
      vi.useFakeTimers()
      try {
        let resolveGetDubbedVolumeB
        let setDubbedCalls = 0
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus('sA', 1))
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.4
          })
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            setDubbedCalls += 1
            return Promise.resolve({
              success: true, dubbedVolume: 0.8, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        expect(dubbedValueText(wrapper)).toBe('40%')

        // Queue a dubbed input for session A (pending, throttle not yet fired).
        await getDubbedSlider(wrapper).setValue(80)

        // Fence changes A→B; B's dubbed read is slow.
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus('sB', 2))
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') {
            return new Promise(resolve => { resolveGetDubbedVolumeB = resolve })
          }
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            setDubbedCalls += 1
            return Promise.resolve({
              success: true, dubbedVolume: 0.8, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
          id: 'extension-id', url: 'chrome-extension://extension-id/'
        })
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // Session A's pending SET must NOT fire for session B's fence.
        vi.advanceTimersByTime(200)
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        expect(setDubbedCalls).toBe(0)

        // B's dubbed query resolves with a different value.
        resolveGetDubbedVolumeB({ success: true, dubbedVolume: 0.75 })
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(dubbedValueText(wrapper)).toBe('75%')
      } finally {
        vi.useRealTimers()
      }
    })

    it('original and dubbed requests use independent generations', async () => {
      vi.useFakeTimers()
      try {
        let getOriginalCalls = 0
        let getDubbedCalls = 0
        sendMessage.mockImplementation(({ action, data }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            getOriginalCalls += 1
            return Promise.resolve({ success: true, originalVolume: 0.5 })
          }
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') {
            getDubbedCalls += 1
            return Promise.resolve({ success: true, dubbedVolume: 0.6 })
          }
          if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            return Promise.resolve({
              success: true, originalVolume: data?.volume, ignored: false, superseded: false
            })
          }
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            return Promise.resolve({
              success: true, dubbedVolume: data?.volume, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        const originalCallsAfterMount = getOriginalCalls
        const dubbedCallsAfterMount = getDubbedCalls

        // Bump the Original generation via an Original SET …
        await wrapper.find('#ti-live-dubbing-volume').setValue(80)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // … then bump the Dubbed generation via a Dubbed SET.
        await getDubbedSlider(wrapper).setValue(90)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // Neither lane re-queried the other: generations are independent.
        expect(getOriginalCalls).toBe(originalCallsAfterMount)
        expect(getDubbedCalls).toBe(dubbedCallsAfterMount)
        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')
        expect(dubbedValueText(wrapper)).toBe('90%')
      } finally {
        vi.useRealTimers()
      }
    })

    it('original pending request does not block dubbed', async () => {
      vi.useFakeTimers()
      try {
        let resolveOriginalSet
        let originalSetCalls = 0
        let dubbedSetCalls = 0
        sendMessage.mockImplementation(({ action, data }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.6
          })
          if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            originalSetCalls += 1
            return new Promise(resolve => { resolveOriginalSet = resolve })
          }
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            dubbedSetCalls += 1
            return Promise.resolve({
              success: true, dubbedVolume: data?.volume, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        // Start an Original SET and leave it pending …
        await wrapper.find('#ti-live-dubbing-volume').setValue(80)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        expect(originalSetCalls).toBe(1)

        // … while it is pending, a Dubbed SET must still be sent.
        await getDubbedSlider(wrapper).setValue(90)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(dubbedSetCalls).toBe(1)
        expect(dubbedValueText(wrapper)).toBe('90%')

        resolveOriginalSet({ success: true, originalVolume: 0.8, ignored: false, superseded: false })
        await flushPromises(wrapper)
      } finally {
        vi.useRealTimers()
      }
    })

    it('dubbed pending request does not block original', async () => {
      vi.useFakeTimers()
      try {
        let resolveDubbedSet
        let originalSetCalls = 0
        let dubbedSetCalls = 0
        sendMessage.mockImplementation(({ action, data }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.6
          })
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            dubbedSetCalls += 1
            return new Promise(resolve => { resolveDubbedSet = resolve })
          }
          if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            originalSetCalls += 1
            return Promise.resolve({
              success: true, originalVolume: data?.volume, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)

        // Start a Dubbed SET and leave it pending …
        await getDubbedSlider(wrapper).setValue(90)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        expect(dubbedSetCalls).toBe(1)

        // … while it is pending, an Original SET must still be sent.
        await wrapper.find('#ti-live-dubbing-volume').setValue(80)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(originalSetCalls).toBe(1)
        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')

        resolveDubbedSet({ success: true, dubbedVolume: 0.9, ignored: false, superseded: false })
        await flushPromises(wrapper)
      } finally {
        vi.useRealTimers()
      }
    })

    it('failure on original does not modify dubbed UI', async () => {
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.6
          })
          if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            return Promise.resolve({ success: false, error: 'GENERIC_FAIL' })
          }
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            return Promise.resolve({
              success: true, dubbedVolume: 0.9, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // Settle Dubbed at 90% first.
        await getDubbedSlider(wrapper).setValue(90)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        expect(dubbedValueText(wrapper)).toBe('90%')

        // Fail an Original SET — Dubbed UI must be unchanged.
        await wrapper.find('#ti-live-dubbing-volume').setValue(80)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('50%')
        expect(dubbedValueText(wrapper)).toBe('90%')
      } finally {
        vi.useRealTimers()
      }
    })

    it('failure on dubbed does not modify original UI', async () => {
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.6
          })
          if (action === 'SET_LIVE_DUBBING_ORIGINAL_VOLUME') {
            return Promise.resolve({
              success: true, originalVolume: 0.8, ignored: false, superseded: false
            })
          }
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            return Promise.resolve({ success: false, error: 'GENERIC_FAIL' })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        // Settle Original at 80% first.
        await wrapper.find('#ti-live-dubbing-volume').setValue(80)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')

        // Fail a Dubbed SET — Original UI must be unchanged.
        await getDubbedSlider(wrapper).setValue(90)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(dubbedValueText(wrapper)).toBe('60%')
        expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('80%')
      } finally {
        vi.useRealTimers()
      }
    })

    it('reopening popup queries actual runtime values for both lanes', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus())
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.42
        })
        if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
          success: true, dubbedVolume: 0.77
        })
        return Promise.resolve({ status: 'idle' })
      })

      const first = await mountAndFlush()
      await flushPromises(first)
      await flushPromises(first)
      expect(first.find('.ti-live-dubbing-control-volume-value').text()).toBe('42%')
      expect(dubbedValueText(first)).toBe('77%')
      first.unmount()

      sendMessage.mockClear()
      const second = await mountAndFlush()
      await flushPromises(second)
      await flushPromises(second)

      const actions = sendMessage.mock.calls.map(([m]) => m.action)
      expect(actions).toContain('GET_LIVE_DUBBING_ORIGINAL_VOLUME')
      expect(actions).toContain('GET_LIVE_DUBBING_DUBBED_VOLUME')
      expect(second.find('.ti-live-dubbing-control-volume-value').text()).toBe('42%')
      expect(dubbedValueText(second)).toBe('77%')
    })

    it('dubbed SET causes no lifecycle restart or eventSequence mutation', async () => {
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(({ action, data }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus('s1', 3))
          if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
            success: true, originalVolume: 0.5
          })
          if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') return Promise.resolve({
            success: true, dubbedVolume: 0.5
          })
          if (action === 'SET_LIVE_DUBBING_DUBBED_VOLUME') {
            return Promise.resolve({
              success: true, dubbedVolume: data?.volume, ignored: false, superseded: false
            })
          }
          return Promise.resolve({ status: 'idle' })
        })

        const wrapper = await mountAndFlush()
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        const sequenceBefore = wrapper.vm.sessionDescriptor.eventSequence
        const lifecycleCallsBefore = sendMessage.mock.calls.filter(([m]) =>
          ['START_LIVE_DUBBING', 'LIVE_DUBBING_DISPOSE', 'LIVE_DUBBING_STATUS'].includes(m.action)
        ).length

        await getDubbedSlider(wrapper).setValue(70)
        vi.advanceTimersByTime(100)
        await flushPromises(wrapper)
        await flushPromises(wrapper)

        expect(dubbedValueText(wrapper)).toBe('70%')
        expect(wrapper.vm.sessionDescriptor.eventSequence).toBe(sequenceBefore)
        const lifecycleCallsAfter = sendMessage.mock.calls.filter(([m]) =>
          ['START_LIVE_DUBBING', 'LIVE_DUBBING_DISPOSE', 'LIVE_DUBBING_STATUS'].includes(m.action)
        ).length
        expect(lifecycleCallsAfter).toBe(lifecycleCallsBefore)
      } finally {
        vi.useRealTimers()
      }
    })

    it('race A→B dubbed query: stale A response cannot overwrite B value', async () => {
      let resolveGetDubbedA
      let resolveGetDubbedB
      let getDubbedCalls = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus('sA', 1))
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') {
          getDubbedCalls += 1
          if (getDubbedCalls === 1) {
            return new Promise(resolve => { resolveGetDubbedA = resolve })
          }
          return Promise.resolve({ status: 'idle' })
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)

      // Lifecycle changes to Session B while A's dubbed GET is still in flight.
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve(runningStatus('sB', 2))
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') return Promise.resolve({
          success: true, originalVolume: 0.5
        })
        if (action === 'GET_LIVE_DUBBING_DUBBED_VOLUME') {
          return new Promise(resolve => { resolveGetDubbedB = resolve })
        }
        return Promise.resolve({ status: 'idle' })
      })

      runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, {
        id: 'extension-id', url: 'chrome-extension://extension-id/'
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // Session B's dubbed response arrives first …
      resolveGetDubbedB({ success: true, dubbedVolume: 0.65 })
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(dubbedValueText(wrapper)).toBe('65%')

      // … then Session A's stale response arrives late and must be discarded.
      resolveGetDubbedA({ success: true, dubbedVolume: 0.2 })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // UI still reflects Session B's value, not Session A's stale response.
      expect(dubbedValueText(wrapper)).toBe('65%')
    })

    // NOTE(spec §20): no test here by design — the contract is that the entire
    // pre-existing suite (Original Volume included) stays green. Verified by running
    // `vitest --config tests/vitest.config.js src/components/popup/LiveDubbingControl.test.js`
    // after adding this block.
  })

  describe('Phase 3 layout', () => {
    it('shows Cleanup required while a retained session awaits cleanup', async () => {
      // RUNNING with a retained session, then STOP fails at transport level:
      // the session stays and the status text names the cleanup state
      // (authoritativeStatus is null on this path, so state owns the label).
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          return Promise.resolve({ status: { status: 'RUNNING', sessionId: 'session-1', providerId: 'gemini' } })
        }
        if (action === 'STOP_LIVE_DUBBING') {
          return Promise.reject(new Error('Background transport failed'))
        }
        return Promise.resolve({ status: 'idle' })
      })

      const wrapper = await mountAndFlush()
      expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Running')

      await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Cleanup required')
      expect(wrapper.find('button[aria-label="Clean up live dubbing"]').exists()).toBe(true)
    })

    it('renders an inline explanation when start is unavailable', async () => {
      sendMessage.mockResolvedValue({ success: false, error: 'LIVE_DUBBING_UNSUPPORTED' })

      const wrapper = await mountAndFlush()

      const explanation = wrapper.find('.ti-live-dubbing-control-unavailable')
      expect(explanation.exists()).toBe(true)
      expect(explanation.attributes('role')).toBe('status')
      expect(explanation.text()).toBe('Live dubbing is not supported in this browser.')
      // Same text is not duplicated in the error paragraph.
      expect(wrapper.find('.ti-live-dubbing-control-error').exists()).toBe(false)
      expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()
    })

    it('prefers the unsupported explanation when the terminal outcome names it', async () => {
      sendMessage.mockResolvedValue({
        available: false,
        terminalOutcome: { providerId: 'gemini', error: 'LIVE_DUBBING_UNSUPPORTED', occurredAt: Date.now() }
      })

      const wrapper = await mountAndFlush()

      const explanation = wrapper.find('.ti-live-dubbing-control-unavailable')
      expect(explanation.exists()).toBe(true)
      expect(explanation.text()).toBe('Live dubbing is not supported in this browser.')
      // The generic error paragraph (which applyStatus populated with
      // "Live dubbing is unavailable.") must not also render here — the
      // unavailable explanation supersedes it for this cause.
      expect(wrapper.find('.ti-live-dubbing-control-error').exists()).toBe(false)
    })

    it('explains a generic terminal failure without blaming the browser', async () => {
      sendMessage.mockResolvedValue({
        available: false,
        terminalOutcome: { providerId: 'gemini', error: 'LIVE_DUBBING_STATUS_FAILED', occurredAt: Date.now() }
      })

      const wrapper = await mountAndFlush()

      expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Unavailable')
      expect(wrapper.text()).toContain('Live dubbing is unavailable.')
      expect(wrapper.text()).not.toContain('not supported in this browser')
      // The generic text renders once via the error paragraph; the
      // unavailable paragraph stays hidden instead of duplicating it.
      expect(wrapper.find('.ti-live-dubbing-control-unavailable').exists()).toBe(false)
      expect(wrapper.find('.ti-live-dubbing-control-error').text()).toBe('Live dubbing is unavailable.')
    })

    it('does not duplicate the message when errorMessage already shows the cause', async () => {
      sendMessage.mockRejectedValue(new Error('Status query failed'))

      const wrapper = await mountAndFlush()

      expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Unavailable')
      expect(wrapper.find('.ti-live-dubbing-control-error').text()).toBe('Status query failed')
      expect(wrapper.find('.ti-live-dubbing-control-unavailable').exists()).toBe(false)
      // Single occurrence across the whole control.
      expect(wrapper.text().split('Status query failed')).toHaveLength(2)
    })

    it('no longer renders the static Live dubbing label', async () => {
      const wrapper = await mountAndFlush()

      expect(wrapper.find('#live-dubbing-label').exists()).toBe(false)
      expect(wrapper.find('.ti-live-dubbing-control-label').exists()).toBe(false)
      // The live status text still conveys context.
      expect(wrapper.find('.ti-live-dubbing-control-status').exists()).toBe(true)
    })
  })

  describe('feedback text direction (RTL)', () => {
    it('renders status text with dir="auto"', async () => {
      const wrapper = await mountAndFlush()

      expect(wrapper.find('.ti-live-dubbing-control-status').attributes('dir')).toBe('auto')
    })

    it('renders unavailable explanation with dir="auto"', async () => {
      sendMessage.mockResolvedValue({ success: false, error: 'LIVE_DUBBING_UNSUPPORTED' })

      const wrapper = await mountAndFlush()

      expect(wrapper.find('.ti-live-dubbing-control-unavailable').attributes('dir')).toBe('auto')
    })

    it('renders error paragraph with dir="auto"', async () => {
      sendMessage.mockRejectedValue(new Error('Status query failed'))

      const wrapper = await mountAndFlush()

      expect(wrapper.find('.ti-live-dubbing-control-error').attributes('dir')).toBe('auto')
    })
  })

  // ── Initial status loading presentation ────────────────────────────────────
  // The presentation-only delay gates the "Checking availability…" text so
  // very fast initial reads never flash it. Lifecycle/session ownership is
  // untouched — only the rendering of the pending state is delayed.

  describe('Initial status loading presentation', () => {
    it('shows no status text while pending, then the authoritative status after a fast resolve', async () => {
      vi.useFakeTimers()
      try {
        let resolveStatus
        sendMessage.mockImplementation(({ action }) => (
          action === 'GET_LIVE_DUBBING_STATUS'
            ? new Promise(resolve => { resolveStatus = resolve })
            : Promise.resolve({ status: 'idle' })
        ))
        const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
        await flushPromises(wrapper)

        // Hidden window while pending: blank — neither "Ready" nor
        // "Checking availability…" may flash.
        const status = wrapper.find('.ti-live-dubbing-control-status')
        expect(status.text()).toBe('')
        expect(status.text()).not.toBe('Ready')
        expect(status.text()).not.toBe('Checking availability…')
        // Behavioral loading: Start stays disabled until the GET resolves,
        // regardless of whether the loading text is visible.
        expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()

        // Resolve within the 150ms window → authoritative status directly.
        resolveStatus({ status: 'idle' })
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        expect(status.text()).toBe('Ready')
        expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeUndefined()

        // Advancing past the delay must not flash the loading text afterwards.
        vi.advanceTimersByTime(500)
        await flushPromises(wrapper)
        expect(status.text()).toBe('Ready')
      } finally {
        vi.useRealTimers()
      }
    })

    it('shows blank first, then "Checking availability…" only after the delay for slow reads', async () => {
      vi.useFakeTimers()
      try {
        // GET never resolves — control stays in its initial loading state.
        sendMessage.mockImplementation(() => new Promise(() => {}))
        const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
        await flushPromises(wrapper)

        // Before the delay elapses: blank — no "Ready", no loading text.
        const status = wrapper.find('.ti-live-dubbing-control-status')
        expect(status.text()).toBe('')
        expect(status.text()).not.toBe('Ready')
        expect(status.text()).not.toBe('Checking availability…')
        expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()

        // Advance past the small presentation delay.
        vi.advanceTimersByTime(150)
        await flushPromises(wrapper)
        expect(status.text()).toBe('Checking availability…')
        // Still pending → Start still disabled.
        expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('returns to the authoritative status once the GET resolves after the loading text appears', async () => {
      vi.useFakeTimers()
      try {
        let resolveStatus
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') {
            return new Promise(resolve => { resolveStatus = resolve })
          }
          return Promise.resolve({ status: 'idle' })
        })
        const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
        await flushPromises(wrapper)

        // Still in the hidden window: blank, not "Ready".
        expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('')

        // Advance past the presentation delay so the loading text is visible.
        vi.advanceTimersByTime(200)
        await flushPromises(wrapper)
        expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Checking availability…')

        // Resolve the GET with a RUNNING session — the authoritative status
        // must replace the loading text immediately, not linger.
        resolveStatus({
          status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 }
        })
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Running')
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not flash "Checking availability…" after the GET resolves mid-delay', async () => {
      vi.useFakeTimers()
      try {
        let resolveStatus
        sendMessage.mockImplementation(({ action }) => {
          if (action === 'GET_LIVE_DUBBING_STATUS') {
            return new Promise(resolve => { resolveStatus = resolve })
          }
          return Promise.resolve({ status: 'idle' })
        })
        const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
        await flushPromises(wrapper)

        // Resolve BEFORE the presentation delay elapses.
        resolveStatus({ status: 'idle' })
        await flushPromises(wrapper)
        await flushPromises(wrapper)
        expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Ready')

        // The timer still fires, but its activation conditional must skip
        // because state has already left 'loading'.
        vi.advanceTimersByTime(500)
        await flushPromises(wrapper)
        expect(wrapper.find('.ti-live-dubbing-control-status').text()).toBe('Ready')
      } finally {
        vi.useRealTimers()
      }
    })

    it('clears the pending loading presentation timer on unmount (no stale update)', async () => {
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(() => new Promise(() => {}))

        const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
        await flushPromises(wrapper)

        // Unmount BEFORE the presentation delay elapses. The pending timer
        // must be cleared — no callback survives the unmount.
        wrapper.unmount()

        // Advancing past the delay must not throw — the timer was cleared.
        expect(() => vi.advanceTimersByTime(500)).not.toThrow()
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps status-resolved emission independent of the presentation delay', async () => {
      // The presentation delay is a UI-only gate; the lifecycle status-resolved
      // emit must still happen exactly once when the initial GET resolves.
      vi.useFakeTimers()
      try {
        sendMessage.mockImplementation(({ action }) => (
          action === 'GET_LIVE_DUBBING_STATUS'
            ? Promise.resolve({ status: 'idle' })
            : Promise.resolve({ status: 'idle' })
        ))
        const wrapper = mount(LiveDubbingControl, { props: { targetLanguage: 'de' } })
        await flushPromises(wrapper)

        // Resolved before the delay — emit fires immediately.
        expect(wrapper.emitted('status-resolved')).toEqual([[]])

        // Advancing the timer must not emit status-resolved a second time.
        vi.advanceTimersByTime(500)
        await flushPromises(wrapper)
        expect(wrapper.emitted('status-resolved')).toEqual([[]])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ── Transient local status presentation ─────────────────────────────────────
  // Local `starting`/`stopping` are valid presentation states of their own;
  // they must never fall through to the generic "Error" fallback, while the
  // authoritative backend stages keep replacing them as they arrive.

  describe('transient local status presentation', () => {
    const statusLine = (wrapper) => wrapper.find('.ti-live-dubbing-control-status').text()
    const wave = (wrapper) => wrapper.find('.ti-live-dubbing-wave')
    const runningDescriptor = { status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 } }

    it('shows "Starting…" immediately while START is pending and never "Error"', async () => {
      let resolveStart
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
        if (action === 'START_LIVE_DUBBING') return new Promise(resolve => { resolveStart = resolve })
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(statusLine(wrapper)).toBe('Ready')

      await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
      await flushPromises(wrapper)

      // Local pending START presents as "Starting…" — never the Error fallback.
      expect(statusLine(wrapper)).toBe('Starting…')
      expect(statusLine(wrapper)).not.toBe('Error')
      expect(wave(wrapper).classes()).toContain('ti-live-dubbing-wave--calm')
      expect(wave(wrapper).attributes('aria-hidden')).toBe('true')
      expect(wrapper.find('.ti-live-dubbing-control-spinner').exists()).toBe(false)
      expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('button[aria-label="Start live dubbing"] .ti-base-loading-spinner').exists()).toBe(false)
      expect(wrapper.find('button[aria-label="Start live dubbing"]').classes()).not.toContain('ti-btn--loading')

      // Resolving START swaps in the authoritative status directly.
      resolveStart(runningDescriptor)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusLine(wrapper)).toBe('Running')
    })

    it('shows "Starting…" after retrying from Error until START resolves', async () => {
      let resolveStart
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'ERROR' })
        if (action === 'START_LIVE_DUBBING') return new Promise(resolve => { resolveStart = resolve })
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(statusLine(wrapper)).toBe('Error')

      await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      expect(statusLine(wrapper)).toBe('Starting…')
      expect(statusLine(wrapper)).not.toBe('Error')

      resolveStart(runningDescriptor)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusLine(wrapper)).toBe('Running')
    })

    it('shows "Stopping…" while STOP is pending instead of the stale RUNNING status', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          return Promise.resolve({ status: { status: 'RUNNING', sessionId: 's1', providerId: 'gemini', eventSequence: 1 } })
        }
        if (action === 'STOP_LIVE_DUBBING') return new Promise(() => {})
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)
      expect(statusLine(wrapper)).toBe('Running')

      await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
      await flushPromises(wrapper)

      // Local pending STOP presents as "Stopping…", never "Error".
      expect(statusLine(wrapper)).toBe('Stopping…')
      expect(statusLine(wrapper)).not.toBe('Error')
      expect(wave(wrapper).classes()).toContain('ti-live-dubbing-wave--slow')
      expect(wave(wrapper).attributes('aria-hidden')).toBe('true')
      expect(wrapper.find('.ti-live-dubbing-control-spinner').exists()).toBe(false)
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').attributes('disabled')).toBeDefined()
      expect(wrapper.find('button[aria-label="Stop live dubbing"] .ti-base-loading-spinner').exists()).toBe(false)
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').classes()).not.toContain('ti-btn--loading')
    })

    it('still shows "Error" for a real START failure', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') return Promise.resolve({ status: 'idle' })
        if (action === 'START_LIVE_DUBBING') return Promise.reject(new Error('transport down'))
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(statusLine(wrapper)).toBe('Error')
      expect(wrapper.text()).toContain('transport down')
    })

    it('marks the Ready waveform as static', async () => {
      const wrapper = await mountAndFlush()

      expect(wave(wrapper).classes()).toContain('ti-live-dubbing-wave--static')
    })

    it('marks the Running waveform as active', async () => {
      sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
        ? Promise.resolve({ status: { status: 'RUNNING', sessionId: 's1' } })
        : Promise.resolve({ status: 'idle' }))
      const wrapper = await mountAndFlush()

      expect(statusLine(wrapper)).toBe('Running')
      expect(wave(wrapper).classes()).toContain('ti-live-dubbing-wave--active')
    })

    it.each([
      ['Error', { status: 'ERROR' }],
      ['Unavailable', { available: false }],
      ['Cleanup', { status: 'ERROR', sessionId: 'retained-session' }]
    ])('marks the %s waveform as static', async (_label, response) => {
      sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
        ? Promise.resolve(response)
        : Promise.resolve({ status: 'idle' }))
      const wrapper = await mountAndFlush()

      expect(wave(wrapper).classes()).toContain('ti-live-dubbing-wave--static')
    })
  })

  // ── Transcript-delivery availability (subtitles note) ──────────────────────
  // The note renders the sanitized getStatus boolean only: notifications only
  // trigger a re-read, never render payload data directly.

  describe('transcript delivery unavailable note', () => {
    const subtitlesNote = (wrapper) => wrapper.findAll('.ti-live-dubbing-control-volume-error')
      .find((paragraph) => paragraph.text().includes('Subtitles unavailable on this tab.'))
    const runningWithFlag = (extra = {}) => ({
      status: { status: 'RUNNING', sessionId: 'session-1', providerId: 'gemini' },
      transcriptDeliveryUnavailable: true,
      ...extra
    })

    it('renders the note while running without affecting START/STOP', async () => {
      sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
        ? Promise.resolve(runningWithFlag())
        : Promise.resolve({ status: 'idle' }))
      const wrapper = await mountAndFlush()

      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')
      const note = subtitlesNote(wrapper)
      expect(note.exists()).toBe(true)
      expect(note.attributes('role')).toBe('status')
      expect(note.attributes('role')).not.toBe('alert')
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.find('button[aria-label="Start live dubbing"]').exists()).toBe(false)
    })

    it('renders the note while starting with an active session', async () => {
      sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
        ? Promise.resolve({
            status: { status: 'PREPARING_CAPTURE', sessionId: 'session-1', providerId: 'gemini' },
            transcriptDeliveryUnavailable: true
          })
        : Promise.resolve({ status: 'idle' }))
      const wrapper = await mountAndFlush()

      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')
    })

    it('resolves the note text through i18n', async () => {
      mockI18nMap.live_dubbing_subtitles_unavailable = 'Untertitel auf diesem Tab nicht verfügbar.'
      sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
        ? Promise.resolve(runningWithFlag())
        : Promise.resolve({ status: 'idle' }))
      const wrapper = await mountAndFlush()

      expect(wrapper.text()).toContain('Untertitel auf diesem Tab nicht verfügbar.')
    })

    it('renders no note when the flag is absent or false', async () => {
      for (const response of [
        { status: { status: 'RUNNING', sessionId: 'session-1', providerId: 'gemini' } },
        { status: { status: 'RUNNING', sessionId: 'session-1', providerId: 'gemini' }, transcriptDeliveryUnavailable: false }
      ]) {
        sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
          ? Promise.resolve(response)
          : Promise.resolve({ status: 'idle' }))
        const wrapper = await mountAndFlush()

        expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')
        expect(subtitlesNote(wrapper)).toBeUndefined()
        wrapper.unmount()
      }
    })

    it('renders no note for a stale flag with no active session', async () => {
      sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
        ? Promise.resolve({ status: 'idle', transcriptDeliveryUnavailable: true })
        : Promise.resolve({ status: 'idle' }))
      const wrapper = await mountAndFlush()

      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)).toBeUndefined()
      expect(wrapper.find('button[aria-label="Start live dubbing"]').exists()).toBe(true)
      expect(wrapper.find('button[aria-label="Start live dubbing"]').attributes('disabled')).toBeUndefined()
    })

    it('never renders raw error text in the note', async () => {
      sendMessage.mockImplementation(({ action }) => action === 'GET_LIVE_DUBBING_STATUS'
        ? Promise.resolve(runningWithFlag({ status: { status: 'RUNNING', sessionId: 'session-1', providerId: 'gemini', lastError: 'RAW_CAPTURE_BOOM' } }))
        : Promise.resolve({ status: 'idle' }))
      const wrapper = await mountAndFlush()

      const note = subtitlesNote(wrapper)
      expect(note.exists()).toBe(true)
      expect(note.text()).toBe('Subtitles unavailable on this tab.')
      expect(note.text()).not.toContain('RAW_CAPTURE_BOOM')
    })

    it('re-reads status on an authenticated transcript-delivery notification', async () => {
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          return Promise.resolve({ status: 'idle' })
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(statusReads).toBe(1)

      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-1' } }, {
        id: 'extension-id', url: 'chrome-extension://extension-id/'
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(statusReads).toBe(2)
      // Notification payloads never render directly.
      expect(wrapper.text()).not.toContain('session-1')

      // Untrusted senders are still ignored.
      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: {} }, { id: 'other-id' })
      await flushPromises(wrapper)

      expect(statusReads).toBe(2)
    })
  })

  describe('transcript delivery notification racing lifecycle operations', () => {
    const authorizedSender = { id: 'extension-id', url: 'chrome-extension://extension-id/' }
    const subtitlesNote = (wrapper) => wrapper.findAll('.ti-live-dubbing-control-volume-error')
      .find((paragraph) => paragraph.text().includes('Subtitles unavailable on this tab.'))

    it('does not invalidate a pending START when a delivery notification arrives', async () => {
      let resolveStart
      const startGate = new Promise((resolve) => { resolveStart = resolve })
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          if (statusReads === 1) return Promise.resolve({ status: 'idle' })
          return Promise.resolve({
            status: { status: 'CONNECTING_PROVIDER', sessionId: 'session-A', providerId: 'gemini' },
            transcriptDeliveryUnavailable: true,
          })
        }
        if (action === 'START_LIVE_DUBBING') return startGate
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(statusReads).toBe(1)

      await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      expect(wrapper.text()).toContain('Starting')

      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-A' } }, authorizedSender)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusReads).toBe(2)

      resolveStart({ success: true, status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' } })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.text()).toContain('Running')
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').attributes('disabled')).toBeUndefined()
      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)?.exists()).toBe(true)
    })

    it('ignores a late delivery refresh for a superseded session', async () => {
      let resolveRefreshA
      const refreshGateA = new Promise((resolve) => { resolveRefreshA = resolve })
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          if (statusReads === 1) {
            return Promise.resolve({
              status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
              transcriptDeliveryUnavailable: false,
            })
          }
          if (statusReads === 2) return refreshGateA
          return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 'session-B', providerId: 'gemini' },
            transcriptDeliveryUnavailable: false,
          })
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')

      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-A' } }, authorizedSender)
      await flushPromises(wrapper)

      // A newer lifecycle generation supersedes to session B.
      runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, authorizedSender)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusReads).toBe(3)

      resolveRefreshA({
        status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
        transcriptDeliveryUnavailable: true,
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)).toBeUndefined()
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
    })
    it('ignores a stale overlapping refresh for the same session', async () => {
      let resolveRefresh1
      const refreshGate1 = new Promise((resolve) => { resolveRefresh1 = resolve })
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          if (statusReads === 1) {
            return Promise.resolve({
              status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
              transcriptDeliveryUnavailable: false,
            })
          }
          if (statusReads === 2) return refreshGate1
          return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
            transcriptDeliveryUnavailable: false,
          })
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')

      // Refresh #1 starts and stays pending.
      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-A' } }, authorizedSender)
      await flushPromises(wrapper)
      // Refresh #2 starts and resolves available.
      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-A' } }, authorizedSender)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusReads).toBe(3)

      // Refresh #1 resolves late with stale unavailable state: ignored.
      resolveRefresh1({
        status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
        transcriptDeliveryUnavailable: true,
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.text()).toContain('Running')
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)).toBeUndefined()
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
    })

    it('does not leak a subtitle note across STOP into a new session', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
            transcriptDeliveryUnavailable: true,
          })
        }
        if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
        if (action === 'START_LIVE_DUBBING') {
          return Promise.resolve({
            success: true,
            status: { status: 'RUNNING', sessionId: 'session-B', providerId: 'gemini' },
          })
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')

      await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(wrapper.find('button[aria-label="Start live dubbing"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')

      await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.text()).toContain('Running')
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)).toBeUndefined()
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
    })

    it('ignores a session-A refresh that resolves after STOP cleared the session', async () => {
      let resolveRefreshA
      const refreshGateA = new Promise((resolve) => { resolveRefreshA = resolve })
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          if (statusReads === 1) {
            return Promise.resolve({
              status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
              transcriptDeliveryUnavailable: false,
            })
          }
          return refreshGateA
        }
        if (action === 'STOP_LIVE_DUBBING') return Promise.resolve({ status: 'idle' })
        if (action === 'START_LIVE_DUBBING') {
          return Promise.resolve({
            success: true,
            status: { status: 'RUNNING', sessionId: 'session-B', providerId: 'gemini' },
          })
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()

      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-A' } }, authorizedSender)
      await flushPromises(wrapper)

      await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(wrapper.find('button[aria-label="Start live dubbing"]').exists()).toBe(true)

      resolveRefreshA({
        status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
        transcriptDeliveryUnavailable: true,
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.text()).toContain('Running')
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)).toBeUndefined()
    })

    it('preserves the retained session when STOP fails with cleanup pending', async () => {
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
            transcriptDeliveryUnavailable: true,
          })
        }
        if (action === 'STOP_LIVE_DUBBING') return Promise.reject(new Error('stop transport boom'))
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')

      await wrapper.find('button[aria-label="Stop live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // Retained session: cleanup required, Start held disabled, no idle reset.
      expect(wrapper.text()).toContain('Cleanup required')
      expect(wrapper.text()).not.toContain('Running')
      const startButton = wrapper.find('button[aria-label="Start live dubbing"]')
      expect(startButton.exists()).toBe(true)
      expect(startButton.attributes('disabled')).toBeDefined()
    })

    it('keeps lifecycle invalidation for terminal notifications', async () => {
      let resolveStart
      const startGate = new Promise((resolve) => { resolveStart = resolve })
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          return Promise.resolve({ status: 'idle' })
        }
        if (action === 'START_LIVE_DUBBING') return startGate
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()

      await wrapper.find('button[aria-label="Start live dubbing"]').trigger('click')
      await flushPromises(wrapper)
      expect(wrapper.text()).toContain('Starting')

      runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, authorizedSender)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusReads).toBe(2)

      resolveStart({ success: true, status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' } })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // The START response was invalidated by the terminal refresh.
      expect(wrapper.text()).not.toContain('Running')
      expect(wrapper.find('button[aria-label="Start live dubbing"]').exists()).toBe(true)
    })

    it('keeps a newer refresh warning when an older lifecycle read resolves', async () => {
      let resolveOldGet
      const oldGetGate = new Promise((resolve) => { resolveOldGet = resolve })
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          if (statusReads === 1) {
            return Promise.resolve({
              status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
              transcriptDeliveryUnavailable: false,
            })
          }
          if (statusReads === 2) return oldGetGate
          return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
            transcriptDeliveryUnavailable: true,
          })
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')

      // An older lifecycle read starts (terminal notification invalidates the view).
      runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, authorizedSender)
      await flushPromises(wrapper)
      expect(statusReads).toBe(2)

      // A delivery notification refresh resolves unavailable while it is pending.
      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-A' } }, authorizedSender)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusReads).toBe(3)
      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')

      // The older lifecycle read resolves with a stale available flag.
      resolveOldGet({
        status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
        transcriptDeliveryUnavailable: false,
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // Lifecycle portion still applies; the stale flag must not hide the warning.
      expect(wrapper.text()).toContain('Running')
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)?.exists()).toBe(true)
    })

    it('keeps a newer refresh warning when volume recovery resolves older state', async () => {
      let resolveRecoveryStatus
      const recoveryGate = new Promise((resolve) => { resolveRecoveryStatus = resolve })
      let statusReads = 0
      let volumeReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          if (statusReads === 1) {
            return Promise.resolve({
              status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini', eventSequence: 1 },
              transcriptDeliveryUnavailable: false,
            })
          }
          if (statusReads === 2) return recoveryGate
          return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini', eventSequence: 1 },
            transcriptDeliveryUnavailable: true,
          })
        }
        if (action === 'GET_LIVE_DUBBING_ORIGINAL_VOLUME') {
          volumeReads += 1
          if (volumeReads === 1) {
            return Promise.resolve({ success: false, error: 'LIVE_DUBBING_SESSION_MISMATCH' })
          }
          return Promise.resolve({ success: true, originalVolume: 0.5 })
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      // The initial volume mismatch entered recovery with a pending status read.
      expect(statusReads).toBe(2)
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')

      // A delivery notification refresh resolves unavailable while recovery pends.
      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-A' } }, authorizedSender)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusReads).toBe(3)
      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')

      // The older recovery read resolves with a stale available flag.
      resolveRecoveryStatus({
        status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini', eventSequence: 1 },
        transcriptDeliveryUnavailable: false,
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // The stale flag must not hide the warning; volume recovery still completes.
      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)?.exists()).toBe(true)
      expect(wrapper.find('.ti-live-dubbing-control-volume-value').text()).toBe('50%')
    })

    it('adopts a newer B refresh when lifecycle adopts B with a stale flag', async () => {
      let resolveLifecycleB
      const lifecycleGateB = new Promise((resolve) => { resolveLifecycleB = resolve })
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          if (statusReads === 1) {
            return Promise.resolve({
              status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
              transcriptDeliveryUnavailable: false,
            })
          }
          if (statusReads === 2) return lifecycleGateB
          return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 'session-B', providerId: 'gemini' },
            transcriptDeliveryUnavailable: true,
          })
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')

      // A lifecycle read for the new session B starts before it is adopted.
      runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, authorizedSender)
      await flushPromises(wrapper)
      expect(statusReads).toBe(2)

      // A delivery notification for B refreshes and records B unavailable
      // while popup lifecycle still displays A: recorded, not yet rendered.
      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-B' } }, authorizedSender)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusReads).toBe(3)
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')

      // The older lifecycle read adopts B with a stale available flag.
      resolveLifecycleB({
        status: { status: 'RUNNING', sessionId: 'session-B', providerId: 'gemini' },
        transcriptDeliveryUnavailable: false,
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      // Lifecycle adopts B; the newer presentation value recorded for B wins.
      expect(wrapper.text()).toContain('Running')
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)?.exists()).toBe(true)
    })

    it('does not leak session A subtitle state into an adopted session B', async () => {
      let resolveLifecycleB
      const lifecycleGateB = new Promise((resolve) => { resolveLifecycleB = resolve })
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          if (statusReads === 1) {
            return Promise.resolve({
              status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
              transcriptDeliveryUnavailable: true,
            })
          }
          if (statusReads === 2) return lifecycleGateB
          // Authoritative reads still see A: the B notification has no fresh state.
          return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
            transcriptDeliveryUnavailable: true,
          })
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')

      // A lifecycle read adopting B starts.
      runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, authorizedSender)
      await flushPromises(wrapper)
      expect(statusReads).toBe(2)

      // A B notification bumps the presentation generation, but its refresh
      // finds no B state authoritatively — A's record is kept, B gains none.
      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-B' } }, authorizedSender)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusReads).toBe(3)
      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')

      // The fenced lifecycle read adopts B; A's value must not leak into B.
      resolveLifecycleB({
        status: { status: 'RUNNING', sessionId: 'session-B', providerId: 'gemini' },
        transcriptDeliveryUnavailable: false,
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.text()).toContain('Running')
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)).toBeUndefined()
    })

    it('lets a pending B refresh apply after lifecycle adopts B', async () => {
      let resolveLifecycleB
      const lifecycleGateB = new Promise((resolve) => { resolveLifecycleB = resolve })
      let resolveRefreshB
      const refreshGateB = new Promise((resolve) => { resolveRefreshB = resolve })
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          if (statusReads === 1) {
            return Promise.resolve({
              status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
              transcriptDeliveryUnavailable: false,
            })
          }
          if (statusReads === 2) return lifecycleGateB
          return refreshGateB
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')

      // A lifecycle read for B starts while UI owns A.
      runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, authorizedSender)
      await flushPromises(wrapper)
      expect(statusReads).toBe(2)

      // A B notification starts refresh B, still pending.
      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-B' } }, authorizedSender)
      await flushPromises(wrapper)
      expect(statusReads).toBe(3)

      // The lifecycle read resolves first with a stale available flag:
      // lifecycle adopts B while subtitles stay fenced.
      resolveLifecycleB({
        status: { status: 'RUNNING', sessionId: 'session-B', providerId: 'gemini' },
        transcriptDeliveryUnavailable: false,
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(wrapper.text()).toContain('Running')
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')

      // Refresh B resolves late with unavailable: no longer discarded.
      resolveRefreshB({
        status: { status: 'RUNNING', sessionId: 'session-B', providerId: 'gemini' },
        transcriptDeliveryUnavailable: true,
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.text()).toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)?.exists()).toBe(true)
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
    })

    it('rejects a pending A refresh after lifecycle adopts B', async () => {
      let resolveRefreshA
      const refreshGateA = new Promise((resolve) => { resolveRefreshA = resolve })
      let statusReads = 0
      sendMessage.mockImplementation(({ action }) => {
        if (action === 'GET_LIVE_DUBBING_STATUS') {
          statusReads += 1
          if (statusReads === 1) {
            return Promise.resolve({
              status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
              transcriptDeliveryUnavailable: false,
            })
          }
          if (statusReads === 2) return refreshGateA
          return Promise.resolve({
            status: { status: 'RUNNING', sessionId: 'session-B', providerId: 'gemini' },
            transcriptDeliveryUnavailable: false,
          })
        }
        return Promise.resolve({ status: 'idle' })
      })
      const wrapper = await mountAndFlush()
      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')

      // Refresh A starts while UI owns A and stays pending.
      runtimeListener({ action: 'LIVE_DUBBING_TRANSCRIPT_DELIVERY_CHANGED', data: { sessionId: 'session-A' } }, authorizedSender)
      await flushPromises(wrapper)
      expect(statusReads).toBe(2)

      // Lifecycle adopts B.
      runtimeListener({ action: 'LIVE_DUBBING_TERMINAL_OUTCOME', data: {} }, authorizedSender)
      await flushPromises(wrapper)
      await flushPromises(wrapper)
      expect(statusReads).toBe(3)
      expect(wrapper.text()).toContain('Running')

      // The stale A refresh resolves late claiming unavailable: rejected.
      resolveRefreshA({
        status: { status: 'RUNNING', sessionId: 'session-A', providerId: 'gemini' },
        transcriptDeliveryUnavailable: true,
      })
      await flushPromises(wrapper)
      await flushPromises(wrapper)

      expect(wrapper.text()).not.toContain('Subtitles unavailable on this tab.')
      expect(subtitlesNote(wrapper)).toBeUndefined()
      expect(wrapper.vm.subtitlesUnavailable).toBe(false)
      expect(wrapper.vm.subtitlesUnavailableSessionId).toBe('session-B')
      expect(wrapper.find('button[aria-label="Stop live dubbing"]').exists()).toBe(true)
    })
  })
})
