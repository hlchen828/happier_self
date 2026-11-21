import { Context } from "@/context";
import { deleteOwnedSession } from "@/app/session/delete/deleteOwnedSession";

/**
 * Delete a session and all its related data.
 * Handles:
 * - Deleting all session messages
 * - Deleting all usage reports for the session
 * - Deleting all access keys for the session
 * - Deleting the session itself
 * - Sending socket notification to all connected clients
 *
 * Owners and session admins may delete authorized sessions, including ordinary shared sessions
 * and hosted machine sessions. The canonical access check runs inside the deletion transaction
 * so revoked access cannot authorize deletion.
 *
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to delete
 * @returns true if deletion was successful, false if the session is missing or access is insufficient
 */
export async function sessionDelete(ctx: Context, sessionId: string): Promise<boolean> {
    return await deleteOwnedSession({
        sessionId,
        requestingAccountId: ctx.uid,
        reason: 'user_request',
    });
}
