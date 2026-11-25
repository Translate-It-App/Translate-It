import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive, ref, onMounted, onUnmounted } from 'vue'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import PopupHeader from './PopupHeader.vue'
import MaskIcon from '@/components/shared/MaskIcon.vue'
import { openExtensionApp } from '@/core/ExtensionAppLauncher.js'
import { MessageActions } from '@/shared/messaging/core/MessageActions.js'

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

let settings
let closePopup
let sidebarToggle
let sidebarOpen
let sessionSet
let sessionRemove
let isMobile

const { mockSelectModeHolder, mockToggleSelectElement, mockToggleMouseHover, mockSendMessage, mockFindProviderById, mockUpdateSetting, mockHandleError } = vi.hoisted(() => ({
  mockSelectModeHolder: { ref: null },
  mockToggleSelectElement: vi.fn(),
  mockToggleMouseHover: vi.fn(),
  mockSendMessage: vi.fn(),
  mockFindProviderById: vi.fn(() => ({ features: ['bulk'] })),
  mockUpdateSetting: vi.fn(),
  mockHandleError: vi.fn()
}))
const mockT = vi.hoisted(() => vi.fn((key, fallback) => fallback || key))

vi.mock('@/features/settings/stores/settings.js', () => ({
  useSettingsStore: () => ({ settings, updateSettingLocally: mockUpdateSetting })
}))

vi.mock('@/features/translation/stores/translation.js', () => ({
  useTranslationStore: () => ({ ephemeralSync: {}, selectedProvider: '' })
}))

vi.mock('@/features/translation/composables/useTranslationModes.js', () => ({
  useSelectElementTranslation: () => {
    // Created lazily so the test file's `ref` import is initialized (same
    // ordering guarantee as the useMouseHoverToggle mock below). A real ref
    // is required: the template relies on setup-binding auto-unwrapping.
    if (!mockSelectModeHolder.ref) mockSelectModeHolder.ref = ref(false)
    return {
      isSelectModeActive: mockSelectModeHolder.ref,
      toggleSelectElement: mockToggleSelectElement
    }
  }
}))

vi.mock('@/features/mouse-hover/composables/useMouseHoverToggle.js', () => ({
  useMouseHoverToggle: () => ({ isMouseHoverEnabled: ref(false), toggleMouseHover: mockToggleMouseHover })
}))

vi.mock('@/shared/messaging/composables/useMessaging.js', () => ({
  useMessaging: () => ({ sendMessage: mockSendMessage })
}))

vi.mock('@/composables/shared/useErrorHandler.js', () => ({
  useErrorHandler: () => ({ handleError: mockHandleError })
}))

vi.mock('@/composables/shared/useUnifiedI18n.js', () => ({
  useUnifiedI18n: () => ({ t: (...args) => mockT(...args) })
}))

vi.mock('@/features/translation/providers/ProviderManifest.js', () => ({
  findProviderById: (...args) => mockFindProviderById(...args)
}))

vi.mock('@/utils/browser/compatibility.js', () => ({
  getBrowserInfoSync: () => ({ isMobile })
}))

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('@/core/ExtensionAppLauncher.js', () => ({
  openExtensionApp: vi.fn()
}))

vi.mock('@/components/shared/IconButton.vue', () => ({
  default: {
    name: 'IconButton',
    emits: ['click'],
    template: '<button class="ti-toolbar-button" @click="$emit(\'click\')" />'
  }
}))

// Kept intentionally: the header must NOT render the scroller anymore, so
// this stub exists only to prove its absence from the rendered tree.
vi.mock('@/components/shared/HorizontalActionScroller.vue', () => ({
  default: {
    name: 'HorizontalActionScroller',
    template: '<div class="horizontal-action-scroller-stub"><slot /></div>'
  }
}))

vi.mock('@/components/base/ToolbarMenu/ToolbarMenu.vue', () => ({
  default: {
    name: 'ToolbarMenu',
    props: {
      placement: {
        type: String,
        default: 'end'
      },
      forcePopover: {
        type: Boolean,
        default: false
      }
    },
    emits: ['open', 'close'],
    setup(props, { emit }) {
      const open = ref(false)
      const openMenu = () => { open.value = true; emit('open') }
      const toggle = () => { if (open.value) closeMenu(); else openMenu() }
      const closeMenu = () => { open.value = false; emit('close') }
      const noopRef = () => {}
      const onKeydown = (event) => {
        if (event.key === 'Escape') closeMenu()
      }
      const onPointerDown = (event) => {
        if (!open.value) return
        if (event.target?.closest?.('.toolbar-menu-stub')) return
        closeMenu()
      }
      onMounted(() => {
        document.addEventListener('keydown', onKeydown)
        document.addEventListener('pointerdown', onPointerDown)
      })
      onUnmounted(() => {
        document.removeEventListener('keydown', onKeydown)
        document.removeEventListener('pointerdown', onPointerDown)
      })
      return { open, toggle, close: closeMenu, noopRef }
    },
    template: `
      <div class="toolbar-menu-stub">
        <slot name="trigger" :trigger-attrs="{ 'aria-expanded': open, 'aria-haspopup': 'menu' }" :trigger-ref="noopRef" :on-toggle="toggle" :toggle="toggle" :close="close" :open="open" />
        <div v-if="open" class="toolbar-menu-panel-stub"><slot :close="close" :is-open="open" /></div>
      </div>
    `
  }
}))

vi.mock('@/features/page-translation/components/PageTranslationButton.vue', () => ({
  default: {
    name: 'PageTranslationButton',
    props: ['compact', 'textOnly', 'targetLanguage', 'disabled', 'disabledReason', 'showAutoTranslateToggle', 'statusBadgePosition'],
    template: '<div class="page-translation-button-stub" />'
  }
}))

describe('PopupHeader', () => {
  beforeEach(() => {
    isMobile = false
    if (mockSelectModeHolder.ref) mockSelectModeHolder.ref.value = false
    mockT.mockClear()
    mockToggleSelectElement.mockClear()
    mockToggleMouseHover.mockClear()
    mockSendMessage.mockClear()
    mockSendMessage.mockResolvedValue({})
    mockHandleError.mockReset()
    mockFindProviderById.mockReset()
    mockFindProviderById.mockImplementation(() => ({ features: ['bulk'] }))
    vi.mocked(openExtensionApp).mockClear()
    vi.mocked(openExtensionApp).mockResolvedValue({ success: true })
    closePopup = vi.spyOn(window, 'close').mockImplementation(() => {})
    globalThis.browser.tabs.query.mockResolvedValue([{ id: 1, windowId: 7, url: 'https://example.com/' }])
    globalThis.browser.tabs.sendMessage.mockReset()
    globalThis.browser.tabs.sendMessage.mockResolvedValue(undefined)
    mockUpdateSetting.mockReset()
    sessionSet = vi.fn().mockResolvedValue(undefined)
    sessionRemove = vi.fn().mockResolvedValue(undefined)
    globalThis.browser.storage.session = { set: sessionSet, remove: sessionRemove }
    sidebarToggle = vi.fn()
    sidebarOpen = vi.fn().mockResolvedValue(undefined)
    globalThis.browser.sidebarAction = { toggle: sidebarToggle, open: sidebarOpen }
    settings = reactive({
      EXTENSION_ENABLED: true,
      TRANSLATE_WITH_SELECT_ELEMENT: true,
      ENABLE_SCREEN_CAPTURE: true,
      WHOLE_PAGE_TRANSLATION_ENABLED: true,
      MODE_PROVIDERS: {},
      TRANSLATION_API: 'google'
    })
  })

  afterEach(() => {
    closePopup.mockRestore()
    delete globalThis.browser.sidebarAction
    delete globalThis.browser.sidePanel
  })

  const openMoreMenu = async (wrapper) => {
    await wrapper.find('.ti-btn-more').trigger('click')
    return wrapper.find('.toolbar-menu-panel-stub')
  }

  const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))
  const flushMicrotasks = async (wrapper) => {
    await Promise.resolve()
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    await Promise.resolve()
  }

  it('renders left and actions groups without the action scroller', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // The HorizontalActionScroller is gone from the header entirely.
    expect(wrapper.find('.horizontal-action-scroller-stub').exists()).toBe(false)

    // Two visual groups: left (page + switcher slot) and right actions.
    const toolbar = wrapper.find('.ti-header-toolbar')
    expect([...toolbar.element.children].map((element) => element.className)).toEqual([
      'ti-header-left',
      'ti-header-actions'
    ])

    const left = wrapper.find('.ti-header-left')
    const pageTranslationButton = left.find('.page-translation-button-stub')
    expect(pageTranslationButton.exists()).toBe(true)
    expect(pageTranslationButton.attributes('class')).toContain('ti-page-translate-btn')

    // Direct actions all live inside the actions group.
    const actions = wrapper.find('.ti-header-actions')
    for (const selector of ['.ti-btn-more-menu', '.ti-btn-settings', '.ti-btn-mouse-hover', '.ti-btn-capture', '.ti-select-action', '.ti-btn-sidepanel']) {
      expect(actions.find(selector).exists()).toBe(true)
    }
    // Revert badge lives INSIDE the select-action wrapper (anchored on
    // Select), not as a top-level action of its own.
    expect([...actions.element.children].some((element) => element.classList.contains('ti-btn-revert-badge'))).toBe(false)
    expect(actions.find('.ti-select-action .ti-btn-revert-badge').exists()).toBe(true)
  })

  it('orders actions More → Settings → Hover → Capture → SelectAction → Sidepanel', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    // Select + Revert badge are a single plain wrapper in the DOM order.
    expect([...wrapper.find('.ti-header-actions').element.children].map((element) => element.className)).toEqual([
      'toolbar-menu-stub ti-btn-more-menu',
      'ti-toolbar-button ti-btn-settings',
      'ti-toolbar-button ti-btn-mouse-hover ti-header-toolbar-button--narrow-hide',
      'ti-toolbar-button ti-btn-capture ti-header-toolbar-button--narrow-hide',
      'ti-select-action',
      'ti-toolbar-button ti-btn-sidepanel ti-header-toolbar-button--narrow-hide'
    ])
  })

  it('keeps the select-action order stable regardless of select mode state', async () => {
    mockSelectModeHolder.ref.value = true
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    // Revert is always a child of the Select wrapper; order never shifts.
    expect([...wrapper.find('.ti-header-actions').element.children].map((element) => element.className)).toEqual([
      'toolbar-menu-stub ti-btn-more-menu',
      'ti-toolbar-button ti-btn-settings',
      'ti-toolbar-button ti-btn-mouse-hover ti-header-toolbar-button--narrow-hide',
      'ti-toolbar-button ti-btn-capture ti-header-toolbar-button--narrow-hide',
      'ti-select-action',
      'ti-toolbar-button ti-btn-sidepanel ti-header-toolbar-button--narrow-hide'
    ])
  })

  it('renders Select plus a Revert badge inside the select-action wrapper (no menu, no chevron)', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    // Only the More menu still uses ToolbarMenu.
    expect(wrapper.findAllComponents({ name: 'ToolbarMenu' })).toHaveLength(1)

    const action = wrapper.find('.ti-select-action')
    expect(action.exists()).toBe(true)
    // Ordinary Select button + Revert badge button inside .ti-select-action.
    expect([...action.element.children].map((element) => element.className)).toEqual([
      'ti-toolbar-button ti-btn-select',
      'ti-btn-revert-badge'
    ])
    // No chevron button anywhere in the header.
    expect(wrapper.find('.ti-btn-select-chevron').exists()).toBe(false)
    expect(wrapper.find('.ti-chevron-icon').exists()).toBe(false)

    // Non-interactive visual surface inside the native Revert badge: it
    // owns geometry + glyph, is hidden from AT, and is never focusable.
    const surface = wrapper.find('.ti-btn-revert-badge .ti-revert-badge-surface')
    expect(surface.exists()).toBe(true)
    expect(surface.attributes('aria-hidden')).toBe('true')
    expect(surface.element.tagName).toBe('SPAN')
    expect(surface.attributes('tabindex')).toBeUndefined()
    // Glyph lives inside the surface; the native button still owns a11y.
    expect(surface.findComponent(MaskIcon).exists()).toBe(true)
    expect(wrapper.find('.ti-btn-revert-badge > .ti-revert-badge-surface').exists()).toBe(true)
  })

  it('passes force-popover to the single remaining PopupHeader ToolbarMenu (More menu)', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const menus = wrapper.findAllComponents({ name: 'ToolbarMenu' })
    expect(menus).toHaveLength(1)
    expect(menus[0].props('forcePopover')).toBe(true)
  })

  it('applies ti-active to Select only; Revert badge never carries it', async () => {
    const idle = mount(PopupHeader)
    await idle.vm.$nextTick()
    expect(idle.find('.ti-btn-select').classes()).not.toContain('ti-active')
    expect(idle.find('.ti-btn-revert-badge').classes()).not.toContain('ti-active')

    mockSelectModeHolder.ref.value = true
    const active = mount(PopupHeader)
    await active.vm.$nextTick()

    const select = active.find('.ti-btn-select')
    const revert = active.find('.ti-btn-revert-badge')
    expect(select.classes()).toContain('ti-active')
    expect(revert.classes()).not.toContain('ti-active')

    // Hover interaction must not leak active state onto the Revert badge.
    await select.trigger('mouseenter')
    await revert.trigger('mouseenter')
    expect(select.classes()).toContain('ti-active')
    expect(revert.classes()).not.toContain('ti-active')

    // Select keeps pressed-toggle semantics; Revert is a plain action button.
    expect(select.attributes('aria-pressed')).toBe('true')
    expect(revert.attributes('aria-pressed')).toBeUndefined()
  })

  it('renders the More trigger as a normal toolbar button with an ellipsis glyph', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const more = wrapper.find('.ti-btn-more')
    expect(more.element.tagName).toBe('BUTTON')
    expect(more.attributes('aria-label')).toBe('More actions')
    expect(more.text()).toContain('⋯')
    // No rotated chevron workaround: no icon image inside the trigger.
    expect(more.find('img').exists()).toBe(false)
  })

  it('uses the popup_more_actions_title key for the More button name', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    expect(mockT).toHaveBeenCalledWith('popup_more_actions_title', 'More actions')
    const more = wrapper.find('.ti-btn-more')
    expect(more.attributes('aria-label')).toBe('More actions')
    expect(more.attributes('title')).toBe('More actions')
  })

  it('gives the Revert badge its own localized title and aria-label (no chevron options key)', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.ti-btn-select-chevron').exists()).toBe(false)
    const revert = wrapper.find('.ti-btn-revert-badge')
    expect(revert.exists()).toBe(true)
    expect(mockT).toHaveBeenCalledWith('popup_revert_title_icon', 'Revert')
    expect(mockT).toHaveBeenCalledWith('popup_revert_alt_icon', 'Revert')
    expect(revert.attributes('title')).toBe('Revert')
    expect(revert.attributes('aria-label')).toBe('Revert')
    // Plain native button — never a menu item; surface is decorative only.
    expect(revert.element.tagName).toBe('BUTTON')
    expect(revert.attributes('type')).toBe('button')
    expect(revert.attributes('role')).toBeUndefined()
    expect(revert.attributes('tabindex')).toBeUndefined()
    expect(revert.find('.ti-revert-badge-surface').attributes('aria-hidden')).toBe('true')
  })

  it('passes English fallbacks as the second t() argument for select and revert titles', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    expect(mockT).toHaveBeenCalledWith('popup_select_element_title_icon', 'Select Element mode')

    // The Revert name is on the always-rendered Revert segment — no menu to open.
    expect(mockT).toHaveBeenCalledWith('popup_revert_title_icon', 'Revert')
    expect(mockT).toHaveBeenCalledWith('popup_revert_alt_icon', 'Revert')
  })

  it('uses the unsupported-provider fallback when the provider lacks bulk support', async () => {
    mockFindProviderById.mockReturnValue({ features: [] })
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    expect(mockT).toHaveBeenCalledWith('provider_does_not_support_bulk', 'This provider does not support page/element translation')
    // Unsupported: the Select button explains itself and stays disabled.
    expect(wrapper.find('.ti-btn-select').attributes('title')).toBe('This provider does not support page/element translation')
    expect(wrapper.find('.ti-btn-select').attributes('disabled')).toBeDefined()
  })

  it('allows an active Select session to deactivate after provider validation becomes invalid', async () => {
    mockSelectModeHolder.ref.value = true
    mockFindProviderById.mockReturnValue({
      features: ['bulk'],
      requiredSettings: ['GEMINI_API_KEY'],
    })
    settings.TRANSLATION_API = 'gemini'
    settings.GEMINI_API_KEY = 'valid-key'
    mockToggleSelectElement.mockResolvedValue(true)
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const select = wrapper.get('.ti-btn-select')
    expect(select.attributes('disabled')).toBeUndefined()
    settings.GEMINI_API_KEY = ''
    await wrapper.vm.$nextTick()
    expect(select.attributes('disabled')).toBeUndefined()
    expect(select.attributes('title')).toBe('Select Element mode')
    await select.trigger('click')
    expect(mockToggleSelectElement).toHaveBeenCalledOnce()
  })

  it('passes a localized missing-key error to the disabled page button', async () => {
    settings.TRANSLATION_API = 'gemini'
    mockFindProviderById.mockReturnValue({
      features: ['bulk'],
      requiredSettings: ['GEMINI_API_KEY'],
    })
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'PageTranslationButton' }).props('disabledReason'))
      .toBe('ERRORS_API_KEY_MISSING')
    expect(mockT).toHaveBeenCalledWith('ERRORS_API_KEY_MISSING', 'ERRORS_API_KEY_MISSING')
  })

  it('passes compact mode to the page translation button', async () => {
    const wrapper = mount(PopupHeader, { props: { targetLanguage: 'fa' } })
    await wrapper.vm.$nextTick()

    const pageButton = wrapper.findComponent({ name: 'PageTranslationButton' })
    expect(pageButton.exists()).toBe(true)
    expect(pageButton.props('compact')).toBe(true)
    expect(pageButton.props('targetLanguage')).toBe('fa')
    expect(pageButton.props('showAutoTranslateToggle')).toBe(true)
  })

  it('opts the page translation button into the corner status badge', async () => {
    const wrapper = mount(PopupHeader, { props: { targetLanguage: 'fa' } })
    await wrapper.vm.$nextTick()

    const pageButton = wrapper.findComponent({ name: 'PageTranslationButton' })
    expect(pageButton.exists()).toBe(true)
    expect(pageButton.props('statusBadgePosition')).toBe('corner')
  })

  it('renders the Revert badge beside Select whenever Select Element is enabled', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.ti-select-action .ti-btn-select').exists()).toBe(true)
    expect(wrapper.find('.ti-select-action .ti-btn-revert-badge').exists()).toBe(true)
    expect(wrapper.find('.ti-btn-select-chevron').exists()).toBe(false)
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)
  })

  it('clicking the Revert badge never activates Select Element and opens no menu', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    await wrapper.find('.ti-btn-revert-badge').trigger('click')
    await flushPromises()

    expect(mockToggleSelectElement).not.toHaveBeenCalled()
    expect(closePopup).not.toHaveBeenCalled()
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)
  })

  it('opens the More menu with Subtitle, PDF, History, Exclude plus narrow-only duplicates', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)

    const panel = await openMoreMenu(wrapper)
    expect(panel.exists()).toBe(true)

    const items = panel.findAll('[role="menuitem"]')
    // Structurally eight: the four always-visible items plus the narrow-only
    // duplicates (CSS-hidden at normal widths — see PopupHeader.scss
    // breakpoint ownership) plus the Desktop FAB action. JSDOM does not apply
    // CSS, so assert existence.
    expect(items).toHaveLength(8)
    const icons = panel.findAll('.ti-header-menu-item img').map((img) => img.attributes('src'))
    expect(icons.some((src) => src?.includes('subtitle.svg'))).toBe(true)
    expect(icons.some((src) => src?.includes('pdf.png'))).toBe(true)
    expect(icons.some((src) => src?.includes('history.svg'))).toBe(false)
    // Multicolor Subtitle renders via native <img> (ADR-001, same as PDF);
    // monochrome menu icons render via MaskIcon (currentColor), not <img>.
    const maskSrcs = panel.findAllComponents(MaskIcon).map((icon) => icon.props('src'))
    const maskOrImgSrcs = [...icons, ...maskSrcs]
    const historyIcon = panel.findAllComponents(MaskIcon).find((icon) => icon.props('src').includes('history.svg'))
    expect(historyIcon).toBeDefined()
    expect(historyIcon.props('size')).toBe(18)
    // Subtitle is no longer a MaskIcon.
    expect(panel.findAllComponents(MaskIcon).some((icon) => icon.props('src')?.includes('subtitle.svg'))).toBe(false)
    // Decorative: the button owns the accessible name, the <img> stays hidden.
    const subtitleImg = panel.findAll('.ti-header-menu-item img').find((img) => img.attributes('src')?.includes('subtitle.svg'))
    expect(subtitleImg.exists()).toBe(true)
    expect(subtitleImg.attributes('alt')).toBe('')
    expect(subtitleImg.attributes('aria-hidden')).toBe('true')
    expect(panel.findAll('[role="menuitem"]')[0].text()).toContain('popup_subtitle_title_icon')
    expect(icons.some((src) => src?.includes('pdf.png'))).toBe(true)
    expect(maskOrImgSrcs.some((src) => src?.includes('mouse-hover.png'))).toBe(true)
    expect(maskOrImgSrcs.some((src) => src?.includes('capture.svg'))).toBe(true)
    expect(maskOrImgSrcs.some((src) => src?.includes('side-panel.png'))).toBe(true)
    // Capture stays mask-driven: no capture <img> in the menu.
    expect(icons.some((src) => src?.includes('capture'))).toBe(false)
    expect(panel.text()).toContain('Disable on this site')
    expect(panel.text()).toContain('Translation History')
    expect(panel.findAll('[role="menuitem"]')[1].text()).toBe('PDF Viewer')
    expect(mockT).toHaveBeenCalledWith('pdf_app_title', 'PDF Viewer')
    expect(mockT).toHaveBeenCalledWith('SIDEPANEL_HISTORY_TOOLTIP', 'Translation History')

    // Breakpoint contract classes: direct buttons hide at narrow widths,
    // narrow-only duplicates show there instead.
    expect(panel.find('.ti-header-menu-item--very-narrow-only').exists()).toBe(true)
    expect(panel.findAll('.ti-header-menu-item--narrow-only')).toHaveLength(2)
    for (const selector of ['.ti-btn-mouse-hover', '.ti-btn-capture', '.ti-btn-sidepanel']) {
      expect(wrapper.find(selector).classes()).toContain('ti-header-toolbar-button--narrow-hide')
    }
  })

  it('hides History and Side Panel actions on mobile while keeping desktop actions visible', async () => {
    const desktop = mount(PopupHeader)
    await desktop.vm.$nextTick()
    expect(desktop.find('.ti-btn-sidepanel').exists()).toBe(true)
    const desktopMenu = await openMoreMenu(desktop)
    expect(desktopMenu.text()).toContain('Translation History')
    expect(desktopMenu.find('.ti-header-menu-item--narrow-only').exists()).toBe(true)

    isMobile = true
    const mobile = mount(PopupHeader)
    await mobile.vm.$nextTick()
    expect(mobile.find('.ti-btn-sidepanel').exists()).toBe(false)
    const mobileMenu = await openMoreMenu(mobile)
    expect(mobileMenu.text()).not.toContain('Translation History')
    expect(mobileMenu.findAllComponents(MaskIcon).some((icon) => icon.props('src').includes('side-panel.png'))).toBe(false)
    expect(mobileMenu.findAll('[role="menuitem"]')).toHaveLength(5)
  })

  it('renders direct toolbar actions in IconButton mask mode', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const buttons = wrapper.findAllComponents({ name: 'IconButton' })
    // The IconButton mock declares no props, so icon/mask/type arrive as
    // fallthrough attrs; read them via $attrs instead of props().
    const byIcon = Object.fromEntries(buttons.map((button) => [button.vm.$attrs.icon, button]))
    for (const icon of ['settings.png', 'mouse-hover.png', 'capture.svg', 'side-panel.png']) {
      expect(byIcon[icon].vm.$attrs.type).toBe('toolbar')
      expect(byIcon[icon].vm.$attrs.mask).toBe(true)
    }
    // Capture is fully off the image path in the header.
    expect(wrapper.find('.ti-btn-capture img').exists()).toBe(false)
  })

  it('renders the Select main action as a decorative MaskIcon', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const select = wrapper.find('.ti-btn-select')
    expect(select.find('img').exists()).toBe(false)
    // Decorative mask icon: the button owns a stable accessible name,
    // independent of the support-aware tooltip (echo-mock returns the key).
    expect(mockT).toHaveBeenCalledWith('popup_select_element_alt_icon')
    expect(select.attributes('aria-label')).toBe('popup_select_element_alt_icon')
    expect(select.attributes('title')).toBe('Select Element mode')
    expect(select.attributes('disabled')).toBeUndefined()
  })

  it('keeps the Select accessible name when the provider lacks bulk support', async () => {
    mockFindProviderById.mockReturnValue({ features: [] })
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const select = wrapper.find('.ti-btn-select')
    // Disabled branch: tooltip explains itself, but the accessible name
    // stays the stable action label.
    expect(select.attributes('disabled')).toBeDefined()
    expect(select.attributes('title')).toBe('This provider does not support page/element translation')
    expect(select.attributes('aria-label')).toBe('popup_select_element_alt_icon')
    const revert = wrapper.find('.ti-btn-revert-badge')
    const icon = select.findComponent(MaskIcon)
    expect(icon.exists()).toBe(true)
    expect(icon.props('src')).toContain('select.png')
    expect(icon.props('size')).toBe(22)
    expect(icon.attributes('aria-hidden')).toBe('true')
    // Revert badge stays independent of the disabled Select state and
    // keeps its own smaller decorative MaskIcon.
    expect(revert.attributes('disabled')).toBeUndefined()
    const revertIcon = revert.findComponent(MaskIcon)
    expect(revertIcon.exists()).toBe(true)
    expect(revertIcon.props('src')).toContain('revert.png')
    expect(revertIcon.props('size')).toBe(12)
    expect(revertIcon.attributes('aria-hidden')).toBe('true')
  })

  it('launches Subtitle and PDF translators from the menu before closing Popup', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    let panel = await openMoreMenu(wrapper)
    await panel.findAll('[role="menuitem"]')[0].trigger('click')
    expect(openExtensionApp).toHaveBeenNthCalledWith(1, 'subtitle')

    panel = await openMoreMenu(wrapper)
    await panel.findAll('[role="menuitem"]')[1].trigger('click')
    expect(openExtensionApp).toHaveBeenNthCalledWith(2, 'pdf')

    expect(closePopup).toHaveBeenCalledTimes(2)
    expect(openExtensionApp.mock.invocationCallOrder[0]).toBeLessThan(closePopup.mock.invocationCallOrder[0])
    expect(openExtensionApp.mock.invocationCallOrder[1]).toBeLessThan(closePopup.mock.invocationCallOrder[1])
    // Menu closes after the action.
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)
  })

  it('opens Firefox Side Panel directly to History without querying again on click', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()
    await flushMicrotasks(wrapper)

    const panel = await openMoreMenu(wrapper)
    // Snapshot AFTER opening: opening also refreshes the FAB status, which
    // queries the active tab once.
    const queryCountBeforeClick = globalThis.browser.tabs.query.mock.calls.length
    await panel.findAll('[role="menuitem"]')[2].trigger('click')
    await flushMicrotasks(wrapper)

    expect(sessionSet).toHaveBeenCalledWith({
      '__translateItSidepanelPendingIntent:7': { action: 'open-history' }
    })
    expect(sidebarOpen).toHaveBeenCalledOnce()
    expect(globalThis.browser.tabs.query).toHaveBeenCalledTimes(queryCountBeforeClick)
    expect(sidebarToggle).not.toHaveBeenCalled()
    expect(closePopup).toHaveBeenCalledOnce()
  })

  it('disables History until the initialization tab query resolves, then opens normally', async () => {
    let resolveTabQuery
    globalThis.browser.tabs.query.mockReturnValue(new Promise((resolve) => { resolveTabQuery = resolve }))
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    let panel = await openMoreMenu(wrapper)
    let historyItem = panel.findAll('[role="menuitem"]')[2]
    expect(historyItem.attributes('disabled')).toBeDefined()
    await historyItem.trigger('click')
    await flushMicrotasks(wrapper)
    expect(sessionSet).not.toHaveBeenCalled()
    expect(sidebarOpen).not.toHaveBeenCalled()
    expect(closePopup).not.toHaveBeenCalled()

    resolveTabQuery([{ id: 1, windowId: 7, url: 'https://example.com/' }])
    await flushMicrotasks(wrapper)
    if (!wrapper.find('.toolbar-menu-panel-stub').exists()) panel = await openMoreMenu(wrapper)
    historyItem = panel.findAll('[role="menuitem"]')[2]
    expect(historyItem.attributes('disabled')).toBeUndefined()
    await historyItem.trigger('click')
    await flushMicrotasks(wrapper)

    expect(sessionSet).toHaveBeenCalledWith({
      '__translateItSidepanelPendingIntent:7': { action: 'open-history' }
    })
    expect(sidebarOpen).toHaveBeenCalledOnce()
    expect(closePopup).toHaveBeenCalledOnce()
  })

  it('opens Side Panel to History when session storage is unavailable', async () => {
    globalThis.browser.storage.session = undefined
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const panel = await openMoreMenu(wrapper)
    await panel.findAll('[role="menuitem"]')[2].trigger('click')
    await flushMicrotasks(wrapper)

    expect(sidebarOpen).toHaveBeenCalledOnce()
    expect(closePopup).toHaveBeenCalledOnce()
    expect(sessionSet).not.toHaveBeenCalled()
  })

  it('opens Chrome Side Panel synchronously and closes only after open and intent write settle', async () => {
    let resolveWrite
    sessionSet.mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve }))
    delete globalThis.browser.sidebarAction
    let resolveOpen
    const sidePanelOpen = vi.fn(() => new Promise((resolve) => { resolveOpen = resolve }))
    globalThis.browser.sidePanel = { open: sidePanelOpen }
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()
    await flushMicrotasks(wrapper)

    const panel = await openMoreMenu(wrapper)
    // Snapshot AFTER opening: opening also refreshes the FAB status (one
    // extra active-tab query, already settled by the flush above).
    const queryCountBeforeClick = globalThis.browser.tabs.query.mock.calls.length
    await panel.findAll('[role="menuitem"]')[2].trigger('click')

    expect(globalThis.browser.tabs.query).toHaveBeenCalledTimes(queryCountBeforeClick)
    expect(sidePanelOpen).toHaveBeenCalledWith({ tabId: 1 })
    expect(sessionSet).toHaveBeenCalledWith({
      '__translateItSidepanelPendingIntent:7': { action: 'open-history' }
    })
    expect(closePopup).not.toHaveBeenCalled()

    resolveOpen()
    await flushMicrotasks(wrapper)
    expect(closePopup).not.toHaveBeenCalled()
    resolveWrite()
    await flushMicrotasks(wrapper)
    expect(closePopup).toHaveBeenCalledOnce()
  })

  it('removes the window-scoped intent when opening the Side Panel fails', async () => {
    delete globalThis.browser.sidebarAction
    const sidePanelOpen = vi.fn().mockRejectedValue(new Error('open failed'))
    globalThis.browser.sidePanel = { open: sidePanelOpen }
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const panel = await openMoreMenu(wrapper)
    await panel.findAll('[role="menuitem"]')[2].trigger('click')
    await flushMicrotasks(wrapper)

    expect(sessionSet).toHaveBeenCalledWith({
      '__translateItSidepanelPendingIntent:7': { action: 'open-history' }
    })
    expect(sessionRemove).toHaveBeenCalledWith('__translateItSidepanelPendingIntent:7')
    expect(closePopup).not.toHaveBeenCalled()
  })

  it('does not show History on a later normal Side Panel open after failure', async () => {
    delete globalThis.browser.sidebarAction
    const sidePanelOpen = vi.fn()
      .mockRejectedValueOnce(new Error('open failed'))
      .mockResolvedValueOnce(undefined)
    globalThis.browser.sidePanel = { open: sidePanelOpen }
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    let panel = await openMoreMenu(wrapper)
    await panel.findAll('[role="menuitem"]')[2].trigger('click')
    await flushMicrotasks(wrapper)
    expect(sessionRemove).toHaveBeenCalledWith('__translateItSidepanelPendingIntent:7')

    await wrapper.find('.ti-btn-sidepanel').trigger('click')
    await flushMicrotasks(wrapper)

    expect(sidePanelOpen).toHaveBeenNthCalledWith(2, { tabId: 1 })
    expect(sessionSet).toHaveBeenCalledTimes(1)
    expect(sessionRemove).toHaveBeenCalledTimes(1)
  })

  it('keeps Popup open when an extension app launch fails', async () => {
    vi.mocked(openExtensionApp).mockResolvedValueOnce({ success: false })
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const panel = await openMoreMenu(wrapper)
    await panel.findAll('[role="menuitem"]')[0].trigger('click')

    expect(openExtensionApp).toHaveBeenCalledWith('subtitle')
    expect(closePopup).not.toHaveBeenCalled()
  })

  it('updates the site toggle from the server response on success only', async () => {
    mockSendMessage.mockImplementation(({ action }) => {
      if (action === MessageActions.IS_Current_Page_Excluded) return Promise.resolve({ excluded: false })
      if (action === MessageActions.Set_Exclude_Current_Page) return Promise.resolve({ success: true, excluded: true })
      return Promise.resolve({})
    })
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // The site action is the FINAL menu item (after the responsive duplicates).
    let panel = await openMoreMenu(wrapper)
    let items = panel.findAll('[role="menuitem"]')
    const siteItem = () => items[items.length - 1]
    expect(siteItem().text()).toContain('Disable on this site')
    // Enabled: decorative indicator present but not in the excluded state.
    expect(siteItem().find('.ti-header-menu-site-indicator').exists()).toBe(true)
    expect(siteItem().find('.ti-header-menu-site-indicator.is-excluded').exists()).toBe(false)

    await siteItem().trigger('click')
    await flushPromises()
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.Set_Exclude_Current_Page,
      data: { exclude: true, url: 'https://example.com/' }
    }))
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)

    // Server confirmed excluded: label flips to Enable; the CSS indicator
    // (not a unicode glyph) reflects the excluded state.
    panel = await openMoreMenu(wrapper)
    items = panel.findAll('[role="menuitem"]')
    expect(siteItem().text()).toContain('Enable on this site')
    expect(siteItem().text()).not.toContain('✓')
    expect(siteItem().find('.ti-header-menu-site-indicator.is-excluded').exists()).toBe(true)
  })

  it('keeps the site toggle unchanged when the server reports failure', async () => {
    mockSendMessage.mockImplementation(({ action }) => {
      if (action === MessageActions.IS_Current_Page_Excluded) return Promise.resolve({ excluded: false })
      if (action === MessageActions.Set_Exclude_Current_Page) return Promise.resolve({ success: false })
      return Promise.resolve({})
    })
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    const panel = await openMoreMenu(wrapper)
    const items = panel.findAll('[role="menuitem"]')
    await items[items.length - 1].trigger('click')
    await flushPromises()

    const reopened = await openMoreMenu(wrapper)
    // No optimistic flip: still enabled, still offering Disable.
    const reopenedItems = reopened.findAll('[role="menuitem"]')
    expect(reopenedItems[reopenedItems.length - 1].text()).toContain('Disable on this site')
  })

  it('routes narrow-duplicate menu actions to the same handlers and closes the menu', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    let panel = await openMoreMenu(wrapper)
    await panel.find('.ti-header-menu-item--very-narrow-only').trigger('click')
    expect(mockToggleMouseHover).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)

    panel = await openMoreMenu(wrapper)
    const narrowItems = panel.findAll('.ti-header-menu-item--narrow-only')
    await narrowItems[0].trigger('click')
    await flushPromises()
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.START_SCREEN_CAPTURE
    }))
    expect(closePopup).toHaveBeenCalled()
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)

    panel = await openMoreMenu(wrapper)
    await panel.findAll('.ti-header-menu-item--narrow-only')[1].trigger('click')
    await flushPromises()
    expect(sidebarToggle).toHaveBeenCalled()
    expect(closePopup).toHaveBeenCalled()
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)
  })

  it('toggles mouse hover from its direct button without closing Popup', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    await wrapper.find('.ti-btn-mouse-hover').trigger('click')

    expect(mockToggleMouseHover).toHaveBeenCalledTimes(1)
    expect(closePopup).not.toHaveBeenCalled()
  })

  it('starts screen capture from its direct button and closes Popup', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    await wrapper.find('.ti-btn-capture').trigger('click')
    await flushPromises()

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.START_SCREEN_CAPTURE
    }))
    expect(closePopup).toHaveBeenCalled()
  })

  it('opens the side panel from its direct button and closes Popup', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    await wrapper.find('.ti-btn-sidepanel').trigger('click')
    await flushPromises()

    expect(sidebarToggle).toHaveBeenCalled()
    expect(sessionSet).not.toHaveBeenCalled()
    expect(closePopup).toHaveBeenCalled()
  })

  it('keeps the normal Chrome Side Panel action unchanged', async () => {
    delete globalThis.browser.sidebarAction
    const sidePanelOpen = vi.fn().mockResolvedValue(undefined)
    globalThis.browser.sidePanel = { open: sidePanelOpen }
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    await wrapper.find('.ti-btn-sidepanel').trigger('click')
    await flushPromises()

    expect(sidePanelOpen).toHaveBeenCalledWith({ tabId: 1 })
    expect(sessionSet).not.toHaveBeenCalled()
    expect(closePopup).toHaveBeenCalled()
  })

  it('closes the More menu on Escape', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    await openMoreMenu(wrapper)
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)
  })

  it('closes the More menu on outside click', async () => {
    const wrapper = mount(PopupHeader, { attachTo: document.body })
    await wrapper.vm.$nextTick()

    await openMoreMenu(wrapper)
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(true)

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)
    wrapper.unmount()
  })

  it('hides conditional actions when disabled', async () => {
    settings.TRANSLATE_WITH_SELECT_ELEMENT = false
    settings.ENABLE_SCREEN_CAPTURE = false
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.ti-select-action').exists()).toBe(false)
    expect(wrapper.find('.ti-btn-select').exists()).toBe(false)
    expect(wrapper.find('.ti-btn-revert-badge').exists()).toBe(false)
    expect(wrapper.find('.ti-btn-capture').exists()).toBe(false)
    expect(wrapper.find('.ti-btn-mouse-hover').exists()).toBe(true)
    expect(wrapper.find('.ti-btn-sidepanel').exists()).toBe(true)
    expect(wrapper.find('.ti-btn-settings').exists()).toBe(true)

    const panel = await openMoreMenu(wrapper)
    // Capture duplicate follows its setting (v-if); hover + sidepanel
    // duplicates stay structural: subtitle, pdf, history, hover, sidepanel,
    // fab, exclude.
    expect(panel.findAll('[role="menuitem"]')).toHaveLength(7)
    expect(panel.find('.ti-header-menu-item--very-narrow-only').exists()).toBe(true)
    expect(panel.findAll('.ti-header-menu-item--narrow-only')).toHaveLength(1)
  })

  it('renders slot content (view switcher) inside the left group', async () => {
    const wrapper = mount(PopupHeader, {
      slots: { default: '<div class="view-switcher-stub" />' }
    })
    await wrapper.vm.$nextTick()

    // Slot sits with Page Translation in the left group, before the actions.
    const leftChildren = [...wrapper.find('.ti-header-left').element.children]
    const switcher = wrapper.find('.view-switcher-stub')
    expect(switcher.exists()).toBe(true)
    expect(leftChildren[0].className).toContain('page-translation-button-stub')
    expect(leftChildren[1]).toBe(switcher.element)

    const toolbarChildren = [...wrapper.find('.ti-header-toolbar').element.children]
    expect(toolbarChildren[0].className).toBe('ti-header-left')
    expect(toolbarChildren[1].className).toBe('ti-header-actions')
    // Actions group starts with More and keeps its order.
    expect(wrapper.find('.ti-header-actions').element.children[0].className).toContain('ti-btn-more-menu')
  })

  it('starts select-element mode and closes the popup', async () => {
    mockToggleSelectElement.mockResolvedValue(true)
    const wrapper = mount(PopupHeader, { props: { targetLanguage: 'fa', provider: 'google' } })
    await wrapper.vm.$nextTick()

    await wrapper.find('.ti-select-action .ti-btn-select').trigger('click')

    expect(mockToggleSelectElement).toHaveBeenCalledWith({ targetLanguage: 'fa', provider: 'google' })
    expect(closePopup).toHaveBeenCalled()
  })

  it('sends a revert request from the Revert badge', async () => {
    mockSendMessage.mockResolvedValue({ success: true })
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    // Revert is a direct badge button — click it, no menu involved.
    await wrapper.find('.ti-select-action .ti-btn-revert-badge').trigger('click')
    await flushPromises()

    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: MessageActions.REVERT_SELECT_ELEMENT_MODE
    }))
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)
  })

  it('reports partial Revert details once without serializing error objects', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()
    mockSendMessage.mockResolvedValueOnce({
      success: true,
      partial: true,
      revertedCount: 2,
      errors: [{ system: 'vue', error: 'restore failed' }],
      message: 'Translation partially reverted'
    })

    await wrapper.find('.ti-btn-revert-badge').trigger('click')
    await flushPromises()

    expect(mockHandleError).toHaveBeenCalledOnce()
    const [error, context, options] = mockHandleError.mock.calls[0]
    expect(error.message).toContain('Revert partially completed')
    expect(error.message).toContain('vue: restore failed')
    expect(error.message).not.toContain('[object Object]')
    expect(error.message).not.toContain('Translation partially reverted')
    expect(context).toBe('popup-header-revert-failed')
    expect(options).toEqual({ isSilent: true })
  })

  it('silently handles failed Revert responses and messaging errors with their contexts', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    mockSendMessage.mockResolvedValueOnce({ success: false, error: 'restore failed' })
    await wrapper.find('.ti-btn-revert-badge').trigger('click')
    await flushPromises()
    expect(mockHandleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Revert failed: restore failed' }),
      'popup-header-revert-failed',
      { isSilent: true }
    )

    mockHandleError.mockClear()
    const transportError = new Error('transport failed')
    mockSendMessage.mockRejectedValueOnce(transportError)
    await wrapper.find('.ti-btn-revert-badge').trigger('click')
    await flushPromises()
    expect(mockHandleError).toHaveBeenCalledOnce()
    expect(mockHandleError).toHaveBeenCalledWith(transportError, 'PopupHeader-revert', { isSilent: true })
  })

  it('treats a zero-count full Revert as success without error feedback', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()
    mockSendMessage.mockResolvedValueOnce({ success: true, revertedCount: 0 })

    await wrapper.find('.ti-btn-revert-badge').trigger('click')
    await flushPromises()

    expect(mockHandleError).not.toHaveBeenCalled()
  })

  it('keeps restricted Revert responses and exceptions quiet', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    mockSendMessage.mockResolvedValueOnce({ success: false, isRestrictedPage: true })
    await wrapper.find('.ti-btn-revert-badge').trigger('click')
    await flushPromises()
    expect(mockHandleError).not.toHaveBeenCalled()

    mockSendMessage.mockRejectedValueOnce(Object.assign(new Error('restricted'), { isRestrictedPage: true }))
    await wrapper.find('.ti-btn-revert-badge').trigger('click')
    await flushPromises()
    expect(mockHandleError).not.toHaveBeenCalled()
  })

  // ── More menu modernization ─────────────────────────────────────────

  it('orders the menu: Subtitle, PDF, History, responsive duplicates, the FAB action, then the site action last', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const panel = await openMoreMenu(wrapper)
    const items = panel.findAll('[role="menuitem"]')
    expect(items).toHaveLength(8)

    // 1: subtitle is a multicolor <img> (ADR-001, same as PDF); 2: PDF stays a branded <img>.
    const subtitleImg = items[0].find('img')
    expect(subtitleImg.exists()).toBe(true)
    expect(subtitleImg.attributes('src')).toContain('subtitle.svg')
    expect(subtitleImg.attributes('alt')).toBe('')
    expect(subtitleImg.attributes('aria-hidden')).toBe('true')
    expect(items[0].findComponent(MaskIcon).exists()).toBe(false)
    expect(items[0].text()).toContain('popup_subtitle_title_icon')
    expect(items[1].find('img').attributes('src')).toContain('pdf.png')

    // 3: permanent History action precedes responsive-only duplicates.
    expect(items[2].text()).toContain('Translation History')
    expect(items[2].find('img').exists()).toBe(false)
    expect(items[2].findComponent(MaskIcon).props('src')).toContain('history.svg')

    // 4-6: responsive-only duplicates keep their existing classes
    // (conditions themselves covered by the dedicated tests above).
    expect(items[3].classes()).toContain('ti-header-menu-item--very-narrow-only')
    expect(items[4].classes()).toContain('ti-header-menu-item--narrow-only')
    expect(items[5].classes()).toContain('ti-header-menu-item--narrow-only')
    expect(items[5].findComponent(MaskIcon).props('src')).toContain('side-panel.png')

    // 7: the FAB action sits directly above the divider, never
    // breakpoint-gated (it replaces no direct toolbar button).
    expect(items[6].classes()).toContain('ti-header-menu-item--fab')
    expect(items[6].classes()).not.toContain('ti-header-menu-item--narrow-only')
    expect(items[6].classes()).not.toContain('ti-header-menu-item--very-narrow-only')

    // 8: site action is the FINAL menu action and never breakpoint-gated —
    // final at every viewport width.
    expect(items[7].text()).toContain('Disable on this site')
    expect(items[7].classes()).not.toContain('ti-header-menu-item--narrow-only')
    expect(items[7].classes()).not.toContain('ti-header-menu-item--very-narrow-only')
  })

  it('renders a separator immediately before the final site action', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const panel = await openMoreMenu(wrapper)
    const separator = panel.find('.ti-header-menu-separator')
    expect(separator.exists()).toBe(true)
    expect(separator.attributes('role')).toBe('separator')

    const items = panel.findAll('[role="menuitem"]')
    // Immediately after the FAB action…
    expect(separator.element.previousElementSibling).toBe(items[6].element)
    expect(items[6].classes()).toContain('ti-header-menu-item--fab')
    // …and immediately before the site action.
    expect(separator.element.nextElementSibling).toBe(items[7].element)
    expect(items[7].text()).toContain('Disable on this site')
  })

  it('replaces the Unicode checkbox with a decorative, non-interactive CSS indicator', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const panel = await openMoreMenu(wrapper)

    // Old Unicode checkbox/checkmark is gone from the rendered menu.
    expect(panel.text()).not.toContain('☐')
    expect(panel.text()).not.toContain('✓')

    const indicator = panel.find('.ti-header-menu-site-indicator')
    expect(indicator.exists()).toBe(true)
    // Decorative only: hidden from AT, a bare span, never focusable —
    // no interaction lives on the indicator itself.
    expect(indicator.attributes('aria-hidden')).toBe('true')
    expect(indicator.element.tagName).toBe('SPAN')
    expect(indicator.attributes('tabindex')).toBeUndefined()
    expect(['BUTTON', 'INPUT', 'A']).not.toContain(indicator.element.tagName)
    // Enabled (default): indicator is NOT in the excluded state.
    expect(indicator.classes()).not.toContain('is-excluded')
    // State class is bound to !isExtensionEnabled (covered flipping to
    // .is-excluded in the server-confirmed toggle test above).
    expect(indicator.classes()).toContain('ti-header-menu-site-indicator')
  })

  it('binds the open state onto the More trigger via aria-expanded (no component state)', async () => {
    const wrapper = mount(PopupHeader)
    await wrapper.vm.$nextTick()

    const more = wrapper.find('.ti-btn-more')
    expect(more.attributes('aria-expanded')).toBe('false')
    expect(more.attributes('aria-haspopup')).toBe('menu')

    await more.trigger('click')
    expect(more.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(true)
  })

  // ── Desktop FAB per-tab visibility action ────────────────────────────

  describe('Desktop FAB visibility action', () => {
    const TAB = { id: 1, windowId: 7, url: 'https://example.com/' }
    const GET = MessageActions.DESKTOP_FAB_GET_STATUS
    const SET = MessageActions.DESKTOP_FAB_SET_OVERRIDE

    const statusSnapshot = (status, extra = {}) => ({
      success: true,
      status,
      url: TAB.url,
      ...extra
    })

    beforeEach(() => {
      globalThis.browser.tabs.query.mockReset()
      globalThis.browser.tabs.query.mockResolvedValue([TAB])
      globalThis.browser.tabs.sendMessage.mockReset()
      globalThis.browser.tabs.sendMessage.mockResolvedValue(undefined)
      mockUpdateSetting.mockReset()
    })

    afterEach(() => {
      // The settling-retry test drives the clock; never leak fake timers.
      vi.useRealTimers()
    })

    const fabItem = (panel) => panel.find('.ti-header-menu-item--fab')

    it('refreshes from the top frame on open and takes its label from the authoritative status', async () => {
      globalThis.browser.tabs.sendMessage.mockResolvedValue(statusSnapshot('hidden'))
      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      let panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)

      // Frame 0, the captured tab id, and the read action.
      expect(globalThis.browser.tabs.sendMessage).toHaveBeenCalledWith(
        TAB.id,
        { action: GET },
        { frameId: 0 }
      )
      expect(fabItem(panel).text()).toBe('Show FAB for Now')
      expect(fabItem(panel).attributes('disabled')).toBeUndefined()

      // Reopen: the status is re-read, never cached from the previous open.
      globalThis.browser.tabs.sendMessage.mockResolvedValue(statusSnapshot('visible'))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wrapper.vm.$nextTick()
      panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)

      expect(globalThis.browser.tabs.sendMessage).toHaveBeenCalledTimes(2)
      expect(fabItem(panel).text()).toBe('Hide FAB for Now')
    })

    it('renders exactly one FAB action and keeps the site action final after the divider', async () => {
      globalThis.browser.tabs.sendMessage.mockResolvedValue(statusSnapshot('visible'))
      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)

      expect(panel.findAll('.ti-header-menu-item--fab')).toHaveLength(1)
      const items = panel.findAll('[role="menuitem"]')
      expect(items[6].classes()).toContain('ti-header-menu-item--fab')
      expect(items[7].text()).toContain('Disable on this site')

      const separator = panel.find('.ti-header-menu-separator')
      expect(separator.element.previousElementSibling).toBe(items[6].element)
      expect(separator.element.nextElementSibling).toBe(items[7].element)
    })

    it('stays disabled with a neutral label and the loading explanation until the status lands', async () => {
      let resolveStatus
      globalThis.browser.tabs.sendMessage.mockImplementation(() =>
        new Promise((resolve) => { resolveStatus = resolve }))

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await wrapper.vm.$nextTick()

      let item = fabItem(panel)
      expect(item.attributes('disabled')).toBeDefined()
      expect(item.text()).toBe('Floating button')
      expect(item.attributes('title')).toBe('Reading the floating button’s status…')
      expect(item.attributes('aria-label')).toBe('Reading the floating button’s status…')

      resolveStatus(statusSnapshot('hidden'))
      await flushMicrotasks(wrapper)
      item = fabItem(panel)
      expect(item.attributes('disabled')).toBeUndefined()
      expect(item.text()).toBe('Show FAB for Now')
    })

    it('disables without any wire traffic while the extension is globally disabled', async () => {
      settings.EXTENSION_ENABLED = false
      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)

      expect(globalThis.browser.tabs.sendMessage).not.toHaveBeenCalled()
      const item = fabItem(panel)
      expect(item.attributes('disabled')).toBeDefined()
      expect(item.text()).toBe('Floating button')
      const explanation = 'The floating button is unavailable while the extension is disabled.'
      expect(item.attributes('title')).toBe(explanation)
      expect(item.attributes('aria-label')).toBe(explanation)
      expect(mockT).toHaveBeenCalledWith('popup_fab_disabled_reason', explanation)
    })

    it('reports a restricted page or missing receiver without leaking raw transport text', async () => {
      globalThis.browser.tabs.sendMessage.mockRejectedValue(
        new Error('Could not establish connection. Receiving end does not exist.')
      )
      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)

      const item = fabItem(panel)
      expect(item.attributes('disabled')).toBeDefined()
      expect(item.text()).toBe('Floating button')
      const generic = 'The floating button’s status is unavailable on this page.'
      expect(item.attributes('title')).toBe(generic)
      expect(item.attributes('aria-label')).toBe(generic)
      expect(mockT).toHaveBeenCalledWith('popup_fab_unavailable_reason', generic)
      // The browser's error message stays internal — never in the a11y tree.
      expect(item.attributes('title')).not.toContain('Could not establish connection')
      expect(item.attributes('aria-label')).not.toContain('Receiving end does not exist')
      // Never claims a state it does not have.
      expect(item.text()).not.toContain('Show FAB')
      expect(item.text()).not.toContain('Hide FAB')
    })

    it('maps recognized content reason codes to localized text and hides unknown ones', async () => {
      const generic = 'The floating button’s status is unavailable on this page.'
      const cases = [
        ['global-disabled', 'The Desktop FAB setting hides the floating button here.', 'popup_fab_reason_disabled_by_setting'],
        ['fullscreen', 'The floating button is hidden while this page is fullscreen.', 'popup_fab_reason_fullscreen'],
        ['ui-absent', 'The floating button is not available on this page.', 'popup_fab_reason_ui_absent'],
        ['mobile-ui', 'The floating button is not available on this page.', 'popup_fab_reason_ui_absent'],
        // Unknown codes (and raw transport detail) never surface verbatim.
        ['write-refused', generic, 'popup_fab_unavailable_reason'],
        ['Could not establish connection. Receiving end does not exist.', generic, 'popup_fab_unavailable_reason']
      ]

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      for (const [reason, expected, key] of cases) {
        globalThis.browser.tabs.sendMessage.mockResolvedValue(
          statusSnapshot('unavailable', { reason })
        )
        const panel = await openMoreMenu(wrapper)
        await flushMicrotasks(wrapper)

        const item = fabItem(panel)
        expect(item.attributes('disabled')).toBeDefined()
        expect(item.text()).toBe('Floating button')
        expect(item.attributes('title')).toBe(expected)
        expect(item.attributes('aria-label')).toBe(expected)
        expect(mockT).toHaveBeenCalledWith(key, expected)
        // Raw code/message must never appear in the accessible explanation.
        if (expected.indexOf(reason) === -1) {
          expect(item.attributes('title')).not.toContain(reason)
          expect(item.attributes('aria-label')).not.toContain(reason)
        }

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await wrapper.vm.$nextTick()
      }
    })

    it('fails closed on replies that are not a successful exact-addressed read', async () => {
      const payloads = [
        { status: 'visible' },
        { success: false, status: 'visible', url: TAB.url },
        { success: true, status: 'visible' },
        { success: true, status: 'visible', url: 'https://other.example/' }
      ]

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      for (const payload of payloads) {
        globalThis.browser.tabs.sendMessage.mockResolvedValue(payload)
        const panel = await openMoreMenu(wrapper)
        await flushMicrotasks(wrapper)

        const item = fabItem(panel)
        expect(item.attributes('disabled')).toBeDefined()
        expect(item.text()).toBe('Floating button')
        expect(item.text()).not.toContain('Hide FAB for Now')
        expect(item.text()).not.toContain('Show FAB for Now')

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await wrapper.vm.$nextTick()
      }
    })

    it('disables when the active tab changes under an in-flight read, even with the same URL', async () => {
      let resolveStatus
      globalThis.browser.tabs.sendMessage.mockImplementation(() =>
        new Promise((resolve) => { resolveStatus = resolve }))

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await wrapper.vm.$nextTick()

      // Same URL, different tab id: the sequence token alone cannot see this.
      globalThis.browser.tabs.query.mockResolvedValue([
        { id: 42, windowId: 7, url: TAB.url }
      ])
      resolveStatus(statusSnapshot('visible'))
      await flushMicrotasks(wrapper)

      const item = fabItem(panel)
      expect(item.attributes('disabled')).toBeDefined()
      expect(item.text()).toBe('Floating button')
      expect(item.text()).not.toContain('Hide FAB for Now')
      expect(wrapper.vm.isFabActionDisabled).toBe(true)
    })

    it('fences a stale active-tab confirmation after reopening', async () => {
      const pendingStatus = []
      let heldConfirm = null
      let queries = 0
      globalThis.browser.tabs.sendMessage.mockImplementation(() =>
        new Promise((resolve) => { pendingStatus.push(resolve) }))

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()
      await flushMicrotasks(wrapper)

      globalThis.browser.tabs.query.mockImplementation(() => {
        queries += 1
        // Second query is read#1's post-reply confirmation.
        if (queries === 2) return new Promise((resolve) => { heldConfirm = resolve })
        return Promise.resolve([TAB])
      })

      await openMoreMenu(wrapper)
      await wrapper.vm.$nextTick()
      pendingStatus[0](statusSnapshot('visible'))
      await flushMicrotasks(wrapper)

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      pendingStatus[1](statusSnapshot('hidden'))
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Show FAB for Now')

      // The first read's confirmation resolves late: it must not apply.
      heldConfirm([TAB])
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Show FAB for Now')
      expect(wrapper.vm.fabState.status).toBe('hidden')
    })

    it('fences a status reply that belongs to another document', async () => {
      globalThis.browser.tabs.sendMessage.mockResolvedValue({
        success: true,
        status: 'visible',
        url: 'https://other.example/'
      })
      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)

      const item = fabItem(panel)
      expect(item.attributes('disabled')).toBeDefined()
      expect(item.text()).toBe('Floating button')
      const generic = 'The floating button’s status is unavailable on this page.'
      expect(item.attributes('title')).toBe(generic)
      expect(mockT).toHaveBeenCalledWith('popup_fab_unavailable_reason', generic)
    })

    it('discards a stale status reply from a previous open', async () => {
      const pending = []
      globalThis.browser.tabs.sendMessage.mockImplementation(() =>
        new Promise((resolve) => { pending.push(resolve) }))

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      await openMoreMenu(wrapper)
      await wrapper.vm.$nextTick()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wrapper.vm.$nextTick()

      // Second open answers first…
      const panel = await openMoreMenu(wrapper)
      pending[1](statusSnapshot('hidden'))
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Show FAB for Now')

      // …then the first open's late reply arrives and must be dropped.
      pending[0](statusSnapshot('visible'))
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Show FAB for Now')
    })

    it('sends the hide override with expectedUrl and re-reads instead of flipping optimistically', async () => {
      let status = 'visible'
      let holdVerify = false
      let verifyResolve
      globalThis.browser.tabs.sendMessage.mockImplementation((tabId, message) => {
        if (message.action === SET) {
          status = 'hidden'
          return Promise.resolve({ success: true })
        }
        if (holdVerify) return new Promise((resolve) => { verifyResolve = resolve })
        return Promise.resolve(statusSnapshot(status))
      })

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      let panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Hide FAB for Now')

      holdVerify = true // from now on, the authoritative GET stays pending
      await fabItem(panel).trigger('click')
      await wrapper.vm.$nextTick()

      expect(globalThis.browser.tabs.sendMessage).toHaveBeenCalledWith(
        TAB.id,
        { action: SET, data: { expectedUrl: TAB.url, override: 'hide' } },
        { frameId: 0 }
      )
      // No optimistic flip while the authoritative re-read is in flight: the
      // row is pending — disabled with the neutral label, never a guessed
      // action — and the override itself owns that pending state.
      expect(wrapper.vm.fabState.status).toBe('loading')
      expect(wrapper.vm.isFabActionDisabled).toBe(true)
      expect(wrapper.vm.fabActionLabel).toBe('Floating button')

      holdVerify = false
      verifyResolve(statusSnapshot('hidden'))
      await flushMicrotasks(wrapper)
      expect(wrapper.vm.fabState.status).toBe('hidden')

      panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Show FAB for Now')
    })

    it('sends the show override when the FAB is hidden', async () => {
      globalThis.browser.tabs.sendMessage.mockImplementation((tabId, message) =>
        message.action === SET
          ? Promise.resolve({ success: true })
          : Promise.resolve(statusSnapshot('hidden')))

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      await fabItem(panel).trigger('click')
      await flushPromises()

      expect(globalThis.browser.tabs.sendMessage).toHaveBeenCalledWith(
        TAB.id,
        { action: SET, data: { expectedUrl: TAB.url, override: 'show' } },
        { frameId: 0 }
      )
    })

    it('never controls a tab other than the one the status came from', async () => {
      globalThis.browser.tabs.sendMessage.mockResolvedValue(statusSnapshot('visible'))
      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      globalThis.browser.tabs.sendMessage.mockClear()

      // The user switched tabs while the menu was open.
      globalThis.browser.tabs.query.mockResolvedValue([
        { id: 42, windowId: 7, url: 'https://other.example/' }
      ])
      await fabItem(panel).trigger('click')
      await flushPromises()

      const overrides = globalThis.browser.tabs.sendMessage.mock.calls
        .filter(([, message]) => message.action === SET)
      expect(overrides).toHaveLength(0)
      // Instead the row re-reads the newly active tab.
      expect(globalThis.browser.tabs.sendMessage).toHaveBeenCalledWith(
        42,
        { action: GET },
        { frameId: 0 }
      )
    })

    it('never claims success when the setter reports failure', async () => {
      let writeRefused = false
      globalThis.browser.tabs.sendMessage.mockImplementation((tabId, message) =>
        message.action === SET
          ? Promise.resolve(writeRefused
            ? { success: false, status: 'unavailable', url: TAB.url, reason: 'write refused' }
            : { success: true })
          : Promise.resolve(statusSnapshot('visible')))

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      let panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)

      writeRefused = true
      await fabItem(panel).trigger('click')
      await flushPromises()

      // The failed write is reported, never optimistically applied: the row
      // goes neutral/disabled with the content script's own reason and the
      // label never becomes "Show FAB for Now" (which would claim a hide).
      expect(wrapper.vm.fabState.status).toBe('unavailable')
      expect(wrapper.vm.fabState.reason).toBe('write refused')
      expect(wrapper.vm.isFabActionDisabled).toBe(true)
      expect(wrapper.vm.fabActionLabel).toBe('Floating button')
      // The raw reason stays internal: the explanation is localized.
      expect(wrapper.vm.fabActionExplanation)
        .toBe('The floating button’s status is unavailable on this page.')
      expect(wrapper.vm.fabActionExplanation).not.toContain('write refused')
      expect(closePopup).not.toHaveBeenCalled()

      // Reopening re-reads the truth: the FAB is still visible there, so the
      // row offers the hide action again instead of a phantom "show".
      panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      const item = fabItem(panel)
      expect(item.attributes('disabled')).toBeUndefined()
      expect(item.text()).toBe('Hide FAB for Now')
      // The popup stays open, like the other toggle-style actions.
      expect(closePopup).not.toHaveBeenCalled()
    })

    it('keeps global settings untouched and the popup open after a successful override', async () => {
      const settingsBefore = JSON.parse(JSON.stringify(settings))
      globalThis.browser.tabs.sendMessage.mockImplementation((tabId, message) =>
        message.action === SET
          ? Promise.resolve({ success: true })
          : Promise.resolve(statusSnapshot('visible')))

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      await fabItem(panel).trigger('click')
      await flushPromises()

      expect(closePopup).not.toHaveBeenCalled()
      expect(mockUpdateSetting).not.toHaveBeenCalled()
      expect(settings).toEqual(settingsBefore)
      // No popup-routed (background) message ever carries the FAB actions.
      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: SET })
      )
      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: GET })
      )
    })

    it('exposes an accessible menuitem with a decorative ADR-001 mask icon and localized fallbacks', async () => {
      globalThis.browser.tabs.sendMessage.mockResolvedValue(statusSnapshot('hidden'))
      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)

      const item = fabItem(panel)
      expect(item.element.tagName).toBe('BUTTON')
      expect(item.attributes('type')).toBe('button')
      expect(item.attributes('role')).toBe('menuitem')
      // Enabled: the visible label stays the accessible name.
      expect(item.attributes('aria-label')).toBeUndefined()
      expect(item.attributes('title')).toBe('Show FAB for Now')

      const icon = item.findComponent(MaskIcon)
      expect(icon.props('src')).toContain('eye-open.svg')
      expect(icon.props('size')).toBe(18)
      expect(icon.attributes('aria-hidden')).toBe('true')

      // English fallbacks are passed as the second t() argument. Both the
      // in-flight label and the resolved label are requested during the
      // open→answer cycle; the hide label belongs to the visible state.
      expect(mockT).toHaveBeenCalledWith('popup_fab_show_label', 'Show FAB for Now')
      expect(mockT).toHaveBeenCalledWith('popup_fab_unknown_label', 'Floating button')
      expect(mockT).toHaveBeenCalledWith('popup_fab_loading_reason', 'Reading the floating button’s status…')
    })

    it('uses the hide-state icon and label while the FAB is visible', async () => {
      globalThis.browser.tabs.sendMessage.mockResolvedValue(statusSnapshot('visible'))
      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)

      const item = fabItem(panel)
      expect(item.findComponent(MaskIcon).props('src')).toContain('eye-hide.svg')
      expect(item.text()).toBe('Hide FAB for Now')
      expect(item.attributes('title')).toBe('Hide FAB for Now')
      expect(mockT).toHaveBeenCalledWith('popup_fab_hide_label', 'Hide FAB for Now')
    })

    it('omits the FAB action on mobile while the site action stays final', async () => {
      isMobile = true
      globalThis.browser.tabs.sendMessage.mockResolvedValue(statusSnapshot('visible'))
      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)

      expect(panel.findAll('.ti-header-menu-item--fab')).toHaveLength(0)
      expect(panel.findAll('[role="menuitem"]')).toHaveLength(5)
      const separator = panel.find('.ti-header-menu-separator')
      expect(separator.element.nextElementSibling.textContent).toContain('Disable on this site')
    })

    it('keeps the row disabled across a reopen while the SET is outstanding, then refreshes authoritatively', async () => {
      const pendingSet = []
      let status = 'visible'
      globalThis.browser.tabs.sendMessage.mockImplementation((tabId, message) => {
        if (message.action === SET) return new Promise((resolve) => { pendingSet.push(resolve) })
        return Promise.resolve(statusSnapshot(status))
      })

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      let panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Hide FAB for Now')

      // The command goes out and stays outstanding.
      await fabItem(panel).trigger('click')
      await wrapper.vm.$nextTick()
      expect(pendingSet).toHaveLength(1)
      expect(globalThis.browser.tabs.sendMessage).toHaveBeenCalledWith(
        TAB.id,
        { action: SET, data: { expectedUrl: TAB.url, override: 'hide' } },
        { frameId: 0 }
      )
      expect(wrapper.vm.isFabActionDisabled).toBe(true)

      // Reopen while the write is in flight: the read answers with the
      // PRE-write status, which must not re-enable the row with a stale action.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wrapper.vm.$nextTick()
      panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).attributes('disabled')).toBeDefined()
      expect(fabItem(panel).text()).toBe('Floating button')
      expect(fabItem(panel).text()).not.toContain('Hide FAB for Now')

      // The write lands (the child now hides the FAB): the authoritative
      // refresh that follows wins over the pre-write reply.
      pendingSet[0]({ success: true })
      status = 'hidden'
      await flushPromises()
      expect(wrapper.vm.isFabActionDisabled).toBe(false)
      expect(fabItem(panel).text()).toBe('Show FAB for Now')
    })

    it.each([
      ['reports failure', (complete) => complete({ success: false, reason: 'write refused' })],
      ['rejects', (complete) => complete(new Error('transport failed'))]
    ])('re-reads after a reopened menu when the outstanding SET %s', async (_description, completeSet) => {
      let resolveSet
      let getCount = 0
      globalThis.browser.tabs.sendMessage.mockImplementation((tabId, message) => {
        if (message.action === SET) {
          return new Promise((resolve, reject) => {
            resolveSet = (result) => result instanceof Error ? reject(result) : resolve(result)
          })
        }
        getCount += 1
        // Reopen gets the pre-write status; the recovery read gets current truth.
        return Promise.resolve(statusSnapshot(getCount < 3 ? 'visible' : 'hidden'))
      })

      const settingsBefore = JSON.parse(JSON.stringify(settings))
      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      let panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      await fabItem(panel).trigger('click')
      await flushMicrotasks(wrapper)

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wrapper.vm.$nextTick()
      panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Floating button')
      expect(fabItem(panel).attributes('disabled')).toBeDefined()

      completeSet(resolveSet)
      await flushPromises()

      expect(getCount).toBe(3)
      expect(globalThis.browser.tabs.sendMessage.mock.calls.filter(([, message]) => message.action === SET))
        .toHaveLength(1)
      expect(globalThis.browser.tabs.sendMessage.mock.calls
        .filter(([, message]) => message.action === GET))
        .toEqual(Array.from({ length: 3 }, () => [TAB.id, { action: GET }, { frameId: 0 }]))
      expect(wrapper.vm.fabState.status).toBe('hidden')
      expect(fabItem(panel).text()).toBe('Show FAB for Now')
      expect(fabItem(panel).attributes('disabled')).toBeUndefined()
      expect(mockUpdateSetting).not.toHaveBeenCalled()
      expect(settings).toEqual(settingsBefore)
    })

    it('retries a transient post-write loading status until the child is present, without open-ended polling', async () => {
      vi.useFakeTimers()
      // 'hidden' → the show command mounts the child, which reports loading
      // for exactly one read, then 'visible'.
      let phase = 'hidden'
      globalThis.browser.tabs.sendMessage.mockImplementation((tabId, message) => {
        if (message.action === SET) {
          phase = 'mounting'
          return Promise.resolve({ success: true })
        }
        if (phase === 'mounting') {
          phase = 'visible'
          return Promise.resolve(statusSnapshot('loading', { reason: 'fab-settling' }))
        }
        return Promise.resolve(statusSnapshot(phase))
      })

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Show FAB for Now')

      // Drive the command directly so the menu — and the row — stay open.
      await wrapper.vm.handleFabVisibilityOverride()
      await flushMicrotasks(wrapper)

      // Transient loading: disabled with the neutral label, never the
      // optimistic post-write action.
      expect(fabItem(panel).attributes('disabled')).toBeDefined()
      expect(fabItem(panel).text()).toBe('Floating button')
      expect(fabItem(panel).text()).not.toContain('Hide FAB for Now')

      const getStatusReads = () => globalThis.browser.tabs.sendMessage.mock.calls
        .filter(([, message]) => message.action === GET).length
      const readsWhileLoading = getStatusReads()

      // The bounded retry picks the status up once the child is present.
      await vi.advanceTimersByTimeAsync(150)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Hide FAB for Now')
      expect(fabItem(panel).attributes('disabled')).toBeUndefined()
      const readsAfterSettle = getStatusReads()
      expect(readsAfterSettle).toBeGreaterThan(readsWhileLoading)

      // Settled: no further polling, however long the menu stays open.
      await vi.advanceTimersByTimeAsync(150 * 20)
      await flushMicrotasks(wrapper)
      expect(getStatusReads()).toBe(readsAfterSettle)
      expect(fabItem(panel).text()).toBe('Hide FAB for Now')
    })

    it('bounds the settling retry when the child never leaves loading', async () => {
      vi.useFakeTimers()
      let reads = 0
      globalThis.browser.tabs.sendMessage.mockImplementation((tabId, message) => {
        if (message.action === SET) return Promise.resolve({ success: true })
        reads += 1
        // The first read is settled; every read after the write is loading.
        return Promise.resolve(reads === 1
          ? statusSnapshot('hidden')
          : statusSnapshot('loading', { reason: 'fab-settling' }))
      })

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Show FAB for Now')

      await wrapper.vm.handleFabVisibilityOverride()
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).attributes('disabled')).toBeDefined()
      const readsAfterWrite = reads

      // A never-settling child drains the retry budget instead of polling.
      await vi.advanceTimersByTimeAsync(150 * 20)
      await flushMicrotasks(wrapper)
      expect(reads - readsAfterWrite).toBeLessThanOrEqual(8)
      const boundedTotal = reads
      await vi.advanceTimersByTimeAsync(150 * 20)
      await flushMicrotasks(wrapper)
      expect(reads).toBe(boundedTotal)
    })

    it('recovers with one fresh read when a command is superseded before it is sent', async () => {
      let holdNextQuery = false
      let heldQuery = null
      globalThis.browser.tabs.query.mockImplementation(() => {
        if (holdNextQuery) {
          holdNextQuery = false
          return new Promise((resolve) => { heldQuery = resolve })
        }
        return Promise.resolve([TAB])
      })
      // No write ever happens; every read reports the pre-command truth.
      globalThis.browser.tabs.sendMessage.mockResolvedValue(statusSnapshot('visible'))

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      let panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Hide FAB for Now')

      // The command's pre-send tab query hangs…
      holdNextQuery = true
      await fabItem(panel).trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.isFabActionDisabled).toBe(true)

      // …the user reopens, and that read's reply is dropped because the
      // abandoned command still owns the row.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wrapper.vm.$nextTick()
      panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Floating button')

      // The hung query resolves: the command aborts unsent, and exactly one
      // fresh authoritative read replaces the swallowed one.
      heldQuery([TAB])
      await flushPromises()

      const calls = globalThis.browser.tabs.sendMessage.mock.calls
      expect(calls.filter(([, message]) => message.action === SET)).toHaveLength(0)
      expect(calls.filter(([, message]) => message.action === GET)).toHaveLength(3)
      expect(fabItem(panel).text()).toBe('Hide FAB for Now')
      expect(fabItem(panel).attributes('disabled')).toBeUndefined()
    })

    it('stops the settling retry once the menu closes, even for a late loading reply', async () => {
      vi.useFakeTimers()
      let phase = 'hidden'
      let holdLoadingReply = false
      let heldLoadingReply = null
      globalThis.browser.tabs.sendMessage.mockImplementation((tabId, message) => {
        if (message.action === SET) {
          phase = 'loading'
          return Promise.resolve({ success: true })
        }
        if (phase === 'loading') {
          if (holdLoadingReply) return new Promise((resolve) => { heldLoadingReply = resolve })
          return Promise.resolve(statusSnapshot('loading', { reason: 'fab-settling' }))
        }
        return Promise.resolve(statusSnapshot(phase))
      })

      const wrapper = mount(PopupHeader)
      await wrapper.vm.$nextTick()

      const panel = await openMoreMenu(wrapper)
      await flushMicrotasks(wrapper)
      expect(fabItem(panel).text()).toBe('Show FAB for Now')

      // The post-write read stays in flight while the menu is open.
      holdLoadingReply = true
      await wrapper.vm.handleFabVisibilityOverride()
      await flushMicrotasks(wrapper)
      const readsBeforeClose = globalThis.browser.tabs.sendMessage.mock.calls
        .filter(([, message]) => message.action === GET).length

      // Menu closes before the reply lands.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.toolbar-menu-panel-stub').exists()).toBe(false)

      // A late transient-loading reply must not re-arm the retry leash.
      holdLoadingReply = false
      heldLoadingReply(statusSnapshot('loading', { reason: 'fab-settling' }))
      await flushMicrotasks(wrapper)
      expect(wrapper.vm.fabState.status).toBe('loading')

      await vi.advanceTimersByTimeAsync(150 * 10)
      await flushMicrotasks(wrapper)
      expect(globalThis.browser.tabs.sendMessage.mock.calls
        .filter(([, message]) => message.action === GET).length).toBe(readsBeforeClose)
    })

    it('ships every FAB key in the en, fa and ja dictionaries', () => {
      const localesDir = resolve(srcDir, '_locales')
      const keys = [
        'popup_fab_show_label',
        'popup_fab_hide_label',
        'popup_fab_unknown_label',
        'popup_fab_loading_reason',
        'popup_fab_unavailable_reason',
        'popup_fab_disabled_reason',
        'popup_fab_reason_disabled_by_setting',
        'popup_fab_reason_fullscreen',
        'popup_fab_reason_ui_absent'
      ]
      const read = (locale) =>
        JSON.parse(readFileSync(resolve(localesDir, `${locale}/messages.json`), 'utf8'))

      for (const locale of ['en', 'fa', 'ja']) {
        const messages = read(locale)
        for (const key of keys) {
          expect(messages[key], `${locale} is missing ${key}`).toBeTruthy()
          expect(typeof messages[key].message).toBe('string')
          expect(messages[key].message.trim()).not.toBe('')
        }
      }
      // The fa strings are RTL copy: they must not be English passthroughs.
      const fa = read('fa')
      expect(fa.popup_fab_show_label.message).not.toBe('Show FAB for Now')
      expect(fa.popup_fab_hide_label.message).not.toBe('Hide FAB for Now')
      expect(fa.popup_fab_reason_fullscreen.message)
        .not.toBe('The floating button is hidden while this page is fullscreen.')
      expect(fa.popup_fab_reason_disabled_by_setting.message)
        .not.toBe('The Desktop FAB setting hides the floating button here.')
      const ja = read('ja')
      expect(ja.popup_fab_show_label.message).not.toBe('Show FAB for Now')
      expect(ja.popup_fab_reason_ui_absent.message)
        .not.toBe('The floating button is not available on this page.')
    })
  })
})
