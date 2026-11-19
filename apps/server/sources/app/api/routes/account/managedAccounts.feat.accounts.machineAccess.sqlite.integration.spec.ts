import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import type { Server as SocketServer } from 'socket.io';
import { startSocket } from '../../socket';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createFakeSocket, triggerSocketHandler } from '../../testkit/socketHarness';
import { rpcHandler } from '../../socket/rpcHandler';
import type { Socket as ServerSocket } from 'socket.io';

// Redis I/O is the boundary; resource decisions still use the real SQLite database.
const redisBoundary = vi.hoisted(() => ({ hmget: vi.fn(), eval: vi.fn() }));
vi.mock('@/storage/redis/redis', () => ({ getRedisClient: () => redisBoundary }));

// Capture the real network server only to close the transport this test starts.
const transport = vi.hoisted(() => ({ server: null as SocketServer | null }));
vi.mock('socket.io', async (importOriginal) => {
    const actual = await importOriginal<typeof import('socket.io')>();
    return { ...actual, Server: class extends actual.Server {
        constructor(...args: ConstructorParameters<typeof actual.Server>) { super(...args); transport.server = this; }
    } };
});
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { createAccountContentPublicKeyBindingMessage } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { eventRouter } from '@/app/events/eventRouter';
import { disableAccount } from '@/app/auth/accountDisable';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { enableAuthentication } from '../../utils/enableAuthentication';
import { authRoutes } from '../auth/authRoutes';
import { accountRoutes } from './accountRoutes';
import { machinesRoutes } from '../machines/machinesRoutes';
import { sessionRoutes } from '../session/sessionRoutes';

function identity() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const challenge = randomBytes(32);
    return {
        signing, content,
        publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
        body: {
            publicKey: privacyKit.encodeBase64(new Uint8Array(signing.publicKey)),
            challenge: privacyKit.encodeBase64(challenge),
            signature: privacyKit.encodeBase64(new Uint8Array(tweetnacl.sign.detached(challenge, signing.secretKey))),
            contentPublicKey: privacyKit.encodeBase64(new Uint8Array(content.publicKey)),
            contentPublicKeySig: privacyKit.encodeBase64(new Uint8Array(tweetnacl.sign.detached(
                createAccountContentPublicKeyBindingMessage(content.publicKey), signing.secretKey,
            ))),
        },
    };
}

function envelope(key: Uint8Array, recipientPublicKey: Uint8Array): string {
    const ephemeral = tweetnacl.box.keyPair();
    const nonce = randomBytes(tweetnacl.box.nonceLength);
    const cipher = tweetnacl.box(key, nonce, recipientPublicKey, ephemeral.secretKey);
    const bytes = new Uint8Array(1 + ephemeral.publicKey.length + nonce.length + cipher.length);
    bytes.set(ephemeral.publicKey, 1);
    bytes.set(nonce, 1 + ephemeral.publicKey.length);
    bytes.set(cipher, 1 + ephemeral.publicKey.length + nonce.length);
    return privacyKit.encodeBase64(bytes);
}

function openEnvelope(value: string, privateKey: Uint8Array): Uint8Array | null {
    const bytes = privacyKit.decodeBase64(value);
    return tweetnacl.box.open(bytes.subarray(57), bytes.subarray(33, 57), bytes.subarray(1, 33), privateKey);
}

// Exercise real auth, persistence, resource routing and asymmetric envelopes; the database is disposable.
describe('managed machine accounts (real SQLite and authenticated HTTP)', () => {
    let harness: LightSqliteHarness;
    const administrator = identity();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    let address: string;
    const clients: ClientSocket[] = [];
    async function connect(token: string, clientType: 'user-scoped' | 'machine-scoped' | 'session-scoped' = 'user-scoped', machineId?: string, sessionId?: string) {
        const socket = connectSocket(address, { path: '/v1/updates', transports: ['websocket'], autoConnect: false, reconnection: false,
            auth: { token, clientType, ...(machineId ? { machineId } : {}), ...(sessionId ? { sessionId } : {}) } });
        clients.push(socket);
        await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
        return socket;
    }

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-managed-accounts-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_ADMIN_PUBLIC_KEY: administrator.publicKey, HAPPIER_SOCKET_ADAPTER: 'memory' },
        });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app as unknown as Parameters<typeof enableAuthentication>[0];
        enableAuthentication(typed);
        authRoutes(typed);
        accountRoutes(typed);
        machinesRoutes(typed);
        sessionRoutes(typed);
        startSocket(typed);
        address = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 120_000);

    afterAll(async () => {
        for (const client of clients) client.disconnect();
        if (transport.server) await new Promise<void>((resolve) => transport.server!.close(() => resolve()));
        await app.close(); await harness?.close();
    });

    it('creates independent invited identities, shares exactly one machine, and revokes old tokens', async () => {
        const rootLogin = await app.inject({ method: 'POST', url: '/v1/auth', payload: administrator.body });
        expect(rootLogin.statusCode, rootLogin.body).toBe(200);
        const rootToken = rootLogin.json<{ token: string }>().token;
        const rootHeaders = { authorization: `Bearer ${rootToken}` };
        const root = await db.account.findUniqueOrThrow({ where: { publicKey: administrator.publicKey } });
        expect((await app.inject({ method: 'GET', url: '/v1/account/access', headers: rootHeaders })).json()).toMatchObject({ managed: true, role: 'admin' });

        const outsider = identity();
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: outsider.body })).statusCode).toBe(403);

        async function invite(kind: 'member' | 'machine', name: string, machineIds?: string[]) {
            const response = await app.inject({ method: 'POST', url: '/v1/account/invites', headers: rootHeaders,
                payload: { kind, name, expiresAt: Date.now() + 60_000, ...(machineIds ? { machineIds } : {}) } });
            expect(response.statusCode).toBe(200);
            return response.json<{ id: string; token: string }>();
        }
        async function join(kind: 'member' | 'machine', name: string, machineIds?: string[]) {
            const person = identity();
            const invitation = await invite(kind, name, machineIds);
            const joined = await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...person.body, inviteToken: invitation.token } });
            expect(joined.statusCode).toBe(200);
            const token = joined.json<{ token: string }>().token;
            const account = await db.account.findUniqueOrThrow({ where: { publicKey: person.publicKey } });
            const replay = await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...identity().body, inviteToken: invitation.token } });
            expect(replay.statusCode).toBe(403);
            return { ...person, id: account.id, token, headers: { authorization: `Bearer ${token}` } };
        }
        const machineA = await join('machine', 'machine A');
        const machineB = await join('machine', 'machine B');
        const machineAId = randomUUID();
        const machineBId = randomUUID();
        const machineKey = new Uint8Array(randomBytes(32));
        const otherKey = new Uint8Array(randomBytes(32));
        const sessionKey = new Uint8Array(randomBytes(32));
        const machineAOwnerEnvelope = envelope(machineKey, machineA.content.publicKey);
        const machineBOwnerEnvelope = envelope(otherKey, machineB.content.publicKey);
        expect((await app.inject({ method: 'POST', url: '/v1/machines', headers: machineA.headers,
            payload: { id: machineAId, metadata: 'encrypted-machine-a', dataEncryptionKey: machineAOwnerEnvelope } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/machines', headers: machineB.headers,
            payload: { id: machineBId, metadata: 'encrypted-machine-b', dataEncryptionKey: machineBOwnerEnvelope } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/machines', headers: machineA.headers,
            payload: { id: randomUUID(), metadata: 'duplicate', dataEncryptionKey: machineAOwnerEnvelope } })).statusCode).toBe(403);
        expect((await app.inject({ method: 'GET', url: `/v1/machines/${machineBId}`, headers: machineA.headers })).statusCode).toBe(404);
        expect((await app.inject({ method: 'GET', url: '/v1/account/members', headers: machineA.headers })).statusCode).toBe(403);

        const sessionResponse = await app.inject({ method: 'POST', url: '/v1/sessions', headers: machineA.headers,
            payload: { tag: randomUUID(), metadata: 'encrypted-session-a', machineId: machineAId,
                dataEncryptionKey: envelope(sessionKey, machineA.content.publicKey) } });
        expect(sessionResponse.statusCode).toBe(200);
        const sessionId = sessionResponse.json<{ session: { id: string } }>().session.id;
        expect((await app.inject({ method: 'POST', url: '/v1/sessions', headers: machineA.headers,
            payload: { tag: randomUUID(), metadata: 'spoofed', machineId: machineBId,
                dataEncryptionKey: envelope(sessionKey, machineA.content.publicKey) } })).statusCode).toBe(403);

        const daemonBeforeJoin = await connect(machineA.token, 'machine-scoped', machineAId);
        const assignmentHint = new Promise<unknown>((resolve) => daemonBeforeJoin.once('update', resolve));
        const alice = await join('member', 'first member', [machineAId, machineAId]);
        expect(await db.machineGrant.findMany({ where: { accountId: alice.id } })).toEqual([
            expect.objectContaining({ machineId: machineAId, dataEncryptionKey: null }),
        ]);
        expect(await assignmentHint).toMatchObject({ body: { t: 'managed-access-changed', machineId: machineAId } });
        daemonBeforeJoin.disconnect();
        const alicePending = (await app.inject({ method: 'GET', url: '/v1/machines', headers: alice.headers })).json();
        expect(alicePending).toEqual([expect.objectContaining({ id: machineAId, managed: true, managedAccessStatus: 'pending', dataEncryptionKey: null })]);
        expect((await app.inject({ method: 'GET', url: `/v2/sessions/${sessionId}`, headers: alice.headers })).statusCode).toBe(404);
        const changesBeforeRetry = await db.accountChange.findMany({ where: { accountId: { in: [alice.id, machineA.id] } } });
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: alice.body })).statusCode).toBe(200);
        expect(await db.accountChange.findMany({ where: { accountId: { in: [alice.id, machineA.id] } } })).toEqual(changesBeforeRetry);
        const bob = await join('member', 'second member');
        const charlie = await join('member', 'unassigned member');
        const granted = await app.inject({ method: 'PUT', url: `/v1/machines/${machineAId}/grants/${bob.id}`, headers: rootHeaders, payload: {} });
        expect(granted.statusCode).toBe(200);
        expect(granted.json()).toMatchObject({ machineId: machineAId, accountId: bob.id, status: 'pending' });
        expect((await app.inject({ method: 'PUT', url: `/v1/machines/${machineBId}/grants/${alice.id}`, headers: alice.headers, payload: {} })).statusCode).toBe(403);
        const recipientsResponse = await app.inject({ method: 'GET', url: `/v1/machines/${machineAId}/recipients`, headers: machineA.headers });
        expect(recipientsResponse.statusCode).toBe(200);
        expect(recipientsResponse.json<{ recipients: Array<{ accountId: string }> }>().recipients.map((recipient) => recipient.accountId).sort()).toEqual([root.id, alice.id, bob.id].sort());
        const encryptedRecipients = [
            { accountId: root.id, dataEncryptionKey: envelope(machineKey, administrator.content.publicKey) },
            { accountId: alice.id, dataEncryptionKey: envelope(machineKey, alice.content.publicKey) },
            { accountId: bob.id, dataEncryptionKey: envelope(machineKey, bob.content.publicKey) },
        ];
        const encryptedSessionRecipients = [
            { accountId: root.id, dataEncryptionKey: envelope(sessionKey, administrator.content.publicKey) },
            { accountId: alice.id, dataEncryptionKey: envelope(sessionKey, alice.content.publicKey) },
            { accountId: bob.id, dataEncryptionKey: envelope(sessionKey, bob.content.publicKey) },
        ];
        expect((await app.inject({ method: 'PUT', url: `/v1/machines/${machineAId}/keys`, headers: machineA.headers,
            payload: { recipients: encryptedRecipients, sessions: [{ sessionId, recipients: encryptedSessionRecipients }] } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'PUT', url: `/v1/machines/${machineBId}/keys`, headers: machineB.headers,
            payload: { recipients: [{ accountId: root.id, dataEncryptionKey: envelope(otherKey, administrator.content.publicKey) }], sessions: [] } })).statusCode).toBe(200);
        const administratorMachines = (await app.inject({ method: 'GET', url: '/v1/machines', headers: rootHeaders })).json<Array<{ id: string }>>();
        expect(administratorMachines.map((machine) => machine.id).sort()).toEqual([machineAId, machineBId].sort());
        const aliceMachines = (await app.inject({ method: 'GET', url: '/v1/machines', headers: alice.headers })).json<Array<{ id: string; dataEncryptionKey: string }>>();
        expect(aliceMachines.map((machine) => machine.id)).toEqual([machineAId]);
        expect(openEnvelope(aliceMachines[0].dataEncryptionKey, alice.content.secretKey)).toEqual(machineKey);
        expect(openEnvelope(aliceMachines[0].dataEncryptionKey, charlie.content.secretKey)).toBeNull();
        const existingSelection = await invite('member', 'must not rename existing member', [machineAId]);
        const readyGrants = await db.machineGrant.findMany({ where: { accountId: alice.id } });
        const readyChanges = await db.accountChange.findMany({ where: { accountId: { in: [alice.id, machineA.id] } } });
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...alice.body, inviteToken: existingSelection.token } })).statusCode).toBe(200);
        expect(await db.machineGrant.findMany({ where: { accountId: alice.id } })).toEqual(readyGrants);
        expect(await db.accountChange.findMany({ where: { accountId: { in: [alice.id, machineA.id] } } })).toEqual(readyChanges);
        expect((await app.inject({ method: 'GET', url: '/v1/machines', headers: charlie.headers })).json()).toEqual([]);
        expect((await app.inject({ method: 'GET', url: `/v1/machines/${machineBId}`, headers: alice.headers })).statusCode).toBe(404);
        const aliceSession = await app.inject({ method: 'GET', url: `/v2/sessions/${sessionId}`, headers: alice.headers });
        expect(aliceSession.statusCode).toBe(200);
        expect(openEnvelope(aliceSession.json<{ session: { dataEncryptionKey: string } }>().session.dataEncryptionKey, alice.content.secretKey)).toEqual(sessionKey);
        const deniedSession = await app.inject({ method: 'GET', url: `/v2/sessions/${sessionId}`, headers: charlie.headers });
        expect(deniedSession.statusCode, deniedSession.body).toBe(404);

        await db.session.update({ where: { id: sessionId }, data: { active: false } });
        const archived = await app.inject({ method: 'POST', url: `/v2/sessions/${sessionId}/archive`, headers: bob.headers });
        expect(archived.statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: `/v2/sessions/${sessionId}/unarchive`, headers: bob.headers })).statusCode).toBe(200);
        const aliceSocket = await connect(alice.token);
        const bobSocket = await connect(bob.token);
        const charlieSocket = await connect(charlie.token);
        const aliceActivity: Array<{ type: string; id?: string; active?: boolean }> = [];
        const charlieActivity: Array<{ type: string; id?: string; active?: boolean }> = [];
        aliceSocket.on('ephemeral', (payload) => aliceActivity.push(payload));
        charlieSocket.on('ephemeral', (payload) => charlieActivity.push(payload));
        const daemon = await connect(machineA.token, 'machine-scoped', machineAId);
        const method = `${machineAId}:managed-test-read`;
        const registered = new Promise<void>((resolve) => daemon.once(SOCKET_RPC_EVENTS.REGISTERED, resolve));
        daemon.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
        await registered;
        daemon.on(SOCKET_RPC_EVENTS.REQUEST, (_request: unknown, acknowledge: (result: unknown) => void) => acknowledge('resource-result'));
        const call = (socket: ClientSocket, target = method) => socket.timeout(5000).emitWithAck(SOCKET_RPC_EVENTS.CALL, { method: target, params: '' });
        expect(await call(aliceSocket)).toMatchObject({ ok: true, result: 'resource-result' });
        expect(await call(bobSocket)).toMatchObject({ ok: true, result: 'resource-result' });
        expect(aliceActivity).toContainEqual(expect.objectContaining({ type: 'machine-activity', id: machineAId, active: true }));
        expect(charlieActivity.filter((activity) => activity.id === machineAId)).toEqual([]);
        const metadataEvents: unknown[] = [];
        aliceSocket.on('update', (payload) => metadataEvents.push(payload));
        const machineChange = await daemon.timeout(5000).emitWithAck('machine-update-metadata', { machineId: machineAId, metadata: 'new-encrypted-metadata', expectedVersion: 1 });
        expect(machineChange).toMatchObject({ result: 'success', version: 2 });
        await call(aliceSocket);
        expect(metadataEvents).toContainEqual(expect.objectContaining({ body: expect.objectContaining({ t: 'update-machine', machineId: machineAId, metadata: { value: 'new-encrypted-metadata', version: 2 } }) }));
        expect((await db.accountChange.findUnique({ where: { accountId_kind_entityId: { accountId: alice.id, kind: 'machine', entityId: machineAId } } }))?.cursor).toBeGreaterThan(1);
        expect(await call(charlieSocket)).toMatchObject({ ok: false, error: 'Forbidden' });
        expect(await call(aliceSocket, `${machineBId}:managed-test-read`)).toMatchObject({ ok: false, error: 'Forbidden' });
        await db.accessKey.create({ data: { accountId: machineA.id, machineId: machineAId, sessionId, data: 'encrypted-machine-binding' } });
        const publisher = await connect(machineA.token, 'session-scoped', machineAId, sessionId);
        const stream = (localId: string) => publisher.emit('transcript-stream-segment', { sid: sessionId, message: {
            localId, messageRole: 'agent', content: { t: 'encrypted', c: 'future-ciphertext' }, createdAt: Date.now(), updatedAt: Date.now(),
        } });
        const initialFrame = new Promise<void>((resolve) => aliceSocket.once('ephemeral', (frame) => { expect(frame).toMatchObject({ type: 'transcript-stream-segment' }); resolve(); }));
        stream('before-revoke');
        await initialFrame;
        const delayedMethod = `${machineAId}:managed-test-delayed`;
        const executions: string[] = [];
        daemon.on(SOCKET_RPC_EVENTS.REQUEST, (request: { method: string; params: string }) => { if (request.method === delayedMethod) executions.push(request.params); });
        aliceSocket.emit(SOCKET_RPC_EVENTS.CALL, { method: delayedMethod, params: 'revoked-request' });
        await call(aliceSocket);
        const disconnected = new Promise<void>((resolve) => aliceSocket.once('disconnect', () => resolve()));
        expect((await app.inject({ method: 'DELETE', url: `/v1/machines/${machineAId}/grants/${alice.id}`, headers: rootHeaders })).statusCode).toBe(200);
        await disconnected;
        const returnedAlice = await connect(alice.token);
        expect(await call(returnedAlice)).toMatchObject({ ok: false, error: 'Forbidden' });
        const forbiddenFrames: unknown[] = [];
        returnedAlice.on('ephemeral', (frame) => { if (frame.type === 'transcript-stream-segment') forbiddenFrames.push(frame); });
        const futureFrame = new Promise<void>((resolve) => {
            const listener = (frame: { type: string; message?: { localId?: string } }) => {
                if (frame.type === 'transcript-stream-segment' && frame.message?.localId === 'after-revoke') { bobSocket.off('ephemeral', listener); resolve(); }
            };
            bobSocket.on('ephemeral', listener);
        });
        stream('after-revoke');
        await futureFrame;
        await call(bobSocket);
        expect(forbiddenFrames).toEqual([]);
        const delayedRegistered = new Promise<void>((resolve) => daemon.once(SOCKET_RPC_EVENTS.REGISTERED, resolve));
        daemon.emit(SOCKET_RPC_EVENTS.REGISTER, { method: delayedMethod });
        await delayedRegistered;
        await bobSocket.timeout(5000).emitWithAck(SOCKET_RPC_EVENTS.CALL, { method: delayedMethod, params: 'allowed-probe' });
        // Observe at least two canonical availability ticks, so the pre-revoke waiter has a
        // real opportunity to submit to the newly registered target rather than ending the test early.
        const { resolveRpcMethodAvailabilityPollMs } = await import('../../socket/rpcMethodAvailabilityGrace');
        await new Promise((resolve) => setTimeout(resolve, resolveRpcMethodAvailabilityPollMs() * 2));
        expect(executions).toEqual(['allowed-probe']);
        expect((await app.inject({ method: 'GET', url: '/v1/machines', headers: alice.headers })).json()).toEqual([]);
        expect((await app.inject({ method: 'GET', url: `/v2/sessions/${sessionId}`, headers: alice.headers })).statusCode).toBe(404);
        expect((await app.inject({ method: 'PUT', url: `/v1/machines/${machineAId}/keys`, headers: machineA.headers,
            payload: { recipients: encryptedRecipients, sessions: [{ sessionId, recipients: encryptedSessionRecipients }] } })).statusCode).toBe(403);
        const newKey = new Uint8Array(randomBytes(32));
        const newSessionHint = new Promise<{ body: { machineId: string; sessionId: string } }>((resolve) => {
            const listener = (payload: { body: { t: string; machineId: string; sessionId?: string } }) => {
                if (payload.body.t === 'managed-access-changed' && payload.body.sessionId) { daemon.off('update', listener); resolve(payload as { body: { machineId: string; sessionId: string } }); }
            };
            daemon.on('update', listener);
        });
        const future = await app.inject({ method: 'POST', url: '/v1/sessions', headers: machineA.headers, payload: { tag: randomUUID(), metadata: 'future-session', machineId: machineAId, dataEncryptionKey: envelope(newKey, machineA.content.publicKey) } });
        const futureId = future.json<{ session: { id: string } }>().session.id;
        expect((await newSessionHint).body).toMatchObject({ machineId: machineAId, sessionId: futureId });
        expect((await app.inject({ method: 'PUT', url: `/v1/machines/${machineAId}/keys`, headers: machineA.headers,
            payload: { recipients: [], sessions: [{ sessionId: futureId, recipients: [{ accountId: bob.id, dataEncryptionKey: envelope(newKey, bob.content.publicKey) }] }] } })).statusCode).toBe(200);
        expect(await db.sessionShare.findUnique({ where: { sessionId_sharedWithUserId: { sessionId, sharedWithUserId: bob.id } } })).not.toBeNull();
        expect(openEnvelope((await app.inject({ method: 'GET', url: `/v2/sessions/${futureId}`, headers: bob.headers })).json<{ session: { dataEncryptionKey: string } }>().session.dataEncryptionKey, bob.content.secretKey)).toEqual(newKey);
        // Hold the real database transaction admission, then commit a revoke before deletion starts.
        // A pre-transaction authorization check must not survive into the destructive transaction.
        let admitDeletion!: () => void;
        let enteredDeletion!: () => void;
        const admitted = new Promise<void>((resolve) => { admitDeletion = resolve; });
        const entered = new Promise<void>((resolve) => { enteredDeletion = resolve; });
        const realTransaction = db.$transaction.bind(db);
        const transactionBoundary = vi.fn(realTransaction).mockImplementationOnce(async (callback, options) => {
            enteredDeletion();
            await admitted;
            return await realTransaction(callback, options);
        });
        // Vitest retains only the callback overload; this boundary delegates all other calls unchanged.
        db.$transaction = transactionBoundary as unknown as typeof db.$transaction;
        const racingDelete = app.inject({ method: 'DELETE', url: `/v1/sessions/${futureId}`, headers: bob.headers }).then((response) => response);
        let deletionStatus: number;
        try {
            await Promise.race([entered, racingDelete.then(() => { throw new Error('Deletion finished before entering its database transaction'); })]);
            expect((await app.inject({ method: 'DELETE', url: `/v1/machines/${machineAId}/grants/${bob.id}`, headers: rootHeaders })).statusCode).toBe(200);
        } finally {
            admitDeletion();
            try { deletionStatus = (await racingDelete).statusCode; }
            finally { db.$transaction = realTransaction; }
        }
        expect(deletionStatus).toBe(404);
        expect(await db.session.findUnique({ where: { id: futureId } })).not.toBeNull();
        expect((await app.inject({ method: 'PUT', url: `/v1/machines/${machineAId}/grants/${bob.id}`, headers: rootHeaders, payload: {} })).statusCode).toBe(200);
        expect((await app.inject({ method: 'PUT', url: `/v1/machines/${machineAId}/keys`, headers: machineA.headers,
            payload: { recipients: [{ accountId: bob.id, dataEncryptionKey: envelope(machineKey, bob.content.publicKey) }], sessions: [{ sessionId: futureId, recipients: [{ accountId: bob.id, dataEncryptionKey: envelope(newKey, bob.content.publicKey) }] }] } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'DELETE', url: `/v1/sessions/${futureId}`, headers: bob.headers })).statusCode).toBe(200);
        expect(await db.session.findUnique({ where: { id: futureId } })).toBeNull();
        expect((await app.inject({ method: 'PATCH', url: `/v1/account/members/${bob.id}`, headers: rootHeaders,
            payload: { disabled: true } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/v1/machines', headers: bob.headers })).statusCode).toBe(403);

        const withdrawn = await invite('member', 'withdrawn');
        expect((await app.inject({ method: 'DELETE', url: `/v1/account/invites/${withdrawn.id}`, headers: rootHeaders })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...identity().body, inviteToken: withdrawn.token } })).statusCode).toBe(403);
        const expired = await app.inject({ method: 'POST', url: '/v1/account/invites', headers: rootHeaders,
            payload: { kind: 'member', expiresAt: Date.now() - 1 } });
        expect(expired.statusCode).toBe(400);
        const expiresBeforeUse = await invite('member', 'expires before enrollment');
        // Seed expiry at the database boundary; account creation and invitation checks stay real.
        await db.managedAccountInvite.update({ where: { id: expiresBeforeUse.id }, data: { expiresAt: new Date(Date.now() - 1) } });
        const expiredIdentity = identity();
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...expiredIdentity.body, inviteToken: expiresBeforeUse.token } })).statusCode).toBe(403);
        expect(await db.account.findUnique({ where: { publicKey: expiredIdentity.publicKey } })).toBeNull();
        expect((await db.managedAccountInvite.findUniqueOrThrow({ where: { id: expiresBeforeUse.id } })).consumedAt).toBeNull();
    });

    it('does not submit a Redis-registry local fallback after its machine grant is revoked', async () => {
        const memberIdentity = identity();
        const ownerIdentity = identity();
        const member = await db.account.create({ data: { publicKey: memberIdentity.publicKey, managedRole: 'member',
            contentPublicKey: new Uint8Array(memberIdentity.content.publicKey), contentPublicKeySig: privacyKit.decodeBase64(memberIdentity.body.contentPublicKeySig) } });
        const owner = await db.account.create({ data: { publicKey: ownerIdentity.publicKey, managedRole: 'machine',
            contentPublicKey: new Uint8Array(ownerIdentity.content.publicKey), contentPublicKeySig: privacyKit.decodeBase64(ownerIdentity.body.contentPublicKeySig) } });
        const machineId = randomUUID();
        const resourceKey = new Uint8Array(randomBytes(32));
        await db.machine.create({ data: { id: machineId, accountId: owner.id, managedIdentityAccountId: owner.id, metadata: 'encrypted',
            dataEncryptionKey: privacyKit.decodeBase64(envelope(resourceKey, ownerIdentity.content.publicKey)) } });
        await db.machineGrant.create({ data: { machineId, accountId: member.id,
            dataEncryptionKey: privacyKit.decodeBase64(envelope(resourceKey, memberIdentity.content.publicKey)) } });
        const method = `${machineId}:managed-redis-read`;
        const submitted: unknown[] = [];
        const target = createFakeSocket({ id: 'redis-local-target', connected: true,
            data: { clientType: 'machine-scoped', machineId },
            timeout: vi.fn(() => ({ emitWithAck: async (...args: unknown[]) => { submitted.push(args); return 'resource-result'; } })) });
        const caller = createFakeSocket({ id: 'redis-caller', connected: true });
        const listeners = new Map<string, Map<string, ServerSocket>>([[owner.id, new Map([[method, target as unknown as ServerSocket]])]]);
        let releaseLookup!: () => void;
        let enteredLookup!: () => void;
        const released = new Promise<void>((resolve) => { releaseLookup = resolve; });
        const entered = new Promise<void>((resolve) => { enteredLookup = resolve; });
        redisBoundary.hmget.mockImplementation(async () => { enteredLookup(); await released; return [null]; });
        rpcHandler(member.id, caller as unknown as ServerSocket, new Map(), listeners, {
            io: {} as SocketServer, redisRegistry: { enabled: true, instanceId: 'managed-test' },
        });
        const acknowledge = vi.fn();
        const pending = triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: 'not-started-before-revoke' }, acknowledge);
        try {
            await entered;
            await db.machineGrant.delete({ where: { machineId_accountId: { machineId, accountId: member.id } } });
        } finally { releaseLookup(); }
        await pending;
        expect(submitted).toEqual([]);
        expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'Forbidden' }));
    });

    it('validates the whole invitation intent and rolls back ineligible redemption without role changes', async () => {
        const login = await app.inject({ method: 'POST', url: '/v1/auth', payload: administrator.body });
        const headers = { authorization: `Bearer ${login.json<{ token: string }>().token}` };
        const root = await db.account.findUniqueOrThrow({ where: { publicKey: administrator.publicKey } });
        const ownerIdentity = identity();
        const owner = await db.account.create({ data: { publicKey: ownerIdentity.publicKey, managedRole: 'machine' } });
        const liveId = randomUUID();
        await db.machine.create({ data: { id: liveId, accountId: owner.id, managedIdentityAccountId: owner.id, metadata: 'encrypted' } });
        async function invite(machineIds?: string[], kind: 'member' | 'machine' = 'member') {
            return app.inject({ method: 'POST', url: '/v1/account/invites', headers, payload: {
                kind, expiresAt: Date.now() + 60_000, ...(machineIds ? { machineIds } : {}),
            } });
        }
        const selected = await invite([liveId, liveId]);
        expect(selected.statusCode, selected.body).toBe(200);
        expect(selected.json()).toMatchObject({ machineIds: [liveId] });
        const selectedInvite = selected.json<{ id: string; token: string }>();
        expect((await db.managedAccountInvite.findUniqueOrThrow({ where: { id: selectedInvite.id } })).machineIds).toBe(JSON.stringify([liveId]));
        expect((await app.inject({ method: 'GET', url: '/v1/account/invites', headers })).json()).toMatchObject({ invites: expect.arrayContaining([expect.objectContaining({ id: selectedInvite.id, machineIds: [liveId] })]) });
        const legacyId = randomUUID();
        await db.machine.create({ data: { id: legacyId, accountId: root.id, metadata: 'legacy' } });
        const foreign = await db.account.create({ data: { publicKey: identity().publicKey } });
        const foreignId = randomUUID();
        await db.machine.create({ data: { id: foreignId, accountId: foreign.id, managedIdentityAccountId: foreign.id, metadata: 'foreign' } });
        const revokedId = randomUUID();
        const replacedId = randomUUID();
        for (const [id, data] of [[revokedId, { revokedAt: new Date() }], [replacedId, { replacedByMachineId: randomUUID() }]] as const) {
            const machineOwner = await db.account.create({ data: { publicKey: identity().publicKey, managedRole: 'machine' } });
            await db.machine.create({ data: { id, accountId: machineOwner.id, managedIdentityAccountId: machineOwner.id, metadata: 'retired', ...data } });
        }
        const inviteCount = await db.managedAccountInvite.count();
        for (const invalidId of [randomUUID(), legacyId, foreignId, revokedId, replacedId]) {
            expect((await invite([liveId, invalidId])).statusCode).toBe(404);
        }
        expect(await db.managedAccountInvite.count()).toBe(inviteCount);
        expect((await invite([liveId], 'machine')).statusCode).toBe(400);

        const memberIdentity = identity();
        const member = await db.account.create({ data: { publicKey: memberIdentity.publicKey, managedRole: 'member', firstName: 'keep member name' } });
        const joined = await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...memberIdentity.body, inviteToken: selectedInvite.token } });
        expect(joined.statusCode, joined.body).toBe(200);
        expect(await db.machineGrant.findMany({ where: { accountId: member.id } })).toEqual([expect.objectContaining({ machineId: liveId, dataEncryptionKey: null })]);
        expect((await db.account.findUniqueOrThrow({ where: { id: member.id } })).firstName).toBe('keep member name');
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...memberIdentity.body, inviteToken: selectedInvite.token } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: memberIdentity.body })).statusCode).toBe(200);
        const promotionIdentity = identity();
        const legacy = await db.account.create({ data: { publicKey: promotionIdentity.publicKey } });
        const promotion = (await invite([liveId])).json<{ id: string; token: string }>();
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...promotionIdentity.body, inviteToken: promotion.token } })).statusCode).toBe(200);
        expect((await db.account.findUniqueOrThrow({ where: { id: legacy.id } })).managedRole).toBe('member');
        expect(await db.machineGrant.count({ where: { accountId: legacy.id } })).toBe(1);
        const roleInvite = (await invite([liveId])).json<{ id: string; token: string }>();
        for (const person of [administrator, ownerIdentity]) {
            expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...person.body, inviteToken: roleInvite.token } })).statusCode).toBe(403);
        }
        const machineInvite = (await invite(undefined, 'machine')).json<{ id: string; token: string }>();
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...memberIdentity.body, inviteToken: machineInvite.token } })).statusCode).toBe(403);
        const memberToken = joined.json<{ token: string }>().token;
        expect((await app.inject({ method: 'PATCH', url: `/v1/account/members/${member.id}`, headers, payload: { disabled: true } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...memberIdentity.body, inviteToken: roleInvite.token } })).statusCode).toBe(403);
        expect(await db.machineGrant.count({ where: { accountId: member.id } })).toBe(0);
        expect((await app.inject({ method: 'GET', url: '/v1/account/access', headers: { authorization: `Bearer ${memberToken}` } })).statusCode).toBe(403);
        expect((await db.managedAccountInvite.findUniqueOrThrow({ where: { id: roleInvite.id } })).consumedAt).toBeNull();

        for (const retirement of ['removed', 'revoked', 'replaced'] as const) {
            const retireOwner = await db.account.create({ data: { publicKey: identity().publicKey, managedRole: 'machine' } });
            const retiringId = randomUUID();
            await db.machine.create({ data: { id: retiringId, accountId: retireOwner.id, managedIdentityAccountId: retireOwner.id, metadata: 'retiring' } });
            const bearer = (await invite([liveId, retiringId])).json<{ id: string; token: string }>();
            if (retirement === 'removed') await db.machine.delete({ where: { id: retiringId } });
            else await db.machine.update({ where: { id: retiringId }, data: retirement === 'revoked' ? { revokedAt: new Date() } : { replacedByMachineId: randomUUID() } });
            const person = identity();
            // Promotion must also roll back; a new identity must not be inserted at all.
            const prior = retirement === 'revoked' ? await db.account.create({ data: { publicKey: person.publicKey } }) : null;
            const beforeChanges = await db.accountChange.count();
            expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...person.body, inviteToken: bearer.token } })).statusCode).toBe(404);
            const after = await db.account.findUnique({ where: { publicKey: person.publicKey } });
            expect(after).toEqual(prior);
            expect(await db.machineGrant.count({ where: { accountId: after?.id ?? 'nonexistent' } })).toBe(0);
            expect(await db.accountChange.count()).toBe(beforeChanges);
            expect((await db.managedAccountInvite.findUniqueOrThrow({ where: { id: bearer.id } })).consumedAt).toBeNull();
        }
        for (const stored of ['{', '[42]', 'null']) {
            const corrupt = (await invite()).json<{ id: string; token: string }>();
            await db.managedAccountInvite.update({ where: { id: corrupt.id }, data: { machineIds: stored } });
            const person = identity();
            expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...person.body, inviteToken: corrupt.token } })).statusCode).toBe(403);
            expect(await db.account.findUnique({ where: { publicKey: person.publicKey } })).toBeNull();
            expect((await db.managedAccountInvite.findUniqueOrThrow({ where: { id: corrupt.id } })).consumedAt).toBeNull();
        }
        const inconsistent = (await invite(undefined, 'machine')).json<{ id: string; token: string }>();
        await db.managedAccountInvite.update({ where: { id: inconsistent.id }, data: { machineIds: JSON.stringify([liveId]) } });
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...identity().body, inviteToken: inconsistent.token } })).statusCode).toBe(403);
        const retiredAuthority = (await invite([liveId])).json<{ id: string; token: string }>();
        harness.resetEnv({ HAPPIER_ADMIN_PUBLIC_KEY: identity().publicKey });
        try {
            expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...identity().body, inviteToken: retiredAuthority.token } })).statusCode).toBe(403);
            expect((await db.managedAccountInvite.findUniqueOrThrow({ where: { id: retiredAuthority.id } })).consumedAt).toBeNull();
        } finally { harness.restoreEnv(); }
        const gated = (await invite([liveId])).json<{ id: string; token: string }>();
        const newPerson = identity();
        harness.resetEnv({ HAPPIER_BUILD_FEATURES_DENY: 'accounts.inviteMachineAssignment' });
        try {
            expect((await invite([liveId])).statusCode).toBe(404);
            expect((await invite()).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...newPerson.body, inviteToken: gated.token } })).statusCode).toBe(404);
            expect(await db.account.findUnique({ where: { publicKey: newPerson.publicKey } })).toBeNull();
            expect((await db.managedAccountInvite.findUniqueOrThrow({ where: { id: gated.id } })).consumedAt).toBeNull();
        } finally { harness.restoreEnv(); }
    });

    it.each(['member', 'machine'] as const)('authenticates a consumed %s invitation retry without replaying enrollment', async (kind) => {
        const rootLogin = await app.inject({ method: 'POST', url: '/v1/auth', payload: administrator.body });
        const rootHeaders = { authorization: `Bearer ${rootLogin.json<{ token: string }>().token}` };
        const owner = await db.account.create({ data: { publicKey: identity().publicKey, managedRole: 'machine' } });
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: owner.id, managedIdentityAccountId: owner.id, metadata: 'retry-machine' } });
        const invitationResponse = await app.inject({ method: 'POST', url: '/v1/account/invites', headers: rootHeaders,
            payload: { kind, expiresAt: Date.now() + 60_000, ...(kind === 'member' ? { machineIds: [machineId] } : {}) } });
        expect(invitationResponse.statusCode).toBe(200);
        const invitation = invitationResponse.json<{ id: string; token: string }>();
        const person = identity();
        const payload = { ...person.body, inviteToken: invitation.token };
        const enrolled = await app.inject({ method: 'POST', url: '/v1/auth', payload });
        expect(enrolled.statusCode, enrolled.body).toBe(200);
        const account = await db.account.findUniqueOrThrow({ where: { publicKey: person.publicKey } });
        if (kind === 'member') {
            expect(await db.machineGrant.count({ where: { machineId, accountId: account.id } })).toBe(1);
            expect((await app.inject({ method: 'DELETE', url: `/v1/machines/${machineId}/grants/${account.id}`, headers: rootHeaders })).statusCode).toBe(200);
        }
        const consumed = await db.managedAccountInvite.findUniqueOrThrow({ where: { id: invitation.id } });
        expect(consumed).toMatchObject({ consumedAt: expect.any(Date), consumedByAccountId: account.id });
        const beforeChanges = await db.accountChange.findMany();
        // Observe the real transport publisher without replacing any routing or domain behavior.
        const updates = vi.spyOn(eventRouter, 'emitUpdate');
        try {
            const retry = await app.inject({ method: 'POST', url: '/v1/auth', payload });
            expect(retry.statusCode, retry.body).toBe(200);
            const access = await app.inject({ method: 'GET', url: '/v1/account/access', headers: { authorization: `Bearer ${retry.json<{ token: string }>().token}` } });
            expect(access.json()).toMatchObject({ role: kind });
            expect(await db.account.findUniqueOrThrow({ where: { publicKey: person.publicKey } })).toMatchObject({ id: account.id, managedRole: kind });
            expect(await db.account.count({ where: { publicKey: person.publicKey } })).toBe(1);
            expect(await db.machineGrant.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.accountChange.findMany()).toEqual(beforeChanges);
            expect(await db.managedAccountInvite.findUniqueOrThrow({ where: { id: invitation.id } })).toEqual(consumed);
            expect(updates.mock.calls.filter(([event]) => event.payload.body.t === 'managed-access-changed')).toEqual([]);
        } finally { updates.mockRestore(); }
        expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...identity().body, inviteToken: invitation.token } })).statusCode).toBe(403);
        if (kind === 'machine') {
            const unrelated = (await app.inject({ method: 'POST', url: '/v1/account/invites', headers: rootHeaders,
                payload: { kind: 'machine', expiresAt: Date.now() + 60_000 } })).json<{ id: string; token: string }>();
            expect((await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...person.body, inviteToken: unrelated.token } })).statusCode).toBe(403);
            expect((await db.managedAccountInvite.findUniqueOrThrow({ where: { id: unrelated.id } })).consumedAt).toBeNull();
            await disableAccount({ accountId: account.id, reason: 'retry-test-disabled', env: process.env });
            expect((await app.inject({ method: 'POST', url: '/v1/auth', payload })).statusCode).toBe(403);
        } else {
            expect((await app.inject({ method: 'PATCH', url: `/v1/account/members/${account.id}`, headers: rootHeaders, payload: { disabled: true } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: '/v1/auth', payload })).statusCode).toBe(403);
        }
    });

    it('never converts an existing human identity into a machine credential with inherited resources', async () => {
        const legacy = identity();
        const account = await db.account.create({ data: { publicKey: legacy.publicKey } });
        await db.machine.createMany({ data: ['old-one', 'old-two'].map((suffix) => ({ id: `${account.id}-${suffix}`, accountId: account.id, metadata: 'legacy-ciphertext' })) });
        const login = await app.inject({ method: 'POST', url: '/v1/auth', payload: administrator.body });
        const headers = { authorization: `Bearer ${login.json<{ token: string }>().token}` };
        const invitation = await app.inject({ method: 'POST', url: '/v1/account/invites', headers, payload: { kind: 'machine', expiresAt: Date.now() + 60_000 } });
        const bearer = invitation.json<{ id: string; token: string }>();
        const converted = await app.inject({ method: 'POST', url: '/v1/auth', payload: { ...legacy.body, inviteToken: bearer.token } });
        expect(converted.statusCode).toBe(403);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).managedRole).toBe('unmanaged');
        expect((await db.managedAccountInvite.findUniqueOrThrow({ where: { id: bearer.id } })).consumedAt).toBeNull();
    });
});
