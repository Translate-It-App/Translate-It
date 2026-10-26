import { describe, expect, it } from 'vitest';
import { MessageActions } from './MessageActions.js';

describe('MessageActions provider status removal', () => {
  it('does not define or validate the removed provider status action', () => {
    expect(MessageActions).not.toHaveProperty('GET_PROVIDER_STATUS');
    expect(MessageActions.isValidAction('GET_PROVIDER_STATUS')).toBe(false);
  });

  it('defines the pending-display invalidation runtime action', () => {
    expect(MessageActions.INVALIDATE_PENDING_DISPLAY).toBe('INVALIDATE_PENDING_DISPLAY');
    expect(MessageActions.isValidAction(MessageActions.INVALIDATE_PENDING_DISPLAY)).toBe(true);
  });
});
