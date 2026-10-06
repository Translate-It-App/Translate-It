import { computed } from 'vue';
import { useSettingsStore } from '@/features/settings/stores/settings.js';
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js';
import { openOptionsPage } from '@/core/helpers.js';
import {
  classifyAutoTranslateRule,
  getAutoTranslateSiteRule,
  isExactPageRule,
  isSiteScopeRule,
  normalizeAutoTranslateRuleUrl,
} from '@/utils/ui/exclusion.js';

/** Composable for page auto-translation rules management. */
export function useAutoTranslateRules({ currentUrl }) {
  const settingsStore = useSettingsStore();
  const { t } = useUnifiedI18n();

  const normalizedPageUrl = computed(() => normalizeAutoTranslateRuleUrl(currentUrl.value));
  const siteRule = computed(() => getAutoTranslateSiteRule(currentUrl.value));
  const isFileUrl = computed(() => {
    try {
      return new URL(currentUrl.value).protocol === 'file:';
    } catch {
      return false;
    }
  });
  const siteScopeAvailable = computed(() => !!siteRule.value);
  const rules = () => settingsStore.settings?.WHOLE_PAGE_AUTO_TRANSLATE_RULES || [];
  const hasPageRule = computed(() => rules().some(rule => isExactPageRule(currentUrl.value, rule)));
  const hasSiteRule = computed(() => rules().some(rule => isSiteScopeRule(currentUrl.value, rule)));
  const hasBroaderMatchingRule = computed(() => rules().some(
    rule => classifyAutoTranslateRule(currentUrl.value, rule) === 'match',
  ));
  const isActive = computed(() => hasPageRule.value || hasSiteRule.value || hasBroaderMatchingRule.value);
  const showManageRules = computed(() => hasBroaderMatchingRule.value);

  const isAutoTranslateToggleVisible = computed(() => !!normalizedPageUrl.value);
  const isAutoTranslateToggleDisabled = computed(() => hasBroaderMatchingRule.value);
  const autoTranslateToggleTitle = computed(() => {
    if (hasPageRule.value) {
      return t('page_translation_remove_auto_translate_tooltip') || 'Remove from auto-translate rules';
    }
    if (hasSiteRule.value || hasBroaderMatchingRule.value) {
      return t('page_translation_auto_translate_inherited_tooltip') || 'This page is auto-translated by a broader rule. Change it in settings.';
    }
    return t('page_translation_add_auto_translate_tooltip') || 'Add to auto-translate rules';
  });

  const toggleScope = async (scope) => {
    const rule = scope === 'page' ? normalizedPageUrl.value : siteRule.value;
    if (!rule) return;
    const currentRules = [...rules()];
    const isScopeRule = scope === 'page'
      ? candidate => isExactPageRule(currentUrl.value, candidate)
      : candidate => isSiteScopeRule(currentUrl.value, candidate);
    const matchingRules = currentRules.filter(isScopeRule);
    const nextRules = matchingRules.length
      ? currentRules.filter(candidate => !isScopeRule(candidate))
      : [...currentRules, rule];
    await settingsStore.updateSettingAndPersist('WHOLE_PAGE_AUTO_TRANSLATE_RULES', nextRules);
  };
  const togglePageScope = () => toggleScope('page');
  const toggleSiteScope = () => toggleScope('site');
  const openManageRules = () => openOptionsPage('/activation?highlight=WHOLE_PAGE_AUTO_TRANSLATE_RULES_DRAWER');

  return {
    normalizedPageUrl,
    siteRule,
    hasPageRule,
    hasSiteRule,
    hasBroaderMatchingRule,
    isActive,
    isFileUrl,
    siteScopeAvailable,
    showManageRules,
    scopeActions: { togglePageScope, toggleSiteScope },
    openManageRules,
    hasExactAutoTranslateRule: hasPageRule,
    hasNonExactMatchingAutoTranslateRule: hasBroaderMatchingRule,
    isAutoTranslateToggleVisible,
    isAutoTranslateToggleActive: isActive,
    isAutoTranslateToggleDisabled,
    autoTranslateToggleTitle,
    toggleAutoTranslateForCurrentPage: togglePageScope,
  };
}
