/**
 * Content Unit retention adapter (Kafuo R1 plan §5.1): which units of an
 * acquired normalized manifest are kept per attempt in
 * `teaching_package_content_units`, and the ONE skip rule they share with the
 * prompt projection (`adaptNormalizedText`).
 *
 * The rule lives here, not in `normalized-content-resource.ts`, so that the
 * retention write and the prompt projection cannot drift: a unit the model
 * could read is a unit Help can later cite, and a unit skipped from the
 * prompt (figure-only, reference) is skipped from retention too — the Scene
 * never cited it, so retaining it would only fabricate grounding.
 */
import type { ContentUnitInput } from '@/lib/persistence/teaching-package';

/** The manifest-unit subset the rule and the adapter read. */
export interface RetainableManifestUnit {
  id: string;
  orderIndex: number;
  role: string;
  subtype?: string;
  title?: string;
  normalizedText?: string;
  blocks?: Array<{ associatedVisualIds?: string[] }>;
}

/**
 * Content Unit roles that are allowed to carry no teaching text at all.
 *
 * Kafuo's own readiness facts (`book_grounded_readiness_facts.py`) treat
 * `{REFERENCE, UNCLASSIFIED}` as non-instructional; its metadata use case
 * (`generate_lesson_metadata.py`) carves out only `{REFERENCE}`. The wider set
 * is adopted deliberately: the projection must not fail acquisition of a
 * package Kafuo itself considers approvable.
 */
export const NON_INSTRUCTIONAL_UNIT_ROLES: ReadonlySet<string> = new Set([
  'REFERENCE',
  'UNCLASSIFIED',
]);

/** Does any of this unit's blocks associate a visual? (internal evidence only). */
export function unitCarriesVisuals(unit: RetainableManifestUnit): boolean {
  return (unit.blocks ?? []).some((block) => (block.associatedVisualIds ?? []).length > 0);
}

/**
 * The unit's usable teaching text, or `null` when the unit legitimately
 * teaches nothing in prose (figure-only / non-instructional) and is SKIPPED
 * by both the prompt projection and retention. A textless unit that is
 * neither is a Kafuo-side defect the projection fails on; this helper does
 * not decide that — it only answers "skip or keep".
 */
export function retainableUnitText(unit: RetainableManifestUnit): string | null {
  const text = unit.normalizedText?.trim();
  if (text) return text;
  return null;
}

export function unitMaySkipText(unit: RetainableManifestUnit): boolean {
  return unitCarriesVisuals(unit) || NON_INSTRUCTIONAL_UNIT_ROLES.has(unit.role?.toUpperCase());
}

/**
 * Project the manifest's units onto retention rows — exactly the units
 * `adaptNormalizedText` renders (same skip rule, same order), with the
 * lineage the manifest carries. The projection already failed acquisition
 * for a textless unit that may not skip, so none reaches here.
 */
export function retainableContentUnits(manifest: {
  contentUnits: RetainableManifestUnit[];
  contentRevisionId?: string;
  approvedSnapshotId?: string;
}): ContentUnitInput[] {
  const rows: ContentUnitInput[] = [];
  const units = [...manifest.contentUnits].sort((a, b) => a.orderIndex - b.orderIndex);
  for (const unit of units) {
    const text = retainableUnitText(unit);
    // A textless unit is skipped whether it MAY skip (figure-only, reference)
    // or not: the latter never reaches here — the projection already failed
    // acquisition on it — and an empty row could not ground anything anyway.
    if (text === null) continue;
    rows.push({
      unitId: String(unit.id),
      orderIndex: unit.orderIndex,
      role: unit.role,
      subtype: unit.subtype ?? null,
      title: unit.title ?? null,
      normalizedText: text,
      contentRevisionId: manifest.contentRevisionId ?? null,
      approvedSnapshotId: manifest.approvedSnapshotId ?? null,
    });
  }
  return rows;
}
