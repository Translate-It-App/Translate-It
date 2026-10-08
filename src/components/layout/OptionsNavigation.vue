<template>
  <div
    ref="navRoot"
    class="options-navigation"
  >
    <div
      data-scroll-frame
      :data-scroll-previous="canScrollPrevious ? '' : null"
      :data-scroll-next="canScrollNext ? '' : null"
    >
      <button
        v-if="showArrows && canScrollPrevious"
        class="tab-scroll-arrow previous"
        data-scroll-edge="start"
        :data-scroll-chevron="isVerticalNavigation ? 'up' : 'left'"
        type="button"
        :aria-label="t(isVerticalNavigation ? 'options_tabs_scroll_up' : 'options_tabs_scroll_previous')"
        @click="scrollTabs(-1)"
      >
        {{ isVerticalNavigation ? '↑' : '‹' }}
      </button>
      <nav
        ref="tabViewport"
        class="vertical-tabs tab-viewport"
        :class="{ 'has-previous': canScrollPrevious, 'has-next': canScrollNext }"
        @scroll="updateScrollState"
      >
        <router-link
          v-for="item in navigationItems"
          :key="item.name"
          :to="{ name: item.name }"
          :class="['tab-button', { active: $route.name === item.name, disabled: item.disabled }]"
          :aria-current="$route.name === item.name ? 'page' : undefined"
        >
          {{ t(item.labelKey) }}
        </router-link>
      </nav>
      <button
        v-if="showArrows && canScrollNext"
        class="tab-scroll-arrow next"
        data-scroll-edge="end"
        :data-scroll-chevron="isVerticalNavigation ? 'down' : 'right'"
        type="button"
        :aria-label="t(isVerticalNavigation ? 'options_tabs_scroll_down' : 'options_tabs_scroll_next')"
        @click="scrollTabs(1)"
      >
        {{ isVerticalNavigation ? '↓' : '›' }}
      </button>
    </div>
    <div
      ref="actionArea"
      class="tabs-action-area"
    >
      <button 
        id="saveSettings" 
        :disabled="isSaving"
        class="save-button"
        @click="saveAllSettings"
      >
        {{ t('save_settings_button') || 'Save' }}
      </button>
    </div>
    <Teleport
      :to="toastTarget || 'body'"
      :disabled="!toastTarget"
    >
      <div
        id="status"
        :class="['options-status-toast', `status-${statusType}`, { 'is-visible': statusMessage }]"
        :role="statusType === 'error' ? 'alert' : 'status'"
        aria-atomic="true"
      >
        {{ statusMessage }}
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import './OptionsNavigation.scss'
import { useRouter } from 'vue-router'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { safeSendMessage } from '@/shared/messaging/core/UnifiedMessaging.js'
import { MessageActions } from '@/shared/messaging/core/MessageActions.js'
import { getFirstMissingSetting } from '@/features/translation/utils/providerValidator.js'
import { PROMPT_REGISTRY } from '@/shared/config/PromptRegistry.js'
import { storageManager } from '@/shared/storage/core/StorageCore.js'
import { CONFIG } from '@/shared/config/config.js'

const logger = getScopedLogger(LOG_COMPONENTS.UI, 'OptionsNavigation')

const { t, locale } = useUnifiedI18n()
const settingsStore = useSettingsStore()
const router = useRouter()

const navRoot = ref(null)
const tabViewport = ref(null)
const actionArea = ref(null)
const canScrollPrevious = ref(false)
const canScrollNext = ref(false)
const showArrows = ref(false)
const isVerticalNavigation = ref(false)
let resizeObserver
let mutationObserver
let lastViewportWidth
let lastViewportHeight
let actionClearanceContainer
const toastTarget = ref(null)
const scrollBehavior = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth'

const updateScrollState = () => {
  const viewport = tabViewport.value
  if (!viewport) return
  const bounds = viewport.getBoundingClientRect()
  const items = [...viewport.children]
  const first = items[0]?.getBoundingClientRect()
  const last = items.at(-1)?.getBoundingClientRect()
  if (isVerticalNavigation.value) {
    canScrollPrevious.value = viewport.scrollHeight > viewport.clientHeight && Boolean(first && first.top < bounds.top - 1)
    canScrollNext.value = viewport.scrollHeight > viewport.clientHeight && Boolean(last && last.bottom > bounds.bottom + 1)
    showArrows.value = viewport.scrollHeight > viewport.clientHeight
  } else {
    const rtl = getComputedStyle(viewport).direction === 'rtl'
    canScrollPrevious.value = viewport.scrollWidth > viewport.clientWidth && Boolean(rtl ? first && first.right > bounds.right + 1 : first && first.left < bounds.left - 1)
    canScrollNext.value = viewport.scrollWidth > viewport.clientWidth && Boolean(rtl ? last && last.left < bounds.left - 1 : last && last.right > bounds.right + 1)
    showArrows.value = viewport.scrollWidth > viewport.clientWidth
  }
}

const revealActiveTab = () => {
  const viewport = tabViewport.value
  const active = viewport?.querySelector('.tab-button.active')
  if (!viewport || !active) return
  const bounds = viewport.getBoundingClientRect()
  const itemBounds = active.getBoundingClientRect()
  const clipped = isVerticalNavigation.value
    ? itemBounds.top < bounds.top || itemBounds.bottom > bounds.bottom
    : itemBounds.left < bounds.left || itemBounds.right > bounds.right
  if (clipped) active.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: scrollBehavior() })
  globalThis.requestAnimationFrame?.(updateScrollState) ?? updateScrollState()
}

const scrollTabs = (direction) => {
  const viewport = tabViewport.value
  if (!viewport) return
  if (isVerticalNavigation.value) {
    const bounds = viewport.getBoundingClientRect()
    const items = [...viewport.children]
    const candidate = direction < 0
      ? [...items].reverse().find(el => el.getBoundingClientRect().top < bounds.top - 1)
      : items.find(el => el.getBoundingClientRect().bottom > bounds.bottom + 1)
    candidate?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: scrollBehavior() })
    return
  }
  const rtl = getComputedStyle(viewport).direction === 'rtl'
  const bounds = viewport.getBoundingClientRect()
  const items = [...viewport.children]
  const candidate = direction < 0
    ? (rtl ? items.find(el => el.getBoundingClientRect().right > bounds.right + 1) : [...items].reverse().find(el => el.getBoundingClientRect().left < bounds.left - 1))
    : (rtl ? [...items].reverse().find(el => el.getBoundingClientRect().left < bounds.left - 1) : items.find(el => el.getBoundingClientRect().right > bounds.right + 1))
  candidate?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: scrollBehavior() })
}

const syncMobileActionHeight = () => {
  actionClearanceContainer ??= navRoot.value?.closest('.extension-options') || navRoot.value?.closest('.options-main')
  if (actionArea.value) actionClearanceContainer?.style.setProperty('--mobile-action-height', `${actionArea.value.getBoundingClientRect().height}px`)
}

const handleWindowResize = () => {
  const width = tabViewport.value?.getBoundingClientRect().width
  const height = tabViewport.value?.getBoundingClientRect().height
  if (width == null || height == null) return
  const viewportChanged = width !== lastViewportWidth || height !== lastViewportHeight
  lastViewportWidth = width
  lastViewportHeight = height
  isVerticalNavigation.value = window.innerWidth > 1024
  updateScrollState()
  if (viewportChanged) revealActiveTab()
}

onMounted(async () => {
  await nextTick()
  actionClearanceContainer = navRoot.value?.closest('.extension-options') || navRoot.value?.closest('.options-main')
  toastTarget.value = navRoot.value?.closest('.extension-options') || null
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => { updateScrollState(); syncMobileActionHeight() })
    resizeObserver.observe(tabViewport.value)
    resizeObserver.observe(actionArea.value)
  }
  if (typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver(() => { updateScrollState(); syncMobileActionHeight() })
    mutationObserver.observe(tabViewport.value, { childList: true, subtree: true, characterData: true })
  }
  isVerticalNavigation.value = window.innerWidth > 1024
  updateScrollState()
  syncMobileActionHeight()
  lastViewportWidth = tabViewport.value?.getBoundingClientRect().width
  lastViewportHeight = tabViewport.value?.getBoundingClientRect().height
  window.addEventListener('resize', handleWindowResize)
  revealActiveTab()
})
onBeforeUnmount(() => { resizeObserver?.disconnect(); mutationObserver?.disconnect(); window.removeEventListener('resize', handleWindowResize); actionClearanceContainer?.style.removeProperty('--mobile-action-height') })
watch(() => router.currentRoute.value.fullPath, async () => { await nextTick(); revealActiveTab() })
watch(() => locale.value, async () => { await nextTick(); revealActiveTab(); updateScrollState() })

// Navigation items, labels are reactive to language changes
const navigationItems = ref([
  { name: 'languages', labelKey: 'languages_tab_title' },
  { name: 'providers', labelKey: 'providers_tab_title' },
  { name: 'activation', labelKey: 'activation_tab_title' },
  { name: 'tts', labelKey: 'tts_tab_title' },
  { name: 'ocr', labelKey: 'ocr_tab_title' },
  { name: 'pdf', labelKey: 'pdf_tab_title' },
  { name: 'prompt', labelKey: 'prompt_tab_title' },
  { name: 'appearance', labelKey: 'appearance_tab_title' },
  { name: 'advance', labelKey: 'advance_tab_title' },
  { name: 'import-export', labelKey: 'import_export_tab_title' },
  { name: 'help', labelKey: 'help_tab_title' },
  { name: 'about', labelKey: 'about_tab_title' }
])

// Watch for language change to force update
watch(() => locale.value, () => {
  navigationItems.value = navigationItems.value.map(item => ({ ...item }))
})

// Status management
const statusMessage = ref('')
const statusType = ref('')
const isSaving = ref(false)

// Shared best-effort post-save notification/refresh helper.
// Persistence remains authoritative for save status and events.
const postSaveNotify = async () => {
  try {
    // Notify background that persisted settings changed.
    const response = await safeSendMessage({
      action: MessageActions.SETTINGS_UPDATED,
      timestamp: Date.now()
    }, 'settings-notification')

    if (response?.success !== true) {
      logger.warn('Settings update notification was not confirmed')
      return false
    }

    logger.debug('Settings update notification acknowledged by background')
    return true
  } catch (error) {
    logger.warn('Failed to send settings update notification:', error)
    return false
  }
}

// Partial save helper for prompt-only validation errors
const performPartialSave = async (errors) => {
  const invalidPromptKeys = errors.map(e => {
    const parts = e.split(':')
    return parts.length >= 2 ? parts[1] : null
  }).filter(Boolean)

  isSaving.value = true
  statusType.value = ''
  statusMessage.value = ''

  const drafts = {}

  try {
    // 1. Get the last persisted settings from storage
    const lastSavedSettings = (await storageManager.get(null)) || {}

    // 2. Temporarily swap invalid prompt keys to last persisted or default value
    for (const key of invalidPromptKeys) {
      drafts[key] = settingsStore.settings[key]
      
      const fallbackValue = lastSavedSettings[key] !== undefined
        ? lastSavedSettings[key]
        : (CONFIG[key] !== undefined ? CONFIG[key] : '')
        
      settingsStore.settings[key] = fallbackValue
    }

    // 3. Save the rest of settings (which are valid)
    await settingsStore.saveAllSettings()
    logger.debug('Valid settings saved successfully; invalid prompts were ignored.')

    // 4. Trigger cross-context updates
    await postSaveNotify()

    // 5. Set warning status
    statusType.value = 'warning'
    statusMessage.value = t('OPTIONS_STATUS_SAVED_WITH_PROMPT_ERRORS') || 'Settings saved, but invalid prompt templates were not saved.'

    setTimeout(() => {
      if (statusType.value === 'warning') {
        statusMessage.value = ''
        statusType.value = ''
      }
    }, 3000)
  } catch (error) {
    logger.error('Failed to save settings partially:', error)
    statusType.value = 'error'
    statusMessage.value = t('OPTIONS_STATUS_SAVED_FAILED') || 'Failed to save settings!'

    setTimeout(() => {
      if (statusType.value === 'error') {
        statusMessage.value = ''
        statusType.value = ''
      }
    }, 3000)
  } finally {
    // 6. Restore drafts in UI settingsStore
    for (const key of invalidPromptKeys) {
      if (drafts[key] !== undefined) {
        settingsStore.settings[key] = drafts[key]
      }
    }
    isSaving.value = false
  }

  // 7. Keep redirect/highlight behavior
  const firstError = errors.find(e => e.startsWith('prompt:'))
  if (firstError) {
    const parts = firstError.split(':')
    const promptKey = parts.length >= 2 ? parts[1] : null
    
    if (promptKey && PROMPT_REGISTRY[promptKey]) {
      if (router.currentRoute.value.name !== 'prompt') {
        await router.push({ name: 'prompt' })
      }
      window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', { 
        detail: { field: 'prompt', promptKey } 
      }))
    }
  }
}

// Save all settings
const saveAllSettings = async () => {
  logger.debug('Save All Settings clicked!')
  
  // 1. Validate all critical settings before proceeding
  const validation = settingsStore.validateSettings()
  if (!validation.isValid) {
    logger.debug('Cannot save settings: Validation failed', validation.errors)
    
    // Check if every validation error is a prompt error
    const promptOnlyErrors = validation.errors.every(e => e.startsWith('prompt:'))
    
    if (!promptOnlyErrors) {
      // Keep current full-block behavior
      statusType.value = 'error'
      const firstError = validation.errors.find(e => !e.startsWith('prompt:')) || validation.errors[0]
      
      // Specific translation logic for prompt-based validation keys
      if (firstError && firstError.startsWith('prompt:')) {
        const parts = firstError.split(':')
        const subError = parts.length >= 3 ? parts[2] : 'validation_prompt_template_empty'
        statusMessage.value = t(subError) || t('OPTIONS_STATUS_VALIDATION_FAILED') || 'Please fix errors before saving'
      } else {
        statusMessage.value = t(firstError) || t('OPTIONS_STATUS_VALIDATION_FAILED') || 'Please fix errors before saving'
      }
      
      setTimeout(() => {
        statusMessage.value = ''
        statusType.value = ''
      }, 5000)

      // Check if it's a provider configuration error
      const globalProvider = settingsStore.settings.TRANSLATION_API;
      const missingKey = getFirstMissingSetting(globalProvider, settingsStore.settings);
      
      if (missingKey) {
        // Redirect to providers tab with highlight parameter if not already there
        const currentRoute = router.currentRoute.value.name
        if (currentRoute !== 'providers') {
          await router.push({ name: 'providers', query: { highlight: missingKey } })
        } else {
          // Already on providers tab, just dispatch the event
          window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', { 
            detail: { field: missingKey } 
          }))
        }
        return
      }

      // Check mode-specific providers for Activation tab
      if (settingsStore.settings.MODE_PROVIDERS) {
        for (const [mode, providerId] of Object.entries(settingsStore.settings.MODE_PROVIDERS)) {
          if (providerId && providerId !== 'default') {
            const modeMissingKey = getFirstMissingSetting(providerId, settingsStore.settings);
            if (modeMissingKey) {
              // Redirect to activation tab if it's a mode managed there
              const currentRoute = router.currentRoute.value.name
              if (currentRoute !== 'activation') {
                await router.push({ name: 'activation' })
              }
              window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', { 
                detail: { field: 'provider', mode } 
              }))
              return
            }
          }
        }
      }

      // Handle language validation errors
      if (validation.errors.some(e => e.includes('language'))) {
        if (router.currentRoute.value.name !== 'languages') {
          await router.push({ name: 'languages' })
        }
        window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', { 
          detail: { field: 'languages' } 
        }))
        return
      }

      // Handle prompt validation errors
      const promptError = validation.errors.find(e => e.startsWith('prompt:'))
      if (promptError) {
        const parts = promptError.split(':')
        const promptKey = parts.length >= 2 ? parts[1] : null
        
        if (promptKey && PROMPT_REGISTRY[promptKey]) {
          if (router.currentRoute.value.name !== 'prompt') {
            await router.push({ name: 'prompt' })
          }
          window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', { 
            detail: { field: 'prompt', promptKey } 
          }))
          return
        } else {
          logger.warn('Received malformed or unknown prompt validation error:', promptError)
        }
      }

      // Handle activation tab validation errors (scroll delay)
      if (validation.errors.includes('validation_scroll_delay_invalid')) {
        if (router.currentRoute.value.name !== 'activation') {
          await router.push({ name: 'activation' })
        }
        window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', { 
          detail: { field: 'WHOLE_PAGE_SCROLL_STOP_DELAY' } 
        }))
        return
      }

      // Handle font validation errors
      if (validation.errors.includes('font_size_range_error') || validation.errors.includes('font_family_required')) {
        if (router.currentRoute.value.name !== 'appearance') {
          await router.push({ name: 'appearance' })
        }
        window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', { 
          detail: { field: 'font_settings' } 
        }))
        return
      }

      // Handle proxy validation errors
      if (validation.errors.some(e => e.includes('proxy'))) {
        if (router.currentRoute.value.name !== 'advance') {
          await router.push({ name: 'advance' })
        }
        window.dispatchEvent(new CustomEvent('options-trigger-validation-feedback', { 
          detail: { field: 'proxy' } 
        }))
        return
      }

      return
    }

    // Call partial save if errors are exclusively prompt template errors
    await performPartialSave(validation.errors)
    return
  }

  isSaving.value = true
  statusType.value = ''
  statusMessage.value = ''
  
  try {
    await settingsStore.saveAllSettings()
    logger.debug('All settings saved successfully')

    // Trigger post-save notifications
    await postSaveNotify()

    // Dispatch event to clear validation states in child components/tabs
    window.dispatchEvent(new CustomEvent('options-settings-saved'))

    statusType.value = 'success'
    statusMessage.value = t('OPTIONS_STATUS_SAVED_SUCCESS') || 'Settings saved successfully!'
    
    // Clear status after 2 seconds
    setTimeout(() => {
      statusMessage.value = ''
      statusType.value = ''
    }, 2000)
  } catch (error) {
    logger.error('Failed to save settings:', error)
    statusType.value = 'error'
    statusMessage.value = t('OPTIONS_STATUS_SAVED_FAILED') || 'Failed to save settings!'
    
    // Clear status after 3 seconds
    setTimeout(() => {
      statusMessage.value = ''
      statusType.value = ''
    }, 3000)
  } finally {
    isSaving.value = false
  }
}
</script>
