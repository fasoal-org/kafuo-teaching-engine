/**
 * Governed regeneration context (Module 3/4 W4 — TAE-RQ-018/019/020/010/011,
 * plan §7.4.1). The distinction this module exists for: lineage preservation
 * and generation authority are DIFFERENT requirements. A regenerated Scene
 * that merely carries `teachingStage` + `teachingSkills` forward while its
 * new pedagogical output was generated without Flow Instructions or resolved
 * Skills LOOKS governed and is not — carrier preservation alone is never
 * accepted as proof.
 *
 * For an operation initiated later than the original request (regeneration,
 * editor mutation), governed mode comes ONLY from the durable marker:
 * `readTeachingSkillsGovernanceForVersion` walks the predecessor chain and
 * reads `teaching_package_generation_attempts.teaching_skills_contract`.
 * Never inferred from `teachingStage`, `teachingSkills`, flow presence, Scene
 * content, or Action content.
 *
 * The Flow resolution REUSES W1 end to end: `resolveGovernedSceneFlowContext`
 * produces the same `SceneFlowContext` it produces at initial generation,
 * with the same fail-closed refusals — a governed Stage whose context cannot
 * be resolved refuses the regeneration rather than producing ungoverned
 * output. The generator is never handed a flow array.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import type { ResolvedSkillDefinition, SceneFlowContext } from '@openmaic/generation';
import type { Scene } from '@/lib/types/stage';
import {
  resolveGovernedSceneFlowContext,
  type GovernedGenerationContext,
} from '@/lib/server/classroom-generation';
import {
  readFlowForVersion,
  readTeachingSkillsGovernanceForVersion,
} from '@/lib/server/teaching-package/exact-flow';
import { resolveFlowSkillPolicies } from '@/lib/server/teaching-package/skill-policy';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

/** The governed authority a regeneration path generates under, or refuses. */
export interface GovernedRegenerationContext {
  /** The ONE resolved Flow position for this Scene (W1 shape, unchanged). */
  flowContext: SceneFlowContext;
  /** The exact resolved canonical Skill definitions for the run. */
  resolvedSkills: ResolvedSkillDefinition[];
}

/**
 * Resolve the governed regeneration context for ONE Scene of a version.
 * Returns `undefined` for a legacy version (no contract marker — tier A or
 * B): the caller keeps today's behavior exactly. Throws
 * `GOVERNED_FLOW_CONTEXT_UNRESOLVED` (via W1's resolver) for a governed
 * version whose Flow entry for the Scene cannot be resolved, and
 * `SKILL_POLICY_REQUIRED` for corrupt governed lineage with no flow at all.
 */
export async function resolveGovernedRegenerationContext(
  pool: Queryable,
  versionId: string,
  scene: Pick<Scene, 'teachingStage'>,
): Promise<GovernedRegenerationContext | undefined> {
  const governance = await readTeachingSkillsGovernanceForVersion(pool, versionId);
  if (!governance || !governance.contract) return undefined;

  const flow = await readFlowForVersion(pool, versionId);
  if (!flow || flow.length === 0) {
    // A governed attempt always carries flow (the parse seam refuses
    // otherwise); a governed version with no resolvable flow is corrupt
    // lineage — fail closed, never degrade to the legacy path (BR-TS-048).
    throw new TeachingPackageError(
      'SKILL_POLICY_REQUIRED',
      'the governed version records no Teaching Model Flow to regenerate under',
      { versionId },
    );
  }

  const versionRow = await pool.query<{
    teaching_model_key: string;
    teaching_model_version: string;
  }>(
    `SELECT teaching_model_key, teaching_model_version
       FROM teaching_package_versions
      WHERE id = $1`,
    [versionId],
  );
  const model = versionRow.rows[0];
  if (!model) {
    throw new TeachingPackageError(
      'SKILL_POLICY_REQUIRED',
      'the governed version cannot be read for its Teaching Model lineage',
      { versionId },
    );
  }

  const governed: GovernedGenerationContext = {
    contract: governance.contract,
    teachingModel: { key: model.teaching_model_key, version: model.teaching_model_version },
    flow,
  };
  const flowContext = resolveGovernedSceneFlowContext(governed, {
    teachingStage: scene.teachingStage,
  } as Parameters<typeof resolveGovernedSceneFlowContext>[1]);
  if (!flowContext) {
    // Unreachable in practice: the resolver returns undefined only for a
    // non-governed input, and `governed` is always defined here. Kept as a
    // throw rather than an assertion so the compiler keeps this path honest.
    throw new TeachingPackageError(
      'GOVERNED_FLOW_CONTEXT_UNRESOLVED',
      'cannot resolve the authoritative Flow entry for a governed regeneration',
      { versionId },
    );
  }

  const resolvedSkills = [...resolveFlowSkillPolicies(flow).entries()].map(([, definition]) => ({
    skillId: definition.skillId,
    version: definition.version,
    definition: definition.content,
  }));
  return { flowContext, resolvedSkills };
}

/**
 * Stage-facing wrapper for callers that know a Stage, not a version — the
 * agent tools. Resolves the version bound to the Stage
 * (`teaching_package_versions.current_stage_id`); a Stage with no bound
 * version is not a Teaching Package Stage and answers `undefined` (legacy,
 * byte-identical behavior). Requires a configured `DATABASE_URL`; without
 * one (non-DB runtimes and unit tests) there is no package lineage to read
 * and the answer is `undefined`.
 */
export async function resolveGovernedRegenerationContextForStage(
  stageId: string,
  scene: Pick<Scene, 'teachingStage'>,
): Promise<GovernedRegenerationContext | undefined> {
  if (!process.env.DATABASE_URL) return undefined;
  const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL);
  const version = await pool.query(
    `SELECT id FROM teaching_package_versions WHERE current_stage_id = $1`,
    [stageId],
  );
  const versionId = (version.rows[0] as { id?: string } | undefined)?.id;
  if (!versionId) return undefined;
  return resolveGovernedRegenerationContext(pool as unknown as Queryable, versionId, scene);
}
