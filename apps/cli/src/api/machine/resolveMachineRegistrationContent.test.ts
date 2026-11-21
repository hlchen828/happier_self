import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { encodeBase64, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
afterEach(() => { envScope.restore(); vi.resetModules(); });

describe('managed machine registration content', () => {
  it.each([false, true])('uses an independent resource key and preserves the published key on restart (existing=%s)', async (existing) => {
    const identity = tweetnacl.box.keyPair();
    const credentials = { token: 'machine-only', encryption: {
      type: 'dataKey' as const, publicKey: identity.publicKey, machineKey: identity.secretKey,
    } };
    const publishedKey = new Uint8Array(32).fill(91);
    const publishedEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: publishedKey, recipientPublicKey: identity.publicKey, randomBytes: (length) => tweetnacl.randomBytes(length),
    }));
    const app = fastify({ logger: false });
    app.get('/v1/features', async () => ({ features: { accounts: { machineAccess: { enabled: true } } }, capabilities: {} }));
    app.get('/v1/account/access', async () => ({ managed: true, role: 'machine', adminAccountId: 'admin', machineId: existing ? 'm1' : null }));
    app.get('/v1/machines/m1', async (_request, reply) => existing
      ? { machine: { id: 'm1', dataEncryptionKey: publishedEnvelope } }
      : reply.code(404).send({ error: 'Machine not found' }));
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    envScope.patch({ HAPPIER_SERVER_URL: origin, HAPPIER_PUBLIC_SERVER_URL: origin, HAPPIER_WEBAPP_URL: origin });
    vi.resetModules();
    try {
      const { resolveMachineRegistrationContent } = await import('./resolveMachineRegistrationContent');
      const result = await resolveMachineRegistrationContent({ credentials, machineId: 'm1' });
      expect(result.context.encryptionKey).not.toEqual(identity.secretKey);
      expect(result.context.encryptionVariant).toBe('dataKey');
      expect(result.accountMode).toBe('e2ee');
      if (existing) {
        expect(result.context.encryptionKey).toEqual(publishedKey);
        expect(result.dataEncryptionKey).toBe(publishedEnvelope);
      }
    } finally { await app.close(); }
  });
});
