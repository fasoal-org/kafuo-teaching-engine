/**
 * W17 final hardening (teaching-skills plan §P Step 18 · §S row W17):
 *
 * 1. The W10 generation-time validator (`validateOutlineSkillSelections`) and
 *    the W12 submit validators implement overlapping rules independently —
 *    required scope/role and the `allowed` permission boundary. The W10–W12
 *    review (§4 of teaching-skills-w10-w12-review-report.md) verified they
 *    agree by reading; this pin makes drift a test failure: for every scenario
 *    in the matrix, W10 throws exactly when the corresponding W12 check fails.
 * 2. No `alignmentStale` flag is persisted anywhere across W14–W17 — alignment
 *    state is derived (§K), and a source scan proves no mutable flag ever
 *    landed in application code.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  validateOutlineSkillSelections,
  type OutlineSkillSelectionShape,
} from '@/lib/server/teaching-package/skill-policy';
import {
  validateRequiredSkillSatisfaction,
  validateSkillAssignmentStructure,
} from '@/lib/server/teaching-package/skill-validators';
import type { TeachingFlowEntry, TeachingSkillRef } from '@/lib/types/teaching-package';

const FEYNMAN: TeachingSkillRef = { skillId: 'feynman-learning', version: 'v1' };
const LECTURE: TeachingSkillRef = { skillId: 'lecture-style', version: 'v1' };
const DEEP_RESEARCH: TeachingSkillRef = { skillId: 'deep-research', version: 'v1' };

function flowWithPolicy(overrides: Partial<TeachingFlowEntry['skillPolicy']>): TeachingFlowEntry[] {
  return [
    {
      stage: 'lesson_introduction',
      instructions: 'i',
      skillPolicy: {
        required: [],
        preferred: [],
        allowed: [FEYNMAN, LECTURE],
        combinationRestrictions: [],
        ...overrides,
      },
    },
  ];
}

function outline(
  overrides: Partial<OutlineSkillSelectionShape> & { id: string },
): OutlineSkillSelectionShape {
  return {
    teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    teachingSkills: { primary: FEYNMAN, classification: 'instructional' },
    ...overrides,
  };
}

/** Run W10 (throws) and report whether it refused, and with which code. */
function w10Outcome(
  outlines: OutlineSkillSelectionShape[],
  flow: TeachingFlowEntry[],
): { accepted: true } | { accepted: false; code: string } {
  try {
    validateOutlineSkillSelections(outlines, flow);
    return { accepted: true };
  } catch (error) {
    if (error instanceof TeachingPackageError) {
      return { accepted: false, code: error.code };
    }
    throw error;
  }
}

/** The W12 checks that own W10's overlapping rules. */
function w12Outcome(
  outlines: OutlineSkillSelectionShape[],
  flow: TeachingFlowEntry[],
): { accepted: true } | { accepted: false; code: string } {
  const failure =
    validateSkillAssignmentStructure(outlines, flow) ??
    validateRequiredSkillSatisfaction(outlines, flow);
  return failure ? { accepted: false, code: failure.code } : { accepted: true };
}

describe('W17 hardening: W10 and W12 validators agree (generation never accepts what Submit rejects)', () => {
  const scenarios: Array<{
    name: string;
    outlines: OutlineSkillSelectionShape[];
    flow: TeachingFlowEntry[];
  }> = [
    {
      name: 'in-policy instructional selection with primary',
      outlines: [outline({ id: 'o1' })],
      flow: flowWithPolicy({}),
    },
    {
      name: 'out-of-policy selection (allowed boundary)',
      outlines: [
        outline({
          id: 'o1',
          teachingSkills: { primary: DEEP_RESEARCH, classification: 'instructional' },
        }),
      ],
      flow: flowWithPolicy({}),
    },
    {
      name: 'flow_position required rule satisfied',
      outlines: [outline({ id: 'o1' })],
      flow: flowWithPolicy({
        required: [{ skill: FEYNMAN, scope: 'flow_position', role: 'primary' }],
      }),
    },
    {
      name: 'flow_position required rule unsatisfied (different skill selected)',
      outlines: [
        outline({
          id: 'o1',
          teachingSkills: { primary: LECTURE, classification: 'instructional' },
        }),
      ],
      flow: flowWithPolicy({
        required: [{ skill: FEYNMAN, scope: 'flow_position', role: 'primary' }],
      }),
    },
    {
      name: 'every_instructional_scene rule satisfied on the one instructional outline',
      outlines: [outline({ id: 'o1' })],
      flow: flowWithPolicy({
        required: [{ skill: FEYNMAN, scope: 'every_instructional_scene', role: 'primary' }],
      }),
    },
    {
      name: 'every_instructional_scene rule unsatisfied on one of two outlines',
      outlines: [
        outline({ id: 'o1' }),
        outline({
          id: 'o2',
          teachingSkills: { primary: LECTURE, classification: 'instructional' },
        }),
      ],
      flow: flowWithPolicy({
        required: [{ skill: FEYNMAN, scope: 'every_instructional_scene', role: 'primary' }],
      }),
    },
    {
      name: 'explicit non-instructional outline exempt from an every-scene rule',
      outlines: [
        outline({ id: 'o1' }),
        outline({ id: 'o2', teachingSkills: { classification: 'non-instructional' } }),
      ],
      flow: flowWithPolicy({
        required: [{ skill: FEYNMAN, scope: 'every_instructional_scene', role: 'primary' }],
      }),
    },
    {
      name: 'required as supporting but selected as primary (role mismatch)',
      outlines: [outline({ id: 'o1' })],
      flow: flowWithPolicy({
        required: [{ skill: FEYNMAN, scope: 'flow_position', role: 'supporting' }],
      }),
    },
  ];

  it.each(scenarios)('$name', ({ outlines, flow }) => {
    const w10 = w10Outcome(outlines, flow);
    const w12 = w12Outcome(outlines, flow);
    // Same accept/refuse verdict, and on refusal the same business code — the
    // drift hazard the review flagged is now a test failure.
    expect(w10.accepted, `W10=${JSON.stringify(w10)} W12=${JSON.stringify(w12)}`).toBe(
      w12.accepted,
    );
    if (!w10.accepted && !w12.accepted) {
      expect(w10.code).toBe(w12.code);
    }
  });
});

describe('W17 hardening: no persisted alignment flag', () => {
  it('no alignmentStale-style mutable flag exists anywhere in application code', () => {
    // §K: the four functional states are DERIVED at read; only the baseline
    // persists. A persisted staleness flag is the design the plan rejected —
    // one every future write path could forget to set.
    const roots = ['lib', 'packages/@openmaic/generation/src', 'app'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, {
        withFileTypes: true,
      }) as Array<{ name: string; isDirectory: () => boolean; path: string }>) {
        const full = path.join(entry.path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const source = readFileSync(full, 'utf8');
          if (/alignmentStale|alignment_stale|isAlignmentStale/.test(source)) offenders.push(full);
        }
      }
    };
    for (const root of roots) walk(path.join(process.cwd(), root));
    expect(offenders).toEqual([]);
  });
});
