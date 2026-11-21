import { Socket } from "socket.io";
import { db } from "@/storage/db";
import { canApprovePermissions, checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { log } from "@/utils/logging/log";
import { isDelegatedSessionApprovalRpcMethod, RPC_METHODS, type SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';
import { hasCurrentSessionScopedMachineAccess } from './sessionScopedBinding';
import { configuredAdministratorPublicKey } from '@/app/account/managedAccounts/policy';
import { managedMachineAccess } from '@/app/account/managedAccounts/access';

export type RpcCallTargetResolution =
    | {
        type: "target";
        targetUserId: string;
        targetSocket: Socket | undefined;
      }
    | {
        type: "forbidden";
      };

export async function resolveRpcCallTarget(params: {
    callerUserId: string;
    method: string;
    allRpcListeners: Map<string, Map<string, Socket>>;
    authorization?: SocketRpcAuthorizationContext | null;
}): Promise<RpcCallTargetResolution> {
    const { callerUserId, method, allRpcListeners } = params;

    const separator = method.indexOf(':');
    const resourceId = separator > 0 ? method.slice(0, separator) : '';
    const stopMethod = separator > 0 ? method.slice(separator + 1) : '';
    const stopSessionId = stopMethod === RPC_METHODS.KILL_SESSION ? resourceId
        : stopMethod === RPC_METHODS.STOP_SESSION ? params.authorization?.sessionId : null;
    if (stopSessionId) {
        const access = await checkSessionAccess(callerUserId, stopSessionId);
        if (access && !access.isOwner && requireAccessLevel(access, 'admin')) {
            const session = await db.session.findUnique({ where: { id: stopSessionId }, select: { accountId: true } });
            if (!session) return { type: 'forbidden' };
            // A session share authorizes stopping only that session, never arbitrary machine RPCs.
            if (stopMethod === RPC_METHODS.STOP_SESSION && !await hasCurrentSessionScopedMachineAccess({
                accountId: session.accountId,
                machineId: resourceId,
                sessionId: stopSessionId,
            })) return { type: 'forbidden' };
            return { type: 'target', targetUserId: session.accountId, targetSocket: allRpcListeners.get(session.accountId)?.get(method) };
        }
    }

    if (configuredAdministratorPublicKey()) {
        const separator = method.indexOf(':');
        if (separator <= 0) return { type: 'forbidden' };
        const resourceId = method.slice(0, separator);
        const machine = await managedMachineAccess(callerUserId, resourceId);
        if (machine) {
            if (machine.status !== 'ready') return { type: 'forbidden' };
            const targetUserId = machine.machine.accountId;
            return { type: 'target', targetUserId, targetSocket: allRpcListeners.get(targetUserId)?.get(method) };
        }
        const access = await checkSessionAccess(callerUserId, resourceId);
        if (!access || !requireAccessLevel(access, 'edit')) return { type: 'forbidden' };
        if (isDelegatedSessionApprovalRpcMethod(method.slice(separator + 1)) && !await canApprovePermissions(callerUserId, resourceId)) return { type: 'forbidden' };
        const session = await db.session.findUnique({ where: { id: resourceId }, select: { accountId: true } });
        if (!session) return { type: 'forbidden' };
        return { type: 'target', targetUserId: session.accountId, targetSocket: allRpcListeners.get(session.accountId)?.get(method) };
    }

    // Apart from the session-admin stop paths above, preserve the existing delegated approval
    // family and same-user forwarding rules.
    let targetUserId = callerUserId;
    let targetSocket: Socket | undefined = undefined;

    const lastColon = method.lastIndexOf(':');
    const suffix = lastColon >= 0 ? method.slice(lastColon + 1) : '';
    if (isDelegatedSessionApprovalRpcMethod(suffix)) {
        const sessionId = lastColon >= 0 ? method.slice(0, lastColon) : '';
        if (sessionId) {
            const session = await db.session.findUnique({
                where: { id: sessionId },
                select: { accountId: true },
            });
            const ownerId = session?.accountId;
            if (ownerId && ownerId !== callerUserId) {
                const allowed = await canApprovePermissions(callerUserId, sessionId);
                if (!allowed) {
                    return { type: "forbidden" };
                }
                targetUserId = ownerId;
                const ownerListeners = allRpcListeners.get(ownerId);
                targetSocket = ownerListeners?.get(method);
                if (targetSocket) {
                    log({ module: 'websocket-rpc' }, `Delegated permission RPC: ${callerUserId} -> ${ownerId} (${sessionId})`);
                }
            }
        }
    }

    return {
        type: "target",
        targetUserId,
        targetSocket,
    };
}
