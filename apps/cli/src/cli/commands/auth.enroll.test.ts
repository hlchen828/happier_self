import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { projectPath } from '@/projectPath';
import { resolveTsxImportHookPath, toNodeImportSpecifier } from '@/utils/spawnHappyCLI';
import { spawnTestProcess } from '@/testkit/process/spawn';
import tweetnacl from 'tweetnacl';
import { createAccountContentPublicKeyBindingMessage } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL',
]);

afterEach(() => {
  envScope.restore();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('auth enroll machine identity', () => {
  it.each(['auth-response', 'role-probe'] as const)('recovers the same machine identity after a lost %s response consumes its invitation', async (failure) => {
    await withTempDir('happier-enrollment-retry-', async (home) => {
      const app = fastify({ logger: false });
      let enrolledSigningKey: string | null = null;
      let interrupted = false;
      app.get('/v1/features', async () => ({ features: { accounts: { machineAccess: { enabled: true } } }, capabilities: {} }));
      app.post('/v1/auth', async (request, reply) => {
        const body = request.body as Record<string, string>;
        if (enrolledSigningKey && body.publicKey !== enrolledSigningKey) return reply.code(403).send({ error: 'invitation-consumed' });
        enrolledSigningKey = body.publicKey;
        if (failure === 'auth-response' && !interrupted) { interrupted = true; return reply.code(503).send({ error: 'response-lost' }); }
        return { success: true, token: 'recovered-machine-token' };
      });
      app.get('/v1/account/access', async (_request, reply) => {
        if (failure === 'role-probe' && !interrupted) { interrupted = true; return reply.code(503).send({ error: 'temporarily-unavailable' }); }
        return { managed: true, role: 'machine', adminAccountId: 'administrator', machineId: null };
      });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: origin, HAPPIER_PUBLIC_SERVER_URL: origin, HAPPIER_WEBAPP_URL: origin });
      vi.resetModules();
      // Run the actual public CLI twice: real stderr object formatting and an OS-process
      // restart must not be replaced by String(error) capture or module-only reload.
      const runEnrollment = async () => {
        const hook = resolveTsxImportHookPath();
        if (!hook) throw new Error('Source CLI test requires the workspace tsx hook');
        const child = spawnTestProcess(process.execPath, [
          '--import', toNodeImportSpecifier(hook), join(projectPath(), 'src', 'index.ts'),
          'auth', 'enroll', '--invite', 'one-use-machine-invite',
        ], {
          cwd: projectPath(),
          env: {
            ...process.env, DEBUG: '1', HAPPIER_CLI_UPDATE_CHECK: '0', HAPPIER_CLI_RUNTIME_DISABLE: '1',
            DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        try {
          const [code] = await once(child, 'close');
          return { code, stdout, stderr };
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }
      };
      try {
        const failed = await runEnrollment();
        expect(failed.code).toBe(1);
        expect(interrupted).toBe(true);
        expect(failed.stderr).toContain('503');
        const retry = await runEnrollment();
        expect(retry.code).toBe(0);
        const { readCredentials } = await import('@/persistence');
        expect((await readCredentials())?.token).toBe('recovered-machine-token');
        const logs = await Promise.all((await readdir(join(home, 'logs'))).map(
          (name) => readFile(join(home, 'logs', name), 'utf8'),
        ));
        const diagnostics = [failed.stdout, failed.stderr, retry.stdout, retry.stderr, ...logs].join('\n');
        expect(diagnostics.includes('one-use-machine-invite')).toBe(false);
        expect(diagnostics.includes('recovered-machine-token')).toBe(false);
      } finally { await app.close(); }
    });
  }, 30_000);

  it('joins with an independent signing/content identity and persists no administrator credentials', async () => {
    await withTempDir('happier-machine-enroll-', async (home) => {
      const app = fastify({ logger: false });
      let acceptedPublicKey: Uint8Array | null = null;
      app.get('/v1/features', async () => ({
        features: { accounts: { machineAccess: { enabled: true } } }, capabilities: {},
      }));
      app.post('/v1/auth', async (request) => {
        const body = request.body as Record<string, string>;
        expect(body.inviteToken).toBe('one-use-machine-invite');
        const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
        const publicKey = bytes(body.publicKey);
        expect(tweetnacl.sign.detached.verify(bytes(body.challenge), bytes(body.signature), publicKey)).toBe(true);
        acceptedPublicKey = bytes(body.contentPublicKey);
        expect(tweetnacl.sign.detached.verify(
          createAccountContentPublicKeyBindingMessage(acceptedPublicKey), bytes(body.contentPublicKeySig), publicKey,
        )).toBe(true);
        return { success: true, token: 'independent-machine-token' };
      });
      app.get('/v1/account/access', async () => ({
        managed: true, role: 'machine', adminAccountId: 'administrator', machineId: null,
      }));
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: origin,
        HAPPIER_PUBLIC_SERVER_URL: origin, HAPPIER_WEBAPP_URL: origin });
      vi.resetModules();
      vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`Unexpected process exit: ${code}`); });
      const output = captureConsoleLogAndMuteStdout();
      try {
        const { handleAuthCommand } = await import('./auth');
        await handleAuthCommand(['enroll', '--invite', 'one-use-machine-invite']);
        const { readCredentials } = await import('@/persistence');
        const credentials = await readCredentials();
        expect(credentials?.token).toBe('independent-machine-token');
        expect(credentials?.encryption?.type).toBe('dataKey');
        if (credentials?.encryption?.type !== 'dataKey') throw new Error('Expected independent machine keys');
        expect(tweetnacl.box.keyPair.fromSecretKey(credentials.encryption.machineKey).publicKey).toEqual(acceptedPublicKey);
        expect(output.logs.join('\n')).not.toContain('one-use-machine-invite');
        expect(output.logs.join('\n')).not.toContain('independent-machine-token');
      } finally {
        output.restore();
        await app.close();
      }
    });
  });
});
