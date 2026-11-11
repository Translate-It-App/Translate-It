/** Browser-safe Phase 2B protocol constants; no Node-only imports. */
const OPERATION = 'firefox-page-replacement';
const VERSION = 1;
const REPORT_PATH = '/__page-translation-replacement/report';
const CONTROL_PREFIX = '/__page-translation-replacement/control/';

export const replacementContentEventAction = '__PAGE_TRANSLATION_REPLACEMENT_EVENT_V1';
export const replacementContentStatusAction = '__PAGE_TRANSLATION_REPLACEMENT_STATUS_V1';
export const replacementInvalidatedDomEvent = 'translate-it:page-translation-replacement-invalidated';
export const replacementNativeCodes = Object.freeze(['ABORTED', 'AbortError', 'CANCELLED', 'NETWORK_ERROR', 'FETCH_ERROR', 'HTTP_ERROR', 'TIMEOUT', 'TEARDOWN', 'TRANSLATION_CANCELLED']);
export const replacementErrorCodes = Object.freeze(['PROTOCOL_ERROR', 'TIMEOUT', 'TEARDOWN', 'PROVIDER_ERROR', 'DOM_MISMATCH']);
export const replacementCancellationReasons = Object.freeze(['operation-abort']);

export const replacementEventSchemas = Object.freeze({
  'session-start': ['owner', 'sessionId', 'currentUrl', 'isAuto', 'autoTranslateOnDomChanges', 'preserveAcceptedTranslations', 'cursor'],
  'scheduler-batch': ['owner', 'sessionId', 'messageId', 'targetIds'],
  'provider-invoked': ['owner', 'sessionId', 'messageId', 'invocationId', 'targetIds'],
  'physical-start': ['owner', 'sessionId', 'messageId', 'invocationId', 'attemptId', 'targetIds'],
  'physical-settled': ['sessionId', 'messageId', 'attemptId', 'outcome', 'code', 'cleanup'],
  'provider-root-settled': ['sessionId', 'messageId', 'status', 'code', 'cleanup', 'operationAborted', 'cancellationReason'],
  'accepted-A': ['sessionId', 'messageId', 'targetIds'],
  'spa-navigation': ['fromUrl', 'toUrl', 'cursor'],
  'stop-ack': ['sessionId', 'navigationCursor', 'success', 'cancellationReason', 'resultSessionId', 'isAutoTranslating'],
  'controller-abort': ['sessionId', 'messageId', 'attemptId', 'aborted', 'cause'],
  'retained-A': ['sessionId', 'sourceSessionId', 'targetIds'],
  'accepted-B': ['sessionId', 'messageId', 'targetIds', 'source'],
  'stop-B': ['sessionId', 'success', 'resultSessionId', 'isAutoTranslating', 'bridgeActive', 'schedulerActive', 'discoveryActive', 'observerRelease'],
  cleanup: ['activeOperations', 'pendingRequests', 'cleanupCancelledAttemptIds'],
  'final-dom': ['sessionId', 'targets', 'postInvalidationAWrites'],
  error: ['code'],
});

export const replacementProtocol = Object.freeze({ operation: OPERATION, version: VERSION, reportPath: REPORT_PATH,
  controlPaths: Object.freeze({ navigateToB: `${CONTROL_PREFIX}navigate-to-b`, captureFinal: `${CONTROL_PREFIX}capture-final` }),
  events: replacementEventSchemas, nativeCodes: replacementNativeCodes, errorCodes: replacementErrorCodes,
  cancellationReasons: replacementCancellationReasons,
  contentEventAction: replacementContentEventAction, contentStatusAction: replacementContentStatusAction,
  invalidatedDomEvent: replacementInvalidatedDomEvent });
