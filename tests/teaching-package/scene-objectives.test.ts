import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene } from '@/lib/document-store/validators';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { insertVersion } from '@/lib/persistence/teaching-package';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import { cloneStageForSuccessor } from '@/lib/server/teaching-package/stage-clone';
import {
  normalizeAssignment,
  setSceneLearningObjectives,
} from '@/lib/server/teaching-package/scene-objectives';
import { validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';
import type { SceneLearningObjectiveRef } from '@/lib/types/teaching-package';
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

function objectives(): SceneLearningObjectiveRef[] {
  return [
    {
      objectiveRef: 'obj-1',
      snapshot: {
        statement: 'Explain <b>photosynthesis</b>',
        label: 'Photosynthesis',
        context: 'Unit 3',
      },
      capturedAt: 1_700_000_000_000,
    },
  ];
}

function quizScene(stageId: string): AppScene {
  return {
    id: 'scene-quiz',
    stageId,
    title: 'Quiz',
    order: 2,
    type: 'quiz',
    content: { type: 'quiz', questions: [] },
    learningObjectives: objectives(),
  } as AppScene;
}

function interactiveScene(stageId: string): AppScene {
  return {
    id: 'scene-interactive',
    stageId,
    title: 'Interactive',
    order: 3,
    type: 'interactive',
    content: { type: 'interactive', url: 'https://example.test/widget' },
    learningObjectives: objectives(),
  } as AppScene;
}

function pblScene(stageId: string): AppScene {
  return {
    id: 'scene-pbl',
    stageId,
    title: 'PBL',
    order: 4,
    type: 'pbl',
    content: {
      type: 'pbl',
      projectConfig: {
        projectInfo: { title: 'Project', description: 'Build it' },
        agents: [],
        issueboard: { agent_ids: [], issues: [], current_issue_id: null },
        chat: { messages: [] },
      },
    },
    learningObjectives: objectives(),
  } as AppScene;
}

describe('scene learning objectives', () => {
  describe('write-boundary validation', () => {
    it('accepts a legacy scene without the field', () => {
      const scene = makeSlideScene('scene-1', 'stage-1', 1);
      expect(validateAppScene(scene)).toEqual({ valid: true });
    });

    it('accepts a valid array on all four scene types', () => {
      const slide = makeSlideScene('scene-1', 'stage-1', 1);
      slide.learningObjectives = objectives();
      expect(validateAppScene(slide)).toEqual({ valid: true });
      expect(validateAppScene(quizScene('stage-1'))).toEqual({ valid: true });
      expect(validateAppScene(interactiveScene('stage-1'))).toEqual({ valid: true });
      expect(validateAppScene(pblScene('stage-1'))).toEqual({ valid: true });
    });

    it('rejects malformed entries at /learningObjectives/<i>/…', () => {
      const base = makeSlideScene('scene-1', 'stage-1', 1);
      const cases: Array<[unknown, string]> = [
        ['not an array', '/learningObjectives'],
        [[{ snapshot: { statement: 'x' }, capturedAt: 1 }], '/learningObjectives/0/objectiveRef'],
        [
          [{ objectiveRef: 'obj', snapshot: { statement: '' }, capturedAt: 1 }],
          '/learningObjectives/0/snapshot/statement',
        ],
        [
          [{ objectiveRef: 'obj', snapshot: null, capturedAt: 1 }],
          '/learningObjectives/0/snapshot',
        ],
        [
          [{ objectiveRef: 'obj', snapshot: { statement: 'x' } }],
          '/learningObjectives/0/capturedAt',
        ],
      ];
      for (const [value, path] of cases) {
        const scene = { ...base, learningObjectives: value } as unknown as AppScene;
        const result = validateAppScene(scene);
        expect(result.valid, JSON.stringify(value)).toBe(false);
        const paths = result.valid ? [] : result.errors.map((issue) => issue.path);
        expect(paths, `${JSON.stringify(value)} → ${path}`).toContain(path);
      }
    });

    it('rejects non-string label/context inside the snapshot', () => {
      const scene = {
        ...makeSlideScene('scene-1', 'stage-1', 1),
        learningObjectives: [
          {
            objectiveRef: 'obj-1',
            snapshot: { statement: 'x', label: 7 },
            capturedAt: 1,
          },
        ],
      } as unknown as AppScene;
      const result = validateAppScene(scene);
      expect(result.valid).toBe(false);
      expect(result.valid ? [] : result.errors.map((issue) => issue.path)).toContain(
        '/learningObjectives/0/snapshot/label',
      );
    });

    it('preserves the DSL result for slide/quiz scenes', () => {
      const brokenSlide = {
        ...makeSlideScene('scene-1', 'stage-1', 1),
        order: 'first',
        learningObjectives: objectives(),
      } as unknown as AppScene;
      const result = validateAppScene(brokenSlide);
      expect(result.valid).toBe(false);
      const paths = result.valid ? [] : result.errors.map((issue) => issue.path);
      expect(paths).toContain('/order');
      expect(paths.some((path) => path.startsWith('/learningObjectives'))).toBe(false);
    });

    it('leaves objective snapshot text untouched through sanitizeSceneContent', () => {
      const scene = quizScene('stage-1');
      const sanitized = sanitizeSceneContent(scene);
      expect(sanitized.learningObjectives).toEqual(objectives());
      expect(sanitized.learningObjectives![0]!.snapshot.statement).toBe(
        'Explain <b>photosynthesis</b>',
      );
    });
  });

  describe('persistence round-trip (PGlite)', () => {
    let pool: PGlitePool;
    let counter = 0;
    const unique = (prefix: string) => `${prefix}-obj-${(counter += 1)}`;
    const qp = () => pool as never;
    const txPool = () => pool as unknown as ConnectableQueryable;

    beforeEach(async () => {
      vi.resetModules();
      vi.unstubAllEnvs();
      vi.stubEnv('DATABASE_URL', `postgres://scene-obj-${randomUUID()}`);
      vi.stubEnv('ASSET_S3_BUCKET', '');
      vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
      const db = new PGlite();
      await db.waitReady;
      pool = new PGlitePool(db);
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    });

    afterEach(async () => {
      await pool.end();
      vi.unstubAllEnvs();
    });

    async function seedVersion(status: 'draft' | 'in_review' | 'approved'): Promise<string> {
      const stageId = unique('stage');
      const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
        pool,
        ownerId: TEACHING_PACKAGE_STAGE_OWNER,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
        mutationFence: teachingPackageStageGuardFence(),
      });
      await store.saveDocument(
        makeDocument(stageId, 'Objectives course', [
          makeSlideScene('scene-1', stageId, 1),
          quizScene(stageId),
        ]),
      );
      const versionId = unique('tpv');
      await insertVersion(qp(), {
        id: versionId,
        learningItem: { type: 'lesson', id: unique('li') },
        version: 1,
        status,
        currentStageId: stageId,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        now: 1,
      });
      return versionId;
    }

    it('sets, reads back, and clears objectives through putScene', async () => {
      const versionId = await seedVersion('draft');
      const now = 1_800_000_000_000;
      const result = await setSceneLearningObjectives(txPool(), versionId, [
        normalizeAssignment({ sceneId: 'scene-1', learningObjectives: objectives() }, now),
      ]);
      expect(result.updatedSceneIds).toEqual(['scene-1']);

      const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
      const { readVersion } = await import('@/lib/persistence/teaching-package');
      const version = (await readVersion(qp(), versionId))!;
      const document = await store.loadDocument(version.currentStageId);
      expect(document!.scenes[0]).toMatchObject({
        id: 'scene-1',
        learningObjectives: objectives(),
      });
      // The quiz scene carried its objectives through the initial save too.
      expect(document!.scenes[1]).toMatchObject({ learningObjectives: objectives() });

      // An empty array clears the annotation.
      await setSceneLearningObjectives(txPool(), versionId, [
        normalizeAssignment({ sceneId: 'scene-1', learningObjectives: [] }, now),
      ]);
      const after = await store.loadDocument(version.currentStageId);
      expect(after!.scenes[0]!.learningObjectives).toEqual([]);
    });

    it('round-trips through saveDocument and cloneStageForSuccessor', async () => {
      const stageId = unique('stage');
      const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
      const annotated = makeSlideScene('scene-1', stageId, 1);
      annotated.learningObjectives = objectives();
      await store.saveDocument(makeDocument(stageId, 'Clone me', [annotated]));

      const { stageId: cloneId } = await cloneStageForSuccessor(store, stageId, {
        producerRef: 'tpv-clone-src',
      });
      const clone = await store.loadDocument(cloneId);
      expect(clone!.scenes[0]!.learningObjectives).toEqual(objectives());

      const source = await store.loadDocument(stageId);
      expect(source!.scenes[0]!.learningObjectives).toEqual(objectives());
    });

    it('refuses objective writes on in_review and approved versions', async () => {
      for (const status of ['in_review', 'approved'] as const) {
        const versionId = await seedVersion(status);
        await expect(
          setSceneLearningObjectives(txPool(), versionId, [
            normalizeAssignment(
              { sceneId: 'scene-1', learningObjectives: objectives() },
              Date.now(),
            ),
          ]),
        ).rejects.toMatchObject({ code: 'INVALID_TRANSITION', status: 409 });
      }
    });

    it('refuses an unknown scene id with 400', async () => {
      const versionId = await seedVersion('draft');
      await expect(
        setSceneLearningObjectives(txPool(), versionId, [
          normalizeAssignment(
            { sceneId: 'scene-absent', learningObjectives: objectives() },
            Date.now(),
          ),
        ]),
      ).rejects.toBeInstanceOf(TeachingPackageError);
    });

    it('stamps capturedAt when the caller omits it', () => {
      const now = 1_234_567_890;
      const assignment = normalizeAssignment(
        {
          sceneId: 'scene-1',
          learningObjectives: [{ objectiveRef: 'obj-9', snapshot: { statement: 's' } }],
        },
        now,
      );
      expect(assignment.learningObjectives[0]!.capturedAt).toBe(now);
    });
  });
});
