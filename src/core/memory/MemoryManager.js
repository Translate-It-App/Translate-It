/**
 * Memory Garbage Collector - Core Memory Manager
 * Manages resources, timers, event listeners, and caches to prevent memory leaks
 */
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { MEMORY_TIMING, TRANSLATION_MEMORY } from './constants.js';
import { isDOMAvailable, isServiceWorker, isDevelopmentMode } from '@/shared/utils/environment.js';

const logger = getScopedLogger(LOG_COMPONENTS.MEMORY, 'MemoryManager');

// Use safe environment detection
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

class MemoryManager {
  constructor(options = {}) {
    this.resources = new Map(); // resourceId -> cleanup function
    this.groups = new Map(); // groupId -> Set of resourceIds
    this.timers = new Set();
    this.eventListeners = new Map(); // element -> Map<event -> Set<handlerInfo>>
    this.domObservers = new WeakMap();
    this.caches = new Set();
    this.stats = {
      totalResources: 0,
      cleanupCount: 0,
      memoryUsage: 0
    };

    // Initialize essential properties for both development and production
    this.registeredCaches = new Set();
    this.registeredMonitors = new Set();
    this.centralTimer = null;
    this.centralTimerInterval = options.centralTimerInterval || MEMORY_TIMING.CENTRAL_TIMER_INTERVAL;

    // Dev-only properties
    const enableDebugFeatures = shouldEnableDebugging();
    if (enableDebugFeatures) {
      this.eventStats = {
        totalTracked: 0,
        totalCleaned: 0,
        byType: new Map()
      };
    }
    this.initCentralTimer(); // Moved outside the if (isDevelopment) block

    // Initialize DOM cleanup observer (only if needed)
    if (options.enableDOMObserver !== false) {
      this.initDOMCleanupObserver();
    }
  }

  /**
   * Initialize shared DOM cleanup observer for automatic cleanup of removed elements
   * Uses a single observer for better performance
   */
  initDOMCleanupObserver() {
    // Skip DOM observer initialization in service worker context
    if (isServiceWorker() || !isDOMAvailable() || typeof MutationObserver === 'undefined') {
      // Skipping DOM observer - logged at TRACE level for detailed debugging
      // logger.trace('Skipping DOM observer initialization (service worker or DOM not available)')
      return
    }

    // Avoid creating multiple observers
    if (this.globalObserver) {
      return
    }

    // Track elements that need cleanup monitoring
    this.monitoredElements = new Set()

    // Create a single shared MutationObserver
    this.globalObserver = new MutationObserver((mutations) => {
      const removedElements = new Set()

      mutations.forEach((mutation) => {
        mutation.removedNodes.forEach((node) => {
          // Check if it's an element node (Node.ELEMENT_NODE = 1)
          if (node.nodeType === 1) {
            removedElements.add(node)
            // Also collect child elements
            const childElements = node.querySelectorAll && node.querySelectorAll('*')
            if (childElements) {
              childElements.forEach(child => removedElements.add(child))
            }
          }
        })
      })

      // Batch cleanup for better performance
      for (const element of removedElements) {
        if (this.monitoredElements.has(element)) {
          this.cleanupElementListeners(element)
          this.monitoredElements.delete(element)
        }
      }
    })

    // Start observing the entire document (only in content script context)
    if (typeof document !== 'undefined' && (document.body || document.documentElement)) {
      this.globalObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      })
    } else {
      // Document not available - logged at TRACE level for detailed debugging
      // logger.trace('Document not available (running in service worker), skipping DOM observer')
      return
    }

    logger.info('Shared DOM cleanup observer initialized')
  }

  /**
   * Check if a handler is already tracked
   * @param {Set} handlers - Set of handler info objects
   * @param {Function} handler - Handler to check
   * @returns {boolean}
   */
  isHandlerTracked(handlers, handler) {
    for (const handlerInfo of handlers) {
      if (handlerInfo.handler === handler) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get size of handler set
   * @param {Set} handlerSet - Set of handler info objects
   * @returns {number}
   */
  getHandlerSetSize(handlerSet) {
    return handlerSet ? handlerSet.size : 0;
  }

  /**
   * Get a description of an element for logging purposes
   * @param {EventTarget|Object} element
   * @returns {string}
   */
  getElementDescription(element) {
    if (!element) return 'null'

    // DOM elements - check if Element is available (browser environment)
    if (typeof Element !== 'undefined' && element instanceof Element) {
      const className = typeof element.className === 'string' ? element.className : element.getAttribute('class') || '';
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${className ? `.${className.split(' ')[0]}` : ''}`
    }

    // Window
    if (typeof window !== 'undefined' && element === window) return 'window'

    // Document
    if (typeof document !== 'undefined' && element === document) return 'document'

    // Browser APIs
    if (typeof element === 'object' && element.constructor) {
      return element.constructor.name || 'unknown'
    }

    return typeof element
  }

  /**
   * Check if element is a DOM element
   * @param {any} element
   * @returns {boolean}
   */
  isDOMElement(element) {
    // Check if DOM constructors are available (browser environment)
    const ElementAvailable = typeof Element !== 'undefined'
    const DocumentAvailable = typeof Document !== 'undefined'

    return (ElementAvailable && element instanceof Element) ||
           (DocumentAvailable && element instanceof Document) ||
           (typeof window !== 'undefined' && element === window)
  }

  /**
   * Set up automatic cleanup for DOM elements when they're removed
   * Uses the shared DOM observer for better performance
   * @param {Element} element
   */
  setupDOMElementCleanup(element) {
    if (!this.isDOMElement(element) || element === window || element === document) return
    if (typeof MutationObserver === 'undefined') return

    // Initialize shared observer if not already done
    this.initDOMCleanupObserver()

    // Add element to monitoring set
    if (this.monitoredElements) {
      this.monitoredElements.add(element)
      // Element added to monitoring - logged at TRACE level for detailed debugging
      // logger.trace(`Added element to shared observer monitoring: ${this.getElementDescription(element)}`)
    }
  }

  /**
   * Clean up all listeners for a specific element
   * @param {Element} element
   */
  cleanupElementListeners(element) {
    if (!this.eventListeners.has(element)) return

    const elementListeners = this.eventListeners.get(element)
    const events = Array.from(elementListeners.keys())

    logger.info(`Cleaning up ${events.length} event types for removed element: ${this.getElementDescription(element)}`)

    events.forEach(event => {
      const handlers = elementListeners.get(event)
      this.getHandlerSetSize(handlers)
      
      // Clean up each handler
      for (const handlerInfo of handlers) {
        try {
          // Find and cleanup the resource
          for (const [resourceId] of this.resources) {
            if (resourceId.includes(handlerInfo.id)) {
              this.cleanupResource(resourceId)
              break
            }
          }
        } catch (error) {
          logger.warn(`Error cleaning handler for ${event}:`, error)
        }
      }
      
      // logger.trace(`Cleaned up ${handlerCount} ${event} listeners for element: ${this.getElementDescription(element)}`)
    })

    // logger.trace(`Total handlers cleaned for element: ${totalHandlers}`)

    // Remove the element from tracking
    this.eventListeners.delete(element)

    // Disconnect any observers
    if (this.domObservers.has(element)) {
      this.domObservers.get(element).disconnect()
      this.domObservers.delete(element)
    }
  }

  /**
   * Track a resource with cleanup function
   * @param {string} resourceId - Unique identifier for the resource
   * @param {Function} cleanupFn - Function to cleanup the resource
   * @param {string} groupId - Group identifier for batch cleanup
   * @param {Object} options - Options object
   * @param {boolean} options.isCritical - Whether this resource is critical and should be protected from cleanup
   */
  trackResource(resourceId, cleanupFn, groupId = 'default', options = {}) {
    if (this.resources.has(resourceId)) {
      // logger.trace(`Resource ${resourceId} already tracked`)
      return
    }

    // Store resource info with critical flag
    const resourceInfo = {
      cleanupFn,
      isCritical: options.isCritical || false
    };

    this.resources.set(resourceId, resourceInfo)

    if (!this.groups.has(groupId)) {
      this.groups.set(groupId, new Set())
    }
    this.groups.get(groupId).add(resourceId)

    this.stats.totalResources++
  }

  /**
   * Track a timer
   * @param {number} timerId - Timer ID from setTimeout/setInterval
   * @param {string} groupId - Group identifier
   */
  trackTimer(timerId, groupId = 'default') {
    this.timers.add(timerId)

    if (!this.groups.has(groupId)) {
      this.groups.set(groupId, new Set())
    }
    this.groups.get(groupId).add(`timer_${timerId}`)
  }

  /**
   * Stop tracking a timer and remove its group entry.
   * @param {number} timerId - Timer ID from setTimeout/setInterval
   * @param {string} groupId - Group identifier
   */
  clearTimer(timerId, groupId = 'default') {
    this.timers.delete(timerId)

    const resourceIds = this.groups.get(groupId)
    if (!resourceIds) return

    resourceIds.delete(`timer_${timerId}`)
    resourceIds.delete(`interval_${timerId}`)
    if (resourceIds.size === 0) this.groups.delete(groupId)
  }

  /**
   * Track an event listener (handles DOM, browser APIs, and custom event systems)
   * Enhanced with Map-based tracking for reliable handler management
   * @param {EventTarget|Object} element - Element, browser API, or custom event emitter
   * @param {string} event - Event type
   * @param {Function} handler - Event handler function
   * @param {string} groupId - Group identifier
   * @param {Object} options - Additional options for tracking
   */
  trackEventListener(element, event, handler, groupId = 'default', options = {}) {
    if (!element) {
      if (isDevelopment) {
        logger.warn('Cannot track event listener: element is null or undefined');
      }
      return;
    }

    // Check for duplicate handler (only if debugging enabled)
    if (shouldEnableDebugging() && this.eventListeners.has(element)) {
      const elementListeners = this.eventListeners.get(element);
      if (elementListeners.has(event)) {
        const eventHandlers = elementListeners.get(event);
        if (this.isHandlerTracked(eventHandlers, handler)) {
          // logger.trace(`Handler already tracked for ${event} on ${this.getElementDescription(element)}`)
          return;
        }
      }
    }

    // Create handler info for tracking
    const handlerInfo = {
      id: `handler_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      handler,
      element,
      event,
      groupId,
      isCritical: options.isCritical || false
    };

    // Debug log for critical events
    if (isDevelopment && handlerInfo.isCritical) {
      logger.info(`Tracking CRITICAL event listener: ${event} on ${this.getElementDescription(element)}`);
    }

    // Create cleanup function
    const cleanupFn = () => {
      try {
        // Debug log for all cleanup attempts (FORCE DEBUG FOR TESTING)
        // logger.trace(`Attempting to cleanup event listener: ${event} on ${this.getElementDescription(element)}, isCritical: ${handlerInfo.isCritical}`);

        // Skip critical event listeners during cleanup
        if (handlerInfo.isCritical) {
          logger.info(`Skipping critical event listener: ${event} on ${this.getElementDescription(element)}`);
          return;
        }

        // Handle custom event systems (like StorageCore with on/off methods)
        if (element && typeof element.off === 'function') {
          element.off(event, handler);
        }
        // Handle browser extension APIs (they use removeListener)
        else if (element && typeof element.removeListener === 'function') {
          element.removeListener(handler);
        }
        // Handle DOM EventTargets
        else if (element && typeof element.removeEventListener === 'function') {
          element.removeEventListener(event, handler);
        }

        // Remove from tracking
        if (shouldEnableDebugging() && this.eventListeners.has(element)) {
          const elementListeners = this.eventListeners.get(element);
          if (elementListeners.has(event)) {
            const eventHandlers = elementListeners.get(event);
            for (const info of eventHandlers) {
              if (info.handler === handler) {
                eventHandlers.delete(info);
                break;
              }
            }
          }
        }

        if (isDevelopment) {
          logger.info(`Removed event listener: ${event} from ${this.getElementDescription(element)}`);
          // Update cleanup statistics
          this.eventStats.totalCleaned++;
          if (this.eventStats.byType.has(event)) {
            this.eventStats.byType.set(event, Math.max(0, this.eventStats.byType.get(event) - 1));
          }
        }
      } catch (error) {
        if (isDevelopment) {
          logger.warn(`Error removing event listener ${event}:`, error);
        }
      }
    };

    const resourceId = `event_${event}_${this.getElementDescription(element)}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.trackResource(resourceId, cleanupFn, groupId);

    // Set up automatic cleanup for DOM elements
    if (options.autoCleanup !== false && this.isDOMElement(element)) {
      this.setupDOMElementCleanup(element, resourceId);
    }

    if (shouldEnableDebugging()) {
      // Initialize element tracking if not exists
      if (!this.eventListeners.has(element)) {
        this.eventListeners.set(element, new Map());
      }
      const elementListeners = this.eventListeners.get(element);
      if (!elementListeners.has(event)) {
        elementListeners.set(event, new Set());
      }
      const eventHandlers = elementListeners.get(event);
      eventHandlers.add(handlerInfo);

      // Update statistics
      this.eventStats.totalTracked++;
      if (!this.eventStats.byType.has(event)) {
        this.eventStats.byType.set(event, 0);
      }
      this.eventStats.byType.set(event, this.eventStats.byType.get(event) + 1);
      logger.debug(`Tracked event listener: ${event} on ${this.getElementDescription(element)} (total: ${this.eventStats.totalTracked})`);
    }
  }

  /**
   * Track a cache instance
   * @param {Object} cache - Cache instance with destroy method
   * @param {Object} options - Cache options
   * @param {string} groupId - Group identifier
   */
  trackCache(cache, groupId = 'default') {
    this.caches.add(cache)

    const resourceId = `cache_${Date.now()}`
    this.trackResource(resourceId, () => {
      if (cache.destroy && typeof cache.destroy === 'function') {
        cache.destroy()
      }
    }, groupId)
  }

  /**
   * Cleanup a specific resource
   * @param {string} resourceId - Resource identifier
   */
  cleanupResource(resourceId) {
    const resourceInfo = this.resources.get(resourceId)
    if (resourceInfo) {
      // Handle both old format (direct function) and new format (object with cleanupFn)
      const cleanupFn = typeof resourceInfo === 'function' ? resourceInfo : resourceInfo.cleanupFn;
      const isCritical = typeof resourceInfo === 'object' ? resourceInfo.isCritical : false;
      
      if (isCritical) {
        logger.info(`Skipping critical resource: ${resourceId}`);
        return;
      }
      
      try {
        cleanupFn()
        this.resources.delete(resourceId)
        this.stats.cleanupCount++

        // Remove from groups
        for (const [groupId, resourceIds] of this.groups) {
          resourceIds.delete(resourceId)
          if (resourceIds.size === 0) {
            this.groups.delete(groupId)
          }
        }
      } catch (error) {
        logger.error(`Error cleaning up resource ${resourceId}:`, error)
      }
    }
  }

  /**
   * Cleanup all resources in a group
   * @param {string} groupId - Group identifier
   */
  cleanupGroup(groupId) {
    const resourceIds = this.groups.get(groupId)
    if (resourceIds) {
      const idsToCleanup = Array.from(resourceIds)
      idsToCleanup.forEach(resourceId => {
        if (resourceId.startsWith('timer_') || resourceId.startsWith('interval_')) {
          const timerId = parseInt(resourceId.replace(/^(timer_|interval_)/, ''))
          clearTimeout(timerId)
          clearInterval(timerId)
          this.timers.delete(timerId)
        } else {
          this.cleanupResource(resourceId)
        }
      })
      this.groups.delete(groupId)
    }
  }

  /**
   * Clear only timers and intervals in a group
   * @param {string} groupId - Group identifier
   */
  clearGroupTimers(groupId) {
    const resourceIds = this.groups.get(groupId)
    if (resourceIds) {
      const ids = Array.from(resourceIds)
      ids.forEach(resourceId => {
        if (resourceId.startsWith('timer_') || resourceId.startsWith('interval_')) {
          const timerId = parseInt(resourceId.replace(/^(timer_|interval_)/, ''))
          clearTimeout(timerId)
          clearInterval(timerId)
          this.timers.delete(timerId)
          resourceIds.delete(resourceId)
        }
      })
    }
  }

  /**
   * Cleanup all resources with enhanced event listener handling
   */
  cleanupAll() {
    if (isDevelopment) {
      logger.info('Starting comprehensive cleanup...');
    }

    // Clear all timers
    this.timers.forEach(timerId => {
      clearTimeout(timerId);
      clearInterval(timerId);
    });
    this.timers.clear();

    // Cleanup all resources
    const allResourceIds = Array.from(this.resources.keys());
    allResourceIds.forEach(resourceId => this.cleanupResource(resourceId));

    // Clear caches (skip critical caches)
    this.caches.forEach(cache => {
      if (cache.isCritical) {
        if (isDevelopment) {
          // logger.trace('Skipping critical cache during cleanup');
        }
        return;
      }
      if (cache.destroy && typeof cache.destroy === 'function') {
        try {
          cache.destroy();
        } catch (error) {
          if (isDevelopment) {
            logger.warn('Error destroying cache:', error);
          }
        }
      }
    });
    // Remove non-critical caches from the set
    const criticalCaches = new Set();
    this.caches.forEach(cache => {
      if (cache.isCritical) {
        criticalCaches.add(cache);
      }
    });
    this.caches = criticalCaches;

    // Clear groups
    this.groups.clear();

    if (shouldEnableDebugging()) {
      this.eventListeners = new Map();
      this.domObservers = new WeakMap();
      this.eventStats.totalTracked = 0;
      this.eventStats.totalCleaned = 0;
      this.eventStats.byType.clear();
      logger.info(`Cleanup completed.`);
    }

    // Cleanup shared DOM observer
    if (this.globalObserver) {
      this.globalObserver.disconnect()
      this.globalObserver = null
    }
    if (this.monitoredElements) {
      this.monitoredElements.clear()
    }
  }

  getMemoryStats() {
    if (shouldEnableDebugging()) {
      this.updateMemoryStats();

      let activeEventListeners = 0;
      let eventTypes = new Set();

      if (this.eventStats) {
        activeEventListeners = Object.values(this.eventStats.byType).reduce((sum, count) => sum + count, 0);
        eventTypes = new Set(Object.keys(this.eventStats.byType));
      }

      return {
        ...this.stats,
        activeResources: this.resources.size,
        activeGroups: this.groups.size,
        activeTimers: this.timers.size,
        activeCaches: this.caches.size,
        activeEventListeners,
        eventTypesCount: eventTypes.size,
        eventStats: {
          totalTracked: this.eventStats?.totalTracked || 0,
          totalCleaned: this.eventStats?.totalCleaned || 0,
          byType: this.eventStats ? Object.fromEntries(this.eventStats.byType) : {}
        }
      };
    }

    // Production version
    return {
      activeResources: this.resources.size,
      activeTimers: this.timers.size
    };
  }

  updateMemoryStats() {
    if (isDevelopment && performance.memory) {
      this.stats.memoryUsage = performance.memory.usedJSHeapSize;
    }
  }

  detectMemoryLeaks() {
    if (!isDevelopment) return [];

    const stats = this.getMemoryStats();
    const warnings = [];

    if (stats.activeResources > 100) {
      warnings.push(`High number of active resources: ${stats.activeResources}`);
    }
    if (stats.activeEventListeners > 50) {
      warnings.push(`High number of active event listeners: ${stats.activeEventListeners}`);
    }
    if (stats.memoryUsage > 100 * 1024 * 1024) { // 100MB
      warnings.push(`High memory usage: ${(stats.memoryUsage / 1024 / 1024).toFixed(2)}MB`);
    }

    return warnings;
  }

  generateReport() {
    if (!isDevelopment) return {};

    const stats = this.getMemoryStats();
    const leaks = this.detectMemoryLeaks();

    return {
      timestamp: new Date().toISOString(),
      stats,
      warnings: leaks,
      resources: Array.from(this.resources.keys()),
      groups: Array.from(this.groups.keys())
    };
  }

  /**
   * Check if translation is currently active
   * @returns {boolean} True if translation is active
   */
  isTranslationActive() {
    // Check if translation engine group has active resources
    const translationGroup = this.groups.get('translation-engine');
    const hasActiveTranslation = translationGroup && translationGroup.size > 0;
    
    if (hasActiveTranslation && isDevelopment) {
      logger.info('Translation active, deferring cleanup operations');
    }
    
    return hasActiveTranslation;
  }

  /**
   * Perform garbage collection (skip critical caches and during translations)
   */
  performGarbageCollection() {
    if (!isDevelopment) return;

    // Skip GC during active translation
    if (TRANSLATION_MEMORY.SKIP_CLEANUP_DURING_TRANSLATION && this.isTranslationActive()) {
      logger.info('Skipping garbage collection during active translation');
      return;
    }

    // Force garbage collection if available (development only)
    if (typeof window !== 'undefined' && window.gc && typeof window.gc === 'function') {
      window.gc();
    }

    // Cleanup expired resources (skip critical caches)
    this.cleanupAll();

    // Update memory stats
    this.updateMemoryStats();
  }

  /**
   * Detect potential memory leaks - ENHANCED VERSION
   */
  detectMemoryLeaksEnhanced() {
    if (!isDevelopment) return [];
    const stats = this.getMemoryStats();
    const warnings = [];

    if (stats.activeResources > 100) {
      warnings.push(`High number of active resources: ${stats.activeResources}`);
    }

    if (stats.activeTimers > 20) {
      warnings.push(`High number of active timers: ${stats.activeTimers}`);
    }

    if (stats.activeEventListeners > 50) {
      warnings.push(`High number of active event listeners: ${stats.activeEventListeners} (${stats.eventTypesCount} types)`);
    }

    if (stats.memoryUsage > 100 * 1024 * 1024) { // 100MB
      warnings.push(`High memory usage: ${(stats.memoryUsage / 1024 / 1024).toFixed(2)}MB`);
    }

    // Check for specific event types that might indicate leaks
    const eventTypeCounts = stats.eventStats.byType;
    for (const [eventType, count] of Object.entries(eventTypeCounts)) {
      if (count > 10) {
        warnings.push(`High number of ${eventType} listeners: ${count}`);
      }
    }

    return warnings;
  }

  /**
   * Clean up event listeners by type or element
   * @param {string} eventType - Optional: specific event type to clean up
   * @param {Element} element - Optional: specific element to clean up
   */
  cleanupEventListeners(eventType = null, element = null) {
    if (!isDevelopment) return 0;
    let cleanupCount = 0;

    if (element && eventType) {
      // Clean up specific event type for specific element
      if (this.eventListeners.has(element)) {
        const elementListeners = this.eventListeners.get(element);
        if (elementListeners.has(eventType)) {
          // Find and cleanup resources for this specific event
          for (const [resourceId] of this.resources) {
            if (resourceId.includes(`event_${eventType}`) && resourceId.includes(this.getElementDescription(element))) {
              this.cleanupResource(resourceId);
              cleanupCount++;
            }
          }
        }
      }
    } else if (eventType) {
      // Clean up all listeners of a specific event type
      for (const [resourceId] of this.resources) {
        if (resourceId.startsWith(`event_${eventType}`)) {
          this.cleanupResource(resourceId);
          cleanupCount++;
        }
      }
    } else {
      // Clean up all event listeners
      for (const [resourceId] of this.resources) {
        if (resourceId.startsWith('event_')) {
          this.cleanupResource(resourceId);
          cleanupCount++;
        }
      }
    }

    logger.info(`Cleaned up ${cleanupCount} event listeners${eventType ? ` of type ${eventType}` : ''}${element ? ` for element ${this.getElementDescription(element)}` : ''}`);
    return cleanupCount;
  }

  /**
   * Get detailed event listener report
   */
  getEventListenerReport() {
    if (!isDevelopment) return {};
    const report = {
      totalElements: 0,
      totalEvents: 0,
      totalListeners: 0,
      byElement: {},
      byEventType: {},
      potentialLeaks: []
    };

    // Use eventStats for report since WeakMap is not iterable
    report.totalEvents = Object.keys(this.eventStats.byType).length;
    report.totalListeners = Object.values(this.eventStats.byType).reduce((sum, count) => sum + count, 0);
    report.byEventType = { ...this.eventStats.byType };

    // Note: We can't get element-specific breakdown with WeakMap
    report.byElement = {
      'tracked_elements': {
        eventCount: report.totalEvents,
        events: Object.keys(this.eventStats.byType).reduce((acc, event) => {
          acc[event] = true;
          return acc;
        }, {})
      }
    };
    report.totalElements = 1; // Approximation

    // Detect potential leaks
    for (const [eventType, count] of Object.entries(report.byEventType)) {
      if (count > 10) {
        report.potentialLeaks.push({
          type: 'high_event_count',
          event: eventType,
          count: count,
          message: `High number of ${eventType} listeners: ${count}`
        });
      }
    }

    return report;
  }

  /**
   * Initialize centralized timer for periodic cleanup and monitoring
   */
  initCentralTimer() {
    // Essential cleanup should work in both development and production
    if (this.centralTimer) return;

    this.centralTimer = setInterval(() => {
      this.performCentralCleanup();
    }, this.centralTimerInterval);

    if (shouldEnableDebugging()) {
      const minutes = Math.floor(this.centralTimerInterval / 60000);
      const seconds = Math.round((this.centralTimerInterval % 60000) / 1000);
      const formattedSeconds = seconds.toString().padStart(2, '0');
      logger.debug(`Centralized cleanup timer initialized (${minutes}:${formattedSeconds} interval)`);
    }
  }

  /**
   * Perform centralized cleanup for all registered caches and monitors
   */
  performCentralCleanup() {
    try {
      // Check if there's an active translation before cleaning up translation-related resources
      const isTranslationActive = typeof window !== 'undefined' && Boolean(window.isTranslationInProgress);
      
      // Cleanup all registered caches (safe to cleanup)
      this.registeredCaches.forEach(cache => {
        if (cache && typeof cache.cleanup === 'function') {
          cache.cleanup();
        }
      });

      // Run monitoring for all registered monitors, but skip SelectElementManager cleanup if translation is active
      this.registeredMonitors.forEach(monitor => {
        if (monitor && typeof monitor.performMonitoring === 'function') {
          // Skip cleanup of translation-related managers during active translation
          if (isTranslationActive && monitor.constructor.name === 'SelectElementManager') {
            logger.debug('Skipping SelectElementManager cleanup during active translation');
            return;
          }
          monitor.performMonitoring();
        }
      });

      logger.debug(`Central cleanup completed for ${this.registeredCaches.size} caches and ${this.registeredMonitors.size} monitors (translation active: ${isTranslationActive})`);
    } catch (error) {
      logger.warn('Error during central cleanup:', error);
    }
  }

  /**
   * Register a cache for centralized cleanup
   * @param {Object} cache - Cache instance with cleanup method
   */
  registerCache(cache) {
    if (cache && typeof cache.cleanup === 'function') {
      this.registeredCaches.add(cache);
      if (shouldEnableDebugging()) {
        // logger.trace(`Cache registered for central cleanup (total: ${this.registeredCaches.size})`);
      }
    }
  }

  /**
   * Unregister a cache from centralized cleanup
   * @param {Object} cache - Cache instance
   */
  unregisterCache(cache) {
    this.registeredCaches.delete(cache);
    if (shouldEnableDebugging()) {
      // logger.trace(`Cache unregistered from central cleanup (total: ${this.registeredCaches.size})`);
    }
  }

  /**
   * Register a monitor for centralized monitoring
   * @param {Object} monitor - Monitor instance with performMonitoring method
   */
  registerMonitor(monitor) {
    if (monitor && typeof monitor.performMonitoring === 'function') {
      this.registeredMonitors.add(monitor);
      if (shouldEnableDebugging()) {
        // logger.trace(`Monitor registered for central monitoring (total: ${this.registeredMonitors.size})`);
      }
    }
  }

  /**
   * Unregister a monitor from centralized monitoring
   * @param {Object} monitor - Monitor instance
   */
  unregisterMonitor(monitor) {
    this.registeredMonitors.delete(monitor);
    if (shouldEnableDebugging()) {
      // logger.trace(`Monitor unregistered from central monitoring (total: ${this.registeredMonitors.size})`);
    }
  }

  /**
   * Stop centralized timer
   */
  stopCentralTimer() {
    if (this.centralTimer) {
      clearInterval(this.centralTimer);
      this.centralTimer = null;
      if (shouldEnableDebugging()) {
        // logger.trace('Centralized cleanup timer stopped');
      }
    }
  }

  /**
   * Get memory trend analysis
   * @returns {Object} Trend analysis
   */
  getTrendAnalysis() {
    if (!isDevelopment) return { trend: 'insufficient-data' };
    if (this.measurements.length < 2) {
      return { trend: 'insufficient-data' };
    }

    // const recent = this.measurements.slice(-10);
    const first = this.measurements[0].used;
    const last = this.measurements[this.measurements.length - 1].used;
    const change = last - first;
    const changePercent = (change / first) * 100;

    return {
      trend: change > 0 ? 'increasing' : change < 0 ? 'decreasing' : 'stable',
      change: `${(change / 1024 / 1024).toFixed(2)}MB`,
      changePercent: `${changePercent.toFixed(2)}%`,
      period: `${this.measurements.length} measurements`
    };
  }

  /**
   * Generate detailed memory report - ENHANCED VERSION
   * @returns {Object} Memory report
   */
  generateReportEnhanced() {
    if (!isDevelopment) return {};
    const current = this.getCurrentMemory();
    const trend = this.getTrendAnalysis();
    const managerStats = this.getMemoryStats();
    const leaks = this.detectMemoryLeaksEnhanced();

    return {
      timestamp: new Date().toISOString(),
      currentMemory: {
        used: current,
        usedMB: (current / 1024 / 1024).toFixed(2),
        total: performance.memory?.totalJSHeapSize || 0,
        limit: performance.memory?.jsHeapSizeLimit || 0
      },
      trend,
      managerStats,
      warnings: leaks,
      measurements: this.measurements.length,
      thresholds: this.thresholds,
      isMonitoring: this.isMonitoring
    };
  }

  /**
   * Set custom thresholds
   * @param {Object} thresholds - New thresholds
   */
  setThresholds(thresholds) {
    if (!isDevelopment) return;
    this.thresholds = { ...this.thresholds, ...thresholds };
    logger.info('Memory thresholds updated', this.thresholds);
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    if (!isDevelopment) return {};
    return {
      isMonitoring: this.isMonitoring,
      measurements: this.measurements.length,
      currentMemory: this.getCurrentMemory(),
      trend: this.getTrendAnalysis(),
      thresholds: this.thresholds
    };
  }

  /**
   * Export diagnostics data
   * @returns {Object} Diagnostics data
   */
  exportDiagnostics() {
    if (!isDevelopment) return {};
    return {
      memoryMonitor: this.generateReport(),
      memoryManager: this.generateReport(),
      performance: {
        memory: performance.memory,
        timing: performance.timing,
        navigation: performance.navigation
      }
    };
  }

  /**
   * Update memory thresholds
   * @param {Object} newThresholds - New threshold values
   */
  updateThresholds(newThresholds) {
    if (!isDevelopment) return;
    if (newThresholds.warning) {
      this.thresholds.warning = newThresholds.warning;
    }
    if (newThresholds.critical) {
      this.thresholds.critical = newThresholds.critical;
    }
    logger.info(`Memory thresholds updated: warning=${(this.thresholds.warning / 1024 / 1024).toFixed(2)}MB, critical=${(this.thresholds.critical / 1024 / 1024).toFixed(2)}MB`);
  }

  /**
   * Destroy memory monitor
   */
  destroy() {
    if (!isDevelopment) return;
    this.stopMonitoring();
    this.measurements = [];
    // logger.trace('Memory monitor destroyed');
  }
}

// Singleton instance
let memoryManagerInstance = null;

/**
 * Get the global memory manager instance
 * @param {Object} options - Configuration options
 */
export function getMemoryManager(options = {}) {
  if (!memoryManagerInstance) {
    memoryManagerInstance = new MemoryManager(options);
  }
  return memoryManagerInstance;
}

export default MemoryManager
