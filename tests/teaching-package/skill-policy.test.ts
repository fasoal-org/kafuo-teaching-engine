/**
 * Teaching Skills policy parsing + resolution (Module 2 W5 — plan §P Step 6,
 * §B.13/§E/§G).
 *
 * `parseFlow` is the single policy parsing seam: it validates the RECEIVED
 * policy's structure and coherence (VAL-TS-003/004) and carries it through; the
 * resolution module decides — against the W1 canonical registry — whether each
 * exact `(skillId, version)` actually resolves (VAL-TS-001/002, AC-TS-010).
 * A policy-absent request parses exactly as before: the legacy path is intact.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveCanonicalSkillVersion } from '@/lib/server/agent-runtime/canonical-skills';
import { skillSourceHash } from '@/lib/server/agent-runtime/skills';
import {
  canonicalRequestDigest,
  parseKafuoGenerationRequest,
} from '@/lib/server/teaching-package/kafuo-request';
import {
  requireCompleteFlowPolicies,
  resolveFlowSkillPolicies,
  skillRefsInPolicy,
} from '@/lib/server/teaching-package/skill-policy';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { TeachingFlowEntry, TeachingSkillPolicy } from '@/lib/types/teaching-package';

const ref = (skillId: string, version = 'v1') => ({ skillId, version });

const policy = (overrides: Partial<TeachingSkillPolicy> = {}): TeachingSkillPolicy => ({
  required: [],
  preferred: [ref('skill-a')],
  allowed: [ref('skill-a'), ref('skill-b'), ref('skill-c')],
  combinationRestrictions: [],
  ...overrides,
});

/** A minimal parseable request body whose flow entries can carry policy. */
const body = (entries: Array<Record<string, unknown>>) => ({
  requestId: 'req-1',
  tenantContext: { tenantId: 'tenant-1' },
  actorRef: '42',
  learningItem: {
    type: 'lesson',
    id: '901',
    title: 'Photosynthesis',
    unit: { id: '12', title: 'Unit 3' },
    curriculum: { id: '5', name: 'Science 5' },
    curriculumVersion: { id: '8', versionLabel: '2026-A' },
    language: 'ar',
  },
  learningObjectives: [
    { objectiveRef: '7001', snapshot: { statement: 'Explain photosynthesis.' } },
  ],
  teachingModel: {
    key: 'g5',
    version: 'g5.v1',
    flow: entries,
  },
  contentResource: {
    id: 'cs-1',
    mimeType: 'application/pdf',
    url: 'https://r2.example.test/lesson.pdf?X-Amz-Signature=abc',
  },
  generation: {},
});

const entry = (stage: string, skillPolicy?: unknown) => ({
  stage,
  instructions: `Instructions for ${stage}.`,
  ...(skillPolicy === undefined ? {} : { skillPolicy }),
});

const expectPolicyError = (act: () => unknown): TeachingPackageError => {
  let thrown: unknown;
  try {
    act();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof TeachingPackageError)) {
    throw new Error(`expected a TeachingPackageError, got ${String(thrown)}`);
  }
  return thrown;
};

describe('parseFlow policy validation (the single seam)', () => {
  it('parses a coherent policy through intact', () => {
    const parsed = parseKafuoGenerationRequest(
      body([
        entry('lesson_introduction', {
          required: [{ skill: ref('skill-a'), scope: 'flow_position', role: 'supporting' }],
          preferred: [ref('skill-b')],
          allowed: [ref('skill-a'), ref('skill-b')],
          combinationRestrictions: [{ skillA: ref('skill-a'), skillB: ref('skill-b') }],
        }),
      ]),
    );
    const flowEntry = parsed.request.teachingModel.flow[0]!;
    expect(flowEntry.skillPolicy).toEqual({
      required: [{ skill: ref('skill-a'), scope: 'flow_position', role: 'supporting' }],
      preferred: [ref('skill-b')],
      allowed: [ref('skill-a'), ref('skill-b')],
      combinationRestrictions: [{ skillA: ref('skill-a'), skillB: ref('skill-b') }],
    });
  });

  it('leaves the policy-absent legacy path exactly as before', () => {
    const parsed = parseKafuoGenerationRequest(
      body([entry('lesson_introduction'), entry('outcome_teaching_cards')]),
    );
    expect(
      parsed.request.teachingModel.flow.map((e) => ({
        stage: e.stage,
        instructions: e.instructions,
      })),
    ).toEqual([
      { stage: 'lesson_introduction', instructions: 'Instructions for lesson_introduction.' },
      { stage: 'outcome_teaching_cards', instructions: 'Instructions for outcome_teaching_cards.' },
    ]);
    expect(parsed.request.teachingModel.flow.every((e) => e.skillPolicy === undefined)).toBe(true);
  });

  it('refuses malformed or incoherent policy with SKILL_POLICY_INVALID', () => {
    const cases: Array<[label: string, raw: unknown, match: RegExp]> = [
      ['non-object policy', 'nope', /must be an object/],
      [
        'bad scope',
        policy({ required: [{ skill: ref('skill-a'), scope: 'somewhere', role: 'primary' }] }),
        /scope/,
      ],
      [
        'bad role',
        policy({ required: [{ skill: ref('skill-a'), scope: 'flow_position', role: 'either' }] }),
        /role/,
      ],
      ['malformed skill id', policy({ allowed: [ref('../escape'), ref('skill-b')] }), /skillId/],
      ['malformed version', policy({ preferred: [ref('skill-b', '')] }), /version/],
      [
        'required outside allowed',
        policy({ required: [{ skill: ref('missing'), scope: 'flow_position', role: 'primary' }] }),
        /allowed boundary/,
      ],
      [
        'required version mismatch',
        policy({
          required: [{ skill: ref('skill-a', 'v2'), scope: 'flow_position', role: 'primary' }],
        }),
        /allowed boundary/,
      ],
      ['preferred outside allowed', policy({ preferred: [ref('missing')] }), /allowed boundary/],
      [
        'duplicate allowed ids',
        policy({ allowed: [ref('skill-a'), ref('skill-a', 'v2'), ref('skill-b')] }),
        /allowed names skill id/,
      ],
      [
        'duplicate required rules',
        policy({
          required: [
            { skill: ref('skill-a'), scope: 'flow_position', role: 'primary' },
            { skill: ref('skill-a'), scope: 'flow_position', role: 'supporting' },
          ],
        }),
        /more than one rule/,
      ],
      [
        'restriction outside allowed',
        policy({ combinationRestrictions: [{ skillA: ref('skill-a'), skillB: ref('missing') }] }),
        /not in the allowed boundary/,
      ],
      [
        'self-restriction',
        policy({ combinationRestrictions: [{ skillA: ref('skill-a'), skillB: ref('skill-a') }] }),
        /two distinct/,
      ],
      [
        'duplicate restriction',
        policy({
          combinationRestrictions: [
            { skillA: ref('skill-a'), skillB: ref('skill-b') },
            { skillA: ref('skill-b'), skillB: ref('skill-a') },
          ],
        }),
        /twice/,
      ],
      [
        'two every-scene primaries (FR-TS-074)',
        policy({
          required: [
            { skill: ref('skill-a'), scope: 'every_instructional_scene', role: 'primary' },
            { skill: ref('skill-b'), scope: 'every_instructional_scene', role: 'primary' },
          ],
        }),
        /contradictory/,
      ],
    ];
    for (const [label, raw, match] of cases) {
      const error = expectPolicyError(() => parseKafuoGenerationRequest(body([entry('s', raw)])));
      expect(error.code, label).toBe('SKILL_POLICY_INVALID');
      expect(error.status, label).toBe(422);
      expect(error.message, label).toMatch(match);
    }
  });

  it('keeps the parsed policy byte-stable through the shared digest', () => {
    // The W4 vector proves KF and TE agree on this exact policy payload; a
    // validation pass that mutated what it carried would break that agreement.
    const vectors = JSON.parse(
      readFileSync(join(__dirname, '..', 'fixtures', 'kafuo-digest-vectors.json'), 'utf8'),
    ) as { vectors: Array<{ request: Record<string, unknown>; digest: string }> };
    const governed = vectors.vectors[2]!;
    const { request } = parseKafuoGenerationRequest(governed.request);
    expect(canonicalRequestDigest(request)).toBe(governed.digest);
  });
});

describe('resolveFlowSkillPolicies (TE is the resolution authority)', () => {
  const governedFlow: TeachingFlowEntry[] = [
    {
      stage: 'lesson_introduction',
      instructions: 'i',
      skillPolicy: policy({
        preferred: [ref('feynman-learning')],
        allowed: [ref('feynman-learning'), ref('learning-to-learn')],
        combinationRestrictions: [],
      }),
    },
    {
      stage: 'outcome_teaching_cards',
      instructions: 'c',
      skillPolicy: policy({
        required: [{ skill: ref('spiral-curriculum'), scope: 'flow_position', role: 'primary' }],
        preferred: [ref('spiral-curriculum')],
        allowed: [ref('spiral-curriculum'), ref('learning-to-learn')],
        combinationRestrictions: [],
      }),
    },
  ];

  it('resolves every exact reference against the real W1 registry', () => {
    const resolved = resolveFlowSkillPolicies(governedFlow);
    expect([...resolved.keys()].sort()).toEqual(
      ['feynman-learning@v1', 'learning-to-learn@v1', 'spiral-curriculum@v1'].sort(),
    );
    const feynman = resolved.get('feynman-learning@v1')!;
    expect(feynman.content).toBe(
      readFileSync(join(process.cwd(), 'skills/agent-runtime/feynman-learning/SKILL.md'), 'utf8'),
    );
    expect(feynman.digest).toBe(skillSourceHash(feynman.content));
  });

  it('refuses an unknown skill identity with SKILL_NOT_FOUND', () => {
    const error = expectPolicyError(() =>
      resolveFlowSkillPolicies([
        {
          stage: 's',
          instructions: 'i',
          skillPolicy: policy({
            preferred: [ref('no-such-skill')],
            allowed: [ref('no-such-skill'), ref('feynman-learning')],
            combinationRestrictions: [],
          }),
        },
      ]),
    );
    expect(error.code).toBe('SKILL_NOT_FOUND');
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({ skillId: 'no-such-skill', stage: 's' });
  });

  it('refuses an unresolvable exact version with SKILL_VERSION_UNRESOLVED, never substituting', () => {
    const error = expectPolicyError(() =>
      resolveFlowSkillPolicies([
        {
          stage: 's',
          instructions: 'i',
          skillPolicy: policy({
            preferred: [ref('feynman-learning', 'v99')],
            allowed: [ref('feynman-learning', 'v99'), ref('feynman-learning')],
            combinationRestrictions: [],
          }),
        },
      ]),
    );
    expect(error.code).toBe('SKILL_VERSION_UNRESOLVED');
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({
      skillId: 'feynman-learning',
      version: 'v99',
      reason: 'version_not_declared',
    });
  });

  it('never leaks the historical SKILL_LINEAGE_UNRESOLVABLE refusal', () => {
    // A drifted retained snapshot (digest mismatch) is a registry integrity
    // refusal for HISTORICAL interpretation (409); for generation-time policy
    // resolution it maps to SKILL_VERSION_UNRESOLVED (422).
    const root = mkdtempSync(join(tmpdir(), 'openmaic-skill-policy-'));
    try {
      const text = '---\nname: drifted\ndescription: d\n---\n\nbody\n';
      mkdirSync(join(root, 'drifted', 'versions', 'v1'), { recursive: true });
      writeFileSync(join(root, 'drifted', 'SKILL.md'), text);
      writeFileSync(join(root, 'drifted', 'versions', 'v1', 'SKILL.md'), text);
      const digest = skillSourceHash(text);
      writeFileSync(
        join(root, 'drifted', 'skill-versions.json'),
        `${JSON.stringify({ recordVersion: 1, currentVersion: 'v1', versions: { v1: { digest } } })}\n`,
      );
      writeFileSync(join(root, 'drifted', 'versions', 'v1', 'SKILL.md'), `${text}drifted\n`);

      expect(() => resolveCanonicalSkillVersion('drifted', 'v1', root)).toThrowError(
        expect.objectContaining({ code: 'SKILL_LINEAGE_UNRESOLVABLE' }),
      );
      const error = expectPolicyError(() =>
        resolveFlowSkillPolicies(
          [
            {
              stage: 's',
              instructions: 'i',
              skillPolicy: policy({
                preferred: [ref('drifted')],
                allowed: [ref('drifted'), ref('feynman-learning')],
                combinationRestrictions: [],
              }),
            },
          ],
          root,
        ),
      );
      expect(error.code).toBe('SKILL_VERSION_UNRESOLVED');
      expect(error.details).toMatchObject({ reason: 'digest_mismatch' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('collects references from every policy set including restrictions', () => {
    expect(
      skillRefsInPolicy({
        required: [{ skill: ref('a'), scope: 'flow_position', role: 'primary' }],
        preferred: [ref('b')],
        allowed: [ref('a'), ref('b'), ref('c')],
        combinationRestrictions: [{ skillA: ref('a'), skillB: ref('c') }],
      }).map((r) => r.skillId),
    ).toEqual(['a', 'b', 'a', 'b', 'c', 'a', 'c']);
  });
});

describe('requireCompleteFlowPolicies (the BR-TS-048 completeness refusal)', () => {
  it('passes a fully policy-carrying flow', () => {
    expect(() =>
      requireCompleteFlowPolicies([
        { stage: 'a', instructions: 'i', skillPolicy: policy() },
        { stage: 'b', instructions: 'i', skillPolicy: policy() },
      ]),
    ).not.toThrow();
  });

  it('refuses a flow item without policy with SKILL_POLICY_REQUIRED', () => {
    const error = expectPolicyError(() =>
      requireCompleteFlowPolicies([
        { stage: 'a', instructions: 'i', skillPolicy: policy() },
        { stage: 'b', instructions: 'i' },
      ]),
    );
    expect(error.code).toBe('SKILL_POLICY_REQUIRED');
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({ flowIndex: 1, stage: 'b' });
    expect(error.message).toMatch(/fails closed/);
  });
});
