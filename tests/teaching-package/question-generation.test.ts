/**
 * Teaching Question generation from an APPROVED Teaching Package (Kafuo
 * question-flow closure, B1). TE resolves its own retained context — the
 * objectives, the flow, the final Scenes and the extracted lesson source text —
 * so Kafuo never resends package content and the transient presigned URL is
 * never needed again.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  readRetainedVersionContext,
  sourceContextMaxChars,
  upsertSourceContext,
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  expandFlowStages,
  generateTeachingQuestionSet,
  renderSceneText,
  selectSourceExcerpts,
  type QuestionModelPort,
  type QuestionSetGenerationRequest,
} from '@/lib/server/teaching-package/question-generation';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const mocks = vi.hoisted(() => ({
  pool: null as unknown,
  generate: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () =>
    createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: mocks.pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }),
}));

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return { query: (text: string, params?: unknown[]) => this.db.query(text, params), release() {} };
  }
  async end() {
    await this.db.close();
  }
}

const TENANT = 'tenant-q';
const FLOW_STAGES = [
  { key: 'lesson_introduction', scope: 'item' as const },
  { key: 'outcome_teaching_cards', scope: 'outcome' as const },
  { key: 'outcome_worked_examples', scope: 'outcome' as const },
];
const OBJECTIVES = [
  { objectiveRef: '48', snapshot: { statement: 'Compare two proper fractions.' } },
  { objectiveRef: '49', snapshot: { statement: 'Add fractions with like denominators.' } },
];
const RETAINED_FLOW = [
  { stage: 'lesson_introduction', instructions: 'intro' },
  { stage: 'outcome_teaching_cards', instructions: 'cards 48' },
  { stage: 'outcome_worked_examples', instructions: 'examples 48' },
  { stage: 'outcome_teaching_cards', instructions: 'cards 49' },
  { stage: 'outcome_worked_examples', instructions: 'examples 49' },
];
const SOURCE_TEXT = [
  'Fractions describe equal parts of a whole.',
  'To compare two proper fractions rewrite them with a common denominator, then compare numerators.',
  'Adding fractions with like denominators keeps the denominator and adds the numerators.',
].join('\n\n');

const ENVELOPE = {
  learning_outcome_id: 48,
  slots: [{ teaching_role: 'check_understanding', supported: false, unsupported_reason: 'x', question: null }],
};

function scene(
  id: string,
  stageId: string,
  order: number,
  flowIndex: number,
  speech: string,
): AppScene {
  return {
    ...makeSlideScene(id, stageId, order, `Scene ${id}`),
    teachingStage: { key: RETAINED_FLOW[flowIndex].stage, flowIndex },
    actions: [{ id: `a-${id}`, type: 'speech', text: speech }],
  } as AppScene;
}

describe('teaching question generation from an approved package', () => {
  let pool: PGlitePool;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;
  const qp = () => pool as never;
  const port: QuestionModelPort = { generate: (s, p) => mocks.generate(s, p) };

  async function seed(options: {
    status?: TeachingPackageStatus;
    withSource?: boolean;
    successor?: boolean;
  } = {}) {
    const itemId = unique('li');
    const learningItem = { type: 'lesson' as const, id: itemId };
    const aggregate = { tenantId: TENANT, learningItem };
    const stageId = unique('stage');
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as never,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(stageId, 'Fractions', [
        scene(`${stageId}-intro`, stageId, 1, 0, 'Today we study fractions.'),
        scene(`${stageId}-c48`, stageId, 2, 1, 'Compare fractions using a common denominator.'),
        scene(`${stageId}-e48`, stageId, 3, 2, 'Worked example: 2/3 versus 3/5 becomes 10/15 versus 9/15.'),
        scene(`${stageId}-c49`, stageId, 4, 3, 'Add like fractions by adding numerators.'),
        scene(`${stageId}-e49`, stageId, 5, 4, 'Worked example: 1/5 plus 2/5 is 3/5.'),
      ]),
    );
    const attemptId = unique('tpa');
    const generatedVersionId = unique('tpv');
    let generatedStageId = stageId;
    if (options.successor) {
      // The superseded predecessor keeps its own Stage; the successor clone holds the new one.
      generatedStageId = unique('stage-old');
      await store.saveDocument(makeDocument(generatedStageId, 'Fractions v1', []));
    }
    await insertVersion(qp(), {
      id: generatedVersionId,
      aggregate,
      version: 1,
      status: options.successor ? 'superseded' : (options.status ?? 'approved'),
      currentStageId: generatedStageId,
      currentAttemptId: attemptId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await insertAttempt(qp(), {
      id: attemptId,
      aggregate,
      versionId: generatedVersionId,
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: {
        learningItem,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        learningObjectives: OBJECTIVES,
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
        teachingFlow: RETAINED_FLOW,
        contentResource: { id: 'cs-575', mimeType: 'application/pdf', measuredSha256: 'a'.repeat(64) },
      },
      now: 1,
    });
    if (options.withSource !== false) {
      await upsertSourceContext(qp(), {
        tenantId: TENANT,
        attemptId,
        contentResourceId: 'cs-575',
        measuredSha256: 'a'.repeat(64),
        text: SOURCE_TEXT,
      });
    }
    let versionId = generatedVersionId;
    if (options.successor) {
      versionId = unique('tpv-successor');
      await insertVersion(qp(), {
        id: versionId,
        aggregate,
        version: 2,
        status: 'approved',
        currentStageId: stageId,
        currentAttemptId: null,
        predecessorVersionId: generatedVersionId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 2,
      });
    }
    return { versionId, learningItem, stageId };
  }

  function request(
    seeded: { versionId: string; learningItem: { type: 'lesson'; id: string } },
    overrides: Partial<QuestionSetGenerationRequest> = {},
  ): QuestionSetGenerationRequest {
    return {
      versionId: seeded.versionId,
      tenantId: TENANT,
      learningItem: seeded.learningItem,
      requestId: 'b3-initial:item:3:None:tpv:48:b3-v1',
      objectiveRef: '48',
      flowStages: FLOW_STAGES,
      language: 'en',
      targetRole: null,
      findings: [],
      siblingMeasurements: [],
      ...overrides,
    };
  }

  beforeEach(async () => {
    const db = new PGlite();
    pool = new PGlitePool(db);
    mocks.pool = pool;
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue({ text: JSON.stringify(ENVELOPE), model: 'openai:test' });
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.end();
  });

  it('generates from the approved version using retained objectives, scenes and source', async () => {
    const seeded = await seed();
    const result = await generateTeachingQuestionSet(qp(), request(seeded), port);

    expect(result.teachingPackageVersionId).toBe(seeded.versionId);
    expect(result.requestId).toBe('b3-initial:item:3:None:tpv:48:b3-v1');
    expect(result.envelope).toEqual(ENVELOPE);
    // Objective 48's scenes (flow indexes 1,2) plus the item intro (0); never objective 49's.
    const sceneIds = result.sections.filter((s) => s.kind === 'teaching_scene').map((s) => s.sceneId);
    expect(sceneIds).toEqual([
      `${seeded.stageId}-intro`,
      `${seeded.stageId}-c48`,
      `${seeded.stageId}-e48`,
    ]);
    const anchors = result.sections.map((s) => s.anchor);
    expect(anchors).toContain('C1');
    expect(anchors.some((a) => a.startsWith('S'))).toBe(true);
    const [, prompt] = mocks.generate.mock.calls[0];
    expect(prompt).toContain('Compare two proper fractions.');
    expect(prompt).toContain('common denominator');
    expect(prompt).not.toContain('Add like fractions by adding numerators.');
    // The transient presigned URL is never fetched again.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['draft', 'in_review', 'rejected', 'discarded'] as const)(
    'refuses a %s version as the generation authority',
    async (status) => {
      const seeded = await seed({ status });
      await expect(generateTeachingQuestionSet(qp(), request(seeded), port)).rejects.toMatchObject({
        code: 'TEACHING_PACKAGE_NOT_APPROVED',
        status: 409,
      });
      expect(mocks.generate).not.toHaveBeenCalled();
    },
  );

  it('resolves a successor’s retained context through its predecessor attempt', async () => {
    const seeded = await seed({ successor: true });
    const result = await generateTeachingQuestionSet(qp(), request(seeded), port);
    expect(result.teachingPackageVersionId).toBe(seeded.versionId);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('refuses a version generated before source-context retention', async () => {
    const seeded = await seed({ withSource: false });
    await expect(generateTeachingQuestionSet(qp(), request(seeded), port)).rejects.toMatchObject({
      code: 'QUESTION_SOURCE_CONTEXT_UNAVAILABLE',
    });
  });

  it('refuses another tenant, another learning item, and an objective the package never taught', async () => {
    const seeded = await seed();
    await expect(
      generateTeachingQuestionSet(qp(), request(seeded, { tenantId: 'tenant-other' }), port),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      generateTeachingQuestionSet(
        qp(),
        request(seeded, { learningItem: { type: 'lesson', id: 'li-other' } }),
        port,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      generateTeachingQuestionSet(qp(), request(seeded, { objectiveRef: '999' }), port),
    ).rejects.toMatchObject({ code: 'OBJECTIVE_NOT_IN_PACKAGE' });
  });

  it('refuses flow stages that do not reproduce the retained flow', async () => {
    const seeded = await seed();
    await expect(
      generateTeachingQuestionSet(
        qp(),
        request(seeded, { flowStages: [{ key: 'outcome_teaching_cards', scope: 'outcome' }] }),
        port,
      ),
    ).rejects.toMatchObject({ code: 'TEACHING_MODEL_FLOW_MISMATCH' });
  });

  it('refuses unparseable model output', async () => {
    const seeded = await seed();
    mocks.generate.mockResolvedValue({ text: 'not json at all', model: 'm' });
    await expect(generateTeachingQuestionSet(qp(), request(seeded), port)).rejects.toBeInstanceOf(
      TeachingPackageError,
    );
  });
});

describe('source context retention', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    pool = new PGlitePool(new PGlite());
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await pool.end();
  });

  it('caps the retained text and records truncation, and stays tenant-scoped', async () => {
    vi.stubEnv('TEACHING_PACKAGE_SOURCE_CONTEXT_MAX_CHARS', '10');
    expect(sourceContextMaxChars()).toBe(10);
    const aggregate = { tenantId: 'tenant-a', learningItem: { type: 'lesson' as const, id: 'li-1' } };
    await insertAttempt(pool as never, {
      id: 'tpa-cap',
      aggregate,
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: {
        learningItem: aggregate.learningItem,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        learningObjectives: [],
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
      },
      now: 1,
    });
    await upsertSourceContext(pool as never, {
      tenantId: 'tenant-a',
      attemptId: 'tpa-cap',
      contentResourceId: 'cs-1',
      measuredSha256: 'b'.repeat(64),
      text: 'x'.repeat(25),
    });
    const row = await pool.query(
      `SELECT text, text_length, truncated FROM teaching_package_source_contexts WHERE attempt_id = 'tpa-cap'`,
    );
    expect(row.rows[0]).toMatchObject({ text: 'x'.repeat(10), text_length: 25, truncated: true });
    // No column can carry a URL or credential.
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'teaching_package_source_contexts'`,
    );
    const names = columns.rows.map((r) => (r as { column_name: string }).column_name);
    expect(names.some((name) => /url|secret|token|signature/.test(name))).toBe(false);
    // A foreign tenant cannot read the retained context through the version walk.
    expect(await readRetainedVersionContext(pool as never, 'tpv-none', { tenantId: 'tenant-b' })).toBeNull();
  });
});

describe('pure helpers', () => {
  it('expands a flow exactly like the Kafuo expansion', () => {
    expect(expandFlowStages(FLOW_STAGES, ['48', '49']).map((e) => `${e.stage}:${e.objectiveRef}`)).toEqual([
      'lesson_introduction:null',
      'outcome_teaching_cards:48',
      'outcome_worked_examples:48',
      'outcome_teaching_cards:49',
      'outcome_worked_examples:49',
    ]);
  });

  it('renders learner-visible scene text and selects related, bounded source excerpts', () => {
    const rendered = renderSceneText({
      ...makeSlideScene('s', 'st', 1),
      actions: [{ id: 'a', type: 'speech', text: 'Say this.' }],
    } as AppScene);
    expect(rendered).toBe('Say this.');
    const excerpts = selectSourceExcerpts(SOURCE_TEXT, 'compare proper fractions denominator');
    expect(excerpts.length).toBeGreaterThan(0);
    expect(excerpts.join(' ')).toContain('common denominator');
  });
});

describe('POST /api/teaching-packages/[id]/question-sets', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'svc-key');
    vi.stubEnv('DATABASE_URL', 'postgres://unused');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@/lib/server/teaching-package/question-generation');
    vi.doUnmock('@/lib/persistence/server-provider');
  });

  async function loadRoute(service: (...args: unknown[]) => unknown) {
    vi.doMock('@/lib/persistence/server-provider', () => ({
      getServerPersistenceProvider: async () => ({ pool: {} }),
    }));
    vi.doMock('@/lib/server/teaching-package/question-generation', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      generateTeachingQuestionSet: service,
    }));
    return import('@/app/api/teaching-packages/[id]/question-sets/route');
  }

  const body = {
    tenantContext: { tenantId: 'tenant-q' },
    learningItem: { type: 'lesson', id: 'li-1' },
    requestId: 'req-1',
    objective: { objectiveRef: '48' },
    flowStages: FLOW_STAGES,
    policy: { envelopeVersion: 'tqs.v1.strict.20260817', language: 'en' },
  };

  function post(payload: unknown, auth = 'Bearer svc-key') {
    return new NextRequest('http://te.test/api/teaching-packages/tpv-1/question-sets', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  it('requires the service key', async () => {
    const { POST } = await loadRoute(vi.fn());
    const response = await POST(post(body, 'Bearer wrong'), { params: Promise.resolve({ id: 'tpv-1' }) });
    expect(response.status).toBe(401);
  });

  it('validates the body and passes identity + policy (never content) to the service', async () => {
    const service = vi.fn().mockResolvedValue({ requestId: 'req-1', envelope: {} });
    const { POST } = await loadRoute(service);
    const bad = await POST(post({ ...body, flowStages: [] }), { params: Promise.resolve({ id: 'tpv-1' }) });
    expect(bad.status).toBe(400);
    const ok = await POST(post(body), { params: Promise.resolve({ id: 'tpv-1' }) });
    expect(ok.status).toBe(200);
    const [, forwarded] = service.mock.calls[0];
    expect(forwarded).toMatchObject({
      versionId: 'tpv-1',
      tenantId: 'tenant-q',
      objectiveRef: '48',
      requestId: 'req-1',
      targetRole: null,
    });
  });

  it('maps a not-approved refusal to 409', async () => {
    const service = vi.fn();
    const { POST } = await loadRoute(service);
    // The route's module graph was reset; build the error from that same graph.
    const { TeachingPackageError: RouteError } = await import('@/lib/server/teaching-package/errors');
    service.mockRejectedValue(new RouteError('TEACHING_PACKAGE_NOT_APPROVED', 'no'));
    const response = await POST(post(body), { params: Promise.resolve({ id: 'tpv-1' }) });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('TEACHING_PACKAGE_NOT_APPROVED');
  });
});
