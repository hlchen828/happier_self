import { db } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { accountDisabledKey } from '@/app/auth/accountDisable';
import { configuredAdministratorPublicKey } from './policy';

/** Current ready recipients are read as a set; disabled accounts never receive live resource data. */
export async function managedMachineRecipientIds(machineId: string, client: Tx = db): Promise<string[]> {
    const publicKey = configuredAdministratorPublicKey();
    if (!publicKey) return [];
    const grants = await client.machineGrant.findMany({ where: { machineId, dataEncryptionKey: { not: null },
        machine: { managedIdentityAccountId: { not: null }, revokedAt: null, replacedByMachineId: null },
        account: { OR: [{ publicKey }, { managedRole: 'member' }] },
    }, select: { accountId: true } });
    const disabled = await client.repeatKey.findMany({ where: { key: { in: grants.map((grant) => accountDisabledKey(grant.accountId)) }, expiresAt: { gt: new Date() } }, select: { key: true } });
    const disabledKeys = new Set(disabled.map((row) => row.key));
    return grants.filter((grant) => !disabledKeys.has(accountDisabledKey(grant.accountId))).map((grant) => grant.accountId);
}

/** Content changes allocate each authorized viewer's own cursor; heartbeat publishers do not call this. */
export async function markMachineParticipantsChanged(tx: Tx, ownerAccountId: string, machineId: string): Promise<Array<{ accountId: string; cursor: number }>> {
    const ids = [...new Set([ownerAccountId, ...await managedMachineRecipientIds(machineId, tx)])];
    const cursors: Array<{ accountId: string; cursor: number }> = [];
    for (const accountId of ids) cursors.push({ accountId, cursor: await markAccountChanged(tx, { accountId, kind: 'machine', entityId: machineId }) });
    return cursors;
}
