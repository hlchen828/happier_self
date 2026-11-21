import { isAxiosError } from 'axios';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionErrorCode } from '@happier-dev/protocol';

/**
 * Classification of a canonical Replay-seeded creation failure.
 *
 * `createSpawnedSession`'s Replay-seeded mode throws one coded error for both
 * the row-creation stage and the launch stage. Every Replay ingress still owns
 * its own result shape, so they share this reader rather than each re-deriving
 * the stage and codes from the error's private fields.
 */
export type ReplaySeededCreationFailure = Readonly<{
  /** `spawn` once the row exists and the launch was rejected; `creation` before that. */
  stage: 'creation' | 'spawn';
  errorCode: string;
  /** Closed-enum projection for legacy creation-stage SpawnSessionResult callers. */
  creationErrorCode: SpawnSessionErrorCode;
  errorMessage: string;
  sessionId: string | null;
  /** Raw launch envelope, preserved so an ingress can return it unchanged. */
  spawnResponse: unknown;
  /**
   * Launch outcome an ingress can return directly: the producer's own envelope
   * when it answered, and a typed error when the transport threw instead. The
   * canonical creator settles the orphaned row in both cases, so an ingress must
   * never surface `null` here.
   */
  spawnResult: unknown;
}>;

export function readReplaySeededCreationFailure(error: unknown): ReplaySeededCreationFailure {
  const record = error !== null && typeof error === 'object'
    ? error as Readonly<Record<string, unknown>>
    : null;
  const details = record?.details !== null && typeof record?.details === 'object'
    ? record.details as Readonly<Record<string, unknown>>
    : null;
  const hasSpawnResponse = details !== null && 'spawnResponse' in details;
  // Axios transport codes (e.g. ECONNRESET) do not prove whether a create
  // committed. Keep lost HTTP responses outcome-unknown, while preserving
  // domain rejections such as the pre-POST missing-machine INVALID_REQUEST.
  const errorCode = !hasSpawnResponse && isAxiosError(error)
    ? SPAWN_SESSION_ERROR_CODES.UNEXPECTED
    : typeof record?.code === 'string' && record.code.trim().length > 0
      ? record.code
      : SPAWN_SESSION_ERROR_CODES.UNEXPECTED;
  const errorMessage = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Failed to create a replay-seeded session';
  const spawnResponse = hasSpawnResponse ? details.spawnResponse : null;
  const hasEnvelope = spawnResponse !== null && typeof spawnResponse === 'object';
  return {
    stage: hasSpawnResponse ? 'spawn' : 'creation',
    errorCode,
    creationErrorCode: Object.values(SPAWN_SESSION_ERROR_CODES).find((code) => code === errorCode)
      ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
    errorMessage,
    sessionId: typeof details?.sessionId === 'string' && details.sessionId.trim().length > 0
      ? details.sessionId
      : null,
    spawnResponse,
    spawnResult: hasEnvelope
      ? spawnResponse
      : { type: 'error' as const, errorCode, errorMessage },
  };
}
