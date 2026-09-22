/**
 * Slide semantics, end to end through the Teaching Package pipeline:
 *
 *   classified outline
 *     → buildCompleteScene (via createSceneWithActions, the generation seam)
 *     → in-memory stage store (the same StageAPI generateClassroom uses)
 *     → Teaching Package persistence sink → saveDocument (PostgreSQL)
 *     → loadDocument → JSON (what GET /api/stages/[id] serializes)
 *     → successor clone
 *
 * TypeScript presence proves nothing about persistence, so every assertion
 * below reads the fields back from the store. The classification is copied,
 * never inferred; historical slides without it load and stay without it.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureTeachingPackageSchema } from '@/lib/persistence/teaching-package';
import { createSceneWithActions } from '@/lib/server/scene-generation';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { AppScene, Scene, SlideContent, Stage } from '@/lib/types/stage';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

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

function inMemoryStageStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };
  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      state = { ...state, ...partial };
    },
    subscribe: () => () => {},
  } as unknown as StageStore;
}

const SLIDE_CONTENT = {
  elements: [
    {
      id: 'text-1',
      type: 'text' as const,
      left: 0,
      top: 0,
      width: 400,
      height: 80,
      // Deliberately misleading prose: nothing may classify from it.
      content: 'Summary and conclusion',
      rotate: 0,
      lineHeight: 1,
      fill: '#000000',
      vertical: false,
      defaultFontName: 'Arial',
      defaultColor: '#000000',
    },
  ],
};

function outline(order: number, extra: Partial<SceneOutline>): SceneOutline {
  return {
    id: `outline_${order}`,
    type: 'slide',
    title: `Scene ${order}`,
    description: 'D',
    keyPoints: ['k'],
    order,
    ...extra,
  };
}

const OUTLINES: SceneOutline[] = [
  outline(1, { slideType: 'cover', contentRole: 'orientation' }),
  outline(2, { slideType: 'content', contentRole: 'explanation', contentKind: 'concept' }),
  outline(3, { slideType: 'content', contentRole: 'explanation', contentKind: 'definition' }),
  outline(4, { slideType: 'content', contentRole: 'worked_example' }),
  outline(5, { slideType: 'content', contentRole: 'activity', contentKind: 'source_analysis' }),
  outline(6, { slideType: 'content', contentRole: 'practice', contentKind: 'guided' }),
  outline(7, {
    type: 'quiz',
    quizConfig: { questionCount: 1, difficulty: 'easy', questionTypes: ['single'] },
  }),
  outline(8, { slideType: 'end', contentRole: 'summary' }),
];

/** [Slide.type, contentRole, contentKind] of a slide scene, as stored. */
function semanticsOf(scene: AppScene): [unknown, unknown, unknown] {
  const content = scene.content as SlideContent;
  return [content.canvas.type, content.contentRole, content.contentKind];
}

describe('slide semantics survive generation → Teaching Package persistence', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://semantics-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  function makeStore() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  /** The generation seam, exactly as generateClassroom drives it. */
  function generateScenes(stageId: string): Scene[] {
    const stage = { id: stageId, name: 'Semantics', createdAt: 1, updatedAt: 1 } as Stage;
    const store = inMemoryStageStore(stage);
    const api = createStageAPI(store);
    for (const planned of OUTLINES) {
      const generated = planned.type === 'quiz' ? { questions: [] } : SLIDE_CONTENT;
      expect(createSceneWithActions(planned, generated, [], api)).toBeTruthy();
    }
    return store.getState().scenes;
  }

  async function persist(
    stageId: string,
    scenes: Scene[],
    stageExtra: Record<string, unknown> = {},
    outlines: SceneOutline[] = OUTLINES,
  ) {
    const { createTeachingPackagePersistenceSink } =
      await import('@/lib/server/teaching-package/stage-persistence-sink');
    await createTeachingPackagePersistenceSink('tpa-semantics').persist(
      {
        id: stageId,
        stage: {
          id: stageId,
          name: 'Semantics',
          createdAt: 1,
          updatedAt: 1,
          ...stageExtra,
        } as never,
        scenes: scenes as never[],
        outlines: outlines as never[],
      },
      '',
    );
  }

  it('persists and retrieves every planned classification unchanged', async () => {
    const stageId = `stage-sem-${randomUUID().slice(0, 8)}`;
    await persist(stageId, generateScenes(stageId));

    const loaded = await makeStore().loadDocument(stageId);
    // What a client receives: the document after a JSON round trip.
    const document = JSON.parse(JSON.stringify(loaded)) as NonNullable<typeof loaded>;
    const byOrder = new Map(document.scenes.map((scene) => [scene.order, scene]));

    expect(byOrder.get(1)!.type).toBe('slide');
    expect(semanticsOf(byOrder.get(1)!)).toEqual(['cover', 'orientation', undefined]);
    expect(semanticsOf(byOrder.get(2)!)).toEqual(['content', 'explanation', 'concept']);
    expect(semanticsOf(byOrder.get(3)!)).toEqual(['content', 'explanation', 'definition']);
    expect(semanticsOf(byOrder.get(4)!)).toEqual(['content', 'worked_example', undefined]);
    expect(semanticsOf(byOrder.get(5)!)).toEqual(['content', 'activity', 'source_analysis']);
    expect(semanticsOf(byOrder.get(6)!)).toEqual(['content', 'practice', 'guided']);
    expect(semanticsOf(byOrder.get(8)!)).toEqual(['end', 'summary', undefined]);

    // A role without kinds is stored WITHOUT the key, not with a null/default.
    expect(byOrder.get(1)!.content).not.toHaveProperty('contentKind');
    expect(byOrder.get(4)!.content).not.toHaveProperty('contentKind');

    // The quiz is a quiz, untouched by the slide metadata.
    const quiz = byOrder.get(7)!;
    expect(quiz.type).toBe('quiz');
    expect(quiz.content).toEqual({ type: 'quiz', questions: [] });

    // The outline layer's sequence is authoritative: nothing was inserted.
    expect(document.scenes.map((scene) => scene.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const slideTypes = document.scenes
      .filter((scene) => scene.type === 'slide')
      .map((scene) => semanticsOf(scene)[0]);
    expect(slideTypes).not.toContain('contents');
    expect(slideTypes).not.toContain('transition');

    // The planned outlines are persisted with their classification too.
    const storedOutlines = (document.outline as { outlines: SceneOutline[] }).outlines;
    expect(storedOutlines[1]).toMatchObject({
      slideType: 'content',
      contentRole: 'explanation',
      contentKind: 'concept',
    });
  });

  it('carries on-demand assistance through persistence, retrieval and the successor clone', async () => {
    const { cloneStageForSuccessor } = await import('@/lib/server/teaching-package/stage-clone');
    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const assistance = {
      hint: '<p>Check the units</p>',
      explanation: '<p>Convert, then divide</p>',
    };
    const planned = outline(1, {
      slideType: 'content',
      contentRole: 'practice',
      contentKind: 'independent',
      assistancePlan: { hint: 'units', explanation: 'convert then divide' },
    });

    const stageId = `stage-assist-${randomUUID().slice(0, 8)}`;
    const stage = { id: stageId, name: 'Assistance', createdAt: 1, updatedAt: 1 } as Stage;
    const memory = inMemoryStageStore(stage);
    expect(
      createSceneWithActions(planned, { ...SLIDE_CONTENT, assistance }, [], createStageAPI(memory)),
    ).toBeTruthy();
    await persist(stageId, memory.getState().scenes, {}, [planned]);

    // What a client receives: the document after a JSON round trip.
    const loaded = JSON.parse(JSON.stringify(await makeStore().loadDocument(stageId)));
    const content = loaded.scenes[0].content as SlideContent;
    expect(content.assistance).toEqual(assistance);
    expect(content.canvas).not.toHaveProperty('assistance');
    // The hidden plan stays on the planning outline, never on the Scene.
    expect(loaded.outline.outlines[0].assistancePlan).toEqual(planned.assistancePlan);
    expect(JSON.stringify(loaded.scenes)).not.toContain('assistancePlan');

    const owned = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    const { stageId: cloneId } = await cloneStageForSuccessor(owned, stageId, {
      producerRef: 'successor-assistance',
    });
    const clone = (await makeStore().loadDocument(cloneId))!;
    expect((clone.scenes[0].content as SlideContent).assistance).toEqual(assistance);
  });

  it('persists the Stage language + text direction, through retrieval and the successor clone', async () => {
    const { cloneStageForSuccessor } = await import('@/lib/server/teaching-package/stage-clone');
    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const owned = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);

    for (const [language, textDirection] of [
      ['ar', 'rtl'],
      ['en', 'ltr'],
    ] as const) {
      const stageId = `stage-dir-${randomUUID().slice(0, 8)}`;
      await persist(stageId, generateScenes(stageId), { language, textDirection });

      const loaded = JSON.parse(JSON.stringify(await makeStore().loadDocument(stageId)));
      expect(loaded.stage).toMatchObject({ language, textDirection });

      const { stageId: cloneId } = await cloneStageForSuccessor(owned, stageId, {
        producerRef: 'successor-direction',
      });
      expect((await makeStore().loadDocument(cloneId))!.stage).toMatchObject({
        language,
        textDirection,
      });
    }

    // A historical Stage has neither field, before and after the round trip.
    const legacyId = `stage-dir-${randomUUID().slice(0, 8)}`;
    await persist(legacyId, generateScenes(legacyId));
    const legacy = (await makeStore().loadDocument(legacyId))!.stage;
    expect(legacy).not.toHaveProperty('language');
    expect(legacy).not.toHaveProperty('textDirection');
  });

  it('survives the successor clone', async () => {
    const stageId = `stage-sem-${randomUUID().slice(0, 8)}`;
    await persist(stageId, generateScenes(stageId));
    const { cloneStageForSuccessor } = await import('@/lib/server/teaching-package/stage-clone');
    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const owned = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    const { stageId: cloneId } = await cloneStageForSuccessor(owned, stageId, {
      producerRef: 'successor-semantics',
    });

    const clone = await makeStore().loadDocument(cloneId);
    const byOrder = new Map(clone!.scenes.map((scene) => [scene.order, scene]));
    expect(semanticsOf(byOrder.get(1)!)).toEqual(['cover', 'orientation', undefined]);
    expect(semanticsOf(byOrder.get(6)!)).toEqual(['content', 'practice', 'guided']);
  });

  it('a historical slide without the metadata persists, loads, and stays unclassified', async () => {
    const stageId = `stage-sem-${randomUUID().slice(0, 8)}`;
    const legacy = makeSlideScene('legacy-slide', stageId, 1);
    expect(legacy.content).not.toHaveProperty('contentRole');
    expect((legacy.content as SlideContent).canvas).not.toHaveProperty('type');

    await persist(stageId, [legacy as Scene]);
    const loaded = (await makeStore().loadDocument(stageId))!.scenes[0]!;

    expect(validateAppScene(loaded).valid).toBe(true);
    expect(semanticsOf(loaded)).toEqual([undefined, undefined, undefined]);
    expect(loaded.content).not.toHaveProperty('contentRole');
    expect(loaded.content).not.toHaveProperty('contentKind');
    expect((loaded.content as SlideContent).canvas).not.toHaveProperty('type');
  });

  it('an unclassified outline is refused at generation — no role is guessed, nothing ships unclassified', async () => {
    // RSS W2: rewritten. The generation seam used to ship an unclassified
    // slide; a NEWLY generated slide now fails instead (legacy persisted slides
    // stay validly unclassified — see the legacy test above).
    const stage = { id: 'stage-x', name: 'X', createdAt: 1, updatedAt: 1 } as Stage;
    const store = inMemoryStageStore(stage);
    expect(() =>
      createSceneWithActions(
        outline(1, { title: 'Summary', description: 'Lesson summary', keyPoints: ['Summary'] }),
        SLIDE_CONTENT,
        [],
        createStageAPI(store),
      ),
    ).toThrow(/OUTLINE_SLIDE_SEMANTICS_INVALID/);
    expect(store.getState().scenes).toEqual([]);
  });
});
