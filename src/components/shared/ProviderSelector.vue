<template>
  <!-- Split Button Mode for Popup -->
  <div
    v-if="mode === 'split'"
    ref="selectorRef"
    class="ti-split-translate-button-container"
    :class="{
      'ti-dropdown-open': isDropdownOpen,
      'is-disabled': disabled,
      'ti-split-translate-button-container--compact-label':
        presentation === 'compact-label',
    }"
    v-bind="$attrs"
  >
    <div
      class="ti-split-translate-button"
      :class="{ 'ti-is-loading': loading }"
    >
      <button
        type="submit"
        class="ti-translate-main-area"
        :title="mainActionLabel"
        :aria-label="mainActionLabel"
        :disabled="disabled"
        @click="handleTranslate"
        @keydown="handleKeydown"
      >
        <MaskIcon
          v-if="loading"
          :src="stopIcon"
          :size="10"
          class="ti-api-provider-icon ti-stop-icon"
        />
        <img
          v-else
          :src="currentProviderIcon"
          alt="API Provider"
          class="ti-api-provider-icon"
          :class="{ 'ti-invert-dark': isProviderInverted(currentProvider) }"
        />
        <span class="ti-translate-main-labels">
          <span class="ti-translate-main-label">{{ mainActionLabel }}</span>
          <span
            class="ti-translate-main-label-reserve"
            aria-hidden="true"
            >{{ translateActionLabel }}</span
          >
          <span
            class="ti-translate-main-label-reserve"
            aria-hidden="true"
            >{{ stopActionLabel }}</span
          >
        </span>
      </button>
      <button
        ref="triggerBtnRef"
        type="button"
        class="ti-provider-dropdown-area"
        :class="{ 'ti-active': isDropdownOpen }"
        :disabled="isProviderSelectionDisabled"
        :aria-expanded="isDropdownOpen"
        :aria-controls="menuId"
        :aria-label="dropdownTriggerLabel"
        @click.stop="toggleDropdown"
        @keydown="handleKeydown"
      >
        <IconButton
          icon="dropdown-arrow.svg"
          alt="Dropdown"
          type="inline"
          class="ti-dropdown-arrow"
          :disabled="isProviderSelectionDisabled"
        />
      </button>
    </div>
  </div>

  <!-- Regular Button Mode for Sidepanel -->
  <div
    v-else-if="mode === 'button'"
    ref="selectorRef"
    class="ti-provider-button-container"
    :class="{
      'ti-dropdown-open': isDropdownOpen,
      'is-disabled': isProviderSelectionDisabled,
    }"
    v-bind="$attrs"
  >
    <button
      ref="triggerBtnRef"
      class="ti-provider-button"
      :class="{ 'ti-active': isDropdownOpen }"
      :disabled="isProviderSelectionDisabled"
      :aria-expanded="isDropdownOpen"
      :aria-controls="menuId"
      @click="toggleDropdown"
      @keydown="handleKeydown"
    >
      <img
        v-if="!selectionOnly || currentProvider"
        :src="currentProviderIcon"
        alt="API Provider"
        class="ti-api-provider-icon"
        :class="{ 'ti-invert-dark': isProviderInverted(currentProvider) }"
      />
      <!-- Selection-only picker: empty model shows the add placeholder,
           never the global provider icon/name (the default branch is absent
           for default consumers, whose provider is always resolvable). -->
      <span
        v-if="selectionOnly && !currentProvider"
        class="ti-provider-button-placeholder"
        >{{ selectionPlaceholderLabel }}</span
      >
      <span v-else>{{ currentProviderName }}</span>
      <IconButton
        icon="dropdown-arrow.svg"
        alt="Dropdown"
        type="inline"
        class="dropdown-arrow"
        :class="{ rotated: isDropdownOpen }"
        :disabled="isProviderSelectionDisabled"
      />
    </button>
  </div>

  <!-- Icon Only Mode for Sidepanel Toolbar -->
  <div
    v-else-if="mode === 'icon-only'"
    ref="selectorRef"
    class="ti-provider-icon-only-container"
    :class="{
      'ti-dropdown-open': isDropdownOpen,
      'is-disabled': isProviderSelectionDisabled,
    }"
    v-bind="$attrs"
  >
    <button
      ref="triggerBtnRef"
      class="ti-provider-icon-button"
      :class="{ 'ti-active': isDropdownOpen }"
      :title="currentProviderName"
      :disabled="isProviderSelectionDisabled"
      :aria-expanded="isDropdownOpen"
      :aria-controls="menuId"
      @click="toggleDropdown"
      @keydown="handleKeydown"
    >
      <img
        :src="currentProviderIcon"
        alt="API Provider"
        class="ti-provider-icon-only"
        :class="{ 'ti-invert-dark': isProviderInverted(currentProvider) }"
      />
    </button>
  </div>

  <!-- Mobile Mode for Manual Input / Bottom Sheets -->
  <div
    v-else-if="mode === 'mobile'"
    ref="selectorRef"
    class="ti-provider-mobile-container"
    :class="{
      'ti-dropdown-open': isDropdownOpen,
      'is-disabled': isProviderSelectionDisabled,
    }"
    v-bind="$attrs"
  >
    <button
      ref="triggerBtnRef"
      class="ti-provider-mobile-button"
      :class="{ 'ti-active': isDropdownOpen }"
      :disabled="isProviderSelectionDisabled"
      :aria-expanded="isDropdownOpen"
      :aria-controls="menuId"
      @click="toggleDropdown"
      @keydown="handleKeydown"
    >
      <img
        :src="currentProviderIcon"
        alt="API Provider"
        class="ti-api-provider-icon"
        :class="{ 'ti-invert-dark': isProviderInverted(currentProvider) }"
      />
      <span>{{ currentProviderName }}</span>
      <IconButton
        icon="dropdown-arrow.svg"
        alt="Dropdown"
        type="inline"
        class="dropdown-arrow"
        :class="{ rotated: isDropdownOpen }"
        :disabled="isProviderSelectionDisabled"
      />
    </button>
  </div>

  <!-- Compact Mode (Native select + adjacent accessible Configure Providers control) -->
  <div
    v-else
    class="ti-provider-compact-container"
    :class="{ 'is-disabled': isProviderSelectionDisabled }"
    v-bind="$attrs"
  >
    <select
      :value="currentProvider"
      class="ti-provider-select"
      :class="{ 'is-dark': settingsStore.isDarkTheme }"
      :disabled="isProviderSelectionDisabled"
      @change="handleProviderChange"
    >
      <!-- Single source of truth: groupedMenu preserves EVERY entry
           (synthetic Default, uncategorized providers included) in full menu
           visual order. Labeled bins become optgroups; unlabeled bins
           (Default first, uncategorized) stay as loose options so all
           selections remain available. -->
      <template
        v-for="group in groupedMenu"
        :key="group.key"
      >
        <optgroup
          v-if="group.header"
          :key="`${group.key}-optgroup`"
          :label="group.header"
        >
          <option
            v-for="item in group.items"
            :key="item.id"
            :value="item.id"
          >
            {{ item.name }}
          </option>
        </optgroup>
        <template v-else>
          <option
            v-for="item in group.items"
            :key="item.id"
            :value="item.id"
          >
            {{ item.name }}
          </option>
        </template>
      </template>
    </select>
    <button
      v-if="!selectionOnly"
      type="button"
      class="ti-provider-compact-config-btn"
      :title="configureProvidersLabel"
      :aria-label="configureProvidersLabel"
      @click.stop="openProvidersSettings"
    >
      <MaskIcon
        :src="gearIcon"
        :size="12"
        class="ti-compact-config-icon"
      />
    </button>
  </div>

  <!-- Common Dropdown Teleport (Single instance for all modes) -->
  <Teleport
    v-if="mode !== 'compact'"
    :to="teleportTarget"
    :disabled="!isTeleportEnabled"
  >
    <div
      v-if="isDropdownOpen"
      :id="menuId"
      ref="dropdownMenuElRef"
      class="ti-provider-dropdown-menu"
      :class="{
        'ti-open-upward': isUpward,
        'ti-is-teleported': isTeleportEnabled,
        'ti-provider-dropdown-menu--popup': isPopupTextContext,
        'ti-provider-dropdown-menu--sidepanel': isSidepanelSplitContext,
      }"
      :style="dropdownStyles"
      @click.stop
      @keydown="handleMenuKeydown"
      @focusout="handleMenuFocusOut"
    >
      <div
        ref="dropdownMenuRef"
        class="ti-provider-dropdown-list"
        @mouseleave="handleMenuPointerLeave"
      >
        <div
          v-for="group in visibleGroups"
          :key="group.key"
          class="ti-dropdown-group"
          :role="group.header ? 'group' : undefined"
          :aria-labelledby="group.headerId || undefined"
        >
          <!-- Category heading: an accessible disclosure button (was an
               aria-hidden label). Toggles this group's persisted collapse
               state via the storage lane; Default/Sync/Configure stay
               outside collapse. -->
          <button
            v-if="group.header"
            :id="group.headerId"
            type="button"
            class="ti-dropdown-group-header"
            :class="{ 'is-collapsed': group.collapsed }"
            :aria-expanded="!group.collapsed"
            :aria-controls="group.rowsId"
            @mouseenter="handleCategoryPointerEnter"
            @click="toggleCategoryCollapse(group)"
          >
            <span class="ti-dropdown-group-title">{{ group.header }}</span>
            <MaskIcon
              :src="chevronIcon"
              :size="10"
              class="ti-provider-chevron"
              :class="{ 'is-expanded': !group.collapsed }"
            />
          </button>

          <!-- Row list of one group: the wrapper is the stable aria-controls
               target for the header disclosure and stays in the DOM when
               collapsed (empty, so no rows render, no focusables live here and
               no vertical gap appears) — rows are withdrawn from the menu
               when collapsed (headers stay; menu rows are only the visible
               ones). -->
          <div
            :id="group.rowsId || undefined"
            class="ti-dropdown-group-rows"
          >
            <template v-if="!group.collapsed">
              <div
                v-for="item in group.items"
                :key="item.id"
                class="ti-dropdown-item"
                :class="{
                  'ti-active': currentProvider === item.id,
                  'is-focused':
                    !isCategoryHeaderHovered &&
                    (pointerIndex === item.index ||
                      (pointerIndex < 0 && focusedIndex === item.index)),
                }"
                @click="selectProvider(item)"
                @mouseenter="handleRowPointerEnter(item)"
              >
                <!-- Semantic selection button: owns the full selectable rectangle
                     (padding lives on it) and keyboard activation. The sibling star
                     stays an independent control; the row is only a click safety
                     net for edge/gap hits. -->
                <button
                  type="button"
                  class="ti-dropdown-item-btn"
                  :aria-current="
                    currentProvider === item.id ? 'true' : undefined
                  "
                  @click.stop="selectProvider(item)"
                  @focus="handleRowFocus(item)"
                >
                  <img
                    :src="getProviderIcon(item.icon)"
                    alt=""
                    :class="{ 'ti-invert-dark': isProviderInverted(item.id) }"
                  />
                  <span>{{ item.name }}</span>
                </button>

                <!-- Set as Default (Star) Icon — never in selection-only pickers,
                     regardless of accidental allowSetDefault/isGlobal props -->
                <button
                  v-if="!selectionOnly && allowSetDefault && !isGlobal"
                  type="button"
                  class="ti-set-default-btn"
                  :class="{ 'is-default': globalDefaultProvider === item.id }"
                  :title="
                    globalDefaultProvider === item.id
                      ? t('is_default_provider_tooltip') || 'Default Service'
                      : t('set_as_default_tooltip') || 'Set as Default Service'
                  "
                  :aria-label="
                    globalDefaultProvider === item.id
                      ? t('is_default_provider_tooltip') || 'Default Service'
                      : t('set_as_default_tooltip') || 'Set as Default Service'
                  "
                  :aria-pressed="
                    globalDefaultProvider === item.id ? 'true' : 'false'
                  "
                  @click.stop="setAsGlobalDefault(item)"
                >
                  <MaskIcon
                    :src="globalDefaultProvider === item.id ? starIcon : starOutlineIcon"
                    :size="14"
                    class="ti-star-icon"
                  />
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- Dropdown footer (ephemeral sync rows + Configure Providers) is a
           synthetic action surface: never rendered for selection-only
           pickers, whatever showSync/accidental props say. -->
      <div
        v-if="!selectionOnly"
        class="ti-provider-dropdown-footer"
      >
        <template v-if="showSync">
          <button
            type="button"
            class="ti-sync-row"
            :class="{
              'is-active': ephemeralSync.page,
              'is-disabled': !canSyncToBulk,
            }"
            :disabled="!canSyncToBulk"
            :aria-pressed="ephemeralSync.page ? 'true' : 'false'"
            :title="syncTooltip('page')"
            @click.stop="canSyncToBulk && toggleSync('page', $event)"
          >
            <div class="ti-sync-info">
              <MaskIcon
                :src="ephemeralSync.page ? linkIcon : linkSlashIcon"
                :size="10"
                class="ti-sync-icon"
              />
              <span>{{ t("sync_page_label") || "Page Translate" }}</span>
            </div>
            <img
              :src="getEffectiveIcon('page')"
              class="ti-sync-provider-icon"
              :class="{
                'ti-invert-dark': isProviderInverted(
                  getEffectiveProviderId('page'),
                ),
              }"
              alt=""
            />
          </button>

          <button
            type="button"
            class="ti-sync-row"
            :class="{
              'is-active': ephemeralSync.element,
              'is-disabled': !canSyncToBulk,
            }"
            :disabled="!canSyncToBulk"
            :aria-pressed="ephemeralSync.element ? 'true' : 'false'"
            :title="syncTooltip('element')"
            @click.stop="canSyncToBulk && toggleSync('element', $event)"
          >
            <div class="ti-sync-info">
              <MaskIcon
                :src="ephemeralSync.element ? linkIcon : linkSlashIcon"
                :size="10"
                class="ti-sync-icon"
              />
              <span>{{ t("sync_element_label") || "Select Element" }}</span>
            </div>
            <img
              :src="getEffectiveIcon('element')"
              class="ti-sync-provider-icon"
              :class="{
                'ti-invert-dark': isProviderInverted(
                  getEffectiveProviderId('element'),
                ),
              }"
              alt=""
            />
          </button>
        </template>

        <button
          type="button"
          class="ti-configure-row"
          :title="configureProvidersLabel"
          :aria-label="configureProvidersLabel"
          @click.stop="openProvidersSettings"
        >
          <div class="ti-sync-info">
            <MaskIcon
              :src="gearIcon"
              :size="10"
              class="ti-sync-icon"
            />
            <span>{{ configureProvidersLabel }}</span>
          </div>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import "./ProviderSelector.scss";
import {
  ref,
  reactive,
  computed,
  watch,
  onMounted,
  onUnmounted,
  nextTick,
  useId,
} from "vue";
import { useSettingsStore } from "@/features/settings/stores/settings.js";
import { useTranslationStore } from "@/features/translation/stores/translation.js";
import { useErrorHandler } from "@/composables/shared/useErrorHandler.js";
import { useUnifiedI18n } from "@/composables/shared/useUnifiedI18n.js";
import { useSelectElementTranslation } from "@/features/translation/composables/useTranslationModes.js";
import {
  getProvidersForDropdown,
  getProviderById,
} from "@/core/provider-registry.js";
import { openOptionsPage } from "@/core/helpers.js";
import { isProviderConfigured } from "@/features/translation/utils/providerValidator.js";
import IconButton from "./IconButton.vue";
import MaskIcon from "@/components/shared/MaskIcon.vue";
import stopIcon from "@/icons/ui/stop.svg?url";
import gearIcon from "@/icons/ui/settings.svg?url";
import chevronIcon from "@/icons/ui/dropdown-arrow.svg?url";
import starIcon from "@/icons/ui/star.svg?url";
import starOutlineIcon from "@/icons/ui/star-outline.svg?url";
import linkIcon from "@/icons/ui/link.svg?url";
import linkSlashIcon from "@/icons/ui/link-slash.svg?url";
import browser from "webextension-polyfill";
import ExtensionContextManager from "@/core/extensionContext.js";
import { getScopedLogger } from "@/shared/logging/logger.js";
import { LOG_COMPONENTS } from "@/shared/logging/logConstants.js";
import { useResourceTracker } from "@/composables/core/useResourceTracker.js";

import { TranslationMode } from "@/shared/config/config.js";

const logger = getScopedLogger(LOG_COMPONENTS.UI, "ProviderSelector");

// Popup Text view menu budget (user-approved 245 CSS px), clamped to the
// viewport with 8px gutters on both sizing and positioning.
const POPUP_MENU_WIDTH = 245;

// Resource tracker for automatic cleanup
const tracker = useResourceTracker("provider-selector");

// Composables
const { t } = useUnifiedI18n();

// Props
const props = defineProps({
  mode: {
    type: String,
    default: "split", // split, button, icon-only, compact, mobile
    validator: (value) =>
      ["split", "button", "icon-only", "compact", "mobile"].includes(value),
  },
  modelValue: {
    type: String,
    default: "",
  },
  selectionOnly: {
    type: Boolean,
    default: false,
  },
  excludeIds: {
    type: Array,
    default: () => [],
  },
  // Opt-in dialog-owned menu (used only with selectionOnly): host passes a
  // selector for the accessible dialog subtree the menu must live in (e.g.
  // '#CUSTOM_PROVIDER_LIST_DRAWER'). Resolved at mount via closest(); a
  // missing or disconnected target fails closed.
  menuTeleportTarget: {
    type: String,
    default: "",
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  dropdownDisabled: {
    type: Boolean,
    default: false,
  },
  isGlobal: {
    type: Boolean,
    default: true,
  },
  showSync: {
    type: Boolean,
    default: false,
  },
  allowDefault: {
    type: Boolean,
    default: false,
  },
  requiredFeature: {
    type: String,
    default: "translation",
  },
  loading: {
    type: Boolean,
    default: false,
  },
  presentation: {
    type: String,
    default: "default",
    validator: (value) => ["default", "compact-label"].includes(value),
  },
  onlyConfigured: {
    type: Boolean,
    default: false,
  },
  ignoreHidden: {
    type: Boolean,
    default: false,
  },
  allowSetDefault: {
    type: Boolean,
    default: false,
  },
  placement: {
    type: String,
    default: "auto", // auto, up, down
    validator: (value) => ["auto", "up", "down"].includes(value),
  },
  translateOnProviderChange: {
    type: Boolean,
    default: true,
  },
});

const translateActionLabel = computed(
  () => t("popup_translate_button_text") || "Translate",
);
const stopActionLabel = computed(() => t("popup_stop_button_title") || "Stop");
const mainActionLabel = computed(() =>
  props.loading ? stopActionLabel.value : translateActionLabel.value,
);
// Accessible name for the split-mode arrow trigger — it otherwise only derives
// the name from the inner image alt attribute.
const dropdownTriggerLabel = computed(
  () => t("switch_provider_label") || "Switch translation service",
);

// Selection-only empty trigger placeholder (localization falls back to the
// same wording used by the Custom List drawer add row).
const selectionPlaceholderLabel = computed(
  () => t("custom_provider_list_add_placeholder") || "Add a provider…",
);

// Stable per-instance prefix for the menu and its category headings
const dropdownUid = `ti-provider-dropdown-${useId()}`;
const menuId = `${dropdownUid}-menu`;

// Emits
const emit = defineEmits([
  "translate",
  "cancel",
  "provider-change",
  "update:modelValue",
]);

// Stores
const settingsStore = useSettingsStore();
const translationStore = useTranslationStore();
const { handleError } = useErrorHandler();
const { isSelectModeActive, deactivateSelectMode } =
  useSelectElementTranslation();

// State
const selectorRef = ref(null);
const triggerBtnRef = ref(null);
const dropdownMenuRef = ref(null);
const dropdownMenuElRef = ref(null);
const isDropdownOpen = ref(false);
const isUpward = ref(false);
const focusedIndex = ref(-1);
const pointerIndex = ref(-1);
const isCategoryHeaderHovered = ref(false);
// Identity of the row that last received REAL focus (recorded at the focus
// event, before any reactive reshaping) — external collapse reconciliation
// re-anchors by this id.
const rowFocusProviderId = ref("");
const dropdownMaxHeight = ref("400px");
const dropdownStyles = ref({});

const teleportTarget = ref("body");
const isTeleportEnabled = ref(false);
// Dialog-owned menu state (selectionOnly + menuTeleportTarget only):
// isDialogMenuContext switches positioning to dialog-absolute; menuTargetFailed
// blocks opening entirely when the explicit dialog target was not found.
const isDialogMenuContext = ref(false);
const menuTargetFailed = ref(false);
let resizeAnimationFrameId = null;
// The one tracked scroll source: Options tab content, or the Custom List
// drawer body for selection-only pickers inside that drawer
let optionsScrollAnimationFrameId = null;

/**
 * Detects RTL direction for correct alignment of teleported dropdowns.
 */
const isRTL = computed(() => {
  try {
    return (
      document.documentElement.dir === "rtl" ||
      document.body.dir === "rtl" ||
      selectorRef.value?.closest(".rtl") !== null
    );
  } catch {
    return false;
  }
});

const isProviderSelectionDisabled = computed(
  () => props.disabled || props.dropdownDisabled,
);

/**
 * Popup Text view detection via its unique `.translation-view` ancestor. The
 * menu teleports to body (or the shadow overlay), where ancestor CSS cannot
 * reach it, hence the explicit menu-root class used with this detection.
 */
const isPopupTextContext = computed(
  () => !!selectorRef.value?.closest?.(".translation-view"),
);

/**
 * Sidepanel split detection: `ti-sidepanel-split-selector` is carried by this
 * component's own split container (wide and narrow Sidepanel layouts; the
 * toolbar icon-only selector does not carry it). Shares the popup viewport
 * budget sizing/positioning branch; the teleported menu gets a dedicated
 * `--sidepanel` marking class so ancestor CSS cannot be relied on.
 */
const isSidepanelSplitContext = computed(
  () =>
    props.mode === "split" &&
    !!selectorRef.value?.classList?.contains("ti-sidepanel-split-selector"),
);

/**
 * Computed property to identify the current global default provider
 */
const globalDefaultProvider = computed(
  () => settingsStore.settings?.TRANSLATION_API,
);

/**
 * Sets a provider as the global default translation service.
 * Used primarily in the Popup to allow making session overrides permanent.
 */
const setAsGlobalDefault = async (provider) => {
  logger.debug("Setting global default provider:", provider.id);
  try {
    // 1. Persist to storage
    await settingsStore.updateSettingAndPersist("TRANSLATION_API", provider.id);

    // 2. Also select it for the current session if it wasn't already
    if (currentProvider.value !== provider.id) {
      await selectProvider(provider);
    }

    // 3. Control activation closes the menu (selection path above already
    //    closed it when the provider changed)
    if (isDropdownOpen.value) closeDropdown(false);

    logger.info(`Provider ${provider.id} set as global default.`);
  } catch (error) {
    logger.error("Failed to set global default provider:", error);
    await handleError(error, "provider-selector-set-default");
  }
};

// Handle keyboard navigation
const handleKeydown = (event) => {
  if (props.disabled) return;

  const { key } = event;
  const items = groupedMenu.value.flatMap((group) => group.items);
  const currentIndex = items.findIndex((p) => p.id === currentProvider.value);

  // If dropdown is closed, Arrow keys change selection directly (Native behavior - No looping)
  if (!isDropdownOpen.value) {
    if (key === "ArrowDown") {
      event.preventDefault();
      if (currentIndex < items.length - 1) {
        selectProvider(items[currentIndex + 1]);
      }
      return;
    }
    if (key === "ArrowUp") {
      event.preventDefault();
      if (currentIndex > 0) {
        selectProvider(items[currentIndex - 1]);
      }
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      // In split mode, Enter triggers translation instead of opening dropdown
      if (props.mode === "split") {
        handleTranslate();
      } else {
        toggleDropdown();
        focusedIndex.value = indexInMenuItems() !== -1 ? indexInMenuItems() : 0;
      }
      return;
    }
    if (key === " ") {
      event.preventDefault();
      toggleDropdown();
      focusedIndex.value = indexInMenuItems() !== -1 ? indexInMenuItems() : 0;
      return;
    }
    return;
  }

  // Dropdown open (focus still on the trigger): mirror the menu keyboard
  // model. All open-menu navigation is driven by focusedIndex state so the
  // outcome is identical whether the browser moved focus into the menu or the
  // trigger still holds focus.
  switch (key) {
    case "ArrowDown":
      event.preventDefault();
      if (!menuItems.value.length) break;
      focusedIndex.value = (focusedIndex.value + 1) % menuItems.value.length;
      moveListFocus();
      break;
    case "ArrowUp":
      event.preventDefault();
      if (!menuItems.value.length) break;
      focusedIndex.value =
        (focusedIndex.value - 1 + menuItems.value.length) %
        menuItems.value.length;
      moveListFocus();
      break;
    case "Enter":
    case " ":
      event.preventDefault();
      if (
        focusedIndex.value >= 0 &&
        focusedIndex.value < menuItems.value.length
      ) {
        selectProvider(menuItems.value[focusedIndex.value]);
      }
      break;
    case "Escape":
      event.preventDefault();
      if (props.selectionOnly) event.stopPropagation();
      closeDropdown(true);
      break;
    // 'Tab': let the browser move focus naturally (item → star → sync →
    // configure); the menu closes via focusout once focus leaves it.
  }
};

/**
 * Records the row that actually received real focus: contiguous focusedIndex
 * plus its stable provider id for the external-collapse reconciliation.
 */
const handleRowFocus = (item) => {
  isCategoryHeaderHovered.value = false;
  pointerIndex.value = -1;
  focusedIndex.value = item.index;
  rowFocusProviderId.value = item.id;
};

const handleRowPointerEnter = (item) => {
  isCategoryHeaderHovered.value = false;
  pointerIndex.value = item.index;
};

const handleMenuPointerLeave = () => {
  isCategoryHeaderHovered.value = false;
  pointerIndex.value = -1;
};

/**
 * A pointer can visit other rows before crossing a category header. Clear that
 * transient row highlight, but keep keyboard navigation anchored to a provider
 * row that still has real focus (root-scoped for ShadowRoot menus).
 */
const handleCategoryPointerEnter = () => {
  isCategoryHeaderHovered.value = true;
  const menuRoot = dropdownMenuElRef.value;
  const focusRoot = menuRoot?.getRootNode?.() ?? document;
  const activeElement = focusRoot.activeElement;
  const focusedRow = activeElement?.closest?.(".ti-dropdown-item-btn");
  if (!menuRoot?.contains(focusedRow)) {
    focusedIndex.value = -1;
    pointerIndex.value = -1;
    return;
  }

  const rows =
    dropdownMenuRef.value?.querySelectorAll(".ti-dropdown-item-btn") ?? [];
  const realFocusIndex = Array.prototype.indexOf.call(rows, focusedRow);
  focusedIndex.value = realFocusIndex;
  pointerIndex.value = -1;
};

const focusedMenuRowIndex = () => {
  const menu = dropdownMenuRef.value;
  const root = menu?.getRootNode?.() ?? document;
  const focusedRow = root.activeElement?.closest?.(".ti-dropdown-item-btn");
  if (!menu?.contains(focusedRow)) return -1;
  const rows = menu.querySelectorAll(".ti-dropdown-item-btn");
  return Array.prototype.indexOf.call(rows, focusedRow);
};

/**
 * Index of the current selection within the visual (group-ordered) menu list
 */
const indexInMenuItems = () =>
  menuItems.value.findIndex((p) => p.id === currentProvider.value);

/**
 * Moves real DOM focus to the provider row at the current focused index.
 * The focus() must run AFTER the open/position flush settles: a rendering
 * pass within the same flush (style patch after positioning, teleport stub
 * re-render in tests) can replace menu nodes and silently drop a same-tick
 * focus(). The current focusedIndex is read at execution time so a queued
 * move never reverts newer state advances.
 */
const moveListFocus = () => {
  nextTick(() => {
    const container = dropdownMenuRef.value;
    if (!container) return;
    const rows = container.querySelectorAll(".ti-dropdown-item");
    rows[focusedIndex.value]?.querySelector(".ti-dropdown-item-btn")?.focus();
  });
  scrollToFocused();
};

/**
 * Delegated keyboard handling for the open dropdown menu.
 * Arrow keys move real focus between provider rows (visual order, groups
 * included); Enter/Space select. The star, sync rows and the Configure action
 * are natural buttons reached by Tab — Tab itself is not intercepted, so
 * focus moves freely between those controls; the menu closes once focus
 * leaves the menu (see handleMenuFocusOut).
 */
const handleMenuKeydown = (event) => {
  const { key } = event;
  // Escape must close/re-focus even with zero visible rows: category headers
  // remain rendered when every group is collapsed, so handle it before the
  // empty-menu early return.
  if (key === "Escape") {
    event.preventDefault();
    if (props.selectionOnly) event.stopPropagation();
    closeDropdown(true);
    return;
  }
  const items = menuItems.value;
  if (!items.length) return;

  if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    const delta = key === "ArrowDown" ? 1 : -1;
    const realFocusIndex = focusedMenuRowIndex();
    const originIndex =
      realFocusIndex >= 0 ? realFocusIndex : focusedIndex.value;
    const next = (originIndex + delta + items.length) % items.length;
    focusedIndex.value = next;
    pointerIndex.value = -1;
    moveListFocus(next);
    return;
  }

  if (key === "Enter" || key === " ") {
    // Only provider selection buttons are activated here; the star, sync and
    // footer controls rely on their native button activation.
    const menu = dropdownMenuRef.value;
    const rowButton = event.target?.closest?.(".ti-dropdown-item-btn");
    if (!rowButton || !menu?.contains(rowButton)) return;
    const rows = menu.querySelectorAll(".ti-dropdown-item-btn");
    const rowIndex = Array.prototype.indexOf.call(rows, rowButton);
    if (rowIndex < 0 || !items[rowIndex]) return;
    event.preventDefault();
    selectProvider(items[rowIndex]);
    return;
  }
};

/**
 * Closes the menu silently when focus moves out of it entirely (e.g. Tab past
 * the Configure row). Moving focus between controls inside the menu keeps it
 * open, as does a blur-to-null caused by the pointer interacting with a
 * non-focusable menu region during an in-menu pointer interaction (tracked by
 * the pointer latch below). Outside clicks should never steal focus, so this
 * close is silent.
 */
const handleMenuFocusOut = (event) => {
  if (!isDropdownOpen.value) return;
  if (dropdownMenuElRef.value?.contains(event.relatedTarget)) return;
  if (menuPointerInside) return;
  closeDropdown(false);
};

/**
 * Pointer latch for the focusout suppression above: latched while a pointer
 * interaction begins inside the menu, cleared by pointerup anywhere or
 * pointercancel, so a canceled/outside pointer can never leave it stuck and
 * keyboard-only focus changes (no latch) still dismiss the menu normally.
 */
let menuPointerInside = false;
const handleMenuPointerTracking = (event) => {
  if (event.type === "pointerdown") {
    menuPointerInside = event.composedPath().includes(dropdownMenuElRef.value);
  } else {
    menuPointerInside = false;
  }
};

const scrollToFocused = () => {
  nextTick(() => {
    const container = dropdownMenuRef.value;
    if (!container) return;
    // Rows live inside optional category groups; query the row list instead
    // of container.children so group headings never corrupt the index.
    const rows = container.querySelectorAll(".ti-dropdown-item");
    const focusedEl = rows[focusedIndex.value];

    if (focusedEl) {
      const containerRect = container.getBoundingClientRect();
      const elementRect = focusedEl.getBoundingClientRect();

      if (elementRect.top < containerRect.top) {
        // Scroll up to show element at top
        container.scrollTo({
          top: container.scrollTop - (containerRect.top - elementRect.top),
          behavior: "smooth",
        });
      } else if (elementRect.bottom > containerRect.bottom) {
        // Scroll down to show element at bottom
        container.scrollTo({
          top:
            container.scrollTop + (elementRect.bottom - containerRect.bottom),
          behavior: "smooth",
        });
      }
    }
  });
};

/**
 * Handle click outside to close dropdown (Shadow DOM compatible)
 */
const handleClickOutside = (event) => {
  // Use composedPath to support Shadow DOM and handle retargeting
  const path = event.composedPath();

  if (!isDropdownOpen.value || !selectorRef.value) return;

  // The click is internal when the trigger container OR the (possibly
  // teleported) menu is in the event path — Teleport on body and in a
  // shadow root both report the menu node in composedPath().
  // Inside-menu clicks must not close during capture: real click flows
  // dismiss through their own handlers (selection, footer actions).
  if (
    !path.includes(selectorRef.value) &&
    !path.includes(dropdownMenuElRef.value)
  ) {
    // Silent close — restoring trigger focus here would steal focus from
    // wherever the user clicked (including clicks inside the menu).
    closeDropdown(false);
  }
};

/**
 * Computed list of providers based on current settings and props
 */
const availableProviders = computed(() => {
  // Use provider registry for consistent provider information
  // Pass current debug mode state to allow/hide mock provider dynamically
  const debugMode = settingsStore.settings?.DEBUG_MODE || false;
  const providersFromRegistry = getProvidersForDropdown(debugMode);
  const hiddenProviders = settingsStore.settings?.HIDDEN_PROVIDERS || [];

  // Filter by required feature if provided
  let filteredRegistry = props.requiredFeature
    ? providersFromRegistry.filter((p) =>
        p.features?.includes(props.requiredFeature),
      )
    : providersFromRegistry;

  // Filter out hidden providers (but always show currently selected even if hidden)
  if (!props.ignoreHidden) {
    filteredRegistry = filteredRegistry.filter((p) => {
      return (
        !hiddenProviders.includes(p.id) ||
        (!props.selectionOnly && currentProvider.value === p.id)
      );
    });
  }

  // Filter by configuration status if requested
  if (props.onlyConfigured) {
    filteredRegistry = filteredRegistry.filter((p) =>
      isProviderConfigured(p.id, settingsStore.settings),
    );
  }

  if (props.excludeIds.length) {
    filteredRegistry = filteredRegistry.filter(
      (provider) => !props.excludeIds.includes(provider.id),
    );
  }

  const mappedProviders = filteredRegistry.map((provider) => ({
    id: provider.id,
    name: provider.name,
    icon: provider.icon,
    category: provider.category || "",
  }));

  if (props.allowDefault && !props.selectionOnly) {
    const defaultProviderId =
      settingsStore.settings?.TRANSLATION_API || "googlev2";
    const defaultProvider = getProviderById(defaultProviderId);

    // Default provider logic:
    // 1. If no specific feature is required, always show Default.
    // 2. If a feature is required, only show Default if the global provider supports it.
    // 3. If onlyConfigured is true, only show Default if global provider is configured.
    // 4. SPECIAL CASE: If the current selection IS 'default', we MUST show it
    //    to prevent the UI from displaying wrong names/icons.

    const defaultSupportsFeature =
      !props.requiredFeature ||
      (defaultProvider &&
        defaultProvider.features?.includes(props.requiredFeature));

    const isDefaultConfigured =
      !props.onlyConfigured ||
      isProviderConfigured(defaultProviderId, settingsStore.settings);

    const isCurrentlyDefault = currentProvider.value === "default";

    // We show "Default" if:
    // 1. allowDefault is true (outer if) AND
    // 2. It's either configured, currently selected, or we just want to allow selecting it (always true if allowDefault is true)
    if (isDefaultConfigured || isCurrentlyDefault || props.allowDefault) {
      const baseName = t("provider_default") || "Default";
      const displayName = !defaultSupportsFeature
        ? `${baseName} (${t("incompatible_label") || "Incompatible"})`
        : baseName;

      return [
        {
          id: "default",
          name: displayName,
          icon: defaultProvider?.icon || "providers/google.svg",
        },
        ...mappedProviders,
      ];
    }
  }

  return mappedProviders;
});

// ─── Conditional Category Grouping (Traditional / AI / Other) ──────────────
// Grouping is view-only on top of availableProviders (filters + synthetic
// Default stay untouched). Rules:
// - Only group when >= 6 visible real providers span >= 2 categories; keep the
//   list flat otherwise.
// - The synthetic "Default" entry leads the menu and is never classified/
//   bucketed (no category, no cost implication).
// - FREE category means Traditional translation services, not free-of-cost.
// - Category buckets keep stable manifest order inside them, so Vajehyab
//   trails the other LOCAL providers in the Other bucket.
const CATEGORY_LABEL_KEYS = {
  free: "provider_category_free",
  ai: "provider_category_ai",
  local: "provider_category_local",
};
const CUSTOM_CATEGORY_KEY = "custom-list";

const groupedMenu = computed(() => {
  const all = availableProviders.value;
  if (props.selectionOnly) {
    return [
      {
        key: "selection-only",
        header: "",
        headerId: "",
        items: all.map((provider, index) => ({ ...provider, index })),
      },
    ];
  }
  const hasDefault =
    props.allowDefault && all.length > 0 && all[0].id === "default";
  const fullReal = hasDefault ? all.slice(1) : all;

  const settings = settingsStore.settings;
  const customListEnabled = settings?.CUSTOM_PROVIDER_LIST_ENABLED === true;
  const configuredIds = Array.isArray(settings?.CUSTOM_PROVIDER_LIST)
    ? settings.CUSTOM_PROVIDER_LIST
    : [];
  const eligibleIds = new Set(fullReal.map((provider) => provider.id));
  const customIds = customListEnabled
    ? [...new Set(configuredIds)].filter(
        (id) => id !== "default" && eligibleIds.has(id),
      )
    : [];
  const customIdSet = new Set(customIds);
  const custom = customIds.map((id) =>
    fullReal.find((provider) => provider.id === id),
  );
  const real = customIds.length
    ? fullReal.filter((provider) => !customIdSet.has(provider.id))
    : fullReal;

  const normalized = real.map((provider) => ({
    ...provider,
    categoryKey: String(provider.category || "")
      .trim()
      .toLowerCase(),
  }));
  const categorySet = new Set(
    fullReal
      .map((provider) =>
        String(provider.category || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  const useGroups = fullReal.length >= 6 && categorySet.size >= 2;

  if (!useGroups) {
    if (customIds.length) {
      const entries = [];
      if (hasDefault)
        entries.push({ key: "default", header: "", items: [all[0]] });
      entries.push({
        key: CUSTOM_CATEGORY_KEY,
        header: t("provider_category_custom") || "Custom List",
        items: custom,
      });
      if (real.length)
        entries.push({ key: "remaining", header: "", items: real });
      let cursor = 0;
      return entries.map((entry, groupIndex) => ({
        key: `${entry.key}-${groupIndex}`,
        categoryId: entry.key,
        header: entry.header,
        headerId: entry.header ? `${dropdownUid}-group-${groupIndex}` : "",
        items: entry.items.map((provider) => ({
          ...provider,
          index: cursor++,
        })),
      }));
    }
    const items = all.map((provider, index) => ({ ...provider, index }));
    return [{ key: "flat", header: "", headerId: "", categoryId: "", items }];
  }

  const order = ["free", "ai", "local"];
  for (const categoryKey of categorySet) {
    if (!order.includes(categoryKey)) order.push(categoryKey);
  }

  const buckets = new Map();
  const uncategorized = [];
  for (const provider of normalized) {
    if (!provider.categoryKey) {
      uncategorized.push(provider);
      continue;
    }
    if (!buckets.has(provider.categoryKey))
      buckets.set(provider.categoryKey, []);
    buckets.get(provider.categoryKey).push(provider);
  }

  const entries = [];
  if (hasDefault) {
    entries.push({ key: "default", header: "", items: [all[0]] });
  }
  if (customIds.length) {
    entries.push({
      key: CUSTOM_CATEGORY_KEY,
      header: t("provider_category_custom") || "Custom List",
      items: custom,
    });
  }
  for (const categoryKey of order) {
    const items = buckets.get(categoryKey);
    if (!items?.length) continue;
    const labelKey = CATEGORY_LABEL_KEYS[categoryKey];
    entries.push({
      key: categoryKey,
      header: labelKey ? t(labelKey) || "" : "",
      items,
    });
  }
  if (uncategorized.length) {
    entries.push({ key: "uncategorized", header: "", items: uncategorized });
  }

  let cursor = 0;
  return entries.map((entry, groupIndex) => ({
    key: `${entry.key}-${groupIndex}`,
    categoryId: entry.key,
    header: entry.header,
    headerId: entry.header ? `${dropdownUid}-group-${groupIndex}` : "",
    items: entry.items.map((provider) => ({ ...provider, index: cursor++ })),
  }));
});

/**
 * Downstream collapsible application: groups with a category header become
 * disclosure groups whose rows are withdrawn from the visible menu when the
 * persisted collapsed-category store marks them. Grouping/filtering/
 * eligibility (groupedMenu) is untouched; this only shapes what is rendered
 * and navigable. Default/Sync/Configure/headerless groups stay expanded.
 */
const visibleGroups = computed(() => {
  const all = groupedMenu.value;
  if (props.selectionOnly) return all;
  // Rendered rows are re-indexed contiguously over the visible order so
  // focusedIndex/menuItems stay aligned when a group is withdrawn. Collapsed
  // groups still carry their full items (count powers index-shift math) but
  // are not rendered.
  let nextIndex = 0;
  return all.map((group) => {
    const collapsed = Boolean(
      group.header &&
      group.categoryId &&
      viewCategoryCollapsed(group.categoryId),
    );
    const startIndex = nextIndex;
    const items = collapsed
      ? group.items
      : group.items.map((provider) => ({ ...provider, index: nextIndex++ }));
    return {
      ...group,
      collapsed,
      items,
      rowsId: group.headerId ? `${group.headerId}-items` : "",
      startIndex,
    };
  });
});

/**
 * Stable category IDs persisted by the storage lane. Canonical shape is a
 * versioned { ids, revision } payload; a plain ID array from the handoff
 * window is accepted defensively too.
 */
const normalizeCollapsedCategoryIds = (value) => {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.ids)) return value.ids;
  return [];
};

const collapsedCategoryIds = computed(
  () =>
    new Set(
      normalizeCollapsedCategoryIds(
        settingsStore.settings?.COLLAPSED_PROVIDER_CATEGORIES,
      ),
    ),
);

const isCategoryCollapsed = (categoryId) =>
  collapsedCategoryIds.value.has(categoryId);

// Pending per-category collapse intent, applied to the view immediately on
// click. The store action does NOT update state synchronously — state arrives
// reactively with the authoritative storage event / promise result, so the
// intent bridges the gap and is cleared by the reconciliation watch below
// once the authoritative state agrees (or on rejection, where the display
// reverts to the store and the failure surfaces through handleError).
const collapseOverrides = reactive(new Map());
// Per-category token for the in-flight persistence request: only the latest
// request's outcome (or an external authoritative event after completion) may
// reconcile the display, so superseded rapid toggles can never flap the view.
const collapseTokens = new Map();
let collapseTokenSeed = 0;

/**
 * External authoritative collapse changes while the open menu reshapes
 * visible rows: re-anchor real focus by provider identity, never by stale
 * index. Snapshot conditions — real focus must sit on a provider row inside
 * this menu (never on a disclosure header, footer action, the trigger or an
 * outside control). After the DOM flush: a still-visible provider keeps real
 * focus (node persists or is re-focused) and just gets a fresh contiguous
 * focusedIndex; a withdrawn one hands focus to its category's disclosure
 * button. Categories owned by our own in-flight requests are left to the
 * local toggle path, which already moves focus; the watch skip below keeps
 * rapid-toggle handling untouched.
 */
const reconcileFocusToVisibleRows = () => {
  // Root-aware active element: inside a (open) ShadowRoot document.activeElement
  // is the shadow HOST, while the menu's getRootNode().activeElement is the
  // focused descendant. The root is captured once for the snapshot and the
  // same root is re-read after the DOM flush; Document roots behave exactly
  // like plain document.activeElement.
  const menuRoot = dropdownMenuElRef.value;
  if (!menuRoot?.isConnected) return;
  const focusRoot = menuRoot.getRootNode?.() ?? document;

  const focusedRow = focusRoot.activeElement?.closest?.(
    ".ti-dropdown-item-btn",
  );
  if (!focusedRow || !menuRoot.contains(focusedRow)) return;

  const providerId = rowFocusProviderId.value;
  if (!providerId) return;
  nextTick(() => {
    if (!isDropdownOpen.value) return;
    // Post-flush no-steal guard: focus may have moved since the snapshot.
    // Reconcile only when
    //  (a) the captured row still holds real focus (root-scoped), or
    //  (b) the captured row was withdrawn by the collapse render and focus
    //      fell to browser neutral as that removal's side effect.
    // Neutral at document level is null/body; for a ShadowRoot it is also the
    // null shadow-root activeElement while document-level focus merely sits on
    // the host. A deliberately focused outside control (anything else) is
    // never re-targeted — footer, another disclosure, the trigger, or outside.
    const rootActive = focusRoot.activeElement ?? null;
    const docActive = document.activeElement;
    const rowStillFocused = rootActive === focusedRow;
    const rowRemoved = !focusedRow.isConnected;
    // Neutral = the focused row's tree-level focus was dropped without a
    // deliberate redirect. Document root: null or body exactly as before.
    // ShadowRoot: its own activeElement is null while document-level focus
    // only sits on the host (or is otherwise gone). A deliberately focused
    // outside control (anything else) is never re-targeted — footer, another
    // disclosure, the trigger, or outside.
    const focusNeutral =
      focusRoot === document
        ? rootActive === null || rootActive === document.body
        : rootActive === null &&
          (!docActive ||
            docActive === document.body ||
            docActive === focusRoot.host);
    if (!rowStillFocused && !(rowRemoved && focusNeutral)) return;
    const newIndex = menuItems.value.findIndex(
      (item) => item.id === providerId,
    );
    if (newIndex >= 0) {
      focusedIndex.value = newIndex;
      const rowButton = dropdownMenuRef.value?.querySelectorAll(
        ".ti-dropdown-item-btn",
      )[newIndex];
      if (rowButton && rootActive !== rowButton) {
        rowButton.focus();
        scrollToFocused();
      }
      return;
    }
    const owningGroup = visibleGroups.value.find(
      (group) =>
        group.headerId && group.items.some((item) => item.id === providerId),
    );
    if (!owningGroup) return;
    focusedIndex.value = -1;
    dropdownMenuRef.value?.querySelector(`#${owningGroup.headerId}`)?.focus();
  });
};

watch(collapsedCategoryIds, (authoritativeIds, previousIds) => {
  for (const [categoryId, intent] of [...collapseOverrides]) {
    if (collapseTokens.has(categoryId)) continue;
    if (authoritativeIds.has(categoryId) === intent)
      collapseOverrides.delete(categoryId);
  }

  // Focus reconciliation only for changes no local request owns: every
  // changed category with a pending token is ours and the local toggle path
  // already moved focus; mixed events still reconcile for the external part.
  const previousSet = previousIds ?? new Set();
  let externalChange = false;
  authoritativeIds.forEach((id) => {
    if (!previousSet.has(id) && !collapseTokens.has(id)) externalChange = true;
  });
  previousSet.forEach((id) => {
    if (!authoritativeIds.has(id) && !collapseTokens.has(id))
      externalChange = true;
  });
  if (externalChange) reconcileFocusToVisibleRows();
});

const viewCategoryCollapsed = (categoryId) =>
  collapseOverrides.has(categoryId)
    ? collapseOverrides.get(categoryId)
    : isCategoryCollapsed(categoryId);

/**
 * Toggles one collapsible category's persisted collapse state. The view flips
 * immediately (pending intent), so rapid toggles of the same header before an
 * earlier persistence resolves always carry a fresh, opposite intent.
 * Persistence failures delete that category's intent (display reverts to the
 * authoritative store state) and surface through handleError — never
 * swallowed. Real focus and focusedIndex are reconciled with the reshaped
 * visible row list (see below).
 */
const toggleCategoryCollapse = async (group) => {
  const categoryId = group.categoryId;
  const collapsing = !viewCategoryCollapsed(categoryId);
  const start = group.startIndex;
  const length = group.items.length;

  // If real focus sits on a row this toggle withdraws, move it to the group's
  // header button after the collapse render settles (same post-flush focus
  // discipline as moveListFocus — the flush can replace menu nodes); rows in
  // earlier groups keep their indices, rows in later ones keep real focus (DOM
  // nodes persist) and only their focusedIndex shifts.
  if (
    collapsing &&
    focusedIndex.value >= start &&
    focusedIndex.value < start + length
  ) {
    focusedIndex.value = -1;
    nextTick(() => {
      dropdownMenuRef.value?.querySelector(`#${group.headerId}`)?.focus();
    });
  } else if (collapsing && focusedIndex.value >= start + length) {
    focusedIndex.value -= length;
  } else if (!collapsing && focusedIndex.value >= start) {
    focusedIndex.value += length;
  }

  const token = ++collapseTokenSeed;
  collapseTokens.set(categoryId, token);
  collapseOverrides.set(categoryId, collapsing);

  if (typeof settingsStore.setProviderCategoryCollapsed !== "function") {
    // Handoff window without the store action: nothing authoritative can land,
    // so reverse the local intent to keep the display reconciled.
    collapseTokens.delete(categoryId);
    collapseOverrides.delete(categoryId);
    logger.debug(
      "setProviderCategoryCollapsed unavailable; collapse not persisted",
    );
    return;
  }
  try {
    await settingsStore.setProviderCategoryCollapsed(categoryId, collapsing);
  } catch (error) {
    // Only the request whose decision is still current unwinds its intent; a
    // superseded request's failure never reverts the newest toggle's view.
    if (collapseTokens.get(categoryId) === token) {
      collapseTokens.delete(categoryId);
      if (collapseOverrides.get(categoryId) === collapsing) {
        collapseOverrides.delete(categoryId);
      }
    }
    logger.error(
      "Failed to persist category collapse state:",
      categoryId,
      error,
    );
    await handleError(error, "provider-selector-toggle-collapse");
    return;
  }
  // This request is still the category's latest: its authoritative state will
  // agree with the intent, so reconcile the display to the store now.
  if (collapseTokens.get(categoryId) === token) {
    collapseTokens.delete(categoryId);
    collapseOverrides.delete(categoryId);
  }
};

const menuItems = computed(() =>
  visibleGroups.value.flatMap((group) => (group.collapsed ? [] : group.items)),
);

/**
 * Opens the Providers tab of the options page (background resolves the anchor).
 */
const configureProvidersLabel = computed(
  () => t("configure_providers") || "Configure Providers",
);
const openProvidersSettings = () => {
  // Control activation closes the menu (silent — focus must stay with the
  // activating control while the options page opens).
  if (isDropdownOpen.value) closeDropdown(false);
  openOptionsPage("providers");
};

// Ephemeral Sync State from store
const ephemeralSync = computed(() => translationStore.ephemeralSync);

/**
 * Currently selected provider ID
 */
const currentProvider = computed(() => {
  if (props.modelValue) return props.modelValue;
  if (props.selectionOnly) return "";
  return settingsStore.settings.TRANSLATION_API;
});

/**
 * Checks if the 'Default' selection is actually valid for this mode's requirements
 */
const isDefaultInvalid = computed(() => {
  if (currentProvider.value !== "default" && props.modelValue !== "default")
    return false;

  const globalId = settingsStore.settings?.TRANSLATION_API || "googlev2";
  const globalProvider = getProviderById(globalId);

  return (
    props.requiredFeature &&
    globalProvider &&
    !globalProvider.features?.includes(props.requiredFeature)
  );
});

const currentProviderIcon = computed(() => {
  const provider = availableProviders.value.find(
    (p) => p.id === currentProvider.value,
  );
  return getProviderIcon(provider?.icon || "providers/google.svg");
});

const currentProviderName = computed(() => {
  // Empty selection-only model: show nothing (no synthetic name, no
  // unknown-provider warn) until the user picks a provider.
  if (props.selectionOnly && !currentProvider.value) return "";
  if (currentProvider.value === "default") {
    const baseName = t("provider_default") || "Default";
    return isDefaultInvalid.value
      ? `${baseName} (${t("incompatible_label") || "Incompatible"})`
      : baseName;
  }
  const provider = availableProviders.value.find(
    (p) => p.id === currentProvider.value,
  );

  if (!provider) {
    logger.warn(
      "[ProviderSelector] Unknown provider ID:",
      currentProvider.value,
    );
    return currentProvider.value || "Unknown";
  }

  return provider.name;
});

/**
 * Checks if the currently selected provider supports bulk operations (required for Page/Element sync)
 */
const canSyncToBulk = computed(() => {
  let providerId = currentProvider.value;

  // Resolve 'default' to actual provider
  if (providerId === "default") {
    providerId = settingsStore.settings?.TRANSLATION_API || "googlev2";
  }

  const provider = getProviderById(providerId);
  return provider?.features?.includes("bulk") || false;
});

/**
 * Helper to determine if a provider icon should be inverted in dark mode
 */
const isProviderInverted = (providerId) => {
  let effectiveId = providerId;

  // If it's 'default', resolve to the actual global provider ID
  if (providerId === "default") {
    effectiveId = settingsStore.settings?.TRANSLATION_API || "googlev2";
  }

  const blackIcons = ["deepl", "openai", "openrouter", "requesty", "cheaperinference", "webai"];
  return blackIcons.includes(effectiveId);
};

/**
 * Helper to get effective provider ID for sync icons
 */
const getEffectiveProviderId = (type) => {
  const isSynced = ephemeralSync.value[type];
  if (isSynced) return currentProvider.value;

  if (type === "page") {
    return (
      settingsStore.settings?.MODE_PROVIDERS?.[TranslationMode.Page] ||
      settingsStore.settings.TRANSLATION_API
    );
  }
  return (
    settingsStore.settings?.MODE_PROVIDERS?.[TranslationMode.Select_Element] ||
    settingsStore.settings.TRANSLATION_API
  );
};

/**
 * Resolves a provider icon URL safely
 */
const getProviderIcon = (iconPath) => {
  try {
    const fallback = "icons/providers/google.svg";

    if (!iconPath) return ExtensionContextManager.safeGetURL(fallback);

    let path = iconPath;
    if (iconPath.startsWith("@/assets/")) {
      path = iconPath.replace("@/assets/", "icons/");
    } else if (!iconPath.includes("/")) {
      path = `icons/providers/${iconPath}`;
    } else if (!iconPath.startsWith("icons/")) {
      path = `icons/${iconPath}`;
    }

    return ExtensionContextManager.safeGetURL(path, fallback);
  } catch (error) {
    if (ExtensionContextManager.isContextError(error)) {
      ExtensionContextManager.handleContextError(
        error,
        "ProviderSelector:getProviderIcon",
      );
    } else {
      logger.error("[getProviderIcon] Failed to resolve icon URL:", error);
    }
    return ExtensionContextManager.GENERIC_FALLBACK_ICON;
  }
};

/**
 * Resolves the icon for sync rows
 */
const getEffectiveIcon = (type) => {
  const isSynced = ephemeralSync.value[type];
  let providerId;

  if (isSynced) {
    // Show UI provider if synced
    providerId = currentProvider.value;
  } else {
    // Show default from settings
    if (type === "page") {
      const pageKey = TranslationMode.Page;
      providerId =
        settingsStore.settings?.MODE_PROVIDERS?.[pageKey] ||
        settingsStore.settings.TRANSLATION_API;
    } else {
      const elementKey = TranslationMode.Select_Element;
      providerId =
        settingsStore.settings?.MODE_PROVIDERS?.[elementKey] ||
        settingsStore.settings.TRANSLATION_API;
    }
  }

  const provider = getProviderById(providerId);
  return getProviderIcon(provider?.icon || "providers/google.svg");
};

/**
 * Tooltip explaining what reflects the CURRENT sync state: while enabled the
 * feature follows the provider selected here; while disabled it uses the
 * feature's configured provider or its normal fallback. Never claims that the
 * click itself translates.
 */
const SYNC_STATE_TOOLTIPS = {
  page: {
    selected: [
      "sync_page_selected_tooltip",
      "Page translation follows the provider selected here",
    ],
    own: [
      "sync_page_own_tooltip",
      "Page translation uses its configured provider, or falls back to the current or default provider.",
    ],
  },
  element: {
    selected: [
      "sync_element_selected_tooltip",
      "Select Element translation follows the provider selected here",
    ],
    own: [
      "sync_element_own_tooltip",
      "Select Element translation uses its configured provider, or falls back to the current or default provider.",
    ],
  },
};
const syncTooltip = (type) => {
  if (!canSyncToBulk.value) {
    return (
      t("provider_does_not_support_bulk") ||
      "This provider does not support page/element translation"
    );
  }
  const entry =
    SYNC_STATE_TOOLTIPS[type][ephemeralSync.value[type] ? "selected" : "own"];
  return t(entry[0]) || entry[1];
};

/**
 * Toggles provider synchronization for specific modes
 */
const toggleSync = (type, event) => {
  translationStore.ephemeralSync[type] = !translationStore.ephemeralSync[type];

  // Also update translationStore.selectedProvider to match current UI selection
  // This ensures UnifiedTranslationService knows WHICH provider to use when synced
  translationStore.selectedProvider = currentProvider.value;

  // No dismissal here: the menu stays open so a sync toggle can be followed by
  // further provider decisions. Focus stays on the toggled button — affirmed
  // explicitly so it holds across activation paths (browsers focus clicked
  // buttons natively; keyboard activation is already focused).
  event?.currentTarget?.focus?.();

  logger.debug(
    `[ProviderSelector] Toggled sync for ${type}:`,
    translationStore.ephemeralSync[type],
  );
};

/**
 * Handles the main translation button click (split mode)
 */
const handleTranslate = () => {
  logger.debug("Translate/Stop button clicked!", {
    currentProvider: currentProvider.value,
    loading: props.loading,
    mode: props.mode,
  });

  if (props.loading) {
    emit("cancel");
  } else {
    emit("translate", { provider: currentProvider.value });
  }
};

/**
 * Toggles the provider selection dropdown
 */
const toggleDropdown = () => {
  // Explicit dialog target not found: fail closed — no menu at body, no
  // inline fallback (which would be clipped and misleading).
  if (isProviderSelectionDisabled.value || menuTargetFailed.value) return;

  // Deactivate select element mode if it's active when user interacts with this control
  if (isSelectModeActive.value && !props.selectionOnly) {
    deactivateSelectMode();
  }

  const newState = !isDropdownOpen.value;

  // Sync focusedIndex with current selection when opening (visual menu order)
  if (newState) {
    focusedIndex.value = indexInMenuItems() !== -1 ? indexInMenuItems() : 0;
  }

  logger.debug("Provider selector dropdown toggled!", {
    currentState: isDropdownOpen.value,
    newState: newState,
    direction: isUpward.value ? "up" : "down",
  });

  isDropdownOpen.value = newState;
  if (newState) {
    nextTick(() => {
      if (!updateDropdownPosition()) {
        closeDropdown();
        return;
      }
      if (menuItems.value.length) {
        // Move real focus into the menu so keyboard interaction is immediate
        moveListFocus();
      } else {
        // Zero visible rows (every collapsible category collapsed, no
        // synthetic Default): seed focus on the first disclosure button so the
        // opening keyboard path is operational — Enter/Space natively expand;
        // Default keeps row priority whenever it renders.
        focusedIndex.value = -1;
        dropdownMenuRef.value
          ?.querySelector(".ti-dropdown-group-header")
          ?.focus();
      }
      scrollToFocused();
    });
  }
};

const updateDropdownPosition = () => {
  const selector = selectorRef.value;
  const trigger = triggerBtnRef.value;

  if (!selector?.isConnected || !trigger?.isConnected) return false;

  // Dialog-owned menu: a disconnected explicit target closes the menu (never
  // re-positions it against a stale rect or lets it leak to body/viewport).
  const isDialogMenu = isDialogMenuContext.value && isTeleportEnabled.value;
  const dialogRect =
    isDialogMenu && teleportTarget.value?.isConnected
      ? teleportTarget.value.getBoundingClientRect()
      : null;
  if (isDialogMenu && !dialogRect) return false;

  const rect = selector.getBoundingClientRect();
  const dimensions = [rect.width, rect.height];

  if (
    dimensions.some(
      (dimension) => !Number.isFinite(dimension) || dimension <= 0,
    )
  )
    return false;

  const isFloatingWindow = selector.closest(".ti-window");
  const mobileContainer = selector.closest(".ti-m-sheet-content");
  const sidepanelContainer = selector.closest(".ti-sidepanel-container");
  const tabContainer = selector.closest(".tab-content-container");
  const windowBody = selector.closest(".ti-window-body");
  const container =
    mobileContainer || sidepanelContainer || tabContainer || windowBody;
  const isTeleport = isTeleportEnabled.value;
  const useViewport = isTeleport || !container || isFloatingWindow;
  const containerRect = useViewport
    ? { top: 0, bottom: window.innerHeight }
    : container.getBoundingClientRect();
  const spaceBelow = containerRect.bottom - rect.bottom;
  const spaceAbove = rect.top - containerRect.top;
  const isOptionsPage = window.location.href.includes("options.html");

  if (props.placement !== "auto") {
    isUpward.value = props.placement === "up";
  } else if (props.mode === "mobile") {
    isUpward.value = spaceBelow < 220 && spaceAbove > spaceBelow;
  } else if (isOptionsPage || !props.isGlobal || isFloatingWindow) {
    const flipThreshold = isFloatingWindow ? 180 : 250;
    isUpward.value = spaceBelow < flipThreshold && spaceAbove > spaceBelow;
  } else {
    isUpward.value = spaceBelow < 100 && spaceAbove > spaceBelow;
  }

  const availableHeight = isUpward.value ? spaceAbove - 20 : spaceBelow - 20;
  const maxLimit = isFloatingWindow
    ? 650
    : props.mode === "mobile"
      ? 350
      : props.isGlobal
        ? 400
        : 550;
  dropdownMaxHeight.value = `${Math.max(0, Math.min(maxLimit, availableHeight))}px`;

  if (isTeleport) {
    const styles = {
      // Dialog-owned menus position absolute against the dialog itself: the
      // drawer's slide transforms turn viewport-fixed into a transformed
      // containing block, so fixed would anchor to the wrong element.
      position: dialogRect ? "absolute !important" : "fixed !important",
      zIndex: "2147483647 !important",
      maxHeight: `${dropdownMaxHeight.value} !important`,
    };

    if (isUpward.value) {
      styles.bottom = dialogRect
        ? `${dialogRect.height - (rect.top - dialogRect.top) + 4}px !important`
        : `${window.innerHeight - rect.top + 4}px !important`;
      styles.top = "auto !important";
    } else {
      styles.top = dialogRect
        ? `${rect.bottom - dialogRect.top + 4}px !important`
        : `${rect.bottom + 4}px !important`;
      styles.bottom = "auto !important";
    }

    if (props.mode === "icon-only") {
      styles.insetInlineStart = `${rect.right + 10}px !important`;
      styles.top = `${rect.top}px !important`;
      styles.bottom = "auto !important";
    } else if (isPopupTextContext.value || isSidepanelSplitContext.value) {
      // Popup Text view and Sidepanel split: fixed budget width (user-approved
      // ~245px), clamped to the viewport with 8px gutters; left/right anchored
      // to the trigger edge and clamped again so the bounded width never
      // leaves the viewport (LTR and RTL).
      const popupWidth = Math.min(POPUP_MENU_WIDTH, window.innerWidth - 16);
      styles.width = `${popupWidth}px !important`;
      styles.minWidth = "0 !important";
      const maxOffset = Math.max(8, window.innerWidth - 16 - popupWidth);
      if (isRTL.value) {
        const desiredRight = window.innerWidth - rect.right;
        styles.right = `${Math.max(8, Math.min(desiredRight, maxOffset))}px !important`;
        styles.left = "auto !important";
      } else {
        styles.left = `${Math.max(8, Math.min(rect.left, maxOffset))}px !important`;
        styles.right = "auto !important";
      }
    } else if (dialogRect) {
      // Dialog-owned selection-only menu: horizontal insets subtract the
      // dialog rect (absolute positioning needs dialog coordinates, not
      // viewport ones); width follows the trigger with the same 220px
      // readability floor, clamped to the dialog with 8px gutters, anchored
      // to the trigger start edge in both LTR and RTL.
      const menuWidth = Math.min(
        Math.max(rect.width, 220),
        dialogRect.width - 16,
      );
      styles.width = `${menuWidth}px !important`;
      styles.minWidth = "0 !important";
      const maxOffset = Math.max(8, dialogRect.width - 16 - menuWidth);
      if (isRTL.value) {
        const desiredRight = dialogRect.right - rect.right;
        styles.right = `${Math.max(8, Math.min(desiredRight, maxOffset))}px !important`;
        styles.left = "auto !important";
      } else {
        styles.left = `${Math.max(8, Math.min(rect.left - dialogRect.left, maxOffset))}px !important`;
        styles.right = "auto !important";
      }
    } else if (props.selectionOnly) {
      // Selection-only picker (drawer/modal trigger): menu width follows the
      // button trigger with the same 220px readability floor as button mode,
      // clamped to the viewport with 8px gutters on narrow windows; anchored
      // to the trigger start edge in both LTR and RTL. Popup Text and
      // Sidepanel keep their own fixed-budget sizing (branch above).
      const menuWidth = Math.min(
        Math.max(rect.width, 220),
        window.innerWidth - 16,
      );
      styles.width = `${menuWidth}px !important`;
      styles.minWidth = "0 !important";
      const maxOffset = Math.max(8, window.innerWidth - 16 - menuWidth);
      if (isRTL.value) {
        styles.right = `${Math.max(8, Math.min(window.innerWidth - rect.right, maxOffset))}px !important`;
        styles.left = "auto !important";
      } else {
        styles.left = `${Math.max(8, Math.min(rect.left, maxOffset))}px !important`;
        styles.right = "auto !important";
      }
    } else {
      if (props.mode === "button" || props.mode === "mobile") {
        styles.width = `${rect.width}px !important`;
        styles.minWidth = "220px !important";
      }

      const expectedWidth = Math.max(rect.width, 220);

      if (isRTL.value) {
        const rightDist = window.innerWidth - rect.right;
        if (rightDist + expectedWidth > window.innerWidth) {
          styles.left = `${rect.left}px !important`;
          styles.right = "auto !important";
        } else {
          styles.right = `${rightDist}px !important`;
          styles.left = "auto !important";
        }
      } else if (rect.left + expectedWidth > window.innerWidth) {
        styles.right = `${window.innerWidth - rect.right}px !important`;
        styles.left = "auto !important";
      } else {
        styles.left = `${rect.left}px !important`;
        styles.right = "auto !important";
      }
    }

    dropdownStyles.value = styles;
  }

  return true;
};

/**
 * Closes the dropdown. `restoreFocus` puts focus back on the trigger (Escape,
 * provider selection). Other closes (outside clicks, scroll, resize, focus
 * leaving the menu) must be silent so they do not steal focus.
 */
const closeDropdown = (restoreFocus = true) => {
  isDropdownOpen.value = false;
  if (!restoreFocus) return;
  // Return focus to trigger button to prevent focus jumping to tab/top of page
  nextTick(() => {
    triggerBtnRef.value?.focus();
  });
};

/**
 * Selects a new provider and emits changes
 */
const selectProvider = async (provider) => {
  logger.debug("Provider selected!", {
    providerId: provider.id,
    providerName: provider.name || "Unknown",
    mode: props.mode,
    isGlobal: props.isGlobal,
  });

  try {
    // Always update the store's active provider so other components (and sync logic) use the latest selection
    if (!props.selectionOnly) translationStore.selectedProvider = provider.id;

    if (props.isGlobal && !props.selectionOnly) {
      await settingsStore.updateSettingAndPersist(
        "TRANSLATION_API",
        provider.id,
      );
      logger.debug("Global provider updated successfully:", provider.id);
    } else {
      logger.debug("Local provider selected:", provider.id);
    }

    emit("update:modelValue", provider.id);
    emit("provider-change", provider.id);
    closeDropdown(true);

    // Auto-trigger translation in split mode after selecting a provider
    if (
      !props.selectionOnly &&
      props.mode === "split" &&
      !props.disabled &&
      props.translateOnProviderChange
    ) {
      emit("translate", { provider: provider.id });
    }
  } catch (error) {
    logger.error("Failed to update provider:", error);
    await handleError(error, "provider-selector-change");
  }
};

/**
 * Handles change for compact select mode
 */
const handleProviderChange = (event) => {
  logger.debug("Provider change event triggered:", event.target.value);
  selectProvider({ id: event.target.value });
};

/**
 * Storage change handler for cross-context updates
 */
const handleStorageChange = (changes, areaName) => {
  if (areaName === "sync" || areaName === "local") {
    if (changes.TRANSLATION_API) {
      // Force update the store to reflect storage changes
      settingsStore.updateSettingLocally(
        "TRANSLATION_API",
        changes.TRANSLATION_API.newValue,
      );
    }
  }
};

// Initialize providers
onMounted(() => {
  // Determine teleport target dynamically
  if (props.selectionOnly && props.menuTeleportTarget) {
    // Opt-in dialog-owned menu: resolve the caller-declared dialog ancestor
    // here at mount (NOT from a parent ref during setup render). Missing or
    // disconnected target fails closed — toggleDropdown stays blocked so the
    // menu can never appear at body or clipped inline.
    const dialogTarget =
      selectorRef.value?.closest?.(props.menuTeleportTarget) ?? null;
    if (dialogTarget && dialogTarget.isConnected) {
      teleportTarget.value = dialogTarget;
      isTeleportEnabled.value = true;
      isDialogMenuContext.value = true;
    } else {
      menuTargetFailed.value = true;
    }
  } else if (ExtensionContextManager.isContentScript() && selectorRef.value) {
    const rootNode = selectorRef.value.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      // Find a suitable overlay/container that is fixed and has no transform
      // to ensure fixed positioning works correctly inside the shadow DOM.
      const overlay =
        rootNode.querySelector(".ti-m-sheet-overlay") ||
        rootNode.querySelector(".ti-window-overlay") ||
        rootNode.querySelector(".ti-host-container") ||
        rootNode.querySelector(".ti-shadow-host-inner") ||
        rootNode.firstElementChild; // Fallback to root element

      if (overlay) {
        teleportTarget.value = overlay;
        isTeleportEnabled.value = true;
      } else {
        isTeleportEnabled.value = false;
      }
    }
  } else {
    // In extension pages (Popup, Options, Sidepanel), teleport to body
    teleportTarget.value = "body";
    isTeleportEnabled.value = true;
  }

  /**
   * USE CAPTURE PHASE FOR CLICK-OUTSIDE
   * Why? Content script UI often uses @click.stop to prevent events from reaching the host page.
   * By using 'capture: true', we intercept the click before it's stopped by any parent container
   * (like TranslationWindow.vue). This ensures the dropdown closes correctly in Shadow DOM.
   */
  tracker.addEventListener(document, "click", handleClickOutside, {
    capture: true,
  });

  // Pointer latch tracking (see handleMenuFocusOut / handleMenuPointerTracking):
  // pointerdown decides whether the interaction begins inside the menu;
  // pointerup/pointercancel anywhere release the latch.
  tracker.addEventListener(document, "pointerdown", handleMenuPointerTracking, {
    capture: true,
  });
  tracker.addEventListener(document, "pointerup", handleMenuPointerTracking, {
    capture: true,
  });
  tracker.addEventListener(
    document,
    "pointercancel",
    handleMenuPointerTracking,
    { capture: true },
  );

  // Container scrolling alone never closes the menu. The nearest real scroll
  // source is tracked: the Options page (only place with
  // `.tab-content-container`, per OptionsLayout) for the regular activation
  // surfaces, or the Custom List drawer body for selection-only pickers. When
  // the scroll moves the trigger fully out of the visible area, dismiss
  // silently; otherwise reposition. Menu-internal scrolling never bubbles
  // through these source containers.
  const scrollContainer = props.selectionOnly
    ? (selectorRef.value?.closest?.(".custom-list-drawer-body") ?? null)
    : window.location.href.includes("options.html")
      ? (selectorRef.value?.closest?.(".tab-content-container") ?? null)
      : null;
  if (scrollContainer) {
    tracker.addEventListener(
      scrollContainer,
      "scroll",
      () => {
        if (!isDropdownOpen.value || optionsScrollAnimationFrameId !== null)
          return;
        optionsScrollAnimationFrameId = requestAnimationFrame(() => {
          optionsScrollAnimationFrameId = null;
          if (!isDropdownOpen.value) return;
          const trigger = triggerBtnRef.value;
          if (!trigger) return;
          const triggerRect = trigger.getBoundingClientRect();
          const containerRect = scrollContainer.getBoundingClientRect();
          // Zero-area intersection counts as invisible: exact shared boundary
          // (bottom === container top, top === viewport bottom, …) means the
          // trigger no longer has visible area. One-pixel overlap stays open.
          const fullyInvisible =
            triggerRect.bottom <= containerRect.top ||
            triggerRect.top >= containerRect.bottom ||
            triggerRect.right <= containerRect.left ||
            triggerRect.left >= containerRect.right ||
            triggerRect.bottom <= 0 ||
            triggerRect.top >= window.innerHeight ||
            triggerRect.right <= 0 ||
            triggerRect.left >= window.innerWidth;
          if (fullyInvisible) {
            closeDropdown(false);
            return;
          }
          if (!updateDropdownPosition()) closeDropdown(false);
        });
      },
      { passive: true },
    );
  }

  // Reposition on resize when teleported
  if (isTeleportEnabled.value) {
    tracker.addEventListener(
      window,
      "resize",
      () => {
        if (!isDropdownOpen.value || resizeAnimationFrameId !== null) return;
        resizeAnimationFrameId = requestAnimationFrame(() => {
          resizeAnimationFrameId = null;
          if (isDropdownOpen.value && !updateDropdownPosition())
            closeDropdown(false);
        });
      },
      { passive: true },
    );
  }

  // Add storage listener for cross-context updates using ResourceTracker
  if (typeof browser !== "undefined" && browser.storage) {
    tracker.addEventListener(
      browser.storage.onChanged,
      "addListener",
      handleStorageChange,
    );
  }
});

onUnmounted(() => {
  if (resizeAnimationFrameId !== null)
    cancelAnimationFrame(resizeAnimationFrameId);
  if (optionsScrollAnimationFrameId !== null)
    cancelAnimationFrame(optionsScrollAnimationFrameId);
  // Event listener cleanup is now handled automatically by useResourceTracker
});
</script>
