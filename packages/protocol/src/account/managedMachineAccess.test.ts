import { describe, expect, it } from 'vitest';
import { ManagedInviteCreateRequestSchema, ManagedInviteCreateResponseSchema, ManagedInvitesResponseSchema } from './managedMachineAccess.js';
import { FeatureGatesSchema } from '../features/payload/featureGatesSchema.js';

describe('managed member invitation machine selection', () => {
    const request = { kind: 'member', expiresAt: 123 };
    const invite = { id: 'invite', kind: 'member', name: null, expiresAt: 123, createdAt: 100 };
    it('accepts old omitted selections as empty and preserves selections through JSON', () => {
        expect(ManagedInviteCreateRequestSchema.parse(request)).toMatchObject({ machineIds: [] });
        expect(ManagedInviteCreateResponseSchema.parse({ ...invite, token: 'token' })).toMatchObject({ machineIds: [] });
        expect(ManagedInvitesResponseSchema.parse({ invites: [{ ...invite, consumedAt: null, revokedAt: null }] }).invites[0]).toMatchObject({ machineIds: [] });
        const machineIds = ['one', 'two'];
        expect(ManagedInviteCreateRequestSchema.parse(JSON.parse(JSON.stringify({ ...request, machineIds })))).toMatchObject({ machineIds });
        expect(ManagedInviteCreateResponseSchema.parse({ ...invite, token: 'token', machineIds })).toMatchObject({ machineIds });
        expect(ManagedInvitesResponseSchema.parse({ invites: [{ ...invite, machineIds, consumedAt: null, revokedAt: null }] }).invites[0]).toMatchObject({ machineIds });
    });
    it('rejects selections on machine invitations and malformed IDs', () => {
        expect(ManagedInviteCreateRequestSchema.safeParse({ kind: 'machine', expiresAt: 123, machineIds: ['one'] }).success).toBe(false);
        expect(ManagedInviteCreateRequestSchema.safeParse({ ...request, machineIds: [''] }).success).toBe(false);
        expect(ManagedInviteCreateRequestSchema.safeParse({ ...request, machineIds: [1] }).success).toBe(false);
        expect(ManagedInviteCreateRequestSchema.safeParse({ kind: 'machine', expiresAt: 123 }).success).toBe(true);
    });
    it('fails closed for the new feature bit on predecessor payloads', () => {
        expect(FeatureGatesSchema.parse({ accounts: { machineAccess: { enabled: true } } }).accounts).toMatchObject({ inviteMachineAssignment: { enabled: false } });
        expect(FeatureGatesSchema.parse({ accounts: { machineAccess: { enabled: true }, inviteMachineAssignment: { enabled: true } } }).accounts).toMatchObject({ inviteMachineAssignment: { enabled: true } });
    });
});
