/**
 * Base AI Provider - Enhanced base class for AI translation services (Gemini, OpenAI, etc.)
 * Provides centralized batching, prompt preparation, and streaming support for AI models.
 */

import { BaseProvider, createOperationAbortError } from "@/features/translation/providers/BaseProvider.js";
import {
  getProviderStreaming,
  getProviderBatching
} from "@/features/translation/core/ProviderConfigurations.js";
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { ResponseFormat } from "@/shared/config/translationConstants.js";
import { AIConversationHelper } from "./utils/AIConversationHelper.js";
import { AIResponseParser } from "./utils/AIResponseParser.js";
import { AITextProcessor } from "./utils/AITextProcessor.js";
import { TranslationMode, getProviderOptimizationLevelAsync } from "@/shared/config/config.js";
import { AIStreamManager } from "./utils/AIStreamManager.js";
import { isCancellationError } from "@/shared/error-management/ErrorMatcher.js";
import { ErrorTypes } from "@/shared/error-management/ErrorTypes.js";
import {
  appendTranslationDiagnostic,
  createProviderExecutionMetadataRef,
  discardProviderExecutionMetadata,
  executeProviderExecutionAttempt,
  publishProviderExecutionMetadata,
} from "@/features/translation/ir/TranslationOperation.js";
import { TranslationCallPurpose } from "@/features/translation/providers/ProviderConstants.js";
import { classifyRecoveryFailure } from "@/features/translation/ir/RecoveryClassification.js";
import { TranslationContractValidator } from "@/features/translation/core/TranslationContractValidator.js";

const logger = getScopedLogger(LOG_COMPONENTS.TRANSLATION, 'BaseAIProvider');
const MAX_SCALAR_SELECTIVE_RECOVERY_UNITS = 3;
const OJH_RESULT_PUBLICATION_OWNER = 'optimized-json-handler';

function createConversationCommitCandidate(translateMode) {
  let staged = null;
  let settled = false;
  return {
    stage(payload) {
      if (!settled && !staged) staged = payload;
    },
    async commit() {
      if (settled || !staged) return;
      settled = true;
      await AIConversationHelper.updateSessionHistory(
        staged.sessionId,
        staged.userContent,
        staged.assistantContent,
         {
           callPurpose: TranslationCallPurpose.PRIMARY_TRANSLATION,
           translateMode,
           conversationParticipates: true,
         }
      );
    },
    discard() {
      if (!settled) {
        settled = true;
        staged = null;
      }
    }
  };
}

function getSelectiveRecoveryPlan(parsed, texts) {
  const invalidUnits = Array.isArray(parsed?.invalidUnits) ? parsed.invalidUnits : [];
  const mappingFacts = parsed?.mappingFacts;
  if (!Array.isArray(texts)
      || !Array.isArray(parsed?.results)
      || parsed.results.length !== texts.length) {
    return null;
  }
  if (!mappingFacts?.identityReliable) {
    return null;
  }
  if (!mappingFacts.complete) {
    return null;
  }
  if (mappingFacts.ambiguous) {
    return null;
  }
  if (invalidUnits.length === 0) {
    return null;
  }

  const indexes = invalidUnits.map(({ requestIndex }) => requestIndex);
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= texts.length)) {
    return null;
  }
  const invalidIndexes = [...new Set(indexes)].sort((a, b) => a - b);
  if (invalidIndexes.length !== indexes.length) {
    return null;
  }
  if (invalidIndexes.length >= texts.length) {
    return null;
  }
  if (invalidIndexes.some((index) => parsed.results[index] === undefined)) {
    return null;
  }

  return {
    invalidIndexes,
    recoveryTexts: invalidIndexes.map((index) => getSourceText(texts[index])),
  };
}

function validateSelectiveRecoveryResult(recoveryResult, expectedCount) {
  const values = Array.isArray(recoveryResult) ? recoveryResult : [recoveryResult];
  if (values.length !== expectedCount || values.some((value) => typeof value !== 'string' || value.trim() === '')) {
    const error = new Error(`Selective structured recovery returned ${values.length} invalid results; expected ${expectedCount}`);
    error.type = ErrorTypes.API_RESPONSE_INVALID;
    throw error;
  }
  return values;
}

function createStructuredRecoveryFailure() {
  const error = new Error('Structured recovery returned an invalid response after one bounded retry');
  error.type = ErrorTypes.API_RESPONSE_INVALID;
  return error;
}

function summarizeRecoveryValue(value) {
  const DIAGNOSTIC_ARRAY_LIMIT = 32;
  const summarize = (item) => {
    if (typeof item === 'string') {
      return {
        type: 'string',
        length: item.length,
        whitespaceOnly: item.trim() === '',
      };
    }
    if (item && typeof item === 'object') {
      const keys = Object.keys(item);
      return {
        type: 'object',
        keys: keys.slice(0, 12),
        resemblesIdText: typeof item.id === 'string' && typeof item.text === 'string',
        resemblesIT: typeof item.i === 'string' && typeof item.t === 'string',
      };
    }
    return { type: item === null ? 'null' : typeof item };
  };

  if (Array.isArray(value)) {
    return {
      containerType: 'array',
      arrayLength: value.length,
      values: value.slice(0, DIAGNOSTIC_ARRAY_LIMIT).map(summarize),
      valuesTotal: value.length,
      valuesTruncated: value.length > DIAGNOSTIC_ARRAY_LIMIT,
    };
  }
  return { containerType: typeof value, arrayLength: null, values: [summarize(value)], valuesTotal: 1, valuesTruncated: false };
}

function collectRecoveryViolationCodes(parsed) {
  const invalidUnits = Array.isArray(parsed?.invalidUnits) ? parsed.invalidUnits : [];
  const codes = new Set();
  for (const unit of invalidUnits) {
    if (Array.isArray(unit?.violationCodes)) {
      for (const code of unit.violationCodes) {
        if (typeof code === 'string') codes.add(code);
      }
    }
  }
  return [...codes];
}

function formatDiagnosticId(value, maxLength = 32) {
  if (typeof value !== 'string' || !value) return null;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function boundDiagnosticValues(values, formatter = (value) => value) {
  return Array.isArray(values) ? values.slice(0, 32).map(formatter) : [];
}

function getSourceText(source) {
  return typeof source === 'object' && source !== null
    ? (source.t ?? source.text ?? '')
    : source;
}

function getRecoveryParentId(source, index) {
  if (typeof source === 'object' && source !== null) {
    return source.b ?? source.blockId ?? source.i ?? source.uid ?? `recovery-${index}`;
  }
  return `recovery-${index}`;
}

function validateRecoveredResults(sourceTexts, recoveredResults) {
  for (let index = 0; index < sourceTexts.length; index++) {
    const sourceText = getSourceText(sourceTexts[index]);
    if (typeof sourceText !== 'string' || !sourceText.includes('@@TI_SEG_')) continue;

    const validation = TranslationContractValidator.validateV3Parent(
      sourceText,
      recoveredResults[index],
      getRecoveryParentId(sourceTexts[index], index),
    );
    if (validation && !validation.isValid) {
      const violation = validation.violations[0];
      const error = new Error(
        `Structured recovery semantic validation failed: ${violation.code}`,
      );
      error.type = ErrorTypes.VALIDATION;
      error.contractViolation = violation.code;
      error.parentId = violation.parentId;
      error.intervalIndex = violation.intervalIndex;
      error.markerId = violation.markerId;
      throw error;
    }
  }
}

function createInvalidStringResultError(providerName, index) {
  const error = new Error(`[${providerName}] Invalid STRING response at index ${index}`);
  error.type = ErrorTypes.API_RESPONSE_INVALID;
  return error;
}

function isBlankSource(source) {
  const sourceText = getSourceText(source);
  return typeof sourceText === 'string' && sourceText.trim() === '';
}

function validateStringResponseValue(value, source, providerName, index) {
  if (typeof value !== 'string' || (value.trim() === '' && !isBlankSource(source))) {
    throw createInvalidStringResultError(providerName, index);
  }
}

function isSpecializedStreamingOwnerMode(mode) {
  return mode === TranslationMode.Select_Element || mode === TranslationMode.Page || mode === TranslationMode.PDF;
}

function validateSequentialStringResponse(response, sourceTexts, providerName) {
  if (Array.isArray(response)) {
    // A single STRING request must not accept an array-shaped native value.
    if (sourceTexts.length === 1) {
      throw createInvalidStringResultError(providerName, 0);
    }

    response.forEach((value, index) => {
      validateStringResponseValue(value, sourceTexts[index], providerName, index);
    });
    return;
  }

  const allSourcesBlank = sourceTexts.every(isBlankSource);
  if (typeof response !== 'string' || (response.trim() === '' && !allSourcesBlank)) {
    throw createInvalidStringResultError(providerName, 0);
  }
}

export class BaseAIProvider extends BaseProvider {
  // AI-specific capabilities - to be overridden by subclasses
  static isAI = true;
  static supportsDictionary = true;

  /**
   * Configuration Resolvers - Unified with ProviderConfigurations.js and User Levels
   */
  async getSupportsStreaming() {
    const level = await getProviderOptimizationLevelAsync(this.providerName);
    return getProviderStreaming(this.providerName, level).enabled;
  }

  async getBatchingConfig(mode = null) {
    const level = await getProviderOptimizationLevelAsync(this.providerName);
    return getProviderBatching(this.providerName, mode, level);
  }

  async getBatchStrategy(mode = null) {
    const config = await this.getBatchingConfig(mode);
    return config.strategy || 'json';
  }

  constructor(providerName) {
    super(providerName);
  }

  /**
   * Enhanced batch translation with streaming support
   */
  async _batchTranslate(texts, sourceLang, targetLang, translateMode, engine, messageId, abortController, priority, sessionId, expectedFormat, options = {}) {
    const callPurpose = options.callPurpose || TranslationCallPurpose.PRIMARY_TRANSLATION;
    const isPrimaryCall = callPurpose === TranslationCallPurpose.PRIMARY_TRANSLATION;
    const conversationParticipates = isPrimaryCall
      && (typeof options.conversationParticipates === 'boolean'
        ? options.conversationParticipates
        : await AIConversationHelper.getConversationParticipation({ callPurpose, translateMode, sessionId }));
    const conversationOptions = {
      ...options,
      callPurpose,
      conversationParticipates,
      useParentConversationLifecycle: isPrimaryCall && options.useParentConversationLifecycle === true,
    };
    const supportsStreaming = await this.getSupportsStreaming();
    const batchStrategy = await this.getBatchStrategy(translateMode);

    // 1. Try streaming if supported and beneficial
    // Specialized orchestrator modes (Select_Element/Page/PDF) own publication via OJH, never via provider-internal streaming
    const shouldStream = await this._shouldUseStreaming(texts, messageId, engine, translateMode);
    const isAlreadyStreaming = !isSpecializedStreamingOwnerMode(translateMode) && messageId && AIStreamManager.isStreamActive(messageId);

    if (supportsStreaming && (shouldStream || isAlreadyStreaming)) {
      return this._streamingBatchTranslate(texts, sourceLang, targetLang, translateMode, engine, messageId, abortController, priority, sessionId, expectedFormat, conversationOptions);
    }

    // 2. If not streaming but segments exist, use the provider's batch strategy (e.g. smart JSON batching)
    if (texts.length >= 1 && (batchStrategy === 'json' || batchStrategy === 'smart')) {
      return this._translateBatch(texts, sourceLang, targetLang, translateMode, abortController, engine, messageId, sessionId, conversationOptions, expectedFormat, priority);
    }

    // 3. Fallback to traditional sequential batching for single segments or non-JSON providers
    return this.executeSequentialBatch(texts, sourceLang, targetLang, {
      translateMode,
      engine,
      messageId,
      abortController,
      priority,
      sessionId,
      expectedFormat,
      contextMetadata: conversationOptions,
    });
  }

  /**
   * Determine if streaming should be used for this request
   */
  async _shouldUseStreaming(texts, messageId, engine, translateMode) {
    // Disable internal AI streaming for specialized orchestrator modes (single owner: OJH)
    if (isSpecializedStreamingOwnerMode(translateMode)) {
      return false;
    }

    const supportsStreaming = await this.getSupportsStreaming();
    return supportsStreaming && 
           messageId && 
           engine && 
           (texts.length > 1 || AITextProcessor.getTotalComplexity(texts) > 100);
  }

  /**
   * Batch translation implementation (e.g. using JSON)
   * @protected
   */
  async _translateBatch(texts, sourceLang, targetLang, translateMode, abortController, engine, messageId, sessionId, contextMetadata = null, expectedFormat = null, priority = null) {
    const structuredFormat = expectedFormat || ResponseFormat.JSON_ARRAY;
    const customResponseFormatCapabilityRef = contextMetadata?.customResponseFormatCapabilityRef || { responseFormatUnsupported: false };
    const callPurpose = contextMetadata?.callPurpose || TranslationCallPurpose.PRIMARY_TRANSLATION;
    const isPrimaryCall = callPurpose === TranslationCallPurpose.PRIMARY_TRANSLATION;
    const conversationParticipates = callPurpose === TranslationCallPurpose.PRIMARY_TRANSLATION
      && (typeof contextMetadata?.conversationParticipates === 'boolean'
        ? contextMetadata.conversationParticipates
        : await AIConversationHelper.getConversationParticipation({
          callPurpose,
          translateMode,
          sessionId,
        }));
    // Per-call completion slot: the adapter records the completion during its
    // provider execution, and recordProviderCompletion publishes the frozen
    // record into this fresh execution slot. Parallel batches share one
    // operation, so each execution owns its own metadata state.
    const baseExecutionContext = contextMetadata?.executionContext;
    const completionRef = baseExecutionContext ? { record: null } : null;
    const providerMetadataRef = createProviderExecutionMetadataRef();
    const callExecutionContext = baseExecutionContext
      ? { ...baseExecutionContext, completionRef, providerMetadataRef }
      : null;
    const callContextMetadata = {
      ...contextMetadata,
      conversationParticipates,
      expectedFormat: structuredFormat,
      useParentConversationLifecycle: isPrimaryCall && contextMetadata?.useParentConversationLifecycle === true,
      ...(callExecutionContext && { executionContext: callExecutionContext }),
      providerMetadataRef,
      customResponseFormatCapabilityRef,
    };
    const conversationCommitCandidate = (
      (structuredFormat === ResponseFormat.JSON_ARRAY || structuredFormat === ResponseFormat.JSON_OBJECT)
      && conversationParticipates
    ) ? createConversationCommitCandidate(translateMode) : null;
    let acceptedResults;
    try {
      const response = await executeProviderExecutionAttempt(providerMetadataRef, () => this.executeStructuredBatch(
        texts, sourceLang, targetLang, {
          translateMode,
          abortController,
          messageId,
          sessionId,
          contextMetadata: callContextMetadata,
          expectedFormat,
          priority,
          conversationCommitCandidate,
          callPurpose,
        },
      ));

      // Stats recording is handled by ProviderRequestEngine. 
      // Orchestrators (like OptimizedJsonHandler or UnifiedService) handle the reporting.
      const executionContext = callExecutionContext || contextMetadata?.executionContext;

      const parsed = AIResponseParser.parseBatchResult(
        response,
        texts.length,
        texts,
        this.providerName,
        expectedFormat || ResponseFormat.JSON_ARRAY,
        executionContext,
        executionContext?.manifestView,
        completionRef?.record ?? null,
      );

      // Recovery classification (ADR-016 P4): only responses entering structured
      // recovery are classified. It combines the normalized completion of this
      // primary response with parser/validator facts to describe WHY it failed.
      // Accepted responses remain unclassified; recovery policy, retry, and
      // recovery shape are unchanged — classification is decision input, not policy.
      const recoveryClassification = parsed.contractViolation
        ? classifyRecoveryFailure({
            completion: completionRef?.record ?? null,
            parseFailed: parsed.parseFailed === true,
            contractViolation: parsed.contractViolation === true,
            violationCodes: collectRecoveryViolationCodes(parsed),
          })
        : null;

      if (completionRef?.record) {
        logger.debug(`[${this.providerName}] Provider completion record`, {
          provider: completionRef.record.provider,
          model: completionRef.record.model,
          termination: completionRef.record.termination,
          responseId: formatDiagnosticId(completionRef.record.responseId),
          usage: completionRef.record.usage,
        });
      }

      // Structured recovery: the parser reports facts only; recovery ownership stays
      // here. Reliable mappings use selective scalar repair; unmappable responses get
      // one bounded structured retry.
      if (parsed.contractViolation) {
        const selectivePlan = getSelectiveRecoveryPlan(parsed, texts);
        const subsetPlan = selectivePlan && selectivePlan.invalidIndexes.length > MAX_SCALAR_SELECTIVE_RECOVERY_UNITS
          ? {
            invalidIndexes: selectivePlan.invalidIndexes,
            recoveryTexts: selectivePlan.invalidIndexes.map((index) => texts[index]),
          }
          : null;
        const recoveryStrategy = subsetPlan
          ? 'STRUCTURED_SUBSET_RETRY'
          : (selectivePlan ? 'SELECTIVE' : 'FULL_STRUCTURED_RETRY');
        const isFullStructuredRetry = contextMetadata?.fullParseRecoveryRetry === true;
        const mappingFacts = parsed.mappingFacts || {};
        conversationCommitCandidate?.discard();
        logger.warn(`[${this.providerName}] Structured response violated its contract; ${recoveryStrategy} started`);
        logger.debug(`[${this.providerName}] Structured recovery triggered`, {
          event: 'STRUCTURED_RECOVERY_TRIGGERED',
          classification: recoveryClassification?.classification ?? null,
          termination: recoveryClassification?.termination ?? null,
          parseFailed: parsed.parseFailed === true,
          contractViolation: parsed.contractViolation === true,
          invalidUnitCount: Array.isArray(parsed.invalidUnits) ? parsed.invalidUnits.length : 0,
          violationCodes: collectRecoveryViolationCodes(parsed),
          mappingFacts: {
            identityReliable: mappingFacts.identityReliable ?? null,
            complete: mappingFacts.complete ?? null,
            ambiguous: mappingFacts.ambiguous ?? null,
          },
          strategy: recoveryStrategy,
          unitCount: texts.length,
          invalidCount: selectivePlan?.invalidIndexes.length || 0,
          originalUnitCount: texts.length,
          ...(recoveryStrategy === 'FULL_STRUCTURED_RETRY' && {
            reason: parsed.parseFailed === true ? 'PARSE_FAILURE' : 'UNTRUSTWORTHY_MAPPING',
            attempt: 1,
          }),
        });
        logger.debug(`[${this.providerName}] Original structured violation facts`, {
          violationCodes: collectRecoveryViolationCodes(parsed),
          invalidUnitIndexes: boundDiagnosticValues(parsed.invalidUnits?.map(({ requestIndex }) => requestIndex)),
          responseIds: boundDiagnosticValues(parsed.parserDiagnostics?.responseIds, formatDiagnosticId),
          requestIds: boundDiagnosticValues(
            parsed.parserDiagnostics?.requestIds || texts.map((text) => text?.i ?? text?.id ?? null),
            formatDiagnosticId,
          ),
          unresolvedIds: boundDiagnosticValues(parsed.parserDiagnostics?.unresolvedIds, formatDiagnosticId),
          duplicateIds: boundDiagnosticValues(parsed.parserDiagnostics?.duplicateResponseIds, formatDiagnosticId),
          invalidTextIndexes: boundDiagnosticValues(parsed.parserDiagnostics?.invalidTextIndexes),
        });
        appendTranslationDiagnostic(executionContext, {
          type: 'RECOVERY_TRIGGERED',
          event: 'STRUCTURED_RECOVERY_TRIGGERED',
          stage: 'recovery',
          provider: this.providerName,
          code: 'CONTRACT_VIOLATION',
          count: texts.length,
          classification: recoveryClassification?.classification ?? null,
          callPurpose,
          outerCallPurpose: callPurpose,
          expectedFormat,
          strategy: recoveryStrategy,
          attempt: 1,
          unitCount: texts.length,
          invalidCount: selectivePlan?.invalidIndexes.length || 0,
          originalUnitCount: texts.length,
        });

        if (contextMetadata?.isSubsetRecoveryAttempt) {
          throw createStructuredRecoveryFailure();
        }

        if (isFullStructuredRetry) {
          const error = createStructuredRecoveryFailure();
          appendTranslationDiagnostic(executionContext, {
            type: 'RECOVERY_FAILED',
            event: 'STRUCTURED_RECOVERY_FAILED',
            stage: 'recovery-validation',
            provider: this.providerName,
            reason: error.type || error.name || 'RECOVERY_FAILED',
            code: error.type,
            callPurpose,
            outerCallPurpose: callPurpose,
            expectedFormat,
            strategy: recoveryStrategy,
            attempt: 1,
            unitCount: texts.length,
          });
          throw error;
        }

        if (!selectivePlan) {
          if (abortController?.signal?.aborted) {
            throw createOperationAbortError(abortController.signal);
          }
          logger.warn(`[${this.providerName}] Full structured recovery retry started`);
          try {
            const retryResult = await this._translateBatch(
              texts,
              sourceLang,
              targetLang,
              translateMode,
              abortController,
              engine,
              messageId,
              sessionId,
              {
                ...contextMetadata,
                callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
                conversationParticipates: false,
                useParentConversationLifecycle: false,
                customResponseFormatCapabilityRef: undefined,
                repairContext: parsed.repairContext,
                fullParseRecoveryRetry: true,
              },
              expectedFormat,
              priority,
            );
            appendTranslationDiagnostic(executionContext, {
              type: 'RECOVERY_SUCCEEDED',
              event: 'STRUCTURED_RECOVERY_RESULT',
              stage: 'recovery',
              provider: this.providerName,
              callPurpose,
              outerCallPurpose: callPurpose,
              expectedFormat,
              strategy: recoveryStrategy,
              attempt: 1,
              unitCount: texts.length,
            });
            logger.debug(`[${this.providerName}] Structured recovery completed`, {
              event: 'STRUCTURED_RECOVERY_RESULT',
              outerCallPurpose: callPurpose,
              expectedFormat,
              attempt: 1,
              unitCount: texts.length,
              classification: recoveryClassification?.classification ?? null,
              strategy: recoveryStrategy,
              recoveredUnitCount: texts.length,
            });
            return retryResult;
          } catch (error) {
            if (!abortController?.signal?.aborted && !isCancellationError(error)) {
              appendTranslationDiagnostic(executionContext, {
                type: 'RECOVERY_FAILED',
                event: 'STRUCTURED_RECOVERY_FAILED',
                stage: 'recovery',
                provider: this.providerName,
                reason: error.type || error.name || 'RECOVERY_FAILED',
                ...(typeof error.type === 'string' && { code: error.type }),
                callPurpose,
                outerCallPurpose: callPurpose,
                expectedFormat,
                strategy: recoveryStrategy,
                attempt: 1,
                unitCount: texts.length,
              });
            }
            throw error;
          }
        }

        if (subsetPlan) {
          if (abortController?.signal?.aborted) {
            throw createOperationAbortError(abortController.signal);
          }
          const subsetExpectedFormat = expectedFormat || ResponseFormat.JSON_ARRAY;
          const subsetExecutionContext = contextMetadata?.executionContext;
          if (Number.isFinite(subsetExecutionContext?.deadlineAt) && Date.now() >= subsetExecutionContext.deadlineAt) {
            const error = new Error('Batch translation timed out');
            error.type = ErrorTypes.TRANSLATION_TIMEOUT;
            throw error;
          }
          try {
            const subsetResults = await this._translateBatch(
              subsetPlan.recoveryTexts,
              sourceLang,
              targetLang,
              translateMode,
              abortController,
              engine,
              messageId,
              sessionId,
              {
                ...contextMetadata,
                callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
                conversationParticipates: false,
                useParentConversationLifecycle: false,
                customResponseFormatCapabilityRef: undefined,
                expectedFormat: subsetExpectedFormat,
                repairContext: parsed.repairContext,
                isSubsetRecoveryAttempt: true,
              },
              subsetExpectedFormat,
              priority,
            );
            if (!Array.isArray(subsetResults) || subsetResults.length !== subsetPlan.invalidIndexes.length) {
              throw createStructuredRecoveryFailure();
            }
            const finalResults = [...parsed.results];
            subsetPlan.invalidIndexes.forEach((requestIndex, subsetIndex) => {
              finalResults[requestIndex] = subsetResults[subsetIndex];
            });
            validateRecoveredResults(texts, finalResults);
            appendTranslationDiagnostic(executionContext, {
              type: 'RECOVERY_SUCCEEDED',
              event: 'STRUCTURED_RECOVERY_RESULT',
              stage: 'recovery',
              provider: this.providerName,
              callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
              outerCallPurpose: callPurpose,
              expectedFormat: subsetExpectedFormat,
              strategy: 'STRUCTURED_SUBSET_RETRY',
              attempt: 1,
              unitCount: subsetPlan.invalidIndexes.length,
              invalidCount: subsetPlan.invalidIndexes.length,
              originalUnitCount: texts.length,
            });
            logger.debug(`[${this.providerName}] Structured recovery completed`, {
              event: 'STRUCTURED_RECOVERY_RESULT',
              outerCallPurpose: callPurpose,
              expectedFormat: subsetExpectedFormat,
              strategy: 'STRUCTURED_SUBSET_RETRY',
              attempt: 1,
              unitCount: subsetPlan.invalidIndexes.length,
              invalidCount: subsetPlan.invalidIndexes.length,
              originalUnitCount: texts.length,
            });
            return finalResults;
          } catch (error) {
            if (!abortController?.signal?.aborted && !isCancellationError(error)) {
              appendTranslationDiagnostic(executionContext, {
                type: 'RECOVERY_FAILED',
                event: 'STRUCTURED_RECOVERY_FAILED',
                stage: 'recovery',
                provider: this.providerName,
                reason: error.type || error.name || 'RECOVERY_FAILED',
                ...(typeof error.type === 'string' && { code: error.type }),
                callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
                outerCallPurpose: callPurpose,
                expectedFormat: subsetExpectedFormat,
                strategy: 'STRUCTURED_SUBSET_RETRY',
                attempt: 1,
                unitCount: subsetPlan.invalidIndexes.length,
                invalidCount: subsetPlan.invalidIndexes.length,
                originalUnitCount: texts.length,
              });
            }
            throw error;
          }
        }

        logger.debug(`[${this.providerName}] Selective structured recovery input`, {
          event: 'STRUCTURED_RECOVERY_INPUT',
          outerCallPurpose: callPurpose,
          strategy: recoveryStrategy,
          expectedFormat: ResponseFormat.STRING,
          unitCount: texts.length,
          selectedUnitCount: selectivePlan?.invalidIndexes.length || 0,
          selectedUnitsTruncated: (selectivePlan?.invalidIndexes.length || 0) > 32,
          selectedUnits: selectivePlan?.invalidIndexes.slice(0, 32).map((requestIndex) => {
            const source = texts[requestIndex];
            const sourceText = getSourceText(source);
            return {
              requestIndex,
              sourceIdentity: formatDiagnosticId(source?.i ?? source?.id ?? source?.uid ?? null),
              sourceLength: typeof sourceText === 'string' ? sourceText.length : null,
            };
          }) || [],
        });

        let recoveryResult;
        try {
          recoveryResult = await this.executeSequentialBatch(selectivePlan?.recoveryTexts || texts, sourceLang, targetLang, {
            translateMode,
            engine,
            messageId,
            abortController,
            priority,
            sessionId,
            expectedFormat: ResponseFormat.STRING,
            contextMetadata,
            customResponseFormatCapabilityRef: undefined,
            repairContext: parsed.repairContext,
            callPurpose: TranslationCallPurpose.STRUCTURED_RECOVERY,
          });
        } catch (error) {
          if (!abortController?.signal?.aborted && !isCancellationError(error)) {
            appendTranslationDiagnostic(executionContext, {
              type: 'RECOVERY_FAILED',
              event: 'STRUCTURED_RECOVERY_FAILED',
              stage: 'recovery',
              provider: this.providerName,
              reason: error.type || error.name || 'RECOVERY_FAILED',
              ...(typeof error.type === 'string' && { code: error.type }),
              callPurpose,
              outerCallPurpose: callPurpose,
              expectedFormat,
              strategy: recoveryStrategy,
              attempt: 1,
              unitCount: texts.length,
            });
            logger.debug(`[${this.providerName}] Structured recovery failed`, {
              event: 'STRUCTURED_RECOVERY_FAILED',
              outerCallPurpose: callPurpose,
              expectedFormat,
              attempt: 1,
              unitCount: texts.length,
              classification: recoveryClassification?.classification ?? null,
              strategy: recoveryStrategy,
              errorType: typeof error.type === 'string' ? error.type : null,
            });
          }
          throw error;
        }

        logger.debug(`[${this.providerName}] Selective structured recovery result`, {
          event: 'STRUCTURED_RECOVERY_RESULT',
          outerCallPurpose: callPurpose,
          strategy: recoveryStrategy,
          expectedFormat: ResponseFormat.STRING,
          unitCount: texts.length,
          summary: summarizeRecoveryValue(recoveryResult),
        });

        const recoveryValues = selectivePlan
          ? validateSelectiveRecoveryResult(recoveryResult, selectivePlan.invalidIndexes.length)
          : (Array.isArray(recoveryResult) ? recoveryResult : [recoveryResult]);
        const finalResults = selectivePlan
          ? (() => {
            const merged = [...parsed.results];
            selectivePlan.invalidIndexes.forEach((index, recoveryIndex) => {
              merged[index] = recoveryValues[recoveryIndex];
            });
            return merged;
          })()
          : recoveryValues;

        const recoverySourceTexts = selectivePlan
          ? [...texts]
          : texts;
        try {
          validateRecoveredResults(recoverySourceTexts, finalResults);
        } catch (error) {
          if (!abortController?.signal?.aborted && !isCancellationError(error)) {
            appendTranslationDiagnostic(executionContext, {
              type: 'RECOVERY_FAILED',
              event: 'STRUCTURED_RECOVERY_FAILED',
              stage: 'recovery-validation',
              provider: this.providerName,
              reason: error.type || error.name || 'RECOVERY_FAILED',
              ...(typeof error.type === 'string' && { code: error.type }),
            });
            logger.debug(`[${this.providerName}] Structured recovery failed semantic validation`, {
              event: 'STRUCTURED_RECOVERY_FAILED',
              outerCallPurpose: callPurpose,
              expectedFormat,
              attempt: 1,
              unitCount: texts.length,
              classification: recoveryClassification?.classification ?? null,
              strategy: recoveryStrategy,
              errorType: typeof error.type === 'string' ? error.type : null,
              violation: error.contractViolation ?? null,
            });
          }
          throw error;
        }

        appendTranslationDiagnostic(executionContext, {
          type: 'RECOVERY_SUCCEEDED',
          event: 'STRUCTURED_RECOVERY_RESULT',
          stage: 'recovery',
          provider: this.providerName,
          callPurpose,
          outerCallPurpose: callPurpose,
          expectedFormat,
          strategy: recoveryStrategy,
          attempt: 1,
          unitCount: texts.length,
        });
        logger.debug(`[${this.providerName}] Structured recovery completed`, {
          event: 'STRUCTURED_RECOVERY_RESULT',
          outerCallPurpose: callPurpose,
          expectedFormat,
          attempt: 1,
          unitCount: texts.length,
          classification: recoveryClassification?.classification ?? null,
          strategy: recoveryStrategy,
          recoveredUnitCount: recoveryValues.length,
        });
        return finalResults;
      }

      acceptedResults = parsed.results;
    } catch (error) {
      discardProviderExecutionMetadata(providerMetadataRef);
      conversationCommitCandidate?.discard();
      // Error accounting is owned exclusively by ProviderRequestEngine.executeApiCall:
      // TranslationStatsManager.errors counts failed physical HTTP calls only.
      // This batch boundary only logs and rethrows; it must not double-record transport
      // failures or classify cancellation, timeout, or pre-transport rejection as one.
      logger.debug(`[${this.providerName}] Batch translation failed`, {
        errorType: error.type || error.name || 'UNKNOWN',
      });

      // EVERY error is thrown - never return original text as a "successful" translation.
      // - Transient (Network, 429, 5xx): thrown so QueueManager can retry.
      // - Fatal (401, 403): thrown to inform the UI and stop the process.
      // - Non-fatal, non-transient: thrown so the failure surfaces loudly instead of
      //   silently reporting the untranslated original as a success.
      throw error;
    }

    // Late-settlement guard: the outer handler (e.g. OptimizedJsonHandler) may
    // abort the signal immediately after the provider response resolved but
    // before this commit point. Once aborted, the user never receives the
    // result, so the conversation must not be written. Discard the staged
    // candidate and fail loudly as USER_CANCELLED.
    if (abortController?.signal?.aborted) {
      conversationCommitCandidate?.discard();
      throw createOperationAbortError(abortController.signal);
    }

    if (!contextMetadata?.useParentConversationLifecycle) {
      await conversationCommitCandidate?.commit();
    } else {
      conversationCommitCandidate?.discard();
    }
    publishProviderExecutionMetadata(callExecutionContext || contextMetadata?.executionContext, providerMetadataRef, callPurpose);
    return acceptedResults;
  }

  async executeStructuredBatch(texts, sourceLang, targetLang, {
    translateMode,
    abortController,
    messageId,
    sessionId,
    contextMetadata = null,
    expectedFormat = null,
    priority = null,
    conversationCommitCandidate = null,
    callPurpose = TranslationCallPurpose.PRIMARY_TRANSLATION,
  } = {}) {
    const { systemPrompt, userText, originalCharCount } = await this._preparePromptAndText(texts, sourceLang, targetLang, translateMode, contextMetadata, sessionId);
    logger.debugLazy(() => [`[${this.providerName}] Batch Prompt preparation complete`, {
      systemPrompt,
      userText: typeof userText === 'string' ? userText : JSON.parse(userText)
    }]);
    const finalUserText = typeof userText === 'string' ? userText : JSON.stringify(userText);
    const context = `${this.providerName.toLowerCase()}-batch-translation`;
    const providerMetadataRef = contextMetadata?.providerMetadataRef || createProviderExecutionMetadataRef();
    const result = await this._executeWithRateLimit(
      (opts) => executeProviderExecutionAttempt(providerMetadataRef, () => this._callAI(systemPrompt, finalUserText, {
        ...opts,
        abortController,
        messageId,
        sessionId,
        mode: translateMode,
        sourceLang,
        targetLang,
        isBatch: true,
        expectedFormat: expectedFormat || ResponseFormat.JSON_ARRAY,
        executionContext: contextMetadata?.executionContext,
        callPurpose,
        ...(originalCharCount !== undefined && { originalCharCount }),
        conversationParticipates: callPurpose === TranslationCallPurpose.PRIMARY_TRANSLATION
          && contextMetadata?.conversationParticipates === true,
        useParentConversationLifecycle: callPurpose === TranslationCallPurpose.PRIMARY_TRANSLATION
          && contextMetadata?.useParentConversationLifecycle === true,
        conversationCommitCandidate,
        providerMetadataRef,
        customResponseFormatCapabilityRef: contextMetadata?.customResponseFormatCapabilityRef,
      })),
      context,
      priority,
      { sessionId, abortController, messageId, executionContext: contextMetadata?.executionContext }
    );
    return result;
  }

  async executeSequentialBatch(texts, sourceLang, targetLang, {
    translateMode,
    engine,
    messageId,
    abortController,
    priority,
    sessionId,
    expectedFormat,
    contextMetadata = {},
    repairContext = null,
    callPurpose,
  } = {}) {
    const recoveryTexts = callPurpose === TranslationCallPurpose.STRUCTURED_RECOVERY
      ? texts.map(getSourceText)
      : texts;
    return this._traditionalBatchTranslate(
      recoveryTexts, sourceLang, targetLang, translateMode, engine, messageId, abortController,
      priority,
      sessionId,
      expectedFormat,
      {
        ...contextMetadata,
        ...(repairContext && { repairContext }),
        ...(callPurpose && { callPurpose }),
      }
    );
  }

  /**
   * Traditional sequential translation for small segments
   */
  async _traditionalBatchTranslate(texts, sourceLang, targetLang, translateMode, engine, messageId, abortController, priority, sessionId, expectedFormat, options = {}) {
    const results = [];
    const context = `${this.providerName.toLowerCase()}-traditional-sequential`;
    const callPurpose = options.callPurpose || TranslationCallPurpose.PRIMARY_TRANSLATION;
    const isStringContract = (expectedFormat || ResponseFormat.STRING) === ResponseFormat.STRING;
    const isPrimaryCall = callPurpose === TranslationCallPurpose.PRIMARY_TRANSLATION;
    const conversationParticipates = await AIConversationHelper.getConversationParticipation({
      callPurpose,
      translateMode,
      sessionId,
    });
    const effectiveExpectedFormat = expectedFormat || ResponseFormat.STRING;
    const inheritedContextMetadata = options.contextMetadata || {};
    const effectiveContextMetadata = {
      ...options,
      ...inheritedContextMetadata,
      callPurpose,
      expectedFormat: effectiveExpectedFormat,
      conversationParticipates,
      useParentConversationLifecycle: isPrimaryCall && options.useParentConversationLifecycle === true,
      contextMetadata: undefined,
    };

    for (let i = 0; i < texts.length; i++) {
      if (abortController?.signal?.aborted) {
        throw createOperationAbortError(abortController.signal);
      }
      
      const text = texts[i];
      const { systemPrompt, userText } = await this._preparePromptAndText(text, sourceLang, targetLang, translateMode, effectiveContextMetadata, sessionId);
      const sourceText = getSourceText(text);
      const originalCharCount = typeof sourceText === 'string' ? sourceText.length : userText.length;
      
      logger.debugLazy(() => [`[${this.providerName}] Traditional Prompt preparation complete`, { systemPrompt, userText }]);
      const chunkContext = `${context}-segment-${i + 1}/${texts.length}`;

      try {
        const customResponseFormatCapabilityRef = { responseFormatUnsupported: false };
        const providerMetadataRef = createProviderExecutionMetadataRef();
        const response = await this._executeWithRateLimit(
          (opts) => executeProviderExecutionAttempt(providerMetadataRef, () => this._callAI(systemPrompt, userText, {
            ...opts,
            abortController,
            messageId,
            sessionId,
            mode: translateMode,
            sourceLang,
            targetLang,
            expectedFormat: effectiveExpectedFormat,
            executionContext: effectiveContextMetadata.executionContext,
            callPurpose,
            originalCharCount,
            conversationParticipates,
            useParentConversationLifecycle: effectiveContextMetadata.useParentConversationLifecycle,
            providerMetadataRef,
            customResponseFormatCapabilityRef,
          })),
          chunkContext,
          priority,
          { sessionId, abortController, messageId }
        );

        if (isStringContract) {
          validateSequentialStringResponse(response, [text], this.providerName);
        }

        const cleanedResponse = AIResponseParser.cleanAIResponse(response, expectedFormat || ResponseFormat.STRING);
        publishProviderExecutionMetadata(effectiveContextMetadata.executionContext, providerMetadataRef, callPurpose);
        results.push(cleanedResponse);
      } catch (error) {
        logger.error(`[${this.providerName}] Traditional segment translation failed:`, error.message);
        // No silent success: a failed segment fails the batch loudly. The error
        // propagates for retry (transient) or explicit failure reporting (fatal/permanent).
        throw error;
      }
    }
    return results.length === 1 && texts.length === 1 ? results[0] : results;
  }

  /**
   * Streaming batch translation implementation
   * Sends segments in multiple batches for real-time updates. Intermediate
   * publication is skipped when OJH owns canonical structured publication.
   * @protected
   */
  async _streamingBatchTranslate(texts, sourceLang, targetLang, translateMode, engine, messageId, abortController, priority, sessionId, expectedFormat, options = {}) {
    logger.debug(`[${this.providerName}] Starting streaming translation for ${texts.length} segments`);

    // Ensure streaming is initialized in the central manager
    if (messageId && engine && !AIStreamManager.isStreamActive(messageId)) {
      try {
        const sender = typeof engine.getStreamingSender === 'function' ? engine.getStreamingSender(messageId) : null;
        if (sender) {
          // If we have sender info, we can safely initialize the stream even if coordinator skipped it
          const { streamingManager } = await import("@/features/translation/core/StreamingManager.js");
          const streamArgs = [messageId, sender, this, texts, sessionId];
          if (options.executionContext?.conversationAcceptanceRegistered === true) streamArgs.push(true);
          streamingManager.initializeStream(...streamArgs);
          logger.debug(`[${this.providerName}] Late-initialized stream for messageId: ${messageId}`);
        }
      } catch (err) {
        logger.warn(`[${this.providerName}] Failed to late-initialize stream:`, err.message);
      }
    }

    // Check one last time if we can actually stream
    const canStream = messageId && AIStreamManager.isStreamActive(messageId);
    if (!canStream) {
      logger.debug(`[${this.providerName}] Streaming not active for ${messageId}, falling back to standard batch`);
      return this._translateBatch(texts, sourceLang, targetLang, translateMode, abortController, engine, messageId, sessionId, options, expectedFormat, priority);
    }

    // Get batching configuration
    const batchingConfig = await this.getBatchingConfig(translateMode);
    const characterLimit = batchingConfig.characterLimit || 5000;

    // 1. Pre-process segments: Split oversized single segments into multiple pieces
    // This ensures that even a single 30k char text is streamed in multiple batches
    const fragmentedTexts = [];
    for (const text of texts) {
      const isObject = typeof text === 'object' && text !== null;
      const content = isObject ? (text.t || text.text || "") : text;
      
      if (typeof content === 'string' && content.length > characterLimit && !AITextProcessor.hasPlaceholders([text])) {
        logger.debug(`[${this.providerName}] Splitting oversized segment (${content.length} chars) for streaming`);
        const chunks = AITextProcessor.smartChunkWithPlaceholders(content, characterLimit);
        
        // Convert chunks back to the original format (preserving IDs if they were objects)
        const typedChunks = chunks.map(chunk => isObject ? { ...text, t: chunk, text: chunk } : chunk);
        fragmentedTexts.push(...typedChunks);
      } else {
        fragmentedTexts.push(text);
      }
    }

    const batches = AITextProcessor.createOptimalBatches(fragmentedTexts, this.providerName, translateMode, batchingConfig);
    const allResults = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      if (abortController?.signal?.aborted || (engine && engine.isCancelled?.(messageId))) {
        throw createOperationAbortError(abortController?.signal);
      }

      const batch = batches[batchIndex];

      try {
        const batchResponse = await this._translateBatch(
          batch,
          sourceLang,
          targetLang,
          translateMode,
          abortController,
          engine,
          messageId,
          sessionId,
          options,
          expectedFormat,
          priority,
        );

        const batchResults = Array.isArray(batchResponse) ? batchResponse : [batchResponse];
        allResults.push(...batchResults);

        // OJH publishes mapped structured results through its canonical path.
        if (engine && messageId
            && options.executionContext?.resultPublicationOwner !== OJH_RESULT_PUBLICATION_OWNER) {
          await AIStreamManager.streamBatchResults(
            this.providerName,
            batchResults,
            batch,
            batchIndex,
            messageId,
            engine,
            sourceLang,
            targetLang
          );
        }

        logger.debug(`[${this.providerName}] Batch ${batchIndex + 1}/${batches.length} completed (${batchResults.length} segments)`);
      } catch (error) {
        logger.error(`[${this.providerName}] Batch ${batchIndex + 1} failed:`, error);

        // Stream error to content script
        if (engine && messageId) {
          await AIStreamManager.streamErrorResults(this.providerName, error, batchIndex, messageId, engine);

        }

        throw error;
      }
    }

    return allResults;
  }

  /**
   * Helper to prepare the prompt and text for AI models
   * @protected
   */
  async _preparePromptAndText(texts, sourceLang, targetLang, translateMode, contextMetadata, sessionId = null) {
    return await AIConversationHelper.preparePromptAndText(texts, sourceLang, targetLang, translateMode, this.constructor.type, sessionId, contextMetadata);
  }

  /**
   * Abstract method to call the actual AI API
   * @protected
   */
  async _callAI() {
    throw new Error(`_callAI not implemented by ${this.providerName}`);
  }
}
