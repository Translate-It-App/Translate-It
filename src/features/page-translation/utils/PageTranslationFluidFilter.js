import { PageTranslationHelper } from '../PageTranslationHelper.js';
import { PAGE_TRANSLATION_TIMING } from '../PageTranslationConstants.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

/**
 * PageTranslationFluidFilter - Optimized filtering logic for "Fluid" mode.
 * Prioritizes Viewport items by score and fills remaining capacity with buffer items.
 */
export class PageTranslationFluidFilter {
  /**
   * Filter and prioritize items for a fluid translation batch.
   * @param {Array} queue - Current scheduler queue
   * @param {Object} config - Batch configuration (chunkSize, maxChars)
   * @returns {Object} { batchItems, remainingItems }
   */
  static process(queue, config) {
    const logger = getScopedLogger(LOG_COMPONENTS.PAGE_TRANSLATION, 'FluidFilter');
    const viewportBuffer = PAGE_TRANSLATION_TIMING.VIEWPORT_BUFFER_PX || 100;
    const { chunkSize, maxChars } = config;

    const viewportItems = [];
    const bufferItems = [];
    const otherItems = [];

    // 1. Partitioning (Categorize items by visibility)
    for (const item of queue) {
      const targetNode = item.node || item.textNode || item;
      
      // Pass logger to identify why items are skipped
      if (PageTranslationHelper.isInViewportWithMargin(targetNode, 0, logger)) {
        viewportItems.push(item);
      } else if (PageTranslationHelper.isInViewportWithMargin(targetNode, viewportBuffer, logger)) {
        bufferItems.push(item);
      } else {
        otherItems.push(item);
      }
    }

    // RULE: If no items in viewport OR buffer, we don't start a batch in lazy mode.
    // This prevents unnecessary API calls for far-away content.
    const isLazy = config.lazyLoading !== false;
    if (viewportItems.length === 0 && bufferItems.length === 0 && isLazy) {
      logger.debugLazy(() => ['Fluid Filter Results:', JSON.stringify({
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
      })]);
      if (config.diagnostics) {
        config.diagnostics.stopReason = 'insufficient_eligible_items';
        config.diagnostics.stoppingReasons = { viewport: 'not_applicable', buffer: 'not_applicable', offscreen: 'not_applicable' };
      }
      return { batchItems: [], remainingItems: queue };
    }

    // 2. Sorting: Prioritize by Context, then Target-Script Match, then Score
    // This quarantines texts that match target script to prevent poisoning other items.
    const contextSorter = (a, b) => 
      (a.contextId - b.contextId) || 
      (Number(a.matchesTargetScript) - Number(b.matchesTargetScript)) || 
      (b.score - a.score);
    
    viewportItems.sort(contextSorter);
    bufferItems.sort(contextSorter);
    if (!isLazy) {
      otherItems.sort(contextSorter);
    }

    const batchItems = [];
    let currentChars = 0;
    let batchMatchesTarget = null;
    const stoppingReasons = {
      viewport: viewportItems.length ? 'insufficient_eligible_items' : 'not_applicable',
      buffer: 'not_applicable',
      offscreen: 'not_applicable',
    };

    // 3. Selection Phase A: Viewport Items (Up to chunkSize/maxChars)
    for (const item of viewportItems) {
      if (batchItems.length >= chunkSize) { stoppingReasons.viewport = 'capacity'; break; }
      if (currentChars + item.text.length > maxChars && batchItems.length > 0) { stoppingReasons.viewport = 'character_limit'; break; }
      
      // SCRIPT PURITY: Don't mix "target-script matches" with "other scripts"
      if (batchItems.length > 0 && item.matchesTargetScript !== batchMatchesTarget) { stoppingReasons.viewport = 'script_boundary'; break; }
      
      if (batchItems.length === 0) batchMatchesTarget = item.matchesTargetScript;

      batchItems.push(item);
      currentChars += item.text.length;
    }
    if (batchItems.length >= chunkSize && stoppingReasons.viewport === 'insufficient_eligible_items') {
      stoppingReasons.viewport = 'capacity';
    }

    // Identify remaining viewport items that didn't fit
    const selectedIds = new Set(batchItems.map(i => i.id || i));
    const remainingViewportItems = viewportItems.filter(i => !selectedIds.has(i.id || i));

    // 4. Selection Phase B: Smart Buffer Filling (Only if space is left)
    const usedBufferItems = [];
    if (batchItems.length < chunkSize) {
      if (bufferItems.length) stoppingReasons.buffer = 'insufficient_eligible_items';
      for (const item of bufferItems) {
        if (batchItems.length >= chunkSize) { stoppingReasons.buffer = 'capacity'; break; }
        if (currentChars + item.text.length > maxChars) { stoppingReasons.buffer = 'character_limit'; break; }

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

    // 5. Selection Phase C: Off-Screen Filling (Only if NOT lazy and space is left)
    const usedOtherItems = [];
    if (!isLazy && batchItems.length < chunkSize) {
      if (otherItems.length) stoppingReasons.offscreen = 'insufficient_eligible_items';
      for (const item of otherItems) {
        if (batchItems.length >= chunkSize) { stoppingReasons.offscreen = 'capacity'; break; }
        if (currentChars + item.text.length > maxChars) { stoppingReasons.offscreen = 'character_limit'; break; }

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

    // 6. Finalizing Remaining Queue
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
      return ['Fluid Filter Results:', JSON.stringify({
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
      })];
    });

    return { batchItems, remainingItems };
  }
}
