import browser from 'webextension-polyfill';
import { storageManager } from '@/shared/storage/core/StorageCore.js';
import ExtensionContextManager from '@/core/extensionContext.js';
import { CONFIG } from '@/shared/config/config.js';
import { findProviderById } from '@/features/translation/providers/ProviderManifest.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import ResourceTracker from '@/core/memory/ResourceTracker.js';

const logger = getScopedLogger(LOG_COMPONENTS.CORE, 'ActionbarIconManager');

/**
 * Actionbar Icon Manager - Minimal, fast, reliable
 * Manages browser action bar icons with dynamic provider overlays
 */
export class ActionbarIconManager {
  constructor() {
    this.resourceTracker = null;
    this.currentProvider = null;
    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized) return;

    if (this.resourceTracker) {
      try {
        this.resourceTracker.destroy();
      } catch {
        // ignore cleanup during retry
      }
      this.resourceTracker = null;
    }
    this.resourceTracker = new ResourceTracker('actionbar-icon-manager');

    try {
      // Get current provider
      const storedProvider = await storageManager.get('TRANSLATION_API');
      this.currentProvider = storedProvider.TRANSLATION_API || CONFIG.TRANSLATION_API;

      logger.debug(`Simple icon manager initialized for: ${this.currentProvider}`);

      // Update icon immediately
      await this.updateIcon(this.currentProvider);

      // Listen for provider changes using tracked event listener
      this.resourceTracker.addEventListener(storageManager, 'change', async (changes) => {
        // StorageCore emits change events as { key, newValue, oldValue }
        if (changes.key === 'TRANSLATION_API' && changes.newValue !== this.currentProvider) {
          this.currentProvider = changes.newValue;
          await this.updateIcon(this.currentProvider);
        }
      });

      this.isInitialized = true;

    } catch (error) {
      try {
        this.resourceTracker.destroy();
      } catch {
        // ignore
      }
      this.resourceTracker = null;
      // Use centralized context error detection
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'actionbar-icon-manager', {
          fallbackAction: () => {
            this.currentProvider = CONFIG.TRANSLATION_API;
            this.isInitialized = true;
          }
        });
        if (this.isInitialized) return;
      } else {
        logger.error('Failed to initialize ActionbarIconManager:', error);
      }
      throw error;
    }
  }

  /**
   * Update icon for provider
   */
  async updateIcon(provider) {
    try {
      logger.debug(`Updating icon for: ${provider}`);

      // Create composite icon with provider overlay
      const compositeImageData = await this.createCompositeIcon(provider);

      if (compositeImageData) {
        await this.setBrowserIconWithImageData(compositeImageData);
        logger.debug(`Icon updated for: ${provider}`);
      } else {
        logger.warn(`Failed to create composite icon for: ${provider}`);
      }

    } catch (error) {
      logger.error(`Failed to update icon for ${provider}:`, error);
    }
  }


  /**
   * Get icon path for provider
   */
  async getProviderIconPath(provider) {
    const providerConfig = findProviderById(provider);
    
    if (providerConfig && providerConfig.icon) {
      return `icons/providers/${providerConfig.icon}`;
    }

    return 'icons/providers/provider.png';
  }

  // Note: The following methods are no longer needed with the new path-based approach:
// - generateCompositeIcon: Removed in favor of static icon paths
// - fetchIcon: Removed as we now use direct paths
// - fetchProviderIcon: Removed as we now use direct paths

  /**
   * Load image and convert to imageData using fetch and OffscreenCanvas
   */
  async loadImageData(iconPath) {
    try {
      // Get full URL for the icon safely
      const fullUrl = ExtensionContextManager.safeGetURL(iconPath);
      
      if (!fullUrl || fullUrl.startsWith('data:')) {
        logger.warn(`Skipping loadImageData for non-extension URL or fallback: ${fullUrl}`);
        return null;
      }

      // Fetch the image
      const response = await fetch(fullUrl);
      if (!response.ok) {
        logger.error(`Failed to fetch image: ${fullUrl}`);
        return null;
      }

      // Create bitmap from image
      const bitmap = await createImageBitmap(await response.blob());

      // Convert to imageData for all sizes
      const imageData = {};
      const sizes = [16, 32, 48, 128];

      for (const size of sizes) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, size, size);
        imageData[size] = ctx.getImageData(0, 0, size, size);
      }

      // Cleanup
      bitmap.close();

      return imageData;
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'actionbar:loadImageData');
      } else {
        logger.error('Error in loadImageData:', error);
      }
      return null;
    }
  }

  /**
   * Create composite icon with provider overlay
   */
  async createCompositeIcon(provider) {
    try {
      // Load main extension icon
      const mainIconBitmap = await this.loadImageBitmap('icons/extension/extension_icon_128.png');

      // Load provider overlay icon
      const providerIconPath = await this.getProviderIconPath(provider);
      const providerIconBitmap = await this.loadImageBitmap(providerIconPath);

      // Simple fallback check
      if (!mainIconBitmap || !providerIconBitmap) {
        logger.warn(`Icon loading failed - Main: ${!!mainIconBitmap}, Provider: ${!!providerIconBitmap} for ${provider}`);
        return null;
      }

      // Create composite for all sizes
      const compositeImageData = {};
      const sizes = [16, 32, 48, 128];

      for (const size of sizes) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');

        // Draw main icon (scaled to full size)
        ctx.drawImage(mainIconBitmap, 0, 0, size, size);

        // Calculate overlay size and position (bottom-right corner)
        const overlaySize = Math.floor(size * 0.65); // 65% of main icon size for better visibility
        const overlayX = size - overlaySize - Math.floor(size * 0.02); // 2% padding
        const overlayY = size - overlaySize - Math.floor(size * 0.02);

        // Create temporary canvas for provider icon with transparency
        const providerCanvas = new OffscreenCanvas(overlaySize, overlaySize);
        const providerCtx = providerCanvas.getContext('2d');

        // Draw provider icon with scaling and transparency
        providerCtx.globalAlpha = 0.9; // Slight transparency for better blending
        providerCtx.drawImage(providerIconBitmap, 0, 0, overlaySize, overlaySize);

        // Draw provider overlay onto main canvas
        ctx.drawImage(providerCanvas, overlayX, overlayY);

        // Get final composite image data
        compositeImageData[size] = ctx.getImageData(0, 0, size, size);
      }

      // Cleanup
      if (mainIconBitmap) mainIconBitmap.close();
      if (providerIconBitmap) providerIconBitmap.close();

      return compositeImageData;
    } catch (error) {
      logger.error('Error creating composite icon:', error);
      return null;
    }
  }

  /**
   * Load image and return as ImageBitmap
   */
  async loadImageBitmap(iconPath) {
    try {
      // Get full URL for the icon safely
      const fullUrl = ExtensionContextManager.safeGetURL(iconPath);
      
      if (!fullUrl || fullUrl.startsWith('data:')) {
        return null;
      }

      // Simple fetch with basic error handling
      const response = await fetch(fullUrl);
      if (!response.ok) {
        logger.warn(`Failed to fetch image: ${fullUrl} - Status: ${response.status}`);
        return null;
      }

      // Create bitmap from image
      return await createImageBitmap(await response.blob());
    } catch (error) {
      if (ExtensionContextManager.isContextError(error)) {
        ExtensionContextManager.handleContextError(error, 'actionbar:loadImageBitmap');
      } else {
        logger.warn(`Error in loadImageBitmap for ${iconPath}:`, error.message);
      }
      return null;
    }
  }

  /**
   * Set browser icon with imageData
   */
  async setBrowserIconWithImageData(imageData) {
    try {
      if (browser.action && browser.action.setIcon) {
        await browser.action.setIcon({ imageData: imageData });
      } else if (browser.browserAction && browser.browserAction.setIcon) {
        await browser.browserAction.setIcon({ imageData: imageData });
      }
    } catch (error) {
      logger.error('Failed to set browser icon with imageData:', error);
      throw error;
    }
  }

  /**
   * Clear cache - No longer needed with path-based approach
   */
  clearCache() {
    // Cache is no longer used with path-based approach
    logger.debug('🧹 Icon cache cleared (no-op)');
  }

  destroy() {
    this.resourceTracker?.destroy();
    this.resourceTracker = null;
    this.isInitialized = false;
  }


}

let instance = null;
export async function getActionbarIconManager() {
  if (!instance) {
    instance = new ActionbarIconManager();
  }
  await instance.initialize();
  if (!instance.isInitialized) {
    throw new Error('ActionbarIconManager failed to initialize');
  }
  return instance;
}

export default getActionbarIconManager;
