import { describe, expect, it } from 'vitest';

import {
  insertionSkillValidationSet,
  preCheckExistingSceneSkills,
  validateInsertionSkills,
} from '@/lib/server/teaching-package/insertion-skill-validation';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

/**
 * Reviewer-generated slide plan §10.8 (V2-1): whole-stage Skill validation
 * runs on the live SCENES (their current `teachingSkills`) plus the new
 * Scene's carrier — never on outline history — and the failure scope decides
 * the remedy.
 */

const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const LECTURE = { skillId: 'lecture-style', version: 'v1' };
const UNKNOWN = { skillId: 'not-a-skill', version: 'v1' };

const policy = {
  required: [],
  preferred: [],
  allowed: [FEYNMAN, LECTURE],
  combinationRestrictions: [],
};
const flow: TeachingFlowEntry[] = [
  { stage: 'intro', instructions: 'i', skillPolicy: policy },
  { stage: 'explain', instructions: 'e', skillPolicy: policy },
] as TeachingFlowEntry[];

function scene(id: string, flowIndex: number, skills: AppScene['teachingSkills']): AppScene {
  return {
    ...makeSlideScene(id, 'stage-skv', flowIndex + 1),
    teachingStage: { key: flowIndex === 0 ? 'intro' : 'explain', flowIndex },
    ...(skills ? { teachingSkills: skills } : {}),
  } as AppScene;
}

const live = () => [
  scene('s1', 0, { classification: 'non-instructional' }),
  // An earlier insertion: no outline entry, its own Skills on the Scene.
  {
    ...scene('ins-old', 1, { primary: LECTURE, classification: 'instructional' }),
    outlineId: 'ins_old',
  },
];

const carrier = (skills: AppScene['teachingSkills']) => ({
  id: 'scene-new',
  teachingStage: { key: 'explain', flowIndex: 1 },
  ...(skills ? { teachingSkills: skills } : {}),
});

describe('insertion Skill validation inputs', () => {
  it('S is built from Scenes, current teachingSkills preserved, plus the carrier', () => {
    const set = insertionSkillValidationSet(
      live(),
      carrier({ primary: FEYNMAN, classification: 'instructional' }),
    );
    expect(set.map((entry) => entry.id)).toEqual(['s1', 'ins-old', 'scene-new']);
    expect(set[1]!.teachingSkills).toEqual({ primary: LECTURE, classification: 'instructional' });
  });

  it('a valid Stage with an earlier inserted Scene (no outline entry) passes', () => {
    const set = insertionSkillValidationSet(
      live(),
      carrier({ primary: FEYNMAN, classification: 'instructional' }),
    );
    expect(validateInsertionSkills(set, flow, 'scene-new')).toBeNull();
  });

  it('a failure naming the new Scene is the planner’s to fix (re-ask)', () => {
    const set = insertionSkillValidationSet(
      live(),
      carrier({ primary: UNKNOWN, classification: 'instructional' }),
    );
    expect(validateInsertionSkills(set, flow, 'scene-new')).toMatchObject({ scope: 'new' });
    const unclassified = insertionSkillValidationSet(live(), carrier({ primary: FEYNMAN }));
    expect(validateInsertionSkills(unclassified, flow, 'scene-new')).toMatchObject({
      scope: 'new',
      code: 'SCENE_CLASSIFICATION_INVALID',
    });
  });

  it('a failure naming only existing Scenes is INSERTION_SKILLS_INVALID — the new id is not attached', () => {
    const broken = [scene('s1', 0, undefined), ...live().slice(1)];
    const set = insertionSkillValidationSet(
      broken,
      carrier({ primary: FEYNMAN, classification: 'instructional' }),
    );
    const failure = validateInsertionSkills(set, flow, 'scene-new');
    expect(failure).toMatchObject({ scope: 'existing' });
    expect(failure!.details.offendingSceneIds).not.toContain('scene-new');
  });

  it('a flow-level failure has no Scene scope', () => {
    const noPolicy = [{ stage: 'intro', instructions: 'i' }, flow[1]!] as TeachingFlowEntry[];
    const set = insertionSkillValidationSet(
      live(),
      carrier({ primary: FEYNMAN, classification: 'instructional' }),
    );
    expect(validateInsertionSkills(set, noPolicy, 'scene-new')).toMatchObject({ scope: 'flow' });
  });

  it('the pre-check runs only the per-Scene checks, over live Scenes alone', () => {
    expect(preCheckExistingSceneSkills(live(), flow)).toBeNull();
    const unclassified = [scene('s1', 0, undefined), ...live().slice(1)];
    expect(preCheckExistingSceneSkills(unclassified, flow)).toMatchObject({
      code: 'SCENE_CLASSIFICATION_INVALID',
      details: { offendingSceneIds: ['s1'] },
    });
  });
});
