import { findProviderById } from '../providers/ProviderManifest.js';
import { getFirstMissingSetting } from './providerValidator.js';
import { MessageContexts } from '@/shared/messaging/core/MessagingConstants.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { mapCanonicalTranslationError } from '@/shared/error-management/PublicTranslationErrorPolicy.js';

export const PROVIDER_CAPABILITY_UNSUPPORTED = 'PROVIDER_CAPABILITY_UNSUPPORTED';

export function getProviderModeValidationMessage(error, t) {
  if (error?.code === PROVIDER_CAPABILITY_UNSUPPORTED) {
    return t(
      'provider_does_not_support_bulk',
      'This provider does not support page/element translation',
    );
  }

  const { messageKey } = mapCanonicalTranslationError(error);
  return t(messageKey, messageKey);
}

const requiredFeatures = new Map([
  [MessageContexts.PAGE_TRANSLATION_BATCH, 'bulk'],
  ['page', 'bulk'],
  [MessageContexts.PDF_TRANSLATION, 'bulk'],
  [MessageContexts.SELECT_ELEMENT, 'bulk'],
  [MessageContexts.CONTENT, 'bulk'],
  [MessageContexts.SUBTITLE_TRANSLATION, 'subtitle'],
]);

export function resolveModeProvider(mode, modeProviders, globalProvider, dictionaryMode, selectionMode, fallbackProvider) {
  if (mode && modeProviders?.[mode]) return modeProviders[mode];
  if (mode === dictionaryMode && modeProviders?.[selectionMode]) return modeProviders[selectionMode];
  return globalProvider || fallbackProvider;
}

export function getProviderModeValidationError(providerId, mode, settings = {}) {
  const provider = findProviderById(providerId);
  if (!provider) {
    const error = new Error(`Unknown translation provider: ${providerId || '(empty)'}`);
    error.type = ErrorTypes.VALIDATION;
    return error;
  }

  const feature = requiredFeatures.get(mode);
  if (feature && !provider.features?.includes(feature)) {
    const error = new Error(`${provider.displayName} does not support ${feature} for ${mode}`);
    error.type = ErrorTypes.VALIDATION;
    error.code = PROVIDER_CAPABILITY_UNSUPPORTED;
    return error;
  }

  const missingSetting = getFirstMissingSetting(providerId, settings);
  if (missingSetting) {
    const type = missingSetting.toLowerCase().includes('key')
      ? ErrorTypes.API_KEY_MISSING
      : missingSetting.toLowerCase().includes('url')
        ? ErrorTypes.API_URL_MISSING
        : missingSetting.toLowerCase().includes('model')
          ? ErrorTypes.MODEL_MISSING
          : ErrorTypes.API_CONFIG_INVALID;
    const error = new Error(type);
    error.type = type;
    error.providerName = provider.displayName;
    return error;
  }
  return null;
}
