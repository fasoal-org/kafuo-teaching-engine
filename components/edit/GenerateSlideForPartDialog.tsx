'use client';

/**
 * "Generate a slide for a lesson part" dialog
 * (reviewer-generated-slide-for-lesson-part-plan §5 step 3, §15, §16).
 *
 * One dialog for both entry points: the Lesson parts panel (the unit is
 * pre-filled and the position suggested) and a "+" zone (the position is
 * fixed). The reviewer picks 1–3 uncovered lesson parts, a position, the
 * teaching stage that position allows, an optional focus for the AI and a
 * required reason (audit only, never sent to the model). Only unit titles are
 * shown: the server never sends unit text.
 *
 * Like RegenerateSlideDialog it is modal while running and cannot be closed.
 * One idempotency key per open. After an `unknown` outcome the key AND the
 * submitted request are kept (the fields freeze), so a retry resends the
 * identical body and the server replays the stored outcome; after `failed`
 * the fields unfreeze and a new key is minted. `busy` / `not-durable` sent
 * nothing, so the key is kept as it is.
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  newInsertionKey,
  runSceneInsertion,
  SCENE_INSERTION_LIMITS,
  type ContentUnitsResponse,
  type ContentUnitSummary,
  type InsertionGate,
  type InsertionPosition,
  type InsertionPositionOption,
  type SceneInsertionOutcome,
  type SceneInsertionRequest,
  type TeachingStageRef,
} from '@/lib/edit/scene-insertion-client';

type TextField = 'instruction' | 'reason';
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The local slides, in rail order — for position labels and unsaved-change names. */
export interface InsertionSceneRef {
  readonly id: string;
  readonly title: string;
}

/** Plan §16 codes plus the reused ones; anything else gets the generic text with its code. */
const KNOWN_ERROR_CODES = new Set([
  'INSERTION_NOT_SUPPORTED',
  'INSERTION_UNIT_INVALID',
  'INSERTION_UNIT_ALREADY_COVERED',
  'INSERTION_POSITION_NOT_ALLOWED',
  'INSERTION_POSITION_CHANGED',
  'INSERTION_FLOW_INVALID',
  'INSERTION_FLOW_POLICY_VIOLATION',
  'INSERTION_PLAN_INVALID',
  'INSERTION_ALIGNMENT_UNAVAILABLE',
  'INSERTION_SKILLS_INVALID',
  'INSERTION_VISUAL_NOT_APPROVED',
  'INSERTION_STAGE_BUSY',
  'INSERTION_PERSISTENCE_FAILED',
  'INSERTION_LEASE_LOST',
  'INSERTION_ADMISSION_CLOSED',
  'INSERTION_NOT_FOUND',
  'SCENE_INSERTION_IN_PROGRESS',
  'STAGE_GENERATION_IN_PROGRESS',
  'IDEMPOTENCY_KEY_REUSED',
  'STAGE_LOCKED',
  'READ_ONLY_GRANT',
  'TEACHING_MODEL_UNAVAILABLE',
  'SUBJECT_ROUTE_UNAVAILABLE',
  'SPEECH_REGISTER_NONCOMPLIANT',
  'SCENE_CONTENT_GENERATION_FAILED',
]);

/** Trimmed limits: the instruction is optional (min 0), the reason is required. */
export function insertionTextError(
  field: TextField,
  value: string,
): { rule: 'required' | 'min' | 'max'; limit?: number } | null {
  const trimmed = value.trim();
  const { min, max } = SCENE_INSERTION_LIMITS[field];
  if (trimmed === '') return min > 0 ? { rule: 'required' } : null;
  if (trimmed.length < min) return { rule: 'min', limit: min };
  if (trimmed.length > max) return { rule: 'max', limit: max };
  return null;
}

export function insertionUnitsError(
  count: number,
): { rule: 'required' | 'max'; limit?: number } | null {
  const { min, max } = SCENE_INSERTION_LIMITS.units;
  if (count < min) return { rule: 'required' };
  if (count > max) return { rule: 'max', limit: max };
  return null;
}

/** Units a new slide can be made for (plan §2, D-1): instructional, with text, no live slide. */
export function eligibleInsertionUnits(units: readonly ContentUnitSummary[]): ContentUnitSummary[] {
  return units
    .filter((unit) => unit.instructional && !unit.covered && unit.textLength > 0)
    .sort((a, b) => a.order - b.order);
}

export function positionKey(position: InsertionPosition): string {
  return `${position.afterSceneId ?? ''}|${position.beforeSceneId ?? ''}`;
}

export type StageChoice =
  | { kind: 'none' }
  | { kind: 'fixed'; stage: TeachingStageRef }
  | { kind: 'choice'; options: readonly TeachingStageRef[] };

/**
 * Plan §9.2 / D-4: no allowed stage → refusal; one → used silently; two (a
 * boundary) → the reviewer picks, the first (the previous scene's) by default.
 */
export function stageChoiceFor(
  option: Pick<InsertionPositionOption, 'allowedStages'> | null | undefined,
): StageChoice {
  const allowed = option?.allowedStages ?? [];
  if (allowed.length === 0) return { kind: 'none' };
  if (allowed.length === 1) return { kind: 'fixed', stage: allowed[0]! };
  return { kind: 'choice', options: allowed };
}

function joinList(items: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** Plan §5 step 5: name what is still unsaved — slide titles, else generic words. */
export function describePendingKeys(
  keys: readonly string[],
  scenes: readonly InsertionSceneRef[],
  t: Translate,
  locale: string,
): string {
  const titles = new Map(scenes.map((scene) => [scene.id, scene.title]));
  const items = new Set<string>();
  for (const key of keys) {
    if (key.startsWith('scene:')) {
      const title = titles.get(key.slice('scene:'.length))?.trim();
      items.add(
        title
          ? t('edit.slideInsertion.unsavedSlide', { title })
          : t('edit.slideInsertion.unsavedSlideUntitled'),
      );
    } else if (key === 'structure') items.add(t('edit.slideInsertion.unsavedStructure'));
    else if (key === 'stage') items.add(t('edit.slideInsertion.unsavedStage'));
    else if (key === 'outline') items.add(t('edit.slideInsertion.unsavedOutline'));
  }
  if (items.size === 0) items.add(t('edit.slideInsertion.unsavedPending'));
  return joinList([...items], locale);
}

export function insertionFailureMessage(code: string, t: Translate): string {
  return KNOWN_ERROR_CODES.has(code)
    ? t(`edit.slideInsertion.errors.${code}`)
    : t('edit.slideInsertion.errors.generic', { code });
}

function unitTitle(unit: ContentUnitSummary, t: Translate): string {
  return unit.title?.trim() || t('edit.slideInsertion.untitledPart', { order: unit.order });
}

export interface GenerateSlideForPartDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly stageId: string;
  /** The lesson parts, coverage and positions (null while loading). */
  readonly data: ContentUnitsResponse | null;
  /** The lesson-parts read failed (with no earlier answer, `data` stays null). */
  readonly loadFailed?: boolean;
  readonly scenes: readonly InsertionSceneRef[];
  /** Panel entry: the unit(s) to pre-fill. */
  readonly initialUnitIds?: readonly string[];
  /** "+" entry: the position, fixed. */
  readonly fixedPosition?: InsertionPosition;
  /** A slide or audio regeneration runs in this tab (plan §11.7). */
  readonly localGenerationRunning: boolean;
  /** The insertion gate's `running`, as last read. */
  readonly gateRunning?: InsertionGate['running'];
  readonly onRunningChange?: (running: boolean) => void;
  /** The slide was saved on the server (shown here or not). */
  readonly onInserted?: (
    outcome: Extract<SceneInsertionOutcome, { kind: 'success' | 'saved-not-shown' }>,
  ) => void;
  /** Test seam. */
  readonly run?: typeof runSceneInsertion;
}

export function GenerateSlideForPartDialog({
  open,
  onOpenChange,
  stageId,
  data,
  loadFailed = false,
  scenes,
  initialUnitIds,
  fixedPosition,
  localGenerationRunning,
  gateRunning,
  onRunningChange,
  onInserted,
  run = runSceneInsertion,
}: GenerateSlideForPartDialogProps) {
  const { t, locale } = useI18n();
  const dir = locale.startsWith('ar') ? 'rtl' : 'ltr';
  const unitsId = useId();
  const positionId = useId();
  const stageLabelId = useId();
  const instructionId = useId();
  const reasonId = useId();

  const [unitSelection, setUnitSelection] = useState<string[] | null>(
    initialUnitIds ? [...initialUnitIds] : null,
  );
  const [chosenPositionKey, setChosenPositionKey] = useState<string | null>(null);
  const [stageSelection, setStageSelection] = useState<{ key: string | null; index: number }>({
    key: null,
    index: 0,
  });
  const [instruction, setInstruction] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState({ units: false, instruction: false, reason: false });
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** After `unknown`: the exact request to resend (same key, same digest). */
  const [frozen, setFrozen] = useState<SceneInsertionRequest | null>(null);
  const inFlight = useRef(false);
  /** One key per open; renewed only after `failed`. */
  const keyRef = useRef<string | null>(null);

  const sceneIndex = useMemo(
    () => new Map(scenes.map((scene, index) => [scene.id, index] as const)),
    [scenes],
  );
  const eligible = useMemo(() => (data ? eligibleInsertionUnits(data.units) : []), [data]);
  const eligibleIds = useMemo(() => new Set(eligible.map((unit) => unit.id)), [eligible]);

  // Units: the reviewer's choice, else (from a "+") the parts suggested for
  // exactly this position. Ids that are no longer eligible drop out.
  const defaultUnitIds = useMemo(() => {
    if (!fixedPosition) return [];
    const key = positionKey(fixedPosition);
    return eligible
      .filter((unit) => unit.suggestedPosition && positionKey(unit.suggestedPosition) === key)
      .slice(0, SCENE_INSERTION_LIMITS.units.max)
      .map((unit) => unit.id);
  }, [eligible, fixedPosition]);
  const selectedIds = (unitSelection ?? defaultUnitIds).filter((id) => eligibleIds.has(id));
  const selectedUnits = eligible.filter((unit) => selectedIds.includes(unit.id));

  // Positions the reviewer can pick: those whose left anchor this editor shows.
  const positionOptions = useMemo(
    () =>
      (data?.positions ?? []).filter(
        (option) => option.afterSceneId === null || sceneIndex.has(option.afterSceneId),
      ),
    [data, sceneIndex],
  );
  const suggested = selectedUnits[0]?.suggestedPosition ?? null;
  const suggestedKey =
    suggested && positionOptions.some((option) => positionKey(option) === positionKey(suggested))
      ? positionKey(suggested)
      : null;
  const lastOption = positionOptions[positionOptions.length - 1];
  // A choice that vanished from a refreshed read (the slides around it changed)
  // falls back like no choice at all, so the select and the state never disagree.
  const chosenKey =
    chosenPositionKey !== null &&
    positionOptions.some((option) => positionKey(option) === chosenPositionKey)
      ? chosenPositionKey
      : null;
  const effectivePositionKey = fixedPosition
    ? positionKey(fixedPosition)
    : (chosenKey ?? suggestedKey ?? (lastOption ? positionKey(lastOption) : null));
  const selectedOption =
    effectivePositionKey === null
      ? null
      : ((data?.positions ?? []).find((option) => positionKey(option) === effectivePositionKey) ??
        null);
  const positionUnknown = Boolean(data && fixedPosition && !selectedOption);

  const stageChoice = stageChoiceFor(selectedOption);
  const stageIndex = stageSelection.key === effectivePositionKey ? stageSelection.index : 0;
  const teachingStage: TeachingStageRef | null =
    stageChoice.kind === 'fixed'
      ? stageChoice.stage
      : stageChoice.kind === 'choice'
        ? (stageChoice.options[stageIndex] ?? stageChoice.options[0]!)
        : null;

  const stageLabel = (ref: TeachingStageRef) =>
    data?.stages.find((stage) => stage.key === ref.key && stage.flowIndex === ref.flowIndex)
      ?.label ?? ref.key;
  const positionLabel = (position: InsertionPosition) => {
    if (position.afterSceneId === null) return t('edit.slideInsertion.positionStart');
    const index = sceneIndex.get(position.afterSceneId) ?? -1;
    const title = scenes[index]?.title ?? '';
    return t('edit.slideInsertion.positionAfter', { number: index + 1, title });
  };

  const errors = {
    units: insertionUnitsError(selectedIds.length),
    instruction: insertionTextError('instruction', instruction),
    reason: insertionTextError('reason', reason),
  };
  const valid =
    frozen !== null ||
    (data !== null &&
      errors.units === null &&
      errors.instruction === null &&
      errors.reason === null &&
      selectedOption !== null &&
      teachingStage !== null);
  const locked = running || frozen !== null;

  const textErrorText = (field: TextField) => {
    const error = errors[field];
    if (!error || !touched[field]) return null;
    if (error.rule === 'required') return t('edit.slideInsertion.errorRequired');
    return t(
      error.rule === 'min' ? 'edit.slideInsertion.errorMin' : 'edit.slideInsertion.errorMax',
      { limit: error.limit },
    );
  };
  const unitsErrorText = () => {
    if (!errors.units || !touched.units || eligible.length === 0) return null;
    return errors.units.rule === 'required'
      ? t('edit.slideInsertion.errorUnitsRequired')
      : t('edit.slideInsertion.errorUnitsMax', { limit: errors.units.limit });
  };

  const toggleUnit = (unitId: string) => {
    setTouched((current) => ({ ...current, units: true }));
    setUnitSelection(
      selectedIds.includes(unitId)
        ? selectedIds.filter((id) => id !== unitId)
        : selectedIds.length >= SCENE_INSERTION_LIMITS.units.max
          ? selectedIds
          : [...selectedIds, unitId],
    );
  };

  const titlesOf = useCallback(
    (unitIds: readonly string[]) =>
      joinList(
        unitIds.map((id) => {
          const unit = data?.units.find((candidate) => candidate.id === id);
          return unit ? unitTitle(unit, t) : id;
        }),
        locale,
      ),
    [data, locale, t],
  );

  const buildRequest = (): SceneInsertionRequest | null => {
    if (!valid || !selectedOption || !teachingStage) return null;
    keyRef.current ??= newInsertionKey();
    return {
      unitIds: [...selectedIds],
      afterSceneId: selectedOption.afterSceneId,
      beforeSceneId: selectedOption.beforeSceneId,
      teachingStage,
      instruction: instruction.trim(),
      reason: reason.trim(),
      idempotencyKey: keyRef.current,
    };
  };

  const submit = async () => {
    setTouched({ units: true, instruction: true, reason: true });
    if (inFlight.current) return;
    const request = frozen ?? buildRequest();
    if (!request) return;
    inFlight.current = true;
    setRunning(true);
    onRunningChange?.(true);
    setFailure(null);
    try {
      const outcome = await run({ stageId, request, localGenerationRunning, gateRunning });
      switch (outcome.kind) {
        case 'success':
          toast.success(t('edit.slideInsertion.success', { unit: titlesOf(request.unitIds) }));
          onInserted?.(outcome);
          onOpenChange(false);
          break;
        case 'saved-not-shown':
          toast.info(t('edit.slideInsertion.savedNotShown'));
          onInserted?.(outcome);
          onOpenChange(false);
          break;
        case 'not-durable':
          setFailure(
            outcome.conflict
              ? t('edit.slideInsertion.notDurableConflict')
              : t('edit.slideInsertion.notDurable', {
                  items: describePendingKeys(outcome.pendingKeys, scenes, t, locale),
                }),
          );
          break;
        case 'busy':
          setFailure(t('edit.slideInsertion.busy'));
          break;
        case 'failed':
          // The server refused or failed: nothing changed. A new attempt is a
          // new request, so it gets a new key and editable fields.
          keyRef.current = newInsertionKey();
          setFrozen(null);
          setFailure(insertionFailureMessage(outcome.code, t));
          break;
        case 'unknown':
          // Keep the key and the exact body: the retry replays the outcome.
          setFrozen(request);
          setFailure(t('edit.slideInsertion.unknown'));
          break;
      }
    } catch (error) {
      // Whether it reached the server is unknown: treat it like `unknown`.
      setFrozen(request);
      setFailure(
        t('edit.slideInsertion.errors.generic', {
          code: error instanceof Error ? error.name : 'ERROR',
        }),
      );
    } finally {
      inFlight.current = false;
      setRunning(false);
      onRunningChange?.(false);
    }
  };

  const counter = (field: TextField, value: string) =>
    t('edit.slideInsertion.counter', {
      count: value.trim().length,
      max: SCENE_INSERTION_LIMITS[field].max,
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Modal while running: the Stage is locked until the run settles.
        if (running) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        dir={dir}
        showCloseButton={!running}
        data-testid="generate-slide-for-part-dialog"
        className="max-h-[90vh] max-w-xl overflow-y-auto"
        onEscapeKeyDown={(event) => {
          if (running) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (running) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (running) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('edit.slideInsertion.title')}</DialogTitle>
          <DialogDescription>{t('edit.slideInsertion.scope')}</DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {data === null && loadFailed ? (
            <p
              className="text-sm text-destructive"
              data-testid="insertion-load-failed"
              role="alert"
            >
              {t('edit.slideInsertion.panelLoadFailed')}
            </p>
          ) : data === null ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="insertion-loading"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t('edit.slideInsertion.loading')}
            </p>
          ) : (
            <>
              <fieldset className="grid gap-1.5" aria-describedby={`${unitsId}-help`}>
                <legend className="text-sm font-medium">
                  {t('edit.slideInsertion.unitsLabel')}
                </legend>
                <p id={`${unitsId}-help`} className="text-xs text-muted-foreground">
                  {t('edit.slideInsertion.unitsHelp')}
                </p>
                {eligible.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="insertion-units-none">
                    {t('edit.slideInsertion.unitsNone')}
                  </p>
                ) : (
                  <ul className="grid max-h-40 gap-1 overflow-y-auto">
                    {eligible.map((unit) => {
                      const checked = selectedIds.includes(unit.id);
                      return (
                        <li key={unit.id}>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              data-testid={`insertion-unit-${unit.id}`}
                              className="size-4 accent-violet-600"
                              checked={checked}
                              disabled={
                                locked ||
                                (!checked && selectedIds.length >= SCENE_INSERTION_LIMITS.units.max)
                              }
                              onChange={() => toggleUnit(unit.id)}
                            />
                            <span>{unitTitle(unit, t)}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <span className="text-xs text-destructive" role="alert">
                  {unitsErrorText()}
                </span>
              </fieldset>

              <div className="grid gap-1.5">
                <Label htmlFor={positionId}>{t('edit.slideInsertion.positionLabel')}</Label>
                {fixedPosition ? (
                  <p id={positionId} className="text-sm" data-testid="insertion-position-fixed">
                    {positionLabel(fixedPosition)}
                  </p>
                ) : (
                  <select
                    id={positionId}
                    data-testid="insertion-position"
                    className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                    value={effectivePositionKey ?? ''}
                    disabled={locked}
                    onChange={(event) => setChosenPositionKey(event.target.value)}
                  >
                    {positionOptions.map((option) => (
                      <option key={positionKey(option)} value={positionKey(option)}>
                        {positionLabel(option)}
                      </option>
                    ))}
                  </select>
                )}
                {positionUnknown ? (
                  <p
                    className="text-sm text-destructive"
                    role="alert"
                    data-testid="insertion-position-unknown"
                  >
                    {t('edit.slideInsertion.positionUnknown')}
                  </p>
                ) : null}
              </div>

              {selectedOption ? (
                <div className="grid gap-1.5">
                  <span id={stageLabelId} className="text-sm font-medium">
                    {t('edit.slideInsertion.stageLabel')}
                  </span>
                  {stageChoice.kind === 'none' ? (
                    <p
                      className="text-sm text-destructive"
                      role="alert"
                      data-testid="insertion-stage-none"
                    >
                      {t('edit.slideInsertion.stageNone')}
                    </p>
                  ) : stageChoice.kind === 'fixed' ? (
                    <p className="text-sm" data-testid="insertion-stage-fixed">
                      {stageLabel(stageChoice.stage)}
                    </p>
                  ) : (
                    <div
                      role="radiogroup"
                      aria-labelledby={stageLabelId}
                      className="grid gap-1"
                      data-testid="insertion-stage-choice"
                    >
                      <p className="text-xs text-muted-foreground">
                        {t('edit.slideInsertion.stageChoiceHelp')}
                      </p>
                      {stageChoice.options.map((option, index) => (
                        <label
                          key={`${option.key}:${option.flowIndex}`}
                          className="flex items-center gap-2 text-sm"
                        >
                          <input
                            type="radio"
                            name={`${stageLabelId}-stage`}
                            data-testid={`insertion-stage-${index}`}
                            className="size-4 accent-violet-600"
                            checked={index === stageIndex}
                            disabled={locked}
                            onChange={() => setStageSelection({ key: effectivePositionKey, index })}
                          />
                          <span>{stageLabel(option)}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor={instructionId}>{t('edit.slideInsertion.instructionLabel')}</Label>
            <p id={`${instructionId}-help`} className="text-xs text-muted-foreground">
              {t('edit.slideInsertion.instructionHelp')}
            </p>
            <Textarea
              id={instructionId}
              name="instruction"
              data-testid="insertion-instruction"
              value={instruction}
              disabled={locked}
              rows={3}
              placeholder={t('edit.slideInsertion.instructionPlaceholder')}
              aria-describedby={`${instructionId}-help ${instructionId}-error`}
              aria-invalid={Boolean(textErrorText('instruction'))}
              onChange={(event) => setInstruction(event.target.value)}
              onBlur={() => setTouched((current) => ({ ...current, instruction: true }))}
            />
            <div className="flex justify-between gap-2 text-xs">
              <span id={`${instructionId}-error`} className="text-destructive" role="alert">
                {textErrorText('instruction')}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {counter('instruction', instruction)}
              </span>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>{t('edit.slideInsertion.reasonLabel')}</Label>
            <p id={`${reasonId}-help`} className="text-xs text-muted-foreground">
              {t('edit.slideInsertion.reasonHelp')}
            </p>
            <Textarea
              id={reasonId}
              name="reason"
              data-testid="insertion-reason"
              value={reason}
              disabled={locked}
              rows={2}
              placeholder={t('edit.slideInsertion.reasonPlaceholder')}
              aria-describedby={`${reasonId}-help ${reasonId}-error`}
              aria-invalid={Boolean(textErrorText('reason'))}
              onChange={(event) => setReason(event.target.value)}
              onBlur={() => setTouched((current) => ({ ...current, reason: true }))}
            />
            <div className="flex justify-between gap-2 text-xs">
              <span id={`${reasonId}-error`} className="text-destructive" role="alert">
                {textErrorText('reason')}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {counter('reason', reason)}
              </span>
            </div>
          </div>

          {running ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="insertion-running"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t('edit.slideInsertion.running')}
            </p>
          ) : null}
          {failure ? (
            <p className="text-sm text-destructive" role="alert" data-testid="insertion-failure">
              {failure}
            </p>
          ) : null}
          {frozen && !running ? (
            <p className="text-xs text-muted-foreground" data-testid="insertion-frozen">
              {t('edit.slideInsertion.frozenNote')}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={running}
              onClick={() => onOpenChange(false)}
            >
              {t('edit.slideInsertion.cancel')}
            </Button>
            <Button type="submit" disabled={running || !valid} data-testid="insertion-submit">
              {frozen ? t('edit.slideInsertion.retry') : t('edit.slideInsertion.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
