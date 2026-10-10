import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError, logInfo, logStep, logSuccess } from '../shared/logger.mjs';

describe('script logger levels', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps progress neutral and does not duplicate caller ellipses', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logStep('Building Chrome extension...');
    logStep('Selecting package');

    expect(log).toHaveBeenNthCalledWith(1, '\nBuilding Chrome extension...\n');
    expect(log).toHaveBeenNthCalledWith(2, '\nSelecting package\n');
    expect(log.mock.calls.flat().join(' ')).not.toContain('✅');
  });

  it('keeps success, error, and informational messages distinct', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logSuccess('Build completed');
    logError('Build failed');
    logInfo('Using Firefox package');

    expect(log.mock.calls.map(([message]) => message)).toEqual([
      '✅ Build completed',
      '❌ Build failed',
      'ℹ️  Using Firefox package',
    ]);
  });
});
