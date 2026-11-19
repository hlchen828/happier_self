import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const ManagedAccountRoleSchema = lazySchema(() => z.enum(['admin', 'member', 'machine', 'unmanaged']));
export const ManagedAccountAccessResponseSchema = lazySchema(() => z.object({
    managed: z.boolean(),
    role: ManagedAccountRoleSchema,
    adminAccountId: z.string().nullable(),
    machineId: z.string().nullable(),
}));
export const ManagedAccountAccessSchema = ManagedAccountAccessResponseSchema;
export type ManagedAccountAccess = z.infer<typeof ManagedAccountAccessResponseSchema>;

export const ManagedInviteKindSchema = lazySchema(() => z.enum(['member', 'machine']));
export const ManagedInviteMachineIdsSchema = lazySchema(() => z.array(z.string().min(1)).optional().default([]));
const validInviteSelection = (invite: { kind: 'member' | 'machine'; machineIds: string[] }) => invite.kind === 'member' || invite.machineIds.length === 0;
const invalidInviteSelection = { path: ['machineIds'], message: 'Only member invitations may assign machines' };
export const ManagedInviteCreateRequestSchema = lazySchema(() => z.object({
    kind: ManagedInviteKindSchema,
    name: z.string().trim().min(1).optional(),
    expiresAt: z.number().int().positive(),
    machineIds: ManagedInviteMachineIdsSchema,
}).refine(validInviteSelection, invalidInviteSelection));
const ManagedInviteSchema = lazySchema(() => z.object({
    id: z.string(), kind: ManagedInviteKindSchema, name: z.string().nullable(),
    machineIds: ManagedInviteMachineIdsSchema,
    expiresAt: z.number(), createdAt: z.number(), consumedAt: z.number().nullable(), revokedAt: z.number().nullable(),
}));
export const ManagedInvitesResponseSchema = lazySchema(() => z.object({ invites: z.array(ManagedInviteSchema.refine(validInviteSelection, invalidInviteSelection)) }));
export const ManagedInviteCreateResponseSchema = lazySchema(() => ManagedInviteSchema.omit({ consumedAt: true, revokedAt: true }).extend({ token: z.string() }).refine(validInviteSelection, invalidInviteSelection));
export type ManagedInvite = z.infer<typeof ManagedInviteSchema>;
export type ManagedInviteCreateResponse = z.infer<typeof ManagedInviteCreateResponseSchema>;

export const ManagedMembersResponseSchema = lazySchema(() => z.object({
    members: z.array(z.object({
        id: z.string(), name: z.string().nullable(), publicKey: z.string().nullable(),
        contentPublicKey: z.string().nullable(), contentPublicKeySig: z.string().nullable(),
        disabled: z.boolean(), createdAt: z.number(), machineIds: z.array(z.string()),
        machineGrants: z.array(z.object({ machineId: z.string(), status: z.enum(['pending', 'ready']) })).optional(),
    })),
}));
export const ManagedMemberUpdateRequestSchema = lazySchema(() => z.object({ disabled: z.boolean() }));
export type ManagedMembersResponse = z.infer<typeof ManagedMembersResponseSchema>;

export const MachineKeyRecipientSchema = lazySchema(() => z.object({
    accountId: z.string(), publicKey: z.string(), contentPublicKey: z.string(), contentPublicKeySig: z.string(),
}));
export const MachineKeyRecipientsResponseSchema = lazySchema(() => z.object({
    machineId: z.string(), recipients: z.array(MachineKeyRecipientSchema),
}));
export type MachineKeyRecipient = z.infer<typeof MachineKeyRecipientSchema>;
export type MachineKeyRecipientsResponse = z.infer<typeof MachineKeyRecipientsResponseSchema>;

const RecipientKeyEnvelopeSchema = lazySchema(() => z.object({ accountId: z.string(), dataEncryptionKey: z.string().min(1) }));
export const MachineKeysPublishRequestSchema = lazySchema(() => z.object({
    recipients: z.array(RecipientKeyEnvelopeSchema),
    sessions: z.array(z.object({ sessionId: z.string(), recipients: z.array(RecipientKeyEnvelopeSchema) })),
}));
export type MachineKeysPublishRequest = z.infer<typeof MachineKeysPublishRequestSchema>;

export const ManagedMachineGrantResponseSchema = lazySchema(() => z.object({
    machineId: z.string(), accountId: z.string(), status: z.enum(['pending', 'ready']),
}));
export const ManagedAccessChangedUpdateBodySchema = lazySchema(() => z.object({ t: z.literal('managed-access-changed'), machineId: z.string().optional(), sessionId: z.string().optional(), revoked: z.boolean().optional() }));
export type ManagedAccessChangedUpdateBody = z.infer<typeof ManagedAccessChangedUpdateBodySchema>;
