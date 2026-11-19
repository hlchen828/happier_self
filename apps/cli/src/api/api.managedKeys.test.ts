import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { Server } from 'socket.io';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { decodeBase64, deriveAccountMachineKeyFromRecoverySecret, MachineKeysPublishRequestSchema, openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1, encodeBase64 } from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createAccountProfileFixture, createAccountTokenFixture } from '@/testkit/backends/accountFixtures';

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
afterEach(() => { envScope.restore(); vi.resetModules(); });

describe('managed machine key delivery', () => {
  it.each(['api', 'by-tag'] as const)('binds %s session creation to the negotiated managed machine', async (entry) => {
    await withTempDir('happier-managed-session-', async (home) => {
      const app = fastify({ logger: false });
      app.get('/v1/features', async () => ({ features: { accounts: { machineAccess: { enabled: true } } }, capabilities: {} }));
      app.post('/v1/sessions', async (request, reply) => {
        const body = request.body as Record<string, unknown>;
        if (body.machineId !== 'm1') return reply.code(400).send({ error: 'managed_machine_id_required' });
        return { resolution: 'created', session: { ...body, id: 's1', seq: 1, createdAt: 1, updatedAt: 1,
          active: false, activeAt: 0, metadataVersion: 1, agentStateVersion: 0 } };
      });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: origin, HAPPIER_PUBLIC_SERVER_URL: origin, HAPPIER_WEBAPP_URL: origin });
      vi.resetModules();
      try {
        const identity = tweetnacl.box.keyPair();
        const credentials = { token: createAccountTokenFixture('machine'), encryption: {
          type: 'dataKey' as const, publicKey: identity.publicKey, machineKey: identity.secretKey,
        } };
        const metadata = { machineId: 'm1', path: home, host: 'test', homeDir: home,
          happyHomeDir: home, happyLibDir: home, happyToolsDir: home };
        if (entry === 'api') {
          const { ApiClient } = await import('./api');
          const api = await ApiClient.create(credentials);
          expect((await api.getOrCreateSession({ tag: 'tag', metadata, state: null }))?.id).toBe('s1');
        } else {
          const { getOrCreateSessionByTag } = await import('@/session/transport/http/sessionsHttp');
          expect((await getOrCreateSessionByTag({ credentials, tag: 'tag', metadata, agentState: null })).session.id).toBe('s1');
        }
      } finally { await app.close(); }
    });
  });

  it('delivers a real recipient-specific resource-key envelope after machine registration', async () => {
    await withTempDir('happier-managed-key-delivery-', async (home) => {
      const identity = tweetnacl.box.keyPair();
      const memberSeed = tweetnacl.randomBytes(32);
      const adminSeed = tweetnacl.randomBytes(32);
      const profiles = [
        createAccountProfileFixture({ accountId: 'admin', signingSeed: adminSeed }),
        createAccountProfileFixture({ accountId: 'member', signingSeed: memberSeed }),
      ];
      const recipients = profiles.map((profile) => ({ accountId: profile.id, publicKey: profile.publicKey!,
        contentPublicKey: profile.contentPublicKey!, contentPublicKeySig: profile.contentPublicKeySig! }));
      const publications: unknown[] = [];
      let corruptRecipientBinding = false;
      let holdRecipientRequest = false;
      let recipientRequestHeld = false;
      let releaseRecipientRequest: (() => void) | undefined;
      const sessionKeys = new Map(['s1', 's2', 's3'].map((id) => [id, tweetnacl.randomBytes(32)]));
      const sessionRow = (id: string) => ({ id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 0,
        metadata: 'encrypted', metadataVersion: 1, agentState: null, agentStateVersion: 0,
        dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKeys.get(id)!,
          recipientPublicKey: identity.publicKey, randomBytes: tweetnacl.randomBytes })) });
      const app = fastify({ logger: false });
      app.get('/v1/features', async () => ({ features: { accounts: { machineAccess: { enabled: true } } }, capabilities: {} }));
      app.get('/v1/account/access', async () => ({ managed: true, role: 'machine', adminAccountId: 'admin', machineId: null }));
      app.get('/v1/machines/m1', async (_request, reply) => reply.code(404).send({ error: 'not found' }));
      app.post('/v1/machines', async (request) => ({ machine: { ...(request.body as Record<string, unknown>), metadataVersion: 1, daemonStateVersion: 0 } }));
      app.get('/v1/machines/m1/recipients', async () => {
        if (holdRecipientRequest) {
          recipientRequestHeld = true;
          await new Promise<void>((resolve) => { releaseRecipientRequest = resolve; });
        }
        return { machineId: 'm1', recipients: corruptRecipientBinding
          ? recipients.map((recipient) => ({ ...recipient, contentPublicKeySig: encodeBase64(new Uint8Array(64)) }))
          : recipients };
      });
      app.get('/v2/sessions', async (request) => {
        const cursor = (request.query as Record<string, unknown>).cursor;
        return cursor === 'page-2'
          ? { sessions: [sessionRow('s2')], nextCursor: null, hasNext: false }
          : { sessions: [sessionRow('s1')], nextCursor: 'page-2', hasNext: true };
      });
      app.get('/v2/sessions/s3', async () => ({ session: sessionRow('s3') }));
      app.get('/v2/changes', async () => ({ changes: [], nextCursor: 0 }));
      app.get('/v1/account/profile', async () => ({ id: 'machine' }));
      app.put('/v1/machines/m1/keys', async (request) => { publications.push(request.body); return { success: true }; });
      const relay = new Server(app.server, { path: '/v1/updates' });
      relay.on('connection', (socket) => {
        socket.on(SOCKET_RPC_EVENTS.REGISTER, (payload) => socket.emit(SOCKET_RPC_EVENTS.REGISTERED, payload));
        socket.on('ping', (ack) => ack({ v: 1 }));
        socket.on('machine-update-state', (payload, ack) => ack({ result: 'success', version: payload.expectedVersion + 1, daemonState: payload.daemonState }));
      });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: origin, HAPPIER_PUBLIC_SERVER_URL: origin, HAPPIER_WEBAPP_URL: origin });
      vi.resetModules();
      try {
        const { ApiClient } = await import('./api');
        const api = await ApiClient.create({ token: createAccountTokenFixture('machine'), encryption: {
          type: 'dataKey', publicKey: identity.publicKey, machineKey: identity.secretKey,
        } });
        const machine = await api.getOrCreateMachine({ machineId: 'm1', metadata: {
          host: 'test-machine', platform: 'linux', happyCliVersion: '0.2.20', homeDir: home,
          happyHomeDir: home, happyLibDir: home,
        } });
        expect(publications).toHaveLength(2);
        const payload = MachineKeysPublishRequestSchema.parse(publications[0]);
        const assertSessionEnvelope = (publication: unknown, sessionId: string) => {
          const row = MachineKeysPublishRequestSchema.parse(publication).sessions.find((session) => session.sessionId === sessionId)!;
          expect(row).toBeDefined();
          for (const [accountId, seed] of [['member', memberSeed], ['admin', adminSeed]] as const) {
            expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(row.recipients.find((recipient) => recipient.accountId === accountId)!.dataEncryptionKey),
              recipientSecretKeyOrSeed: deriveAccountMachineKeyFromRecoverySecret(seed) })).toEqual(sessionKeys.get(sessionId));
          }
        };
        assertSessionEnvelope(publications[0], 's1');
        assertSessionEnvelope(publications[1], 's2');
        expect(payload.recipients.map((row) => row.accountId)).toEqual(['admin', 'member']);
        const memberEnvelope = payload.recipients.find((row) => row.accountId === 'member')!.dataEncryptionKey;
        expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(memberEnvelope),
          recipientSecretKeyOrSeed: deriveAccountMachineKeyFromRecoverySecret(memberSeed) })).toEqual(machine.encryptionKey);
        expect(machine.encryptionKey).not.toEqual(identity.secretKey);
        expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(memberEnvelope),
          recipientSecretKeyOrSeed: deriveAccountMachineKeyFromRecoverySecret(adminSeed) })).toBeNull();
        const client = api.machineSyncClient(machine);
        // Execution is an OS/provider boundary; this key-delivery recipe must not start tasks.
        const unexpectedExecution = async (): Promise<never> => { throw new Error('Unexpected task execution'); };
        client.setRPCHandlers({
          spawnSession: unexpectedExecution,
          resolveSpawnSessionByNonce: unexpectedExecution,
          stopSession: unexpectedExecution,
          requestShutdown: () => { throw new Error('Unexpected daemon shutdown'); },
        });
        try {
          client.connect();
          await vi.waitFor(() => expect(relay.sockets.sockets.size).toBe(1));
          await vi.waitFor(() => expect(publications).toHaveLength(4));
          publications.length = 0;
          relay.emit('update', { id: 'new-session', seq: 2, createdAt: 1,
            body: { t: 'managed-access-changed', machineId: 'm1', sessionId: 's3' } });
          await vi.waitFor(() => expect(publications).toHaveLength(1));
          expect(MachineKeysPublishRequestSchema.parse(publications[0]).recipients).toEqual([]);
          assertSessionEnvelope(publications[0], 's3');
          publications.length = 0;
          relay.emit('update', { id: 'access-change', seq: 3, createdAt: 1,
            body: { t: 'managed-access-changed', machineId: 'm1' } });
          await vi.waitFor(() => expect(publications).toHaveLength(2));
          assertSessionEnvelope(publications[0], 's1');
          assertSessionEnvelope(publications[1], 's2');
          publications.length = 0;
          const disconnectedSocket = [...relay.sockets.sockets.values()][0];
          disconnectedSocket.conn.close();
          await vi.waitFor(() => {
            expect([...relay.sockets.sockets.values()].some((socket) => socket.id !== disconnectedSocket.id)).toBe(true);
            expect(publications).toHaveLength(2);
          }, { timeout: 5000 });
          assertSessionEnvelope(publications[0], 's1');
          assertSessionEnvelope(publications[1], 's2');
          publications.length = 0;
          holdRecipientRequest = true;
          relay.emit('update', { id: 'held-delivery', seq: 4, createdAt: 1,
            body: { t: 'managed-access-changed', machineId: 'm1' } });
          await vi.waitFor(() => expect(recipientRequestHeld).toBe(true));
          // Closing the client must cancel a live HTTP read, not await an unavailable holder.
          await client.shutdown();
          expect(publications).toEqual([]);
        } finally { releaseRecipientRequest?.(); await client.shutdown(); }
        holdRecipientRequest = false;
        publications.length = 0;
        corruptRecipientBinding = true;
        const { publishManagedMachineKeys } = await import('@/api/machine/managedMachineKeyDelivery');
        await expect(publishManagedMachineKeys({ machine, credentials: { token: createAccountTokenFixture('machine'),
          encryption: { type: 'dataKey', publicKey: identity.publicKey, machineKey: identity.secretKey } } })).rejects.toThrow();
        expect(publications).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await app.close();
      }
    });
  });
});
