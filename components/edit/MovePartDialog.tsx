'use client';

/**
 * "Move a lesson part to another slide" (owner, 14 Nov 2026).
 *
 * The teacher picks the slide the part leaves (when more than one teaches it),
 * the slide it goes to, the requirements for the AI (pre-filled) and a reason.
 * The move is two ordinary single-slide regenerations with a
 * `contentUnitChange`, run one after the other:
 *
 * 1. the TARGET slide first (`add`), so the part is always taught somewhere —
 *    if this fails nothing moved;
 * 2. then the SOURCE slide (`remove`) — if this fails the part is taught on
 *    both slides, which Submit accepts, and the step can be retried.
 *
 * Each step is paid. Modal while running, like the regenerate dialog.
 */
import { useId, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

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
import type { ContentUnitSummary, ContentUnitsResponse } from '@/lib/edit/scene-insertion-client';
import {
  newRegenerationKey,
  REGENERATION_LIMITS,
  runSlideRegeneration,
  type RegenerationOutcome,
} from '@/lib/edit/scene-regeneration-client';

export interface MovePartSlide {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  /** The slide's `contentRole`, when it has one (orientation, summary, …). */
  readonly contentRole?: string | null;
}

/**
 * Slide roles that do not count as teaching a part — the server's
 * `NON_TEACHING_SLIDE_ROLES` (`lib/server/teaching-package/outline-grounding.ts`),
 * copied because that module is server-only; a test pins the two equal.
 */
export const NON_TEACHING_SLIDE_ROLES_CLIENT: ReadonlySet<string> = new Set([
  'orientation',
  'summary',
  'check_understanding',
  'practice',
]);

/** A slide a moved part can go to: a slide whose role teaches (as `isTeachingSlide`). */
export function isTeachingTarget(slide: MovePartSlide): boolean {
  return (
    slide.type === 'slide' &&
    !(slide.contentRole && NON_TEACHING_SLIDE_ROLES_CLIENT.has(slide.contentRole))
  );
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; step: 'target' | 'source' }
  | { kind: 'done' }
  | { kind: 'targetFailed'; code: string }
  | { kind: 'sourceFailed'; code: string };

interface MovePartDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly stageId: string;
  readonly unit: ContentUnitSummary;
  readonly data: ContentUnitsResponse | null;
  /** Every Scene of the Stage, in rail order. */
  readonly slides: readonly MovePartSlide[];
  /** Another generation runs in this tab: the move cannot start. */
  readonly busy: boolean;
  /** Reported so the rail can hold its other generations and refresh after. */
  readonly onRunningChange?: (running: boolean) => void;
  /** Test seam. */
  readonly run?: typeof runSlideRegeneration;
}

/** How many lesson parts a slide cites (taught or not): removing the last one is refused. */
export function partsOnSlide(data: ContentUnitsResponse | null, sceneId: string): number {
  if (!data) return 0;
  return data.units.filter(
    (unit) =>
      unit.coveredBySlideIds.includes(sceneId) || unit.citedByOtherSceneIds.includes(sceneId),
  ).length;
}

/** The server's refusal rule for a move (`INVALID_REQUEST` details), or the error code. */
function failureCode(outcome: RegenerationOutcome): string | null {
  if (outcome.kind === 'success' || outcome.kind === 'changed-since') return null;
  if (outcome.kind === 'failed') {
    const rule = (outcome.details as { field?: string; rule?: string } | undefined) ?? {};
    return rule.field === 'contentUnitChange' && rule.rule ? `rule:${rule.rule}` : outcome.code;
  }
  return outcome.kind === 'not-durable' ? 'NOT_DURABLE' : 'STALE';
}

/** A move refusal the teacher can act on, said in words; any other failure shows its code. */
const RULE_MESSAGES = new Set([
  'wouldBeUntaught',
  'notTeachingSlide',
  'lastPart',
  'alreadyTaught',
  'notTaught',
]);

export function MovePartDialog({
  open,
  onOpenChange,
  stageId,
  unit,
  data,
  slides,
  busy,
  onRunningChange,
  run = runSlideRegeneration,
}: MovePartDialogProps) {
  const { t, locale } = useI18n();
  const tr = (key: string, options?: Record<string, unknown>) =>
    t(`edit.slideInsertion.move.${key}`, options);
  const ids = { from: useId(), to: useId(), instruction: useId(), reason: useId() };

  const numberOf = useMemo(() => {
    const map = new Map<string, number>();
    slides.forEach((slide, index) => map.set(slide.id, index + 1));
    return map;
  }, [slides]);
  const sources = unit.coveredBySlideIds.filter((id) => numberOf.has(id));
  const [fromId, setFromId] = useState<string>(sources[0] ?? '');
  // Only a slide that teaches (never an orientation, summary, check or practice slide,
  // which would leave the part untaught), never the source or a slide already teaching it.
  const targets = slides.filter(
    (slide) =>
      isTeachingTarget(slide) && slide.id !== fromId && !unit.coveredBySlideIds.includes(slide.id),
  );
  const [toId, setToId] = useState<string>('');
  const partName =
    unit.title?.trim() || t('edit.slideInsertion.untitledPart', { order: unit.order });
  const fromNumber = numberOf.get(fromId) ?? 0;
  const toNumber = numberOf.get(toId) ?? 0;
  const defaultInstruction = toId
    ? tr('instructionDefault', { part: partName, from: fromNumber, to: toNumber })
    : '';
  const [instruction, setInstruction] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const effectiveInstruction = (instruction ?? defaultInstruction).trim();
  const onlyPart = fromId !== '' && partsOnSlide(data, fromId) <= 1;
  const running = phase.kind === 'running';
  const fieldOk = (value: string, field: 'instruction' | 'reason') =>
    value.trim().length >= REGENERATION_LIMITS[field].min &&
    value.trim().length <= REGENERATION_LIMITS[field].max;
  const canStart =
    !busy &&
    !running &&
    phase.kind !== 'done' &&
    fromId !== '' &&
    toId !== '' &&
    !onlyPart &&
    fieldOk(effectiveInstruction, 'instruction') &&
    fieldOk(reason, 'reason');

  const step = async (sceneId: string, op: 'add' | 'remove') =>
    run({
      stageId,
      sceneId,
      instruction: effectiveInstruction,
      reason: reason.trim(),
      idempotencyKey: newRegenerationKey(),
      contentUnitChange: { op, unitId: unit.id },
    });

  const runSource = async () => {
    setPhase({ kind: 'running', step: 'source' });
    const removed = await step(fromId, 'remove');
    const code = failureCode(removed);
    setPhase(code ? { kind: 'sourceFailed', code } : { kind: 'done' });
  };

  const start = async () => {
    if (!canStart) return;
    onRunningChange?.(true);
    try {
      setPhase({ kind: 'running', step: 'target' });
      const added = await step(toId, 'add');
      const code = failureCode(added);
      if (code) {
        setPhase({ kind: 'targetFailed', code });
        return;
      }
      await runSource();
    } finally {
      onRunningChange?.(false);
    }
  };

  const retrySource = async () => {
    onRunningChange?.(true);
    try {
      await runSource();
    } finally {
      onRunningChange?.(false);
    }
  };

  const locked = running || phase.kind === 'done' || phase.kind === 'sourceFailed';
  // `w-full min-w-0`: a long slide title must not widen the select past its column.
  const selectClass =
    'h-9 w-full min-w-0 truncate rounded-md border border-input bg-transparent px-2 text-sm';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        dir={locale.startsWith('ar') ? 'rtl' : 'ltr'}
        showCloseButton={!running}
        data-testid="move-part-dialog"
        className="sm:max-w-2xl"
        onEscapeKeyDown={(event) => {
          if (running) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (running) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{tr('title')}</DialogTitle>
          <DialogDescription>{tr('description')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">{tr('part')}</span>
            <span className="font-medium" data-testid="move-part-name">
              {partName}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor={ids.from}>{tr('from')}</Label>
              {sources.length > 1 ? (
                <select
                  id={ids.from}
                  data-testid="move-part-from"
                  className={selectClass}
                  value={fromId}
                  disabled={locked}
                  onChange={(event) => {
                    setFromId(event.target.value);
                    setToId('');
                  }}
                >
                  {sources.map((id) => (
                    <option key={id} value={id}>
                      {numberOf.get(id)} — {slides.find((slide) => slide.id === id)?.title}
                    </option>
                  ))}
                </select>
              ) : (
                <p id={ids.from} className="text-sm" data-testid="move-part-from-fixed">
                  {fromNumber} — {slides.find((slide) => slide.id === fromId)?.title}
                </p>
              )}
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor={ids.to}>{tr('to')}</Label>
              {targets.length > 0 ? (
                <select
                  id={ids.to}
                  data-testid="move-part-to"
                  className={selectClass}
                  value={toId}
                  disabled={locked}
                  onChange={(event) => {
                    setToId(event.target.value);
                    setInstruction(null);
                  }}
                >
                  <option value="">{tr('toPlaceholder')}</option>
                  {targets.map((slide) => (
                    <option key={slide.id} value={slide.id}>
                      {numberOf.get(slide.id)} — {slide.title}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-muted-foreground">{tr('noTarget')}</p>
              )}
            </div>
          </div>

          {onlyPart ? (
            <p className="text-sm text-red-700 dark:text-red-300" data-testid="move-part-only-part">
              {tr('onlyPart', { from: fromNumber })}
            </p>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor={ids.instruction}>{tr('instruction')}</Label>
            <Textarea
              id={ids.instruction}
              data-testid="move-part-instruction"
              rows={3}
              maxLength={REGENERATION_LIMITS.instruction.max}
              value={instruction ?? defaultInstruction}
              disabled={locked || toId === ''}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.reason}>{tr('reason')}</Label>
            <Textarea
              id={ids.reason}
              data-testid="move-part-reason"
              rows={2}
              maxLength={REGENERATION_LIMITS.reason.max}
              value={reason}
              disabled={locked}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          <MovePartStatus phase={phase} tr={tr} from={fromNumber} to={toNumber} />
        </div>

        <DialogFooter>
          {phase.kind === 'sourceFailed' ? (
            <Button type="button" data-testid="move-part-retry" onClick={() => void retrySource()}>
              {tr('retrySource', { from: fromNumber })}
            </Button>
          ) : phase.kind === 'done' ? (
            <Button type="button" onClick={() => onOpenChange(false)}>
              {tr('close')}
            </Button>
          ) : (
            <Button
              type="button"
              data-testid="move-part-start"
              disabled={!canStart}
              onClick={() => void start()}
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {tr('start')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovePartStatus({
  phase,
  tr,
  from,
  to,
}: {
  readonly phase: Phase;
  readonly tr: (key: string, options?: Record<string, unknown>) => string;
  readonly from: number;
  readonly to: number;
}) {
  if (phase.kind === 'idle') return null;
  // A refusal rule the teacher can act on reads as words; anything else as its code.
  const said = (code: string) => {
    const rule = code.startsWith('rule:') ? code.slice('rule:'.length) : null;
    return rule && RULE_MESSAGES.has(rule) ? tr(`rule.${rule}`) : (rule ?? code);
  };
  const text =
    phase.kind === 'running'
      ? tr(phase.step === 'target' ? 'stepTarget' : 'stepSource', {
          n: phase.step === 'target' ? to : from,
        })
      : phase.kind === 'done'
        ? tr('done', { from, to })
        : phase.kind === 'targetFailed'
          ? tr('targetFailed', { to, code: said(phase.code) })
          : tr('sourceFailed', { from, to, code: said(phase.code) });
  const tone =
    phase.kind === 'done'
      ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
      : phase.kind === 'running'
        ? 'bg-brand-soft text-brand-soft-foreground'
        : 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300';
  return (
    <p
      role="status"
      data-testid="move-part-status"
      data-phase={phase.kind}
      className={`rounded-lg px-3 py-2 text-sm ${tone}`}
    >
      {text}
    </p>
  );
}
