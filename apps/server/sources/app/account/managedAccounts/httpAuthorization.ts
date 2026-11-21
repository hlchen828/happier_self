import type { FastifyRequest } from 'fastify';
import { configuredAdministratorPublicKey } from './policy';
import { managedSessionAccess, ManagedAccessError } from './access';

/** Close legacy sharing and plaintext bypasses at the authenticated HTTP boundary. */
export async function enforceManagedHttpAuthorization(request: FastifyRequest): Promise<void> {
    if (!configuredAdministratorPublicKey()) return;
    const route = request.routeOptions.url ?? '';
    if (route.includes('/shares') || route.includes('/public-share')) throw new ManagedAccessError(403, 'machine-grant-required');
    if (route.startsWith('/v1/account/encryption') && request.method !== 'GET') throw new ManagedAccessError(403, 'managed-e2ee-required');
    const params = request.params as Record<string, unknown> | undefined;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null;
    if (sessionId && !await managedSessionAccess(request.userId, sessionId)) throw new ManagedAccessError(404, 'Session not found');
}
