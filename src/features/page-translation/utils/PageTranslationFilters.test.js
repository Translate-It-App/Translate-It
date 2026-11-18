import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PageTranslationQueueFilter } from './PageTranslationQueueFilter.js';
import { PageTranslationFluidFilter } from './PageTranslationFluidFilter.js';
import { PageTranslationHelper } from '../PageTranslationHelper.js';
import { getScopedLogger } from '@/shared/logging/logger.js';

vi.mock('../PageTranslationHelper.js', () => ({
  PageTranslationHelper: {
    isInViewportWithMargin: vi.fn()
  }
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    debugLazy: vi.fn()
  }))
}));

describe('PageTranslation Filters', () => {
  let queue;
  let config;

  beforeEach(() => {
    vi.clearAllMocks();
    queue = [
      { id: 1, text: 'Item 1', score: 1, matchesTargetScript: false, contextId: 10 },
      { id: 2, text: 'Item 2', score: 2, matchesTargetScript: false, contextId: 10 },
      { id: 3, text: 'Item 3', score: 0.5, matchesTargetScript: false, contextId: 20 },
      { id: 4, text: 'Item 4', score: 3, matchesTargetScript: true, contextId: 10 },
    ];
    config = {
      chunkSize: 10,
      maxChars: 1000,
      lazyLoading: true
    };
  });

  const runFilterTest = (FilterClass) => {
    describe(`${FilterClass.name}`, () => {
      it('should prioritize viewport items', () => {
        // Mock Item 3 as in viewport, others not
        PageTranslationHelper.isInViewportWithMargin.mockImplementation((node) => {
          if (node.id === 3) return true;
          return false;
        });

        const { batchItems } = FilterClass.process(queue, config);
        expect(batchItems[0].id).toBe(3);
      });

      it('should respect chunkSize limit', () => {
        config.chunkSize = 2;
        PageTranslationHelper.isInViewportWithMargin.mockReturnValue(true);

        const { batchItems, remainingItems } = FilterClass.process(queue, config);
        expect(batchItems).toHaveLength(2);
        expect(remainingItems).toHaveLength(2);
      });

      it('should respect maxChars limit', () => {
        config.maxChars = 10; // 'Item 1' is 6 chars, 'Item 2' is 6 chars. Together 12 > 10.
        PageTranslationHelper.isInViewportWithMargin.mockReturnValue(true);

        const { batchItems } = FilterClass.process(queue, config);
        expect(batchItems).toHaveLength(1);
      });

      it('should maintain script purity (don\'t mix matchesTargetScript)', () => {
        PageTranslationHelper.isInViewportWithMargin.mockReturnValue(true);
        // Item 4 matches target script, others don't.
        // Item 1, 2, 3 have contextId 10, 10, 20.
        // Sorting will group Item 1, 2, 4 (contextId 10) then Item 3 (contextId 20).
        // Within contextId 10, sorting is (Number(a.matchesTargetScript) - Number(b.matchesTargetScript))
        // So matchesTargetScript=false (Item 1, 2) comes before matchesTargetScript=true (Item 4).
        
        const { batchItems } = FilterClass.process(queue, config);
        
        // The first item defines the script purity for the batch
        const firstMatch = batchItems[0].matchesTargetScript;
        expect(batchItems.every(item => item.matchesTargetScript === firstMatch)).toBe(true);
      });

      it('should return empty batch if lazy and nothing in viewport/buffer', () => {
        PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
        const { batchItems, remainingItems } = FilterClass.process(queue, config);
        expect(batchItems).toHaveLength(0);
        expect(remainingItems).toHaveLength(queue.length);
      });

      it('logs aggregate batch diagnostics without item text', () => {
        config.chunkSize = 2;
        PageTranslationHelper.isInViewportWithMargin.mockReturnValue(true);

        FilterClass.process(queue, { ...config, diagnostics: {
          sessionId: 'session-1', batchId: 7, concurrencyLimit: 3, preparationStartedAt: performance.now()
        } });

        const logger = getScopedLogger.mock.results.at(-1).value;
        const [message, serializedDetails] = logger.debugLazy.mock.calls.at(-1)[0]();
        const details = JSON.parse(serializedDetails);
        expect(message).toMatch(/Filter Results/);
        expect(serializedDetails).not.toContain('\n');
        expect(details).toMatchObject({
          sessionId: 'session-1', batchId: 7, concurrencyLimit: 3,
          totalQueued: 4, viewportCount: 4, bufferCount: 0, offscreenCount: 0,
          selectedItemCount: 2, originalChars: 12, chunkSize: 2,
          stopReason: 'capacity', compatibleEligibleRemaining: 1
        });
        expect(JSON.stringify(details)).not.toContain('Item 1');
      });

      it('reports buffer-only compatible counts and keeps script-boundary stop reasons', () => {
        config.chunkSize = 1;
        const bufferItems = [
          { id: 'buffer-selected', text: 'selected', score: 1, matchesTargetScript: false, contextId: 1 },
          { id: 'buffer-compatible', text: 'compatible', score: 1, matchesTargetScript: false, contextId: 1 },
          { id: 'buffer-other-script', text: 'other', score: 1, matchesTargetScript: true, contextId: 1 },
        ];
        PageTranslationHelper.isInViewportWithMargin.mockImplementation((node, margin) => margin > 0);
        FilterClass.process(bufferItems, { ...config, diagnostics: { preparationStartedAt: performance.now() } });
        const logger = getScopedLogger.mock.results.at(-1).value;
        const details = JSON.parse(logger.debugLazy.mock.calls.at(-1)[0]()[1]);

        expect(details).toMatchObject({
          stopReason: 'capacity',
          stoppingReasons: { viewport: 'not_applicable', buffer: 'capacity', offscreen: 'not_applicable' },
          compatibleEligibleRemaining: 1,
        });
      });

      it('reports capacity when viewport fills exactly and eligible later phases are skipped', () => {
        config.chunkSize = 2;
        config.lazyLoading = false;
        const items = [
          { id: 'viewport-1', text: 'one', score: 1, matchesTargetScript: false, contextId: 1 },
          { id: 'viewport-2', text: 'two', score: 1, matchesTargetScript: false, contextId: 1 },
          { id: 'buffer-1', text: 'buffer', score: 1, matchesTargetScript: false, contextId: 1 },
          { id: 'offscreen-1', text: 'offscreen', score: 1, matchesTargetScript: false, contextId: 1 },
        ];
        PageTranslationHelper.isInViewportWithMargin.mockImplementation((node, margin) => node.id.startsWith('viewport')
          ? margin === 0
          : node.id.startsWith('buffer') && margin > 0);
        FilterClass.process(items, { ...config, diagnostics: { preparationStartedAt: performance.now() } });
        const logger = getScopedLogger.mock.results.at(-1).value;
        const details = JSON.parse(logger.debugLazy.mock.calls.at(-1)[0]()[1]);

        expect(details).toMatchObject({
          selectedItemCount: 2,
          stopReason: 'capacity',
          stoppingReasons: { viewport: 'capacity', buffer: 'capacity', offscreen: 'capacity' },
        });
      });

      it('keeps a viewport script boundary as the final reason when buffer work exhausts', () => {
        config.chunkSize = 4;
        const items = [
          { id: 'viewport-other-script', text: 'other', score: 1, matchesTargetScript: true, contextId: 1 },
          { id: 'viewport-first-script', text: 'first', score: 1, matchesTargetScript: false, contextId: 1 },
          { id: 'buffer-item', text: 'buffer', score: 1, matchesTargetScript: false, contextId: 1 },
        ];
        PageTranslationHelper.isInViewportWithMargin.mockImplementation((node, margin) => node.id.startsWith('viewport')
          ? margin === 0
          : margin > 0);
        FilterClass.process(items, { ...config, diagnostics: { preparationStartedAt: performance.now() } });
        const logger = getScopedLogger.mock.results.at(-1).value;
        const details = JSON.parse(logger.debugLazy.mock.calls.at(-1)[0]()[1]);

        expect(details).toMatchObject({
          selectedItemCount: 2,
          stopReason: 'script_boundary',
          stoppingReasons: { viewport: 'script_boundary', buffer: 'insufficient_eligible_items' },
        });
      });

      it('counts remaining work compatible with every script represented in the batch', () => {
        config.chunkSize = 3;
        const mixedItems = [
          { id: 'viewport-latin', text: 'latin', score: 1, matchesTargetScript: false, contextId: 1 },
          { id: 'viewport-target', text: 'target', score: 1, matchesTargetScript: true, contextId: 1 },
          { id: 'buffer-target', text: 'buffer target', score: 1, matchesTargetScript: true, contextId: 1 },
          { id: 'remaining-latin', text: 'remaining latin', score: 1, matchesTargetScript: false, contextId: 1 },
          { id: 'remaining-target', text: 'remaining target', score: 1, matchesTargetScript: true, contextId: 1 },
        ];
        PageTranslationHelper.isInViewportWithMargin.mockImplementation((node, margin) => node.id.startsWith('viewport')
          ? margin === 0
          : margin > 0);
        FilterClass.process(mixedItems, { ...config, diagnostics: { preparationStartedAt: performance.now() } });
        const logger = getScopedLogger.mock.results.at(-1).value;
        const details = JSON.parse(logger.debugLazy.mock.calls.at(-1)[0]()[1]);

        expect(details).toMatchObject({
          selectedItemCount: 3,
          compatibleEligibleRemaining: 2,
          stoppingReasons: { viewport: 'script_boundary', buffer: 'capacity' },
        });
      });

      it('should fill batch from off-screen if NOT lazy', () => {
        config.lazyLoading = false;
        PageTranslationHelper.isInViewportWithMargin.mockReturnValue(false);
        
        const { batchItems } = FilterClass.process(queue, config);
        expect(batchItems.length).toBeGreaterThan(0);
      });
    });
  };

  runFilterTest(PageTranslationQueueFilter);
  runFilterTest(PageTranslationFluidFilter);

  describe('PageTranslationQueueFilter Specifics', () => {
    it('should purge distant items if queue is too large', () => {
      const largeQueue = Array.from({ length: 1100 }, (_, i) => ({
        id: i,
        text: 'text',
        node: { id: i }
      }));
      
      PageTranslationHelper.isInViewportWithMargin.mockImplementation((node, margin) => {
        if (margin > 1000) return false; // Too far
        return false;
      });

      const { purgedCount } = PageTranslationQueueFilter.process(largeQueue, config);
      expect(purgedCount).toBeGreaterThan(0);
    });
  });
});
