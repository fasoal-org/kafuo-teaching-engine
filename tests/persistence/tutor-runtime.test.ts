import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveConversation,
  ensureTutorRuntimeSchema,
  insertConversation,
  insertHelpStudentMessage,
  insertHelpTutorMessage,
  insertStudentMessage,
  insertTurnGrounding,
  insertTutorMessage,
  listConversationsByStudent,
  markMessageCompleted,
  markMessageFailed,
  markMessageGenerating,
  markMessagesMeterFinalized,
  nextHelpMessageSeq,
  nextMessageSeq,
  readConversation,
  readGroundingSnapshot,
  readHelpMessagesBySeq,
  readHelpSessionByAnchor,
  readMessageByClientId,
  readMessagesBySeq,
  readOwnedConversation,
  readTurnGrounding,
  recordConversationActivity,
  unarchiveConversation,
  upsertHelpSession,
  parseConversationAssociation,
  parseGroundingSnapshot,
  parsePendingClarification,
  updateConversationPendingClarification,
  writeGroundingSnapshot,
  type GroundingSnapshot,
  type InsertConversationInput,
} from '@/lib/persistence/tutor-runtime';

/**
 * Student runtime persistence (Kafuo R1 plan §5.1). PGlite is real Postgres,
 * so the unique constraints, partial unique indexes, CHECKs and row locks
 * are exercised for real. `teaching_package_versions` is stubbed with just
 * its primary key: the FK is what matters here, not the package schema.
 */

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) {
    return this.db.query<Row>(text, params);
  }
  async connect() {
    return { query: (t: string, p?: unknown[]) => this.db.query(t, p), release() {} };
  }
  async end() {
    await this.db.close();
  }
}

const NOW = 1_800_000_000; // epoch seconds
const OWNER = { tenantId: '1', studentRef: 'abcdefghijklmnopqrstuvwx' };

function conversation(overrides: Partial<InsertConversationInput> = {}): InsertConversationInput {
  return {
    id: overrides.id ?? `conv-${Math.random().toString(36).slice(2)}`,
    tenantId: OWNER.tenantId,
    studentRef: OWNER.studentRef,
    subjectCode: 'MATH',
    subjectOfferingId: '10',
    subjectName: 'الرياضيات',
    academic: {
      curriculumId: '27',
      curriculumName: 'National',
      curriculumVersionLabel: '2026',
      gradeLabel: 'Grade 9',
      academicLanguage: 'ar',
    },
    now: NOW,
    ...overrides,
  };
}

describe('tutor runtime persistence', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await pool.query(`CREATE TABLE teaching_package_versions (id TEXT PRIMARY KEY)`);
    await pool.query(`INSERT INTO teaching_package_versions (id) VALUES ('tpv-1')`);
    await ensureTutorRuntimeSchema(pool);
    // Idempotent: a second boot against an existing schema is a no-op.
    await ensureTutorRuntimeSchema(pool);
  });

  afterEach(async () => {
    await pool.end();
  });

  it('creates every table with the Revision-4 additions', async () => {
    const columns = async (table: string) =>
      (
        await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
          [table],
        )
      ).rows.map((r) => r.column_name);
    for (const table of ['tutor_messages', 'tutor_help_messages']) {
      const cols = await columns(table);
      expect(cols).toEqual(
        expect.arrayContaining(['accounting_complete', 'meter_reservation_id', 'meter_finalized', 'turn_attempt']),
      );
    }
    expect(await columns('tutor_help_messages')).toContain('step_ref');
    expect(await columns('tutor_turn_groundings')).toEqual(
      expect.arrayContaining([
        'lineage_status',
        'resolved_attempt_id',
        'budget_estimate_tokens',
        'budget_counter_kind',
        'input_token_estimate',
      ]),
    );
    expect(await columns('tutor_help_sessions')).toContain('learner_key');
  });

  it('inserts and reads a conversation; ownership mismatch reads as absent', async () => {
    const created = await insertConversation(pool, conversation({ id: 'conv-1' }));
    expect(created).toMatchObject({
      id: 'conv-1',
      status: 'active',
      titleSource: 'pending',
      title: null,
      messageCount: 0,
      lastMessageAt: null,
      academic: { academicLanguage: 'ar', curriculumId: '27' },
      createdAt: NOW,
    });
    expect(await readConversation(pool, 'conv-1')).toEqual(created);
    expect(await readOwnedConversation(pool, 'conv-1', OWNER)).toEqual(created);
    expect(await readOwnedConversation(pool, 'conv-1', { ...OWNER, studentRef: 'zzzzzzzzzzzzzzzzzzzzzzzz' })).toBeNull();
    expect(await readOwnedConversation(pool, 'conv-1', { ...OWNER, tenantId: '2' })).toBeNull();
  });

  it('client message ids are unique per conversation: the second insert is a no-op', async () => {
    await insertConversation(pool, conversation({ id: 'conv-1' }));
    await insertConversation(pool, conversation({ id: 'conv-2' }));
    const first = await insertStudentMessage(pool, {
      id: 'm-1',
      parentId: 'conv-1',
      seq: await nextMessageSeq(pool, 'conv-1'),
      clientMessageId: 'cm-a',
      turnId: 'turn-1',
      text: 'hello',
      now: NOW,
    });
    expect(first).toMatchObject({ id: 'm-1', seq: 1, status: 'accepted', turnAttempt: 1, role: 'student' });
    const duplicate = await insertStudentMessage(pool, {
      id: 'm-1-dup',
      parentId: 'conv-1',
      seq: 2,
      clientMessageId: 'cm-a',
      turnId: 'turn-1',
      text: 'hello again',
      now: NOW + 1,
    });
    expect(duplicate).toBeNull();
    expect((await readMessageByClientId(pool, 'conv-1', 'cm-a'))!.id).toBe('m-1');
    // The same client id in ANOTHER conversation is a different message.
    const other = await insertStudentMessage(pool, {
      id: 'm-2',
      parentId: 'conv-2',
      seq: 1,
      clientMessageId: 'cm-a',
      turnId: 'turn-2',
      text: 'hello',
      now: NOW,
    });
    expect(other).not.toBeNull();
  });

  it('seq is unique per conversation and nextMessageSeq is monotonic', async () => {
    await insertConversation(pool, conversation({ id: 'conv-1' }));
    expect(await nextMessageSeq(pool, 'conv-1')).toBe(1);
    await insertStudentMessage(pool, {
      id: 'm-1',
      parentId: 'conv-1',
      seq: 1,
      clientMessageId: 'cm-1',
      turnId: 'turn-1',
      text: 'a',
      now: NOW,
    });
    await insertTutorMessage(pool, {
      id: 'm-2',
      parentId: 'conv-1',
      seq: 2,
      turnId: 'turn-1',
      turnAttempt: 1,
      text: 'b',
      servedBy: 'primary',
      groundingMode: 'none',
      now: NOW + 1,
    });
    expect(await nextMessageSeq(pool, 'conv-1')).toBe(3);
    await expect(
      insertTutorMessage(pool, {
        id: 'm-3',
        parentId: 'conv-1',
        seq: 2,
        turnId: 'turn-1',
        turnAttempt: 1,
        text: 'c',
        servedBy: 'fallback',
        groundingMode: 'none',
        now: NOW + 2,
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('turn lifecycle: generating (attempt bump) → completed / failed, and the meter flag', async () => {
    await insertConversation(pool, conversation({ id: 'conv-1' }));
    const message = (await insertStudentMessage(pool, {
      id: 'm-1',
      parentId: 'conv-1',
      seq: 1,
      clientMessageId: 'cm-1',
      turnId: 'turn-1',
      text: 'a',
      now: NOW,
    }))!;
    const generating = await markMessageGenerating(pool, message.id, { turnAttempt: 1 });
    expect(generating).toMatchObject({ status: 'generating', turnAttempt: 1 });
    // A second worker cannot re-enter generating.
    expect(await markMessageGenerating(pool, message.id, { turnAttempt: 2 })).toBeNull();

    const failed = await markMessageFailed(pool, message.id, {
      now: NOW + 5,
      errorCode: 'TEACHING_MODEL_UNAVAILABLE',
      meterReservationId: 'res-1',
    });
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'TEACHING_MODEL_UNAVAILABLE',
      meterReservationId: 'res-1',
      meterFinalized: false,
      completedAt: NOW + 5,
    });
    // Retry: failed → generating under attempt 2 with a fresh reservation.
    const retry = await markMessageGenerating(pool, message.id, {
      turnAttempt: 2,
      meterReservationId: 'res-2',
    });
    expect(retry).toMatchObject({ status: 'generating', turnAttempt: 2, meterReservationId: 'res-2', errorCode: null });
    const completed = await markMessageCompleted(pool, message.id, { now: NOW + 9, accountingComplete: true });
    expect(completed).toMatchObject({ status: 'completed', accountingComplete: true, meterReservationId: 'res-2' });
    // Completed is terminal.
    expect(await markMessageFailed(pool, message.id, { now: NOW + 10, errorCode: 'X' })).toBeNull();

    await insertTutorMessage(pool, {
      id: 'm-2',
      parentId: 'conv-1',
      seq: 2,
      turnId: 'turn-1',
      turnAttempt: 2,
      text: 'reply',
      servedBy: 'fallback',
      groundingMode: 'retrieved',
      safety: { triggered: false },
      meterReservationId: 'res-2',
      accountingComplete: true,
      now: NOW + 9,
    });
    expect(await markMessagesMeterFinalized(pool, 'res-2')).toBe(2);
    expect(await markMessagesMeterFinalized(pool, 'res-2')).toBe(0);
    const { messages } = await readMessagesBySeq(pool, { parentId: 'conv-1', limit: 50 });
    expect(messages.map((m) => [m.seq, m.role, m.meterFinalized, m.servedBy])).toEqual([
      [1, 'student', true, null],
      [2, 'tutor', true, 'fallback'],
    ]);
    expect(messages[1]!.safety).toEqual({ triggered: false });
  });

  it('history windows page backwards by seq and come back ascending', async () => {
    await insertConversation(pool, conversation({ id: 'conv-1' }));
    for (let i = 1; i <= 7; i += 1) {
      await insertStudentMessage(pool, {
        id: `m-${i}`,
        parentId: 'conv-1',
        seq: i,
        clientMessageId: `cm-${i}`,
        turnId: `turn-${i}`,
        text: `t${i}`,
        now: NOW + i,
      });
    }
    const newest = await readMessagesBySeq(pool, { parentId: 'conv-1', limit: 3 });
    expect(newest.messages.map((m) => m.seq)).toEqual([5, 6, 7]);
    expect(newest.hasMore).toBe(true);
    const older = await readMessagesBySeq(pool, { parentId: 'conv-1', beforeSeq: 5, limit: 3 });
    expect(older.messages.map((m) => m.seq)).toEqual([2, 3, 4]);
    expect(older.hasMore).toBe(true);
    const oldest = await readMessagesBySeq(pool, { parentId: 'conv-1', beforeSeq: 2, limit: 3 });
    expect(oldest.messages.map((m) => m.seq)).toEqual([1]);
    expect(oldest.hasMore).toBe(false);
  });

  it('lists a student’s conversations newest-activity-first with an opaque cursor', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await insertConversation(pool, conversation({ id: `conv-${i}`, now: NOW + i }));
    }
    // conv-2 gets a message later than every creation: it sorts first.
    await recordConversationActivity(pool, 'conv-2', { messageCountDelta: 2, lastMessageAt: NOW + 100 });
    // Another student and an archived one never appear in this list.
    await insertConversation(pool, conversation({ id: 'conv-other', studentRef: 'zzzzzzzzzzzzzzzzzzzzzzzz' }));
    await archiveConversation(pool, 'conv-4', OWNER, NOW + 200);

    const page1 = await listConversationsByStudent(pool, { ...OWNER, status: 'active', limit: 2 });
    expect(page1.items.map((c) => c.id)).toEqual(['conv-2', 'conv-5']);
    expect(page1.items[0]!.messageCount).toBe(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await listConversationsByStudent(pool, {
      ...OWNER,
      status: 'active',
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((c) => c.id)).toEqual(['conv-3', 'conv-1']);
    expect(page2.nextCursor).toBeNull();
    const garbage = await listConversationsByStudent(pool, { ...OWNER, status: 'active', limit: 10, cursor: '!!' });
    expect(garbage.items).toHaveLength(4);

    const archived = await listConversationsByStudent(pool, { ...OWNER, status: 'archived', limit: 10 });
    expect(archived.items.map((c) => c.id)).toEqual(['conv-4']);
    expect(await unarchiveConversation(pool, 'conv-4', OWNER, NOW + 300)).toMatchObject({ status: 'active' });
    // Ownership guards the archive path too.
    expect(await archiveConversation(pool, 'conv-1', { ...OWNER, tenantId: '9' }, NOW)).toBeNull();
  });

  it('grounding snapshot v2 round-trips (kafuo_http and direct) and clears', async () => {
    await insertConversation(pool, conversation({ id: 'conv-1' }));
    expect(await readGroundingSnapshot(pool, 'conv-1')).toBeNull();
    const httpSnapshot: GroundingSnapshot = {
      schema: 2,
      source: 'kafuo_http',
      units: [{ source: 'kafuo_http', unitId: 'u-1', lessonId: 'l-1', lessonTitle: 'Fractions', title: 'Intro', text: '…', chars: 1 }],
      keywords: ['fractions'],
      setAtSeq: 3,
      lastUsedSeq: 3,
    };
    await writeGroundingSnapshot(pool, 'conv-1', httpSnapshot, NOW + 1);
    expect(await readGroundingSnapshot(pool, 'conv-1')).toEqual(httpSnapshot);
    const directSnapshot: GroundingSnapshot = {
      schema: 2,
      source: 'direct',
      units: [
        {
          source: 'direct',
          unitId: '3279',
          itemId: '155',
          itemType: 'LESSON',
          buildId: '41',
          revisionId: '90',
          unitUpdatedAt: '2026-09-30T10:00:00+00:00',
          title: 'المفردات',
          text: 'المثال المضاد',
          chars: 13,
        },
      ],
      items: [{ itemId: '155', itemType: 'LESSON', title: 'التبرير والبرهان' }],
      keywords: ['مثال', 'مضاد'],
      setAtSeq: 5,
      lastUsedSeq: 7,
    };
    await writeGroundingSnapshot(pool, 'conv-1', directSnapshot, NOW + 2);
    expect(await readGroundingSnapshot(pool, 'conv-1')).toEqual(directSnapshot);
    await writeGroundingSnapshot(pool, 'conv-1', null, NOW + 3);
    expect(await readGroundingSnapshot(pool, 'conv-1')).toBeNull();
  });

  it('help sessions are unique per anchor and their messages carry step_ref', async () => {
    const anchor = { versionId: 'tpv-1', stageId: 'stage-1', sceneId: 'scene-1', learnerKey: 'tp:abc' };
    const first = await upsertHelpSession(pool, {
      ...anchor,
      id: 'hs-1',
      tenantId: '1',
      studentRef: OWNER.studentRef,
      subjectCode: 'PHYSICS',
      now: NOW,
    });
    expect(first).toMatchObject({ id: 'hs-1', status: 'active', createdAt: NOW, updatedAt: NOW });
    const again = await upsertHelpSession(pool, {
      ...anchor,
      id: 'hs-2',
      tenantId: '1',
      studentRef: OWNER.studentRef,
      subjectCode: 'PHYSICS',
      now: NOW + 5,
    });
    expect(again.id).toBe('hs-1');
    expect(again.updatedAt).toBe(NOW + 5);
    expect((await readHelpSessionByAnchor(pool, anchor))!.id).toBe('hs-1');
    expect(await readHelpSessionByAnchor(pool, { ...anchor, sceneId: 'scene-2' })).toBeNull();
    // The version must exist (FK).
    await expect(
      upsertHelpSession(pool, {
        ...anchor,
        versionId: 'tpv-missing',
        id: 'hs-3',
        tenantId: '1',
        studentRef: OWNER.studentRef,
        subjectCode: 'PHYSICS',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: '23503' });

    const seq = await nextHelpMessageSeq(pool, 'hs-1');
    const student = await insertHelpStudentMessage(pool, {
      id: 'hm-1',
      parentId: 'hs-1',
      seq,
      clientMessageId: 'cm-1',
      turnId: 'help-turn-1',
      text: 'why?',
      stepRef: 'step-2',
      now: NOW,
    });
    expect(student).toMatchObject({ seq: 1, stepRef: 'step-2' });
    expect(
      await insertHelpStudentMessage(pool, {
        id: 'hm-dup',
        parentId: 'hs-1',
        seq: 2,
        clientMessageId: 'cm-1',
        turnId: 'help-turn-1',
        text: 'why?',
        now: NOW,
      }),
    ).toBeNull();
    await insertHelpTutorMessage(pool, {
      id: 'hm-2',
      parentId: 'hs-1',
      seq: 2,
      turnId: 'help-turn-1',
      turnAttempt: 1,
      text: 'because',
      servedBy: 'primary',
      groundingMode: 'scene',
      stepRef: 'step-2',
      now: NOW + 1,
    });
    const { messages } = await readHelpMessagesBySeq(pool, { parentId: 'hs-1', limit: 10 });
    expect(messages.map((m) => [m.seq, m.role, m.stepRef, m.groundingMode])).toEqual([
      [1, 'student', 'step-2', null],
      [2, 'tutor', 'step-2', 'scene'],
    ]);
  });

  it('turn groundings persist the assessment, lineage and budget columns', async () => {
    const row = await insertTurnGrounding(pool, {
      turnId: 'turn-1',
      conversationId: 'conv-1',
      mode: 'retrieved',
      assessment: { decision: 'retrieve', rule: 'R2', query: 'fractions' },
      units: [{ unitId: 'u-1', lessonId: 'l-1', title: 'Intro', chars: 900, orderIndex: 0 }],
      totalChars: 900,
      inputTokenEstimate: 1200,
      lineageStatus: 'own_attempt',
      resolvedAttemptId: 'tpa-1',
      budgetEstimateTokens: 1300,
      budgetCounterKind: 'proxy',
      now: NOW,
    });
    expect(row).toMatchObject({
      turnId: 'turn-1',
      mode: 'retrieved',
      lineageStatus: 'own_attempt',
      budgetCounterKind: 'proxy',
      budgetEstimateTokens: 1300,
      truncated: false,
    });
    expect(await readTurnGrounding(pool, 'turn-1')).toEqual(row);
    // The 10,000-char ceiling is a CHECK, not a convention.
    await expect(
      insertTurnGrounding(pool, {
        turnId: 'turn-2',
        mode: 'scene',
        assessment: {},
        units: [],
        totalChars: 10_001,
        inputTokenEstimate: 1,
        budgetEstimateTokens: 1,
        budgetCounterKind: 'exact',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

/** The tutor tables exactly as they were before discovery-first P7 (inline CHECKs without `clarification`). */
const PRE_P7_DDL = [
  `CREATE TABLE teaching_package_versions (id TEXT PRIMARY KEY)`,
  `CREATE TABLE tutor_conversations (
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
  )`,
  `CREATE TABLE tutor_messages (
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
  )`,
  `CREATE TABLE tutor_help_sessions (
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
  )`,
  `CREATE TABLE tutor_help_messages (
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
  )`,
  `CREATE TABLE tutor_turn_groundings (
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
  )`,
];

describe('discovery-first P7 schema evolution and stored shapes', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    await pool.end();
  });

  const checkDefs = async (table: string) =>
    (
      await pool.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY conname`,
        [table],
      )
    ).rows;

  const groundingModeCheck = async (table: string, column: string) =>
    (await checkDefs(table)).filter((row) => row.def.includes(column) && row.def.includes('reuse'));

  it('upgrades the pre-P7 schema in place (twice): CHECKs accept clarification, new columns exist, old rows stay', async () => {
    for (const statement of PRE_P7_DDL) await pool.query(statement);
    await pool.query(`INSERT INTO teaching_package_versions (id) VALUES ('tpv-1')`);
    // A pre-P7 row with the old association and snapshot shapes, written by hand.
    await pool.query(
      `INSERT INTO tutor_conversations (id, tenant_id, student_ref, subject_code, subject_offering_id, subject_name,
         academic, lesson_association, grounding, status, created_at, updated_at)
       VALUES ('conv-1', '1', $1, 'MATH', '10', 'الرياضيات', '{"academicLanguage":"ar"}'::jsonb, $2::jsonb, $3::jsonb, 'active', $4, $4)`,
      [
        OWNER.studentRef,
        JSON.stringify({ learningItemType: 'lesson', learningItemId: 'L1', lessonTitle: 'قديم', confidence: 0.9, associatedAtSeq: 1 }),
        JSON.stringify({ units: [{ unitId: 'u-1', title: 'x', text: 'y', chars: 1 }], keywords: [], setAtSeq: 1, lastUsedSeq: 1 }),
        NOW,
      ],
    );
    await pool.query(
      `INSERT INTO tutor_messages (id, conversation_id, seq, role, turn_id, text, status, grounding_mode, created_at)
       VALUES ('m-old', 'conv-1', 1, 'tutor', 't-old', 'old', 'completed', 'retrieved', $1)`,
      [NOW],
    );
    const before = await groundingModeCheck('tutor_messages', 'grounding_mode');
    expect(before).toHaveLength(1);
    expect(before[0]!.def).not.toContain('clarification');

    await ensureTutorRuntimeSchema(pool);
    await ensureTutorRuntimeSchema(pool);

    for (const [table, column] of [
      ['tutor_messages', 'grounding_mode'],
      ['tutor_turn_groundings', 'mode'],
    ] as const) {
      const checks = await groundingModeCheck(table, column);
      expect(checks).toHaveLength(1);
      expect(checks[0]!.def).toContain('clarification');
    }
    // Help messages never use it: their CHECK is untouched.
    const help = await groundingModeCheck('tutor_help_messages', 'grounding_mode');
    expect(help).toHaveLength(1);
    expect(help[0]!.def).not.toContain('clarification');

    const columns = async (table: string) =>
      (
        await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
          [table],
        )
      ).rows.map((r) => r.column_name);
    expect(await columns('tutor_conversations')).toContain('pending_clarification');
    expect(await columns('tutor_messages')).toContain('first_delta_at');
    expect(await columns('tutor_help_messages')).not.toContain('first_delta_at');
    expect(await columns('tutor_turn_groundings')).toEqual(
      expect.arrayContaining([
        'source',
        'outcome_reason',
        'resolution',
        'embedding_model',
        'embedding_tokens',
        'pool_wait_ms',
        'resolve_ms',
        'embed_ms',
        'search_ms',
        'total_retrieval_ms',
      ]),
    );

    // The old row survives; its pre-P7 association and snapshot parse as "none" (D-19).
    const old = (await readConversation(pool, 'conv-1'))!;
    expect(old).toMatchObject({ id: 'conv-1', lessonAssociation: null, grounding: null, pendingClarification: null });
    expect((await readMessagesBySeq(pool, { parentId: 'conv-1', limit: 5 })).messages[0]).toMatchObject({
      groundingMode: 'retrieved',
    });

    // `clarification` is now accepted on tutor_messages and tutor_turn_groundings …
    await insertTutorMessage(pool, {
      id: 'm-clar',
      parentId: 'conv-1',
      seq: 2,
      turnId: 't-clar',
      turnAttempt: 1,
      text: 'أي موضوع تقصد؟',
      servedBy: null,
      groundingMode: 'clarification',
      accountingComplete: true,
      firstDeltaAt: NOW + 0.25,
      now: NOW,
    });
    const delta = await pool.query<{ first_delta_at: number }>(
      `SELECT first_delta_at FROM tutor_messages WHERE id = 'm-clar'`,
    );
    expect(Number(delta.rows[0]!.first_delta_at)).toBe(NOW + 0.25);
    await insertTurnGrounding(pool, {
      turnId: 't-clar',
      conversationId: 'conv-1',
      mode: 'clarification',
      assessment: {},
      units: [],
      totalChars: 0,
      inputTokenEstimate: 0,
      budgetEstimateTokens: 0,
      budgetCounterKind: 'exact',
      now: NOW,
    });
    // … and still refused on tutor_help_messages.
    await upsertHelpSession(pool, {
      id: 'hs-1',
      tenantId: '1',
      versionId: 'tpv-1',
      stageId: 's',
      sceneId: 'sc',
      learnerKey: 'tp:x',
      studentRef: OWNER.studentRef,
      subjectCode: 'MATH',
      now: NOW,
    });
    await expect(
      insertHelpTutorMessage(pool, {
        id: 'hm-1',
        parentId: 'hs-1',
        seq: 1,
        turnId: 'ht-1',
        turnAttempt: 1,
        text: 'x',
        servedBy: null,
        groundingMode: 'clarification',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a fresh database carries the widened CHECKs at creation (the evolution block is a no-op)', async () => {
    await pool.query(`CREATE TABLE teaching_package_versions (id TEXT PRIMARY KEY)`);
    await ensureTutorRuntimeSchema(pool);
    const checks = await groundingModeCheck('tutor_messages', 'grounding_mode');
    expect(checks).toHaveLength(1);
    expect(checks[0]!.def).toContain('clarification');
    await ensureTutorRuntimeSchema(pool);
    expect(await groundingModeCheck('tutor_messages', 'grounding_mode')).toEqual(checks);
  });

  it('parses only association v2 and the rollback-only schema 1; anything else is none', () => {
    const v2 = { schema: 2, learningItemType: 'SECTION', learningItemId: '612', title: 'المثال المضاد', confidence: 0.81, associatedAtSeq: 3, buildId: '41' };
    expect(parseConversationAssociation(v2)).toEqual(v2);
    expect(parseConversationAssociation(JSON.stringify(v2))).toEqual(v2);
    const v1 = { schema: 1, lessonId: '290', lessonTitle: 'التبرير', confidence: 0.6, associatedAtSeq: 1 };
    expect(parseConversationAssociation(v1)).toEqual(v1);
    for (const other of [
      { learningItemType: 'lesson', learningItemId: 'L1', lessonTitle: 'x', confidence: 0.9, associatedAtSeq: 1 },
      { ...v2, learningItemType: 'lesson' },
      { ...v2, learningItemId: '' },
      { ...v1, lessonId: 290 },
      { schema: 3 },
      'not json',
      null,
      [],
    ]) {
      expect(parseConversationAssociation(other)).toBeNull();
    }
  });

  it('parses only snapshot v2; a pre-P7 or malformed snapshot is none; pending clarification is validated', () => {
    expect(parseGroundingSnapshot({ units: [], keywords: [], setAtSeq: 1, lastUsedSeq: 1 })).toBeNull();
    const direct = {
      schema: 2,
      source: 'direct',
      units: [{ source: 'direct', unitId: '1', itemId: '2', itemType: 'LESSON', buildId: '3', revisionId: '4', unitUpdatedAt: 't', title: null, text: 'x', chars: 1 }],
      items: [{ itemId: '2', itemType: 'LESSON', title: 'T' }],
      keywords: ['x'],
      setAtSeq: 1,
      lastUsedSeq: 1,
    };
    expect(parseGroundingSnapshot(direct)).toEqual(direct);
    // A direct unit without build data cannot be revalidated: the snapshot is none.
    expect(parseGroundingSnapshot({ ...direct, units: [{ ...direct.units[0], buildId: undefined }] })).toBeNull();
    // A kafuo_http unit inside a direct snapshot is not a direct unit.
    expect(parseGroundingSnapshot({ ...direct, units: [{ ...direct.units[0], source: 'kafuo_http' }] })).toBeNull();

    const pending = { candidates: [{ itemId: '1', itemType: 'LESSON', title: 'أ' }, { itemId: '2', itemType: 'SECTION', title: 'ب' }], questionSeq: 3, askedAtSeq: 4 };
    expect(parsePendingClarification(pending)).toEqual(pending);
    expect(parsePendingClarification({ ...pending, candidates: [] })).toBeNull();
    expect(parsePendingClarification({ ...pending, candidates: [...pending.candidates, ...pending.candidates] })).toBeNull();
    expect(parsePendingClarification({ ...pending, questionSeq: 'x' })).toBeNull();
  });

  it('pending_clarification and the retrieval audit columns round-trip', async () => {
    await pool.query(`CREATE TABLE teaching_package_versions (id TEXT PRIMARY KEY)`);
    await ensureTutorRuntimeSchema(pool);
    await insertConversation(pool, conversation({ id: 'conv-1' }));
    const pending = { candidates: [{ itemId: '155', itemType: 'LESSON' as const, title: 'التبرير' }], questionSeq: 1, askedAtSeq: 2 };
    await updateConversationPendingClarification(pool, 'conv-1', pending, NOW + 1);
    expect((await readConversation(pool, 'conv-1'))!.pendingClarification).toEqual(pending);
    await updateConversationPendingClarification(pool, 'conv-1', null, NOW + 2);
    expect((await readConversation(pool, 'conv-1'))!.pendingClarification).toBeNull();

    const row = await insertTurnGrounding(pool, {
      turnId: 'turn-1',
      conversationId: 'conv-1',
      mode: 'insufficient',
      assessment: { rule: 'lesson_discovery' },
      units: [],
      totalChars: 0,
      inputTokenEstimate: 900,
      budgetEstimateTokens: 900,
      budgetCounterKind: 'proxy',
      retrieval: {
        source: 'direct',
        outcomeReason: 'no_match',
        resolution: { outcome: 'no_match', indexCoverage: 'partial' },
        embeddingModel: null,
        embeddingTokens: null,
        poolWaitMs: 0.5,
        resolveMs: 3.25,
        embedMs: 0,
        searchMs: 0,
        totalRetrievalMs: 3.75,
      },
      now: NOW,
    });
    expect(row).toMatchObject({
      source: 'direct',
      outcomeReason: 'no_match',
      resolution: { outcome: 'no_match', indexCoverage: 'partial' },
      poolWaitMs: 0.5,
      resolveMs: 3.25,
      totalRetrievalMs: 3.75,
    });
    expect(await readTurnGrounding(pool, 'turn-1')).toEqual(row);
    await expect(
      insertTurnGrounding(pool, {
        turnId: 'turn-2',
        mode: 'none',
        assessment: {},
        units: [],
        totalChars: 0,
        inputTokenEstimate: 1,
        budgetEstimateTokens: 1,
        budgetCounterKind: 'exact',
        retrieval: { source: 'elsewhere' as never },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('server-provider registration', () => {
  it('bootstraps the tutor runtime and meter outbox tables with the provider', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', 'postgres://tutor-runtime-registration');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const db = new PGlite();
    await db.waitReady;
    const pool = new PGlitePool(db);
    try {
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
      const tables = await pool.query<{ name: string | null }>(
        `SELECT to_regclass('tutor_conversations')::text AS name
         UNION ALL SELECT to_regclass('tutor_help_sessions')::text
         UNION ALL SELECT to_regclass('tutor_turn_groundings')::text
         UNION ALL SELECT to_regclass('meter_finalize_outbox')::text`,
      );
      expect(tables.rows.map((r) => r.name)).toEqual([
        'tutor_conversations',
        'tutor_help_sessions',
        'tutor_turn_groundings',
        'meter_finalize_outbox',
      ]);
    } finally {
      await pool.end();
      vi.unstubAllEnvs();
    }
  });
});
