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
}

export interface TeachingPackageVersion {
  /** `tpv-` + 12 base64url chars. */
  id: string;
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
  learningItem: LearningItemRef;
  /** Null for an initial attempt until its completion transaction. */
  versionId: string | null;
  kind: GenerationAttemptKind;
  status: GenerationAttemptStatus;
  /** Kafuo idempotency key. */
  requestId: string | null;
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
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}
