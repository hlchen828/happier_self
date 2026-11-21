import * as privacyKit from 'privacy-kit';
import { verifyAccountContentPublicKeyBinding, type MachineKeysPublishRequest, type MachineKeyRecipient } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx, afterTx, type Tx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { accountDisabledKey } from '@/app/auth/accountDisable';
import { eventRouter } from '@/app/events/eventRouter';
import type { RecipientFilter } from '@/app/events/eventPayloadTypes';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { configuredAdministratorPublicKey } from './policy';
import { managedAccountAccess, managedMachineAccess, requireManagedAdministrator, requireManagedMachinePublisher, ManagedAccessError } from './access';

export function emitManagedAccessChanged(params: {
    accountId: string;
    cursor: number;
    machineId?: string;
    sessionId?: string;
    revoked?: boolean;
    recipientFilter?: RecipientFilter;
}): void {
    eventRouter.emitUpdate({
        userId: params.accountId,
        payload: {
            id: randomKeyNaked(12), seq: params.cursor, createdAt: Date.now(),
            body: { t: 'managed-access-changed', ...(params.machineId ? { machineId: params.machineId } : {}),
                ...(params.sessionId ? { sessionId: params.sessionId } : {}), ...(params.revoked ? { revoked: true } : {}) },
        },
        ...(params.recipientFilter ? { recipientFilter: params.recipientFilter } : {}),
    });
}

export async function disabledAccountIds(client: Tx, accountIds: string[]): Promise<Set<string>> {
    const rows = await client.repeatKey.findMany({ where: { key: { in: accountIds.map(accountDisabledKey) }, expiresAt: { gt: new Date() } }, select: { key: true } });
    const keys = new Set(rows.map((row) => row.key));
    return new Set(accountIds.filter((id) => keys.has(accountDisabledKey(id))));
}

/** Read recipients as one set. The server verifies the same signed content-key binding as clients. */
export async function machineKeyRecipients(machineId: string, client: Tx = db): Promise<MachineKeyRecipient[]> {
    const publicKey = configuredAdministratorPublicKey();
    if (!publicKey) return [];
    const administrator = await client.account.findUnique({ where: { publicKey }, select: { id: true } });
    const grants = await client.machineGrant.findMany({ where: { machineId }, select: { accountId: true } });
    const ids = [...new Set([...(administrator ? [administrator.id] : []), ...grants.map((grant) => grant.accountId)])];
    const accounts = await client.account.findMany({ where: { id: { in: ids } }, select: {
        id: true, publicKey: true, contentPublicKey: true, contentPublicKeySig: true, managedRole: true,
    } });
    const disabled = await disabledAccountIds(client, ids);
    return accounts.flatMap((account) => {
        if (disabled.has(account.id) || !account.publicKey || !account.contentPublicKey || !account.contentPublicKeySig) return [];
        if (account.id !== administrator?.id && account.managedRole !== 'member') return [];
        const recipient = { accountId: account.id, publicKey: account.publicKey,
            contentPublicKey: privacyKit.encodeBase64(account.contentPublicKey), contentPublicKeySig: privacyKit.encodeBase64(account.contentPublicKeySig) };
        return verifyAccountContentPublicKeyBinding({ signingPublicKeyHex: recipient.publicKey, contentPublicKeyB64: recipient.contentPublicKey, contentPublicKeySigB64: recipient.contentPublicKeySig }) ? [recipient] : [];
    });
}

export function decodeDataKeyEnvelope(value: string): Uint8Array<ArrayBuffer> {
    let bytes: Uint8Array;
    try { bytes = privacyKit.decodeBase64(value); } catch { throw new ManagedAccessError(400, 'invalid-key-envelope'); }
    // Existing V1 DEK envelope: version + ephemeral box key + nonce + encrypted 32-byte DEK.
    if (bytes.length !== 105 || bytes[0] !== 0) throw new ManagedAccessError(400, 'invalid-key-envelope');
    return new Uint8Array(bytes);
}

/** Incremental upsert; omissions in a history page do not revoke unrelated resource envelopes. */
export async function publishMachineKeys(accountId: string, machineId: string, input: MachineKeysPublishRequest): Promise<void> {
    await inTx(async (tx) => {
        const machine = await requireManagedMachinePublisher(accountId, machineId, tx);
        const recipients = await machineKeyRecipients(machineId, tx);
        const permitted = new Map(recipients.map((recipient) => [recipient.accountId, recipient]));
        const administratorId = (await managedAccountAccess(accountId, tx)).adminAccountId;
        for (const recipient of [...input.recipients, ...input.sessions.flatMap((session) => session.recipients)]) {
            if (!permitted.has(recipient.accountId)) throw new ManagedAccessError(403, 'recipient-not-authorized');
            decodeDataKeyEnvelope(recipient.dataEncryptionKey);
        }
        const sessionIds = [...new Set(input.sessions.map((session) => session.sessionId))];
        const sessions = await tx.session.findMany({ where: { id: { in: sessionIds }, machineId, accountId: machine.accountId }, select: { id: true } });
        if (sessions.length !== sessionIds.length) throw new ManagedAccessError(403, 'session-machine-mismatch');
        const existingGrants = await tx.machineGrant.findMany({ where: { machineId }, select: { accountId: true, dataEncryptionKey: true } });
        const grantsByAccount = new Map(existingGrants.map((grant) => [grant.accountId, grant]));
        const existingShares = await tx.sessionShare.findMany({ where: { sessionId: { in: sessionIds } }, select: { sessionId: true, sharedWithUserId: true, encryptedDataKey: true } });
        const sharesByKey = new Map(existingShares.map((share) => [`${share.sessionId}:${share.sharedWithUserId}`, share]));
        const changed = new Map<string, number>();
        for (const recipient of input.recipients) {
            const dataEncryptionKey = decodeDataKeyEnvelope(recipient.dataEncryptionKey);
            const current = grantsByAccount.get(recipient.accountId);
            if (current?.dataEncryptionKey && Buffer.from(current.dataEncryptionKey).equals(dataEncryptionKey)) continue;
            if (!current && recipient.accountId !== administratorId) throw new ManagedAccessError(403, 'recipient-not-authorized');
            await tx.machineGrant.upsert({ where: { machineId_accountId: { machineId, accountId: recipient.accountId } },
                create: { machineId, accountId: recipient.accountId, dataEncryptionKey }, update: { dataEncryptionKey } });
            changed.set(recipient.accountId, await markAccountChanged(tx, { accountId: recipient.accountId, kind: 'machine', entityId: machineId }));
        }
        for (const session of input.sessions) {
            for (const recipient of session.recipients) {
                const dataEncryptionKey = decodeDataKeyEnvelope(recipient.dataEncryptionKey);
                const current = sharesByKey.get(`${session.sessionId}:${recipient.accountId}`);
                if (current?.encryptedDataKey && Buffer.from(current.encryptedDataKey).equals(dataEncryptionKey)) continue;
                await tx.sessionShare.upsert({ where: { sessionId_sharedWithUserId: { sessionId: session.sessionId, sharedWithUserId: recipient.accountId } },
                    create: { sessionId: session.sessionId, sharedByUserId: machine.accountId, sharedWithUserId: recipient.accountId,
                        accessLevel: 'admin', canApprovePermissions: true, encryptedDataKey: dataEncryptionKey },
                    update: { encryptedDataKey: dataEncryptionKey, accessLevel: 'admin', canApprovePermissions: true } });
                changed.set(recipient.accountId, await markAccountChanged(tx, { accountId: recipient.accountId, kind: 'session', entityId: session.sessionId }));
            }
        }
        afterTx(tx, () => { for (const [recipientId, cursor] of changed) emitManagedAccessChanged({ accountId: recipientId, cursor, machineId }); });
    });
}

/** Validate the entire set before any writes, through indexed Machine and Account identities. */
export async function requireGrantableManagedMachines(administratorId: string, machineIds: readonly string[], tx: Tx) {
    await requireManagedAdministrator(administratorId, tx);
    const ids = [...new Set(machineIds)];
    const machines = await tx.machine.findMany({ where: { id: { in: ids }, revokedAt: null, replacedByMachineId: null },
        select: { id: true, accountId: true, managedIdentityAccountId: true } });
    const ownerIds = [...new Set(machines.map((machine) => machine.accountId))];
    const owners = await tx.account.findMany({ where: { id: { in: ownerIds }, managedRole: 'machine' }, select: { id: true } });
    const permittedOwners = new Set(owners.map((owner) => owner.id));
    const disabled = await disabledAccountIds(tx, [administratorId, ...ownerIds]);
    if (disabled.has(administratorId)) throw new ManagedAccessError(403, 'administrator-required');
    if (machines.length !== ids.length || machines.some((machine) => machine.managedIdentityAccountId !== machine.accountId
        || !permittedOwners.has(machine.accountId) || disabled.has(machine.accountId))) {
        throw new ManagedAccessError(404, 'machine-not-found');
    }
    return machines;
}

/** One grant writer serves direct assignments and invitation redemption in the caller's transaction. */
export async function grantMachines(administratorId: string, machineIds: readonly string[], accountId: string, tx: Tx) {
    const machines = await requireGrantableManagedMachines(administratorId, machineIds, tx);
    const member = await managedAccountAccess(accountId, tx);
    if (member.role !== 'member' || (await disabledAccountIds(tx, [accountId])).has(accountId)) throw new ManagedAccessError(403, 'member-not-eligible');
    const current = await tx.machineGrant.findMany({ where: { machineId: { in: machines.map((machine) => machine.id) }, accountId },
        select: { machineId: true, dataEncryptionKey: true } });
    const grants = new Map(current.map((grant) => [grant.machineId, grant]));
    const results = [];
    for (const machine of machines) {
        const existing = grants.get(machine.id);
        if (!existing) {
            await tx.machineGrant.create({ data: { machineId: machine.id, accountId } });
            const cursor = await markAccountChanged(tx, { accountId, kind: 'machine', entityId: machine.id });
            const ownerCursor = await markAccountChanged(tx, { accountId: machine.accountId, kind: 'machine', entityId: machine.id });
            afterTx(tx, () => {
                emitManagedAccessChanged({ accountId, cursor, machineId: machine.id });
                emitManagedAccessChanged({ accountId: machine.accountId, cursor: ownerCursor, machineId: machine.id, recipientFilter: { type: 'machine-only', machineId: machine.id } });
            });
        }
        results.push({ machineId: machine.id, accountId, status: existing?.dataEncryptionKey ? 'ready' as const : 'pending' as const });
    }
    return results;
}

export async function grantMachine(administratorId: string, machineId: string, accountId: string) {
    return inTx(async (tx) => (await grantMachines(administratorId, [machineId], accountId, tx))[0]);
}

export async function revokeMachine(administratorId: string, machineId: string, accountId: string): Promise<void> {
    await inTx(async (tx) => {
        await requireManagedAdministrator(administratorId, tx);
        const machine = await managedMachineAccess(administratorId, machineId, tx);
        if (!machine) throw new ManagedAccessError(404, 'machine-not-found');
        if ((await managedAccountAccess(accountId, tx)).role !== 'member') throw new ManagedAccessError(403, 'member-required');
        const removed = await tx.machineGrant.deleteMany({ where: { machineId, accountId } });
        if (!removed.count) return;
        const shares = await tx.sessionShare.findMany({ where: { sharedWithUserId: accountId, session: { machineId } }, select: { sessionId: true } });
        await tx.sessionShare.deleteMany({ where: { sharedWithUserId: accountId, sessionId: { in: shares.map((share) => share.sessionId) } } });
        for (const share of shares) await markAccountChanged(tx, { accountId, kind: 'session', entityId: share.sessionId });
        const cursor = await markAccountChanged(tx, { accountId, kind: 'machine', entityId: machineId });
        const ownerCursor = await markAccountChanged(tx, { accountId: machine.machine.accountId, kind: 'machine', entityId: machineId });
        afterTx(tx, () => { emitManagedAccessChanged({ accountId, cursor, machineId, revoked: true }); emitManagedAccessChanged({ accountId: machine.machine.accountId, cursor: ownerCursor, machineId, recipientFilter: { type: 'machine-only', machineId } }); eventRouter.disconnectAccount(accountId); });
    });
}
