<template>
  <section class="options-tab-content languages-tab">
    <h2>{{ t('languages_section_title') || 'Languages' }}</h2>

    <div class="settings-container">
      <div
        v-if="!isLoaded"
        class="loading-message"
      >
        Loading languages...
      </div>
      <template v-else>
        <div 
          v-if="isAutoLanguageProvider" 
          class="smart-language-info-banner"
        >
          <div class="banner-content">
            <h3>{{ t('smart_language_title') || 'Smart Language Handling' }}</h3>
            <p>{{ t('smart_language_description') || 'This provider is specialized for the Persian language, providing dictionary results for English, Arabic, and Turkish in relation to Persian.' }}</p>
          </div>
        </div>

        <div class="languages-selectors-container">
          <div class="setting-group">
            <label for="SOURCE_LANGUAGE">{{ t('source_language_label') || 'Source Language' }}</label>
            <LanguageDropdown
              id="SOURCE_LANGUAGE"
              v-model="sourceLanguage"
              :languages="filteredSourceLanguages"
              type="source"
              :error="sourceLanguageError"
              :beta-label="t('deepl_beta_label')"
            />
          </div>

          <div class="setting-group">
            <label for="TARGET_LANGUAGE">{{ t('target_language_label') || 'Target Language' }}</label>
            <LanguageDropdown
              id="TARGET_LANGUAGE"
              v-model="targetLanguage"
              :languages="filteredTargetLanguages"
              type="target"
              :error="targetLanguageError"
              :beta-label="t('deepl_beta_label')"
            />
          </div>

          <div class="setting-group provider-selection-group">
            <label>{{ t('translation_api_label') || 'Primary Service' }}</label>
            <ProviderSelector 
              v-model="selectedProvider" 
              mode="button"
              :is-global="false"
              ignore-hidden
            />
          </div>

          <!-- Validation Error (e.g., Same Source/Target Language) -->
          <Transition name="fade-slide">
            <div 
              v-if="validationError && validationErrorKey !== 'PROVIDER_CONFIG_ERROR' && !validationErrorKey.startsWith('validation_deepl_')"
              class="validation-error"
            >
              <span class="error-icon">⛔</span>
              <span class="error-message">{{ validationError }}</span>
            </div>
          </Transition>

          <!-- Configuration Warning -->
          <Transition name="fade-slide">
            <div 
              v-if="missingSetting" 
              class="provider-config-warning"
            >
              <span class="warning-icon">⚠️</span>
              <div class="warning-content">
                <p>{{ missingSettingWarning }}</p>
                <button 
                  class="configure-btn"
                  @click="navigateToProviderSettings"
                >
                  {{ t('configure_service_button') || 'Configure Service ⚙️' }}
                </button>
              </div>
            </div>
          </Transition>

          <p 
            v-if="isAutoLanguageProvider" 
            class="smart-language-fallback-note"
          >
            {{ t('smart_language_fallback_note') }}
          </p>
        </div>

        <p
          v-if="isDeepLProvider(selectedProvider) && deepLLanguageStatus"
          class="setting-description"
          role="status"
          aria-live="polite"
        >
          {{ t(deepLLanguageStatus) }}
        </p>

        <!-- Dictionary Mode -->
        <BaseAccordion
          id="DICTIONARY_SECTION"
          :is-open="activeAccordion === 'dictionary'"
          item-class="dictionary-mode-setting"
          @toggle="toggleAccordion('dictionary')"
        >
          <template #header>
            <div class="checkbox-area">
              <BaseCheckbox
                v-model="enableDictionary"
                class="dictionary-main-checkbox"
                @click.stop
              />
              <span 
                class="accordion-title-text"
                :class="{ active: activeAccordion === 'dictionary' }"
              >
                {{ t('activation_group_dictionary_title') || 'Dictionary Mode' }}
              </span>
            </div>
          </template>

          <template #content>
            <div class="accordion-inner">
              <div class="dictionary-content-wrapper">
                <div class="setting-group dictionary-provider-group mb-md">
                  <label 
                    class="setting-label"
                    :class="{ 'is-disabled': !enableDictionary }"
                  >{{ t('translation_api_label') || 'Service' }}:</label>
                  <ProviderSelector 
                    v-model="dictionaryProvider" 
                    mode="button"
                    :is-global="false"
                    allow-default
                    required-feature="dictionary"
                    :disabled="!enableDictionary"
                    ignore-hidden
                  />
                </div>
                <p class="setting-description">
                  {{ t('enable_dictionary_translation_description') }}
                </p>

                <!-- Dictionary Display Options -->
                <div 
                  id="DICTIONARY_DISPLAY_OPTIONS"
                  class="dictionary-display-options mt-md"
                  :class="{ 'is-disabled': !enableDictionary || !isGoogleDictionary }"
                >
                  <label class="setting-label mb-sm">{{ t('dict_setting_display_options') || 'Display Options' }}:</label>
                  <div class="checkbox-list-vertical">
                    <BaseCheckbox 
                      v-model="showPos" 
                      :label="t('dict_setting_show_pos')" 
                      :disabled="!enableDictionary || !isGoogleDictionary"
                      class="mb-xs"
                    />
                    <BaseCheckbox 
                      v-model="showPronunciation" 
                      :label="t('dict_setting_show_pronunciation')" 
                      :disabled="!enableDictionary || !isGoogleDictionary"
                      class="mb-xs"
                    />
                    <BaseCheckbox 
                      v-model="showDefinitions" 
                      :label="t('dict_setting_show_definitions')" 
                      :disabled="!enableDictionary || !isGoogleDictionary"
                      class="mb-xs"
                    />
                    <BaseCheckbox 
                      v-model="showExamples" 
                      :label="t('dict_setting_show_examples')" 
                      :disabled="!enableDictionary || !isGoogleDictionary"
                    />
                  </div>
                </div>
              </div>
            </div>
          </template>
        </BaseAccordion>

        <!-- Bilingual Translation Setting -->
        <BaseAccordion
          id="BILINGUAL_SECTION"
          :is-open="activeAccordion === 'bilingual'"
          item-class="bilingual-setting"
          @toggle="toggleAccordion('bilingual')"
        >
          <template #header>
            <div class="checkbox-area">
              <BaseCheckbox
                v-model="bilingualTranslation"
                class="bilingual-main-checkbox"
                @click.stop
              />
              <span 
                class="accordion-title-text"
                :class="{ active: activeAccordion === 'bilingual' }"
              >
                {{ t('bilingual_translation_label') || 'Bilingual Translation (Swap Language)' }}
              </span>
            </div>
          </template>

          <template #content>
            <div class="accordion-inner">
              <p class="setting-description mb-md">
                {{ t('bilingual_translation_description') }}
              </p>

              <div class="bilingual-modes-list">
                <BaseCheckbox
                  v-for="mode in visibleBilingualModes"
                  :key="mode"
                  :model-value="bilingualTranslationModes[mode]"
                  :label="modeLabels[mode]"
                  class="mode-checkbox"
                  @update:model-value="updateBilingualMode(mode, $event)"
                />
              </div>
            </div>
          </template>
        </BaseAccordion>

        <!-- Language Detection Preferences -->
        <BaseAccordion
          id="DETECTION_SECTION"
          :is-open="activeAccordion === 'detection'"
          item-class="language-pref-setting"
          @toggle="toggleAccordion('detection')"
        >
          <template #header>
            <span 
              class="accordion-title-text"
              :class="{ active: activeAccordion === 'detection' }"
            >
              {{ t('language_detection_label') || 'Language Detection Preferences' }}
            </span>
          </template>

          <template #content>
            <div class="accordion-inner">
              <p class="setting-description mb-md">
                {{ t('language_detection_preferences_description') }}
              </p>

              <div class="language-pref-row">
                <label class="pref-label">{{ t('latin_script_priority_label') }}:</label>
                <BaseSelect
                  v-model="latinScriptPreference"
                  :options="latinScriptOptions"
                  class="pref-select"
                />
              </div>

              <div class="language-pref-row">
                <label class="pref-label">{{ t('arabic_script_priority_label') }}:</label>
                <BaseSelect
                  v-model="arabicScriptPreference"
                  :options="arabicScriptOptions"
                  class="pref-select"
                />
              </div>

              <div class="language-pref-row">
                <label class="pref-label">{{ t('chinese_script_priority_label') }}:</label>
                <BaseSelect
                  v-model="chineseScriptPreference"
                  :options="chineseScriptOptions"
                  class="pref-select"
                />
              </div>

              <div class="language-pref-row">
                <label class="pref-label">{{ t('devanagari_script_priority_label') }}:</label>
                <BaseSelect
                  v-model="devanagariScriptPreference"
                  :options="devanagariScriptOptions"
                  class="pref-select"
                />
              </div>
            </div>
          </template>
        </BaseAccordion>

        <!-- AI Optimization -->
        <BaseAccordion
          id="AI_OPT_SECTION"
          :is-open="activeAccordion === 'ai'"
          item-class="ai-optimization-setting"
          @toggle="toggleAccordion('ai')"
        >
          <template #header>
            <span class="accordion-title-text">{{ t('ai_optimization_section_title') || 'AI Optimization' }}</span>
          </template>

          <template #content>
            <div class="accordion-inner">
              <div class="setting-group vertical">
                <BaseCheckbox
                  v-model="aiContextEnabled"
                  :label="t('ai_context_translation_label')"
                />
                <p class="setting-description mb-md">
                  {{ t('ai_context_translation_description') }}
                </p>
              </div>

              <div class="setting-group vertical">
                <BaseCheckbox
                  v-model="aiHistoryEnabled"
                  :label="t('ai_conversation_history_label')"
                />
                <p class="setting-description mb-md">
                  {{ t('ai_conversation_history_description') }}
                </p>
              </div>
            </div>
          </template>
        </BaseAccordion>
      </template>
    </div>
  </section>
</template>

<script setup>
import './LanguagesTab.scss'
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { useTabSettings } from '../composables/useTabSettings.js'
import { useValidation } from '@/core/validation.js'
import { useLanguages } from '@/composables/shared/useLanguages.js'
import { TranslationMode } from '@/shared/config/config.js'
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js'
import { ProviderRegistryIds } from '@/features/translation/providers/ProviderConstants.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'
import { PROVIDER_SUPPORTED_LANGUAGES, PROVIDER_LANGUAGE_PAIRS, getCanonicalCode, getProviderLanguageCode } from '@/shared/config/languageConstants.js'
import { getFirstMissingSetting } from '@/features/translation/utils/providerValidator.js'
import { useHighlightManager } from '../composables/useHighlightManager.js'
import { DEEPL_LANGUAGE_CATALOG_TTL_MS, getDeepLEligibleKeys, getDeepLLanguageIdentity, matchDeepLLanguage, normalizeDeepLLanguageTag, resolveDeepLLanguageTag } from '@/features/translation/providers/DeepLLanguageDiscovery.js'

// Components
import LanguageDropdown from '@/components/feature/LanguageDropdown.vue'
import ProviderSelector from '@/components/shared/ProviderSelector.vue'
import BaseCheckbox from '@/components/base/BaseCheckbox.vue'
import BaseSelect from '@/components/base/BaseSelect.vue'
import BaseAccordion from '@/components/base/BaseAccordion.vue'

const logger = getScopedLogger(LOG_COMPONENTS.UI, 'LanguagesTab')
const settingsStore = useSettingsStore()
const router = useRouter()
const { t } = useUnifiedI18n()
const { highlightElement } = useHighlightManager()
const { createSetting, createProviderSetting } = useTabSettings(settingsStore, logger)
const { validateLanguages: validate, getFirstError, getFirstErrorTranslated, clearErrors } = useValidation()
const { allLanguages, loadLanguages, isLoaded } = useLanguages()

// State
const activeAccordion = ref(null)
const toggleAccordion = (name) => { activeAccordion.value = activeAccordion.value === name ? null : name }

// AI Optimization logic
const aiContextEnabled = createSetting('SMART_CONTEXT_TRANSLATION_ENABLED', true)
const aiHistoryEnabled = createSetting('AI_CONVERSATION_HISTORY_ENABLED', true)

// Global reveal listener for highlighting
onMounted(() => {
  window.addEventListener('options-reveal-accordion', (e) => {
    activeAccordion.value = e.detail;
  });
})

// --- Standard Settings ---

const sourceLanguage = createSetting('SOURCE_LANGUAGE', 'auto', { onChanged: () => validateLanguages() })
const targetLanguage = createSetting('TARGET_LANGUAGE', 'fa', { onChanged: () => validateLanguages() })

const bilingualTranslation = createSetting('BILINGUAL_TRANSLATION', false, {
  onChanged: (val) => {
    if (val) {
      const currentModes = { ...(settingsStore.settings?.BILINGUAL_TRANSLATION_MODES || {}) }
      if (!visibleBilingualModes.some(m => currentModes[m])) {
        visibleBilingualModes.forEach(m => { 
          if (m !== TranslationMode.Page) {
            currentModes[m] = true 
          }
        })
        currentModes[TranslationMode.Sidepanel_Translate] = true
        settingsStore.updateSettingLocally('BILINGUAL_TRANSLATION_MODES', currentModes)
      }
      activeAccordion.value = 'bilingual'
    } else if (activeAccordion.value === 'bilingual') {
      activeAccordion.value = null
    }
  }
})

const selectedProvider = createSetting('TRANSLATION_API', ProviderRegistryIds.GOOGLE_V2)

const missingSetting = computed(() => {
  // 1. Check primary provider
  const primaryMissing = getFirstMissingSetting(selectedProvider.value, settingsStore.settings)
  if (primaryMissing) return primaryMissing

  // 2. Check dictionary provider if enabled
  if (enableDictionary.value) {
    const dictProvider = dictionaryProvider.value === 'default' ? selectedProvider.value : dictionaryProvider.value
    return getFirstMissingSetting(dictProvider, settingsStore.settings)
  }

  return null
})

const missingSettingWarning = computed(() => {
  if (!missingSetting.value) return ''
  
  const key = missingSetting.value
  const providerName = selectedProviderInfo.value?.displayName || selectedProvider.value
  
  if (key.includes('URL')) {
    return t('provider_config_required_url', { provider: providerName })
  } else if (key.includes('API')) {
    return t('provider_config_required_api', { provider: providerName })
  }
  
  return t('provider_config_required_generic', { provider: providerName })
})

const navigateToProviderSettings = () => {
  if (missingSetting.value) {
    router.push({ 
      name: 'providers', 
      query: { highlight: missingSetting.value } 
    })
  }
}

// --- Bilingual Logic ---

const visibleBilingualModes = [TranslationMode.Selection, TranslationMode.MouseHover, TranslationMode.Select_Element, TranslationMode.Field, TranslationMode.Popup_Translate, TranslationMode.Page]
const modeLabels = computed(() => ({
  [TranslationMode.Selection]: t('bilingual_mode_selection_label'),
  [TranslationMode.MouseHover]: t('bilingual_mode_mouse_hover_label'),
  [TranslationMode.Select_Element]: t('bilingual_mode_select_element_label'),
  [TranslationMode.Field]: t('bilingual_mode_field_label'),
  [TranslationMode.Popup_Translate]: t('bilingual_mode_popup_label'),
  [TranslationMode.Page]: t('bilingual_mode_page_label')
}))

const bilingualTranslationModes = computed(() => settingsStore.settings?.BILINGUAL_TRANSLATION_MODES || {})
const updateBilingualMode = (mode, value) => {
  const newModes = { ...bilingualTranslationModes.value, [mode]: value }
  if (mode === TranslationMode.Popup_Translate) newModes[TranslationMode.Sidepanel_Translate] = value
  if (!visibleBilingualModes.some(m => newModes[m]) && bilingualTranslation.value) {
    settingsStore.updateSettingLocally('BILINGUAL_TRANSLATION', false)
  }
  settingsStore.updateSettingLocally('BILINGUAL_TRANSLATION_MODES', newModes)
}

// --- Script Detection Preferences ---

const createScriptSetting = (script, def) => computed({
  get: () => settingsStore.settings?.LANGUAGE_DETECTION_PREFERENCES?.[script] || def,
  set: (val) => {
    const preferences = { ...(settingsStore.settings?.LANGUAGE_DETECTION_PREFERENCES || {}) }
    preferences[script] = val
    logger.debug(`📝 Script preference [${script}] changed:`, val)
    settingsStore.updateSettingLocally('LANGUAGE_DETECTION_PREFERENCES', preferences)
  }
})

const arabicScriptPreference = createScriptSetting('arabic-script', 'fa')
const chineseScriptPreference = createScriptSetting('chinese-script', 'zh-cn')
const devanagariScriptPreference = createScriptSetting('devanagari-script', 'hi')
const latinScriptPreference = createScriptSetting('latin-script', 'none')

const arabicScriptOptions = computed(() => [
  { value: 'fa', label: `${t('persian_language_name')} (${t('default_label')})` },
  { value: 'ar', label: t('arabic_language_name') },
  { value: 'ur', label: t('urdu_language_name') },
  { value: 'ps', label: t('pashto_language_name') }
])

const chineseScriptOptions = computed(() => [
  { value: 'zh-cn', label: `${t('chinese_simplified_name')} (${t('default_label')})` },
  { value: 'zh-tw', label: t('chinese_traditional_name') },
  { value: 'lzh', label: t('chinese_classical_name') },
  { value: 'yue', label: t('chinese_cantonese_name') }
])

const devanagariScriptOptions = computed(() => [
  { value: 'hi', label: `${t('hindi_language_name')} (${t('default_label')})` },
  { value: 'mr', label: t('marathi_language_name') },
  { value: 'ne', label: t('nepali_language_name') }
])

const latinScriptOptions = computed(() => [
  { value: 'none', label: `${t('latin_priority_none_label')} (${t('default_label')})` },
  { value: 'en', label: t('english_language_name') },
  { value: 'fr', label: t('french_language_name') },
  { value: 'es', label: t('spanish_language_name') },
  { value: 'de', label: t('german_language_name') },
  { value: 'it', label: t('italian_language_name') },
  { value: 'pt', label: t('portuguese_language_name') },
  { value: 'tr', label: t('turkish_language_name') },
  { value: 'nl', label: t('dutch_language_name') }
])

// --- Dictionary Logic ---
const enableDictionary = createSetting('ENABLE_DICTIONARY', true)
const dictionaryProvider = createProviderSetting(TranslationMode.Dictionary_Translation)
const isGoogleDictionary = computed(() => {
  const provider = dictionaryProvider.value === 'default' ? selectedProvider.value : dictionaryProvider.value
  return [ProviderRegistryIds.GOOGLE, ProviderRegistryIds.GOOGLE_V2].includes(provider)
})
const showPronunciation = createSetting('DICTIONARY_SHOW_PRONUNCIATION', true)
const showPos = createSetting('DICTIONARY_SHOW_POS', true)
const showDefinitions = createSetting('DICTIONARY_SHOW_DEFINITIONS', false)
const showExamples = createSetting('DICTIONARY_SHOW_EXAMPLES', false)

// --- Provider & Language Logic ---

const isAIProvider = computed(() => ['gemini', 'openai', 'openrouter', 'requesty', 'cheaperinference', 'deepseek', 'webai', 'custom'].includes(selectedProvider.value))
const isAutoLanguageProvider = computed(() => selectedProviderInfo.value?.features?.includes('autoLanguage'))
const selectedProviderInfo = computed(() => findProviderById(selectedProvider.value))
const verifiedDeepLLanguageCatalog = computed(() => {
  const capabilities = settingsStore.deepLLanguageCapabilities
  if (capabilities?.status !== 'ready' || !Array.isArray(capabilities.catalog)) return null
  // Accept a fresh snapshot from any currently eligible key: capability
  // discovery fails over to the first succeeding key, matching settings.js.
  const configuredKeys = settingsStore.settings?.DEEPL_API_KEY || ''
  const tier = settingsStore.settings?.DEEPL_API_TIER
  const eligibleIdentities = new Set(
    getDeepLEligibleKeys(configuredKeys, tier).map(key => getDeepLLanguageIdentity(key, tier))
  )
  const age = capabilities.fetchedAt == null ? Infinity : Date.now() - capabilities.fetchedAt
  return eligibleIdentities.has(capabilities.identity) && age >= 0 && age < DEEPL_LANGUAGE_CATALOG_TTL_MS ? capabilities.catalog : null
})

const getFilteredLanguages = (type) => {
  const provider = selectedProvider.value
  const providerInfo = findProviderById(provider)
  const languages = allLanguages.value || []
  
  // 1. Determine if Auto-Detect should be available based on provider features
  const hasAutoDetect = providerInfo?.features?.includes('autoDetect')
  
  if (!languages.length) {
    return type === 'source' && hasAutoDetect ? [{ code: 'auto', name: 'Auto-Detect' }] : []
  }

  // Bypass filtering for smart auto-language providers (like Vajehyab)
  // as the selected languages will be used as fallbacks for other features
  if (isAutoLanguageProvider.value) {
    if (type === 'source') {
      return hasAutoDetect ? [{ code: 'auto', name: 'Auto-Detect' }, ...languages] : languages
    }
    return languages
  }

  // 2. Filter base languages supported by the provider
  let filtered = languages
  if (!isAIProvider.value) {
    if (isDeepLProvider(provider)) {
      const catalog = verifiedDeepLLanguageCatalog.value
      if (catalog?.length) {
        filtered = orderDeepLLanguages(catalog
          .filter(entry => matchDeepLLanguage(catalog, entry.lang, type) === 'supported')
          .map(entry => ({
              code: entry.lang,
              name: deepLDisplayNameFor(entry, entry.lang),
            normalizedTag: entry.normalizedTag,
            isBeta: entry.metadataValid === true && entry.status === 'beta',
            status: entry.status,
            features: entry.features
          })))
      }
      if (type === 'source') return [{ code: 'auto', name: 'Auto-Detect' }, ...filtered]
      return filtered
    }
    let providerKey = provider.toLowerCase()
    const mappingKey = providerKey.includes('google') || providerKey.includes('lingva') ? 'GOOGLE' : providerKey.includes('bing') || providerKey.includes('edge') ? 'BING' : providerKey.includes('deepl') ? 'DEEPL' : providerKey.includes('yandex') ? 'YANDEX' : 'BROWSER'
    
    if (providerKey.includes('google') || providerKey.includes('lingva')) providerKey = 'google'
    if (providerKey.includes('bing') || providerKey.includes('edge')) providerKey = 'bing'
    
    const supported = PROVIDER_SUPPORTED_LANGUAGES[providerKey]
    if (supported) {
      filtered = languages.filter(l => supported.includes(getProviderLanguageCode(l.code, mappingKey)) || supported.includes(l.code))
    }
  }

  // 3. Handle Source specifically (Auto-Detect logic & Source Restrictions)
  if (type === 'source') {
    // If provider has restricted pairs, only show languages that can act as a source
    const restrictedMap = PROVIDER_LANGUAGE_PAIRS[provider]
    if (restrictedMap) {
      filtered = filtered.filter(l => !!restrictedMap[l.code])
    }

    return hasAutoDetect ? [{ code: 'auto', name: 'Auto-Detect' }, ...filtered] : filtered
  }

  // 4. Handle Target specifically (Pair-based filtering)
  const restrictedMap = PROVIDER_LANGUAGE_PAIRS[provider]
  if (restrictedMap) {
    const currentSource = sourceLanguage.value
    // If we have a restricted map and a specific source is selected, filter targets
    if (currentSource !== 'auto' && restrictedMap[currentSource]) {
      const allowedTargets = restrictedMap[currentSource]
      filtered = filtered.filter(l => allowedTargets.includes(l.code))
    } else if (currentSource === 'auto') {
      // If source is auto (and somehow allowed), show union of all possible targets
      const allPossibleTargets = new Set(Object.values(restrictedMap).flat())
      filtered = filtered.filter(l => allPossibleTargets.has(l.code))
    }
  }

  return filtered
}

// Raw provider-filtered options (no selection backfill): the source of truth
// for support checks and sync decisions below.
const baseFilteredSourceLanguages = computed(() => getFilteredLanguages('source'))
const baseFilteredTargetLanguages = computed(() => getFilteredLanguages('target'))

// Label for a selected code missing from the loaded list (falls back to the
// code itself so the dropdown never renders a blank selection).
const languageLabelFor = (code) => {
  if (!code) return ''
  if (code === 'auto') return 'Auto-Detect'
  return allLanguages.value?.find(l => l.code === code)?.name || code
}

// Canonical Translate It name for an exact normalized code match (pt vs
// pt-BR stay distinct). DeepL-specific codes without a match return ''.
const canonicalNameFor = (code) => {
  const normalized = normalizeDeepLLanguageTag(code)
  if (!normalized) return ''
  return allLanguages.value?.find(language => normalizeDeepLLanguageTag(language.code) === normalized)?.name || ''
}

// Display name for a DeepL catalog entry: the canonical name on an exact
// code match, otherwise the official DeepL name, otherwise the code itself.
const deepLDisplayNameFor = (catalogEntry, code) => (
  (catalogEntry && canonicalNameFor(catalogEntry.lang))
  || catalogEntry?.name
  || canonicalNameFor(code)
  || languageLabelFor(code)
)

// DeepL dropdown order, mirroring other providers: entries exactly matching
// a canonical code first in allLanguages order, then DeepL-only
// languages/variants in relative API order. Sorts the freshly mapped option
// copies; never mutates the catalog or cached data.
const orderDeepLLanguages = (entries) => {
  const order = new Map((allLanguages.value || []).map((language, index) => [normalizeDeepLLanguageTag(language.code), index]))
  const canonical = []
  const deepLOnly = []
  for (const entry of entries) {
    const normalized = normalizeDeepLLanguageTag(entry.code)
    if (normalized && order.has(normalized)) canonical.push(entry)
    else deepLOnly.push(entry)
  }
  canonical.sort((a, b) => order.get(normalizeDeepLLanguageTag(a.code)) - order.get(normalizeDeepLLanguageTag(b.code)))
  return [...canonical, ...deepLOnly]
}

// Visible options: filtered list plus the current selection when filtered
// out, so a preserved-but-unsupported value still renders instead of blank.
const withCurrentSelection = (list, current, direction) => {
  if (!current) return list
  const normalized = normalizeDeepLLanguageTag(current)
  const resolved = resolveDeepLLanguageTag(current, direction)
  const existing = list.find(language => normalizeDeepLLanguageTag(language.code) === normalized)
    || (resolved !== normalized && list.find(language => normalizeDeepLLanguageTag(language.code) === resolved))
  if (existing) return list.map(language => language === existing ? { ...language, code: current } : language)
  const catalogEntry = verifiedDeepLLanguageCatalog.value?.find(entry => entry.normalizedTag === resolved)
  return [...list, {
    code: current,
    name: deepLDisplayNameFor(catalogEntry, current),
    isBeta: catalogEntry?.metadataValid === true && catalogEntry.status === 'beta',
    status: catalogEntry?.metadataValid === true ? catalogEntry.status : null
  }]
}

const filteredSourceLanguages = computed(() => withCurrentSelection(baseFilteredSourceLanguages.value, sourceLanguage.value, 'source'))
const filteredTargetLanguages = computed(() => withCurrentSelection(baseFilteredTargetLanguages.value, targetLanguage.value, 'target'))

const isDeepLProvider = (provider) => typeof provider === 'string' && provider.toLowerCase().includes('deepl')

const syncLanguagesWithProviderSupport = () => {
  const provider = selectedProvider.value
  const providerInfo = findProviderById(provider)
  const hasAutoDetect = providerInfo?.features?.includes('autoDetect')

  // 1. Correct Source Language
  if (sourceLanguage.value === 'auto' && !hasAutoDetect) {
    // Switch to first available source (e.g., 'fa' or 'en' for Vajehyab)
    sourceLanguage.value = baseFilteredSourceLanguages.value[0]?.code || 'en'
  } else if (!baseFilteredSourceLanguages.value.some(l => l.code === sourceLanguage.value)) {
    // Never silently drop a DeepL-conflicting source either: preserve the
    // selection so store-level validation surfaces it with feedback (#321).
    if (isDeepLProvider(selectedProvider.value)) return
    // If current source is not supported, default to first available
    sourceLanguage.value = hasAutoDetect ? 'auto' : (baseFilteredSourceLanguages.value[0]?.code || 'en')
  }

  // 2. Correct Target Language based on Source
  // Never silently drop a DeepL-conflicting target: preserve the selection
  // so store-level validation surfaces it with feedback (#321). All other
  // providers keep the existing automatic replacement.
  if (!baseFilteredTargetLanguages.value.some(l => l.code === targetLanguage.value)) {
    if (isDeepLProvider(selectedProvider.value)) return
    targetLanguage.value = (baseFilteredTargetLanguages.value.find(l => l.code === 'fa' || l.code === 'en' || getCanonicalCode(l.code) === 'en')?.code || baseFilteredTargetLanguages.value[0]?.code || 'en')
  }
}

watch([selectedProvider, sourceLanguage], () => {
  syncLanguagesWithProviderSupport()
  // Refresh a showing DeepL conflict message (or clear it when resolved);
  // never pops a new inline error unprompted — see validateLanguages.
  validateLanguages()
})

const deepLLanguageStatus = computed(() => {
  if (!isDeepLProvider(selectedProvider.value)) return ''
  const status = settingsStore.deepLLanguageCapabilities?.status
  if (status === 'loading') return 'deepl_languages_loading'
  return verifiedDeepLLanguageCatalog.value ? '' : 'deepl_languages_unavailable'
})

const deepLError = computed(() => validationErrorKey.value.startsWith('validation_deepl_') ? validationErrorKey.value : '')
const sourceLanguageError = computed(() => deepLError.value.includes('source_language') || deepLError.value.includes('languages_unverified') ? validationError.value : '')
const targetLanguageError = computed(() => deepLError.value.includes('target_language') || deepLError.value.includes('languages_unverified') ? validationError.value : '')

// --- Validation ---

const validationErrorKey = ref('')
const validationError = computed(() => {
  if (!validationErrorKey.value) return ''

  // 1. Check for provider configuration errors if that's the current error state
  if (validationErrorKey.value === 'PROVIDER_CONFIG_ERROR') {
    const missingKey = getFirstMissingSetting(selectedProvider.value, settingsStore.settings)
    if (missingKey) {
      // Use generic config error if it's a URL or Model, otherwise use API key error
      const errorKey = (missingKey.includes('URL') || missingKey.includes('MODEL')) 
        ? 'validation_provider_config_empty' 
        : 'validation_api_key_empty';
        
      return t(errorKey, { provider: selectedProviderInfo.value?.displayName || selectedProvider.value }) || 'Provider not configured'
    }
    return ''
  }

  // 2. DeepL compatibility errors (store-level identifiers with a :code payload)
  if (validationErrorKey.value.startsWith('validation_deepl_')) {
    const separatorIndex = validationErrorKey.value.indexOf(':')
    const baseKey = separatorIndex === -1 ? validationErrorKey.value : validationErrorKey.value.slice(0, separatorIndex)
    const code = separatorIndex === -1 ? '' : validationErrorKey.value.slice(separatorIndex + 1)
    return t(baseKey, { language: code }) || ''
  }

  // 3. Otherwise show language validation errors (validationErrorKey holds the error key)
  return getFirstErrorTranslated('sourceLanguage', t) || getFirstErrorTranslated('targetLanguage', t) || ''
})

watch(validationError, (err) => {
  // Sync with global store state
  settingsStore.isSettingsValid = !err
}, { immediate: true })

const validateLanguages = async (showFeedback = false) => {
  clearErrors()
  
  // 1. Standard language validation
  const isValid = await validate(sourceLanguage.value, targetLanguage.value)
  if (!isValid) {
    // Replace a currently shown DeepL conflict so the displayed error tracks
    // the input; never surface unsolicited standard errors otherwise.
    if (showFeedback || validationErrorKey.value.startsWith('validation_deepl_')) {
      validationErrorKey.value = getFirstError('sourceLanguage') || getFirstError('targetLanguage') || ''
    }
    return false
  }

  // 2. Provider configuration validation
  const missingKey = getFirstMissingSetting(selectedProvider.value, settingsStore.settings);
  if (missingKey) {
    // Drop a stale DeepL conflict key: the provider-config warning owns the
    // display from here (missingSetting drives its banner); the DeepL message
    // no longer applies once the provider changed or needs configuration.
    if (validationErrorKey.value.startsWith('validation_deepl_')) {
      validationErrorKey.value = ''
    }
    if (showFeedback) {
      validationErrorKey.value = 'PROVIDER_CONFIG_ERROR'
    }
    return false
  }

  // 3. DeepL effective-set compatibility — consume the store-level result
  // (no duplicated logic). Refreshes a showing conflict message so it tracks
  // the current selection, but only takes over the display on explicit
  // feedback or when already showing a DeepL conflict.
  const storeValidation = settingsStore.validateSettings()
  const deeplError = storeValidation.errors.find(e => e.includes('deepl') && e.includes('language'))
  if (deeplError) {
    if (showFeedback || validationErrorKey.value.startsWith('validation_deepl_')) {
      validationErrorKey.value = deeplError
    }
    return false
  }

  // Clear error display if everything is valid
  validationErrorKey.value = ''
  return true
}

// Re-evaluate validation when provider credentials/tier drafts change; catalog
// refresh preserves the saved language choices and updates their feedback.
watch(() => [settingsStore.settings?.DEEPL_API_KEY, settingsStore.settings?.DEEPL_API_TIER, selectedProvider.value], async () => {
  if (isDeepLProvider(selectedProvider.value) && settingsStore.refreshDeepLLanguageCapabilities) {
    await settingsStore.refreshDeepLLanguageCapabilities()
  }
  validateLanguages()
})

// Validation feedback listener
const handleValidationFeedback = (e) => {
  const { field, focus } = e.detail || {};
  
  // Explicitly trigger validation feedback display
  validateLanguages(true);

  // Focus and highlight logic
  if (field === 'languages') {
    highlightElement(focus === 'target' ? 'TARGET_LANGUAGE' : 'SOURCE_LANGUAGE');
  }
};

onMounted(() => {
  window.addEventListener('options-trigger-validation-feedback', handleValidationFeedback);
})

onUnmounted(() => {
  window.removeEventListener('options-trigger-validation-feedback', handleValidationFeedback);
})

onMounted(async () => {
  await loadLanguages()
  if (isDeepLProvider(selectedProvider.value) && settingsStore.refreshDeepLLanguageCapabilities) {
    await settingsStore.refreshDeepLLanguageCapabilities()
  }
  await validateLanguages()
})
defineExpose({ validate: validateLanguages })

</script>
