import type { Credentials } from '@/persistence';
import { requireEncryptionCredentials } from '@/persistence';

import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { getRandomBytes } from '../encryption';

export type EncryptionContext = {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  dataEncryptionKey: Uint8Array | null;
};

export function resolveSessionEncryptionContext(credential: Credentials): EncryptionContext {
  requireEncryptionCredentials(credential);
  // Resolve encryption key
  let dataEncryptionKey: Uint8Array | null = null;
  let encryptionKey: Uint8Array;
  let encryptionVariant: 'legacy' | 'dataKey';

  if (credential.encryption.type === 'dataKey') {
    // Use a per-session key for session message encryption (AES-256-GCM).
    encryptionKey = getRandomBytes(32);
    encryptionVariant = 'dataKey';

    // Publish the per-session key encrypted for the account's content keypair public key.
    dataEncryptionKey = sealEncryptedDataKeyEnvelopeV1({
      dataKey: encryptionKey,
      recipientPublicKey: credential.encryption.publicKey,
      randomBytes: getRandomBytes,
    });
  } else {
    encryptionKey = credential.encryption.secret;
    encryptionVariant = 'legacy';
  }

  return { encryptionKey, encryptionVariant, dataEncryptionKey };
}

export function resolveMachineEncryptionContext(
  credential: Credentials,
  options: Readonly<{ independentResourceKey?: boolean }> = {},
): EncryptionContext {
  requireEncryptionCredentials(credential);
  if (options.independentResourceKey && credential.encryption.type !== 'dataKey') {
    throw new Error('Managed machines require an independent content-key identity. Enroll this machine with an invitation.');
  }
  // Resolve encryption key
  let dataEncryptionKey: Uint8Array | null = null;
  let encryptionKey: Uint8Array;
  let encryptionVariant: 'legacy' | 'dataKey';

  if (credential.encryption.type === 'dataKey') {
    // Encrypt data encryption key
    encryptionVariant = 'dataKey';
    // Sharing a managed machine must never disclose its identity's private key.
    encryptionKey = options.independentResourceKey ? getRandomBytes(32) : credential.encryption.machineKey;
    dataEncryptionKey = sealEncryptedDataKeyEnvelopeV1({
      dataKey: encryptionKey,
      recipientPublicKey: credential.encryption.publicKey,
      randomBytes: getRandomBytes,
    });
  } else {
    // Legacy encryption
    encryptionKey = credential.encryption.secret;
    encryptionVariant = 'legacy';
  }

  return { encryptionKey, encryptionVariant, dataEncryptionKey };
}
