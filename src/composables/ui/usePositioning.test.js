import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { usePositioning } from '@/composables/ui/usePositioning.js';

const VIEW_W = 1000;
const VIEW_H = 768;

const mouseEvent = (type, x, y) => new MouseEvent(type, {
  clientX: x,
  clientY: y,
  bubbles: true,
  cancelable: true,
});

const touchEvent = (type, x, y) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: [{ clientX: x, clientY: y }],
  });
  return event;
};

const dispatchOnDocument = (event) => document.dispatchEvent(event);

const positionings = [];
const createPositioning = (position, options) => {
  const instance = usePositioning(position, options);
  positionings.push(instance);
  return instance;
};

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: VIEW_W, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: VIEW_H, configurable: true, writable: true });
  Object.defineProperty(window, 'scrollX', { value: 0, configurable: true, writable: true });
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
  document.body.style.userSelect = '';
});

afterEach(() => {
  positionings.splice(0).forEach((instance) => instance.cleanup());
  document.body.style.userSelect = '';
});

describe('usePositioning', () => {
  describe('initial placement', () => {
    it('places the window at the provided position', () => {
      const { currentPosition } = createPositioning({ x: 100, y: 50 });
      expect(currentPosition.value).toEqual({ x: 100, y: 50 });
    });

    it('clamps positions inside the viewport margins', () => {
      const { currentPosition } = createPositioning({ x: -50, y: -20 });
      expect(currentPosition.value).toEqual({ x: 10, y: 10 });
    });

    it('brings overflowing positions back into the viewport', () => {
      const { currentPosition } = createPositioning({ x: 2000, y: 2000 });
      expect(currentPosition.value.x).toBeGreaterThanOrEqual(10);
      expect(currentPosition.value.x).toBeLessThanOrEqual(VIEW_W - 350 - 10);
      expect(currentPosition.value.y).toBeGreaterThanOrEqual(10);
      expect(currentPosition.value.y).toBeLessThanOrEqual(VIEW_H - 180 - 10);
    });

    it('keeps viewport-relative positions without scroll adjustment', () => {
      Object.defineProperty(window, 'scrollX', { value: 500, configurable: true, writable: true });
      Object.defineProperty(window, 'scrollY', { value: 300, configurable: true, writable: true });
      const { currentPosition } = createPositioning({ x: 120, y: 80, _isViewportRelative: true });
      expect(currentPosition.value).toEqual({ x: 120, y: 80 });
    });

    it('converts absolute coordinates to viewport-relative on init', () => {
      Object.defineProperty(window, 'scrollX', { value: 500, configurable: true, writable: true });
      Object.defineProperty(window, 'scrollY', { value: 300, configurable: true, writable: true });
      const { currentPosition } = createPositioning({ x: 620, y: 380 });
      expect(currentPosition.value).toEqual({ x: 120, y: 80 });
    });

    it('places a toolbar-anchored window below or above the rendered toolbar without overlap', () => {
      const anchor = { left: 300, top: 100, right: 380, bottom: 132, width: 80, height: 32 };
      const below = createPositioning({ x: 340, y: 140, _isViewportRelative: true, _toolbarRect: anchor }, {
        defaultWidth: 350, defaultHeight: 180,
      });
      expect(below.currentPosition.value).toEqual({ x: 165, y: 140 });

      const nearBottom = createPositioning({
        x: 340, y: 700, _isViewportRelative: true,
        _toolbarRect: { ...anchor, top: 680, bottom: 712 },
      }, { defaultWidth: 350, defaultHeight: 180 });
      expect(nearBottom.currentPosition.value.y).toBe(492);
    });

    it.each([
      ['left edge', { left: 0, top: 100, right: 50, bottom: 132, width: 50, height: 32 }, { x: 10, y: 140 }],
      ['right edge', { left: 950, top: 100, right: 1000, bottom: 132, width: 50, height: 32 }, { x: 640, y: 140 }],
      ['top edge', { left: 300, top: 0, right: 380, bottom: 32, width: 80, height: 32 }, { x: 165, y: 40 }],
      ['bottom edge', { left: 300, top: 700, right: 380, bottom: 732, width: 80, height: 32 }, { x: 165, y: 512 }],
    ])('keeps the rendered anchor on-screen near the %s', (_edge, anchor, expected) => {
      const { currentPosition } = createPositioning({
        x: anchor.left + anchor.width / 2,
        y: anchor.bottom + 8,
        _isViewportRelative: true,
        _toolbarRect: anchor,
      }, { defaultWidth: 350, defaultHeight: 180 });

      expect(currentPosition.value).toEqual(expected);
    });

    it('does not subtract page scroll from iframe-adjusted toolbar bounds', () => {
      Object.defineProperty(window, 'scrollX', { value: 500, configurable: true, writable: true });
      Object.defineProperty(window, 'scrollY', { value: 300, configurable: true, writable: true });
      const anchor = { left: 120, top: 40, right: 200, bottom: 72, width: 80, height: 32 };
      const { currentPosition } = createPositioning({
        x: 160, y: 80, _isViewportRelative: true, _toolbarRect: anchor,
      }, { defaultWidth: 50, defaultHeight: 40 });

      expect(currentPosition.value).toEqual({ x: 135, y: 80 });
    });

    it('clamps an anchored window to a narrow viewport while keeping it on-screen', () => {
      Object.defineProperty(window, 'innerWidth', { value: 280, configurable: true, writable: true });
      const anchor = { left: 100, top: 100, right: 180, bottom: 132, width: 80, height: 32 };
      const { currentPosition } = createPositioning({
        x: 140, y: 140, _isViewportRelative: true, _toolbarRect: anchor,
      }, { defaultWidth: 260, defaultHeight: 180 });

      expect(currentPosition.value).toEqual({ x: 10, y: 140 });
    });

    it('repositions a resized loading window around its rendered toolbar anchor', () => {
      Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true, writable: true });
      const anchor = { left: 400, top: 250, right: 480, bottom: 282, width: 80, height: 32 };
      const positioning = createPositioning({
        x: 440, y: 290, _isViewportRelative: true, _toolbarRect: anchor,
      }, { defaultWidth: 28, defaultHeight: 28 });

      expect(positioning.currentPosition.value).toEqual({ x: 426, y: 290 });
      positioning.updatePosition(positioning.currentPosition.value, { width: 350, height: 180 });

      expect(positioning.currentPosition.value).toEqual({ x: 265, y: 62 });
    });

    it('clamps an anchored resize when neither side has enough vertical space', () => {
      Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true, writable: true });
      const anchor = { left: 400, top: 250, right: 480, bottom: 282, width: 80, height: 32 };
      const positioning = createPositioning({
        x: 440, y: 290, _isViewportRelative: true, _toolbarRect: anchor,
      }, { defaultWidth: 28, defaultHeight: 28 });

      positioning.updatePosition(positioning.currentPosition.value, { width: 350, height: 260 });

      expect(positioning.currentPosition.value).toEqual({ x: 265, y: 10 });
    });

    it('does not re-anchor a resized window after an explicit unanchored update', () => {
      const anchor = { left: 400, top: 250, right: 480, bottom: 282, width: 80, height: 32 };
      const positioning = createPositioning({
        x: 440, y: 290, _isViewportRelative: true, _toolbarRect: anchor,
      }, { defaultWidth: 28, defaultHeight: 28 });

      positioning.updatePosition({ x: 100, y: 100 }, { width: 28, height: 28 });
      positioning.updatePosition(positioning.currentPosition.value, { width: 350, height: 180 });

      expect(positioning.currentPosition.value).toEqual({ x: 100, y: 100 });
    });

    it('keeps the anchor through a redundant undocked mode update before resize', () => {
      Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true, writable: true });
      const anchor = { left: 400, top: 250, right: 480, bottom: 282, width: 80, height: 32 };
      const positioning = createPositioning({
        x: 440, y: 290, _isViewportRelative: true, _toolbarRect: anchor,
      }, { defaultWidth: 28, defaultHeight: 28 });

      positioning.updateDockMode('none');
      positioning.updatePosition(positioning.currentPosition.value, { width: 350, height: 180 });

      expect(positioning.currentPosition.value).toEqual({ x: 265, y: 62 });
    });

    it('does not resurrect the anchor after docking and undocking before resize', () => {
      const anchor = { left: 400, top: 250, right: 480, bottom: 282, width: 80, height: 32 };
      const positioning = createPositioning({
        x: 440, y: 290, _isViewportRelative: true, _toolbarRect: anchor,
      }, { defaultWidth: 28, defaultHeight: 28 });

      positioning.updateDockMode('left');
      positioning.updateDockMode('none');
      positioning.updatePosition(positioning.currentPosition.value, { width: 350, height: 180 });

      expect(positioning.currentPosition.value).toEqual({ x: 10, y: 10 });
    });

    it.each([
      ['left', { x: 0, y: 0 }],
      ['right', { x: VIEW_W - 350, y: 0 }],
    ])('preserves %s dock placement through a size update', (mode, dockedPosition) => {
      const anchor = { left: 400, top: 250, right: 480, bottom: 282, width: 80, height: 32 };
      const positioning = createPositioning({
        x: 440, y: 290, _isViewportRelative: true, _toolbarRect: anchor,
      }, { defaultWidth: 28, defaultHeight: 28 });

      positioning.updateDockMode(mode);
      positioning.updatePosition(positioning.currentPosition.value, { width: 350, height: 180 });

      expect(positioning.currentPosition.value).toEqual(dockedPosition);
    });

    it('does not re-anchor a resized window after dragging starts', () => {
      const anchor = { left: 400, top: 100, right: 480, bottom: 132, width: 80, height: 32 };
      const positioning = createPositioning({
        x: 440, y: 140, _isViewportRelative: true, _toolbarRect: anchor,
      }, { defaultWidth: 28, defaultHeight: 28, enableDragging: true });

      positioning.startDrag(mouseEvent('mousedown', 440, 140));
      dispatchOnDocument(mouseEvent('mousemove', 460, 160));
      expect(positioning.currentPosition.value).toEqual({ x: 446, y: 160 });
      positioning.updatePosition(positioning.currentPosition.value, { width: 350, height: 180 });

      expect(positioning.currentPosition.value).toEqual({ x: 446, y: 160 });
      positioning.stopDrag();
    });

    it.each([
      ['missing bounds', undefined],
      ['missing coordinates', { left: 20, top: 30, width: 80, height: 32 }],
      ['NaN bounds', { left: Number.NaN, top: 30, right: 100, bottom: 62, width: 80, height: 32 }],
      ['infinite bounds', { left: 20, top: 30, right: 100, bottom: 62, width: 80, height: Number.POSITIVE_INFINITY }],
      ['zero dimensions', { left: 20, top: 30, right: 20, bottom: 30, width: 0, height: 0 }],
    ])('keeps finite placement for %s', (_label, anchor) => {
      const { currentPosition } = createPositioning({
        x: 50, y: 60, _isViewportRelative: true, _toolbarRect: anchor,
      });

      expect(Number.isFinite(currentPosition.value.x)).toBe(true);
      expect(Number.isFinite(currentPosition.value.y)).toBe(true);
    });

    it.each([
      ['NaN x', { x: Number.NaN, y: 60, _isViewportRelative: true }],
      ['infinite y', { x: 50, y: Number.POSITIVE_INFINITY, _isViewportRelative: true }],
      ['missing coordinates', { _isViewportRelative: true }],
    ])('keeps finite placement for %s original coordinates', (_label, position) => {
      const { currentPosition } = createPositioning(position);
      expect(Number.isFinite(currentPosition.value.x)).toBe(true);
      expect(Number.isFinite(currentPosition.value.y)).toBe(true);
    });
  });

  describe('mouse drag', () => {
    it('moves the window while a mouse drag is active', () => {
      const { currentPosition, isDragging, startDrag } = createPositioning(
        { x: 500, y: 300 },
        { enableDragging: true }
      );
      startDrag(mouseEvent('mousedown', 300, 200));
      expect(isDragging.value).toBe(true);
      dispatchOnDocument(mouseEvent('mousemove', 350, 250));
      expect(currentPosition.value).toEqual({ x: 550, y: 350 });
    });

    it('stops on mouseup, restores userSelect, and removes listeners', () => {
      const { currentPosition, isDragging, startDrag } = createPositioning(
        { x: 500, y: 300 },
        { enableDragging: true }
      );
      startDrag(mouseEvent('mousedown', 300, 200));
      expect(document.body.style.userSelect).toBe('none');
      dispatchOnDocument(mouseEvent('mousemove', 350, 250));
      dispatchOnDocument(mouseEvent('mouseup', 350, 250));
      expect(isDragging.value).toBe(false);
      expect(document.body.style.userSelect).toBe('');
      dispatchOnDocument(mouseEvent('mousemove', 400, 300));
      expect(currentPosition.value).toEqual({ x: 550, y: 350 });
    });
  });

  describe('touch drag', () => {
    it('moves the window on touch drag and stops on touchend', () => {
      const { currentPosition, isDragging, startDrag } = createPositioning(
        { x: 500, y: 300 },
        { enableDragging: true }
      );
      startDrag(touchEvent('touchstart', 300, 200));
      dispatchOnDocument(touchEvent('touchmove', 350, 250));
      expect(currentPosition.value).toEqual({ x: 550, y: 350 });
      dispatchOnDocument(touchEvent('touchend', 350, 250));
      expect(isDragging.value).toBe(false);
      expect(document.body.style.userSelect).toBe('');
      dispatchOnDocument(touchEvent('touchmove', 450, 350));
      expect(currentPosition.value).toEqual({ x: 550, y: 350 });
    });

    it('terminates the drag on touchcancel', () => {
      const { currentPosition, isDragging, startDrag } = createPositioning(
        { x: 500, y: 300 },
        { enableDragging: true }
      );
      startDrag(touchEvent('touchstart', 300, 200));
      dispatchOnDocument(touchEvent('touchcancel', 350, 250));
      expect(isDragging.value).toBe(false);
      expect(document.body.style.userSelect).toBe('');
      dispatchOnDocument(touchEvent('touchmove', 450, 350));
      expect(currentPosition.value).toEqual({ x: 500, y: 300 });
    });
  });

  describe('cleanup', () => {
    it('cleans up drag state and listeners during an active drag', () => {
      const { currentPosition, startDrag, cleanup, isDragging } = createPositioning(
        { x: 500, y: 300 },
        { enableDragging: true }
      );
      startDrag(touchEvent('touchstart', 300, 200));
      cleanup();
      expect(isDragging.value).toBe(false);
      expect(document.body.style.userSelect).toBe('');
      dispatchOnDocument(touchEvent('touchmove', 350, 250));
      dispatchOnDocument(touchEvent('touchend', 350, 250));
      dispatchOnDocument(touchEvent('touchcancel', 350, 250));
      expect(currentPosition.value).toEqual({ x: 500, y: 300 });
    });

    it('is safe after a completed drag session', () => {
      const { startDrag, stopDrag, cleanup } = createPositioning(
        { x: 500, y: 300 },
        { enableDragging: true }
      );
      startDrag(mouseEvent('mousedown', 300, 200));
      stopDrag();
      expect(() => cleanup()).not.toThrow();
      expect(document.body.style.userSelect).toBe('');
    });

    it('stops responding to window resize after cleanup', async () => {
      const { currentPosition, cleanup } = createPositioning({ x: 500, y: 300 });
      cleanup();
      Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true, writable: true });
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(currentPosition.value).toEqual({ x: 500, y: 300 });
    });
  });

  describe('dock behavior', () => {
    it('snaps to the left dock near the left edge', () => {
      const { currentDockMode, currentPosition, startDrag } = createPositioning(
        { x: 500, y: 300 },
        { enableDragging: true }
      );
      startDrag(mouseEvent('mousedown', 10, 200));
      dispatchOnDocument(mouseEvent('mousemove', 10, 200));
      expect(currentDockMode.value).toBe('left');
      expect(currentPosition.value).toEqual({ x: 0, y: 0 });
    });

    it('snaps to the right dock near the right edge', () => {
      const { currentDockMode, currentPosition, startDrag } = createPositioning(
        { x: 500, y: 300 },
        { enableDragging: true }
      );
      startDrag(mouseEvent('mousedown', 990, 200));
      dispatchOnDocument(mouseEvent('mousemove', 990, 200));
      expect(currentDockMode.value).toBe('right');
      expect(currentPosition.value).toEqual({ x: VIEW_W - 350, y: 0 });
    });

    it('breaks away from the dock when the pointer moves inward', () => {
      const { currentDockMode, currentPosition, startDrag } = createPositioning(
        { x: 0, y: 0 },
        { enableDragging: true, dockMode: 'left', dockedWidth: 350 }
      );
      startDrag(mouseEvent('mousedown', 200, 200));
      dispatchOnDocument(mouseEvent('mousemove', 400, 200));
      expect(currentDockMode.value).toBe('none');
      expect(currentPosition.value.x).toBeGreaterThan(100);
    });
  });
});
