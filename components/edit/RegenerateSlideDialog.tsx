'use client';

/**
 * "Regenerate slide" dialog (single-slide-regeneration-plan §12.2).
 *
 * Two required, separate fields: the requirements for the AI (sent to the
 * model as the edit directive) and the reason (an audit record that never
 * reaches the model). While the regeneration runs the dialog is modal and
 * cannot be dismissed, so the slide cannot be edited underneath it; values
 * are kept on any failure so the reviewer can retry or adjust.
 */
import { useCallback, useId, useRef, useState } from 'react';
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
  newRegenerationKey,
  REGENERATION_LIMITS,
  restoreSlideRegeneration,
  runSlideRegeneration,
  type RegenerationOutcome,
} from '@/lib/edit/scene-regeneration-client';

type Field = 'instruction' | 'reason';

interface RegenerateSlideDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly stageId: string;
  readonly sceneId: string;
  readonly sceneTitle: string;
  /** The scene's type (3 Oct 2026: quizzes are regenerable too) — picks the wording. */
  readonly sceneType?: 'slide' | 'quiz';
  /** Test seam. */
  readonly run?: typeof runSlideRegeneration;
}

const KNOWN_ERROR_CODES = new Set([
  'STAGE_LOCKED',
  'SCENE_REGENERATION_IN_PROGRESS',
  'SCENE_CHANGED_DURING_REGENERATION',
  'SOURCE_VISUAL_UNRESOLVED',
  'ORIENTATION_VISUAL_MISSING',
  'SPEECH_REGISTER_NONCOMPLIANT',
  'TEACHING_MODEL_UNAVAILABLE',
  'SUBJECT_ROUTE_UNAVAILABLE',
  'READ_ONLY_GRANT',
]);

export function fieldError(
  field: Field,
  value: string,
): { rule: 'required' | 'min' | 'max'; limit?: number } | null {
  const trimmed = value.trim();
  const { min, max } = REGENERATION_LIMITS[field];
  if (trimmed === '') return { rule: 'required' };
  if (trimmed.length < min) return { rule: 'min', limit: min };
  if (trimmed.length > max) return { rule: 'max', limit: max };
  return null;
}

export function RegenerateSlideDialog({
  open,
  onOpenChange,
  stageId,
  sceneId,
  sceneTitle,
  sceneType = 'slide',
  run = runSlideRegeneration,
}: RegenerateSlideDialogProps) {
  const { t, locale } = useI18n();
  // Quiz wording where it differs; every other key falls back to the slide text.
  const tr = useCallback(
    (key: string, options?: Record<string, unknown>) =>
      sceneType === 'quiz'
        ? t(`edit.quizRegeneration.${key}`, {
            ...options,
            defaultValue: t(`edit.slideRegeneration.${key}`, options),
          })
        : t(`edit.slideRegeneration.${key}`, options),
    [t, sceneType],
  );
  const dir = locale.startsWith('ar') ? 'rtl' : 'ltr';
  const instructionId = useId();
  const reasonId = useId();
  const [instruction, setInstruction] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState<Record<Field, boolean>>({
    instruction: false,
    reason: false,
  });
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);

  const errors = {
    instruction: fieldError('instruction', instruction),
    reason: fieldError('reason', reason),
  };
  const valid = errors.instruction === null && errors.reason === null;

  const errorText = (field: Field) => {
    const error = errors[field];
    if (!error || !touched[field]) return null;
    if (error.rule === 'required') return tr('errorRequired');
    return t(
      error.rule === 'min' ? 'edit.slideRegeneration.errorMin' : 'edit.slideRegeneration.errorMax',
      { limit: error.limit },
    );
  };

  const failureMessage = useCallback(
    (outcome: Extract<RegenerationOutcome, { kind: 'failed' }>) =>
      KNOWN_ERROR_CODES.has(outcome.code)
        ? t(`edit.slideRegeneration.errors.${outcome.code}`)
        : tr('errors.generic', { code: outcome.code }),
    [t, tr],
  );

  const submit = async () => {
    setTouched({ instruction: true, reason: true });
    if (!valid || inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setFailure(null);
    try {
      // A new key for every user submission; transport retries reuse it.
      const outcome = await run({
        stageId,
        sceneId,
        instruction: instruction.trim(),
        reason: reason.trim(),
        idempotencyKey: newRegenerationKey(),
      });
      switch (outcome.kind) {
        case 'success': {
          const regenerationId = outcome.regenerationId;
          toast.success(tr('success'), {
            action: {
              label: tr('restoreAction'),
              onClick: () => {
                void restoreSlideRegeneration(stageId, regenerationId).then((restored) => {
                  if (restored.ok) toast.success(tr('restored'));
                  else toast.error(tr('restoreFailed', { code: restored.code }));
                });
              },
            },
          });
          onOpenChange(false);
          setInstruction('');
          setReason('');
          setTouched({ instruction: false, reason: false });
          break;
        }
        case 'changed-since':
          toast(tr('changedSince'));
          onOpenChange(false);
          break;
        case 'stale':
          onOpenChange(false);
          break;
        case 'not-durable':
          setFailure(tr('notDurable'));
          break;
        case 'failed':
          setFailure(failureMessage(outcome));
          break;
      }
    } catch (error) {
      setFailure(
        tr('errors.generic', {
          code: error instanceof Error ? error.name : 'ERROR',
        }),
      );
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  };

  const counter = (field: Field, value: string) =>
    tr('counter', {
      count: value.trim().length,
      max: REGENERATION_LIMITS[field].max,
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Modal while running: the slide is locked until the run settles.
        if (running) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        dir={dir}
        showCloseButton={!running}
        data-testid="regenerate-slide-dialog"
        className="max-w-xl"
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
          <DialogTitle>{tr('title')}</DialogTitle>
          <DialogDescription>
            <span className="block font-medium text-foreground">{sceneTitle}</span>
            <span className="block">{tr('scope')}</span>
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={instructionId}>{tr('instructionLabel')}</Label>
            <p id={`${instructionId}-help`} className="text-xs text-muted-foreground">
              {tr('instructionHelp')}
            </p>
            <Textarea
              id={instructionId}
              name="instruction"
              data-testid="regenerate-instruction"
              value={instruction}
              disabled={running}
              rows={4}
              placeholder={tr('instructionPlaceholder')}
              aria-describedby={`${instructionId}-help ${instructionId}-error`}
              aria-invalid={Boolean(errorText('instruction'))}
              onChange={(event) => setInstruction(event.target.value)}
              onBlur={() => setTouched((current) => ({ ...current, instruction: true }))}
            />
            <div className="flex justify-between gap-2 text-xs">
              <span id={`${instructionId}-error`} className="text-destructive" role="alert">
                {errorText('instruction')}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {counter('instruction', instruction)}
              </span>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>{tr('reasonLabel')}</Label>
            <p id={`${reasonId}-help`} className="text-xs text-muted-foreground">
              {tr('reasonHelp')}
            </p>
            <Textarea
              id={reasonId}
              name="reason"
              data-testid="regenerate-reason"
              value={reason}
              disabled={running}
              rows={2}
              placeholder={tr('reasonPlaceholder')}
              aria-describedby={`${reasonId}-help ${reasonId}-error`}
              aria-invalid={Boolean(errorText('reason'))}
              onChange={(event) => setReason(event.target.value)}
              onBlur={() => setTouched((current) => ({ ...current, reason: true }))}
            />
            <div className="flex justify-between gap-2 text-xs">
              <span id={`${reasonId}-error`} className="text-destructive" role="alert">
                {errorText('reason')}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {counter('reason', reason)}
              </span>
            </div>
          </div>

          {running ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="regenerate-running"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {tr('running')}
            </p>
          ) : null}
          {failure ? (
            <p className="text-sm text-destructive" role="alert" data-testid="regenerate-failure">
              {failure}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={running}
              onClick={() => onOpenChange(false)}
            >
              {tr('cancel')}
            </Button>
            <Button type="submit" disabled={running || !valid} data-testid="regenerate-submit">
              {tr('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
