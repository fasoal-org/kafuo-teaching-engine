/**
 * Teaching Package error vocabulary (plan §5/§6.1).
 *
 * `TeachingPackageError` carries a machine code plus the HTTP status the route
 * layer maps onto the folders-style `{ error: { code, message, details? } }`
 * envelope. `TeachingPackageStageLockedError` is the immutability guard's
 * refusal: it deliberately does NOT extend `StageAccessError`, because that
 * class is swallowed into `null` on reads (owner-bound-document-store.ts).
 */

export type TeachingPackageErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'ACTOR_REQUIRED'
  | 'REASON_REQUIRED'
  | 'UNSUPPORTED_LEARNING_ITEM_TYPE'
  | 'MODEL_VERSION_REQUIRED'
  | 'INVALID_TRANSITION'
  | 'STALE_STATE'
  | 'ACTIVE_SUCCESSOR_EXISTS'
  | 'APPROVAL_CONFLICT'
  | 'STAGE_CHANGED_SINCE_SUBMISSION'
  | 'GENERATION_IN_PROGRESS'
  | 'NOT_A_SUCCESSOR'
  | 'STAGE_NOT_LIVE'
  | 'STAGE_NOT_PACKAGE_ELIGIBLE'
  | 'STAGE_LOCKED'
  | 'SERVICE_UNAUTHENTICATED'
  // --- Kafuo integration (plan §4.1.6) ---
  | 'IDEMPOTENCY_CONFLICT'
  | 'FLOW_REQUIRED'
  | 'FLOW_INVALID'
  | 'CONTENT_RESOURCE_REQUIRED'
  | 'TENANT_REQUIRED'
  | 'TEACHING_MODEL_FLOW_MISMATCH'
  | 'SOURCE_VISUAL_MODEL_UNAVAILABLE'
  | 'INTEGRATION_NOT_CONFIGURED'
  | 'NORMALIZED_CONTENT_DOWNLOAD_FAILED'
  | 'NORMALIZED_CONTENT_SCHEMA_UNSUPPORTED'
  | 'NORMALIZED_CONTENT_LINEAGE_MISMATCH'
  | 'NORMALIZED_CONTENT_INTEGRITY_MISMATCH'
  | 'NORMALIZED_CONTENT_ARCHIVE_INVALID'
  | 'NORMALIZED_CONTENT_ASSOCIATION_INVALID'
  | 'NORMALIZED_CONTENT_MEDIA_INVALID'
  | 'NORMALIZED_CONTENT_EMPTY'
  /**
   * The MODEL's outline response failed Content-Unit grounding: an outline
   * omitted `sourceContentUnitIds`, returned it empty, or cited an id that
   * names nothing in the approved normalized manifest. Distinct from
   * `NORMALIZED_CONTENT_LINEAGE_MISMATCH`, which stays reserved for an actual
   * package/request lineage mismatch — a bad model answer is not a bad package.
   */
  | 'OUTLINE_CONTENT_UNIT_GROUNDING_INVALID'
  // --- Kafuo question-flow closure (B1) ---
  | 'TEACHING_PACKAGE_NOT_APPROVED'
  | 'QUESTION_SOURCE_CONTEXT_UNAVAILABLE'
  | 'OBJECTIVE_NOT_IN_PACKAGE'
  | 'OBJECTIVE_TEACHING_MISSING'
  | 'QUESTION_GENERATION_MODEL_UNAVAILABLE'
  | 'QUESTION_GENERATION_OUTPUT_INVALID';

const CODE_STATUSES: Record<TeachingPackageErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  ACTOR_REQUIRED: 400,
  REASON_REQUIRED: 400,
  UNSUPPORTED_LEARNING_ITEM_TYPE: 400,
  MODEL_VERSION_REQUIRED: 400,
  INVALID_TRANSITION: 409,
  STALE_STATE: 409,
  ACTIVE_SUCCESSOR_EXISTS: 409,
  APPROVAL_CONFLICT: 409,
  STAGE_CHANGED_SINCE_SUBMISSION: 409,
  GENERATION_IN_PROGRESS: 409,
  NOT_A_SUCCESSOR: 409,
  STAGE_NOT_LIVE: 422,
  STAGE_NOT_PACKAGE_ELIGIBLE: 422,
  STAGE_LOCKED: 423,
  SERVICE_UNAUTHENTICATED: 401,
  IDEMPOTENCY_CONFLICT: 409,
  FLOW_REQUIRED: 400,
  FLOW_INVALID: 400,
  CONTENT_RESOURCE_REQUIRED: 400,
  TENANT_REQUIRED: 400,
  TEACHING_MODEL_FLOW_MISMATCH: 409,
  SOURCE_VISUAL_MODEL_UNAVAILABLE: 422,
  INTEGRATION_NOT_CONFIGURED: 503,
  NORMALIZED_CONTENT_DOWNLOAD_FAILED: 502,
  NORMALIZED_CONTENT_SCHEMA_UNSUPPORTED: 422,
  NORMALIZED_CONTENT_LINEAGE_MISMATCH: 409,
  NORMALIZED_CONTENT_INTEGRITY_MISMATCH: 422,
  NORMALIZED_CONTENT_ARCHIVE_INVALID: 422,
  NORMALIZED_CONTENT_ASSOCIATION_INVALID: 422,
  NORMALIZED_CONTENT_MEDIA_INVALID: 422,
  NORMALIZED_CONTENT_EMPTY: 422,
  OUTLINE_CONTENT_UNIT_GROUNDING_INVALID: 422,
  TEACHING_PACKAGE_NOT_APPROVED: 409,
  QUESTION_SOURCE_CONTEXT_UNAVAILABLE: 409,
  OBJECTIVE_NOT_IN_PACKAGE: 422,
  OBJECTIVE_TEACHING_MISSING: 422,
  QUESTION_GENERATION_MODEL_UNAVAILABLE: 503,
  QUESTION_GENERATION_OUTPUT_INVALID: 502,
};

export class TeachingPackageError extends Error {
  readonly code: TeachingPackageErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: TeachingPackageErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'TeachingPackageError';
    this.code = code;
    this.status = CODE_STATUSES[code];
    this.details = details;
  }
}

/**
 * The stage guard's refusal. `reason` is the protecting status
 * (`in_review`/`approved`/`superseded`/`discarded`), `displaced`, or
 * `package-owned` (delete refusal). The message begins with the fixed prefix so
 * route error mapping can rely on it.
 */
export class TeachingPackageStageLockedError extends Error {
  readonly stageId: string;
  readonly reason: string;

  constructor(stageId: string, reason: string) {
    super(`teaching package stage locked (${reason}) for ${JSON.stringify(stageId)}`);
    this.name = 'TeachingPackageStageLockedError';
    this.stageId = stageId;
    this.reason = reason;
  }
}

/**
 * Realm-safe detection. The app answers requests from more than one module
 * graph (Next dev HMR, the instrumentation bundle), where `instanceof` is false
 * across copies while the error's declared name is exactly right — and a lock
 * refusal that degrades to 500 is the one a client retries forever.
 */
export function isTeachingPackageStageLockedError(
  error: unknown,
): error is TeachingPackageStageLockedError {
  return (
    error instanceof TeachingPackageStageLockedError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'TeachingPackageStageLockedError')
  );
}

/**
 * True when the error is a PostgreSQL unique violation (23505) — the backstop
 * behind every partial unique index. Same three-line check as
 * `lib/server/folder-name-errors.ts` (which keeps its copy private).
 */
export function isPgUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}
