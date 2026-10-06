/**
 * Cross-system contract verification — Module 2 W7, the ROLLOUT GATE
 * (teaching-skills plan §P Step 7a · §S row W7 · §B.13/§M/§N cross-system rows ·
 * FRD FR-TS-006/007/011 · VAL-TS-002/003/022 · AC-TS-010/028).
 *
 * This is the Teaching Engine half of a verification suite that exists identically
 * in Kafuo (`zakrly-backend` `tests/unit/teaching_engine/
 * test_teaching_skills_cross_system.py`). Both halves walk the same §N matrix over
 * MIRRORED wire shapes so neither side can drift silently:
 *
 * - the shared artifact is `tests/fixtures/kafuo-digest-vectors.json` (tracked here,
 *   provisioned from this copy on the Kafuo side per the W7 reviewer decision);
 * - vector 3 is the governed shape (marker + policy on every entry, real registry
 *   skill ids at v1); vectors 1–2 are the policy-free legacy shapes;
 * - refusal shapes have no digest by definition, so both suites derive them from
 *   vector 3 through THE SAME minimal mutations — `strip skillPolicy`, `strip the
 *   marker`, `replaceRefs(skill → v99)`, `replaceRefs(skill → unknown id)` —
 *   defined identically in both files.
 *
 * The boundary this matrix pins (plan §G): Kafuo validates policy SHAPE and
 * coherence; TE alone decides whether a reference RESOLVES. A structurally valid
 * reference to a non-existent canonical Skill or version passes the Kafuo half and
 * is refused by this half.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  canonicalRequestDigest,
  buildKafuoStartRequest,
  parseKafuoGenerationRequest,
  TEACHING_SKILLS_CONTRACT_V1,
} from '@/lib/server/teaching-package/kafuo-request';
import {
  computeSkillPolicyDigest,
  requireCompleteFlowPolicies,
  resolveFlowSkillPolicies,
} from '@/lib/server/teaching-package/skill-policy';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { TeachingSkillRef } from '@/lib/types/teaching-package';

type Vector = { request: Record<string, unknown>; digest: string };

const vectors = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'kafuo-digest-vectors.json'), 'utf8'),
) as { vectors: Vector[] };

const governedVector = (): Vector['request'] =>
  JSON.parse(JSON.stringify(vectors.vectors[2]!.request)) as Vector['request'];

/** Replace every `{skillId, version}` ref equal to `from` with `to`, recursively. */
function replaceRefs(
  value: unknown,
  from: TeachingSkillRef,
  to: TeachingSkillRef,
): void {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (
          key === 'skillId' &&
          typeof child === 'string' &&
          child === from.skillId &&
          'version' in node &&
          (node as Record<string, unknown>).version === from.version
        ) {
          (node as Record<string, unknown>).skillId = to.skillId;
          (node as Record<string, unknown>).version = to.version;
          continue;
        }
        walk(child);
      }
    }
  };
  walk(value);
}

const governedFlowOf = (wire: Record<string, unknown>) =>
  parseKafuoGenerationRequest(wire).request.teachingModel.flow;

const expectTeachingPackageError = (act: () => unknown, code: string): TeachingPackageError => {
  let thrown: unknown;
  try {
    act();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected TeachingPackageError ${code}`).toBeInstanceOf(TeachingPackageError);
  const error = thrown as TeachingPackageError;
  expect(error.code).toBe(code);
  return error;
};

describe('W7 matrix — fixture mirror discipline (the shared artifact)', () => {
  it('carries the policy-free legacy vectors unchanged (digest pins the pre-Module-2 shape)', () => {
    for (const vector of [vectors.vectors[0]!, vectors.vectors[1]!]) {
      expect(vector.request.teachingSkills).toBeUndefined();
      const flow = (vector.request.teachingModel as Record<string, unknown>)
        .flow as Record<string, unknown>[];
      expect(flow.every((entry) => !('skillPolicy' in entry))).toBe(true);
    }
  });

  it('agrees with the shared digest on every mirrored vector — the TE half of VAL-TS-022', () => {
    // The Kafuo half asserts the identical loop over the identical (provisioned)
    // fixture bytes with canonical_request_digest; passing both means the two
    // implementations agree on every vector, including the governed policy vector.
    for (const vector of vectors.vectors) {
      const { request } = parseKafuoGenerationRequest(vector.request);
      expect(canonicalRequestDigest(request)).toBe(vector.digest);
    }
  });

  it('mirrors the exact governed shape Kafuo emits: marker + policy on every flow entry', () => {
    const wire = governedVector();
    expect(wire.teachingSkills).toBe(TEACHING_SKILLS_CONTRACT_V1);
    const flow = (wire.teachingModel as Record<string, unknown>).flow as Record<string, unknown>[];
    expect(flow.length).toBeGreaterThan(0);
    expect(flow.every((entry) => 'skillPolicy' in entry)).toBe(true);
  });
});

describe('W7 matrix — valid policy: TE parses, resolves, records governance', () => {
  it('derives governed mode from the marker and parses every entry policy intact', () => {
    const { request } = parseKafuoGenerationRequest(governedVector());
    expect(request.teachingSkillsContract).toBe(TEACHING_SKILLS_CONTRACT_V1);
    expect(request.teachingModel.flow.every((entry) => entry.skillPolicy !== undefined)).toBe(
      true,
    );
  });

  it('resolves every exact policy reference against the real W1 canonical registry', () => {
    // Vector 3 references real catalog ids at v1 (understanding-by-design,
    // spiral-curriculum, feynman-learning, learning-to-learn, social-emotional-learning),
    // so this is a live resolution, not a shape check (VAL-TS-002, AC-TS-010 happy path).
    const flow = governedFlowOf(governedVector());
    const resolved = resolveFlowSkillPolicies(flow);
    expect(resolved.size).toBeGreaterThan(0);
    for (const entry of flow) {
      for (const ref of [
        ...entry.skillPolicy!.required.map((rule) => rule.skill),
        ...entry.skillPolicy!.preferred,
        ...entry.skillPolicy!.allowed,
      ]) {
        expect(resolved.has(`${ref.skillId}@${ref.version}`), `${ref.skillId}@${ref.version}`).toBe(
          true,
        );
      }
    }
  });

  it('records governance in the start request: contract marker + non-null policy digest', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(governedVector());
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(start.teachingSkillsContract).toBe(TEACHING_SKILLS_CONTRACT_V1);
    expect(start.skillPolicyDigest).toBe(computeSkillPolicyDigest(request.teachingModel.flow));
    expect(start.skillPolicyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(kafuo.teachingSkillsContract).toBe(TEACHING_SKILLS_CONTRACT_V1);
  });
});

describe('W7 matrix — marker present + policy MISSING: fail closed, never reclassified legacy', () => {
  const stripped = (): Record<string, unknown> => {
    const wire = governedVector();
    const model = wire.teachingModel as Record<string, unknown>;
    (model.flow as Record<string, unknown>[]).forEach((entry) => delete entry.skillPolicy);
    return wire;
  };

  it('keeps the request governed — the marker, not policy presence, declares mode', () => {
    const { request } = parseKafuoGenerationRequest(stripped());
    expect(request.teachingSkillsContract).toBe(TEACHING_SKILLS_CONTRACT_V1);
    expect(request.teachingModel.flow.every((entry) => entry.skillPolicy === undefined)).toBe(
      true,
    );
  });

  it('refuses the completeness check with SKILL_POLICY_REQUIRED (BR-TS-048 vocabulary)', () => {
    const flow = governedFlowOf(stripped());
    const error = expectTeachingPackageError(() => requireCompleteFlowPolicies(flow), 'SKILL_POLICY_REQUIRED');
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({ flowIndex: 0 });
  });

  it('carries NO policy digest for the stripped flow while remaining governed', () => {
    // skill_policy_digest is lineage evidence, never the mode declaration (§M):
    // null here, and the mode would still be governed — W8's gate consumes both.
    const flow = governedFlowOf(stripped());
    expect(computeSkillPolicyDigest(flow)).toBeNull();
  });
});

describe('W7 matrix — marker present + invalid policy: SKILL_POLICY_INVALID, no partial acceptance', () => {
  it('refuses an incoherent policy (preferred outside the allowed boundary) at parse', () => {
    const wire = governedVector();
    const flow = (wire.teachingModel as Record<string, unknown>).flow as Record<string, unknown>[];
    const firstPolicy = flow[0]!.skillPolicy as Record<string, unknown>;
    (firstPolicy.allowed as Record<string, unknown>[]).shift(); // drop the preferred member
    const error = expectTeachingPackageError(
      () => parseKafuoGenerationRequest(wire),
      'SKILL_POLICY_INVALID',
    );
    expect(error.status).toBe(422);
    expect(error.message).toMatch(/allowed boundary/);
  });

  it('refuses a malformed reference shape at parse', () => {
    const wire = governedVector();
    replaceRefs(
      wire,
      { skillId: 'feynman-learning', version: 'v1' },
      { skillId: '../escape', version: 'v1' },
    );
    expectTeachingPackageError(() => parseKafuoGenerationRequest(wire), 'SKILL_POLICY_INVALID');
  });

  it('accepts nothing partially: a throwing parse yields no request at all', () => {
    const wire = governedVector();
    const flow = (wire.teachingModel as Record<string, unknown>).flow as Record<string, unknown>[];
    delete (flow[2]!.skillPolicy as Record<string, unknown>).allowed;
    let result: unknown = 'unset';
    try {
      result = parseKafuoGenerationRequest(wire);
    } catch {
      // expected
    }
    expect(result).toBe('unset');
  });
});

describe('W7 matrix — marker absent: the genuine legacy compatibility path', () => {
  it('parses policy-free vectors as legacy with no governance recorded anywhere', () => {
    for (const vector of [vectors.vectors[0]!, vectors.vectors[1]!]) {
      const { request, aggregate } = parseKafuoGenerationRequest(vector.request);
      expect(request.teachingSkillsContract).toBeUndefined();
      const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
      expect(start.teachingSkillsContract).toBeNull();
      expect(start.skillPolicyDigest).toBeNull();
      expect(kafuo.teachingSkillsContract).toBeNull();
    }
  });
});

describe('W7 matrix — marker absent but policy present (transitional shape): stays legacy', () => {
  it('never fabricates governance from policy presence (§M)', () => {
    const wire = governedVector();
    delete wire.teachingSkills;
    const { request, aggregate } = parseKafuoGenerationRequest(wire);
    expect(request.teachingSkillsContract).toBeUndefined();
    // Lineage evidence is still recorded — Kafuo projects policy while the flag is
    // off — but the mode stays legacy.
    const { start } = buildKafuoStartRequest(request, aggregate);
    expect(start.teachingSkillsContract).toBeNull();
    expect(start.skillPolicyDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('W7 matrix — unresolved exact version: passes Kafuo, refused HERE', () => {
  // The Kafuo half builds the IDENTICAL mutation (feynman-learning v1 → v99 across
  // the whole governed vector) and asserts Kafuo accepts, digests, and emits it —
  // canonical existence is TE's authority alone. Coherence survives the mutation
  // because every occurrence of the skill moves to v99 together.
  const unresolved = (): Record<string, unknown> => {
    const wire = governedVector();
    replaceRefs(wire, { skillId: 'feynman-learning', version: 'v1' }, { skillId: 'feynman-learning', version: 'v99' });
    return wire;
  };

  it('parses the structurally valid shape — refusal belongs to resolution, not parsing', () => {
    const flow = governedFlowOf(unresolved());
    expect(flow.some((entry) => JSON.stringify(entry.skillPolicy).includes('v99'))).toBe(true);
  });

  it('raises SKILL_VERSION_UNRESOLVED at resolution and never substitutes a newer version', () => {
    const flow = governedFlowOf(unresolved());
    const error = expectTeachingPackageError(
      () => resolveFlowSkillPolicies(flow),
      'SKILL_VERSION_UNRESOLVED',
    );
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({ skillId: 'feynman-learning', version: 'v99' });
  });
});

describe('W7 matrix — unknown Skill identity: SKILL_NOT_FOUND is a TE outcome', () => {
  const unknown = (): Record<string, unknown> => {
    const wire = governedVector();
    replaceRefs(
      wire,
      { skillId: 'spiral-curriculum', version: 'v1' },
      { skillId: 'no-such-canonical-skill', version: 'v1' },
    );
    return wire;
  };

  it('parses the well-formed unknown reference (Kafuo does not check existence)', () => {
    expect(() => parseKafuoGenerationRequest(unknown())).not.toThrow();
  });

  it('raises SKILL_NOT_FOUND at resolution against the real registry', () => {
    const error = expectTeachingPackageError(
      () => resolveFlowSkillPolicies(governedFlowOf(unknown())),
      'SKILL_NOT_FOUND',
    );
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({ skillId: 'no-such-canonical-skill' });
  });
});

describe('W7 matrix — Module-2 request: mode derived once and carried as a value', () => {
  it('threads one identical contract value through request, start request, and context', () => {
    // §B.13: the marker is tested at ONE detection point (parse) and carried as a
    // value. All three downstream sites must agree without re-testing the wire.
    const { request, aggregate } = parseKafuoGenerationRequest(governedVector());
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(
      new Set([request.teachingSkillsContract, start.teachingSkillsContract, kafuo.teachingSkillsContract]),
    ).toEqual(new Set([TEACHING_SKILLS_CONTRACT_V1]));
  });

  it('derives the mode from the marker alone: same flow, no marker, different mode', () => {
    const wire = governedVector();
    const governed = parseKafuoGenerationRequest(wire);
    delete wire.teachingSkills;
    const legacy = parseKafuoGenerationRequest(wire);
    expect(governed.request.teachingSkillsContract).toBe(TEACHING_SKILLS_CONTRACT_V1);
    expect(legacy.request.teachingSkillsContract).toBeUndefined();
    // Identical policy payload, identical digest — mode is orthogonal to policy.
    expect(canonicalRequestDigest(legacy.request)).toBe(
      canonicalRequestDigest(governed.request),
    );
  });
});
