'use client';

/**
 * "Lesson parts" panel (reviewer-generated-slide-for-lesson-part-plan §5
 * step 1, D-1/D-2): every retained lesson part (Content Unit) in manifest
 * order, badged by coverage, with "Generate slide" on each uncovered
 * instructional part. It says WHAT is missing; the "+" zones say WHERE.
 *
 * The entry is a full-width button at the top of the slide rail's list: the
 * panel acts on the whole lesson and inserts into the rail, and the top of the
 * list is the one place the rail always shows (its header band is hidden in
 * the workbench). The list opens in a dialog; "Generate slide" closes it
 * before the insertion dialog opens, so modals never nest. The rail decides
 * whether the entry exists at all (write grant, editable version, supported
 * or `no_content_units` gate).
 */
import { useState } from 'react';
import { ListTree } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { ContentUnitSummary, ContentUnitsResponse } from '@/lib/edit/scene-insertion-client';

/** `units`: the gate allows insertion; `no-parts`: it refused for `no_content_units`. */
export type LessonPartsMode = 'units' | 'no-parts';

export type UnitBadge = 'covered' | 'quiz-only' | 'no-slide' | 'reference';

/** Plan §8.2: covered = a live slide cites it; "quiz only" = cited only by other scenes. */
export function unitBadge(unit: ContentUnitSummary): UnitBadge {
  if (!unit.instructional) return 'reference';
  if (unit.covered) return 'covered';
  if (unit.citedByOtherSceneIds.length > 0) return 'quiz-only';
  return 'no-slide';
}

/** A slide can be generated for it: instructional, with retained text, no live slide. */
export function canGenerateForUnit(unit: ContentUnitSummary): boolean {
  return unit.instructional && !unit.covered && unit.textLength > 0;
}

/** No usable lesson parts (plan §5 step 1): the version predates stored units. */
export function hasNoLessonParts(data: ContentUnitsResponse): boolean {
  return data.lineageStatus === 'unavailable' || data.units.length === 0;
}

interface LessonPartsListProps {
  readonly mode: LessonPartsMode;
  readonly data: ContentUnitsResponse | null;
  readonly loadFailed: boolean;
  /** Another generation runs in this tab (plan §11.7): "Generate slide" is disabled. */
  readonly busy: boolean;
  readonly onGenerate: (unitId: string) => void;
}

/** The panel's body (also rendered directly by tests). */
export function LessonPartsList({
  mode,
  data,
  loadFailed,
  busy,
  onGenerate,
}: LessonPartsListProps) {
  const { t } = useI18n();
  if (mode === 'no-parts' || (data !== null && hasNoLessonParts(data))) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="lesson-parts-none">
        {t('edit.slideInsertion.panelNoParts')}
      </p>
    );
  }
  if (data === null) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="lesson-parts-status" role="status">
        {loadFailed ? t('edit.slideInsertion.panelLoadFailed') : t('edit.slideInsertion.loading')}
      </p>
    );
  }
  const units = [...data.units].sort((a, b) => a.order - b.order);
  return (
    <ol className="grid gap-1.5" data-testid="lesson-parts-list">
      {units.map((unit) => {
        const badge = unitBadge(unit);
        return (
          <li
            key={unit.id}
            data-testid="lesson-part"
            data-unit-id={unit.id}
            data-badge={badge}
            className={cn(
              'flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm',
              badge === 'reference' && 'border-dashed text-muted-foreground opacity-70',
            )}
          >
            <span className="min-w-0 flex-1 truncate">
              {unit.title?.trim() || t('edit.slideInsertion.untitledPart', { order: unit.order })}
            </span>
            <UnitBadgeLabel unit={unit} badge={badge} />
            {canGenerateForUnit(unit) ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                title={busy ? t('edit.slideInsertion.busyHint') : undefined}
                data-testid="lesson-part-generate"
                onClick={() => onGenerate(unit.id)}
              >
                {t('edit.slideInsertion.generateAction')}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function UnitBadgeLabel({
  unit,
  badge,
}: {
  readonly unit: ContentUnitSummary;
  readonly badge: UnitBadge;
}) {
  const { t } = useI18n();
  switch (badge) {
    case 'covered':
      return (
        <Badge variant="secondary">
          {t('edit.slideInsertion.badgeCovered', { count: unit.coveredBySlideIds.length })}
        </Badge>
      );
    case 'quiz-only':
      return <Badge variant="outline">{t('edit.slideInsertion.badgeQuizOnly')}</Badge>;
    case 'no-slide':
      return <Badge variant="destructive">{t('edit.slideInsertion.badgeNoSlide')}</Badge>;
    case 'reference':
      return <Badge variant="ghost">{t('edit.slideInsertion.badgeReference')}</Badge>;
  }
}

interface LessonPartsPanelProps extends LessonPartsListProps {
  /** The panel opened: the rail refreshes the gate and the parts. */
  readonly onOpen?: () => void;
}

export function LessonPartsPanel({ onOpen, onGenerate, ...listProps }: LessonPartsPanelProps) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const uncovered =
    listProps.mode === 'units' && listProps.data
      ? listProps.data.units.filter(canGenerateForUnit).length
      : 0;
  return (
    <>
      <button
        type="button"
        data-testid="lesson-parts-entry"
        onClick={() => {
          setOpen(true);
          onOpen?.();
        }}
        className={cn(
          'mb-2 flex w-full items-center gap-2 rounded-lg border border-dashed border-violet-200 px-2.5 py-1.5 text-left text-xs',
          'text-violet-700 transition-colors hover:bg-violet-50',
          'dark:border-violet-400/30 dark:text-violet-300 dark:hover:bg-violet-500/10',
        )}
      >
        <ListTree className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{t('edit.slideInsertion.panelEntry')}</span>
        {uncovered > 0 ? (
          <span className="shrink-0 tabular-nums text-[11px] text-violet-500">
            {t('edit.slideInsertion.panelEntryCount', { count: uncovered })}
          </span>
        ) : null}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          dir={locale.startsWith('ar') ? 'rtl' : 'ltr'}
          data-testid="lesson-parts-panel"
          className="max-h-[80vh] max-w-lg overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>{t('edit.slideInsertion.panelTitle')}</DialogTitle>
            <DialogDescription>{t('edit.slideInsertion.panelDescription')}</DialogDescription>
          </DialogHeader>
          <LessonPartsList
            {...listProps}
            onGenerate={(unitId) => {
              setOpen(false);
              onGenerate(unitId);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
