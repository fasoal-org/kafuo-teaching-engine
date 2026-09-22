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
  grounding_mode TEXT CHECK (grounding_mode IN ('none','reuse','retrieved','scene','insufficient')),
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
  mode TEXT NOT NULL CHECK (mode IN ('none','reuse','retrieved','scene','insufficient')),
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

export const TUTOR_RUNTIME_SCHEMA = `${TUTOR_RUNTIME_TABLES}
${TUTOR_RUNTIME_INDEXES}`;

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
}

// ---------------------------------------------------------------------------
// Domain shapes
// ---------------------------------------------------------------------------

export type ConversationStatus = 'active' | 'archived';
export type TitleSource = 'topic' | 'lesson' | 'lesson_suffix' | 'fallback' | 'pending';
export type MessageRole = 'student' | 'tutor';
export type MessageStatus = 'accepted' | 'generating' | 'completed' | 'failed';
export type ServedBy = 'primary' | 'fallback';
export type GroundingMode = 'none' | 'reuse' | 'retrieved' | 'scene' | 'insufficient';
export type LineageStatus = 'own_attempt' | 'predecessor_attempt' | 'partial' | 'unavailable';
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

export interface LessonAssociation {
  learningItemType: string;
  learningItemId: string;
  lessonTitle: string;
  confidence: number;
  associatedAtSeq: number;
}

export interface GroundingSnapshotUnit {
  unitId: string;
  lessonId?: string | null;
  lessonTitle?: string | null;
  title: string | null;
  text: string;
  chars: number;
}

/** The conversation's current valid grounding (§8.2 `reuse`). */
export interface GroundingSnapshot {
  units: GroundingSnapshotUnit[];
  keywords: string[];
  setAtSeq: number;
  lastUsedSeq: number;
}

export interface TutorConversation {
  id: string;
  tenantId: string;
  studentRef: string;
  subjectCode: string;
  subjectOfferingId: string;
  subjectName: string;
  academic: ConversationAcademic;
  lessonAssociation: LessonAssociation | null;
  title: string | null;
  titleSource: TitleSource | null;
  status: ConversationStatus;
  grounding: GroundingSnapshot | null;
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
  title: string | null;
  chars: number;
  orderIndex: number;
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
  academic, lesson_association, title, title_source, status, grounding, context_summary,
  summary_through_seq, last_input_tokens, message_count, last_message_at, client_request_id,
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
    lessonAssociation: jsonOrNull<LessonAssociation>(row.lesson_association),
    title: row.title,
    titleSource: row.title_source,
    status: row.status,
    grounding: jsonOrNull<GroundingSnapshot>(row.grounding),
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
 * on the given lesson (CHAT-02: a second conversation on the same lesson gets
 * a topic suffix).
 */
export async function countConversationsForLesson(
  queryable: Queryable,
  owner: ConversationOwner,
  learningItemId: string,
  excludeConversationId: string,
): Promise<number> {
  const result = await queryable.query<{ n: unknown }>(
    `SELECT count(*)::int AS n FROM tutor_conversations
      WHERE tenant_id = $1 AND student_ref = $2 AND id <> $3
        AND lesson_association IS NOT NULL
        AND lesson_association->>'learningItemId' = $4
        AND title_source IN ('lesson', 'lesson_suffix')`,
    [owner.tenantId, owner.studentRef, excludeConversationId, learningItemId],
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
  association: LessonAssociation | null,
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
  return result.rows[0] ? jsonOrNull<GroundingSnapshot>(result.rows[0].grounding) : null;
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
  created_at, completed_at`;
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
            generating_at = COALESCE($4, generating_at, created_at)
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
  /** Epoch seconds. */
  now: number;
}

/** The tutor's reply row: always `completed` (a failed turn has no tutor row). */
async function insertTutor(
  queryable: Queryable,
  t: MessageTable,
  input: InsertTutorMessageInput,
): Promise<TutorMessage> {
  const stepColumn = t.hasStepRef ? ', step_ref' : '';
  // $12 is `now`; step_ref, when present, is $13.
  const stepValue = t.hasStepRef ? ', $13' : '';
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
  if (t.hasStepRef) params.push(input.stepRef ?? null);
  const result = await queryable.query<MessageRow>(
    `INSERT INTO ${t.table} (
       id, ${t.parentColumn}, seq, role, client_message_id, turn_id, turn_attempt, text, status,
       served_by, grounding_mode, safety, accounting_complete, meter_reservation_id,
       created_at, completed_at${stepColumn}
     ) VALUES ($1, $2, $3, 'tutor', NULL, $4, $5, $6, 'completed', $7, $8, $9::jsonb, $10, $11,
       $12, $12${stepValue})
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
       budget_counter_kind, created_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)
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
       created_at = EXCLUDED.created_at
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
