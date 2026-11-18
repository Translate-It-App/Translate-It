import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

/**
 * PageTranslationScrollTracker - Manages scroll event detection and debounce.
 * Isolates scroll listening logic from the main Manager.
 */
export class PageTranslationScrollTracker {
  constructor(onScrollStopCallback, onScrollStartCallback, onViewportActivityCallback) {
    this.logger = getScopedLogger(LOG_COMPONENTS.PAGE_TRANSLATION, 'ScrollTracker');
    this.onScrollStopCallback = onScrollStopCallback;
    this.onScrollStartCallback = onScrollStartCallback;
    this.onViewportActivityCallback = onViewportActivityCallback;
    this.scrollTimer = null;
    this.scrollStopDelay = 500;
    this._handleScroll = this._handleScroll.bind(this);
    this._handleScrollEnd = this._handleScrollEnd.bind(this);
    this._isActive = false;
    this._isScrolling = false;
    this._lastActivityNotify = null;
    this._lastViewportActivityNotify = null;
    this._handleResize = this._handleResize.bind(this);
  }

  /**
   * Start listening for scroll events
   */
  start(delay = 500) {
    if (this._isActive) {
      this.updateDelay(delay);
      return;
    }
    this._isActive = true;
    this.scrollStopDelay = Number(delay) || 500;
    this._lastActivityNotify = null;
    this._lastViewportActivityNotify = null;
    this.logger.debug('Starting scroll tracker with delay:', this.scrollStopDelay);
    
    // Always use manual debounce for custom delays
    // Native 'scrollend' doesn't support custom wait times
    window.addEventListener('scroll', this._handleScroll, { passive: true, capture: true });
    window.addEventListener('resize', this._handleResize, { passive: true });
  }

  /**
   * Update the scroll stop delay dynamically
   * @param {number} delay - New delay in ms
   */
  updateDelay(delay) {
    const newDelay = Number(delay) || 500;
    if (this.scrollStopDelay !== newDelay) {
      this.logger.debug('Updating scroll stop delay to:', newDelay);
      this.scrollStopDelay = newDelay;
    }
  }

  /**
   * Stop listening for scroll events
   */
  stop() {
    if (!this._isActive) return;
    this._isActive = false;
    this._lastActivityNotify = null;
    this._lastViewportActivityNotify = null;
    this.logger.debug('Stopping scroll tracker');
    
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    this._isScrolling = false;
    window.removeEventListener('scroll', this._handleScroll, true);
    window.removeEventListener('resize', this._handleResize);
  }

  /**
   * Notify that an activity (like DOM change) occurred.
   * This resets the stop timer even if not scrolling.
   */
  notifyActivity() {
    if (!this._isActive) return;

    // Throttle activity notifications to once every 50ms 
    // to avoid resetting the timer thousands of times during initial bridge pass
    const now = Date.now();
    if (this._lastActivityNotify !== null && now - this._lastActivityNotify < 50) {
      return;
    }
    this._lastActivityNotify = now;

    // If we're not currently "scrolling", we still want to treat 
    // dynamic content as an activity that needs a pause before translating.
    if (!this._isScrolling) {
      this._isScrolling = true;
      if (this.onScrollStartCallback) {
        this.onScrollStartCallback();
      }
    }

    this._resetTimer();
  }

  _handleScroll() {
    if (!this._isActive) return;
    this._notifyViewportActivity();
    if (!this._isScrolling) {
      this._isScrolling = true;
      if (this.onScrollStartCallback) {
        this.onScrollStartCallback();
      }
    }

    this._resetTimer();
  }

  _handleResize() {
    if (this._isActive) this._notifyViewportActivity();
  }

  _notifyViewportActivity() {
    if (!this.onViewportActivityCallback) return;
    const now = Date.now();
    if (this._lastViewportActivityNotify !== null && now - this._lastViewportActivityNotify < 50) return;
    this._lastViewportActivityNotify = now;
    this.onViewportActivityCallback();
  }

  _resetTimer() {
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
    }
    
    this.scrollTimer = setTimeout(() => {
      if (this._isActive && this._isScrolling) {
        this._handleScrollEnd();
      }
    }, this.scrollStopDelay);
  }

  _handleScrollEnd() {
    if (this._isActive) {
      this._isScrolling = false;
      if (this.scrollTimer) {
        clearTimeout(this.scrollTimer);
        this.scrollTimer = null;
      }
      this.onScrollStopCallback();
    }
  }

  destroy() {
    this.stop();
  }
}
