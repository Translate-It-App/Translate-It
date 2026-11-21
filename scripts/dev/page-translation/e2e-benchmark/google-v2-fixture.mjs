export const GOOGLE_V2_ENDPOINT = Object.freeze({
  origin: 'https://translate.google.com',
  pathname: '/translate_a/single',
  method: 'POST',
});
export const GOOGLE_V2_DELIMITER = '\n[[---]]\n';

export function decodeGoogleV2Request({ method, url, body }) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new TypeError('Google V2 request URL is invalid.'); }
  if (parsed.origin !== GOOGLE_V2_ENDPOINT.origin || parsed.pathname !== GOOGLE_V2_ENDPOINT.pathname
      || method !== GOOGLE_V2_ENDPOINT.method) throw new TypeError('Unexpected Google V2 endpoint or method.');
  if (parsed.hash || /%(?![0-9a-f]{2})/i.test(parsed.search)
      || parsed.searchParams.has('q') || parsed.searchParams.getAll('sl').length !== 1
      || parsed.searchParams.getAll('tl').length !== 1 || !parsed.searchParams.get('sl')
      || parsed.searchParams.get('tl') !== 'fr') throw new TypeError('Google V2 request query is malformed or unexpected.');
  if (typeof body !== 'string' || !body) throw new TypeError('Google V2 form body is empty or unavailable.');
  // URLSearchParams tolerates malformed percent escapes; reject them before decoding.
  if (/%(?![0-9a-f]{2})/i.test(body)) throw new TypeError('Google V2 form body has malformed percent encoding.');
  const pairs = body.split('&').map(pair => {
    const separator = pair.indexOf('=');
    if (separator < 0) throw new TypeError('Google V2 form body has malformed field encoding.');
    try {
      return [decodeURIComponent(pair.slice(0, separator).replaceAll('+', ' ')),
        decodeURIComponent(pair.slice(separator + 1).replaceAll('+', ' '))];
    } catch { throw new TypeError('Google V2 form body has malformed percent encoding.'); }
  });
  const q = pairs.filter(([key]) => key === 'q');
  if (q.length !== 1 || !q[0][1] || pairs.length !== 1) throw new TypeError('Google V2 request requires exactly one nonempty q field.');
  const texts = q[0][1].split(GOOGLE_V2_DELIMITER);
  if (texts.some(text => !text.trim()) || texts.some(text => !/^Benchmark (?:sentence|target) \d+ has stable fixture content\.$/.test(text))) {
    throw new TypeError('Google V2 q contains empty or unknown fixture text.');
  }
  return { texts, sourceLanguage: parsed.searchParams.get('sl') ?? pairs.find(([key]) => key === 'sl')?.[1] ?? null };
}

export function mapGoogleV2Response(texts) {
  if (!Array.isArray(texts) || !texts.length || texts.some(text => typeof text !== 'string' || !text.trim())) {
    throw new TypeError('Google V2 request must contain non-empty strings.');
  }
  const segments = [];
  texts.forEach((text, index) => {
    if (index) segments.push([GOOGLE_V2_DELIMITER, GOOGLE_V2_DELIMITER]);
    segments.push([`fixture translation: ${text}`, text, null, null, 1]);
  });
  return [segments, null, 'en'];
}
