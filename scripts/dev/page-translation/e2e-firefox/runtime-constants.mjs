export const PROVIDER_ONLY_DEADLINE_MS = 10_000;
export const PAGE_TRANSLATION_STOP_DEADLINE_MS = 30_000;
export const PAGE_TRANSLATION_STOP_DIAGNOSTIC_STAGES = Object.freeze([
  'accepted-batch', 'stop-control', 'control-delivery', 'production-stop', 'cancellation-ack', 'stop-command-report',
  'stop-command', 'snapshot-control', 'worker-root-settlement', 'final-content-delivery', 'content-drain',
  'final-report', 'final-provider-report', 'final-content-evidence', 'final-batch-correlation',
  'final-cancellation-ack', 'final-worker-evidence', 'worker-cancel-request', 'worker-controller-abort',
  'worker-physical-missing', 'worker-physical-status', 'worker-physical-sequence', 'worker-physical-order', 'worker-resource-drain',
]);
