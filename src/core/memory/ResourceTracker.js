/**
 * Memory Garbage Collector - Resource Tracker
 * Provides a convenient interface for tracking resources in classes
 */
import { getMemoryManager } from './MemoryManager.js';
import { isDevelopmentMode } from '../../shared/utils/environment.js';
import { getScopedLogger } from '../../shared/logging/logger.js';
import { LOG_COMPONENTS } from '../../shared/logging/logConstants.js';

const isDevelopment = isDevelopmentMode();

// Helper function to check if debugging features should be enabled
const shouldEnableDebugging = () => {
  // In production, only enable debugging if explicitly requested
  if (!isDevelopment) {
    return typeof globalThis !== 'undefined' && globalThis.__MEMORY_DEBUG__ === true;
  }
  // In development, always enable debugging
  return true;
};

class ResourceTracker {
  constructor(groupId) {
    this.groupId = groupId;
    this.memoryManager = getMemoryManager();
    this._logger = null;
    if (shouldEnableDebugging()) {
      this.resources = new Set();
    }
  }

  get logger() {
    if (!this._logger) {
      this._logger = getScopedLogger(LOG_COMPONENTS.MEMORY, `ResourceTracker:${this.groupId}`);
    }
    return this._logger;
  }

  set logger(value) {
    this._logger = value;
  }

  /**
   * Track a timeout
   * @param {Function} callback - Callback function
   * @param {number} delay - Delay in milliseconds
   * @returns {number} Timer ID
   */
  trackTimeout(callback, delay) {
    const timerId = setTimeout(() => {
      try {
        callback();
      } finally {
        // A completed timer must not linger in the memory manager's group.
        this.clearTimer(timerId);
      }
    }, delay);

    if (shouldEnableDebugging()) {
      const resourceId = `timer_${timerId}`;
      this.resources.add(resourceId);
    }
    this.memoryManager.trackTimer(timerId, this.groupId);

    return timerId;
  }

  /** Alias for trackTimeout */
  setTimeout(callback, delay) {
    return this.trackTimeout(callback, delay);
  }

  trackInterval(callback, delay) {
    const intervalId = setInterval(callback, delay);

    if (shouldEnableDebugging()) {
      const resourceId = `interval_${intervalId}`;
      this.resources.add(resourceId);
    }
    this.memoryManager.trackTimer(intervalId, this.groupId);

    return intervalId;
  }

  /** Alias for trackInterval */
  setInterval(callback, delay) {
    return this.trackInterval(callback, delay);
  }

  addEventListener(element, event, handler, options = null) {
    // The core tracking is now handled by MemoryManager, which is already environment-aware.
    // This method just needs to call the appropriate function on the element.

    // Handle custom event systems (like StorageCore with on/off methods)
    if (element && typeof element.on === 'function' && typeof element.off === 'function') {
      element.on(event, handler);
    }
    // Handle browser extension APIs (they use addListener/removeListener)
    else if (element && typeof element.addListener === 'function' && typeof element.removeListener === 'function') {
      element.addListener(handler);
    }
    // Handle DOM EventTargets
    else if (element && typeof element.addEventListener === 'function') {
      if (options) {
        element.addEventListener(event, handler, options);
      } else {
        element.addEventListener(event, handler);
      }
    }
    else if (shouldEnableDebugging()) {
      this.logger.warn('Unsupported event target type:', element);
    }

    // Extract critical flag from options
    const trackingOptions = {};
    if (options && typeof options === 'object' && (options.critical || options.isCritical)) {
      trackingOptions.isCritical = true;
    }

    // Let the memory manager handle the actual resource tracking
    this.memoryManager.trackEventListener(element, event, handler, this.groupId, trackingOptions);

    if (shouldEnableDebugging()) {
      const resourceId = `event_${event}_${Date.now()}`;
      this.resources.add(resourceId);
    }
  }

  trackResource(resourceId, cleanupFn, options = {}) {
    if (shouldEnableDebugging()) {
      this.resources.add(resourceId);
    }
    this.memoryManager.trackResource(resourceId, cleanupFn, this.groupId, options);
  }

  /**
   * Remove event listener with proper cleanup
   * @param {Element} element - The element to remove listener from
   * @param {string} event - The event name
   * @param {Function} handler - The event handler
   * @param {Object} options - Event options
   */
  removeEventListener(element, event, handler, options = null) {
    try {
      // Handle custom event systems (like StorageCore with on/off methods)
      if (element && typeof element.off === 'function') {
        element.off(event, handler);
      }
      // Handle browser extension APIs (they use addListener/removeListener)
      else if (element && typeof element.removeListener === 'function') {
        element.removeListener(handler);
      }
      // Handle DOM EventTargets
      else if (element && typeof element.removeEventListener === 'function') {
        if (options) {
          element.removeEventListener(event, handler, options);
        } else {
          element.removeEventListener(event, handler);
        }
      }

      // Log removal in development
      if (shouldEnableDebugging()) {
        // this.logger.trace('Event listener removed:', { event, element: element?.constructor?.name });
      }
    } catch (error) {
      this.logger.error('Error removing event listener:', error);
    }
  }

  trackCache(cache, options = {}) {
    this.memoryManager.trackCache(cache, options, this.groupId);
    if (shouldEnableDebugging()) {
      const resourceId = `cache_${Date.now()}`;
      this.resources.add(resourceId);
    }
  }

  clearTimer(timerId) {
    clearTimeout(timerId);
    clearInterval(timerId);
    this.memoryManager.clearTimer(timerId, this.groupId);
    if (shouldEnableDebugging()) {
      this.resources.delete(`timer_${timerId}`);
      this.resources.delete(`interval_${timerId}`);
    }
  }

  /**
   * Clear all active timeouts and intervals for this tracker
   */
  clearAllTimers() {
    this.memoryManager.clearGroupTimers(this.groupId);
    
    if (shouldEnableDebugging()) {
      for (const resourceId of this.resources) {
        if (resourceId.startsWith('timer_') || resourceId.startsWith('interval_')) {
          this.resources.delete(resourceId);
        }
      }
    }
  }

  cleanup() {
    this.memoryManager.cleanupGroup(this.groupId);
    if (shouldEnableDebugging()) {
      this.resources.clear();
    }
  }

  getStats() {
    if (shouldEnableDebugging()) {
      return {
        groupId: this.groupId,
        trackedResources: this.resources ? this.resources.size : 0,
        memoryManagerStats: this.memoryManager.getMemoryStats()
      };
    }
    return { groupId: this.groupId, trackedResources: 0 };
  }

  /**
   * Destroy this tracker and cleanup all resources
   */
  destroy() {
    this.cleanup()
    this.memoryManager = null
    this.resources = null
  }
}

export default ResourceTracker
