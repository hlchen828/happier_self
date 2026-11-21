import axios from 'axios';
import {
  decodeBase64,
  encodeBase64,
  MachineKeyRecipientsResponseSchema,
  ManagedAccessChangedUpdateBodySchema,
  sealEncryptedDataKeyEnvelopeV1,
  verifyAccountContentPublicKeyBinding,
  type MachineKeysPublishRequest,
  type MachineKeyRecipient,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { Machine } from '@/api/types';
import type { ApiMachineClient } from '@/api/apiMachine';
import { getRandomBytes } from '@/api/encryption';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { configuration } from '@/configuration';
import { fetchSessionById, fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
import { logger } from '@/ui/logger';

interface DeliveryParams {
  credentials: Credentials;
  machine: Machine;
  signal?: AbortSignal;
  sessionId?: string;
}

function sealForRecipients(key: Uint8Array, recipients: readonly MachineKeyRecipient[]) {
  return recipients.map((recipient) => ({
    accountId: recipient.accountId,
    dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: key, recipientPublicKey: decodeBase64(recipient.contentPublicKey), randomBytes: getRandomBytes,
    })),
  }));
}

/** Only the holding client opens keys; the relay receives recipient-specific envelopes. */
export async function publishManagedMachineKeys(params: DeliveryParams): Promise<void> {
  if (params.machine.encryptionVariant !== 'dataKey' || params.credentials.encryption?.type !== 'dataKey') {
    throw new Error('Managed machine key delivery requires independent resource and identity keys.');
  }
  const url = `${resolveServerHttpBaseUrl()}/v1/machines/${encodeURIComponent(params.machine.id)}`;
  const options = { headers: { Authorization: `Bearer ${params.credentials.token}` },
    timeout: configuration.sessionControlHttpTimeoutMs, ...(params.signal ? { signal: params.signal } : {}) };
  const response = await axios.get<unknown>(`${url}/recipients`, options);
  const { machineId, recipients } = MachineKeyRecipientsResponseSchema.parse(response.data);
  if (machineId !== params.machine.id) throw new Error('Key-delivery machine identity mismatch.');
  for (const recipient of recipients) {
    if (!verifyAccountContentPublicKeyBinding({ signingPublicKeyHex: recipient.publicKey,
      contentPublicKeyB64: recipient.contentPublicKey, contentPublicKeySigB64: recipient.contentPublicKeySig })) {
      throw new Error('Refusing key delivery to an invalid recipient content-key binding.');
    }
  }
  const publish = async (payload: MachineKeysPublishRequest) => {
    params.signal?.throwIfAborted();
    const result = await axios.put<unknown>(`${url}/keys`, payload, options);
    const body = result.data;
    if (!body || typeof body !== 'object' || !('success' in body) || body.success !== true) {
      throw new Error('The relay did not confirm managed key delivery.');
    }
  };
  const sealSession = (session: Readonly<{ id: string; dataEncryptionKey?: string | null }>) => {
    const key = openSessionDataEncryptionKey({ credential: params.credentials, encryptedDataEncryptionKeyBase64: session.dataEncryptionKey });
    if (!key || key.length !== 32) throw new Error('A managed session has no readable resource-key envelope.');
    return { sessionId: session.id, recipients: sealForRecipients(key, recipients) };
  };
  if (params.sessionId) {
    const session = await fetchSessionById({ token: params.credentials.token, sessionId: params.sessionId, signal: params.signal });
    if (session) await publish({ recipients: [], sessions: [sealSession(session)] });
    return;
  }
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let first = true;
  do {
    params.signal?.throwIfAborted();
    const page = await fetchSessionsPage({ token: params.credentials.token, cursor, signal: params.signal });
    await publish({ recipients: first ? sealForRecipients(params.machine.encryptionKey, recipients) : [],
      sessions: page.sessions.map(sealSession) });
    first = false;
    if (!page.hasNext) return;
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw new Error('The relay returned an invalid cursor during historical key delivery.');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
}

/** Reconcile on real access/session changes and reconnect, never on an idle timer. */
export function startManagedMachineKeyDelivery(params: Readonly<{
  client: Pick<ApiMachineClient, 'onUpdate' | 'onConnectionStateChange'>;
  credentials: Credentials;
  machine: Machine;
}>): Readonly<{ close: () => Promise<void> }> {
  const abort = new AbortController();
  let fullPending = false;
  const sessionsPending = new Set<string>();
  let running: Promise<void> | null = null;
  const request = (sessionId?: string) => {
    if (abort.signal.aborted) return;
    if (sessionId) sessionsPending.add(sessionId);
    else fullPending = true;
    if (running) return;
    running = (async () => {
      while (!abort.signal.aborted && (fullPending || sessionsPending.size > 0)) {
        const full = fullPending;
        fullPending = false;
        const ids = [...sessionsPending];
        sessionsPending.clear();
        try {
          if (full) await publishManagedMachineKeys({ ...params, signal: abort.signal });
          else for (const id of ids) await publishManagedMachineKeys({ ...params, signal: abort.signal, sessionId: id });
        } catch (error) {
          if (!abort.signal.aborted) logger.warn('[MANAGED MACHINE] Key delivery failed; affected resources remain pending. Reconnect to retry.', {
            error: serializeAxiosErrorForLog(error),
          });
        }
      }
    })().finally(() => { running = null; });
  };
  const offUpdate = params.client.onUpdate((update) => {
    const hint = ManagedAccessChangedUpdateBodySchema.safeParse(update.body);
    if (!hint.success || (hint.data.machineId && hint.data.machineId !== params.machine.id)) return false;
    request(hint.data.sessionId);
    return true;
  });
  const offConnection = params.client.onConnectionStateChange((state) => {
    if (state.phase === 'online') request();
  });
  return { close: async () => {
    abort.abort();
    offUpdate();
    offConnection();
    fullPending = false;
    sessionsPending.clear();
    await running;
  } };
}
