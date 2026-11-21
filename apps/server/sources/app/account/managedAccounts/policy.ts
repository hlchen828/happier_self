import type { ManagedAccountAccess } from '@happier-dev/protocol';

/** Deployment authority is a signing public key, never registration order or a client-supplied role. */
export function configuredAdministratorPublicKey(env: NodeJS.ProcessEnv = process.env): string | null {
    const key = env.HAPPIER_ADMIN_PUBLIC_KEY?.trim().toUpperCase();
    if (!key) return null;
    // privacyKit.encodeHex is the canonical persisted Account signing-key encoding (uppercase).
    if (!/^[0-9A-F]{64}$/.test(key)) throw new Error('HAPPIER_ADMIN_PUBLIC_KEY must be a 32-byte Ed25519 public key encoded as hex');
    return key;
}

export function managedRoleForAccount(
    account: Readonly<{ publicKey: string | null; managedRole: string }>,
    administratorPublicKey: string,
): ManagedAccountAccess['role'] {
    if (account.publicKey === administratorPublicKey) return 'admin';
    return account.managedRole === 'member' || account.managedRole === 'machine' ? account.managedRole : 'unmanaged';
}
