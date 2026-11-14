/**
 * Subject Teaching Skills V1: which canonical Teaching Skill teaches which subject.
 * Plan: `docs/frds/subject-teaching-skills-v1-plan-2026-11-14.md` §3.
 *
 * Ownership:
 * - The map is code-owned HERE, like the subject routing policy
 *   (`lib/server/teaching-model/subject-policy.ts`).
 * - Kafuo mirrors it in `app/modules/teaching_engine/domain/subject_teaching_skills.py`.
 * - Both sides pin the same shared fixture, `tests/fixtures/subject-teaching-skills.v1.json`.
 *
 * Kafuo (g5.v9 only) projects the subject's Skill into the objective position's Skill
 * Policy, as a required supporting rule on every instructional scene. The TE does not
 * derive or re-project policy (`skill-policy.ts`). This module only GUARDS what it
 * received: a governed request whose policies name a subject Teaching Skill must name
 * the one Skill its routing subject maps to, and nothing else. A request that names no
 * subject Skill, like every g5.v1–g5.v8 request, passes untouched.
 */
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { skillRefsInPolicy } from '@/lib/server/teaching-package/skill-policy';
import type { TeachingFlowEntry, TeachingSkillRef } from '@/lib/types/teaching-package';

/**
 * Routing subject code (`learningItem.subjectOffering.code`, normalised by
 * `subjectCodeOf`) → the exact subject Teaching Skill. SOCIAL_STUDIES, ENGLISH and
 * unrouted subjects have none.
 */
export const SUBJECT_TEACHING_SKILLS: Readonly<Record<string, Readonly<TeachingSkillRef>>> =
  Object.freeze({
    MATH: Object.freeze({ skillId: 'mathematics-academic-teaching', version: 'v1' }),
    PHYSICS: Object.freeze({ skillId: 'physics-conceptual-teaching', version: 'v1' }),
    CHEMISTRY: Object.freeze({ skillId: 'chemistry-scientific-teaching', version: 'v1' }),
    BIOLOGY: Object.freeze({ skillId: 'biology-structured-teaching', version: 'v1' }),
    ARABIC: Object.freeze({ skillId: 'arabic-language-teaching', version: 'v1' }),
  });

/** Every subject Teaching Skill id, whatever its subject. */
export const SUBJECT_TEACHING_SKILL_IDS: ReadonlySet<string> = new Set(
  Object.values(SUBJECT_TEACHING_SKILLS).map((ref) => ref.skillId),
);

/** The subject Skill for a routing subject code, or `null` (no subject Skill). */
export function subjectTeachingSkillFor(
  subjectCode: string | null | undefined,
): TeachingSkillRef | null {
  if (typeof subjectCode !== 'string') return null;
  const ref = SUBJECT_TEACHING_SKILLS[subjectCode.trim().toUpperCase()];
  return ref ? { skillId: ref.skillId, version: ref.version } : null;
}

/**
 * Fail closed when a received Skill Policy names a subject Teaching Skill that is not
 * the request's own subject Skill (`SKILL_POLICY_INVALID`). An example is the
 * mathematics Skill on a PHYSICS lesson, or any subject Skill on an unrouted one.
 * Whether the exact version resolves is the registry's question
 * (`resolveFlowSkillPolicies`), never this guard's.
 */
export function assertSubjectTeachingSkillPolicy(
  flow: readonly TeachingFlowEntry[],
  subjectCode: string | null,
): void {
  const expected = subjectTeachingSkillFor(subjectCode);
  flow.forEach((entry, flowIndex) => {
    if (!entry.skillPolicy) return;
    for (const ref of skillRefsInPolicy(entry.skillPolicy)) {
      if (!SUBJECT_TEACHING_SKILL_IDS.has(ref.skillId)) continue;
      if (expected && expected.skillId === ref.skillId) continue;
      throw new TeachingPackageError(
        'SKILL_POLICY_INVALID',
        `teachingModel.flow[${flowIndex}] (stage "${entry.stage}").skillPolicy names the subject Teaching Skill ${JSON.stringify(ref.skillId)}, which does not teach this lesson's subject (${subjectCode === null ? 'unrouted' : JSON.stringify(subjectCode)})`,
        {
          flowIndex,
          stage: entry.stage,
          skillId: ref.skillId,
          skillVersion: ref.version,
          subjectCode,
          expectedSkillId: expected?.skillId ?? null,
        },
      );
    }
  });
}
