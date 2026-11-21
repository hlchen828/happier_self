import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { openEncryptedDataKeyEnvelopeV1, RPC_METHODS } from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import {
  createSessionFromNewSessionComposer,
  reloadCreatedSessionFromNewSessionComposer,
} from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { selectSessionForkStrategy } from '../../src/testkit/uiE2e/selectSessionForkStrategy';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { ensureSessionReplayForkEnabled } from '../../src/testkit/uiE2e/ensureSessionReplayForkEnabled';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { createTestAuthIdentity } from '../../src/testkit/auth';
import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { fetchJson } from '../../src/testkit/http';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { decryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { unwrapSerializedJsonValue } from '../../src/testkit/unwrapSerializedJsonValue';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function restoreIdentity(page: Page, uiBaseUrl: string, identity: ReturnType<typeof createTestAuthIdentity>) {
  await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
  await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/restore/manual`);
  await page.getByTestId('restore-manual-secret-input').fill(Buffer.from(identity.recoverySecret).toString('base64url'));
  const authOk = page.waitForResponse((response) => response.url().endsWith('/v1/auth') && response.status() === 200);
  await expect(page.getByTestId('restore-manual-submit')).toBeEnabled();
  await page.getByTestId('restore-manual-submit').click();
  await authOk;
  await page.waitForURL((url) => !url.pathname.endsWith('/restore/manual'));
  await ensureAccountReadyForConnect({ page, clickCreateAccount: false, timeoutMs: 120_000 });
}

async function api<T>(server: StartedServer, token: string | null, path: string, body?: unknown, method?: string) {
  return await fetchJson<T>(`${server.baseUrl}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    timeoutMs: 20_000,
  });
}

for (const managed of [false, true]) {
  test.describe(`ui e2e: ${managed ? 'managed' : 'ordinary'} session fork from header action menu`, () => {
    const suiteDir = run.testDir(`session-fork-from-header-${managed ? 'managed' : 'ordinary'}`);
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
    const administrator = managed ? createTestAuthIdentity() : null;
    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
      test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
      await mkdir(cliHomeDir, { recursive: true });
      await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');
      server = await startServerLight({
        testDir: suiteDir,
        dbProvider: 'sqlite',
        extraEnv: {
          HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys,providers.claude.unifiedTerminal',
          HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
          HAPPIER_ADMIN_PUBLIC_KEY: administrator?.publicKeyHex ?? '',
        },
      });
      ui = await startUiWeb({
        testDir: suiteDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
          EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-${managed ? 'managed' : 'ordinary'}`,
        },
      });
      uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
      test.setTimeout(120_000);
      await daemon?.stop().catch(() => {});
      await ui?.stop().catch(() => {});
      await server?.stop().catch(() => {});
    });

    test('Replay creates a correctly bound child, opens lineage, and enforces machine grants', { tag: '@smoke' }, async ({ page }, testInfo) => {
      test.setTimeout(300_000);
      if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');
      const diagnostics = collectBrowserDiagnostics({ page });
      try {
        await page.setViewportSize({ width: 1440, height: 900 });
        const testDir = resolve(join(suiteDir, 'fork-header'));
        await mkdir(testDir, { recursive: true });
        const daemonEnv: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: cliHomeDir,
          HAPPIER_HOME_DIR: cliHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: uiBaseUrl,
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-${managed}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}-${managed}`,
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'transcript-activity-feed',
        };
        let memberToken: string | null = null;
        let administratorToken: string | null = null;
        let member: ReturnType<typeof createTestAuthIdentity> | null = null;
        if (administrator) {
          const login = await api<{ token: string }>(server, null, '/v1/auth', administrator.body);
          expect(login.status).toBe(200);
          administratorToken = login.data.token;
          expect((await api(server, administratorToken, '/v1/account/access')).data).toMatchObject({ managed: true, role: 'admin' });
          const invitation = await api<{ token: string }>(server, administratorToken, '/v1/account/invites', { kind: 'machine', name: 'Replay fixture daemon', expiresAt: Date.now() + 120_000 });
          expect(invitation.status).toBe(200);
          const launch = await resolveCliTestLaunchSpec({ testDir, env: daemonEnv }, { snapshotDir: join(testDir, 'cli-source') });
          await runLoggedCommand({
            command: launch.command,
            args: [...launch.args, 'auth', 'enroll', '--invite', invitation.data.token],
            cwd: launch.cwd ?? testDir,
            env: { ...daemonEnv, ...launch.env },
            stdoutPath: join(testDir, 'enroll.stdout.log'),
            stderrPath: join(testDir, 'enroll.stderr.log'),
          });
          daemon = await startTestDaemon({ testDir, happyHomeDir: cliHomeDir, env: daemonEnv });
        } else {
          await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
          await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
          daemon = await authenticateAndStartDaemon({ page, testDir, cliHomeDir, serverUrl: server.baseUrl, uiBaseUrl, extraEnv: daemonEnv });
        }
        const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 120_000 });
        const credentials = await readCliAccessKey(cliHomeDir);
        if (!credentials) throw new Error('missing isolated daemon credentials');
        const daemonProfile = await api<{ id: string }>(server, credentials.token, '/v1/account/profile');
        expect(daemonProfile.status).toBe(200);
        await expect.poll(async () => (await api(server!, credentials.token, `/v1/machines/${machineId}`)).status,
          { message: 'enrolled daemon machine registration', timeout: 60_000 }).toBe(200);
        if (administratorToken) {
          expect((await api(server, credentials.token, '/v1/account/access')).data).toMatchObject({ managed: true, role: 'machine' });
          member = createTestAuthIdentity();
          const invitation = await api<{ token: string }>(server, administratorToken, '/v1/account/invites', { kind: 'member', name: 'Replay fixture member', machineIds: [machineId], expiresAt: Date.now() + 120_000 });
          expect(invitation.status).toBe(200);
          const login = await api<{ token: string }>(server, null, '/v1/auth', { ...member.body, inviteToken: invitation.data.token });
          expect(login.status).toBe(200);
          memberToken = login.data.token;
          await expect.poll(async () => (await api<Array<{ id: string; managedAccessStatus: string }>>(server!, memberToken, '/v1/machines')).data.find((machine) => machine.id === machineId)?.managedAccessStatus, { timeout: 60_000 }).toBe('ready');
          await restoreIdentity(page, uiBaseUrl, member);
        }
        const parentSession = await createSessionFromNewSessionComposer({ page, uiBaseUrl, machineId, prompt: `fork-header-parent ${run.runId}` });
        const parentSessionId = parentSession.sessionId;
        await expect(page.getByText(/FAKE_TRANSCRIPT_ACTIVITY_FEED_DONE_1/)).toHaveCount(1, { timeout: 180_000 });
        await ensureSessionReplayForkEnabled({ page, uiBaseUrl });
        await reloadCreatedSessionFromNewSessionComposer({ page, session: parentSession });
        await expect(page.getByText(/FAKE_TRANSCRIPT_ACTIVITY_FEED_DONE_1/)).toHaveCount(1, { timeout: 180_000 });
        await page.getByLabel('Open session actions').click();
        await expect(page.getByRole('button', { name: /Fork session/i })).toHaveCount(1, { timeout: 60_000 });
        await page.getByRole('button', { name: /Fork session/i }).click();
        await selectSessionForkStrategy(page, 'replay');
        await page.waitForURL((url) => url.pathname.startsWith('/session/') && url.pathname !== `/session/${parentSessionId}`, { timeout: 120_000 });
        const childSessionId = new URL(page.url()).pathname.split('/').filter(Boolean)[1]!;
        expect(childSessionId).not.toBe(parentSessionId);
        const divider = page.getByTestId(`transcript-fork-divider:${parentSessionId}:${childSessionId}`);
        await expect(divider).toBeVisible({ timeout: 120_000 });
        // Playwright visibility does not detect an opaque pointer-events:none overlay. Wait for
        // the real first-paint presentation gate, then bring committed parent content into view.
        await expect(page.getByTestId('transcript-first-paint-placeholder')).toHaveCount(0, { timeout: 120_000 });
        const parentCommittedTurn = page.getByTestId('transcript-chat-list').getByText(/FAKE_TRANSCRIPT_ACTIVITY_FEED_DONE_1/).first();
        await parentCommittedTurn.scrollIntoViewIfNeeded();
        await expect(parentCommittedTurn).toBeVisible({ timeout: 120_000 });
        await divider.scrollIntoViewIfNeeded();
        await expect(divider).toBeInViewport();
        await expect(parentCommittedTurn).toBeInViewport();
        await expect(page.getByTestId('transcript-first-paint-placeholder')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('replay-child-lineage.png'), animations: 'disabled' });

        // The SQL binding is the server's authorization fact; decrypted metadata alone cannot prove it.
        const database = new DatabaseSync(join(server.dataDir, 'happier-server-light.sqlite'), { readOnly: true });
        try {
          const rows = database.prepare('SELECT id, accountId, machineId FROM Session WHERE id IN (?, ?) ORDER BY id').all(parentSessionId, childSessionId);
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            expect(row).toMatchObject({ accountId: daemonProfile.data.id });
            // Ordinary sessions use encrypted metadata for placement; managed sessions also persist
            // the server-verified authorization binding (registerSessionCreateOrLoadRoute).
            if (managed) expect(row).toMatchObject({ machineId });
          }
          expect(database.prepare('SELECT id, accountId FROM Machine WHERE id = ?').get(machineId))
            .toMatchObject({ id: machineId, accountId: daemonProfile.data.id });
          if (!managed) {
            await expect.poll(() => database.prepare('SELECT accountId, machineId, sessionId FROM AccessKey WHERE sessionId = ?').get(childSessionId),
              { message: 'Replay child runner enrolled-machine access key', timeout: 60_000 })
              .toMatchObject({ accountId: daemonProfile.data.id, machineId, sessionId: childSessionId });
          }
          const child = await api<{ session: { metadata: string; dataEncryptionKey: string | null } }>(server, credentials.token, `/v2/sessions/${childSessionId}`);
          expect(child.status).toBe(200);
          let childKey: Uint8Array | null = null;
          const metadata = 'encryption' in credentials
            ? (() => {
              childKey = openEncryptedDataKeyEnvelopeV1({ envelope: new Uint8Array(Buffer.from(child.data.session.dataEncryptionKey!, 'base64')), recipientSecretKeyOrSeed: new Uint8Array(Buffer.from(credentials.encryption.machineKey, 'base64')) });
              if (!childKey) throw new Error('daemon cannot decrypt child data key');
              return unwrapSerializedJsonValue(decryptDataKeyBase64(child.data.session.metadata, childKey));
            })()
            : unwrapSerializedJsonValue(decryptLegacyBase64(child.data.session.metadata, new Uint8Array(Buffer.from(credentials.secret, 'base64'))));
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('forkV1' in metadata)) {
            throw new Error('Expected decryptable child metadata with fork lineage');
          }
          expect(metadata).toMatchObject({ machineId, forkV1: { v: 1, parentSessionId, strategy: 'replay' } });
          if (memberToken && member && administratorToken) {
            const visibleChild = await api<{ session: { metadata: string; dataEncryptionKey: string } }>(server, memberToken, `/v2/sessions/${childSessionId}`);
            expect(visibleChild.status).toBe(200);
            const memberKey = openEncryptedDataKeyEnvelopeV1({ envelope: new Uint8Array(Buffer.from(visibleChild.data.session.dataEncryptionKey, 'base64')), recipientSecretKeyOrSeed: member.machineKey });
            expect(memberKey).toEqual(childKey);
            expect(unwrapSerializedJsonValue(decryptDataKeyBase64(visibleChild.data.session.metadata, memberKey!))).toMatchObject({ forkV1: { parentSessionId } });
            const spoofed = await api(server, credentials.token, '/v1/sessions', { tag: randomUUID(), machineId: randomUUID(), metadata: child.data.session.metadata, dataEncryptionKey: child.data.session.dataEncryptionKey });
            expect(spoofed.status).toBe(403);
            const memberProfile = await api<{ id: string }>(server, memberToken, '/v1/account/profile');
            expect((await api(server, administratorToken, `/v1/machines/${machineId}/grants/${memberProfile.data.id}`, undefined, 'DELETE')).status).toBe(200);
            expect((await api(server, memberToken, `/v2/sessions/${childSessionId}`)).status).toBe(404);
            const socket = createUserScopedSocketCollector(server.baseUrl, memberToken);
            try {
              socket.connect();
              await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });
              const denied = await socket.rpcCall<{ ok: boolean; error?: string }>(`${machineId}:${RPC_METHODS.SESSION_FORK}`, 'not-a-ciphertext', 20_000, { kind: 'session.write', sessionId: parentSessionId });
              expect(denied).toEqual({ ok: false, error: 'Forbidden' });
            } finally {
              socket.close();
            }
            expect(database.prepare('SELECT count(*) AS count FROM Session').get()?.count).toBe(2);
          }
          await testInfo.attach('Replay binding and lineage', { body: JSON.stringify({ managed, machineId, ownerAccountId: daemonProfile.data.id, parentSessionId, childSessionId, lineage: metadata.forkV1, persistedBindings: rows }), contentType: 'application/json' });
        } finally {
          database.close();
        }
      } catch (error) {
        await page.screenshot({ path: testInfo.outputPath('replay-failure.png'), animations: 'disabled' }).catch(() => {});
        throw appendBrowserDiagnostics(error, diagnostics());
      }
    });
  });
}
