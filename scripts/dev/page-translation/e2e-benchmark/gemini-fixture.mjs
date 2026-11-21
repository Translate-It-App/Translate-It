export const GEMINI_FIXTURE_ENDPOINT = Object.freeze({
  origin: 'https://benchmark-gemini.invalid',
  pathname: '/v1beta/models/benchmark-gemini-model:generateContent',
  method: 'POST',
});
export const GEMINI_FIXTURE_URL = `${GEMINI_FIXTURE_ENDPOINT.origin}${GEMINI_FIXTURE_ENDPOINT.pathname}`;
export const GEMINI_FIXTURE_MODEL = 'benchmark-gemini-model';
export const GEMINI_FIXTURE_KEY = 'benchmark-dummy-key';
export const GEMINI_GENERATION_CONFIG = Object.freeze({
  maxOutputTokens: 8192,
  responseMimeType: 'application/json',
  temperature: 0.1,
});

export function decodeGeminiRequest({ method, url, body, headers = {}, expectedTexts }) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new TypeError('Gemini request URL is invalid.'); }
  if (parsed.origin !== GEMINI_FIXTURE_ENDPOINT.origin || parsed.pathname !== GEMINI_FIXTURE_ENDPOINT.pathname
      || parsed.username || parsed.password || parsed.port || parsed.hash || method !== GEMINI_FIXTURE_ENDPOINT.method
      || [...parsed.searchParams.keys()].length !== 1 || parsed.searchParams.get('key') !== GEMINI_FIXTURE_KEY) {
    throw new TypeError('Unexpected Gemini endpoint, method, or API key.');
  }
  if (Object.keys(headers).some(name => name.toLowerCase() === 'authorization')) {
    throw new TypeError('Gemini synthetic request must not include Authorization.');
  }
  if (!Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'content-type'
      && typeof value === 'string' && value.toLowerCase() === 'application/json')) {
    throw new TypeError('Gemini request must use application/json.');
  }
  let payload;
  try { payload = JSON.parse(body); } catch { throw new TypeError('Gemini request body is invalid JSON.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(['contents', 'generationConfig', 'systemInstruction'].sort())
      || JSON.stringify(Object.keys(payload.generationConfig ?? {}).sort()) !== JSON.stringify(Object.keys(GEMINI_GENERATION_CONFIG).sort())
      || Object.entries(GEMINI_GENERATION_CONFIG).some(([key, value]) => payload.generationConfig[key] !== value)
      || !Array.isArray(payload.contents) || payload.contents.length !== 1
      || JSON.stringify(Object.keys(payload.contents[0] ?? {}).sort()) !== JSON.stringify(['parts'])
      || !Array.isArray(payload.contents[0]?.parts)
      || payload.contents[0].parts.length !== 1 || typeof payload.contents[0].parts[0]?.text !== 'string'
      || !payload.contents[0].parts[0].text.trim()
      || !Array.isArray(payload.systemInstruction?.parts) || payload.systemInstruction.parts.length !== 1
      || typeof payload.systemInstruction.parts[0]?.text !== 'string' || !payload.systemInstruction.parts[0].text.trim()
      || JSON.stringify(Object.keys(payload.systemInstruction).sort()) !== JSON.stringify(['parts'])) {
    throw new TypeError('Gemini request payload is malformed or unexpected.');
  }
  let userContent;
  try { userContent = JSON.parse(payload.contents[0].parts[0].text); } catch { throw new TypeError('Gemini user content is not JSON.'); }
  const translations = userContent?.translations;
  if (!userContent || JSON.stringify(Object.keys(userContent)) !== JSON.stringify(['translations'])
      || !Array.isArray(translations) || !translations.length
      || translations.some(item => !item || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(['id', 'text'])
        || typeof item.id !== 'string' || !item.id.trim() || typeof item.text !== 'string' || !item.text.trim())
      || new Set(translations.map(item => item.id)).size !== translations.length) {
    throw new TypeError('Gemini user content requires unique IDs and non-empty translations.');
  }
  const expected = new Set(expectedTexts ?? []);
  if (!expected.size || translations.some(item => !expected.has(item.text))) {
    throw new TypeError('Gemini request contains empty or unknown fixture text.');
  }
  return { model: GEMINI_FIXTURE_MODEL, ids: translations.map(item => item.id), texts: translations.map(item => item.text) };
}

export function mapGeminiResponse({ ids, texts }) {
  if (!Array.isArray(ids) || !Array.isArray(texts) || !ids.length || ids.length !== texts.length
      || ids.some(id => typeof id !== 'string' || !id.trim())
      || texts.some(text => typeof text !== 'string' || !text.trim())) {
    throw new TypeError('Gemini fixture response requires matching non-empty IDs and texts.');
  }
  const translations = ids.map((id, index) => ({ id, text: `fixture translation: ${texts[index]}` })).reverse();
  return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(translations) }] } }] };
}

export function mapMalformedGeminiResponse() {
  return { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '{"translations": [ malformed' }] } }] };
}

export function isMappedGeminiResponse(response, { ids, texts }) {
  if (!Array.isArray(ids) || !Array.isArray(texts) || !ids.length || ids.length !== texts.length
      || response?.candidates?.length !== 1
      || response.candidates[0]?.finishReason !== 'STOP'
      || response.candidates[0]?.content?.role !== 'model'
      || response.candidates[0]?.content?.parts?.length !== 1) return false;
  try {
    const output = JSON.parse(response.candidates[0].content.parts[0].text);
    const expected = ids.map((id, index) => ({ id, text: `fixture translation: ${texts[index]}` })).reverse();
    return JSON.stringify(output) === JSON.stringify(expected);
  } catch { return false; }
}
