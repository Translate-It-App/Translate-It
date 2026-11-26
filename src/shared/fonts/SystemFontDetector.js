/**
 * SystemFontDetector.js - System font detection service
 * Detects available system fonts using various browser APIs
 */

import { getScopedLogger } from '@/shared/logging/logger.js'
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js'

const logger = getScopedLogger(LOG_COMPONENTS.UI, 'SystemFontDetector');

class SystemFontDetector {
  constructor() {
    this.cachedFonts = null
    this.isDetecting = false
    this.detectionPromise = null
    
    // Common system fonts as fallback
    this.fallbackFonts = [
      { name: 'Auto (Smart Detection)', value: 'auto', category: 'smart' },
      { name: 'System Default', value: 'system', category: 'system' },
      { name: 'Arial', value: 'arial', category: 'sans-serif' },
      { name: 'Times New Roman', value: 'times', category: 'serif' },
      { name: 'Georgia', value: 'georgia', category: 'serif' },
      { name: 'Tahoma', value: 'tahoma', category: 'sans-serif' },
      { name: 'Segoe UI', value: 'segoe-ui', category: 'sans-serif' },
      { name: 'Roboto', value: 'roboto', category: 'sans-serif' },
      { name: 'Vazirmatn (Persian)', value: 'vazirmatn', category: 'persian' },
      { name: 'Noto Sans', value: 'noto-sans', category: 'multilingual' }
    ]
    
    // List of fonts to test for availability
    this.testFonts = [
      // System fonts
      'Arial', 'Arial Black', 'Arial Narrow', 'Arial Rounded MT Bold',
      'Calibri', 'Cambria', 'Consolas', 'Comic Sans MS', 'Courier New',
      'Franklin Gothic Medium', 'Georgia', 'Impact', 'Lucida Console',
      'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype',
      'Segoe UI', 'Segoe Print', 'Symbol', 'Tahoma', 'Times New Roman',
      'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings',
      
      // Google Fonts commonly installed
      'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Source Sans Pro',
      'Raleway', 'Ubuntu', 'Nunito', 'Playfair Display', 'Inter',
      
      // Persian/Arabic fonts
      'Vazirmatn', 'Vazir', 'Iran Sans', 'Yekan', 'Samim', 'Sahel',
      'Shabnam', 'Tanha', 'IranNastaliq', 'B Nazanin', 'B Titr',
      'Noto Sans Arabic', 'Arial Unicode MS',
      
      // Mac/iOS fonts
      'San Francisco', 'Helvetica Neue', 'Helvetica', 'Avenir',
      'Avenir Next', 'Futura', 'Gill Sans', 'Optima', 'Palatino',
      'American Typewriter', 'Baskerville', 'Big Caslon',
      
      // Android/Mobile-specific fonts
      'Roboto', 'Noto Sans', 'Droid Sans', 'SamsungOne', 'MiSans', 
      'OnePlus Sans', 'Oppo Sans', 'Vivo Sans',

      // Linux fonts
      'DejaVu Sans', 'DejaVu Serif', 'Liberation Sans', 'Liberation Serif',
      'Ubuntu', 'FreeSans', 'FreeSerif'
    ]
  }

  /**
   * Get available system fonts with lazy loading
   * @param {boolean} forceRefresh - Force refresh cached fonts
   * @returns {Promise<Array>} List of available fonts
   */
  async getAvailableFonts(forceRefresh = false) {
    if (this.cachedFonts && !forceRefresh) {
      logger.debug('Returning cached fonts:', this.cachedFonts.length)
      return this.cachedFonts
    }

    if (this.isDetecting) {
      logger.debug('Font detection already in progress, returning existing promise')
      return await this.detectionPromise
    }

    this.isDetecting = true
    this.detectionPromise = this._detectSystemFonts()
    
    try {
      const fonts = await this.detectionPromise
      this.cachedFonts = fonts
      logger.info('System fonts detected successfully:', fonts.length)
      return fonts
    } catch (error) {
      logger.error('Font detection failed:', error)
      return this.fallbackFonts
    } finally {
      this.isDetecting = false
      this.detectionPromise = null
    }
  }

  /**
   * Internal font detection method
   * @returns {Promise<Array>} Detected fonts
   */
  async _detectSystemFonts() {
    const detectedFonts = new Set()
    
    try {
      // Method 1: Use document.fonts API if available
      if (typeof document !== 'undefined' && document.fonts && document.fonts.check) {
        logger.debug('Using document.fonts API for detection')
        const fontPromises = this.testFonts.map(async (fontName) => {
          try {
            const isAvailable = await this._checkFontAvailability(fontName)
            if (isAvailable) {
              detectedFonts.add(fontName)
            }
          } catch (error) {
            logger.debug(`Font check failed for ${fontName}:`, error)
          }
        })
        
        // Process fonts in batches to avoid overwhelming the browser
        const batchSize = 10
        for (let i = 0; i < fontPromises.length; i += batchSize) {
          const batch = fontPromises.slice(i, i + batchSize)
          await Promise.all(batch)
          
          // Small delay to prevent blocking
          if (i + batchSize < fontPromises.length) {
            await new Promise(resolve => setTimeout(resolve, 5))
          }
        }
      }
      
      // Method 2: Canvas-based detection as fallback
      if (detectedFonts.size === 0) {
        logger.debug('Falling back to canvas-based detection')
        this.testFonts.forEach(fontName => {
          if (this._isSystemFontAvailable(fontName)) {
            detectedFonts.add(fontName)
          }
        })
      }
      
    } catch (error) {
      logger.warn('Font detection error:', error)
    }

    // Convert to structured format
    const fonts = [...this.fallbackFonts]
    
    // Add detected system fonts, avoiding duplicates by both name and value
    const sortedFonts = Array.from(detectedFonts).sort()
    sortedFonts.forEach(fontName => {
      const fontValue = this._sanitizeFontValue(fontName)
      
      // Check for duplicates by both name and value
      const isDuplicate = fonts.some(f => 
        f.name === fontName || 
        f.value === fontValue ||
        f.name.toLowerCase() === fontName.toLowerCase()
      )
      
      if (!isDuplicate) {
        fonts.push({
          name: fontName,
          value: fontValue,
          category: this._categorizeFontName(fontName),
          isSystemFont: true
        })
      } else {
        logger.debug(`Skipping duplicate font: ${fontName} (value: ${fontValue})`)
      }
    })

    logger.debug('Final font list prepared:', fonts.length)
    return fonts
  }

  /**
   * Check font availability using document.fonts.check
   * @param {string} fontName - Font name to check
   * @returns {Promise<boolean>} Font availability
   */
  async _checkFontAvailability(fontName) {
    if (!document.fonts || !document.fonts.check) {
      return false
    }

    try {
      // Check if font is available for common text
      const sizes = ['12px', '16px']
      for (const size of sizes) {
        const fontSpec = `${size} "${fontName}", monospace`
        if (document.fonts.check(fontSpec, 'A')) {
          return true
        }
      }
      return false
        } catch {
      return false
    }
  }

  /**
   * Canvas-based font detection (fallback method)
   * @param {string} fontName - Font name to check
   * @returns {boolean} Font availability
   */
  _isSystemFontAvailable(fontName) {
    if (typeof document === 'undefined') return false
    
    try {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      
      const testText = 'mmmmmmmmmmlli'
      const testSize = '72px'
      const fallbackFont = 'monospace'
      
      // Measure text with fallback font
      context.font = `${testSize} ${fallbackFont}`
      const fallbackWidth = context.measureText(testText).width
      
      // Measure text with target font + fallback
      context.font = `${testSize} "${fontName}", ${fallbackFont}`
      const testWidth = context.measureText(testText).width
      
      // If widths differ, the font is available
      return Math.abs(testWidth - fallbackWidth) > 1
        } catch {
      return false
    }
  }

  /**
   * Sanitize font name for CSS value
   * @param {string} fontName - Original font name
   * @returns {string} Sanitized value
   */
  _sanitizeFontValue(fontName) {
    return fontName.toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
  }

  /**
   * Categorize font by name patterns
   * @param {string} fontName - Font name
   * @returns {string} Font category
   */
  _categorizeFontName(fontName) {
    const name = fontName.toLowerCase()
    
    if (name.includes('sans') || name.includes('arial') || name.includes('helvetica')) {
      return 'sans-serif'
    }
    if (name.includes('serif') || name.includes('times') || name.includes('georgia')) {
      return 'serif'
    }
    if (name.includes('mono') || name.includes('consola') || name.includes('courier')) {
      return 'monospace'
    }
    if (name.includes('vazir') || name.includes('iran') || name.includes('persian') || 
        name.includes('arabic') || name.includes('nastaliq')) {
      return 'persian'
    }
    if (name.includes('noto') || name.includes('unicode')) {
      return 'multilingual'
    }
    
    return 'other'
  }

  /**
   * Search fonts by query
   * @param {string} query - Search query
   * @param {number} limit - Maximum results
   * @returns {Promise<Array>} Filtered fonts
   */
  async searchFonts(query = '', limit = 50) {
    const allFonts = await this.getAvailableFonts()
    
    if (!query.trim()) {
      return allFonts.slice(0, limit)
    }
    
    const searchTerm = query.toLowerCase()
    const filtered = allFonts.filter(font => 
      font.name.toLowerCase().includes(searchTerm) ||
      font.category.includes(searchTerm)
    )
    
    return filtered.slice(0, limit)
  }

  /**
   * Resolve display metadata for a font value without running font detection.
   * Uses detected fonts when cached, then the predefined fonts, then the known
   * system-font catalog. Catalog and unknown fonts are not marked as system
   * fonts because their availability has not been verified.
   * @param {string} fontValue - Saved font value
   * @returns {Object|null} Font metadata ({ name, value, category, isSystemFont? })
   */
  getFontMetadata(fontValue) {
    if (!fontValue) return null

    const knownFont = this.cachedFonts?.find(f => f.value === fontValue) ||
      this.fallbackFonts.find(f => f.value === fontValue)
    if (knownFont) return knownFont

    const catalogFont = this.testFonts.find(name => this._sanitizeFontValue(name) === fontValue)
    if (catalogFont) {
      return {
        name: catalogFont,
        value: fontValue,
        category: this._categorizeFontName(catalogFont)
      }
    }

    return { name: fontValue, value: fontValue, category: '' }
  }

  /**
   * Get font CSS family string
   * @param {string} fontValue - Font value
   * @returns {string} CSS font-family string
   */
  getFontCSSFamily(fontValue) {
    if (fontValue === 'auto') {
      return 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'
    }
    if (fontValue === 'system') {
      return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto'
    }
    
    // For system fonts, create proper font stack
    const font = this.cachedFonts?.find(f => f.value === fontValue)
    if (font && font.isSystemFont) {
      const fallback = this._getFallbackByCategory(font.category)
      return `"${font.name}", ${fallback}`
    }
    
    // Legacy static fonts
    const staticFonts = {
      'vazirmatn': '"Vazirmatn", "Vazir", Tahoma, Arial, sans-serif',
      'noto-sans': '"Noto Sans", "Noto Sans Arabic", "Noto Sans CJK", Arial, sans-serif',
      'arial': 'Arial, Helvetica, sans-serif',
      'times': '"Times New Roman", Times, serif',
      'georgia': 'Georgia, Times, serif',
      'tahoma': 'Tahoma, Geneva, sans-serif',
      'segoe-ui': '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
      'roboto': 'Roboto, Arial, sans-serif'
    }

    if (staticFonts[fontValue]) {
      return staticFonts[fontValue]
    }

    const catalogFont = this.testFonts.find(name => this._sanitizeFontValue(name) === fontValue)
    if (catalogFont) {
      const fallback = this._getFallbackByCategory(this._categorizeFontName(catalogFont))
      return `"${catalogFont}", ${fallback}`
    }

    return 'system-ui, sans-serif'
  }

  /**
   * Get fallback fonts by category
   * @param {string} category - Font category
   * @returns {string} Fallback font stack
   */
  _getFallbackByCategory(category) {
    switch (category) {
      case 'serif':
        return 'Georgia, "Times New Roman", Times, serif'
      case 'monospace':
        return 'Consolas, "Courier New", monospace'
      case 'persian':
        return 'Tahoma, Arial, sans-serif'
      case 'multilingual':
        return 'Arial, sans-serif'
      default:
        return 'system-ui, -apple-system, Arial, sans-serif'
    }
  }

  /**
   * Clear font cache
   */
  clearCache() {
    this.cachedFonts = null
    logger.debug('Font cache cleared')
  }

  /**
   * Generate unique key for font to avoid duplicates in Vue
   * @param {Object} font - Font object
   * @param {number} index - Font index
   * @returns {string} Unique key
   */
  generateFontKey(font, index) {
    return `${font.value}-${font.isSystemFont ? 'system' : 'default'}-${index}`
  }
}

// Create singleton instance
export const systemFontDetector = new SystemFontDetector()
export default systemFontDetector
