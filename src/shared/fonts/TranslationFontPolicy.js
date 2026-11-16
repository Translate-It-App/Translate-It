const UNSAFE_TAGS = new Set([
  'A', 'BUTTON', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'EMBED', 'OBJECT',
]);

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
    if (descendants.some(isUnsafeDescendant)) return null;
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
