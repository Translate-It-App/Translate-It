import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('vue', async importOriginal => ({
  ...await importOriginal(),
  onMounted: vi.fn(),
}));

vi.mock('vue-sonner', () => ({ toast }));
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ debug: vi.fn() }),
}));

import { useContentAppNotifications } from './useContentAppNotifications.js';

describe('useContentAppNotifications presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.translateItShownNotifications = new Set();
    window.translateItDismissedNotifications = new Set();
    window.translateItToastStates = new Map();
  });

  const createHandler = () => useContentAppNotifications({
    shouldShowGlobalUI: { value: true },
    toastRTL: { value: false },
    tracker: { addEventListener: vi.fn() },
  }).handleShowNotification;

  it('presents distinct attempt-owned token confirmations with the same message and type', async () => {
    const handleShowNotification = createHandler();
    const detail = {
      message: 'This provider uses tokens. Continue?',
      type: 'warning',
      duration: Infinity,
      persistent: true,
    };

    await handleShowNotification({ ...detail, id: 'page-translation-token-warning-attempt-a' });
    await handleShowNotification({ ...detail, id: 'page-translation-token-warning-attempt-b' });

    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(toast.warning.mock.calls.map(([, options]) => options.id)).toEqual([
      'page-translation-token-warning-attempt-a',
      'page-translation-token-warning-attempt-b',
    ]);
  });

  it('continues deduplicating ordinary notifications by message and type', async () => {
    const handleShowNotification = createHandler();
    const detail = { message: 'Saved', type: 'success', duration: 4000 };

    await handleShowNotification({ ...detail, id: 'ordinary-a' });
    await handleShowNotification({ ...detail, id: 'ordinary-b' });

    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
