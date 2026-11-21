import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    listeners: new Map<string, (value: any) => void>(),
    getState: vi.fn(async () => ({ running: false, permissionGranted: true })),
    start: vi.fn(async () => ({ running: true, permissionGranted: true })),
    stop: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    requestPermission: vi.fn(async () => undefined),
    takePendingActions: vi.fn(async (): Promise<Array<{ type: 'openSession'; sessionId: string }>> => []),
}));
const headless = vi.hoisted(() => new Map<string, () => () => Promise<void>>());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        AppRegistry: { registerHeadlessTask: (name: string, provider: () => () => Promise<void>) => headless.set(name, provider) },
    });
});

vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: () => ({
        ...native,
        addListener: (name: string, listener: (value: any) => void) => {
            native.listeners.set(name, listener);
            return { remove: () => native.listeners.delete(name) };
        },
    }),
}));

import {
    getAndroidPetOverlayState,
    initializeAndroidPetOverlay,
    requestAndroidPetOverlayStart,
    stopAndroidPetOverlay,
    syncAndroidPetOverlay,
} from './androidPetOverlay';
import { isBackgroundSyncServiceRunning } from '@/sync/runtime/connectivity/backgroundSyncService';

afterEach(async () => {
    await stopAndroidPetOverlay();
    vi.clearAllMocks();
});

describe('Android pet service controller', () => {
    it('does not restart after stop cancels a pending permission check', async () => {
        const dispose = initializeAndroidPetOverlay(() => undefined);
        await Promise.resolve();
        let release!: (state: { running: boolean; permissionGranted: boolean }) => void;
        native.getState.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const start = requestAndroidPetOverlayStart();
        await stopAndroidPetOverlay();
        release({ running: false, permissionGranted: true });
        await start;
        expect(getAndroidPetOverlayState().starting).toBe(false);
        expect(isBackgroundSyncServiceRunning()).toBe(false);
        dispose();
    });

    it('consumes buffered native actions once when observation resumes', async () => {
        native.takePendingActions.mockResolvedValueOnce([{ type: 'openSession', sessionId: 'session-a' }]);
        const action = vi.fn();
        const dispose = initializeAndroidPetOverlay(action);
        await vi.waitFor(() => expect(action).toHaveBeenCalledWith({ type: 'openSession', sessionId: 'session-a' }));
        expect(action).toHaveBeenCalledTimes(1);
        dispose();
    });

    it('holds the headless task until the user stops the overlay', async () => {
        const { registerAndroidPetOverlayTask } = await import('./registerAndroidPetOverlayTask');
        registerAndroidPetOverlayTask();
        const dispose = initializeAndroidPetOverlay(() => undefined);
        await Promise.resolve();
        await requestAndroidPetOverlayStart();
        let finished = false;
        const task = headless.get('HappierPetOverlay')!()().then(() => { finished = true; });
        await syncAndroidPetOverlay('{}');
        await Promise.resolve();
        expect(finished).toBe(false);
        await stopAndroidPetOverlay();
        await task;
        expect(finished).toBe(true);
        dispose();
    });

    it('grants background sync only after native start succeeds, and releases it on stop', async () => {
        const dispose = initializeAndroidPetOverlay(() => undefined);
        await Promise.resolve();
        await requestAndroidPetOverlayStart();
        expect(getAndroidPetOverlayState().starting).toBe(true);
        expect(isBackgroundSyncServiceRunning()).toBe(false);
        await syncAndroidPetOverlay('{}');
        expect(native.start).toHaveBeenCalledWith('{}');
        expect(isBackgroundSyncServiceRunning()).toBe(true);
        await stopAndroidPetOverlay();
        expect(isBackgroundSyncServiceRunning()).toBe(false);
        dispose();
    });

    it('does not retain background permission after failed start or native stop', async () => {
        const dispose = initializeAndroidPetOverlay(() => undefined);
        await Promise.resolve();
        native.start.mockRejectedValueOnce(new Error('permission revoked'));
        await requestAndroidPetOverlayStart();
        await syncAndroidPetOverlay('{}');
        expect(getAndroidPetOverlayState().running).toBe(false);
        expect(getAndroidPetOverlayState().error).toBe('permission revoked');
        expect(isBackgroundSyncServiceRunning()).toBe(false);
        await requestAndroidPetOverlayStart();
        await syncAndroidPetOverlay('{}');
        native.listeners.get('onStateChanged')?.({ running: false, permissionGranted: false });
        expect(isBackgroundSyncServiceRunning()).toBe(false);
        expect(getAndroidPetOverlayState().running).toBe(false);
        dispose();
    });
});
