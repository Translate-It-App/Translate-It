const ACCEPTED_CLICK = 'translate-it:select-element-benchmark:accepted-click';
const REQUEST_DISPATCH = 'translate-it:select-element-benchmark:request-dispatch';
const OPERATION_TERMINAL = 'translate-it:select-element-benchmark:operation-terminal';
const OPT_IN_ATTRIBUTE = 'data-translate-it-live-benchmark';
const ROOT_ATTRIBUTE = 'data-translate-it-live-benchmark-root';
const TRIAL_ATTRIBUTE = 'data-translate-it-live-benchmark-trial';
import {
  getEffectiveProviderAsync, getSourceLanguageAsync, getTargetLanguageAsync,
  getAIContextTranslationEnabledAsync, getAIConversationHistoryEnabledAsync,
  getSelectElementUseTranslationFontAsync, getProviderOptimizationLevelAsync,
  getGeminiModelAsync, getWebAIApiModelAsync, getDeepSeekApiModelAsync,
  getCustomApiModelAsync, getOpenAIModelAsync, getOpenRouterApiModelAsync,
  getRequestyApiModelAsync,
} from '@/config.js';
import { TranslationMode } from '@/shared/config/config.js';

const safeScalar = (value) => typeof value === 'string' && /^[\w .:+/-]{1,80}$/.test(value) ? value : null;
const safeModel = (value) => {
  const model = safeScalar(value);
  return model && !/(?:https?:\/\/|www\.|:\/\/|api[_ -]?key|token|secret|password|bearer|\bsk-(?:proj-)?[a-z0-9_-]{8,}\b|(?:^|[\s/])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$))/i.test(model) ? model : null;
};
const trySetting = async (getter) => { try { return await getter(); } catch { return null; } };
const isLocalBenchmark = () => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);

export async function captureBenchmarkMetadata(event) {
  if (!isLocalBenchmark()) return;
  const detail = (() => { try { return JSON.parse(event.detail); } catch { return null; } })();
  const root = [...document.querySelectorAll(`[${ROOT_ATTRIBUTE}="true"]`)]
    .find((candidate) => candidate.getAttribute(TRIAL_ATTRIBUTE) === detail?.trialId);
  if (!detail?.trialId || !root || getBenchmarkTrialId(root) !== detail.trialId) return;
  const provider = await trySetting(() => getEffectiveProviderAsync(TranslationMode.Select_Element));
  if (getBenchmarkTrialId(root) !== detail.trialId) return;
  const modelGetters = {
    gemini: getGeminiModelAsync, webai: getWebAIApiModelAsync, deepseek: getDeepSeekApiModelAsync,
    custom: getCustomApiModelAsync, openai: getOpenAIModelAsync, openrouter: getOpenRouterApiModelAsync,
    requesty: getRequestyApiModelAsync,
  };
  const [model, optimizationLevel, sourceLanguage, targetLanguage, aiContext, conversationHistory, translationFont] = await Promise.all([
    modelGetters[String(provider).toLowerCase()] ? trySetting(modelGetters[String(provider).toLowerCase()]) : null,
    trySetting(() => getProviderOptimizationLevelAsync(provider)),
    trySetting(getSourceLanguageAsync), trySetting(getTargetLanguageAsync),
    trySetting(getAIContextTranslationEnabledAsync), trySetting(getAIConversationHistoryEnabledAsync),
    trySetting(getSelectElementUseTranslationFontAsync),
  ]);
  if (getBenchmarkTrialId(root) !== detail.trialId) return;
  const runtime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime;
  let extensionVersion = null;
  try { extensionVersion = runtime?.getManifest?.()?.version; } catch { /* Extension context may be unavailable. */ }
  emit('translate-it:select-element-benchmark:configured-metadata', root, {
    provider: safeScalar(provider), model: safeModel(model),
    optimizationLevel: Number.isInteger(optimizationLevel) && optimizationLevel >= 1 && optimizationLevel <= 5 ? optimizationLevel : null,
    sourceLanguage: safeScalar(sourceLanguage), targetLanguage: safeScalar(targetLanguage),
    aiContext: typeof aiContext === 'boolean' ? aiContext : null,
    conversationHistory: typeof conversationHistory === 'boolean' ? conversationHistory : null,
    translationFont: typeof translationFont === 'boolean' ? translationFont : null,
    extensionVersion: safeScalar(extensionVersion),
    capturePhase: detail.capturePhase === 'after-measurement' ? 'after-measurement' : 'before-measurement',
  }, detail.trialId);
}

export function getBenchmarkTrialId(element) {
  if (!import.meta.env.DEV
      || document.documentElement.getAttribute(OPT_IN_ATTRIBUTE) !== 'true'
      || !isLocalBenchmark()
      || !element?.isConnected
      || element.getAttribute(ROOT_ATTRIBUTE) !== 'true') return null;
  return element.getAttribute(TRIAL_ATTRIBUTE) || null;
}

function emit(type, element, payload, expectedTrialId = getBenchmarkTrialId(element)) {
  if (!expectedTrialId || getBenchmarkTrialId(element) !== expectedTrialId) return;
  document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify({ ...payload, trialId: expectedTrialId }) }));
}

export function emitBenchmarkAcceptedClick(event, element) {
  const trialId = getBenchmarkTrialId(element);
  if (!trialId) return;
  emit(ACCEPTED_CLICK, element, {
    clickTimeStamp: Number.isFinite(event?.timeStamp) ? event.timeStamp : null,
    acceptedAt: performance.now(),
  }, trialId);
}

export function emitBenchmarkRequestDispatch(element) {
  const trialId = getBenchmarkTrialId(element);
  if (!trialId) return;
  emit(REQUEST_DISPATCH, element, { at: performance.now() }, trialId);
}

export function emitBenchmarkRuntimeMetadata(element, metadata) {
  const trialId = getBenchmarkTrialId(element);
  if (!trialId) return;
  emit('translate-it:select-element-benchmark:runtime-metadata', element, {
    provider: metadata.provider,
    extractionMode: String(metadata.extractionMode).toUpperCase(),
    sourceLanguage: metadata.sourceLanguage,
    targetLanguage: metadata.targetLanguage,
  }, trialId);
}

export function emitBenchmarkTerminal(element, status, expectedTrialId) {
  if (!expectedTrialId
      || getBenchmarkTrialId(element) !== expectedTrialId
      || !['successful', 'partial', 'failed', 'cancelled'].includes(status)) return;
  emit(OPERATION_TERMINAL, element, { at: performance.now(), status }, expectedTrialId);
}
