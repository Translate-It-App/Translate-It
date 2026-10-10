const fallbackFlags = {
  en: 'gb', es: 'es', pt: 'pt', fr: 'fr', de: 'de', ru: 'ru', nl: 'nl', fa: 'ir', ja: 'jp', ko: 'kr', zh: 'cn', 'zh-cn': 'cn', 'zh-tw': 'tw',
  'zh-hk': 'hk', yue: 'hk', lzh: 'tw', ar: 'sa', he: 'il', hi: 'in', el: 'gr', da: 'dk', sv: 'se',
  uk: 'ua', cs: 'cz', et: 'ee', sl: 'si', sq: 'al', be: 'by', ka: 'ge', hy: 'am',
  ne: 'np', si: 'lk', my: 'mm', km: 'kh', lo: 'la', gu: 'in', ta: 'in', te: 'in',
  kn: 'in', ml: 'in', pa: 'in', bn: 'bd', ur: 'pk', am: 'et', om: 'et', sw: 'ke',
  ny: 'mw', st: 'za', zu: 'za', xh: 'za', af: 'za', eu: 'es', ca: 'es', co: 'fr',
  fy: 'nl', gl: 'es', haw: 'us', hmn: 'la', ig: 'ng', jw: 'id', kk: 'kz', ky: 'kg',
  lb: 'lu', mi: 'nz', sm: 'ws', gd: 'gb', sn: 'zw', su: 'id', tg: 'tj', tt: 'ru',
  uz: 'uz', yi: 'il', yo: 'ng', it: 'it', tr: 'tr', no: 'no', nb: 'no', fi: 'fi',
  pl: 'pl', ro: 'ro', hu: 'hu', sk: 'sk', th: 'th', vi: 'vn', id: 'id', ms: 'my', tl: 'ph',
  fil: 'ph', ps: 'af', mr: 'in', bg: 'bg', hr: 'hr', lv: 'lv', lt: 'lt', mt: 'mt',
  ga: 'ie', cy: 'gb', is: 'is', mk: 'mk', az: 'az', or: 'in', sr: 'rs', mn: 'mn',
  to: 'to', so: 'so', rw: 'rw', mg: 'mg', ace: 'id'
}

const regionalFlags = {
  'en-us': 'us', 'en-gb': 'gb', 'en-au': 'au', 'en-in': 'in', 'en-ca': 'ca',
  'es-es': 'es', 'es-mx': 'mx', 'es-us': 'us', 'pt-br': 'br', 'pt-pt': 'pt',
  'zh-cn': 'cn', 'zh-tw': 'tw', 'zh-hk': 'hk', 'fr-fr': 'fr', 'fr-ca': 'ca', 'de-de': 'de',
  'ar-sa': 'sa', 'ar-eg': 'eg'
}

const availableFlags = new Set('af al am au az bd bg br by ca cn cz de dk ee eg es et fi fr gb ge gr hk hr hu id ie il in ir is it jp ke kg kh kr kz la lk lu lt lv mg mk mm mn mt mw mx my ng nl no np nz ph pk pl pt ro rs ru rw sa se si sk so tj th to tr tw ua un us uz vn ws za zw'.split(' '))

export const resolveTTSFlagCode = (lang) => {
  const explicitCode = typeof lang?.flagCode === 'string' ? lang.flagCode.trim().toLowerCase() : ''
  if (explicitCode) return availableFlags.has(explicitCode) ? explicitCode : 'un'

  const code = typeof lang?.code === 'string' ? lang.code.toLowerCase().trim() : ''
  if (!code) return 'un'
  if (regionalFlags[code]) return regionalFlags[code]

  const baseLang = code.split('-')[0]
  const flagCode = fallbackFlags[code] || fallbackFlags[baseLang]
  return availableFlags.has(flagCode) ? flagCode : 'un'
}
