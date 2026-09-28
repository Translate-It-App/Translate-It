<template>
  <div
    class="live-dubbing-view"
    :class="{ 'live-dubbing-view--rtl': isRtlLocale }"
  >
    <!-- Configuration: target language + provider for upcoming sessions -->
    <section
      class="live-dubbing-card live-dubbing-config-card"
      :aria-label="t('live_dubbing_config_label', 'Configuration')"
    >
      <div class="live-dubbing-config-grid">
        <label
          class="ti-live-dubbing-language-header live-dubbing-config-label"
          for="live-dubbing-target-language-select"
        >
          {{ t('target_language_label', 'Target Language') }}
        </label>
        <div class="ti-live-dubbing-provider-header">
          <label
            class="live-dubbing-config-label"
            for="live-dubbing-provider-select"
          >
            {{ t('provider_label', 'Provider') }}
          </label>
          <button
            type="button"
            class="ti-live-dubbing-manage-keys"
            :aria-label="t('live_dubbing_manage_api_keys', 'Manage API keys')"
            :title="t('live_dubbing_manage_api_keys', 'Manage API keys')"
            @click="handleManageApiKeys"
          >
            <MaskIcon
              :src="keyIcon"
              :size="15"
            />
          </button>
        </div>
        <div class="live-dubbing-config-field live-dubbing-config-field--language ti-live-dubbing-language-control">
          <LanguageSelector
            v-model:target-language="targetLanguageModel"
            :provider="providerModel"
            target-select-id="live-dubbing-target-language-select"
            :target-title="t('target_language_label', 'Target Language')"
            :enable-select-element-integration="false"
            :target-only="true"
            :disabled="isControlBusy || targetLanguagePending || isSetupSaving"
          />
        </div>
        <div class="live-dubbing-config-field live-dubbing-config-field--provider ti-live-dubbing-provider-control">
          <BaseSelect
            id="live-dubbing-provider-select"
            v-model="providerModel"
            :options="providerOptions"
            :disabled="isControlBusy || isSetupSaving"
            :title="t('live_dubbing_provider_description', 'Used for new live dubbing sessions.')"
          />
        </div>
      </div>
    </section>

    <!-- Subtitles follow the same visibility gate as the session/status card:
         hidden while setup is required, visible when configured, and kept
         visible during an active session even if credentials disappear. -->
    <section
      v-show="showSessionControl"
      class="live-dubbing-card live-dubbing-transcript-preferences ti-live-dubbing-transcript-card"
      :aria-label="t('live_dubbing_transcript_preferences_label', 'Subtitles')"
    >
      <div
        class="live-dubbing-transcript-preferences-header"
        :class="{ 'live-dubbing-transcript-preferences-header--expanded': isTranscriptPreferencesExpanded }"
      >
        <button
          type="button"
          class="live-dubbing-transcript-preferences-toggle"
          :aria-expanded="isTranscriptPreferencesExpanded"
          aria-controls="live-dubbing-transcript-preferences-content"
          @click="isTranscriptPreferencesExpanded = !isTranscriptPreferencesExpanded"
        >
          <span class="live-dubbing-card-title">
            {{ t('live_dubbing_transcript_preferences_label', 'Subtitles') }}
          </span>
        </button>
        <button
          type="button"
          class="live-dubbing-change-font-link"
          @click="handleChangeFont"
        >
          {{ t('live_dubbing_change_font_label', 'Change font') }}
        </button>
        <span
          class="live-dubbing-transcript-preferences-chevron"
          aria-hidden="true"
        />
      </div>
      <Transition
        :css="false"
        @before-enter="handleTranscriptPreferencesBeforeEnter"
        @enter="handleTranscriptPreferencesEnter"
        @before-leave="handleTranscriptPreferencesBeforeLeave"
        @leave="handleTranscriptPreferencesLeave"
      >
        <div
          v-show="isTranscriptPreferencesExpanded"
          id="live-dubbing-transcript-preferences-content"
          ref="transcriptPreferencesContentRef"
          class="live-dubbing-transcript-preferences-content"
          :inert="!isTranscriptPreferencesExpanded ? '' : undefined"
        >
          <div class="live-dubbing-transcript-preferences-content-inner">
            <div class="live-dubbing-transcript-preferences-list">
              <div class="live-dubbing-transcript-preference">
                <span class="live-dubbing-transcript-preference-label">
                  {{ t('live_dubbing_show_translated_transcript', 'Dubbed') }}
                </span>
                <BaseToggle
                  class="live-dubbing-transcript-preference-toggle"
                  :class="{ 'live-dubbing-toggle--pending-neutral': hasTranslatedPreferenceWritePending }"
                  :model-value="showTranslatedTranscript"
                  :disabled="hasTranslatedPreferenceWritePending"
                  :title="t('live_dubbing_show_translated_transcript', 'Dubbed')"
                  @update:model-value="updateTranscriptPreference('LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT', $event)"
                />
              </div>
              <div class="live-dubbing-transcript-preference">
                <span class="live-dubbing-transcript-preference-label">
                  {{ t('live_dubbing_show_original_transcript', 'Original') }}
                </span>
                <BaseToggle
                  class="live-dubbing-transcript-preference-toggle"
                  :class="{ 'live-dubbing-toggle--pending-neutral': hasOriginalPreferenceWritePending && !isOriginalOpenAIRestricted }"
                  :model-value="showOriginalTranscript"
                  :disabled="hasOriginalPreferenceWritePending || isOriginalOpenAIRestricted"
                  :title="t('live_dubbing_show_original_transcript', 'Original')"
                  @update:model-value="updateTranscriptPreference('LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT', $event)"
                />
              </div>
              <div class="live-dubbing-transcript-preference live-dubbing-transcript-preference--size">
                <BaseSelect
                  id="live-dubbing-subtitle-size-select"
                  v-model="subtitleSizeModel"
                  :aria-label="t('live_dubbing_subtitle_size_label', 'Subtitle size')"
                  class="live-dubbing-subtitle-size-select"
                  :options="subtitleSizeOptions"
                  :disabled="hasSubtitleSizePreferenceWritePending"
                />
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </section>

    <!-- Credential setup: rendered only while the selected provider has no key -->
    <!-- :key remount clears stale draft/errors on provider switch; the select is
         disabled while the control is busy, so remounts only happen while idle. -->
    <LiveDubbingProviderSetup
      v-if="needsSetup"
      :key="providerModel"
      :provider-id="providerModel"
      :target-language="targetLanguage"
      @save-pending="isSetupSaving = $event"
      @saved="handleSetupSaved"
    />

    <!-- Session: start/stop, status feedback and volumes (owned by the control) -->
    <!-- The control stays mounted across subtitle preference writes so its
         status/session presentation remains stable. Start is gated through the
         :start-disabled prop until every relevant write settles. -->
    <section
      v-show="showSessionControl"
      class="live-dubbing-card live-dubbing-session-card"
    >
      <LiveDubbingControl
        :key="controlKey"
        :target-language="targetLanguage"
        :provider-id="providerModel"
        :start-disabled="targetLanguagePending || hasTranslatedPreferenceWritePending || hasOriginalPreferenceWritePending"
        @busy-change="handleBusyChange"
        @status-resolved="handleControlStatusResolved"
      />
    </section>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { openOptionsPage } from '@/core/helpers.js'
import LanguageSelector from '@/components/shared/LanguageSelector.vue'
import LiveDubbingControl from '@/components/popup/LiveDubbingControl.vue'
import LiveDubbingProviderSetup from '@/components/popup/LiveDubbingProviderSetup.vue'
import BaseSelect from '@/components/base/BaseSelect.vue'
import BaseToggle from '@/components/base/BaseToggle.vue'
import MaskIcon from '@/components/shared/MaskIcon.vue'
import keyIcon from '@/icons/ui/key.svg?url'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import {
  LIVE_DUBBING_PROVIDER_ID,
  LIVE_DUBBING_OPENAI_PROVIDER_ID,
  LIVE_DUBBING_PROVIDER_IDS
} from '@/features/live-dubbing/constants.js'
import {
  LIVE_DUBBING_SUBTITLE_SIZE_PRESETS,
  normalizeLiveDubbingSubtitleSize,
} from '@/features/live-dubbing/content/liveDubbingSubtitleSize.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'

// Import adjacent SCSS
import './LiveDubbingView.scss'

const props = defineProps({
  targetLanguage: {
    type: String,
    default: 'en'
  },
  targetLanguagePending: {
    type: Boolean,
    default: false
  },
  providerId: {
    type: String,
    default: LIVE_DUBBING_PROVIDER_ID
  }
})

const emit = defineEmits(['busy-change', 'update:targetLanguage'])

const { t, locale } = useUnifiedI18n()
const settingsStore = useSettingsStore()
const logger = getScopedLogger(LOG_COMPONENTS.UI, 'LiveDubbingView')

const isTranscriptPreferencesExpanded = ref(
  settingsStore.settings?.LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT === true
  || settingsStore.settings?.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT === true
)

const TRANSCRIPT_PREFERENCES_TRANSITION_DURATION = 190
const TRANSCRIPT_PREFERENCES_TRANSITION_EASING = 'cubic-bezier(0.2, 0, 0, 1)'
const transcriptPreferencesContentRef = ref(null)
let transcriptPreferencesTransitionGeneration = 0
let activeTranscriptPreferencesTransition = null

const clearTranscriptPreferencesTransitionStyles = (element) => {
  element.style.removeProperty('height')
  element.style.removeProperty('overflow')
  element.style.removeProperty('transition')
}

const prefersReducedMotion = () => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const scheduleAnimationFrame = (callback) => {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    const frameId = window.requestAnimationFrame(callback)
    return () => window.cancelAnimationFrame(frameId)
  }

  const timeoutId = setTimeout(callback, 0)
  return () => clearTimeout(timeoutId)
}

const cancelActiveTranscriptPreferencesTransition = () => {
  transcriptPreferencesTransitionGeneration += 1
  const activeTransition = activeTranscriptPreferencesTransition
  activeTranscriptPreferencesTransition = null
  if (!activeTransition) return

  activeTransition.cancel()
  activeTransition.complete()
}

const runTranscriptPreferencesHeightTransition = (element, fromHeight, toHeight, done) => {
  cancelActiveTranscriptPreferencesTransition()
  const generation = transcriptPreferencesTransitionGeneration
  let frameCancel = () => {}
  let timerId = null
  let cancelled = false
  let completed = false

  const cancel = () => {
    if (cancelled || completed) return
    cancelled = true
    frameCancel()
    if (timerId !== null) clearTimeout(timerId)
  }

  const complete = () => {
    if (completed) return
    completed = true
    frameCancel()
    if (timerId !== null) clearTimeout(timerId)

    if (generation === transcriptPreferencesTransitionGeneration) {
      element.style.height = toHeight === 'auto' ? 'auto' : toHeight
      clearTranscriptPreferencesTransitionStyles(element)
      activeTranscriptPreferencesTransition = null
    }

    done()
  }

  activeTranscriptPreferencesTransition = { cancel, complete }
  element.style.height = fromHeight
  element.style.overflow = 'hidden'
  element.style.transition = 'none'
  void element.offsetHeight

  if (prefersReducedMotion()) {
    complete()
    return
  }

  frameCancel = scheduleAnimationFrame(() => {
    if (cancelled || generation !== transcriptPreferencesTransitionGeneration) return
    element.style.transition = `height ${TRANSCRIPT_PREFERENCES_TRANSITION_DURATION}ms ${TRANSCRIPT_PREFERENCES_TRANSITION_EASING}`
    element.style.height = toHeight
    timerId = setTimeout(complete, TRANSCRIPT_PREFERENCES_TRANSITION_DURATION)
  })
}

const handleTranscriptPreferencesBeforeEnter = (element) => {
  cancelActiveTranscriptPreferencesTransition()
  element.style.height = '0px'
  element.style.overflow = 'hidden'
  element.style.transition = 'none'
}

const handleTranscriptPreferencesEnter = (element, done) => {
  runTranscriptPreferencesHeightTransition(element, '0px', `${element.scrollHeight}px`, done)
}

const getCurrentTranscriptPreferencesHeight = (element) => {
  const inlineHeight = Number.parseFloat(element.style.height)
  if (Number.isFinite(inlineHeight)) return inlineHeight

  const renderedHeight = element.getBoundingClientRect().height
  return renderedHeight || element.scrollHeight
}

const handleTranscriptPreferencesBeforeLeave = (element) => {
  cancelActiveTranscriptPreferencesTransition()
  const currentHeight = getCurrentTranscriptPreferencesHeight(element)
  element.style.height = `${currentHeight}px`
  element.style.overflow = 'hidden'
  element.style.transition = 'none'
  void element.offsetHeight
}

const handleTranscriptPreferencesLeave = (element, done) => {
  runTranscriptPreferencesHeightTransition(
    element,
    element.style.height || `${getCurrentTranscriptPreferencesHeight(element)}px`,
    '0px',
    done
  )
}

onBeforeUnmount(() => {
  cancelActiveTranscriptPreferencesTransition()
  if (transcriptPreferencesContentRef.value) {
    clearTranscriptPreferencesTransitionStyles(transcriptPreferencesContentRef.value)
  }
})

const handleChangeFont = async () => {
  try {
    const response = await openOptionsPage('/appearance?highlight=LIVE_DUBBING_USE_TRANSLATION_FONT')
    if (response?.success) {
      window.close()
      return
    }

    logger.warn('Unable to open Appearance settings for Live Dubbing font selection.')
  } catch (error) {
    logger.error('Failed to open Appearance settings for Live Dubbing font selection:', error)
  }
}

const handleManageApiKeys = async () => {
  try {
    const apiKey = providerModel.value === LIVE_DUBBING_OPENAI_PROVIDER_ID ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'
    const response = await openOptionsPage(`/providers?highlight=${apiKey}`)
    if (response?.success) window.close()
  } catch (error) {
    logger.error('Failed to open provider settings for Live Dubbing API keys:', error)
  }
}

const isRtlLocale = computed(() => /^fa(?:-|$)/i.test(locale.value || ''))

/** Mirrors LiveDubbingControl's busy state so the config card can lock while a session is active. */
const isControlBusy = ref(false)
const isControlStatusResolved = ref(false)

const showTranslatedTranscript = computed(() =>
  settingsStore.settings?.LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT === true
)
const showOriginalTranscript = computed(() =>
  settingsStore.settings?.LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT === true
)
const hasTranslatedPreferenceWritePending = ref(false)
const hasOriginalPreferenceWritePending = ref(false)
const hasSubtitleSizePreferenceWritePending = ref(false)

/**
 * Real UI restriction on the original-subtitle toggle: OpenAI applies the
 * preference only at session start, so it stays locked while the control
 * status is unresolved or a session is busy. Takes precedence over the
 * temporary pending-write presentation — when both conditions apply the
 * genuine disabled appearance (opacity + not-allowed cursor) wins.
 */
const isOriginalOpenAIRestricted = computed(() =>
  providerModel.value === LIVE_DUBBING_OPENAI_PROVIDER_ID
  && (!isControlStatusResolved.value || isControlBusy.value)
)

const subtitleSizeOptions = computed(() => Object.keys(LIVE_DUBBING_SUBTITLE_SIZE_PRESETS).map(value => ({
  value,
  label: t(`live_dubbing_subtitle_size_${value}`, value),
})))

const subtitleSizeModel = computed({
  get: () => normalizeLiveDubbingSubtitleSize(
    settingsStore.getSetting('LIVE_DUBBING_SUBTITLE_SIZE', 'medium')
  ),
  set: value => updateTranscriptPreference(
    'LIVE_DUBBING_SUBTITLE_SIZE',
    normalizeLiveDubbingSubtitleSize(value)
  )
})

/** Persist one transcript preference and restore its prior value on failure. */
const updateTranscriptPreference = async (key, value) => {
  const pending = key === 'LIVE_DUBBING_SHOW_TRANSLATED_TRANSCRIPT'
    ? hasTranslatedPreferenceWritePending
    : key === 'LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT'
      ? hasOriginalPreferenceWritePending
      : hasSubtitleSizePreferenceWritePending

  if (pending.value) return

  const previousValue = key === 'LIVE_DUBBING_SUBTITLE_SIZE'
    ? normalizeLiveDubbingSubtitleSize(settingsStore.getSetting(key, 'medium'))
    : settingsStore.getSetting(key, false) === true
  pending.value = true
  try {
    await settingsStore.updateSettingAndPersist(key, value)
  } catch {
    // Restore local state without starting another persistence write.
    settingsStore.updateSettingLocally(key, previousValue)
  } finally {
    pending.value = false
  }
}

const targetLanguageModel = computed({
  get: () => props.targetLanguage,
  set: (value) => emit('update:targetLanguage', value)
})

/**
 * Normalized provider selection. Reads the parent-owned prop and persists
 * changes immediately under LIVE_DUBBING_PROVIDER only — TRANSLATION_API is
 * a separate concern and is never touched here.
 */
const providerModel = computed({
  get: () => (LIVE_DUBBING_PROVIDER_IDS.includes(props.providerId)
    ? props.providerId
    : LIVE_DUBBING_PROVIDER_ID),
  set: (value) => {
    if (!LIVE_DUBBING_PROVIDER_IDS.includes(value)) return
    // Local store state is applied synchronously; if the storage write fails
    // the selection still sticks for this session and retries on next save.
    settingsStore.updateSettingAndPersist('LIVE_DUBBING_PROVIDER', value)
      .catch(() => { /* selection already applied locally */ })
  }
})

const providerOptions = computed(() => [
  { value: LIVE_DUBBING_PROVIDER_ID, label: t('provider_gemini_title', 'Google Gemini') },
  { value: LIVE_DUBBING_OPENAI_PROVIDER_ID, label: t('provider_openai_title', 'OpenAI GPT') }
])

/**
 * "Configured" = at least one non-empty trimmed line, matching
 * ApiKeyManager.parseKeys semantics. Gemini also honors the legacy single-key
 * API_KEY store as configured (the bootstrap service falls back to it).
 * @param {unknown} value - raw stored credential value
 * @returns {boolean} true when the value holds usable key material
 */
const hasKeyMaterial = (value) => typeof value === 'string'
  && value.split('\n').some((line) => line.trim().length > 0)

/** True while the credential setup card has an in-flight save. */
const isSetupSaving = ref(false)

/**
 * Identity key for LiveDubbingControl. It follows the provider ONLY while
 * idle, so an idle Gemini↔OpenAI switch remounts to fresh presentation state
 * while a busy control is never remounted mid-session. setupEpoch forces a
 * fresh control after successful credential setup (also idle-guarded).
 */
const setupEpoch = ref(0)
const controlKey = ref(`${providerModel.value}:${setupEpoch.value}`)
watch([providerModel, setupEpoch, isControlBusy], ([provider, epoch, busy]) => {
  if (!busy) controlKey.value = `${provider}:${epoch}`
})
watch(controlKey, () => {
  isControlStatusResolved.value = false
})

const needsSetup = computed(() => {
  // A pending save keeps the card mounted even though the store mutates first.
  if (isSetupSaving.value) return true
  const settings = settingsStore.settings || {}
  if (providerModel.value === LIVE_DUBBING_OPENAI_PROVIDER_ID) {
    return !hasKeyMaterial(settings.OPENAI_API_KEY)
  }
  return !hasKeyMaterial(settings.GEMINI_API_KEY) && !hasKeyMaterial(settings.API_KEY)
})

/** Keep an active session visible even if its credentials disappear externally. */
const showSessionControl = computed(() => isControlBusy.value || !needsSetup.value)

/** Track control busy state locally, then keep the parent in sync unchanged. */
const handleBusyChange = (busy) => {
  isControlBusy.value = busy
  emit('busy-change', busy)
}

const handleControlStatusResolved = () => {
  isControlStatusResolved.value = true
}

/**
 * A successful first-time credential setup leaves a fresh control behind so
 * stale bootstrap/setup error presentation cannot block the session. Never
 * remounts while busy — the epoch only takes effect through controlKey.
 */
const handleSetupSaved = () => {
  if (!isControlBusy.value) setupEpoch.value += 1
}
</script>
