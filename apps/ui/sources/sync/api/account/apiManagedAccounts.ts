import { z } from 'zod';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch, StaleServerGenerationError } from '@/sync/http/client';
import { getActiveServerSnapshot, type ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { HappyError } from '@/utils/errors/errors';
import {
    ManagedAccountAccessResponseSchema, ManagedMembersResponseSchema, ManagedInvitesResponseSchema,
    ManagedInviteCreateRequestSchema, ManagedInviteCreateResponseSchema, ManagedMachineGrantResponseSchema,
    ManagedMemberUpdateRequestSchema,
    type ManagedAccountAccess, type ManagedInvite, type ManagedMembersResponse,
} from '@happier-dev/protocol';

export type ManagedAdminState = Readonly<{
    access: ManagedAccountAccess;
    members: ManagedMembersResponse['members'];
    invites: ManagedInvite[];
}>;

export function createManagedAccountClient(credentials: AuthCredentials, scope: ActiveServerSnapshot, options: Readonly<{ signal?: AbortSignal }> = {}) {
    const assertScope = () => {
        const current = getActiveServerSnapshot();
        if (current.serverId !== scope.serverId || current.serverUrl !== scope.serverUrl || current.generation !== scope.generation) {
            throw new StaleServerGenerationError();
        }
    };
    const request = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
        assertScope();
        return await serverFetch(`${scope.serverUrl.replace(/\/+$/, '')}${path}`, {
            method, signal: options.signal,
            headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }, { includeAuth: false }, async (response): Promise<unknown> => {
            if (!response.ok) throw new HappyError('Managed account operation failed', response.status >= 500, { status: response.status, kind: 'server' });
            const data: unknown = await response.json();
            assertScope();
            return data;
        });
    };
    return {
        getAccess: async () => ManagedAccountAccessResponseSchema.parse(await request('/v1/account/access')),
        getMembers: async () => ManagedMembersResponseSchema.parse(await request('/v1/account/members')).members,
        getInvites: async () => ManagedInvitesResponseSchema.parse(await request('/v1/account/invites')).invites,
        createInvite: async (input: z.input<typeof ManagedInviteCreateRequestSchema>) => {
            const { machineIds, ...invite } = ManagedInviteCreateRequestSchema.parse(input);
            // Omit empty preauthorization so older relays receive their original request shape.
            return ManagedInviteCreateResponseSchema.parse(await request('/v1/account/invites', 'POST', {
                ...invite, ...(machineIds.length > 0 ? { machineIds } : {}),
            }));
        },
        revokeInvite: async (id: string) => { await request(`/v1/account/invites/${encodeURIComponent(id)}`, 'DELETE'); },
        setMemberDisabled: async (id: string, disabled: boolean) => {
            await request(`/v1/account/members/${encodeURIComponent(id)}`, 'PATCH', ManagedMemberUpdateRequestSchema.parse({ disabled }));
        },
        grantMachine: async (machineId: string, accountId: string) => ManagedMachineGrantResponseSchema.parse(
            await request(`/v1/machines/${encodeURIComponent(machineId)}/grants/${encodeURIComponent(accountId)}`, 'PUT', {})),
        revokeMachine: async (machineId: string, accountId: string) => {
            await request(`/v1/machines/${encodeURIComponent(machineId)}/grants/${encodeURIComponent(accountId)}`, 'DELETE');
        },
    };
}

export async function loadManagedAdminState(credentials: AuthCredentials, scope: ActiveServerSnapshot, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<ManagedAdminState> {
    const client = createManagedAccountClient(credentials, scope, options);
    const access = await client.getAccess();
    if (!access.managed || access.role !== 'admin') {
        throw new HappyError('Administrator access required', false, { status: 403, kind: 'auth' });
    }
    const [members, invites] = await Promise.all([client.getMembers(), client.getInvites()]);
    return { access, members, invites };
}
