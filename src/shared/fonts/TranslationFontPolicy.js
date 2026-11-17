const UNSAFE_TAGS = new Set([
  'A', 'BUTTON', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'EMBED', 'OBJECT',
]);
const SELECT_ELEMENT_FONT_SENSITIVE_TAGS = new Set(['CODE', 'PRE', 'KBD', 'SAMP']);

export function isSelectElementFontTargetSafe(target) {
  if (!target) return false;
  const tagName = target.tagName.toUpperCase();
  const className = target.getAttribute('class') || '';
  return !SELECT_ELEMENT_FONT_SENSITIVE_TAGS.has(tagName)
    && !(tagName === 'I' && target.hasAttribute('class'))
    && !target.hasAttribute('data-icon')
    && !/(?:icon|fa-)/i.test(className);
}

function hasGeneratedContent(element, pseudo) {
  const content = window.getComputedStyle(element, pseudo).content;
  return content && content !== 'none' && content !== 'normal' && content !== '""' && content !== "''";
}

function isUnsafeDescendant(element) {
  const tagName = element.tagName.toUpperCase();
  const role = element.getAttribute('role')?.toLowerCase();
  return tagName.includes('-') || UNSAFE_TAGS.has(tagName)
    || role === 'button' || role === 'link' || element.onclick !== null
    || element.getAttribute('tabindex') === '0'
    || element.isContentEditable || element.hasAttribute('contenteditable');
}

// Select Element-only fallback: font styling is scoped by its stylesheet marker,
// so safe textual descendants can be styled without relaxing the shared policy.
export function getSelectElementMixedFontTarget(textNode) {
  try {
    const parent = textNode?.parentElement;
    if (!parent || parent.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null;
    if (parent.getRootNode()?.host) return null;
    const directTextNodes = [...parent.childNodes].filter(node => node.nodeType === 3 && node.nodeValue?.trim());
    if (directTextNodes.length !== 1 || directTextNodes[0] !== textNode) return null;
    const isUnsafeContext = (element) => {
      const tagName = element.tagName.toUpperCase();
      const role = element.getAttribute('role')?.toLowerCase();
      return tagName.includes('-') || UNSAFE_TAGS.has(tagName)
        || role === 'button' || role === 'link' || element.onclick !== null
        || element.getAttribute('tabindex') === '0' || element.isContentEditable
        || element.hasAttribute('contenteditable');
    };
    for (let element = parent; element; element = element.parentElement) {
      if (isUnsafeContext(element)) return null;
    }
    if (parent.shadowRoot || parent.style.getPropertyPriority('font-family') === 'important') return null;
    if (hasGeneratedContent(parent, '::before') || hasGeneratedContent(parent, '::after')) return null;
    return parent;
  } catch {
    return null;
  }
}

export function getTranslationFontTarget(textNode) {
  try {
    const parent = textNode?.parentElement;
    if (!parent) return null;
    const meaningfulTextNodes = [...parent.childNodes].filter(
      node => node.nodeType === 3 && node.nodeValue?.trim()
    );
    if (meaningfulTextNodes.length !== 1 || meaningfulTextNodes[0] !== textNode) return null;
    const tagName = parent.tagName.toUpperCase();
    if (tagName.includes('-') || UNSAFE_TAGS.has(tagName)) return null;
    const role = parent.getAttribute('role')?.toLowerCase();
    if (role === 'button' || role === 'link' || parent.onclick !== null || parent.getAttribute('tabindex') === '0') return null;
    if (parent.isContentEditable || parent.hasAttribute('contenteditable')) return null;
    const descendants = [...parent.querySelectorAll('*')];
    if (parent.shadowRoot || descendants.some(descendant => descendant.shadowRoot || isUnsafeDescendant(descendant))) return null;
    if (parent.style.getPropertyPriority('font-family') === 'important') return null;
    if (hasGeneratedContent(parent, '::before') || hasGeneratedContent(parent, '::after')) return null;
    const parentFontFamily = window.getComputedStyle(parent).fontFamily;
    if (descendants.some(descendant => {
      if (hasGeneratedContent(descendant, '::before') || hasGeneratedContent(descendant, '::after')) return true;
      const hasMeaningfulDirectText = [...descendant.childNodes].some(
        node => node.nodeType === 3 && node.nodeValue?.trim()
      );
      return hasMeaningfulDirectText && window.getComputedStyle(descendant).fontFamily === parentFontFamily;
    })) return null;
    return parent;
  } catch {
    return null;
  }
}
