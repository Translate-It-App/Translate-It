import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { pageEventBus } from '@/core/PageEventBus.js';
import { SELECTION_EVENTS } from '@/features/text-selection/events/SelectionEvents.js';
import useFabSelection from './useFabSelection.js';

describe('useFabSelection', () => {
  let wrapper;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  const mountSelection = () => {
    let selection;
    wrapper = mount(defineComponent({
      setup() {
        selection = useFabSelection();
        return () => null;
      },
    }));
    return selection;
  };

  it('does not trigger a stale positioned selection after a fragment-only event', () => {
    const selection = mountSelection();
    const onTrigger = vi.fn();
    window.addEventListener(SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER, onTrigger);

    try {
      pageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, {
        text: 'previous selection',
        position: { x: 10, y: 20 },
      });
      pageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, {
        text: 'fragment-only selection',
        position: null,
      });

      selection.triggerTranslation();

      expect(selection.pendingSelection.value.hasSelection).toBe(false);
      expect(onTrigger).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER, onTrigger);
    }
  });

  it('triggers a valid selection with its text and position, then clears it', () => {
    const selection = mountSelection();
    const onTrigger = vi.fn();
    const position = { x: 10, y: 20 };
    window.addEventListener(SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER, onTrigger);

    try {
      pageEventBus.emit(SELECTION_EVENTS.GLOBAL_SELECTION_CHANGE, {
        text: 'selected text',
        position,
      });

      selection.triggerTranslation();

      expect(onTrigger).toHaveBeenCalledOnce();
      expect(onTrigger.mock.calls[0][0].detail).toEqual({
        text: 'selected text',
        position,
        options: { immediate: true },
      });
      expect(selection.pendingSelection.value.hasSelection).toBe(false);
    } finally {
      window.removeEventListener(SELECTION_EVENTS.GLOBAL_SELECTION_TRIGGER, onTrigger);
    }
  });
});
