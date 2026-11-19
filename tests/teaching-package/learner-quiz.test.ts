/**
 * Learner quiz security: a learner grant's Stage response carries no grading
 * secrets, and grading happens server-side against the pinned version.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { insertAttempt, insertVersion } from '@/lib/persistence/teaching-package';
import { guideWrittenQuestionId } from '@/lib/server/teaching-package/guide-written-attempts';
import {
  buildEditorGrantPayload,
  grantCookieValueForRedeem,
} from '@/lib/server/teaching-package/editor-grant';
import {
  gradeQuizQuestions,
  normalizeAnswerText,
  parseLearnerAnswers,
  sanitizeLearnerDelivery,
} from '@/lib/server/teaching-package/learner-quiz';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene, QuizQuestion } from '@/lib/types/stage';
import type { KafuoTeacherGuide } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }
  async end() {
    await this.db.close();
  }
}

const TENANT = 'tenant-quiz';
const STAGE = 'stage-quiz-v1';
const STAGE_V2 = 'stage-quiz-v2';
const SERVICE_KEY = 'quiz-service-key';
const SECRET_SHORT_ANSWER = 'التخمين الاستقرائي';
const SECRET_EXPLANATION = 'secret explanation text';
const SECRET_RUBRIC = 'secret rubric text';

const QUESTIONS: QuizQuestion[] = [
  {
    id: 'q-single',
    type: 'single',
    question: 'Pick one',
    options: [
      { label: 'Alpha', value: 'A' },
      { label: 'Beta', value: 'B' },
    ],
    answer: ['B'],
    analysis: SECRET_EXPLANATION,
    hasAnswer: true,
    points: 2,
  },
  {
    id: 'q-multi',
    type: 'multiple',
    question: 'Pick two',
    options: [
      { label: 'One', value: 'A' },
      { label: 'Two', value: 'B' },
      { label: 'Three', value: 'C' },
    ],
    // Stored as a label on purpose: the key resolves through the options.
    answer: ['One', 'C'],
    hasAnswer: true,
    points: 3,
  },
  {
    id: 'q-short-keyed',
    type: 'short_answer',
    question: 'Name it',
    answer: [SECRET_SHORT_ANSWER],
    commentPrompt: SECRET_RUBRIC,
    hasAnswer: true,
  },
  {
    id: 'q-short-open',
    type: 'short_answer',
    question: 'Explain',
    commentPrompt: SECRET_RUBRIC,
    hasAnswer: false,
    points: 4,
  },
];

// Owner decision (17 Nov 2026): the pinned teacher guide behind the written questions.
const GUIDE_ID = 'tg-quiz';
const MODEL_PROOF = 'MODEL-PROOF الفرق ثابت ويساوي 3';
const MODEL_POSSIBLE = 'MODEL-POSSIBLE مثال مضاد هو 2';
const MODEL_FIGURE_NOTE = 'MODEL-FIGURE-NOTE';
const MODEL_LONG = 'MODEL-LONG برهان';
const PINNED_GUIDE: KafuoTeacherGuide = {
  guideId: GUIDE_ID,
  items: [
    {
      contentUnitId: '6234',
      label: '1B',
      status: 'reference',
      modelAnswer: { kind: 'proof', text: MODEL_PROOF },
    },
    {
      contentUnitId: '6249',
      label: '12',
      status: 'reference',
      modelAnswer: { kind: 'possible', text: MODEL_POSSIBLE },
    },
    {
      contentUnitId: '6249',
      label: '13',
      status: 'reference',
      modelAnswer: {
        kind: 'figure',
        image: { checksumSha256: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 10 },
        text: MODEL_FIGURE_NOTE,
      },
    },
    {
      contentUnitId: '6249',
      label: '11',
      status: 'approved',
      answer: { type: 'number', value: 5 },
    },
    {
      contentUnitId: '6249',
      label: '14',
      status: 'reference',
      modelAnswer: { kind: 'proof', text: MODEL_LONG },
    },
  ],
};
const writtenId = (contentUnitId: string, label: string) =>
  guideWrittenQuestionId(GUIDE_ID, { contentUnitId, label });
const PROOF_STEM = 'اكتب البرهان بنفسك خطوةً بخطوة، مع سبب كل خطوة:\nأثبت أن الفرق ثابت.';
const POSSIBLE_STEM = 'اكتب إجابتك بنفسك، بكلماتك:\nأعطِ مثالًا مضادًا.';
const written = (id: string, question: string): QuizQuestion => ({
  id,
  type: 'short_answer',
  question,
  hasAnswer: false,
  points: 2,
});
const GUIDED_QUESTIONS: QuizQuestion[] = [
  QUESTIONS[0]!,
  written(writtenId('6234', '1B'), PROOF_STEM),
  // An editor's note is never revealed on a written question.
  { ...written(writtenId('6249', '12'), POSSIBLE_STEM), analysis: SECRET_EXPLANATION },
  written(writtenId('6249', '13'), 'ارسم التمثيل.'),
  written(writtenId('6249', '11'), 'اكتب الناتج.'),
  written(writtenId('6249', '14'), 'س'.repeat(4_001)),
  QUESTIONS[3]!,
];

function quizScene(stageId: string, questions: QuizQuestion[] = QUESTIONS): AppScene {
  const base = makeSlideScene('scene-quiz', stageId, 2, 'Quiz');
  return { ...base, type: 'quiz', content: { type: 'quiz', questions } } as AppScene;
}

const FORBIDDEN_KEYS = new Set(['answer', 'analysis', 'commentPrompt', 'hasAnswer']);

/** Every forbidden key or secret literal anywhere in [value]. */
function leaks(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    return [
      SECRET_SHORT_ANSWER,
      SECRET_EXPLANATION,
      SECRET_RUBRIC,
      // Owner (17 Nov 2026): a guide model answer, anywhere.
      'MODEL-',
    ].some((s) => value.includes(s))
      ? [path]
      : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry, i) => leaks(entry, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [
      ...(FORBIDDEN_KEYS.has(key) ? [`${path}.${key}`] : []),
      ...leaks(entry, `${path}.${key}`),
    ]);
  }
  return [];
}

// --------------------------------------------------------------------------
// Pure behaviour
// --------------------------------------------------------------------------

describe('sanitizeLearnerDelivery', () => {
  it('keeps only render fields, deeply, and never mutates its input', () => {
    const document = { stage: { id: STAGE }, scenes: [quizScene(STAGE)] };
    const before = JSON.stringify(document);
    const delivered = sanitizeLearnerDelivery(document) as typeof document;
    expect(JSON.stringify(document)).toBe(before);
    expect(delivered).not.toBe(document);
    expect(leaks(delivered)).toEqual([]);
    const questions = (delivered.scenes[0]!.content as { questions: unknown[] }).questions;
    expect(questions[0]).toEqual({
      id: 'q-single',
      type: 'single',
      question: 'Pick one',
      options: [
        { label: 'Alpha', value: 'A' },
        { label: 'Beta', value: 'B' },
      ],
      points: 2,
    });
    expect(questions[2]).toEqual({
      id: 'q-short-keyed',
      type: 'short_answer',
      question: 'Name it',
    });
  });

  it('withholds a grading field added later (allowlist, not denylist)', () => {
    const scene = quizScene(STAGE, [
      { ...QUESTIONS[0]!, rubricV2: 'future secret' } as QuizQuestion,
    ]);
    const delivered = sanitizeLearnerDelivery(scene) as AppScene;
    expect(JSON.stringify(delivered)).not.toContain('future secret');
  });

  it('withholds any guide reference, on a question or beside the questions (owner, 17 Nov 2026)', () => {
    const scene = quizScene(STAGE, [
      { ...QUESTIONS[3]!, guideRef: { contentUnitId: '6234', label: '1B' } } as QuizQuestion,
    ]);
    const stamped = {
      ...scene,
      content: { ...scene.content, guideRefs: { 'q-short-open': { label: '1B' } } },
    };
    const delivered = JSON.stringify(sanitizeLearnerDelivery(stamped));
    expect(delivered).not.toContain('guideRef');
    expect(delivered).not.toContain('6234');
    expect(delivered).not.toContain('1B');
  });
});

describe('normalizeAnswerText (parity with the Kafuo app)', () => {
  it.each([
    ['مَدْرَسَة', 'مدرسه'],
    ['أحمد', 'احمد'],
    ['إسلام', 'اسلام'],
    ['مصطفى', 'مصطفي'],
    ['٢٠٢٤', '2024'],
    ['۱۲', '12'],
    ['  Hello   World ', 'hello world'],
    ['كتـــاب', 'كتاب'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAnswerText(input)).toBe(expected);
  });
});

describe('gradeQuizQuestions', () => {
  const grade = (answers: Record<string, string[]>, reveal = false) =>
    gradeQuizQuestions(QUESTIONS, answers, reveal);

  it('grades every type and keeps pending short answers out of the score', () => {
    const result = grade({
      'q-single': ['B'],
      'q-multi': ['C', 'A'],
      'q-short-keyed': ['  التَّخمين الإستقرائي '],
      'q-short-open': ['my explanation'],
    });
    expect(result.results.map((r) => [r.questionId, r.status, r.earned, r.possible])).toEqual([
      ['q-single', 'correct', 2, 2],
      ['q-multi', 'correct', 3, 3],
      ['q-short-keyed', 'correct', 1, 1],
      ['q-short-open', 'pending_review', 0, 4],
    ]);
    expect(result.earned).toBe(6);
    expect(result.possible).toBe(6);
    expect(result.pendingPossible).toBe(4);
  });

  it('marks wrong, partial, over-selected, foreign and blank answers', () => {
    const result = grade({
      'q-single': ['A', 'B'],
      'q-multi': ['A'],
      'q-short-keyed': ['wrong'],
    });
    expect(result.results.map((r) => r.status)).toEqual([
      'incorrect',
      'incorrect',
      'incorrect',
      'pending_review',
    ]);
    expect(grade({ 'q-single': ['Z'] }).results[0]!.status).toBe('incorrect');
    expect(grade({ 'q-single': ['   '] }).results[0]!.status).toBe('unanswered');
    expect(grade({}).results.map((r) => r.status)).toEqual([
      'unanswered',
      'unanswered',
      'unanswered',
      'pending_review',
    ]);
  });

  it('does not accept a label where the key expects a value', () => {
    expect(grade({ 'q-single': ['Beta'] }).results[0]!.status).toBe('incorrect');
  });

  it('reports an unresolvable choice key as not_gradable, never as wrong', () => {
    const broken = gradeQuizQuestions(
      [{ ...QUESTIONS[0]!, answer: ['Nope'] }],
      { 'q-single': ['A'] },
      false,
    );
    expect(broken.results[0]).toMatchObject({ status: 'not_gradable', earned: 0 });
    expect(broken.possible).toBe(0);
    expect(broken.pendingPossible).toBe(2);
  });

  it('reveals keys and explanations only when asked', () => {
    const hidden = grade({ 'q-single': ['A'] });
    expect(leaks(hidden)).toEqual([]);
    expect(hidden.results[0]).not.toHaveProperty('correctAnswer');
    const shown = grade({ 'q-single': ['A'] }, true);
    expect(shown.results[0]).toMatchObject({
      correctAnswer: ['B'],
      explanation: SECRET_EXPLANATION,
    });
    expect(shown.results[1]).toMatchObject({ correctAnswer: ['A', 'C'] });
  });

  it('never reveals anything on a guide written question, even when asked', () => {
    const written: QuizQuestion = {
      id: guideWrittenQuestionId('tg-quiz', { contentUnitId: '6234', label: '1B' }),
      type: 'short_answer',
      question: 'اكتب البرهان بنفسك',
      answer: [MODEL_PROOF],
      analysis: MODEL_PROOF,
      points: 2,
    };
    const shown = gradeQuizQuestions([written], { [written.id]: ['x'] }, true);
    expect(shown.results[0]).toEqual({
      questionId: written.id,
      status: 'incorrect',
      earned: 0,
      possible: 2,
    });
    expect(JSON.stringify(shown)).not.toContain(MODEL_PROOF);
  });

  it('refuses question ids that are not in the scene', () => {
    expect(() => grade({ 'q-forged': ['A'] })).toThrow(
      expect.objectContaining({ code: 'QUIZ_QUESTION_NOT_IN_SCENE' }),
    );
  });

  it('bounds and type-checks the untrusted answers map', () => {
    expect(() => parseLearnerAnswers(['A'])).toThrow();
    expect(() => parseLearnerAnswers({ q: 'A' })).toThrow();
    expect(() => parseLearnerAnswers({ q: [1] })).toThrow();
    expect(() => parseLearnerAnswers({ q: ['x'.repeat(2_001)] })).toThrow();
    expect(parseLearnerAnswers({ q: ['A'] })).toEqual({ q: ['A'] });
  });
});

// --------------------------------------------------------------------------
// Over HTTP: the Stage a learner receives, and the grading route
// --------------------------------------------------------------------------

describe('learner quiz over HTTP', () => {
  let pool: PGlitePool;
  const qp = () => pool as never;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://learner-quiz-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    vi.doMock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
      getOwnerScopedDocumentStore: async () =>
        createOwnerBoundDocumentStore<AppScene, AppStage>({
          pool: pool as never,
          ownerId: TEACHING_PACKAGE_STAGE_OWNER,
          validateScene: validateAppScene,
          validateStage: validateAppStage,
        }),
    }));

    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(STAGE, 'Quiz lesson', [makeSlideScene('scene-1', STAGE, 1), quizScene(STAGE)]),
    );
    // The successor's quiz has a DIFFERENT key: grading must use the pinned one.
    await store.saveDocument(
      makeDocument(STAGE_V2, 'Quiz lesson v2', [
        quizScene(STAGE_V2, [{ ...QUESTIONS[0]!, answer: ['A'] }]),
      ]),
    );
    await store.saveDocument(
      makeDocument('stage-quiz-draft', 'Draft', [quizScene('stage-quiz-draft')]),
    );
    for (const [id, status, stageId, version] of [
      ['tpv-quiz-v1', 'superseded', STAGE, 1],
      ['tpv-quiz-v2', 'approved', STAGE_V2, 2],
    ] as const) {
      await insertVersion(qp(), {
        id,
        aggregate: { tenantId: TENANT, learningItem: { type: 'lesson', id: 'li-quiz' } },
        version,
        status,
        currentStageId: stageId,
        teachingModel: { key: 'g5', version: 'g5.v3' },
        now: 1,
      });
    }
    await insertVersion(qp(), {
      id: 'tpv-quiz-draft',
      aggregate: { tenantId: TENANT, learningItem: { type: 'lesson', id: 'li-quiz-2' } },
      version: 1,
      status: 'draft',
      currentStageId: 'stage-quiz-draft',
      teachingModel: { key: 'g5', version: 'g5.v3' },
      now: 1,
    });

    // Owner (17 Nov 2026): a g5.v11 package whose attempt pinned a teacher guide, and its
    // review-edit successor (no attempt of its own: the pin is its predecessor's).
    const guided = { tenantId: TENANT, learningItem: { type: 'lesson' as const, id: 'li-guided' } };
    const v11 = { key: 'g5', version: 'g5.v11' };
    for (const stageId of ['stage-guided', 'stage-guided-v2']) {
      await store.saveDocument(
        makeDocument(stageId, 'Guided lesson', [quizScene(stageId, GUIDED_QUESTIONS)]),
      );
    }
    await insertAttempt(qp(), {
      id: 'tpa-guided',
      aggregate: guided,
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: v11,
      inputSnapshot: {
        learningItem: guided.learningItem,
        teachingModel: v11,
        learningObjectives: [],
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
        teacherGuide: PINNED_GUIDE,
      } as never,
      now: 1,
    });
    await insertVersion(qp(), {
      id: 'tpv-guided',
      aggregate: guided,
      version: 1,
      status: 'superseded',
      currentStageId: 'stage-guided',
      currentAttemptId: 'tpa-guided',
      teachingModel: v11,
      now: 1,
    });
    await insertVersion(qp(), {
      id: 'tpv-guided-v2',
      aggregate: guided,
      version: 2,
      status: 'approved',
      currentStageId: 'stage-guided-v2',
      predecessorVersionId: 'tpv-guided',
      teachingModel: v11,
      now: 2,
    });
  });

  afterEach(async () => {
    vi.doUnmock('@/lib/server/agent-runtime/owner-scoped-documents');
    await pool.end();
    vi.unstubAllEnvs();
  });

  function grantCookie(
    purpose: 'learner' | 'preview' | 'edit',
    capability: 'read' | 'write',
    versionId = 'tpv-quiz-v1',
    stageId = STAGE,
  ) {
    const { token } = buildEditorGrantPayload({
      tenantId: TENANT,
      versionId,
      stageId,
      capability,
      purpose,
    });
    return `teaching_package_grant=${encodeURIComponent(
      grantCookieValueForRedeem(new Headers(), token, stageId),
    )}`;
  }

  async function read(path: string, cookie: string): Promise<unknown> {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const response = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence${path}`, { headers: { cookie } }),
      { poolFactory: () => pool as never },
    );
    expect(response.status).toBe(200);
    // Learner and preview bodies differ at the same URL: never cacheable across grants.
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    // The HTTP body itself, not an in-memory object.
    return JSON.parse(await response.text());
  }

  async function gradeRoute(versionId: string, body: unknown, key = SERVICE_KEY) {
    const { POST } = await import('@/app/api/teaching-packages/[id]/quiz-grades/route');
    return POST(
      new NextRequest(`http://localhost/api/teaching-packages/${versionId}/quiz-grades`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: versionId }) },
    );
  }

  it('serves a learner no answer keys, explanations or rubrics — whole document and single scene', async () => {
    const cookie = grantCookie('learner', 'read');
    const document = await read(`/documents/${STAGE}`, cookie);
    expect(leaks(document)).toEqual([]);
    const scenes = (document as { scenes: AppScene[] }).scenes;
    const quiz = scenes.find((scene) => scene.id === 'scene-quiz')!;
    expect((quiz.content as { questions: unknown[] }).questions).toHaveLength(4);

    expect(leaks(await read(`/documents/${STAGE}/scenes/scene-quiz`, cookie))).toEqual([]);
  });

  it('keeps the keys for preview and edit grants', async () => {
    for (const cookie of [grantCookie('preview', 'read'), grantCookie('edit', 'write')]) {
      const document = await read(`/documents/${STAGE}`, cookie);
      expect(leaks(document).length).toBeGreaterThan(0);
    }
  });

  it('grades through the route against the pinned (superseded) version, statelessly', async () => {
    const body = {
      tenantContext: { tenantId: TENANT },
      sceneId: 'scene-quiz',
      answers: { 'q-single': ['B'], 'q-short-open': ['because'] },
    };
    const first = await gradeRoute('tpv-quiz-v1', body);
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result).toMatchObject({ versionId: 'tpv-quiz-v1', stageId: STAGE, earned: 2 });
    expect(result.results.map((r: { status: string }) => r.status)).toEqual([
      'correct',
      'unanswered',
      'unanswered',
      'pending_review',
    ]);
    expect(leaks(result)).toEqual([]);
    // Same submission, same answer: retries are safe.
    expect(await (await gradeRoute('tpv-quiz-v1', body)).json()).toEqual(result);

    // The newer version's key calls 'B' wrong: the version named (the pin) decides.
    const newer = await (
      await gradeRoute('tpv-quiz-v2', { ...body, answers: { 'q-single': ['B'] } })
    ).json();
    expect(newer.results[0].status).toBe('incorrect');
  });

  it('ignores client-supplied scores, keys and verdicts', async () => {
    const tampered = await gradeRoute('tpv-quiz-v1', {
      tenantContext: { tenantId: TENANT },
      sceneId: 'scene-quiz',
      answers: { 'q-single': ['A'] },
      points: 999,
      earned: 999,
      correct: true,
      questions: [{ id: 'q-single', answer: ['A'], points: 999 }],
    });
    const result = await tampered.json();
    expect(result.results[0]).toMatchObject({ status: 'incorrect', earned: 0, possible: 2 });
    expect(result.earned).toBe(0);
  });

  it('refuses a draft version, a foreign tenant, a non-quiz scene, a forged question and a bad key', async () => {
    const base = { tenantContext: { tenantId: TENANT }, sceneId: 'scene-quiz', answers: {} };
    const codes = async (response: Response) => [
      response.status,
      (await response.json()).error?.code,
    ];
    expect(await codes(await gradeRoute('tpv-quiz-draft', base))).toEqual([
      409,
      'TEACHING_PACKAGE_NOT_APPROVED',
    ]);
    expect(
      await codes(
        await gradeRoute('tpv-quiz-v1', { ...base, tenantContext: { tenantId: 'other' } }),
      ),
    ).toEqual([404, 'NOT_FOUND']);
    expect(await codes(await gradeRoute('tpv-quiz-v1', { ...base, sceneId: 'scene-1' }))).toEqual([
      404,
      'QUIZ_SCENE_NOT_FOUND',
    ]);
    expect(
      await codes(await gradeRoute('tpv-quiz-v1', { ...base, answers: { 'q-forged': ['A'] } })),
    ).toEqual([422, 'QUIZ_QUESTION_NOT_IN_SCENE']);
    expect((await gradeRoute('tpv-quiz-v1', base, 'wrong-key')).status).toBe(401);
  });

  describe('teacher-guide written answers (owner, 17 Nov 2026)', () => {
    const answers = {
      'q-single': ['B'],
      [writtenId('6234', '1B')]: ['البرهان: الفرق 3 في كل مرة'],
      [writtenId('6249', '12')]: ['2'],
      [writtenId('6249', '13')]: ['رسمت'],
      [writtenId('6249', '11')]: ['5'],
      [writtenId('6249', '14')]: ['برهاني'],
      'q-short-open': ['because'],
    };
    const grade = async (versionId: string, reveal: boolean) => {
      const response = await gradeRoute(versionId, {
        tenantContext: { tenantId: TENANT },
        sceneId: 'scene-quiz',
        answers,
        reveal,
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    it('gives a pending written answer its context from the PINNED guide, scores untouched', async () => {
      for (const versionId of ['tpv-guided', 'tpv-guided-v2']) {
        const result = await grade(versionId, true);
        const byId = new Map(
          (result.results as Array<Record<string, unknown>>).map((r) => [r.questionId, r]),
        );
        expect(byId.get(writtenId('6234', '1B'))).toEqual({
          questionId: writtenId('6234', '1B'),
          status: 'pending_review',
          earned: 0,
          possible: 2,
          gradingContext: { questionText: PROOF_STEM, modelAnswer: MODEL_PROOF, kind: 'proof' },
        });
        // Never a revealed answer or explanation, even under `reveal`.
        expect(byId.get(writtenId('6249', '12'))).toEqual({
          questionId: writtenId('6249', '12'),
          status: 'pending_review',
          earned: 0,
          possible: 2,
          gradingContext: {
            questionText: POSSIBLE_STEM,
            modelAnswer: MODEL_POSSIBLE,
            kind: 'possible',
          },
        });
        // A figure, a keyed item, an over-long stem and a plain short answer: no context.
        for (const id of [
          writtenId('6249', '13'),
          writtenId('6249', '11'),
          writtenId('6249', '14'),
          'q-short-open',
        ]) {
          expect(byId.get(id)).toMatchObject({ status: 'pending_review', earned: 0 });
          expect(byId.get(id)).not.toHaveProperty('gradingContext');
          expect(byId.get(id)).not.toHaveProperty('correctAnswer');
        }
        expect(result).toMatchObject({ earned: 2, possible: 2, pendingPossible: 14 });
        // The model answers appear ONLY as the two contexts' `modelAnswer`.
        const withoutContexts = {
          ...result,
          results: (result.results as Array<Record<string, unknown>>).map(
            ({ gradingContext: _context, ...rest }) => rest,
          ),
        };
        // (`reveal` shows the choice question's own explanation, never a model answer.)
        expect(JSON.stringify(withoutContexts)).not.toContain('MODEL-');
        expect(byId.get('q-single')).toMatchObject({ explanation: SECRET_EXPLANATION });
        expect(JSON.stringify(result)).not.toContain(MODEL_FIGURE_NOTE);
        expect(JSON.stringify(result)).not.toContain(MODEL_LONG);
      }
    });

    it('reads no guide for a package without one, and never serves a learner the model answer', async () => {
      const plain = await gradeRoute('tpv-quiz-v1', {
        tenantContext: { tenantId: TENANT },
        sceneId: 'scene-quiz',
        answers: { 'q-short-open': ['because'] },
        reveal: true,
      });
      const body = await plain.json();
      expect(JSON.stringify(body)).not.toContain('gradingContext');

      const cookie = grantCookie('learner', 'read', 'tpv-guided-v2', 'stage-guided-v2');
      const document = await read('/documents/stage-guided-v2', cookie);
      expect(leaks(document)).toEqual([]);
      const delivered = JSON.stringify(document);
      expect(delivered).not.toContain('gradingContext');
      expect(delivered).not.toContain('guideRef');
      const quiz = (document as { scenes: AppScene[] }).scenes[0]!;
      expect((quiz.content as { questions: Array<{ id: string }> }).questions[1]).toEqual({
        id: writtenId('6234', '1B'),
        type: 'short_answer',
        question: PROOF_STEM,
        points: 2,
      });
    });
  });
});

describe('learner delivery of narration provenance (SATTS W1-5)', () => {
  it('passes SpeechAction.audioProvenance and Stage speech metadata through unchanged', () => {
    const audioProvenance = {
      fingerprint: 'fp1:abc',
      policyVersion: null,
      originalDigest: 'o',
      responseFormat: 'mp3',
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
      voice: 'alloy',
      speed: 1,
      preparedDigest: 'p',
      segments: 1,
      preparedChars: 5,
      originalChars: 5,
      warningCount: 0,
      generatedAt: '2026-09-28T00:00:00.000Z',
      reason: 'initial',
    };
    const document = {
      stage: { id: 's', subjectCode: 'MATH', speechReadingMode: 'natural' },
      scenes: [
        {
          id: 'sc',
          actions: [{ id: 'a', type: 'speech', text: 'hello', audioId: 'x', audioProvenance }],
        },
      ],
    };
    expect(sanitizeLearnerDelivery(document)).toEqual(document);
  });
});
