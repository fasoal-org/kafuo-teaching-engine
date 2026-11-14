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
import { ChevronDown, ListTree } from 'lucide-react';

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
  /** The 1-based position of a live slide in the rail, for an opened part's slide list. */
  readonly slideNumber?: (sceneId: string) => number | null;
}

/** The panel's body (also rendered directly by tests). */
export function LessonPartsList({
  mode,
  data,
  loadFailed,
  busy,
  onGenerate,
  slideNumber,
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
    <div className="grid gap-3">
      <LessonPartsSummary units={units} />
      <ol className="grid gap-2" data-testid="lesson-parts-list">
        {units.map((unit) => (
          <LessonPartRow
            key={unit.id}
            unit={unit}
            busy={busy}
            onGenerate={onGenerate}
            slideNumber={slideNumber}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * One part as a card. Owner, 14 Nov 2026: the order and name at the start, the coverage
 * badge and the action at the end; pressing the card opens the part's full data (its
 * type, its text and the slides that teach it) and pressing again closes it.
 */
function LessonPartRow({
  unit,
  busy,
  onGenerate,
  slideNumber,
}: {
  readonly unit: ContentUnitSummary;
  readonly busy: boolean;
  readonly onGenerate: (unitId: string) => void;
  readonly slideNumber?: (sceneId: string) => number | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const badge = unitBadge(unit);
  const title = unit.title?.trim() || t('edit.slideInsertion.untitledPart', { order: unit.order });
  const detailsId = `lesson-part-details-${unit.id}`;
  return (
    <li
      data-testid="lesson-part"
      data-unit-id={unit.id}
      data-badge={badge}
      data-open={open}
      className={cn(
        'rounded-xl border border-zinc-200 bg-white text-sm shadow-xs transition-colors hover:border-violet-200',
        'dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/20',
        badge === 'no-slide' && 'border-red-200/80 dark:border-red-500/30',
        badge === 'reference' && 'border-dashed bg-transparent text-muted-foreground',
        badge === 'reference' && !open && 'opacity-70',
        open && 'border-violet-300 dark:border-white/25',
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          data-testid="lesson-part-toggle"
          aria-expanded={open}
          aria-controls={detailsId}
          title={t('edit.slideInsertion.partOpen')}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden="true"
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
              badge === 'reference'
                ? 'bg-muted text-muted-foreground'
                : 'bg-brand-soft text-brand-soft-foreground',
            )}
          >
            {unit.order}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              open && 'rotate-180',
            )}
          />
        </button>
        <UnitBadgeLabel unit={unit} badge={badge} />
        {canGenerateForUnit(unit) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            title={busy ? t('edit.slideInsertion.busyHint') : undefined}
            data-testid="lesson-part-generate"
            className="shrink-0 border-primary/40 text-primary hover:bg-primary hover:text-primary-foreground"
            onClick={() => onGenerate(unit.id)}
          >
            {t('edit.slideInsertion.generateAction')}
          </Button>
        ) : null}
      </div>
      {open ? <LessonPartDetails id={detailsId} unit={unit} slideNumber={slideNumber} /> : null}
    </li>
  );
}

/** The opened part: its type, size, the slides that teach it, then its full text. */
function LessonPartDetails({
  id,
  unit,
  slideNumber,
}: {
  readonly id: string;
  readonly unit: ContentUnitSummary;
  readonly slideNumber?: (sceneId: string) => number | null;
}) {
  const { t } = useI18n();
  const text = typeof unit.text === 'string' ? unit.text.trim() : '';
  const slides = unit.coveredBySlideIds
    .map((sceneId) => slideNumber?.(sceneId) ?? null)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  return (
    <div
      id={id}
      data-testid="lesson-part-details"
      className="grid gap-3 border-t border-zinc-100 px-4 pt-3 pb-4 dark:border-white/10"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-brand-soft px-2.5 py-0.5 font-medium text-brand-soft-foreground">
          {t(`edit.slideInsertion.partRole.${unit.role}`, { defaultValue: unit.role })}
        </span>
        {unit.textLength > 0 ? (
          <span className="text-muted-foreground tabular-nums">
            {t('edit.slideInsertion.partLength', { count: unit.textLength })}
          </span>
        ) : null}
        {slides.length > 0 ? (
          <span className="text-muted-foreground" data-testid="lesson-part-slides">
            {t('edit.slideInsertion.partSlides', { list: slides.join('، ') })}
          </span>
        ) : null}
      </div>
      {text ? (
        <div
          dir="auto"
          data-testid="lesson-part-text"
          className="max-h-80 overflow-y-auto rounded-lg bg-zinc-50 p-3 text-sm leading-7 whitespace-pre-wrap text-foreground [scrollbar-width:thin] dark:bg-white/[0.04] dark:[color-scheme:dark]"
        >
          {text}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="lesson-part-no-text">
          {t('edit.slideInsertion.partNoText')}
        </p>
      )}
    </div>
  );
}

/** One line of counts above the list: covered, without a slide, reference. */
function LessonPartsSummary({ units }: { readonly units: readonly ContentUnitSummary[] }) {
  const { t } = useI18n();
  const counts = { covered: 0, missing: 0, reference: 0 };
  for (const unit of units) {
    const badge = unitBadge(unit);
    if (badge === 'covered') counts.covered += 1;
    else if (badge === 'reference') counts.reference += 1;
    else if (canGenerateForUnit(unit)) counts.missing += 1;
  }
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="lesson-parts-summary">
      <span className={cn(SUMMARY_CHIP, 'bg-brand-soft text-brand-soft-foreground')}>
        {t('edit.slideInsertion.badgeCovered', { count: counts.covered })}
      </span>
      <span
        className={cn(SUMMARY_CHIP, 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300')}
      >
        {t('edit.slideInsertion.panelEntryCount', { count: counts.missing })}
      </span>
      {counts.reference > 0 ? (
        <span className={cn(SUMMARY_CHIP, 'bg-muted text-muted-foreground')}>
          {t('edit.slideInsertion.badgeReference')} · {counts.reference}
        </span>
      ) : null}
    </div>
  );
}

const SUMMARY_CHIP = 'rounded-full px-3 py-1 text-xs font-medium tabular-nums';

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
        <Badge className="shrink-0 border-transparent bg-brand-soft text-brand-soft-foreground">
          {t('edit.slideInsertion.badgeCovered', { count: unit.coveredBySlideIds.length })}
        </Badge>
      );
    case 'quiz-only':
      return (
        <Badge variant="outline" className="shrink-0">
          {t('edit.slideInsertion.badgeQuizOnly')}
        </Badge>
      );
    case 'no-slide':
      return (
        <Badge className="shrink-0 border-transparent bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300">
          {t('edit.slideInsertion.badgeNoSlide')}
        </Badge>
      );
    case 'reference':
      return (
        <Badge variant="ghost" className="shrink-0">
          {t('edit.slideInsertion.badgeReference')}
        </Badge>
      );
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
          'mb-2 flex w-full items-center gap-2 rounded-lg border border-dashed border-violet-200 px-2.5 py-1.5 text-start text-xs',
          'text-violet-700 transition-colors hover:bg-violet-50',
          'dark:border-violet-400/30 dark:text-violet-300 dark:hover:bg-violet-500/10',
        )}
      >
        <ListTree className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{t('edit.slideInsertion.panelEntry')}</span>
        {uncovered > 0 ? (
          <span className="shrink-0 rounded-full bg-brand-accent px-1.5 text-[11px] font-semibold tabular-nums text-brand-accent-foreground">
            {t('edit.slideInsertion.panelEntryCount', { count: uncovered })}
          </span>
        ) : null}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          dir={locale.startsWith('ar') ? 'rtl' : 'ltr'}
          data-testid="lesson-parts-panel"
          // Owner, 14 Nov 2026: wider, with the list scrolling under a fixed header.
          className="flex max-h-[85vh] flex-col gap-4 sm:max-w-3xl"
        >
          <DialogHeader>
            <DialogTitle>{t('edit.slideInsertion.panelTitle')}</DialogTitle>
            <DialogDescription>{t('edit.slideInsertion.panelDescription')}</DialogDescription>
          </DialogHeader>
          {/* Thin, theme-matched scrollbar (it sits on the left in Arabic). */}
          <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 pb-1 [scrollbar-width:thin] dark:[color-scheme:dark]">
            <LessonPartsList
              {...listProps}
              onGenerate={(unitId) => {
                setOpen(false);
                onGenerate(unitId);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
