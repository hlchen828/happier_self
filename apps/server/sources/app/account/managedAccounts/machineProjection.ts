import { db } from '@/storage/db';
import { MACHINE_SERIALIZATION_SELECT, serializeMachineRow } from '@/app/machines/machineSerialization';
import { managedAccountAccess, managedMachineAccess } from './access';

export async function listManagedMachines(accountId: string) {
    const actor = await managedAccountAccess(accountId);
    const grants = await db.machineGrant.findMany({ where: { accountId }, select: { machineId: true, dataEncryptionKey: true } });
    const keys = new Map(grants.map((grant) => [grant.machineId, grant.dataEncryptionKey]));
    const ownerIds = actor.role === 'admin'
        ? [accountId, ...(await db.account.findMany({ where: { managedRole: 'machine' }, select: { id: true } })).map((account) => account.id)]
        : actor.role === 'machine' ? [accountId] : [];
    const owned = ownerIds.length ? await db.machine.findMany({ where: { accountId: { in: ownerIds }, revokedAt: null, replacedByMachineId: null, ...(actor.role === 'machine' ? { managedIdentityAccountId: accountId } : {}) }, select: { ...MACHINE_SERIALIZATION_SELECT, accountId: true, managedIdentityAccountId: true }, orderBy: { lastActiveAt: 'desc' } }) : [];
    const shared = actor.role === 'member' && grants.length
        ? await db.machine.findMany({ where: { id: { in: grants.map((grant) => grant.machineId) }, revokedAt: null, replacedByMachineId: null }, select: { ...MACHINE_SERIALIZATION_SELECT, accountId: true, managedIdentityAccountId: true }, orderBy: { lastActiveAt: 'desc' } }) : [];
    return [...owned, ...shared].map((row) => {
        const key = row.accountId === accountId ? row.dataEncryptionKey : keys.get(row.id) ?? null;
        return { ...serializeMachineRow({ ...row, dataEncryptionKey: key }), managed: row.managedIdentityAccountId !== null, managedAccessStatus: key ? 'ready' as const : 'pending' as const };
    });
}

export async function readManagedMachine(accountId: string, machineId: string) {
    const access = await managedMachineAccess(accountId, machineId);
    if (!access) return null;
    const row = await db.machine.findUnique({ where: { id: machineId }, select: { ...MACHINE_SERIALIZATION_SELECT, managedIdentityAccountId: true } });
    return row ? { ...serializeMachineRow({ ...row, dataEncryptionKey: access.dataEncryptionKey }), managed: row.managedIdentityAccountId !== null, managedAccessStatus: access.status } : null;
}
