import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { readFileSync } from 'node:fs'
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js'
import { ProviderRegistryIds } from '@/features/translation/providers/ProviderConstants.js'
import MaskIcon from '@/components/shared/MaskIcon.vue'

const settingsStore = vi.hoisted(() => ({
  settings: null,
  isDarkTheme: false,
  updateSettingAndPersist: vi.fn(),
  setProviderCategoryCollapsed: vi.fn(),
}))
settingsStore.settings = reactive({ TRANSLATION_API: 'googlev2', DEBUG_MODE: false, HIDDEN_PROVIDERS: [] })
// Storage-lane contract: action receives (categoryId, collapsed) and does NOT
// update state synchronously; the authoritative { ids, revision } entry lands
// reactively with the promise result. `behavior` may replace the default
// (deferred control) in specific tests.
const makeCollapseStore = (behavior) => {
  settingsStore.setProviderCategoryCollapsed.mockReset()
  settingsStore.setProviderCategoryCollapsed.mockImplementation(async (categoryId, collapsed) => {
    if (behavior) return behavior(categoryId, collapsed)
    const current = settingsStore.settings.COLLAPSED_PROVIDER_CATEGORIES
    const ids = Array.isArray(current)
      ? [...current]
      : (current && Array.isArray(current.ids) ? [...current.ids] : [])
    const nextIds = ids.filter((id) => id !== categoryId)
    if (collapsed) nextIds.push(categoryId)
    settingsStore.settings.COLLAPSED_PROVIDER_CATEGORIES = { ids: nextIds, revision: (current?.revision || 0) + 1 }
  })
}
makeCollapseStore()
const translationStore = vi.hoisted(() => ({ ephemeralSync: null, selectedProvider: null }))
translationStore.ephemeralSync = reactive({ page: false, element: false })
const registry = vi.hoisted(() => ({
  providers: [
    { id: 'googlev2', name: 'Google', icon: 'providers/google.svg', category: 'FREE', supported: true, features: ['translation', 'bulk'] },
  ],
}))
const openOptionsPage = vi.hoisted(() => vi.fn())
const extensionContext = vi.hoisted(() => ({ isContentScript: false }))
const trackedListeners = vi.hoisted(() => [])
const deactivateSelectMode = vi.hoisted(() => vi.fn())
const selectMode = vi.hoisted(() => ({ active: false }))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => settingsStore,
}))

vi.mock('@/features/translation/stores/translation.js', () => ({
  useTranslationStore: () => translationStore,
}))

vi.mock('@/core/helpers.js', () => ({ openOptionsPage }))

const errorHandler = vi.hoisted(() => ({ handleError: vi.fn() }))
vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: () => errorHandler,
}))

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({
    t: (key, values = {}) => {
      const labels = {
        popup_translate_button_text: 'Translate',
        popup_stop_button_title: 'Stop',
        provider_default: 'Default',
        sync_page_label: 'Page Translate',
        sync_element_label: 'Select Element',
        sync_page_selected_tooltip: 'Page translation follows the provider selected here',
        sync_page_own_tooltip: 'Page translation uses its configured provider, or falls back to the current or default provider.',
        sync_element_selected_tooltip: 'Select Element translation follows the provider selected here',
        sync_element_own_tooltip: 'Select Element translation uses its configured provider, or falls back to the current or default provider.',
        provider_does_not_support_bulk: 'This provider does not support Page Translate and Select Element translation.',
        provider_category_free: 'Traditional',
        provider_category_ai: 'AI',
        provider_category_local: 'Other',
        provider_category_custom: 'Custom List',
        configure_providers: 'Configure Providers',
        custom_provider_list_add_placeholder: 'Add a provider…',
      }
      if (labels[key]) return labels[key]
      if (/(traditional|free)/i.test(key) && /(category|group|provider)/i.test(key)) return 'Traditional'
      if (/local/i.test(key) && /(category|group|provider)/i.test(key)) return 'Other'
      if (/\bai\b|_ai|ai_/i.test(key) && /(category|group|provider)/i.test(key)) return 'AI'
      if (/configure.*provider|provider.*configure/i.test(key)) return 'Configure Providers'
      if (/page/i.test(key) && /sync/i.test(key)) return `Page Translate: ${values.providerName || values.provider || values.service || key}`
      if (/element/i.test(key) && /sync/i.test(key)) return `Select Element: ${values.providerName || values.provider || values.service || key}`
      return key
    },
  }),
}))

vi.mock('@/features/translation/composables/useTranslationModes.js', () => ({
  useSelectElementTranslation: () => ({
    isSelectModeActive: ref(selectMode.active),
    deactivateSelectMode,
  }),
}))

vi.mock('@/core/provider-registry.js', () => ({
  getProvidersForDropdown: (debugMode) => registry.providers.filter((provider) => provider.supported !== false && (provider.id !== 'mock' || debugMode)),
  getProviderById: (id) => registry.providers.find((provider) => provider.id === id),
}))

vi.mock('@/features/translation/utils/providerValidator.js', () => ({
  isProviderConfigured: (id) => id !== 'unconfigured',
}))

vi.mock('./IconButton.vue', () => ({
  default: { template: '<span class="mock-icon-button" />' },
}))

vi.mock('webextension-polyfill', () => ({ default: {} }))

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    safeGetURL: (path) => path,
    isContextError: () => false,
    isContentScript: () => extensionContext.isContentScript,
    GENERIC_FALLBACK_ICON: 'fallback.svg',
  },
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('@/composables/core/useResourceTracker.js', async () => {
  const { onUnmounted } = await import('vue')
  return {
    useResourceTracker: () => {
      const ownedListeners = []
      onUnmounted(() => {
        ownedListeners.forEach(({ target, event, listener, options }) => {
          target.removeEventListener(event, listener, options)
          const index = trackedListeners.findIndex((entry) => entry.listener === listener)
          if (index !== -1) trackedListeners.splice(index, 1)
        })
      })
      return {
        addEventListener: (target, event, listener, options) => {
          if (typeof event === 'string' && typeof listener === 'function') {
            target.addEventListener(event, listener, options)
            const entry = { target, event, listener, options }
            ownedListeners.push(entry)
            trackedListeners.push(entry)
          }
        },
      }
    },
  }
})

import ProviderSelector from './ProviderSelector.vue'

const providerSelectorScss = readFileSync('src/components/shared/ProviderSelector.scss', 'utf8')

afterEach(() => {
  trackedListeners.splice(0).forEach(({ target, event, listener, options }) => {
    target.removeEventListener(event, listener, options)
  })
})

describe('ProviderSelector split mode', () => {
  beforeEach(() => {
    settingsStore.updateSettingAndPersist.mockReset()
  })

  it('keeps accessible Translate and Stop labels while reserving localized label width', async () => {
    const wrapper = mount(ProviderSelector, {
      props: { mode: 'split', modelValue: 'googlev2' },
      global: { stubs: { Teleport: true } },
    })

    const mainAction = wrapper.find('.ti-translate-main-area')
    const labels = wrapper.find('.ti-translate-main-labels')
    expect(mainAction.attributes('aria-label')).toBe('Translate')
    expect(wrapper.find('.ti-translate-main-label').text()).toBe('Translate')
    expect(labels.findAll('.ti-translate-main-label-reserve')).toHaveLength(2)
    expect(labels.findAll('.ti-translate-main-label-reserve').map((label) => label.text())).toEqual(['Translate', 'Stop'])
    expect(labels.findAll('.ti-translate-main-label-reserve').every((label) => label.attributes('aria-hidden') === 'true')).toBe(true)

    await mainAction.trigger('click')
    expect(wrapper.emitted('translate')).toEqual([[{ provider: 'googlev2' }]])

    await wrapper.setProps({ loading: true })
    expect(mainAction.attributes('aria-label')).toBe('Stop')
    expect(wrapper.find('.ti-translate-main-label').text()).toBe('Stop')
    const stopIcon = wrapper.findComponent(MaskIcon)
    expect(stopIcon.classes()).toContain('ti-stop-icon')
    expect(stopIcon.props('src')).toMatch(/^data:image\/svg\+xml/)
    expect(stopIcon.attributes('aria-hidden')).toBe('true')

    await mainAction.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('exposes compact-label presentation without changing split actions', () => {
    const wrapper = mount(ProviderSelector, {
      props: { mode: 'split', modelValue: 'googlev2', presentation: 'compact-label' },
      global: { stubs: { Teleport: true } },
    })

    expect(wrapper.find('.ti-split-translate-button-container').classes()).toContain('ti-split-translate-button-container--compact-label')
    expect(wrapper.find('.ti-translate-main-label').text()).toBe('Translate')
    expect(wrapper.find('.ti-provider-dropdown-area').exists()).toBe(true)
  })

  it('keeps provider dropdown trigger available in split mode', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    let wrapper
    try {
      wrapper = mount(ProviderSelector, {
        props: { mode: 'split', modelValue: 'googlev2' },
        global: { stubs: { Teleport: true } },
        attachTo: container,
      })

      const rootEl = wrapper.find('.ti-split-translate-button-container').element
      vi.spyOn(rootEl, 'getBoundingClientRect').mockReturnValue({
        top: 10, left: 10, right: 300, bottom: 50,
        width: 290, height: 40, x: 10, y: 10
      })

      await wrapper.find('.ti-provider-dropdown-area').trigger('click')
      expect(wrapper.find('.ti-provider-dropdown-menu').exists()).toBe(true)
    } finally {
      wrapper?.unmount()
      container.remove()
    }
  })

  it('auto-triggers translate after provider selection by default', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    let wrapper
    try {
      wrapper = mount(ProviderSelector, {
        props: { mode: 'split', modelValue: 'googlev2' },
        global: { stubs: { Teleport: true } },
        attachTo: container,
      })

      const rootEl = wrapper.find('.ti-split-translate-button-container').element
      vi.spyOn(rootEl, 'getBoundingClientRect').mockReturnValue({
        top: 10, left: 10, right: 300, bottom: 50,
        width: 290, height: 40, x: 10, y: 10
      })

      await wrapper.find('.ti-provider-dropdown-area').trigger('click')
      await wrapper.find('.ti-dropdown-item-btn').trigger('click')

      expect(wrapper.emitted('provider-change')).toEqual([['googlev2']])
      expect(wrapper.emitted('update:modelValue')).toEqual([['googlev2']])
      expect(wrapper.emitted('translate')).toEqual([[{ provider: 'googlev2' }]])
    } finally {
      wrapper?.unmount()
      container.remove()
    }
  })

  it('skips the automatic translate emit when translateOnProviderChange is false', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    let wrapper
    try {
      wrapper = mount(ProviderSelector, {
        props: { mode: 'split', modelValue: 'googlev2', translateOnProviderChange: false },
        global: { stubs: { Teleport: true } },
        attachTo: container,
      })

      const rootEl = wrapper.find('.ti-split-translate-button-container').element
      vi.spyOn(rootEl, 'getBoundingClientRect').mockReturnValue({
        top: 10, left: 10, right: 300, bottom: 50,
        width: 290, height: 40, x: 10, y: 10
      })

      await wrapper.find('.ti-provider-dropdown-area').trigger('click')
      await wrapper.find('.ti-dropdown-item').trigger('click')

      expect(wrapper.emitted('provider-change')).toEqual([['googlev2']])
      expect(wrapper.emitted('update:modelValue')).toEqual([['googlev2']])
      expect(wrapper.emitted('translate')).toBeUndefined()
    } finally {
      wrapper?.unmount()
      container.remove()
    }
  })
})

const providers = [
  { id: 'googlev2', name: 'Google', category: 'free', features: ['translation', 'bulk'] },
  { id: 'deepl', name: 'DeepL', category: 'free', needsApiKey: true, consumesTokens: true },
  { id: 'unconfigured', name: 'Unconfigured', category: 'free' },
  { id: 'openai', name: 'OpenAI', category: 'ai' },
  { id: 'gemini', name: 'Gemini', category: 'ai' },
  { id: 'browser', name: 'Browser', category: 'local' },
].map((provider) => ({
  icon: `providers/${provider.id}.svg`, supported: true, features: ['translation'], ...provider,
}))

const attachSelector = async (props = {}, {
  realTeleport = false, shadow = false, popupAncestor = false, selectorClass, containerClass, rect, containerRect, parent,
} = {}) => {
  const container = document.createElement('div')
  if (popupAncestor) container.classList.add('translation-view')
  if (containerClass) container.classList.add(containerClass)
  ;(parent || document.body).appendChild(container)
  let mountPoint = container
  let shadowRoot
  if (shadow) {
    const host = document.createElement('div')
    shadowRoot = host.attachShadow({ mode: 'open' })
    const overlay = document.createElement('div')
    overlay.className = 'ti-host-container'
    const shadowMount = document.createElement('div')
    overlay.appendChild(shadowMount)
    shadowRoot.appendChild(overlay)
    container.appendChild(host)
    mountPoint = shadowMount
    extensionContext.isContentScript = true
  }
  const global = realTeleport || shadow ? {} : { stubs: { Teleport: true } }
  const wrapper = mount(ProviderSelector, {
    props,
    attrs: selectorClass ? { class: selectorClass } : undefined,
    attachTo: mountPoint,
    global,
  })
  const anchor = wrapper.element.querySelector('.ti-split-translate-button-container, .ti-provider-button-container, .ti-provider-icon-only-container, .ti-provider-mobile-container')
  if (anchor) {
    const anchorRect = {
      top: 10, left: 100, right: 300, bottom: 50, width: 200, height: 40, x: 100, y: 10,
      ...rect,
    }
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => ({ ...anchorRect }))
    const trigger = wrapper.element.querySelector('.ti-provider-dropdown-area, .ti-provider-button, .ti-provider-icon-button, .ti-provider-mobile-button')
    if (trigger) vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => ({ ...anchorRect }))
    if (containerClass) {
      const scrollContainerRect = {
        top: 0, left: 0, right: 600, bottom: 600, width: 600, height: 600,
        ...containerRect,
      }
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ ...scrollContainerRect })
      return { wrapper, container, shadowRoot, setRect: (next) => Object.assign(anchorRect, next) }
    }
    return { wrapper, container, shadowRoot, setRect: (next) => Object.assign(anchorRect, next) }
  }
  return { wrapper, container, shadowRoot }
}

const enterOptionsPage = () => {
  const previousUrl = window.location.href
  window.history.replaceState({}, '', `${window.location.origin}/options.html`)
  return () => window.history.replaceState({}, '', previousUrl)
}

const enterOtherPage = () => {
  const previousUrl = window.location.href
  window.history.replaceState({}, '', `${window.location.origin}/popup.html`)
  return () => window.history.replaceState({}, '', previousUrl)
}

const stubAnimationFrames = () => {  const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  const cancelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame')
  const frames = new Map()
  const cancelled = []
  let nextId = 1

  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback) => {
      const id = nextId++
      frames.set(id, callback)
      return id
    },
  })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (id) => {
      cancelled.push(id)
      frames.delete(id)
    },
  })

  return {
    frames,
    cancelled,
    flush(id = frames.keys().next().value) {
      const callback = frames.get(id)
      frames.delete(id)
      callback?.(0)
    },
    restore() {
      if (requestDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', requestDescriptor)
      else delete globalThis.requestAnimationFrame
      if (cancelDescriptor) Object.defineProperty(globalThis, 'cancelAnimationFrame', cancelDescriptor)
      else delete globalThis.cancelAnimationFrame
    },
  }
}

/**
 * Drawer-dialog fixture mirroring the host structure the second designer
 * owns: dialog element (role=dialog subtree carrying the teleport target id)
 * → scrollable drawer body → mount container. Modeled with plain divs so
 * jsdom stays deterministic.
 */
const attachDialogSelector = async (props = {}, { rect, dialogRect, drawerRect } = {}) => {
  const dialog = document.createElement('div')
  dialog.id = 'CUSTOM_PROVIDER_LIST_DRAWER'
  const drawerBody = document.createElement('div')
  drawerBody.className = 'custom-list-drawer-body'
  dialog.appendChild(drawerBody)
  document.body.appendChild(dialog)
  const mounted = await attachSelector(
    { mode: 'button', selectionOnly: true, modelValue: '', menuTeleportTarget: '#CUSTOM_PROVIDER_LIST_DRAWER', ...props },
    { realTeleport: true, parent: drawerBody, rect },
  )
  if (dialogRect) vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ ...dialogRect })
  if (drawerRect) vi.spyOn(drawerBody, 'getBoundingClientRect').mockReturnValue({ ...drawerRect })
  return { ...mounted, dialog, drawerBody }
}

describe('ProviderSelector provider list contract', () => {
  beforeEach(() => {
    registry.providers = providers.map((provider) => ({ ...provider }))
    Object.assign(settingsStore.settings, {
      TRANSLATION_API: 'googlev2', DEBUG_MODE: false, HIDDEN_PROVIDERS: [],
      CUSTOM_PROVIDER_LIST_ENABLED: false, CUSTOM_PROVIDER_LIST: [],
      COLLAPSED_PROVIDER_CATEGORIES: [],
    })
    settingsStore.updateSettingAndPersist.mockReset()
    makeCollapseStore()
    openOptionsPage.mockReset()
    Object.assign(translationStore.ephemeralSync, { page: false, element: false })
    translationStore.selectedProvider = null
    deactivateSelectMode.mockReset()
    selectMode.active = false
    extensionContext.isContentScript = false
    errorHandler.handleError.mockReset()
  })

  it('inverts only registered dark-theme icon providers in icon-only and split modes', async () => {
    registry.providers.push(
      { id: 'openrouter', name: 'OpenRouter', category: 'ai', icon: 'providers/openrouter.svg', supported: true, features: ['translation'] },
      { id: 'requesty', name: 'Requesty', category: 'ai', icon: 'providers/requesty.svg', supported: true, features: ['translation'] },
      { id: 'cheaperinference', name: 'CheaperInference', category: 'ai', icon: 'providers/cheaperinference.svg', supported: true, features: ['translation'] },
      { id: 'webai', name: 'WebAI', category: 'ai', icon: 'providers/webai.svg', supported: true, features: ['translation'] },
    )
    const invertedIds = new Set(['deepl', 'openai', 'openrouter', 'requesty', 'cheaperinference', 'webai'])
    const providerIds = [...invertedIds, 'googlev2', 'gemini']

    for (const mode of ['icon-only', 'split']) {
      for (const id of providerIds) {
        const { wrapper, container } = await attachSelector({ mode, modelValue: id })
        try {
          const icon = wrapper.find(mode === 'icon-only'
            ? '.ti-provider-icon-only'
            : '.ti-translate-main-area .ti-api-provider-icon')
          expect(icon.exists(), `${mode} icon for ${id}`).toBe(true)
          expect(icon.classes().includes('ti-invert-dark')).toBe(invertedIds.has(id))
        } finally {
          wrapper.unmount()
          container.remove()
        }
      }
    }
  })

  it('groups six providers by registry category in Traditional, AI, Local order, preserving manifest order', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = wrapper.find('.ti-provider-dropdown-menu')
      const categoryLabels = Array.from(menu.element.querySelectorAll('*'))
        .filter((element) => !element.closest('.ti-dropdown-item') && element.children.length === 0)
        .map((element) => element.textContent.trim())
        .filter((text) => ['Traditional', 'AI', 'Other'].includes(text))
      expect(categoryLabels).toEqual(['Traditional', 'AI', 'Other'])
      expect(menu.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
      const selected = menu.findAll('.ti-dropdown-item-btn')[0]
      const sibling = menu.findAll('.ti-dropdown-item-btn')[1]
      expect(selected.attributes('aria-current')).toBe('true')
      expect(sibling.attributes('aria-current')).not.toBe('true')
      expect(selected.find('img').attributes('alt')).toBe('')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('groups Vajehyab under Other rather than Traditional using its manifest category', async () => {
    const vajehyab = findProviderById(ProviderRegistryIds.VAJEHYAB)
    registry.providers.push({
      id: vajehyab.id,
      name: vajehyab.displayName,
      icon: `providers/${vajehyab.icon}`,
      supported: vajehyab.supported,
      features: vajehyab.features,
      category: vajehyab.category,
    })

    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const groups = wrapper.findAll('.ti-dropdown-group')
      const vajehyabGroup = groups.find((group) =>
        group.find('.ti-dropdown-group-header').text().trim() === 'Other')
      const traditionalGroup = groups.find((group) =>
        group.find('.ti-dropdown-group-header').text().trim() === 'Traditional')

      expect(vajehyabGroup.findAll('.ti-dropdown-item').map((item) => item.text().trim()))
        .toContain('Vajehyab Dictionary')
      expect(traditionalGroup.findAll('.ti-dropdown-item').map((item) => item.text().trim()))
        .not.toContain('Vajehyab Dictionary')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('moves closed-selector arrows through custom-list visual order without wrapping', async () => {
    Object.assign(settingsStore.settings, {
      CUSTOM_PROVIDER_LIST_ENABLED: true,
      CUSTOM_PROVIDER_LIST: ['gemini', 'googlev2'],
    })
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'gemini' })
    try {
      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('keydown', { key: 'ArrowUp' })
      expect(wrapper.emitted('provider-change')).toBeUndefined()

      await trigger.trigger('keydown', { key: 'ArrowDown' })
      expect(wrapper.emitted('provider-change')).toEqual([['googlev2']])
      await wrapper.setProps({ modelValue: 'browser' })
      await trigger.trigger('keydown', { key: 'ArrowDown' })
      expect(wrapper.emitted('provider-change')).toHaveLength(1)
      await trigger.trigger('keydown', { key: 'ArrowUp' })
      expect(wrapper.emitted('provider-change')?.at(-1)).toEqual(['openai'])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('keeps closed arrows eligible across collapsed groups and in selection-only mode', async () => {
    Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
    const regular = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await regular.wrapper.find('.ti-provider-button').trigger('keydown', { key: 'ArrowDown' })
      expect(regular.wrapper.emitted('provider-change')).toEqual([['deepl']])
    } finally {
      regular.wrapper.unmount()
      regular.container.remove()
    }

    const selectionOnly = await attachSelector({ mode: 'button', selectionOnly: true, modelValue: 'googlev2' })
    try {
      await selectionOnly.wrapper.find('.ti-provider-button').trigger('keydown', { key: 'ArrowDown' })
      expect(selectionOnly.wrapper.emitted('provider-change')).toEqual([['deepl']])
    } finally {
      selectionOnly.wrapper.unmount()
      selectionOnly.container.remove()
    }
  })

  it('uses unique menu and category IDs for selectors in the same Vue app', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const wrapper = mount({
      components: { ProviderSelector },
      template: '<div><ProviderSelector mode="button" model-value="googlev2" /><ProviderSelector mode="button" model-value="deepl" /></div>',
    }, { attachTo: container, global: { stubs: { Teleport: true } } })
    try {
      wrapper.element.querySelectorAll('.ti-provider-button-container').forEach((anchor) => {
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
          top: 10, left: 100, right: 300, bottom: 50, width: 200, height: 40, x: 100, y: 10,
        })
      })
      const triggers = wrapper.findAll('.ti-provider-button')
      await triggers[0].trigger('click')
      const outsideClickListeners = trackedListeners.filter(({ target, event }) => target === document && event === 'click')
      outsideClickListeners.forEach(({ target, event, listener, options }) => target.removeEventListener(event, listener, options))
      try {
        await triggers[1].trigger('click')
      } finally {
        outsideClickListeners.forEach(({ target, event, listener, options }) => target.addEventListener(event, listener, options))
      }

      const menuElements = Array.from(wrapper.element.querySelectorAll('.ti-provider-dropdown-menu'))
      const menuIds = menuElements.map((menu) => menu.id)
      expect(menuIds).toHaveLength(2)
      expect(menuIds.every(Boolean)).toBe(true)
      expect(new Set(menuIds).size).toBe(2)
      expect(triggers.map((trigger) => trigger.attributes('aria-controls'))).toEqual(menuIds)

      const headerIds = menuElements.flatMap((menu) =>
        Array.from(menu.querySelectorAll('.ti-dropdown-group-header'), (header) => header.id),
      )
      expect(headerIds.length).toBeGreaterThan(0)
      expect(headerIds.every(Boolean)).toBe(true)
      expect(new Set(headerIds).size).toBe(headerIds.length)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('keeps small and single-category lists flat', async () => {
    registry.providers = providers.slice(0, 5).map((provider) => ({ ...provider }))
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      expect(wrapper.find('.ti-provider-dropdown-menu').text()).not.toContain('Traditional')
    } finally {
      wrapper.unmount()
      container.remove()
    }

    registry.providers = providers.slice(0, 6).map((provider) => ({ ...provider, category: 'free' }))
    const singleCategory = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await singleCategory.wrapper.find('.ti-provider-button').trigger('click')
      expect(singleCategory.wrapper.find('.ti-provider-dropdown-menu').text()).not.toContain('Traditional')
    } finally {
      singleCategory.wrapper.unmount()
      singleCategory.container.remove()
    }
  })

  it('preserves manifest ordering and flat grouping when the custom list is disabled', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
      expect(wrapper.find('.ti-provider-dropdown-menu').text()).not.toContain('Custom List')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('puts configured eligible providers first, then groups the remaining providers using the full-list threshold', async () => {
    Object.assign(settingsStore.settings, { CUSTOM_PROVIDER_LIST_ENABLED: true, CUSTOM_PROVIDER_LIST: ['gemini', 'googlev2', 'gemini'] })
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2', allowDefault: true })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = wrapper.find('.ti-provider-dropdown-menu')
      expect(Array.from(menu.findAll('.ti-dropdown-group-header'), header => header.text())).toEqual(['Custom List', 'Traditional', 'AI', 'Other'])
      expect(menu.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Default', 'Gemini', 'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Browser',
      ])
      expect(new Set(menu.findAll('.ti-dropdown-item-btn').map(button => button.text())).size).toBe(7)
      expect(menu.findAll('.ti-dropdown-item').map(item => item.text().trim()).filter(name => name === 'Gemini')).toHaveLength(1)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('renders each provider ID only once when the configured list contains duplicates', async () => {
    Object.assign(settingsStore.settings, { CUSTOM_PROVIDER_LIST_ENABLED: true, CUSTOM_PROVIDER_LIST: ['gemini', 'googlev2', 'gemini'] })
    const { wrapper, container } = await attachSelector({ mode: 'compact', modelValue: 'googlev2' })
    try {
      const ids = Array.from(wrapper.find('select').element.options, option => option.value)
      expect(ids).toHaveLength(6)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.slice(0, 2)).toEqual(['gemini', 'googlev2'])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('keeps a short custom group visible and applies eligibility filters before splitting', async () => {
    Object.assign(settingsStore.settings, {
      CUSTOM_PROVIDER_LIST_ENABLED: true,
      CUSTOM_PROVIDER_LIST: ['deepl', 'googlev2', 'mock', 'unconfigured', 'browser'],
      HIDDEN_PROVIDERS: ['deepl'],
    })
    registry.providers.push({ id: 'mock', name: 'Mock', category: 'local', icon: 'mock.svg', supported: true, features: ['translation'] })
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'deepl', onlyConfigured: true })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = wrapper.find('.ti-provider-dropdown-menu')
      expect(Array.from(menu.findAll('.ti-dropdown-group-header'), header => header.text())).toEqual(['Custom List'])
      expect(menu.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'DeepL', 'Google', 'Browser', 'OpenAI', 'Gemini',
      ])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('does not create an empty custom group and exposes the same order to compact options and keyboard navigation', async () => {
    Object.assign(settingsStore.settings, { CUSTOM_PROVIDER_LIST_ENABLED: true, CUSTOM_PROVIDER_LIST: ['mock', 'missing', 'default'] })
    const compact = await attachSelector({ mode: 'compact', modelValue: 'googlev2', allowDefault: true })
    try {
      expect(Array.from(compact.wrapper.find('select').element.options, option => option.value)).toEqual([
        'default', 'googlev2', 'deepl', 'unconfigured', 'openai', 'gemini', 'browser',
      ])
    } finally {
      compact.wrapper.unmount()
      compact.container.remove()
    }

    Object.assign(settingsStore.settings, { CUSTOM_PROVIDER_LIST: ['gemini', 'googlev2'] })
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Gemini', 'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Browser',
      ])
      const keyOnFocusedControl = async (key) => {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
        await wrapper.vm.$nextTick()
      }
      await keyOnFocusedControl('ArrowDown')
      await keyOnFocusedControl('Enter')
      expect(wrapper.emitted('provider-change')).toEqual([['googlev2']])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('retains category grouping when custom selection removes a category and orders active compact options', async () => {
    Object.assign(settingsStore.settings, { CUSTOM_PROVIDER_LIST_ENABLED: true, CUSTOM_PROVIDER_LIST: ['openai', 'gemini'] })
    const compact = await attachSelector({ mode: 'compact', modelValue: 'googlev2' })
    try {
      const select = compact.wrapper.find('select').element
      expect(Array.from(select.options, option => option.value)).toEqual([
        'openai', 'gemini', 'googlev2', 'deepl', 'unconfigured', 'browser',
      ])
      expect(Array.from(select.children, child => child.label)).toEqual(['Custom List', 'Traditional', 'Other'])
    } finally {
      compact.wrapper.unmount()
      compact.container.remove()
    }

    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      expect(Array.from(wrapper.findAll('.ti-dropdown-group-header'), header => header.text())).toEqual(['Custom List', 'Traditional', 'Other'])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('ignores a malformed imported provider list without breaking the menu', async () => {
    Object.assign(settingsStore.settings, { CUSTOM_PROVIDER_LIST_ENABLED: true, CUSTOM_PROVIDER_LIST: {} })
    const { wrapper, container } = await attachSelector({ mode: 'compact', modelValue: 'googlev2' })
    try {
      expect(Array.from(wrapper.find('select').element.options, option => option.value)).toEqual([
        'googlev2', 'deepl', 'unconfigured', 'openai', 'gemini', 'browser',
      ])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('keeps configured IDs while unsupported and feature-ineligible providers are absent, then restores eligible IDs', async () => {
    Object.assign(settingsStore.settings, { CUSTOM_PROVIDER_LIST_ENABLED: true, CUSTOM_PROVIDER_LIST: ['unsupported', 'bulk-only'] })
    registry.providers.push(
      { id: 'unsupported', name: 'Unsupported', category: 'ai', icon: 'unsupported.svg', supported: false, features: ['translation'] },
      { id: 'bulk-only', name: 'Bulk Only', category: 'local', icon: 'bulk.svg', supported: true, features: ['bulk'] },
    )
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2', requiredFeature: 'translation' })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      expect(wrapper.findAll('.ti-dropdown-item').map(item => item.text().trim())).not.toContain('Unsupported')
      expect(wrapper.findAll('.ti-dropdown-item').map(item => item.text().trim())).not.toContain('Bulk Only')
      expect(settingsStore.settings.CUSTOM_PROVIDER_LIST).toEqual(['unsupported', 'bulk-only'])

      await wrapper.setProps({ requiredFeature: 'bulk' })
      expect(wrapper.findAll('.ti-dropdown-item').map(item => item.text().trim())).toContain('Bulk Only')
      expect(wrapper.findAll('.ti-dropdown-group-header').map(header => header.text())).toContain('Custom List')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('applies debug, hidden, configured, feature, and default filters before displaying providers', async () => {
    registry.providers.push({ id: 'mock', name: 'Mock', category: 'local', icon: 'mock.svg', supported: true, features: ['translation'] })
    settingsStore.settings.HIDDEN_PROVIDERS = ['deepl']
    let mounted = await attachSelector({ mode: 'button', modelValue: 'googlev2', onlyConfigured: true })
    try {
      await mounted.wrapper.find('.ti-provider-button').trigger('click')
      expect(mounted.wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual(['Google', 'OpenAI', 'Gemini', 'Browser'])
    } finally {
      mounted.wrapper.unmount()
      mounted.container.remove()
    }

    mounted = await attachSelector({ mode: 'button', modelValue: 'googlev2', ignoreHidden: true, allowDefault: true, requiredFeature: 'bulk' })
    try {
      await mounted.wrapper.find('.ti-provider-button').trigger('click')
      expect(mounted.wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual(['Default', 'Google'])
    } finally {
      mounted.wrapper.unmount()
      mounted.container.remove()
    }

    settingsStore.settings.DEBUG_MODE = true
    mounted = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await mounted.wrapper.find('.ti-provider-button').trigger('click')
      expect(mounted.wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toContain('Mock')
    } finally {
      mounted.wrapper.unmount()
      mounted.container.remove()
    }
  })

  it('opens provider configuration from the menu footer', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const maskSources = wrapper.findAllComponents(MaskIcon).map(icon => icon.props('src'))
      expect(maskSources.length).toBeGreaterThan(0)
      expect(maskSources.every(src => src.startsWith('data:image/svg+xml'))).toBe(true)
      const configureButton = wrapper.findAll('button').find((button) => button.text().includes('Configure Providers'))
      expect(configureButton).toBeTruthy()
      await configureButton.trigger('click')
      expect(openOptionsPage).toHaveBeenCalledWith('providers')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('keeps category order as keyboard navigation order and selects on Enter', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const trigger = wrapper.find('.ti-provider-button')
      trigger.element.focus()
      await trigger.trigger('click')
      const keyOnFocusedControl = async (key) => {
        const activeElement = document.activeElement
        expect(activeElement).toBeTruthy()
        activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
        await wrapper.vm.$nextTick()
      }
      await keyOnFocusedControl('ArrowDown')
      await keyOnFocusedControl('ArrowDown')
      await keyOnFocusedControl('Enter')
      expect(wrapper.emitted('provider-change')).toEqual([['unconfigured']])
      expect(wrapper.emitted('update:modelValue')).toEqual([['unconfigured']])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('selection-only mode filters exclusions and hidden providers, stays flat, and ignores injected defaults', async () => {
    registry.providers = providers.map(provider => ({ ...provider }))
    Object.assign(settingsStore.settings, {
      TRANSLATION_API: 'googlev2',
      HIDDEN_PROVIDERS: ['deepl'],
      CUSTOM_PROVIDER_LIST_ENABLED: true,
      CUSTOM_PROVIDER_LIST: ['gemini'],
    })
    const { wrapper, container } = await attachSelector({
      mode: 'button', selectionOnly: true, modelValue: '', excludeIds: ['browser'], allowDefault: true,
    })
    try {
      expect(wrapper.vm.currentProvider).toBe('')
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = wrapper.find('.ti-provider-dropdown-menu')
      expect(menu.findAll('.ti-dropdown-group-header')).toHaveLength(0)
      expect(menu.findAll('.ti-dropdown-item').map(item => item.text().trim())).toEqual([
        'Google', 'Unconfigured', 'OpenAI', 'Gemini',
      ])
      expect(menu.findAll('.ti-dropdown-item-btn')).toHaveLength(4)
      await wrapper.setProps({ modelValue: 'deepl' })
      expect(wrapper.findAll('.ti-dropdown-item').map(item => item.text().trim())).not.toContain('DeepL')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('selection-only click and keyboard selection emit only model events and leave stores and select mode untouched', async () => {
    selectMode.active = true
    const { wrapper, container } = await attachSelector({
      mode: 'button', selectionOnly: true, isGlobal: true, modelValue: '',
    })
    try {
      expect(wrapper.vm.currentProvider).toBe('')
      await wrapper.find('.ti-provider-button').trigger('click')
      expect(wrapper.findAll('.ti-dropdown-item').map(item => item.text().trim()).slice(0, 2)).toEqual(['Google', 'DeepL'])
      await wrapper.findAll('.ti-dropdown-item-btn')[1].trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('update:modelValue')).toEqual([['deepl']])
      expect(wrapper.emitted('provider-change')).toEqual([['deepl']])
      expect(wrapper.emitted('translate')).toBeUndefined()
      expect(settingsStore.updateSettingAndPersist).not.toHaveBeenCalled()
      expect(translationStore.selectedProvider).toBeNull()
      expect(deactivateSelectMode).not.toHaveBeenCalled()

      await wrapper.setProps({ modelValue: 'googlev2' })
      await wrapper.find('.ti-provider-button').trigger('click')
      const firstMenuButton = wrapper.find('.ti-dropdown-item-btn')
      firstMenuButton.element.focus()
      firstMenuButton.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await wrapper.vm.$nextTick()
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('provider-change')).toEqual([['deepl'], ['deepl']])
      expect(settingsStore.updateSettingAndPersist).not.toHaveBeenCalled()
      expect(translationStore.selectedProvider).toBeNull()
      expect(deactivateSelectMode).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('selection-only Escape stops before window handlers, including for an empty menu', async () => {
    const { wrapper, container } = await attachSelector({
      mode: 'button', selectionOnly: true, excludeIds: providers.map(provider => provider.id),
    })
    const parentKeyHandler = vi.fn()
    window.addEventListener('keydown', parentKeyHandler)
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = wrapper.find('.ti-provider-dropdown-menu')
      expect(menu.findAll('.ti-dropdown-item')).toHaveLength(0)
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      menu.element.dispatchEvent(escape)
      expect(escape.defaultPrevented).toBe(true)
      expect(parentKeyHandler).not.toHaveBeenCalled()
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.ti-provider-dropdown-menu').exists()).toBe(false)
    } finally {
      window.removeEventListener('keydown', parentKeyHandler)
      wrapper.unmount()
      container.remove()
    }
  })

  it('selection-only trigger shows the add placeholder instead of the global provider identity until a pick', async () => {
    const { wrapper, container } = await attachSelector({
      mode: 'button', selectionOnly: true, modelValue: '',
    })
    try {
      const trigger = wrapper.find('.ti-provider-button')
      expect(trigger.find('img').exists()).toBe(false)
      expect(trigger.find('.ti-provider-button-placeholder').text()).toBe('Add a provider…')
      expect(trigger.text()).not.toContain('Google')

      await trigger.trigger('click')
      await wrapper.findAll('.ti-dropdown-item-btn')[0].trigger('click')
      expect(wrapper.emitted('update:modelValue')).toEqual([['googlev2']])

      await wrapper.setProps({ modelValue: 'googlev2' })
      const pickedTrigger = wrapper.find('.ti-provider-button')
      expect(pickedTrigger.find('.ti-provider-button-placeholder').exists()).toBe(false)
      expect(pickedTrigger.find('img').exists()).toBe(true)
      expect(pickedTrigger.text()).toContain('Google')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('selection-only menu hides Default, star, sync, Configure Providers, and compact configure regardless of accidental props', async () => {
    const { wrapper, container } = await attachSelector({
      mode: 'button', selectionOnly: true, modelValue: '', allowDefault: true, allowSetDefault: true, isGlobal: false, showSync: true,
    })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = wrapper.find('.ti-provider-dropdown-menu')
      expect(menu.findAll('.ti-dropdown-item').map(item => item.text().trim())).not.toContain('Default')
      expect(menu.findAll('.ti-set-default-btn')).toHaveLength(0)
      expect(menu.findAll('.ti-sync-row')).toHaveLength(0)
      expect(menu.find('.ti-configure-row').exists()).toBe(false)
      expect(wrapper.find('.ti-provider-dropdown-footer').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      container.remove()
    }

    const compact = await attachSelector({ mode: 'compact', selectionOnly: true, modelValue: '' })
    try {
      expect(compact.wrapper.find('.ti-provider-compact-config-btn').exists()).toBe(false)
      expect(Array.from(compact.wrapper.find('select').element.options, option => option.value)).toEqual([
        'googlev2', 'deepl', 'unconfigured', 'openai', 'gemini', 'browser',
      ])
    } finally {
      compact.wrapper.unmount()
      compact.container.remove()
    }
  })

  it('removes the open teleported menu when the selection-only host unmounts', async () => {
    const { wrapper, container } = await attachSelector(
      { mode: 'button', selectionOnly: true, modelValue: '' },
      { realTeleport: true },
    )
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeTruthy()
    } finally {
      wrapper.unmount()
      container.remove()
    }
    expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeNull()
  })

  it.each([
    { label: 'LTR narrow', width: 240, dir: 'ltr', rect: { left: 180, right: 220, width: 40 } },
    { label: 'RTL narrow', width: 240, dir: 'rtl', rect: { left: 20, right: 60, width: 40 } },
    { label: 'LTR roomy', width: 520, dir: 'ltr', rect: { left: 150, right: 350, width: 200 } },
    { label: 'RTL roomy', width: 520, dir: 'rtl', rect: { left: 170, right: 370, width: 200 } },
  ])('clamps the selection-only menu inside 8px viewport gutters: $label', async ({ width, dir, rect }) => {
    const widthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const previousDir = document.documentElement.dir
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    document.documentElement.dir = dir
    const { wrapper, container } = await attachSelector(
      { mode: 'button', selectionOnly: true, modelValue: '' },
      { realTeleport: true, rect },
    )
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(menu.classList.contains('ti-provider-dropdown-menu--popup')).toBe(false)
      expect(menu.classList.contains('ti-provider-dropdown-menu--sidepanel')).toBe(false)
      const menuWidth = Math.min(Math.max(rect.width, 220), width - 16)
      expect(menu.style.width).toBe(`${menuWidth}px`)
      const left = menu.style.left !== 'auto'
        ? Number.parseFloat(menu.style.left)
        : width - Number.parseFloat(menu.style.right) - menuWidth
      expect(left).toBeGreaterThanOrEqual(8)
      expect(left + menuWidth).toBeLessThanOrEqual(width - 8)
    } finally {
      wrapper.unmount()
      container.remove()
      document.documentElement.dir = previousDir
      if (widthDescriptor) Object.defineProperty(window, 'innerWidth', widthDescriptor)
      else delete window.innerWidth
    }
  })

  it('coalesces drawer body scrolls with the Options RAF and repositions while the trigger stays visible', async () => {
    const raf = stubAnimationFrames()
    const { wrapper, container, setRect } = await attachSelector(
      { mode: 'button', selectionOnly: true, modelValue: '' },
      { realTeleport: true, containerClass: 'custom-list-drawer-body' },
    )
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(menu.style.left).toBe('100px')
      expect(trackedListeners.some(({ target, event }) => target === container && event === 'scroll')).toBe(true)
      expect(trackedListeners.some(({ target, event }) => target === window && event === 'scroll')).toBe(false)

      setRect({ left: 140, right: 340, x: 140 })
      container.dispatchEvent(new Event('scroll'))
      container.dispatchEvent(new Event('scroll'))
      expect(raf.frames.size).toBe(1)
      raf.flush()
      await wrapper.vm.$nextTick()
      expect(menu.style.left).toBe('140px')
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBe(menu)
    } finally {
      wrapper.unmount()
      container.remove()
      raf.restore()
    }
  })

  it('silently closes when the trigger scrolls fully out of the drawer body', async () => {
    const raf = stubAnimationFrames()
    const { wrapper, container, setRect } = await attachSelector(
      { mode: 'button', selectionOnly: true, modelValue: '' },
      {
        realTeleport: true,
        containerClass: 'custom-list-drawer-body',
        containerRect: { top: 100, left: 0, right: 600, bottom: 400, width: 600, height: 300 },
      },
    )
    try {
      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('click')
      const triggerFocus = vi.spyOn(trigger.element, 'focus')
      setRect({ top: 410, bottom: 450 })
      container.dispatchEvent(new Event('scroll'))
      raf.flush()
      await wrapper.vm.$nextTick()
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeNull()
      expect(wrapper.emitted('provider-change')).toBeUndefined()
      expect(triggerFocus).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      container.remove()
      raf.restore()
    }
  })

  it('cancels pending drawer RAF work and removes the drawer scroll listener on unmount', async () => {
    const raf = stubAnimationFrames()
    const { wrapper, container } = await attachSelector(
      { mode: 'button', selectionOnly: true, modelValue: '' },
      { realTeleport: true, containerClass: 'custom-list-drawer-body' },
    )
    await wrapper.find('.ti-provider-button').trigger('click')
    container.dispatchEvent(new Event('scroll'))
    expect(raf.frames.size).toBe(1)
    const [frameId] = raf.frames.keys()
    expect(trackedListeners.some(({ target, event }) => target === container && event === 'scroll')).toBe(true)
    wrapper.unmount()
    expect(raf.cancelled).toContain(frameId)
    expect(raf.frames.size).toBe(0)
    expect(trackedListeners.some(({ target, event }) => target === container && event === 'scroll')).toBe(false)
    container.remove()
    raf.restore()
  })

  it('renders each mode with its expected provider-selection control', async () => {
    for (const mode of ['split', 'button', 'icon-only', 'mobile']) {
      const { wrapper, container } = await attachSelector({ mode, modelValue: 'googlev2' })
      try {
        const trigger = wrapper.find({
          split: '.ti-provider-dropdown-area',
          button: '.ti-provider-button',
          'icon-only': '.ti-provider-icon-button',
          mobile: '.ti-provider-mobile-button',
        }[mode])
        expect(trigger.exists()).toBe(true)
        await trigger.trigger('click')
        expect(wrapper.find('.ti-provider-dropdown-menu').exists()).toBe(true)
      } finally {
        wrapper.unmount()
        container.remove()
      }
    }

    const { wrapper, container } = await attachSelector({ mode: 'compact', modelValue: 'googlev2' })
    try {
      expect(wrapper.find('select.ti-provider-select').exists()).toBe(true)
      expect(wrapper.findAll('select option')).toHaveLength(6)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('keeps Default and every provider selectable in compact mode and exposes configuration', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'compact', modelValue: 'googlev2', allowDefault: true })
    try {
      const select = wrapper.get('select.ti-provider-select')
      expect(Array.from(select.element.options).map((option) => option.value)).toEqual([
        'default', 'googlev2', 'deepl', 'unconfigured', 'openai', 'gemini', 'browser',
      ])
      await select.setValue('deepl')
      expect(wrapper.emitted('provider-change')).toEqual([['deepl']])

      const configure = wrapper.get('.ti-provider-compact-config-btn')
      expect(configure.attributes('aria-label')).toBe('Configure Providers')
      await configure.trigger('click')
      expect(openOptionsPage).toHaveBeenCalledWith('providers')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it.each([true, false])('persists only global selection (isGlobal=%s)', async (isGlobal) => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2', isGlobal })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      await wrapper.findAll('.ti-dropdown-item')[1].trigger('click')
      expect(wrapper.emitted('provider-change')).toEqual([['deepl']])
      expect(translationStore.selectedProvider).toBe('deepl')
      expect(settingsStore.updateSettingAndPersist).toHaveBeenCalledTimes(isGlobal ? 1 : 0)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('keeps default-star persistence independent from temporary selection and sync toggling', async () => {
    const { wrapper, container } = await attachSelector({
      mode: 'button', modelValue: 'googlev2', isGlobal: false, allowSetDefault: true, showSync: true,
    })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const googleItem = () => wrapper.findAll('.ti-dropdown-item').find(item => item.text().includes('Google'))
      const googleStar = () => googleItem().findComponent(MaskIcon).props('src')
      const defaultStar = googleStar()
      expect(defaultStar).toMatch(/^data:image\/svg\+xml/)
      settingsStore.settings.TRANSLATION_API = 'deepl'
      await wrapper.vm.$nextTick()
      expect(googleStar()).not.toBe(defaultStar)
      settingsStore.settings.TRANSLATION_API = 'googlev2'
      await wrapper.vm.$nextTick()
      expect(googleStar()).toBe(defaultStar)

      const deeplItem = wrapper.findAll('.ti-dropdown-item')[1]
      await deeplItem.find('.ti-set-default-btn').trigger('click')
      expect(settingsStore.updateSettingAndPersist).toHaveBeenCalledWith('TRANSLATION_API', 'deepl')
      expect(wrapper.emitted('provider-change')).toEqual([['deepl']])

      await wrapper.find('.ti-provider-button').trigger('click')
      expect(wrapper.findAll('.ti-sync-row')).toHaveLength(2)
      await wrapper.findAll('.ti-sync-row')[0].trigger('click')
      expect(translationStore.ephemeralSync.page).toBe(true)
      expect(settingsStore.updateSettingAndPersist).toHaveBeenCalledTimes(1)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('toggles Page and Element sync repeatedly without closing or selecting a provider', async () => {
    settingsStore.settings.TRANSLATION_API = 'deepl'
    const { wrapper, container } = await attachSelector({
      mode: 'button', modelValue: 'googlev2', showSync: true,
    }, { realTeleport: true })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      const [page, element] = menu.querySelectorAll('.ti-sync-row')
      expect(page.textContent).toContain('Page Translate')
      expect(element.textContent).toContain('Select Element')
      expect(page.getAttribute('aria-pressed')).toBe('false')
      expect(element.getAttribute('aria-pressed')).toBe('false')
      expect(page.getAttribute('title')).toBe('Page translation uses its configured provider, or falls back to the current or default provider.')
      expect(element.getAttribute('title')).toBe('Select Element translation uses its configured provider, or falls back to the current or default provider.')
      const pageIcon = () => page.querySelector('.ti-sync-icon').getAttribute('style')
      const initialPageIcon = pageIcon()
      expect(initialPageIcon).toContain('data:image/svg+xml')

      page.focus()
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      page.dispatchEvent(enter)
      expect(enter.defaultPrevented).toBe(false)
      await wrapper.vm.$nextTick()
      page.focus()
      page.click() // jsdom does not synthesize native button activation from keydown.
      await wrapper.vm.$nextTick()
      expect(page.getAttribute('aria-pressed')).toBe('true')
      expect(page.getAttribute('title')).toBe('Page translation follows the provider selected here')
      expect(pageIcon()).toContain('data:image/svg+xml')
      expect(pageIcon()).not.toBe(initialPageIcon)
      expect(document.activeElement).toBe(page)
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBe(menu)
      expect(wrapper.find('.ti-provider-button').attributes('aria-expanded')).toBe('true')

      page.click()
      await wrapper.vm.$nextTick()
      expect(page.getAttribute('aria-pressed')).toBe('false')
      expect(page.getAttribute('title')).toBe('Page translation uses its configured provider, or falls back to the current or default provider.')
      expect(pageIcon()).toBe(initialPageIcon)

      const initialElementIcon = element.querySelector('.ti-sync-icon').getAttribute('style')
      expect(initialElementIcon).toContain('data:image/svg+xml')
      element.focus()
      const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
      element.dispatchEvent(space)
      expect(space.defaultPrevented).toBe(false)
      await wrapper.vm.$nextTick()
      element.focus()
      element.click()
      await wrapper.vm.$nextTick()
      expect(element.getAttribute('aria-pressed')).toBe('true')
      expect(element.getAttribute('title')).toBe('Select Element translation follows the provider selected here')
      expect(document.activeElement).toBe(element)
      expect(element.querySelector('.ti-sync-icon').getAttribute('style')).not.toBe(initialElementIcon)
      expect(menu.querySelector('.ti-configure-row')).toBeTruthy()

      element.click()
      await wrapper.vm.$nextTick()
      expect(element.getAttribute('aria-pressed')).toBe('false')
      expect(element.getAttribute('title')).toBe('Select Element translation uses its configured provider, or falls back to the current or default provider.')
      expect(element.querySelector('.ti-sync-icon').getAttribute('style')).toBe(initialElementIcon)
      expect(translationStore.ephemeralSync).toEqual({ page: false, element: false })
      expect(translationStore.selectedProvider).toBe('googlev2')
      expect(wrapper.emitted('provider-change')).toBeUndefined()
      expect(wrapper.emitted('translate')).toBeUndefined()
      expect(settingsStore.updateSettingAndPersist).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('disables both sync controls and prevents mutation for a provider without bulk support', async () => {
    registry.providers = [{
      id: 'local-only', name: 'Local Only', category: 'local', icon: 'providers/local.svg',
      supported: true, features: ['translation'],
    }]
    const { wrapper, container } = await attachSelector({
      mode: 'button', modelValue: 'local-only', showSync: true,
    }, { realTeleport: true })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const rows = Array.from(document.body.querySelectorAll('.ti-sync-row'))
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.disabled)).toBe(true)
      expect(rows.every((row) => Boolean(row.title))).toBe(true)
      expect(rows.map((row) => row.title)).toEqual([
        'This provider does not support Page Translate and Select Element translation.',
        'This provider does not support Page Translate and Select Element translation.',
      ])
      rows.forEach((row) => row.click())
      expect(translationStore.ephemeralSync).toEqual({ page: false, element: false })
      expect(translationStore.selectedProvider).toBeNull()
      expect(wrapper.emitted('provider-change')).toBeUndefined()
      expect(wrapper.emitted('translate')).toBeUndefined()
      expect(settingsStore.updateSettingAndPersist).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('closes on Escape from the focused dropdown control and restores trigger focus', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const trigger = wrapper.find('.ti-provider-button')
      trigger.element.focus()
      await trigger.trigger('click')
      const focusedControl = document.activeElement
      expect(focusedControl).toBeTruthy()
      focusedControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.ti-provider-dropdown-menu').exists()).toBe(false)
      expect(document.activeElement).toBe(trigger.element)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('keeps star, sync, and configure controls tabbable without intercepting Tab', async () => {
    const { wrapper, container } = await attachSelector({
      mode: 'button', modelValue: 'googlev2', isGlobal: false, allowSetDefault: true, showSync: true,
    }, { realTeleport: true })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      const buttons = Array.from(menu.querySelectorAll('button'))
      const star = buttons.find((button) => button.classList.contains('ti-set-default-btn'))
      const sync = buttons.find((button) => button.classList.contains('ti-sync-row'))
      const configure = buttons.find((button) => button.textContent.includes('Configure Providers'))
      expect(star).toBeTruthy()
      expect(sync).toBeTruthy()
      expect(configure).toBeTruthy()
      expect(buttons.indexOf(star)).toBeLessThan(buttons.indexOf(sync))
      expect(buttons.indexOf(sync)).toBeLessThan(buttons.indexOf(configure))

      star.focus()
      expect(document.activeElement).toBe(star)
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      document.activeElement.dispatchEvent(tab)
      await wrapper.vm.$nextTick()
      expect(tab.defaultPrevented).toBe(false)
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBe(menu)
      sync.focus()
      expect(document.activeElement).toBe(sync)
      configure.focus()
      expect(document.activeElement).toBe(configure)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('teleports into the document and positions the menu using RTL inline coordinates', async () => {
    const previousDir = document.documentElement.dir
    document.documentElement.dir = 'rtl'
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(menu).toBeTruthy()
      expect(menu.getAttribute('style')).toContain(`right: ${window.innerWidth - 300}px`)
    } finally {
      wrapper.unmount()
      container.remove()
      document.documentElement.dir = previousDir
    }
  })

  it('marks only Popup Text menus for popup sizing and keeps provider controls intact', async () => {
    const longName = 'A deliberately long provider display name that should remain available'
    registry.providers[1].name = longName
    const { wrapper, container } = await attachSelector({
      mode: 'split', modelValue: 'googlev2', isGlobal: false, allowSetDefault: true, showSync: true,
    }, { realTeleport: true, popupAncestor: true })
    try {
      await wrapper.find('.ti-provider-dropdown-area').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(menu.classList.contains('ti-provider-dropdown-menu--popup')).toBe(true)
      expect(menu.style.width).toBe('245px')
      expect(menu.textContent).toContain(longName)
      expect(menu.querySelector('.ti-set-default-btn')).toBeTruthy()
      expect(menu.querySelectorAll('.ti-sync-row')).toHaveLength(2)
      expect(menu.querySelector('.ti-configure-row')).toBeTruthy()
    } finally {
      wrapper.unmount()
      container.remove()
    }

    for (const mode of ['split', 'button', 'icon-only', 'mobile']) {
      const regular = await attachSelector({ mode, modelValue: 'googlev2' }, { realTeleport: true })
      try {
        await regular.wrapper.find({
          split: '.ti-provider-dropdown-area',
          button: '.ti-provider-button',
          'icon-only': '.ti-provider-icon-button',
          mobile: '.ti-provider-mobile-button',
        }[mode]).trigger('click')
        const menu = document.body.querySelector('.ti-provider-dropdown-menu')
        expect(menu.classList.contains('ti-provider-dropdown-menu--popup')).toBe(false)
        expect(menu.style.width).not.toBe('245px')
      } finally {
        regular.wrapper.unmount()
        regular.container.remove()
      }
    }
  })

  it.each([
    { label: 'LTR near the right edge', width: 360, dir: 'ltr', rect: { left: 250, right: 300, width: 50 } },
    { label: 'RTL near the left edge', width: 360, dir: 'rtl', rect: { left: 10, right: 60, width: 50 } },
    { label: 'narrow viewport', width: 240, dir: 'ltr', rect: { left: 180, right: 220, width: 40 } },
  ])('clamps Popup Text menu within the viewport: $label', async ({ width, dir, rect }) => {
    const widthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const previousDir = document.documentElement.dir
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    document.documentElement.dir = dir
    const { wrapper, container } = await attachSelector(
      { mode: 'split', modelValue: 'googlev2' },
      { realTeleport: true, popupAncestor: true, rect },
    )
    try {
      await wrapper.find('.ti-provider-dropdown-area').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(menu.classList.contains('ti-provider-dropdown-menu--popup')).toBe(true)
      const menuWidth = Math.min(245, width - 16)
      const left = menu.style.left !== 'auto'
        ? Number.parseFloat(menu.style.left)
        : width - Number.parseFloat(menu.style.right) - menuWidth
      expect(left).toBeGreaterThanOrEqual(8)
      expect(left + menuWidth).toBeLessThanOrEqual(width - 8)
    } finally {
      wrapper.unmount()
      container.remove()
      document.documentElement.dir = previousDir
      if (widthDescriptor) Object.defineProperty(window, 'innerWidth', widthDescriptor)
      else delete window.innerWidth
    }
  })

  it.each([
    { label: 'LTR narrow', width: 280, dir: 'ltr', rect: { left: 220, right: 260, width: 40 } },
    { label: 'RTL narrow', width: 280, dir: 'rtl', rect: { left: 20, right: 60, width: 40 } },
    { label: 'LTR wide', width: 520, dir: 'ltr', rect: { left: 460, right: 500, width: 40 } },
    { label: 'RTL wide', width: 520, dir: 'rtl', rect: { left: 20, right: 60, width: 40 } },
  ])('clamps the Sidepanel menu in $label viewports', async ({ width, dir, rect }) => {
    const widthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const previousDir = document.documentElement.dir
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    document.documentElement.dir = dir
    const { wrapper, container } = await attachSelector(
      { mode: 'split', modelValue: 'googlev2' },
      { realTeleport: true, selectorClass: 'ti-sidepanel-split-selector', rect },
    )
    try {
      await wrapper.find('.ti-provider-dropdown-area').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(menu.classList.contains('ti-provider-dropdown-menu--sidepanel')).toBe(true)
      const menuWidth = Math.min(245, width - 16)
      expect(menu.style.width).toBe(`${menuWidth}px`)
      const left = menu.style.left !== 'auto'
        ? Number.parseFloat(menu.style.left)
        : width - Number.parseFloat(menu.style.right) - menuWidth
      expect(left).toBeGreaterThanOrEqual(8)
      expect(left + menuWidth).toBeLessThanOrEqual(width - 8)
    } finally {
      wrapper.unmount()
      container.remove()
      document.documentElement.dir = previousDir
      if (widthDescriptor) Object.defineProperty(window, 'innerWidth', widthDescriptor)
      else delete window.innerWidth
    }
  })

  it('keeps long provider names, stars, sync rows, and Configure Providers in the Sidepanel menu', async () => {
    const longName = 'A deliberately long Sidepanel provider name that should remain available'
    registry.providers[1].name = longName
    const { wrapper, container } = await attachSelector({
      mode: 'split', modelValue: 'googlev2', isGlobal: false, allowSetDefault: true, showSync: true,
    }, { realTeleport: true, selectorClass: 'ti-sidepanel-split-selector' })
    try {
      await wrapper.find('.ti-provider-dropdown-area').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(menu.classList.contains('ti-provider-dropdown-menu--sidepanel')).toBe(true)
      expect(menu.classList.contains('ti-provider-dropdown-menu--popup')).toBe(false)
      expect(menu.textContent).toContain(longName)
      expect(menu.querySelectorAll('.ti-set-default-btn')).toHaveLength(6)
      expect(menu.querySelectorAll('.ti-sync-row')).toHaveLength(2)
      expect(menu.querySelector('.ti-configure-row')).toBeTruthy()
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('does not apply Sidepanel sizing to Popup, PDF compact-label, Options, Subtitle, mobile, or Floating Window menus', async () => {
    const consumers = [
      { mode: 'split', props: { presentation: 'compact-label' } },
      { mode: 'button' },
      { mode: 'mobile' },
      { mode: 'icon-only', selectorClass: 'ti-window-provider-selector' },
      { mode: 'split', popupAncestor: true, popup: true },
    ]
    for (const { mode, props = {}, selectorClass, popupAncestor, popup = false } of consumers) {
      const { wrapper, container } = await attachSelector(
        { mode, modelValue: 'googlev2', ...props },
        { realTeleport: true, selectorClass, popupAncestor },
      )
      try {
        await wrapper.find({
          split: '.ti-provider-dropdown-area',
          button: '.ti-provider-button',
          mobile: '.ti-provider-mobile-button',
          'icon-only': '.ti-provider-icon-button',
        }[mode]).trigger('click')
        const menu = document.body.querySelector('.ti-provider-dropdown-menu')
        expect(menu.classList.contains('ti-provider-dropdown-menu--sidepanel')).toBe(false)
        expect(menu.classList.contains('ti-provider-dropdown-menu--popup')).toBe(popup)
        if (popup) expect(menu.style.width).toBe('245px')
        else expect(menu.style.width).not.toBe('245px')
      } finally {
        wrapper.unmount()
        container.remove()
      }
    }
  })

  it('allows provider selection and Configure Providers clicks inside the real teleported menu', async () => {
    const { wrapper, container } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' }, { realTeleport: true },
    )
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      await menu.querySelectorAll('.ti-dropdown-item-btn')[1].click()
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('provider-change')).toEqual([['deepl']])
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeNull()

      await wrapper.find('.ti-provider-button').trigger('click')
      const configure = Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent.includes('Configure Providers'))
      expect(configure).toBeTruthy()
      configure.click()
      expect(openOptionsPage).toHaveBeenCalledWith('providers')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('does not classify a real teleported menu click as outside during capture', async () => {
    const { wrapper, container } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' }, { realTeleport: true },
    )
    let captureState
    try {
      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      const observeCapture = () => { captureState = wrapper.vm.$.setupState.isDropdownOpen }
      document.addEventListener('click', observeCapture, true)
      try {
        menu.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
      } finally {
        document.removeEventListener('click', observeCapture, true)
      }
      expect(captureState).toBe(true)
      await wrapper.vm.$nextTick()
      expect(trigger.attributes('aria-expanded')).toBe('true')
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBe(menu)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('preserves provider selection when a row-edge pointer sequence moves focus before click', async () => {
    const { wrapper, container } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' }, { realTeleport: true },
    )
    try {
      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      const row = menu.querySelectorAll('.ti-dropdown-item')[1]
      const rowButton = row.querySelector('.ti-dropdown-item-btn')
      rowButton.focus()

      // jsdom has no CSS hit testing; the row container represents its padding edge.
      row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }))
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }))
      rowButton.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(trigger.attributes('aria-expanded')).toBe('true')

      row.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(wrapper.emitted('provider-change')).toEqual([['deepl']])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('keeps star, sync, and configure clicks independent from provider selection', async () => {
    const { wrapper, container } = await attachSelector({
      mode: 'button', modelValue: 'googlev2', isGlobal: false, allowSetDefault: true, showSync: true,
    }, { realTeleport: true })
    try {
      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('click')
      let menu = document.body.querySelector('.ti-provider-dropdown-menu')
      await menu.querySelector('.ti-dropdown-item-btn[aria-current="true"]')
        .closest('.ti-dropdown-item').querySelector('.ti-set-default-btn').click()
      expect(settingsStore.updateSettingAndPersist).toHaveBeenCalledWith('TRANSLATION_API', 'googlev2')
      expect(wrapper.emitted('provider-change')).toBeUndefined()

      await trigger.trigger('click')
      menu = document.body.querySelector('.ti-provider-dropdown-menu')
      menu.querySelector('.ti-sync-row').click()
      expect(translationStore.ephemeralSync.page).toBe(true)
      expect(wrapper.emitted('provider-change')).toBeUndefined()

      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBe(menu)
      menu.querySelector('.ti-configure-row').click()
      expect(openOptionsPage).toHaveBeenCalledWith('providers')
      expect(wrapper.emitted('provider-change')).toBeUndefined()
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('dismisses on a real outside click without selecting or stealing focus', async () => {
    const { wrapper, container } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' }, { realTeleport: true },
    )
    const outside = document.createElement('button')
    outside.textContent = 'Outside'
    container.appendChild(outside)
    try {
      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('click')
      const triggerFocus = vi.spyOn(trigger.element, 'focus')
      outside.click()
      await wrapper.vm.$nextTick()
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeNull()
      expect(wrapper.emitted('provider-change')).toBeUndefined()
      expect(triggerFocus).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it.each([false, true])('ignores window scrolling and installs no window scroll listener (Options=%s)', async (optionsPage) => {
    const restoreLocation = optionsPage ? enterOptionsPage() : enterOtherPage()
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      expect(trackedListeners.some(({ target, event }) => target === window && event === 'scroll')).toBe(false)
      window.dispatchEvent(new Event('scroll'))
      await wrapper.vm.$nextTick()
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeTruthy()
    } finally {
      wrapper.unmount()
      container.remove()
      restoreLocation()
    }
  })

  it('coalesces Options tab scrolls, repositions from the moved trigger, and preserves resize', async () => {
    const restoreLocation = enterOptionsPage()
    const raf = stubAnimationFrames()
    const { wrapper, container, setRect } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' },
      { realTeleport: true, containerClass: 'tab-content-container' },
    )
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(menu.style.left).toBe('100px')
      expect(trackedListeners.some(({ target, event }) => target === container && event === 'scroll')).toBe(true)
      expect(trackedListeners.some(({ target, event }) => target === window && event === 'scroll')).toBe(false)
      expect(trackedListeners.some(({ target, event }) => target === window && event === 'resize')).toBe(true)

      setRect({ left: 150, right: 350, x: 150 })
      container.dispatchEvent(new Event('scroll'))
      container.dispatchEvent(new Event('scroll'))
      expect(raf.frames.size).toBe(1)
      raf.flush()
      await wrapper.vm.$nextTick()
      expect(menu.style.left).toBe('150px')

      setRect({ left: 190, right: 390, x: 190 })
      window.dispatchEvent(new Event('resize'))
      expect(raf.frames.size).toBe(1)
      raf.flush()
      await wrapper.vm.$nextTick()
      expect(menu.style.left).toBe('190px')

      menu.querySelector('.ti-provider-dropdown-list').dispatchEvent(new Event('scroll'))
      expect(raf.frames.size).toBe(0)
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBe(menu)
    } finally {
      wrapper.unmount()
      container.remove()
      raf.restore()
      restoreLocation()
    }
  })

  it('does not attach Options tab-scroll repositioning in another context', async () => {
    const restoreLocation = enterOtherPage()
    const raf = stubAnimationFrames()
    const { wrapper, container } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' },
      { realTeleport: true, containerClass: 'tab-content-container' },
    )
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      expect(trackedListeners.some(({ target, event }) => target === container && event === 'scroll')).toBe(false)
      container.dispatchEvent(new Event('scroll'))
      expect(raf.frames.size).toBe(0)
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeTruthy()
    } finally {
      wrapper.unmount()
      container.remove()
      raf.restore()
      restoreLocation()
    }
  })

  it.each([
    { label: 'entirely below its Options container', width: 800, moved: { top: 410, bottom: 450 } },
    { label: 'exactly at the Options container edge', width: 800, moved: { top: 400, bottom: 440 } },
    { label: 'entirely beyond the horizontal viewport', width: 360, moved: { left: 370, right: 410, x: 370 } },
  ])('silently closes when the trigger is $label', async ({ width, moved }) => {
    const restoreLocation = enterOptionsPage()
    const widthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    const raf = stubAnimationFrames()
    const { wrapper, container, setRect } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' },
      {
        realTeleport: true,
        containerClass: 'tab-content-container',
        containerRect: { top: 100, left: 0, right: 600, bottom: 400, width: 600, height: 300 },
      },
    )
    try {
      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('click')
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      const triggerFocus = vi.spyOn(trigger.element, 'focus')
      setRect(moved)
      container.dispatchEvent(new Event('scroll'))
      expect(raf.frames.size).toBe(1)
      raf.flush()
      await wrapper.vm.$nextTick()
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeNull()
      expect(wrapper.emitted('provider-change')).toBeUndefined()
      expect(triggerFocus).not.toHaveBeenCalled()
      expect(menu.isConnected).toBe(false)
    } finally {
      wrapper.unmount()
      container.remove()
      raf.restore()
      restoreLocation()
      if (widthDescriptor) Object.defineProperty(window, 'innerWidth', widthDescriptor)
      else delete window.innerWidth
    }
  })

  it('keeps a partially visible trigger open while repositioning', async () => {
    const restoreLocation = enterOptionsPage()
    const raf = stubAnimationFrames()
    const { wrapper, container, setRect } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' },
      {
        realTeleport: true,
        containerClass: 'tab-content-container',
        containerRect: { top: 100, left: 0, right: 600, bottom: 400, width: 600, height: 300 },
      },
    )
    try {
      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('click')
      setRect({ top: 390, bottom: 430 })
      container.dispatchEvent(new Event('scroll'))
      expect(raf.frames.size).toBe(1)
      raf.flush()
      await wrapper.vm.$nextTick()
      expect(trigger.attributes('aria-expanded')).toBe('true')
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeTruthy()
    } finally {
      wrapper.unmount()
      container.remove()
      raf.restore()
      restoreLocation()
    }
  })

  it('cancels pending position work and removes tracked listeners on unmount', async () => {
    const restoreLocation = enterOptionsPage()
    const raf = stubAnimationFrames()
    const { wrapper, container } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' },
      { realTeleport: true, containerClass: 'tab-content-container' },
    )
    await wrapper.find('.ti-provider-button').trigger('click')
    container.dispatchEvent(new Event('scroll'))
    expect(raf.frames.size).toBe(1)
    const [frameId] = raf.frames.keys()
    expect(trackedListeners.some(({ target, event }) => target === container && event === 'scroll')).toBe(true)
    wrapper.unmount()
    try {
      expect(raf.cancelled).toContain(frameId)
      expect(raf.frames.size).toBe(0)
      expect(trackedListeners.some(({ target, event }) => target === container && event === 'scroll')).toBe(false)
      expect(trackedListeners.some(({ target, event }) => target === window && event === 'resize')).toBe(false)
    } finally {
      container.remove()
      raf.restore()
      restoreLocation()
    }
  })

  it('teleports into the component shadow root when running in content-script context', async () => {
    const { wrapper, container, shadowRoot } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' }, { shadow: true },
    )
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = shadowRoot.querySelector('.ti-provider-dropdown-menu')
      expect(menu).toBeTruthy()
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeNull()
      const trigger = wrapper.find('.ti-provider-button')
      menu.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
      await wrapper.vm.$nextTick()
      expect(trigger.attributes('aria-expanded')).toBe('true')
      const configure = Array.from(shadowRoot.querySelectorAll('button'))
        .find((button) => button.textContent.includes('Configure Providers'))
      expect(configure).toBeTruthy()
      configure.click()
      expect(openOptionsPage).toHaveBeenCalledWith('providers')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  const DIALOG_RECT = { top: 40, left: 20, right: 420, bottom: 640, width: 400, height: 600 }
  const TRIGGER_RECT = { top: 60, bottom: 100, left: 40, right: 400, width: 360, height: 40, x: 40, y: 60 }
  const DRAWER_RECT = { top: 0, left: 0, right: 600, bottom: 600, width: 600, height: 600 }

  it('teleports the selection-only menu into the provided dialog target and positions it absolutely relative to the dialog', async () => {
    const { wrapper, dialog, drawerBody } = await attachDialogSelector({}, {
      rect: TRIGGER_RECT, dialogRect: DIALOG_RECT, drawerRect: DRAWER_RECT,
    })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = dialog.querySelector('.ti-provider-dropdown-menu')
      expect(menu).toBeTruthy()
      expect(menu.parentElement).toBe(dialog)
      expect(menu.parentElement).not.toBe(drawerBody)
      expect(document.body.querySelector(':scope > .ti-provider-dropdown-menu')).toBeNull()
      // Dialog-relative math, not viewport-fixed: trigger bottom 100 minus
      // dialog top 40 + 4 → 64 (viewport math would say 104).
      expect(menu.style.position).toBe('absolute')
      expect(menu.style.top).toBe('64px')
      // Trigger starts 20px inside the dialog → menu pinned to that inset,
      // trigger width (360) since it fits the dialog budget (384).
      expect(menu.style.left).toBe('20px')
      expect(menu.style.width).toBe('360px')
    } finally {
      wrapper.unmount()
      dialog.remove()
    }
  })

  it('fails closed when the provided dialog target is missing: no body teleport and no inline fallback', async () => {
    const { wrapper, container } = await attachSelector(
      { mode: 'button', selectionOnly: true, modelValue: '', menuTeleportTarget: '#CUSTOM_PROVIDER_LIST_DRAWER' },
      { realTeleport: true },
    )
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      await wrapper.vm.$nextTick()
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeNull()
      expect(wrapper.find('.ti-provider-dropdown-menu').exists()).toBe(false)
      expect(wrapper.find('.ti-provider-button').attributes('aria-expanded')).toBe('false')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('fails closed when the resolved dialog target disconnects while the menu is open', async () => {
    const raf = stubAnimationFrames()
    const { wrapper, dialog, drawerBody } = await attachDialogSelector({}, {
      rect: TRIGGER_RECT, dialogRect: DIALOG_RECT, drawerRect: DRAWER_RECT,
    })
    try {
      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('click')
      expect(dialog.querySelector('.ti-provider-dropdown-menu')).toBeTruthy()
      // Host closes the drawer: dialog subtree detaches, scroll event still hits the listener.
      dialog.remove()
      drawerBody.dispatchEvent(new Event('scroll'))
      raf.flush()
      await wrapper.vm.$nextTick()
      expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeNull()
      expect(trigger.attributes('aria-expanded')).toBe('false')
    } finally {
      wrapper.unmount()
      raf.restore()
    }
  })

  it.each([
    { label: 'LTR narrow', dir: 'ltr', rect: { left: 180, right: 220, width: 40, x: 180 }, expected: { left: '8px' } },
    { label: 'RTL narrow', dir: 'rtl', rect: { left: 30, right: 70, width: 40, x: 30 }, expected: { right: '8px' } },
  ])('clamps the dialog menu inside the dialog with 8px gutters: $label', async ({ dir, rect, expected }) => {
    const previousDir = document.documentElement.dir
    document.documentElement.dir = dir
    const dialogRect = { left: 20, right: 260, width: 240, top: 40, bottom: 640, height: 600 }
    const { wrapper, dialog } = await attachDialogSelector({}, {
      rect: { ...TRIGGER_RECT, ...rect }, dialogRect, drawerRect: DRAWER_RECT,
    })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = dialog.querySelector('.ti-provider-dropdown-menu')
      expect(menu.style.width).toBe('220px')
      expect(menu.style.left).toBe(expected.left ?? 'auto')
      expect(menu.style.right).toBe(expected.right ?? 'auto')
      // Reconstruct viewport-space bounds and assert 8px dialog gutters.
      const menuWidth = 220
      const left = menu.style.left !== 'auto'
        ? dialogRect.left + Number.parseFloat(menu.style.left)
        : dialogRect.right - Number.parseFloat(menu.style.right) - menuWidth
      expect(left).toBeGreaterThanOrEqual(dialogRect.left + 8)
      expect(left + menuWidth).toBeLessThanOrEqual(dialogRect.right - 8)
    } finally {
      wrapper.unmount()
      dialog.remove()
      document.documentElement.dir = previousDir
    }
  })

  it('places the dialog menu above the trigger with dialog-relative bottom coordinates when placement is up', async () => {
    const { wrapper, dialog } = await attachDialogSelector({ placement: 'up' }, {
      rect: TRIGGER_RECT, dialogRect: DIALOG_RECT,
    })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = dialog.querySelector('.ti-provider-dropdown-menu')
      expect(menu.style.position).toBe('absolute')
      // dialog height 600 − (trigger top 60 − dialog top 40) + 4 → 584 (viewport math would say 712).
      expect(menu.style.bottom).toBe('584px')
      expect(menu.style.top).toBe('auto')
      expect(menu.style.left).toBe('20px')
    } finally {
      wrapper.unmount()
      dialog.remove()
    }
  })

  it('repositions the dialog menu on window resize using the fresh dialog-relative frame', async () => {
    const raf = stubAnimationFrames()
    const { wrapper, dialog } = await attachDialogSelector({}, {
      rect: TRIGGER_RECT, dialogRect: DIALOG_RECT,
    })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = dialog.querySelector('.ti-provider-dropdown-menu')
      expect(menu.style.top).toBe('64px')

      const anchor = wrapper.element.querySelector('.ti-provider-button-container')
      vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
        ...TRIGGER_RECT, top: 90, bottom: 130, y: 90,
      })
      window.dispatchEvent(new Event('resize'))
      expect(raf.frames.size).toBe(1)
      raf.flush()
      await wrapper.vm.$nextTick()
      // Trigger bottom 130 − dialog top 40 + 4 → 94.
      expect(menu.style.top).toBe('94px')
      // Menu stays dialog-owned after resize, never moved to body.
      expect(dialog.querySelector('.ti-provider-dropdown-menu')).toBe(menu)
    } finally {
      wrapper.unmount()
      dialog.remove()
      raf.restore()
    }
  })

  it.each([
    { label: 'visible: coalesces and repositions', movedLeft: 30 },
    { label: 'invisible: closes silently', movedBelow: 620 },
  ])('keeps drawer-body scroll behavior for the dialog menu: $label', async ({ movedLeft, movedBelow }) => {
    const raf = stubAnimationFrames()
    const { wrapper, dialog, drawerBody } = await attachDialogSelector({}, {
      rect: TRIGGER_RECT, dialogRect: DIALOG_RECT, drawerRect: DRAWER_RECT,
    })
    try {
      const anchor = wrapper.element.querySelector('.ti-provider-button-container')
      const triggerEl = wrapper.element.querySelector('.ti-provider-button')
      const moved = movedBelow
        ? { ...TRIGGER_RECT, top: movedBelow, bottom: movedBelow + 40, y: movedBelow }
        : { ...TRIGGER_RECT, left: movedLeft, right: TRIGGER_RECT.right - 10, x: movedLeft }
      // Both the container (position source) and the trigger (visibility
      // source) report the moved geometry for the scroll frame.
      for (const element of [anchor, triggerEl]) {
        vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(moved)
      }
      await wrapper.find('.ti-provider-button').trigger('click')
      const menu = dialog.querySelector('.ti-provider-dropdown-menu')
      expect(menu).toBeTruthy()
      expect(trackedListeners.some(({ target, event }) => target === drawerBody && event === 'scroll')).toBe(true)
      expect(trackedListeners.some(({ target, event }) => target === window && event === 'scroll')).toBe(false)

      drawerBody.dispatchEvent(new Event('scroll'))
      expect(raf.frames.size).toBe(1)
      raf.flush()
      await wrapper.vm.$nextTick()
      if (movedBelow) {
        expect(document.body.querySelector('.ti-provider-dropdown-menu')).toBeNull()
      } else {
        // Trigger now starts 10px inside the dialog → menu inset 10px.
        expect(dialog.querySelector('.ti-provider-dropdown-menu')).toBe(menu)
        expect(menu.style.left).toBe(`${movedLeft - 20}px`)
      }
    } finally {
      wrapper.unmount()
      dialog.remove()
      raf.restore()
    }
  })

  it('cleans up on unmount: cancels pending drawer RAF, removes listeners, and removes the dialog menu', async () => {
    const raf = stubAnimationFrames()
    const { wrapper, dialog, drawerBody } = await attachDialogSelector({}, {
      rect: TRIGGER_RECT, dialogRect: DIALOG_RECT, drawerRect: DRAWER_RECT,
    })
    try {
      await wrapper.find('.ti-provider-button').trigger('click')
      expect(dialog.querySelector('.ti-provider-dropdown-menu')).toBeTruthy()
      drawerBody.dispatchEvent(new Event('scroll'))
      expect(raf.frames.size).toBe(1)
      const [frameId] = raf.frames.keys()
      expect(trackedListeners.some(({ target, event }) => target === drawerBody && event === 'scroll')).toBe(true)
      wrapper.unmount()
      expect(raf.cancelled).toContain(frameId)
      expect(raf.frames.size).toBe(0)
      expect(trackedListeners.some(({ target, event }) => target === drawerBody && event === 'scroll')).toBe(false)
      expect(dialog.querySelector('.ti-provider-dropdown-menu')).toBeNull()
      // Listener is really removed: scoped to the drawer body, the re-dispatch schedules nothing.
      drawerBody.dispatchEvent(new Event('scroll'))
      expect(raf.frames.size).toBe(0)
    } finally {
      dialog.remove()
      raf.restore()
    }
  })
})

describe('ProviderSelector collapsible category groups', () => {
  beforeEach(() => {
    registry.providers = providers.map((provider) => ({ ...provider }))
    Object.assign(settingsStore.settings, {
      TRANSLATION_API: 'googlev2', DEBUG_MODE: false, HIDDEN_PROVIDERS: [],
      CUSTOM_PROVIDER_LIST_ENABLED: false, CUSTOM_PROVIDER_LIST: [],
      COLLAPSED_PROVIDER_CATEGORIES: [],
    })
    makeCollapseStore()
    settingsStore.updateSettingAndPersist.mockReset()
    openOptionsPage.mockReset()
    Object.assign(translationStore.ephemeralSync, { page: false, element: false })
    translationStore.selectedProvider = null
    deactivateSelectMode.mockReset()
    selectMode.active = false
    extensionContext.isContentScript = false
    errorHandler.handleError.mockReset()
  })

  const openMenu = async (wrapper) => {
    const anchor = wrapper.find('.ti-provider-button-container')
    vi.spyOn(anchor.element, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 100, right: 300, bottom: 50, width: 200, height: 40, x: 100, y: 10,
    })
    await wrapper.find('.ti-provider-button').trigger('click')
    return wrapper.find('.ti-provider-dropdown-menu')
  }

  // Deterministic flush for promise reactions + Vue watcher/render queues.
  const flushReactions = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  // Real-teleport open helper: mocks the anchor rect, opens the menu, and
  // settles the open-time focus move across two flushes.
  const openRealMenu = async (wrapper, rect = {}) => {
    const anchor = wrapper.element.querySelector('.ti-provider-button-container')
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      top: 10, left: 100, right: 300, bottom: 50, width: 200, height: 40, x: 100, y: 10,
      ...rect,
    })
    await wrapper.find('.ti-provider-button').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
  }

  // Steps real-focus down one row per call (double-flush discipline mirrors
  // the component's post-render focus move).
  const arrowDown = async (wrapper) => {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
  }

  // Shadow-root variant: dispatch from the root's own activeElement (the
  // document-level activeElement is the host when focus lives in a ShadowRoot).
  const shadowArrowDown = async (wrapper, shadowRoot) => {
    shadowRoot.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
  }

  it.each([
    { label: 'Document', shadow: false },
    { label: 'ShadowRoot', shadow: true },
  ])('selects the actually focused row after pointer hover in $label menus for Enter and Space', async ({ shadow }) => {
    for (const key of ['Enter', ' ']) {
      const { wrapper, container, shadowRoot } = await attachSelector(
        { mode: 'button', modelValue: 'googlev2' }, { realTeleport: true, shadow },
      )
      try {
        await openRealMenu(wrapper)
        const root = shadowRoot ?? document
        const button = (name) => Array.from(root.querySelectorAll('.ti-dropdown-item-btn'))
          .find((candidate) => candidate.textContent.trim() === name)
        const focusedButton = button('DeepL')
        focusedButton.focus()
        button('Browser').closest('.ti-dropdown-item').dispatchEvent(new MouseEvent('mouseenter'))
        await wrapper.vm.$nextTick()
        expect(wrapper.vm.$.setupState.focusedIndex).toBe(1)
        expect(wrapper.vm.$.setupState.pointerIndex).toBe(5)

        focusedButton.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        await wrapper.vm.$nextTick()
        expect(wrapper.emitted('provider-change')?.at(-1)).toEqual(['deepl'])
      } finally {
        wrapper.unmount()
        container.remove()
      }
    }
  })

  it.each([
    { label: 'Document', shadow: false },
    { label: 'ShadowRoot', shadow: true },
  ])('continues arrows from the real focused row after pointer hover in $label menus', async ({ shadow }) => {
    const { wrapper, container, shadowRoot } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' }, { realTeleport: true, shadow },
    )
    try {
      await openRealMenu(wrapper)
      const root = shadowRoot ?? document
      const button = (name) => Array.from(root.querySelectorAll('.ti-dropdown-item-btn'))
        .find((candidate) => candidate.textContent.trim() === name)
      const focusedButton = button('OpenAI')
      focusedButton.focus()
      button('Google').closest('.ti-dropdown-item').dispatchEvent(new MouseEvent('mouseenter'))
      await wrapper.vm.$nextTick()

      focusedButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(root.activeElement.textContent.trim()).toBe('Gemini')
      root.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(root.activeElement.textContent.trim()).toBe('OpenAI')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it.each([
    { label: 'pointer from above', focused: 'OpenAI', focusedIndex: 3, pointer: 'Google', next: 'Gemini' },
    { label: 'pointer from below', focused: 'Google', focusedIndex: 0, pointer: 'Browser', next: 'DeepL' },
    { label: 'pointer between categories', focused: 'DeepL', focusedIndex: 1, pointer: 'Gemini', next: 'Unconfigured' },
  ])('header pointer entry clears stale row hover and preserves keyboard focus ($label)', async ({ focused, focusedIndex, pointer, next }) => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      await openRealMenu(wrapper)
      const providerButton = (name) => Array.from(document.body.querySelectorAll('.ti-dropdown-item-btn'))
        .find((button) => button.textContent.trim() === name)
      const focusedButton = providerButton(focused)
      const pointerRow = providerButton(pointer).closest('.ti-dropdown-item')
      focusedButton.focus()
      pointerRow.dispatchEvent(new MouseEvent('mouseenter'))
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(focusedIndex)
      expect(wrapper.vm.$.setupState.pointerIndex).toBe(
        ['Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser'].indexOf(pointer),
      )
      expect(pointerRow.classList.contains('is-focused')).toBe(true)

      const header = document.body.querySelector('.ti-dropdown-group-header')
      header.dispatchEvent(new MouseEvent('mouseenter'))
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(focusedButton)
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(focusedIndex)
      expect(document.body.querySelectorAll('.ti-dropdown-item.is-focused')).toHaveLength(0)
      expect(pointerRow.classList.contains('is-focused')).toBe(false)
      const selectedRow = providerButton('Google').closest('.ti-dropdown-item')
      expect(selectedRow.classList.contains('ti-active')).toBe(true)

      await arrowDown(wrapper)
      expect(document.activeElement.textContent.trim()).toBe(next)
      expect(document.activeElement.closest('.ti-dropdown-item').classList.contains('is-focused')).toBe(true)
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('provider-change')?.at(-1)).toEqual([next.toLowerCase() === 'google' ? 'googlev2' : next.toLowerCase()])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it.each([
    { direction: 'above', pointer: 'Google' },
    { direction: 'below', pointer: 'Browser' },
  ])('header pointer entry clears row-only highlight when real focus is on the header (from $direction)', async ({ pointer }) => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      await openRealMenu(wrapper)
      const menu = document.body.querySelector('.ti-provider-dropdown-menu')
      const aiHeader = Array.from(menu.querySelectorAll('.ti-dropdown-group-header'))
        .find((header) => header.textContent.trim() === 'AI')
      aiHeader.focus()
      expect(document.activeElement).toBe(aiHeader)

      const pointerRow = Array.from(menu.querySelectorAll('.ti-dropdown-item'))
        .find((row) => row.textContent.trim().includes(pointer))
      pointerRow.dispatchEvent(new MouseEvent('mouseenter'))
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.$.setupState.pointerIndex).toBeGreaterThanOrEqual(0)
      expect(pointerRow.classList.contains('is-focused')).toBe(true)

      aiHeader.dispatchEvent(new MouseEvent('mouseenter'))
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(aiHeader)
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(-1)
      expect(menu.querySelectorAll('.ti-dropdown-item.is-focused')).toHaveLength(0)

      // From header focus with no pointer-highlighted row, ArrowDown still
      // starts at the first visible provider and moves real focus into the list.
      aiHeader.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(document.activeElement.classList.contains('ti-dropdown-item-btn')).toBe(true)
      expect(document.activeElement.textContent.trim()).toBe('Google')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('header hover hides the auto-focused row highlight without clearing selected state or keyboard origin', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      await openRealMenu(wrapper)
      const selectedButton = document.activeElement
      expect(selectedButton.textContent.trim()).toBe('Google')
      expect(selectedButton.closest('.ti-dropdown-item').classList.contains('ti-active')).toBe(true)

      const browserRow = Array.from(document.body.querySelectorAll('.ti-dropdown-item'))
        .find((row) => row.textContent.trim() === 'Browser')
      browserRow.dispatchEvent(new MouseEvent('mouseenter'))
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.$.setupState.pointerIndex).toBe(5)

      document.body.querySelector('.ti-dropdown-group-header')
        .dispatchEvent(new MouseEvent('mouseenter'))
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(selectedButton)
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(0)
      expect(document.body.querySelectorAll('.ti-dropdown-item.is-focused')).toHaveLength(0)
      expect(selectedButton.closest('.ti-dropdown-item').classList.contains('ti-active')).toBe(true)

      await arrowDown(wrapper)
      expect(document.activeElement.textContent.trim()).toBe('DeepL')
      expect(document.activeElement.closest('.ti-dropdown-item').classList.contains('is-focused')).toBe(true)
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(document.activeElement.textContent.trim()).toBe('Google')
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(0)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('header pointer entry restores the real focused row inside a ShadowRoot menu', async () => {
    const { wrapper, container, shadowRoot } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' }, { realTeleport: true, shadow: true },
    )
    try {
      await openRealMenu(wrapper)
      const providerButton = (name) => Array.from(shadowRoot.querySelectorAll('.ti-dropdown-item-btn'))
        .find((button) => button.textContent.trim() === name)
      const openAiButton = providerButton('OpenAI')
      openAiButton.focus()
      providerButton('Browser').closest('.ti-dropdown-item').dispatchEvent(new MouseEvent('mouseenter'))
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.$.setupState.pointerIndex).toBe(5)

      shadowRoot.querySelector('.ti-dropdown-group-header').dispatchEvent(new MouseEvent('mouseenter'))
      await wrapper.vm.$nextTick()
      expect(shadowRoot.activeElement).toBe(openAiButton)
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(3)
      expect(shadowRoot.querySelectorAll('.ti-dropdown-item.is-focused')).toHaveLength(0)
      expect(providerButton('Browser').closest('.ti-dropdown-item').classList.contains('is-focused')).toBe(false)

      await shadowArrowDown(wrapper, shadowRoot)
      expect(shadowRoot.activeElement?.textContent.trim()).toBe('Gemini')
      shadowRoot.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(shadowRoot.activeElement?.textContent.trim()).toBe('OpenAI')
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(3)
      await shadowArrowDown(wrapper, shadowRoot)
      expect(shadowRoot.activeElement?.textContent.trim()).toBe('Gemini')
      expect(shadowRoot.activeElement.closest('.ti-dropdown-item').classList.contains('is-focused')).toBe(true)
      shadowRoot.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('provider-change')).toEqual([['gemini']])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('category header styles keep hover transparent and reveal a subtle chevron only for interaction/touch', () => {
    const headerRule = providerSelectorScss.match(/\.ti-dropdown-group-header\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const chevronRule = providerSelectorScss.match(/^\.ti-provider-chevron\s*\{([\s\S]*?)\n\}/m)?.[1] ?? ''
    expect(headerRule).toContain('background: transparent !important;')
    expect(headerRule.match(/background: transparent !important;/g)).toHaveLength(2)
    expect(headerRule).toContain('&:hover')
    expect(headerRule).toContain('color: var(--color-text-secondary);')
    expect(headerRule).toContain('outline: 2px solid var(--color-primary) !important;')
    expect(chevronRule).toContain('opacity: 0;')
    expect(chevronRule).toContain('transform: rotate(180deg);')
    expect(providerSelectorScss).toMatch(/&:hover \.ti-provider-chevron,[\s\S]*?&:focus-visible \.ti-provider-chevron\s*\{\s*opacity:\s*1;/)
    expect(providerSelectorScss).toMatch(/@media \(hover: none\)[\s\S]*?\.ti-provider-chevron\s*\{\s*opacity:\s*1;/)
    expect(providerSelectorScss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ti-provider-chevron\s*\{\s*transition:\s*none;/)
  })

  it('renders accessible disclosure headers with unique IDs, expand state, and chevron', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const menu = await openMenu(wrapper)
      const headers = menu.findAll('.ti-dropdown-group-header')
      expect(headers.map((header) => header.text().trim())).toEqual(['Traditional', 'AI', 'Other'])
      const headerIds = headers.map((header) => header.attributes('id'))
      expect(headerIds.every(Boolean)).toBe(true)
      expect(new Set(headerIds).size).toBe(headerIds.length)
      headers.forEach((header) => {
        expect(header.attributes('aria-expanded')).toBe('true')
        const rowsId = header.attributes('aria-controls')
        expect(rowsId).toBeTruthy()
        const rows = menu.findAll(`[id="${rowsId}"] .ti-dropdown-item`)
        expect(rows.length).toBeGreaterThan(0)
        expect(header.find('.ti-provider-chevron').exists()).toBe(true)
      })
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('collapses a category on header click: rows withdraw, header persists, store persists the stable ID', async () => {    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const menu = await openMenu(wrapper)
      const [traditional] = menu.findAll('.ti-dropdown-group-header')
      expect(traditional.attributes('aria-expanded')).toBe('true')

      await traditional.trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(settingsStore.setProviderCategoryCollapsed).toHaveBeenCalledWith('free', true)
      expect(settingsStore.settings.COLLAPSED_PROVIDER_CATEGORIES.ids).toEqual(['free'])

      // Header persists while visible; rows of the collapsed group withdraw
      // and later groups keep order. The open menu re-renders in place.
      const traditionalAfter = wrapper.findAll('.ti-dropdown-group-header')
        .find((header) => header.text().trim() === 'Traditional')
      expect(traditionalAfter.exists()).toBe(true)
      expect(traditionalAfter.attributes('aria-expanded')).toBe('false')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual(['OpenAI', 'Gemini', 'Browser'])

      await traditionalAfter.trigger('click')
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(settingsStore.setProviderCategoryCollapsed).toHaveBeenCalledWith('free', false)
      expect(settingsStore.settings.COLLAPSED_PROVIDER_CATEGORIES.ids).toEqual([])
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('shares persisted category collapse state between mounted selectors', async () => {
    const first = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    const second = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const firstMenu = await openMenu(first.wrapper)
      const firstTraditional = firstMenu.findAll('.ti-dropdown-group-header')
        .find((header) => header.text().trim() === 'Traditional')
      await firstTraditional.trigger('click')
      await first.wrapper.vm.$nextTick()
      await second.wrapper.vm.$nextTick()
      await flushReactions()
      await second.wrapper.vm.$nextTick()

      const secondMenu = await openMenu(second.wrapper)
      const secondTraditional = secondMenu.findAll('.ti-dropdown-group-header')
        .find((header) => header.text().trim() === 'Traditional')
      expect(secondTraditional.attributes('aria-expanded')).toBe('false')
      expect(secondMenu.findAll('.ti-dropdown-item').map((item) => item.text().trim()))
        .not.toContain('Google')

      await secondTraditional.trigger('click')
      await second.wrapper.vm.$nextTick()
      await flushReactions()

      const reopenedFirstMenu = await openMenu(first.wrapper)
      const firstTraditionalAfter = reopenedFirstMenu.findAll('.ti-dropdown-group-header')
        .find((header) => header.text().trim() === 'Traditional')
      expect(firstTraditionalAfter.attributes('aria-expanded')).toBe('true')
      expect(reopenedFirstMenu.findAll('.ti-dropdown-item').map((item) => item.text().trim()))
        .toContain('Google')
    } finally {
      first.wrapper.unmount()
      first.container.remove()
      second.wrapper.unmount()
      second.container.remove()
    }
  })

  it('applies the versioned persisted shape and star/sync controls keep working around collapsed groups', async () => {
    Object.assign(settingsStore.settings, {
      COLLAPSED_PROVIDER_CATEGORIES: { ids: ['free'], revision: 2 },
    })
    const { wrapper, container } = await attachSelector({
      mode: 'button', modelValue: 'googlev2', allowDefault: true, allowSetDefault: true, isGlobal: false, showSync: true,
    })
    try {
      const menu = await openMenu(wrapper)
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Default', 'OpenAI', 'Gemini', 'Browser',
      ])
      // Default entry remains visible and carries no disclosure header.
      const headers = menu.findAll('.ti-dropdown-group-header').map((header) => header.text().trim())
      expect(headers).toEqual(['Traditional', 'AI', 'Other'])
      // Star and sync stay functional with collapsed categories (the Default
      // row also carries a star; target the OpenAI row's own star).
      const openAiRow = wrapper.findAll('.ti-dropdown-item')
        .find((item) => item.text().trim().includes('OpenAI'))
      await openAiRow.find('.ti-set-default-btn').trigger('click')
      expect(settingsStore.updateSettingAndPersist).toHaveBeenCalledWith('TRANSLATION_API', 'openai')
      // The star action dismissed the menu; reopen for the sync row check.
      const reOpenedTrigger = wrapper.find('.ti-provider-button')
      await reOpenedTrigger.trigger('click')
      await wrapper.vm.$nextTick()
      const syncRow = wrapper.findAll('.ti-sync-row').at(0)
      await syncRow.trigger('click')
      expect(translationStore.ephemeralSync.page).toBe(true)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('custom list groups collapse under their stable ID and disabled custom list yields no header', async () => {
    Object.assign(settingsStore.settings, {
      CUSTOM_PROVIDER_LIST_ENABLED: true,
      CUSTOM_PROVIDER_LIST: ['gemini'],
      COLLAPSED_PROVIDER_CATEGORIES: [],
    })
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const menu = await openMenu(wrapper)
      const [customHeader] = menu.findAll('.ti-dropdown-group-header')
      expect(menu.findAll('.ti-dropdown-group-header').map((header) => header.text().trim())).toEqual(['Custom List', 'Traditional', 'AI', 'Other'])

      await customHeader.trigger('click')
      await wrapper.vm.$nextTick()
      expect(settingsStore.setProviderCategoryCollapsed).toHaveBeenCalledWith('custom-list', true)
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Browser',
      ])
    } finally {
      wrapper.unmount()
      container.remove()
    }

    Object.assign(settingsStore.settings, { CUSTOM_PROVIDER_LIST_ENABLED: false, CUSTOM_PROVIDER_LIST: [] })
    const flat = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const flatMenu = await openMenu(flat.wrapper)
      // Still grouped by category (threshold unchanged) but no Custom List
      // header; a stale collapsed custom-list ID hides nothing.
      const flatHeaders = flatMenu.findAll('.ti-dropdown-group-header').map((header) => header.text().trim())
      expect(flatHeaders).toEqual(['Traditional', 'AI', 'Other'])
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['custom-list'] })
      expect(flat.wrapper.vm.$.setupState.visibleGroups.length).toBe(3)
      expect(flat.wrapper.vm.$.setupState.menuItems).toHaveLength(6)
      expect(flatMenu.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
    } finally {
      flat.wrapper.unmount()
      flat.container.remove()
    }
  })

  it('keyboard navigation walks visible rows only and Enter selects in the reshaped order', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      await openMenu(wrapper)
      // Collapse the first group via its header (pending intent applies
      // immediately), then close and re-open the menu.
      const [traditional] = wrapper.findAll('.ti-dropdown-group-header')
      await traditional.trigger('click')
      await wrapper.vm.$nextTick()

      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('click') // close
      await wrapper.find('.ti-provider-button').trigger('click') // re-open
      await wrapper.vm.$nextTick()
      const keyOnFocusedControl = async (key) => {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
        await wrapper.vm.$nextTick()
      }
      // Selected provider is hidden inside the collapsed group: focus starts
      // on the first visible row (OpenAI) and stays contiguously ordered.
      expect(document.activeElement.textContent).toContain('OpenAI')
      await keyOnFocusedControl('ArrowDown')
      await keyOnFocusedControl('Enter')
      expect(wrapper.emitted('provider-change')).toEqual([['gemini']])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  // Uses the real teleported menu (production path) so nodes persist across
  // the collapse re-render, as in the browser.
  it('collapsing a group that holds real focus moves focus to its header button', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      const anchor = wrapper.element.querySelector('.ti-provider-button-container')
      vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
        top: 10, left: 100, right: 300, bottom: 50, width: 200, height: 40, x: 100, y: 10,
      })
      await wrapper.find('.ti-provider-button').trigger('click')
      // Opening placed real focus on the first row (inside Traditional).
      const firstRowButton = document.activeElement
      expect(firstRowButton.textContent).toContain('Google')

      const header = document.body.querySelectorAll('.ti-dropdown-group-header')[0]
      header.click()
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(header.isConnected).toBe(true)
      expect(document.activeElement).toBe(header)
      expect(header.getAttribute('aria-expanded')).toBe('false')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  // Uses the real teleported menu (production path) so row DOM nodes persist
  // across the expansion re-render, as in the browser.
  it('expanding above a later focused row keeps real focus and shifts its index correctly', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      const anchor = wrapper.element.querySelector('.ti-provider-button-container')
      vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
        top: 10, left: 100, right: 300, bottom: 50, width: 200, height: 40, x: 100, y: 10,
      })
      await wrapper.find('.ti-provider-button').trigger('click')
      // Collapse Traditional via its header.
      document.body.querySelectorAll('.ti-dropdown-group-header')[0].click()
      await wrapper.vm.$nextTick()
      expect(Array.from(document.body.querySelectorAll('.ti-dropdown-item'), (item) => item.textContent.trim()))
        .toEqual(['OpenAI', 'Gemini', 'Browser'])

      const trigger = wrapper.find('.ti-provider-button')
      await trigger.trigger('click') // close
      await trigger.trigger('click') // re-open
      await wrapper.vm.$nextTick()
      // Real focus starts on OpenAI (first visible row, AI group below the
      // collapsed Traditional group).
      const openAiBtn = document.activeElement
      expect(document.activeElement.textContent).toContain('OpenAI')

      // Expand Traditional: rows re-inserted above OpenAI; the focused row's
      // index must shift so OpenAI stays index 3 (menuItems visible rows).
      Array.from(document.body.querySelectorAll('.ti-dropdown-group-header'))
        .find((header) => header.textContent.trim() === 'Traditional')
        .click()
      await wrapper.vm.$nextTick()
      expect(openAiBtn.isConnected).toBe(true)
      expect(document.activeElement).toBe(openAiBtn)
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(3)

      // From the row, ArrowDown moves to the row right after OpenAI: Gemini.
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(document.activeElement.textContent).toContain('Gemini')
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('provider-change')).toEqual([['gemini']])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('persistence failure reverts the pending intent and surfaces through handleError', async () => {
    makeCollapseStore(async () => { throw new Error('persist failed') })
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const menu = await openMenu(wrapper)
      const [traditional] = menu.findAll('.ti-dropdown-group-header')
      await traditional.trigger('click')
      // Pending intent flips the view immediately, ahead of persistence.
      const traditionalPending = wrapper.findAll('.ti-dropdown-group-header')
        .find((header) => header.text().trim() === 'Traditional')
      expect(traditionalPending.attributes('aria-expanded')).toBe('false')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual(['OpenAI', 'Gemini', 'Browser'])

      await new Promise((resolve) => setTimeout(resolve, 0))
      await wrapper.vm.$nextTick()
      // Store rejected without reacting: pending intent unwinds, display reverts.
      const traditionalReverted = wrapper.findAll('.ti-dropdown-group-header')
        .find((header) => header.text().trim() === 'Traditional')
      expect(traditionalReverted.attributes('aria-expanded')).toBe('true')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
      expect(settingsStore.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual([])
      expect(errorHandler.handleError).toHaveBeenCalledTimes(1)
      expect(errorHandler.handleError).toHaveBeenCalledWith(expect.any(Error), 'provider-selector-toggle-collapse')
    } finally {
      wrapper.unmount()
      container.remove()
      makeCollapseStore()
    }
  })

  it('rapid toggles before persistence resolves queue fresh opposite intents deterministically', async () => {
    // Deferred control: promises resolve only on demand; authoritative state
    // lands manually as the lane's storage event would.
    const deferredActions = []
    makeCollapseStore((categoryId, collapsed) => new Promise((resolve, reject) => {
      deferredActions.push({ categoryId, collapsed, resolve, reject })
    }))
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const menu = await openMenu(wrapper)
      let traditional = menu.findAll('.ti-dropdown-group-header')[0]

      await traditional.trigger('click')
      await wrapper.vm.$nextTick()
      traditional = wrapper.findAll('.ti-dropdown-group-header')[0]
      // Pending intent: collapsed instantly, even though nothing persisted yet.
      expect(traditional.attributes('aria-expanded')).toBe('false')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual(['OpenAI', 'Gemini', 'Browser'])
      expect(settingsStore.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual([])

      // Second rapid click still flips the view to expanded (new intent), and
      // the store stays untouched until authoritative events land.
      await traditional.trigger('click')
      await wrapper.vm.$nextTick()
      traditional = wrapper.findAll('.ti-dropdown-group-header')[0]
      expect(traditional.attributes('aria-expanded')).toBe('true')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
      expect(deferredActions.map((action) => [action.categoryId, action.collapsed])).toEqual([['free', true], ['free', false]])
      expect(settingsStore.settings.COLLAPSED_PROVIDER_CATEGORIES).toEqual([])

      // Stale first persistence resolves; the authoritative event toggling 'free'
      // on must NOT override the newer expanding intent (display stays expanded).
      deferredActions[0].resolve()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: { ids: ['free'], revision: 1 } })
      await wrapper.vm.$nextTick()
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])

      // Newest persistence resolves; the authoritative state agrees with the
      // pending intent and the reconciliation watch clears it.
      deferredActions[1].resolve()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: { ids: [], revision: 2 } })
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
      expect(settingsStore.settings.COLLAPSED_PROVIDER_CATEGORIES.revision).toBe(2)
    } finally {
      wrapper.unmount()
      container.remove()
      makeCollapseStore()
    }
  })

  it('keeps the header aria-controls target mounted (visible and collapsed) without rendering rows when collapsed', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const menu = await openMenu(wrapper)
      const traditional = menu.findAll('.ti-dropdown-group-header')[0]
      const rowsId = traditional.attributes('aria-controls')
      expect(rowsId).toBeTruthy()
      expect(menu.find(`[id="${rowsId}"]`).findAll('.ti-dropdown-item')).toHaveLength(3)

      await traditional.trigger('click')
      await wrapper.vm.$nextTick()
      // Whole menu re-query after the collapse render.
      const collapsedMenu = wrapper.find('.ti-provider-dropdown-menu')
      const collapsedHeader = collapsedMenu.findAll('.ti-dropdown-group-header')[0]
      expect(collapsedHeader.attributes('aria-expanded')).toBe('false')
      expect(collapsedHeader.attributes('aria-controls')).toBe(rowsId)
      const target = collapsedMenu.find(`[id="${rowsId}"]`)
      expect(target.exists()).toBe(true)
      expect(target.findAll('.ti-dropdown-item')).toHaveLength(0)
      expect(target.findAll('.ti-dropdown-item-btn')).toHaveLength(0)
      expect(target.findAll('button')).toHaveLength(0)
      // Expanded again: the same stable target resolves the rows.
      await collapsedHeader.trigger('click')
      await wrapper.vm.$nextTick()
      const expandedMenu = wrapper.find('.ti-provider-dropdown-menu')
      expect(expandedMenu.find(`[id="${rowsId}"]`).findAll('.ti-dropdown-item')).toHaveLength(3)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('Escape on a category header closes an all-collapsed zero-rows menu and restores trigger focus', async () => {
    Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free', 'ai', 'local'] })
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const menu = await openMenu(wrapper)
      expect(menu.findAll('.ti-dropdown-group-header').map((header) => header.text().trim())).toEqual(['Traditional', 'AI', 'Other'])
      expect(menu.findAll('.ti-dropdown-item')).toHaveLength(0)

      const header = menu.findAll('.ti-dropdown-group-header')[0]
      header.element.focus()
      header.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.ti-provider-dropdown-menu').exists()).toBe(false)
      expect(document.activeElement).toBe(wrapper.find('.ti-provider-button').element)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('deferred rapid toggles: earlier acks and failures never clear the latest pending intent', async () => {
    const deferredActions = []
    makeCollapseStore((categoryId, collapsed) => new Promise((resolve, reject) => {
      deferredActions.push({ categoryId, collapsed, resolve, reject })
    }))
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const menu = await openMenu(wrapper)
      const traditional = menu.findAll('.ti-dropdown-group-header')[0]
      await traditional.trigger('click')
      await traditional.trigger('click')
      await traditional.trigger('click')
      await wrapper.vm.$nextTick()
      // A(true) → B(false) → C(true): display follows the latest intent (collapsed).
      expect(deferredActions.map((action) => [action.categoryId, action.collapsed])).toEqual([['free', true], ['free', false], ['free', true]])
      let currentTraditional = wrapper.findAll('.ti-dropdown-group-header')[0]
      expect(currentTraditional.attributes('aria-expanded')).toBe('false')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual(['OpenAI', 'Gemini', 'Browser'])

      // A (earlier) FAILS: intent C survives, display stays collapsed.
      deferredActions[0].reject(new Error('A failed'))
      await flushReactions()
      await wrapper.vm.$nextTick()
      currentTraditional = wrapper.findAll('.ti-dropdown-group-header')[0]
      expect(currentTraditional.attributes('aria-expanded')).toBe('false')
      expect(errorHandler.handleError).toHaveBeenCalledTimes(1)

      // B (superseded) acks false: transient authoritative expansion must not
      // flip the view while C is still pending.
      deferredActions[1].resolve()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: { ids: [], revision: 2 } })
      await flushReactions()
      await wrapper.vm.$nextTick()
      currentTraditional = wrapper.findAll('.ti-dropdown-group-header')[0]
      expect(currentTraditional.attributes('aria-expanded')).toBe('false')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual(['OpenAI', 'Gemini', 'Browser'])

      // C (latest) succeeds: intent cleared, view reconciles to the store.
      deferredActions[2].resolve()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: { ids: ['free'], revision: 3 } })
      await flushReactions()
      await wrapper.vm.$nextTick()
      currentTraditional = wrapper.findAll('.ti-dropdown-group-header')[0]
      expect(currentTraditional.attributes('aria-expanded')).toBe('false')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual(['OpenAI', 'Gemini', 'Browser'])
      expect(errorHandler.handleError).toHaveBeenCalledTimes(1)
    } finally {
      wrapper.unmount()
      container.remove()
      makeCollapseStore()
    }
  })

  it('deferred failure of the latest request reverts the display; later superseded acks reconcile the store', async () => {
    const deferredActions = []
    makeCollapseStore((categoryId, collapsed) => new Promise((resolve, reject) => {
      deferredActions.push({ categoryId, collapsed, resolve, reject })
    }))
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const menu = await openMenu(wrapper)
      const traditional = menu.findAll('.ti-dropdown-group-header')[0]
      await traditional.trigger('click')
      await traditional.trigger('click')
      await traditional.trigger('click')
      await wrapper.vm.$nextTick()
      expect(deferredActions).toHaveLength(3)

      // C (latest) FAILS first: display reverts to the store (expanded), and
      // the failure surfaces through handleError.
      deferredActions[2].reject(new Error('C failed'))
      await flushReactions()
      await wrapper.vm.$nextTick()
      let currentTraditional = wrapper.findAll('.ti-dropdown-group-header')[0]
      expect(currentTraditional.attributes('aria-expanded')).toBe('true')
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
      expect(errorHandler.handleError).toHaveBeenCalledTimes(1)

      // Superseded A now acks: completion passed, so the authoritative state
      // drives the display (collapsed again).
      deferredActions[0].resolve()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: { ids: ['free'], revision: 1 } })
      await flushReactions()
      await wrapper.vm.$nextTick()
      currentTraditional = wrapper.findAll('.ti-dropdown-group-header')[0]
      expect(currentTraditional.attributes('aria-expanded')).toBe('false')

      // Superseded B acks: authoritative expansion wins post-completion.
      deferredActions[1].resolve()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: { ids: [], revision: 2 } })
      await flushReactions()
      await wrapper.vm.$nextTick()
      currentTraditional = wrapper.findAll('.ti-dropdown-group-header')[0]
      expect(wrapper.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
    } finally {
      wrapper.unmount()
      container.remove()
      makeCollapseStore()
    }
  })

  it('external collapse focuses the matching disclosure when the focused row hides', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      await openRealMenu(wrapper)
      await arrowDown(wrapper)
      const deepLBtn = document.activeElement
      expect(deepLBtn.textContent).toContain('DeepL')

      // Authoritative external event (no local request owns it).
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await flushReactions()
      await wrapper.vm.$nextTick()

      expect(wrapper.vm.$.setupState.focusedIndex).toBe(-1)
      const header = document.activeElement
      expect(header.classList.contains('ti-dropdown-group-header')).toBe(true)
      expect(header.textContent).toContain('Traditional')
      expect(header.getAttribute('aria-expanded')).toBe('false')
      expect(Array.from(document.body.querySelectorAll('.ti-dropdown-item'), (item) => item.textContent.trim()))
        .toEqual(['OpenAI', 'Gemini', 'Browser'])

      // Escape from the disclosure restores trigger focus as before.
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(wrapper.find('.ti-provider-button').element)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('external collapse/expand above the focused row preserves real focus and shifts its index', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      await openRealMenu(wrapper)
      await arrowDown(wrapper)
      await arrowDown(wrapper)
      await arrowDown(wrapper)
      const openAiBtn = document.activeElement
      expect(openAiBtn.textContent).toContain('OpenAI')

      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      // Real focus never left the node; the index shifted contiguously.
      expect(document.activeElement).toBe(openAiBtn)
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(0)

      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: [] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(openAiBtn)
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(3)

      // Keyboard continues from the re-anchored position.
      await arrowDown(wrapper)
      expect(document.activeElement.textContent).toContain('Gemini')
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('provider-change')).toEqual([['gemini']])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('post-flush no-steal guard: focus redirected between snapshot and repair survives (footer, header, expanded row)', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      await openRealMenu(wrapper)
      // Walk to DeepL while real focus genuinely sits on the row.
      for (let step = 0; step < 3; step += 1) {
        if (document.activeElement.textContent.includes('DeepL')) break
        await arrowDown(wrapper)
      }
      expect(document.activeElement.textContent).toContain('DeepL')
      // The repair's identity source was recorded at the actual focus event.
      expect(wrapper.vm.$.setupState.rowFocusProviderId).toBe('deepl')
      const deepLBtn = document.activeElement

      // Phase 1 (expanded-row redirect): order the events so the watcher's
      // snapshot runs while the row is focused — mutate, yield exactly one
      // microtask so the flush (snapshot + repair enqueue) completes, THEN
      // redirect to the footer before the queued repair callback executes.
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await Promise.resolve()
      const footer = document.body.querySelector('.ti-configure-row')
      footer.focus()
      await wrapper.vm.$nextTick()
      await flushReactions()
      await wrapper.vm.$nextTick()
      // The withdrawal happened (watcher pipeline definitely ran) ...
      expect(deepLBtn.isConnected).toBe(false)
      expect(Array.from(document.body.querySelectorAll('.ti-dropdown-item'), (item) => item.textContent.trim())).toEqual([
        'OpenAI', 'Gemini', 'Browser',
      ])
      // ... but the repair never moved focus away from the redirected footer.
      expect(document.activeElement).toBe(footer)
      // Without the post-flush guard the repair would have focused the
      // Traditional disclosure instead; neither provider row nor header won.
      expect(document.activeElement.classList.contains('ti-dropdown-group-header')).toBe(false)
      expect(document.activeElement.classList.contains('ti-dropdown-item-btn')).toBe(false)

      // Phase 2 (disclosure redirect): restore the row, re-focus it, mutate,
      // yield one microtask, redirect to a header, let the repair run.
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: [] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      const reFocusedDeepL = Array.from(document.body.querySelectorAll('.ti-dropdown-item-btn'))
        .find((element) => element.textContent.trim() === 'DeepL')
      reFocusedDeepL.focus()
      expect(wrapper.vm.$.setupState.rowFocusProviderId).toBe('deepl')
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await Promise.resolve()
      const aiHeader = Array.from(document.body.querySelectorAll('.ti-dropdown-group-header'))
        .find((element) => element.textContent.trim() === 'AI')
      aiHeader.focus()
      await wrapper.vm.$nextTick()
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(aiHeader)
      expect(Array.from(document.body.querySelectorAll('.ti-dropdown-item'), (item) => item.textContent.trim())).toEqual([
        'OpenAI', 'Gemini', 'Browser',
      ])

      // Phase 3 (surviving row): expanding and re-collapsing above OpenAI
      // must leave that row focused with its updated visible index.
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: [] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      const openAiRow = Array.from(document.body.querySelectorAll('.ti-dropdown-item-btn'))
        .find((element) => element.textContent.trim() === 'OpenAI')
      openAiRow.focus()
      expect(wrapper.vm.$.setupState.rowFocusProviderId).toBe('openai')
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await Promise.resolve()
      openAiRow.focus()
      await wrapper.vm.$nextTick()
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(openAiRow)
      // OpenAI stays the first visible row under AI.
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(0)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('shadow menu: external collapse focused row transfers to its disclosure via root-scoped focus', async () => {
    const { wrapper, container, shadowRoot } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' }, { realTeleport: true, shadow: true },
    )
    try {
      await openRealMenu(wrapper)
      // Walk to DeepL with the shadow root's own activeElement.
      for (let step = 0; step < 3; step += 1) {
        const current = shadowRoot.activeElement
        if (current?.textContent.includes('DeepL')) break
        current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        await wrapper.vm.$nextTick()
        await wrapper.vm.$nextTick()
      }
      const deepLBtn = shadowRoot.activeElement
      expect(deepLBtn?.textContent).toContain('DeepL')

      // Authoritative external change, no local request owns it.
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await flushReactions()
      await wrapper.vm.$nextTick()

      const header = shadowRoot.activeElement
      expect(header?.classList.contains('ti-dropdown-group-header')).toBe(true)
      expect(header?.textContent).toContain('Traditional')
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(-1)
      const menuRoot = shadowRoot.querySelector('.ti-provider-dropdown-menu')
      expect(Array.from(menuRoot.querySelectorAll('.ti-dropdown-item'), (item) => item.textContent.trim()))
        .toEqual(['OpenAI', 'Gemini', 'Browser'])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('shadow menu: external collapse/expand above the focused provider reindexes by identity', async () => {
    const { wrapper, container, shadowRoot } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' }, { realTeleport: true, shadow: true },
    )
    try {
      await openRealMenu(wrapper)
      for (let step = 0; step < 3; step += 1) {
        const current = shadowRoot.activeElement
        if (current?.textContent.includes('OpenAI')) break
        current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        await wrapper.vm.$nextTick()
        await wrapper.vm.$nextTick()
      }
      const openAiBtn = shadowRoot.activeElement
      expect(openAiBtn?.textContent).toContain('OpenAI')

      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(shadowRoot.activeElement).toBe(openAiBtn)
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(0)

      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: [] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(shadowRoot.activeElement).toBe(openAiBtn)
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(3)

      // Arrow navigation continues from the re-anchored position.
      await shadowArrowDown(wrapper, shadowRoot)
      expect(shadowRoot.activeElement?.textContent).toContain('Gemini')
      shadowRoot.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('provider-change')).toEqual([['gemini']])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('shadow menu: post-flush redirects (footer, outside document focus) are never stolen by the repair', async () => {
    const { wrapper, container, shadowRoot } = await attachSelector(
      { mode: 'button', modelValue: 'googlev2' }, { realTeleport: true, shadow: true },
    )
    try {
      await openRealMenu(wrapper)
      // Redirect to the menu footer (Configure Providers) synchronously after
      // the watcher snapshot; the queued repair must not pull focus back out of
      // the footer into any provider row.
      await shadowArrowDown(wrapper, shadowRoot)
      expect(shadowRoot.activeElement?.textContent).toContain('DeepL')
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await Promise.resolve()
      const footer = shadowRoot.querySelector('.ti-configure-row')
      footer.focus()
      await wrapper.vm.$nextTick()
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(shadowRoot.activeElement).toBe(footer)
      expect(Array.from(shadowRoot.querySelectorAll('.ti-dropdown-item'), (item) => item.textContent.trim()))
        .toEqual(['OpenAI', 'Gemini', 'Browser'])

      // Reopen-fresh state, row focused; then the true post-flush redirect
      // ordering: mutate first (repair enqueued), yield one microtask so the
      // watcher snapshot runs, THEN redirect to the outside document control.
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: [] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      const deepLRow = Array.from(shadowRoot.querySelectorAll('.ti-dropdown-item-btn'))
        .find((element) => element.textContent.trim() === 'DeepL')
      deepLRow.focus()
      expect(shadowRoot.activeElement).toBe(deepLRow)
      const outsideButton = document.createElement('button')
      outsideButton.textContent = 'Outside control'
      container.appendChild(outsideButton)
      // Needed by the no-steal assertions below (header must stay unfocused).
      const traditionalHeader = Array.from(shadowRoot.querySelectorAll('.ti-dropdown-group-header'))
        .find((header) => header.textContent.trim() === 'Traditional')

      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await Promise.resolve()
      outsideButton.focus()
      await wrapper.vm.$nextTick()
      await flushReactions()
      await wrapper.vm.$nextTick()
      // No steal: the redirected outside control keeps document-level focus;
      // neither the captured-withdrawn row nor its Traditional disclosure
      // re-took focus. (Whether the shadow-boundary focusout auto-closed the
      // menu or not is a jsdom artifact; real browsers close it via the
      // menu's focusout handling and this assertion set stays valid either
      // way.)
      expect(document.activeElement).toBe(outsideButton)
      expect(shadowRoot.activeElement ?? null).not.toBe(deepLRow)
      expect(shadowRoot.activeElement ?? null).not.toBe(traditionalHeader)
      expect(wrapper.emitted('provider-change')).toBeUndefined()
      expect(traditionalHeader?.getAttribute('aria-expanded')).toBe('false')
      expect(shadowRoot.activeElement).not.toBe(traditionalHeader)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('external collapse reconciles focus only when it still belongs to the captured row or fell neutral on withdrawal', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      await openRealMenu(wrapper)

      // (a) Focus moved to the footer Configure action after the snapshot:
      // the reconciliation must not steal focus back to the provider row.
      // Walk toward DeepL one step at a time (focus settles per step).
      for (let step = 0; step < 3; step += 1) {
        if (document.activeElement.textContent.includes('DeepL')) break
        await arrowDown(wrapper)
      }
      expect(document.activeElement.textContent).toContain('DeepL')
      const configure = document.body.querySelector('.ti-configure-row')
      configure.focus()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(configure)
      // focusedIndex is left at the (stale) row position; selection unaffected.
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(1)
      expect(settingsStore.setProviderCategoryCollapsed).not.toHaveBeenCalled()

      // (b) From footer focus, external EXPAND above a row that is not focused:
      // no steal either (the captured-row guard fails for a footer target).
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: [] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(configure)

      // (c) Row-focused external collapse with withdrawal → matching header.
      const deepLBtn = Array.from(document.body.querySelectorAll('.ti-dropdown-item-btn'))
        .find((element) => element.textContent.trim() === 'DeepL')
      deepLBtn.focus()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      const header = document.activeElement
      expect(header.classList.contains('ti-dropdown-group-header')).toBe(true)
      expect(header.textContent).toContain('Traditional')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('external expand above the focused row keeps real focus; synchronously-redirected footer focus survives', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await openRealMenu(wrapper)
      // Real focus starts on OpenAI (first visible row); external expand above re-widens.
      const openAiBtn = document.activeElement
      expect(openAiBtn.textContent).toContain('OpenAI')

      // Redirect to a category header synchronously BEFORE the flush tick:
      // the reconciliation must not pull focus back to the provider row.
      const aiHeader = Array.from(document.body.querySelectorAll('.ti-dropdown-group-header'))
        .find((element) => element.textContent.trim() === 'AI')
      aiHeader.focus()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: [] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(aiHeader)
      expect(aiHeader.getAttribute('aria-expanded')).toBe('true')

      // And from the header, header-held Arrow navigation still lands on rows.
      const menuRoot = document.body.querySelector('.ti-provider-dropdown-menu')
      menuRoot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(document.activeElement.classList.contains('ti-dropdown-item-btn')).toBe(true)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('opens an all-collapsed grouped menu focused on the first disclosure, whose native activation exposes rows', async () => {
    Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free', 'ai', 'local'] })
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      await openRealMenu(wrapper)
      const menuRoot = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(menuRoot.querySelectorAll('.ti-dropdown-item')).toHaveLength(0)
      const header = document.activeElement
      expect(header.classList.contains('ti-dropdown-group-header')).toBe(true)
      expect(header.id).toBe('ti-provider-dropdown-v-0-group-0')
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(-1)

      // Browser Enter/Space performs the native button activation; jsdom lacks
      // synthesized keydown→click, so single click stands in for the test.
      // Expanding the Traditional category only exposes its three rows.
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      header.click()
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      const expandedMenu = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(Array.from(expandedMenu.querySelectorAll('.ti-dropdown-item'), (item) => item.textContent.trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured',
      ])

      // Arrow navigation works from the disclosure into the exposed rows;
      // dispatch on the live menu root, whose nodes were patched by the flush.
      expandedMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      expect(document.activeElement.classList.contains('ti-dropdown-item-btn')).toBe(true)
      expect(document.activeElement.textContent).toContain('Google')
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('synthetic Default keeps row priority when the grouped menu has zero real visible rows', async () => {
    Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free', 'ai', 'local'] })
    const { wrapper, container } = await attachSelector({
      mode: 'button', modelValue: 'googlev2', allowDefault: true,
    }, { realTeleport: true })
    try {
      await openRealMenu(wrapper)
      const menuRoot = document.body.querySelector('.ti-provider-dropdown-menu')
      expect(Array.from(menuRoot.querySelectorAll('.ti-dropdown-item'), (item) => item.textContent.trim()))
        .toEqual(['Default'])
      expect(wrapper.vm.$.setupState.focusedIndex).toBe(0)
      expect(document.activeElement.classList.contains('ti-dropdown-item-btn')).toBe(true)
      expect(document.activeElement.textContent).toContain('Default')
      // The Default row keeps selection-row semantics (single selectable row).
      expect(document.activeElement.closest('.ti-dropdown-group').querySelectorAll('.ti-dropdown-item')).toHaveLength(1)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('external collapse leaves disclosure/footer/trigger focus untouched and selection-only rows put', async () => {
    const { wrapper, container } = await attachSelector({
      mode: 'button', modelValue: 'googlev2', showSync: false,
    }, { realTeleport: true })
    try {
      await openRealMenu(wrapper)
      // Footer focus (Configure Providers) must not be moved.
      const configure = document.body.querySelector('.ti-configure-row')
      configure.focus()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free'] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(configure)

      // Disclosure focus must not be moved either.
      const aiHeader = Array.from(document.body.querySelectorAll('.ti-dropdown-group-header'))
        .find((element) => element.textContent.trim() === 'AI')
      aiHeader.focus()
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free', 'ai'] })
      await flushReactions()
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(aiHeader)
      expect(aiHeader.getAttribute('aria-expanded')).toBe('false')
    } finally {
      wrapper.unmount()
      container.remove()
    }

    // Selection-only rows are headerless: external changes must not move focus.
    const solo = await attachSelector({ mode: 'button', selectionOnly: true, modelValue: '' }, { realTeleport: true })
    try {
      await openRealMenu(solo.wrapper)
      const googleRow = document.activeElement
      expect(googleRow.textContent).toContain('Google')
      Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free', 'ai', 'local'] })
      await flushReactions()
      await solo.wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(googleRow)
      expect(Array.from(document.body.querySelectorAll('.ti-dropdown-item'), (item) => item.textContent.trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
    } finally {
      solo.wrapper.unmount()
      solo.container.remove()
    }
  })

  it('collapsing with the first row after the group focused shifts its index across the boundary', async () => {
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' }, { realTeleport: true })
    try {
      const anchor = wrapper.element.querySelector('.ti-provider-button-container')
      vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
        top: 10, left: 100, right: 300, bottom: 50, width: 200, height: 40, x: 100, y: 10,
      })
      await wrapper.find('.ti-provider-button').trigger('click')
      // Arrow moves real focus in a post-render task (same-tick focus() can be
      // dropped by the flush), so each step settles across two ticks.
      const keyOnFocusedControl = async (key) => {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
        await wrapper.vm.$nextTick()
        await wrapper.vm.$nextTick()
      }
      // Walk to OpenAI — the first row after Traditional (boundary index 3).
      // Two flushes settle the open-time focus move before the walk starts.
      await wrapper.vm.$nextTick()
      await wrapper.vm.$nextTick()
      await keyOnFocusedControl('ArrowDown')
      await keyOnFocusedControl('ArrowDown')
      await keyOnFocusedControl('ArrowDown')
      expect(document.activeElement.textContent).toContain('OpenAI')

      // Collapse Traditional: equality with `start + length` must shift the
      // later row, keeping real focus and keyboard continuity (OpenAI → 0).
      document.body.querySelectorAll('.ti-dropdown-group-header')[0].click()
      await wrapper.vm.$nextTick()
      expect(document.activeElement.textContent).toContain('OpenAI')
      await keyOnFocusedControl('ArrowDown')
      expect(document.activeElement.textContent).toContain('Gemini')
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.emitted('provider-change')).toEqual([['gemini']])
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('collapsing every category leaves zero rows with no modulo fault and safe keyboard handling', async () => {
    Object.assign(settingsStore.settings, { COLLAPSED_PROVIDER_CATEGORIES: ['free', 'ai', 'local'] })
    const { wrapper, container } = await attachSelector({ mode: 'button', modelValue: 'googlev2' })
    try {
      const menu = await openMenu(wrapper)
      expect(menu.findAll('.ti-dropdown-group-header').map((header) => header.text().trim())).toEqual(['Traditional', 'AI', 'Other'])
      expect(menu.findAll('.ti-dropdown-item')).toHaveLength(0)

      // Trigger-follows-menu keyboard branch must survive zero visible rows.
      const trigger = wrapper.find('.ti-provider-button')
      trigger.element.focus()
      trigger.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      trigger.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.ti-provider-dropdown-menu').exists()).toBe(true)

      trigger.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(document.activeElement).toBe(trigger.element)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('keeps header IDs unique across two selectors in the same app and wires aria-controls per group', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const wrapper = mount({
      components: { ProviderSelector },
      template: '<div><ProviderSelector mode="button" model-value="googlev2" /><ProviderSelector mode="button" model-value="deepl" /></div>',
    }, { attachTo: container, global: { stubs: { Teleport: true } } })
    try {
      wrapper.element.querySelectorAll('.ti-provider-button-container').forEach((anchor) => {
        vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
          top: 10, left: 100, right: 300, bottom: 50, width: 200, height: 40, x: 100, y: 10,
        })
      })
      const triggers = wrapper.findAll('.ti-provider-button')
      await triggers[0].trigger('click')
      const firstHeaderIds = wrapper.findAll('.ti-dropdown-group-header').map((header) => header.attributes('id'))
      const firstRowsIds = firstHeaderIds.map((id) => `${id}-items`)
      // Only one menu open at a time; close the first before opening the second
      // so the sets are compared in isolation.
      await triggers[0].trigger('click')
      await triggers[1].trigger('click')
      const secondHeaderIds = wrapper.findAll('.ti-dropdown-group-header').map((header) => header.attributes('id'))
      const secondRowsIds = secondHeaderIds.map((id) => `${id}-items`)
      expect(firstHeaderIds).toHaveLength(3)
      expect(secondHeaderIds).toHaveLength(3)
      expect(firstHeaderIds.every(Boolean)).toBe(true)
      expect(new Set(firstHeaderIds).size).toBe(firstHeaderIds.length)
      expect(new Set(secondHeaderIds).size).toBe(secondHeaderIds.length)
      expect(firstHeaderIds.some((id) => secondHeaderIds.includes(id))).toBe(false)
      expect(firstRowsIds.some((id) => secondRowsIds.includes(id))).toBe(false)
    } finally {
      wrapper.unmount()
      container.remove()
    }
  })

  it('selection-only menus stay header-free and compact mode ignores collapse state', async () => {
    Object.assign(settingsStore.settings, {
      COLLAPSED_PROVIDER_CATEGORIES: ['free'],
      CUSTOM_PROVIDER_LIST_ENABLED: true,
      CUSTOM_PROVIDER_LIST: ['gemini'],
    })
    const { wrapper, container } = await attachSelector({ mode: 'button', selectionOnly: true, modelValue: '' })
    try {
      const menu = await openMenu(wrapper)
      expect(menu.findAll('.ti-dropdown-group-header')).toHaveLength(0)
      expect(menu.findAll('.ti-dropdown-item').map((item) => item.text().trim())).toEqual([
        'Google', 'DeepL', 'Unconfigured', 'OpenAI', 'Gemini', 'Browser',
      ])
    } finally {
      wrapper.unmount()
      container.remove()
    }

    // Compact keeps its groupedMenu regardless of the collapse state; drop the
    // custom-list overrides applied for the selection-only phase above.
    Object.assign(settingsStore.settings, {
      CUSTOM_PROVIDER_LIST_ENABLED: false,
      CUSTOM_PROVIDER_LIST: [],
    })
    const compact = await attachSelector({ mode: 'compact', modelValue: 'googlev2' })
    try {
      const select = compact.wrapper.get('select.ti-provider-select')
      expect(Array.from(select.element.options).map((option) => option.value)).toEqual([
        'googlev2', 'deepl', 'unconfigured', 'openai', 'gemini', 'browser',
      ])
    } finally {
      compact.wrapper.unmount()
      compact.container.remove()
    }
  })
})
