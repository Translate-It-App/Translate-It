<template>
  <div class="translation-view">
    <div class="language-controls">
      <!-- Provider Selector: Manages temporary session-based provider overrides -->
      <ProviderSelector
        v-model="currentProviderModel"
        mode="split"
        :is-global="false"
        :show-sync="true"
        allow-set-default
        only-configured
        :loading="translationFormRef?.isTranslating"
        @translate="emit('translate', $event)"
        @cancel="emit('cancel')"
      />

      <!-- Language Selector: Handles source and target language selection -->
      <LanguageSelector
        v-model:source-language="sourceLanguageModel"
        v-model:target-language="targetLanguageModel"
        :provider="currentProvider"
        :disabled="liveDubbingBusy"
        :last-keyword="lastKeyword"
        show-default-actions
        :default-actions-enabled="isReady"
        :source-is-saved-default="sourceIsSavedDefault"
        :target-is-saved-default="targetIsSavedDefault"
        :source-default-title="sourceDefaultTitle"
        :target-default-title="targetDefaultTitle"
        :source-title="t('popup_source_language_title') || 'زبان مبدا'"
        :target-title="t('popup_target_language_title') || 'زبان مقصد'"
        :swap-title="t('popup_swap_languages_title') || 'جابجایی زبان‌ها'"
        :swap-alt="t('popup_swap_languages_alt_icon') || 'Swap'"
        :auto-detect-label="'Auto-Detect'"
        @set-default-source="emit('set-default-source')"
        @set-default-target="emit('set-default-target')"
      />

      <!-- Clear Button: Minimized clear fields button -->
      <button
        v-if="showClearButton"
        class="ti-btn-min-clear"
        :title="t('popup_clear_storage_title_icon') || 'پاک کردن فیلدها'"
        :aria-label="t('popup_clear_storage_title_icon') || 'پاک کردن فیلدها'"
        @click="emit('clear')"
      >
        <MaskIcon
          :src="clearIcon"
          :size="14"
        />
      </button>
    </div>

    <!-- Scrollable Translation Area: Contains the main translation form -->
    <div class="translation-container">
      <TranslationForm
        ref="translationFormRef"
        :translation="translation"
        :source-language="sourceLanguage"
        :target-language="targetLanguage"
        :provider="currentProvider"
        @can-translate-change="emit('can-translate-change', $event)"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import LanguageSelector from '@/components/shared/LanguageSelector.vue'
import ProviderSelector from '@/components/shared/ProviderSelector.vue'
import TranslationForm from '@/components/popup/TranslationForm.vue'
import MaskIcon from '@/components/shared/MaskIcon.vue'
import ExtensionContextManager from '@/core/extensionContext.js'

// Import adjacent SCSS
import './TranslationView.scss'

const props = defineProps({
  sourceLanguage: {
    type: String,
    default: 'auto'
  },
  targetLanguage: {
    type: String,
    default: 'en'
  },
  currentProvider: {
    type: String,
    default: ''
  },
  translation: {
    type: Object,
    required: true
  },
  liveDubbingBusy: {
    type: Boolean,
    default: false
  },
  isReady: {
    type: Boolean,
    default: false
  },
  sourceIsSavedDefault: {
    type: Boolean,
    default: false
  },
  targetIsSavedDefault: {
    type: Boolean,
    default: false
  },
  sourceDefaultTitle: {
    type: String,
    default: ''
  },
  targetDefaultTitle: {
    type: String,
    default: ''
  },
  lastKeyword: {
    type: String,
    default: ''
  },
  showClearButton: {
    type: Boolean,
    default: true
  }
})

const emit = defineEmits([
  'translate',
  'cancel',
  'clear',
  'set-default-source',
  'set-default-target',
  'can-translate-change',
  'update:sourceLanguage',
  'update:targetLanguage',
  'update:currentProvider'
])

const { t } = useUnifiedI18n()
/** Monochrome clear icon rendered via CSS mask; inherits button color. */
const clearIcon = computed(() => ExtensionContextManager.safeGetURL('icons/ui/clear.png'))

// Two-way proxies so inner selectors can write back to PopupApp-owned state
const sourceLanguageModel = computed({
  get: () => props.sourceLanguage,
  set: (value) => emit('update:sourceLanguage', value)
})
const targetLanguageModel = computed({
  get: () => props.targetLanguage,
  set: (value) => emit('update:targetLanguage', value)
})
const currentProviderModel = computed({
  get: () => props.currentProvider,
  set: (value) => emit('update:currentProvider', value)
})

const translationFormRef = ref(null)

/**
 * Expose the inner form's imperative API so PopupApp keeps driving
 * translate/cancel through a single ref without knowing the nesting.
 */
defineExpose({
  triggerTranslation: (...args) => translationFormRef.value?.triggerTranslation(...args),
  cancelTranslation: (...args) => translationFormRef.value?.cancelTranslation(...args)
})
</script>
