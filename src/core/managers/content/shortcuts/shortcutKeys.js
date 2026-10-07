const MODIFIER_ALIASES = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
};

function normalizeKey(key) {
  if (key === ' ') return 'space';
  const normalized = key.trim().toLowerCase();
  return normalized;
}

export function parseShortcut(shortcut) {
  const parts = String(shortcut || 'Ctrl+/').split('+');
  if (parts.length > 1 && parts.at(-1) === '' && parts.at(-2) === '') {
    parts.splice(-2, 2, '+');
  }
  const normalizedParts = parts.map(part => part.trim().toLowerCase());
  const modifiers = new Set(normalizedParts.map(part => MODIFIER_ALIASES[part]).filter(Boolean));
  const key = normalizedParts.find(part => !MODIFIER_ALIASES[part]);

  return {
    ctrl: modifiers.has('ctrl'),
    alt: modifiers.has('alt'),
    shift: modifiers.has('shift'),
    meta: modifiers.has('meta'),
    key: normalizeKey(key || '/'),
  };
}

export function shortcutEventKey(event) {
  if (!event.key || ['control', 'shift', 'alt', 'meta'].includes(event.key.toLowerCase())) return '';
  return normalizeKey(event.key);
}

export function matchesShortcutEvent(event, parsedShortcut) {
  if (!parsedShortcut || event.repeat) return false;
  return shortcutEventKey(event) === parsedShortcut.key
    && parsedShortcut.ctrl === event.ctrlKey
    && parsedShortcut.alt === event.altKey
    && parsedShortcut.shift === event.shiftKey
    && parsedShortcut.meta === event.metaKey;
}

export function shortcutKeyForEvent(event) {
  const key = shortcutEventKey(event);
  if (!key) return '';
  return [
    event.ctrlKey && 'Ctrl',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    event.metaKey && 'Meta',
    key,
  ].filter(Boolean).join('+');
}

export function canonicalShortcutKey(shortcut) {
  const parsed = parseShortcut(shortcut);
  return [
    parsed.ctrl && 'Ctrl',
    parsed.alt && 'Alt',
    parsed.shift && 'Shift',
    parsed.meta && 'Meta',
    parsed.key,
  ].filter(Boolean).join('+');
}
