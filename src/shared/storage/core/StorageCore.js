/**
 * StorageCore - Centralized Storage Management System
 * Provides unified API for browser extension storage with caching and event system
 * Compatible with both Chrome and Firefox through webextension-polyfill
 *
 * This is the new unified storage system that replaces the old StorageManager
 */

// Early debug to trace module evaluation order
import ResourceTracker from '@/core/memory/ResourceTracker.js';
import browser from "webextension-polyfill";
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

const logger = getScopedLogger(LOG_COMPONENTS.STORAGE, 'StorageCore');
import SmartCache from '@/core/memory/SmartCache.js';
import { MEMORY_TIMING } from '@/core/memory/constants.js';
import { isContextError } from '@/core/contextCore.js';
import { handleContextError } from '@/core/contextErrorHandler.js';

class StorageCore extends ResourceTracker {
  constructor() {
    super('storage-core')
    this.cache = new SmartCache({ 
      maxSize: MEMORY_TIMING.MAX_CACHE_SIZE, 
      defaultTTL: MEMORY_TIMING.CRITICAL_CACHE_TTL, 
      isCritical: true 
    }); // Critical storage cache with centralized timing
    this._cacheRevision = 0;
    this.listeners = new Map(); // event_name -> Set of callbacks
    this._isReady = false;
    this._useInMemoryStorage = false;
    this._inMemoryData = {};
    this._readyPromise = null;
    this._changeListener = null;
    this.logger = getScopedLogger(LOG_COMPONENTS.STORAGE, 'Core');
    // StorageCore initialized - logged at TRACE level for detailed debugging
    // this.logger.init('StorageCore initialized');
    this._initializeAsync().catch(() => {
      // Keep rejected _readyPromise observable while handling fire-and-forget rejection.
    });
  }

  /**
   * Initialize storage manager asynchronously
   */
  async _initializeAsync() {
    if (this._readyPromise) {
      return this._readyPromise;
    }

    const promise = this._initializeWithRetry().catch(error => {
      if (this._readyPromise === promise) {
        this._readyPromise = null;
      }
      throw error;
    });
    this._readyPromise = promise;
    return this._readyPromise;
  }

  async _initializeWithRetry(maxRetries = 5, delay = 100) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this._initialize();
        return; // Success
      } catch (error) {
        // Use centralized context error detection
        const contextError = isContextError(error);

        if (contextError && attempt < maxRetries) {
          // Context error during extension reload - retry with backoff
          this.logger.debug(`Storage initialization attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
          continue;
        }

        // Final attempt or non-retryable error
        if (contextError) {
          handleContextError(error, 'storage:init');
        } else {
          this.logger.error('Initialization failed', error);
        }
        throw error;
      }
    }
  }

  async _initialize() {
    // Keep memory fallback for environments without the storage API.
    if (!browser?.storage?.local) {
      this.logger.debug('Standard browser storage not available, falling back to in-memory storage: API unavailable');
      this._useInMemoryStorage = true;
      this._inMemoryData = {};
      this._isReady = true;
      return;
    }

    // Probe failures must reach the existing retry and context-error handling.
    await this._getBrowserStorageOrThrow().get(["__storage_test__"]);

    // Setup change listener for cache invalidation
    this._setupChangeListener();

    this._isReady = true;
    this.logger.info('Storage core initialized successfully');
  }

  /**
   * Resolve the browser storage area, failing fast when the extension
   * runtime has disappeared after startup (e.g. invalidated context in
   * long-lived pages). Deliberately never falls back to in-memory here:
   * a browser-backed instance must not silently fork into a second
   * storage universe on runtime loss. The thrown error carries an explicit
   * message recognized by the permanent-context contract.
   * @returns {object} The browser.storage.local area.
   * @throws {Error} Explicit context error when the runtime API is gone.
   * @private
   */
  _getBrowserStorageOrThrow() {
    const area = browser?.storage?.local;
    if (!area) {
      throw new Error('Runtime API unavailable: browser.storage.local is missing');
    }
    return area;
  }

  /**
   * Setup storage change listener for cache invalidation
   */
  _setupChangeListener() {
    this.logger.debug('Storage core: Setting up change listener...');
    if (!browser?.storage?.onChanged) {
      this.logger.warn('storage.onChanged not available');
      return;
    }

    this._changeListener = (changes, areaName) => {
      if (areaName !== "local") return;

      this._advanceCacheRevision();

      // Update cache and emit events
      for (const [key, { newValue, oldValue }] of Object.entries(changes)) {
        // Update cache
        if (newValue !== undefined) {
          this.cache.set(key, newValue);
        } else {
          this.cache.delete(key);
        }

        // Emit change events
        this._emit("change", { key, newValue, oldValue });
        this._emit(`change:${key}`, { newValue, oldValue });
      }
    };

    try {
      // Use tracked event listener
      this.addEventListener(browser.storage.onChanged, 'change', this._changeListener);
    } catch (error) {
      try {
        browser.storage.onChanged.removeListener?.(this._changeListener);
      } catch {
        // Registration ownership was not established.
      }
      this._changeListener = null;
      throw error;
    }
  }

  /**
   * Mark cache/storage state as newer than pending browser reads.
   */
  _advanceCacheRevision() {
    this._cacheRevision += 1;
  }

  /**
   * Force immediate cache invalidation for specific keys
   * This ensures that subsequent get calls will fetch fresh values
   */
  _invalidateCache(keys) {
    if (!keys || !Array.isArray(keys)) return;
    if (keys.length === 0) return;

    this._advanceCacheRevision();

    // Cache invalidation - logged at TRACE level for detailed debugging
    // this.logger.debug(`Force invalidating cache for keys: ${keys.join(', ')}`);
    for (const key of keys) {
      this.cache.delete(key);
    }
  }

  /**
   * Ensure storage manager is ready
   */
  async _ensureReady() {
    if (this._isReady) return;
    if (this._readyPromise) {
      await this._readyPromise;
      return;
    }
    await this._initializeAsync();
  }

  /**
   * Normalize keys to a standard format
   * @param {string|string[]|Object} keys - Keys to normalize
   * @returns {string[]} Array of key names
   */
  _normalizeKeys(keys) {
    if (typeof keys === "string") {
      return [keys];
    } else if (Array.isArray(keys)) {
      return keys;
    } else if (typeof keys === "object" && keys !== null) {
      return Object.keys(keys);
    }
    return [];
  }

  /**
   * Get fresh values from storage, bypassing cache
   * This is useful for time-sensitive settings that need immediate consistency
   * @param {string|string[]|Object} keys - Keys to retrieve
   * @returns {Promise<Object>} Fresh values from storage
   */
  async getFresh(keys) {
    // Force cache invalidation for requested keys
    const keyList = this._normalizeKeys(keys);
    this._invalidateCache(keyList);

    // Get values through the shared revision-guarded read path.
    return this.get(keys, false);
  }

  /**
   * Get values from storage
   * Retries backend reads that overlap newer cache or storage state.
   * @param {string|string[]|Object} keys - Keys to retrieve
   * @param {boolean} useCache - Whether to use cache (default: true)
   * @returns {Promise<Object>} Retrieved values
   */
  async get(keys, useCache = true) {
    await this._ensureReady();

    try {
      // Handle different key formats
      let keyList = null;
      let defaultValues = {};

      if (keys === null || keys === undefined) {
        // Get all keys
        keyList = null;
      } else {
        keyList = this._normalizeKeys(keys);
        if (typeof keys === "object" && keys !== null) {
          defaultValues = keys;
        }
      }

      // Handle in-memory fallback
      if (this._useInMemoryStorage) {
        const result = {};
        if (keyList === null) {
          Object.assign(result, defaultValues, this._inMemoryData);
        } else {
          for (const key of keyList) {
            const val = key in this._inMemoryData ? this._inMemoryData[key] : defaultValues[key];
            if (val !== undefined) {
              result[key] = val;
            }
          }
        }
        return result;
      }

      while (true) {
        let cachedResult = {};
        let readKeys = keyList;

        // Rebuild cache snapshot after every retry.
        if (useCache && keyList) {
          this._ensureCache();
          const uncachedKeys = [];

          for (const key of keyList) {
            const cachedValue = this.cache.hasValid(key)
              ? this.cache.get(key)
              : undefined;
            if (cachedValue !== undefined) cachedResult[key] = cachedValue;
            else uncachedKeys.push(key);
          }

          // If all keys are cached, return cached result
          if (uncachedKeys.length === 0) {
            return { ...defaultValues, ...cachedResult };
          }

          readKeys = uncachedKeys;
        }

        const readRevision = this._cacheRevision;
        const result = await this._getBrowserStorageOrThrow().get(readKeys || undefined);

        if (readRevision !== this._cacheRevision) {
          continue;
        }

        // Update cache only after the read is confirmed current.
        for (const [key, value] of Object.entries(result)) {
          this.cache.set(key, value);
        }

        // Apply default values if provided
        return { ...defaultValues, ...cachedResult, ...result };
      }

    } catch (error) {
      // StorageCore should not handle its own errors via ErrorHandler
      // to avoid circular dependencies. We check if it's a context error.
      if (isContextError(error)) {
        handleContextError(error, 'storage-core-get');
      } else {
        logger.error('StorageCore-get error:', error);
      }
      throw error;
    }
  }

  /**
   * Convert Vue reactive objects (Proxy) to plain JavaScript objects
   * @param {*} obj - Object to convert
   * @returns {*} Plain JavaScript object or primitive value
   */
  _convertToPlainObject(obj) {
    // Handle null, undefined, primitives
    if (obj === null || obj === undefined || typeof obj !== "object") {
      return obj;
    }

    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map(item => this._convertToPlainObject(item));
    }

    // Handle dates
    if (obj instanceof Date) {
      return obj;
    }

    // Handle Vue reactive objects (Proxy) or regular objects
    const plainObj = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        plainObj[key] = this._convertToPlainObject(obj[key]);
      }
    }
    return plainObj;
  }

  /**
   * Set values in storage
   * @param {Object} data - Key-value pairs to store
   * @param {boolean} updateCache - Whether to update cache (default: true)
   * @returns {Promise<void>}
   */
  async set(data, updateCache = true) {
    await this._ensureReady();

    if (!data || typeof data !== "object") {
      throw new Error("Data must be an object");
    }

    try {
      // Convert Vue reactive objects to plain objects
      const plainData = this._convertToPlainObject(data);

      if (this._useInMemoryStorage) {
        for (const [key, value] of Object.entries(plainData)) {
          this._inMemoryData[key] = value;
          if (updateCache) {
            this._ensureCache();
            this.cache.set(key, value);
          }
        }
        // Emit events
        for (const key of Object.keys(plainData)) {
          this._emit("set", { key, value: plainData[key] });
          this._emit(`set:${key}`, { value: plainData[key] });
        }
        return;
      }

      await this._getBrowserStorageOrThrow().set(plainData);
      this._advanceCacheRevision();

      // Update cache if requested (use plain data)
      if (updateCache) {
        // Ensure cache availability
        this._ensureCache();
        
        for (const [key, value] of Object.entries(plainData)) {
          this.cache.set(key, value);
        }
      }

      // Emit set events (use plain data)
      for (const key of Object.keys(plainData)) {
        this._emit("set", { key, value: plainData[key] });
        this._emit(`set:${key}`, { value: plainData[key] });
      }

      // Set operation completed - logged at TRACE level for detailed debugging
      // this.logger.debug(`Set ${Object.keys(plainData).length} key(s)`);
    } catch (error) {
      if (isContextError(error)) {
        handleContextError(error, 'storage-core-set');
      } else {
        this.logger.error('Set operation failed', error);
      }
      throw error;
    }
  }

  /**
   * Remove keys from storage
   * @param {string|string[]} keys - Keys to remove
   * @param {boolean} updateCache - Whether to update cache (default: true)
   * @returns {Promise<void>}
   */
  async remove(keys, updateCache = true) {
    await this._ensureReady();

    const keyList = Array.isArray(keys) ? keys : [keys];

    try {
      if (this._useInMemoryStorage) {
        for (const key of keyList) {
          delete this._inMemoryData[key];
          if (updateCache) {
            this.cache.delete(key);
          }
        }
        // Emit remove events
        for (const key of keyList) {
          this._emit("remove", { key });
          this._emit(`remove:${key}`, {});
        }
        return;
      }

      await this._getBrowserStorageOrThrow().remove(keyList);
      this._advanceCacheRevision();

      // Update cache if requested
      if (updateCache) {
        for (const key of keyList) {
          this.cache.delete(key);
        }
      }

      // Emit remove events
      for (const key of keyList) {
        this._emit("remove", { key });
        this._emit(`remove:${key}`, {});
      }

      // Remove operation completed - logged at TRACE level for detailed debugging
      // this.logger.debug(`Removed ${keyList.length} key(s)`);
    } catch (error) {
      if (isContextError(error)) {
        handleContextError(error, 'storage-core-remove');
      } else {
        this.logger.error('Remove operation failed', error);
      }
      throw error;
    }
  }

  /**
   * Clear all storage
   * @param {boolean} updateCache - Whether to clear cache (default: true)
   * @returns {Promise<void>}
   */
  async clear(updateCache = true) {
    await this._ensureReady();

    try {
      if (this._useInMemoryStorage) {
        this._inMemoryData = {};
        if (updateCache) {
          this.cache.clear();
        }
        this._emit("clear", {});
        return;
      }

      await this._getBrowserStorageOrThrow().clear();
      this._advanceCacheRevision();

      if (updateCache) {
        this.cache.clear();
      }

      this._emit("clear", {});
      // Storage cleared - logged at TRACE level for detailed debugging
      // this.logger.debug('Storage cleared');
    } catch (error) {
      if (isContextError(error)) {
        handleContextError(error, 'storage-core-clear');
      } else {
        this.logger.error('Clear operation failed', error);
      }
      throw error;
    }
  }

  /**
   * Get cached value (synchronous)
   * @param {string} key - Key to retrieve
   * @param {*} defaultValue - Default value if not found
   * @returns {*} Cached value or default
   */
  getCached(key, defaultValue = undefined) {
    // Ensure cache availability
    this._ensureCache();
    if (!this.cache.hasValid(key)) return defaultValue;
    const cachedValue = this.cache.get(key);
    return cachedValue === undefined ? defaultValue : cachedValue;
  }

  /**
   * Check if key exists in cache, recreating cache if destroyed
   * @param {string} key - Key to check
   * @returns {boolean} Whether key exists in cache
   */
  hasCached(key) {
    // Ensure cache availability
    this._ensureCache();
    return this.cache.hasValid(key);
  }

  /**
   * Ensure cache is available and recreate if destroyed
   * Enhanced cache recreation with proper re-registration
   * @private
   */
  _ensureCache() {
    if (this.cache.isDestroyed) {
      this._advanceCacheRevision();
      // Cache recreation - logged at TRACE level for detailed debugging
      // this.logger.debug('Cache was destroyed, recreating with enhanced settings...');
      
      // Create new cache with same settings
      this.cache = new SmartCache({ 
        maxSize: MEMORY_TIMING.MAX_CACHE_SIZE, 
        defaultTTL: MEMORY_TIMING.CRITICAL_CACHE_TTL, 
        isCritical: true 
      });
      
      // Re-register with memory manager for proper tracking
      this.trackCache(this.cache, { isCritical: true });
      
      // Cache recreated - logged at TRACE level for detailed debugging
      // this.logger.debug('Cache successfully recreated and re-registered');
    }
  }

  /**
   * Invalidate cache for specific keys
   * @param {string|string[]} keys - Keys to invalidate
   */
  invalidateCache(keys) {
    const keyList = Array.isArray(keys) ? keys : [keys];
    this._advanceCacheRevision();
    
    for (const key of keyList) {
      this.cache.delete(key);
    }

    // Cache invalidated - logged at TRACE level for detailed debugging
    // this.logger.debug(`Invalidated cache for ${keyList.length} key(s)`);
  }

  /**
   * Clear entire cache
   */
  clearCache() {
    this._advanceCacheRevision();
    this.cache.clear();
    // Cache cleared - logged at TRACE level for detailed debugging
    // this.logger.debug('Cache cleared');
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
      isReady: this._isReady
    };
  }

  /**
   * Add event listener
   * @param {string} event - Event name (change, set, remove, clear)
   * @param {Function} callback - Callback function
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
  }

  /**
   * Remove event listener
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
      
      // Clean up empty listener sets
      if (this.listeners.get(event).size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Emit event to listeners
   * @private
   */
  _emit(event, data) {
    if (this.listeners.has(event)) {
      const callbacks = this.listeners.get(event);
      for (const callback of callbacks) {
        try {
          callback(data);
        } catch (error) {
          if (isContextError(error)) {
            handleContextError(error, `storage-core-emit-${event}`);
          } else {
            this.logger.error(`Event listener error for '${event}'`, error);
          }
        }
      }
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    try {
      // Remove storage change listener (handled by ResourceTracker)
      // Clear cache and listeners
      this.cache.destroy();
      this.listeners.clear();

      this._isReady = false;
      this.logger.operation('Cleanup completed');
    } catch (error) {
      this.logger.warn('Cleanup error', error);
    }
  }

  /**
   * Destroy the storage core and cleanup all resources
   */
  destroy() {
    this.cleanup();
    // Call parent destroy
    super.destroy();
  }
}

// Create singleton instance
const storageCore = new StorageCore();

// Export singleton and class with new names
export { storageCore, StorageCore };

// Backward compatibility exports
export const storageManager = storageCore;
export const StorageManager = StorageCore;

// Default export
export default storageCore;
