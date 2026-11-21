import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { listManagedMachines, readManagedMachine } from './machineProjection';

describe('managed machine projection (real SQLite)', () => {
    let harness: LightSqliteHarness;
    const administrator = privacyKit.encodeHex(new Uint8Array(tweetnacl.sign.keyPair().publicKey));

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-managed-projection-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_ADMIN_PUBLIC_KEY: administrator, HAPPIER_SOCKET_ADAPTER: 'memory' },
        });
    });

    afterAll(async () => { await harness?.close(); });

    it('excludes retired machines from the administrator-owned inventory', async () => {
        const admin = await db.account.create({ data: { publicKey: administrator } });
        const identityAccount = (): Promise<{ id: string }> => db.account.create({ data: { publicKey: privacyKit.encodeHex(new Uint8Array(tweetnacl.sign.keyPair().publicKey)), managedRole: 'machine' } });
        const ownerA = await identityAccount();
        const ownerB = await identityAccount();
        const ownerC = await identityAccount();
        const liveId = randomUUID();
        const revokedId = randomUUID();
        const replacedId = randomUUID();
        await db.machine.create({ data: { id: liveId, accountId: ownerA.id, managedIdentityAccountId: ownerA.id, metadata: 'encrypted-live' } });
        await db.machine.create({ data: { id: revokedId, accountId: ownerB.id, managedIdentityAccountId: ownerB.id, metadata: 'encrypted-revoked', revokedAt: new Date() } });
        await db.machine.create({ data: { id: replacedId, accountId: ownerC.id, managedIdentityAccountId: ownerC.id, metadata: 'encrypted-replaced', replacedByMachineId: randomUUID() } });

        const legacyId = randomUUID();
        await db.machine.create({ data: { id: legacyId, accountId: admin.id, metadata: 'encrypted-legacy' } });
        const machines = await listManagedMachines(admin.id);
        expect(machines.map((machine) => machine.id).sort()).toEqual([liveId, legacyId].sort());
        expect(machines.find((machine) => machine.id === liveId)).toMatchObject({ managed: true });
        expect(machines.find((machine) => machine.id === legacyId)).toMatchObject({ managed: false });
        expect(machines.every((machine) => !('managedIdentityAccountId' in machine))).toBe(true);
        expect(await readManagedMachine(admin.id, liveId)).toMatchObject({ managed: true });
        expect(await readManagedMachine(admin.id, legacyId)).toMatchObject({ managed: false });
        expect(await readManagedMachine(admin.id, revokedId)).toBeNull();
        expect(await readManagedMachine(admin.id, replacedId)).toBeNull();
    });
});
