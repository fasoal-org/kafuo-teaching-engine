/**
 * Subject Teaching Skills V1 (plan `docs/frds/subject-teaching-skills-v1-plan-2026-11-14.md`).
 *
 * - Each of the five Skills is registered and resolves at its exact version.
 * - The subject → Skill map is the shared one.
 * - The request seam refuses a policy that names another subject's Skill.
 * - g5.v9's policy makes the subject Skill the required Primary Skill of every
 *   instructional objective scene, enforced by the existing Stage-1 validator (owner,
 *   14 Nov 2026, revising the same day's "supporting").
 * - g5.v9 keeps g5.v8's teacher-parity gates.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveCanonicalSkillVersion,
  verifyCanonicalSkillVersions,
} from '@/lib/server/agent-runtime/canonical-skills';
import { skillSourceHash } from '@/lib/server/agent-runtime/skills';
import { isTeacherParityModel } from '@/lib/server/teaching-package/book-coverage';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  parseKafuoGenerationRequest,
  TEACHING_SKILLS_CONTRACT_V1,
} from '@/lib/server/teaching-package/kafuo-request';
import {
  findOutlineSkillSelectionIssues,
  resolveFlowSkillPolicies,
  type OutlineSkillSelectionShape,
} from '@/lib/server/teaching-package/skill-policy';
import {
  assertSubjectTeachingSkillPolicy,
  SUBJECT_TEACHING_SKILLS,
  subjectTeachingSkillFor,
} from '@/lib/server/teaching-package/subject-teaching-skills';
import type { TeachingFlowEntry, TeachingSkillRef } from '@/lib/types/teaching-package';

import {
  g5V8Flow,
  g5V9Flow,
  OBJECTIVE_FLOW_INDEX,
  QUIZ_FLOW_INDEX,
  SHARED_FIXTURE,
  SUBJECTS,
  UBD,
  type Subject,
} from './subject-teaching-skills-fixtures';

const CATALOG = join(process.cwd(), 'skills/agent-runtime');

/** A line of each Skill's own method that no other Skill carries. */
const METHOD_HEADING: Record<Subject, string> = {
  MATH: '## Mathematics method',
  PHYSICS: '## Physics method',
  CHEMISTRY: '## Chemistry method',
  BIOLOGY: '## Biology method',
  ARABIC: '## Arabic language method',
};

const skillOf = (subject: Subject): TeachingSkillRef => SUBJECT_TEACHING_SKILLS[subject]!;

describe('the five subject Teaching Skills are canonical and versioned', () => {
  it.each(SUBJECTS)('%s: resolves at v1, byte-identical to the shipped file', (subject) => {
    const { skillId } = skillOf(subject);
    const resolved = resolveCanonicalSkillVersion(skillId, 'v1', CATALOG);
    const active = readFileSync(join(CATALOG, skillId, 'SKILL.md'), 'utf8');

    expect(resolved).toMatchObject({ skillId, version: 'v1' });
    expect(resolved.content).toBe(active);
    expect(resolved.digest).toBe(skillSourceHash(active));
    expect(resolved.content).toContain(`name: ${skillId}\n`);
    expect(resolved.content).toContain(METHOD_HEADING[subject]);
    expect(resolved.content).toContain(
      'This is the PRIMARY Skill of every teaching slide at this stage.',
    );
    expect(resolved.content).not.toContain('SUPPORTING Skill');
    // The shared principles (spec §2) ride every Skill's own immutable snapshot.
    expect(resolved.content).toContain('Never invent a misconception to fill a slot.');
    expect(resolved.content).toContain(
      'Never reveal answers to the quiz or question-bank items the learner answers alone.',
    );
  });

  it.each(SUBJECTS)('%s: no other version resolves (exact version only)', (subject) => {
    const { skillId } = skillOf(subject);
    expect(() => resolveCanonicalSkillVersion(skillId, 'v2', CATALOG)).toThrow(
      TeachingPackageError,
    );
  });

  it('the registry verifies all five as intact', () => {
    const ids = SUBJECTS.map((subject) => skillOf(subject).skillId);
    const rows = verifyCanonicalSkillVersions(CATALOG).filter((row) => ids.includes(row.skillId));
    expect(rows.map((row) => row.skillId).sort()).toEqual([...ids].sort());
    for (const row of rows) expect(row.status, row.skillId).toBe('ok');
  });
});

describe('subject → Skill map', () => {
  it('is exactly the shared fixture both repositories pin', () => {
    expect(SHARED_FIXTURE.contract).toBe('kafuo.subject-teaching-skills.v1');
    expect(SUBJECT_TEACHING_SKILLS).toEqual(SHARED_FIXTURE.skills);
    expect(Object.keys(SUBJECT_TEACHING_SKILLS)).toEqual([...SUBJECTS]);
  });

  it('selects by the routing subject code, as `subjectCodeOf` normalises it', () => {
    expect(subjectTeachingSkillFor('MATH')).toEqual({
      skillId: 'mathematics-academic-teaching',
      version: 'v1',
    });
    expect(subjectTeachingSkillFor(' arabic ')).toEqual(skillOf('ARABIC'));
    for (const none of ['SOCIAL_STUDIES', 'ENGLISH', '', null, undefined]) {
      expect(subjectTeachingSkillFor(none)).toBeNull();
    }
  });
});

describe('the subject guard', () => {
  it.each(SUBJECTS)('%s: accepts its own g5.v9 policy', (subject) => {
    expect(() => assertSubjectTeachingSkillPolicy(g5V9Flow(subject), subject)).not.toThrow();
  });

  it.each(SUBJECTS)('%s: refuses a g5.v9 policy built for another subject', (subject) => {
    const other = SUBJECTS.find((candidate) => candidate !== subject)!;
    let caught: unknown;
    try {
      assertSubjectTeachingSkillPolicy(g5V9Flow(other), subject);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TeachingPackageError);
    expect((caught as TeachingPackageError).code).toBe('SKILL_POLICY_INVALID');
    expect((caught as TeachingPackageError).details).toMatchObject({
      flowIndex: OBJECTIVE_FLOW_INDEX,
      skillId: skillOf(other).skillId,
      expectedSkillId: skillOf(subject).skillId,
    });
  });

  it('refuses any subject Skill on a lesson whose subject has none', () => {
    for (const subjectCode of ['SOCIAL_STUDIES', 'ENGLISH', null]) {
      expect(() => assertSubjectTeachingSkillPolicy(g5V9Flow('MATH'), subjectCode)).toThrow(
        /does not teach this lesson's subject/,
      );
    }
  });

  it('leaves every g5.v8 policy, and every policy-free flow, untouched', () => {
    for (const subjectCode of [...SUBJECTS, 'SOCIAL_STUDIES', 'ENGLISH', null]) {
      expect(() => assertSubjectTeachingSkillPolicy(g5V8Flow(), subjectCode)).not.toThrow();
      const legacy = g5V8Flow().map(({ stage, instructions }) => ({ stage, instructions }));
      expect(() => assertSubjectTeachingSkillPolicy(legacy, subjectCode)).not.toThrow();
    }
  });
});

describe('the request seam runs the guard', () => {
  const body = (subjectCode: string | null, flow: TeachingFlowEntry[], version = 'g5.v9') => ({
    requestId: 'req-subject-skill',
    tenantContext: { tenantId: 'tenant-1' },
    actorRef: '42',
    learningItem: {
      type: 'lesson',
      id: '901',
      title: 'Lesson',
      unit: { id: '12', title: 'Unit 3' },
      subjectOffering: { id: '10', name: 'Subject', code: subjectCode },
      curriculum: { id: '5', name: 'Curriculum' },
      curriculumVersion: { id: '8', versionLabel: '2026-A' },
      language: 'ar',
    },
    learningObjectives: [{ objectiveRef: '7001', snapshot: { statement: 'An objective.' } }],
    teachingModel: { key: 'g5', version, flow },
    contentResource: {
      id: 'cs-1',
      mimeType: 'application/pdf',
      url: 'https://r2.example.test/lesson.pdf?X-Amz-Signature=abc',
    },
    generation: {},
    teachingSkills: TEACHING_SKILLS_CONTRACT_V1,
  });

  it.each(SUBJECTS)('%s: a g5.v9 request for its own subject parses', (subject) => {
    const { request } = parseKafuoGenerationRequest(body(subject, g5V9Flow(subject)));
    const objective = request.teachingModel.flow[OBJECTIVE_FLOW_INDEX]!.skillPolicy!;
    expect(objective.allowed).toContainEqual(skillOf(subject));
  });

  it('a PHYSICS lesson sent the mathematics Skill is refused before anything runs', () => {
    let caught: unknown;
    try {
      parseKafuoGenerationRequest(body('PHYSICS', g5V9Flow('MATH')));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TeachingPackageError);
    expect((caught as TeachingPackageError).code).toBe('SKILL_POLICY_INVALID');
  });

  it('a g5.v8 request for any subject parses exactly as before', () => {
    for (const subject of [...SUBJECTS, null]) {
      expect(() => parseKafuoGenerationRequest(body(subject, g5V8Flow(), 'g5.v8'))).not.toThrow();
    }
  });
});

describe('g5.v9 selection respects the Primary/Supporting rules', () => {
  const objectiveOutline = (
    id: string,
    teachingSkills: OutlineSkillSelectionShape['teachingSkills'],
  ): OutlineSkillSelectionShape => ({
    id,
    teachingStage: { key: 'outcome_visual_explanations', flowIndex: OBJECTIVE_FLOW_INDEX },
    teachingSkills,
  });

  it.each(SUBJECTS)('%s: every policy reference resolves in the registry', (subject) => {
    const resolved = resolveFlowSkillPolicies(g5V9Flow(subject), CATALOG);
    expect(resolved.get(`${skillOf(subject).skillId}@v1`)?.content).toContain(
      METHOD_HEADING[subject],
    );
    // Only the lesson's own subject Skill is resolved for its prompts.
    const subjectIds = new Set(SUBJECTS.map((s) => skillOf(s).skillId));
    expect([...resolved.values()].filter((d) => subjectIds.has(d.skillId))).toHaveLength(1);
  });

  it.each(SUBJECTS)('%s: the subject Skill as the Primary passes', (subject) => {
    const outlines = [
      // Lesson 329's shape: the subject Skill as the Primary of every teaching slide.
      objectiveOutline('s1', { classification: 'instructional', primary: skillOf(subject) }),
      // A pedagogical method may ride as supporting.
      objectiveOutline('s2', {
        classification: 'instructional',
        primary: skillOf(subject),
        supporting: [UBD],
      }),
      // A transition slide, explicitly non-instructional, is exempt.
      objectiveOutline('s3', { classification: 'non-instructional' }),
    ];
    expect(findOutlineSkillSelectionIssues(outlines, g5V9Flow(subject), CATALOG)).toEqual([]);
  });

  it.each(SUBJECTS)('%s: an instructional slide without it is refused', (subject) => {
    const outlines = [objectiveOutline('s1', { classification: 'instructional', primary: UBD })];
    const issues = findOutlineSkillSelectionIssues(outlines, g5V9Flow(subject), CATALOG);
    expect(issues.map((issue) => issue.code)).toEqual(['SKILL_REQUIREMENT_UNSATISFIED']);
    expect(issues[0]!.details).toMatchObject({
      skillId: skillOf(subject).skillId,
      role: 'primary',
      requiredScope: 'every_instructional_scene',
      offendingSceneIds: ['s1'],
    });
  });

  it.each(SUBJECTS)('%s: it as supporting under another Primary is refused', (subject) => {
    const outlines = [
      objectiveOutline('s1', {
        classification: 'instructional',
        primary: UBD,
        supporting: [skillOf(subject)],
      }),
    ];
    const issues = findOutlineSkillSelectionIssues(outlines, g5V9Flow(subject), CATALOG);
    expect(issues.map((issue) => issue.code)).toEqual(['SKILL_REQUIREMENT_UNSATISFIED']);
  });

  it("another subject's Skill is outside the permitted set", () => {
    const outlines = [
      objectiveOutline('s1', {
        classification: 'instructional',
        primary: skillOf('MATH'),
        supporting: [skillOf('PHYSICS')],
      }),
    ];
    const issues = findOutlineSkillSelectionIssues(outlines, g5V9Flow('MATH'), CATALOG);
    expect(issues.map((issue) => issue.code)).toEqual(['SKILL_ASSIGNMENT_INVALID']);
    expect(issues[0]!.details).toMatchObject({ skillId: 'physics-conceptual-teaching' });
  });

  it('the opener, the learning map and the quiz position carry no subject Skill', () => {
    const flow = g5V9Flow('MATH');
    flow.forEach((entry, index) => {
      if (index === OBJECTIVE_FLOW_INDEX) return;
      expect(entry.skillPolicy, entry.stage).toEqual(g5V8Flow()[index]!.skillPolicy);
    });
    expect(flow[QUIZ_FLOW_INDEX]!.skillPolicy!.required).toEqual([]);
  });
});

describe('g5.v9 keeps the g5.v8 teacher-parity gates', () => {
  it('is the one switch for both versions, and nothing else', () => {
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v9' })).toBe(true);
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v8' })).toBe(true);
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v7' })).toBe(false);
    expect(isTeacherParityModel({ key: 'other', version: 'g5.v9' })).toBe(false);
    expect(isTeacherParityModel({ key: 'g5', version: null })).toBe(false);
  });
});
