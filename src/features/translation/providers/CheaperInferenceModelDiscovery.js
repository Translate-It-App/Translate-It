import { proxyManager } from '@/shared/proxy/ProxyManager.js'
import { resolveProxyConfig } from '@/shared/proxy/ProxySettings.js'
import { ApiKeyManager } from '@/features/translation/providers/ApiKeyManager.js'
import { apiKeyFingerprint, createDiscoveryRequestSignal, getCachedEntry, throwIfAborted } from './modelDiscoveryUtils.js'

// Public catalog: lists models without an API key (the /v1/models route needs one).
const CHEAPERINFERENCE_MODELS_URL = 'https://api.cheaperinference.com/public/models'
const modelCache = new Map()

function humanName(item, id) {
  for (const field of ['name', 'display_name', 'displayName', 'model_name', 'modelName']) {
    if (typeof item?.[field] === 'string' && item[field].trim()) return item[field].trim()
  }
  return id
}

export function normalizeCheaperInferenceModels(data) {
  if (!Array.isArray(data?.models)) return []
  const models = []
  const seen = new Set()
  for (const item of data.models) {
    const value = typeof item?.id === 'string' ? item.id.trim() : ''
    if (!value || seen.has(value)) continue
    // Skip models that are not served on chat completions (embeddings, images, audio).
    if (Array.isArray(item.supported_endpoints) && !item.supported_endpoints.includes('/v1/chat/completions')) continue
    seen.add(value)
    models.push({ value, name: humanName(item, value) })
  }
  return models
}

function isValidCheaperInferenceModelsPayload(data) {
  return data !== null
    && typeof data === 'object'
    && !Array.isArray(data)
    && Array.isArray(data.models)
    && (data.models.length === 0 || data.models.some(item => typeof item?.id === 'string' && item.id.trim()))
}

export function getCachedCheaperInferenceModels(apiKey = '', now = Date.now()) {
  const key = apiKeyFingerprint(apiKey)
  return getCachedEntry(modelCache, key, models => models.map(model => ({ ...model })), now)
}

export function clearCheaperInferenceModelCache() {
  modelCache.clear()
}

export async function fetchCheaperInferenceModels({
  apiKey = '',
  fetchFn,
  timeoutMs = 8000,
  signal,
} = {}) {
  const { signal: requestSignal, cleanup } = createDiscoveryRequestSignal(signal, timeoutMs)
  try {
    const configuredKey = typeof apiKey === 'string' ? apiKey : ''
    const key = ApiKeyManager.parseKeys(configuredKey)[0]
    const headers = { Accept: 'application/json' }
    if (key) headers.Authorization = `Bearer ${key}`
    const options = { method: 'GET', headers, signal: requestSignal }
    const response = fetchFn
      ? await fetchFn(CHEAPERINFERENCE_MODELS_URL, options)
      : await (async () => {
        const proxyConfig = await resolveProxyConfig()
        return proxyManager.fetch(CHEAPERINFERENCE_MODELS_URL, options, proxyConfig)
      })()
    throwIfAborted(requestSignal)
    if (!response.ok) throw new Error(`Cheaper Inference model discovery failed (${response.status})`)
    const data = await response.json()
    throwIfAborted(requestSignal)
    if (!isValidCheaperInferenceModelsPayload(data)) throw new TypeError('Invalid Cheaper Inference model list response')
    const models = normalizeCheaperInferenceModels(data)
    modelCache.set(apiKeyFingerprint(configuredKey), { models, fetchedAt: Date.now() })
    return models
  } finally {
    cleanup()
  }
}
