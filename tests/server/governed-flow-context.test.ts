import { describe, expect, it } from 'vitest';

import {
  resolveGovernedSceneFlowContext,
  type GovernedGenerationContext,
} from '@/lib/server/classroom-generation';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { SceneOutline } from '@openmaic/generation';

/**
 * Module 3/4 W1 (TAE-RQ-009/012, plan §7.1.2): a governed run resolves each
 * Scene's exact authoritative Flow entry ONCE, in orchestration, and refuses
 * — BEFORE Action generation — when that context cannot be resolved. A
 * non-governed run never resolves and never refuses.
 */

const governed: GovernedGenerationContext = {
  contract: 'kafuo.teaching-skills.v1',
  teachingModel: { key: 'g5', version: 'g5.v1' },
  flow: [
    { stage: 'lesson_introduction', instructions: 'Open the lesson.' },
    { stage: 'outcome_teaching_cards', instructions: '  Teach the outcome.  ' },
  ],
};

const outlineWith = (teachingStage?: SceneOutline['teachingStage']): SceneOutline =>
  ({
    id: 'o1',
    type: 'slide',
    title: 'Opening',
    description: 'd',
    keyPoints: [],
    order: 1,
    ...(teachingStage ? { teachingStage } : {}),
  }) as SceneOutline;

describe('resolveGovernedSceneFlowContext — fail-closed on a governed run', () => {
  it.each([
    ['missing teachingStage', outlineWith(undefined)],
    ['out-of-range flowIndex', outlineWith({ key: 'outcome_teaching_cards', flowIndex: 9 })],
    ['negative flowIndex', outlineWith({ key: 'lesson_introduction', flowIndex: -1 })],
    ['stage/key mismatch', outlineWith({ key: 'lesson_introduction', flowIndex: 1 })],
    ['empty instructions', outlineWith({ key: 'absent_instructions', flowIndex: 2 })],
  ] as const)('refuses (%s) with GOVERNED_FLOW_CONTEXT_UNRESOLVED', (_label, outline) => {
    const flow = [
      ...governed.flow,
      { stage: 'absent_instructions', instructions: '   ' },
    ] as GovernedGenerationContext['flow'];
    expect(() => resolveGovernedSceneFlowContext({ ...governed, flow }, outline)).toThrowError(
      TeachingPackageError,
    );
    try {
      resolveGovernedSceneFlowContext({ ...governed, flow }, outline);
    } catch (error) {
      const refusal = error as TeachingPackageError;
      expect(refusal.code).toBe('GOVERNED_FLOW_CONTEXT_UNRESOLVED');
      expect(refusal.status).toBe(422);
      // Identity-only details (§12.6) — never narration or source prose.
      expect(refusal.details).toMatchObject({
        teachingModel: 'g5@g5.v1',
        reason: expect.any(String),
      });
    }
  });

  it('returns the exact resolved entry for a valid triple', () => {
    const context = resolveGovernedSceneFlowContext(
      governed,
      outlineWith({ key: 'outcome_teaching_cards', flowIndex: 1 }),
    );
    expect(context).toEqual({
      teachingModelKey: 'g5',
      teachingModelVersion: 'g5.v1',
      stageKey: 'outcome_teaching_cards',
      flowIndex: 1,
      // Verbatim — not trimmed, not reformatted: byte-equal authority.
      instructions: '  Teach the outcome.  ',
    });
  });

  it('returns undefined for a non-governed input and never throws', () => {
    // An outline with NO teachingStage at all — legacy shapes pass through.
    expect(resolveGovernedSceneFlowContext(undefined, outlineWith(undefined))).toBeUndefined();
    expect(
      resolveGovernedSceneFlowContext(undefined, outlineWith({ key: 'x', flowIndex: 99 })),
    ).toBeUndefined();
  });
});
