import { describe, expect, it } from 'vitest';

import {
  flowPositionDeleteRefusal,
  SCENE_DELETE_EMPTIES_FLOW_POSITION,
} from '@/lib/server/teaching-package/flow-position-guard';
import { FLOW_POSITION_REFUSAL_CODE } from '@/lib/store/stage';

/**
 * ED-3 (critical items before package regeneration, 27 Nov 2026): the document route
 * refuses a write that takes the only page of a lesson flow position away — the server
 * half of the rail's delete guard.
 */

const EXPL_1 = { key: 'outcome_visual_explanations', flowIndex: 1 };
const CHECK_1 = { key: 'outcome_check_understanding', flowIndex: 2 };
const EXPL_2 = { key: 'outcome_visual_explanations', flowIndex: 3 };

type Row = { id: string; type: string; teachingStage?: { key: string; flowIndex: number } };

const STORED: Row[] = [
  { id: 's1', type: 'slide', teachingStage: EXPL_1 },
  { id: 's1b', type: 'slide', teachingStage: EXPL_1 },
  { id: 'q1', type: 'quiz', teachingStage: CHECK_1 },
  { id: 's2', type: 'slide', teachingStage: EXPL_2 },
];

/** The stored scenes as the guard's one read returns them (jsonb as text, like PGlite may). */
function reader(rows: Row[], asText = false) {
  const queries: string[] = [];
  return {
    queries,
    query: async (sql: string) => {
      queries.push(sql);
      return {
        rows: rows.map((row) => ({
          id: row.id,
          type: row.type,
          teaching_stage:
            row.teachingStage === undefined
              ? null
              : asText
                ? JSON.stringify(row.teachingStage)
                : row.teachingStage,
        })),
      };
    },
  };
}

function put(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const document = (rows: Row[]) => ({ stage: { id: 'stage-1' }, scenes: rows });

describe('flowPositionDeleteRefusal', () => {
  it('refuses a whole-document save that drops an objective’s check quiz', async () => {
    const refusal = await flowPositionDeleteRefusal(
      put('/documents/stage-1', document(STORED.filter((row) => row.id !== 'q1'))),
      '/documents/stage-1',
      reader(STORED),
    );
    expect(refusal).toMatchObject({
      status: 422,
      code: SCENE_DELETE_EMPTIES_FLOW_POSITION,
      positions: [CHECK_1.flowIndex],
      scenes: [{ id: 'q1', flowIndex: CHECK_1.flowIndex }],
    });
  });

  it('refuses a save that drops an objective’s last slide, even beside its try-it quiz', async () => {
    const stored: Row[] = [
      { id: 's1', type: 'slide', teachingStage: EXPL_1 },
      { id: 'try', type: 'quiz', teachingStage: EXPL_1 },
      { id: 'q1', type: 'quiz', teachingStage: CHECK_1 },
    ];
    const refusal = await flowPositionDeleteRefusal(
      put('/documents/stage-1', document(stored.slice(1))),
      '/documents/stage-1',
      reader(stored, true),
    );
    expect(refusal?.positions).toEqual([EXPL_1.flowIndex]);
  });

  it('lets through a delete of one of two slides, a reorder and a replaced page', async () => {
    const keepsPositions = [
      STORED.filter((row) => row.id !== 's1b'),
      [...STORED].reverse(),
      [
        ...STORED.filter((row) => row.id !== 'q1'),
        { id: 'q1-new', type: 'quiz', teachingStage: CHECK_1 },
      ],
    ];
    for (const scenes of keepsPositions) {
      await expect(
        flowPositionDeleteRefusal(
          put('/documents/stage-1', document(scenes)),
          '/documents/stage-1',
          reader(STORED),
        ),
      ).resolves.toBeNull();
    }
  });

  it('never refuses a lesson for a position it had already lost', async () => {
    const broken: Row[] = [
      { id: 's1', type: 'slide', teachingStage: EXPL_1 },
      { id: 's2', type: 'slide', teachingStage: EXPL_2 },
    ];
    await expect(
      flowPositionDeleteRefusal(
        put('/documents/stage-1', document(broken)),
        '/documents/stage-1',
        reader(broken),
      ),
    ).resolves.toBeNull();
  });

  it('covers a scene DELETE and a scene PUT that moves its scene off the position', async () => {
    const deleted = await flowPositionDeleteRefusal(
      new Request('http://localhost/documents/stage-1/scenes/q1', { method: 'DELETE' }),
      '/documents/stage-1/scenes/q1',
      reader(STORED),
    );
    expect(deleted?.scenes).toEqual([{ id: 'q1', flowIndex: CHECK_1.flowIndex }]);
    const moved = await flowPositionDeleteRefusal(
      put('/documents/stage-1/scenes/q1', { id: 'q1', type: 'quiz', teachingStage: EXPL_2 }),
      '/documents/stage-1/scenes/q1',
      reader(STORED),
    );
    expect(moved?.positions).toEqual([CHECK_1.flowIndex]);
    await expect(
      flowPositionDeleteRefusal(
        put('/documents/stage-1/scenes/s1b', { id: 's1b', type: 'slide', teachingStage: EXPL_1 }),
        '/documents/stage-1/scenes/s1b',
        reader(STORED),
      ),
    ).resolves.toBeNull();
  });

  it('a scene PUT that leaves teachingStage out keeps the stored position (the store carries it)', async () => {
    await expect(
      flowPositionDeleteRefusal(
        put('/documents/stage-1/scenes/q1', { id: 'q1', type: 'quiz' }),
        '/documents/stage-1/scenes/q1',
        reader(STORED),
      ),
    ).resolves.toBeNull();
    // An explicit null removes it, as the store writes it.
    const cleared = await flowPositionDeleteRefusal(
      put('/documents/stage-1/scenes/q1', { id: 'q1', type: 'quiz', teachingStage: null }),
      '/documents/stage-1/scenes/q1',
      reader(STORED),
    );
    expect(cleared?.positions).toEqual([CHECK_1.flowIndex]);
  });

  it('never judges a non-package stage, a read or an unreadable body', async () => {
    const plain: Row[] = [{ id: 'a', type: 'slide' }];
    await expect(
      flowPositionDeleteRefusal(
        put('/documents/stage-1', document([])),
        '/documents/stage-1',
        reader(plain),
      ),
    ).resolves.toBeNull();
    const read = reader(STORED);
    await expect(
      flowPositionDeleteRefusal(
        new Request('http://localhost/documents/stage-1'),
        '/documents/stage-1',
        read,
      ),
    ).resolves.toBeNull();
    expect(read.queries).toHaveLength(0);
    await expect(
      flowPositionDeleteRefusal(
        new Request('http://localhost/documents/stage-1', { method: 'PUT', body: 'not json' }),
        '/documents/stage-1',
        reader(STORED),
      ),
    ).resolves.toBeNull();
  });

  // g5.v12 (A-32): a check quiz the run dropped leaves its position empty from the start.
  // The guard is a delta check, and the rail's order check only needs ascending positions,
  // so a teacher's save, drag or Restore on such a lesson is never refused for that gap.
  it('A-32: a package whose check quiz was dropped keeps saving, reordering and deleting', async () => {
    const dropped = STORED.filter((row) => row.id !== 'q1');
    const reordered = [dropped[1]!, dropped[0]!, dropped[2]!];
    expect(
      await flowPositionDeleteRefusal(
        put('/documents/stage-1', document(reordered)),
        '/documents/stage-1',
        reader(dropped),
      ),
    ).toBeNull();
    expect(
      await flowPositionDeleteRefusal(
        new Request('http://localhost/documents/stage-1/scenes/s1b', { method: 'DELETE' }),
        '/documents/stage-1/scenes/s1b',
        reader(dropped),
      ),
    ).toBeNull();
    const { keepsTeachingOrder } = await import('@/lib/edit/scene-defaults');
    expect(keepsTeachingOrder(dropped)).toBe(true);
  });

  it('the editor maps exactly this code to its terminal resync', () => {
    expect(FLOW_POSITION_REFUSAL_CODE).toBe(SCENE_DELETE_EMPTIES_FLOW_POSITION);
  });
});
