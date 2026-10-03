import { nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';

const logger = getScopedLogger(LOG_COMPONENTS.UI, 'HighlightManager');

/**
 * Route-driven run ownership. Every checkAndHighlight() takes the next
 * generation; a run that finds itself stale after ANY async boundary goes
 * inert before touching the DOM or the URL. Navigation is global, so the
 * token lives at module scope: a newer navigation always wins, no matter
 * which instance started the older run. Manual highlightElement() never
 * takes or checks a generation and is unaffected.
 */
let highlightRunId = 0;

/**
 * Bounded wait for a spotlight target to exist in the DOM.
 *
 * Async-loaded settings panels (defineAsyncComponent) and transitions can
 * mount after the route-driven highlight fires, so a fixed delay always
 * loses eventually. This bound (~1500ms) replaces timing guesses with
 * readiness detection. Never polls.
 */
export const HIGHLIGHT_ELEMENT_TIMEOUT_MS = 1500;

/**
 * Resolves with the target element once present, or with null after the
 * bounded wait. Returns immediately when already present. Always
 * disconnects the observer and clears the timeout on settle.
 *
 * @param {string} elementId - The ID of the element to wait for
 * @returns {Promise<Element|null>} The element, or null on timeout
 */
const waitForElement = (elementId) => new Promise((resolve) => {
  const existing = document.getElementById(elementId);
  if (existing) {
    resolve(existing);
    return;
  }

  let settled = false;
  const settle = (element) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    observer.disconnect();
    resolve(element);
  };

  const observer = new MutationObserver(() => {
    const element = document.getElementById(elementId);
    if (element) settle(element);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const timeoutId = setTimeout(() => {
    logger.warn(`Timed out waiting for highlight target "${elementId}".`);
    settle(null);
  }, HIGHLIGHT_ELEMENT_TIMEOUT_MS);
});

/**
 * Composable to handle spotlighting/highlighting specific elements in the options page.
 * It looks for a 'highlight' query parameter in the URL and applies an animation to the target element.
 */
export function useHighlightManager() {
  const route = useRoute();
  const router = useRouter();

  /**
   * Internal helper to perform the scroll and animation.
   * Awaits target readiness (async panels/transitions) instead of assuming
   * presence. The optional staleness guard runs after the wait but BEFORE
   * any scrolling/highlighting, so a superseded route-driven run goes inert
   * before its visual highlight. Scroll/animation timing below is untouched.
   */
  const applyHighlight = async (elementId, isStale = () => false) => {
    const element = await waitForElement(elementId);
    if (!element || isStale()) return;

    // 1. Scroll into view
    logger.debug(`Scrolling to element: ${elementId}`);
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });

    // 2. Apply highlight class
    // Wait for scroll to finish approximately
    setTimeout(() => {
      logger.debug(`Applying highlight animation to: ${elementId}`);
      element.classList.add('is-highlighting');

      // 3. Remove highlight class after animation finishes (matches CSS duration)
      setTimeout(() => {
        element.classList.remove('is-highlighting');
        logger.debug(`Highlight class removed from: ${elementId}`);
      }, 3600);
    }, 500);
  };

  /**
   * Manually trigger a highlight on a specific element ID.
   * Useful for programmatic highlighting (e.g., when a setting is missing).
   * 
   * @param {string} elementId - The ID of the element to highlight
   */
  const highlightElement = async (elementId) => {
    if (!elementId) return;
    logger.debug(`Manual highlight requested for: ${elementId}`);
    await applyHighlight(elementId);
  };

  /**
   * Checks the current route for a highlight parameter and performs the reveal/scroll/highlight sequence.
   * @param {Object} options Configuration options
   * @param {Function} options.revealAction Optional callback to open accordions or parents before highlighting
   */
  const checkAndHighlight = async (options = {}) => {
    const targetId = route.query.highlight;
    if (!targetId) return;

    // Take ownership: any older run still in flight goes stale.
    highlightRunId += 1;
    const runId = highlightRunId;
    // Current only while no newer navigation started AND the URL still asks
    // for this run's own target (covers the param being cleared externally
    // without a newer run).
    const isCurrentRun = () => runId === highlightRunId && route.query.highlight === targetId;

    logger.debug(`Target highlight detected from URL: ${targetId}`);

    // Wait for the next tick to ensure components are mounted
    await nextTick();
    if (!isCurrentRun()) return;

    // Unified Reveal Logic
    const globalReveal = (id) => {
      if (id.startsWith('PROXY_')) return 'proxy';
      if (id === 'DEBUG_MODE' || id.startsWith('LOG_LEVEL_')) return 'debug';
      if (id.startsWith('DICTIONARY_')) return 'dictionary';
      if (id.startsWith('BILINGUAL_')) return 'bilingual';
      if (id.startsWith('FAB_')) return 'fab';
      if (id === 'WHOLE_PAGE_AUTO_TRANSLATE_RULES') return 'wholePageRules';
      if (id.startsWith('AI_OPT_')) return 'ai';
      
      return null;
    };

    const accordionToOpen = globalReveal(targetId);
    
    if (accordionToOpen || typeof options.revealAction === 'function') {
      logger.debug(`Attempting to reveal: ${targetId}`);
      
      if (typeof options.revealAction === 'function') {
        options.revealAction(targetId);
      } else if (accordionToOpen) {
        window.dispatchEvent(new CustomEvent('options-reveal-accordion', { detail: accordionToOpen }));
      }

      await nextTick();
      if (!isCurrentRun()) return;
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!isCurrentRun()) return;
    }

    // Await target readiness (async panels/transitions) BEFORE cleaning the
    // query param, so a slow mount can never lose the spotlight. The guard
    // makes the staleness check land before the visual highlight itself.
    await applyHighlight(targetId, () => !isCurrentRun());

    // A stale run must never delete a newer navigation's highlight param.
    if (!isCurrentRun()) return;

    // Clean up URL
    const newQuery = { ...route.query };
    delete newQuery.highlight;
    router.replace({ query: newQuery });
  };

  return {
    checkAndHighlight,
    highlightElement
  };
}
