/**
 * Pedagogically material Scene fingerprint (Module 2 W13 — teaching-skills plan
 * §P Step 14 · §K · R-6 CLOSED · FR-TS-042/043 · BR-TS-036/037 · AC-TS-013).
 *
 * The material boundary is CLOSED (R-6) and lives here as the ONE definition —
 * W13's legacy-successor material-edit comparison and W14's derived alignment
 * state must never grow second copies of it:
 *
 * ```text
 * Material:      content · actions · title · description
 * Non-material:  order · outlineId · stageId · updatedAt
 * ```
 *
 * `order` is excluded deliberately: it is governed by flow identity and
 * exact-flow validation, not by Skill alignment (R-6, VAL-TS-012). `teachingStage`
 * is flow identity and excluded for the same reason. `teachingSkills` is the
 * assignment itself — the derivation compares it separately, never through the
 * fingerprint. `id`, `stageId`, `outlineId`, `createdAt` and `updatedAt` are
 * identity/provenance plumbing.
 *
 * The fingerprint is a sha256 over the sorted-key canonical JSON of the material
 * projection (the same canonicalization idiom `computeSkillPolicyDigest` uses),
 * so two scenes with equal material fields always fingerprint identically
 * regardless of key order, and a no-op save is digest-stable.
 */
import { createHash } from 'node:crypto';

import type { AppScene } from '@/lib/types/stage';
import type { SceneAlignmentBaseline, TeachingSkillRef } from '@/lib/types/teaching-package';

/** The R-6 closed material field set, in the plan's own order. */
export const MATERIAL_SCENE_FIELDS = ['content', 'actions', 'title', 'description'] as const;

/** Fields deliberately OUTSIDE the fingerprint, recorded so tests can pin the boundary. */
export const NON_MATERIAL_SCENE_FIELDS = ['order', 'outlineId', 'stageId', 'updatedAt'] as const;

/**
 * The material projection of one Scene: exactly the four R-6 fields. Absent
 * optional fields are normalised away so `{title}` and `{title, description:
 * undefined}` project identically.
 *
 * `AppScene` carries no top-level `description` today (the pedagogical
 * description the plan's R-6 names lives on the outline and, once
 * materialised, inside `content`) — it is read defensively so that if a
 * Scene-level description field ever lands, it is material from day one
 * rather than silently outside the fingerprint.
 */
export function materialSceneProjection(scene: AppScene): Record<string, unknown> {
  const description = (scene as { description?: unknown }).description;
  const projection: Record<string, unknown> = {
    title: scene.title,
    content: scene.content ?? null,
    actions: scene.actions ?? null,
  };
  if (description !== undefined) projection.description = description;
  return projection;
}

/** Sorted-key canonical JSON (arrays keep their order — it is semantic). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return entry;
  });
}

/**
 * The pedagogically material fingerprint of one Scene — the semantic
 * material-change signal, deliberately NOT the trigger-maintained `sceneRev`
 * (plan §K: `sceneRev` is concurrency protection only and a metadata-only edit
 * raises it while leaving this fingerprint unchanged).
 */
export function sceneMaterialFingerprint(scene: AppScene): string {
  return createHash('sha256')
    .update(canonicalJson(materialSceneProjection(scene)), 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Derived alignment state (Module 2 W14 — plan §P Step 14 · §K · BR-TS-037 ·
// FR-TS-042/043 · VAL-TS-010 · AC-TS-013)
// ---------------------------------------------------------------------------

/**
 * One Scene's derived alignment state — computed at read, NEVER stored. The
 * four functional states the Editor and Submit consume map onto these values:
 *
 * ```text
 * current              baseline matches, origin 'generation'
 * confirmed            baseline matches, origin 'reviewer-confirmation'
 *                      (the "resolved / confirmed" functional state)
 * stale                fingerprint / assignment / classification ≠ baseline
 *                      (the "stale / validation-required after a change" one)
 * validation-required  no baseline (a governed Scene never validated or
 *                      confirmed — W15 stamps one on generation/confirmation)
 * ```
 *
 * The fourth functional state, `known mismatch`, is the future evaluator's
 * verdict (FR-TS-064 seam): V1 persists no mismatch record and no evaluator is
 * built, so nothing derives it. It needs no separate representation here
 * because Submit blocks on EVERY non-matching state identically — uncertainty
 * is never silently resolved as success (VAL-TS-010).
 */
export type DerivedAlignmentState = 'current' | 'confirmed' | 'stale' | 'validation-required';

export interface SceneAlignmentDerivation {
  sceneId: string;
  state: DerivedAlignmentState;
  /** True only while the Scene still matches its baseline (`current`/`confirmed`). */
  aligned: boolean;
  /** Which bound value failed to match, when a baseline exists. */
  reason?: 'material-change' | 'assignment-change' | 'classification-change';
  baselineOrigin?: SceneAlignmentBaseline['origin'];
  baselineEstablishedAt?: number;
}

const sameRef = (a: TeachingSkillRef | undefined, b: TeachingSkillRef | undefined): boolean => {
  if (!a || !b) return a === b;
  return a.skillId === b.skillId && a.version === b.version;
};

const sameRefList = (
  a: readonly TeachingSkillRef[] | undefined,
  b: readonly TeachingSkillRef[] | undefined,
): boolean => {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((ref, index) => sameRef(ref, b[index]));
};

/**
 * Derive one Scene's alignment state against its baseline — the §K ladder,
 * exactly and in order:
 *
 * ```text
 * no baseline (governed Scene)            → validation-required
 * fingerprint ≠ baseline.fingerprint      → stale (material change)
 * assignment or classification ≠ baseline → stale
 * otherwise                               → current / resolved
 * ```
 *
 * Read-only and pure: the caller supplies the Scene; nothing here trusts a
 * persisted state, a `sceneRev`, or a generation-attempt row. `sceneRev`
 * equality is deliberately NOT required for validity — a metadata-only edit
 * raises the revision while leaving this derivation matching (FR-TS-043).
 */
export function deriveSceneAlignment(scene: AppScene): SceneAlignmentDerivation {
  const baseline = scene.alignmentBaseline;
  if (!baseline) {
    return { sceneId: scene.id, state: 'validation-required', aligned: false };
  }
  const mismatch = (
    reason: NonNullable<SceneAlignmentDerivation['reason']>,
  ): SceneAlignmentDerivation => ({
    sceneId: scene.id,
    state: 'stale',
    aligned: false,
    reason,
    baselineOrigin: baseline.origin,
    baselineEstablishedAt: baseline.establishedAt,
  });
  if (sceneMaterialFingerprint(scene) !== baseline.fingerprint) {
    return mismatch('material-change');
  }
  const skills = scene.teachingSkills;
  if (
    !sameRef(skills?.primary, baseline.primary) ||
    !sameRefList(skills?.supporting, baseline.supporting)
  ) {
    return mismatch('assignment-change');
  }
  if (skills?.classification !== baseline.classification) {
    return mismatch('classification-change');
  }
  return {
    sceneId: scene.id,
    state: baseline.origin === 'reviewer-confirmation' ? 'confirmed' : 'current',
    aligned: true,
    baselineOrigin: baseline.origin,
    baselineEstablishedAt: baseline.establishedAt,
  };
}

/** Derive every Scene's alignment state, keyed by scene id. */
export function deriveStageAlignment(
  scenes: readonly AppScene[],
): Map<string, SceneAlignmentDerivation> {
  return new Map(scenes.map((scene) => [scene.id, deriveSceneAlignment(scene)]));
}

// ---------------------------------------------------------------------------
// Baseline establishment (Module 2 W15 — plan §P Step 16 · §K · BR-TS-032/038 ·
// FR-TS-037/044/045/071 · VAL-TS-010 · AC-TS-032)
// ---------------------------------------------------------------------------

/**
 * Establish a baseline from a Scene's CURRENT state — the one construction
 * point both origins share (plan §K: "Both origins produce the same shape, so
 * Submit has one thing to check"):
 *
 * - `'generation'` — stamped only once final Scene content and Actions exist
 *   (the persistence sink, after narration normalization, so the fingerprint
 *   reflects the ACTUAL generated pedagogical result, never the outline's
 *   intent); carries no actorRef.
 * - `'reviewer-confirmation'` — recorded by the confirmation route in
 *   draft/rejected, binding the assignment + classification + fingerprint the
 *   reviewer confirmed, with actorRef and time.
 *
 * Returns `null` for a Scene that carries no classification (or a value
 * outside the closed vocabulary): a baseline binds a classification the Scene
 * ACTUALLY carries, and fabricating one produced a record the Scene could
 * never match — `stale / classification-change` from birth, a falsehood about
 * a Scene where nothing changed, which reviewer confirmation could not lift.
 * Such a Scene gets NO baseline from any path; it derives
 * `validation-required` until it carries one. The nullable return is the
 * enforcement: the compiler forces every future caller to confront the
 * unclassified shape instead of silently re-fabricating.
 *
 * Identity plus state ONLY — no chain-of-thought, no rationale (BR-TS-032,
 * FR-TS-037). Validity is recomputed at read against this record; the record
 * itself is never trusted as a state. A stale baseline is inert, not
 * dangerous: it cannot overwrite newer state, it simply fails to match.
 */
export function buildSceneAlignmentBaseline(
  scene: AppScene,
  options: { origin: 'generation' | 'reviewer-confirmation'; actorRef?: string; now: number },
): SceneAlignmentBaseline | null {
  const skills = scene.teachingSkills;
  const classification = skills?.classification;
  if (classification !== 'instructional' && classification !== 'non-instructional') {
    return null;
  }
  return {
    ...(skills?.primary ? { primary: skills.primary } : {}),
    ...(skills?.supporting ? { supporting: skills.supporting } : {}),
    classification,
    fingerprint: sceneMaterialFingerprint(scene),
    ...(options.origin === 'reviewer-confirmation' && options.actorRef
      ? { actorRef: options.actorRef }
      : {}),
    establishedAt: options.now,
    origin: options.origin,
  };
}

/**
 * Stamp generation-origin baselines onto the Scenes a governed generation just
 * produced (Module 2 W15). Only Scenes carrying a `teachingSkills` carrier are
 * stamped: that carrier exists exclusively on Module-2-governed runs (W10's
 * gate emits it only under resolved policy), so presence IS the governed
 * signal and legacy Scenes stay untouched — absence on legacy data is the
 * backward-compatibility mechanism itself (AC-TS-034).
 *
 * An unclassified Scene (a malformed carrier the Stage-1 gate would normally
 * refuse) is SKIPPED rather than stamped with a fabricated classification: it
 * derives `validation-required` — the honest state — instead of a
 * self-invalidating `stale`.
 *
 * The caller MUST invoke this only on the FINAL scene set (content and Actions
 * composed, narration normalized, media references rewritten to the final
 * stage id) — the fingerprint must reflect the persisted result, not an
 * intermediate one.
 */
export function stampGenerationAlignmentBaselines(
  scenes: readonly AppScene[],
  now: number,
): AppScene[] {
  return scenes.map((scene) => {
    if (!scene.teachingSkills) return scene;
    const baseline = buildSceneAlignmentBaseline(scene, { origin: 'generation', now });
    return baseline ? { ...scene, alignmentBaseline: baseline } : scene;
  });
}
