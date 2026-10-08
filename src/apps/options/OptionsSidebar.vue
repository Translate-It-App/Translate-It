<template>
  <aside class="options-sidebar">
    <div
      v-if="sidebarError"
      class="sidebar-error"
    >
      <h2>Sidebar Error</h2>
      <pre>{{ sidebarError }}</pre>
    </div>
    <div
      v-else
      class="sidebar-content"
    >
      <div class="sidebar-header">
        <a
          :href="REPO_URLS.WEBSITE_MAIN"
          target="_blank"
          rel="noopener noreferrer"
          class="header-logo-link"
        >
          <h1>{{ t('name') }}</h1>
          <span>{{ manifestVersion }}</span>
        </a>
        <p>{{ t('options_description', 'Translate the web, your way.') }}</p>
      </div>
      
      <div class="sidebar-section theme-controls">
        <ThemeSelector />
      </div>

      <div class="sidebar-section localization-controls">
        <h2>{{ t('localization_section_title') }}</h2>
        
        <!-- Desktop Language List -->
        <div class="desktop-only">
          <InterfaceLocaleSelector mode="list" />
        </div>

        <!-- Mobile Language Dropdown -->
        <div class="mobile-only">
          <InterfaceLocaleSelector mode="dropdown" />
        </div>
      </div>

      <a 
        id="SUBTITLE_TRANSLATOR"
        href="#"
        class="sidebar-section app-link-section"
        :aria-label="t('open_subtitle_translator', 'Subtitle Translator')"
        @click.prevent="openSubtitlePage"
      >
        <img
          src="@/icons/ui/subtitle.svg"
          class="app-link-icon"
          alt=""
          aria-hidden="true"
        >
        <span class="app-link-label">{{ t('open_subtitle_translator', 'Subtitle Translator') }}</span>
      </a>

      <a 
        id="PDF_TRANSLATOR"
        href="#"
        class="sidebar-section app-link-section"
        @click.prevent="openPdfPage"
      >
        <img
          src="@/icons/ui/pdf_viewer/pdf.png"
          class="app-link-icon"
          alt="PDF"
        >
        <span class="app-link-label">{{ t('pdf_app_title', 'PDF Translator') }}</span>
      </a>

      <div class="sidebar-footer">
        <div class="footer-icon-links">
          <a
            :href="REPO_URLS.GITHUB_MAIN"
            target="_blank"
            rel="noopener noreferrer"
            :title="t('github_link_title') || 'GitHub'"
          >
            <img
              src="@/icons/ui/github.svg"
              alt="GitHub"
              height="22"
              class="footer-icon github-icon"
            >
          </a>
          <a
            :href="REPO_URLS.WEBSITE_MAIN"
            target="_blank"
            rel="noopener noreferrer"
            title="Translate It Website"
          >
            <img
              src="@/icons/extension/extension_icon_64.png"
              alt="Translate It Website"
              height="22"
              class="footer-icon"
            >
          </a>
        </div>
        <p>
          <span>Translate It &copy; {{ copyrightYear }}</span>
        </p>
      </div>
    </div>
  </aside>
</template>

<script setup>
import './OptionsSidebar.scss'
import { ref, computed, onMounted } from 'vue'
import browser from 'webextension-polyfill'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'
import { REPO_URLS } from '@/shared/constants/core.js'
import { openExtensionApp } from '@/core/ExtensionAppLauncher.js'
import ThemeSelector from './components/ThemeSelector.vue'
import InterfaceLocaleSelector from './components/InterfaceLocaleSelector.vue'

// Logger
const logger = getScopedLogger(LOG_COMPONENTS.UI, 'OptionsSidebar')

// Composables
const { t } = useUnifiedI18n()

// State
const sidebarError = ref('')
const manifestVersion = ref('v0.0.0')

// --- Computed Properties ---

// Dynamic copyright year logic based on build time
const copyrightYear = computed(() => {
  const startYear = 2025
  const buildYear = typeof __BUILD_YEAR__ !== 'undefined' ? __BUILD_YEAR__ : startYear
  return buildYear > startYear ? `${startYear}-${buildYear}` : `${startYear}`
})

// --- Lifecycle ---

onMounted(async () => {
  try {
    const manifest = browser.runtime.getManifest()
    manifestVersion.value = `v${manifest.version}`
  } catch (error) {
    logger.warn('Failed to get manifest version:', error)
    sidebarError.value = error?.message || String(error)
  }
})

const openApp = async (appName) => {
  try {
    await openExtensionApp(appName)
  } catch (error) {
    logger.error(`Failed to open ${appName} page:`, error)
  }
}

const openPdfPage = () => openApp('pdf')
const openSubtitlePage = () => openApp('subtitle')
</script>
