import { APICallError } from 'ai';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { readFinalize } from '@/lib/persistence/meter-finalize-outbox';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  insertAttempt,
  insertVersion,
  upsertContentUnits,
  upsertSourceContext,
  type ContentUnitInput,
} from '@/lib/persistence/teaching-package';
import {
  readAttempt,
  type TeachingModelAttemptRow,
} from '@/lib/persistence/teaching-model-attempts';
import {
  readHelpMessageByClientId,
  readHelpMessagesBySeq,
  readTurnGrounding,
} from '@/lib/persistence/tutor-runtime';
import { resetLedgerRetryQueueForTests } from '@/lib/server/teaching-model/ledger-retry-queue';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import { buildEditorGrantPayload } from '@/lib/server/teaching-package/editor-grant';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { SAFETY_BOUNDARY_MESSAGE } from '@/lib/server/tutor/experiment-guard';
import { resetTurnRateLimitForTests } from '@/lib/server/tutor/rate-limit';
import { setTutorRuntimeDepsForTests } from '@/lib/server/tutor/runtime-deps';
import type { LearnerStudentContext } from '@/lib/server/tutor/student-context';
import { countTokens, effectiveCap, UNIT_CHAR_CAP } from '@/lib/server/tutor/token-budget';
import { HELP_SCOPE_TEXT, PARTIAL_SCENE_COVERAGE_TEXT } from '@/lib/server/tutor/tutor-rules';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';

import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';
import {
  asConnectable,
  createTutorPool,
  fakeKafuo,
  readSse,
  RecordingPool,
  STUDENT_REF,
  streamOf,
  studentBearer,
  T0_MS,
  textStream,
  type FakeKafuo,
} from './tutor-test-harness';

/**
 * Stage Help routes (contracts §0 H2, §2.2, §5; plan §8.3, §8.7 step 4, P7,
 * §11 row "Scene-grounded Help and lineage"). PGlite with the REAL
 * teaching-package + document schemas (versions, attempts, retained units,
 * Stage documents), a mocked `@/lib/ai/llm` (the exact provider request is
 * captured), a fake Kafuo client whose `groundingSearch` must never be
 * called, and learner grant cookies pinning a version + Stage.
 */

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  streamLLM: vi.fn(),
  events: [] as string[],
  assembled: [] as Array<{
    messages: unknown[];
    budget: { estimate: number; counterKind: 'exact' | 'proxy'; effectiveCap: number };
  }>,
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM, streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', async () => {
  const providers = await import('@/lib/ai/providers');
  return {
    resolveModel: async ({ modelString }: { modelString: string }) => {
      const { providerId, modelId } = providers.parseModelString(modelString);
      return {
        model: { provider: providerId, modelId },
        modelInfo: providers.getModelInfo(providerId, modelId),
        modelString,
        providerId,
        modelId,
        apiKey: 'k',
      };
    },
  };
});
vi.mock('@/lib/server/tutor/prompt-assembly', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/tutor/prompt-assembly')>();
  return {
    ...actual,
    assembleTutorPrompt: (input: Parameters<typeof actual.assembleTutorPrompt>[0]) => {
      mocks.events.push('assemble');
      const result = actual.assembleTutorPrompt(input);
      mocks.assembled.push(result);
      return result;
    },
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const SERVICE_KEY = 'help-routes-svc-key';
const TENANT = '1';
const MODEL = { key: 'g5', version: 'g5.v1' };
let t = T0_MS;
const now = () => t;

const STUDENT: LearnerStudentContext = {
  studentRef: STUDENT_REF,
  academic: {
    curriculumName: 'المنهج الوطني',
    curriculumVersionLabel: '2026',
    gradeLabel: 'الصف التاسع',
  },
  subject: { code: 'CHEMISTRY', nameAr: 'الكيمياء', nameEn: 'Chemistry', academicLanguage: 'ar' },
  localeHint: 'ar',
  entitlements: { help: true },
};

const UNIT_TEXT = {
  'cu-1': 'قانون حفظ الكتلة: كتلة المواد المتفاعلة تساوي كتلة المواد الناتجة في أي تفاعل كيميائي.',
  'cu-2': 'عند احتراق الماغنسيوم في الهواء تبقى الكتلة الكلية للنظام محفوظة.',
  'cu-3': 'المعادلة الكيميائية الموزونة تعبّر عن حفظ الكتلة بعدد الذرات.',
} as const;

function apiError(statusCode: number) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://provider.example',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

function cookieFor(...tokens: string[]): string {
  return `teaching_package_grant=${encodeURIComponent(JSON.stringify(tokens))}`;
}

function learnerCookie(options: {
  versionId: string;
  stageId: string;
  student?: LearnerStudentContext | undefined;
  purpose?: 'learner' | 'preview';
  learnerRef?: string;
}): string {
  const { token } = buildEditorGrantPayload({
    tenantId: TENANT,
    versionId: options.versionId,
    stageId: options.stageId,
    capability: 'read',
    purpose: options.purpose ?? 'learner',
    learnerRef: options.learnerRef ?? 'learner-ref-0123456789abcdef',
    ...('student' in options ? { student: options.student } : { student: STUDENT }),
    now: T0_MS,
  });
  return cookieFor(token);
}

function unit(unitId: string, text: string, title: string | null = null): ContentUnitInput {
  return {
    unitId,
    orderIndex: Number(unitId.replace(/\D/g, '')) || 0,
    role: 'CONCEPT',
    normalizedText: text,
    ...(title ? { title } : {}),
  };
}

function scene(
  id: string,
  stageId: string,
  order: number,
  options: { title?: string; unitIds?: string[]; text?: string } = {},
): AppScene {
  return {
    ...makeSlideScene(id, stageId, order, options.title ?? `Scene ${id}`),
    ...(options.unitIds ? { sourceContentUnitIds: options.unitIds } : {}),
    ...(options.text ? { actions: [{ id: `a-${id}`, type: 'speech', text: options.text }] } : {}),
  } as AppScene;
}

describe('Stage Help routes', () => {
  let pool: RecordingPool;
  let kafuo: FakeKafuo;
  let ids: number;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;
  const qp = () => pool as never;

  const documents = () =>
    createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });

  const aggregate = () => ({
    tenantId: TENANT,
    learningItem: { type: 'lesson' as const, id: unique('li') },
  });

  async function attempt(
    agg: ReturnType<typeof aggregate>,
    options: {
      sourceKind: 'kafuo_normalized' | 'pdf_fallback';
      units?: ContentUnitInput[];
      versionId?: string | null;
    },
  ) {
    const id = unique('tpa');
    await insertAttempt(qp(), {
      id,
      aggregate: agg,
      versionId: options.versionId ?? null,
      kind: options.versionId ? 'regeneration' : 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: MODEL,
      inputSnapshot: {
        learningItem: agg.learningItem,
        teachingModel: MODEL,
        learningObjectives: [],
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
        subjectCode: 'CHEMISTRY',
      },
      now: 1,
    });
    await upsertSourceContext(qp(), {
      tenantId: TENANT,
      attemptId: id,
      contentResourceId: 'cs-1',
      measuredSha256: 'a'.repeat(64),
      text: 'source',
      sourceKind: options.sourceKind,
    });
    if (options.units)
      await upsertContentUnits(qp(), { tenantId: TENANT, attemptId: id, units: options.units });
    return id;
  }

  async function stage(name: string, build: (stageId: string) => AppScene[]) {
    const stageId = unique('stage');
    await documents().saveDocument(makeDocument(stageId, name, build(stageId)));
    return stageId;
  }

  async function version(
    agg: ReturnType<typeof aggregate>,
    options: {
      version: number;
      status: TeachingPackageStatus;
      currentAttemptId: string | null;
      stageId: string;
      predecessorVersionId?: string;
    },
  ) {
    const id = unique('tpv');
    await insertVersion(qp(), {
      id,
      aggregate: agg,
      version: options.version,
      status: options.status,
      currentStageId: options.stageId,
      currentAttemptId: options.currentAttemptId,
      ...(options.predecessorVersionId
        ? { predecessorVersionId: options.predecessorVersionId }
        : {}),
      teachingModel: MODEL,
      now: 1,
    });
    return id;
  }

  /** The default lesson: one generated attempt with cu-1..cu-3 and a Stage whose scenes cite them in different ways. */
  async function seedLesson(options: { status?: TeachingPackageStatus } = {}) {
    const agg = aggregate();
    const attemptId = await attempt(agg, {
      sourceKind: 'kafuo_normalized',
      units: [
        unit('cu-1', UNIT_TEXT['cu-1'], 'حفظ الكتلة'),
        unit('cu-2', UNIT_TEXT['cu-2'], 'احتراق الماغنسيوم'),
        unit('cu-3', UNIT_TEXT['cu-3']),
      ],
    });
    const stageId = await stage('قانون حفظ الكتلة', (sid) => [
      scene('sc-1', sid, 1, {
        title: 'حفظ الكتلة في التفاعلات',
        unitIds: ['cu-2', 'cu-1'],
        text: 'كتلة المتفاعلات تساوي كتلة النواتج.',
      }),
      scene('sc-unbound', sid, 2, { title: 'بلا ربط' }),
      scene('sc-partial', sid, 3, { title: 'جزئي', unitIds: ['cu-1', 'cu-9'] }),
      scene('sc-missing', sid, 4, { title: 'مفقود', unitIds: ['cu-9'] }),
    ]);
    const versionId = await version(agg, {
      version: 1,
      status: options.status ?? 'approved',
      currentAttemptId: attemptId,
      stageId,
    });
    return { agg, attemptId, stageId, versionId, cookie: learnerCookie({ versionId, stageId }) };
  }

  async function turn(
    body: Record<string, unknown>,
    cookie: string | null,
    extraHeaders: Record<string, string> = {},
  ) {
    const { POST } = await import('@/app/api/tutor/help/turns/route');
    return POST(
      new NextRequest('http://localhost/api/tutor/help/turns', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async function sessions(
    query: Record<string, string>,
    cookie: string | null,
    extraHeaders: Record<string, string> = {},
  ) {
    const { GET } = await import('@/app/api/tutor/help/sessions/route');
    const search = new URLSearchParams(query).toString();
    return GET(
      new NextRequest(`http://localhost/api/tutor/help/sessions?${search}`, {
        headers: { ...(cookie ? { cookie } : {}), ...extraHeaders },
      }),
    );
  }

  const anchorBody = (
    seed: { versionId: string; stageId: string },
    sceneId = 'sc-1',
    rest: Record<string, unknown> = {},
  ) => ({
    versionId: seed.versionId,
    stageId: seed.stageId,
    sceneId,
    clientMessageId: 'cm-1',
    text: 'ليه كتلة المتفاعلات تساوي كتلة النواتج؟',
    ...rest,
  });

  const turnRows = async (turnId: string) => {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM teaching_model_attempts WHERE turn_id = $1 ORDER BY attempt_index`,
      [turnId],
    );
    const rows: TeachingModelAttemptRow[] = [];
    for (const row of result.rows) rows.push((await readAttempt(pool, row.id))!);
    return rows;
  };

  const ledgerCount = async () =>
    Number(
      (await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM teaching_model_attempts'))
        .rows[0]!.n,
    );

  const sentMessages = (call = 0) =>
    mocks.streamLLM.mock.calls[call]![0].messages as Array<{ role: string; content: string }>;
  const sentText = (call = 0) =>
    sentMessages(call)
      .map((m) => m.content)
      .join('\n');

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    vi.stubEnv('DATABASE_URL', 'postgres://help-routes-test');
    vi.stubEnv('TUTOR_COMPACTION_ENABLED', 'false');
    mocks.callLLM.mockReset();
    mocks.streamLLM.mockReset();
    mocks.events.length = 0;
    mocks.assembled.length = 0;
    resetLedgerRetryQueueForTests();
    resetTurnRateLimitForTests();
    t = T0_MS;
    ids = 0;
    pool = await createTutorPool(mocks.events, { packageSchema: true });
    mocks.events.length = 0;
    kafuo = fakeKafuo(mocks.events);
    const store = documents();
    setTutorRuntimeDepsForTests({
      pool: asConnectable(pool),
      kafuo: kafuo.client,
      now,
      workerId: 'host:1:test',
      idFactory: () => `id-${++ids}`,
      executor: {
        rateCard: BASE_RATE_CARD,
        completionRetryDelaysMs: [0, 0, 0],
        idFactory: () => `tma-${++ids}`,
      },
      heartbeatMs: 0,
      completionTxRetryDelaysMs: [0, 0],
      loadStageDocument: (stageId) => store.loadDocument(stageId),
    });
  });

  afterEach(async () => {
    // Help never retrieves: the Scene's own units are the only evidence (HLP-02).
    expect(kafuo.groundingSearch).not.toHaveBeenCalled();
    setTutorRuntimeDepsForTests(undefined);
    await pool.end();
  });

  describe('guards and anchor binding', () => {
    it('answers 404 when the Teaching Package API is off, 401 without a learner grant or with a student bearer (both routes)', async () => {
      const seed = await seedLesson();
      vi.stubEnv('DATABASE_URL', '');
      expect((await turn(anchorBody(seed), seed.cookie)).status).toBe(404);
      expect(
        (
          await sessions(
            { versionId: seed.versionId, stageId: seed.stageId, sceneId: 'sc-1' },
            seed.cookie,
          )
        ).status,
      ).toBe(404);
      vi.stubEnv('DATABASE_URL', 'postgres://help-routes-test');
      expect((await turn(anchorBody(seed), null)).status).toBe(401);
      expect(
        (
          await sessions(
            { versionId: seed.versionId, stageId: seed.stageId, sceneId: 'sc-1' },
            null,
          )
        ).status,
      ).toBe(401);
      // A student grant is a different credential kind: refused, never interchangeable.
      const asStudent = await turn(anchorBody(seed), null, { authorization: studentBearer() });
      expect(asStudent.status).toBe(401);
      await expect(asStudent.json()).resolves.toMatchObject({ error: { code: 'GRANT_INVALID' } });
      expect(
        (
          await sessions(
            { versionId: seed.versionId, stageId: seed.stageId, sceneId: 'sc-1' },
            null,
            { authorization: studentBearer() },
          )
        ).status,
      ).toBe(401);
      // A learner grant without the student block, or a preview grant, cannot act.
      expect(
        (
          await turn(
            anchorBody(seed),
            learnerCookie({ versionId: seed.versionId, stageId: seed.stageId, student: undefined }),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await turn(
            anchorBody(seed),
            learnerCookie({ versionId: seed.versionId, stageId: seed.stageId, purpose: 'preview' }),
          )
        ).status,
      ).toBe(401);
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(kafuo.reserve).not.toHaveBeenCalled();
    });

    it('is Stage-bound: a body outside the grant’s pinned (version, stage), or a Scene outside the Stage, is a non-enumerating 404', async () => {
      const seed = await seedLesson();
      const other = await seedLesson();
      // The cookie holds a grant for another Stage only.
      const wrongStage = await turn(anchorBody(seed), other.cookie);
      expect(wrongStage.status).toBe(404);
      await expect(wrongStage.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
      // The grant's Stage but another version id.
      const wrongVersion = await turn(
        { ...anchorBody(seed), versionId: other.versionId },
        seed.cookie,
      );
      expect(wrongVersion.status).toBe(404);
      // A grant minted for a version whose current Stage is not the granted one.
      const crossed = await turn(
        { ...anchorBody(seed), versionId: other.versionId, stageId: seed.stageId },
        learnerCookie({ versionId: other.versionId, stageId: seed.stageId }),
      );
      expect(crossed.status).toBe(404);
      // A Scene id that is not in the granted Stage.
      const foreignScene = await turn(anchorBody(seed, 'sc-nope'), seed.cookie);
      expect(foreignScene.status).toBe(404);
      await expect(foreignScene.json()).resolves.toMatchObject({ error: { code: 'NOT_FOUND' } });
      // Same on the session read.
      expect(
        (
          await sessions(
            { versionId: other.versionId, stageId: seed.stageId, sceneId: 'sc-1' },
            seed.cookie,
          )
        ).status,
      ).toBe(404);
      expect(await ledgerCount()).toBe(0);
      expect(kafuo.reserve).not.toHaveBeenCalled();
    });

    it('requires an approved or superseded version (a draft pinned by a stale grant is refused)', async () => {
      const seed = await seedLesson({ status: 'draft' });
      const response = await turn(anchorBody(seed), seed.cookie);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'INVALID_TRANSITION' },
      });
    });

    it('takes the subject from the grant’s snapshot: a null code (no routing key) or an unrouted one → 422 SUBJECT_ROUTE_UNAVAILABLE, never a generic model', async () => {
      const seed = await seedLesson();
      for (const code of [null, 'ENGLISH']) {
        const cookie = learnerCookie({
          versionId: seed.versionId,
          stageId: seed.stageId,
          student: { ...STUDENT, subject: { ...STUDENT.subject, code } },
        });
        const response = await turn({ ...anchorBody(seed), sceneId: 'sc-1' }, cookie);
        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: 'SUBJECT_ROUTE_UNAVAILABLE', retryable: false },
        });
      }
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(kafuo.reserve).not.toHaveBeenCalled();
      expect(await ledgerCount()).toBe(0);
    });

    it('validates the body (clientMessageId, text, stepRef, intentHint)', async () => {
      const seed = await seedLesson();
      expect((await turn({ ...anchorBody(seed), clientMessageId: '' }, seed.cookie)).status).toBe(
        400,
      );
      expect((await turn({ ...anchorBody(seed), text: '   ' }, seed.cookie)).status).toBe(400);
      expect((await turn({ ...anchorBody(seed), intentHint: 'solve' }, seed.cookie)).status).toBe(
        400,
      );
      expect((await turn({ ...anchorBody(seed), stepRef: 42 }, seed.cookie)).status).toBe(400);
      expect(
        (await turn({ ...anchorBody(seed), text: 'x'.repeat(4_001) }, seed.cookie)).status,
      ).toBe(422);
    });
  });

  describe('grounding authority (HLP-01/02/04)', () => {
    it('a Scene without a Content Unit binding → 422 HELP_GROUNDING_UNAVAILABLE before any reservation, ledger row or model call', async () => {
      const seed = await seedLesson();
      const response = await turn(anchorBody(seed, 'sc-unbound'), seed.cookie);
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'HELP_GROUNDING_UNAVAILABLE', retryable: false },
      });
      // Likewise when none of the cited ids resolve.
      const missing = await turn(anchorBody(seed, 'sc-missing'), seed.cookie);
      expect(missing.status).toBe(422);
      await expect(missing.json()).resolves.toMatchObject({
        error: { code: 'HELP_GROUNDING_UNAVAILABLE', details: { lineageStatus: 'unavailable' } },
      });
      expect(kafuo.reserve).not.toHaveBeenCalled();
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(await ledgerCount()).toBe(0);
      expect(
        mocks.events.filter(
          (e) => e === 'assemble' || e.startsWith('ledger') || e.startsWith('kafuo'),
        ),
      ).toEqual([]);
      // No session was opened for a refused anchor.
      const read = await sessions(
        { versionId: seed.versionId, stageId: seed.stageId, sceneId: 'sc-unbound' },
        seed.cookie,
      );
      await expect(read.json()).resolves.toEqual({ session: null, messages: [], hasMore: false });
    });

    it('lineage unavailable (pdf_fallback attempt) → refused before any model call and before any reservation', async () => {
      const agg = aggregate();
      const pdf = await attempt(agg, { sourceKind: 'pdf_fallback' });
      const stageId = await stage('pdf', (sid) => [scene('sc-1', sid, 1, { unitIds: ['cu-1'] })]);
      const versionId = await version(agg, {
        version: 1,
        status: 'approved',
        currentAttemptId: pdf,
        stageId,
      });
      const response = await turn(
        anchorBody({ versionId, stageId }),
        learnerCookie({ versionId, stageId }),
      );
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'HELP_GROUNDING_UNAVAILABLE' },
      });
      expect(kafuo.reserve).not.toHaveBeenCalled();
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(await ledgerCount()).toBe(0);
    });
  });

  describe('POST /help/turns — the turn', () => {
    it('streams a Scene-grounded turn: assemble → reserve(help) → started row → model → completion tx → commit → finalize; ledger rows carry the help session and scene', async () => {
      const seed = await seedLesson();
      mocks.streamLLM.mockImplementationOnce(() => {
        mocks.events.push('model');
        return textStream('لأن الذرات لا تفنى ولا تُستحدث في التفاعل.');
      });
      const response = await turn(
        anchorBody(seed, 'sc-1', { stepRef: 'step-2', intentHint: 'explain' }),
        seed.cookie,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const frames = await readSse(response);
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'done']);
      expect(frames[1]!.data).toEqual({ mode: 'scene', lessonTitle: 'قانون حفظ الكتلة' });
      expect(frames[3]!.data).toMatchObject({
        servedBy: 'primary',
        accountingComplete: true,
        safety: { triggered: false },
      });

      const order = mocks.events.filter((e) => !e.startsWith('tx:begin'));
      expect(order.slice(order.indexOf('assemble'), order.indexOf('kafuo:finalize') + 1)).toEqual([
        'assemble',
        'kafuo:reserve',
        'ledger:insert',
        'model',
        'ledger:update',
        'outbox:insert',
        'tx:commit',
        'kafuo:finalize',
      ]);

      // The session exists for the anchor and holds both messages.
      const read = await sessions(
        { versionId: seed.versionId, stageId: seed.stageId, sceneId: 'sc-1' },
        seed.cookie,
      );
      const { session, messages } = (await read.json()) as {
        session: Record<string, unknown>;
        messages: Array<Record<string, unknown>>;
      };
      expect(session).toMatchObject({
        versionId: seed.versionId,
        stageId: seed.stageId,
        sceneId: 'sc-1',
        subjectCode: 'CHEMISTRY',
        status: 'active',
      });
      expect(session).not.toHaveProperty('learnerKey');
      expect(session).not.toHaveProperty('studentRef');
      expect(messages.map((m) => [m.role, m.status])).toEqual([
        ['student', 'completed'],
        ['tutor', 'completed'],
      ]);
      expect(messages[1]).toMatchObject({
        text: 'لأن الذرات لا تفنى ولا تُستحدث في التفاعل.',
        servedBy: 'primary',
        groundingMode: 'scene',
      });
      const helpSessionId = session.id as string;
      const student = (await readHelpMessageByClientId(pool, helpSessionId, 'cm-1'))!;
      expect(student).toMatchObject({
        status: 'completed',
        turnAttempt: 1,
        accountingComplete: true,
        meterReservationId: 'res-1',
        stepRef: 'step-2',
      });
      const stored = await readHelpMessagesBySeq(pool, { parentId: helpSessionId, limit: 10 });
      expect(stored.messages[1]).toMatchObject({ stepRef: 'step-2', turnId: student.turnId });

      // Meter: capability help with the help meter scope, before the started row.
      expect(kafuo.reserve.mock.calls[0]![0]).toMatchObject({
        tenantId: TENANT,
        studentRef: STUDENT_REF,
        capability: 'help',
        meterScope: { helpSessionId, lessonId: seed.agg.learningItem.id },
        turnId: student.turnId,
        turnAttempt: 1,
        clientMessageId: 'cm-1',
      });
      // Finalize delivered after done.
      expect(kafuo.finalize).toHaveBeenCalledTimes(1);
      expect(await readFinalize(pool, 'res-1')).toMatchObject({
        status: 'delivered',
        outcome: 'delivered',
        reason: null,
        turn_id: student.turnId,
        turn_attempt: 1,
      });

      // Ledger: capability help, origin openmaic_runtime, stage help-turn, association block.
      const [row] = await turnRows(student.turnId);
      expect(row).toMatchObject({
        accounting_status: 'complete',
        outcome: 'succeeded',
        capability: 'help',
        stage: 'help-turn',
        origin: 'openmaic_runtime',
        subject_code: 'CHEMISTRY',
        help_session_id: helpSessionId,
        scene_id: 'sc-1',
        student_ref: STUDENT_REF,
        learning_item_type: 'lesson',
        learning_item_id: seed.agg.learningItem.id,
        conversation_id: null,
      });
      expect(row!.budget_estimate_tokens).toBeGreaterThan(0);

      // Grounding audit: own attempt, the two cited units in cited order (cu-2 then cu-1), nothing else.
      const grounding = (await readTurnGrounding(pool, student.turnId))!;
      expect(grounding).toMatchObject({
        mode: 'scene',
        helpSessionId,
        conversationId: null,
        lineageStatus: 'own_attempt',
        resolvedAttemptId: seed.attemptId,
        truncated: false,
      });
      expect(grounding.units.map((u) => u.unitId)).toEqual(['cu-2', 'cu-1']);
      expect(grounding.totalChars).toBe(UNIT_TEXT['cu-1'].length + UNIT_TEXT['cu-2'].length);
      expect(grounding.assessment).toMatchObject({
        decision: 'scene',
        lineageStatus: 'own_attempt',
        candidateCount: 2,
        selectedCount: 2,
        capped: false,
        intentHint: 'explain',
        stepRef: 'step-2',
      });

      // The exact request: Help scope note, Scene title + visible text, the Scene's units (never cu-3), the soft intent hint.
      const sent = sentMessages();
      expect(sent).toEqual(mocks.assembled[0]!.messages);
      const text = sentText();
      expect(text).toContain(HELP_SCOPE_TEXT);
      expect(text).toContain('Scene / المشهد: حفظ الكتلة في التفاعلات');
      expect(text).toContain('كتلة المتفاعلات تساوي كتلة النواتج.');
      expect(text).toContain(UNIT_TEXT['cu-1']);
      expect(text).toContain(UNIT_TEXT['cu-2']);
      expect(text).not.toContain(UNIT_TEXT['cu-3']);
      expect(text).not.toContain(PARTIAL_SCENE_COVERAGE_TEXT);
      expect(text).toContain('the student asked to EXPLAIN');
      expect(text).not.toContain(helpSessionId);
      expect(text).not.toContain(seed.versionId);
      // Budget assertion on the captured messages with both counters of the pair.
      expect(countTokens(sent, 'proxy', 'qwen:qwen3.7-flash')).toBeLessThanOrEqual(
        effectiveCap('proxy'),
      );
      expect(countTokens(sent, 'exact', 'openai:gpt-5-nano')).toBeLessThanOrEqual(
        effectiveCap('exact'),
      );
      expect(mocks.assembled[0]!.budget.estimate).toBeLessThanOrEqual(
        mocks.assembled[0]!.budget.effectiveCap,
      );
      // No title call on Help.
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('follow-ups keep the anchor: the same session is reused and the earlier turn is the history', async () => {
      const seed = await seedLesson();
      mocks.streamLLM.mockImplementationOnce(() => textStream('الرد الأول.'));
      await readSse(await turn(anchorBody(seed), seed.cookie));
      mocks.streamLLM.mockImplementationOnce(() => textStream('الرد الثاني.'));
      const frames = await readSse(
        await turn(
          anchorBody(seed, 'sc-1', { clientMessageId: 'cm-2', text: 'اشرح تاني بمثال' }),
          seed.cookie,
        ),
      );
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'done']);
      const sessionRows = await pool.query<{ id: string }>('SELECT id FROM tutor_help_sessions');
      expect(sessionRows.rows).toHaveLength(1);
      const helpSessionId = sessionRows.rows[0]!.id;
      const { messages } = await readHelpMessagesBySeq(pool, {
        parentId: helpSessionId,
        limit: 10,
      });
      expect(messages.map((m) => [m.seq, m.role, m.text])).toEqual([
        [1, 'student', 'ليه كتلة المتفاعلات تساوي كتلة النواتج؟'],
        [2, 'tutor', 'الرد الأول.'],
        [3, 'student', 'اشرح تاني بمثال'],
        [4, 'tutor', 'الرد الثاني.'],
      ]);
      const second = sentMessages(1);
      expect(second.map((m) => m.role).slice(-4)).toEqual(['user', 'assistant', 'system', 'user']);
      expect(second[second.length - 4]!.content).toBe('ليه كتلة المتفاعلات تساوي كتلة النواتج؟');
      expect(second[second.length - 3]!.content).toBe('الرد الأول.');
      expect(sentText(1)).toContain(UNIT_TEXT['cu-1']);
      for (const row of (
        await pool.query<{ help_session_id: string; capability: string }>(
          'SELECT help_session_id, capability FROM teaching_model_attempts',
        )
      ).rows) {
        expect(row).toEqual({ help_session_id: helpSessionId, capability: 'help' });
      }
      expect(kafuo.reserve).toHaveBeenCalledTimes(2);
      expect(kafuo.finalize).toHaveBeenCalledTimes(2);
      // Another learner on the same anchor gets a different session.
      mocks.streamLLM.mockImplementationOnce(() => textStream('رد آخر.'));
      await readSse(
        await turn(
          anchorBody(seed),
          learnerCookie({
            versionId: seed.versionId,
            stageId: seed.stageId,
            learnerRef: 'learner-ref-other-000000000',
          }),
        ),
      );
      expect((await pool.query('SELECT id FROM tutor_help_sessions')).rows).toHaveLength(2);
      // A read of the session pages the messages.
      const read = await sessions(
        { versionId: seed.versionId, stageId: seed.stageId, sceneId: 'sc-1', limit: '2' },
        seed.cookie,
      );
      await expect(read.json()).resolves.toMatchObject({
        session: { id: helpSessionId },
        hasMore: true,
      });
    });

    it('replays a completed turn idempotently without any model call or reservation', async () => {
      const seed = await seedLesson();
      mocks.streamLLM.mockImplementationOnce(() => textStream('الجواب.'));
      await readSse(await turn(anchorBody(seed), seed.cookie));
      mocks.events.length = 0;
      const frames = await readSse(await turn(anchorBody(seed), seed.cookie));
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'text_delta', 'done']);
      expect(mocks.events.filter((e) => !e.startsWith('tx:'))).toEqual([]);
      expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
      expect(kafuo.reserve).toHaveBeenCalledTimes(1);
    });

    it('meter refused → 429 ALLOWANCE_EXHAUSTED with no model call and no ledger row', async () => {
      const seed = await seedLesson();
      kafuo.reserve.mockResolvedValueOnce({
        allowed: false,
        reason: 'help_allowance_exhausted',
        window: 'half_month',
        resetAt: '2026-10-01T00:00:00+03:00',
        replay: false,
      });
      const response = await turn(anchorBody(seed), seed.cookie);
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'ALLOWANCE_EXHAUSTED', details: { window: 'half_month' } },
      });
      expect(mocks.streamLLM).not.toHaveBeenCalled();
      expect(await ledgerCount()).toBe(0);
    });

    it('applies the per-grant rate limit on the turn route (429 RATE_LIMITED)', async () => {
      vi.stubEnv('TUTOR_TURNS_PER_MINUTE', '1');
      const seed = await seedLesson();
      mocks.streamLLM.mockImplementationOnce(() => textStream('ok'));
      await readSse(await turn(anchorBody(seed), seed.cookie));
      const limited = await turn(
        anchorBody(seed, 'sc-1', { clientMessageId: 'cm-2' }),
        seed.cookie,
      );
      expect(limited.status).toBe(429);
      await expect(limited.json()).resolves.toMatchObject({ error: { code: 'RATE_LIMITED' } });
    });
  });

  describe('lineage matrix (plan §8.3, P4/P7)', () => {
    it('a review-edit successor (current_attempt_id NULL) grounds on the predecessor attempt’s units', async () => {
      const seed = await seedLesson();
      // The successor clones the Stage (scenes keep their sourceContentUnitIds) and has no attempt of its own.
      const clonedStage = await stage('قانون حفظ الكتلة (مراجعة)', (sid) => [
        scene('sc-1', sid, 1, { title: 'حفظ الكتلة', unitIds: ['cu-2', 'cu-1'] }),
      ]);
      await pool.query(`UPDATE teaching_package_versions SET status = 'superseded' WHERE id = $1`, [
        seed.versionId,
      ]);
      const successor = await version(seed.agg, {
        version: 2,
        status: 'approved',
        currentAttemptId: null,
        stageId: clonedStage,
        predecessorVersionId: seed.versionId,
      });
      mocks.streamLLM.mockImplementationOnce(() => textStream('ok'));
      const frames = await readSse(
        await turn(
          anchorBody({ versionId: successor, stageId: clonedStage }),
          learnerCookie({ versionId: successor, stageId: clonedStage }),
        ),
      );
      expect(frames[3]!.event).toBe('done');
      const student = (
        await pool.query<{ turn_id: string }>(
          `SELECT turn_id FROM tutor_help_messages WHERE role = 'student'`,
        )
      ).rows[0]!;
      expect(await readTurnGrounding(pool, student.turn_id)).toMatchObject({
        lineageStatus: 'predecessor_attempt',
        resolvedAttemptId: seed.attemptId,
      });
      expect(sentText()).toContain(UNIT_TEXT['cu-1']);
      expect(sentText()).toContain(UNIT_TEXT['cu-2']);
      expect(
        (await pool.query<{ version_id: string }>('SELECT version_id FROM tutor_help_sessions'))
          .rows[0],
      ).toEqual({ version_id: successor });
    });

    it('a pinned superseded version uses ITS OWN units while a newer approved version cites different ones', async () => {
      const agg = aggregate();
      const oldAttempt = await attempt(agg, {
        sourceKind: 'kafuo_normalized',
        units: [unit('cu-old', 'النص القديم عن حفظ الكتلة في التفاعل.')],
      });
      const oldStage = await stage('v1', (sid) => [
        scene('sc-1', sid, 1, { title: 'حفظ الكتلة', unitIds: ['cu-old'] }),
      ]);
      const pinned = await version(agg, {
        version: 1,
        status: 'superseded',
        currentAttemptId: oldAttempt,
        stageId: oldStage,
      });
      const newAttempt = await attempt(agg, {
        sourceKind: 'kafuo_normalized',
        units: [unit('cu-new', 'النص الجديد المختلف تمامًا عن الكتلة.')],
      });
      const newStage = await stage('v2', (sid) => [
        scene('sc-1', sid, 1, { title: 'حفظ الكتلة', unitIds: ['cu-new'] }),
      ]);
      const approved = await version(agg, {
        version: 2,
        status: 'approved',
        currentAttemptId: newAttempt,
        stageId: newStage,
        predecessorVersionId: pinned,
      });

      mocks.streamLLM.mockImplementationOnce(() => textStream('ok'));
      const frames = await readSse(
        await turn(
          anchorBody({ versionId: pinned, stageId: oldStage }),
          learnerCookie({ versionId: pinned, stageId: oldStage }),
        ),
      );
      expect(frames[3]!.event).toBe('done');
      expect(sentText()).toContain('النص القديم عن حفظ الكتلة');
      expect(sentText()).not.toContain('النص الجديد');
      const student = (
        await pool.query<{ turn_id: string }>(
          `SELECT turn_id FROM tutor_help_messages WHERE role = 'student'`,
        )
      ).rows[0]!;
      expect(await readTurnGrounding(pool, student.turn_id)).toMatchObject({
        lineageStatus: 'own_attempt',
        resolvedAttemptId: oldAttempt,
      });
      expect((await turnRows(student.turn_id))[0]).toMatchObject({
        capability: 'help',
        scene_id: 'sc-1',
      });

      // The same learner on the newer approved version grounds on the NEW units.
      mocks.streamLLM.mockImplementationOnce(() => textStream('ok'));
      await readSse(
        await turn(
          anchorBody({ versionId: approved, stageId: newStage }),
          learnerCookie({ versionId: approved, stageId: newStage }),
        ),
      );
      expect(sentText(1)).toContain('النص الجديد');
      expect(sentText(1)).not.toContain('النص القديم');
    });

    it('partial lineage proceeds with the resolvable units, records partial + the attempt, and tells the tutor the evidence is incomplete', async () => {
      const seed = await seedLesson();
      mocks.streamLLM.mockImplementationOnce(() => textStream('ok'));
      const frames = await readSse(await turn(anchorBody(seed, 'sc-partial'), seed.cookie));
      expect(frames[1]!.data).toMatchObject({ mode: 'scene' });
      expect(frames[3]!.event).toBe('done');
      const student = (await readHelpMessageByClientId(
        pool,
        (await pool.query<{ id: string }>('SELECT id FROM tutor_help_sessions')).rows[0]!.id,
        'cm-1',
      ))!;
      const grounding = (await readTurnGrounding(pool, student.turnId))!;
      expect(grounding).toMatchObject({
        mode: 'scene',
        lineageStatus: 'partial',
        resolvedAttemptId: seed.attemptId,
      });
      expect(grounding.units.map((u) => u.unitId)).toEqual(['cu-1']);
      expect(sentText()).toContain(UNIT_TEXT['cu-1']);
      expect(sentText()).toContain(PARTIAL_SCENE_COVERAGE_TEXT);
      expect(sentText()).not.toContain(UNIT_TEXT['cu-2']);
    });
  });

  describe('selection under the 10,000-char ceiling and the Scene scope (HLP-02/04)', () => {
    it('Scene units over 10,000 chars → a prioritised subset under the cap, cited order, never widened', async () => {
      const agg = aggregate();
      const filler = (marker: string) =>
        `${'كتلة المتفاعلات تساوي كتلة النواتج في كل تفاعل كيميائي. '.repeat(70)} ${marker}`;
      const units = [
        unit('cu-a', filler('المؤشر الأول عن الماغنسيوم'), 'أ'),
        unit('cu-b', filler('المؤشر الثاني عن الأكسجين'), 'ب'),
        unit('cu-c', filler('المؤشر الثالث عن الكربون'), 'ج'),
      ];
      expect(units.reduce((sum, u) => sum + u.normalizedText.length, 0)).toBeGreaterThan(
        UNIT_CHAR_CAP,
      );
      const attemptId = await attempt(agg, { sourceKind: 'kafuo_normalized', units });
      const stageId = await stage('كبير', (sid) => [
        scene('sc-1', sid, 1, { title: 'حفظ الكتلة', unitIds: ['cu-a', 'cu-b', 'cu-c'] }),
      ]);
      const versionId = await version(agg, {
        version: 1,
        status: 'approved',
        currentAttemptId: attemptId,
        stageId,
      });
      mocks.streamLLM.mockImplementationOnce(() => textStream('ok'));
      const frames = await readSse(
        await turn(
          { ...anchorBody({ versionId, stageId }), text: 'ما دور الكربون في التفاعل؟' },
          learnerCookie({ versionId, stageId }),
        ),
      );
      expect(frames[3]!.event).toBe('done');
      const student = (
        await pool.query<{ turn_id: string }>(
          `SELECT turn_id FROM tutor_help_messages WHERE role = 'student'`,
        )
      ).rows[0]!;
      const grounding = (await readTurnGrounding(pool, student.turn_id))!;
      expect(grounding.totalChars).toBeLessThanOrEqual(UNIT_CHAR_CAP);
      expect(grounding.units).toHaveLength(2);
      // The unit the question names (cu-c) is kept; the picks are in cited order.
      expect(grounding.units.map((u) => u.unitId)).toEqual(['cu-a', 'cu-c']);
      expect(grounding.assessment).toMatchObject({
        capped: true,
        candidateCount: 3,
        selectedCount: 2,
        droppedUnitIds: ['cu-b'],
      });
      expect(sentText()).toContain('المؤشر الثالث عن الكربون');
      expect(sentText()).not.toContain('المؤشر الثاني عن الأكسجين');
      expect(sentText()).toContain(PARTIAL_SCENE_COVERAGE_TEXT);
      const sent = sentMessages();
      expect(countTokens(sent, 'proxy', 'qwen:qwen3.7-flash')).toBeLessThanOrEqual(
        effectiveCap('proxy'),
      );
      expect(countTokens(sent, 'exact', 'openai:gpt-5-nano')).toBeLessThanOrEqual(
        effectiveCap('exact'),
      );
    });

    it('a question outside the Scene runs with grounding_mode insufficient (say so, point to Free Chat) and never retrieves', async () => {
      const seed = await seedLesson();
      mocks.streamLLM.mockImplementationOnce(() =>
        textStream('هذا السؤال خارج المشهد الحالي؛ جرّب الدردشة الحرة للمادة.'),
      );
      const frames = await readSse(
        await turn(
          {
            ...anchorBody(seed),
            text: 'How does photosynthesis convert sunlight into glucose inside chloroplasts?',
          },
          seed.cookie,
        ),
      );
      expect(frames.map((f) => f.event)).toEqual(['turn_start', 'grounding', 'text_delta', 'done']);
      expect(frames[1]!.data).toEqual({ mode: 'insufficient', lessonTitle: 'قانون حفظ الكتلة' });
      const helpSessionId = (await pool.query<{ id: string }>('SELECT id FROM tutor_help_sessions'))
        .rows[0]!.id;
      const { messages } = await readHelpMessagesBySeq(pool, {
        parentId: helpSessionId,
        limit: 10,
      });
      expect(messages[1]).toMatchObject({ role: 'tutor', groundingMode: 'insufficient' });
      const student = (await readHelpMessageByClientId(pool, helpSessionId, 'cm-1'))!;
      const grounding = (await readTurnGrounding(pool, student.turnId))!;
      expect(grounding).toMatchObject({
        mode: 'insufficient',
        units: [],
        totalChars: 0,
        lineageStatus: 'own_attempt',
      });
      expect(grounding.assessment).toMatchObject({
        decision: 'outside_scene',
        rule: 'scene_zero_overlap',
        overlap: 0,
      });
      const text = sentText();
      expect(text).toContain(HELP_SCOPE_TEXT);
      expect(text).toContain('No curriculum text is available for this turn');
      expect(text).not.toContain(UNIT_TEXT['cu-1']);
      // Still metered and finalized as a delivered Help turn.
      expect(kafuo.reserve.mock.calls[0]![0]).toMatchObject({ capability: 'help' });
      expect(await readFinalize(pool, 'res-1')).toMatchObject({ outcome: 'delivered' });
    });
  });

  describe('safety guard on both routes', () => {
    it('the directive reaches Primary and Fallback; a violating reply is replaced by the boundary and finalized delivered/safety_boundary', async () => {
      const seed = await seedLesson();
      mocks.streamLLM
        .mockImplementationOnce(() => streamOf([{ type: 'error', error: apiError(429) }]))
        .mockImplementationOnce(() =>
          textStream('الخطوة 1: اخلط الكلور مع الأمونيا في وعاء.\nالخطوة 2: سخن الخليط على النار.'),
        );
      const frames = await readSse(
        await turn(
          {
            ...anchorBody(seed),
            text: 'ممكن أخلط الكلور مع الأمونيا في البيت عشان أثبت حفظ الكتلة؟',
          },
          seed.cookie,
        ),
      );
      // Primary failed before any delta (no restart for it); the fallback's violating text is replaced by the boundary.
      expect(frames.map((f) => f.event)).toEqual([
        'turn_start',
        'grounding',
        'text_delta',
        'restart',
        'text_delta',
        'done',
      ]);
      expect(frames[4]!.data).toEqual({ delta: SAFETY_BOUNDARY_MESSAGE });
      expect(frames[5]!.data).toMatchObject({
        servedBy: 'fallback',
        safety: { triggered: true, boundary: true, code: 'SAFETY_BOUNDARY' },
      });
      for (const call of [0, 1]) {
        const sent = sentMessages(call);
        expect(sent[sent.length - 2]!.content).toContain('SAFETY DIRECTIVE');
        expect(sent.map((m) => m.content).join('\n')).toContain(HELP_SCOPE_TEXT);
      }
      const helpSessionId = (await pool.query<{ id: string }>('SELECT id FROM tutor_help_sessions'))
        .rows[0]!.id;
      const student = (await readHelpMessageByClientId(pool, helpSessionId, 'cm-1'))!;
      const rows = await turnRows(student.turnId);
      expect(rows.map((r) => [r.role, r.outcome, r.capability, r.help_session_id])).toEqual([
        ['primary', 'rate_limited', 'help', helpSessionId],
        ['fallback', 'succeeded', 'help', helpSessionId],
      ]);
      const { messages } = await readHelpMessagesBySeq(pool, {
        parentId: helpSessionId,
        limit: 10,
      });
      expect(messages[1]).toMatchObject({
        text: SAFETY_BOUNDARY_MESSAGE,
        servedBy: 'fallback',
        safety: { boundary: true },
      });
      expect(await readFinalize(pool, 'res-1')).toMatchObject({
        outcome: 'delivered',
        reason: 'safety_boundary',
      });
    });
  });
});
