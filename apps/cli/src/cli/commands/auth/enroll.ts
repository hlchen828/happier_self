import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import {
  createAccountContentPublicKeyBindingMessage,
  deriveAccountMachineKeyFromRecoverySecret,
  ManagedAccountAccessResponseSchema,
  readServerEnabledBit,
} from '@happier-dev/protocol';

import { authChallenge, encodeBase64, getRandomBytes } from '@/api/encryption';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readCredentials, writeCredentialsDataKey } from '@/persistence';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';

/** Retain the independent identity before a one-use invitation can be consumed remotely. */
async function readOrCreateMachineSigningSeed(): Promise<Uint8Array> {
  const dir = join(configuration.activeServerDir, 'auth');
  const path = join(dir, 'machine-identity.key');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, getRandomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  const seed = new Uint8Array(await readFile(path));
  if (seed.length !== 32) throw new Error('Stored machine identity is invalid; it will not be replaced.');
  return seed;
}

/** An enrollment creates a machine-only identity, never a copy of administrator credentials. */
export async function handleAuthEnroll(args: string[]): Promise<void> {
  args = await applyServerSelectionFromArgs(args);
  const inviteIndex = args.indexOf('--invite');
  const inviteToken = inviteIndex >= 0 ? args[inviteIndex + 1]?.trim() : '';
  if (!inviteToken || inviteToken.startsWith('--')) {
    throw new Error('A machine invitation is required: happier auth enroll --invite <token>');
  }
  if (await readCredentials()) {
    throw new Error('This relay already has local credentials. Use a separate HAPPIER_HOME_DIR for a managed machine; existing credentials will not be overwritten.');
  }
  const serverUrl = resolveServerHttpBaseUrl();
  const snapshot = await fetchServerFeaturesSnapshot({ serverUrl, timeoutMs: configuration.sessionControlHttpTimeoutMs });
  if (snapshot.status !== 'ready' || readServerEnabledBit(snapshot.features, 'accounts.machineAccess') !== true) {
    throw new Error('This relay does not support managed-machine invitations.');
  }

  const signingSeed = await readOrCreateMachineSigningSeed();
  const signing = tweetnacl.sign.keyPair.fromSeed(signingSeed);
  const machineKey = deriveAccountMachineKeyFromRecoverySecret(signingSeed);
  const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
  const proof = authChallenge(signingSeed);
  const response = await axios.post<unknown>(`${serverUrl}/v1/auth`, {
    publicKey: encodeBase64(proof.publicKey),
    challenge: encodeBase64(proof.challenge),
    signature: encodeBase64(proof.signature),
    contentPublicKey: encodeBase64(contentPublicKey),
    contentPublicKeySig: encodeBase64(tweetnacl.sign.detached(
      createAccountContentPublicKeyBindingMessage(contentPublicKey), signing.secretKey,
    )),
    inviteToken,
  }, { timeout: configuration.sessionControlHttpTimeoutMs });
  const body = response.data;
  if (!body || typeof body !== 'object' || !('success' in body) || body.success !== true
    || !('token' in body) || typeof body.token !== 'string' || !body.token) {
    throw new Error('The relay returned an invalid machine-enrollment response.');
  }
  const accessResponse = await axios.get<unknown>(`${serverUrl}/v1/account/access`, {
    headers: { Authorization: `Bearer ${body.token}` }, timeout: configuration.sessionControlHttpTimeoutMs,
  });
  const access = ManagedAccountAccessResponseSchema.parse(accessResponse.data);
  if (!access.managed || access.role !== 'machine') {
    throw new Error('This invitation did not enroll a machine identity. Request a machine invitation from the administrator.');
  }
  await writeCredentialsDataKey({ token: body.token, publicKey: contentPublicKey, machineKey });
  console.log('Machine identity enrolled. Start the daemon to register this machine.');
}
