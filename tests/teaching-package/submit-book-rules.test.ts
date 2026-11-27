/**
 * g5.v12 (critical items before package regeneration, 27 Nov 2026, EN-6): Submit re-checks
 * the book's coverage and order on the live Stage. Between the plan's gates and Submit a
 * person edits the Stage, and nothing re-checked the book. Over PGlite, with the attempt's
 * pinned book, parts, flow and retained units — only the model is absent. The identical
 * package on g5.v11 is Submit's behaviour exactly as before.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  upsertContentUnits,
  upsertSourceContext,
} from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  findBookCoverageGaps,
  requireEssentialUntypedUnits,
  requireTaughtUnits,
  teacherParityBook,
} from '@/lib/server/teaching-package/book-coverage';
import {
  buildBookPartMap,
  listedPartUnitIds,
} from '@/lib/server/teaching-package/book-part-placement';
import { submitBlockers, submitForReview } from '@/lib/server/teaching-package/lifecycle';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';
import type { KafuoBookStructure, TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const TENANT = 'tenant-test';

/** Two objectives: each its slides, then its quiz. */
const FLOW: TeachingFlowEntry[] = [
  {
    stage: 'lesson_opener',
    instructions: 'Open.',
    scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
  },
  {
    stage: 'outcome_visual_explanations',
    instructions: 'Teach o1.',
    scenePolicy: { sceneTypes: ['slide', 'quiz'], cardinality: 'one_or_more' },
  },
  {
    stage: 'outcome_check_understanding',
    instructions: 'Check o1.',
    scenePolicy: { sceneTypes: ['quiz'], cardinality: 'exactly_one' },
  },
  {
    stage: 'outcome_visual_explanations',
    instructions: 'Teach o2.',
    scenePolicy: { sceneTypes: ['slide', 'quiz'], cardinality: 'one_or_more' },
  },
  {
    stage: 'outcome_check_understanding',
    instructions: 'Check o2.',
    scenePolicy: { sceneTypes: ['quiz'], cardinality: 'exactly_one' },
  },
];

const unit = (
  contentUnitId: string,
  element: string | null,
  partIndex: number,
): KafuoBookStructure['units'][number] => ({
  contentUnitId,
  kind: element === null ? null : element === 'try_it' ? 'UNDERSTANDING_CHECK' : 'KEY_CONCEPT',
  element,
  required: element === 'key_concept' || element === 'try_it',
  partIndex,
});

/** u3 and u6 are kind-less (D-4): listed part units on g5.v12. */
const BOOK: KafuoBookStructure = {
  templateVersionId: '4',
  rules: [],
  units: [
    unit('u1', 'key_concept', 1),
    unit('u2', 'try_it', 1),
    unit('u3', null, 1),
    unit('u4', 'key_concept', 2),
    unit('u5', 'try_it', 2),
    unit('u6', null, 2),
  ],
};

const OBJECTIVES = [
  { objectiveRef: 'o1', snapshot: { statement: 's1' }, contentUnitIds: ['u1', 'u2', 'u3'] },
  { objectiveRef: 'o2', snapshot: { statement: 's2' }, contentUnitIds: ['u4', 'u5', 'u6'] },
];

const UNITS = [
  {
    unitId: 'u1',
    orderIndex: 1,
    role: 'CONCEPT_EXPLANATION',
    title: 'u1',
    normalizedText: 'text u1',
  },
  {
    unitId: 'u2',
    orderIndex: 2,
    role: 'UNDERSTANDING_CHECK',
    title: 'check',
    normalizedText: 'text u2',
  },
  {
    unitId: 'u3',
    orderIndex: 3,
    role: 'CONCEPT_EXPLANATION',
    title: 'u3',
    normalizedText: 'text u3',
  },
  {
    unitId: 'u4',
    orderIndex: 4,
    role: 'CONCEPT_EXPLANATION',
    title: 'u4',
    normalizedText: 'text u4',
  },
  {
    unitId: 'u5',
    orderIndex: 5,
    role: 'UNDERSTANDING_CHECK',
    title: 'check',
    normalizedText: 'text u5',
  },
  {
    unitId: 'u6',
    orderIndex: 6,
    role: 'CONCEPT_EXPLANATION',
    title: 'u6',
    normalizedText: 'text u6',
  },
];

const ESSENTIAL = ['u1', 'u3', 'u4', 'u6'];

const at = (flowIndex: number) => ({ key: FLOW[flowIndex]!.stage, flowIndex });

/** A live slide as the editor persists it: its own citations, role, type and stage. */
function slide(
  stageId: string,
  id: string,
  flowIndex: number,
  units: string[],
  semantics: { slideType: string; contentRole: string },
): AppScene {
  const base = makeSlideScene(id, stageId, 0, id);
  const content = base.content as Extract<AppScene['content'], { type: 'slide' }>;
  return {
    ...base,
    teachingStage: at(flowIndex),
    sourceContentUnitIds: units,
    content: {
      ...content,
      canvas: { ...content.canvas, type: semantics.slideType },
      contentRole: semantics.contentRole,
    },
    actions: [],
  } as unknown as AppScene;
}

function quiz(stageId: string, id: string, flowIndex: number, units: string[]): AppScene {
  return {
    ...makeSlideScene(id, stageId, 0, id),
    type: 'quiz',
    teachingStage: at(flowIndex),
    sourceContentUnitIds: units,
    content: { type: 'quiz', questions: [] },
    actions: [],
  } as unknown as AppScene;
}

const EXPLAIN = { slideType: 'content', contentRole: 'explanation' };
const TRY = { slideType: 'content', contentRole: 'check_understanding' };
const SOLVE = { slideType: 'content', contentRole: 'worked_example' };

/** Play order, re-stamped after a teacher dragged a slide. */
const withOrder = (scenes: AppScene[]) =>
  scenes.map((scene, index) => ({ ...scene, order: index + 1 }));

/** A g5.v12 package as the run leaves it: in book order, every check with its pair. */
const inBookOrder = (stageId: string) => [
  slide(stageId, 'cover', 0, ['u1'], { slideType: 'cover', contentRole: 'orientation' }),
  slide(stageId, 'c1', 1, ['u1'], EXPLAIN),
  slide(stageId, 'try1', 1, ['u2'], TRY),
  slide(stageId, 'sol1', 1, ['u2'], SOLVE),
  slide(stageId, 'c2', 1, ['u3'], EXPLAIN),
  quiz(stageId, 'q1', 2, ['u2']),
  slide(stageId, 'c3', 3, ['u4'], EXPLAIN),
  slide(stageId, 'try2', 3, ['u5'], TRY),
  slide(stageId, 'sol2', 3, ['u5'], SOLVE),
  slide(stageId, 'c4', 3, ['u6'], EXPLAIN),
  quiz(stageId, 'q2', 4, ['u5']),
];

/** The live slides as the plan the coverage gate reads: type, slide type, role and citations. */
const asPlan = (scenes: readonly AppScene[]): SceneOutline[] =>
  scenes.map((scene) => {
    const content = scene.content as { canvas?: { type?: string }; contentRole?: string };
    return {
      id: scene.id,
      type: scene.type,
      title: scene.title,
      description: '',
      keyPoints: [],
      order: scene.order,
      sourceContentUnitIds: scene.sourceContentUnitIds,
      ...(content.canvas?.type ? { slideType: content.canvas.type } : {}),
      ...(content.contentRole ? { contentRole: content.contentRole } : {}),
    } as SceneOutline;
  });

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

describe('g5.v12 Submit re-checks the book (EN-6)', () => {
  let pool: PGlitePool;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;
  const qp = () => pool as never;
  const tx = () => pool as unknown as ConnectableQueryable;

  /** A version whose producing attempt pinned the book, the parts, the flow and its units. */
  async function seedBookVersion(options: {
    version: string;
    scenes: (stageId: string) => AppScene[];
    gapContentUnitIds?: string[];
    book?: KafuoBookStructure;
    objectives?: typeof OBJECTIVES;
  }): Promise<string> {
    const stageId = unique('stage-book');
    const versionId = unique('tpv');
    const attemptId = unique('tpa');
    const item = { type: 'lesson' as const, id: unique('li') };
    const teachingModel = { key: 'g5', version: options.version };
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(makeDocument(stageId, 'Book', withOrder(options.scenes(stageId))));
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: TENANT, learningItem: item },
      version: 1,
      status: 'draft',
      currentStageId: stageId,
      currentAttemptId: attemptId,
      teachingModel,
      now: 1,
    });
    await insertAttempt(qp(), {
      id: attemptId,
      aggregate: { tenantId: TENANT, learningItem: item },
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'actor-1',
      teachingModel,
      // `sectionCoverage` is a key the runner writes on the raw snapshot (Submit's
      // authority), so the pinned snapshot is given as it is stored.
      inputSnapshot: {
        learningItem: item,
        teachingModel,
        learningObjectives: options.objectives ?? OBJECTIVES,
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
        teachingFlow: FLOW,
        bookStructure: options.book ?? BOOK,
        sectionCoverage: {
          essentialContentUnitIds: ESSENTIAL,
          gapContentUnitIds: options.gapContentUnitIds ?? [],
        },
      } as never,
      now: 1,
    });
    await upsertSourceContext(qp(), {
      tenantId: TENANT,
      attemptId,
      contentResourceId: 'cs-1',
      measuredSha256: 'a'.repeat(64),
      text: 'source',
      sourceKind: 'kafuo_normalized',
    });
    await upsertContentUnits(qp(), { tenantId: TENANT, attemptId, units: UNITS });
    return versionId;
  }

  const command = (versionId: string) => ({ tenantId: TENANT, versionId, actorRef: 'reviewer-1' });

  async function refusal(promise: Promise<unknown>) {
    await expect(promise).rejects.toBeInstanceOf(TeachingPackageError);
    return (await promise.catch((error: unknown) => error)) as TeachingPackageError;
  }

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    vi.stubEnv('DATABASE_URL', `postgres://submit-book-${(counter += 1)}`);
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  /** A teacher dragged the kind-less u6 (printed after the check u5) above the check. */
  const dragged = (stageId: string) => {
    const scenes = inBookOrder(stageId);
    const [c4] = scenes.splice(9, 1);
    scenes.splice(7, 0, c4!);
    return scenes;
  };
  const without = (ids: string[]) => (stageId: string) =>
    inBookOrder(stageId).filter((scene) => !ids.includes(scene.id));

  it('submits a g5.v12 package that follows the book, and its readiness lists no blocker', async () => {
    const versionId = await seedBookVersion({ version: 'g5.v12', scenes: inBookOrder });

    expect((await submitForReview(tx(), command(versionId))).status).toBe('in_review');
  });

  it('H1 (wave 1 review): a listed part unit with no text (no retained row) is never required at Submit', async () => {
    // u7: a figure-only kind-less unit of part 2 that o2 owns. No slide can teach it (no
    // text for a repair or "Generate slide"), so requiring it would refuse for good.
    const versionId = await seedBookVersion({
      version: 'g5.v12',
      scenes: inBookOrder,
      book: { ...BOOK, units: [...BOOK.units, unit('u7', null, 2)] },
      objectives: [
        OBJECTIVES[0]!,
        { ...OBJECTIVES[1]!, contentUnitIds: [...OBJECTIVES[1]!.contentUnitIds, 'u7'] },
      ],
    });

    expect(await submitBlockers(tx(), versionId, TENANT)).toEqual([]);
    expect((await submitForReview(tx(), command(versionId))).status).toBe('in_review');
  });

  it('submits an untouched g5.v12 package from the readiness reader alone: no blocker', async () => {
    const versionId = await seedBookVersion({ version: 'g5.v12', scenes: inBookOrder });

    expect(await submitBlockers(tx(), versionId, TENANT)).toEqual([]);
  });

  it('refuses a g5.v12 package a teacher dragged out of the book order, naming the slides to move', async () => {
    const versionId = await seedBookVersion({ version: 'g5.v12', scenes: dragged });

    const error = await refusal(submitForReview(tx(), command(versionId)));

    expect(error.code).toBe('TEACHING_MODEL_FLOW_MISMATCH');
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ reason: 'book_order' });
    // The check u5 and its solution now come after the kind-less u6, which the book prints later.
    expect((error.details as { offendingSceneIds: string[] }).offendingSceneIds).toEqual([
      'try2',
      'sol2',
    ]);
    expect(error.message).toContain('move each listed slide to its place in the book');
    // The collect-all reader names the same refusal, so the Agent API's readiness agrees.
    const blockers = await submitBlockers(tx(), versionId, TENANT);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      code: 'TEACHING_MODEL_FLOW_MISMATCH',
      details: { reason: 'book_order', offendingSceneIds: ['try2', 'sol2'] },
    });
  });

  it('L7 (wave 1 review): a solution before its try-it is refused, but never offered as a "generate slide" unit', async () => {
    // A copy of u2's solution slide, dragged above its try-it (the later one stays).
    const earlySolution = (stageId: string) => {
      const scenes = inBookOrder(stageId);
      const early = { ...scenes[3]!, id: 'sol1-early', outlineId: 'sol1-early' } as AppScene;
      scenes.splice(2, 0, early);
      return scenes;
    };
    const versionId = await seedBookVersion({ version: 'g5.v12', scenes: earlySolution });

    const blockers = await submitBlockers(tx(), versionId, TENANT);
    const uncovered = blockers.find((blocker) => blocker.code === 'ESSENTIAL_SECTION_UNCOVERED');
    const details = uncovered?.details as {
      unitIds: string[];
      findings: Array<{ unitId?: string; message: string }>;
    };
    // N4 (re-review): the finding names the slide to move or delete.
    expect(details.findings).toEqual([
      expect.objectContaining({
        sceneId: 'sol1-early',
        unitId: 'u2',
        message: expect.stringContaining('before its try-it'),
      }),
    ]);
    expect(details.unitIds).toEqual([]);
  });

  it('refuses a check whose solution slide was deleted, by the check it belongs to', async () => {
    const versionId = await seedBookVersion({ version: 'g5.v12', scenes: without(['sol2']) });

    const error = await refusal(submitForReview(tx(), command(versionId)));

    expect(error.code).toBe('ESSENTIAL_SECTION_UNCOVERED');
    expect(error.status).toBe(422);
    expect((error.details as { unitIds: string[] }).unitIds).toEqual(['u5']);
    expect(
      (error.details as { findings: Array<{ unitId?: string; code: string; message: string }> })
        .findings,
    ).toEqual([
      {
        unitId: 'u5',
        code: 'BOOK_COVERAGE_INCOMPLETE',
        message:
          'UNDERSTANDING_CHECK u5 in part 2 has a try-it slide but no solution slide after it',
      },
    ]);
  });

  it('refuses two checks on one slide', async () => {
    const versionId = await seedBookVersion({
      version: 'g5.v12',
      scenes: (stageId) =>
        inBookOrder(stageId).map((scene) =>
          scene.id === 'try2' ? { ...scene, sourceContentUnitIds: ['u5', 'u2'] } : scene,
        ),
    });

    const error = await refusal(submitForReview(tx(), command(versionId)));

    expect(error.code).toBe('ESSENTIAL_SECTION_UNCOVERED');
    expect(error.details).toMatchObject({
      findings: [{ sceneId: 'try2', code: 'CHECKS_MERGED' }],
    });
  });

  it('refuses a listed unit whose slide was deleted, a kind-less one the book map does not require', async () => {
    const versionId = await seedBookVersion({ version: 'g5.v12', scenes: without(['c2']) });

    const error = await refusal(submitForReview(tx(), command(versionId)));

    expect(error.code).toBe('ESSENTIAL_SECTION_UNCOVERED');
    expect((error.details as { unitIds: string[] }).unitIds).toEqual(['u3']);
  });

  it('does not re-judge the recall and exercises blocks, which need unit facts the attempt pinned only on a checkpoint (review)', async () => {
    // A book with a «فيما سبق» unit: the run's own gate asks for a recall slide, and this package has none.
    const withPrior: KafuoBookStructure = {
      ...BOOK,
      units: [
        {
          contentUnitId: 'u-prior',
          kind: 'PRIOR_KNOWLEDGE',
          element: 'prior_knowledge',
          required: false,
        },
        ...BOOK.units,
      ],
    };
    const coverage = teacherParityBook(
      requireTaughtUnits(requireEssentialUntypedUnits(withPrior, ESSENTIAL), [
        ...listedPartUnitIds(buildBookPartMap(withPrior, OBJECTIVES, FLOW)!),
        ...ESSENTIAL,
      ]),
      { key: 'g5', version: 'g5.v12' },
    )!;
    expect(
      findBookCoverageGaps(asPlan(inBookOrder('x')), coverage).map((gap) => gap.kind),
    ).toContain('missing_recall');

    const versionId = await seedBookVersion({
      version: 'g5.v12',
      scenes: inBookOrder,
      book: withPrior,
    });

    expect(await submitBlockers(tx(), versionId, TENANT)).toEqual([]);
    expect((await submitForReview(tx(), command(versionId))).status).toBe('in_review');
  });

  it('g5.v11 is unchanged: the same out-of-order package, and the same deleted solution, submit as before', async () => {
    const draggedId = await seedBookVersion({ version: 'g5.v11', scenes: dragged });
    expect(await submitBlockers(tx(), draggedId, TENANT)).toEqual([]);
    expect((await submitForReview(tx(), command(draggedId))).status).toBe('in_review');

    const noSolutionId = await seedBookVersion({ version: 'g5.v11', scenes: without(['sol2']) });
    expect((await submitForReview(tx(), command(noSolutionId))).status).toBe('in_review');
  });
});
