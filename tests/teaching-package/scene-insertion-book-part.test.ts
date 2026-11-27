/**
 * g5.v12 (book-section plan W5, critical item V12-3, 27 Nov 2026): an inserted slide takes
 * the stage of the objective block that OWNS the part it teaches. At a block boundary a
 * position allows the neighbouring stages, and a slide generated for a part used to take
 * the neighbour block's label — so the part left its place in the book. On every other
 * Teaching Model, and for a part with a single owner nowhere, the rule is not applied.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
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
  checkPositionAndUnits,
  readInsertionContext,
} from '@/lib/server/teaching-package/scene-insertion';
import { stagesOwnedByPart } from '@/lib/server/teaching-package/content-unit-coverage';
import type { SceneInsertionRequest } from '@/lib/server/teaching-package/scene-insertion';
import type { AppScene } from '@/lib/types/stage';
import type { KafuoBookStructure, TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const TENANT = 'tenant-test';
const V11 = { key: 'g5', version: 'g5.v11' };
const V12 = { key: 'g5', version: 'g5.v12' };

/** Two objectives: each its slides, then its quiz. The blocks sit at flow 1 and flow 3. */
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
const stage = (flowIndex: number) => ({ key: FLOW[flowIndex]!.stage, flowIndex });
const O1 = stage(1);
const O2 = stage(3);

const unit = (contentUnitId: string, element: string | null, partIndex: number) => ({
  contentUnitId,
  kind: element === null ? null : element === 'try_it' ? 'UNDERSTANDING_CHECK' : 'KEY_CONCEPT',
  element,
  required: element !== 'supporting',
  partIndex,
});

const BOOK: KafuoBookStructure = {
  templateVersionId: '4',
  rules: [],
  units: [
    {
      contentUnitId: 'u-prior',
      kind: 'PRIOR_KNOWLEDGE',
      element: 'prior_knowledge',
      required: false,
    },
    unit('u1', 'key_concept', 1),
    unit('u3', null, 1), // kind-less: listed on g5.v12 (D-4)
    unit('u4', 'key_concept', 2),
    unit('u6', null, 2),
  ],
};
const OBJECTIVES = [
  { objectiveRef: 'o1', snapshot: { statement: 's1' }, contentUnitIds: ['u1', 'u3'] },
  { objectiveRef: 'o2', snapshot: { statement: 's2' }, contentUnitIds: ['u4', 'u6'] },
];

/** The retained units an inserted slide may be generated for. */
const UNITS = ['u1', 'u3', 'u4', 'u6', 'u-prior'].map((unitId, index) => ({
  unitId,
  orderIndex: index + 1,
  role: 'CONCEPT_EXPLANATION',
  title: unitId,
  normalizedText: `text ${unitId}`,
  textLength: `text ${unitId}`.length,
  contentRevisionId: null,
  approvedSnapshotId: null,
})) as never[];

/** The lesson as the run leaves it: the first block, its quiz, the second block, its quiz. */
function lesson(stageId: string): AppScene[] {
  const slide = (id: string, at: ReturnType<typeof stage>, units: string[], order: number) =>
    ({
      ...makeSlideScene(id, stageId, order, id),
      teachingStage: at,
      sourceContentUnitIds: units,
      content: {
        ...(makeSlideScene(id, stageId, order, id).content as object),
        contentRole: 'explanation',
      },
    }) as unknown as AppScene;
  const quiz = (id: string, at: ReturnType<typeof stage>, units: string[], order: number) =>
    ({
      ...makeSlideScene(id, stageId, order, id),
      type: 'quiz',
      teachingStage: at,
      sourceContentUnitIds: units,
      content: { type: 'quiz', questions: [] },
    }) as unknown as AppScene;
  return [
    slide('s1', O1, ['u1'], 1),
    quiz('q1', stage(2), ['u1'], 2),
    slide('s2', O2, ['u4'], 3),
    quiz('q2', stage(4), ['u4'], 4),
  ];
}

function request(
  unitIds: string[],
  between: { after: string; before: string },
  teachingStage: ReturnType<typeof stage>,
): SceneInsertionRequest {
  return {
    unitIds,
    afterSceneId: between.after,
    beforeSceneId: between.before,
    teachingStage,
    instruction: 'teach it',
    reason: 'REASON',
    idempotencyKey: 'k-1',
    admitBy: Date.now() + 60_000,
  } as unknown as SceneInsertionRequest;
}

/** The blocks of this lesson, as `bookPartBlocksFor` reads them off the attempt. */
const BLOCKS = {
  ownerBlockOf: (unitId: string) => ({ u1: 1, u3: 1, u4: 3, u6: 3 })[unitId] as number | undefined,
  isObjectiveBlock: (flowIndex: number) => flowIndex === 1 || flowIndex === 3,
};

const OUTLINE = {
  outlines: [],
  requirement: 'r',
  generationComplete: true,
  createdAt: 1,
  updatedAt: 1,
};

describe('stagesOwnedByPart', () => {
  const both = [O1, O2];

  it('keeps the stages the position allows when the model is not g5.v12', () => {
    expect(stagesOwnedByPart(both, ['u3'], null)).toEqual(both);
    expect(stagesOwnedByPart(both, ['u3'], undefined)).toEqual(both);
  });

  it('keeps only the stage of the block that owns the part', () => {
    expect(stagesOwnedByPart(both, ['u3'], BLOCKS)).toEqual([O1]);
    expect(stagesOwnedByPart(both, ['u6'], BLOCKS)).toEqual([O2]);
    // The owner is the same whichever side of the boundary the position is on.
    expect(stagesOwnedByPart([O2], ['u3'], BLOCKS)).toEqual([]);
  });

  it('is not applied when the parts have no single owner', () => {
    expect(stagesOwnedByPart(both, ['u3', 'u4'], BLOCKS)).toEqual(both);
    expect(stagesOwnedByPart(both, ['u-prior'], BLOCKS)).toEqual(both);
  });
});

describe('an inserted slide at a block boundary (checkPositionAndUnits)', () => {
  const scenes = lesson('stage-x');

  it('g5.v12: a part of the first block is generated inside that block, with its stage', () => {
    // Between the first block's last slide and its quiz: inside the owner's block.
    const position = checkPositionAndUnits(
      request(['u3'], { after: 's1', before: 'q1' }, O1),
      scenes,
      OUTLINE,
      UNITS,
      FLOW,
      false,
      undefined,
      BLOCKS,
    );
    expect(position).toMatchObject({ at: 2, after: { id: 's1' }, before: { id: 'q1' } });
  });

  it('g5.v12: the same part is refused right after the quiz, where only the next block is allowed', () => {
    let error: unknown;
    try {
      checkPositionAndUnits(
        request(['u3'], { after: 'q1', before: 's2' }, O2),
        scenes,
        OUTLINE,
        UNITS,
        FLOW,
        false,
        undefined,
        BLOCKS,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TeachingPackageError);
    expect(error).toMatchObject({
      code: 'INSERTION_POSITION_NOT_ALLOWED',
      message:
        'that lesson part belongs to another objective block of the lesson: generate its slide inside the block that owns it',
      details: { allowedStages: [] },
    });
  });

  it('g5.v12: a part of the second block is generated there, and never with the first block’s stage', () => {
    expect(
      checkPositionAndUnits(
        request(['u6'], { after: 'q1', before: 's2' }, O2),
        scenes,
        OUTLINE,
        UNITS,
        FLOW,
        false,
        undefined,
        BLOCKS,
      ),
    ).toMatchObject({ at: 3, before: { id: 's2' } });
    expect(() =>
      checkPositionAndUnits(
        request(['u6'], { after: 's1', before: 'q1' }, O1),
        scenes,
        OUTLINE,
        UNITS,
        FLOW,
        false,
        undefined,
        BLOCKS,
      ),
    ).toThrowError(expect.objectContaining({ details: { allowedStages: [] } }));
  });

  it('g5.v11 is unchanged: the neighbour block’s stage is allowed, as before', () => {
    // The old behaviour at the boundary after the quiz: the slide takes the next block's stage.
    expect(
      checkPositionAndUnits(
        request(['u3'], { after: 'q1', before: 's2' }, O2),
        scenes,
        OUTLINE,
        UNITS,
        FLOW,
        false,
      ),
    ).toMatchObject({ at: 3 });
    expect(
      checkPositionAndUnits(
        request(['u3'], { after: 'q1', before: 's2' }, O2),
        scenes,
        OUTLINE,
        UNITS,
        FLOW,
        false,
        undefined,
        null,
      ),
    ).toMatchObject({ at: 3 });
  });
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
}

describe('readInsertionContext reads the blocks off a version', () => {
  let pool: PGlitePool;
  let counter = 0;
  const qp = () => pool as never;

  /** A draft whose producing attempt pinned the book, the parts and the flow, with its units. */
  async function seed(model: { key: string; version: string }) {
    const n = (counter += 1);
    const stageId = `stage-ins-${n}`;
    const versionId = `tpv-ins-${n}`;
    const attemptId = `tpa-ins-${n}`;
    const item = { type: 'lesson' as const, id: `li-ins-${n}` };
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(makeDocument(stageId, 'Insertion', lesson(stageId)));
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: TENANT, learningItem: item },
      version: 1,
      status: 'draft',
      currentStageId: stageId,
      currentAttemptId: attemptId,
      teachingModel: model,
      now: 1,
    });
    await insertAttempt(qp(), {
      id: attemptId,
      aggregate: { tenantId: TENANT, learningItem: item },
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: model,
      inputSnapshot: {
        learningItem: item,
        teachingModel: model,
        learningObjectives: OBJECTIVES,
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
        teachingFlow: FLOW,
        bookStructure: BOOK,
      },
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
    return { versionId, stageId };
  }

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
  });

  afterEach(async () => {
    await pool.db.close();
  });

  it('g5.v12: each part has the block that owns it', async () => {
    const { versionId, stageId } = await seed(V12);

    const context = await readInsertionContext(pool as never, {
      tenantId: TENANT,
      versionId,
      stageId,
    });

    expect(context.blocks!.ownerBlockOf('u1')).toBe(1);
    // A kind-less part has its owner too (EN-3).
    expect(context.blocks!.ownerBlockOf('u3')).toBe(1);
    expect(context.blocks!.ownerBlockOf('u4')).toBe(3);
    expect(context.blocks!.ownerBlockOf('u6')).toBe(3);
    // A unit the engine places by rule belongs to no block.
    expect(context.blocks!.ownerBlockOf('u-prior')).toBeUndefined();
    expect(context.blocks!.isObjectiveBlock(1)).toBe(true);
    expect(context.blocks!.isObjectiveBlock(2)).toBe(false);
  });

  it('g5.v11 is unchanged: no blocks, so an insert takes the stage the position allows', async () => {
    const { versionId, stageId } = await seed(V11);

    const context = await readInsertionContext(pool as never, {
      tenantId: TENANT,
      versionId,
      stageId,
    });

    expect(context.blocks).toBeNull();
  });
});
