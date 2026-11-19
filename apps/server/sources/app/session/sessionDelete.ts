import { Context } from "@/context";
import { deleteOwnedSession } from "@/app/session/delete/deleteOwnedSession";
import { configuredAdministratorPublicKey } from "@/app/account/managedAccounts/policy";

/**
 * Delete a session and all its related data.
 * Handles:
 * - Deleting all session messages
 * - Deleting all usage reports for the session
 * - Deleting all access keys for the session
 * - Deleting the session itself
 * - Sending socket notification to all connected clients
 *
 * In managed deployments machine sessions are owned by a non-human machine identity, so no human
 * caller would ever match the owner check. Any caller with admin-level session access (the
 * administrator, or a member whose ready grant published a session share) may delete such a
 * session; allocation is still enforced through the canonical access-control gate. Unmanaged
 * deployments keep the original owner-only contract.
 *
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to delete
 * @returns true if deletion was successful, false if session not found or not owned by user
 */
export async function sessionDelete(ctx: Context, sessionId: string): Promise<boolean> {
    if (configuredAdministratorPublicKey()) {
        return await deleteOwnedSession({ sessionId, requestingAccountId: ctx.uid, reason: 'user_request' });
    }
    return await deleteOwnedSession({
        sessionId,
        ownerAccountId: ctx.uid,
        reason: 'user_request',
    });
}
