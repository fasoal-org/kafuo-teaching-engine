/**
 * The asynchronous question-set review (ai-reviewer-layer plan §4.7, contract
 * §3.4/§4.3/§4.4): the 202 route, the sweep-run job, the verdict event and the
 * signed read, with a fake reviewer. No model is called.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  upsertSourceContext,
} from '@/lib/persistence/teaching-package';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  combinedFixNote,
  parseQuestionReviewAnswer,
  renderQuestionsBlock,
} from '@/lib/server/teaching-package/question-review';
import type { AppScene } from '@/lib/types/stage';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return { query: (t: string, p?: unknown[]) => this.db.query(t, p), release() {} };
  }
  async end() {
    await this.db.close();
  }
}

const TENANT = 'tenant-qr';
const KEY = 'question-review-key';
const OPUS = 'anthropic:claude-opus-5-5';

const QUESTIONS = [
  {
    questionId: 'q-101',
    questionType: 'multiple_choice',
    targetRole: 'check_understanding',
    stem: 'كم يساوي ٣ × ٤؟',
    choices: [
      { id: 'a', text: '١٢', isCorrect: true },
      { id: 'b', text: '٧', isCorrect: false },
    ],
    correctAnswer: { choiceId: 'a' },
    explanation: 'لأن ٣ × ٤ = ١٢',
  },
  {
    questionId: 'q-102',
    questionType: 'true_false',
    targetRole: null,
    stem: 'الكسر ٢/٤ يساوي ١/٢',
    choices: [],
    correctAnswer: { value: true },
    explanation: null,
  },
];

describe('question-set review (Phase 4)', () => {
  let pool: PGlitePool;
  const txPool = () => pool as unknown as ConnectableQueryable;

  async function seed(options: { withSource?: boolean } = {}) {
    const learningItem = { type: 'lesson' as const, id: `li-${randomUUID()}` };
    const aggregate = { tenantId: TENANT, learningItem };
    const stageId = `stage-${randomUUID()}`;
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    await store.saveDocument(
      makeDocument(stageId, 'Fractions', [makeSlideScene(`${stageId}-1`, stageId, 1, 'S')]),
    );
    const attemptId = `tpa-${randomUUID()}`;
    const versionId = `tpv-${randomUUID()}`;
    await insertVersion(pool as never, {
      id: versionId,
      aggregate,
      version: 1,
      status: 'approved',
      currentStageId: stageId,
      currentAttemptId: attemptId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await insertAttempt(pool as never, {
      id: attemptId,
      aggregate,
      versionId,
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: { learningItem, subjectCode: 'MATH' } as never,
      now: 1,
    });
    if (options.withSource !== false) {
      await upsertSourceContext(pool as never, {
        tenantId: TENANT,
        attemptId,
        contentResourceId: 'cs-1',
        measuredSha256: 'a'.repeat(64),
        text: 'نص الكتاب: ٣ × ٤ = ١٢',
      });
    }
    return { versionId, learningItem, attemptId };
  }

  function post(versionId: string, body: Record<string, unknown>, authed = true) {
    return new NextRequest(`http://localhost/api/teaching-packages/${versionId}/question-reviews`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        ...(authed ? { authorization: `Bearer ${KEY}` } : {}),
      },
    });
  }

  function body(seeded: { learningItem: { type: 'lesson'; id: string } }, requestId = 'qr-req-1') {
    return {
      tenantContext: { tenantId: TENANT },
      learningItem: seeded.learningItem,
      requestId,
      language: 'ar',
      objective: { objectiveRef: '48', text: 'يضرب عددين' },
      questions: QUESTIONS,
    };
  }

  async function queue(seeded: Awaited<ReturnType<typeof seed>>, requestId = 'qr-req-1') {
    const route = await import('@/app/api/teaching-packages/[id]/question-reviews/route');
    const response = await route.POST(post(seeded.versionId, body(seeded, requestId)), {
      params: Promise.resolve({ id: seeded.versionId }),
    });
    return {
      response,
      json: (await response.json()) as { questionReview: { id: string; status: string } },
    };
  }

  async function events() {
    const rows = await pool.query(
      `SELECT payload FROM teaching_package_webhook_deliveries
        WHERE event_type = 'teaching_question_set.review_completed' ORDER BY sequence`,
    );
    return (rows.rows as Array<{ payload: Record<string, unknown> }>).map((r) => r.payload);
  }

  const failingQ1 = vi.fn(async () => ({
    results: [
      { questionId: 'q-101', verdict: 'pass' as const, findings: [], fixNote: null },
      {
        questionId: 'q-102',
        verdict: 'fail' as const,
        findings: [
          {
            check: 'Q5' as const,
            severity: 'medium' as const,
            bookEvidence: { quote: 'BOOKQUOTEMARKER', unitId: null },
            whatIsWrong: 'لا يوجد شرح',
            fixNote: 'أضف شرحًا: ٢/٤ = ١/٢ بقسمة البسط والمقام على ٢',
          },
        ],
        fixNote: '(Q5) أضف شرحًا: ٢/٤ = ١/٢ بقسمة البسط والمقام على ٢',
      },
    ],
    call: { provider: 'anthropic' as const, modelString: OPUS },
  }));

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://tqr-${randomUUID()}`);
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', KEY);
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    failingQ1.mockClear();
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('POST answers 202 with a queued review; the same requestId replays the same review (no second call)', async () => {
    const seeded = await seed();
    const first = await queue(seeded);
    expect(first.response.status).toBe(202);
    expect(first.json.questionReview).toMatchObject({ status: 'queued' });
    expect(first.json.questionReview.id).toMatch(/^tqr-/);
    const again = await queue(seeded);
    expect(again.response.status).toBe(202);
    expect(again.json.questionReview.id).toBe(first.json.questionReview.id);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM teaching_question_reviews`);
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it('POST refuses an unsigned call, a malformed body and another learning item', async () => {
    const seeded = await seed();
    const route = await import('@/app/api/teaching-packages/[id]/question-reviews/route');
    const params = { params: Promise.resolve({ id: seeded.versionId }) };
    expect((await route.POST(post(seeded.versionId, body(seeded), false), params)).status).toBe(
      401,
    );
    const empty = await route.POST(
      post(seeded.versionId, { ...body(seeded), questions: [] }),
      params,
    );
    expect(empty.status).toBeGreaterThanOrEqual(400);
    expect(empty.status).toBeLessThan(500);
    const repeated = await route.POST(
      post(seeded.versionId, { ...body(seeded), questions: [QUESTIONS[0], QUESTIONS[0]] }),
      params,
    );
    expect(repeated.status).toBeGreaterThanOrEqual(400);
    const other = await route.POST(
      post(seeded.versionId, { ...body(seeded), learningItem: { type: 'lesson', id: 'li-other' } }),
      params,
    );
    expect(other.status).toBe(404);
  });

  it('the job: the whole set in one call, the book once; verdict event with check codes and no notes', async () => {
    const seeded = await seed();
    const { json } = await queue(seeded);
    const { runQuestionReview } = await import('@/lib/server/teaching-package/question-review');
    const done = await runQuestionReview(json.questionReview.id, {
      pool: txPool(),
      callReviewer: failingQ1,
    });
    expect(done).toMatchObject({ status: 'completed', provider: 'anthropic', model: OPUS });
    expect(failingQ1).toHaveBeenCalledTimes(1);
    const [request] = failingQ1.mock.calls[0] as unknown as [
      {
        units: Array<{ text: string }>;
        review: { questions: unknown[] };
        subjectCode: string;
        attemptId: string;
      },
    ];
    expect(request.units).toEqual([expect.objectContaining({ text: 'نص الكتاب: ٣ × ٤ = ١٢' })]);
    expect(request.review.questions).toHaveLength(2);
    expect(request).toMatchObject({ subjectCode: 'MATH', attemptId: seeded.attemptId });
    const [event] = await events();
    expect(event).toEqual({
      questionReview: expect.objectContaining({
        id: json.questionReview.id,
        versionId: seeded.versionId,
        requestId: 'qr-req-1',
        status: 'completed',
        results: [
          { questionId: 'q-101', verdict: 'pass', checks: [], autoFixable: false },
          { questionId: 'q-102', verdict: 'fail', checks: ['Q5'], autoFixable: true },
        ],
        errorCode: null,
      }),
    });
    expect(JSON.stringify(event)).not.toContain('BOOKQUOTEMARKER');
    expect(JSON.stringify(event)).not.toContain('أضف شرحًا');
    expect(
      await runQuestionReview(json.questionReview.id, { pool: txPool(), callReviewer: failingQ1 }),
    ).toBeNull();
  });

  it('the signed GET returns the findings and the combined repair note, scoped to the tenant', async () => {
    const seeded = await seed();
    const { json } = await queue(seeded);
    const { runQuestionReview } = await import('@/lib/server/teaching-package/question-review');
    await runQuestionReview(json.questionReview.id, { pool: txPool(), callReviewer: failingQ1 });
    const route =
      await import('@/app/api/teaching-packages/[id]/question-reviews/[reviewId]/route');
    const url = `http://localhost/api/teaching-packages/${seeded.versionId}/question-reviews/${json.questionReview.id}`;
    const params = {
      params: Promise.resolve({ id: seeded.versionId, reviewId: json.questionReview.id }),
    };
    const ok = await route.GET(
      new NextRequest(`${url}?tenantId=${TENANT}`, { headers: { authorization: `Bearer ${KEY}` } }),
      params,
    );
    expect(ok.status).toBe(200);
    const read = (await ok.json()) as {
      questionReview: { results: Array<Record<string, unknown>> };
    };
    expect(read.questionReview.results[1]).toMatchObject({
      questionId: 'q-102',
      verdict: 'fail',
      fixNote: '(Q5) أضف شرحًا: ٢/٤ = ١/٢ بقسمة البسط والمقام على ٢',
      findings: [
        expect.objectContaining({
          check: 'Q5',
          bookEvidence: { quote: 'BOOKQUOTEMARKER', unitId: null },
        }),
      ],
    });
    const other = await route.GET(
      new NextRequest(`${url}?tenantId=tenant-other`, {
        headers: { authorization: `Bearer ${KEY}` },
      }),
      params,
    );
    expect(other.status).toBe(404);
  });

  it('no book source, or the reviewer down → unavailable with the event (the approval lock never waits forever)', async () => {
    const { runQuestionReview } = await import('@/lib/server/teaching-package/question-review');
    const noSource = await seed({ withSource: false });
    const first = await queue(noSource, 'qr-nosource');
    expect(
      await runQuestionReview(first.json.questionReview.id, {
        pool: txPool(),
        callReviewer: failingQ1,
      }),
    ).toMatchObject({ status: 'unavailable', errorCode: 'NO_BOOK_SOURCE' });
    expect(failingQ1).not.toHaveBeenCalled();

    const seeded = await seed();
    const second = await queue(seeded, 'qr-down');
    const { TeachingModelUnavailableError } = await import('@/lib/server/teaching-model/execute');
    const done = await runQuestionReview(second.json.questionReview.id, {
      pool: txPool(),
      callReviewer: vi.fn(async () => {
        throw new TeachingModelUnavailableError('down', {
          attemptIds: [],
          outcomes: [],
          retryable: true,
        });
      }),
    });
    expect(done).toMatchObject({ status: 'unavailable', errorCode: 'REVIEWER_UNAVAILABLE' });
    const sent = await events();
    expect(sent.map((e) => (e.questionReview as { status: string }).status)).toEqual([
      'unavailable',
      'unavailable',
    ]);
  });

  it('the sweep starts a queued question review in the background', async () => {
    const seeded = await seed();
    const { json } = await queue(seeded);
    const { sweepQuestionReviews } = await import('@/lib/server/teaching-package/question-review');
    expect(await sweepQuestionReviews({ pool: txPool(), callReviewer: failingQ1 })).toEqual([
      json.questionReview.id,
    ]);
    await vi.waitFor(async () => {
      const rows = await pool.query(`SELECT status FROM teaching_question_reviews WHERE id = $1`, [
        json.questionReview.id,
      ]);
      expect((rows.rows[0] as { status: string }).status).toBe('completed');
    });
  });
});

describe('question review prompt and answer', () => {
  const review = {
    objectiveRef: '48',
    objectiveText: 'يضرب عددين',
    questions: QUESTIONS.map((q) => ({ ...q, choices: q.choices.map((c) => ({ ...c })) })),
  };

  it('renders the objective, every question, the marked choice and the explanation', () => {
    const text = renderQuestionsBlock(review as never);
    expect(text).toContain('OBJECTIVE (objectiveRef=48): يضرب عددين');
    expect(text).toContain(
      '<<QUESTION id=q-101 | type=multiple_choice | role=check_understanding>>',
    );
    expect(text).toContain('(a) ١٢  [MARKED CORRECT]');
    expect(text).toContain('EXPLANATION: لأن ٣ × ٤ = ١٢');
  });

  it('every question must be answered exactly once (else unusable → fallback); a pass with findings is a fail', () => {
    const finding = {
      check: 'Q1',
      severity: 'high',
      book_evidence: { quote: 'q', unit_id: '' },
      what_is_wrong: 'w',
      fix_note: 'n',
    };
    expect(() =>
      parseQuestionReviewAnswer(
        JSON.stringify({ results: [{ question_id: 'q-101', verdict: 'pass', findings: [] }] }),
        ['q-101', 'q-102'],
      ),
    ).toThrow(/skipped 1/);
    const results = parseQuestionReviewAnswer(
      JSON.stringify({
        results: [
          { question_id: 'q-101', verdict: 'pass', findings: [finding] },
          { question_id: 'q-102', verdict: 'fail', findings: [] },
          { question_id: 'ghost', verdict: 'fail', findings: [finding] },
        ],
      }),
      ['q-101', 'q-102'],
    );
    expect(results.map((r) => [r.questionId, r.verdict, r.fixNote])).toEqual([
      ['q-101', 'fail', '(Q1) n'],
      ['q-102', 'pass', null],
    ]);
    expect(() =>
      parseQuestionReviewAnswer(
        JSON.stringify({
          results: [
            { question_id: 'q-101', verdict: 'fail', findings: [{ ...finding, check: 'Q9' }] },
          ],
        }),
        ['q-101'],
      ),
    ).toThrow(/unknown check/);
  });

  it('combinedFixNote joins the notes by check', () => {
    expect(combinedFixNote([])).toBeNull();
    expect(
      combinedFixNote([
        {
          check: 'Q1',
          severity: 'high',
          bookEvidence: { quote: '', unitId: null },
          whatIsWrong: 'w',
          fixNote: 'a',
        },
        {
          check: 'Q4',
          severity: 'low',
          bookEvidence: { quote: '', unitId: null },
          whatIsWrong: 'w',
          fixNote: 'b',
        },
      ]),
    ).toBe('(Q1) a\n(Q4) b');
  });
});
