/**
 * usePositioning.js - Composable for position management
 * Handles viewport clamping, position updates, and responsive positioning
 */

import { ref, computed } from 'vue';

export function usePositioning(initialPosition, options = {}) {
  const {
    defaultWidth = 350,
    defaultHeight = 180,
    margin = 10,
    enableDragging = false,
    dockMode = 'none', // 'none', 'left', 'right'
    dockedWidth = 350
  } = options;
  

  // Reactive position state
  const currentPosition = ref({ x: 0, y: 0 });
  const toolbarAnchor = ref(null);
  const dragStartOffset = ref({ x: 0, y: 0 });
  const isDragging = ref(false);
  const currentDockMode = ref(dockMode);
  const currentDockedWidth = ref(dockedWidth);

  /**
   * Smart positioning: automatically find best position to keep window visible
   */
  function findSmartPosition(pos, width = defaultWidth, height = defaultHeight) {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;

    if (currentDockMode.value === 'left') {
      return { x: 0, y: 0 };
    }
    if (currentDockMode.value === 'right') {
      return { x: vw - width, y: 0 };
    }

    let x = Number.isFinite(pos.x ?? pos.left) ? (pos.x ?? pos.left) : 0;
    let y = Number.isFinite(pos.y ?? pos.top) ? (pos.y ?? pos.top) : 0;

    const anchor = pos._toolbarRect;
    const usableAnchor = anchor && ['left', 'top', 'right', 'bottom', 'width', 'height']
      .every((key) => Number.isFinite(anchor[key])) && anchor.width > 0 && anchor.height > 0;
    if (currentDockMode.value === 'none' && usableAnchor && width > 0 && height > 0) {
      const gap = 8;
      const below = anchor.bottom + gap;
      const above = anchor.top - height - gap;
      const belowSpace = vh - anchor.bottom - gap;
      const aboveSpace = anchor.top - gap;
      y = belowSpace >= height + margin
        ? below
        : aboveSpace >= height + margin || aboveSpace >= belowSpace ? above : below;
      x = anchor.left + (anchor.width - width) / 2;
      // Anchored placement clamps around the toolbar; cursor-side flipping would jump an extra window width.
      return {
        x: Math.max(margin, Math.min(x, vw - width - margin)),
        y: Math.max(margin, Math.min(y, vh - height - margin)),
      };
    }

    // Smart horizontal positioning
    if (x + width + margin > vw) {
      // Window would overflow right - try positioning to the left of cursor
      const leftPosition = x - width - margin;
      if (leftPosition >= margin) {
        x = leftPosition; // Position to left
      } else {
        // Not enough space on left either - position at right edge
        x = vw - width - margin;
      }
    }

    // Smart vertical positioning
    if (y + height + margin > vh) {
      // Window would overflow bottom - try positioning above cursor
      const topPosition = y - height - margin;
      if (topPosition >= margin) {
        y = topPosition; // Position above
      } else {
        // Not enough space above either - position at bottom edge
        y = vh - height - margin;
      }
    }

    // Final bounds check to ensure minimum margins
    x = Math.max(margin, Math.min(x, vw - width - margin));
    y = Math.max(margin, Math.min(y, vh - height - margin));

    return { x, y };
  }

  /**
   * Clamp position to viewport bounds (legacy method)
   */
  function clampToViewport(pos, width = defaultWidth, height = defaultHeight) {
    // Use smart positioning for better UX
    return findSmartPosition(pos, width, height);
  }

  /**
   * Update position with viewport clamping
   */
  function updatePosition(newPosition, dimensions) {
    if (newPosition?._toolbarRect) toolbarAnchor.value = newPosition._toolbarRect;
    const preserveInitialAnchor = newPosition === currentPosition.value && currentDockMode.value === 'none';
    if (!newPosition?._toolbarRect && !preserveInitialAnchor) toolbarAnchor.value = null;
    currentPosition.value = clampToViewport(
      preserveInitialAnchor ? { ...newPosition, _toolbarRect: toolbarAnchor.value } : newPosition,
      dimensions?.width,
      dimensions?.height,
    );
  }

  /**
   * Initialize position
   */
  function initializePosition(pos) {
    toolbarAnchor.value = pos._toolbarRect || null;
    const originalX = pos.x ?? pos.left ?? 0;
    const originalY = pos.y ?? pos.top ?? 0;
    
    let viewportPosition;
    
    // Check if position is already viewport-relative (iframe adjusted positions)
    if (pos._isViewportRelative) {
      // Position is already viewport-relative, don't subtract scroll
      viewportPosition = {
        x: originalX,
        y: originalY,
        _toolbarRect: pos._toolbarRect
      };
    } else {
      // Convert absolute coordinates to viewport-relative for fixed positioning
      viewportPosition = {
        x: originalX - window.scrollX,
        y: originalY - window.scrollY
      };
    }
    
    currentPosition.value = clampToViewport(viewportPosition);
  }

  // Initialize with provided position
  if (initialPosition) {
    initializePosition(initialPosition);
  }

  // Computed styles for positioning
  const positionStyle = computed(() => {
    return {
      position: 'fixed',
      left: `${currentPosition.value.x}px`,
      top: `${currentPosition.value.y}px`,
      // Width/Height handling is moved to components for better flexibility with loading states
      zIndex: 2147483647
    };
  });

  /**
   * Update dock mode and refresh position
   */
  function updateDockMode(mode) {
    if (mode !== currentDockMode.value) toolbarAnchor.value = null;
    currentDockMode.value = mode;
    const width = (mode !== 'none') ? (currentDockedWidth.value || defaultWidth) : defaultWidth;
    currentPosition.value = findSmartPosition(currentPosition.value, width);
  }

  /**
   * Update docked width and refresh position
   */
  function updateDockedWidth(width) {
    currentDockedWidth.value = width;
    if (currentDockMode.value !== 'none') {
      currentPosition.value = findSmartPosition(currentPosition.value, width);
    }
  }

  // Helper to get coordinates from mouse or touch event
  const getCoordinates = (event) => {
    if (event.touches && event.touches.length > 0) {
      return { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
    return { x: event.clientX, y: event.clientY };
  };

  // Drag handling functions
  const onDrag = (event) => {
    if (!isDragging.value) return;
    
    // For touch events, we must prevent default to stop page scrolling
    if (event.type === 'touchmove' || event.touches) {
      if (event.cancelable) {
        event.preventDefault();
      }
    }
    
    const coords = getCoordinates(event);
    const rawX = coords.x - dragStartOffset.value.x;
    const rawY = coords.y - dragStartOffset.value.y;
    
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const snapThreshold = 30; // Distance of POINTER to edge to trigger dock
    const breakThreshold = 100; // Distance of POINTER from edge to trigger undock
    
    // Snapping Logic (Based on Pointer position)
    if (currentDockMode.value === 'none') {
      if (coords.x < snapThreshold) {
        updateDockMode('left');
        return;
      } else if (coords.x > vw - snapThreshold) {
        updateDockMode('right');
        return;
      }
    } else {
      // Breakaway Logic (Undocking - Based on Pointer position)
      let shouldUndock = false;
      if (currentDockMode.value === 'left' && coords.x > breakThreshold) {
        shouldUndock = true;
      } else if (currentDockMode.value === 'right' && coords.x < vw - breakThreshold) {
        shouldUndock = true;
      }
      
      if (shouldUndock) {
        const previousMode = currentDockMode.value;
        updateDockMode('none');
        
        // Adjust drag offset so the window center stays under the cursor when undocking
        // This makes the transition feel smooth
        if (previousMode === 'left') {
          dragStartOffset.value.x = (currentDockedWidth.value || defaultWidth) / 2;
        } else {
          dragStartOffset.value.x = (currentDockedWidth.value || defaultWidth) / 2;
        }
      } else {
        // If still docked, don't update position freely (docked state handles it)
        return;
      }
    }
    
    currentPosition.value = clampToViewport({ x: rawX, y: rawY });
  };

  const teardownDragSession = () => {
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('touchmove', onDrag);
    document.removeEventListener('touchend', stopDrag);
    document.removeEventListener('touchcancel', stopDrag);

    // Restore text selection
    document.body.style.userSelect = '';
  };

  const stopDrag = () => {
    isDragging.value = false;
    teardownDragSession();
  };

  const startDrag = (event) => {
    toolbarAnchor.value = null;
    isDragging.value = true;
    
    // Prevent default on touchstart to avoid scrolling/gestures
    if (event.type === 'touchstart' && event.cancelable) {
      event.preventDefault();
    }

    const coords = getCoordinates(event);
    dragStartOffset.value.x = coords.x - currentPosition.value.x;
    dragStartOffset.value.y = coords.y - currentPosition.value.y;
    
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchmove', onDrag, { passive: false });
    document.addEventListener('touchend', stopDrag);
    document.addEventListener('touchcancel', stopDrag);
    
    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
  };

  // Drag handlers object (if enabled)
  const dragHandlers = enableDragging ? {
    startDrag,
    onDrag,
    stopDrag
  } : {};

  // Responsive positioning on window resize and scroll
  let resizeTimeout;
  const handleResize = () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      currentPosition.value = clampToViewport(currentPosition.value);
    }, 100);
  };

  // Setup event listeners
  window.addEventListener('resize', handleResize);

  return {
    // State
    currentPosition,
    isDragging,
    currentDockMode,
    currentDockedWidth,
    
    // Computed
    positionStyle,
    
    // Methods
    updatePosition,
    initializePosition,
    clampToViewport,
    updateDockMode,
    updateDockedWidth,
    
    // Drag handlers (if enabled)
    ...dragHandlers,
    
    // Cleanup
    cleanup: () => {
      clearTimeout(resizeTimeout);
      window.removeEventListener('resize', handleResize);
      if (enableDragging) {
        stopDrag();
      }
    }
  };
}
