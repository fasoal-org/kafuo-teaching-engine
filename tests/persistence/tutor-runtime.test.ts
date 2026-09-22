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
  writeGroundingSnapshot,
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

  it('grounding snapshot round-trips and clears', async () => {
    await insertConversation(pool, conversation({ id: 'conv-1' }));
    expect(await readGroundingSnapshot(pool, 'conv-1')).toBeNull();
    const snapshot = {
      units: [{ unitId: 'u-1', lessonId: 'l-1', lessonTitle: 'Fractions', title: 'Intro', text: '…', chars: 1 }],
      keywords: ['fractions'],
      setAtSeq: 3,
      lastUsedSeq: 3,
    };
    await writeGroundingSnapshot(pool, 'conv-1', snapshot, NOW + 1);
    expect(await readGroundingSnapshot(pool, 'conv-1')).toEqual(snapshot);
    await writeGroundingSnapshot(pool, 'conv-1', null, NOW + 2);
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
