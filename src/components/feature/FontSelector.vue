<template>
  <div class="font-selector">
    <!-- Font Family Selector -->
    <div class="font-group">
      <label for="font-family-search">{{ t('font_family_label') || 'Font Family' }}</label>
      
      <!-- Searchable Font Selector -->
      <div
        ref="fontDropdownRef"
        class="font-search-container"
      >
        <div
          class="font-dropdown"
          :class="{ 'is-open': isDropdownOpen }"
        >
          <div class="font-input-wrapper">
            <input
              id="font-family-search"
              ref="fontSearchInput"
              v-model="searchQuery"
              type="text"
              class="font-search-input"
              :placeholder="selectedFontName || t('search_fonts_placeholder', 'Search fonts...')"
              autocomplete="off"
              @focus="openDropdown"
              @blur="closeDropdownDelayed"
              @input="handleSearch"
              @keydown="handleKeydown"
            >
            <div
              class="font-dropdown-arrow"
              @click="toggleDropdown"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
              >
                <path
                  d="M6 8L2 4h8z"
                  fill="currentColor"
                />
              </svg>
            </div>
          </div>
          
          <!-- Loading state -->
          <div
            v-if="isLoadingFonts"
            class="font-loading"
          >
            <div class="loading-spinner" />
            <span>{{ t('loading_fonts', 'Loading fonts...') }}</span>
          </div>
          
          <!-- Dropdown Options -->
          <div
            v-else-if="isDropdownOpen"
            class="font-options-container"
          >
            <div
              ref="fontOptionsRef"
              class="font-options"
            >
              <div
                v-for="(font, index) in filteredFonts"
                :key="generateFontKey(font, index)"
                :class="[
                  'font-option',
                  { 
                    'is-selected': font.value === localFontFamily,
                    'is-highlighted': index === highlightedIndex,
                    'is-system': font.isSystemFont 
                  }
                ]"
                @click="selectFont(font)"
                @mouseenter="highlightedIndex = index"
              >
                <div class="font-option-content">
                  <span
                    class="font-name"
                    :style="{ fontFamily: getFontPreviewFamily(font) }"
                  >
                    {{ font.name }}
                  </span>
                  <span class="font-category">{{ font.category }}</span>
                </div>
                <div
                  v-if="font.isSystemFont"
                  class="font-system-badge"
                >
                  {{ t('system_font', 'System') }}
                </div>
              </div>
              
              <!-- No results message -->
              <div
                v-if="filteredFonts.length === 0 && searchQuery"
                class="font-no-results"
              >
                {{ t('no_fonts_found', 'No fonts found') }}
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <div class="font-description">
        {{ selectedFontDescription }}
      </div>
    </div>

    <slot name="after-font-family" />

    <!-- Font Size Selector -->
    <div class="font-group">
      <label for="font-size-select">{{ t('font_size_label') || 'Font Size' }}</label>
      <select 
        id="font-size-select"
        v-model="localFontSize"
        class="font-select"
      >
        <option 
          v-for="size in fontSizeOptions" 
          :key="size.value" 
          :value="size.value"
        >
          {{ size.name }}
        </option>
      </select>
    </div>

    <!-- Font Preview -->
    <div class="font-preview">
      <div class="preview-label">
        {{ t('font_preview_label') || 'Preview' }}
      </div>
      <div 
        class="preview-text"
        :style="previewStyle"
      >
        {{ previewText }}
      </div>
    </div>

    <!-- Validation Error -->
    <div
      v-if="error"
      class="error-message"
    >
      {{ error }}
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import './FontSelector.scss'
import { CONFIG } from '@/shared/config/config.js'
import { useUnifiedI18n } from '@/composables/shared/useUnifiedI18n.js'
import { systemFontDetector } from '@/shared/fonts/SystemFontDetector.js'
import { LanguageDetectionService } from '@/shared/services/LanguageDetectionService.js'
import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'

const logger = getScopedLogger(LOG_COMPONENTS.UI, 'FontSelector')

const props = defineProps({
  fontFamily: {
    type: String,
    default: 'auto'
  },
  fontSize: {
    type: String,
    default: '14'
  },
  targetLanguage: {
    type: String,
    default: 'English'
  }
})

const emit = defineEmits(['update:font-family', 'update:font-size'])

const { t } = useUnifiedI18n()

// Refs
const fontSearchInput = ref(null)
const fontOptionsRef = ref(null)
const fontDropdownRef = ref(null)

// Local reactive values
const localFontFamily = ref(props.fontFamily)
const localFontSize = ref(props.fontSize)
const error = ref('')
const searchQuery = ref('')
const isDropdownOpen = ref(false)
const isLoadingFonts = ref(false)
const availableFonts = ref([])
const filteredFonts = ref([])
const highlightedIndex = ref(-1)
const closeTimer = ref(null)

// Font size options from config
const fontSizeOptions = computed(() => CONFIG.FONT_SIZE_OPTIONS || [])

// Computed properties
const selectedFont = computed(() => {
  return availableFonts.value.find(f => f.value === localFontFamily.value) ||
    systemFontDetector.getFontMetadata(localFontFamily.value)
})

const selectedFontName = computed(() => {
  return selectedFont.value?.name || ''
})

const selectedFontDescription = computed(() => {
  const font = selectedFont.value
  if (!font) return ''
  
  let description = font.category || ''
  if (font.isSystemFont) {
    description += description ? ' • System Font' : 'System Font'
  }
  return description
})

// Preview text based on target language
const previewText = computed(() => {
  return [
    'این متن نمونه‌ای برای پیش‌نمایش فونت است', // Farsi
    'This is a sample text for font preview', // English
    '这是一个用于字体预览的示例文本', // Chinese
    'Este es un texto de muestra para la vista previa de la fuente', // Spanish
    'これはフォントプレビュー用のサンプルテキストです', // Japanese
    '이것은 글꼴 미리보기를 위한 샘플 텍스트입니다', // Korean
  ].join('\n\n')
})


// Methods
const loadFonts = async () => {
  if (isLoadingFonts.value || availableFonts.value.length > 0) return
  
  try {
    isLoadingFonts.value = true
    
    const fonts = await systemFontDetector.getAvailableFonts()
    availableFonts.value = fonts
    filteredFonts.value = fonts.slice(0, 20) // Initial limit
    
  } catch (error) {
    logger.error('Failed to load fonts:', error)
    error.value = t('font_loading_error', 'Failed to load fonts')
  } finally {
    isLoadingFonts.value = false
  }
}

const handleSearch = async () => {
  if (!searchQuery.value.trim()) {
    filteredFonts.value = availableFonts.value.slice(0, 20)
    return
  }
  
  try {
    const results = await systemFontDetector.searchFonts(searchQuery.value, 50)
    filteredFonts.value = results
    highlightedIndex.value = -1
  } catch (error) {
    logger.error('Font search failed:', error)
  }
}

const openDropdown = async () => {
  if (isDropdownOpen.value) return
  
  clearTimeout(closeTimer.value)
  isDropdownOpen.value = true
  
  // Load fonts when dropdown opens (lazy loading)
  if (availableFonts.value.length === 0) {
    await loadFonts()
  }
  
  // Focus search input
  await nextTick()
  fontSearchInput.value?.focus()
}

const closeDropdownDelayed = () => {
  closeTimer.value = setTimeout(() => {
    isDropdownOpen.value = false
    searchQuery.value = ''
    highlightedIndex.value = -1
  }, 150)
}

const toggleDropdown = () => {
  if (isDropdownOpen.value) {
    isDropdownOpen.value = false
    searchQuery.value = ''
  } else {
    openDropdown()
  }
}

const selectFont = (font) => {
  localFontFamily.value = font.value
  isDropdownOpen.value = false
  searchQuery.value = ''
  highlightedIndex.value = -1
  clearTimeout(closeTimer.value)
  
}

const handleKeydown = (event) => {
  if (!isDropdownOpen.value) return
  
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      highlightedIndex.value = Math.min(
        highlightedIndex.value + 1,
        filteredFonts.value.length - 1
      )
      scrollToHighlighted()
      break
      
    case 'ArrowUp':
      event.preventDefault()
      highlightedIndex.value = Math.max(highlightedIndex.value - 1, -1)
      scrollToHighlighted()
      break
      
    case 'Enter':
      event.preventDefault()
      if (highlightedIndex.value >= 0) {
        selectFont(filteredFonts.value[highlightedIndex.value])
      }
      break
      
    case 'Escape':
      event.preventDefault()
      isDropdownOpen.value = false
      searchQuery.value = ''
      fontSearchInput.value?.blur()
      break
  }
}

const scrollToHighlighted = async () => {
  await nextTick()
  const container = fontOptionsRef.value
  const highlighted = container?.querySelector('.font-option.is-highlighted')
  
  if (container && highlighted) {
    const containerRect = container.getBoundingClientRect()
    const highlightedRect = highlighted.getBoundingClientRect()
    
    if (highlightedRect.bottom > containerRect.bottom) {
      container.scrollTop += highlightedRect.bottom - containerRect.bottom + 5
    } else if (highlightedRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - highlightedRect.top + 5
    }
  }
}

const getFontPreviewFamily = (font) => {
  return systemFontDetector.getFontCSSFamily(font.value)
}

const generateFontKey = (font, index) => {
  return systemFontDetector.generateFontKey(font, index)
}

// Generate CSS for font family (updated to use system fonts)
const getFontFamilyCSS = (fontValue) => {
  return systemFontDetector.getFontCSSFamily(fontValue)
}

// Preview style
const previewStyle = computed(() => ({
  fontFamily: getFontFamilyCSS(localFontFamily.value),
  fontSize: `${localFontSize.value}px`,
  lineHeight: '1.5',
  direction: LanguageDetectionService.isRTL(props.targetLanguage) ? 'rtl' : 'ltr',
  textAlign: 'center'
}))

// Watch for prop changes and update local values
watch(() => props.fontFamily, (newVal) => {
  localFontFamily.value = newVal
})

watch(() => props.fontSize, (newVal) => {
  localFontSize.value = newVal
})

// Emit changes
watch(localFontFamily, (newVal) => {
  emit('update:font-family', newVal)
})

watch(localFontSize, (newVal) => {
  emit('update:font-size', newVal)
})

// Validation
const validate = () => {
  error.value = ''
  
  if (!localFontFamily.value) {
    error.value = t('font_family_required') || 'Font family is required'
    return false
  }
  
  if (!localFontSize.value || isNaN(parseInt(localFontSize.value))) {
    error.value = t('font_size_invalid') || 'Font size must be a valid number'
    return false
  }
  
  const sizeNum = parseInt(localFontSize.value)
  if (sizeNum < 10 || sizeNum > 30) {
    error.value = t('font_size_range_error') || 'Font size must be between 10 and 30 pixels'
    return false
  }
  
  return true
}

// Debounced search (optimized for better UX)
let searchTimeout = null
watch(searchQuery, () => {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(handleSearch, 150) // Reduced debounce for faster response
})

// Click outside to close dropdown
const handleClickOutside = (event) => {
  if (fontDropdownRef.value && !fontDropdownRef.value.contains(event.target)) {
    isDropdownOpen.value = false
    searchQuery.value = ''
  }
}

// Lifecycle hooks
onMounted(() => {
  validate()
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  clearTimeout(closeTimer.value)
  clearTimeout(searchTimeout)
  document.removeEventListener('click', handleClickOutside)
})

// Expose validation method
defineExpose({
  validate,
  loadFonts
})
</script>
