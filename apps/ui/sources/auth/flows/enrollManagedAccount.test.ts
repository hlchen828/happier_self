import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
installTokenStorageWebPlatformMocks();
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';
import { enrollManagedAccount } from './enrollManagedAccount';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { digest } from '@/platform/digest';
import { encodeHex } from '@/encryption/hex';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

describe('managed invitation enrollment recovery', () => {
    let restoreStorage: (() => void) | undefined;
    beforeEach(() => { restoreStorage = installLocalStorageMock().restore; network.fetch.mockReset(); setRuntimeFetch(network.fetch); resetServerFeaturesClientForTests(); });
    afterEach(() => { resetRuntimeFetch(); restoreStorage?.(); });
    it('reuses the privately prepared signing identity after the server consumes an invitation but its response is lost', async () => {
        let consumedBy: string | null = null;
        const scope = getActiveServerSnapshot();
        const inviteHash = encodeHex(await digest('SHA-256', new TextEncoder().encode('single-use-invite')));
        network.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/health')) return reply({ ok: true });
            if (path.endsWith('/features')) return reply({ features: { accounts: { machineAccess: { enabled: true } }, sharing: { contentKeys: { enabled: true } } }, capabilities: {} });
            const prepared = await TokenStorage.getPreparedManagedEnrollment(scope.serverUrl, inviteHash, { serverId: scope.serverId });
            expect(prepared?.secret).toEqual(expect.any(String));
            const body = JSON.parse(String(init?.body)) as { publicKey: string };
            if (consumedBy === null) { consumedBy = body.publicKey; throw new Error('Response lost after invitation consumption'); }
            return body.publicKey === consumedBy ? reply({ token: 'member-token' }) : reply({ error: 'signup-disabled' }, 403);
        });
        await expect(enrollManagedAccount('single-use-invite')).rejects.toThrow();
        resetServerFeaturesClientForTests();
        const resumed = await enrollManagedAccount('single-use-invite');
        expect(resumed.credentials.token).toBe('member-token');
        const bodies = network.fetch.mock.calls.filter(([path]) => path.endsWith('/auth')).map(([, init]) => JSON.parse(String(init.body)) as { publicKey: string });
        expect(bodies[1]?.publicKey).toBe(bodies[0]?.publicKey);
    });
});
