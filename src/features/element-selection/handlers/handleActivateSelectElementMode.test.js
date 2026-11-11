import { describe, it, expect, vi, beforeEach } from 'vitest';
import browser from 'webextension-polyfill';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';

// Mock webextension-polyfill
vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: {
      query: vi.fn(),
      sendMessage: vi.fn()
    },
    webNavigation: {
      getAllFrames: vi.fn()
    }
  }
}));

// Mock local dependencies
vi.mock('./selectElementStateManager.js', () => ({
  completeActivationAttempt: vi.fn(),
  compensateInvalidatedActivationAttempts: vi.fn(() => Promise.resolve([])),
  setStateForTab: vi.fn(),
  createActivationGeneration: vi.fn(() => 1),
  getActivationEpoch: vi.fn(() => 'epoch-1'),
  getActivationAttemptToken: vi.fn(() => ({})),
  getActiveSessionRevision: vi.fn(() => 0),
  getCurrentGeneration: vi.fn(() => undefined),
  getStateForTab: vi.fn(() => ({ active: false })),
  invalidateOlderActivationAttempts: vi.fn(() => []),
  invalidateRetainedSessionRecovery: vi.fn(),
  isActivationAttemptCurrent: vi.fn(() => true),
  isDeactivationPending: vi.fn(() => false),
  isRetainedSessionRecoveryCurrent: vi.fn(() => true),
  isStructurallyNonInjectableFrame: vi.fn(() => false),
  recordActivationAttemptFrames: vi.fn(),
  retainCompatibilityFrames: vi.fn(),
  registerParticipant: vi.fn(() => true),
  settleActivationAttemptFrame: vi.fn(),
}));

vi.mock('./handleDeactivateSelectElementMode.js', () => ({
  handleDeactivateSelectElementMode: vi.fn(),
}));

vi.mock('@/core/tabPermissions.js', () => ({
  tabPermissionChecker: {
    checkTabAccess: vi.fn()
  }
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: vi.fn(() => false),
    handleContextError: vi.fn()
  }
}));

vi.mock('@/shared/error-management/ErrorHandler.js');

vi.mock('../utils/activationError.js', () => ({
  getSelectElementActivationErrorMessage: vi.fn(() => Promise.resolve('Could not activate Select Element mode.')),
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('@/shared/messaging/core/MessageActions.js', () => ({
  MessageActions: {
    ACTIVATE_SELECT_ELEMENT_MODE: 'ACTIVATE_SELECT_ELEMENT_MODE',
    DEACTIVATE_SELECT_ELEMENT_MODE: 'DEACTIVATE_SELECT_ELEMENT_MODE'
  }
}));

vi.mock('@/shared/messaging/core/MessagingCore.js', () => ({
  MessagingContexts: { CONTENT: 'CONTENT' },
  MessageFormat: {
    create: vi.fn((action, data, context) => ({ action, data, context }))
  }
}));

import { handleActivateSelectElementMode } from './handleActivateSelectElementMode.js';
import { tabPermissionChecker } from '@/core/tabPermissions.js';
import {
  compensateInvalidatedActivationAttempts,
  createActivationGeneration,
  getActivationEpoch,
  getActivationAttemptToken,
  getActiveSessionRevision,
  getCurrentGeneration,
  getStateForTab,
  invalidateOlderActivationAttempts,
  invalidateRetainedSessionRecovery,
  isActivationAttemptCurrent,
  isDeactivationPending,
  isRetainedSessionRecoveryCurrent,
  isStructurallyNonInjectableFrame,
  recordActivationAttemptFrames,
  retainCompatibilityFrames,
  registerParticipant,
  setStateForTab,
  settleActivationAttemptFrame,
} from './selectElementStateManager.js';
import { handleDeactivateSelectElementMode } from './handleDeactivateSelectElementMode.js';

describe('handleActivateSelectElementMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createActivationGeneration.mockReturnValue(1);
    getActivationEpoch.mockReturnValue('epoch-1');
    getActivationAttemptToken.mockReturnValue({});
    getActiveSessionRevision.mockReturnValue(0);
    getCurrentGeneration.mockReturnValue(undefined);
    getStateForTab.mockReturnValue({ active: false });
    invalidateOlderActivationAttempts.mockReturnValue([]);
    invalidateRetainedSessionRecovery.mockReturnValue(true);
    isActivationAttemptCurrent.mockReturnValue(true);
    isDeactivationPending.mockReturnValue(false);
    isRetainedSessionRecoveryCurrent.mockReturnValue(true);
    isStructurallyNonInjectableFrame.mockReturnValue(false);
    compensateInvalidatedActivationAttempts.mockResolvedValue([]);
    recordActivationAttemptFrames.mockReturnValue(undefined);
    retainCompatibilityFrames.mockReturnValue(undefined);
    settleActivationAttemptFrame.mockReturnValue(undefined);
    registerParticipant.mockReturnValue(true);
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ isAccessible: true, isRestricted: false, fullUrl: 'https://example.com' });
    browser.webNavigation.getAllFrames.mockResolvedValue([{ frameId: 0 }]);
    browser.tabs.sendMessage.mockResolvedValue({
      success: true,
      activated: true,
      activationGeneration: 1,
      activationEpoch: 'epoch-1',
    });
    handleDeactivateSelectElementMode.mockResolvedValue({ success: true, tabId: 1, active: false });
  });

  it('should activate mode for a specific tab', async () => {
    const message = { data: { tabId: 1, active: true } };
    const response = await handleActivateSelectElementMode(message, {});

    expect(response.success).toBe(true);
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
      action: 'ACTIVATE_SELECT_ELEMENT_MODE',
      data: expect.objectContaining({ active: true })
    }), { frameId: 0 });
    expect(browser.tabs.sendMessage.mock.calls[0][1].data).not.toHaveProperty('activate');
    expect(browser.tabs.sendMessage.mock.calls[0][1].data.activationGeneration).toBe(1);
    expect(browser.tabs.sendMessage.mock.calls[0][1].data.activationEpoch).toBe('epoch-1');
    expect(setStateForTab).toHaveBeenCalledWith(1, true);
  });

  it('registers strict authority when content echoes epoch and generation', async () => {
    browser.tabs.sendMessage.mockImplementation(async (_tabId, contentMessage) => ({
      success: true,
      activated: true,
      activationEpoch: contentMessage.data.activationEpoch,
      activationGeneration: contentMessage.data.activationGeneration,
    }));

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    expect(response).toMatchObject({ success: true, activated: true });
    expect(registerParticipant).toHaveBeenCalledWith(1, 0, 1);
    expect(setStateForTab).toHaveBeenCalledWith(1, true);
  });

  it('R5 uses current epoch and generation for retained-session re-authorization', async () => {
    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    expect(response).toMatchObject({ success: true, activated: true });
    expect(browser.tabs.sendMessage.mock.calls[0][1].data).toMatchObject({
      activationEpoch: 'epoch-1',
      activationGeneration: 1,
    });
    expect(browser.tabs.sendMessage.mock.calls[0][1].data).not.toHaveProperty('recoveryDeadlineAt');
  });

  it('recovery aborts when token invalidated before generation creation', async () => {
    let resolvePermission;
    tabPermissionChecker.checkTabAccess.mockReturnValue(new Promise(r => { resolvePermission = r; }));
    getActivationAttemptToken.mockReturnValue(undefined);
    isRetainedSessionRecoveryCurrent.mockReturnValue(true);
    const recoveryToken = 999;
    const promise = handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
      { recoveryToken, expectedRevision: 0, expectedGeneration: undefined },
    );
    await vi.waitFor(() => expect(tabPermissionChecker.checkTabAccess).toHaveBeenCalled());
    // Explicit deactivate invalidates recovery
    isRetainedSessionRecoveryCurrent.mockReturnValue(false);
    resolvePermission({ isAccessible: true, isRestricted: false, fullUrl: 'https://example.com' });
    const response = await promise;
    expect(response.success).toBe(false);
    expect(response.activated).toBe(false);
    expect(createActivationGeneration).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('explicit user activation invalidates retained recovery', async () => {
    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );
    expect(invalidateRetainedSessionRecovery).toHaveBeenCalledWith(1);
    expect(response.success).toBe(true);
  });

  it('recovery activation does not invalidate itself', async () => {
    getActivationAttemptToken.mockReturnValue(undefined);
    isRetainedSessionRecoveryCurrent.mockReturnValue(true);
    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
      { recoveryToken: 123, expectedRevision: 0, expectedGeneration: undefined },
    );
    expect(invalidateRetainedSessionRecovery).not.toHaveBeenCalled();
    expect(response.success).toBe(true);
  });

  it('rejects an activation ACK from a different epoch', async () => {
    browser.tabs.sendMessage.mockResolvedValue({
      success: true,
      activated: true,
      activationEpoch: 'old-epoch',
      activationGeneration: 1,
    });

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    expect(response.success).toBe(false);
    expect(registerParticipant).not.toHaveBeenCalled();
    expect(setStateForTab).not.toHaveBeenCalledWith(1, true);
  });

  it('should find active tab if no tabId provided', async () => {
    browser.tabs.query.mockResolvedValue([{ id: 2 }]);
    const message = { data: { active: true } };
    
    await handleActivateSelectElementMode(message, {});

    expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(2, expect.anything(), { frameId: 0 });
  });

  it('should handle permission check failures', async () => {
    tabPermissionChecker.checkTabAccess.mockResolvedValue({ 
      isAccessible: false, 
      errorMessage: 'Restricted page', 
      fullUrl: 'chrome://settings' 
    });
    
    const message = { data: { tabId: 3, active: true } };
    const response = await handleActivateSelectElementMode(message, {});

    expect(response.success).toBe(false);
    expect(response.isRestrictedPage).toBe(true);
    expect(response).not.toHaveProperty('errorDetails');
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('should handle communication errors with content script', async () => {
    browser.tabs.sendMessage.mockRejectedValue(new Error('Connection closed'));
    
    const message = { data: { tabId: 1, active: true } };
    const response = await handleActivateSelectElementMode(message, {});

    expect(response.success).toBe(false);
    expect(response.message).toContain('Failed to communicate');
    expect(response.errorDetails).toEqual({
      message: 'Could not activate Select Element mode.',
      type: ErrorTypes.SELECT_ELEMENT,
    });
  });

  it('settles a proven no-receiver frame without provisional cleanup debt', async () => {
    browser.webNavigation.getAllFrames.mockResolvedValue([{ frameId: 3 }]);
    browser.tabs.sendMessage.mockImplementation((_tabId, _message, { frameId }) => {
      if (frameId === 3) {
        return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
      }
      return Promise.resolve({ success: true, activated: true, activationGeneration: 1, activationEpoch: 'epoch-1' });
    });

    const response = await handleActivateSelectElementMode({ data: { tabId: 1, active: true } }, {});

    expect(response.success).toBe(true);
    expect(registerParticipant).toHaveBeenCalledWith(1, 0, 1);
    expect(settleActivationAttemptFrame).toHaveBeenCalledWith(1, 1, 3);
  });

  it('retains ambiguous delivery failures as provisional cleanup ownership', async () => {
    browser.tabs.sendMessage.mockRejectedValue(new Error('Connection closed'));

    await handleActivateSelectElementMode({ data: { tabId: 1, active: true } }, {});

    expect(settleActivationAttemptFrame).not.toHaveBeenCalled();
  });

  it('should handle legacy boolean responses (true)', async () => {
    browser.tabs.sendMessage.mockResolvedValue(true);
    
    const message = { data: { tabId: 1, active: true } };
    const response = await handleActivateSelectElementMode(message, {});

    expect(response.success).toBe(true);
    expect(setStateForTab).not.toHaveBeenCalledWith(1, true);
    expect(registerParticipant).not.toHaveBeenCalled();
    expect(retainCompatibilityFrames).toHaveBeenCalledWith(1, 1, [0]);
  });

  it('should not establish authority without a generation echo', async () => {
    browser.tabs.sendMessage.mockResolvedValue({ success: true, activated: true });

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    expect(response.success).toBe(true);
    expect(registerParticipant).not.toHaveBeenCalled();
    expect(setStateForTab).not.toHaveBeenCalledWith(1, true);
    expect(retainCompatibilityFrames).toHaveBeenCalledWith(1, 1, [0]);
  });

  it('should reject mismatched generation echoes without authority', async () => {
    browser.tabs.sendMessage.mockResolvedValue({
      success: true,
      activated: true,
      activationGeneration: 2,
    });

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    expect(response.success).toBe(false);
    expect(registerParticipant).not.toHaveBeenCalled();
    expect(setStateForTab).not.toHaveBeenCalledWith(1, true);
  });

  it('should reject generation-verified ACKs from invalidated activation attempts', async () => {
    isActivationAttemptCurrent.mockReturnValue(false);
    browser.tabs.sendMessage.mockResolvedValue({
      success: true,
      activated: true,
      activationGeneration: 1,
      activationEpoch: 'epoch-1',
    });

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    expect(response.success).toBe(false);
    expect(registerParticipant).not.toHaveBeenCalled();
    expect(setStateForTab).not.toHaveBeenCalledWith(1, true);
    expect(isActivationAttemptCurrent).toHaveBeenCalledWith(1, 1, expect.anything());
    expect(getActivationAttemptToken).toHaveBeenCalledWith(1);
  });

  it('tracks delivered frames provisionally and rejects their late ACKs', async () => {
    let resolveFrameThree;
    browser.webNavigation.getAllFrames.mockResolvedValue([{ frameId: 0 }, { frameId: 3 }]);
    browser.tabs.sendMessage.mockImplementation((_tabId, _message, { frameId }) => {
      if (frameId === 0) {
        return Promise.resolve({ success: true, activated: true, activationGeneration: 1, activationEpoch: 'epoch-1' });
      }
      return new Promise(resolve => {
        resolveFrameThree = resolve;
      });
    });

    const activation = handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );
    await vi.waitFor(() => expect(resolveFrameThree).toEqual(expect.any(Function)));

    expect(recordActivationAttemptFrames).toHaveBeenCalledWith(1, 1, [0]);
    expect(recordActivationAttemptFrames).toHaveBeenCalledWith(1, 1, [3]);
    isActivationAttemptCurrent.mockReturnValue(false);
    resolveFrameThree({ success: true, activated: true, activationGeneration: 1 });

    await expect(activation).resolves.toMatchObject({ success: false, activated: false });
    expect(registerParticipant).not.toHaveBeenCalled();
    expect(setStateForTab).not.toHaveBeenCalledWith(1, true);
  });

  it('allows newer activation after older attempt invalidation', async () => {
    let resolveFirstActivation;
    let invalidated = false;
    browser.tabs.sendMessage.mockImplementation((_tabId, message) => {
      if (message.data.activationGeneration === 1) {
        return new Promise(resolve => {
          resolveFirstActivation = resolve;
        });
      }
      return Promise.resolve({
        success: true,
        activated: true,
        activationGeneration: 2,
        activationEpoch: 'epoch-1',
      });
    });
    isActivationAttemptCurrent.mockImplementation((_tabId, generation) => (
      generation === 2 || (generation === 1 && !invalidated)
    ));
    createActivationGeneration.mockReturnValueOnce(1).mockReturnValueOnce(2);

    const firstActivation = handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );
    await vi.waitFor(() => expect(resolveFirstActivation).toEqual(expect.any(Function)));
    await handleActivateSelectElementMode({ data: { tabId: 1, active: false } }, {});
    invalidated = true;
    const secondActivation = handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    resolveFirstActivation({
      success: true,
      activated: true,
      activationGeneration: 1,
      activationEpoch: 'epoch-1',
    });

    const [firstResponse, secondResponse] = await Promise.all([firstActivation, secondActivation]);

    expect(firstResponse.success).toBe(false);
    expect(secondResponse.success).toBe(true);
    expect(registerParticipant).toHaveBeenCalledTimes(1);
    expect(registerParticipant).toHaveBeenCalledWith(1, 0, 2);
    expect(setStateForTab).toHaveBeenCalledWith(1, true);
  });

  it('should handle legacy boolean responses (false) on accessible pages', async () => {
    browser.tabs.sendMessage.mockResolvedValue(false);
    
    const message = { data: { tabId: 1, active: true } };
    const response = await handleActivateSelectElementMode(message, {});

    expect(response.success).toBe(false);
    expect(response.isLegacyResponse).toBe(true);
    expect(setStateForTab).not.toHaveBeenCalledWith(1, true);
  });

  it('should handle structured error response from content script', async () => {
    browser.tabs.sendMessage.mockResolvedValue({ 
      success: false, 
      error: 'Already active',
      errorType: 'MODEL_MISSING',
      isCompatibilityIssue: true 
    });
    
    const message = { data: { tabId: 1, active: true } };
    const response = await handleActivateSelectElementMode(message, {});

    expect(response.success).toBe(false);
    expect(response.message).toBe('Could not activate Select Element mode.');
    expect(response.error).toBe('Could not activate Select Element mode.');
    expect(response.isCompatibilityIssue).toBe(true);
    expect(response.errorType).toBe('MODEL_MISSING');
    expect(response.errorDetails).toEqual({
      message: 'Could not activate Select Element mode.',
      type: 'MODEL_MISSING',
    });
  });

  it('sanitizes unknown activation exceptions while retaining diagnostics in logs', async () => {
    const technicalMessage = 'Could not establish connection. Receiving end does not exist: INTERNAL_PORT_9f81';
    browser.tabs.query.mockRejectedValueOnce(new Error(technicalMessage));

    const response = await handleActivateSelectElementMode({ data: { active: true } }, {});

    expect(response).toMatchObject({
      success: false,
      message: 'Could not activate Select Element mode.',
      error: 'Could not activate Select Element mode.',
      errorDetails: {
        message: 'Could not activate Select Element mode.',
        type: ErrorTypes.SELECT_ELEMENT,
      },
    });
    expect(JSON.stringify(response)).not.toContain('INTERNAL_PORT_9f81');
    expect(JSON.stringify(response)).not.toContain('Receiving end does not exist');
  });

  it('should route deactivation through the authoritative barrier', async () => {
    const message = { data: { tabId: 1, active: false } };
    const response = await handleActivateSelectElementMode(message, {});

    expect(response.success).toBe(true);
    expect(handleDeactivateSelectElementMode).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { tabId: 1, active: false },
      }),
      {},
    );
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    expect(setStateForTab).not.toHaveBeenCalledWith(1, false);
  });

  it('should not invalidate existing state when activation has no strict ACK', async () => {
    browser.tabs.sendMessage.mockResolvedValueOnce({ success: true, activated: false });

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    expect(response.success).toBe(false);
    expect(response.activated).toBe(false);
    expect(setStateForTab).not.toHaveBeenCalledWith(1, false);
    expect(setStateForTab).not.toHaveBeenCalledWith(1, true);
  });

  it('should reject an activation response without confirmed state', async () => {
    browser.tabs.sendMessage.mockResolvedValueOnce({ success: true });

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    expect(response.success).toBe(false);
    expect(setStateForTab).not.toHaveBeenCalledWith(1, true);
  });

  it('should activate and register every frame with a strict ACK', async () => {
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0 },
      { frameId: 4 },
    ]);
    browser.tabs.sendMessage.mockResolvedValue({
      success: true,
      activated: true,
      activationGeneration: 1,
      activationEpoch: 'epoch-1',
    });

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    expect(response.success).toBe(true);
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(1, expect.anything(), { frameId: 0 });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(1, expect.anything(), { frameId: 4 });
    expect(registerParticipant).toHaveBeenCalledWith(1, 0, 1);
    expect(registerParticipant).toHaveBeenCalledWith(1, 4, 1);
    expect(registerParticipant.mock.calls.map(([, , generation]) => generation)).toEqual([1, 1]);
    expect(setStateForTab).toHaveBeenCalledWith(1, true);
  });

  it('should publish active state when at least one frame confirms activation', async () => {
    browser.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0 },
      { frameId: 4 },
    ]);
    browser.tabs.sendMessage
      .mockResolvedValueOnce({ success: true, activated: true, activationGeneration: 1, activationEpoch: 'epoch-1' })
      .mockResolvedValueOnce({ success: false, error: 'Frame unavailable' });

    const response = await handleActivateSelectElementMode(
      { data: { tabId: 1, active: true } },
      {},
    );

    expect(response.success).toBe(true);
    expect(registerParticipant).toHaveBeenCalledTimes(1);
    expect(registerParticipant).toHaveBeenCalledWith(1, 0, 1);
    expect(setStateForTab).toHaveBeenCalledWith(1, true);
  });
});
