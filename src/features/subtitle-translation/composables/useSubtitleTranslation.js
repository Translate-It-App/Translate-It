import { ref, reactive } from 'vue';
import { MessagingBus } from '@/shared/messaging/core/MessagingBus.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { MessageContexts } from '@/shared/messaging/core/MessagingConstants.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { MessageFormat, isStructuredTranslationError } from '@/shared/messaging/core/MessagingCore.js';
import { presentSubtitleTranslationError } from '../presentation/SubtitleTranslationErrorPresenter.js';

const CANONICAL_ERROR_TYPES = new Set([
  ...Object.values(ErrorTypes),
  'MODEL_NOT_FOUND',
  'PROVIDER_ERROR'
]);

function isCanonicalTranslationError(error) {
  if (!error || typeof error !== 'object') return false;

  if (CANONICAL_ERROR_TYPES.has(error.type) || CANONICAL_ERROR_TYPES.has(error.originalType)) {
    return true;
  }

  return Boolean(
    (error.type || error.originalType)
    && ['statusCode', 'code', 'errorCode', 'providerName', 'providerId'].some((field) => error[field] !== undefined)
  );
}

function getRejectedErrorDetails(error) {
  if (isStructuredTranslationError(error?.errorDetails)) return error.errorDetails;
  if (isCanonicalTranslationError(error)) return MessageFormat.serializeTranslationError(error);
  return undefined;
}

export function useSubtitleTranslation() {
  const jobId = ref(`job-${Date.now()}`);
  const status = ref('idle'); // idle, translating, completed, error
  const progress = reactive({
    percent: 0,
    processed: 0,
    total: 0,
    translated: 0,
    failed: 0,
    etaMs: 0,
    elapsedMs: 0
  });
  
  const translatedContent = ref('');
  const error = ref(null);
  const errorAction = ref(null);
  const errorDetails = ref(null);
  const currentFile = ref(null);
  const cues = ref([]);
  let presentationVersion = 0;

  // Subscribe to background updates
  const unsubscribe = MessagingBus.subscribe(MessageContexts.SUBTITLE_TRANSLATION, (message) => {
    const { action, data } = message;

    if (!data || data.jobId !== jobId.value) return;

    switch (action) {
      case MessageActions.SUBTITLE_TRANSLATE_PROGRESS:
        presentationVersion++;
        Object.assign(progress, data.progress);
        status.value = 'translating';
        
        // Update cues with translated text from the batch
        if (data.updatedCues && Array.isArray(data.updatedCues)) {
          data.updatedCues.forEach(updated => {
            const cue = cues.value.find(c => c.id === updated.id);
            if (cue) {
              cue.translatedText = updated.translatedText;
              cue.status = updated.status;
            }
          });
        }
        break;

      case MessageActions.SUBTITLE_TRANSLATE_COMPLETE: {
        presentationVersion++;
        Object.assign(progress, data.stats);
        const translatedCount = Number(data.stats?.translated) || 0;
        const failedCount = Number(data.stats?.failed) || 0;
        const terminalErrorDetails = data.errorDetails || progress.terminalErrorDetails || null;

        if (translatedCount === 0 && failedCount > 0) {
          translatedContent.value = '';
          void applyTranslationError({ errorDetails: terminalErrorDetails });
          break;
        }

        status.value = 'completed';
        translatedContent.value = data.content;
        errorDetails.value = terminalErrorDetails;
        
        // Final status update for any remaining cues if needed
        // (Coordinator handles serialization, but we want UI to reflect completion)
        if (progress.percent === 100) {
          cues.value.forEach(cue => {
            if (cue.status === 'pending' || cue.status === 'translating') {
              cue.status = 'skipped';
            }
          });
        }
        break;
      }

      case MessageActions.SUBTITLE_TRANSLATE_ERROR:
        void applyTranslationError({ errorDetails: data.errorDetails });
        break;
    }
  });

  const applyTranslationError = async (detail = {}) => {
    const version = ++presentationVersion;
    errorDetails.value = detail.errorDetails || null;
    const presentation = await presentSubtitleTranslationError(detail);
    if (version !== presentationVersion) return;
    if (presentation.kind === 'silent') {
      status.value = 'idle';
      error.value = null;
      errorAction.value = null;
      return;
    }

    status.value = 'error';
    error.value = presentation.kind === 'display' ? presentation.message : null;
    errorAction.value = presentation.kind === 'display' ? presentation.action ?? null : null;
  };

  const presentError = (error) => applyTranslationError({
    errorDetails: MessageFormat.serializeTranslationError(error),
  });

  const startTranslation = async (fileContent, filename, config) => {
    presentationVersion++;
    status.value = 'translating';
    error.value = null;
    errorAction.value = null;
    errorDetails.value = null;
    translatedContent.value = '';
    
    // Reset progress
    Object.assign(progress, {
      percent: 0,
      processed: 0,
      total: 0,
      translated: 0,
      failed: 0,
      etaMs: 0,
      elapsedMs: 0
    });

    try {
      const response = await MessagingBus.sendToBackground({
        context: MessageContexts.SUBTITLE_TRANSLATION,
        action: MessageActions.SUBTITLE_TRANSLATE,
        payload: {
          jobId: jobId.value,
          content: fileContent,
          filename,
          sourceLanguage: config.sourceLanguage,
          targetLanguage: config.targetLanguage,
          providerId: config.providerId,
          options: config.options ? JSON.parse(JSON.stringify(config.options)) : undefined
        }
      });

      if (response && response.success === false) {
        await applyTranslationError({ errorDetails: response.errorDetails });
      }
    } catch (err) {
      await applyTranslationError({ errorDetails: getRejectedErrorDetails(err) });
    }
  };

  const cancelTranslation = () => {
    presentationVersion++;
    MessagingBus.sendToBackground({
      context: MessageContexts.SUBTITLE_TRANSLATION,
      action: MessageActions.SUBTITLE_TRANSLATE_CANCEL,
      payload: { jobId: jobId.value }
    });
    status.value = 'idle';
  };

  const downloadResult = (filename) => {
    if (!translatedContent.value) return;

    const blob = new Blob([translatedContent.value], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    // Suggest a name: original_translated.srt
    const nameParts = filename.split('.');
    const ext = nameParts.pop();
    const newName = `${nameParts.join('.')}_translated.${ext}`;
    
    a.href = url;
    a.download = newName;
    a.click();
    URL.revokeObjectURL(url);
  };

  return {
    jobId,
    status,
    progress,
    error,
    errorAction,
    errorDetails,
    currentFile,
    cues,
    translatedContent,
    startTranslation,
    presentError,
    cancelTranslation,
    downloadResult,
    cleanup: unsubscribe
  };
}
