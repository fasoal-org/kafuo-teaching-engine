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

  it('L-6: a requestId replayed on ANOTHER version is a 409, never that version’s review', async () => {
    const first = await seed();
    const second = await seed();
    const queued = await queue(first, 'qr-shared');
    expect(queued.response.status).toBe(202);
    const replayed = await queue(second, 'qr-shared');
    expect(replayed.response.status).toBe(409);
    expect((replayed.json as unknown as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    // The same version still replays its own review.
    const again = await queue(first, 'qr-shared');
    expect(again.response.status).toBe(202);
    expect(again.json.questionReview.id).toBe(queued.json.questionReview.id);
  });

  it('L-6 / LOW-6: correctAnswer strings are trimmed to 4,000 characters; only a still-oversized object refuses', async () => {
    const seeded = await seed();
    const route = await import('@/app/api/teaching-packages/[id]/question-reviews/route');
    const params = { params: Promise.resolve({ id: seeded.versionId }) };
    // One long working text is trimmed, never a refusal of the whole set.
    const long = {
      ...QUESTIONS[0],
      correctAnswer: { choiceId: 'a', steps: ['خطوة', 'x'.repeat(10_000)] },
    };
    const accepted = await route.POST(
      post(seeded.versionId, { ...body(seeded, 'qr-long'), questions: [long, QUESTIONS[1]] }),
      params,
    );
    expect(accepted.status).toBe(202);
    const stored = (
      await pool.query(`SELECT questions FROM teaching_question_reviews WHERE request_id = $1`, [
        'qr-long',
      ])
    ).rows[0] as { questions: Array<{ correctAnswer: { choiceId: string; steps: string[] } }> };
    expect(stored.questions[0]!.correctAnswer.choiceId).toBe('a');
    expect(stored.questions[0]!.correctAnswer.steps[0]).toBe('خطوة');
    expect(stored.questions[0]!.correctAnswer.steps[1]).toBe(`${'x'.repeat(4_000)}…`);
    // Still over 16,000 characters after trimming every string: refused.
    const huge = {
      ...QUESTIONS[0],
      correctAnswer: {
        a: 'x'.repeat(4_000),
        b: 'x'.repeat(4_000),
        c: 'x'.repeat(4_000),
        d: 'x'.repeat(4_000),
        e: 'x',
      },
    };
    const refused = await route.POST(
      post(seeded.versionId, { ...body(seeded, 'qr-huge'), questions: [huge] }),
      params,
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_REQUEST',
    );
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

  it('M-4: the paid answer is stored under the lease before the terminal write; a failed finish resumes from it without a second call', async () => {
    const seeded = await seed();
    const { json } = await queue(seeded);
    const id = json.questionReview.id;
    const { runQuestionReview } = await import('@/lib/server/teaching-package/question-review');
    // The terminal transaction fails once (its outbox table is away) AFTER the paid call.
    const answer = await failingQ1();
    failingQ1.mockClear();
    const callReviewer = vi.fn(async () => {
      await pool.query(
        `ALTER TABLE teaching_package_webhook_deliveries RENAME TO tpwd_away_for_test`,
      );
      return answer;
    });
    expect(await runQuestionReview(id, { pool: txPool(), callReviewer })).toBeNull();
    await pool.query(
      `ALTER TABLE tpwd_away_for_test RENAME TO teaching_package_webhook_deliveries`,
    );
    const stored = (
      await pool.query(
        `SELECT status, reviewed_at, provider, results FROM teaching_question_reviews WHERE id = $1`,
        [id],
      )
    ).rows[0] as {
      status: string;
      reviewed_at: number | null;
      provider: string;
      results: Array<{ questionId: string; verdict: string }>;
    };
    expect(stored.status).toBe('running');
    expect(stored.reviewed_at).not.toBeNull();
    expect(stored.provider).toBe('anthropic');
    expect(stored.results.map((r) => [r.questionId, r.verdict])).toEqual([
      ['q-101', 'pass'],
      ['q-102', 'fail'],
    ]);
    // A running answer is not yet the review's result.
    const route =
      await import('@/app/api/teaching-packages/[id]/question-reviews/[reviewId]/route');
    const read = await route.GET(
      new NextRequest(
        `http://localhost/api/teaching-packages/${seeded.versionId}/question-reviews/${id}?tenantId=${TENANT}`,
        { headers: { authorization: `Bearer ${KEY}` } },
      ),
      { params: Promise.resolve({ id: seeded.versionId, reviewId: id }) },
    );
    expect(
      ((await read.json()) as { questionReview: { results: unknown[] } }).questionReview,
    ).toMatchObject({ status: 'running', results: [] });
    expect(await events()).toEqual([]);

    // The lease lapses; the resume finishes from the stored answer and never pays again.
    await pool.query(`UPDATE teaching_question_reviews SET lease_until = 1 WHERE id = $1`, [id]);
    const done = await runQuestionReview(id, { pool: txPool(), callReviewer });
    expect(done).toMatchObject({ status: 'completed', provider: 'anthropic', model: OPUS });
    expect(callReviewer).toHaveBeenCalledTimes(1);
    const [event] = await events();
    expect((event!.questionReview as { results: unknown[] }).results).toEqual([
      { questionId: 'q-101', verdict: 'pass', checks: [], autoFixable: false },
      { questionId: 'q-102', verdict: 'fail', checks: ['Q5'], autoFixable: true },
    ]);
  });

  it('M-4: a crashed worker’s stored answer is finished by the sweep with no reviewer call', async () => {
    const seeded = await seed();
    const { json } = await queue(seeded);
    const id = json.questionReview.id;
    const answer = await failingQ1();
    failingQ1.mockClear();
    await pool.query(
      `UPDATE teaching_question_reviews
          SET status = 'running', lease_owner = 'dead', lease_until = 1, run_attempts = 1,
              reviewed_at = 5, provider = 'anthropic', model = $2, results = $3::jsonb
        WHERE id = $1`,
      [id, OPUS, JSON.stringify(answer.results)],
    );
    const { sweepQuestionReviews } = await import('@/lib/server/teaching-package/question-review');
    expect(await sweepQuestionReviews({ pool: txPool(), callReviewer: failingQ1 })).toEqual([id]);
    await vi.waitFor(async () => {
      const rows = await pool.query(`SELECT status FROM teaching_question_reviews WHERE id = $1`, [
        id,
      ]);
      expect((rows.rows[0] as { status: string }).status).toBe('completed');
    });
    expect(failingQ1).not.toHaveBeenCalled();
    const [event] = await events();
    expect(event!.questionReview).toMatchObject({ status: 'completed', model: OPUS });
  });

  it('LOW-1: past the claim cap a stored answer ends unavailable with NO verdicts (row and event)', async () => {
    const seeded = await seed();
    const { json } = await queue(seeded);
    const id = json.questionReview.id;
    const answer = await failingQ1();
    failingQ1.mockClear();
    await pool.query(
      `UPDATE teaching_question_reviews
          SET status = 'running', lease_owner = 'dead', lease_until = 1, run_attempts = 3,
              reviewed_at = 5, provider = 'anthropic', model = $2, results = $3::jsonb
        WHERE id = $1`,
      [id, OPUS, JSON.stringify(answer.results)],
    );
    const { runQuestionReview } = await import('@/lib/server/teaching-package/question-review');
    const done = await runQuestionReview(id, { pool: txPool(), callReviewer: failingQ1 });
    expect(done).toMatchObject({
      status: 'unavailable',
      errorCode: 'REVIEW_ATTEMPTS_EXHAUSTED',
      results: [],
    });
    expect(failingQ1).not.toHaveBeenCalled();
    const [event] = await events();
    expect(event!.questionReview).toMatchObject({ status: 'unavailable', results: [] });
  });

  it('LOW-1: a stored answer that does not answer every question is not trusted; the set is reviewed again', async () => {
    const seeded = await seed();
    const { json } = await queue(seeded);
    const id = json.questionReview.id;
    const answer = await failingQ1();
    failingQ1.mockClear();
    await pool.query(
      `UPDATE teaching_question_reviews
          SET status = 'running', lease_owner = 'dead', lease_until = 1, run_attempts = 1,
              reviewed_at = 5, provider = 'anthropic', model = $2, results = $3::jsonb
        WHERE id = $1`,
      [id, OPUS, JSON.stringify(answer.results.slice(0, 1))],
    );
    const { runQuestionReview } = await import('@/lib/server/teaching-package/question-review');
    const done = await runQuestionReview(id, { pool: txPool(), callReviewer: failingQ1 });
    expect(failingQ1).toHaveBeenCalledTimes(1);
    expect(done).toMatchObject({ status: 'completed' });
    expect(done!.results.map((r) => r.questionId)).toEqual(['q-101', 'q-102']);
  });

  const reviewRow = async (id: string) =>
    (
      await pool.query(
        `SELECT status, lease_owner, reviewed_at FROM teaching_question_reviews WHERE id = $1`,
        [id],
      )
    ).rows[0] as { status: string; lease_owner: string | null; reviewed_at: number | null };

  it('HIGH-1: a question run stalled BEFORE its call whose lease moved on never pays and writes nothing', async () => {
    const seeded = await seed();
    const { json } = await queue(seeded);
    const id = json.questionReview.id;
    const { runQuestionReview } = await import('@/lib/server/teaching-package/question-review');
    const { loadReviewBookUnits } =
      await import('@/lib/server/teaching-package/package-review-input');
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loadBook = vi.fn(async (...args: Parameters<typeof loadReviewBookUnits>) => {
      await stalled;
      return loadReviewBookUnits(...args);
    });
    const running = runQuestionReview(id, {
      pool: txPool(),
      callReviewer: failingQ1,
      loadBook,
      workerId: 'stale-worker',
    });
    await vi.waitFor(() => expect(loadBook).toHaveBeenCalledTimes(1));
    await pool.query(
      `UPDATE teaching_question_reviews SET lease_owner = 'other-worker' WHERE id = $1`,
      [id],
    );
    release();
    expect(await running).toBeNull();
    expect(failingQ1).not.toHaveBeenCalled();
    expect(await reviewRow(id)).toMatchObject({
      status: 'running',
      lease_owner: 'other-worker',
      reviewed_at: null,
    });
    expect(await events()).toEqual([]);
  });

  it('L-10 / HIGH-1: a hung question run is evicted (its call aborted) and resumed; the stale answer is refused', async () => {
    const seeded = await seed();
    const { json } = await queue(seeded);
    const id = json.questionReview.id;
    const { sweepQuestionReviews, QUESTION_REVIEW_LEASE_MS } =
      await import('@/lib/server/teaching-package/question-review');
    const answer = await failingQ1();
    failingQ1.mockClear();
    const gates: Array<() => void> = [];
    const callReviewer = vi.fn(
      (_request: { signal?: AbortSignal }) =>
        new Promise<typeof answer>((resolve) => {
          gates.push(() => resolve(answer));
        }),
    );
    let t = Date.now();
    const deps = { pool: txPool(), callReviewer, now: () => t };
    expect(await sweepQuestionReviews(deps)).toEqual([id]);
    await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(1));
    const firstOwner = (await reviewRow(id)).lease_owner;
    t += QUESTION_REVIEW_LEASE_MS - 1_000;
    expect(await sweepQuestionReviews(deps)).toEqual([]);
    t += 2_000;
    expect(await sweepQuestionReviews(deps)).toEqual([id]);
    await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(2));
    expect(callReviewer.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(callReviewer.mock.calls[1]![0].signal?.aborted).toBe(false);
    const secondOwner = (await reviewRow(id)).lease_owner;
    expect(secondOwner).not.toBe(firstOwner);
    // The stale run's answer arrives: its save is refused by the lease guard.
    gates[0]!();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await reviewRow(id)).toMatchObject({
      status: 'running',
      lease_owner: secondOwner,
      reviewed_at: null,
    });
    gates[1]!();
    await vi.waitFor(async () => expect((await reviewRow(id)).status).toBe('completed'));
    expect(await events()).toHaveLength(1);
  });

  it('D-6: the sweep runs at most 2 question reviews at once; the next starts after one ends', async () => {
    const seeded = await seed();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { json } = await queue(seeded, `qr-cap-${index}`);
      await pool.query(`UPDATE teaching_question_reviews SET created_at = $2 WHERE id = $1`, [
        json.questionReview.id,
        index + 1,
      ]);
      ids.push(json.questionReview.id);
    }
    const gateOf = new Map<string, () => void>();
    const answer = await failingQ1();
    failingQ1.mockClear();
    const callReviewer = vi.fn(
      (request: { review: { id: string } }) =>
        new Promise<typeof answer>((resolve) => {
          gateOf.set(request.review.id, () => resolve(answer));
        }),
    );
    const status = async (id: string) =>
      (
        (await pool.query(`SELECT status FROM teaching_question_reviews WHERE id = $1`, [id]))
          .rows[0] as { status: string }
      ).status;
    const { sweepQuestionReviews } = await import('@/lib/server/teaching-package/question-review');
    const deps = { pool: txPool(), callReviewer };
    expect(await sweepQuestionReviews(deps)).toEqual([ids[0], ids[1]]);
    await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(2));
    expect(await sweepQuestionReviews(deps)).toEqual([]);
    gateOf.get(ids[0]!)!();
    await vi.waitFor(async () => expect(await status(ids[0]!)).toBe('completed'));
    await vi.waitFor(async () => expect(await sweepQuestionReviews(deps)).toEqual([ids[2]]));
    await vi.waitFor(() => expect(callReviewer).toHaveBeenCalledTimes(3));
    // One at a time: the test database is a single connection, so two finishing
    // transactions must not interleave.
    gateOf.get(ids[1]!)!();
    await vi.waitFor(async () => expect(await status(ids[1]!)).toBe('completed'));
    gateOf.get(ids[2]!)!();
    await vi.waitFor(async () => expect(await status(ids[2]!)).toBe('completed'));
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

  it('H-1: the system prompt carries the exact schema for Sol, and a fenced answer parses', async () => {
    const { QUESTION_REVIEW_SCHEMA, QUESTION_REVIEW_SYSTEM } =
      await import('@/lib/server/teaching-package/question-review');
    expect(QUESTION_REVIEW_SYSTEM).toContain(JSON.stringify(QUESTION_REVIEW_SCHEMA));
    expect(QUESTION_REVIEW_SYSTEM).toContain('"results"');
    const fenced =
      '```json\n' +
      JSON.stringify({ results: [{ question_id: 'q-101', verdict: 'pass', findings: [] }] }) +
      '\n```';
    expect(parseQuestionReviewAnswer(fenced, ['q-101'])).toEqual([
      { questionId: 'q-101', verdict: 'pass', findings: [], fixNote: null },
    ]);
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
