import {
  LIVE_DUBBING_OPENAI_PROVIDER_ID,
  LIVE_DUBBING_PROVIDER_ID,
} from '../constants.js';

// Independent visible windows per kind: the muted source row and the primary
// translated row each clip against their own limit, never against the other.
export const LIVE_DUBBING_VISIBLE_CHARACTER_LIMIT = 400;
export const LIVE_DUBBING_VISIBLE_SOURCE_CHARACTER_LIMIT = 200;

export function shouldShowLiveDubbingOriginalTranscript(settings, providerId) {
  const preferenceKey = providerId === LIVE_DUBBING_PROVIDER_ID
    ? 'LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_GEMINI'
    : providerId === LIVE_DUBBING_OPENAI_PROVIDER_ID
      ? 'LIVE_DUBBING_SHOW_ORIGINAL_TRANSCRIPT_OPENAI'
      : null;
  return preferenceKey !== null && settings?.[preferenceKey] === true;
}

function joinFragments(fragments) {
  return Array.isArray(fragments) ? fragments.join('') : '';
}

function clipToVisibleWindow(text, limit) {
  if (text.length <= limit) return text;
  const suffix = text.slice(-limit);
  const boundary = suffix.search(/\s/);
  return boundary === -1 ? suffix : suffix.slice(boundary + 1);
}

export function getVisibleLiveDubbingTranscript(snapshot, limit = LIVE_DUBBING_VISIBLE_CHARACTER_LIMIT) {
  return clipToVisibleWindow(joinFragments(snapshot?.translatedFragments), limit);
}

export function getVisibleLiveDubbingSourceTranscript(snapshot, limit = LIVE_DUBBING_VISIBLE_SOURCE_CHARACTER_LIMIT) {
  return clipToVisibleWindow(joinFragments(snapshot?.sourceFragments), limit);
}
