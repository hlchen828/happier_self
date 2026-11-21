import { z } from 'zod';
import * as privacyKit from 'privacy-kit';
import {
    ManagedAccountAccessResponseSchema, ManagedMembersResponseSchema, ManagedInvitesResponseSchema, ManagedInviteKindSchema,
    ManagedInviteCreateRequestSchema, ManagedInviteCreateResponseSchema, ManagedMemberUpdateRequestSchema,
    MachineKeyRecipientsResponseSchema, MachineKeysPublishRequestSchema, ManagedMachineGrantResponseSchema,
} from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx, afterTx } from '@/storage/inTx';
import { disableAccount, accountDisabledKey } from '@/app/auth/accountDisable';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { eventRouter } from '@/app/events/eventRouter';
import { type Fastify } from '@/app/api/types';
import { createServerFeatureGatedRouteApp } from '@/app/features/catalog/serverFeatureGate';
import { managedAccountAccess, requireManagedAdministrator, requireManagedMachinePublisher, ManagedAccessError } from './access';
import { createManagedInvitation, invitationMachineIds } from './invitations';
import { disabledAccountIds, machineKeyRecipients, publishMachineKeys, grantMachine, revokeMachine, emitManagedAccessChanged } from './grants';

export function registerManagedAccountRoutes(rawApp: Fastify): void {
    // Discovery remains usable on ordinary servers; management operations are capability-gated.
    rawApp.get('/v1/account/access', { preHandler: rawApp.authenticate, schema: { response: { 200: ManagedAccountAccessResponseSchema } } },
        async (request) => managedAccountAccess(request.userId));
    const app = createServerFeatureGatedRouteApp(rawApp, 'accounts.machineAccess');
    app.post('/v1/account/invites', { preHandler: app.authenticate, schema: { body: ManagedInviteCreateRequestSchema, response: { 200: ManagedInviteCreateResponseSchema } } },
        async (request) => createManagedInvitation(request.userId, request.body));
    app.get('/v1/account/invites', { preHandler: app.authenticate, schema: { response: { 200: ManagedInvitesResponseSchema } } }, async (request) => {
        await requireManagedAdministrator(request.userId);
        const invitations = await db.managedAccountInvite.findMany({ where: { createdByAccountId: request.userId }, orderBy: { createdAt: 'desc' } });
        return { invites: invitations.map((row) => ({ id: row.id, kind: ManagedInviteKindSchema.parse(row.kind), name: row.name, machineIds: invitationMachineIds(row),
            expiresAt: row.expiresAt.getTime(), createdAt: row.createdAt.getTime(), consumedAt: row.consumedAt?.getTime() ?? null, revokedAt: row.revokedAt?.getTime() ?? null })) };
    });
    app.delete('/v1/account/invites/:id', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string() }) } }, async (request) => {
        await requireManagedAdministrator(request.userId);
        await db.managedAccountInvite.updateMany({ where: { id: request.params.id, createdByAccountId: request.userId, revokedAt: null }, data: { revokedAt: new Date() } });
        return { success: true };
    });
    app.get('/v1/account/members', { preHandler: app.authenticate, schema: { response: { 200: ManagedMembersResponseSchema } } }, async (request) => {
        await requireManagedAdministrator(request.userId);
        const members = await db.account.findMany({ where: { managedRole: 'member' }, orderBy: { createdAt: 'asc' }, select: {
            id: true, firstName: true, publicKey: true, contentPublicKey: true, contentPublicKeySig: true, createdAt: true,
            machineGrants: { select: { machineId: true, dataEncryptionKey: true } },
        } });
        const disabled = await disabledAccountIds(db, members.map((member) => member.id));
        return { members: members.map((member) => ({ id: member.id, name: member.firstName, publicKey: member.publicKey,
            contentPublicKey: member.contentPublicKey ? privacyKit.encodeBase64(member.contentPublicKey) : null,
            contentPublicKeySig: member.contentPublicKeySig ? privacyKit.encodeBase64(member.contentPublicKeySig) : null,
            disabled: disabled.has(member.id), createdAt: member.createdAt.getTime(), machineIds: member.machineGrants.map((grant) => grant.machineId),
            machineGrants: member.machineGrants.map((grant) => ({ machineId: grant.machineId, status: grant.dataEncryptionKey ? 'ready' as const : 'pending' as const })) })) };
    });
    app.patch('/v1/account/members/:id', { preHandler: app.authenticate, schema: { params: z.object({ id: z.string() }), body: ManagedMemberUpdateRequestSchema } }, async (request) => {
        await inTx(async (tx) => {
            await requireManagedAdministrator(request.userId, tx);
            const memberId = request.params.id;
            if ((await managedAccountAccess(memberId, tx)).role !== 'member') throw new ManagedAccessError(403, 'member-required');
            if (!request.body.disabled) {
                await tx.repeatKey.deleteMany({ where: { key: accountDisabledKey(memberId) } });
                return;
            }
            const grants = await tx.machineGrant.findMany({ where: { accountId: memberId }, select: { machineId: true, machine: { select: { accountId: true } } } });
            await disableAccount({ accountId: memberId, reason: 'administrator-disabled', env: process.env, tx });
            const shares = await tx.sessionShare.findMany({ where: { sharedWithUserId: memberId }, select: { sessionId: true } });
            await tx.sessionShare.deleteMany({ where: { sharedWithUserId: memberId } });
            await tx.machineGrant.deleteMany({ where: { accountId: memberId } });
            for (const share of shares) await markAccountChanged(tx, { accountId: memberId, kind: 'session', entityId: share.sessionId });
            const ownerHints = new Map<string, { ownerId: string; cursor: number }>();
            for (const grant of grants) {
                await markAccountChanged(tx, { accountId: memberId, kind: 'machine', entityId: grant.machineId });
                ownerHints.set(grant.machineId, { ownerId: grant.machine.accountId, cursor: await markAccountChanged(tx, { accountId: grant.machine.accountId, kind: 'machine', entityId: grant.machineId }) });
            }
            const memberCursor = (await tx.account.findUniqueOrThrow({ where: { id: memberId }, select: { seq: true } })).seq;
            afterTx(tx, () => {
                emitManagedAccessChanged({ accountId: memberId, cursor: memberCursor, revoked: true });
                for (const [machineId, hint] of ownerHints) emitManagedAccessChanged({ accountId: hint.ownerId, cursor: hint.cursor, machineId, recipientFilter: { type: 'machine-only', machineId } });
                eventRouter.disconnectAccount(memberId);
            });
        });
        return { success: true };
    });
}

export function registerManagedMachineRoutes(rawApp: Fastify): void {
    const app = createServerFeatureGatedRouteApp(rawApp, 'accounts.machineAccess');
    const machineParams = z.object({ id: z.string() });
    const grantParams = z.object({ id: z.string(), accountId: z.string() });
    app.put('/v1/machines/:id/grants/:accountId', { preHandler: app.authenticate, schema: { params: grantParams, body: z.object({}), response: { 200: ManagedMachineGrantResponseSchema } } },
        async (request) => grantMachine(request.userId, request.params.id, request.params.accountId));
    app.delete('/v1/machines/:id/grants/:accountId', { preHandler: app.authenticate, schema: { params: grantParams } }, async (request) => {
        await revokeMachine(request.userId, request.params.id, request.params.accountId); return { success: true };
    });
    app.get('/v1/machines/:id/recipients', { preHandler: app.authenticate, schema: { params: machineParams, response: { 200: MachineKeyRecipientsResponseSchema } } }, async (request) => {
        await requireManagedMachinePublisher(request.userId, request.params.id);
        return { machineId: request.params.id, recipients: await machineKeyRecipients(request.params.id) };
    });
    app.put('/v1/machines/:id/keys', { preHandler: app.authenticate, schema: { params: machineParams, body: MachineKeysPublishRequestSchema } }, async (request) => {
        await publishMachineKeys(request.userId, request.params.id, request.body); return { success: true };
    });
}
