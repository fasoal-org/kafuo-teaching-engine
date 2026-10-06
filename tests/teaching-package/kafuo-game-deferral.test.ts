/**
 * Kafuo Release 1 defers generated games — the Teaching Engine's own reading.
 *
 * The same predicate as Kafuo's `game_deferral.py`: a flow position permits a
 * game when its scene policy (or, without one, the legacy `lesson_learning_game`
 * rule) allows `interactive` with no widget restriction or with `game`. The
 * shared g5.v5 digest vector proves both sides read the same wire flow.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import {
  assertKafuoFlowWithoutGames,
  findGameScenesOutsideFlow,
  flowGamePositions,
  KAFUO_DEFERRED_WIDGET_TYPES,
} from '@/lib/server/teaching-package/kafuo-game-deferral';
import { diagnoseCandidateOutlines } from '@/lib/server/teaching-package/outline-correction';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { buildGenerationTools } from '@/lib/server/agent-runtime/generation-tools';
import type { CourseDocument, CourseStore } from '@/lib/server/agent-runtime/course-tools';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(path.join(here, '../fixtures/kafuo-digest-vectors.json'), 'utf8'),
) as {
  vectors: Array<{ request: { teachingModel: { version: string; flow: TeachingFlowEntry[] } } }>;
};

const V6_FLOW: TeachingFlowEntry[] = [
  {
    stage: 'lesson_opener',
    instructions: 'Open.',
    scenePolicy: { sceneTypes: ['slide'], cardinality: 'exactly_one' },
  },
  {
    stage: 'outcome_visual_explanations',
    instructions: 'Teach.',
    scenePolicy: { sceneTypes: ['slide'], cardinality: 'one_or_more' },
  },
  {
    stage: 'outcome_check_understanding',
    instructions: 'Check.',
    scenePolicy: { sceneTypes: ['quiz'], cardinality: 'exactly_one' },
  },
];

describe('flow positions that permit a game', () => {
  it('is only `game` that Release 1 defers', () => {
    expect(KAFUO_DEFERRED_WIDGET_TYPES).toEqual(['game']);
  });

  it('reads policies, the legacy game stage, and unrestricted interactive positions', () => {
    expect(flowGamePositions(V6_FLOW)).toEqual([]);
    expect(
      flowGamePositions([
        { stage: 'lesson_introduction', instructions: 'i' },
        { stage: 'outcome_teaching_cards', instructions: 'c' },
      ]),
    ).toEqual([]);
    expect(
      flowGamePositions([
        { stage: 'lesson_opener', instructions: 'i' },
        { stage: 'lesson_learning_game', instructions: 'Play.' },
      ]),
    ).toEqual([{ flowIndex: 1, stage: 'lesson_learning_game' }]);
    expect(
      flowGamePositions([
        {
          stage: 'x',
          instructions: 'i',
          scenePolicy: { sceneTypes: ['interactive'], cardinality: 'one_or_more' },
        },
        {
          stage: 'y',
          instructions: 'i',
          scenePolicy: {
            sceneTypes: ['interactive'],
            widgetTypes: ['simulation'],
            cardinality: 'exactly_one',
          },
        },
      ]),
    ).toEqual([{ flowIndex: 0, stage: 'x' }]);
  });

  it('finds the final game in the shared g5.v5 digest vector, as Kafuo does', () => {
    const v5 = vectors.vectors.find((vector) => vector.request.teachingModel.version === 'g5.v5')!;
    const flow = v5.request.teachingModel.flow;
    expect(flowGamePositions(flow)).toEqual([
      { flowIndex: flow.length - 1, stage: 'lesson_learning_game' },
    ]);
    for (const vector of vectors.vectors.filter(
      (v) => v.request.teachingModel.version === 'g5.v1',
    )) {
      expect(flowGamePositions(vector.request.teachingModel.flow)).toEqual([]);
    }
  });
});

describe('assertKafuoFlowWithoutGames', () => {
  const v5 = {
    key: 'g5',
    version: 'g5.v5',
    flow: [
      ...V6_FLOW,
      {
        stage: 'lesson_learning_game',
        instructions: 'Play.',
        scenePolicy: {
          sceneTypes: ['interactive'],
          widgetTypes: ['game'],
          cardinality: 'exactly_one',
        },
      },
    ] as TeachingFlowEntry[],
  };

  it('passes a game-free flow', () => {
    expect(() =>
      assertKafuoFlowWithoutGames({ key: 'g5', version: 'g5.v6', flow: V6_FLOW }, 'generate'),
    ).not.toThrow();
  });

  it.each([
    ['generate', 'Assign the game-free Teaching Model version'],
    ['resume', 'abandon it'],
  ] as const)(
    'refuses a game-bearing flow on %s with actionable guidance',
    (operation, guidance) => {
      let caught: unknown;
      try {
        assertKafuoFlowWithoutGames(v5, operation);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TeachingPackageError);
      expect(caught).toMatchObject({
        code: 'GAME_GENERATION_DEFERRED',
        status: 422,
        details: {
          teachingModel: { key: 'g5', version: 'g5.v5' },
          gamePositions: [{ flowIndex: 3, stage: 'lesson_learning_game' }],
        },
      });
      expect((caught as Error).message).toContain(guidance);
    },
  );
});

describe('findGameScenesOutsideFlow', () => {
  const scene = (id: string, type: string, flowIndex: number, widgetType?: string) =>
    ({
      id,
      type,
      content: widgetType ? { type: 'interactive', html: '', widgetType } : { type },
      teachingStage: { key: V6_FLOW[flowIndex]?.stage ?? 'lesson_learning_game', flowIndex },
    }) as unknown as AppScene;

  it('names a game at a position that does not permit one', () => {
    expect(
      findGameScenesOutsideFlow(
        [scene('s1', 'slide', 0), scene('g1', 'interactive', 1, 'game'), scene('q1', 'quiz', 2)],
        V6_FLOW,
      ),
    ).toEqual(['g1']);
  });

  it('ignores non-game interactive scenes and flows without scene policies', () => {
    expect(
      findGameScenesOutsideFlow([scene('i1', 'interactive', 1, 'simulation')], V6_FLOW),
    ).toEqual([]);
    expect(
      findGameScenesOutsideFlow(
        [scene('g1', 'interactive', 1, 'game')],
        [
          { stage: 'lesson_introduction', instructions: 'i' },
          { stage: 'outcome_teaching_cards', instructions: 'c' },
        ],
      ),
    ).toEqual([]);
  });
});

describe('admin correction', () => {
  it('reports an outline edited into a game as blocking', () => {
    const outlines: SceneOutline[] = [
      {
        id: 'o1',
        type: 'slide',
        slideType: 'cover',
        contentRole: 'orientation',
        title: 'Open',
        description: '',
        keyPoints: [],
        order: 1,
        teachingStage: { key: 'lesson_opener', flowIndex: 0 },
        visualPlan: { mode: 'native' },
      } as SceneOutline,
      {
        id: 'o2',
        type: 'interactive',
        widgetType: 'game',
        widgetOutline: { concept: 'x', gameType: 'quiz' },
        title: 'Game',
        description: '',
        keyPoints: [],
        order: 2,
        teachingStage: { key: 'outcome_visual_explanations', flowIndex: 1 },
      } as SceneOutline,
    ];
    const diagnosis = diagnoseCandidateOutlines(outlines, {
      flow: V6_FLOW,
      sourceImages: [],
    } as never);
    expect(diagnosis.blocking.map((d) => [d.code, d.outlineId])).toContainEqual([
      'WIDGET_TYPE_PROHIBITED',
      'o2',
    ]);
  });
});

describe('editor generate_scene', () => {
  function tools(isKafuo: boolean, aiCall = vi.fn(async () => '[]')) {
    let doc: CourseDocument | null = {
      stage: { id: 'stage-k', name: 'K', createdAt: 1, updatedAt: 1 },
      scenes: [],
      outline: { outlines: [], createdAt: 1, updatedAt: 1 },
    } as unknown as CourseDocument;
    const store = {
      loadDocument: vi.fn(async () => doc),
      putScene: vi.fn(async () => {}),
      saveDocument: vi.fn(async (next: CourseDocument) => {
        doc = next;
      }),
    } as unknown as CourseStore;
    const built = buildGenerationTools({
      store,
      stageAccess: async () => ({ kind: 'owned' as const }),
      sessionId: 'session-k',
      onCheckpoint: vi.fn(),
      synthesizeTts: vi.fn(async () => ({
        available: true,
        changed: false,
        generated: 0,
        skipped: 0,
        failed: [],
      })),
      aiCall,
      isKafuoPackageStage: async () => isKafuo,
    } as never);
    const generate = built.find((tool) => tool.name === 'generate_scene') as AgentTool<
      never,
      never
    >;
    return { generate, store, aiCall };
  }

  const gameParams = {
    stageId: 'stage-k',
    order: 1,
    title: 'Race',
    type: 'interactive',
    brief: 'A fraction race',
    widgetType: 'game',
    widgetOutline: { concept: 'fractions', gameType: 'quiz' },
  };

  it('refuses a game on a Kafuo package Stage without calling a model or writing', async () => {
    const { generate, store, aiCall } = tools(true);
    const response = await generate.execute('call', gameParams as never);
    expect(response).toMatchObject({
      isError: true,
      details: { error: 'GAME_GENERATION_DEFERRED' },
    });
    expect(aiCall).not.toHaveBeenCalled();
    expect(store.putScene).not.toHaveBeenCalled();
    expect(store.saveDocument).not.toHaveBeenCalled();
  });

  it('leaves game generation available on any other Stage', async () => {
    const { generate, aiCall } = tools(false);
    const response = await generate.execute('call', gameParams as never);
    expect(response).not.toMatchObject({ details: { error: 'GAME_GENERATION_DEFERRED' } });
    expect(aiCall).toHaveBeenCalled();
  });
});
