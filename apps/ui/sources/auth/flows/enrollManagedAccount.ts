import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';
import { digest } from '@/platform/digest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot, type ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { StaleServerGenerationError } from '@/sync/http/client';
import { authGetToken } from './getToken';

function assertEnrollmentScope(scope: ActiveServerSnapshot) {
    const current = getActiveServerSnapshot();
    if (current.serverId !== scope.serverId || current.serverUrl !== scope.serverUrl || current.generation !== scope.generation) throw new StaleServerGenerationError();
}

export async function enrollManagedAccount(inviteToken: string) {
    const scope = getActiveServerSnapshot();
    const inviteHash = encodeHex(await digest('SHA-256', new TextEncoder().encode(inviteToken.trim())));
    assertEnrollmentScope(scope);
    let prepared = await TokenStorage.getPreparedManagedEnrollment(scope.serverUrl, inviteHash, { serverId: scope.serverId });
    assertEnrollmentScope(scope);
    if (!prepared) {
        const secret = await getRandomBytesAsync(32);
        assertEnrollmentScope(scope);
        prepared = { secret: encodeBase64(secret, 'base64url') };
        if (!await TokenStorage.setPreparedManagedEnrollment(scope.serverUrl, inviteHash, prepared, { serverId: scope.serverId })) {
            throw new Error('Could not save independent enrollment recovery key');
        }
    }
    assertEnrollmentScope(scope);
    const secret = decodeBase64(prepared.secret, 'base64url');
    if (secret.length !== 32) throw new Error('Invalid prepared enrollment recovery key');
    const token = await authGetToken(secret, { inviteToken });
    assertEnrollmentScope(scope);
    return { credentials: { token, secret: prepared.secret }, scope, inviteHash };
}

export async function completeManagedAccountEnrollment(enrollment: Awaited<ReturnType<typeof enrollManagedAccount>>): Promise<void> {
    assertEnrollmentScope(enrollment.scope);
    if (!await TokenStorage.clearPreparedManagedEnrollment(enrollment.scope.serverUrl, enrollment.inviteHash, { serverId: enrollment.scope.serverId })) {
        throw new Error('Could not clear completed enrollment recovery state');
    }
}
