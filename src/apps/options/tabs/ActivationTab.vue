<template>
  <section class="options-tab-content activation-tab">
    <h2>{{ t('translation_activation_section_title') || 'Translation Activation Methods' }}</h2>

    <!-- Extension Enable/Disable -->
    <div class="setting-group extension-enabled-group">
      <BaseCheckbox
        v-model="extensionEnabled"
        :label="t('extension_enabled_label') || 'Enable Extension'"
      />
      <span class="setting-description">
        {{ t('extension_enabled_description') || 'Enable or disable the entire extension functionality except Popup and Sidepanel.' }}
      </span>
    </div>

    <!-- Desktop FAB Menu -->
    <BaseFieldset 
      id="FIELDSET_FAB"
      :legend="t('activation_group_fab_title') || 'Quick Action Button (FAB)'"
    >
      <div class="setting-group">
        <div class="setting-row fab-setting-row">
          <BaseCheckbox
            id="SHOW_DESKTOP_FAB"
            v-model="showDesktopFab"
            :disabled="!extensionEnabled"
            :label="t('show_desktop_fab_label') || 'Show Desktop Quick Action Button (FAB)'"
          />
          <div 
            class="fab-mode-select-wrapper"
            :class="{ open: showDesktopFab }"
          >
            <BaseSelect
              v-model="mobileUiMode"
              :options="mobileModeOptions"
              :disabled="!extensionEnabled || !showDesktopFab"
              class="compact-select"
            />
          </div>
        </div>
        <span class="setting-description">
          {{ t('show_desktop_fab_description') || 'Display a floating action button on desktop to quickly access tools like Translate Page and Select Element.' }}
        </span>
      </div>

      <div 
        class="sub-options-group"
        :class="{ open: showDesktopFab }"
      >
        <div 
          id="FAB_CUSTOMIZATION_SETTINGS"
          class="sub-options-inner fab-appearance-options"
        >
          <div class="fab-appearance-item opacity-item">
            <BaseRange
              id="FAB_IDLE_OPACITY"
              v-model="fabIdleOpacity"
              :label="t('fab_idle_opacity_label') || 'Idle Fade Opacity'"
              value-suffix="%"
              min="0"
              max="100"
              :disabled="!extensionEnabled || !showDesktopFab"
            />
          </div>

          <div class="separator-v" />

          <div class="fab-appearance-item size-item">
            <label class="setting-label">{{ t('fab_size_label') || 'Icon Size' }}</label>
            <BaseSelect
              id="FAB_SIZE"
              v-model="fabSize"
              :options="fabSizeOptions"
              :disabled="!extensionEnabled || !showDesktopFab"
              class="compact-select"
            />
          </div>
        </div>
      </div>
    </BaseFieldset>

    <!-- On-Page Selection -->
    <BaseFieldset 
      id="activation_group_page_selection"
      :legend="t('activation_group_page_selection_title') || 'Text Selection'"
    >
      <template #header>
        <div class="legend-actions-wrapper">
          <span 
            class="legend-action-label"
            :class="{ 'is-disabled': !extensionEnabled || !translateOnTextSelection }"
          >{{ t('provider_label') }}:</span>
          <ProviderSelector
            v-model="selectionProvider"
            allow-default
            mode="button"
            only-configured
            :is-global="false"
            :disabled="!extensionEnabled || !translateOnTextSelection"
          />
        </div>
      </template>

      <div class="setting-group">
        <BaseCheckbox
          v-model="translateOnTextSelection"
          :disabled="!extensionEnabled"
          :label="t('translate_on_text_selection_label') || 'Enable translation on text selection'"
        />
        <span class="setting-description">
          {{ t('translate_on_text_selection_description') || 'Allow triggering translation automatically or via shortcut after selecting text on the page.' }}
        </span>
      </div>

      <!-- Selection Mode Options -->
      <div 
        class="sub-options-group"
        :class="{ open: translateOnTextSelection }"
      >
        <div class="sub-options-inner">
          <div class="radio-group">
            <BaseRadio
              v-model="selectionTranslationMode"
              :value="SelectionTranslationMode.IMMEDIATE"
              name="selectionTranslationMode"
              :disabled="!extensionEnabled"
              :label="t('options_selection_mode_immediate') || 'Immediately'"
            />
            <BaseRadio
              v-model="selectionTranslationMode"
              :value="SelectionTranslationMode.ON_CLICK"
              name="selectionTranslationMode"
              :disabled="!extensionEnabled"
              :label="t('options_selection_mode_onclick') || 'Show Icon'"
            />
            <BaseRadio
              v-model="selectionTranslationMode"
              :value="SelectionTranslationMode.ON_FAB_CLICK"
              name="selectionTranslationMode"
              :disabled="!extensionEnabled || !showDesktopFab"
              :label="t('options_selection_mode_onfabclick') || 'FAB'"
            />
          </div>

          <div class="setting-group sub-setting-group">
            <BaseCheckbox
              v-model="requireCtrlForTextSelection"
              :disabled="!extensionEnabled || selectionTranslationMode !== SelectionTranslationMode.IMMEDIATE"
              :label="t('require_ctrl_for_text_selection_label') || 'Require Ctrl key for text selection translation'"
            />
          </div>

          <div class="setting-group sub-setting-group">
            <BaseCheckbox
              v-model="activeSelectionIconOnTextfields"
              :disabled="!extensionEnabled"
              :label="t('active_selection_icon_on_textfields_label') || 'Active Selection Icon on Textfields'"
            />
            <span class="setting-description">
              {{ t('active_selection_icon_on_textfields_description') || 'Show translation icon when selecting text inside text fields (input, textarea).' }}
            </span>
          </div>

          <div class="setting-group sub-setting-group">
            <BaseCheckbox
              v-model="enhancedTripleClickDrag"
              :disabled="!extensionEnabled"
              :label="t('enhanced_triple_click_drag_label') || 'Enhanced Triple-Click + Drag Support'"
            />
            <span class="setting-description">
              {{ t('enhanced_triple_click_drag_description') || 'When enabled, triple-clicking to select a paragraph and then dragging to extend the selection will wait until you release the mouse before showing the translation. This prevents premature translation when you want to select multiple paragraphs.' }}
            </span>
          </div>

          <div
            v-if="selectionTranslationMode === SelectionTranslationMode.ON_CLICK"
            id="SHOW_TRANSLATE_ICON_IN_TOOLBAR"
            class="setting-group sub-setting-group"
          >
            <BaseCheckbox
              v-model="showTranslateIconInToolbar"
              :disabled="!extensionEnabled || !showTtsIconInToolbar"
              :label="t('show_translate_icon_in_toolbar_label') || 'Show Translate Button in Selection Toolbar'"
            />
            <span class="setting-description">
              {{ t('show_translate_icon_in_toolbar_description') || 'Display the Translate icon inside the floating selection toolbar.' }}
            </span>
          </div>

          <div
            v-if="selectionTranslationMode === SelectionTranslationMode.ON_CLICK"
            id="SHOW_TTS_ICON_IN_TOOLBAR"
            class="setting-group sub-setting-group"
          >
            <BaseCheckbox
              v-model="showTtsIconInToolbar"
              :disabled="!extensionEnabled || !showTranslateIconInToolbar"
              :label="t('show_tts_icon_in_toolbar_label') || 'Show Text-to-Speech (TTS) Button in Selection Toolbar'"
            />
            <span class="setting-description">
              {{ t('show_tts_icon_in_toolbar_description') || 'Display the stateful volume icon to speak selected text inside the floating selection toolbar.' }}
            </span>
          </div>
        </div>
      </div>
    </BaseFieldset>

    <!-- Select Element -->
    <BaseFieldset 
      id="activation_group_select_element"
      :legend="t('activation_group_select_element_title') || 'Select Element'"
    >
      <template #header>
        <div class="legend-actions-wrapper">
          <span 
            class="legend-action-label"
            :class="{ 'is-disabled': !extensionEnabled || !translateWithSelectElement }"
          >{{ t('provider_label') }}:</span>
          <ProviderSelector
            v-model="selectElementProvider"
            allow-default
            mode="button"
            required-feature="bulk"
            only-configured
            :is-global="false"
            :disabled="!extensionEnabled || !translateWithSelectElement"
          />
        </div>
      </template>
      <div class="setting-group">
        <div class="setting-row">
          <BaseCheckbox
            v-model="translateWithSelectElement"
            :disabled="!extensionEnabled"
            :label="t('translate_with_select_element_label') || 'Enable translation via select element'"
          />
          <div 
            id="SELECT_ELEMENT_CONFIGURE_SHORTCUTS"
            class="shortcut-picker-animated-wrapper"
            :class="{ open: translateWithSelectElement }"
          >
            <ConfigureShortcutButton
              command-name="SELECT-ELEMENT-COMMAND"
              :disabled="!extensionEnabled"
            />
          </div>
        </div>
        <span class="setting-description">
          {{ t('translate_with_select_element_description') || 'Allow triggering translation using a specific selection method (if implemented, e.g., selecting a whole paragraph).' }}
        </span>
      </div>

      <!-- Select Element Sub-Options -->
      <div 
        class="sub-options-group"
        :class="{ open: translateWithSelectElement }"
      >
        <div class="sub-options-inner">
          <div
            id="SELECT_ELEMENT_SHOW_ORIGINAL_ON_HOVER"
            class="setting-group sub-setting-group"
          >
            <BaseCheckbox
              v-model="selectElementShowOriginal"
              :disabled="!extensionEnabled"
              :label="t('select_element_show_original_on_hover_label') || 'Show original on hover'"
            />
            <span class="setting-description">
              {{ t('select_element_show_original_on_hover_description') || 'Show the original text in a tooltip when hovering over elements translated via Select Element.' }}
            </span>
          </div>

          <div
            id="PAGE_CONTEXT_SELECT_ELEMENT"
            class="setting-group sub-setting-group"
          >
            <BaseCheckbox
              v-model="showSelectElementInContextMenu"
              :disabled="!extensionEnabled"
              :label="t('show_select_element_in_context_menu_label') || 'Show in context menu'"
            />
            <span class="setting-description">
              {{ t('show_select_element_in_context_menu_description') || 'Display the \'Select Element\' option in the browser\'s right-click context menu.' }}
            </span>
          </div>
        </div>
      </div>
    </BaseFieldset>

    <!-- Whole Page Translation -->
    <BaseFieldset 
      id="FIELDSET_WHOLE_PAGE"
      :legend="t('whole_page_translation_section_title') || 'Whole Page Translation'"
    >
      <template #header>
        <div class="legend-actions-wrapper">
          <span 
            class="legend-action-label"
            :class="{ 'is-disabled': !extensionEnabled || !wholePageEnabled }"
          >{{ t('provider_label') }}:</span>
          <ProviderSelector
            v-model="pageProvider"
            allow-default
            mode="button"
            required-feature="bulk"
            only-configured
            :is-global="false"
            :disabled="!extensionEnabled || !wholePageEnabled"
          />
        </div>
      </template>

      <div class="setting-group">
        <BaseCheckbox
          id="WHOLE_PAGE_TRANSLATION_ENABLED"
          v-model="wholePageEnabled"
          :disabled="!extensionEnabled"
          :label="t('whole_page_translation_enabled_label') || 'Enable Whole Page Translation'"
        />
        <span class="setting-description">
          {{ t('whole_page_translation_enabled_description') || 'Allow translating the entire web page content while maintaining the layout.' }}
        </span>
      </div>

      <div
        class="sub-options-group"
        :class="{ open: wholePageEnabled || revealWholePageRules }"
      >
        <div class="sub-options-inner">
          <div
            id="PAGE_CONTEXT_PAGE_TRANSLATION"
            class="setting-group sub-setting-group"
          >
            <BaseCheckbox
              v-model="showPageTranslationInContextMenu"
              :disabled="!extensionEnabled"
              :label="t('show_page_translation_in_context_menu_label') || 'Show in context menu'"
            />
            <span class="setting-description">
              {{ t('show_page_translation_in_context_menu_description') || 'Display page translation and restore options in the browser\'s right-click context menu.' }}
            </span>
          </div>

          <div 
            id="WHOLE_PAGE_TRIGGER_MODE"
            class="setting-group sub-setting-group whole-page-trigger-group"
          >
            <div class="trigger-modes-container">
              <div class="radio-group-horizontal">
                <BaseRadio
                  v-model="wholePageTranslateAfterScrollStop"
                  :value="true"
                  name="wholePageTrigger"
                  :disabled="!extensionEnabled"
                  :label="t('whole_page_trigger_on_stop') || 'On Scroll Stop'"
                />
                <BaseRadio
                  v-model="wholePageTranslateAfterScrollStop"
                  :value="false"
                  name="wholePageTrigger"
                  :disabled="!extensionEnabled"
                  :label="t('whole_page_trigger_fluid') || 'During Scroll'"
                />
              </div>
            </div>

            <div class="delay-setting-container">
              <span 
                class="delay-label"
                :class="{ 'is-disabled': !extensionEnabled }"
              >{{ t('whole_page_delay_label') || 'Translation Delay' }}:</span>
              <div class="number-input-container inline-delay-input">
                <input
                  v-model.number="wholePageScrollStopDelay"
                  type="number"
                  min="100"
                  max="5000"
                  step="100"
                  class="base-number-input compact-input"
                  :disabled="!extensionEnabled"
                >
                <span 
                  class="unit-label"
                  :class="{ 'is-disabled': !extensionEnabled }"
                >{{ t('whole_page_scroll_stop_delay_unit') || 'ms' }}</span>
              </div>
            </div>
            <span class="setting-description">
              {{ wholePageTranslateAfterScrollStop 
                ? (t('whole_page_translate_after_scroll_stop_description') || 'Only trigger translation when you stop scrolling.')
                : (t('whole_page_translate_fluid_description') || 'Translate continuously with a slight delay during scrolling.') 
              }}
            </span>
          </div>

          <div class="setting-group sub-setting-group">
            <BaseCheckbox
              v-model="wholePageShowOriginal"
              :disabled="!extensionEnabled"
              :label="t('whole_page_show_original_on_hover_label') || 'Show original on hover'"
            />
            <span class="setting-description">
              {{ t('whole_page_show_original_on_hover_description') || 'Show the original text in a tooltip when hovering over translated content.' }}
            </span>
          </div>

          <div class="setting-group sub-setting-group">
            <BaseCheckbox
              v-model="wholePageLazyLoading"
              :disabled="!extensionEnabled"
              :label="t('whole_page_lazy_loading_label') || 'Lazy Loading (Performance)'"
            />
            <span class="setting-description">
              {{ t('whole_page_lazy_loading_description') || 'Only translate parts of the page that are visible or near the viewport.' }}
            </span>
          </div>

          <div class="setting-group sub-setting-group">
            <BaseCheckbox
              v-model="wholePageAutoTranslate"
              :disabled="!extensionEnabled"
              :label="t('whole_page_auto_translate_on_dom_changes_label') || 'Auto-translate new content (Infinite Scroll)'"
            />
            <span class="setting-description">
              {{ t('whole_page_auto_translate_on_dom_changes_description') || 'Automatically detect and translate new content as it appears.' }}
            </span>
          </div>

          <div 
            id="WHOLE_PAGE_TOKEN_WARNING_HIDDEN"
            class="setting-group sub-setting-group"
          >
            <BaseCheckbox
              v-model="wholePageTokenWarningEnabled"
              :disabled="!extensionEnabled"
              :label="t('whole_page_token_warning_label') || 'Show token usage warning'"
            />
            <span class="setting-description">
              {{ t('whole_page_token_warning_description') || 'Display a confirmation dialog before translating the whole page if the provider uses credits/tokens (e.g. Gemini, OpenAI, DeepL).' }}
            </span>
          </div>

          <div 
            id="WHOLE_PAGE_AUTO_TRANSLATE_RULES"
            class="setting-group sub-setting-group"
          >
            <div class="setting-row">
              <div class="setting-info">
                <label class="setting-label">{{ t('whole_page_rules_label_clean') || 'Automatically Translate Sites' }}</label>
                <span class="setting-description">
                  {{ t('whole_page_rules_desc_clean') || 'Specify site patterns that should be translated automatically upon navigation.' }}
                </span>
              </div>
              <div class="setting-control">
                <BaseButton
                  id="WHOLE_PAGE_MANAGE_RULES_BTN"
                  class="manage-rules-button"
                  :disabled="!extensionEnabled"
                  @click="openRulesDrawer"
                >
                  {{ t('whole_page_manage_rules_btn') || 'Manage Rules ⚙️' }}
                </BaseButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseFieldset>

    <!-- Mouse on Hover Translation -->
    <BaseFieldset 
      id="activation_group_mouse_hover"
      :legend="t('activation_group_mouse_hover_title') || 'Mouse on Hover Translation'"
    >
      <template #header>
        <div class="legend-actions-wrapper">
          <span 
            class="legend-action-label"
            :class="{ 'is-disabled': !extensionEnabled || !mouseHoverEnabled }"
          >{{ t('provider_label') }}:</span>
          <ProviderSelector
            v-model="mouseHoverProvider"
            allow-default
            mode="button"
            required-feature="bulk"
            only-configured
            :is-global="false"
            :disabled="!extensionEnabled || !mouseHoverEnabled"
          />
        </div>
      </template>

      <div class="setting-group">
        <BaseCheckbox
          id="MOUSE_HOVER_TRANSLATION_ENABLED"
          v-model="mouseHoverEnabled"
          :disabled="!extensionEnabled"
          :label="t('mouse_hover_translation_enabled_label') || 'Enable Mouse on Hover Translation'"
        />
        <span class="setting-description">
          {{ t('mouse_hover_translation_enabled_description') || 'Automatically translate text when you hover over it.' }}
        </span>
      </div>

      <div 
        class="sub-options-group"
        :class="{ open: mouseHoverEnabled }"
      >
        <div class="sub-options-inner">
          <!-- FAB Toggle -->
          <div class="setting-group sub-setting-group">
            <BaseCheckbox
              id="SHOW_MOUSE_HOVER_IN_FAB"
              v-model="showMouseHoverInFab"
              :disabled="!extensionEnabled || !mouseHoverEnabled"
              :label="t('show_mouse_hover_in_fab_label') || 'Show in Desktop FAB menu'"
            />
            <span class="setting-description">
              {{ t('show_mouse_hover_in_fab_description') || 'Allow enabling or disabling Mouse on Hover translation directly from the Desktop floating button menu.' }}
            </span>
          </div>

          <div class="section-separator mini" />

          <!-- Scope -->
          <div class="horizontal-setting-row">
            <label class="setting-label">{{ t('mouse_hover_scope_label') || 'Translation Scope' }}</label>
            <div class="setting-control-group">
              <BaseSelect
                id="MOUSE_HOVER_SCOPE"
                v-model="mouseHoverScope"
                :options="mouseHoverScopeOptions"
                :disabled="!extensionEnabled || !mouseHoverEnabled"
                class="compact-select"
              />
              <div 
                v-if="mouseHoverScope === 'container'"
                class="inline-checkbox-wrapper"
              >
                <BaseCheckbox
                  id="MOUSE_HOVER_SHOW_CONTAINER_BORDER"
                  v-model="mouseHoverShowBorder"
                  :disabled="!extensionEnabled || !mouseHoverEnabled"
                  :label="t('mouse_hover_show_container_border_label') || 'Show border around container'"
                />
              </div>
            </div>
          </div>

          <div class="section-separator mini" />

          <!-- Trigger & Delay -->
          <div class="horizontal-setting-row">
            <label class="setting-label">{{ t('mouse_hover_trigger_label') || 'Trigger' }}</label>
            <div class="setting-control-group">
              <BaseSelect
                id="MOUSE_HOVER_TRIGGER"
                v-model="mouseHoverTriggerUi"
                :options="mouseHoverTriggerOptions"
                :disabled="!extensionEnabled || !mouseHoverEnabled"
                class="compact-select"
              />

              <!-- Delay (Only shown for Immediate) -->
              <div 
                v-if="mouseHoverTrigger === 'hover'"
                class="inline-control-wrapper"
              >
                <span 
                  class="setting-label"
                  :class="{ 'is-disabled': !extensionEnabled || !mouseHoverEnabled }"
                >{{ t('mouse_hover_delay_label') || 'Hover Delay' }}:</span>
                <div class="number-input-container inline-delay-input">
                  <input
                    id="MOUSE_HOVER_DELAY"
                    v-model.number="mouseHoverDelay"
                    type="number"
                    min="100"
                    max="5000"
                    step="100"
                    class="base-number-input compact-input"
                    :disabled="!extensionEnabled || !mouseHoverEnabled"
                  >
                  <span 
                    class="unit-label"
                    :class="{ 'is-disabled': !extensionEnabled || !mouseHoverEnabled }"
                  >ms</span>
                </div>
              </div>
            </div>
          </div>

          <div class="section-separator mini" />

          <!-- Auto Close & Display Time -->
          <div class="horizontal-setting-row">
            <label class="setting-label">{{ t('mouse_hover_autoclose_label') || 'Auto-Close Tooltip' }}</label>
            <div class="setting-control-group">
              <BaseSelect
                id="MOUSE_HOVER_AUTO_CLOSE"
                v-model="mouseHoverAutoClose"
                :options="mouseHoverAutoCloseOptions"
                :disabled="!extensionEnabled || !mouseHoverEnabled"
                class="compact-select"
              />

              <!-- Display Time -->
              <div 
                v-if="mouseHoverAutoClose === 'timer'"
                class="inline-control-wrapper"
              >
                <label class="setting-label">{{ t('mouse_hover_timer_label') || 'Display Time' }}</label>
                <div class="number-input-container inline-delay-input">
                  <input
                    id="MOUSE_HOVER_TIMER_DURATION"
                    v-model.number="mouseHoverTimerDuration"
                    type="number"
                    min="1000"
                    max="30000"
                    step="500"
                    class="base-number-input compact-input"
                    :disabled="!extensionEnabled || !mouseHoverEnabled"
                  >
                  <span 
                    class="unit-label"
                    :class="{ 'is-disabled': !extensionEnabled || !mouseHoverEnabled }"
                  >ms</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseFieldset>

    <!-- Text Field Translation -->
    <BaseFieldset 
      id="activation_group_text_fields"
      :legend="t('activation_group_text_fields_title') || 'Text Field Translation'"
    >
      <template #header>
        <div class="legend-actions-wrapper">
          <span 
            class="legend-action-label"
            :class="{ 'is-disabled': !extensionEnabled || (!translateOnTextFields && !enableShortcutForTextFields) }"
          >{{ t('provider_label') }}:</span>
          <ProviderSelector
            v-model="fieldProvider"
            allow-default
            mode="button"
            required-feature="bulk"
            only-configured
            :is-global="false"
            :disabled="!extensionEnabled || (!translateOnTextFields && !enableShortcutForTextFields)"
          />
        </div>
      </template>

      <div class="setting-group">
        <BaseCheckbox
          v-model="translateOnTextFields"
          :disabled="!extensionEnabled"
          :label="t('translate_on_text_fields_label') || 'Enable translation on text fields'"
        />
        <span class="setting-description">
          {{ t('translate_on_text_fields_description') || 'Allow triggering translation directly within input/textarea fields (e.g., via context menu or shortcut).' }}
        </span>
      </div>

      <div class="setting-group">
        <div class="setting-row">
          <BaseCheckbox
            v-model="enableShortcutForTextFields"
            :disabled="!extensionEnabled"
            :label="t('enable_shortcut_for_text_fields_label') || 'Enable shortcut for text fields'"
          />
          <div 
            class="shortcut-picker-animated-wrapper"
            :class="{ open: enableShortcutForTextFields }"
          >
            <ShortcutPicker
              v-model="textFieldShortcut"
              :disabled="!extensionEnabled"
              :placeholder="t('click_to_set_shortcut') || 'Set shortcut'"
              class="inline-picker"
            />
          </div>
        </div>
        <span
          v-if="!enableShortcutForTextFields"
          class="setting-description"
        >
          {{ t('enable_shortcut_for_text_fields_description') || 'Allow using a keyboard shortcut to trigger translation when inside a text field.' }}
        </span>
      </div>

      <!-- Text Field Mode Options -->
      <div 
        class="sub-options-group"
        :class="{ open: translateOnTextFields || enableShortcutForTextFields }"
      >
        <div class="sub-options-inner">
          <div class="radio-group">
            <BaseRadio
              v-model="textFieldMode"
              value="replace"
              name="textFieldMode"
              :disabled="!extensionEnabled"
              :label="t('options_textField_mode_replace') || 'Replace on Textfield'"
            />
            <BaseRadio
              v-model="textFieldMode"
              value="copy"
              name="textFieldMode"
              :disabled="!extensionEnabled"
              :label="t('options_textField_mode_copy') || 'Copy to Clipboard'"
            />
          </div>

          <div class="setting-group sub-setting-group">
            <BaseCheckbox 
              v-model="replaceOnSpecialSites" 
              :disabled="!extensionEnabled || textFieldMode !== 'copy'"
              :label="t('enable_replace_on_special_sites') || 'Enable replace on special sites (Whatsapp, Telegram, etc.)'"
            />
          </div>
        </div>
      </div>
    </BaseFieldset>

    <!-- Auto Page Translation Rules slide-out Drawer -->
    <Transition name="drawer-fade">
      <div 
        v-if="isRulesDrawerOpen" 
        class="drawer-overlay" 
        @click="closeRulesDrawer" 
      />
    </Transition>
    <Transition name="drawer-slide">
      <div 
        v-if="isRulesDrawerOpen" 
        id="WHOLE_PAGE_AUTO_TRANSLATE_RULES_DRAWER"
        class="drawer-container"
        :class="{ 'rtl': isRTL }"
      >
        <div class="drawer-header">
          <h3>{{ t('whole_page_rules_drawer_title') || 'Auto Page Translation Rules' }}</h3>
          <button 
            class="drawer-close-btn" 
            @click="closeRulesDrawer"
          >
            ✕
          </button>
        </div>
        
        <!-- Rules Format Instruction Panel -->
        <div class="drawer-instruction-panel">
          <div class="instruction-header">
            <h4>{{ t('whole_page_rules_instruction_title') || 'Wildcard Rule Patterns' }}</h4>
          </div>
          <pre
            class="instruction-content"
            :class="{ 'rtl-text': isRTL }"
          >{{ rulesInstructionsText }}</pre>
        </div>

        <!-- Add New Rule Section -->
        <div class="drawer-add-rule-section">
          <div class="add-rule-input-wrapper">
            <input
              v-model="newRuleInput"
              type="text"
              class="add-rule-input"
              :placeholder="t('whole_page_rules_add_placeholder') || 'Add new rule (e.g. *.example.com/*)...'"
              dir="ltr"
              @keydown.enter="addNewRule"
            >
            <BaseButton 
              class="add-rule-btn" 
              variant="primary"
              size="sm"
              @click="addNewRule"
            >
              {{ t('whole_page_rules_btn_add') || 'Add' }}
            </BaseButton>
          </div>
          <div
            v-if="ruleErrorMsg"
            class="rule-error-message"
          >
            {{ ruleErrorMsg }}
          </div>
        </div>

        <div class="drawer-body">
          <div 
            v-if="tempRules.length === 0" 
            class="drawer-empty"
          >
            {{ t('whole_page_rules_empty') || 'No auto-translate rules added yet.' }}
          </div>
          <div 
            v-else 
            class="drawer-list"
          >
            <div
              v-for="(rule, index) in tempRules"
              :key="rule"
              class="rule-item"
            >
              <span
                class="rule-text"
                dir="ltr"
              >{{ rule }}</span>
              <button 
                class="delete-rule-btn" 
                :title="t('whole_page_rules_btn_delete') || 'Delete'"
                @click="deleteRule(index)"
              >
                🗑
              </button>
            </div>
          </div>
        </div>

        <div class="drawer-footer">
          <BaseButton 
            variant="danger" 
            size="sm" 
            @click="resetAllRules"
          >
            {{ t('tts_reset_all') || 'Reset All' }}
          </BaseButton>
          <div class="drawer-footer-actions">
            <BaseButton 
              variant="primary" 
              size="sm" 
              @click="saveAndCloseRulesDrawer"
            >
              {{ t('tts_done') || 'Done' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<script setup>
import './ActivationTab.scss'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '@/features/settings/stores/settings.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { useTabSettings } from '../composables/useTabSettings.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'
import { TranslationMode, SelectionTranslationMode, CONFIG } from '@/shared/config/config.js'
import { MOBILE_CONSTANTS } from '@/shared/constants/mobile.js'
import { useHighlightManager } from '../composables/useHighlightManager.js'
import { detectOS, OS_PLATFORMS } from '@/utils/browser/compatibility.js'

// Components
import BaseCheckbox from '@/components/base/BaseCheckbox.vue'
import BaseRadio from '@/components/base/BaseRadio.vue'
import BaseSelect from '@/components/base/BaseSelect.vue'
import BaseRange from '@/components/base/BaseRange.vue'
import BaseFieldset from '@/components/base/BaseFieldset.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import ShortcutPicker from '@/components/base/ShortcutPicker.vue'
import ConfigureShortcutButton from '@/components/feature/ConfigureShortcutButton.vue'
import ProviderSelector from '@/components/shared/ProviderSelector.vue'
const logger = getScopedLogger(LOG_COMPONENTS.UI, 'ActivationTab')
const settingsStore = useSettingsStore()
const { highlightElement } = useHighlightManager()
const { t } = useUnifiedI18n()
const { createSetting, createProviderSetting } = useTabSettings(settingsStore, logger)

// --- Actions ---

// --- State ---
// --- Settings Definitions ---

// General
const extensionEnabled = createSetting('EXTENSION_ENABLED', true)

// FAB
const showMobileFab = createSetting('SHOW_MOBILE_FAB', true)
const showDesktopFab = createSetting('SHOW_DESKTOP_FAB', false, {
  onChanged: (val) => {
    // Sync mobile FAB with desktop FAB toggle
    showMobileFab.value = val
    
    if (!val && selectionTranslationMode.value === SelectionTranslationMode.ON_FAB_CLICK) {
      selectionTranslationMode.value = SelectionTranslationMode.ON_CLICK
    }
  }
})
const mobileUiMode = createSetting('MOBILE_UI_MODE', MOBILE_CONSTANTS.UI_MODE.AUTO)

const mobileModeOptions = computed(() => [
  { value: MOBILE_CONSTANTS.UI_MODE.AUTO, label: t('mobile_ui_mode_auto') },
  { value: MOBILE_CONSTANTS.UI_MODE.MOBILE, label: t('mobile_ui_mode_mobile') },
  { value: MOBILE_CONSTANTS.UI_MODE.DESKTOP, label: t('mobile_ui_mode_desktop') }
])

const fabIdleOpacity = createSetting('FAB_IDLE_OPACITY', 20)
const fabSize = createSetting('FAB_SIZE', '1')

const fabSizeOptions = computed(() => [
  { value: '0.8', label: t('fab_size_small') || 'Small' },
  { value: '1', label: t('fab_size_default') || 'Default' },
  { value: '1.2', label: t('fab_size_large') || 'Large' },
  { value: '1.5', label: t('fab_size_extra_large') || 'Extra Large' }
])

// Text Fields
const translateOnTextFields = createSetting('TRANSLATE_ON_TEXT_FIELDS', false)
const enableShortcutForTextFields = createSetting('ENABLE_SHORTCUT_FOR_TEXT_FIELDS', false)
const textFieldShortcut = createSetting('TEXT_FIELD_SHORTCUT', 'Ctrl+/')
const textFieldMode = createSetting('COPY_REPLACE', 'copy', {
  transformGet: (v) => v === 'replace' ? 'replace' : 'copy'
})
const replaceOnSpecialSites = createSetting('REPLACE_SPECIAL_SITES', false)

// Selection
const translateWithSelectElement = createSetting('TRANSLATE_WITH_SELECT_ELEMENT', false)
const selectElementShowOriginal = createSetting('SELECT_ELEMENT_SHOW_ORIGINAL_ON_HOVER', false)
const contextMenuVisibility = createSetting('CONTEXT_MENU_VISIBILITY', CONFIG.CONTEXT_MENU_VISIBILITY)

const showSelectElementInContextMenu = computed({
  get: () => contextMenuVisibility.value?.PAGE_CONTEXT_SELECT_ELEMENT ?? true,
  set: (val) => {
    contextMenuVisibility.value = {
      ...contextMenuVisibility.value,
      PAGE_CONTEXT_SELECT_ELEMENT: val
    }
  }
})

const translateOnTextSelection = createSetting('TRANSLATE_ON_TEXT_SELECTION', CONFIG.TRANSLATE_ON_TEXT_SELECTION)
const selectionTranslationMode = createSetting('selectionTranslationMode', SelectionTranslationMode.IMMEDIATE)
const requireCtrlForTextSelection = createSetting('REQUIRE_CTRL_FOR_TEXT_SELECTION', false)
const showTtsIconInToolbar = createSetting('SHOW_TTS_ICON_IN_TOOLBAR', true)
const showTranslateIconInToolbar = createSetting('SHOW_TRANSLATE_ICON_IN_TOOLBAR', true)
const activeSelectionIconOnTextfields = createSetting('ACTIVE_SELECTION_ICON_ON_TEXTFIELDS', true)
const enhancedTripleClickDrag = createSetting('ENHANCED_TRIPLE_CLICK_DRAG', false)

// Whole Page
const wholePageEnabled = createSetting('WHOLE_PAGE_TRANSLATION_ENABLED', true)
const revealWholePageRules = ref(false)
const showPageTranslationInContextMenu = computed({
  get: () => contextMenuVisibility.value?.PAGE_CONTEXT_PAGE_TRANSLATION ?? true,
  set: (val) => {
    contextMenuVisibility.value = {
      ...contextMenuVisibility.value,
      PAGE_CONTEXT_PAGE_TRANSLATION: val
    }
  }
})
const wholePageLazyLoading = createSetting('WHOLE_PAGE_LAZY_LOADING', true)
const wholePageAutoTranslate = createSetting('WHOLE_PAGE_AUTO_TRANSLATE_ON_DOM_CHANGES', true)
const wholePageShowOriginal = createSetting('WHOLE_PAGE_SHOW_ORIGINAL_ON_HOVER', false)
const wholePageTranslateAfterScrollStop = createSetting('WHOLE_PAGE_TRANSLATE_AFTER_SCROLL_STOP', false)
const wholePageScrollStopDelay = createSetting('WHOLE_PAGE_SCROLL_STOP_DELAY', 500)
const wholePageTokenWarningEnabled = createSetting('WHOLE_PAGE_TOKEN_WARNING_HIDDEN', false, {
  transformGet: (v) => !v,
  transformSet: (v) => !v
})
// RTL check
const isRTL = computed(() => {
  try {
    return t('IsRTL') === 'true'
  } catch {
    return false
  }
})

// Rules Drawer State
const isRulesDrawerOpen = ref(false)
const newRuleInput = ref('')
const ruleErrorMsg = ref('')
const tempRules = ref([])

const openRulesDrawer = () => {
  newRuleInput.value = ''
  ruleErrorMsg.value = ''
  const currentRules = settingsStore.settings?.WHOLE_PAGE_AUTO_TRANSLATE_RULES || []
  tempRules.value = Array.isArray(currentRules) ? [...currentRules] : []
  isRulesDrawerOpen.value = true
}

const closeRulesDrawer = () => {
  isRulesDrawerOpen.value = false
}

const addNewRule = () => {
  const rule = newRuleInput.value.trim()
  if (!rule) {
    ruleErrorMsg.value = t('whole_page_rules_error_invalid') || 'Please enter a valid rule pattern.'
    return
  }
  
  if (tempRules.value.includes(rule)) {
    ruleErrorMsg.value = t('whole_page_rules_error_duplicate') || 'This rule already exists.'
    return
  }
  
  tempRules.value.push(rule)
  newRuleInput.value = ''
  ruleErrorMsg.value = ''
}

const deleteRule = (index) => {
  tempRules.value.splice(index, 1)
}

const resetAllRules = () => {
  if (confirm(t('whole_page_rules_confirm_reset') || 'Are you sure you want to delete all rules?')) {
    tempRules.value = []
  }
}

const saveAndCloseRulesDrawer = () => {
  settingsStore.updateSettingLocally('WHOLE_PAGE_AUTO_TRANSLATE_RULES', [...tempRules.value])
  isRulesDrawerOpen.value = false
}

const rulesInstructionsText = computed(() => {
  return t('whole_page_auto_translate_rules_description') || 
         `example.com           → root page only\nexample.com/*         → all pages on the site\n*.example.com         → root pages of the domain and subdomains\n*.example.com/*       → all pages on the domain and subdomains\nexample.com/docs      → exact page\nexample.com/docs/*    → all pages under /docs`
})

const handleKeyDown = (e) => {
  if (e.key === 'Escape' && isRulesDrawerOpen.value) {
    closeRulesDrawer()
  }
}

// Mouse on Hover
const mouseHoverEnabled = createSetting('MOUSE_HOVER_TRANSLATION_ENABLED', false)
const mouseHoverScope = createSetting('MOUSE_HOVER_SCOPE', 'container')
const mouseHoverTrigger = createSetting('MOUSE_HOVER_TRIGGER', CONFIG.MOUSE_HOVER_TRIGGER)
const mouseHoverDelay = createSetting('MOUSE_HOVER_DELAY', 500)
const mouseHoverAutoClose = createSetting('MOUSE_HOVER_AUTO_CLOSE', 'mouseleave')
const mouseHoverTimerDuration = createSetting('MOUSE_HOVER_TIMER_DURATION', 3000)
const mouseHoverShowBorder = createSetting('MOUSE_HOVER_SHOW_CONTAINER_BORDER', true)
const showMouseHoverInFab = createSetting('SHOW_MOUSE_HOVER_IN_FAB', true)
const isMacOS = detectOS() === OS_PLATFORMS.MAC
const mouseHoverTriggerUi = computed({
  get: () => !isMacOS && mouseHoverTrigger.value === 'control'
    ? 'primary'
    : mouseHoverTrigger.value,
  set: (value) => {
    mouseHoverTrigger.value = value
  }
})

const mouseHoverScopeOptions = computed(() => [
  { value: 'word', label: t('mouse_hover_scope_word') || 'Word' },
  { value: 'sentence', label: t('mouse_hover_scope_sentence') || 'Sentence' },
  { value: 'container', label: t('mouse_hover_scope_container') || 'Container' }
])

const mouseHoverTriggerOptions = computed(() => {
  const modifierOptions = isMacOS
    ? [
        { value: 'primary', label: t('mouse_hover_trigger_primary_mac') || 'Command ⌘' },
        { value: 'control', label: t('mouse_hover_trigger_control') || 'Control ⌃' },
        { value: 'alt', label: t('mouse_hover_trigger_alt_mac') || 'Option ⌥' },
        { value: 'shift', label: t('mouse_hover_trigger_shift_mac') || 'Shift ⇧' }
      ]
    : [
        { value: 'primary', label: t('mouse_hover_trigger_primary') || 'Ctrl' },
        { value: 'alt', label: t('mouse_hover_trigger_alt') || 'Alt' },
        { value: 'shift', label: t('mouse_hover_trigger_shift') || 'Shift' }
      ]

  return [
    { value: 'hover', label: t('mouse_hover_trigger_hover') || 'Immediate (Hover)' },
    ...modifierOptions
  ]
})

const mouseHoverAutoCloseOptions = computed(() => [
  { value: 'mouseleave', label: t('mouse_hover_autoclose_mouseleave') || 'On Mouse Leave' },
  { value: 'timer', label: t('mouse_hover_autoclose_timer') || 'After Time' }
])

const fieldProvider = createProviderSetting(TranslationMode.Field)
const selectElementProvider = createProviderSetting(TranslationMode.Select_Element)
const selectionProvider = createProviderSetting(TranslationMode.Selection)
const pageProvider = createProviderSetting(TranslationMode.Page)
const mouseHoverProvider = createProviderSetting(TranslationMode.MouseHover)

// --- Validation Feedback ---

const handleValidationFeedback = (e) => {
  const { field, mode } = e.detail || {};
  
  if (field === 'provider' && mode) {
    // Map mode to fieldset ID
    const modeToId = {
      [TranslationMode.Field]: 'activation_group_text_fields',
      [TranslationMode.Select_Element]: 'activation_group_select_element',
      [TranslationMode.Selection]: 'activation_group_page_selection',
      [TranslationMode.Page]: 'FIELDSET_WHOLE_PAGE',
      [TranslationMode.MouseHover]: 'activation_group_mouse_hover'
    };
    
    const id = modeToId[mode];
    if (id) highlightElement(id);
  } else if (field === 'WHOLE_PAGE_SCROLL_STOP_DELAY') {
    highlightElement('WHOLE_PAGE_TRIGGER_MODE');
  }
};

const handleHighlightReveal = (event) => {
  if (event.detail === 'wholePageRules') revealWholePageRules.value = true;
};

const handleRevealIntent = (event) => {
  if (event.detail === 'wholePageRulesDrawer' && !isRulesDrawerOpen.value) openRulesDrawer();
};

onMounted(async () => {
  window.addEventListener('options-trigger-validation-feedback', handleValidationFeedback);
  window.addEventListener('options-reveal-accordion', handleHighlightReveal);
  window.addEventListener('options-reveal-intent', handleRevealIntent);
  window.addEventListener('keydown', handleKeyDown);
})

onUnmounted(() => {
  window.removeEventListener('options-trigger-validation-feedback', handleValidationFeedback);
  window.removeEventListener('options-reveal-accordion', handleHighlightReveal);
  window.removeEventListener('options-reveal-intent', handleRevealIntent);
  window.removeEventListener('keydown', handleKeyDown);
})

</script>
