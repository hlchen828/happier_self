import { requireOptionalNativeModule } from 'expo-modules-core';

import { setBackgroundSyncServiceRunning } from '@/sync/runtime/connectivity/backgroundSyncService';

export type AndroidPetOverlayState = Readonly<{
    running: boolean;
    starting: boolean;
    checking: boolean;
    stopping: boolean;
    permissionGranted: boolean;
    available: boolean;
    error: string | null;
}>;

export type AndroidPetOverlayAction = Readonly<{
    type: 'open' | 'openSession' | 'dismiss';
    sessionId?: string;
    dismissKey?: string;
}>;

type NativeState = Pick<AndroidPetOverlayState, 'running' | 'permissionGranted'>;
type PetOverlayNativeModule = {
    getState: () => Promise<NativeState>;
    requestPermission: () => Promise<void>;
    start: (payload: string) => Promise<NativeState>;
    stop: () => Promise<void>;
    update: (payload: string) => Promise<void>;
    takePendingActions: () => Promise<AndroidPetOverlayAction[]>;
    addListener: (name: string, listener: (value: any) => void) => { remove: () => void };
};

let state: AndroidPetOverlayState = {
    running: false, starting: false, checking: false, stopping: false, permissionGranted: false, available: false, error: null,
};
let nativeModule: PetOverlayNativeModule | null = null;
let generation = 0;
let startInFlight: Promise<void> | null = null;
let stopInFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(delta: Partial<AndroidPetOverlayState>): void {
    const next = { ...state, ...delta };
    if (Object.keys(next).every((key) => next[key as keyof AndroidPetOverlayState] === state[key as keyof AndroidPetOverlayState])) return;
    state = next;
    setBackgroundSyncServiceRunning(state.running && !state.stopping);
    for (const listener of listeners) listener();
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function getAndroidPetOverlayState(): AndroidPetOverlayState {
    return state;
}

export function subscribeAndroidPetOverlay(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function initializeAndroidPetOverlay(onAction: (action: AndroidPetOverlayAction) => void): () => void {
    nativeModule = requireOptionalNativeModule<PetOverlayNativeModule>('HappierPetOverlay');
    publish({ available: nativeModule !== null });
    if (!nativeModule) return () => undefined;
    let active = true;
    const native = nativeModule;
    const observedGeneration = generation;
    const stateSubscription = native.addListener('onStateChanged', (value: NativeState) => {
        if (active) publish({ ...value, starting: value.running ? false : state.starting });
    });
    const actionSubscription = native.addListener('onAction', (action: AndroidPetOverlayAction) => {
        if (active) onAction(action);
    });
    const errorSubscription = native.addListener('onError', (value: { message: string }) => {
        if (active) publish({ error: value.message, running: false, starting: false });
    });
    void native.getState().then((value) => {
        if (active && generation === observedGeneration) publish(value);
        return native.takePendingActions();
    }).then((actions) => {
        if (active) for (const action of actions) onAction(action);
    }).catch((error) => {
        if (active) publish({ error: errorMessage(error) });
    });
    return () => {
        active = false;
        stateSubscription.remove();
        actionSubscription.remove();
        errorSubscription.remove();
        void stopAndroidPetOverlay();
    };
}

export async function refreshAndroidPetOverlayState(): Promise<void> {
    if (!nativeModule) return;
    const observedGeneration = generation;
    try {
        const value = await nativeModule.getState();
        if (generation === observedGeneration) publish(value);
    } catch (error) {
        publish({ error: errorMessage(error) });
    }
}

export async function requestAndroidPetOverlayStart(): Promise<void> {
    if (!nativeModule || state.running || state.starting || state.checking || state.stopping) return;
    const currentGeneration = ++generation;
    publish({ checking: true, error: null });
    try {
        const current = await nativeModule.getState();
        if (currentGeneration !== generation) return;
        publish({ ...current, checking: false, starting: current.permissionGranted && !current.running });
        if (!current.permissionGranted) {
            publish({ starting: false });
            await nativeModule.requestPermission();
        }
    } catch (error) {
        if (currentGeneration === generation) publish({ checking: false, starting: false, error: errorMessage(error) });
        throw error;
    }
}

export function failAndroidPetOverlayStart(error: unknown): void {
    publish({ starting: false, error: errorMessage(error) });
}

export async function syncAndroidPetOverlay(payload: string): Promise<void> {
    const native = nativeModule;
    if (!native || state.stopping) return;
    if (state.starting) {
        if (startInFlight) return startInFlight;
        const currentGeneration = generation;
        startInFlight = (async () => {
            try {
                const result = await native.start(payload);
                if (currentGeneration === generation) publish({ ...result, starting: false, error: null });
            } catch (error) {
                if (currentGeneration === generation) publish({ running: false, starting: false, error: errorMessage(error) });
            }
        })();
        try { await startInFlight; } finally { startInFlight = null; }
        return;
    }
    if (!state.running) return;
    try {
        await native.update(payload);
    } catch (error) {
        publish({ error: errorMessage(error) });
        await stopAndroidPetOverlay();
    }
}

export async function stopAndroidPetOverlay(): Promise<void> {
    if (stopInFlight) return stopInFlight;
    generation += 1;
    publish({ running: false, checking: false, starting: false, stopping: true });
    stopInFlight = (async () => {
        try {
            await startInFlight;
            await nativeModule?.stop();
        } catch (error) {
            publish({ error: errorMessage(error) });
        } finally {
            publish({ stopping: false });
        }
    })();
    try { await stopInFlight; } finally { stopInFlight = null; }
}
