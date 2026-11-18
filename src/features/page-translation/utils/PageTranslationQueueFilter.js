import { PageTranslationHelper } from '../PageTranslationHelper.js';
import { PAGE_TRANSLATION_TIMING } from '../PageTranslationConstants.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

/**
 * PageTranslationQueueFilter - Logic for filtering the translation queue.
 * Prioritizes Viewport items and fills remaining capacity with buffer items.
 */
export class PageTranslationQueueFilter {
  /**
   * Filter and prioritize items in the queue.
   * @param {Array} queue - Current scheduler queue
   * @param {Object} config - Batch configuration (chunkSize, maxChars, lazyLoading)
   * @returns {Object} { batchItems, remainingItems }
   */
  static process(queue, config) {
    const logger = getScopedLogger(LOG_COMPONENTS.PAGE_TRANSLATION, 'QueueFilter');
    const viewportBuffer = PAGE_TRANSLATION_TIMING.VIEWPORT_BUFFER_PX || 100;
    const { chunkSize, maxChars } = config;

    const viewportItems = [];
    const bufferItems = [];
    const otherItems = [];

    for (const item of queue) {
      const targetNode = item.node || item.textNode || item;

      // Pass logger for diagnostics
      if (PageTranslationHelper.isInViewportWithMargin(targetNode, 0, logger)) {
        viewportItems.push(item);
      } else if (PageTranslationHelper.isInViewportWithMargin(targetNode, viewportBuffer, logger)) {
        bufferItems.push(item);
      } else {
        otherItems.push(item);
      }
    }

    // 1b. Sorting: Prioritize by Context and Target-Script Match
    // This ensures that an API batch is "Pure" and won't be poisoned by target-language content.
    const contextSorter = (a, b) => 
      (a.contextId - b.contextId) || 
      (Number(a.matchesTargetScript) - Number(b.matchesTargetScript)) || 
      (b.score - a.score);

    viewportItems.sort(contextSorter);
    bufferItems.sort(contextSorter);
    otherItems.sort(contextSorter);

    // RULE: If no items in viewport OR buffer, we don't start a batch in lazy mode.
    const isLazy = config.lazyLoading !== false;
    if (viewportItems.length === 0 && bufferItems.length === 0 && isLazy) {
      // SMART PURGE: Only purge in lazy mode to avoid memory leaks during long scrolls
      if (queue.length > 1000) {
        const MAX_DISTANCE_PX = 3000;
        const purgeResult = this._purgeDistantItems(otherItems, MAX_DISTANCE_PX, logger);
        
        if (purgeResult.purgedCount > 0) {
          logger.debug(`Purged ${purgeResult.purgedCount} items that were too far (> ${MAX_DISTANCE_PX}px)`);
          logger.debugLazy(() => ['Filter Results (Smart Buffer):', {
            sessionId: config.diagnostics?.sessionId,
            batchId: config.diagnostics?.batchId,
            concurrencyLimit: config.diagnostics?.concurrencyLimit,
             preparationDurationMs: config.diagnostics ? performance.now() - config.diagnostics.preparationStartedAt : undefined,
            totalQueued: queue.length,
            viewportCount: viewportItems.length,
            bufferCount: bufferItems.length,
            offscreenCount: otherItems.length,
            selectedItemCount: 0,
            originalChars: 0,
            chunkSize,
            maxChars,
             stopReason: 'insufficient_eligible_items',
              stoppingReasons: { viewport: 'not_applicable', buffer: 'not_applicable', offscreen: 'not_applicable' },
            compatibleEligibleRemaining: 0
          }]);
          if (config.diagnostics) {
            config.diagnostics.stopReason = 'insufficient_eligible_items';
            config.diagnostics.stoppingReasons = { viewport: 'not_applicable', buffer: 'not_applicable', offscreen: 'not_applicable' };
          }
          return { batchItems: [], remainingItems: [...bufferItems, ...purgeResult.remaining], purgedCount: purgeResult.purgedCount, ejectedItems: purgeResult.ejectedItems };
        }
      }
      logger.debugLazy(() => ['Filter Results (Smart Buffer):', {
        sessionId: config.diagnostics?.sessionId,
        batchId: config.diagnostics?.batchId,
        concurrencyLimit: config.diagnostics?.concurrencyLimit,
         preparationDurationMs: config.diagnostics ? performance.now() - config.diagnostics.preparationStartedAt : undefined,
        totalQueued: queue.length,
        viewportCount: viewportItems.length,
        bufferCount: bufferItems.length,
        offscreenCount: otherItems.length,
        selectedItemCount: 0,
        originalChars: 0,
        chunkSize,
        maxChars,
         stopReason: 'insufficient_eligible_items',
          stoppingReasons: { viewport: 'not_applicable', buffer: 'not_applicable', offscreen: 'not_applicable' },
        compatibleEligibleRemaining: 0
      }]);
      if (config.diagnostics) {
        config.diagnostics.stopReason = 'insufficient_eligible_items';
        config.diagnostics.stoppingReasons = { viewport: 'not_applicable', buffer: 'not_applicable', offscreen: 'not_applicable' };
      }
      return { batchItems: [], remainingItems: queue };
    }

    const batchItems = [];
    let currentChars = 0;
    let batchMatchesTarget = null;
    const stoppingReasons = {
      viewport: viewportItems.length ? 'insufficient_eligible_items' : 'not_applicable',
      buffer: 'not_applicable',
      offscreen: 'not_applicable',
    };

    // 1. Selection Phase A: Viewport Items (Up to chunkSize/maxChars)
    for (const item of viewportItems) {
      if (batchItems.length >= chunkSize) { stoppingReasons.viewport = 'capacity'; break; }
      if (maxChars && currentChars + item.text.length > maxChars && batchItems.length > 0) { stoppingReasons.viewport = 'character_limit'; break; }
      
      // SCRIPT PURITY: Don't mix "target-script matches" with "other scripts"
      if (batchItems.length > 0 && item.matchesTargetScript !== batchMatchesTarget) { stoppingReasons.viewport = 'script_boundary'; break; }
      if (batchItems.length === 0) batchMatchesTarget = item.matchesTargetScript;

      batchItems.push(item);
      currentChars += item.text.length;
    }
    if (batchItems.length >= chunkSize && stoppingReasons.viewport === 'insufficient_eligible_items') {
      stoppingReasons.viewport = 'capacity';
    }

    const selectedIds = new Set(batchItems.map(i => i.id || i));
    const remainingViewportItems = viewportItems.filter(i => !selectedIds.has(i.id || i));

    // 2. Selection Phase B: Smart Buffer Filling (Only if space is left)
    const usedBufferItems = [];
    if (batchItems.length < chunkSize) {
      if (bufferItems.length) stoppingReasons.buffer = 'insufficient_eligible_items';
      for (const item of bufferItems) {
        if (batchItems.length >= chunkSize) { stoppingReasons.buffer = 'capacity'; break; }
        if (maxChars && currentChars + item.text.length > maxChars) { stoppingReasons.buffer = 'character_limit'; break; }

        batchItems.push(item);
        usedBufferItems.push(item);
        currentChars += item.text.length;
      }
      if (batchItems.length >= chunkSize && stoppingReasons.buffer === 'insufficient_eligible_items') {
        stoppingReasons.buffer = 'capacity';
      }
    } else if (bufferItems.length) {
      stoppingReasons.buffer = 'capacity';
    }

    const usedBufferIds = new Set(usedBufferItems.map(i => i.id || i));
    const remainingBufferItems = bufferItems.filter(i => !usedBufferIds.has(i.id || i));

    // 3. Selection Phase C: Off-Screen Filling (Only if NOT lazy and space is left)
    const usedOtherItems = [];
    if (!isLazy && batchItems.length < chunkSize) {
      if (otherItems.length) stoppingReasons.offscreen = 'insufficient_eligible_items';
      for (const item of otherItems) {
        if (batchItems.length >= chunkSize) { stoppingReasons.offscreen = 'capacity'; break; }
        if (maxChars && currentChars + item.text.length > maxChars) { stoppingReasons.offscreen = 'character_limit'; break; }

        batchItems.push(item);
        usedOtherItems.push(item);
        currentChars += item.text.length;
      }
      if (batchItems.length >= chunkSize && stoppingReasons.offscreen === 'insufficient_eligible_items') {
        stoppingReasons.offscreen = 'capacity';
      }
    } else if (!isLazy && batchItems.length >= chunkSize && otherItems.length) {
      stoppingReasons.offscreen = 'capacity';
    }

    const usedOtherIds = new Set(usedOtherItems.map(i => i.id || i));
    const remainingOtherItems = otherItems.filter(i => !usedOtherIds.has(i.id || i));

    // 4. Finalizing Remaining Queue
    const remainingItems = [
      ...remainingViewportItems,
      ...remainingBufferItems,
      ...remainingOtherItems
    ];

    const lastApplicableReason = [stoppingReasons.viewport, stoppingReasons.buffer, stoppingReasons.offscreen]
      .filter(reason => reason !== 'not_applicable').at(-1);
    const lastSelectionConstraint = [stoppingReasons.viewport, stoppingReasons.buffer, stoppingReasons.offscreen]
      .filter(reason => reason === 'character_limit' || reason === 'script_boundary').at(-1);
    const finalStopReason = batchItems.length >= chunkSize
      ? 'capacity'
      : lastSelectionConstraint || lastApplicableReason || 'insufficient_eligible_items';
    if (config.diagnostics) {
      config.diagnostics.stopReason = finalStopReason;
      config.diagnostics.stoppingReasons = stoppingReasons;
    }

    logger.debugLazy(() => {
      const eligibleRemaining = [...remainingViewportItems, ...remainingBufferItems, ...(!isLazy ? remainingOtherItems : [])];
      const selectedScripts = new Set(batchItems.map(item => item.matchesTargetScript));
      const compatibleEligibleRemaining = selectedScripts.size === 0
        ? eligibleRemaining.length
        : eligibleRemaining.filter(item => selectedScripts.has(item.matchesTargetScript)).length;
      return ['Filter Results (Smart Buffer):', {
        sessionId: config.diagnostics?.sessionId,
        batchId: config.diagnostics?.batchId,
        concurrencyLimit: config.diagnostics?.concurrencyLimit,
         preparationDurationMs: config.diagnostics ? performance.now() - config.diagnostics.preparationStartedAt : undefined,
        totalQueued: queue.length,
        viewportCount: viewportItems.length,
        bufferCount: bufferItems.length,
        offscreenCount: otherItems.length,
        selectedItemCount: batchItems.length,
        originalChars: currentChars,
        chunkSize,
        maxChars,
         stopReason: finalStopReason,
         stoppingReasons,
        compatibleEligibleRemaining,
        remaining: remainingItems.length
      }];
    });

    return { batchItems, remainingItems };
  }

  /**
   * Internal helper to filter out items that are physically far from the viewport.
   * Marks them as "ejected" so the scheduler can handle them specially.
   */
  static _purgeDistantItems(items, maxDistance, logger = null) {
    const remaining = [];
    let purgedCount = 0;

    for (const item of items) {
      const targetNode = item.node || item.textNode || item;
      
      // If we can't determine distance or it's within range, keep it
      if (!targetNode || PageTranslationHelper.isInViewportWithMargin(targetNode, maxDistance, logger)) {
        remaining.push(item);
      } else {
        // MARK FOR RETRY: Instead of final resolution, mark it as ejected.
        // The scheduler will resolve it with the original text but in a way 
        // that allows domtranslator to potentially try again later if it becomes visible.
        item.isEjected = true;
        purgedCount++;
      }
    }

    return { remaining, purgedCount, ejectedItems: items.filter(i => i.isEjected) };
  }
}
