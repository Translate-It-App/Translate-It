<!-- PageTranslationButton - Translate/Restore button or text label -->
<template>
  <div
    class="page-translation-controls"
    :class="{ 'text-only': textOnly, 'compact-wrapper': compact }"
  >
    <!-- Progress Bar (shown during translation, only if not textOnly) -->
    <div
      v-if="showProgress && !textOnly"
      class="progress-bar"
      :class="{ compact }"
    >
      <div
        class="progress-fill"
        :style="{ width: `${progress}%` }"
      />
      <span class="progress-text">{{ progressText }}</span>
    </div>

    <!-- State: Not Translated (Show Red dot here if there was a previous error) -->
    <template v-if="!isTranslated && !isTranslating && !isAutoTranslating">
      <a
        v-if="textOnly"
        href="#"
        class="toolbar-link"
        :class="{ disabled: !canTranslate }"
        @click.prevent="handleTranslate"
      >
        <PageTranslationStatus 
          v-if="hasError"
          :status-data="{ hasError: true }"
          mode="compact"
          class="ti-text-status-badge"
        />
        {{ t('page_translation_btn_translate') || 'Translate Page' }}
      </a>
      <BaseButton
        v-else
        :variant="compact ? 'ghost' : 'secondary'"
        :disabled="!canTranslate"
        :title="translateButtonTitle"
        :class="{ 'is-compact-icon': compact, 'is-translate-btn': true }"
        @click="handleTranslate"
      >
        <div class="ti-btn-status-container">
          <PageTranslationStatus
            v-if="hasError && !useCornerStatus"
            :status-data="{ hasError: true }"
            mode="compact"
            class="ti-btn-status-badge"
          />
          <img
            v-if="compact"
            :src="ExtensionContextManager.safeGetURL('icons/ui/whole-page.png')"
            class="toolbar-icon"
            alt="Translate"
          >
          <Icon
            v-else
            icon="fa6-solid:language"
          />
        </div>
        <span v-if="!compact">{{ translateButtonText }}</span>
      </BaseButton>
    </template>

    <!-- State: Translating or Auto-Translating -->
    <template v-if="isTranslating || isAutoTranslating">
      <a
        v-if="textOnly"
        href="#"
        class="toolbar-link loading"
        :class="{ 'ti-active': isAutoTranslating }"
        @click.prevent="handleCancelOrStop"
      >
        <PageTranslationStatus 
          :status-data="{ isTranslating, isAutoTranslating, isTranslated, progress }"
          mode="compact"
          class="ti-text-status-badge"
        />
        {{ t('page_translation_btn_stop') || 'Stop Translating' }}
      </a>
      <BaseButton
        v-else
        :variant="compact ? 'ghost' : 'primary'"
        :title="cancelButtonTitle"
        :class="{ 'is-compact-icon': compact, 'ti-active': isAutoTranslating }"
        @click="handleCancelOrStop"
      >
        <div class="ti-btn-status-container">
          <!-- Loading Spinner centered via CSS -->
          <LoadingSpinner
            v-if="isTranslating || isAutoTranslating"
            size="sm"
          />
          
          <!-- Status Badge absolute via CSS (suppressed when the root-level
               corner badge owns the status — never two active statuses) -->
          <PageTranslationStatus
            v-if="!useCornerStatus"
            :status-data="{ isTranslating, isAutoTranslating, isTranslated, progress }"
            mode="compact"
            class="ti-btn-status-badge"
          />
          
          <!-- Icon removed during translation states as requested. 
               Container size is maintained via SCSS .compact-wrapper fix -->
        </div>

        <span v-if="!compact">{{ isTranslating ? translatingText : stopTranslatingText }}</span>
      </BaseButton>
    </template>

    <!-- State: Translated -->
    <template v-if="isTranslated && !isTranslating && !isAutoTranslating">
      <div
        v-if="textOnly"
        class="ti-text-status-wrapper"
      >
        <a
          href="#"
          class="toolbar-link"
          :class="{ disabled: !canRestore }"
          @click.prevent="handleRestore"
        >
          <PageTranslationStatus 
            :status-data="{ isTranslated: true, isTranslating: false, isAutoTranslating: false }"
            mode="compact"
            class="ti-text-status-badge"
          />
          {{ t('page_translation_btn_restore') || 'Restore Original' }}
        </a>
      </div>
      <BaseButton
        v-else
        :variant="compact ? 'ghost' : 'secondary'"
        :disabled="!canRestore"
        :title="restoreButtonTitle"
        :class="{ 'is-compact-icon': compact, 'is-restore-btn': true }"
        @click="handleRestore"
      >
        <div class="ti-btn-status-container">
          <PageTranslationStatus
            v-if="!useCornerStatus"
            :status-data="{ isTranslated: true, isTranslating: false, isAutoTranslating: false }"
            mode="compact"
            class="ti-btn-status-badge"
          />
          <img
            :src="ExtensionContextManager.safeGetURL('icons/ui/restore.png')"
            :class="compact ? 'toolbar-icon' : 'ti-btn__icon'"
            alt="Restore"
          >
        </div>
        <span v-if="!compact">{{ restoreButtonText }}</span>
      </BaseButton>
    </template>

    <!-- Error State Message -->
    <div
      v-if="hasError && !compact && !textOnly"
      class="error-message"
    >
      {{ message }}
    </div>

    <!-- Root-level corner status badge (compact + statusBadgePosition="corner").
         Lives on .page-translation-controls itself — top-right of the WHOLE
         control, opposite the bottom-right Auto-Translate star. -->
    <PageTranslationStatus
      v-if="compactCornerStatusData"
      :status-data="compactCornerStatusData"
      mode="compact"
      class="ti-compact-corner-status-badge"
    />

    <!-- Auto-Translate Star Toggle -->
    <button
      v-if="showAutoTranslateToggle && isAutoTranslateToggleVisible"
      ref="scopeTrigger"
      class="page-translate-star-btn"
      :class="{ 
        'is-active': isActive
      }"
      :title="scopeMenuLabel"
      :aria-expanded="scopeMenuOpen"
      :aria-label="scopeMenuLabel"
      @click.stop="toggleScopeMenu"
    >
      <svg 
        viewBox="0 0 24 24" 
        width="14" 
        height="14" 
        class="star-svg"
      >
        <path 
          :fill="isActive ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linejoin="round"
          stroke-linecap="round"
          d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
        />
      </svg>
    </button>
    <div
      v-if="scopeMenuOpen"
      class="auto-translate-scope-menu"
      role="group"
      :aria-label="scopeMenuLabel"
      @click.stop
    >
      <button
        ref="firstScopeItem"
        :aria-pressed="hasPageRule"
        @click.stop="scopeActions.togglePageScope()"
      >
        <span aria-hidden="true">{{ hasPageRule ? '✓' : '' }}</span>{{ t('auto_translate_scope_this_page', 'This Page') }}
      </button>
      <button
        v-if="siteScopeAvailable"
        :aria-pressed="hasSiteRule"
        @click.stop="scopeActions.toggleSiteScope()"
      >
        <span aria-hidden="true">{{ hasSiteRule ? '✓' : '' }}</span>{{ t('auto_translate_scope_this_site', 'This Site') }}
      </button>
      <template v-if="showManageRules">
        <div class="auto-translate-managed-note">
          {{ t('auto_translate_managed_by_broader_rule', 'Managed by a broader rule') }}
        </div>
        <button
          @click.stop="openManageRules"
        >
          {{ t('auto_translate_manage_rules', 'Manage Rules') }}
        </button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import BaseButton from '@/components/base/BaseButton.vue';
import LoadingSpinner from '@/components/base/LoadingSpinner.vue';
import { Icon } from '@iconify/vue';
import { usePageTranslation } from '../composables/usePageTranslation.js';
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js';
import PageTranslationStatus from '@/components/shared/PageTranslationStatus.vue';
import ExtensionContextManager from '@/core/extensionContext.js';
import { useActiveTabUrl } from '@/composables/core/useActiveTabUrl.js';
import { useAutoTranslateRules } from '../composables/useAutoTranslateRules.js';

const props = defineProps({
  compact: {
    type: Boolean,
    default: false,
  },
  textOnly: {
    type: Boolean,
    default: false,
  },
  targetLanguage: {
    type: String,
    default: null
  },
  disabled: {
    type: Boolean,
    default: false
  },
  showAutoTranslateToggle: {
    type: Boolean,
    default: false
  },
  /**
   * Status badge presentation:
   * - 'inner'  — badge inside .ti-btn-status-container (default; Sidepanel).
   * - 'corner' — root-level top-right badge (only meaningful with compact;
   *              PopupHeader opts in). Explicit prop — no DOM/class detection.
   */
  statusBadgePosition: {
    type: String,
    default: 'inner',
    validator: (value) => ['inner', 'corner'].includes(value)
  }
});

const { t } = useUnifiedI18n();

const { activeTabUrl } = useActiveTabUrl({ enabled: computed(() => props.showAutoTranslateToggle) });

const {
  isAutoTranslateToggleVisible,
  isActive,
  hasPageRule,
  hasSiteRule,
  siteScopeAvailable,
  showManageRules,
  scopeActions,
  openManageRules,
} = useAutoTranslateRules({ currentUrl: activeTabUrl });
const scopeMenuLabel = computed(() => t('auto_translate_scope_menu_label', 'Auto-translate scope'));
const scopeMenuOpen = ref(false);
const scopeTrigger = ref(null);
const firstScopeItem = ref(null);
const toggleScopeMenu = async () => {
  scopeMenuOpen.value = !scopeMenuOpen.value;
  if (scopeMenuOpen.value) { await nextTick(); firstScopeItem.value?.focus(); }
};
const onScopeMenuKeydown = (event) => {
  if (event.key === 'Escape' && scopeMenuOpen.value) {
    scopeMenuOpen.value = false;
    scopeTrigger.value?.focus();
  }
};
const onScopeMenuPointerdown = (event) => {
  if (scopeMenuOpen.value && !event.target.closest('.page-translation-controls')) scopeMenuOpen.value = false;
};
onMounted(() => {
  document.addEventListener('keydown', onScopeMenuKeydown);
  document.addEventListener('pointerdown', onScopeMenuPointerdown);
});
onUnmounted(() => {
  document.removeEventListener('keydown', onScopeMenuKeydown);
  document.removeEventListener('pointerdown', onScopeMenuPointerdown);
});

const {
  isTranslating,
  isTranslated,
  isAutoTranslating,
  progress,
  message,
  canTranslate: baseCanTranslate,
  canRestore,
  hasError,
  translatePage,
  restorePage,
  stopAutoTranslation,
  cancelTranslation,
} = usePageTranslation();

// Computed properties
const canTranslate = computed(() => baseCanTranslate.value && !props.disabled);
const showProgress = computed(() => isTranslating.value && progress.value > 0 && !props.compact);

/** Corner presentation is opt-in, compact-only, and never textOnly — textOnly
 *  keeps its own status path; every other consumer (Sidepanel default,
 *  non-compact) keeps the internal badge path. */
const useCornerStatus = computed(
  () => props.compact
    && !props.textOnly
    && props.statusBadgePosition === 'corner'
);

/**
 * Status payload for the root-level corner badge, preserving the exact
 * precedence of the state templates above:
 * translating/auto → completed → idle-with-error; `null` when no state
 * currently renders a status (idle without a previous error).
 * @returns {object|null} PageTranslationStatus status-data payload
 */
const compactCornerStatusData = computed(() => {
  if (!useCornerStatus.value) return null;
  if (isTranslating.value || isAutoTranslating.value) {
    return { isTranslating: isTranslating.value, isAutoTranslating: isAutoTranslating.value, isTranslated: isTranslated.value, progress: progress.value };
  }
  if (isTranslated.value) {
    return { isTranslated: true, isTranslating: false, isAutoTranslating: false };
  }
  if (hasError.value) {
    return { hasError: true };
  }
  return null;
});

const progressText = computed(() => {
  if (message.value) return message.value;
  if (progress.value > 0) {
    return `${progress.value}%`;
  }
  return '';
});

const translateButtonText = computed(() => {
  if (props.compact) return t('popup_translate_button_text') || 'Translate';
  return t('page_translation_btn_translate') || 'Translate Page';
});

const translatingText = computed(() => {
  return t('popup_string_during_translate') || 'Translating...';
});

const stopTranslatingText = computed(() => {
  return t('page_translation_btn_stop') || 'Stop Translating';
});

const restoreButtonText = computed(() => {
  return t('page_translation_btn_restore') || 'Restore Original';
});

const translateButtonTitle = computed(() => {
  if (props.disabled) {
    return t('provider_does_not_support_bulk') || 'This provider does not support page/element translation';
  }
  if (!canTranslate.value) {
    return isTranslating.value || isAutoTranslating.value ? t('page_translation_tooltip_in_progress', 'Translation in progress...') : t('page_translation_tooltip_translate', 'Translate entire page');
  }
  return t('page_translation_tooltip_translate', 'Translate entire page');
});

const cancelButtonTitle = computed(() => {
  if (isAutoTranslating.value) return t('page_translation_tooltip_stop_auto', 'Stop auto-translation');
  return t('page_translation_tooltip_cancel', 'Cancel translation');
});

const restoreButtonTitle = computed(() => {
  if (!canRestore.value) {
    return isTranslating.value || isAutoTranslating.value ? t('page_translation_tooltip_restore_blocked', 'Cannot restore during translation') : t('page_translation_tooltip_nothing_to_restore', 'No translation to restore');
  }
  return t('page_translation_tooltip_restore', 'Restore original page content');
});

// Actions
const handleTranslate = () => {
  if (!canTranslate.value) return;
  // Start translation using user's configured settings
  translatePage({ targetLanguage: props.targetLanguage });
};

const handleCancelOrStop = () => {
  if (isAutoTranslating.value) {
    stopAutoTranslation();
  } else if (isTranslating.value) {
    cancelTranslation();
  }
};

const handleRestore = () => {
  if (!canRestore.value) return;
  restorePage();
};
</script>

<script>
// For recursive or named access if needed
export default {
  name: 'PageTranslationButton'
};
</script>
