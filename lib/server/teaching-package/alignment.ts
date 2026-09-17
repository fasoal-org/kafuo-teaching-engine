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
