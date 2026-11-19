import type { ManagedAccountAccess } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { accountDisabledKey } from '@/app/auth/accountDisable';
import { configuredAdministratorPublicKey, managedRoleForAccount } from './policy';

export class ManagedAccessError extends Error {
    constructor(readonly statusCode: number, readonly code: string) { super(code); this.name = code; }
}

export async function managedAccountAccess(accountId: string, client: Tx = db): Promise<ManagedAccountAccess> {
    const publicKey = configuredAdministratorPublicKey();
    if (!publicKey) return { managed: false, role: 'unmanaged', adminAccountId: null, machineId: null };
    const [account, administrator] = await Promise.all([
        client.account.findUnique({ where: { id: accountId }, select: { publicKey: true, managedRole: true, managedMachine: { select: { id: true } } } }),
        client.account.findUnique({ where: { publicKey }, select: { id: true } }),
    ]);
    return { managed: true, role: account ? managedRoleForAccount(account, publicKey) : 'unmanaged',
        adminAccountId: administrator?.id ?? null, machineId: account?.managedMachine?.id ?? null };
}

export async function requireManagedAdministrator(accountId: string, client: Tx = db): Promise<void> {
    const access = await managedAccountAccess(accountId, client);
    if (!access.managed) throw new ManagedAccessError(404, 'managed-accounts-disabled');
    if (access.role !== 'admin') throw new ManagedAccessError(403, 'administrator-required');
}

/** The single resource-grant decision used by HTTP, session access, RPC and key publication. */
export async function managedMachineAccess(accountId: string, machineId: string, client: Tx = db) {
    const machine = await client.machine.findUnique({ where: { id: machineId },
        select: { id: true, accountId: true, managedIdentityAccountId: true, revokedAt: true, replacedByMachineId: true, dataEncryptionKey: true } });
    if (!machine || machine.revokedAt || machine.replacedByMachineId) return null;
    if (!configuredAdministratorPublicKey()) return machine.accountId === accountId ? { machine, isOwner: true, dataEncryptionKey: machine.dataEncryptionKey, status: 'ready' as const } : null;
    const actor = await managedAccountAccess(accountId, client);
    if (await client.repeatKey.findFirst({ where: { key: accountDisabledKey(accountId), expiresAt: { gt: new Date() } }, select: { key: true } })) return null;
    if (actor.role === 'machine' && machine.accountId === accountId && machine.managedIdentityAccountId === accountId) {
        return { machine, isOwner: true, dataEncryptionKey: machine.dataEncryptionKey, status: 'ready' as const };
    }
    if (actor.role === 'admin' && machine.accountId === accountId) return { machine, isOwner: true, dataEncryptionKey: machine.dataEncryptionKey, status: 'ready' as const };
    if (actor.role !== 'admin' && actor.role !== 'member') return null;
    const grant = await client.machineGrant.findUnique({ where: { machineId_accountId: { machineId, accountId } }, select: { dataEncryptionKey: true } });
    if (!grant && actor.role !== 'admin') return null;
    if (!machine.managedIdentityAccountId) return null;
    return { machine, isOwner: false, dataEncryptionKey: grant?.dataEncryptionKey ?? null, status: grant?.dataEncryptionKey ? 'ready' as const : 'pending' as const };
}

export async function requireManagedMachinePublisher(accountId: string, machineId: string, client: Tx = db) {
    const access = await managedMachineAccess(accountId, machineId, client);
    const actor = await managedAccountAccess(accountId, client);
    if (!access || (actor.role !== 'admin' && !(actor.role === 'machine' && access.isOwner))) throw new ManagedAccessError(403, 'machine-publisher-required');
    return access.machine;
}

export async function managedSessionAccess(accountId: string, sessionId: string, client: Tx = db) {
    const session = await client.session.findUnique({ where: { id: sessionId }, select: { accountId: true, machineId: true } });
    if (!session) return null;
    if (!configuredAdministratorPublicKey()) return { session, machineAccess: null };
    if (!session.machineId) return session.accountId === accountId && (await managedAccountAccess(accountId, client)).role === 'admin' ? { session, machineAccess: null } : null;
    const machineAccess = await managedMachineAccess(accountId, session.machineId, client);
    if (!machineAccess || machineAccess.status !== 'ready' || machineAccess.machine.accountId !== session.accountId) return null;
    return { session, machineAccess };
}
