/**
 * The one diagnostic shape every outline check reports in.
 *
 * Three dispositions exist and they never blur:
 *
 * - `repaired` — machine-repairable METADATA was normalised (an incompatible
 *   `contentKind` dropped, a stray planner-only field removed). The pedagogical
 *   purpose (`contentRole`), the scene type, the flow position and the grounding
 *   are never changed by a repair. The record is kept so the change is visible.
 * - `admin_correctable` — the outline cannot proceed as answered, but a person
 *   can fix it by choosing a value (a role, a flow position, Content Units, …).
 *   A run that supports checkpoints pauses for correction instead of failing.
 * - Execution failures (provider outage, unresolvable authority, malformed
 *   response) are NOT diagnostics: they keep throwing their typed errors.
 *
 * Pure data: no I/O and no behaviour.
 */

export type OutlineDiagnosticDisposition = 'repaired' | 'admin_correctable';

export interface OutlineDiagnostic {
  /** Stable machine code, e.g. `CONTENT_KIND_DROPPED`, `CONTENT_ROLE_NOT_ALLOWED`. */
  code: string;
  disposition: OutlineDiagnosticDisposition;
  /** Zero-based position of the outline, when the finding is about one outline. */
  outlineIndex?: number;
  outlineId?: string;
  /** The outline field the finding is about (`contentRole`, `teachingStage`, …). */
  field?: string;
  /** Human-readable reason — what is wrong and why. */
  message: string;
  /** The values an administrator may choose from, when the field is enumerable. */
  allowedValues?: Array<string | number>;
  /** For `repaired`: the value that was removed or replaced. */
  previousValue?: unknown;
  /** The authoritative Teaching Model Flow position the finding concerns. */
  flowIndex?: number;
  stage?: string;
}

/** True when at least one diagnostic needs a person before the run may continue. */
export function hasBlockingOutlineDiagnostics(diagnostics: readonly OutlineDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.disposition === 'admin_correctable');
}

/** One-line summary of blocking diagnostics, used as an error message. */
export function formatBlockingOutlineDiagnostics(
  diagnostics: readonly OutlineDiagnostic[],
  prefix: string,
): string {
  const blocking = diagnostics.filter(
    (diagnostic) => diagnostic.disposition === 'admin_correctable',
  );
  const shown = blocking
    .slice(0, 5)
    .map((diagnostic) =>
      diagnostic.outlineIndex !== undefined
        ? `#${diagnostic.outlineIndex} ${diagnostic.message}`
        : diagnostic.message,
    )
    .join('; ');
  const more = blocking.length > 5 ? ` (+${blocking.length - 5} more)` : '';
  return `${prefix}: ${blocking.length} issue(s): ${shown}${more}`;
}
