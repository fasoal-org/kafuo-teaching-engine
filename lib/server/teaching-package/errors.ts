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
  | 'QUESTION_GENERATION_OUTPUT_INVALID'
  // --- Teaching Skills canonical versioning (Module 2 W1, plan §M) ---
  /**
   * A historical exact canonical Skill version cannot be resolved for
   * interpretation: the skill is unknown to the registry, the version was
   * never declared, its retained snapshot is absent, or its bytes drifted
   * from the declared content digest. Reported, never substituted with a
   * newer version (FR-TS-036, VAL-TS-019).
   */
  | 'SKILL_LINEAGE_UNRESOLVABLE'
  // --- Teaching Skills policy parsing + resolution (Module 2 W5, plan §J/§M) ---
  /** A governed request's flow item carries no Skill Policy — fail closed (BR-TS-048). */
  | 'SKILL_POLICY_REQUIRED'
  /** A received Skill Policy is malformed or internally incoherent (FR-TS-011, VAL-TS-003). */
  | 'SKILL_POLICY_INVALID'
  /** A referenced canonical Skill identity does not exist in TE's registry (VAL-TS-001). */
  | 'SKILL_NOT_FOUND'
  /** A referenced exact canonical Skill version does not resolve (VAL-TS-002, AC-TS-010). */
  | 'SKILL_VERSION_UNRESOLVED'
  // --- Teaching Skills generation-time selection (Module 2 W10, plan §J) ---
  /**
   * A selected Skill assignment is invalid for its flow position: the ref is
   * outside the position's permitted set (VAL-TS-004 — the unrestricted catalog
   * is never a fallback, BR-TS-048), or otherwise structurally invalid.
   */
  | 'SKILL_ASSIGNMENT_INVALID'
  /**
   * A required Skill rule was not satisfied according to its explicit policy
   * scope and role (VAL-TS-005 — no default scope is ever inferred, BR-TS-010).
   */
  | 'SKILL_REQUIREMENT_UNSATISFIED'
  // --- Teaching Skills deterministic validators (Module 2 W12, plan §J/§K) ---
  /**
   * Authoritative flow instructions and configured Skill Policy cannot be
   * satisfied together (FR-TS-074): a Teaching Model CONFIGURATION fault, never
   * an agent or reviewer fault — a reviewer cannot override it, and the remedy
   * is a new Teaching Model version (BR-TS-051).
   */
  | 'TEACHING_MODEL_CONFIG_CONTRADICTORY'
  /**
   * A Scene's instructional/non-instructional classification is structurally
   * invalid on a governed package: absent, or outside the closed vocabulary
   * (VAL-TS-007 — never derived from Skill absence, BR-TS-054).
   */
  | 'SCENE_CLASSIFICATION_INVALID'
  // --- Teaching Skills submit gate (Module 2 W17, plan §J/§K/§L) ---
  /**
   * Alignment at Submit is unresolved (VAL-TS-010, AC-TS-032/034): a governed
   * Scene is stale against its baseline (a material edit, Skill change or
   * classification change after the last baseline), or has never been
   * validated or confirmed at all. Uncertainty is never silently resolved as
   * success — the reviewer confirms, corrects, or regenerates (FR-TS-044/071).
   */
  | 'SKILL_ALIGNMENT_UNRESOLVED'
  // --- Teaching Actions + Action Engine (Module 3/4 W1, plan §7.1.2) ---
  /**
   * A governed run could not resolve a Scene's authoritative Flow context:
   * no `teachingStage` on the outline, an out-of-range `flowIndex`, a stage/key
   * mismatch, or empty Flow Instructions. An unresolvable authoritative
   * context is a bad request, not a bad model answer — non-retryable
   * (TAE-RQ-009/012; details are identity-only per plan §12.6).
   */
  | 'GOVERNED_FLOW_CONTEXT_UNRESOLVED'
  // --- Teaching Actions + Action Engine (Module 3/4 W2, plan §7.2) ---
  /**
   * A governed Scene's content generation failed after bounded retries
   * (TAE-RQ-017): the Flow position cannot be silently dropped, so the run
   * refuses rather than binding a Stage with a missing Scene — and the
   * failure carries its own code, never a TEACHING_MODEL_FLOW_MISMATCH.
   * Retryable at the attempt level: a bad model answer is not a bad package.
   */
  | 'GOVERNED_SCENE_GENERATION_FAILED'
  /**
   * A governed Scene's Action generation fell back to the model-free
   * defaults on every bounded attempt (TAE-RQ-017): structurally canonical
   * but pedagogically ungoverned output may never be bound as the package's
   * Stage. Retryable at the attempt level, same precedent.
   */
  | 'GOVERNED_ACTION_GENERATION_FAILED';

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
  SKILL_LINEAGE_UNRESOLVABLE: 409,
  SKILL_POLICY_REQUIRED: 400,
  SKILL_POLICY_INVALID: 422,
  SKILL_NOT_FOUND: 422,
  SKILL_VERSION_UNRESOLVED: 422,
  SKILL_ASSIGNMENT_INVALID: 422,
  SKILL_REQUIREMENT_UNSATISFIED: 422,
  TEACHING_MODEL_CONFIG_CONTRADICTORY: 422,
  SCENE_CLASSIFICATION_INVALID: 422,
  SKILL_ALIGNMENT_UNRESOLVED: 409,
  GOVERNED_FLOW_CONTEXT_UNRESOLVED: 422,
  GOVERNED_SCENE_GENERATION_FAILED: 422,
  GOVERNED_ACTION_GENERATION_FAILED: 422,
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
