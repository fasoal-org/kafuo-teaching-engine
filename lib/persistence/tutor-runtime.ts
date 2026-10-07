/**
 * Student runtime tables for Free Chat and Help (Kafuo R1 plan §5.1 Revision 1
 * DDL + Revision 4 additions; contracts §5).
 *
 * Same pattern as `teaching-model-attempts.ts`: idempotent `ensure…Schema`
 * DDL run at boot from `server-provider.ts`, and raw helpers over a
 * `Queryable` so every write can join the caller's transaction — the
 * conversational turn commits its tutor message, its ledger completion and
 * its meter finalize outbox row as ONE transaction (§7.7, §8.6). No class, no
 * store, nothing under `data/` (§9.4; `tests/lint-no-local-state`).
 *
 * Ownership is `(tenant_id, student_ref)` on conversations and
 * `(version_id, stage_id, scene_id, learner_key)` on help sessions (§9.3);
 * the read helpers take the owner so a mismatch reads exactly like an absent
 * row (the routes answer a non-enumerating 404).
 *
 * Timestamps are DOUBLE PRECISION epoch SECONDS (contracts §1). `seq` is the
 * per-conversation message order; `BIGINT` comes back as a string from `pg`,
 * so every reader converts through `Number`.
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const TUTOR_RUNTIME_TABLES = `
CREATE TABLE IF NOT EXISTS tutor_conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
  student_ref TEXT NOT NULL,
  subject_code TEXT NOT NULL,
  subject_offering_id TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  academic JSONB NOT NULL,
  lesson_association JSONB,
  title TEXT,
  title_source TEXT CHECK (title_source IN ('topic','lesson','lesson_suffix','fallback','pending')),
  status TEXT NOT NULL CHECK (status IN ('active','archived')),
  grounding JSONB,
  context_summary TEXT,
  summary_through_seq BIGINT,
  last_input_tokens INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at DOUBLE PRECISION,
  client_request_id TEXT,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL
);

ALTER TABLE tutor_conversations ADD COLUMN IF NOT EXISTS client_request_id TEXT;

CREATE TABLE IF NOT EXISTS tutor_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES tutor_conversations(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','tutor')),
  client_message_id TEXT,
  turn_id TEXT NOT NULL,
  turn_attempt INTEGER NOT NULL DEFAULT 1,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','generating','completed','failed')),
  served_by TEXT CHECK (served_by IN ('primary','fallback')),
  grounding_mode TEXT CHECK (grounding_mode IN ('none','reuse','retrieved','scene','insufficient','clarification')),
  safety JSONB,
  error_code TEXT,
  accounting_complete BOOLEAN NOT NULL DEFAULT FALSE,
  meter_reservation_id TEXT,
  meter_finalized BOOLEAN NOT NULL DEFAULT FALSE,
  generating_at DOUBLE PRECISION,
  created_at DOUBLE PRECISION NOT NULL,
  completed_at DOUBLE PRECISION,
  CONSTRAINT tm_conversation_seq_unique UNIQUE (conversation_id, seq)
);

ALTER TABLE tutor_messages ADD COLUMN IF NOT EXISTS generating_at DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS tutor_help_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
  version_id TEXT NOT NULL REFERENCES teaching_package_versions(id) ON DELETE RESTRICT,
  stage_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  learner_key TEXT NOT NULL,
  student_ref TEXT NOT NULL,
  subject_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','closed')),
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  CONSTRAINT ths_anchor_unique UNIQUE (version_id, stage_id, scene_id, learner_key)
);

CREATE TABLE IF NOT EXISTS tutor_help_messages (
  id TEXT PRIMARY KEY,
  help_session_id TEXT NOT NULL REFERENCES tutor_help_sessions(id) ON DELETE RESTRICT,
  seq BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','tutor')),
  client_message_id TEXT,
  turn_id TEXT NOT NULL,
  turn_attempt INTEGER NOT NULL DEFAULT 1,
  step_ref TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','generating','completed','failed')),
  served_by TEXT CHECK (served_by IN ('primary','fallback')),
  grounding_mode TEXT CHECK (grounding_mode IN ('none','reuse','retrieved','scene','insufficient')),
  safety JSONB,
  error_code TEXT,
  accounting_complete BOOLEAN NOT NULL DEFAULT FALSE,
  meter_reservation_id TEXT,
  meter_finalized BOOLEAN NOT NULL DEFAULT FALSE,
  generating_at DOUBLE PRECISION,
  created_at DOUBLE PRECISION NOT NULL,
  completed_at DOUBLE PRECISION,
  CONSTRAINT thm_session_seq_unique UNIQUE (help_session_id, seq)
);

ALTER TABLE tutor_help_messages ADD COLUMN IF NOT EXISTS generating_at DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS tutor_turn_groundings (
  turn_id TEXT PRIMARY KEY,
  conversation_id TEXT,
  help_session_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('none','reuse','retrieved','scene','insufficient','clarification')),
  assessment JSONB NOT NULL,
  units JSONB NOT NULL,
  total_chars INTEGER NOT NULL CHECK (total_chars <= 10000),
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  input_token_estimate INTEGER NOT NULL,
  lineage_status TEXT CHECK (lineage_status IN ('own_attempt','predecessor_attempt','partial','unavailable')),
  resolved_attempt_id TEXT,
  budget_estimate_tokens INTEGER NOT NULL,
  budget_counter_kind TEXT NOT NULL CHECK (budget_counter_kind IN ('exact','proxy')),
  created_at DOUBLE PRECISION NOT NULL
);
`;

const TUTOR_RUNTIME_INDEXES = `
CREATE INDEX IF NOT EXISTS tc_student_idx
  ON tutor_conversations (tenant_id, student_ref, status, last_message_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS tc_client_request_unique
  ON tutor_conversations (tenant_id, student_ref, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tm_client_message_unique
  ON tutor_messages (conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tm_meter_reservation_idx
  ON tutor_messages (meter_reservation_id)
  WHERE meter_reservation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS thm_client_message_unique
  ON tutor_help_messages (help_session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS thm_meter_reservation_idx
  ON tutor_help_messages (meter_reservation_id)
  WHERE meter_reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ttg_conversation_idx
  ON tutor_turn_groundings (conversation_id, created_at)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ttg_help_session_idx
  ON tutor_turn_groundings (help_session_id, created_at)
  WHERE help_session_id IS NOT NULL;
`;

/**
 * TE-1 / D5 (free-chat-ios-run-fix-plan §5): additive only. `progress_at` is
 * the epoch-seconds liveness mark of the current `generating` attempt: set
 * when the turn's stream opens and bumped every ~10 s while it runs
 * (`lib/server/tutor/turn-progress.ts`); `markGenerating` clears it for a new
 * attempt. At admission a `generating` row with no progress for 30 s is stale.
 * NULL (rows from before the column, or a turn still before its stream)
 * keeps the 120 s `generating_at` rule. A re-run is a no-op.
 */
const TURN_PROGRESS_EVOLUTION = `
ALTER TABLE tutor_messages ADD COLUMN IF NOT EXISTS progress_at DOUBLE PRECISION;
ALTER TABLE tutor_help_messages ADD COLUMN IF NOT EXISTS progress_at DOUBLE PRECISION;
`;

/**
 * Discovery-first Free Chat (discovery-first plan P7): additive only. The
 * `grounding_mode` CHECKs on `tutor_messages` and `tutor_turn_groundings`
 * gain `clarification` (drop and re-add, guarded — precedent
 * `teaching-model-attempts.ts` evolution block; `tutor_help_messages` never
 * uses it and keeps its CHECK). New nullable columns record the retrieval
 * source, outcome reason, resolution audit and stage timings, the
 * student-perceived first-delta time, and the pending clarification. A fresh
 * database (whose CREATE TABLE already carries the widened CHECKs) and a
 * re-run are no-ops. Nothing is ever narrowed.
 */
const TUTOR_RUNTIME_EVOLUTION = `
ALTER TABLE tutor_conversations ADD COLUMN IF NOT EXISTS pending_clarification JSONB;
ALTER TABLE tutor_messages ADD COLUMN IF NOT EXISTS first_delta_at DOUBLE PRECISION;
ALTER TABLE tutor_turn_groundings ADD COLUMN IF NOT EXISTS source TEXT
  CHECK (source IN ('kafuo_http','direct','shadow'));
ALTER TABLE tutor_turn_groundings ADD COLUMN IF NOT EXISTS outcome_reason TEXT;
ALTER TABLE tutor_turn_groundings ADD COLUMN IF NOT EXISTS resolution JSONB;
ALTER TABLE tutor_turn_groundings ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE tutor_turn_groundings ADD COLUMN IF NOT EXISTS embedding_tokens INTEGER;
ALTER TABLE tutor_turn_groundings ADD COLUMN IF NOT EXISTS pool_wait_ms DOUBLE PRECISION;
ALTER TABLE tutor_turn_groundings ADD COLUMN IF NOT EXISTS resolve_ms DOUBLE PRECISION;
ALTER TABLE tutor_turn_groundings ADD COLUMN IF NOT EXISTS embed_ms DOUBLE PRECISION;
ALTER TABLE tutor_turn_groundings ADD COLUMN IF NOT EXISTS search_ms DOUBLE PRECISION;
ALTER TABLE tutor_turn_groundings ADD COLUMN IF NOT EXISTS total_retrieval_ms DOUBLE PRECISION;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tutor_messages_grounding_mode_check'
       AND pg_get_constraintdef(oid) LIKE '%clarification%'
  ) THEN
    ALTER TABLE tutor_messages DROP CONSTRAINT IF EXISTS tutor_messages_grounding_mode_check;
    ALTER TABLE tutor_messages
      ADD CONSTRAINT tutor_messages_grounding_mode_check
      CHECK (grounding_mode IN ('none','reuse','retrieved','scene','insufficient','clarification'));
  END IF;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tutor_turn_groundings_mode_check'
       AND pg_get_constraintdef(oid) LIKE '%clarification%'
  ) THEN
    ALTER TABLE tutor_turn_groundings DROP CONSTRAINT IF EXISTS tutor_turn_groundings_mode_check;
    ALTER TABLE tutor_turn_groundings
      ADD CONSTRAINT tutor_turn_groundings_mode_check
      CHECK (mode IN ('none','reuse','retrieved','scene','insufficient','clarification'));
  END IF;
END;
$$;
${TURN_PROGRESS_EVOLUTION}`;

export const TUTOR_RUNTIME_SCHEMA = `${TUTOR_RUNTIME_TABLES}
${TUTOR_RUNTIME_INDEXES}
${TUTOR_RUNTIME_EVOLUTION}`;

/**
 * Idempotent; safe at every boot and twice in a row. Must run AFTER
 * `ensureTeachingPackageSchema`: `tutor_help_sessions.version_id` references
 * `teaching_package_versions`.
 */
export async function ensureTutorRuntimeSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(TUTOR_RUNTIME_TABLES)) {
    await queryable.query(statement);
  }
  for (const statement of splitSqlStatements(TUTOR_RUNTIME_INDEXES)) {
    await queryable.query(statement);
  }
  for (const statement of splitSqlStatements(TUTOR_RUNTIME_EVOLUTION)) {
    await queryable.query(statement);
  }
}

// ---------------------------------------------------------------------------
// Domain shapes
// ---------------------------------------------------------------------------

export type ConversationStatus = 'active' | 'archived';
export type TitleSource = 'topic' | 'lesson' | 'lesson_suffix' | 'fallback' | 'pending';
export type MessageRole = 'student' | 'tutor';
export type MessageStatus = 'accepted' | 'generating' | 'completed' | 'failed';
export type ServedBy = 'primary' | 'fallback';
/** `clarification` is Free Chat only (P7, D-8 (a)): a deterministic template, no model call. */
export type GroundingMode = 'none' | 'reuse' | 'retrieved' | 'scene' | 'insufficient' | 'clarification';
export type LineageStatus = 'own_attempt' | 'predecessor_attempt' | 'partial' | 'unavailable';
/** The retrieval path that served a Free Chat turn (`TUTOR_GROUNDING_SOURCE`, effective). */
export type GroundingSourceTag = 'kafuo_http' | 'direct' | 'shadow';
/** Kafuo Learning Item types Free Chat can ground on (LESSON and SECTION). */
export type LearningItemType = 'LESSON' | 'SECTION';
export type HelpSessionStatus = 'active' | 'closed';

export interface ConversationAcademic {
  curriculumId?: string;
  /** Labels are nullable upstream (Kafuo forwards nullable columns as-is). */
  curriculumName: string | null;
  curriculumVersionLabel: string | null;
  gradeLabel: string | null;
  academicLanguage: string;
  /** Both official subject names, so the academic block can show them (BR-03). */
  subjectNameAr?: string | null;
  subjectNameEn?: string | null;
}

/**
 * Association v2 (discovery-first P7, CHAT-07): the conversation's Learning
 * Item — a Kafuo `learning_items.id` with its type. Written only by the
 * `direct` path, on a `single` resolution or a single-item evidence set, and
 * cleared when a later turn grounds on other items.
 */
export interface ItemAssociationV2 {
  schema: 2;
  learningItemType: LearningItemType;
  learningItemId: string;
  title: string;
  confidence: number;
  associatedAtSeq: number;
  buildId: string | null;
}

/**
 * Rollback-only association written by the temporary `kafuo_http` path (it
 * can only name a Kafuo `lessons.id`). Never replaces a v2; removed in P11
 * with that path.
 */
export interface LessonAssociationV1 {
  schema: 1;
  lessonId: string;
  lessonTitle: string;
  confidence: number;
  associatedAtSeq: number;
}

export type ConversationAssociation = ItemAssociationV2 | LessonAssociationV1;

/**
 * The `(schema, type, id)` tuple titles and sibling counts key on, so a
 * schema-1 `lessons.id` never equals a v2 `learning_items.id`.
 */
export interface AssociationKey {
  schema: 1 | 2;
  type: string;
  id: string;
}

export function associationKey(association: ConversationAssociation): AssociationKey {
  return association.schema === 2
    ? { schema: 2, type: association.learningItemType, id: association.learningItemId }
    : { schema: 1, type: 'lesson', id: association.lessonId };
}

/** The human-readable name of the associated item (never an id). */
export function associationTitle(association: ConversationAssociation): string {
  return association.schema === 2 ? association.title : association.lessonTitle;
}

/** A unit retrieved by the `direct` path (snapshot v2): enough to revalidate it (D-17). */
export interface DirectSnapshotUnit {
  source: 'direct';
  unitId: string;
  itemId: string;
  itemType: LearningItemType;
  buildId: string;
  revisionId: string;
  unitUpdatedAt: string;
  title: string | null;
  text: string;
  chars: number;
}

/** A unit returned by the temporary `kafuo_http` path (no build/version data, never revalidated). */
export interface HttpSnapshotUnit {
  source: 'kafuo_http';
  unitId: string;
  lessonId: string | null;
  lessonTitle: string | null;
  title: string | null;
  text: string;
  chars: number;
}

export type GroundingSnapshotUnit = DirectSnapshotUnit | HttpSnapshotUnit;

/** A Learning Item the direct snapshot's units come from (for the prompt's per-item headers). */
export interface SnapshotItem {
  itemId: string;
  itemType: LearningItemType;
  title: string | null;
}

/**
 * The conversation's current grounding (§8.2 `reuse`), snapshot v2. The
 * `direct` path reuses only a `source: 'direct'` snapshot (after
 * `validate_units`); any other stored shape parses as "no snapshot".
 */
export type GroundingSnapshot =
  | {
      schema: 2;
      source: 'direct';
      units: DirectSnapshotUnit[];
      items: SnapshotItem[];
      keywords: string[];
      setAtSeq: number;
      lastUsedSeq: number;
    }
  | {
      schema: 2;
      source: 'kafuo_http';
      units: HttpSnapshotUnit[];
      keywords: string[];
      setAtSeq: number;
      lastUsedSeq: number;
    };

/** A clarification awaiting the student's choice (P7, FRD §9): ≤ 3 candidates, no text. */
export interface PendingClarification {
  candidates: Array<{ itemId: string; itemType: LearningItemType; title: string }>;
  /** `seq` of the student's original question (its text is re-read for retrieval). */
  questionSeq: number;
  /** `seq` of the tutor's clarification message. */
  askedAtSeq: number;
}

// --- Strict parsers (D-19: any other stored shape is "none", not an error) ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isItemType(value: unknown): value is LearningItemType {
  return value === 'LESSON' || value === 'SECTION';
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Accepts exactly association v2 or the rollback-only schema 1. Anything
 * else — including the pre-P7 `{learningItemType:'lesson', learningItemId:<lessons.id>}`
 * — is "no association". Ordinary input validation, not a compatibility path.
 */
export function parseConversationAssociation(raw: unknown): ConversationAssociation | null {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isRecord(value)) return null;
  if (value.schema === 2) {
    if (
      isItemType(value.learningItemType) &&
      isNonEmptyString(value.learningItemId) &&
      typeof value.title === 'string' &&
      isFiniteNumber(value.confidence) &&
      isFiniteNumber(value.associatedAtSeq) &&
      (value.buildId === undefined || isStringOrNull(value.buildId))
    ) {
      return {
        schema: 2,
        learningItemType: value.learningItemType,
        learningItemId: value.learningItemId,
        title: value.title,
        confidence: value.confidence,
        associatedAtSeq: value.associatedAtSeq,
        buildId: (value.buildId as string | null | undefined) ?? null,
      };
    }
    return null;
  }
  if (value.schema === 1) {
    if (
      isNonEmptyString(value.lessonId) &&
      typeof value.lessonTitle === 'string' &&
      isFiniteNumber(value.confidence) &&
      isFiniteNumber(value.associatedAtSeq)
    ) {
      return {
        schema: 1,
        lessonId: value.lessonId,
        lessonTitle: value.lessonTitle,
        confidence: value.confidence,
        associatedAtSeq: value.associatedAtSeq,
      };
    }
  }
  return null;
}

function parseDirectUnit(value: unknown): DirectSnapshotUnit | null {
  if (!isRecord(value) || value.source !== 'direct') return null;
  if (
    !isNonEmptyString(value.unitId) ||
    !isNonEmptyString(value.itemId) ||
    !isItemType(value.itemType) ||
    !isNonEmptyString(value.buildId) ||
    !isNonEmptyString(value.revisionId) ||
    typeof value.unitUpdatedAt !== 'string' ||
    !isStringOrNull(value.title) ||
    typeof value.text !== 'string' ||
    !isFiniteNumber(value.chars)
  ) {
    return null;
  }
  return {
    source: 'direct',
    unitId: value.unitId,
    itemId: value.itemId,
    itemType: value.itemType,
    buildId: value.buildId,
    revisionId: value.revisionId,
    unitUpdatedAt: value.unitUpdatedAt,
    title: value.title,
    text: value.text,
    chars: value.chars,
  };
}

function parseHttpUnit(value: unknown): HttpSnapshotUnit | null {
  if (!isRecord(value) || value.source !== 'kafuo_http') return null;
  if (
    !isNonEmptyString(value.unitId) ||
    !isStringOrNull(value.lessonId) ||
    !isStringOrNull(value.lessonTitle) ||
    !isStringOrNull(value.title) ||
    typeof value.text !== 'string' ||
    !isFiniteNumber(value.chars)
  ) {
    return null;
  }
  return {
    source: 'kafuo_http',
    unitId: value.unitId,
    lessonId: value.lessonId,
    lessonTitle: value.lessonTitle,
    title: value.title,
    text: value.text,
    chars: value.chars,
  };
}

function parseAll<T>(values: unknown, parse: (value: unknown) => T | null): T[] | null {
  if (!Array.isArray(values)) return null;
  const out: T[] = [];
  for (const value of values) {
    const parsed = parse(value);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** Accepts exactly snapshot v2 (`direct` or `kafuo_http`); any other shape is "no snapshot". */
export function parseGroundingSnapshot(raw: unknown): GroundingSnapshot | null {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isRecord(value) || value.schema !== 2) return null;
  if (!isFiniteNumber(value.setAtSeq) || !isFiniteNumber(value.lastUsedSeq)) return null;
  const keywords = parseAll(value.keywords, (k) => (typeof k === 'string' ? k : null));
  if (keywords === null) return null;
  if (value.source === 'direct') {
    const units = parseAll(value.units, parseDirectUnit);
    const items = parseAll(value.items, (item) =>
      isRecord(item) &&
      isNonEmptyString(item.itemId) &&
      isItemType(item.itemType) &&
      isStringOrNull(item.title)
        ? { itemId: item.itemId, itemType: item.itemType, title: item.title }
        : null,
    );
    if (units === null || items === null) return null;
    return {
      schema: 2,
      source: 'direct',
      units,
      items,
      keywords,
      setAtSeq: value.setAtSeq,
      lastUsedSeq: value.lastUsedSeq,
    };
  }
  if (value.source === 'kafuo_http') {
    const units = parseAll(value.units, parseHttpUnit);
    if (units === null) return null;
    return {
      schema: 2,
      source: 'kafuo_http',
      units,
      keywords,
      setAtSeq: value.setAtSeq,
      lastUsedSeq: value.lastUsedSeq,
    };
  }
  return null;
}

export function parsePendingClarification(raw: unknown): PendingClarification | null {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isRecord(value)) return null;
  if (!isFiniteNumber(value.questionSeq) || !isFiniteNumber(value.askedAtSeq)) return null;
  const candidates = parseAll(value.candidates, (candidate) =>
    isRecord(candidate) &&
    isNonEmptyString(candidate.itemId) &&
    isItemType(candidate.itemType) &&
    typeof candidate.title === 'string'
      ? { itemId: candidate.itemId, itemType: candidate.itemType, title: candidate.title }
      : null,
  );
  if (candidates === null || candidates.length === 0 || candidates.length > 3) return null;
  return { candidates, questionSeq: value.questionSeq, askedAtSeq: value.askedAtSeq };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface TutorConversation {
  id: string;
  tenantId: string;
  studentRef: string;
  subjectCode: string;
  subjectOfferingId: string;
  subjectName: string;
  academic: ConversationAcademic;
  lessonAssociation: ConversationAssociation | null;
  title: string | null;
  titleSource: TitleSource | null;
  status: ConversationStatus;
  grounding: GroundingSnapshot | null;
  /** Set by a clarification turn; cleared by the next successful turn. */
  pendingClarification: PendingClarification | null;
  contextSummary: string | null;
  summaryThroughSeq: number | null;
  lastInputTokens: number | null;
  messageCount: number;
  lastMessageAt: number | null;
  clientRequestId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TutorMessage {
  id: string;
  /** `conversation_id` for Free Chat rows, `help_session_id` for Help rows. */
  parentId: string;
  seq: number;
  role: MessageRole;
  clientMessageId: string | null;
  turnId: string;
  turnAttempt: number;
  /** Help rows only. */
  stepRef: string | null;
  text: string;
  status: MessageStatus;
  servedBy: ServedBy | null;
  groundingMode: GroundingMode | null;
  safety: Record<string, unknown> | null;
  errorCode: string | null;
  accountingComplete: boolean;
  meterReservationId: string | null;
  meterFinalized: boolean;
  /** Epoch seconds the current `generating` attempt began (null until the first). */
  generatingAt: number | null;
  /**
   * Epoch seconds of the current attempt's last liveness mark (TE-1): set when
   * its stream opens, bumped while it runs. Null before the stream opens and
   * on rows from before the column.
   */
  progressAt: number | null;
  createdAt: number;
  completedAt: number | null;
}

export interface TutorHelpSession {
  id: string;
  tenantId: string;
  versionId: string;
  stageId: string;
  sceneId: string;
  learnerKey: string;
  studentRef: string;
  subjectCode: string;
  status: HelpSessionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TurnGroundingUnit {
  unitId: string;
  lessonId?: string | null;
  /** `direct` path: the unit's Learning Item and build/revision (audit, CHAT-07). */
  itemId?: string | null;
  itemType?: LearningItemType | null;
  buildId?: string | null;
  revisionId?: string | null;
  title: string | null;
  chars: number;
  orderIndex: number;
}

/** Retrieval audit of one Free Chat turn (P7): source, outcome reason, resolution and timings. */
export interface TurnRetrievalAudit {
  source: GroundingSourceTag;
  outcomeReason?: string | null;
  /** Bounded ids, outcomes, scores, matched term types and build ids — never text (RET-07). */
  resolution?: Record<string, unknown> | null;
  embeddingModel?: string | null;
  embeddingTokens?: number | null;
  poolWaitMs?: number | null;
  resolveMs?: number | null;
  embedMs?: number | null;
  searchMs?: number | null;
  totalRetrievalMs?: number | null;
}

export interface TurnGrounding {
  turnId: string;
  conversationId: string | null;
  helpSessionId: string | null;
  mode: GroundingMode;
  assessment: Record<string, unknown>;
  units: TurnGroundingUnit[];
  totalChars: number;
  truncated: boolean;
  inputTokenEstimate: number;
  lineageStatus: LineageStatus | null;
  resolvedAttemptId: string | null;
  budgetEstimateTokens: number;
  budgetCounterKind: 'exact' | 'proxy';
  /** P7 retrieval audit; `null` columns on rows written before P7 or by Help. */
  source: GroundingSourceTag | null;
  outcomeReason: string | null;
  resolution: Record<string, unknown> | null;
  embeddingModel: string | null;
  embeddingTokens: number | null;
  poolWaitMs: number | null;
  resolveMs: number | null;
  embedMs: number | null;
  searchMs: number | null;
  totalRetrievalMs: number | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function json<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function jsonOrNull<T>(value: unknown): T | null {
  return value === null || value === undefined ? null : json<T>(value);
}

interface ConversationRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  student_ref: string;
  subject_code: string;
  subject_offering_id: string;
  subject_name: string;
  academic: unknown;
  lesson_association: unknown;
  title: string | null;
  title_source: TitleSource | null;
  status: ConversationStatus;
  grounding: unknown;
  pending_clarification: unknown;
  context_summary: string | null;
  summary_through_seq: unknown;
  last_input_tokens: number | null;
  message_count: number;
  last_message_at: number | null;
  client_request_id: string | null;
  created_at: number;
  updated_at: number;
}

const CONVERSATION_COLUMNS = `id, tenant_id, student_ref, subject_code, subject_offering_id, subject_name,
  academic, lesson_association, title, title_source, status, grounding, pending_clarification,
  context_summary, summary_through_seq, last_input_tokens, message_count, last_message_at, client_request_id,
  created_at, updated_at`;

function mapConversation(row: ConversationRow): TutorConversation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    studentRef: row.student_ref,
    subjectCode: row.subject_code,
    subjectOfferingId: row.subject_offering_id,
    subjectName: row.subject_name,
    academic: json<ConversationAcademic>(row.academic),
    lessonAssociation: parseConversationAssociation(row.lesson_association),
    title: row.title,
    titleSource: row.title_source,
    status: row.status,
    grounding: parseGroundingSnapshot(row.grounding),
    pendingClarification: parsePendingClarification(row.pending_clarification),
    contextSummary: row.context_summary,
    summaryThroughSeq: numOrNull(row.summary_through_seq),
    lastInputTokens: numOrNull(row.last_input_tokens),
    messageCount: num(row.message_count),
    lastMessageAt: numOrNull(row.last_message_at),
    clientRequestId: row.client_request_id ?? null,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  parent_id: string;
  seq: unknown;
  role: MessageRole;
  client_message_id: string | null;
  turn_id: string;
  turn_attempt: number;
  step_ref: string | null;
  text: string;
  status: MessageStatus;
  served_by: ServedBy | null;
  grounding_mode: GroundingMode | null;
  safety: unknown;
  error_code: string | null;
  accounting_complete: boolean;
  meter_reservation_id: string | null;
  meter_finalized: boolean;
  generating_at: number | null;
  progress_at: number | null;
  created_at: number;
  completed_at: number | null;
}

function mapMessage(row: MessageRow): TutorMessage {
  return {
    id: row.id,
    parentId: row.parent_id,
    seq: num(row.seq),
    role: row.role,
    clientMessageId: row.client_message_id,
    turnId: row.turn_id,
    turnAttempt: num(row.turn_attempt),
    stepRef: row.step_ref ?? null,
    text: row.text,
    status: row.status,
    servedBy: row.served_by,
    groundingMode: row.grounding_mode,
    safety: jsonOrNull<Record<string, unknown>>(row.safety),
    errorCode: row.error_code,
    accountingComplete: Boolean(row.accounting_complete),
    meterReservationId: row.meter_reservation_id,
    meterFinalized: Boolean(row.meter_finalized),
    generatingAt: numOrNull(row.generating_at),
    progressAt: numOrNull(row.progress_at),
    createdAt: num(row.created_at),
    completedAt: numOrNull(row.completed_at),
  };
}

interface HelpSessionRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  version_id: string;
  stage_id: string;
  scene_id: string;
  learner_key: string;
  student_ref: string;
  subject_code: string;
  status: HelpSessionStatus;
  created_at: number;
  updated_at: number;
}

const HELP_SESSION_COLUMNS = `id, tenant_id, version_id, stage_id, scene_id, learner_key, student_ref,
  subject_code, status, created_at, updated_at`;

function mapHelpSession(row: HelpSessionRow): TutorHelpSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    versionId: row.version_id,
    stageId: row.stage_id,
    sceneId: row.scene_id,
    learnerKey: row.learner_key,
    studentRef: row.student_ref,
    subjectCode: row.subject_code,
    status: row.status,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

interface GroundingRow extends Record<string, unknown> {
  turn_id: string;
  conversation_id: string | null;
  help_session_id: string | null;
  mode: GroundingMode;
  assessment: unknown;
  units: unknown;
  total_chars: number;
  truncated: boolean;
  input_token_estimate: number;
  lineage_status: LineageStatus | null;
  resolved_attempt_id: string | null;
  budget_estimate_tokens: number;
  budget_counter_kind: 'exact' | 'proxy';
  source: GroundingSourceTag | null;
  outcome_reason: string | null;
  resolution: unknown;
  embedding_model: string | null;
  embedding_tokens: unknown;
  pool_wait_ms: unknown;
  resolve_ms: unknown;
  embed_ms: unknown;
  search_ms: unknown;
  total_retrieval_ms: unknown;
  created_at: number;
}

function mapGrounding(row: GroundingRow): TurnGrounding {
  return {
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    helpSessionId: row.help_session_id,
    mode: row.mode,
    assessment: json<Record<string, unknown>>(row.assessment),
    units: json<TurnGroundingUnit[]>(row.units),
    totalChars: num(row.total_chars),
    truncated: Boolean(row.truncated),
    inputTokenEstimate: num(row.input_token_estimate),
    lineageStatus: row.lineage_status,
    resolvedAttemptId: row.resolved_attempt_id,
    budgetEstimateTokens: num(row.budget_estimate_tokens),
    budgetCounterKind: row.budget_counter_kind,
    source: row.source ?? null,
    outcomeReason: row.outcome_reason ?? null,
    resolution: jsonOrNull<Record<string, unknown>>(row.resolution),
    embeddingModel: row.embedding_model ?? null,
    embeddingTokens: numOrNull(row.embedding_tokens),
    poolWaitMs: numOrNull(row.pool_wait_ms),
    resolveMs: numOrNull(row.resolve_ms),
    embedMs: numOrNull(row.embed_ms),
    searchMs: numOrNull(row.search_ms),
    totalRetrievalMs: numOrNull(row.total_retrieval_ms),
    createdAt: num(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface ConversationOwner {
  tenantId: string;
  studentRef: string;
}

export interface InsertConversationInput {
  id: string;
  tenantId: string;
  studentRef: string;
  subjectCode: string;
  subjectOfferingId: string;
  subjectName: string;
  academic: ConversationAcademic;
  /** Epoch seconds. */
  now: number;
  title?: string | null;
  titleSource?: TitleSource | null;
  /** Create idempotency key (contracts §5 `clientRequestId`), unique per owner. */
  clientRequestId?: string | null;
}

/**
 * Insert a conversation. With a `clientRequestId` the insert is idempotent
 * per owner: a repeat returns `null` and the caller reads the existing row
 * with `readConversationByClientRequestId`.
 */
export async function insertConversationIdempotent(
  queryable: Queryable,
  input: InsertConversationInput,
): Promise<TutorConversation | null> {
  const result = await queryable.query<ConversationRow>(
    `INSERT INTO tutor_conversations (
       id, tenant_id, student_ref, subject_code, subject_offering_id, subject_name,
       academic, title, title_source, status, message_count, client_request_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'active', 0, $11, $10, $10)
     ON CONFLICT (tenant_id, student_ref, client_request_id) WHERE client_request_id IS NOT NULL
     DO NOTHING
     RETURNING ${CONVERSATION_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.studentRef,
      input.subjectCode,
      input.subjectOfferingId,
      input.subjectName,
      JSON.stringify(input.academic),
      input.title ?? null,
      input.titleSource ?? (input.title ? 'topic' : 'pending'),
      input.now,
      input.clientRequestId ?? null,
    ],
  );
  return result.rows[0] ? mapConversation(result.rows[0]) : null;
}

/** Plain insert (no idempotency key): the row is always created. */
export async function insertConversation(
  queryable: Queryable,
  input: Omit<InsertConversationInput, 'clientRequestId'>,
): Promise<TutorConversation> {
  const row = await insertConversationIdempotent(queryable, { ...input, clientRequestId: null });
  return row!;
}

export async function readConversationByClientRequestId(
  queryable: Queryable,
  owner: ConversationOwner,
  clientRequestId: string,
): Promise<TutorConversation | null> {
  const result = await queryable.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM tutor_conversations
      WHERE tenant_id = $1 AND student_ref = $2 AND client_request_id = $3`,
    [owner.tenantId, owner.studentRef, clientRequestId],
  );
  return result.rows[0] ? mapConversation(result.rows[0]) : null;
}

/**
 * How many OTHER conversations of this student already carry a title based
 * on the same associated item (CHAT-02: a second conversation on the same
 * item gets a topic suffix). Keyed on the full `(schema, type, id)` tuple, so
 * a rollback-only schema-1 `lessons.id` never counts as a v2
 * `learning_items.id` (P7).
 */
export async function countConversationsForLesson(
  queryable: Queryable,
  owner: ConversationOwner,
  key: AssociationKey,
  excludeConversationId: string,
): Promise<number> {
  const result = await queryable.query<{ n: unknown }>(
    `SELECT count(*)::int AS n FROM tutor_conversations
      WHERE tenant_id = $1 AND student_ref = $2 AND id <> $3
        AND lesson_association IS NOT NULL
        AND lesson_association->>'schema' = $4
        AND (CASE WHEN lesson_association->>'schema' = '2'
                  THEN lesson_association->>'learningItemType' ELSE 'lesson' END) = $5
        AND (CASE WHEN lesson_association->>'schema' = '2'
                  THEN lesson_association->>'learningItemId'
                  ELSE lesson_association->>'lessonId' END) = $6
        AND title_source IN ('lesson', 'lesson_suffix')`,
    [owner.tenantId, owner.studentRef, excludeConversationId, String(key.schema), key.type, key.id],
  );
  return num(result.rows[0]?.n ?? 0);
}

export async function readConversation(
  queryable: Queryable,
  id: string,
): Promise<TutorConversation | null> {
  const result = await queryable.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM tutor_conversations WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapConversation(result.rows[0]) : null;
}

/** Ownership read (§9.3): a conversation of another tenant/student reads as absent. */
export async function readOwnedConversation(
  queryable: Queryable,
  id: string,
  owner: ConversationOwner,
): Promise<TutorConversation | null> {
  const result = await queryable.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM tutor_conversations
      WHERE id = $1 AND tenant_id = $2 AND student_ref = $3`,
    [id, owner.tenantId, owner.studentRef],
  );
  return result.rows[0] ? mapConversation(result.rows[0]) : null;
}

export interface ListConversationsOptions extends ConversationOwner {
  status: ConversationStatus;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
  limit: number;
}

interface ConversationCursor {
  at: number;
  id: string;
}

function encodeCursor(cursor: ConversationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | null | undefined): ConversationCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<ConversationCursor>;
    if (typeof parsed.at === 'number' && typeof parsed.id === 'string') {
      return { at: parsed.at, id: parsed.id };
    }
  } catch {
    /* malformed cursor → first page */
  }
  return null;
}

/**
 * Newest-activity-first page of a student's conversations. Ordered by
 * `COALESCE(last_message_at, created_at) DESC, id DESC` so a conversation
 * with no message yet sorts by creation; the cursor is that pair, opaque to
 * the client. `limit` is clamped to 1..100.
 */
export async function listConversationsByStudent(
  queryable: Queryable,
  options: ListConversationsOptions,
): Promise<{ items: TutorConversation[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  const cursor = decodeCursor(options.cursor);
  const params: unknown[] = [options.tenantId, options.studentRef, options.status, limit + 1];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor.at, cursor.id);
    cursorClause = `AND (COALESCE(last_message_at, created_at), id) < ($5, $6)`;
  }
  const result = await queryable.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS} FROM tutor_conversations
      WHERE tenant_id = $1 AND student_ref = $2 AND status = $3 ${cursorClause}
      ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC
      LIMIT $4`,
    params,
  );
  const rows = result.rows.map(mapConversation);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last ? encodeCursor({ at: last.lastMessageAt ?? last.createdAt, id: last.id }) : null,
  };
}

/** Archive / unarchive under ownership; `null` when the owner does not hold it. */
export async function setConversationStatus(
  queryable: Queryable,
  id: string,
  owner: ConversationOwner,
  status: ConversationStatus,
  now: number,
): Promise<TutorConversation | null> {
  const result = await queryable.query<ConversationRow>(
    `UPDATE tutor_conversations
        SET status = $4, updated_at = $5
      WHERE id = $1 AND tenant_id = $2 AND student_ref = $3
      RETURNING ${CONVERSATION_COLUMNS}`,
    [id, owner.tenantId, owner.studentRef, status, now],
  );
  return result.rows[0] ? mapConversation(result.rows[0]) : null;
}

export async function archiveConversation(
  queryable: Queryable,
  id: string,
  owner: ConversationOwner,
  now: number,
): Promise<TutorConversation | null> {
  return setConversationStatus(queryable, id, owner, 'archived', now);
}

export async function unarchiveConversation(
  queryable: Queryable,
  id: string,
  owner: ConversationOwner,
  now: number,
): Promise<TutorConversation | null> {
  return setConversationStatus(queryable, id, owner, 'active', now);
}

/** Bump `message_count` / `last_message_at` after messages were inserted. */
export async function recordConversationActivity(
  queryable: Queryable,
  id: string,
  options: { messageCountDelta: number; lastMessageAt: number },
): Promise<void> {
  await queryable.query(
    `UPDATE tutor_conversations
        SET message_count = message_count + $2,
            last_message_at = GREATEST(COALESCE(last_message_at, 0), $3),
            updated_at = GREATEST(updated_at, $3)
      WHERE id = $1`,
    [id, options.messageCountDelta, options.lastMessageAt],
  );
}

export async function updateConversationTitle(
  queryable: Queryable,
  id: string,
  options: { title: string | null; titleSource: TitleSource; now: number },
): Promise<void> {
  await queryable.query(
    `UPDATE tutor_conversations SET title = $2, title_source = $3, updated_at = $4 WHERE id = $1`,
    [id, options.title, options.titleSource, options.now],
  );
}

export async function updateConversationLessonAssociation(
  queryable: Queryable,
  id: string,
  association: ConversationAssociation | null,
  now: number,
): Promise<void> {
  await queryable.query(
    `UPDATE tutor_conversations SET lesson_association = $2::jsonb, updated_at = $3 WHERE id = $1`,
    [id, association === null ? null : JSON.stringify(association), now],
  );
}

export async function updateConversationContextSummary(
  queryable: Queryable,
  id: string,
  options: { contextSummary: string | null; summaryThroughSeq: number | null; now: number },
): Promise<void> {
  await queryable.query(
    `UPDATE tutor_conversations
        SET context_summary = $2, summary_through_seq = $3, updated_at = $4
      WHERE id = $1`,
    [id, options.contextSummary, options.summaryThroughSeq, options.now],
  );
}

/** Provider-reported input tokens of the last turn (calibrates the estimator). */
export async function updateConversationLastInputTokens(
  queryable: Queryable,
  id: string,
  lastInputTokens: number | null,
): Promise<void> {
  await queryable.query(`UPDATE tutor_conversations SET last_input_tokens = $2 WHERE id = $1`, [
    id,
    lastInputTokens,
  ]);
}

export async function readGroundingSnapshot(
  queryable: Queryable,
  conversationId: string,
): Promise<GroundingSnapshot | null> {
  const result = await queryable.query<{ grounding: unknown }>(
    `SELECT grounding FROM tutor_conversations WHERE id = $1`,
    [conversationId],
  );
  return result.rows[0] ? parseGroundingSnapshot(result.rows[0].grounding) : null;
}

/** Replace (or clear with `null`) the conversation's current grounding snapshot. */
export async function writeGroundingSnapshot(
  queryable: Queryable,
  conversationId: string,
  snapshot: GroundingSnapshot | null,
  now: number,
): Promise<void> {
  await queryable.query(
    `UPDATE tutor_conversations SET grounding = $2::jsonb, updated_at = $3 WHERE id = $1`,
    [conversationId, snapshot === null ? null : JSON.stringify(snapshot), now],
  );
}

/** Set (or clear with `null`) the clarification awaiting the student's choice (P7). */
export async function updateConversationPendingClarification(
  queryable: Queryable,
  conversationId: string,
  pending: PendingClarification | null,
  now: number,
): Promise<void> {
  await queryable.query(
    `UPDATE tutor_conversations SET pending_clarification = $2::jsonb, updated_at = $3 WHERE id = $1`,
    [conversationId, pending === null ? null : JSON.stringify(pending), now],
  );
}

// ---------------------------------------------------------------------------
// Messages (shared by tutor_messages and tutor_help_messages)
// ---------------------------------------------------------------------------

interface MessageTable {
  table: 'tutor_messages' | 'tutor_help_messages';
  parentColumn: 'conversation_id' | 'help_session_id';
  parentTable: 'tutor_conversations' | 'tutor_help_sessions';
  hasStepRef: boolean;
}

const CHAT_MESSAGES: MessageTable = {
  table: 'tutor_messages',
  parentColumn: 'conversation_id',
  parentTable: 'tutor_conversations',
  hasStepRef: false,
};

const HELP_MESSAGES: MessageTable = {
  table: 'tutor_help_messages',
  parentColumn: 'help_session_id',
  parentTable: 'tutor_help_sessions',
  hasStepRef: true,
};

function messageColumns(t: MessageTable): string {
  return `id, ${t.parentColumn} AS parent_id, seq, role, client_message_id, turn_id, turn_attempt,
  ${t.hasStepRef ? 'step_ref' : 'NULL::text AS step_ref'}, text, status, served_by, grounding_mode,
  safety, error_code, accounting_complete, meter_reservation_id, meter_finalized, generating_at,
  progress_at, created_at, completed_at`;
}

/**
 * The next `seq` for a parent. Locks the parent row (`FOR UPDATE`) so two
 * turns of the same conversation inside concurrent transactions serialize
 * here rather than colliding on the unique constraint; call it inside the
 * transaction that inserts the message.
 */
async function nextSeq(queryable: Queryable, t: MessageTable, parentId: string): Promise<number> {
  await queryable.query(`SELECT id FROM ${t.parentTable} WHERE id = $1 FOR UPDATE`, [parentId]);
  const result = await queryable.query<{ next: unknown }>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ${t.table} WHERE ${t.parentColumn} = $1`,
    [parentId],
  );
  return num(result.rows[0]?.next ?? 1);
}

export interface InsertStudentMessageInput {
  id: string;
  parentId: string;
  seq: number;
  clientMessageId: string;
  turnId: string;
  text: string;
  /** Help rows only. */
  stepRef?: string | null;
  /** Epoch seconds. */
  now: number;
}

/**
 * Idempotent insert keyed by `(parent, client_message_id)`: `null` when the
 * client already submitted this message (the caller reads the existing row
 * with `…MessageByClientId` and replays / refuses per contracts §5).
 */
async function insertStudent(
  queryable: Queryable,
  t: MessageTable,
  input: InsertStudentMessageInput,
): Promise<TutorMessage | null> {
  const stepColumn = t.hasStepRef ? ', step_ref' : '';
  const stepValue = t.hasStepRef ? ', $8' : '';
  const params: unknown[] = [
    input.id,
    input.parentId,
    input.seq,
    input.clientMessageId,
    input.turnId,
    input.text,
    input.now,
  ];
  if (t.hasStepRef) params.push(input.stepRef ?? null);
  const result = await queryable.query<MessageRow>(
    `INSERT INTO ${t.table} (
       id, ${t.parentColumn}, seq, role, client_message_id, turn_id, turn_attempt, text, status,
       created_at${stepColumn}
     ) VALUES ($1, $2, $3, 'student', $4, $5, 1, $6, 'accepted', $7${stepValue})
     ON CONFLICT (${t.parentColumn}, client_message_id) WHERE client_message_id IS NOT NULL
     DO NOTHING
     RETURNING ${messageColumns(t)}`,
    params,
  );
  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

async function readByClientId(
  queryable: Queryable,
  t: MessageTable,
  parentId: string,
  clientMessageId: string,
): Promise<TutorMessage | null> {
  const result = await queryable.query<MessageRow>(
    `SELECT ${messageColumns(t)} FROM ${t.table}
      WHERE ${t.parentColumn} = $1 AND client_message_id = $2`,
    [parentId, clientMessageId],
  );
  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

/** The tutor reply of a turn (there is at most one: a failed turn has none). */
async function readTutorReplyByTurn(
  queryable: Queryable,
  t: MessageTable,
  parentId: string,
  turnId: string,
): Promise<TutorMessage | null> {
  const result = await queryable.query<MessageRow>(
    `SELECT ${messageColumns(t)} FROM ${t.table}
      WHERE ${t.parentColumn} = $1 AND turn_id = $2 AND role = 'tutor'
      ORDER BY seq DESC LIMIT 1`,
    [parentId, turnId],
  );
  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

async function readById(
  queryable: Queryable,
  t: MessageTable,
  id: string,
): Promise<TutorMessage | null> {
  const result = await queryable.query<MessageRow>(
    `SELECT ${messageColumns(t)} FROM ${t.table} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

/**
 * `accepted|failed → generating`, bumping `turn_attempt` to the given value
 * (a retry of a `failed` turn re-opens the meter under `turn_attempt + 1`,
 * §8.6). Returns the row, or `null` when the guard did not match (already
 * generating / completed — the caller answers `TURN_IN_PROGRESS` / replay).
 * `progress_at` is cleared: a new attempt has no liveness mark until its
 * stream opens (a dead attempt's last mark must not age the new one).
 */
async function markGenerating(
  queryable: Queryable,
  t: MessageTable,
  id: string,
  options: { turnAttempt: number; meterReservationId?: string | null; now?: number },
): Promise<TutorMessage | null> {
  const result = await queryable.query<MessageRow>(
    `UPDATE ${t.table}
        SET status = 'generating',
            turn_attempt = $2,
            meter_reservation_id = COALESCE($3, meter_reservation_id),
            meter_finalized = FALSE,
            error_code = NULL,
            generating_at = COALESCE($4, generating_at, created_at),
            progress_at = NULL
      WHERE id = $1 AND status IN ('accepted', 'failed')
      RETURNING ${messageColumns(t)}`,
    [id, options.turnAttempt, options.meterReservationId ?? null, options.now ?? null],
  );
  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

export interface MessageCompletionInput {
  /** Epoch seconds. */
  now: number;
  accountingComplete?: boolean;
  meterReservationId?: string | null;
}

async function markCompleted(
  queryable: Queryable,
  t: MessageTable,
  id: string,
  options: MessageCompletionInput,
): Promise<TutorMessage | null> {
  const result = await queryable.query<MessageRow>(
    `UPDATE ${t.table}
        SET status = 'completed',
            completed_at = $2,
            accounting_complete = $3,
            meter_reservation_id = COALESCE($4, meter_reservation_id),
            error_code = NULL
      WHERE id = $1 AND status <> 'completed'
      RETURNING ${messageColumns(t)}`,
    [id, options.now, options.accountingComplete ?? false, options.meterReservationId ?? null],
  );
  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

export interface MessageFailureInput extends MessageCompletionInput {
  errorCode: string;
}

async function markFailed(
  queryable: Queryable,
  t: MessageTable,
  id: string,
  options: MessageFailureInput,
): Promise<TutorMessage | null> {
  const result = await queryable.query<MessageRow>(
    `UPDATE ${t.table}
        SET status = 'failed',
            completed_at = $2,
            error_code = $3,
            accounting_complete = $4,
            meter_reservation_id = COALESCE($5, meter_reservation_id)
      WHERE id = $1 AND status <> 'completed'
      RETURNING ${messageColumns(t)}`,
    [
      id,
      options.now,
      options.errorCode,
      options.accountingComplete ?? false,
      options.meterReservationId ?? null,
    ],
  );
  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

/**
 * TE-1 liveness mark: `progress_at = now` for the given attempt while it is
 * still `generating`. A row taken over (new `turn_attempt`) or finished is
 * left alone. Returns whether a row was updated.
 */
async function markProgress(
  queryable: Queryable,
  t: MessageTable,
  id: string,
  options: { turnAttempt: number; now: number },
): Promise<boolean> {
  const result = await queryable.query<{ id: string }>(
    `UPDATE ${t.table}
        SET progress_at = $3
      WHERE id = $1 AND status = 'generating' AND turn_attempt = $2
      RETURNING id`,
    [id, options.turnAttempt, options.now],
  );
  return result.rows.length > 0;
}

/** One in-flight attempt: the row id and the `turn_attempt` this process runs. */
export interface InFlightAttempt {
  id: string;
  turnAttempt: number;
}

/**
 * TE-1 shutdown: the given attempts, if their row is still `generating` under
 * that same `turn_attempt`, become `failed` / `TURN_STALE` (the write the
 * admission path makes for a stale turn), so a retry starts
 * `turn_attempt + 1` at once. An attempt another instance already took over
 * is left alone. Returns the ids marked.
 */
async function markStale(
  queryable: Queryable,
  t: MessageTable,
  attempts: readonly InFlightAttempt[],
  options: { now: number },
): Promise<string[]> {
  if (attempts.length === 0) return [];
  const result = await queryable.query<{ id: string }>(
    `UPDATE ${t.table} AS m
        SET status = 'failed',
            completed_at = $3,
            error_code = 'TURN_STALE',
            accounting_complete = FALSE
       FROM unnest($1::text[], $2::int[]) AS a(id, turn_attempt)
      WHERE m.id = a.id AND m.turn_attempt = a.turn_attempt AND m.status = 'generating'
      RETURNING m.id`,
    [attempts.map((a) => a.id), attempts.map((a) => a.turnAttempt), options.now],
  );
  return result.rows.map((row) => row.id);
}

export interface InsertTutorMessageInput {
  id: string;
  parentId: string;
  seq: number;
  turnId: string;
  turnAttempt: number;
  text: string;
  /** `null` only for a boundary reply written without any model attempt (SAFE-02). */
  servedBy: ServedBy | null;
  groundingMode: GroundingMode | null;
  safety?: Record<string, unknown> | null;
  accountingComplete?: boolean;
  meterReservationId?: string | null;
  /** Help rows only. */
  stepRef?: string | null;
  /**
   * Free Chat rows only: epoch seconds the first `text_delta` was written
   * (student-perceived TTFT, P7). Ignored for Help rows (no such column).
   */
  firstDeltaAt?: number | null;
  /** Epoch seconds. */
  now: number;
}

/** The tutor's reply row: always `completed` (a failed turn has no tutor row). */
async function insertTutor(
  queryable: Queryable,
  t: MessageTable,
  input: InsertTutorMessageInput,
): Promise<TutorMessage> {
  // $12 is `now`; the table-specific column (step_ref for Help, first_delta_at
  // for Free Chat) is $13.
  const extraColumn = t.hasStepRef ? 'step_ref' : 'first_delta_at';
  const params: unknown[] = [
    input.id,
    input.parentId,
    input.seq,
    input.turnId,
    input.turnAttempt,
    input.text,
    input.servedBy,
    input.groundingMode,
    input.safety === undefined || input.safety === null ? null : JSON.stringify(input.safety),
    input.accountingComplete ?? false,
    input.meterReservationId ?? null,
    input.now,
  ];
  params.push(t.hasStepRef ? (input.stepRef ?? null) : (input.firstDeltaAt ?? null));
  const result = await queryable.query<MessageRow>(
    `INSERT INTO ${t.table} (
       id, ${t.parentColumn}, seq, role, client_message_id, turn_id, turn_attempt, text, status,
       served_by, grounding_mode, safety, accounting_complete, meter_reservation_id,
       created_at, completed_at, ${extraColumn}
     ) VALUES ($1, $2, $3, 'tutor', NULL, $4, $5, $6, 'completed', $7, $8, $9::jsonb, $10, $11,
       $12, $12, $13)
     RETURNING ${messageColumns(t)}`,
    params,
  );
  return mapMessage(result.rows[0]!);
}

export interface MessageWindowOptions {
  parentId: string;
  /** Return messages with `seq < beforeSeq` (absent → the newest window). */
  beforeSeq?: number | null;
  limit: number;
}

/**
 * A history window: the `limit` newest messages before `beforeSeq`, returned
 * in ascending `seq`, with `hasMore` for the page before it. `limit` is
 * clamped to 1..200.
 */
async function readWindow(
  queryable: Queryable,
  t: MessageTable,
  options: MessageWindowOptions,
): Promise<{ messages: TutorMessage[]; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit)));
  const params: unknown[] = [options.parentId, limit + 1];
  let beforeClause = '';
  if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
    params.push(options.beforeSeq);
    beforeClause = 'AND seq < $3';
  }
  const result = await queryable.query<MessageRow>(
    `SELECT ${messageColumns(t)} FROM ${t.table}
      WHERE ${t.parentColumn} = $1 ${beforeClause}
      ORDER BY seq DESC
      LIMIT $2`,
    params,
  );
  const rows = result.rows.map(mapMessage);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  page.reverse();
  return { messages: page, hasMore };
}

// --- Free Chat wrappers ------------------------------------------------------

export function nextMessageSeq(queryable: Queryable, conversationId: string): Promise<number> {
  return nextSeq(queryable, CHAT_MESSAGES, conversationId);
}

export function insertStudentMessage(
  queryable: Queryable,
  input: InsertStudentMessageInput,
): Promise<TutorMessage | null> {
  return insertStudent(queryable, CHAT_MESSAGES, input);
}

export function readMessageByClientId(
  queryable: Queryable,
  conversationId: string,
  clientMessageId: string,
): Promise<TutorMessage | null> {
  return readByClientId(queryable, CHAT_MESSAGES, conversationId, clientMessageId);
}

export function readMessage(queryable: Queryable, id: string): Promise<TutorMessage | null> {
  return readById(queryable, CHAT_MESSAGES, id);
}

export function markMessageGenerating(
  queryable: Queryable,
  id: string,
  options: { turnAttempt: number; meterReservationId?: string | null; now?: number },
): Promise<TutorMessage | null> {
  return markGenerating(queryable, CHAT_MESSAGES, id, options);
}

export function readTutorReplyByTurnId(
  queryable: Queryable,
  conversationId: string,
  turnId: string,
): Promise<TutorMessage | null> {
  return readTutorReplyByTurn(queryable, CHAT_MESSAGES, conversationId, turnId);
}

export function markMessageCompleted(
  queryable: Queryable,
  id: string,
  options: MessageCompletionInput,
): Promise<TutorMessage | null> {
  return markCompleted(queryable, CHAT_MESSAGES, id, options);
}

export function markMessageFailed(
  queryable: Queryable,
  id: string,
  options: MessageFailureInput,
): Promise<TutorMessage | null> {
  return markFailed(queryable, CHAT_MESSAGES, id, options);
}

export function markMessageProgress(
  queryable: Queryable,
  id: string,
  options: { turnAttempt: number; now: number },
): Promise<boolean> {
  return markProgress(queryable, CHAT_MESSAGES, id, options);
}

export function markMessagesStale(
  queryable: Queryable,
  attempts: readonly InFlightAttempt[],
  options: { now: number },
): Promise<string[]> {
  return markStale(queryable, CHAT_MESSAGES, attempts, options);
}

export function insertTutorMessage(
  queryable: Queryable,
  input: InsertTutorMessageInput,
): Promise<TutorMessage> {
  return insertTutor(queryable, CHAT_MESSAGES, input);
}

export function readMessagesBySeq(
  queryable: Queryable,
  options: MessageWindowOptions,
): Promise<{ messages: TutorMessage[]; hasMore: boolean }> {
  return readWindow(queryable, CHAT_MESSAGES, options);
}

// --- Help wrappers -----------------------------------------------------------

export function nextHelpMessageSeq(queryable: Queryable, helpSessionId: string): Promise<number> {
  return nextSeq(queryable, HELP_MESSAGES, helpSessionId);
}

export function insertHelpStudentMessage(
  queryable: Queryable,
  input: InsertStudentMessageInput,
): Promise<TutorMessage | null> {
  return insertStudent(queryable, HELP_MESSAGES, input);
}

export function readHelpMessageByClientId(
  queryable: Queryable,
  helpSessionId: string,
  clientMessageId: string,
): Promise<TutorMessage | null> {
  return readByClientId(queryable, HELP_MESSAGES, helpSessionId, clientMessageId);
}

export function readHelpMessage(queryable: Queryable, id: string): Promise<TutorMessage | null> {
  return readById(queryable, HELP_MESSAGES, id);
}

export function markHelpMessageGenerating(
  queryable: Queryable,
  id: string,
  options: { turnAttempt: number; meterReservationId?: string | null; now?: number },
): Promise<TutorMessage | null> {
  return markGenerating(queryable, HELP_MESSAGES, id, options);
}

export function readHelpTutorReplyByTurnId(
  queryable: Queryable,
  helpSessionId: string,
  turnId: string,
): Promise<TutorMessage | null> {
  return readTutorReplyByTurn(queryable, HELP_MESSAGES, helpSessionId, turnId);
}

export function markHelpMessageCompleted(
  queryable: Queryable,
  id: string,
  options: MessageCompletionInput,
): Promise<TutorMessage | null> {
  return markCompleted(queryable, HELP_MESSAGES, id, options);
}

export function markHelpMessageFailed(
  queryable: Queryable,
  id: string,
  options: MessageFailureInput,
): Promise<TutorMessage | null> {
  return markFailed(queryable, HELP_MESSAGES, id, options);
}

export function markHelpMessageProgress(
  queryable: Queryable,
  id: string,
  options: { turnAttempt: number; now: number },
): Promise<boolean> {
  return markProgress(queryable, HELP_MESSAGES, id, options);
}

export function markHelpMessagesStale(
  queryable: Queryable,
  attempts: readonly InFlightAttempt[],
  options: { now: number },
): Promise<string[]> {
  return markStale(queryable, HELP_MESSAGES, attempts, options);
}

export function insertHelpTutorMessage(
  queryable: Queryable,
  input: InsertTutorMessageInput,
): Promise<TutorMessage> {
  return insertTutor(queryable, HELP_MESSAGES, input);
}

export function readHelpMessagesBySeq(
  queryable: Queryable,
  options: MessageWindowOptions,
): Promise<{ messages: TutorMessage[]; hasMore: boolean }> {
  return readWindow(queryable, HELP_MESSAGES, options);
}

/**
 * Flag every message row of a reservation `meter_finalized` once Kafuo
 * acknowledged the finalize (§8.6). Informational: the outbox row is the
 * record of delivery; this is what lets a conversation read show it.
 */
export async function markMessagesMeterFinalized(
  queryable: Queryable,
  meterReservationId: string,
): Promise<number> {
  let updated = 0;
  for (const table of ['tutor_messages', 'tutor_help_messages'] as const) {
    const result = await queryable.query<{ id: string }>(
      `UPDATE ${table} SET meter_finalized = TRUE
        WHERE meter_reservation_id = $1 AND meter_finalized = FALSE
        RETURNING id`,
      [meterReservationId],
    );
    updated += result.rows.length;
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Help sessions
// ---------------------------------------------------------------------------

export interface HelpSessionAnchor {
  versionId: string;
  stageId: string;
  sceneId: string;
  learnerKey: string;
}

export interface UpsertHelpSessionInput extends HelpSessionAnchor {
  /** Used only when the anchor has no session yet. */
  id: string;
  tenantId: string;
  studentRef: string;
  subjectCode: string;
  /** Epoch seconds. */
  now: number;
}

/**
 * One session per `(version, stage, scene, learner)` anchor: inserts it, or
 * returns the existing one with `updated_at` touched. The stored id wins
 * over `input.id` on the existing path, so two concurrent first turns on
 * the same anchor converge on one session.
 */
export async function upsertHelpSession(
  queryable: Queryable,
  input: UpsertHelpSessionInput,
): Promise<TutorHelpSession> {
  const result = await queryable.query<HelpSessionRow>(
    `INSERT INTO tutor_help_sessions (
       id, tenant_id, version_id, stage_id, scene_id, learner_key, student_ref, subject_code,
       status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $9)
     ON CONFLICT ON CONSTRAINT ths_anchor_unique
     DO UPDATE SET updated_at = EXCLUDED.updated_at
     RETURNING ${HELP_SESSION_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.versionId,
      input.stageId,
      input.sceneId,
      input.learnerKey,
      input.studentRef,
      input.subjectCode,
      input.now,
    ],
  );
  return mapHelpSession(result.rows[0]!);
}

export async function readHelpSession(
  queryable: Queryable,
  id: string,
): Promise<TutorHelpSession | null> {
  const result = await queryable.query<HelpSessionRow>(
    `SELECT ${HELP_SESSION_COLUMNS} FROM tutor_help_sessions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapHelpSession(result.rows[0]) : null;
}

export async function readHelpSessionByAnchor(
  queryable: Queryable,
  anchor: HelpSessionAnchor,
): Promise<TutorHelpSession | null> {
  const result = await queryable.query<HelpSessionRow>(
    `SELECT ${HELP_SESSION_COLUMNS} FROM tutor_help_sessions
      WHERE version_id = $1 AND stage_id = $2 AND scene_id = $3 AND learner_key = $4`,
    [anchor.versionId, anchor.stageId, anchor.sceneId, anchor.learnerKey],
  );
  return result.rows[0] ? mapHelpSession(result.rows[0]) : null;
}

export async function setHelpSessionStatus(
  queryable: Queryable,
  id: string,
  status: HelpSessionStatus,
  now: number,
): Promise<TutorHelpSession | null> {
  const result = await queryable.query<HelpSessionRow>(
    `UPDATE tutor_help_sessions SET status = $2, updated_at = $3 WHERE id = $1
     RETURNING ${HELP_SESSION_COLUMNS}`,
    [id, status, now],
  );
  return result.rows[0] ? mapHelpSession(result.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Turn groundings (§8.2/§8.3 audit row per turn)
// ---------------------------------------------------------------------------

export interface InsertTurnGroundingInput {
  turnId: string;
  conversationId?: string | null;
  helpSessionId?: string | null;
  mode: GroundingMode;
  assessment: Record<string, unknown>;
  units: TurnGroundingUnit[];
  totalChars: number;
  truncated?: boolean;
  inputTokenEstimate: number;
  lineageStatus?: LineageStatus | null;
  resolvedAttemptId?: string | null;
  budgetEstimateTokens: number;
  budgetCounterKind: 'exact' | 'proxy';
  /** Free Chat (P7): retrieval source, outcome reason, resolution and timings. */
  retrieval?: TurnRetrievalAudit | null;
  /** Epoch seconds. */
  now: number;
}

/** Idempotent per `turn_id`: a retried attempt re-records its grounding. */
export async function insertTurnGrounding(
  queryable: Queryable,
  input: InsertTurnGroundingInput,
): Promise<TurnGrounding> {
  const result = await queryable.query<GroundingRow>(
    `INSERT INTO tutor_turn_groundings (
       turn_id, conversation_id, help_session_id, mode, assessment, units, total_chars, truncated,
       input_token_estimate, lineage_status, resolved_attempt_id, budget_estimate_tokens,
       budget_counter_kind, created_at, source, outcome_reason, resolution, embedding_model,
       embedding_tokens, pool_wait_ms, resolve_ms, embed_ms, search_ms, total_retrieval_ms
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17::jsonb, $18, $19, $20, $21, $22, $23, $24)
     ON CONFLICT (turn_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       assessment = EXCLUDED.assessment,
       units = EXCLUDED.units,
       total_chars = EXCLUDED.total_chars,
       truncated = EXCLUDED.truncated,
       input_token_estimate = EXCLUDED.input_token_estimate,
       lineage_status = EXCLUDED.lineage_status,
       resolved_attempt_id = EXCLUDED.resolved_attempt_id,
       budget_estimate_tokens = EXCLUDED.budget_estimate_tokens,
       budget_counter_kind = EXCLUDED.budget_counter_kind,
       created_at = EXCLUDED.created_at,
       source = EXCLUDED.source,
       outcome_reason = EXCLUDED.outcome_reason,
       resolution = EXCLUDED.resolution,
       embedding_model = EXCLUDED.embedding_model,
       embedding_tokens = EXCLUDED.embedding_tokens,
       pool_wait_ms = EXCLUDED.pool_wait_ms,
       resolve_ms = EXCLUDED.resolve_ms,
       embed_ms = EXCLUDED.embed_ms,
       search_ms = EXCLUDED.search_ms,
       total_retrieval_ms = EXCLUDED.total_retrieval_ms
     RETURNING *`,
    [
      input.turnId,
      input.conversationId ?? null,
      input.helpSessionId ?? null,
      input.mode,
      JSON.stringify(input.assessment),
      JSON.stringify(input.units),
      input.totalChars,
      input.truncated ?? false,
      input.inputTokenEstimate,
      input.lineageStatus ?? null,
      input.resolvedAttemptId ?? null,
      input.budgetEstimateTokens,
      input.budgetCounterKind,
      input.now,
      input.retrieval?.source ?? null,
      input.retrieval?.outcomeReason ?? null,
      input.retrieval?.resolution ? JSON.stringify(input.retrieval.resolution) : null,
      input.retrieval?.embeddingModel ?? null,
      input.retrieval?.embeddingTokens ?? null,
      input.retrieval?.poolWaitMs ?? null,
      input.retrieval?.resolveMs ?? null,
      input.retrieval?.embedMs ?? null,
      input.retrieval?.searchMs ?? null,
      input.retrieval?.totalRetrievalMs ?? null,
    ],
  );
  return mapGrounding(result.rows[0]!);
}

export async function readTurnGrounding(
  queryable: Queryable,
  turnId: string,
): Promise<TurnGrounding | null> {
  const result = await queryable.query<GroundingRow>(
    `SELECT * FROM tutor_turn_groundings WHERE turn_id = $1`,
    [turnId],
  );
  return result.rows[0] ? mapGrounding(result.rows[0]) : null;
}
