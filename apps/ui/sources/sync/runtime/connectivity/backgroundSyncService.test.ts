import { describe, expect, it, vi } from 'vitest';

import {
    isBackgroundSyncServiceRunning,
    setBackgroundSyncServiceRunning,
    subscribeBackgroundSyncService,
    shouldKeepBackgroundSyncActive,
} from './backgroundSyncService';

describe('background sync service lifetime', () => {
    it('allows Android background sync only while the service is actually running', () => {
        setBackgroundSyncServiceRunning(false);
        expect(shouldKeepBackgroundSyncActive('android', false)).toBe(false);
        setBackgroundSyncServiceRunning(true);
        expect(isBackgroundSyncServiceRunning()).toBe(true);
        expect(shouldKeepBackgroundSyncActive('android', false)).toBe(true);
        expect(shouldKeepBackgroundSyncActive('ios', false)).toBe(false);
        expect(shouldKeepBackgroundSyncActive('web', false)).toBe(false);
        expect(shouldKeepBackgroundSyncActive('web', true)).toBe(true);
        setBackgroundSyncServiceRunning(false);
        expect(shouldKeepBackgroundSyncActive('android', false)).toBe(false);
    });

    it('notifies start and stop exactly once and releases subscribers', () => {
        setBackgroundSyncServiceRunning(false);
        const listener = vi.fn();
        const unsubscribe = subscribeBackgroundSyncService(listener);
        setBackgroundSyncServiceRunning(true);
        setBackgroundSyncServiceRunning(true);
        setBackgroundSyncServiceRunning(false);
        expect(listener.mock.calls).toEqual([[true], [false]]);
        unsubscribe();
        setBackgroundSyncServiceRunning(true);
        expect(listener).toHaveBeenCalledTimes(2);
        setBackgroundSyncServiceRunning(false);
    });
});
