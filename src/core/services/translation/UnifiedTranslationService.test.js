import { vi } from 'vitest';

// Mock backgroundService early
globalThis.backgroundService = {
  translationEngine: {
    cancelTranslation: vi.fn()
  }
};

const backgroundLeaseMock = vi.hoisted(() => {
  const state = { activeOperationCount: 0 };
  const runWithLease = async (_operationId, operation) => {
    state.activeOperationCount += 1;
    try {
      return await operation();
    } finally {
      state.activeOperationCount -= 1;
    }
  };

  return {
    state,
    runWithLease,
    getStatus: () => ({
      activeOperationCount: state.activeOperationCount,
      timer: state.activeOperationCount > 0 ? {} : null,
      timerActive: state.activeOperationCount > 0,
    }),
    withBackgroundOperationLease: vi.fn(runWithLease),
  };
});

const streamingManagerMock = vi.hoisted(() => ({
  initializeStream: vi.fn(),
  getStreamInfo: vi.fn(),
  completeStream: vi.fn(),
}));

vi.mock('./BackgroundOperationLease.js', () => backgroundLeaseMock);
vi.mock('@/features/translation/core/StreamingManager.js', () => ({
  streamingManager: streamingManagerMock,
}));

// 1. Mocks first
vi.mock('./TranslationRequestTracker.js', () => ({
  translationRequestTracker: {
    getRequest: vi.fn(),
    isRequestActive: vi.fn(),
    createRequest: vi.fn(),
    setActiveExpiryHandler: vi.fn(),
    updateRequest: vi.fn(),
    completeRequest: vi.fn(),
    failRequest: vi.fn(),
    cancelRequest: vi.fn(),
    markTimeout: vi.fn(),
    cleanup: vi.fn()
  },
  RequestStatus: {
    COMPLETED: 'completed',
    FAILED: 'failed',
    TIMEOUT: 'timeout'
  }
}));

vi.mock('./UnifiedResultDispatcher.js', () => ({
  UnifiedResultDispatcher: vi.fn().mockImplementation(function() {
    this.dispatchResult = vi.fn();
    this.dispatchStreamingUpdate = vi.fn();
    this.dispatchCancellation = vi.fn();
  })
}));

vi.mock('./UnifiedModeCoordinator.js', () => ({
  UnifiedModeCoordinator: vi.fn().mockImplementation(function() {
    return {
      processRequest: vi.fn()
    };
  })
}));

vi.mock('../../../features/translation/utils/translationModeHelper.js', () => ({
  isEligibleForDictionaryUpgrade: vi.fn().mockResolvedValue(false)
}));

vi.mock('../../../shared/config/config.js', () => ({
  TranslationMode: {
    Field: 'field',
    Selection: 'selection',
    Select_Element: 'select-element',
    Page: 'page',
    PDF: 'pdf-translation'
  },
  getModeProvidersAsync: vi.fn().mockResolvedValue({}),
  getTranslationApiAsync: vi.fn().mockResolvedValue('google'),
  getPopupMaxCharsAsync: vi.fn().mockResolvedValue(5000),
  getSidepanelMaxCharsAsync: vi.fn().mockResolvedValue(10000),
  getSelectionMaxCharsAsync: vi.fn().mockResolvedValue(5000),
  getSelectElementMaxCharsAsync: vi.fn().mockResolvedValue(20000)
  ,getAIConversationHistoryEnabledAsync: vi.fn().mockResolvedValue(true)
}));

vi.mock('../../../shared/messaging/core/MessagingCore.js', () => ({
  MessageFormat: {
    validate: vi.fn().mockReturnValue(true),
    createErrorResponse: vi.fn((err) => ({ success: false, error: err.message || err })),
    serializeTranslationError: vi.fn((error, options = {}) => ({
      message: error?.message || String(error),
      ...(options.type || error?.type ? { type: options.type || error.type } : {}),
      ...(options.providerName || error?.providerName ? { providerName: options.providerName || error.providerName } : {}),
    }))
  },
  MessageContexts: {
    POPUP: 'popup',
    SIDEPANEL: 'sidepanel',
    SELECT_ELEMENT: 'select-element',
    PDF_TRANSLATION: 'pdf-translation',
    PAGE_TRANSLATION_BATCH: 'page-translation-batch',
    CONTENT: 'content',
    MOBILE_TRANSLATE: 'mobile-translate',
    SELECTION_MANAGER: 'selection-manager'
  },
  ActionReasons: {
    USER_CANCELLED: 'user_cancelled'
  }
}));

vi.mock('../../../features/translation/core/TranslationStatsManager.js', () => ({
  statsManager: {
    printSummary: vi.fn(),
    recordOperationQuality: vi.fn()
  }
}));

vi.mock('../../../shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock('../../../shared/logging/logConstants.js', () => ({
  LOG_COMPONENTS: {
    TRANSLATION: 'translation'
  }
}));

vi.mock('../../../features/translation/ir/TranslationOperation.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createTranslationOperation: vi.fn(actual.createTranslationOperation),
    finalizeTranslationOperation: vi.fn(actual.finalizeTranslationOperation)
  };
});

vi.mock('../../../features/translation/ir/RequestUnitManifest.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequestUnitManifest: vi.fn(actual.createRequestUnitManifest)
  };
});

vi.mock('../../../features/translation/ir/TerminalExecutionRouter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    TerminalExecutionRouter: {
      ...actual.TerminalExecutionRouter,
      routeTerminalExecution: vi.fn(actual.TerminalExecutionRouter.routeTerminalExecution)
    }
  };
});

// 2. Imports second
import { describe, it, expect, beforeEach } from 'vitest';
import { UnifiedTranslationService } from './UnifiedTranslationService.js';
import { ErrorTypes } from '../../../shared/error-management/ErrorTypes.js';
import { translationRequestTracker } from './TranslationRequestTracker.js';
import { createTranslationOperation, finalizeTranslationOperation } from '../../../features/translation/ir/TranslationOperation.js';
import { createRequestUnitManifest } from '../../../features/translation/ir/RequestUnitManifest.js';
import { TerminalExecutionRouter } from '../../../features/translation/ir/TerminalExecutionRouter.js';
import { AIConversationHelper } from '../../../features/translation/providers/utils/AIConversationHelper.js';
import { ActionReasons } from '../../../shared/messaging/core/MessagingCore.js';
import { statsManager } from '../../../features/translation/core/TranslationStatsManager.js';
import { translationSessionManager } from '../../../features/translation/core/TranslationSessionManager.js';
import * as configuration from '../../../shared/config/config.js';
import { isEligibleForDictionaryUpgrade } from '../../../features/translation/utils/translationModeHelper.js';

describe('UnifiedTranslationService', () => {
  let service;
  let mockEngine;
  let mockBackground;

  beforeEach(() => {
    vi.clearAllMocks();
    configuration.getModeProvidersAsync.mockReset().mockResolvedValue({});
    configuration.getTranslationApiAsync.mockReset().mockResolvedValue('google');
    configuration.getPopupMaxCharsAsync.mockReset().mockResolvedValue(5000);
    configuration.getSidepanelMaxCharsAsync.mockReset().mockResolvedValue(10000);
    configuration.getSelectionMaxCharsAsync.mockReset().mockResolvedValue(5000);
    configuration.getSelectElementMaxCharsAsync.mockReset().mockResolvedValue(20000);
    isEligibleForDictionaryUpgrade.mockReset().mockResolvedValue(false);
    backgroundLeaseMock.state.activeOperationCount = 0;
    backgroundLeaseMock.withBackgroundOperationLease
      .mockReset()
      .mockImplementation(backgroundLeaseMock.runWithLease);
    translationRequestTracker.getRequest.mockReset();
    translationRequestTracker.isRequestActive.mockReset();
    translationRequestTracker.createRequest.mockReset().mockImplementation(({ messageId, data }) => ({
      messageId,
      data: { ...data, sessionId: data?.sessionId || messageId },
      mode: data?.mode,
      status: 'pending',
      metadata: { provider: data?.provider },
    }));
    streamingManagerMock.initializeStream.mockReset();
    streamingManagerMock.getStreamInfo.mockReset().mockReturnValue(null);
    streamingManagerMock.completeStream.mockReset().mockResolvedValue(undefined);
    service = new UnifiedTranslationService();
    mockEngine = { cancelTranslation: vi.fn() };
    mockBackground = { translationEngine: mockEngine };
    service.initialize({ translationEngine: mockEngine, backgroundService: mockBackground });
    translationRequestTracker.completeRequest.mockReturnValue({ accepted: true, status: 'completed' });
    translationRequestTracker.failRequest.mockReturnValue({ accepted: true, status: 'failed' });
    translationRequestTracker.cancelRequest.mockReturnValue({ accepted: true, status: 'cancelled' });
    translationRequestTracker.markTimeout.mockReturnValue({ accepted: true, status: 'timeout' });
  });

  describe('handleTranslationRequest', () => {
    it('wraps complete requests in a background operation lease', async () => {
      const message = {
        messageId: 'lease-request',
        data: { text: 'source', mode: 'selection', provider: 'google' },
        context: 'content',
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'selection' };
      translationRequestTracker.createRequest.mockReturnValue(request);
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'translated' });

      await service.handleTranslationRequest(message);

      expect(backgroundLeaseMock.withBackgroundOperationLease).toHaveBeenCalledWith(
        message.messageId,
        expect.any(Function),
      );
    });

    it.each([
      ['cancellation', 'lease-cancel'],
      ['timeout', 'lease-timeout'],
    ])('keeps lease owned by wrapped operation during terminal %s unwind', async (transitionType, messageId) => {
      const message = {
        messageId,
        data: { text: 'source', mode: 'selection', provider: 'google' },
        context: 'content',
      };
      const request = { messageId, data: message.data, mode: 'selection' };
      let settleExecution;
      const execution = new Promise(resolve => {
        settleExecution = resolve;
      });

      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.getRequest
        .mockReturnValueOnce(null)
        .mockReturnValue(request);
      translationRequestTracker.completeRequest.mockReturnValue({
        accepted: false,
        status: transitionType === 'timeout' ? 'timeout' : 'cancelled',
        reason: 'already_terminal',
      });
      service.modeCoordinator.processRequest.mockReturnValue(execution);

      const wrappedRequest = service.handleTranslationRequest(message);
      await vi.waitFor(() => expect(service.modeCoordinator.processRequest).toHaveBeenCalledTimes(1));
      expect(backgroundLeaseMock.getStatus()).toMatchObject({
        activeOperationCount: 1,
        timerActive: true,
      });

      if (transitionType === 'timeout') {
        await service.handleTimeout(messageId);
      } else {
        await service.cancelRequest(messageId);
      }

      expect(backgroundLeaseMock.getStatus()).toMatchObject({
        activeOperationCount: 1,
        timerActive: true,
      });

      settleExecution({ success: true, translatedText: 'translated' });
      await wrappedRequest;

      expect(backgroundLeaseMock.getStatus()).toMatchObject({
        activeOperationCount: 0,
        timer: null,
        timerActive: false,
      });
    });

    it('registers immutable conversation handoff before execution and preserves handle after operation finalization', async () => {
      const message = {
        messageId: 'handoff-runtime',
        data: {
          text: 'source',
          mode: 'select-element',
          provider: 'openai',
          sessionId: 'session-1',
          conversationParents: [
            { parentId: 'g2', cleanSource: 'second' },
            { parentId: 'g1', cleanSource: 'first' },
          ],
        },
        context: 'select-element',
      };
      const mockRequest = { messageId: message.messageId, data: message.data };
      expect(mockRequest).not.toHaveProperty('mode');
      expect(mockRequest).not.toHaveProperty('sessionId');
      translationRequestTracker.createRequest.mockReturnValue(mockRequest);
      const registrationSpy = vi.spyOn(service, '_registerConversationAcceptance');
      let handleDuringProcessing;
      let executionContextDuringProcessing;
      service.modeCoordinator.processRequest.mockImplementation(async (_request, { executionContext }) => {
        executionContextDuringProcessing = executionContext;
        handleDuringProcessing = service.conversationAcceptanceCoordinator.lookup(message.messageId);
        return { success: true, translatedText: 'translated' };
      });

      await expect(service.handleTranslationRequest(message)).resolves.toMatchObject({ success: true });

      const handle = service.conversationAcceptanceCoordinator.lookup(message.messageId);
      expect(handle).not.toBeNull();
      expect(handleDuringProcessing).toBe(handle);
      expect(executionContextDuringProcessing.conversationAcceptanceRegistered).toBe(true);
      expect(registrationSpy).toHaveBeenCalledTimes(1);
      expect(handle.snapshot()).toMatchObject({
        messageId: message.messageId,
        sessionId: 'session-1',
        parents: [
          { parentId: 'g2', sourceOrder: 0, cleanSource: 'second', state: 'PENDING' },
          { parentId: 'g1', sourceOrder: 1, cleanSource: 'first', state: 'PENDING' },
        ],
      });
      expect(handle.snapshot().parents[0].cleanResult).toBeNull();
      expect(finalizeTranslationOperation).toHaveBeenCalled();
      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).toBe(handle);

      service.conversationAcceptanceCoordinator.remove(message.messageId);
      handle.dispose();
    });

    it('propagates the authoritative conversation acceptance decision to the result', async () => {
      const { getAIConversationHistoryEnabledAsync } = await import('../../../shared/config/config.js');
      const buildMessage = (messageId) => ({
        messageId,
        data: {
          text: 'source',
          mode: 'select-element',
          provider: 'openai',
          sessionId: messageId,
          conversationParents: [{ parentId: 'g1', cleanSource: 'source' }],
        },
        context: 'select-element',
      });

      getAIConversationHistoryEnabledAsync.mockResolvedValue(true);
      const messageOn = buildMessage('propagation-on');
      const requestOn = { messageId: messageOn.messageId, data: messageOn.data };
      translationRequestTracker.createRequest.mockReturnValueOnce(requestOn);
      service.modeCoordinator.processRequest.mockResolvedValueOnce({ success: true, translatedText: 'translated' });

      const resultOn = await service.handleTranslationRequest(messageOn);
      expect(resultOn).toMatchObject({ success: true, conversationAcceptance: true });

      getAIConversationHistoryEnabledAsync.mockResolvedValue(false);
      const messageOff = buildMessage('propagation-off');
      const requestOff = { messageId: messageOff.messageId, data: messageOff.data };
      translationRequestTracker.createRequest.mockReturnValueOnce(requestOff);
      service.modeCoordinator.processRequest.mockResolvedValueOnce({ success: true, translatedText: 'translated' });

      const resultOff = await service.handleTranslationRequest(messageOff);
      expect(resultOff).toMatchObject({ success: true });
      expect(resultOff).not.toHaveProperty('conversationAcceptance');
    });

    it('accepts ACK before execution completes without activating timeout', async () => {
      vi.useFakeTimers();
      const { getAIConversationHistoryEnabledAsync } = await import('../../../shared/config/config.js');
      getAIConversationHistoryEnabledAsync.mockResolvedValue(true);
      const message = {
        messageId: 'early-ack',
        data: {
          text: 'source', mode: 'select-element', provider: 'openai', sessionId: 'session-1',
          conversationParents: [
            { parentId: 'g1', cleanSource: 'source' },
            { parentId: 'g2', cleanSource: 'sibling' },
          ],
        },
        context: 'select-element',
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'select-element' };
      let resolveExecution;
      translationRequestTracker.createRequest.mockReturnValue(request);
      service.modeCoordinator.processRequest.mockReturnValue(new Promise(resolve => {
        resolveExecution = resolve;
      }));

      const pending = service.handleTranslationRequest(message);
      for (let index = 0; index < 30 && !service.conversationAcceptanceCoordinator.lookup(message.messageId); index++) {
        await Promise.resolve();
      }
      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).not.toBeNull();

      await expect(service.conversationAcceptanceCoordinator.acknowledge(message.messageId, 'g1', true, 'translated'))
        .resolves.toMatchObject({ status: 'ACCEPTED' });
      await vi.advanceTimersByTimeAsync(300000);
      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).not.toBeNull();

      resolveExecution({ success: true, translatedText: 'translated' });
      await pending;
      vi.useRealTimers();
    });

    it.each([
      ['execution failure', () => service.modeCoordinator.processRequest.mockRejectedValue(new Error('execution failed'))],
      ['execution timeout', () => service.modeCoordinator.processRequest.mockRejectedValue(Object.assign(new Error('timed out'), { type: ErrorTypes.TRANSLATION_TIMEOUT }))],
    ])('removes early handle on %s', async (_label, rejectExecution) => {
      const message = {
        messageId: `early-failure-${_label}`,
        data: {
          text: 'source', mode: 'select-element', provider: 'openai', sessionId: 'session-1',
          conversationParents: [{ parentId: 'g1', cleanSource: 'source' }],
        },
        context: 'select-element',
      };
      translationRequestTracker.createRequest.mockReturnValue({ messageId: message.messageId, data: message.data, mode: 'select-element' });
      rejectExecution();

      await service.handleTranslationRequest(message);

      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).toBeNull();
    });

    it('removes early handle when cancellation wins during execution', async () => {
      const message = {
        messageId: 'early-cancel',
        data: {
          text: 'source', mode: 'select-element', provider: 'openai', sessionId: 'session-1',
          conversationParents: [{ parentId: 'g1', cleanSource: 'source' }],
        },
        context: 'select-element',
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'select-element' };
      let resolveExecution;
      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.getRequest
        .mockReturnValueOnce(null)
        .mockReturnValue(request);
      service.modeCoordinator.processRequest.mockReturnValue(new Promise(resolve => {
        resolveExecution = resolve;
      }));

      const pending = service.handleTranslationRequest(message);
      for (let index = 0; index < 30 && !service.conversationAcceptanceCoordinator.lookup(message.messageId); index++) {
        await Promise.resolve();
      }
      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).not.toBeNull();

      await service.cancelRequest(message.messageId);
      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).toBeNull();

      translationRequestTracker.completeRequest.mockReturnValue({ accepted: false, status: 'cancelled', reason: 'already_terminal' });
      resolveExecution({ success: true, translatedText: 'translated' });
      await pending;
    });

    it('keeps an early-committed parent after later execution failure', async () => {
      vi.useRealTimers();
      const { getAIConversationHistoryEnabledAsync } = await import('../../../shared/config/config.js');
      getAIConversationHistoryEnabledAsync.mockResolvedValue(true);
      translationSessionManager.sessions.clear();

      const message = {
        messageId: 'early-commit-later-failure',
        data: {
          text: 'source',
          mode: 'select-element',
          provider: 'openai',
          sessionId: 'early-commit-session',
          conversationParents: [
            { parentId: 'g1', cleanSource: 'source A' },
            { parentId: 'g2', cleanSource: 'source B' },
          ],
        },
        context: 'select-element',
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'select-element' };
      let rejectExecution;
      translationRequestTracker.createRequest.mockReturnValue(request);
      service.modeCoordinator.processRequest.mockReturnValue(new Promise((_resolve, reject) => {
        rejectExecution = reject;
      }));

      const pending = service.handleTranslationRequest(message);
      for (let index = 0; index < 30 && !service.conversationAcceptanceCoordinator.lookup(message.messageId); index++) {
        await Promise.resolve();
      }
      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).not.toBeNull();

      const firstAck = await service.conversationAcceptanceCoordinator.acknowledge(
        message.messageId,
        'g1',
        true,
        'translated A',
      );
      expect(firstAck).toMatchObject({ status: 'ACCEPTED', committed: ['g1'] });

      const session = translationSessionManager.sessions.get(message.data.sessionId);
      expect(session.history.map(({ content }) => content)).toEqual(['source A', 'translated A']);
      expect(session.history).toHaveLength(2);

      rejectExecution(new Error('sibling execution failed'));
      await pending;

      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).toBeNull();
      expect(session.history.map(({ content }) => content)).toEqual(['source A', 'translated A']);
      expect(session.history).toHaveLength(2);
    });

    it('does not register conversation acceptance for non-participating execution', async () => {
      const message = {
        messageId: 'handoff-stateless',
        data: {
          text: 'source', mode: 'select-element', provider: 'openai', sessionId: 'session-1',
          conversationParents: [{ parentId: 'g1', cleanSource: 'source' }],
        },
        context: 'select-element',
      };
      const mockRequest = { messageId: message.messageId, data: message.data };
      const { getAIConversationHistoryEnabledAsync } = await import('../../../shared/config/config.js');
      getAIConversationHistoryEnabledAsync.mockResolvedValue(false);
      translationRequestTracker.createRequest.mockReturnValue(mockRequest);
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'translated' });

      await service.handleTranslationRequest(message);

      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).toBeNull();
    });
    it.each([
      ['AI participating parent', 'openai', 's1', true, 1],
      ['traditional provider', 'google', 's1', true, 0],
      ['history disabled', 'openai', 's1', false, 0],
      ['invalid session', 'openai', '', true, 0],
    ])('%s registers only eligible parent candidates', async (_label, provider, sessionId, historyEnabled, expectedCount) => {
      const { getAIConversationHistoryEnabledAsync } = await import('../../../shared/config/config.js');
      getAIConversationHistoryEnabledAsync.mockResolvedValue(historyEnabled);
      const message = {
        messageId: `parent-${_label}`,
        sessionId,
        data: {
          text: JSON.stringify([{ t: 'source', i: 'n1', b: 'g1' }]),
          mode: 'select-element',
          provider,
          sessionId,
          conversationParents: [{ parentId: 'g1', cleanSource: 'source' }],
        },
        context: 'select-element',
      };
      const mockRequest = { messageId: message.messageId, data: message.data, sessionId };
      let candidatesDuringProcessing;
      translationRequestTracker.createRequest.mockReturnValue(mockRequest);
      service.modeCoordinator.processRequest.mockImplementation(async (_request, options) => {
        candidatesDuringProcessing = options.executionContext.operation.snapshotParentCandidates();
        return { success: true, translatedText: 'translated' };
      });

      await service.handleTranslationRequest(message);

      expect(candidatesDuringProcessing).toHaveLength(expectedCount);
    });

    it('registers an eligible AI parent before operation processing without throwing', async () => {
      const { getAIConversationHistoryEnabledAsync } = await import('../../../shared/config/config.js');
      getAIConversationHistoryEnabledAsync.mockResolvedValue(true);
      const message = {
        messageId: 'parent-runtime',
        data: {
          text: JSON.stringify([{ t: 'source', i: 'n1', b: 'g1' }]),
          mode: 'select-element',
          provider: 'openai',
          sessionId: 's1',
          conversationParents: [{ parentId: 'g1', cleanSource: 'source' }],
        },
        context: 'select-element',
      };
      const mockRequest = { messageId: 'parent-runtime', data: message.data, sessionId: 's1' };
      let candidatesDuringProcessing;
      translationRequestTracker.createRequest.mockReturnValue(mockRequest);
      service.modeCoordinator.processRequest.mockImplementation(async (_request, options) => {
        candidatesDuringProcessing = options.executionContext.operation.snapshotParentCandidates();
        return { success: true, translatedText: 'translated' };
      });

      await expect(service.handleTranslationRequest(message)).resolves.toMatchObject({ success: true });
      expect(candidatesDuringProcessing).toEqual([
        expect.objectContaining({ parentId: 'g1', sourceOrder: 0, cleanSource: 'source', state: 'STAGED' }),
      ]);
    });
    it('creates isolated result dispatchers for separate services', () => {
      const secondService = new UnifiedTranslationService();

      expect(service.resultDispatcher).not.toBe(secondService.resultDispatcher);
    });

    it('should block requests exceeding character limits', async () => {
      const message = {
        messageId: 'm1',
        data: { text: 'a'.repeat(6000), mode: 'selection' },
        context: 'popup'
      };

      const result = await service.handleTranslationRequest(message);

      expect(result.success).toBe(false);
      expect(result.error.type).toBe(ErrorTypes.TEXT_TOO_LONG);
      expect(translationRequestTracker.failRequest).toHaveBeenCalledTimes(1);
      expect(service.modeCoordinator.processRequest).not.toHaveBeenCalled();
    });

    it('should use context-specific character limits (Sidepanel)', async () => {
      const message = {
        messageId: 'm1',
        data: { text: 'a'.repeat(12000), mode: 'selection' },
        context: 'sidepanel'
      };
      const result = await service.handleTranslationRequest(message);
      expect(result.success).toBe(false); // Max is 10000
    });

    it('should process a valid request successfully', async () => {
      const message = {
        messageId: 'm1',
        data: { text: 'hello', mode: 'selection' },
        context: 'content'
      };

      const mockRequest = { messageId: 'm1', data: message.data };
      translationRequestTracker.createRequest.mockReturnValue(mockRequest);
      
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'bonjour' });

      const result = await service.handleTranslationRequest(message);

      expect(result.success).toBe(true);
      expect(result.translatedText).toBe('bonjour');
      expect(service.resultDispatcher.dispatchResult).toHaveBeenCalled();
    });

    it('returns delivery failure without activating conversation acceptance', async () => {
      const message = {
        messageId: 'delivery-failure',
        data: {
          text: 'source',
          mode: 'select-element',
          provider: 'openai',
          sessionId: 'delivery-failure',
          conversationParents: [{ parentId: 'g1', cleanSource: 'source' }],
        },
        context: 'select-element',
      };
      const request = { messageId: message.messageId, data: message.data };
      const deliveryError = Object.assign(new Error('Select Element result delivery failed'), {
        type: ErrorTypes.CONNECTION_LOST,
      });
      translationRequestTracker.createRequest.mockReturnValue(request);
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'translated' });
      service.resultDispatcher.dispatchResult.mockRejectedValue(deliveryError);
      const activate = vi.spyOn(service.conversationAcceptanceCoordinator, 'activate');
      const remove = vi.spyOn(service.conversationAcceptanceCoordinator, 'remove');

      const result = await service.handleTranslationRequest(message);

      expect(result).toMatchObject({ success: false, error: deliveryError.message });
      expect(remove).toHaveBeenCalledWith(message.messageId);
      expect(activate).not.toHaveBeenCalled();
      expect(service.modeCoordinator.processRequest).toHaveBeenCalledTimes(1);
      expect(translationRequestTracker.completeRequest).toHaveBeenCalledWith(message.messageId, expect.objectContaining({ success: true }));
    });

    it.each([
      ['operation abort', {
        success: false,
        cancelled: false,
        error: {
          operationAborted: true,
          cancellationReason: 'operation-abort',
          message: 'Translation operation aborted',
        },
      }],
      ['provider failure', {
        success: false,
        error: { type: ErrorTypes.API_ERROR, message: 'Provider rejected request' },
      }],
      ['pre-cancelled tombstone', {
        success: false,
        cancelled: true,
        error: { type: ErrorTypes.USER_CANCELLED, message: 'Translation cancelled by user' },
      }],
    ])('removes acceptance without activating for terminal %s result', async (_label, failedResult) => {
      const { getAIConversationHistoryEnabledAsync } = await import('../../../shared/config/config.js');
      getAIConversationHistoryEnabledAsync.mockResolvedValue(true);
      const message = {
        messageId: `failed-result-${_label}`,
        data: {
          text: 'source',
          mode: 'select-element',
          provider: 'openai',
          sessionId: `failed-result-${_label}`,
          conversationParents: [{ parentId: 'g1', cleanSource: 'source' }],
        },
        context: 'select-element',
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'select-element' };
      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.completeRequest.mockReturnValue({ accepted: true, status: 'failed' });
      service.modeCoordinator.processRequest.mockResolvedValue(failedResult);
      const activate = vi.spyOn(service.conversationAcceptanceCoordinator, 'activate');
      const remove = vi.spyOn(service.conversationAcceptanceCoordinator, 'remove');

      const result = await service.handleTranslationRequest(message);

      expect(service.resultDispatcher.dispatchResult).toHaveBeenCalledWith(expect.objectContaining({
        messageId: message.messageId,
        result: expect.objectContaining(failedResult),
      }));
      expect(result).toMatchObject(failedResult);
      expect(activate).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith(message.messageId);
      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).toBeNull();
      expect(result.error).toMatchObject(failedResult.error);
    });

    it('activates acceptance exactly once for successful partial results', async () => {
      const { getAIConversationHistoryEnabledAsync } = await import('../../../shared/config/config.js');
      getAIConversationHistoryEnabledAsync.mockResolvedValue(true);
      const message = {
        messageId: 'successful-partial-result',
        data: {
          text: 'source',
          mode: 'select-element',
          provider: 'openai',
          sessionId: 'successful-partial-result',
          conversationParents: [{ parentId: 'g1', cleanSource: 'source' }],
        },
        context: 'select-element',
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'select-element' };
      translationRequestTracker.createRequest.mockReturnValue(request);
      service.modeCoordinator.processRequest.mockResolvedValue({
        success: true,
        partial: true,
        committedParentCount: 1,
        translatedText: 'translated',
      });
      const activate = vi.spyOn(service.conversationAcceptanceCoordinator, 'activate');
      const remove = vi.spyOn(service.conversationAcceptanceCoordinator, 'remove');

      await service.handleTranslationRequest(message);

      expect(activate).toHaveBeenCalledTimes(1);
      expect(activate).toHaveBeenCalledWith(message.messageId);
      expect(remove).not.toHaveBeenCalled();
      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).not.toBeNull();
      service.conversationAcceptanceCoordinator.remove(message.messageId);
    });

    it('does not touch acceptance for successful Field direct results', async () => {
      const { getAIConversationHistoryEnabledAsync } = await import('../../../shared/config/config.js');
      getAIConversationHistoryEnabledAsync.mockResolvedValue(true);
      const message = {
        messageId: 'field-direct-result',
        data: {
          text: 'source',
          mode: 'field',
          provider: 'openai',
          sessionId: 'field-direct-result',
          conversationParents: [{ parentId: 'g1', cleanSource: 'source' }],
        },
        context: 'content',
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'field' };
      translationRequestTracker.createRequest.mockReturnValue(request);
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'translated' });
      const activate = vi.spyOn(service.conversationAcceptanceCoordinator, 'activate');
      const remove = vi.spyOn(service.conversationAcceptanceCoordinator, 'remove');

      await service.handleTranslationRequest(message);

      expect(activate).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).toBeNull();
    });

    it('records OPERATION_FAILED with reason and code when the tracker transition is FAILED', async () => {
      const message = {
        messageId: 'm-fail',
        data: { text: 'hello', mode: 'selection' },
        context: 'content'
      };

      const mockRequest = { messageId: 'm-fail', data: message.data };
      translationRequestTracker.createRequest.mockReturnValue(mockRequest);
      translationRequestTracker.completeRequest.mockReturnValue({ accepted: true, status: 'failed' });

      service.modeCoordinator.processRequest.mockResolvedValue({
        success: false,
        error: { type: 'API_ERROR', message: 'Provider rejected request' }
      });

      await service.handleTranslationRequest(message);

      const calls = finalizeTranslationOperation.mock.results;
      const report = calls[calls.length - 1].value;
      expect(report).toBeTruthy();
      const terminal = report.entries[report.entries.length - 1];
      expect(terminal.type).toBe('OPERATION_FAILED');
      expect(terminal.reason).toBe('Provider rejected request');
      expect(terminal.code).toBe('API_ERROR');
    });

    it('records OPERATION_COMPLETED when the tracker transition is COMPLETED', async () => {
      const message = {
        messageId: 'm-ok',
        data: { text: 'hello', mode: 'selection' },
        context: 'content'
      };

      const mockRequest = { messageId: 'm-ok', data: message.data };
      translationRequestTracker.createRequest.mockReturnValue(mockRequest);

      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'bonjour' });

      await service.handleTranslationRequest(message);

      const calls = finalizeTranslationOperation.mock.results;
      const report = calls[calls.length - 1].value;
      expect(report).toBeTruthy();
      const terminal = report.entries[report.entries.length - 1];
      expect(terminal.type).toBe('OPERATION_COMPLETED');
      const { statsManager } = await import('../../../features/translation/core/TranslationStatsManager.js');
      expect(statsManager.recordOperationQuality).toHaveBeenCalledTimes(1);
    });

    it('suppresses a late success result when cancellation already won', async () => {
      const message = { messageId: 'm-cancelled', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      const request = { messageId: 'm-cancelled', data: message.data, mode: 'selection' };
      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.completeRequest.mockReturnValue({ accepted: false, status: 'cancelled', reason: 'already_terminal' });
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'bonjour' });

      const result = await service.handleTranslationRequest(message);

      expect(result).toMatchObject({ success: false, cancelled: true });
      expect(service.resultDispatcher.dispatchResult).not.toHaveBeenCalled();
    });

    it('returns a delivery failure without changing accepted completion', async () => {
      const message = {
        messageId: 'm-dispatch',
        data: {
          text: 'hello', mode: 'select-element', provider: 'openai', sessionId: 'dispatch-session',
          conversationParents: [{ parentId: 'g1', cleanSource: 'hello' }],
        },
        context: 'select-element',
      };
      const request = { messageId: 'm-dispatch', data: message.data, mode: 'select-element' };
      translationRequestTracker.createRequest.mockReturnValue(request);
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'bonjour' });
      let registeredHandle;
      service.resultDispatcher.dispatchResult.mockImplementation(async () => {
        registeredHandle = service.conversationAcceptanceCoordinator.lookup(message.messageId);
        throw new Error('delivery failed');
      });

      const result = await service.handleTranslationRequest(message);
      const handle = service.conversationAcceptanceCoordinator.lookup(message.messageId);

      expect(result).toMatchObject({ success: false, error: 'delivery failed' });
      expect(handle).toBeNull();
      expect(registeredHandle.snapshot().state).toBe('DISPOSED');
      expect(translationRequestTracker.failRequest).not.toHaveBeenCalled();
      expect(translationRequestTracker.completeRequest).toHaveBeenCalledTimes(1);
    });

    it('does not mutate a frozen provider result while normalizing transport metadata', async () => {
      const message = {
        messageId: 'm-frozen-result',
        data: { text: 'hello', mode: 'selection' },
        context: 'content',
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'selection' };
      const providerResult = Object.freeze({
        success: true,
        translatedText: 'bonjour',
        conversationAcceptance: false,
      });
      translationRequestTracker.createRequest.mockReturnValue(request);
      service.modeCoordinator.processRequest.mockResolvedValue(providerResult);

      const result = await service.handleTranslationRequest(message);

      expect(result).not.toBe(providerResult);
      expect(result).not.toHaveProperty('conversationAcceptance');
      expect(providerResult.conversationAcceptance).toBe(false);
      expect(service.resultDispatcher.dispatchResult).toHaveBeenCalledWith(expect.objectContaining({
        result: expect.not.objectContaining({ conversationAcceptance: expect.anything() }),
      }));
    });

    it('does not fail a request when registration itself throws', async () => {
      const message = { messageId: 'm-setup', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      translationRequestTracker.createRequest.mockImplementation(() => { throw new Error('setup failed') });

      const result = await service.handleTranslationRequest(message);

      expect(result).toMatchObject({ success: false, error: 'setup failed' });
      expect(translationRequestTracker.failRequest).not.toHaveBeenCalled();
    });

    it('fails an active tracked request when post-registration setup fails before execution', async () => {
      const message = { messageId: 'm-tracked-setup', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      translationRequestTracker.createRequest.mockReturnValue({});
      translationRequestTracker.isRequestActive.mockReturnValue(true);

      const result = await service.handleTranslationRequest(message);

      expect(result).toMatchObject({ success: false, error: 'Translation request registration failed' });
      expect(translationRequestTracker.failRequest).toHaveBeenCalledTimes(1);
      expect(service.modeCoordinator.processRequest).not.toHaveBeenCalled();
    });

    it('suppresses a late failure when cancellation already won', async () => {
      const message = { messageId: 'm-cancelled', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      translationRequestTracker.createRequest.mockReturnValue({ messageId: 'm-cancelled', data: message.data, mode: 'selection' });
      translationRequestTracker.failRequest.mockReturnValue({ accepted: false, status: 'cancelled', reason: 'already_terminal' });
      service.modeCoordinator.processRequest.mockRejectedValue(new Error('late failure'));

      const result = await service.handleTranslationRequest(message);

      expect(result).toMatchObject({ success: false, cancelled: true });
      expect(service.resultDispatcher.dispatchResult).not.toHaveBeenCalled();
    });

    it('rethrows ordinary preparation errors after failing and finalizing the early record', async () => {
      const { getSelectionMaxCharsAsync } = await import('../../../shared/config/config.js');
      const preparationError = new Error('settings unavailable');
      getSelectionMaxCharsAsync.mockRejectedValueOnce(preparationError);
      const request = { messageId: 'settings-error', data: { text: 'hello', mode: 'selection' }, status: 'pending' };
      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.isRequestActive.mockReturnValue(true);

      await expect(service.handleTranslationRequest({
        messageId: request.messageId,
        data: request.data,
        context: 'content',
      })).rejects.toBe(preparationError);

      expect(translationRequestTracker.failRequest).toHaveBeenCalledWith(request.messageId, preparationError);
      expect(finalizeTranslationOperation).toHaveBeenCalledTimes(1);
      expect(service.modeCoordinator.processRequest).not.toHaveBeenCalled();
    });

    it('registers the request and operation before the first eligibility await', async () => {
      let releaseEligibility;
      let enteredEligibility;
      const eligibilityStarted = new Promise(resolve => { enteredEligibility = resolve; });
      isEligibleForDictionaryUpgrade.mockImplementationOnce(() => {
        enteredEligibility();
        return new Promise(resolve => { releaseEligibility = resolve; });
      });
      const message = { messageId: 'first-await-cancel', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      const request = { messageId: message.messageId, data: message.data, mode: 'selection', status: 'pending' };
      let terminalStatus = null;
      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.getRequest.mockReturnValueOnce(null).mockReturnValue(request);
      translationRequestTracker.isRequestActive.mockImplementation(() => terminalStatus === null);
      translationRequestTracker.cancelRequest.mockImplementation(() => {
        terminalStatus = 'cancelled';
        request.status = terminalStatus;
        return { accepted: true, status: terminalStatus, request };
      });
      const providerResolution = vi.spyOn(service, '_resolveEffectiveProvider');

      const pending = service.handleTranslationRequest(message);
      await eligibilityStarted;
      expect(translationRequestTracker.createRequest).toHaveBeenCalledTimes(1);
      expect(service._getOperation(request)).not.toBeNull();
      await service.cancelRequest(message.messageId);
      releaseEligibility(false);

      await expect(pending).resolves.toMatchObject({ success: false, cancelled: true });
      expect(providerResolution).not.toHaveBeenCalled();
      expect(configuration.getModeProvidersAsync).not.toHaveBeenCalled();
      expect(service.modeCoordinator.processRequest).not.toHaveBeenCalled();
      expect(finalizeTranslationOperation).toHaveBeenCalledTimes(1);
    });

    it.each(['resolve', 'reject'])('suppresses late character-limit lookup %s after cancellation', async settlement => {
      const { getSelectionMaxCharsAsync } = await import('../../../shared/config/config.js');
      let settleLimit;
      getSelectionMaxCharsAsync.mockReturnValueOnce(new Promise((resolve, reject) => {
        settleLimit = value => settlement === 'resolve' ? resolve(value) : reject(value);
      }));
      const message = { messageId: `limit-race-${settlement}`, data: { text: 'hello', mode: 'selection' }, context: 'content' };
      const request = { messageId: message.messageId, data: message.data, mode: 'selection', status: 'pending' };
      let terminalStatus = null;
      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.getRequest.mockReturnValueOnce(null).mockReturnValue(request);
      translationRequestTracker.isRequestActive.mockImplementation(() => terminalStatus === null);
      translationRequestTracker.cancelRequest.mockImplementation(() => {
        terminalStatus = 'cancelled';
        request.status = terminalStatus;
        return { accepted: true, status: terminalStatus, request };
      });

      const pending = service.handleTranslationRequest(message);
      await vi.waitFor(() => expect(getSelectionMaxCharsAsync).toHaveBeenCalledTimes(1));
      await service.cancelRequest(message.messageId);
      settleLimit(settlement === 'reject' ? new Error('late limit failure') : 5000);

      await expect(pending).resolves.toMatchObject({ success: false, cancelled: true });
      expect(service.modeCoordinator.processRequest).not.toHaveBeenCalled();
      expect(finalizeTranslationOperation).toHaveBeenCalledTimes(1);
    });

    it('copies resolved provider to the input, tracked data and metadata before execution', async () => {
      const { getModeProvidersAsync } = await import('../../../shared/config/config.js');
      getModeProvidersAsync.mockResolvedValueOnce({ selection: 'resolved-provider' });
      const data = { text: 'hello', mode: 'selection' };
      const request = { messageId: 'provider-copy', data: { ...data }, metadata: {}, mode: 'selection' };
      translationRequestTracker.createRequest.mockReturnValue(request);
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true });

      await service.handleTranslationRequest({ messageId: request.messageId, data, context: 'content' });

      expect(data.provider).toBe('resolved-provider');
      expect(request.data.provider).toBe('resolved-provider');
      expect(request.metadata.provider).toBe('resolved-provider');
    });

    it('does not replace or finalize an admitted request on a duplicate during preparation', async () => {
      const { getModeProvidersAsync } = await import('../../../shared/config/config.js');
      let releaseProviderLookup;
      getModeProvidersAsync.mockReturnValueOnce(new Promise(resolve => { releaseProviderLookup = resolve; }));
      const message = { messageId: 'duplicate-during-preparation', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      const request = { messageId: message.messageId, data: message.data, status: 'pending' };
      translationRequestTracker.getRequest.mockReturnValueOnce(null).mockReturnValue(request);
      translationRequestTracker.isRequestActive.mockReturnValue(true);
      translationRequestTracker.createRequest.mockReturnValue(request);
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true });

      const first = service.handleTranslationRequest(message);
      await vi.waitFor(() => expect(getModeProvidersAsync).toHaveBeenCalled());
      const duplicate = await service.handleTranslationRequest(message);
      expect(duplicate).toMatchObject({ success: false, error: 'Request already processing' });
      expect(translationRequestTracker.createRequest).toHaveBeenCalledTimes(1);
      expect(finalizeTranslationOperation).not.toHaveBeenCalled();

      releaseProviderLookup({});
      await expect(first).resolves.toMatchObject({ success: true });
      expect(translationRequestTracker.createRequest).toHaveBeenCalledTimes(1);
      expect(finalizeTranslationOperation).toHaveBeenCalledTimes(1);
    });

    it('marks a canonical provider timeout as TIMEOUT and records OPERATION_TIMEOUT', async () => {
      const message = { messageId: 'm-provider-timeout', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      translationRequestTracker.createRequest.mockReturnValue({ messageId: message.messageId, data: message.data, mode: 'selection' });
      const timeout = Object.assign(new Error('Batch translation timed out'), {
        type: ErrorTypes.TRANSLATION_TIMEOUT
      });
      service.modeCoordinator.processRequest.mockRejectedValue(timeout);

      await service.handleTranslationRequest(message);

      expect(translationRequestTracker.markTimeout).toHaveBeenCalledWith(message.messageId);
      expect(translationRequestTracker.failRequest).not.toHaveBeenCalled();
      const report = finalizeTranslationOperation.mock.results.at(-1).value;
      expect(report.entries.at(-1).type).toBe('OPERATION_TIMEOUT');
    });

    it('preserves timeout when late completion is rejected', async () => {
      const message = { messageId: 'm-timeout', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      translationRequestTracker.createRequest.mockReturnValue({ messageId: 'm-timeout', data: message.data, mode: 'selection' });
      translationRequestTracker.completeRequest.mockReturnValue({ accepted: false, status: 'timeout', reason: 'already_terminal' });
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true });

      const result = await service.handleTranslationRequest(message);

      expect(result).toMatchObject({ success: false, timedOut: true });
      expect(result.error.type).not.toBe(ErrorTypes.USER_CANCELLED);
      expect(service.resultDispatcher.dispatchResult).not.toHaveBeenCalled();
    });

    it('suppresses duplicate and missing terminal completion without fabricating cancellation', async () => {
      const message = { messageId: 'm-duplicate', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      translationRequestTracker.createRequest.mockReturnValue({ messageId: 'm-duplicate', data: message.data, mode: 'selection' });
      translationRequestTracker.completeRequest.mockReturnValueOnce({ accepted: false, status: 'completed', reason: 'already_terminal' });
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true });

      const duplicate = await service.handleTranslationRequest(message);
      expect(duplicate).toMatchObject({ success: false, suppressed: true, status: 'completed' });

      translationRequestTracker.completeRequest.mockReturnValueOnce({ accepted: false, status: null, reason: 'not_found' });
      const missing = await service.handleTranslationRequest(message);
      expect(missing).toMatchObject({ success: false, suppressed: true, status: null });
    });

    it('should handle Field mode with direct return', async () => {
      const message = {
        messageId: 'm-field',
        data: { text: 'test', mode: 'field' },
        context: 'content'
      };

      const mockRequest = { messageId: 'm-field', data: message.data, mode: 'field' };
      translationRequestTracker.createRequest.mockReturnValue(mockRequest);
      
      const expectedResult = { success: true, translatedText: 'TEST' };
      service.modeCoordinator.processRequest.mockResolvedValue(expectedResult);

      const result = await service.handleTranslationRequest(message);

      expect(result).toBe(expectedResult);
      expect(service.resultDispatcher.dispatchResult).not.toHaveBeenCalled();
    });

    it('should block duplicate active requests', async () => {
      const message = { messageId: 'm1', data: { text: 'hi' } };
      translationRequestTracker.getRequest.mockReturnValue({ messageId: 'm1' });
      translationRequestTracker.isRequestActive.mockReturnValue(true);

      const result = await service.handleTranslationRequest(message);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Request already processing');
    });

    it('should reject reuse of retained terminal request IDs', async () => {
      const message = { messageId: 'm1', data: { text: 'hi' } };
      translationRequestTracker.getRequest.mockReturnValue({ messageId: 'm1', status: 'completed' });
      translationRequestTracker.isRequestActive.mockReturnValue(false);

      const result = await service.handleTranslationRequest(message);

      expect(result).toMatchObject({ success: false, error: 'Request messageId already exists' });
      expect(translationRequestTracker.createRequest).not.toHaveBeenCalled();
    });

    it('should fallback to globalThis.backgroundService if not initialized', async () => {
      const s2 = new UnifiedTranslationService();
      translationRequestTracker.getRequest.mockReturnValue(null);
      translationRequestTracker.createRequest.mockReturnValue({ mode: 'selection' });
      s2.modeCoordinator.processRequest.mockResolvedValue({ success: true });

      await s2.handleTranslationRequest({ messageId: 'm1', data: { text: 'hi' } });
      expect(s2.translationEngine).toBe(globalThis.backgroundService.translationEngine);
    });

    it('should log session stats for successful non-field requests', async () => {
      const { statsManager } = await import('../../../features/translation/core/TranslationStatsManager.js');
      const message = { messageId: 'm1', data: { text: 'hi', mode: 'selection' }, context: 'content' };
      translationRequestTracker.createRequest.mockReturnValue({ messageId: 'm1', mode: 'selection' });
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true });

      await service.handleTranslationRequest(message);
      expect(statsManager.printSummary).toHaveBeenCalledWith('m1', expect.objectContaining({ status: 'Session' }));
    });

    it('should log batch stats for Page mode', async () => {
      const { statsManager } = await import('../../../features/translation/core/TranslationStatsManager.js');
      const message = { messageId: 'm1', data: { text: 'hi', mode: 'page' }, context: 'content' };
      translationRequestTracker.createRequest.mockReturnValue({ messageId: 'm1', mode: 'page' });
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, actualCharCount: 10 });

      await service.handleTranslationRequest(message);
      expect(statsManager.printSummary).toHaveBeenCalledWith('m1', expect.objectContaining({ status: 'Batch' }));
    });

    it('should treat PDF mode as a dedicated structured translation mode', async () => {
      const message = {
        messageId: 'm-pdf',
        data: { text: JSON.stringify([{ blockId: 'b1', text: 'hello' }]), mode: 'pdf-translation' },
        context: 'pdf-translation'
      };

      const mockRequest = { messageId: 'm-pdf', data: message.data, mode: 'pdf-translation' };
      translationRequestTracker.createRequest.mockReturnValue(mockRequest);
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: '[]' });

      const result = await service.handleTranslationRequest(message);

      expect(result.success).toBe(true);
      expect(service.modeCoordinator.processRequest).toHaveBeenCalledWith(mockRequest, expect.any(Object));
    });

    it('does not start execution after cancellation wins during setup', async () => {
      let releaseParticipation;
      const participation = new Promise(resolve => { releaseParticipation = resolve; });
      const participationSpy = vi.spyOn(AIConversationHelper, 'getConversationParticipation')
        .mockReturnValue(participation);
      const message = {
        messageId: 'm-setup-cancelled',
        data: { text: 'hello', mode: 'selection', provider: 'google' },
        context: 'content'
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'selection' };
      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.isRequestActive.mockReturnValue(false);

      try {
        const requestPromise = service.handleTranslationRequest(message);
        releaseParticipation(false);
        const result = await requestPromise;

        expect(result).toMatchObject({ success: false, suppressed: true, reason: 'already_terminal' });
        expect(service.modeCoordinator.processRequest).not.toHaveBeenCalled();
      } finally {
        participationSpy.mockRestore();
      }
    });

    it('sees the attached operation when cancellation wins during setup', async () => {
      let releaseParticipation;
      const participation = new Promise(resolve => { releaseParticipation = resolve; });
      const participationSpy = vi.spyOn(AIConversationHelper, 'getConversationParticipation')
        .mockReturnValue(participation);
      const message = {
        messageId: 'm-setup-cancelled-owned',
        data: { text: 'hello', mode: 'selection', provider: 'google' },
        context: 'content'
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'selection' };
      let terminalStatus = null;
      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.getRequest
        .mockReturnValueOnce(null)
        .mockImplementation(() => request);
      translationRequestTracker.isRequestActive.mockImplementation(() => terminalStatus === null);
      translationRequestTracker.cancelRequest.mockImplementation(() => {
        terminalStatus = 'cancelled';
        request.status = terminalStatus;
        return { accepted: true, status: terminalStatus, request };
      });

      try {
        const pending = service.handleTranslationRequest(message);
        await vi.waitFor(() => expect(participationSpy).toHaveBeenCalledTimes(1));

        await expect(service.cancelRequest(message.messageId, ActionReasons.USER_CANCELLED))
          .resolves.toMatchObject({ handled: true, success: true });

        releaseParticipation(false);
        const result = await pending;

        expect(result).toMatchObject({ success: false, cancelled: true });
        expect(service.modeCoordinator.processRequest).not.toHaveBeenCalled();
        expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).toBeNull();
        expect(finalizeTranslationOperation).toHaveBeenCalledTimes(1);
        expect(TerminalExecutionRouter.routeTerminalExecution).toHaveBeenCalledWith(
          expect.any(Object),
          { status: 'cancelled' },
        );
      } finally {
        participationSpy.mockRestore();
      }
    });

    it('does not start execution after timeout wins during setup', async () => {
      let releaseParticipation;
      const participation = new Promise(resolve => { releaseParticipation = resolve; });
      const participationSpy = vi.spyOn(AIConversationHelper, 'getConversationParticipation')
        .mockReturnValue(participation);
      const message = {
        messageId: 'm-setup-timeout',
        data: { text: 'hello', mode: 'selection', provider: 'google' },
        context: 'content'
      };
      const request = { messageId: message.messageId, data: message.data, mode: 'selection' };
      let terminalStatus = null;
      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.getRequest
        .mockReturnValueOnce(null)
        .mockImplementation(() => request);
      translationRequestTracker.isRequestActive.mockImplementation(() => terminalStatus === null);
      translationRequestTracker.markTimeout.mockImplementation(() => {
        terminalStatus = 'timeout';
        request.status = terminalStatus;
        return { accepted: true, status: terminalStatus, request };
      });

      try {
        const pending = service.handleTranslationRequest(message);
        await vi.waitFor(() => expect(participationSpy).toHaveBeenCalledTimes(1));

        await expect(service.handleTimeout(
          message.messageId,
          'No progress',
          ErrorTypes.PROGRESS_TIMEOUT,
        )).resolves.toEqual({ handled: true, success: true });

        releaseParticipation(false);
        const result = await pending;

        expect(result).toMatchObject({ success: false, timedOut: true });
        expect(service.modeCoordinator.processRequest).not.toHaveBeenCalled();
        expect(service.conversationAcceptanceCoordinator.lookup(message.messageId)).toBeNull();
        expect(mockEngine.cancelTranslation).toHaveBeenCalledWith(
          message.messageId,
          true,
          ErrorTypes.PROGRESS_TIMEOUT,
          'No progress',
        );
        const report = finalizeTranslationOperation.mock.results.at(-1).value;
        expect(report.entries.at(-1).type).toBe('OPERATION_TIMEOUT');
      } finally {
        participationSpy.mockRestore();
      }
    });

    it.each([
      ['success', false],
      ['error', true],
    ])('publishes only cancellation winner when late stream %s settles', async (lateOutcome, isError) => {
      const messageId = `m-stream-cancel-race-${lateOutcome}`;
      const message = {
        messageId,
        data: {
          text: JSON.stringify([{ i: 'n1', t: 'Hello' }]),
          mode: 'select-element',
          provider: 'google',
          options: { rawJsonPayload: true },
        },
        context: 'select-element'
      };
      const sender = { tab: { id: 7 }, frameId: 3 };
      const request = { messageId, data: message.data, mode: 'select-element', sender };
      let terminalStatus = null;
      let settleExecution;

      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.getRequest
        .mockReturnValueOnce(null)
        .mockReturnValue(request);
      translationRequestTracker.isRequestActive.mockImplementation(() => terminalStatus === null);
      const acceptTerminal = status => {
        if (terminalStatus) return { accepted: false, status: terminalStatus, reason: 'already_terminal' };
        terminalStatus = status;
        request.status = status;
        return { accepted: true, status, request };
      };
      translationRequestTracker.cancelRequest.mockImplementation(() => acceptTerminal('cancelled'));
      translationRequestTracker.completeRequest.mockImplementation((_id, result) => acceptTerminal(result?.success === true ? 'completed' : 'failed'));
      translationRequestTracker.failRequest.mockImplementation(() => acceptTerminal('failed'));
      streamingManagerMock.getStreamInfo.mockReturnValue({ providerName: 'Google', processedSegments: 0 });
      service.modeCoordinator.processRequest.mockReturnValue(new Promise((resolve, reject) => {
        settleExecution = value => isError ? reject(value) : resolve(value);
      }));

      const inFlight = service.handleTranslationRequest(message, sender);
      await vi.waitFor(() => expect(service.modeCoordinator.processRequest).toHaveBeenCalledTimes(1));
      await service.cancelRequest(messageId, 'user_cancelled');
      settleExecution(isError ? new Error('late stream failure') : { success: true, translatedText: 'late' });
      const result = await inFlight;

      expect(result).toMatchObject({ success: false, cancelled: true });
      expect(streamingManagerMock.completeStream).toHaveBeenCalledTimes(1);
      expect(streamingManagerMock.completeStream).toHaveBeenCalledWith(
        messageId,
        false,
        expect.objectContaining({ cancelled: true, reason: 'user_cancelled' }),
      );
    });

    it.each([
      ['success', false],
      ['error', true],
    ])('publishes only timeout winner when late stream %s settles', async (lateOutcome, isError) => {
      const messageId = `m-stream-timeout-race-${lateOutcome}`;
      const message = {
        messageId,
        data: {
          text: JSON.stringify([{ i: 'n1', t: 'Hello' }]),
          mode: 'select-element',
          provider: 'google',
          options: { rawJsonPayload: true },
        },
        context: 'select-element'
      };
      const sender = { tab: { id: 8 }, frameId: 4 };
      const request = { messageId, data: message.data, mode: 'select-element', sender };
      let terminalStatus = null;
      let settleExecution;

      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.getRequest
        .mockReturnValueOnce(null)
        .mockReturnValue(request);
      translationRequestTracker.isRequestActive.mockImplementation(() => terminalStatus === null);
      const acceptTerminal = status => {
        if (terminalStatus) return { accepted: false, status: terminalStatus, reason: 'already_terminal' };
        terminalStatus = status;
        request.status = status;
        return { accepted: true, status, request };
      };
      translationRequestTracker.markTimeout.mockImplementation(() => acceptTerminal('timeout'));
      translationRequestTracker.completeRequest.mockImplementation((_id, result) => acceptTerminal(result?.success === true ? 'completed' : 'failed'));
      translationRequestTracker.failRequest.mockImplementation(() => acceptTerminal('failed'));
      streamingManagerMock.getStreamInfo.mockReturnValue({ providerName: 'Google', processedSegments: 0 });
      service.modeCoordinator.processRequest.mockReturnValue(new Promise((resolve, reject) => {
        settleExecution = value => isError ? reject(value) : resolve(value);
      }));

      const inFlight = service.handleTranslationRequest(message, sender);
      await vi.waitFor(() => expect(service.modeCoordinator.processRequest).toHaveBeenCalledTimes(1));
      await service.handleTimeout(messageId, 'No progress', ErrorTypes.PROGRESS_TIMEOUT);
      settleExecution(isError ? new Error('late stream failure') : { success: true, translatedText: 'late' });
      const result = await inFlight;

      expect(result).toMatchObject({ success: false, timedOut: true });
      expect(streamingManagerMock.completeStream).toHaveBeenCalledTimes(1);
      expect(streamingManagerMock.completeStream).toHaveBeenCalledWith(
        messageId,
        false,
        expect.objectContaining({
          timedOut: true,
          cancelled: false,
          timeoutType: ErrorTypes.PROGRESS_TIMEOUT,
        }),
      );
    });

    it('owns structured stream terminal publication after accepted completion', async () => {
      const message = {
        messageId: 'm-structured-stream',
        data: {
          text: JSON.stringify([{ i: 'n1', t: 'Hello' }]),
          mode: 'select-element',
          provider: 'google',
          sessionId: 'session-1',
          options: { rawJsonPayload: true },
        },
        context: 'select-element'
      };
      const sender = { tab: { id: 7 }, frameId: 3 };
      const request = {
        messageId: message.messageId,
        data: message.data,
        mode: 'select-element',
        sender,
        sessionId: 'session-1',
      };
      translationRequestTracker.createRequest.mockReturnValue(request);
      streamingManagerMock.getStreamInfo.mockReturnValue({
        providerName: 'Google',
        processedSegments: 0,
      });
      service.modeCoordinator.processRequest.mockResolvedValue({
        success: true,
        streaming: true,
        results: [{ i: 'n1', t: 'Bonjour' }],
      });

      await service.handleTranslationRequest(message, sender);

      expect(streamingManagerMock.initializeStream).toHaveBeenCalledWith(
        message.messageId,
        sender,
        expect.objectContaining({ providerName: expect.any(String) }),
        [{ i: 'n1', t: 'Hello' }],
        'session-1',
        false,
      );
      expect(streamingManagerMock.completeStream).toHaveBeenCalledWith(
        message.messageId,
        true,
        expect.objectContaining({
          translationMode: 'select-element',
          processedSegments: 1,
        }),
      );
    });

    it('forwards timeout subtype through service-owned stream completion', async () => {
      const messageId = 'm-service-timeout';
      const request = { messageId, mode: 'select-element', data: { mode: 'select-element' } };
      translationRequestTracker.getRequest.mockReturnValue(request);
      translationRequestTracker.markTimeout.mockReturnValue({ accepted: true, status: 'timeout' });
      streamingManagerMock.getStreamInfo.mockReturnValue({ providerName: 'Google', processedSegments: 1 });

      await service.handleTimeout(messageId, 'No progress', ErrorTypes.PROGRESS_TIMEOUT);

      expect(streamingManagerMock.completeStream).toHaveBeenCalledWith(
        messageId,
        false,
        expect.objectContaining({
          timedOut: true,
          timeoutType: ErrorTypes.PROGRESS_TIMEOUT,
          errorDetails: expect.objectContaining({ message: 'No progress' }),
        }),
      );
    });

    it('passes the exact manifest instance to TranslationOperation', async () => {
      const message = { messageId: 'm-manifest', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      translationRequestTracker.createRequest.mockReturnValue({ messageId: 'm-manifest', data: message.data, mode: 'selection' });
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'bonjour' });

      await service.handleTranslationRequest(message);

      const manifest = createRequestUnitManifest.mock.results[0].value;
      expect(createTranslationOperation).toHaveBeenCalledWith('m-manifest', manifest);
    });

    it('invokes the router once for an accepted completion', async () => {
      const message = { messageId: 'm-route', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      translationRequestTracker.createRequest.mockReturnValue({ messageId: 'm-route', data: message.data, mode: 'selection' });
      translationRequestTracker.completeRequest.mockReturnValue({ accepted: true, status: 'completed' });
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'bonjour' });

      await service.handleTranslationRequest(message);

      expect(TerminalExecutionRouter.routeTerminalExecution).toHaveBeenCalledTimes(1);
      expect(TerminalExecutionRouter.routeTerminalExecution).toHaveBeenCalledWith(expect.any(Object), { status: 'completed' });
    });

    it('never invokes the router when completion is rejected', async () => {
      const message = { messageId: 'm-rejected', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      translationRequestTracker.createRequest.mockReturnValue({ messageId: 'm-rejected', data: message.data, mode: 'selection' });
      translationRequestTracker.completeRequest.mockReturnValue({ accepted: false, status: 'cancelled', reason: 'already_terminal' });
      service.modeCoordinator.processRequest.mockResolvedValue({ success: true, translatedText: 'bonjour' });

      const result = await service.handleTranslationRequest(message);

      expect(result).toMatchObject({ success: false, cancelled: true });
      expect(TerminalExecutionRouter.routeTerminalExecution).not.toHaveBeenCalled();
    });
  });

  describe('_resolveEffectiveProvider', () => {
    it('should use provider from data if in UI context', async () => {
      const provider = await service._resolveEffectiveProvider({ provider: 'p1' }, 'popup');
      expect(provider).toBe('p1');
    });

    it('should use mode-specific provider if defined', async () => {
      const { getModeProvidersAsync } = await import('../../../shared/config/config.js');
      getModeProvidersAsync.mockResolvedValue({ selection: 'p-sel' });
      
      const provider = await service._resolveEffectiveProvider({ mode: 'selection' }, 'content');
      expect(provider).toBe('p-sel');
    });

    it('should fallback to default provider if mode-specific is "default"', async () => {
      const { getModeProvidersAsync, getTranslationApiAsync } = await import('../../../shared/config/config.js');
      getModeProvidersAsync.mockResolvedValue({ selection: 'default' });
      getTranslationApiAsync.mockResolvedValue('p-global');
      
      const provider = await service._resolveEffectiveProvider({ mode: 'selection' }, 'content');
      expect(provider).toBe('p-global');
    });
  });

  describe('cancelRequest', () => {
    it('should cancel active request', async () => {
      const mockRequest = { messageId: 'm1' };
      translationRequestTracker.getRequest.mockReturnValue(mockRequest);

      const result = await service.cancelRequest('m1');

      expect(result).toEqual({ handled: true, success: true });
      expect(translationRequestTracker.cancelRequest).toHaveBeenCalledWith('m1', ActionReasons.USER_CANCELLED);
       expect(mockEngine.cancelTranslation).toHaveBeenCalledWith('m1', false, undefined, ActionReasons.USER_CANCELLED);
      expect(service.resultDispatcher.dispatchCancellation).toHaveBeenCalled();
    });

    it('should return unhandled when request not found', async () => {
      translationRequestTracker.getRequest.mockReturnValue(null);

      const result = await service.cancelRequest('unknown');

      expect(result).toEqual({ handled: false, success: false, error: 'Request not found' });
    });

    it('reports handled-but-rejected cancellation without finalizing or dispatching', async () => {
      translationRequestTracker.getRequest.mockReturnValue({ messageId: 'm-rejected' });
      translationRequestTracker.cancelRequest.mockReturnValue({ accepted: false, status: 'completed', reason: 'already_terminal' });

      const result = await service.cancelRequest('m-rejected');

      expect(result).toEqual({ handled: true, success: false, error: 'already_terminal' });
      expect(finalizeTranslationOperation).not.toHaveBeenCalled();
      expect(service.resultDispatcher.dispatchCancellation).not.toHaveBeenCalled();
    });

    it('threads the supplied reason unchanged to the tracker', async () => {
      translationRequestTracker.getRequest.mockReturnValue({ messageId: 'm-reason' });

      await service.cancelRequest('m-reason', 'user-typed');

      expect(translationRequestTracker.cancelRequest).toHaveBeenCalledWith('m-reason', 'user-typed');
    });

    it('finalizes, aborts and dispatches exactly once on accepted cancellation', async () => {
      translationRequestTracker.getRequest.mockReturnValue({ messageId: 'm-finalize' });

      await service.cancelRequest('m-finalize');

      expect(finalizeTranslationOperation).toHaveBeenCalledTimes(1);
      expect(mockEngine.cancelTranslation).toHaveBeenCalledTimes(1);
      expect(service.resultDispatcher.dispatchCancellation).toHaveBeenCalledTimes(1);
    });

    it('routes the accepted cancellation to the router exactly once', async () => {
      translationRequestTracker.getRequest.mockReturnValue({ messageId: 'm-route-cancel' });

      await service.cancelRequest('m-route-cancel');

      expect(TerminalExecutionRouter.routeTerminalExecution).toHaveBeenCalledTimes(1);
      expect(TerminalExecutionRouter.routeTerminalExecution).toHaveBeenCalledWith(expect.any(Object), { status: 'cancelled' });
    });

    it('never routes when cancellation is rejected', async () => {
      translationRequestTracker.getRequest.mockReturnValue({ messageId: 'm-reject-cancel' });
      translationRequestTracker.cancelRequest.mockReturnValue({ accepted: false, status: 'completed', reason: 'already_terminal' });

      await service.cancelRequest('m-reject-cancel');

      expect(TerminalExecutionRouter.routeTerminalExecution).not.toHaveBeenCalled();
    });
  });

  describe('handleTimeout', () => {
    async function startTimedOutRequest(outcome) {
      const message = { messageId: 'm-timeout', data: { text: 'hello', mode: 'selection' }, context: 'content' };
      const request = { messageId: 'm-timeout', data: message.data, mode: 'selection' };
      let settle;
      const pending = new Promise((resolve, reject) => {
        settle = value => value instanceof Error ? reject(value) : resolve(value);
      });
      translationRequestTracker.getRequest
        .mockReturnValueOnce(null)
        .mockReturnValue(request);
      translationRequestTracker.createRequest.mockReturnValue(request);
      translationRequestTracker.completeRequest.mockReturnValue({ accepted: false, status: 'timeout', reason: 'already_terminal' });
      translationRequestTracker.failRequest.mockReturnValue({ accepted: false, status: 'timeout', reason: 'already_terminal' });
      service.modeCoordinator.processRequest.mockReturnValue(pending);

      const inFlight = service.handleTranslationRequest(message);
      await vi.waitFor(() => expect(service.modeCoordinator.processRequest).toHaveBeenCalledTimes(1));
      await service.handleTimeout('m-timeout');
      settle(outcome);
      return inFlight;
    }

    it('finalizes and cancels once after an accepted timeout', async () => {
      const request = { messageId: 'm-timeout' };
      translationRequestTracker.getRequest.mockReturnValue(request);
      service._setOperation(request, createTranslationOperation('m-timeout'));

      const result = await service.handleTimeout(
        'm-timeout',
        'Streaming translation timed out',
        'PROGRESS_TIMEOUT'
      );

      expect(result).toEqual({ handled: true, success: true });
      expect(translationRequestTracker.markTimeout).toHaveBeenCalledTimes(1);
      expect(finalizeTranslationOperation).toHaveBeenCalledTimes(1);
      expect(statsManager.recordOperationQuality).toHaveBeenCalledTimes(1);
      expect(service._getOperation(request)).toBeNull();
      expect(mockEngine.cancelTranslation).toHaveBeenCalledWith(
        'm-timeout',
        true,
        'PROGRESS_TIMEOUT',
        'Streaming translation timed out'
      );
      expect(TerminalExecutionRouter.routeTerminalExecution).toHaveBeenCalledWith(
        expect.any(Object),
        { status: 'timeout' },
      );
    });

    it('does no terminal work when timeout transition is rejected', async () => {
      translationRequestTracker.getRequest.mockReturnValue({ messageId: 'm-timeout' });
      translationRequestTracker.markTimeout.mockReturnValue({ accepted: false, status: 'completed', reason: 'already_terminal' });

      const result = await service.handleTimeout('m-timeout');

      expect(result).toEqual({ handled: true, success: false, error: 'already_terminal' });
      expect(finalizeTranslationOperation).not.toHaveBeenCalled();
      expect(statsManager.recordOperationQuality).not.toHaveBeenCalled();
      expect(mockEngine.cancelTranslation).not.toHaveBeenCalled();
    });

    it('finalizes only once when duplicate timeout is rejected', async () => {
      const request = { messageId: 'm-timeout' };
      translationRequestTracker.getRequest.mockReturnValue(request);
      translationRequestTracker.markTimeout
        .mockReturnValueOnce({ accepted: true, status: 'timeout' })
        .mockReturnValueOnce({ accepted: false, status: 'timeout', reason: 'already_terminal' });
      service._setOperation(request, createTranslationOperation('m-timeout'));

      await service.handleTimeout('m-timeout');
      await service.handleTimeout('m-timeout');

      expect(finalizeTranslationOperation).toHaveBeenCalledTimes(1);
      expect(statsManager.recordOperationQuality).toHaveBeenCalledTimes(1);
      expect(mockEngine.cancelTranslation).toHaveBeenCalledTimes(1);
    });

    it('records an incomplete recovery summary for timeout', async () => {
      const request = { messageId: 'm-timeout' };
      const operation = createTranslationOperation('m-timeout');
      operation.appendDiagnostic({ type: 'RECOVERY_TRIGGERED', provider: 'google' });
      translationRequestTracker.getRequest.mockReturnValue(request);
      service._setOperation(request, operation);

      await service.handleTimeout('m-timeout');

      expect(statsManager.recordOperationQuality).toHaveBeenCalledWith(expect.objectContaining({
        hadRecovery: true,
        finalRecoveryOutcome: 'INCOMPLETE',
      }));
    });

    it('does not aggregate again when success arrives after timeout', async () => {
      const result = await startTimedOutRequest({ success: true });

      expect(result).toMatchObject({ success: false, timedOut: true });
      expect(statsManager.recordOperationQuality).toHaveBeenCalledTimes(1);
    });

    it('does not aggregate again when failure arrives after timeout', async () => {
      const result = await startTimedOutRequest(new Error('late failure'));

      expect(result).toMatchObject({ success: false, timedOut: true });
      expect(statsManager.recordOperationQuality).toHaveBeenCalledTimes(1);
    });

    it('keeps timeout finalization when engine cancellation fails', async () => {
      const request = { messageId: 'm-timeout' };
      translationRequestTracker.getRequest.mockReturnValue(request);
      service._setOperation(request, createTranslationOperation('m-timeout'));
      mockEngine.cancelTranslation.mockRejectedValueOnce(new Error('abort failed'));

      await expect(service.handleTimeout('m-timeout')).resolves.toEqual({ handled: true, success: true });

      expect(finalizeTranslationOperation).toHaveBeenCalledTimes(1);
      expect(statsManager.recordOperationQuality).toHaveBeenCalledTimes(1);
      expect(service._getOperation(request)).toBeNull();
    });
  });

  describe('handleStreamingUpdate', () => {
    it('should forward update to dispatcher', async () => {
      const message = { messageId: 'm1', data: { chunk: '...' } };
      await service.handleStreamingUpdate(message);

      expect(service.resultDispatcher.dispatchStreamingUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'm1', data: message.data })
      );
    });
  });

  describe('cleanup', () => {
    it('should call tracker cleanup', () => {
      translationRequestTracker.cleanup.mockReturnValue(5);
      service.cleanup();
      expect(translationRequestTracker.cleanup).toHaveBeenCalled();
    });

    it('registers active expiry with the canonical timeout owner', async () => {
      const expiryHandler = translationRequestTracker.setActiveExpiryHandler.mock.calls.at(-1)[0];
      const request = { messageId: 'stale-service-request' };
      translationRequestTracker.getRequest.mockReturnValue(request);

      expiryHandler(request.messageId);
      await vi.waitFor(() => expect(translationRequestTracker.markTimeout).toHaveBeenCalledWith(request.messageId));

      expect(mockEngine.cancelTranslation).toHaveBeenCalledWith(
        request.messageId,
        true,
        ErrorTypes.FINAL_TIMEOUT,
        'Translation request expired',
      );
      expect(finalizeTranslationOperation).toHaveBeenCalledTimes(1);
    });
  });
});
