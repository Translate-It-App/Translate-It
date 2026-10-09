<template>
  <div
    class="subtitle-app"
    :class="{ 'is-dark': isDark, 'is-rtl': t('IsRTL') === 'true' }"
  >
    <header class="app-header">
      <div class="logo">
        <img
          src="@/icons/ui/subtitle.svg"
          class="logo-icon"
          alt=""
          aria-hidden="true"
        >
        <div class="logo-text">
          <h1>{{ t('subtitle_app_title', 'Subtitle Translator') }}</h1>
          <span>{{ t('subtitle_app_powered_by', 'Powered by Translate It') }}</span>
        </div>
      </div>
      
      <div class="header-actions">
        <a
          v-if="status === 'completed'"
          :href="reportUrl"
          target="_blank"
          class="report-link fade-in"
          :title="t('subtitle_report_issue', 'Report issue in the translation of this subtitle file')"
        >
          <v-icon icon="mdi:github" />
          <span class="report-label">{{ t('subtitle_report_issue', 'Report Issue') }}</span>
        </a>
        <ThemeSelector />
      </div>
    </header>

    <main class="app-content">
      <div class="container">
        <!-- Step 1: Upload -->
        <section
          v-if="status === 'idle'"
          class="step-upload"
        >
          <SubtitleFileDropzone 
            v-model="currentFile" 
            @file-loaded="handleFileLoaded" 
          />
          
          <div
            v-if="fileContent"
            class="config-card fade-in"
          >
            <div class="config-grid">
              <div class="config-item language-pair">
                <label>{{ t('subtitle_languages_label', 'Translation Languages') }}</label>
                <LanguageSelector
                  v-model:source-language="config.sourceLanguage"
                  v-model:target-language="config.targetLanguage"
                  :provider="config.providerId"
                  :allow-auto="false"
                  :beta="settingsStore.settings.DEEPL_BETA_LANGUAGES_ENABLED"
                  :enable-select-element-integration="false"
                />
              </div>
              <div class="config-item">
                <label>{{ t('provider_label', 'Provider') }}</label>
                <div class="provider-selector-container">
                  <ProviderSelector 
                    v-model="config.providerId" 
                    mode="button"
                    :is-global="false"
                    required-feature="subtitle"
                    only-configured
                  />
                  <button 
                    class="icon-btn settings-link-btn" 
                    :title="t('configure_providers_tooltip', 'Configure Providers')"
                    @click="goToProviderSettings"
                  >
                    <v-icon icon="mdi:cog" />
                  </button>
                </div>
              </div>
            </div>

            <div class="actions">
              <button 
                class="primary-btn" 
                :disabled="!canTranslate"
                @click="startJob"
              >
                <v-icon icon="mdi:translate" />
                {{ t('subtitle_start_btn', 'Start Translation') }}
              </button>
            </div>

            <div
              v-if="cues.length > 0"
              class="preview-section"
            >
              <label class="section-label">{{ t('subtitle_preview_label', 'Preview (First 100 cues)') }}</label>
              <SubtitleViewer
                :cues="cues.slice(0, 100)"
                :item-height="80"
                :source-language="config.sourceLanguage"
                :target-language="config.targetLanguage"
              />
            </div>
          </div>
        </section>

        <!-- Step 2: Translating -->
        <section
          v-if="status === 'translating' || status === 'completed'"
          class="step-progress"
        >
          <SubtitleProgressPanel
            :progress="progress"
            :status="status"
            :filename="currentFile?.name"
          />

          <div
            v-if="status === 'completed'"
            class="complete-actions fade-in"
          >
            <button
              class="primary-btn success"
              @click="handleDownload(currentFile.name)"
            >
              <v-icon icon="mdi:download" />
              {{ t('subtitle_download_btn', 'Download Translated Subtitle') }}
            </button>
            <button
              v-if="isDownloaded"
              class="secondary-btn fade-in"
              @click="reset"
            >
              <v-icon icon="mdi:refresh" />
              {{ t('subtitle_another_file_btn', 'Translate Another File') }}
            </button>
          </div>

          <div class="live-view-section">
            <label class="section-label">{{ t('subtitle_live_view_label', 'Live Translation View') }}</label>
            <SubtitleViewer
              :cues="cues"
              :item-height="80"
              :source-language="config.sourceLanguage"
              :target-language="config.targetLanguage"
            />
          </div>

          <div
            v-if="status === 'translating'"
            class="actions"
          >
            <button
              class="secondary-btn"
              @click="cancelTranslation"
            >
              <v-icon icon="mdi:close" />
              {{ t('subtitle_cancel_btn', 'Cancel Job') }}
            </button>
          </div>
        </section>

        <!-- Error State -->
        <section
          v-if="status === 'error'"
          class="step-error fade-in"
        >
          <div class="error-card">
            <v-icon
              icon="mdi:alert-circle-outline"
              class="error-icon"
            />
            <h3>{{ t('subtitle_error_title', 'Oops! Something went wrong') }}</h3>
            <p>{{ error }}</p>
            <button
              v-if="errorAction === PublicTranslationErrorActions.RETRY"
              class="primary-btn"
              @click="status = 'idle'"
            >
              {{ t('subtitle_try_again_btn', 'Try Again') }}
            </button>
            <button
              v-if="errorAction === PublicTranslationErrorActions.OPEN_SETTINGS"
              class="secondary-btn"
              @click="goToProviderSettings"
            >
              {{ t('configure_providers_tooltip', 'Configure Providers') }}
            </button>
            <button
              v-if="errorAction !== PublicTranslationErrorActions.RETRY"
              class="secondary-btn"
              @click="backToSetup"
            >
              {{ t('subtitle_back_to_setup_btn', 'Back to Setup') }}
            </button>
          </div>
        </section>
      </div>
    </main>

    <footer class="app-footer">
      <p>&copy; 2026 {{ t('app_copyright', 'Translate It. All rights reserved.') }}</p>
    </footer>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { Icon as VIcon } from '@iconify/vue';
import browser from 'webextension-polyfill';
import SubtitleFileDropzone from '@/features/subtitle-translation/components/SubtitleFileDropzone.vue';
import SubtitleProgressPanel from '@/features/subtitle-translation/components/SubtitleProgressPanel.vue';
import SubtitleViewer from '@/features/subtitle-translation/components/SubtitleViewer.vue';
import { SubtitleParserFactory } from '@/features/subtitle-translation/parsers/SubtitleParserFactory.js';
import LanguageSelector from '@/components/shared/LanguageSelector.vue';
import ProviderSelector from '@/components/shared/ProviderSelector.vue';
import { useSubtitleTranslation } from '@/features/subtitle-translation/composables/useSubtitleTranslation.js';
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js';
import { useSettingsStore } from '@/features/settings/stores/settings.js';
import ThemeSelector from '@/apps/options/components/ThemeSelector.vue';
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js';
import { isProviderConfigured } from '@/features/translation/utils/providerValidator.js';
import { applyTheme } from '@/utils/ui/theme.js';
import { useResourceTracker } from '@/composables/core/useResourceTracker.js';
import { openOptionsPage } from '@/core/helpers.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { PublicTranslationErrorActions } from '@/shared/error-management/PublicTranslationError.js';

// --- Initialization & Setup ---
const logger = getScopedLogger(LOG_COMPONENTS.SUBTITLE, 'SubtitleApp');
const { t } = useUnifiedI18n();
const settingsStore = useSettingsStore();
const tracker = useResourceTracker('subtitle-app');

const isDark = computed(() => settingsStore.isDarkTheme);
const fileContent = ref('');
const isDownloaded = ref(false);

const {
  status,
  progress,
  error,
  errorAction,
  currentFile,
  cues,
  startTranslation,
  cancelTranslation,
  downloadResult: downloadResultOriginal,
  cleanup
} = useSubtitleTranslation();

/**
 * Redirects the user to the providers configuration page.
 */
const goToProviderSettings = async () => {
  try {
    const response = await openOptionsPage('providers');
    if (response?.success === false) {
      logger.error('Failed to open provider settings:', response.error || 'Unknown error');
    }
  } catch (err) {
    logger.error('Failed to open provider settings:', err);
  }
};

/**
 * Returns to setup without clearing the loaded subtitle state.
 */
const backToSetup = () => {
  status.value = 'idle';
};

/**
 * Enhanced download handler to track state.
 */
const handleDownload = (filename) => {
  downloadResultOriginal(filename);
  isDownloaded.value = true;
};

const config = reactive({
  sourceLanguage: '',
  targetLanguage: settingsStore.settings?.TARGET_LANGUAGE || 'en',
  providerId: settingsStore.settings.TRANSLATION_API || 'googlev2',
  options: { useContext: true }
});

// (Theme toggle handled by ThemeSelector component)

onMounted(async () => {
  try {
    // Load existing settings and initialize the theme
    await settingsStore.loadSettings();
    applyTheme(settingsStore.settings.THEME);

    // Set default target language from user settings
    if (settingsStore.settings?.TARGET_LANGUAGE) {
      config.targetLanguage = settingsStore.settings.TARGET_LANGUAGE;
    }

    // Sync provider with settings - Ensure it supports subtitles and is configured
    const defaultProviderId = settingsStore.settings.TRANSLATION_API || 'googlev2';
    const provider = findProviderById(defaultProviderId);
    
    const isSubtitleCapable = provider && provider.features?.includes('subtitle');
    const isConfigured = isProviderConfigured(defaultProviderId, settingsStore.settings);

    if (isSubtitleCapable && isConfigured) {
      config.providerId = defaultProviderId;
    } else {
      // Fallback to Google Translate if default doesn't support subtitles or isn't configured
      config.providerId = 'googlev2';
      logger.info('Default provider is incompatible or not configured for subtitles, falling back to Google Translate V2');
    }
    
    // Listen for theme changes from other options/extension pages
    tracker.addEventListener(browser.runtime.onMessage, 'addListener', (message) => {
      if (message && message.action === 'THEME_CHANGED') {
        if (message.payload?.theme) {
          applyTheme(message.payload.theme);
        }
      }
    });

    // Listen for system theme changes in auto mode
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    tracker.addEventListener(mediaQuery, 'change', () => {
      if (settingsStore.settings.THEME === 'auto') {
        applyTheme('auto');
      }
    });
  } catch (err) {
    logger.error('Failed to initialize settings/theme in SubtitleApp:', err);
  }
});

const handleFileLoaded = (content) => {
  fileContent.value = content;
  
  if (content && currentFile.value) {
    try {
      const adapter = SubtitleParserFactory.getAdapter(currentFile.value.name);
      const { cues: parsedCues } = adapter.parse(content);
      cues.value = parsedCues;
    } catch (err) {
      logger.error('Failed to parse subtitle for preview:', err);
    }
  }
};

const canTranslate = computed(() => {
  return (
    fileContent.value && 
    config.sourceLanguage && 
    config.targetLanguage && 
    config.providerId && 
    config.sourceLanguage !== config.targetLanguage
  );
});

/**
 * Generates a pre-filled GitHub issue URL for reporting subtitle issues.
 * Includes structured template with technical metadata.
 */
const reportUrl = computed(() => {
  const baseUrl = 'https://github.com/Translate-It-App/Translate-It/issues/new';
  const fileName = currentFile.value?.name || 'unknown.srt';
  const source = config.sourceLanguage || 'auto';
  const target = config.targetLanguage;
  const provider = config.providerId;
  
  // Get technical metadata
  const manifest = browser.runtime.getManifest();
  const version = manifest.version;
  const userAgent = navigator.userAgent;
  const browserName = userAgent.includes('Firefox') ? 'Firefox' : 'Chrome/Edge';

  const title = encodeURIComponent(`[Subtitle Issue] ${fileName} (${source} -> ${target})`);
  
  const body = encodeURIComponent(
    `### 🔍 Technical Details\n` +
    `- **Extension Version:** ${version}\n` +
    `- **Browser:** ${browserName}\n` +
    `- **File Name:** ${fileName}\n` +
    `- **Language Pair:** ${source} -> ${target}\n` +
    `- **Provider:** ${provider}\n\n` +
    `### Description\n` +
    `${t('subtitle_report_description_placeholder', '[Please describe the issue with formatting or translation here. Please drag and drop your problematic .srt file into this issue to help us investigate.]')}`
  );

  return `${baseUrl}?title=${title}&body=${body}`;
});

const startJob = () => {
  startTranslation(fileContent.value, currentFile.value.name, config);
};

const reset = () => {
  status.value = 'idle';
  currentFile.value = null;
  fileContent.value = '';
  cues.value = [];
  isDownloaded.value = false;
};

onUnmounted(() => {
  cleanup();
});
</script>

<style lang="scss">
@use '../../assets/styles/base/brand-tokens' as *;
@use '../../assets/styles/base/mixins' as *;

:root {
  --primary-color: #6366f1;
  --primary-glow: rgba(99, 102, 241, 0.15);
  --success-color: #10b981;
  --error-color: #ef4444;
  
  /* Light theme default colors */
  --bg-app: #f8fafc;
  --bg-card: #ffffff;
  --border-color: rgba(0, 0, 0, 0.08);
  --text-primary: #0f172a;
  --text-secondary: #64748b;
  --bg-header: rgba(248, 250, 252, 0.8);
  @include css-properties('logo-text-gradient', (
    'start': $brand-title-gradient-light-start,
    'end': $brand-title-gradient-light-end
  ));
  --btn-secondary-bg: rgba(0, 0, 0, 0.03);
  --btn-secondary-bg-hover: rgba(0, 0, 0, 0.06);
  --bg-glass: rgba(0, 0, 0, 0.02);
  --bg-glass-hover: rgba(0, 0, 0, 0.04);
  --progress-track-bg: rgba(0, 0, 0, 0.05);
}

/* Dark theme overrides */
:root.theme-dark, .theme-dark, .is-dark {
  --bg-app: #0f172a;
  --bg-card: rgba(30, 41, 59, 0.7);
  --border-color: rgba(255, 255, 255, 0.1);
  --text-primary: #f8fafc;
  --text-secondary: #94a3b8;
  --bg-header: rgba(15, 23, 42, 0.8);
  @include css-properties('logo-text-gradient', (
    'start': $brand-title-gradient-dark-start,
    'end': $brand-title-gradient-dark-end
  ));
  --btn-secondary-bg: rgba(255, 255, 255, 0.05);
  --btn-secondary-bg-hover: rgba(255, 255, 255, 0.1);
  --bg-glass: rgba(255, 255, 255, 0.03);
  --bg-glass-hover: rgba(255, 255, 255, 0.05);
  --progress-track-bg: rgba(255, 255, 255, 0.1);
}

.subtitle-app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  transition: background-color 0.3s ease;
  background-color: var(--bg-app);
  color: var(--text-primary);

  &.is-rtl {
    direction: rtl;
    text-align: right;

    .config-card .config-grid .config-item label {
      text-align: right;
    }

    .primary-btn, .secondary-btn {
      flex-direction: row-reverse;
    }
    
    .logo-text {
      text-align: right;
    }
  }

  .app-header {
    padding: 1.5rem 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-header);
    backdrop-filter: blur(12px);
    position: sticky;
    top: 0;
    z-index: 50;

    .logo {
      display: flex;
      align-items: center;
      gap: 1rem;

      .logo-icon {
        width: 2.5rem;
        height: 2.5rem;
        object-fit: contain;
      }

      .logo-text {
        h1 {
          font-size: 1.25rem;
          margin: 0;
          font-weight: 700;
          background: linear-gradient(90deg, var(--logo-text-gradient-start), var(--logo-text-gradient-end));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        span {
          font-size: 0.75rem;
          color: var(--text-secondary);
        }
      }
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 1rem;

      .theme-selector-container {
        width: auto;
        padding: 0;

        .theme-cycle-btn {
          min-width: auto;
          padding: 0;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          justify-content: center;
          background: var(--btn-secondary-bg);
          border: 1px solid var(--border-color);

          &:hover {
            background: var(--btn-secondary-bg-hover);
          }

          .theme-btn-label {
            display: none;
          }
          
          .icon-wrapper {
            margin: 0;
          }
        }
      }

      .report-link {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        border-radius: 10px;
        background: var(--btn-secondary-bg);
        border: 1px solid var(--border-color);
        color: var(--text-primary);
        text-decoration: none;
        font-size: 0.85rem;
        font-weight: 600;
        transition: all 0.2s ease;
        white-space: nowrap;
        flex-shrink: 0;

        &:hover {
          background: var(--btn-secondary-bg-hover);
          transform: translateY(-1px);
        }

        .report-label {
          @media (max-width: 800px) {
            display: none;
          }
        }
      }
    }
  }

  .app-content {
    flex: 1;
    padding: 3rem 1rem;

    .container {
      max-width: 900px;
      margin: 0 auto;
    }
  }

  .section-label {
    display: block;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text-secondary);
    margin-bottom: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .preview-section, .live-view-section {
    margin-top: 2rem;
    animation: fadeIn 0.5s ease-out forwards;
  }

  .config-card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 20px;
    padding: 2rem;
    margin-top: 1rem;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05);
    transition: all 0.3s ease;
    position: relative;
    z-index: 1;

    &:focus-within {
      z-index: 101;
    }

    :root.theme-dark &, .theme-dark &, .is-dark & {
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
    }

    .config-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 2rem;
      margin-bottom: 2rem;

      .config-item {
        &.language-pair {
          grid-column: span 2;
          text-align: center;
          
          @media (max-width: 600px) {
            grid-column: span 1;
          }

          label {
            text-align: center !important;
          }

          .ti-language-controls {
            justify-content: center !important;
            margin: 0.5rem auto 0 auto !important;
            background: transparent !important;
            padding: 0 !important;
          }
        }

        label {
          display: block;
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--text-secondary);
          margin-bottom: 0.75rem;
        }

        .provider-selector-container {
          display: flex;
          align-items: center;
          gap: 0.75rem;

          > *:first-child {
            flex: 1;
          }

          .settings-link-btn {
            flex-shrink: 0;
            width: 40px;
            height: 40px;
          }
        }
      }
    }
  }

  .actions {
    display: flex;
    justify-content: center;
    gap: 1rem;
  }

  .complete-actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
  }

  .primary-btn {
    padding: 0.85rem 2rem;
    border-radius: 12px;
    background: var(--primary-color);
    color: #fff;
    border: none;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    transition: all 0.2s ease;

    &:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px var(--primary-glow);
      filter: brightness(1.1);
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    &.success {
      background: var(--success-color);
      color: #0f172a; /* Dark text for better contrast on success background */
      padding: 1rem 3rem;
      font-size: 1.1rem;
    }
  }

  .secondary-btn {
    padding: 0.85rem 2rem;
    border-radius: 12px;
    background: var(--btn-secondary-bg);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    transition: all 0.2s ease;

    &:hover {
      background: var(--btn-secondary-bg-hover);
    }
  }

  .icon-btn {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--btn-secondary-bg);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 1.25rem;

    &:hover {
      background: var(--btn-secondary-bg-hover);
      transform: scale(1.05);
    }
    
    &:active {
      transform: scale(0.95);
    }
  }

  .error-card {
    text-align: center;
    padding: 3rem;
    background: rgba(239, 68, 68, 0.05);
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-radius: 20px;

    .error-icon {
      font-size: 4rem;
      color: var(--error-color);
      margin-bottom: 1rem;
    }

    h3 {
      font-size: 1.5rem;
      margin-bottom: 1rem;
    }

    p {
      color: var(--text-secondary);
      margin-bottom: 2rem;
    }
  }

  .app-footer {
    padding: 2rem;
    text-align: center;
    border-top: 1px solid var(--border-color);
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
}

.fade-in {
  animation: fadeIn 0.5s ease-out forwards;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
