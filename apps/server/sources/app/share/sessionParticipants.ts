import { db } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { configuredAdministratorPublicKey } from '@/app/account/managedAccounts/policy';
import { accountDisabledKey } from '@/app/auth/accountDisable';

/** Resolve participants at the resource authority, never from a caller-supplied recipient list. */
export async function getSessionParticipantUserIds(params: { sessionId: string; tx?: Tx }): Promise<string[]> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    if (!sessionId) return [];
    const client = params.tx ?? db;
    if (configuredAdministratorPublicKey()) {
        const session = await client.session.findUnique({ where: { id: sessionId }, select: {
            accountId: true, machineId: true,
            machine: { select: { accountId: true, managedIdentityAccountId: true, revokedAt: true, replacedByMachineId: true,
                grants: { where: { dataEncryptionKey: { not: null } }, select: { accountId: true } } } },
            shares: { where: { encryptedDataKey: { not: null } }, select: { sharedWithUserId: true } },
        } });
        if (!session) return [];
        if (session.machineId && (!session.machine || session.machine.accountId !== session.accountId || session.machine.revokedAt || session.machine.replacedByMachineId)) return [];
        const grants = new Set(session.machine?.grants.map((grant) => grant.accountId) ?? []);
        const ids = new Set([session.accountId]);
        for (const share of session.shares) {
            if (session.machine?.managedIdentityAccountId && grants.has(share.sharedWithUserId)) ids.add(share.sharedWithUserId);
        }
        const disabled = await client.repeatKey.findMany({ where: { key: { in: Array.from(ids, accountDisabledKey) }, expiresAt: { gt: new Date() } }, select: { key: true } });
        const disabledKeys = new Set(disabled.map((row) => row.key));
        return Array.from(ids).filter((id) => !disabledKeys.has(accountDisabledKey(id)));
    }
    const session = await client.session.findUnique({ where: { id: sessionId }, select: {
        accountId: true, shares: { select: { sharedWithUserId: true } },
    } });
    return session ? [...new Set([session.accountId, ...session.shares.map((share) => share.sharedWithUserId)])] : [];
}
