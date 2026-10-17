import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRouter } from './MessageRouter.js';
import { WindowsConfig } from '../core/WindowsConfig.js';

describe('MessageRouter', () => {
  let messageRouter;
  let mockFrameRegistry;
  let mockOptions;
  let addEventListenerSpy;
  let removeEventListenerSpy;

  beforeEach(() => {
    mockFrameRegistry = {
      frameId: 'test-frame-1',
      isInIframe: false,
      handleFrameRegistration: vi.fn()
    };

    mockOptions = {
      onOutsideClick: vi.fn(),
      onWindowCreationRequest: vi.fn(),
      onWindowCreatedResponse: vi.fn(),
      onBroadcastStateChange: vi.fn()
    };

    addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

    // Reset global broadcast count
    delete window.translateItBroadcastCount;

    messageRouter = new MessageRouter(mockFrameRegistry, mockOptions);
    messageRouter.setHandlers(mockOptions);
  });

  afterEach(() => {
    messageRouter.cleanup();
    vi.restoreAllMocks();
    delete window.translateItBroadcastCount;
  });

  describe('Initialization and Cleanup', () => {
    it('should add message event listener on construction', () => {
      expect(addEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('should remove message event listener on cleanup', () => {
      messageRouter.cleanup();
      expect(removeEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('should clear handlers on cleanup', () => {
      messageRouter.cleanup();
      expect(messageRouter.onOutsideClick).toBeNull();
      expect(messageRouter.onWindowCreationRequest).toBeNull();
    });
  });

  describe('Message Routing', () => {
    it('should ignore messages without data or type', () => {
      const event = { data: null };
      messageRouter._handleCrossFrameMessage(event);
      // No errors should occur
    });

    it('should handle REGISTER_FRAME message', () => {
      const event = {
        data: { type: WindowsConfig.CROSS_FRAME.REGISTER_FRAME }
      };
      messageRouter._handleCrossFrameMessage(event);
      expect(mockFrameRegistry.handleFrameRegistration).toHaveBeenCalledWith(event);
    });

    it('should handle SET_BROADCAST_REQUEST in main frame', () => {
      mockFrameRegistry.isInIframe = false;
      const broadcastSpy = vi.spyOn(messageRouter, '_broadcastToAllIframes').mockImplementation(() => {});
      
      // First request to enable
      messageRouter._handleCrossFrameMessage({
        data: { type: WindowsConfig.CROSS_FRAME.SET_BROADCAST_REQUEST, enabled: true }
      });

      expect(window.translateItBroadcastCount).toBe(1);
      expect(mockOptions.onBroadcastStateChange).toHaveBeenCalledWith(true);
      expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: WindowsConfig.CROSS_FRAME.SET_BROADCAST_APPLY,
        enabled: true
      }));

      // Second request to disable
      messageRouter._handleCrossFrameMessage({
        data: { type: WindowsConfig.CROSS_FRAME.SET_BROADCAST_REQUEST, enabled: false }
      });
      expect(window.translateItBroadcastCount).toBe(0);
      expect(mockOptions.onBroadcastStateChange).toHaveBeenCalledWith(false);
    });

    it('should ignore SET_BROADCAST_REQUEST in iframe', () => {
      mockFrameRegistry.isInIframe = true;
      messageRouter._handleCrossFrameMessage({
        data: { type: WindowsConfig.CROSS_FRAME.SET_BROADCAST_REQUEST, enabled: true }
      });
      expect(window.translateItBroadcastCount).toBeUndefined();
    });

    it('should handle SET_BROADCAST_APPLY', () => {
      const broadcastSpy = vi.spyOn(messageRouter, '_broadcastToAllIframes').mockImplementation(() => {});
      
      messageRouter._handleCrossFrameMessage({
        data: { type: WindowsConfig.CROSS_FRAME.SET_BROADCAST_APPLY, enabled: true }
      });

      expect(mockOptions.onBroadcastStateChange).toHaveBeenCalledWith(true);
      expect(broadcastSpy).toHaveBeenCalled();
    });

    it('should handle OUTSIDE_CLICK and filter messages originating from self', () => {
      const event = {
        data: { 
          type: WindowsConfig.CROSS_FRAME.OUTSIDE_CLICK,
          frameId: 'test-frame-1' // Same as current frame
        }
      };
      messageRouter._handleCrossFrameMessage(event);
      expect(mockOptions.onOutsideClick).not.toHaveBeenCalled();
    });

    it('should handle OUTSIDE_CLICK and filter messages forwarded from self', () => {
      const event = {
        data: { 
          type: WindowsConfig.CROSS_FRAME.OUTSIDE_CLICK,
          frameId: 'some-other-frame',
          forwardedFrom: 'test-frame-1' // Same as current frame
        }
      };
      messageRouter._handleCrossFrameMessage(event);
      expect(mockOptions.onOutsideClick).not.toHaveBeenCalled();
    });

    it('should handle OUTSIDE_CLICK and forward if main frame', () => {
      mockFrameRegistry.isInIframe = false;
      const forwardSpy = vi.spyOn(messageRouter, '_forwardMessageToIframes').mockImplementation(() => {});
      
      const event = {
        data: { 
          type: WindowsConfig.CROSS_FRAME.OUTSIDE_CLICK,
          frameId: 'iframe-1',
          isInIframe: true
        }
      };
      
      messageRouter._handleCrossFrameMessage(event);
      expect(mockOptions.onOutsideClick).toHaveBeenCalledWith(event);
      expect(forwardSpy).toHaveBeenCalledWith(event.data);
    });

    it('should handle CREATE_WINDOW_REQUEST in main frame', () => {
      mockFrameRegistry.isInIframe = false;
      const event = {
        data: { type: WindowsConfig.CROSS_FRAME.CREATE_WINDOW_REQUEST },
        source: 'mock-source'
      };
      messageRouter._handleCrossFrameMessage(event);
      expect(mockOptions.onWindowCreationRequest).toHaveBeenCalledWith(event.data, event.source);
    });

    it('should handle WINDOW_CREATED in target iframe', () => {
      mockFrameRegistry.isInIframe = true;
      mockFrameRegistry.frameId = 'iframe-1';
      
      const event = {
        data: { 
          type: WindowsConfig.CROSS_FRAME.WINDOW_CREATED,
          targetFrameId: 'iframe-1'
        }
      };
      
      messageRouter._handleCrossFrameMessage(event);
      expect(mockOptions.onWindowCreatedResponse).toHaveBeenCalledWith(event.data);
    });

    it('should ignore TEXT_SELECTION_WINDOW_REQUEST (relay owns this route)', () => {
      mockFrameRegistry.isInIframe = false;
      const event = {
        data: { 
          type: WindowsConfig.CROSS_FRAME.TEXT_SELECTION_WINDOW_REQUEST,
          selectedText: 'hello',
          position: { x: 0, y: 0 }
        },
        source: 'mock-source'
      };
      
      expect(() => messageRouter._handleCrossFrameMessage(event)).not.toThrow();
      expect(messageRouter.onTextSelectionWindowRequest).toBeUndefined();
    });
  });

  describe('Outbound Communication', () => {
    it('broadcastOutsideClick should send to parent if in iframe', () => {
      mockFrameRegistry.isInIframe = true;
      const parentPostMessage = vi.fn();
      vi.stubGlobal('parent', { postMessage: parentPostMessage });
      
      messageRouter.broadcastOutsideClick({ 
        target: { tagName: 'DIV', className: 'test' } 
      });

      expect(parentPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: WindowsConfig.CROSS_FRAME.OUTSIDE_CLICK,
        frameId: 'test-frame-1'
      }), '*');
    });

    it('broadcastOutsideClick forwards bounded gesture identity into the payload', () => {
      mockFrameRegistry.isInIframe = true;
      const parentPostMessage = vi.fn();
      vi.stubGlobal('parent', { postMessage: parentPostMessage });

      messageRouter.broadcastOutsideClick(
        { target: { tagName: 'DIV', className: 'test' }, pointerId: 3 },
        { pointerId: 3, fromCrossDocumentGesture: true },
      );

      const [message] = parentPostMessage.mock.calls[0];
      expect(message.pointerId).toBe(3);
      expect(message.fromCrossDocumentGesture).toBe(true);
    });

    it('broadcastOutsideClick defaults identity fields to non-suppressing values', () => {
      mockFrameRegistry.isInIframe = true;
      const parentPostMessage = vi.fn();
      vi.stubGlobal('parent', { postMessage: parentPostMessage });

      messageRouter.broadcastOutsideClick({
        target: { tagName: 'DIV', className: '' },
      });

      const [message] = parentPostMessage.mock.calls[0];
      expect(message.pointerId).toBe(null);
      expect(message.fromCrossDocumentGesture).toBe(false);
    });

    it('requestWindowCreation should send to parent', () => {
      const parentPostMessage = vi.fn();
      vi.stubGlobal('parent', { postMessage: parentPostMessage });
      
      messageRouter.requestWindowCreation('text', { x: 1, y: 1 });

      expect(parentPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: WindowsConfig.CROSS_FRAME.CREATE_WINDOW_REQUEST,
        selectedText: 'text'
      }), '*');
    });

    it('requestBroadcastChange should handle main document directly', () => {
      mockFrameRegistry.isInIframe = false;
      const handleSpy = vi.spyOn(messageRouter, '_handleBroadcastRequest');
      
      messageRouter.requestBroadcastChange(true);
      
      expect(handleSpy).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ enabled: true })
      }));
    });
  });

  describe('_broadcastToAllIframes', () => {
    it('should send message to all iframes in document', () => {
      const mockPostMessage = vi.fn();
      const mockIframe = {
        contentWindow: { postMessage: mockPostMessage }
      };
      
      vi.spyOn(document, 'querySelectorAll').mockReturnValue([mockIframe]);
      
      messageRouter._broadcastToAllIframes({ test: true });
      
      expect(mockPostMessage).toHaveBeenCalledWith({ test: true }, '*');
    });

    it('should handle iframes without contentWindow safely', () => {
      const mockIframe = {}; // No contentWindow
      vi.spyOn(document, 'querySelectorAll').mockReturnValue([mockIframe]);
      
      expect(() => {
        messageRouter._broadcastToAllIframes({ test: true });
      }).not.toThrow();
    });
  });
});
