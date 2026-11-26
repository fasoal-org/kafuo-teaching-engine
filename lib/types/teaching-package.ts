/**
 * Teaching Package domain types (Module 1 — Experience / Scene Model).
 *
 * A Teaching Package version wraps exactly one PostgreSQL-backed Stage. Stage,
 * Scene and Action structures are never embedded here (BR-015) and learner
 * runtime state is never present (BR-022). The logical "Teaching Package" is
 * identified by the Learning Item key `(type, id)`; versions are rows.
 */
import type { OutlineDiagnostic, TeachingScenePolicy } from '@openmaic/generation';

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
 * An exact canonical Skill reference — `(skillId, version)`, never "latest".
 * Kafuo validates reference shape; TE alone is authoritative for whether the
 * reference resolves (teaching-skills plan §G).
 */
export interface TeachingSkillRef {
  skillId: string;
  version: string;
}

/**
 * A required Skill rule with an EXPLICIT requirement scope and assignment role
 * (BR-TS-010 — V1 defines no implicit default scope and no "appears on at least
 * one Scene" fallback). Closed V1 vocabularies: scope ∈
 * {'flow_position','every_instructional_scene'}, role ∈ {'primary','supporting'}.
 */
export interface TeachingRequiredSkillRule {
  skill: TeachingSkillRef;
  scope: string;
  role: string;
}

/**
 * An explicitly prohibited unordered pairing of two exact Skill versions on one
 * Scene (BR-TS-055 — explicit restrictions only; V1 builds no universal
 * compatibility engine).
 */
export interface TeachingSkillCombinationRestriction {
  skillA: TeachingSkillRef;
  skillB: TeachingSkillRef;
}

/**
 * The Teaching Model Skill Policy for one resolved flow-position instance
 * (FRD §10.7). Authored on Kafuo's frozen flow definition item and projected onto
 * every expanded entry by `expand_teaching_model_flow`; TE receives and validates
 * it and NEVER re-expands or re-derives it (plan §G).
 */
export interface TeachingSkillPolicy {
  required: TeachingRequiredSkillRule[];
  preferred: TeachingSkillRef[];
  allowed: TeachingSkillRef[];
  combinationRestrictions: TeachingSkillCombinationRestriction[];
}

/**
 * The Scene-level Teaching Skills carrier (Module 2 W9, plan §E/§F): Primary and
 * Supporting assignment plus the instructional classification, on ONE carrier for
 * every Scene type — no second Scene model.
 *
 * Every member is optional and additive: absence on a legacy Scene is the
 * backward-compatibility mechanism itself (AC-TS-034 — legacy lineage absence is
 * explicit and never fabricated). Nothing populates the carrier until W10's
 * generation-time selection; W12's validators consume it.
 *
 * The refs keep BOTH the stable canonical id and the exact version so later
 * validators can key duplicates on the ID while resolution keys on the pair
 * (plan §K: `primary feynman v1` + `supporting feynman v2` must be detectable as
 * the same Skill twice).
 */
export interface SceneTeachingSkills {
  /** Exactly one primary on an instructional Scene (BR-TS-021); absent on a genuinely non-instructional one. */
  primary?: TeachingSkillRef;
  /** Intentional `0..N` supporting Skills (BR-TS-022 — no arbitrary V1 cap). */
  supporting?: TeachingSkillRef[];
  /** The classification emitted at outline time (FR-TS-022); never derived from Skill absence (BR-TS-054). */
  classification?: 'instructional' | 'non-instructional';
}

/**
 * The durable per-Scene ALIGNMENT BASELINE (Module 2 W14/W15 — teaching-skills
 * plan §K): the last known-aligned state of one Scene, against which the four
 * functional alignment states are DERIVED at read (§K derivation). Identity
 * plus state ONLY — no chain-of-thought, no long rationale (BR-TS-032,
 * FR-TS-037).
 *
 * Persistence owner (plan §F/§K, one answer): package Scene/Stage lifecycle
 * data, NOT generation-attempt state — an app-layer Scene field that travels
 * with a same-model clone (stage-clone spread), is governed by Stage/package
 * editability, and freezes with approved content. `sceneRev` is deliberately
 * NOT part of the binding (it would invalidate on metadata-only edits, which
 * FR-TS-043 forbids); the write path is still `sceneRev`-guarded via putScene.
 *
 * Absent on legacy data and until W15 stamps one — absence IS the derived
 * `validation-required` state for a governed Scene.
 */
export interface SceneAlignmentBaseline {
  /** The primary the baseline was taken against; absent for a genuinely non-instructional Scene. */
  primary?: TeachingSkillRef;
  /** The supporting set the baseline was taken against (ordered, exact versions). */
  supporting?: TeachingSkillRef[];
  /** The classification the baseline was taken against. */
  classification: 'instructional' | 'non-instructional';
  /** sha256 over the R-6 material projection (content · actions · title · description). */
  fingerprint: string;
  /** Who established it — reviewer-confirmed baselines only; generation baselines carry none. */
  actorRef?: string;
  /** Epoch milliseconds. */
  establishedAt: number;
  /** `'generation'` (stamped post-generation by W15) | `'reviewer-confirmation'` (recorded by W15's route). */
  origin: 'generation' | 'reviewer-confirmation';
}

/**
 * Kafuo Teaching Model Flow entry (FRD §11.1). Array order is authoritative;
 * TE derives the zero-based `flowIndex` from position. Repeated stage keys are
 * valid — identity is `(flowIndex, stage)`. Kafuo never sends `flowIndex`.
 *
 * `skillPolicy` is the definition item's policy projected onto this resolved
 * position by Kafuo's expansion; optional because pre-Module-2 requests carry
 * none (the legacy path parses exactly as before).
 */
export interface TeachingFlowEntry {
  /** Case-sensitive stable machine key, e.g. `lesson_introduction`. */
  stage: string;
  /** Non-empty pedagogical instructions for this flow position. */
  instructions: string;
  /** Projected Skill Policy; absent on pre-Module-2 (legacy) requests. */
  skillPolicy?: TeachingSkillPolicy;
  /**
   * Projected machine-readable scene policy of this position (g5.v5+): the
   * allowed scene types, slide types and content roles, the visual requirement
   * and the cardinality. Absent on earlier Teaching Model versions, whose
   * positions keep the stage-keyed legacy rules (`scenePolicyFor`).
   */
  scenePolicy?: TeachingScenePolicy;
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
  /**
   * g5.v7: the objective's part of the book, its content unit ids in book order.
   * Absent on every other version, so their canonical digest is unchanged.
   */
  contentUnitIds?: string[];
}

/** One unit of the g5.v7 book map (`bookStructure.units[]`), in book order. */
export interface KafuoBookStructureUnit {
  contentUnitId: string;
  /** The profile kind the book printed it as, e.g. `WORKED_EXAMPLE`. */
  kind: string | null;
  /** The Lesson Template element it becomes; `null` when the template does not name its kind. */
  element: string | null;
  /** Coverage requires a slide citing it (P-6). */
  required: boolean;
  /** Absent for opening, objective-source and ignored units. */
  partIndex?: number;
  /**
   * For a try-it unit: the worked example printed before it. g5.v8: for an
   * `exercise` unit, the «المثال N» it is printed under.
   */
  pairedExampleUnitId?: string;
  /** For a supporting note: the element it explains. */
  attachesToUnitId?: string;
  /**
   * g5.v8, `exercise` units only: sent (always `false`) when the unit holds no
   * solvable item. Absent ⇒ usable.
   */
  exerciseUsable?: false;
  /** g5.v8: why an exercise unit is unusable (sent with `exerciseUsable: false`). */
  exerciseUnusableReason?: KafuoExerciseUnusableReason;
}

/**
 * Why a g5.v8 exercise unit holds no item to pick. `instructions_only` is the
 * instruction line of the units after it that share its `pairedExampleUnitId`.
 */
export const KAFUO_EXERCISE_UNUSABLE_REASONS = [
  'empty',
  'number_only',
  'figure_description_only',
  'instructions_only',
] as const;
export type KafuoExerciseUnusableReason = (typeof KAFUO_EXERCISE_UNUSABLE_REASONS)[number];

/** g5.v8: the exercises block caps (owner decision D-4), sent when the map holds exercises. */
export interface KafuoExercisePolicy {
  maxExercises: number;
  maxExerciseSlides: number;
  /**
   * The block's effective minimum (owner, 2 Nov 2026): `min(6, usable)` exercise
   * units on at least `minExerciseSlides` slides (2 when 6+ are usable, else 1).
   * Both present or both absent; absent on older wires and when none is usable.
   */
  minExercises?: number;
  minExerciseSlides?: number;
}

/** The g5.v7 book map and Lesson Template Kafuo sends (`bookStructure`). */
export interface KafuoBookStructure {
  templateVersionId: string;
  rules: Array<{ kind: string; element: string; required: boolean }>;
  units: KafuoBookStructureUnit[];
  /** g5.v8 only, and only when the map holds exercise units. */
  exercisePolicy?: KafuoExercisePolicy;
}

/**
 * g5.v11 (teacher-guide answer referee plan §4/§7): the status of one guide item matched
 * to OUR question. `approved` = same givens and an independent check agrees; `settled` =
 * a person settled a doubtful item; the others are never given to the model.
 */
export const KAFUO_TEACHER_GUIDE_STATUSES = [
  'approved',
  'settled',
  'doubtful',
  'changed',
  'reference',
  'missing',
] as const;
export type KafuoTeacherGuideStatus = (typeof KAFUO_TEACHER_GUIDE_STATUSES)[number];

/** The kinds of a normalized guide answer (`answer.type`). */
export const KAFUO_TEACHER_GUIDE_ANSWER_TYPES = ['number', 'choice', 'bool', 'text'] as const;
export type KafuoTeacherGuideAnswerType = (typeof KAFUO_TEACHER_GUIDE_ANSWER_TYPES)[number];

/**
 * A guide answer, normalized by the backend (`answer_value`). `choice` is the book's
 * option letter (A–D or أ/ب/ج/د); `approximate` marks a «تقريبًا» answer (5% tolerance).
 */
export type KafuoTeacherGuideAnswer =
  | { type: 'number'; value: number; unit?: string; approximate?: true }
  | { type: 'choice'; value: string; unit?: string }
  | { type: 'bool'; value: boolean; unit?: string }
  | { type: 'text'; value: string; unit?: string };

/**
 * The kinds of a guide model answer (`modelAnswer.kind`): a proof, an open «إجابة ممكنة»,
 * or a drawing («مثّل بيانيًا», «ارسم …»).
 */
export const KAFUO_TEACHER_GUIDE_MODEL_ANSWER_KINDS = ['proof', 'possible', 'figure'] as const;
export type KafuoTeacherGuideModelAnswerKind =
  (typeof KAFUO_TEACHER_GUIDE_MODEL_ANSWER_KINDS)[number];

/**
 * The guide's answer drawing (owner, 17 Nov 2026): a PNG of at most 5,000,000 bytes.
 * `url` is the transient presigned GET URL the Backend mints at send time: on the wire
 * only, never in the digest, the attempt snapshot, logs or responses (like
 * `contentResource.url`). Every record read after the run has no `url`.
 */
export interface KafuoTeacherGuideFigureImage {
  checksumSha256: string;
  mimeType: 'image/png';
  sizeBytes: number;
  url?: string;
}

/**
 * Owner decision (17 Nov 2026): the guide's model answer of a proof or an open «إجابة ممكنة»
 * question (1..4000 characters), or its answer drawing (an image, with an optional note).
 * Never a key: it reaches the solution slides' writers only, so the worked proof or
 * solution follows it and the drawing is shown on that slide.
 */
export type KafuoTeacherGuideModelAnswer =
  | { kind: 'proof' | 'possible'; text: string }
  | { kind: 'figure'; image: KafuoTeacherGuideFigureImage; text?: string };

/** One guide item, keyed by OUR content unit and OUR item label («1A», «11», «11b»). */
export interface KafuoTeacherGuideItem {
  contentUnitId: string;
  label: string;
  status: KafuoTeacherGuideStatus;
  /** Required on `approved`; allowed on `settled`; never on any other status. */
  answer?: KafuoTeacherGuideAnswer;
  /** Allowed on `reference` only (owner, 17 Nov 2026); never on any other status. */
  modelAnswer?: KafuoTeacherGuideModelAnswer;
}

/**
 * g5.v11 only: the `teacherGuide` block of a generation request (records only, no page
 * text; a `reference` record may carry its model answer, owner 17 Nov 2026).
 */
export interface KafuoTeacherGuide {
  guideId: string;
  items: KafuoTeacherGuideItem[];
}

/** One g5.v11 settlement pinned on the attempt (`GuideAnswerSettlement` plus its run). */
export interface GuideAnswerSettlementRecord {
  outlineId: string;
  action:
    | 'questions_removed'
    | 'items_removed'
    | 'unverified'
    | 'narration_replaced'
    | 'attempt_dropped'
    | 'final_line_written'
    | 'key_rewritten';
  /** The outline ids that left the lesson: only an attempt left with no question. */
  dropped: string[];
  removedQuestions: number[];
  items: Array<{
    contentUnitId: string;
    label: string;
    outcome: 'removed' | 'unverified' | 'written';
  }>;
  findings: Array<{ code: string; contentUnitId: string; label: string; where: string }>;
  generationRun: number;
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
  /**
   * Model string from resolveModel; patched in by the runner after resolution.
   * Legacy (non-Kafuo) runs and Kafuo runs with `TEACHING_SUBJECT_ROUTING=off`
   * only — a subject-routed run records the policy below instead.
   */
  resolvedLlmModel?: string;
  /** ---- Subject routing (Kafuo R1 plan §5.1, §7.4) — patched by the runner ---- */
  /** The routed subject (`learningItem.subjectOffering.code`) the attempt ran under. */
  subjectCode?: string;
  /** The policy version the pair below was taken from. */
  policyVersion?: string;
  /** Canonical `provider:model` strings of the subject's Primary and Fallback. */
  primaryModel?: string;
  fallbackModel?: string;
  /**
   * The superadmin-configured route the attempt ran under, frozen by the runner
   * with the subject route (teaching-generation-model-admin-config-plan-2026-11-18
   * D-10). Absent ⇒ the code-owned table (`policyVersion` `r1-2026-09`). Slide
   * regeneration, slide insertion and package questions read it back (D-6, D-7).
   */
  generationRoute?: GenerationModelRoute;
  /**
   * The planning and review model route the attempt ran its planner under
   * (package-planner-issue-resolve-plan-2026-11-22 §3c), frozen beside
   * `generationRoute`. Absent ⇒ planning followed the generation route.
   */
  planRoute?: GenerationModelRoute;
  /**
   * "Regenerate as the original" (S6 G1(b), teaching-generation-model-admin-
   * config-plan-2026-11-18 D-18): set when the request said `routePin:
   * "original"`. `generationRoute` / `planRoute` above (or their absence, the
   * code table) were copied from `sourceAttemptId`, the version's producing
   * attempt, instead of today's settings.
   */
  routePin?: { mode: 'original'; sourceAttemptId: string };
  /**
   * The Teaching Engine build that ran the attempt (S5.5 / G4): the image's
   * `KAFUO_BUILD_SHA`, NULL when the image carries none (a local run, or an
   * image built before the deploy passed it). Written by the runner before any
   * model call; a correction resume writes `resumeEngineBuild` instead, so the
   * first run's build stays.
   */
  engineBuild?: { sha: string | null };
  resumeEngineBuild?: { sha: string | null };
  /** True when any teaching-call ledger row of this attempt did not reach `complete`. */
  ledgerIncomplete?: boolean;
  /**
   * Outline metadata the run repaired (e.g. an incompatible `contentKind`
   * dropped with the role kept) — written by the runner before binding.
   */
  outlineRepairs?: Array<{
    code: string;
    outlineId?: string;
    field?: string;
    previousValue?: unknown;
    message: string;
  }>;
  requestedAt: number;
  /** ---- Kafuo integration additions (FRD §9.2/§17.1) ---- */
  /** Effective Kafuo tenant; `LEGACY_TENANT_ID` for pre-tenant rows. */
  tenantId?: string;
  /** The ordered Kafuo Teaching Model Flow when the request carried one. */
  teachingFlow?: TeachingFlowEntry[];
  /** g5.v7: the book map, pinned so an outline edit re-checks book coverage. */
  bookStructure?: KafuoBookStructure;
  /**
   * g5.v11 only: the approved teacher-guide answers, pinned so a correction re-check,
   * a resume and the AI reviewer read the same records. Absent on every other model.
   */
  teacherGuide?: KafuoTeacherGuide;
  /**
   * g5.v11: the items whose checked answer still failed after their one regeneration
   * (D-19): an attempt question removed, an exercise removed from the lesson, an item
   * kept unverified, an attempt's narration replaced, or an attempt left with no question
   * dropped. Pinned per run (merged, never overwritten) BEFORE any pause, so a resumed
   * run never re-inserts a dropped attempt. Labels and codes only, never an answer value.
   */
  guideAnswerSettlements?: GuideAnswerSettlementRecord[];
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
  /**
   * The explicit Teaching Skills governance contract marker Module 2 requests
   * carry (Module 2 W6, plan §M). Its ABSENCE is the genuine pre-Module-2
   * legacy path — governance is declared, never inferred from Skill fields,
   * policy presence, or flow presence. Identifiers only; secrecy-safe.
   * `null` and absence are both the legacy state (truthiness is the test).
   */
  teachingSkillsContract?: string | null;
  /**
   * Deterministic digest of the resolved Skill Policy lineage — integrity
   * evidence only, NOT the mode declaration (the contract marker above is).
   * Nullable: a policy-free flow carries no lineage evidence.
   */
  skillPolicyDigest?: string | null;
  /** Source-visual counts patched in by the acquisition/generation layers. */
  sourceVisualSummary?: {
    available: number;
    selected: number;
    materialized: number;
  };
  /**
   * Diagnosis only (lesson 306, F-1), patched in by the runner: the attempt's
   * outline answers that needed a JSON repair, could not be parsed, or were
   * refused as broken — in call order, the latest few — each a size-capped
   * copy of the model's raw text. Model output only: no prompt, key or
   * student data. Absent while every answer was read without a repair.
   */
  outlineAnswerDiagnostics?: Array<OutlineAnswerCapture & { generationRun: number; at: number }>;
  /**
   * Every automatic change the plan review made to this attempt's plan before
   * any person saw it (package-planner-issue-resolve-plan-2026-11-22 §3b, P1):
   * the free rule fixes and the book repair now, the AI plan review (P2) next.
   * Only the current generation run's fixes are kept, oldest first, capped.
   */
  planReview?: {
    fixes: PlanReviewFix[];
    /** The AI plan review's prompt version, once it recorded a fix (P2). */
    promptVersion?: string;
  };
}

/**
 * One automatic change to a plan (package-planner-issue-resolve-plan-2026-11-22
 * §3b). `from` is the before-state an undo needs (a move's old index, a set's
 * old value, a removed outline in full); it never reaches a browser.
 */
export interface PlanReviewFix {
  id: string;
  op: 'set' | 'move' | 'remove' | 'insert_book_slide';
  outlineId: string;
  field?: string;
  from?: unknown;
  to?: unknown;
  /** A short plain Arabic sentence for the admin; never lesson text. */
  reason: string;
  actor: 'system:plan-reviewer';
  /** 0 for the free rule fixes and the book repair; 1–2 for the AI review rounds. */
  round: number;
  generationRun: number;
  at: number;
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
  | 'stage_replaced'
  // Reviewer-driven single-slide regeneration (single-slide-regeneration-plan §10.3).
  | 'scene_regeneration_started'
  | 'scene_regeneration_completed'
  | 'scene_regeneration_failed'
  | 'scene_regeneration_refused'
  | 'scene_regeneration_restored'
  // Reviewer-generated slide for a lesson part (reviewer-generated-slide plan §12 E-2).
  | 'scene_insertion_started'
  | 'scene_insertion_completed'
  | 'scene_insertion_failed'
  | 'scene_insertion_refused';

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

/**
 * `awaiting_admin_correction` is the durable, non-terminal pause of an attempt
 * whose candidate needs a person (slide-classification-admin-correction-plan
 * §3): it is in flight, never reclaimed as stale, never a failure, and resumes
 * the SAME attempt.
 */
export type GenerationAttemptStatus =
  | 'queued'
  | 'running'
  | 'awaiting_admin_correction'
  | 'succeeded'
  | 'failed';

/** Where a paused attempt stopped: before any Stage (`outline`) or on a retained Stage (`scenes`). */
export type GenerationCheckpointPhase = 'outline' | 'scenes';

/** `awaiting` a person, `resumed` (by the revision recorded), or `abandoned`. */
export type GenerationCheckpointState = 'awaiting' | 'resumed' | 'abandoned';

/** Metadata of one screened-and-approved source visual — never its bytes or URL. */
export interface CheckpointSourceImage {
  id: string;
  sha256: string;
  pageNumber: number | null;
  sourceContentUnitIds?: string[];
  caption?: string;
  figureLabel?: string;
  description?: string;
  width?: number;
  height?: number;
}

/**
 * The secret-free references a resume needs (plan §3.1). Everything the
 * candidate was validated against is pinned here, so an edit is revalidated
 * against exactly the same authority and a resume can prove the re-acquired
 * source is the one the candidate was planned from.
 */
export interface GenerationCheckpointSourceRefs {
  /** sha256 of the attempt's authoritative `teachingFlow` (snapshot). */
  flowDigest: string;
  /** The attempt's canonical request digest; a resume must present the same. */
  requestDigest: string | null;
  /** The classroom run the candidate belongs to (ledger attribution on resume). */
  generationRun: number;
  sourceKind: 'pdf_fallback' | 'kafuo_normalized';
  contentResourceId: string;
  /** Measured sha256 of the acquired source; re-acquisition must match it. */
  measuredSha256: string;
  normalizedPackageId?: string;
  /** The exact Content Unit id set the grounding gate used; null = no gate. */
  contentUnitIds: string[] | null;
  /**
   * The essential sections the Submit coverage gate requires; absent on
   * checkpoints paused before the gate existed.
   */
  essentialContentUnitIds?: string[] | null;
  /**
   * Essential sections the model's plan left without a teaching slide. Sticky:
   * an admin outline edit can neither clear nor cite one; only a slide
   * generated for it after generation ("Generate slide") restores it.
   */
  coverageGapUnitIds?: string[];
  /**
   * g5.v8 only: per check / exercise unit, its labelled items and detectable
   * hidden-step types (no text), so a correction re-check reads the same facts
   * as the run. Absent on every earlier version.
   */
  bookUnitFacts?: Record<
    string,
    {
      itemLabels: string[];
      hiddenSteps: Array<'ordered_named_set' | 'clock_time'>;
      /** The unit's numbered questions (3 Nov 2026); absent on older checkpoints. */
      questionNumbers?: number[];
      /** 4 Nov 2026: every item held a verse or hadith; never selected. */
      noItemsLeft?: true;
    }
  >;
  /** Content Unit choices for a person (id, order, title, role) — no text. */
  contentUnits: Array<{
    id: string;
    order: number;
    title: string | null;
    role: string;
    /** Lesson 2-5 (17 Nov 2026): the normalized subtype (absent on older checkpoints). */
    subtype?: string | null;
  }>;
  /** Screening verdicts reused on resume instead of screening again. */
  visualVerdicts: {
    approved: Array<{ id: string; sha256: string }>;
    withheld: Array<{ id: string; sha256: string; verdict: string }>;
  };
  /** Approved source visuals offered to the planner (metadata only). */
  sourceImages: CheckpointSourceImage[];
}

/** One outline answer kept for diagnosis (see `outlineAnswerDiagnostics`). */
export interface OutlineAnswerCapture {
  /** How the JSON reader read it; `null` = not parseable at all. */
  parse: {
    extraction: string;
    repair: string;
    reasoningPrefixStripped: boolean;
    exact: boolean;
  } | null;
  /** The structural findings that refused it (empty = it was only repaired). */
  malformed: string[];
  /** Length of the whole raw text, in UTF-16 code units (JS string length). */
  rawLength: number;
  /** The raw text when it fits in 16,384 code units, else its first 8,192. */
  rawHead: string;
  /** The last 8,192 code units when the text was cut, else empty. */
  rawTail: string;
}

export interface GenerationCheckpointLogEntry {
  revision: number;
  event: 'paused' | 'edited' | 'resumed' | 'abandoned';
  actorRef: string;
  at: number;
  phase?: GenerationCheckpointPhase;
  blockingCount?: number;
  operations?: unknown[];
  reason?: string;
  /**
   * On a `paused` entry: the plan review's automatic fixes since the run (or
   * the resume) began (package-planner-issue-resolve-plan-2026-11-22 §3b).
   */
  planFixes?: PlanReviewFix[];
  /**
   * On a `paused` entry: the pausing run had the plan review (P3). A checkpoint whose
   * pauses all lack it paused before the review existed and is reviewed once.
   */
  planReviewed?: boolean;
  /** A `review_plan` on this checkpoint (P3): `started`, then `finished` with its fixes. */
  planReview?: 'started' | 'finished';
}

export interface GenerationCheckpoint {
  attemptId: string;
  tenantId: string;
  phase: GenerationCheckpointPhase;
  state: GenerationCheckpointState;
  /** Optimistic-concurrency token; every edit increments it. */
  revision: number;
  outlines: import('@/lib/types/generation').SceneOutline[];
  courseTitle: string | null;
  languageDirective: string;
  /** Open admin-correctable findings. Empty ⇒ the candidate may resume. */
  diagnostics: OutlineDiagnostic[];
  /** Machine repairs applied to the candidate (visible, not blocking). */
  repairs: OutlineDiagnostic[];
  sourceRefs: GenerationCheckpointSourceRefs;
  /** `scenes` phase: the retained, unbound Stage. */
  reservedStageId: string | null;
  /** `scenes` phase: the outlines whose Scenes a resume regenerates. */
  pendingOutlineIds: string[] | null;
  editLog: GenerationCheckpointLogEntry[];
  resumedRevision: number | null;
  pauseCount: number;
  pausedAt: number;
  updatedAt: number;
  resumedAt: number | null;
  abandonedAt: number | null;
}

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
  /**
   * The authoritative Teaching Skills governance discriminator, persisted from
   * the request marker (Module 2 W6, plan §F/§M). `NULL` ⇒ the attempt was not
   * governed by Teaching Skills ⇒ legacy. Never inferred from content.
   */
  teachingSkillsContract: string | null;
  /** Skill Policy lineage digest — integrity evidence, not the mode declaration. */
  skillPolicyDigest: string | null;
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

/**
 * `learningItem.subjectOffering` as Kafuo sends it (R1 contracts §6). The
 * optional keys are present exactly when the wire carried them (null values
 * included) so the shared canonical digest stays byte-compatible.
 */
export interface KafuoSubjectOffering {
  id: string;
  name: string;
  code?: string | null;
  nameAr?: string | null;
  nameEn?: string | null;
  academicLanguage?: string | null;
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
  /**
   * The Kafuo subject offering (R1 contracts §6). `code` is the routing key
   * (`master_subjects.routing_key`); the Backend sends `code: null` for an
   * unrouted subject — kept as received here (the digest covers the wire
   * shape byte-for-byte), normalised separately into
   * `KafuoGenerationContext.subjectCode`.
   */
  subjectOffering?: KafuoSubjectOffering;
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
  /**
   * The explicit `teachingSkills` governance marker, when the request carried
   * one (Module 2 W6). Undefined ⇒ legacy — never inferred from `skillPolicy`
   * presence (plan §M).
   */
  teachingSkillsContract?: string;
  /**
   * The superadmin-configured narration route for the lesson's subject
   * (tts-provider-routing-admin-config-plan §3.2). Absent ⇒ the default
   * routing table, and the canonical digest is byte-identical to before.
   */
  narration?: { ttsRoute: KafuoNarrationTtsRoute };
  /**
   * The superadmin-configured generation model route for the lesson's subject
   * (teaching-generation-model-admin-config-plan-2026-11-18 D-9). Absent ⇒ the
   * code-owned subject table, and the canonical digest is byte-identical to before.
   */
  modelRoute?: GenerationModelRoute;
  /**
   * The superadmin-configured planning and review model route for the lesson's
   * subject (package-planner-issue-resolve-plan-2026-11-22 §3c, D-5/D-10), with
   * `settingKey` `teaching_generation.plan_route.<CODE>`. It drives the
   * planner's outline call and every call made through it. Absent ⇒ planning
   * runs on the generation route, and the canonical digest is byte-identical.
   */
  planRoute?: GenerationModelRoute;
  /**
   * "Regenerate as the original" (S6 G1(b), teaching-generation-model-admin-
   * config-plan-2026-11-18 D-18): `"original"` makes a regeneration
   * (`versionId` required) run on the version's producing attempt's frozen
   * `generationRoute` / `planRoute`, or on the code table when that attempt
   * ran on it, instead of a sent route. Never sent with `modelRoute` or
   * `planRoute`. Covered by the digest when present; absent ⇒ byte-identical.
   */
  routePin?: 'original';
  /**
   * g5.v7 only: the lesson's book map and Lesson Template. Absent ⇒ every
   * earlier version's planning and digest are unchanged.
   */
  bookStructure?: KafuoBookStructure;
  /**
   * g5.v11 (teacher-guide answer referee plan §7): the guide items matched to this
   * lesson's questions. Covered by the digest when sent; used on g5.v11 only.
   */
  teacherGuide?: KafuoTeacherGuide;
}

/** `narration.ttsRoute` as Kafuo sends it; the model and language come from the TE catalogue. */
export interface KafuoNarrationTtsRoute {
  providerId: string;
  voiceId: string;
  /** The Kafuo runtime setting key, e.g. `teaching_tts.route.CHEMISTRY` (audit lineage). */
  settingKey: string;
}

/**
 * One target of a configured generation route (plan D-13): a catalogue model
 * string and one of that model's thinking values (`low`, `on`, …).
 */
export interface GenerationRouteTarget {
  model: string;
  thinking: string;
}

/**
 * `modelRoute` as Kafuo sends it (plan D-9), and as it is frozen on the producing
 * attempt's `input_snapshot.generationRoute` (D-10). Validated against the TE
 * catalogue (`lib/server/teaching-model/generation-catalog.ts`).
 */
export interface GenerationModelRoute {
  primary: GenerationRouteTarget;
  fallback: GenerationRouteTarget;
  /** The Kafuo runtime setting key, e.g. `teaching_generation.route.MATH` (audit lineage). */
  settingKey: string;
}

// ---------------------------------------------------------------------------
// Teaching Engine → Kafuo webhook contract (FRD §9.8) plus the admin-correction pause.
// ---------------------------------------------------------------------------

export type TeachingEngineWebhookType =
  | 'teaching_package.generation_succeeded'
  | 'teaching_package.generation_failed'
  | 'teaching_package.status_changed'
  | 'teaching_package.generation_awaiting_correction';

/**
 * The attempt paused for an administrator (plan §3.1). Identity-only: no
 * outline text, no source content, no retrieval URL.
 */
export interface GenerationAwaitingCorrectionEventData {
  requestId: string;
  attempt: {
    id: string;
    kind: GenerationAttemptKind;
    status: 'awaiting_admin_correction';
    versionId: string | null;
    startedAt: number | null;
    pausedAt: number;
    generationRuns: number;
  };
  correction: {
    phase: GenerationCheckpointPhase;
    revision: number;
    blockingIssueCount: number;
  };
}

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
// Quran and hadith pins (quran-text-handling-rules-plan Q-14). Persisted on
// the outline record; carries no quote text.
// ---------------------------------------------------------------------------

export interface SacredQuotePin {
  kind: 'quran' | 'hadith';
  /** Hex sha256 of the quote's exact UTF-8 text (a verse includes its ﴿ ﴾). */
  sha256: string;
  sourceBlockId: string | null;
  contentUnitId: string;
  reference: string | null;
  /** The generated package shows this quote. */
  used: boolean;
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
