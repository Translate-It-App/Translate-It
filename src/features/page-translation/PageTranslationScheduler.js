import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessageFormat, MessageContexts, reconstructTranslationError } from '@/shared/messaging/core/MessagingCore.js';
import { TranslationMode } from '@/shared/config/config.js';
import { 
  getTranslationApiAsync, 
  getTargetLanguageAsync,
  getWholePageMaxCharsAsync,
  getWholePageAiMaxCharsAsync
} from '@/config.js';
import { AUTO_DETECT_VALUE } from '@/shared/constants/core.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { isFatalError, matchErrorToType } from '@/shared/error-management/ErrorMatcher.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import ExtensionContextManager from '@/core/extensionContext.js';
import { isRTL } from '@/utils/dom/DomDirectionManager.js';
import { PageTranslationHelper } from './PageTranslationHelper.js';
import { shouldApplyRtl } from '@/shared/utils/text/textAnalysis.js';
import { DEFAULT_PAGE_TRANSLATION_SETTINGS, PAGE_TRANSLATION_TIMING } from './PageTranslationConstants.js';
import { PageTranslationQueueFilter } from './utils/PageTranslationQueueFilter.js';
import { PageTranslationFluidFilter } from './utils/PageTranslationFluidFilter.js';
import ResourceTracker from '@/core/memory/ResourceTracker.js';
import { sendRegularMessage, safeSendMessage } from '@/shared/messaging/core/UnifiedMessaging.js';
import { registryIdToName, isProviderType, ProviderTypes } from '@/features/translation/providers/ProviderConstants.js';

const INTERNAL_CANCELLATION_REASON = 'operation-abort';

/**
 * PageTranslationScheduler - Optimized translation scheduler inspired by AnyLang.
 * Handles batching, prioritization (Viewport first), and fault tolerance.
 */
export class PageTranslationScheduler extends ResourceTracker {
  constructor({ onFatalError, onLifecycleEvent, onInternalError } = {}) {
    super('page-translation-scheduler');
    this.logger = getScopedLogger(LOG_COMPONENTS.PAGE_TRANSLATION, 'Scheduler');
    this.onFatalError = typeof onFatalError === 'function' ? onFatalError : null;
    this.onLifecycleEvent = typeof onLifecycleEvent === 'function' ? onLifecycleEvent : null;
    this.onInternalError = typeof onInternalError === 'function' ? onInternalError : null;
    this.queue = []; // Tasks: { text, score, resolve, reject, context, node }
    this.batchTimer = null;
    this.translatedCount = 0;
    this.failedCount = 0;
    this.totalTasks = 0;
    this.activeFlushes = 0;
    this.fatalErrorOccurred = false;
    // Keep latest non-fatal terminal cause for zero-result completion.
    this.lastNonFatalError = null;
    this.isFirstBatch = true;
    this.isTranslated = false;
    this.translationSessionId = null;
    this.sessionContext = null;
    this.isScrolling = false;
    this.highPriorityCount = 0;
    this.isWaitingForVisibility = false; // flag to track idle state
    
    // Memory-safe map for logical context grouping
    this.contextMap = new WeakMap();
    this._nextContextId = 1;
    this._nextItemId = 1;

    this.settings = { 
      ...DEFAULT_PAGE_TRANSLATION_SETTINGS,
      poolDelay: 150, // Time to wait for collecting more items (AnyLang style)
      priorityThreshold: 1, // Any score >= this is considered high priority (Viewport)
    };

    // Throttling state for progress reporting
    this._lastReportTime = 0;
    this._reportInterval = 300; // ms
    this._reportPending = false;
    this._completionTimer = null;
    this.pendingSettlements = new Set();
    this.activeBatches = new Set();

    // Register queue for automatic memory management via ResourceTracker
    this.trackResource('translation-queue', () => {
      if (this.queue.length > 0) {
        this.logger.debug('Cleaning up queue via ResourceTracker', this.queue.length);
        this.queue = [];
      }
      this.contextMap = new WeakMap(); // Reset context map
      this._nextContextId = 1;
    });
  }

  setSettings(settings) {
    this.settings = { ...this.settings, ...settings };
  }

  _emitLifecycle(action, data, sessionId = this.translationSessionId) {
    const lifecycleData = typeof sessionId === 'string' && sessionId.length > 0
      ? { ...data, sessionId }
      : data;

    if (this.onLifecycleEvent) {
      this.onLifecycleEvent(action, lifecycleData);
      return;
    }

    // Standalone scheduler consumers retain local presentation behavior.
    pageEventBus.emit(action, lifecycleData);
  }

  setTranslationState(isTranslated, sessionId, sessionContext = null, cancellationReason) {
    if (!isTranslated) {
      this.stop('cancelled', cancellationReason);
    } else {
      this.lastNonFatalError = null;
      this.isTranslated = isTranslated;
      this.translationSessionId = sessionId;
      this.sessionContext = sessionContext;
    }
  }

  reset() {
    this.stop();
    this.translatedCount = 0;
    this.failedCount = 0;
    this.totalTasks = 0;
    this.highPriorityCount = 0;
    this.isWaitingForVisibility = false;
    this.fatalErrorOccurred = false;
    this.translationSessionId = null;
    this.sessionContext = null;
    this._lastReportTime = 0;
    this._reportPending = false;
    this.contextMap = new WeakMap();
    this._nextContextId = 1;
  }

  stop(settlementOutcome = 'cancelled', cancellationReason = INTERNAL_CANCELLATION_REASON) {
    const wasTranslating = this.isTranslated;
    this.isTranslated = false;
    this.lastNonFatalError = null;
    this.sessionContext = null;
    this._reportPending = false;
    this.isScrolling = false;
    this.isWaitingForVisibility = false;
    this.contextMap = new WeakMap();
    
    // CRITICAL: Notify background to abort any pending batch for this session
    if (wasTranslating && this.translationSessionId) {
      this.logger.debug(`[Scheduler] Sending cancel signal for session: ${this.translationSessionId}`);
      sendRegularMessage({
        action: MessageActions.CANCEL_TRANSLATION,
        data: { 
          cancelAll: true,
          context: MessageContexts.PAGE_TRANSLATION_BATCH,
          sessionId: this.translationSessionId,
          reason: cancellationReason
        }
      }).then(response => {
        this.logger.debug('[Scheduler] Cancel signal acknowledged by background:', response);
      }).catch(err => {
        this.logger.error('[Scheduler] Failed to send cancel signal:', err);
      });
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this._completionTimer) {
      clearTimeout(this._completionTimer);
      this._completionTimer = null;
    }
    
    if (this.queue.length > 0) {
      const itemsToReject = [...this.queue];
      this.queue = [];
      this.highPriorityCount = 0;
      itemsToReject.forEach(item => this._resolveItem(item, item.text, settlementOutcome));
    }

    const activeBatches = [...this.activeBatches];
    this.activeBatches.clear();
    activeBatches.forEach(({ items }) => {
      items.forEach(item => this._resolveItem(item, item.text, settlementOutcome));
    });

    [...this.pendingSettlements].forEach(settlement => settlement.settle(settlementOutcome));
    this.activeFlushes = 0;
    this.isFirstBatch = true;
  }

  _createSettlement(item, text) {
    // Provider success stays pending until Bridge validates its DOM target.
    let state = 'pending';
    const settlement = {
      __pageTranslationSettlement: true,
      text,
      get state() {
        return state;
      },
      settle: (outcome) => {
        if (state !== 'pending') return false;
        state = outcome;
        this.pendingSettlements.delete(settlement);
        if (outcome === 'accepted') this.translatedCount++;
        if (outcome === 'stale' || outcome === 'failed') this.failedCount++;
        if (outcome === 'accepted' || outcome === 'stale') {
          this._reportProgress();
          this._checkCompletion();
        }
        return true;
      },
    };
    this.pendingSettlements.add(settlement);
    return settlement;
  }

  _resolveItem(item, text, outcome) {
    if (!item || item.settled) return;
    item.settled = true;
    const settlement = this._createSettlement(item, text);
    if (outcome !== 'success') settlement.settle(outcome);
    try {
      item.resolve(settlement);
    } catch {
      // Ignore resolution errors
    }
  }

  recordRetainedTranslation(context) {
    if (!this.isTranslated || context !== this.sessionContext) return;
    this.totalTasks++;
    this.translatedCount++;
    this._reportProgress();
    this._checkCompletion();
  }

  /**
   * Enqueue a text for translation with a given priority (score).
   * @param {string} text - Text to translate
   * @param {any} context - Session context validation
   * @param {number} score - Priority score from domtranslator (greater = more important)
   * @param {Node} node - Associated DOM node for visibility check
   */
  async enqueue(text, context = null, score = 0, node = null) {
    // 1. Session & State Validation
    if (context && context !== this.sessionContext) return text;
    if (!this.isTranslated || this.fatalErrorOccurred || !text || !text.trim()) return text;
    
    // Pass this.logger for diagnostic visibility
    if (!PageTranslationHelper.shouldTranslate(text)) {
      // Diagnostic for skipped items
      this.logger.debugLazy(() => [`Item rejected by shouldTranslate: "${text.substring(0, 20)}..."`]);
      return text;
    }

    this.totalTasks++;
    this._reportProgress();

    const isHighPriority = score >= this.settings.priorityThreshold;

    // 2. Discover Logical Context and Script Type for smart grouping
    const container = PageTranslationHelper.getNearestSemanticContainer(node);
    let contextId = 0; 
    
    if (container) {
      if (!this.contextMap.has(container)) {
        this.contextMap.set(container, this._nextContextId++);
      }
      contextId = this.contextMap.get(container);
    }

    // Identify script group to prevent mixing target-language script and other scripts in a single batch.
    // This is the "Ultimate Solution" to prevent language detection traps for ALL languages.
    const isTargetRtl = isRTL(this.settings.targetLanguage);
    const textIsRtl = shouldApplyRtl(text);
    
    // Flag if this text's script matches the target language's script
    // (e.g., if target is Farsi, flag all RTL texts; if target is English, flag all Latin texts)
    const matchesTargetScript = (isTargetRtl === textIsRtl);

    return new Promise((resolve, reject) => {
      this.queue.push({ 
        id: String(this._nextItemId++),
        text: text.trim(), 
        score: score || 0, 
        isHighPriority,
        contextId,
        isRtlText: textIsRtl,
        matchesTargetScript, // Added: for ultimate script-pure batching
        resolve, 
        reject, 
        context,
        node
      });

      if (isHighPriority) {
        this.highPriorityCount++;
      }

      this._scheduleFlush(score);
    });
  }

  /**
   * External signal that scrolling has stopped.
   * Ensures that any pending items in the queue are processed once motion stops.
   */
  signalScrollStop() {
    this.isScrolling = false;
    this.logger.debug('Signal: Scroll Stop. Queue size:', this.queue.length);
    this.flush();
  }

  /**
   * External signal that scrolling has started.
   */
  signalScrollStart() {
    this.isScrolling = true;
    
    // If we are waiting for a scroll stop, clear any pending automatic timers
    // to ensure we strictly wait for the next stop.
    if (this.settings.translateAfterScrollStop && this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Smart scheduling based on priority.
   * High priority (Viewport) triggers faster flushes.
   */
  _scheduleFlush(score) {
    if (this.activeFlushes >= (this.settings.maxConcurrentFlushes || 1)) return;

    // 1. EMERGENCY FLUSH (Memory Safety)
    // If total queue is massive (e.g. 1000+), flush regardless of state to prevent memory issues.
    if (this.queue.length >= 1000) {
      this.logger.debug('Queue reached emergency limit (1000). Forcing flush.');
      this.flush();
      return;
    }

    // 2. CAPACITY FLUSH (Efficiency)
    // If we have enough HIGH PRIORITY items to fill a full API request (chunkSize),
    // we flush immediately UNLESS:
    // a) We are in "On Stop" mode and still scrolling.
    // b) We are in "Fluid" mode and it's not the first batch (we want to respect the user's delay).
    if (this.highPriorityCount >= (this.settings.chunkSize || 250)) {
      const isFluidAndNotFirst = !this.settings.translateAfterScrollStop && !this.isFirstBatch;
      const shouldWait = (this.settings.translateAfterScrollStop && this.isScrolling && !this.isFirstBatch) || isFluidAndNotFirst;
      
      if (!shouldWait) {
        this.logger.debug('High-priority items reached capacity. Forcing immediate flush.');
        this.flush();
        return;
      }
    }

    // 3. ON-STOP MODE CONTROL
    // IF in "On Stop" mode AND currently busy (scrolling or dynamic activity): 
    // DO NOT schedule automatic timed flushes EXCEPT for the very first batch.
    if (this.settings.translateAfterScrollStop && this.isScrolling && !this.isFirstBatch) {
      return;
    }

    const isHighPriority = score >= this.settings.priorityThreshold;
    
    // Adaptive delay: 
    // - Very first batch is slightly delayed to collect initial content.
    // - High priority items (Viewport) trigger faster processing.
    // - Low priority items:
    //    a) If translateAfterScrollStop is true: use poolDelay (internal batching)
    //    b) If translateAfterScrollStop is false (Fluid): use user-defined scrollStopDelay
    const standardDelay = this.settings.translateAfterScrollStop 
      ? (this.settings.poolDelay || PAGE_TRANSLATION_TIMING.STANDARD_LOAD_DELAY)
      : (this.settings.scrollStopDelay || PAGE_TRANSLATION_TIMING.STANDARD_LOAD_DELAY);

    const delay = this.isFirstBatch 
      ? PAGE_TRANSLATION_TIMING.FIRST_BATCH_DELAY 
      : (isHighPriority 
          ? Math.min(PAGE_TRANSLATION_TIMING.HIGH_PRIORITY_DELAY, standardDelay)
          : standardDelay);

    if (this.batchTimer) {
      // If a high-priority item comes in, we might want to speed up the existing timer
      if (isHighPriority && this.batchTimerDelay > 100) {
        clearTimeout(this.batchTimer);
        this.batchTimer = null;
      } else {
        return; // Already scheduled
      }
    }

    this.batchTimerDelay = delay;
    this.batchTimer = this.trackTimeout(() => this.flush(), delay);
  }

  async flush() {
    if (!this.isTranslated || this.queue.length === 0) {
      if (!this.isTranslated && this.queue.length > 0) this.stop();
      return;
    }
    
    // Respect concurrency limits
    if (this.activeFlushes >= (this.settings.maxConcurrentFlushes || 1)) {
      if (!this.batchTimer && this.isTranslated) {
        this.batchTimer = this.trackTimeout(() => this.flush(), PAGE_TRANSLATION_TIMING.CONCURRENCY_RETRY_DELAY);
      }
      return;
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    
    const flushSessionId = this.translationSessionId;
    const flushContext = this.sessionContext;
    this.activeFlushes++;
    let activeBatch = null;

    try {
      // Process batches in a loop as long as there are items and we are still translating
      while (this.queue.length > 0 && this.isTranslated && flushContext === this.sessionContext) {
        const config = await this._getBatchConfig();
        if (!this._ownsFlushSession(flushSessionId, flushContext)) return;
        if (this.activeFlushes > (this.settings.maxConcurrentFlushes || 1)) break;
        let currentBatch = [];

        // 1. SELECT BATCH: Use specialized filters based on the mode
        if (this.settings.translateAfterScrollStop) {
          const result = PageTranslationQueueFilter.process(this.queue, config);
          this._validateFilterResult(result);
          currentBatch = result.batchItems;
          const ejectedItems = Array.isArray(result.ejectedItems) ? result.ejectedItems : [];
          activeBatch = this._trackBatch(currentBatch, ejectedItems);
          this.queue = result.remainingItems;

          // HANDLE EJECTED ITEMS: These were too far, so we remove them from the 
          // scheduler's responsibility by resolving them with original text.
          if (result.purgedCount > 0) {
            ejectedItems.forEach(item => {
              if (item.isHighPriority) {
                this.highPriorityCount = Math.max(0, this.highPriorityCount - 1);
              }
              this._resolveItem(item, item.text, 'failed');
            });
          }
        } else {
          const result = PageTranslationFluidFilter.process(this.queue, config);
          this._validateFilterResult(result);
          currentBatch = result.batchItems;
          activeBatch = this._trackBatch(currentBatch);
          this.queue = result.remainingItems;
        }

        if (currentBatch.length === 0) {
          this.activeBatches.delete(activeBatch);
          activeBatch = null;
          this.logger.debug('No visible content in queue, stopping flush loop');
          this.isWaitingForVisibility = true; // No visible content found
          break;
        }

        // Update high priority count based on removed items
        const removedHighPriority = currentBatch.filter(item => item.isHighPriority).length;
        this.highPriorityCount = Math.max(0, this.highPriorityCount - removedHighPriority);
        this.isWaitingForVisibility = false; // We found something to translate

        // 2. EXECUTE BATCH: Process the selected items
        this.isFirstBatch = false;
        // Fill one available worker; provider-wide limits still own physical AI requests.
        if (config.parallelExecution && this.queue.length > 0
            && this.activeFlushes < (this.settings.maxConcurrentFlushes || 1)) {
          void this.flush();
        }
        await this._executeBatchRequest(currentBatch, config, flushContext, flushSessionId);
        this.activeBatches.delete(activeBatch);
        activeBatch = null;

        // 3. YIELD: Give event loop a breath if there's more work
        if (this.queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    } catch (error) {
      this.logger.error('Critical error in scheduler flush loop:', error);
      this._handleOuterFlushFailure(error, flushSessionId, flushContext);
    } finally {
      if (activeBatch) this.activeBatches.delete(activeBatch);
      // A stopped flush may settle after a newer session has started. Its
      // finalizer must not decrement the newer session's accounting.
      const ownsAccounting = this.translationSessionId === flushSessionId
        && this.sessionContext === flushContext;
      if (ownsAccounting) {
        this.activeFlushes--;
        this._checkCompletion();
      }
    }
  }

  _ownsFlushSession(sessionId, sessionContext) {
    return this.isTranslated
      && this.translationSessionId === sessionId
      && this.sessionContext === sessionContext;
  }

  _validateFilterResult(result) {
    if (!result || !Array.isArray(result.batchItems) || !Array.isArray(result.remainingItems)) {
      throw new TypeError('Page translation filter returned an invalid result');
    }
    if (result.purgedCount > 0 && !Array.isArray(result.ejectedItems)) {
      throw new TypeError('Page translation filter omitted ejected items');
    }
  }

  _trackBatch(batch, additionalItems = []) {
    const activeBatch = {
      items: [...batch, ...additionalItems]
    };
    this.activeBatches.add(activeBatch);
    return activeBatch;
  }

  _handleOuterFlushFailure(error, sessionId, sessionContext) {
    if (!this._ownsFlushSession(sessionId, sessionContext) || this.fatalErrorOccurred) return false;

    this.fatalErrorOccurred = true;
    const isContextError = ExtensionContextManager.isContextError(error);
    this.stop(
      isContextError ? 'cancelled' : 'failed',
      INTERNAL_CANCELLATION_REASON
    );

    this.onFatalError?.({
      error,
      errorType: matchErrorToType(error),
      context: 'page-translation-scheduler',
      sessionId,
      sessionContext,
    });
    return true;
  }

  /**
   * Internal method to handle the actual translation request and resolution.
   */
  async _executeBatchRequest(batch, config, flushContext, flushSessionId) {
    const textsToTranslate = batch.map(item => ({ id: item.id, text: item.text }));
    
    const batchMessage = MessageFormat.create(
      MessageActions.PAGE_TRANSLATE_BATCH,
      {
        text: JSON.stringify(textsToTranslate),
        provider: config.providerRegistryId,
        isExplicitProvider: this.settings.isExplicitProvider,
        sourceLanguage: AUTO_DETECT_VALUE, 
        targetLanguage: config.targetLanguage,
        mode: TranslationMode.Page,
        contextMetadata: this.settings.aiContextTranslationEnabled ? { pageTitle: document.title } : null,
        options: { rawJsonPayload: true },
        sessionId: this.translationSessionId 
      },
      MessageContexts.PAGE_TRANSLATION_BATCH
    );

    try {
      if (!this.isTranslated) throw new Error('Session stopped');

      this.logger.debug(`Sending batch: ${batch.length} items`);
      const result = await safeSendMessage(batchMessage, 'page-translation-batch');

      // Validation after async call
      if (!this._ownsFlushSession(flushSessionId, flushContext)) {
        this.logger.debug('Batch discarded: session changed or stopped');
        batch.forEach(item => this._resolveItem(item, item.text, 'cancelled'));
        return;
      }

      // Detect failure or Soft-Failure with error details
      if (!result?.success || result?.hasError) {
        this.logger.debug('Batch failed:', result?.error || 'Unknown error');
        const rawErrorMessage = typeof result?.error === 'string' ? result.error : '';
        const fallbackErrorMessage = ((!result && !ExtensionContextManager.isValidSync()) || ExtensionContextManager.isContextError(rawErrorMessage))
          ? 'Extension context invalidated'
          : 'Batch translation failed';
        const batchError = result?.errorDetails
          ? reconstructTranslationError(result.errorDetails)
          : new Error(rawErrorMessage || fallbackErrorMessage);

        // Preserve legacy Page classification without overwriting canonical identity.
        const pageErrorType = result?.errorType;
        if (!batchError.type && pageErrorType) batchError.type = pageErrorType;
        if (result?.isFatal) batchError.isFatal = true;

        await this._handleBatchError(batchError, batch, pageErrorType, flushSessionId, flushContext);
        return;
      }

      // Resolve successfully translated items
      const translatedTexts = JSON.parse(result.translatedText);
      if (!Array.isArray(translatedTexts)) throw new TypeError('Page translation response must be an array');
      this.logger.debug(`Batch received: ${translatedTexts.length} items`);

      const hasItemIds = batch.every(item => typeof item.id === 'string');
      const resultsById = hasItemIds ? new Map() : null;
      if (resultsById) {
        const expectedIds = new Set(batch.map(item => item.id));
        for (const translatedItem of translatedTexts) {
          if (!expectedIds.has(translatedItem?.id) || resultsById.has(translatedItem.id)) {
            throw new TypeError('Page translation response has an unknown or duplicate item ID');
          }
          resultsById.set(translatedItem.id, translatedItem);
        }
      }

      if (translatedTexts.length !== batch.length) {
        this.logger.error('Batch size mismatch!', { sent: batch.length, received: translatedTexts.length });
      }

      batch.forEach((item, index) => {
        const translatedItem = resultsById ? resultsById.get(item.id) : translatedTexts[index];

        const isExplicitlySkipped = typeof translatedItem === 'object'
          && translatedItem !== null
          && translatedItem.isSkipped === true;

        let translatedText = "";

        if (typeof translatedItem === 'string') {
          translatedText = translatedItem;
        } else if (typeof translatedItem === 'object' && translatedItem !== null) {
          // Explicitly check for properties to avoid OR-gate fallthrough on empty strings
          if (typeof translatedItem.text === 'string') translatedText = translatedItem.text;
          else if (typeof translatedItem.t === 'string') translatedText = translatedItem.t;
          else if (typeof translatedItem.translatedText === 'string') translatedText = translatedItem.translatedText;
          else {
            // CRITICAL: If no text property found, return empty string instead of JSON.stringify
            // Artifacts like {"text":""} come from JSON.stringify being called on an object 
            // where text property exists but is empty.
            translatedText = "";
          }
        } else {
          translatedText = null;
        }

        // Blank and non-string results are unresolved. Identity translations
        // remain valid because only usability, not source equality, is checked.
        if (isExplicitlySkipped || typeof translatedText !== 'string' || !translatedText.trim()) {
          this._resolveItem(item, item.text, 'failed');
          return;
        }

        this._resolveItem(item, translatedText, 'success');
      });

      this._reportProgress();
    } catch (error) {
      this.logger.error('Batch execution error:', error);
      await this._handleBatchError(error, batch, null, flushSessionId, flushContext);
    }  }

  async _getBatchConfig() {
    const settings = this.settings;
    // Priority: this.settings (from Manager) -> defaults
    if (!settings.translationApi) {
      settings.translationApi = await getTranslationApiAsync();
    }
    if (!settings.targetLanguage) {
      settings.targetLanguage = await getTargetLanguageAsync();
    }

    const { getProviderConfiguration } = await import('@/features/translation/core/ProviderConfigurations.js');
    const { getProviderOptimizationLevelAsync } = await import('@/shared/config/config.js');

    const providerRegistryId = settings.translationApi;
    const targetLanguage = settings.targetLanguage;
    
    const providerName = registryIdToName(providerRegistryId);
    const level = await getProviderOptimizationLevelAsync(providerName);
    const providerConfig = getProviderConfiguration(providerName, level);

    const isAI = isProviderType(providerName, ProviderTypes.AI);

    // Sync concurrency settings with optimization level
    if (providerConfig.rateLimit) {
      settings.maxConcurrentFlushes = providerConfig.rateLimit.maxConcurrent;
    }

    // Dynamic Chunk Size Scaling (Optimization Level Alignment)
    // Level 1 (Economy): Large chunks (50-80 segments) -> Minimizes token overhead/system prompt repeats.
    // Level 5 (Turbo): Small chunks (10-15 segments) -> Faster initial translation and UI updates.
    
    // Traditional providers (Bing/Google/Edge)
    const chunkMultipliers = {
      1: 2.0, // Large chunks for stability/economy
      2: 1.5, 
      3: 1.0, // Balanced
      4: 0.7, 
      5: 0.4  // Small chunks for fast progressive updates
    };

    let baseChunkSize = isAI ? 50 : 25; 
    let chunkSize = Math.floor(baseChunkSize * (chunkMultipliers[level] || 1));
    
    // Special Scaling for AI (More aggressive for cost/context)
    if (isAI) {
      // Level 1: 80 segments (Very efficient), Level 5: 15 segments (Very fast updates)
      const aiChunks = { 1: 80, 2: 50, 3: 30, 4: 20, 5: 15 };
      chunkSize = aiChunks[level] || 30;
    }

    return {
      providerRegistryId,
      targetLanguage,
      chunkSize: Math.max(chunkSize, 5), // Ensure at least 5 segments per batch
      parallelExecution: isAI || isProviderType(providerName, ProviderTypes.CUSTOM),
      lazyLoading: settings.lazyLoading,
      maxChars: isAI ? (providerConfig.batching?.maxBatchSizeChars || await getWholePageAiMaxCharsAsync()) : (providerConfig.batching?.characterLimit || await getWholePageMaxCharsAsync())
    };
  }

  async _handleBatchError(
    error,
    batch,
    pageErrorType = null,
    sessionId = this.translationSessionId,
    sessionContext = this.sessionContext
  ) {
    if (!this._ownsFlushSession(sessionId, sessionContext)) {
      batch.forEach(item => this._resolveItem(item, item.text, 'cancelled'));
      return false;
    }

    if (this.fatalErrorOccurred) return;

    // Preserve original error identity as per guidelines
    const errorType = pageErrorType || matchErrorToType(error);
    
    // Page Translation Specific: If a batch fails PERMANENTLY (after all internal retries)
    // due to network or server issues, we treat it as fatal for the session to prevent
    // continuous failing requests in Auto-translate mode and avoid Circuit Breaker deadlock.
    const fatalityInput = error && typeof error === 'object'
      && (error.type || error.originalType || error.statusCode !== undefined)
      ? error
      : errorType;
    let isFatal = isFatalError(fatalityInput) || 
                  errorType === 'NETWORK_ERROR' || 
                  errorType === 'SERVER_ERROR';

    if (isFatal) {
      this.fatalErrorOccurred = true;
    } else {
      // Intermediate failures stay silent but remain available for terminal UI.
      const errorTypeForDetails = error?.type || errorType;
      this.lastNonFatalError = MessageFormat.serializeTranslationError(
        error,
        errorTypeForDetails ? { type: errorTypeForDetails } : {}
      );
    }

    // Resolve current batch items with original text to unblock domtranslator
    batch.forEach(item => this._resolveItem(item, item.text, 'failed'));

    // Emit internal event for the Manager to handle feedback and broadcasting
    pageEventBus.emit('page-translation-internal-error', { 
      error, 
      errorType, 
      isFatal: isFatal,
      context: 'page-translation-batch'
    });
    this.onInternalError?.({
      error,
      errorType,
      isFatal,
      context: 'page-translation-batch',
      sessionId,
    });

    // Also emit specific fatal event for the Manager's circuit breaker
    if (isFatal) {
      if (this._ownsFlushSession(sessionId, sessionContext)) {
        this.onFatalError?.({
          error,
          errorType,
          context: 'page-translation-batch',
          sessionId,
          sessionContext,
        });
      }
    }
  }

  _reportProgress(force = false) {
    const now = Date.now();
    const timeSinceLastReport = now - this._lastReportTime;

    if (force || timeSinceLastReport >= this._reportInterval) {
      this._lastReportTime = now;
      this._reportPending = false;
      this._emitLifecycle(MessageActions.PAGE_TRANSLATE_PROGRESS, { 
        translatedCount: this.translatedCount, 
        totalCount: this.totalTasks,
        failedCount: this.failedCount,
        isAutoTranslating: !!this.settings.autoTranslateOnDOMChanges && this.isTranslated
      });
      return;
    }

    if (!this._reportPending) {
      this._reportPending = true;
      this.trackTimeout(() => {
        if (this._reportPending) {
          this._reportProgress(true);
        }
      }, this._reportInterval - timeSinceLastReport);
    }
  }

  /**
   * Check if translation is complete or temporarily idle (waiting for more visible content)
   */
  _checkCompletion() {
    if (this._completionTimer) return;
    // Small delay to ensure no more immediate tasks are coming
    this._completionTimer = this.trackTimeout(() => {
      this._completionTimer = null;
      if (!this.isTranslated || this.activeFlushes > 0) return;

      const processedCount = this.translatedCount + this.failedCount;
      const isAuto = !!this.settings.autoTranslateOnDOMChanges && this.isTranslated;

      // Case 1: Pure Completion (Everything in queue is done)
      if (this.queue.length === 0 && this.totalTasks > 0 && processedCount >= this.totalTasks) {
        // If auto-translating, we are never "truly" complete, just idle/watching
        if (isAuto) {
          this.logger.debug('Scheduler detected completion of current queue in Auto mode, signaling idle');
          this._emitLifecycle(MessageActions.PAGE_TRANSLATE_IDLE, {
            translatedCount: this.translatedCount,
            totalCount: this.totalTasks,
            failedCount: this.failedCount,
            isAutoTranslating: true
          });
        } else {
          this.logger.info('Scheduler detected total completion', { 
            translated: this.translatedCount, 
            total: this.totalTasks,
            failed: this.failedCount
          });
          this._emitLifecycle(MessageActions.PAGE_TRANSLATE_COMPLETE, {
            translatedCount: this.translatedCount,
            totalCount: this.totalTasks,
            failedCount: this.failedCount,
            isAutoTranslating: false,
            ...(this.translatedCount === 0
              && this.failedCount > 0
              && this.lastNonFatalError
              ? { errorDetails: this.lastNonFatalError }
              : {})
          });
        }
        this.isWaitingForVisibility = false;
        return;
      }

      // Case 2: Partial Completion / Idle (Visible content done, but more invisible items exist)
      // This is triggered if the last flush attempt found NO visible content.
      // We allow idle even if some failed or nothing successfully translated yet.
      if (this.isWaitingForVisibility && processedCount >= 0) {
        this.logger.debug('Scheduler entering idle state (Visible content processed)');
        this._emitLifecycle(MessageActions.PAGE_TRANSLATE_IDLE, {
          translatedCount: this.translatedCount,
          totalCount: this.totalTasks,
          failedCount: this.failedCount,
          isAutoTranslating: isAuto
        });
      }
    }, 500);
  }
}
