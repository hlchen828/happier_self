let running = false;
const listeners = new Set<(running: boolean) => void>();

export function isBackgroundSyncServiceRunning(): boolean {
    return running;
}

export function setBackgroundSyncServiceRunning(next: boolean): void {
    if (next === running) return;
    running = next;
    for (const listener of listeners) listener(running);
}

export function subscribeBackgroundSyncService(listener: (running: boolean) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function shouldKeepBackgroundSyncActive(platform: string, persistentDesktop: boolean): boolean {
    return persistentDesktop || (platform === 'android' && running);
}
