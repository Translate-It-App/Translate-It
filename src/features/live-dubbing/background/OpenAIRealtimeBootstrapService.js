import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { ApiKeyManager } from '@/features/translation/providers/ApiKeyManager.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import {
  LIVE_DUBBING_OPENAI_PROVIDER_ID,
} from '../constants.js';
import {
  LIVE_DUBBING_CREDENTIAL_REASONS,
  createLiveDubbingCredentialResult,
  normalizeProviderTargetLanguage,
} from '../contracts.js';

const logger = getScopedLogger(LOG_COMPONENTS.LIVE_DUBBING, 'OpenAIRealtimeBootstrapService');

export const OPENAI_REALTIME_TRANSLATIONS_CLIENT_SECRETS_ENDPOINT =
  'https://api.openai.com/v1/realtime/translations/client_secrets';
export const OPENAI_REALTIME_TRANSLATE_MODEL = 'gpt-realtime-translate';
export const OPENAI_REALTIME_WHISPER_MODEL = 'gpt-realtime-whisper';
export const OPENAI_REALTIME_KEYS_SETTING = 'OPENAI_API_KEY';
export const OPENAI_REALTIME_ORIGINAL_TRANSCRIPT_SETTING = 'LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI';

const KEY_INVALID_CODE_PATTERN = /invalid[_ -]?api[_ -]?key|authentication/i;
const QUOTA_CODE_PATTERN = /insufficient[_ -]?quota|quota|billing[_ -]?hard[_ -]?limit/i;
const RATE_LIMIT_CODE_PATTERN = /rate[_ -]?limit|too[_ -]?many[_ -]?requests/i;

function toEligibleKeys(values) {
  const seen = new Set();
  const eligible = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue;
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    eligible.push(key);
  }
  return eligible;
}

function safeText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : null;
}

/**
 * Read only coarse OpenAI error metadata for key failover classification.
 * The response body is never logged, thrown, returned, or included in an
 * error; no provider metadata crosses the bootstrap boundary.
 */
async function readMintErrorMetadata(response) {
  try {
    const body = await response.json();
    const error = body && typeof body === 'object' && !Array.isArray(body) ? body.error : null;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
    return {
      type: safeText(error.type, 80),
      code: safeText(error.code, 80),
      message: safeText(error.message, 200),
    };
  } catch {
    return null;
  }
}

function hasKeyInvalidSignal(metadata) {
  if (!metadata) return false;
  return [metadata.type, metadata.code, metadata.message]
    .some(value => typeof value === 'string' && KEY_INVALID_CODE_PATTERN.test(value));
}

function hasQuotaSignal(metadata) {
  if (!metadata) return false;
  return [metadata.type, metadata.code, metadata.message]
    .some(value => typeof value === 'string' && QUOTA_CODE_PATTERN.test(value));
}

function hasRateLimitSignal(metadata) {
  if (!metadata) return false;
  return [metadata.type, metadata.code, metadata.message]
    .some(value => typeof value === 'string' && RATE_LIMIT_CODE_PATTERN.test(value));
}

/**
 * Map an OpenAI mint failure to the shared key failover taxonomy. Only
 * invalid credentials, quota/billing exhaustion, and rate limiting advance;
 * malformed requests, serving failures, and transport failures stop.
 */
function classifyMintFailure(status, metadata) {
  if (status === 429) {
    return hasQuotaSignal(metadata) ? ErrorTypes.QUOTA_EXCEEDED : ErrorTypes.RATE_LIMIT_REACHED;
  }
  if (status === 401) return ErrorTypes.API_KEY_INVALID;
  if (status === 402) return ErrorTypes.INSUFFICIENT_BALANCE;
  if (Number.isInteger(status) && status >= 500 && status <= 599) return ErrorTypes.SERVER_ERROR;
  if (hasKeyInvalidSignal(metadata)) return ErrorTypes.API_KEY_INVALID;
  if (hasQuotaSignal(metadata)) return ErrorTypes.QUOTA_EXCEEDED;
  if (hasRateLimitSignal(metadata)) return ErrorTypes.RATE_LIMIT_REACHED;
  return ErrorTypes.HTTP_ERROR;
}

/**
 * Map one classified mint failure to a coarse, sanitized validation reason.
 * Transport throws and 5xx serving failures stay indeterminate and never
 * report an invalid key; a 403 reports a capability rejection rather than
 * an invalid key.
 */
function toValidationReason(failure) {
  if (!failure || failure.kind === 'TRANSPORT') {
    return LIVE_DUBBING_CREDENTIAL_REASONS.NETWORK_ERROR;
  }
  if (failure.kind === 'MALFORMED') {
    return LIVE_DUBBING_CREDENTIAL_REASONS.INVALID_RESPONSE;
  }
  if (failure.type === ErrorTypes.API_KEY_INVALID) {
    return LIVE_DUBBING_CREDENTIAL_REASONS.AUTH_INVALID;
  }
  if (failure.type === ErrorTypes.QUOTA_EXCEEDED) {
    return LIVE_DUBBING_CREDENTIAL_REASONS.QUOTA_EXCEEDED;
  }
  if (failure.type === ErrorTypes.RATE_LIMIT_REACHED) {
    return LIVE_DUBBING_CREDENTIAL_REASONS.RATE_LIMITED;
  }
  if (failure.type === ErrorTypes.INSUFFICIENT_BALANCE) {
    return LIVE_DUBBING_CREDENTIAL_REASONS.INSUFFICIENT_BALANCE;
  }
  if (failure.status === 403) return LIVE_DUBBING_CREDENTIAL_REASONS.FORBIDDEN;
  if (failure.type === ErrorTypes.SERVER_ERROR) {
    return LIVE_DUBBING_CREDENTIAL_REASONS.SERVER_ERROR;
  }
  return LIVE_DUBBING_CREDENTIAL_REASONS.REQUEST_FAILED;
}

function buildMintBody(targetLanguage, showOriginalTranscript) {
  const audio = showOriginalTranscript
    ? {
      input: { transcription: { model: OPENAI_REALTIME_WHISPER_MODEL } },
      output: { language: targetLanguage },
    }
    : { output: { language: targetLanguage } };

  return {
    session: {
      model: OPENAI_REALTIME_TRANSLATE_MODEL,
      audio,
    },
  };
}

/**
 * Background-only minter for OpenAI Realtime translation client secrets.
 *
 * Long-lived keys are read through `ApiKeyManager` and used only for the
 * provider request. The documented response `value` is the sole returned
 * bootstrap data; keys, headers, raw bodies, expiry, model, and language
 * metadata never enter logs, errors, storage, descriptors, or UI responses.
 * Failover is mint-time only and follows `ApiKeyManager.shouldFailover`.
 */
export class OpenAIRealtimeBootstrapService {
  constructor(options = {}) {
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : null;
    this.getKeysImpl = typeof options.getKeysImpl === 'function'
      ? options.getKeysImpl
      : () => ApiKeyManager.getKeys(OPENAI_REALTIME_KEYS_SETTING);
    this.getOriginalTranscriptEnabledImpl = typeof options.getOriginalTranscriptEnabledImpl === 'function'
      ? options.getOriginalTranscriptEnabledImpl
      : async () => {
        const { storageManager } = await import('@/shared/storage/core/StorageCore.js');
        const stored = await storageManager.getFresh({
          [OPENAI_REALTIME_ORIGINAL_TRANSCRIPT_SETTING]: false,
        });
        return stored?.[OPENAI_REALTIME_ORIGINAL_TRANSCRIPT_SETTING];
      };
    this.authTokenEndpoint = typeof options.authTokenEndpoint === 'string' && options.authTokenEndpoint
      ? options.authTokenEndpoint
      : OPENAI_REALTIME_TRANSLATIONS_CLIENT_SECRETS_ENDPOINT;
    this.log = options.logger || logger;
  }

  /**
   * Mint one opaque client secret for the normalized target language.
   * @param {unknown} targetLanguage
   * @returns {Promise<string|null>} The documented response `value`, or null.
   */
  async mintClientSecret(targetLanguage) {
    let normalized;
    try {
      normalized = normalizeProviderTargetLanguage(LIVE_DUBBING_OPENAI_PROVIDER_ID, targetLanguage);
    } catch {
      return null;
    }

    const showOriginalTranscript = await this._readOriginalTranscriptEnabled();
    const keys = await this._eligibleKeys();
    if (keys.length === 0) return null;

    for (let index = 0; index < keys.length; index += 1) {
      const outcome = await this._attemptMint(keys[index], normalized, showOriginalTranscript);
      if (outcome.ok) return outcome.secret;
      if (!outcome.tryNext) {
        this.log.debug('[OpenAIRealtimeBootstrapService] Client secret mint failed without failover');
        return null;
      }
      this.log.debug('[OpenAIRealtimeBootstrapService] Client secret mint failed, trying next key');
    }
    return null;
  }

  /**
   * Read configured keys in priority order without changing key-manager
   * ordering or persisting failover state.
   * @returns {Promise<string[]>}
   */
  async _eligibleKeys() {
    try {
      return toEligibleKeys(await this.getKeysImpl());
    } catch {
      return [];
    }
  }

  async hasConfiguredCredentials() {
    return (await this._eligibleKeys()).length > 0;
  }

  async _readOriginalTranscriptEnabled() {
    try {
      return (await this.getOriginalTranscriptEnabledImpl()) === true;
    } catch {
      return false;
    }
  }

  /**
   * Validate one caller-supplied draft key against the Live Dubbing mint
   * capability. Exactly one `_attemptMint` runs with the draft key only:
   * no stored-key reads, no failover to other keys, no promotion, and no
   * session/descriptor side effects. A minted client secret proves the
   * capability and is immediately discarded; it never enters the result,
   * storage, or logs.
   * @param {unknown} draftApiKey
   * @param {unknown} targetLanguage
   * @returns {Promise<{ok: boolean, valid: boolean, reason: string}>}
   */
  async validateCredential(draftApiKey, targetLanguage) {
    let normalized;
    try {
      normalized = normalizeProviderTargetLanguage(LIVE_DUBBING_OPENAI_PROVIDER_ID, targetLanguage);
    } catch (error) {
      return createLiveDubbingCredentialResult(
        false,
        error instanceof RangeError
          ? LIVE_DUBBING_CREDENTIAL_REASONS.UNSUPPORTED_LANGUAGE
          : LIVE_DUBBING_CREDENTIAL_REASONS.INVALID_REQUEST,
      );
    }

    if (typeof draftApiKey !== 'string' || !draftApiKey.trim()) {
      return createLiveDubbingCredentialResult(
        false,
        LIVE_DUBBING_CREDENTIAL_REASONS.MISSING_CREDENTIAL,
      );
    }

    const showOriginalTranscript = await this._readOriginalTranscriptEnabled();
    const outcome = await this._attemptMint(
      draftApiKey.trim(),
      normalized,
      showOriginalTranscript,
    );
    if (outcome.ok) {
      return createLiveDubbingCredentialResult(true, LIVE_DUBBING_CREDENTIAL_REASONS.VALID);
    }
    return createLiveDubbingCredentialResult(false, toValidationReason(outcome.failure));
  }

  /**
   * One classified mint attempt. It never throws or surfaces provider data.
   * @returns {Promise<{ok: boolean, secret?: string, tryNext?: boolean, failure?: object}>}
   */
  async _attemptMint(apiKey, targetLanguage, showOriginalTranscript) {
    let response;
    try {
      response = await this._fetch(this.authTokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildMintBody(targetLanguage, showOriginalTranscript)),
      });
    } catch {
      return { ok: false, tryNext: false, failure: { kind: 'TRANSPORT' } };
    }

    if (!response || response.ok !== true) {
      const failed = Boolean(response) && response.ok === false;
      if (!failed) return { ok: false, tryNext: false, failure: { kind: 'TRANSPORT' } };
      const failure = await this._classifyResponseFailure(response);
      return {
        ok: false,
        tryNext: ApiKeyManager.shouldFailover({ type: failure.type }) === true,
        failure,
      };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, tryNext: false, failure: { kind: 'MALFORMED' } };
    }

    const secret = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload.value
      : null;
    if (typeof secret !== 'string' || !secret) return { ok: false, tryNext: false, failure: { kind: 'MALFORMED' } };
    return { ok: true, secret };
  }

  async _classifyResponseFailure(response) {
    const status = Number.isInteger(response?.status) ? response.status : 0;
    const metadata = await readMintErrorMetadata(response);
    return { kind: 'RESPONSE', status, type: classifyMintFailure(status, metadata) };
  }

  /**
   * Production minting uses the existing proxy infrastructure on one path.
   * Proxy, config, and network failures stop the mint without a direct-fetch
   * retry. The existing HTTPS proxy response has no trusted target-forwarding
   * marker or envelope, so 401/429 responses fail closed and do not advance
   * bootstrap keys.
   */
  async _fetch(url, options) {
    if (this.fetchImpl) return this.fetchImpl(url, options);

    const { resolveProxyConfig } = await import('@/shared/proxy/ProxySettings.js');
    const { proxyManager } = await import('@/shared/proxy/ProxyManager.js');
    return proxyManager.fetch(
      url,
      options,
      await resolveProxyConfig(),
    );
  }
}

export const openAIRealtimeBootstrapService = new OpenAIRealtimeBootstrapService();
