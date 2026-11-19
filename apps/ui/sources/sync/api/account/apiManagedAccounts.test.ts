import { beforeEach, describe, expect, it, vi } from 'vitest';
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
// Network transport is the system boundary; wire schemas and role decisions remain real.
vi.mock('@/sync/http/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/sync/http/client')>(), serverFetch: network.fetch }));
import { createManagedAccountClient, loadManagedAdminState } from './apiManagedAccounts';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
const credentials = { token: 'account-token', secret: 'independent-secret' };
const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

describe('managed account administration', () => {
    beforeEach(() => { network.fetch.mockReset(); });
    it('loads canonical admin data without exposing invitation tokens from the listing', async () => {
        network.fetch.mockImplementation(async (path: string, _init: unknown, _options: unknown, consume: (response: Response) => Promise<unknown>) => {
            if (path.endsWith('/access')) return consume(reply({ managed: true, role: 'admin', adminAccountId: 'a', machineId: null }));
            if (path.endsWith('/members')) return consume(reply({ members: [{ id: 'm', name: null, publicKey: null, contentPublicKey: null, contentPublicKeySig: null, disabled: false, createdAt: 1, machineIds: ['machine-1'] }] }));
            return consume(reply({ invites: [{ id: 'i', kind: 'member', name: null, expiresAt: 100, createdAt: 1, consumedAt: null, revokedAt: null, token: 'must-not-surface' }] }));
        });
        const result = await loadManagedAdminState(credentials, getActiveServerSnapshot());
        expect(result.members[0]?.machineIds).toEqual(['machine-1']);
        expect(result.invites[0]).not.toHaveProperty('token');
    });
    it('exposes a newly created invitation once and preserves a pending grant without sending account secrets', async () => {
        network.fetch.mockImplementation(async (path: string, init: RequestInit, _options: unknown, consume: (response: Response) => Promise<unknown>) => {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            expect(body).not.toHaveProperty('secret');
            if (path.endsWith('/invites')) {
                expect(body).toEqual({ kind: 'member', expiresAt: 100, name: 'Member' });
                return consume(reply({ id: 'i', kind: 'member', expiresAt: 100, name: 'Member', createdAt: 1, token: 'new-private-invite' }));
            }
            expect(body).toEqual({});
            return consume(reply({ machineId: 'machine-1', accountId: 'm', status: 'pending' }));
        });
        const client = createManagedAccountClient(credentials, getActiveServerSnapshot());
        expect((await client.createInvite({ kind: 'member', expiresAt: 100, name: 'Member' })).token).toBe('new-private-invite');
        expect((await client.grantMachine('machine-1', 'm')).status).toBe('pending');
    });
    it('submits selected machine ids and reads preauthorization from canonical invite responses', async () => {
        network.fetch.mockImplementation(async (_path: string, init: RequestInit, _options: unknown, consume: (response: Response) => Promise<unknown>) => {
            expect(JSON.parse(String(init.body))).toEqual({ kind: 'member', expiresAt: 100, machineIds: ['machine-1'] });
            return consume(reply({ id: 'i', kind: 'member', name: null, expiresAt: 100, createdAt: 1, machineIds: ['machine-1'], token: 'one-time' }));
        });
        const result = await createManagedAccountClient(credentials, getActiveServerSnapshot()).createInvite({ kind: 'member', expiresAt: 100, machineIds: ['machine-1'] });
        expect(result.machineIds).toEqual(['machine-1']);
    });

    it('defaults old invite listings to no preauthorized machines without surfacing a token', async () => {
        network.fetch.mockImplementation(async (_path: string, _init: unknown, _options: unknown, consume: (response: Response) => Promise<unknown>) =>
            consume(reply({ invites: [{ id: 'i', kind: 'member', name: null, expiresAt: 100, createdAt: 1, consumedAt: null, revokedAt: null }] })));
        expect((await createManagedAccountClient(credentials, getActiveServerSnapshot()).getInvites())[0]?.machineIds).toEqual([]);
    });

    it('never sends a retained account token to a newly selected server', async () => {
        const origin = getActiveServerSnapshot();
        const client = createManagedAccountClient(credentials, getActiveServerSnapshot());
        try {
            upsertAndActivateServer({ serverUrl: 'http://managed-other.test:53288', scope: 'device' });
            await expect(client.grantMachine('machine-1', 'm')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
            expect(network.fetch).not.toHaveBeenCalled();
        } finally { setActiveServer({ serverId: origin.serverId, scope: 'device' }); }
    });

    it('rejects an old row callback even when it creates its client after a Home switch', async () => {
        network.fetch.mockImplementation(async (_path: string, _init: unknown, _options: unknown, consume: (response: Response) => Promise<unknown>) =>
            consume(reply({ machineId: 'machine-1', accountId: 'm', status: 'ready' })));
        const origin = getActiveServerSnapshot();
        try {
            upsertAndActivateServer({ serverUrl: 'http://managed-late-callback.test:53288', scope: 'device' });
            const lateClient = createManagedAccountClient(credentials, origin);
            await expect(lateClient.grantMachine('machine-1', 'm')).rejects.toMatchObject({ name: 'StaleServerGenerationError' });
            expect(network.fetch).not.toHaveBeenCalled();
        } finally { setActiveServer({ serverId: origin.serverId, scope: 'device' }); }
    });

    it('does not request admin data for a member account', async () => {
        network.fetch.mockImplementation(async (_path: string, _init: unknown, _options: unknown, consume: (response: Response) => Promise<unknown>) =>
            consume(reply({ managed: true, role: 'member', adminAccountId: 'a', machineId: null })));
        await expect(loadManagedAdminState(credentials, getActiveServerSnapshot())).rejects.toMatchObject({ status: 403 });
        expect(network.fetch.mock.calls.some(([path]) => String(path).endsWith('/members') || String(path).endsWith('/invites'))).toBe(false);
    });
});
