// src/managers/content/windows/core/WindowsConfig.js

/**
 * Configuration constants and settings for WindowsManager
 */
export class WindowsConfig {
  static ANIMATION = {
    FADE_IN_DURATION: 50,
    FADE_OUT_DURATION: 125,
    SCALE_TRANSITION: 'transform 0.1s ease-out, opacity 50ms ease-in-out',
    ICON_ANIMATION: {
      DURATION: 120,
      EASING: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      DELAY: 10
    }
  };

  static POSITIONING = {
    POPUP_WIDTH: 300,
    POPUP_HEIGHT: 180,
    MIN_DOCKED_WIDTH: 280,
    MAX_DOCKED_WIDTH_PERCENT: 0.8,

    ICON_SIZE: 24,
    VIEWPORT_MARGIN: 8, // Reduced for less aggressive repositioning
    SELECTION_OFFSET: 3, // Reduced offset for closer positioning to selection
    SMART_POSITIONING: {
      VERTICAL_OFFSET_MULTIPLIER: 10, // Used to calculate vertical offset (SELECTION_OFFSET * 10)
      SAFETY_MARGIN_EXTRA: 2 // Extra margin for smart positioning (VIEWPORT_MARGIN + 2)
    }
  };

  static Z_INDEX = {
    MAX: 2147483647,
    POPUP: 2147483647,
    ICON: 2147483647
  };

  static TIMEOUTS = {
    OUTSIDE_CLICK_DELAY: 600,
    PENDING_WINDOW_RESET: 500,
    ERROR_DISPLAY: 4000,
    TTS_TIMEOUT: 15000,
    TRANSLATION_TIMEOUT: 180000,
    ICON_CLEANUP: 150
  };

  static CSS_CLASSES = {
    POPUP_HOST: 'aiwc-selection-popup-host',
    POPUP_CONTAINER: 'popup-container',
    LOADING_CONTAINER: 'loading-container',
    LOADING_DOT: 'loading-dot',
    FIRST_LINE: 'first-line',
    SECOND_LINE: 'second-line',
    TTS_ICON: 'tts-icon',
    ORIGINAL_TEXT: 'original-text',
    TEXT_CONTENT: 'text-content',
    THEME_LIGHT: 'theme-light',
    THEME_DARK: 'theme-dark'
  };

  static IDS = {
    ICON: 'translate-it-icon',
    ICON_HOST: 'aiwc-selection-icon-host'
  };

  static CROSS_FRAME = {
    REGISTER_FRAME: 'translateit-register-frame',
    SET_BROADCAST_REQUEST: 'translateit-set-broadcast-request',
    SET_BROADCAST_APPLY: 'translateit-set-broadcast-apply',
    OUTSIDE_CLICK: 'translateit-outside-click',
    CREATE_WINDOW_REQUEST: 'translateit-create-window-request',
    WINDOW_CREATED: 'translateit-window-created',
    TEXT_SELECTION_WINDOW_REQUEST: 'TEXT_SELECTION_WINDOW_REQUEST'
  };

  static STYLES = {
    POPUP_VARIABLES: {
      light: {
        '--sw-bg-color': '#f8f8f8',
        '--sw-text-color': '#333',
        '--sw-border-color': '#ddd',
        '--sw-shadow-color': 'rgba(0,0,0,0.1)',
        '--sw-original-text-color': '#000',
        '--sw-loading-dot-opacity-start': '0.3',
        '--sw-loading-dot-opacity-mid': '0.8',
        '--sw-link-color': '#0066cc'
      },
      dark: {
        '--sw-bg-color': '#2a2a2a',
        '--sw-text-color': '#e0e0e0',
        '--sw-border-color': '#444',
        '--sw-shadow-color': 'rgba(255,255,255,0.08)',
        '--sw-original-text-color': '#fff',
        '--sw-loading-dot-opacity-start': '0.5',
        '--sw-loading-dot-opacity-mid': '1',
        '--sw-link-color': '#58a6ff'
      }
    }
  };
}
