import { ref, onMounted, onBeforeUnmount } from 'vue';
import { pageEventBus } from '@/core/PageEventBus.js';
import { SELECTION_EVENTS } from '@/features/text-selection/events/SelectionEvents.js';
import { SelectionTranslationMode } from '@/shared/config/config.js';
import { getScopedLogger } from '@/shared/logging/logger.js';
import { LOG_COMPONENTS } from '@/shared/logging/logConstants.js';
import { useResourceTracker } from '@/composables/core/useResourceTracker.js';

const logger = getScopedLogger(LOG_COMPONENTS.DESKTOP_FAB, 'useFabSelection');

/**
 * Composable for managing FAB-specific selection state and logic.
 * Decoupled from WindowsManager.
 */
export default function useFabSelection(options = {}) {
  const { onSelectionPending } = options;
  const tracker = useResourceTracker('fab-selection');

  const pendingSelection = ref({
    hasSelection: false,
    text: '',
    position: null,
    mode: SelectionTranslationMode.ON_CLICK
  });

  const handleSelectionChange = (detail) => {
    logger.debug('Received GLOBAL_SELECTION_CHANGE', { 
      text: detail?.text?.substring(0, 10), 
      mode: detail?.mode 
    });

    if (!detail || !detail.text || detail.text.trim().length === 0) {
      clearSelection();
      return;
    }

    if (detail.position == null) {
      clearSelection();
      return;
    }

    pendingSelection.value = {
      hasSelection: true,
      text: detail.text,
      position: detail.position,
      mode: detail.mode || SelectionTranslationMode.ON_CLICK
    };

    // Callback for UI effects (like waking up the FAB/starting timers)
    if (typeof onSelectionPending === 'function') {
      onSelectionPending(pendingSelection.value);
    }
  };

  const clearSelection = () => {
    logger.debug('Clearing FAB selection state');
    pendingSelection.value = {
      hasSelection: false,
      text: '',
      position: null,
      mode: SelectionTranslationMode.ON_CLICK
    };
  };

  const triggerTranslation = () => {
    if (!pendingSelection.value.hasSelection) return;

    logger.info('Triggering translation from FAB (Global Event)');
    
    // Emit global trigger event - Coordinator will handle the rest
    pageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER, {
      text: pendingSelection.value.text,
      position: pendingSelection.value.position,
      options: {
        immediate: true // Ensure window shows immediately regardless of selection mode
      }
    });

    // Reset local state for responsiveness
    clearSelection();
  };

  onMounted(() => {
    // Listen for global selection events
    tracker.addEventListener(pageEventBus, SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, handleSelectionChange);
    tracker.addEventListener(pageEventBus, SELECTION_EVENTS.GLOBAL_SELECTION_CLEAR, clearSelection);
    
    logger.debug('useFabSelection initialized and listening for global events');
  });

  // Cleanup is handled by tracker automatically on unmount if used correctly,
  // but we can explicitly call it if needed.
  onBeforeUnmount(() => {
    tracker.cleanup();
  });

  return {
    pendingSelection,
    triggerTranslation,
    clearSelection
  };
}
