/**
 * Unified Translation Service - Centralized coordination for all translation operations
 * Coordinates requests, delivery, and mode behaviors across the extension.
 */

import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { 
  TranslationMode, 
  getModeProvidersAsync, 
  getTranslationApiAsync, 
  getPopupMaxCharsAsync,
  getSidepanelMaxCharsAsync,
  getSelectionMaxCharsAsync,
  getSelectElementMaxCharsAsync
} from '@/shared/config/config.js';
import { MessageFormat, MessageContexts, ActionReasons } from '@/shared/messaging/core/MessagingCore.js';
import { RequestStatus, translationRequestTracker } from './TranslationRequestTracker.js';
import { UnifiedResultDispatcher } from './UnifiedResultDispatcher.js';
import { UnifiedModeCoordinator } from './UnifiedModeCoordinator.js';
import { statsManager } from '@/features/translation/core/TranslationStatsManager.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { isEligibleForDictionaryUpgrade } from '@/features/translation/utils/translationModeHelper.js';
import {
  appendTranslationDiagnostic,
  createTranslationOperation,
  deriveRecoverySummary,
  finalizeTranslationOperation,
} from '@/features/translation/ir/TranslationOperation.js';
import { createManifestView, createRequestUnitManifest } from '@/features/translation/ir/RequestUnitManifest.js';
import { TerminalExecutionRouter } from '@/features/translation/ir/TerminalExecutionRouter.js';
import { TranslationCallPurpose, isProviderType, registryIdToName, ProviderTypes } from '@/features/translation/providers/ProviderConstants.js';
import { AIConversationHelper } from '@/features/translation/providers/utils/AIConversationHelper.js';
import { ConversationAcceptanceHandoff } from '@/features/translation/conversation/ConversationAcceptanceHandoff.js';
import { ConversationAcceptanceHandle } from '@/features/translation/conversation/ConversationAcceptanceHandle.js';
import { ConversationAcceptanceCoordinator } from '@/features/translation/conversation/ConversationAcceptanceCoordinator.js';
import {
  withBackgroundOperationLease,
} from './BackgroundOperationLease.js';
import { streamingManager } from '@/features/translation/core/StreamingManager.js';

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'UnifiedTranslationService');

export class UnifiedTranslationService {
  constructor() {
    this.requestTracker = translationRequestTracker;
    this.resultDispatcher = new UnifiedResultDispatcher();
    this.modeCoordinator = new UnifiedModeCoordinator();
    this.conversationAcceptanceCoordinator = new ConversationAcceptanceCoordinator();

    this.translationEngine = null;
    this.backgroundService = null;
    this._operations = new WeakMap();
    this._diagnosticReports = new WeakMap();

    this.requestTracker.setActiveExpiryHandler?.((messageId) => {
      this._handleActiveRequestExpiry(messageId);
    });

    logger.info('UnifiedTranslationService initialized');
  }

  /**
   * Initialize service with required background dependencies.
   */
  initialize({ translationEngine, backgroundService }) {
    this.translationEngine = translationEngine;
    this.backgroundService = backgroundService;
    logger.info('UnifiedTranslationService dependencies initialized');
  }

  /**
   * Determine the effective provider based on request context and mode settings.
   * @private
   */
  async _resolveEffectiveProvider(data, context) {
    // 1. Direct UI Override (Highest Priority)
    // If the request is marked explicitly by the UI (e.g. user manually changed dropdown)
    if (data.isExplicitProvider && data.provider) {
      logger.debug(`[UnifiedTranslationService] Using EXPLICIT UI provider override: ${data.provider}`);
      return data.provider;
    }

    const modeProviders = await getModeProvidersAsync();
    const modeSpecificProvider = modeProviders ? modeProviders[data.mode] : null;

    // 2. Feature-Specific Setting (e.g., Dictionary, Page Translation)
    if (modeSpecificProvider && modeSpecificProvider !== 'default') {
      logger.debug(`[UnifiedTranslationService] Using mode-specific provider for ${data.mode}: ${modeSpecificProvider}`);
      return modeSpecificProvider;
    }

    const uiContexts = [
      MessageContexts.POPUP, MessageContexts.SIDEPANEL, MessageContexts.SELECT_ELEMENT, MessageContexts.PDF_TRANSLATION,
      MessageContexts.PAGE_TRANSLATION_BATCH, MessageContexts.CONTENT, MessageContexts.MOBILE_TRANSLATE
    ];
    
    // 3. Use UI-provided provider as fallback (Standard behavioral consistency)
    if (uiContexts.includes(context) && data.provider) return data.provider;

    // 4. Global default
    return data.provider || await getTranslationApiAsync();
  }

  /**
   * Main entry point for all incoming translation requests.
   */
  async handleTranslationRequest(message, sender) {
    const operationId = message?.messageId || message?.data?.messageId;
    return withBackgroundOperationLease(
      operationId,
      () => this._handleTranslationRequest(message, sender),
    );
  }

  async _handleTranslationRequest(message, sender) {
    const { messageId, data, context } = message || {};
    logger.debug(`[UnifiedTranslationService] Received request: ${messageId}, context: ${context}, sessionId: ${data?.sessionId}`);

    if (!MessageFormat.validate(message)) {
      return MessageFormat.createErrorResponse(new Error('Invalid message format'), messageId);
    }

    const existingRequest = this.requestTracker.getRequest(messageId);
    if (existingRequest) {
      return {
        success: false,
        error: this.requestTracker.isRequestActive(messageId)
          ? 'Request already processing'
          : 'Request messageId already exists'
      };
    }

    this.translationEngine = this.translationEngine || globalThis.backgroundService?.translationEngine;
    this.backgroundService = this.backgroundService || globalThis.backgroundService;

    let request;
    let operation;
    let requestUnitManifest;
    try {
      request = this.requestTracker.createRequest({
        messageId,
        data,
        sessionId: data?.sessionId || message.sessionId || messageId,
        sender,
        timestamp: Date.now(),
        context
      });
      if (request) {
        requestUnitManifest = createRequestUnitManifest(data?.text);
        operation = createTranslationOperation(messageId, requestUnitManifest);
        this._setOperation(request, operation);
      }
      if (!request || request.messageId !== messageId) {
        throw new Error('Translation request registration failed');
      }
    } catch (error) {
      logger.debug('Request setup failed:', error.message);
      if (request && this.requestTracker.isRequestActive(messageId)) {
        const transition = this.requestTracker.failRequest(messageId, error);
        if (transition.accepted && operation) {
          this._finalizeDiagnostics(request, { operation }, {
            type: 'OPERATION_FAILED',
            stage: 'service',
            reason: error.message,
            code: error.type,
          });
        }
      }
      return MessageFormat.createErrorResponse(error, messageId);
    }

    const suppressIfTerminal = () => {
      if (this.requestTracker.isRequestActive(messageId) !== false) return null;
      this.conversationAcceptanceCoordinator.remove(messageId);
      return this._createSuppressedResponse(messageId, {
        accepted: false,
        status: this.requestTracker.getRequest(messageId)?.status || request.status,
        reason: 'already_terminal',
      });
    };

    const failPreparation = (error) => {
      const suppressed = suppressIfTerminal();
      if (suppressed) return suppressed;
      const transition = this.requestTracker.failRequest(messageId, error);
      if (!transition.accepted) {
        this.conversationAcceptanceCoordinator.remove(messageId);
        return this._createSuppressedResponse(messageId, transition);
      }
      this.conversationAcceptanceCoordinator.remove(messageId);
      this._finalizeDiagnostics(request, { operation }, {
        type: 'OPERATION_FAILED',
        stage: 'service',
        reason: error.message,
        code: error.type,
      });
      return null;
    };

    // Preparation errors retain their historical rejection boundary, but the
    // request is now owned by the tracker while asynchronous preparation runs.
    try {
      if (data) {
        let effectiveMode = data.mode || TranslationMode.Selection;
        if (await isEligibleForDictionaryUpgrade(data.text, effectiveMode, data)) {
          logger.debug(`[UnifiedTranslationService] Detected single word, using dictionary mode for provider resolution.`);
          effectiveMode = TranslationMode.Dictionary_Translation;
        }
        const suppressed = suppressIfTerminal();
        if (suppressed) return suppressed;

        const provider = await this._resolveEffectiveProvider({ ...data, mode: effectiveMode }, context);
        const providerSuppressed = suppressIfTerminal();
        if (providerSuppressed) return providerSuppressed;
        data.provider = provider;
        if (request.data) request.data.provider = provider;
        if (request.metadata) request.metadata.provider = provider;
      }
    } catch (error) {
      const suppressed = failPreparation(error);
      if (suppressed) return suppressed;
      throw error;
    }

    // Calculate estimated characters for limit validation
    let estimatedChars = 0;
    if (typeof data?.text === 'string') {
      estimatedChars = data.text.length;
    } else if (Array.isArray(data?.items)) {
      estimatedChars = data.items.reduce((sum, item) => sum + (typeof item === 'string' ? item.length : (item.text?.length || 0)), 0);
    }
    const mode = data?.mode || 'unknown';

    // 1. Character Limit Validation
    let charLimit = 50000; // Default safety limit
    try {
      if (context === MessageContexts.POPUP) {
        charLimit = await getPopupMaxCharsAsync();
      } else if (context === MessageContexts.SIDEPANEL) {
        charLimit = await getSidepanelMaxCharsAsync();
      } else if (mode === TranslationMode.Select_Element || mode === TranslationMode.PDF) {
        charLimit = await getSelectElementMaxCharsAsync();
      } else if (mode === TranslationMode.Selection || context === MessageContexts.SELECTION_MANAGER) {
        charLimit = await getSelectionMaxCharsAsync();
      }
    } catch (error) {
      const suppressed = failPreparation(error);
      if (suppressed) return suppressed;
      throw error;
    }

    const limitSuppressed = suppressIfTerminal();
    if (limitSuppressed) return limitSuppressed;

    if (estimatedChars > charLimit) {
      logger.debug(`[UnifiedTranslationService] Text too long for context ${context}/mode ${mode}: ${estimatedChars} > ${charLimit}`);
      const tooLong = {
        success: false,
        error: {
          type: ErrorTypes.TEXT_TOO_LONG,
          message: `Text too long (${estimatedChars.toLocaleString()} chars). Max allowed for this context is ${charLimit.toLocaleString()} chars.`,
          context: context,
          timestamp: Date.now()
        }
      };
      const suppressed = failPreparation(tooLong.error);
      if (suppressed) return suppressed;
      return tooLong;
    }

    logger.info(`Request: ${messageId} (${estimatedChars.toLocaleString()} chars, mode: ${mode}, provider: ${data?.provider || 'unknown'})`);

    if (!this.translationEngine || !this.backgroundService) {
      this.translationEngine = this.translationEngine || globalThis.backgroundService?.translationEngine;
      this.backgroundService = this.backgroundService || globalThis.backgroundService;
      if (!this.translationEngine || !this.backgroundService) {
        const error = new Error('Translation service not initialized');
        const suppressed = failPreparation(error);
        if (suppressed) return suppressed;
        throw error;
      }
    }

    try {
      const suppressed = suppressIfTerminal();
      if (suppressed) return suppressed;

      const parentMetadata = Array.isArray(data?.conversationParents) ? data.conversationParents : [];
      const providerName = registryIdToName(data?.provider);
      const participates = await AIConversationHelper.getConversationParticipation({
        callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION,
        translateMode: data?.mode,
        sessionId: request.data?.sessionId,
        isAIProvider: isProviderType(providerName, ProviderTypes.AI),
      });
      if (parentMetadata.length > 0 && participates) {
        operation.registerParentCandidates(parentMetadata.map((parent, sourceOrder) => ({
          ...parent,
          sourceOrder,
          sessionId: request.data?.sessionId,
          provider: providerName,
          mode: data.mode,
          callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION,
          conversationParticipates: participates,
        })));
      }

      // Cancellation can win while conversation participation is resolving.
      // Never register acceptance or start engine work after that terminal state.
      if (this.requestTracker.isRequestActive(messageId) === false) {
        this.conversationAcceptanceCoordinator.remove(messageId);
        return this._createSuppressedResponse(messageId, {
          accepted: false,
          status: this.requestTracker.getRequest(messageId)?.status || request.status,
          reason: 'already_terminal',
        });
      }

      const executionContext = {
        operation,
        manifestView: createManifestView(requestUnitManifest),
        onTerminalUnitsAccepted: TerminalExecutionRouter.createTerminalUnitsObserver(operation),
      };
      // Authoritative participation decision: true only when a
      // ConversationAcceptanceHandle was actually registered for this request.
      // The consuming feature gates parent acceptance ACK emission on this value.
      const conversationAcceptanceRegistered = this._registerConversationAcceptance(request, executionContext, providerName, participates);
      // Transport-only handoff metadata. Keep this outside operation metadata and history.
      executionContext.conversationAcceptanceRegistered = conversationAcceptanceRegistered;
      this._initializeStructuredStreaming(request, providerName, conversationAcceptanceRegistered);

      let result;
      try {
        result = await this.modeCoordinator.processRequest(request, {
          translationEngine: this.translationEngine,
          backgroundService: this.backgroundService,
          executionContext
        });
      } catch (error) {
        logger.debug('Request failed:', error.message);
        const timeoutType = error.timeoutType
          || (error.type === ErrorTypes.PROGRESS_TIMEOUT ? ErrorTypes.PROGRESS_TIMEOUT : null)
          || (error.type === ErrorTypes.FINAL_TIMEOUT ? ErrorTypes.FINAL_TIMEOUT : null);
        const isTimeout = error.type === ErrorTypes.TRANSLATION_TIMEOUT
          || error.type === ErrorTypes.OPERATION_TIMEOUT
          || error.type === 'TIMEOUT'
          || Boolean(timeoutType);
        const transition = isTimeout
          ? this.requestTracker.markTimeout(messageId)
          : this.requestTracker.failRequest(messageId, error);
        if (!transition.accepted) {
          this.conversationAcceptanceCoordinator.remove(messageId);
          return this._createSuppressedResponse(messageId, transition);
        }
        await this._completeStreaming(request, messageId, {
          success: false,
          error,
          timedOut: isTimeout,
          timeoutType,
        });
        this.conversationAcceptanceCoordinator.remove(messageId);
        if (isTimeout) {
          await this._finalizeAcceptedTimeout(request, messageId, error.message, timeoutType);
        } else {
          this._finalizeDiagnostics(request, executionContext, {
            type: 'OPERATION_FAILED',
            stage: 'service',
            reason: error.message,
            code: error.type,
          });
        }
        return MessageFormat.createErrorResponse(error, messageId);
      }

      // Propagate only a positive registration decision. Missing metadata means
      // the requesting feature must not emit a parent acceptance ACK.
      let resultForDispatch = result;
      if (result && typeof result === 'object'
        && (conversationAcceptanceRegistered || Object.prototype.hasOwnProperty.call(result, 'conversationAcceptance'))) {
        resultForDispatch = { ...result };
        delete resultForDispatch.conversationAcceptance;
        if (conversationAcceptanceRegistered) resultForDispatch.conversationAcceptance = true;
      }

      const transition = this.requestTracker.completeRequest(messageId, resultForDispatch);
      if (!transition.accepted) {
        this.conversationAcceptanceCoordinator.remove(messageId);
        return this._createSuppressedResponse(messageId, transition);
      }
      await this._completeStreaming(request, messageId, {
        success: resultForDispatch?.success === true,
        result: resultForDispatch,
        error: resultForDispatch?.success === false ? resultForDispatch.errorDetails || resultForDispatch.error : null,
      });
      TerminalExecutionRouter.routeTerminalExecution(executionContext.operation, { status: transition.status });
      this._finalizeDiagnostics(request, executionContext, {
        type: transition.status === RequestStatus.FAILED ? 'OPERATION_FAILED' : 'OPERATION_COMPLETED',
        stage: 'service',
        ...(transition.status === RequestStatus.FAILED && {
          reason: typeof resultForDispatch?.error === 'object' ? resultForDispatch.error?.message : resultForDispatch?.error,
          code: typeof resultForDispatch?.error === 'object' ? resultForDispatch.error?.type : undefined,
        }),
      });

      // Special handling for Field mode (direct return)
      if (request.mode === TranslationMode.Field) return resultForDispatch;

      try {
        await this.resultDispatcher.dispatchResult({ messageId, result: resultForDispatch, request, originalMessage: message });
        if (conversationAcceptanceRegistered && resultForDispatch?.success === true) {
          this.conversationAcceptanceCoordinator.activate(messageId);
        } else if (conversationAcceptanceRegistered) {
          this.conversationAcceptanceCoordinator.remove(messageId);
        }
      } catch (error) {
        logger.error('Result dispatch failed:', error.message);
        this.conversationAcceptanceCoordinator.remove(messageId);
        return MessageFormat.createErrorResponse(error, messageId);
      }

      // Post-processing stats logging
      this._logSessionStats(request, resultForDispatch, messageId);

      return resultForDispatch;

    } catch (error) {
      logger.debug('Request setup failed:', error.message);
      this.conversationAcceptanceCoordinator.remove(messageId);
      if (this.requestTracker.isRequestActive(messageId)) {
        const transition = this.requestTracker.failRequest(messageId, error);
        if (!transition.accepted) return this._createSuppressedResponse(messageId, transition);
        const request = this.requestTracker.getRequest(messageId);
        const operation = this._getOperation(request);
        this._finalizeDiagnostics(request, { operation }, {
          type: 'OPERATION_FAILED',
          stage: 'service',
          reason: error.message,
          code: error.type,
        });
      }
      return MessageFormat.createErrorResponse(error, messageId);
    }
  }

  /**
   * Log translation performance and consumption stats.
   * @private
   */
  _logSessionStats(request, result, messageId) {
    const mode = request.mode;
    const sessionId = request.sessionId || request.data?.sessionId;
    const summaryId = sessionId || messageId;
    const isMultiBatch = !!(sessionId && sessionId !== messageId);

    if (mode === TranslationMode.Page) {
      statsManager.printSummary(summaryId, { 
        status: 'Batch', 
        batchChars: result.actualCharCount || 0,
        batchOriginalChars: result.originalCharCount || 0
      });
    } else if (!isMultiBatch || ((mode === TranslationMode.Select_Element || mode === TranslationMode.PDF) && !result.streaming)) {
      statsManager.printSummary(summaryId, { 
        status: 'Session', success: result.success, 
        clear: mode !== TranslationMode.Select_Element && mode !== TranslationMode.PDF 
      });
    }
  }

  /**
   * Handle real-time streaming updates from the engine.
   */
  async handleStreamingUpdate(message) {
    await this.resultDispatcher.dispatchStreamingUpdate({
      messageId: message.messageId,
      data: message.data,
      request: this.requestTracker.getRequest(message.messageId)
    });
  }

  /**
   * Cancel an active service-owned request.
   * User-cancellation entry point only; timeout stays outside this API.
   * Returns { handled } so callers can fall back for non-service requests.
   */
  async cancelRequest(messageId, reason = ActionReasons.USER_CANCELLED) {
    logger.info(`Cancelling request: ${messageId}`);
    const request = this.requestTracker.getRequest(messageId);
    if (!request) return { handled: false, success: false, error: 'Request not found' };

    const cancellation = this.requestTracker.cancelRequest(messageId, reason);
    if (!cancellation.accepted) return { handled: true, success: false, error: cancellation.reason };

    await this._completeStreaming(request, messageId, {
      success: false,
      cancelled: true,
      reason,
    });
    this.conversationAcceptanceCoordinator.remove(messageId);
    const operation = this._getOperation(request);
    TerminalExecutionRouter.routeTerminalExecution(operation, { status: cancellation.status });
    this._finalizeDiagnostics(request, { operation }, {
      type: 'OPERATION_CANCELLED',
      stage: 'service',
      reason: cancellation.reason,
      cancelled: true,
    });
    if (this.translationEngine) {
      this.translationEngine.cancelTranslation(messageId, false, undefined, reason);
    }
    
    await this.resultDispatcher.dispatchCancellation({ messageId, request });
    return { handled: true, success: true };
  }

  async handleTimeout(messageId, reason = 'Translation timed out', timeoutType) {
    const request = this.requestTracker.getRequest(messageId);
    if (!request) return { handled: false, success: false, error: 'Request not found' };
    const timeout = this.requestTracker.markTimeout(messageId);
    if (!timeout.accepted) return { handled: true, success: false, error: timeout.reason };
    await this._completeStreaming(request, messageId, {
      success: false,
      timedOut: true,
      timeoutType,
      error: {
        type: ErrorTypes.TRANSLATION_TIMEOUT,
        message: reason,
        ...(timeoutType && { timeoutType }),
      },
    });
    this.conversationAcceptanceCoordinator.remove(messageId);
    await this._finalizeAcceptedTimeout(request, messageId, reason, timeoutType);
    return { handled: true, success: true };
  }

  async _finalizeAcceptedTimeout(request, messageId, reason, timeoutType) {
    const operation = this._getOperation(request);
    TerminalExecutionRouter.routeTerminalExecution(operation, { status: RequestStatus.TIMEOUT });
    this._finalizeDiagnostics(request, { operation }, {
      type: 'OPERATION_TIMEOUT',
      stage: 'service',
      reason,
      code: 'TIMEOUT',
    });
    try {
      await this.translationEngine?.cancelTranslation(messageId, true, timeoutType, reason);
    } catch (error) {
      logger.debug('Timeout cancellation failed:', error.message);
    }
  }

  _initializeStructuredStreaming(request, providerName, conversationAcceptanceRegistered) {
    const isStructuredSelect = request.mode === TranslationMode.Select_Element
      && request.data?.options?.rawJsonPayload === true;
    const isStructuredPdf = request.mode === TranslationMode.PDF;
    if (!isStructuredSelect && !isStructuredPdf) return;

    let segments = [request.data?.text || ''];
    if (typeof request.data?.text === 'string') {
      try {
        const parsed = JSON.parse(request.data.text);
        if (Array.isArray(parsed)) segments = parsed;
      } catch { /* keep single raw segment */ }
    }

    streamingManager.initializeStream(
      request.messageId,
      request.sender,
      { providerName: providerName || request.data?.provider || 'unknown' },
      segments,
      request.sessionId || request.data?.sessionId,
      conversationAcceptanceRegistered,
    );
  }

  async _completeStreaming(request, messageId, {
    success,
    result = null,
    error = null,
    cancelled = false,
    timedOut = false,
    timeoutType,
    reason,
  }) {
    const streamInfo = streamingManager.getStreamInfo(messageId);
    if (!streamInfo) return;

    const completionData = {
      ...(request?.mode && { translationMode: request.mode }),
      ...(result?.sourceLanguage && { sourceLanguage: result.sourceLanguage }),
      ...(result?.targetLanguage && { targetLanguage: result.targetLanguage }),
      ...(cancelled && { cancelled: true, reason, terminalStatus: 'cancelled' }),
      ...(timedOut && {
        timedOut: true,
        cancelled: false,
        type: ErrorTypes.TRANSLATION_TIMEOUT,
        ...(timeoutType && { timeoutType }),
      }),
    };

    if (Array.isArray(result?.results) && streamInfo.processedSegments === 0) {
      completionData.processedSegments = result.results.length;
    }

    if (error) {
      const serializedError = MessageFormat.serializeTranslationError(error, {
        type: error.type || (timedOut ? ErrorTypes.TRANSLATION_TIMEOUT : undefined),
        providerName: error.providerName || streamInfo.providerName,
      });
      completionData.error = serializedError;
      completionData.errorDetails = serializedError;
    }

    try {
      await streamingManager.completeStream(messageId, success, completionData);
    } catch (streamError) {
      logger.debug(`Streaming terminal publication failed for ${messageId}:`, streamError.message);
    }
  }

  _handleActiveRequestExpiry(messageId) {
    this.handleTimeout(messageId, 'Translation request expired', ErrorTypes.FINAL_TIMEOUT)
      .catch(error => logger.debug(`Active request expiry handling failed for ${messageId}:`, error.message));
  }

  _createCancelledResponse(messageId) {
    return {
      success: false,
      cancelled: true,
      messageId,
      error: {
        type: ErrorTypes.USER_CANCELLED,
        message: 'Translation cancelled by user'
      }
    };
  }

  _createSuppressedResponse(messageId, transition) {
    if (transition.status === 'cancelled') return this._createCancelledResponse(messageId);
    if (transition.status === 'timeout') {
      return {
        success: false,
        timedOut: true,
        messageId,
        error: { type: ErrorTypes.TRANSLATION_TIMEOUT, message: 'Translation timed out' }
      };
    }
    return {
      success: false,
      suppressed: true,
      messageId,
      reason: transition.reason,
      status: transition.status
    };
  }

  _finalizeDiagnostics(request, executionContext, terminalFact) {
    appendTranslationDiagnostic(executionContext, terminalFact);
    const report = finalizeTranslationOperation(executionContext);
    if (report) {
      this._setDiagnosticReport(request, report);
      const terminalStatus = {
        OPERATION_COMPLETED: 'completed',
        OPERATION_FAILED: 'failed',
        OPERATION_CANCELLED: 'cancelled',
        OPERATION_TIMEOUT: 'timeout',
      }[terminalFact.type];
      if (terminalStatus) {
        statsManager.recordOperationQuality(deriveRecoverySummary(report, {
          terminalStatus,
          operationSucceeded: terminalStatus === 'completed',
        }));
      }
    }
    this._clearOperation(request);
  }

  _registerConversationAcceptance(request, executionContext, providerName, participates) {
    if (!participates) return false;

    const parents = executionContext.operation.snapshotParentCandidates()
      .filter(parent => parent.conversationParticipates && parent.cleanSource !== null)
      .map(({ parentId, sourceOrder, cleanSource }) => ({ parentId, sourceOrder, cleanSource }));
    if (parents.length === 0) return false;

    try {
      const handoff = new ConversationAcceptanceHandoff({
        messageId: request.messageId,
        sessionId: request.data?.sessionId,
        provider: providerName,
        mode: request.data?.mode,
        parents,
      });
      const handle = new ConversationAcceptanceHandle(handoff);
      if (this.conversationAcceptanceCoordinator.register(request.messageId, handle)) return true;

      logger.warn(`[UnifiedTranslationService] Conversation acceptance registration rejected for ${request.messageId}`);
      appendTranslationDiagnostic(executionContext, {
        type: 'CONVERSATION_ACCEPTANCE_REGISTRATION_REJECTED',
        stage: 'service',
        reason: 'duplicate_message_id',
      });
    } catch (error) {
      logger.warn(`[UnifiedTranslationService] Conversation acceptance handoff failed for ${request.messageId}:`, error.message);
      appendTranslationDiagnostic(executionContext, {
        type: 'CONVERSATION_ACCEPTANCE_HANDOFF_FAILED',
        stage: 'service',
        reason: error.message,
      });
    }
    return false;
  }

  _setOperation(request, operation) {
    this._operations.set(request, operation);
  }

  _getOperation(request) {
    return this._operations.get(request) || null;
  }

  _clearOperation(request) {
    this._operations.delete(request);
  }

  _setDiagnosticReport(request, report) {
    this._diagnosticReports.set(request, report);
    this.requestTracker._setDiagnosticReport?.(request, report);
  }

  /**
   * Force-clear a Page session's source-resolution state.
   * Invoked on session terminal lifecycle (complete/cancel/error/restore).
   *
   * @param {string} sessionId - Page translation session identifier
   */
  clearPageSourceSession(sessionId) {
    if (sessionId) this.modeCoordinator.clearPageSourceLanguage(sessionId);
  }

  /**
   * Periodically clean up old request records.
   */
  cleanup() {
    const count = this.requestTracker.cleanup();
    if (count > 0) logger.debug(`Cleaned up ${count} records`);
  }
}

export const unifiedTranslationService = new UnifiedTranslationService();
