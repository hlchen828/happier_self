type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribeManagedAccessChanged(serverId: string, listener: Listener): () => void {
    const bucket = listeners.get(serverId) ?? new Set<Listener>();
    bucket.add(listener);
    listeners.set(serverId, bucket);
    return () => {
        bucket.delete(listener);
        if (bucket.size === 0) listeners.delete(serverId);
    };
}

export function notifyManagedAccessChanged(serverId: string): void {
    for (const listener of Array.from(listeners.get(serverId) ?? [])) listener();
}
