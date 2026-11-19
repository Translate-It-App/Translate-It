export const CUSTOM_FIXTURE_ENDPOINT = Object.freeze({
  origin: 'https://benchmark-custom.invalid',
  pathname: '/v1/chat/completions',
  method: 'POST',
});
export const CUSTOM_FIXTURE_URL = `${CUSTOM_FIXTURE_ENDPOINT.origin}${CUSTOM_FIXTURE_ENDPOINT.pathname}`;
export const CUSTOM_FIXTURE_MODEL = 'benchmark-custom-model';

export function decodeCustomRequest({ method, url, body, headers = {}, expectedTexts }) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new TypeError('Custom request URL is invalid.'); }
  if (parsed.origin !== CUSTOM_FIXTURE_ENDPOINT.origin || parsed.pathname !== CUSTOM_FIXTURE_ENDPOINT.pathname
      || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || method !== CUSTOM_FIXTURE_ENDPOINT.method) {
    throw new TypeError('Unexpected Custom endpoint or method.');
  }
  if (Object.keys(headers).some(name => name.toLowerCase() === 'authorization')) {
    throw new TypeError('Custom synthetic request must not include Authorization.');
  }
  let payload;
  try { payload = JSON.parse(body); } catch { throw new TypeError('Custom request body is invalid JSON.'); }
  const keys = Object.keys(payload ?? {}).sort();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || JSON.stringify(keys) !== JSON.stringify(['max_tokens', 'messages', 'model', 'response_format'].sort())
        && JSON.stringify(keys) !== JSON.stringify(['max_tokens', 'messages', 'model'])
      || payload.model !== CUSTOM_FIXTURE_MODEL || payload.max_tokens !== 4096
      || !Array.isArray(payload.messages) || payload.messages.length < 2
      || (payload.response_format !== undefined && JSON.stringify(payload.response_format) !== JSON.stringify({ type: 'json_object' }))) {
    throw new TypeError('Custom request payload is malformed or unexpected.');
  }
  if (payload.messages.some(message => !message || !['system', 'user'].includes(message.role)
      || typeof message.content !== 'string' || !message.content.trim())) {
    throw new TypeError('Custom request messages are malformed.');
  }
  const users = payload.messages.filter(message => message.role === 'user');
  if (users.length !== 1) throw new TypeError('Custom request must contain exactly one user message.');
  let userContent;
  try { userContent = JSON.parse(users[0].content); } catch { throw new TypeError('Custom user message is not JSON.'); }
  const translations = userContent?.translations;
  if (!userContent || Object.keys(userContent).length !== 1 || !Array.isArray(translations) || !translations.length
      || translations.some(item => !item || typeof item.id !== 'string' || !item.id.trim()
        || typeof item.text !== 'string' || !item.text.trim())
      || new Set(translations.map(item => item.id)).size !== translations.length) {
    throw new TypeError('Custom user message requires unique IDs and non-empty translations.');
  }
  const expected = new Set(expectedTexts ?? []);
  if (!expected.size || translations.some(item => !expected.has(item.text))) {
    throw new TypeError('Custom request contains empty or unknown fixture text.');
  }
  return { model: payload.model, ids: translations.map(item => item.id), texts: translations.map(item => item.text) };
}

export function mapCustomResponse({ ids, texts }) {
  if (!Array.isArray(ids) || !Array.isArray(texts) || !ids.length || ids.length !== texts.length
      || ids.some(id => typeof id !== 'string' || !id.trim())
      || texts.some(text => typeof text !== 'string' || !text.trim())) {
    throw new TypeError('Custom fixture response requires matching non-empty IDs and texts.');
  }
  const translations = ids.map((id, index) => ({ id, text: `fixture translation: ${texts[index]}` })).reverse();
  return { choices: [{ message: { content: JSON.stringify({ translations }) } }] };
}
