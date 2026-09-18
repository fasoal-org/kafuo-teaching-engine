'use client';

/**
 * TeachingSkillsPanel — the reviewer's per-Scene pedagogical inspection surface
 * (Module 2 W16, teaching-skills plan §P Step 17 · §J · FR-TS-038/045/053 ·
 * AC-TS-026).
 *
 * Mounted by `EditDock` — ABOVE the surface layer, on purpose: the surfaces
 * cover only slide and quiz, and attaching there would silently exclude
 * interactive and PBL Scenes, exactly the Scene types most likely to be
 * pedagogically active (plan §J Phase 2B constraint 1). The dock renders for
 * every Scene type, and this panel reads only the Scene-type-agnostic
 * `teachingSkills`/`teachingStage` carriers via the inspection API — it never
 * switches on `scene.type`.
 *
 * All eight fields render: classification · Primary · Supporting · exact
 * versions · policy relationship · flow position · alignment state ·
 * actionable failures. While the version is editable, the panel also corrects
 * assignment and classification (policy-constrained, content preserved, no
 * regeneration) and records reviewer confirmation. Authorization is the
 * Editor grant's capability plus the existing status guard — both enforced
 * server-side; the panel only reflects them (`editable`).
 *
 * Module 3/4 W5 (plan §7.5, TAE-RQ-025/027) adds the Actions governance
 * context: the inspection response's `actionCount` and the structural
 * findings folded into `failures` render here as a SUMMARY that points at the
 * timeline rows — the ordered Actions themselves render once, in the
 * ActionsBar timeline this panel floats above; this panel never lists them
 * (the C-8 reuse decision), and the payload it reads carries Action identity
 * and findings only, never Action content.
 */
import { useCallback, useEffect, useState } from 'react';

import { useStageStore } from '@/lib/store/stage';

interface SkillRefView {
  skillId: string;
  version: string;
}

interface SceneInspectionView {
  sceneId: string;
  sceneType: string;
  flowPosition: { key: string; flowIndex: number } | null;
  classification: string | null;
  primary: SkillRefView | null;
  supporting: SkillRefView[];
  policy: {
    relationship: 'within-policy' | 'out-of-policy' | 'no-policy';
    allowed: SkillRefView[];
    required: Array<SkillRefView & { role: string; scope: string }>;
    preferred: SkillRefView[];
  };
  alignment: {
    state: 'current' | 'confirmed' | 'stale' | 'validation-required';
    aligned: boolean;
    reason?: string;
    baselineOrigin?: string;
  };
  /** W5: ordered-Action count (identity-only projection — never content). */
  actionCount: number;
  /** W5: per-Action structural findings, attributed on `actionId`. */
  actionFindings: Array<{
    actionId?: string;
    actionType?: string;
    code: string;
    message: string;
  }>;
  failures: Array<{ code: string; message: string }>;
}

interface InspectionResponse {
  governed: boolean;
  capability?: 'read' | 'write';
  versionStatus?: string;
  editable?: boolean;
  teachingModel?: { key: string; version: string };
  flowStages?: string[];
  scenes?: SceneInspectionView[];
}

const refLabel = (ref: SkillRefView) => `${ref.skillId}@${ref.version}`;

const ALIGNMENT_LABELS: Record<SceneInspectionView['alignment']['state'], string> = {
  current: 'Aligned (generated)',
  confirmed: 'Confirmed by reviewer',
  stale: 'Validation required (changed)',
  'validation-required': 'Validation required (never confirmed)',
};

/**
 * The panel is deliberately self-effacing: anything it cannot inspect (a
 * non-package classroom, a legacy package, an unreachable API) renders
 * NOTHING — it must never interfere with ordinary editing.
 */
export function TeachingSkillsPanel({ sceneId }: { readonly sceneId: string }) {
  const stageId = useStageStore((state) => state.stage?.id ?? null);
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<InspectionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!stageId) return;
    try {
      const response = await fetch(`/api/stages/${encodeURIComponent(stageId)}/teaching-skills`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        setInspection(null);
        return;
      }
      setInspection((await response.json()) as InspectionResponse);
      setError(null);
    } catch {
      // Non-package classroom, offline dev, legacy stage — stay hidden.
      setInspection(null);
    }
  }, [stageId]);

  useEffect(() => {
    setInspection(null);
    void load();
  }, [load]);

  if (!stageId || !inspection?.governed) return null;

  const scene = inspection.scenes?.find((entry) => entry.sceneId === sceneId) ?? null;
  if (!scene) return null;

  const editable = inspection.editable === true && inspection.capability === 'write';
  const canConfirm = editable && !scene.alignment.aligned;

  const mutate = async (body: Record<string, unknown>, endpoint: 'skills' | 'confirm') => {
    setBusy(true);
    setError(null);
    try {
      const base = `/api/stages/${encodeURIComponent(stageId)}`;
      const response = await fetch(
        endpoint === 'skills' ? `${base}/teaching-skills` : `${base}/scene-alignment-confirmations`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? 'the change was rejected');
        return;
      }
      await load();
    } catch {
      setError('the change could not be applied');
    } finally {
      setBusy(false);
    }
  };

  const applySkills = (teachingSkills: Record<string, unknown>) =>
    mutate({ assignments: [{ sceneId, teachingSkills }] }, 'skills');

  return (
    <div className="pointer-events-none absolute bottom-full right-3 z-20 mb-1 flex flex-col items-end">
      <button
        type="button"
        data-testid="teaching-skills-toggle"
        onClick={() => setOpen((current) => !current)}
        className="pointer-events-auto mb-1 rounded-full border border-zinc-200 bg-white/90 px-3 py-1 text-xs text-zinc-600 shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-slate-900/90 dark:text-zinc-300"
      >
        Teaching Skills
      </button>
      {open ? (
        <section
          data-testid="teaching-skills-panel"
          data-scene-type={scene.sceneType}
          className="pointer-events-auto max-h-64 w-96 overflow-y-auto rounded-xl border border-zinc-200 bg-white/95 p-3 text-xs shadow-xl backdrop-blur dark:border-zinc-700 dark:bg-slate-900/95 dark:text-zinc-200"
        >
          <header className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Teaching Skills</h3>
            <span data-testid="teaching-skills-flow-position">
              {scene.flowPosition
                ? `${scene.flowPosition.flowIndex} · ${scene.flowPosition.key}`
                : 'no flow position'}
            </span>
          </header>

          <dl className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">Classification</dt>
              <dd data-testid="teaching-skills-classification" className="flex items-center gap-1">
                <span>{scene.classification ?? '—'}</span>
                {editable ? (
                  <select
                    data-testid="teaching-skills-classification-input"
                    value={scene.classification ?? ''}
                    disabled={busy}
                    onChange={(event) =>
                      void applySkills({
                        ...(scene.primary ? { primary: scene.primary } : {}),
                        ...(scene.supporting.length > 0 ? { supporting: scene.supporting } : {}),
                        classification: event.target.value,
                      })
                    }
                  >
                    <option value="instructional">instructional</option>
                    <option value="non-instructional">non-instructional</option>
                  </select>
                ) : null}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">Primary</dt>
              <dd data-testid="teaching-skills-primary" className="flex items-center gap-1">
                <span>{scene.primary ? refLabel(scene.primary) : '—'}</span>
                {editable && scene.policy.allowed.length > 0 ? (
                  <select
                    data-testid="teaching-skills-primary-input"
                    value={scene.primary ? refLabel(scene.primary) : ''}
                    disabled={busy}
                    onChange={(event) => {
                      const selected = scene.policy.allowed.find(
                        (ref) => refLabel(ref) === event.target.value,
                      );
                      if (!selected) return;
                      void applySkills({
                        primary: selected,
                        ...(scene.supporting.length > 0
                          ? {
                              supporting: scene.supporting.filter(
                                (ref) => ref.skillId !== selected.skillId,
                              ),
                            }
                          : {}),
                        classification: scene.classification ?? 'instructional',
                      });
                    }}
                  >
                    {scene.primary ? (
                      <option value={refLabel(scene.primary)}>{refLabel(scene.primary)}</option>
                    ) : null}
                    {scene.policy.allowed
                      .filter((ref) => !scene.primary || refLabel(ref) !== refLabel(scene.primary))
                      .map((ref) => (
                        <option key={refLabel(ref)} value={refLabel(ref)}>
                          {refLabel(ref)}
                        </option>
                      ))}
                  </select>
                ) : null}
              </dd>
            </div>

            <div className="flex items-start justify-between gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">Supporting</dt>
              <dd data-testid="teaching-skills-supporting" className="text-right">
                {scene.supporting.length === 0 ? (
                  <span>—</span>
                ) : (
                  scene.supporting.map((ref) => <div key={refLabel(ref)}>{refLabel(ref)}</div>)
                )}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">Policy</dt>
              <dd data-testid="teaching-skills-policy" className="text-right">
                <span>
                  {scene.policy.relationship === 'within-policy'
                    ? 'within policy'
                    : scene.policy.relationship === 'out-of-policy'
                      ? 'OUT OF POLICY'
                      : 'no policy at this position'}
                </span>
                {scene.policy.allowed.length > 0 ? (
                  <div className="text-zinc-400">
                    allowed: {scene.policy.allowed.map(refLabel).join(', ')}
                  </div>
                ) : null}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">Alignment</dt>
              <dd
                data-testid="teaching-skills-alignment"
                data-state={scene.alignment.state}
                className={scene.alignment.aligned ? 'text-emerald-600' : 'text-amber-600'}
              >
                {ALIGNMENT_LABELS[scene.alignment.state]}
                {scene.alignment.reason ? ` — ${scene.alignment.reason}` : ''}
              </dd>
            </div>

            {/* W5: the Actions governance context — a summary pointing at the
                timeline this panel floats above, never a second Action list.
                The timeline marks the offending rows; the codes and messages
                ride the failures channel below. */}
            <div className="flex items-center justify-between gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">Actions</dt>
              <dd data-testid="teaching-skills-actions" className="text-right">
                <span>{scene.actionCount ?? 0} in the timeline</span>
                {(scene.actionFindings ?? []).length > 0 ? (
                  <div className="text-red-600 dark:text-red-400">
                    {(scene.actionFindings ?? []).length} structural finding
                    {(scene.actionFindings ?? []).length === 1 ? '' : 's'} — marked on the offending
                    Action rows in the timeline
                  </div>
                ) : (
                  <div className="text-zinc-400">no structural findings</div>
                )}
              </dd>
            </div>
          </dl>

          {scene.failures.length > 0 ? (
            <ul data-testid="teaching-skills-failures" className="mt-2 space-y-1">
              {scene.failures.map((failure) => (
                <li
                  key={failure.code}
                  className="rounded bg-red-50 px-2 py-1 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                >
                  <span className="font-mono text-[10px]">{failure.code}</span> {failure.message}
                </li>
              ))}
            </ul>
          ) : (
            <p data-testid="teaching-skills-failures" className="mt-2 text-zinc-400">
              no validation failures
            </p>
          )}

          {canConfirm ? (
            <button
              type="button"
              data-testid="teaching-skills-confirm"
              disabled={busy}
              className="mt-2 w-full rounded-lg border border-zinc-300 px-2 py-1 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
              onClick={() => void mutate({ confirmations: [{ sceneId }] }, 'confirm')}
            >
              Confirm alignment
            </button>
          ) : null}
          {error ? <p className="mt-2 text-red-600">{error}</p> : null}
          {!editable ? (
            <p className="mt-2 text-zinc-400">
              read-only — the version is {inspection.versionStatus ?? 'not editable'}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
