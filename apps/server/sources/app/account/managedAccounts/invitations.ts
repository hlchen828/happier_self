import { createHash, randomBytes } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { ManagedInviteCreateRequestSchema, ManagedInviteMachineIdsSchema } from '@happier-dev/protocol';
import { inTx } from '@/storage/inTx';
import { isServerFeatureEnabledForRequest } from '@/app/features/catalog/serverFeatureGate';
import { ManagedAccessError, requireManagedAdministrator } from './access';
import { configuredAdministratorPublicKey } from './policy';
import { disabledAccountIds, grantMachines, requireGrantableManagedMachines } from './grants';

function invitationHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

/** Historical rows have no selection; malformed stored intent is never silently discarded. */
export function invitationMachineIds(invitation: { kind: string; machineIds?: string }): string[] {
    let value: unknown;
    try { value = JSON.parse(invitation.machineIds ?? '[]'); }
    catch { throw new ManagedAccessError(403, 'invalid-invitation'); }
    const parsed = ManagedInviteMachineIdsSchema.safeParse(value);
    if (!parsed.success || (invitation.kind !== 'member' && parsed.data.length > 0)) throw new ManagedAccessError(403, 'invalid-invitation');
    return [...new Set(parsed.data)];
}

function requireInvitationAssignmentFeature(machineIds: readonly string[]): void {
    if (machineIds.length && !isServerFeatureEnabledForRequest('accounts.inviteMachineAssignment', process.env)) {
        throw new ManagedAccessError(404, 'not_found');
    }
}

/** Store only a digest; the bearer invitation is returned once to its administrator. */
export async function createManagedInvitation(accountId: string, input: Readonly<{ kind: 'member' | 'machine'; name?: string; expiresAt: number; machineIds?: string[] }>) {
    const parsed = ManagedInviteCreateRequestSchema.safeParse(input);
    if (!parsed.success) throw new ManagedAccessError(400, 'invalid-invitation');
    const machineIds = [...new Set(parsed.data.machineIds)];
    requireInvitationAssignmentFeature(machineIds);
    return inTx(async (tx) => {
        await requireManagedAdministrator(accountId, tx);
        if (parsed.data.expiresAt <= Date.now()) throw new ManagedAccessError(400, 'invitation-expired');
        await requireGrantableManagedMachines(accountId, machineIds, tx);
        const token = privacyKit.encodeBase64(randomBytes(32), 'base64url');
        const invitation = await tx.managedAccountInvite.create({ data: {
            tokenHash: invitationHash(token), kind: parsed.data.kind, name: parsed.data.name ?? null, machineIds: JSON.stringify(machineIds),
            createdByAccountId: accountId, expiresAt: new Date(parsed.data.expiresAt),
        } });
        return { id: invitation.id, token, kind: parsed.data.kind, name: invitation.name, machineIds,
            expiresAt: invitation.expiresAt.getTime(), createdAt: invitation.createdAt.getTime() };
    });
}

/** Signature and content-public-key binding have already been verified by the key-challenge owner. */
export async function authenticateManagedAccount(input: Readonly<{
    publicKey: string; contentPublicKey: Uint8Array | null; contentPublicKeySig: Uint8Array | null; inviteToken?: string;
}>) {
    const administratorPublicKey = configuredAdministratorPublicKey();
    if (!administratorPublicKey) throw new ManagedAccessError(404, 'managed-accounts-disabled');
    return inTx(async (tx) => {
        const existing = await tx.account.findUnique({ where: { publicKey: input.publicKey } });
        if (existing && (await disabledAccountIds(tx, [existing.id])).has(existing.id)) throw new ManagedAccessError(403, 'account-disabled');
        const administrator = input.publicKey === administratorPublicKey;
        let enrollmentRetry = false;
        if (input.inviteToken !== undefined && existing && !administrator && (existing.managedRole === 'member' || existing.managedRole === 'machine')) {
            const consumed = await tx.managedAccountInvite.findUnique({ where: { tokenHash: invitationHash(input.inviteToken) },
                select: { kind: true, consumedAt: true, consumedByAccountId: true } });
            // Prepared identities resend the invitation after a lost response. This is authentication
            // of the same committed enrollment, never redemption or replay of its machine assignments.
            enrollmentRetry = consumed !== null && consumed.consumedAt !== null
                && consumed.consumedByAccountId === existing.id && consumed.kind === existing.managedRole;
        }
        // Other explicit invitations remain requested mutations, not ordinary existing-account login.
        if (input.inviteToken !== undefined && !enrollmentRetry && (administrator || existing?.managedRole === 'machine')) throw new ManagedAccessError(403, 'invitation-role-mismatch');
        if ((input.inviteToken === undefined || enrollmentRetry) && existing && (administrator || existing.managedRole === 'member' || existing.managedRole === 'machine')) {
            if (!input.contentPublicKey || !input.contentPublicKeySig) return existing;
            return tx.account.update({ where: { id: existing.id }, data: {
                contentPublicKey: new Uint8Array(input.contentPublicKey), contentPublicKeySig: new Uint8Array(input.contentPublicKeySig),
            } });
        }
        if (administrator && !existing) {
            if (!input.contentPublicKey || !input.contentPublicKeySig) throw new ManagedAccessError(400, 'content-key-required');
            return tx.account.create({ data: { publicKey: input.publicKey, encryptionMode: 'e2ee',
                contentPublicKey: new Uint8Array(input.contentPublicKey), contentPublicKeySig: new Uint8Array(input.contentPublicKeySig) } });
        }
        if (!input.inviteToken) throw new ManagedAccessError(403, 'invitation-required');
        const now = new Date();
        const invitation = await tx.managedAccountInvite.findFirst({ where: {
            tokenHash: invitationHash(input.inviteToken), consumedAt: null, revokedAt: null, expiresAt: { gt: now },
            createdByAccount: { publicKey: administratorPublicKey },
        } });
        if (!invitation || (invitation.kind !== 'member' && invitation.kind !== 'machine')) throw new ManagedAccessError(403, 'invalid-invitation');
        // A daemon credential is a new independent identity, never a promoted human/legacy
        // account whose token would inherit unrelated machines, sessions or account secrets.
        if (invitation.kind === 'machine' && existing) throw new ManagedAccessError(403, 'new-machine-identity-required');
        const machineIds = invitationMachineIds(invitation);
        requireInvitationAssignmentFeature(machineIds);
        await requireGrantableManagedMachines(invitation.createdByAccountId, machineIds, tx);
        if (!input.contentPublicKey || !input.contentPublicKeySig) throw new ManagedAccessError(400, 'content-key-required');
        // Existing members keep their role and display name; only legacy identities are promoted.
        const data = { managedRole: invitation.kind, encryptionMode: 'e2ee',
            contentPublicKey: new Uint8Array(input.contentPublicKey), contentPublicKeySig: new Uint8Array(input.contentPublicKeySig),
            ...(existing?.managedRole !== 'member' && invitation.name ? { firstName: invitation.name } : {}),
        };
        const account = existing
            ? await tx.account.update({ where: { id: existing.id }, data })
            : await tx.account.create({ data: { publicKey: input.publicKey, ...data } });
        if (machineIds.length) await grantMachines(invitation.createdByAccountId, machineIds, account.id, tx);
        // Conditional consumption is the concurrency fence; a losing transaction rolls back
        // the Account, all grants, change cursors and afterTx owner delivery notifications.
        const consumed = await tx.managedAccountInvite.updateMany({ where: {
            id: invitation.id, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() },
        }, data: { consumedAt: now, consumedByAccountId: account.id } });
        if (consumed.count !== 1) throw new ManagedAccessError(403, 'invalid-invitation');
        return account;
    });
}
