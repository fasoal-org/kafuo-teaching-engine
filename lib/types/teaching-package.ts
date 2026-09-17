/**
 * Teaching Package domain types (Module 1 — Experience / Scene Model).
 *
 * A Teaching Package version wraps exactly one PostgreSQL-backed Stage. Stage,
 * Scene and Action structures are never embedded here (BR-015) and learner
 * runtime state is never present (BR-022). The logical "Teaching Package" is
 * identified by the Learning Item key `(type, id)`; versions are rows.
 */
import type {
  ClassroomGenerationProgress,
  GenerateClassroomInput,
} from '@/lib/server/classroom-generation';

export type LearningItemType = 'lesson' | 'section';

export interface LearningItemRef {
  type: LearningItemType;
  /** Opaque Kafuo-owned identifier; the Teaching Engine never interprets it. */
  id: string;
}

export type TeachingPackageStatus =
  | 'draft'
  | 'in_review'
  | 'rejected'
  | 'approved'
  | 'superseded'
  | 'discarded';

/** Non-terminal statuses — the at-most-one "active" version of a Learning Item. */
export const TEACHING_PACKAGE_ACTIVE_STATUSES: readonly TeachingPackageStatus[] = [
  'draft',
  'in_review',
  'rejected',
];

/** Statuses under which the version's current Stage may be edited. */
export const TEACHING_PACKAGE_EDITABLE_STATUSES: readonly TeachingPackageStatus[] = [
  'draft',
  'rejected',
];

export interface TeachingModelLineage {
  /** e.g. `g5` — the Teaching Model key Kafuo assigned. */
  key: string;
  /** e.g. `g5.v1` — the exact resolved version; historical truth. */
  version: string;
}

/**
 * Kafuo Teaching Model Flow entry (FRD §11.1). Array order is authoritative;
 * TE derives the zero-based `flowIndex` from position. Repeated stage keys are
 * valid — identity is `(flowIndex, stage)`. Kafuo never sends `flowIndex`.
 */
export interface TeachingFlowEntry {
  /** Case-sensitive stable machine key, e.g. `lesson_introduction`. */
  stage: string;
  /** Non-empty pedagogical instructions for this flow position. */
  instructions: string;
}

/** Teaching-stage identity carried by every Kafuo-generated outline and Scene. */
export interface TeachingStageRef {
  /** Must equal `flow[flowIndex].stage` exactly. */
  key: string;
  /** Zero-based authoritative flow position, derived by TE. */
  flowIndex: number;
}

/**
 * The one canonical Teaching Package aggregate scope (plan §4.1.2):
 * `(tenantId, learningItem.type, learningItem.id)`. `LearningItemRef` stays the
 * external `{type, id}` shape; every internal read/write takes this key.
 */
export interface TeachingPackageAggregateKey {
  tenantId: string;
  learningItem: LearningItemRef;
}

/** Tenant namespace for rows written before the tenant column existed. */
export const LEGACY_TENANT_ID = '__legacy__';

export interface LearningObjectiveSnapshot {
  statement: string;
  label?: string;
  context?: string;
}

export interface LearningObjectiveRef {
  objectiveRef: string;
  snapshot: LearningObjectiveSnapshot;
}

/** Kafuo Learning Objective reference retained on a scene (app-layer field). */
export interface SceneLearningObjectiveRef {
  objectiveRef: string;
  snapshot: LearningObjectiveSnapshot;
  /** When the snapshot was captured; Kafuo changes never rewrite it. */
  capturedAt: number;
}

/**
 * Transient execution payload handed to `generateClassroom`. It is exactly the
 * existing `GenerateClassroomInput` and may carry secrets (`webSearchApiKey`)
 * and bulky source content (`pdfContent`). It lives only in the request/runner
 * process and is NEVER persisted.
 */
export type GenerationExecutionInput = GenerateClassroomInput;

/**
 * Immutable, lightweight, reference-based audit lineage persisted per attempt
 * (BRD §17). No secrets, no raw source content.
 */
export interface GenerationInputSnapshot {
  learningItem: LearningItemRef;
  teachingModel: TeachingModelLineage;
  learningObjectives: LearningObjectiveRef[];
  contentUnitRefs: string[];
  sourceRefs: string[];
  /** Opaque Kafuo-supplied references/context, ≤ 64 KiB, secret-free by key name. */
  generationContext: Record<string, unknown>;
  /** Non-secret execution flags, copied from the execution input. */
  generationOptions: {
    enableWebSearch?: boolean;
    webSearchProviderId?: string;
    webSearchModelId?: string;
    baiduSubSources?: unknown;
    enableImageGeneration?: boolean;
    enableVideoGeneration?: boolean;
    enableTTS?: boolean;
    agentMode?: 'default' | 'generate';
  };
  /** sha256 hex digest of the full requirement text. */
  requirementDigest: string;
  /** First 200 chars (precedent: classroom-job-store buildInputSummary). */
  requirementPreview: string;
  pdfContentSummary: {
    present: boolean;
    textLength: number;
    imageCount: number;
    textDigest?: string;
  } | null;
  /** Model string from resolveModel; patched in by the runner after resolution. */
  resolvedLlmModel?: string;
  requestedAt: number;
  /** ---- Kafuo integration additions (FRD §9.2/§17.1) ---- */
  /** Effective Kafuo tenant; `LEGACY_TENANT_ID` for pre-tenant rows. */
  tenantId?: string;
  /** The ordered Kafuo Teaching Model Flow when the request carried one. */
  teachingFlow?: TeachingFlowEntry[];
  /**
   * Stable resource identity/integrity lineage. NEVER carries `url` — the
   * signed retrieval URL is a transient credential (FRD §9.2 secrecy rules).
   */
  contentResource?: {
    id: string;
    fileName?: string;
    mimeType: string;
    fileSizeBytes?: number;
    checksumSha256?: string;
    /** Filled by the acquisition layer from the downloaded bytes. */
    measuredBytes?: number;
    measuredSha256?: string;
  };
  /** Stable normalized-package facts only; never the signed URL. */
  normalizedContentResource?: Omit<KafuoNormalizedContentResource, 'url'> & {
    measuredBytes?: number;
    measuredSha256?: string;
    contentUnitCount?: number;
    blockCount?: number;
    visualCount?: number;
  };
  /** sha256 of the canonical Kafuo request (excludes the signed URL). */
  requestDigest?: string;
  /** Source-visual counts patched in by the acquisition/generation layers. */
  sourceVisualSummary?: {
    available: number;
    selected: number;
    materialized: number;
  };
}

export interface TeachingPackageVersion {
  /** `tpv-` + 12 base64url chars. */
  id: string;
  /** Owning tenant; immutable once written (`LEGACY_TENANT_ID` for legacy rows). */
  tenantId: string;
  learningItem: LearningItemRef;
  /** 1..n, unique per learning item, never reused. */
  version: number;
  status: TeachingPackageStatus;
  /** Exactly one, always present. */
  currentStageId: string;
  /** Attempt that produced currentStageId; null for a cloned successor. */
  currentAttemptId: string | null;
  teachingModel: TeachingModelLineage;
  /** Set on successors. */
  predecessorVersionId: string | null;
  supersededByVersionId: string | null;
  /** `document_stage_revision.rev` captured at submit; re-checked at approve. */
  submittedStageRev: number | null;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  submittedAt: number | null;
  approvedAt: number | null;
  supersededAt: number | null;
  discardedAt: number | null;
}

export type ReviewEventType =
  | 'created'
  | 'submitted_for_review'
  | 'review_edit_started'
  | 'rejected'
  | 'resubmitted'
  | 'approved'
  | 'superseded'
  | 'discarded'
  | 'successor_created'
  | 'stage_replaced';

export interface ReviewEvent {
  id: number;
  versionId: string;
  eventType: ReviewEventType;
  fromStatus: TeachingPackageStatus | null;
  toStatus: TeachingPackageStatus;
  actorRef: string;
  reason: string | null;
  comment: string | null;
  relatedVersionId: string | null;
  data: Record<string, unknown> | null;
  createdAt: number;
}

export type GenerationAttemptKind = 'initial' | 'regeneration';

export type GenerationAttemptStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface GenerationAttempt {
  /** `tpa-` + 12 base64url chars. */
  id: string;
  /** Owning tenant; immutable once written (`LEGACY_TENANT_ID` for legacy rows). */
  tenantId: string;
  learningItem: LearningItemRef;
  /** Null for an initial attempt until its completion transaction. */
  versionId: string | null;
  kind: GenerationAttemptKind;
  status: GenerationAttemptStatus;
  /** Kafuo idempotency key. */
  requestId: string | null;
  /** Semantic digest of the Kafuo request; null for legacy body callers. */
  requestDigest: string | null;
  /** Full-classroom generation runs consumed (Layer B, plan §4.3.8). */
  generationRuns: number;
  requestedByActorRef: string;
  teachingModel: TeachingModelLineage;
  inputSnapshot: GenerationInputSnapshot;
  /** Immutable historical identity of the Stage this attempt produced. */
  producedStageId: string | null;
  /** Live reference to that Stage while it is retained. */
  stageId: string | null;
  /** Set when this attempt's Stage stopped being the version's current Stage. */
  displacedAt: number | null;
  /** Set by the future retention policy; guard protection ends here. */
  stageReleasedAt: number | null;
  progress: ClassroomGenerationProgress | null;
  error: string | null;
  /** Structured failure code (e.g. `ATTEMPT_RECLAIMED_STALE`). */
  errorCode: string | null;
  errorRetryable: boolean | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Kafuo → Teaching Engine structured generation request (FRD §9.2).
// ---------------------------------------------------------------------------

/** Kafuo generation capability switches only — never provider IDs or keys. */
export interface KafuoGenerationSwitches {
  enableWebSearch?: boolean;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
}

/** Hierarchy/context block of the Kafuo Learning Item (FRD §9.2). */
export interface KafuoLearningItemContext {
  type: 'lesson' | 'section';
  /** `String(learning_items.id)` — never `lesson_id`/`logical_section_id`. */
  id: string;
  title: string;
  lessonId?: string;
  logicalSectionId?: string;
  unit: { id: string; title: string };
  academicPeriod?: { id: string; name: string };
  subjectOffering?: { id: string; name: string };
  level?: { id: string; name: string };
  curriculum: { id: string; name: string };
  curriculumVersion: { id: string; versionLabel: string };
  language: string;
  estimatedMinutes?: number;
  concepts?: Array<{
    title: string;
    description?: string;
    sortOrder: number;
  }>;
}

/** The lesson-scoped PDF resource Kafuo authorizes TE to download once. */
export interface KafuoContentResource {
  /** `String(content_sources.id)`. */
  id: string;
  /** Transient retrieval credential — never persisted, logged, or echoed. */
  url: string;
  fileName?: string;
  mimeType: 'application/pdf';
  fileSizeBytes?: number;
  checksumSha256?: string;
}

export interface KafuoNormalizedContentResource {
  id: string;
  /** Transient retrieval credential — execution memory only. */
  url: string;
  mimeType: 'application/zip';
  schemaVersion: 'kafuo.normalized-content.v1';
  contentSourceId: string;
  contentRevisionId: string;
  parseRunId: string;
  structureProfile: { id: string; versionId: string };
  fileSizeBytes: number;
  checksumSha256: string;
}

/** The structured Kafuo generation request (FRD §9.2, normative boundary). */
export interface KafuoGenerationRequest {
  requestId: string;
  learningItem: KafuoLearningItemContext;
  /** Approved active outcomes in approved order. */
  learningObjectives: LearningObjectiveRef[];
  teachingModel: TeachingModelLineage & { flow: TeachingFlowEntry[] };
  contentResource: KafuoContentResource;
  normalizedContentResource?: KafuoNormalizedContentResource;
  generation: KafuoGenerationSwitches;
  /** From `ActorContext.resolve_tenant(...)`, never a browser body value. */
  tenantContext: { tenantId: string };
  actorRef: string;
  /** Present ⇒ regeneration of that TE version. */
  versionId?: string;
}

// ---------------------------------------------------------------------------
// Teaching Engine → Kafuo webhook contract (FRD §9.8). Exactly three types.
// ---------------------------------------------------------------------------

export type TeachingEngineWebhookType =
  | 'teaching_package.generation_succeeded'
  | 'teaching_package.generation_failed'
  | 'teaching_package.status_changed';

export interface GenerationSucceededEventData {
  requestId: string;
  attempt: {
    id: string;
    kind: GenerationAttemptKind;
    status: 'succeeded';
    producedStageId: string;
    startedAt: number;
    completedAt: number;
    generationRuns: number;
  };
  version: {
    id: string;
    version: number;
    status: TeachingPackageStatus;
    currentStageId: string;
    currentAttemptId: string | null;
    teachingModel: TeachingModelLineage;
    updatedAt: number;
  };
  allowedActions?: string[];
}

export interface GenerationFailedEventData {
  requestId: string;
  attempt: {
    id: string;
    kind: GenerationAttemptKind;
    status: 'failed';
    versionId: string | null;
    producedStageId: string | null;
    startedAt: number | null;
    completedAt: number;
    generationRuns: number;
  };
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  retainedVersion?: {
    id: string;
    status: TeachingPackageStatus;
    currentStageId: string;
  };
}

export interface StatusChangedEventData {
  version: {
    id: string;
    version: number;
    previousStatus: TeachingPackageStatus;
    status: TeachingPackageStatus;
    currentStageId: string;
    teachingModel: TeachingModelLineage;
    updatedAt: number;
  };
  actorRef: string;
  allowedActions?: string[];
}

export interface TeachingEngineWebhookEnvelope<T> {
  /** Globally unique event id. */
  id: string;
  type: TeachingEngineWebhookType;
  /** ISO-8601 UTC domain-event time (never the delivery time). */
  occurredAt: string;
  /** Monotonically increasing per tenant/item aggregate. */
  sequence: number;
  tenantContext: { tenantId: string };
  learningItem: { type: 'lesson' | 'section'; id: string };
  data: T;
}

// ---------------------------------------------------------------------------
// Aggregate reconciliation read (plan §4.4.4). No Stage/Scene/history payload.
// ---------------------------------------------------------------------------

export interface AggregateReadResponse {
  approvedVersion: TeachingPackageVersion | null;
  workingVersion: TeachingPackageVersion | null;
  latestAttempt: GenerationAttempt | null;
  /** Watermark: highest webhook sequence allocated for the aggregate. */
  latestAggregateSequence: number;
}

// ---------------------------------------------------------------------------
// Source-visual provenance manifest (plan §4.3.6). Persisted on the outline
// record; carries no binary, no signed URL.
// ---------------------------------------------------------------------------

export interface SourceVisualManifestEntry {
  /** Stable logical id, e.g. `src-3`. */
  id: string;
  /** `String(content_sources.id)` of the PDF the visual came from. */
  contentResourceId: string;
  /** The provider's image id (untrusted; never used as a filename). */
  providerImageId?: string;
  pageNumber: number | null;
  width?: number;
  height?: number;
  description?: string;
  mimeType: string;
  sha256: string;
  /** Origin-relative serving path under the Stage media dir. */
  servingPath: string;
  normalizedPackageId?: string;
  normalizedContentSourceId?: string;
  contentRevisionId?: string;
  parseRunId?: string;
  structureProfile?: { id: string; versionId: string };
  sourceContentUnitIds?: string[];
  sourceBlockIds?: string[];
  sourceRole?: string;
  caption?: string;
  figureLabel?: string;
}
