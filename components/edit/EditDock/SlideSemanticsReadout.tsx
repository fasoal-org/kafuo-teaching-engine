'use client';

/**
 * SlideSemanticsReadout — a READ-ONLY inspector of a slide's classification
 * (RSS-FR-115 "may display"; plan §7.11), where the content already lives: the
 * OpenMAIC edit dock, reached through the existing Admin handoff.
 *
 * It is an inspector, not an input: it shows the slide's structural type, its
 * pedagogical role and kind, and which on-demand assistance tiers exist. It
 * never edits them, never infers one from the slide's text, and is never part
 * of the rendered slide — learners do not see role / kind tokens anywhere. A
 * legacy slide reads "Unclassified"; nothing is guessed for it. It self-hides
 * on non-slide scenes.
 */
import { useState } from 'react';

import { useStageStore } from '@/lib/store/stage';
import { SLIDE_ASSISTANCE_TIERS } from '@/lib/types/stage';

export function SlideSemanticsReadout({ sceneId }: { sceneId: string }) {
  const [open, setOpen] = useState(false);
  const scene = useStageStore((state) => state.scenes.find((item) => item.id === sceneId));
  if (!scene || scene.type !== 'slide' || scene.content.type !== 'slide') return null;

  const { canvas, contentRole, contentKind, assistance } = scene.content;
  const tiers = SLIDE_ASSISTANCE_TIERS.filter((tier) => Boolean(assistance?.[tier]));
  const rows: Array<[string, string]> = [
    ['Slide type', canvas.type ?? '—'],
    ['Teaching role', contentRole ?? 'Unclassified'],
    ['Kind', contentKind ?? '—'],
    ['On-demand assistance', tiers.length > 0 ? tiers.join(' · ') : 'None'],
  ];

  return (
    <div className="pointer-events-none absolute bottom-full left-3 z-20 mb-1 flex flex-col items-start">
      <button
        type="button"
        data-testid="slide-semantics-toggle"
        onClick={() => setOpen((current) => !current)}
        className="pointer-events-auto mb-1 rounded-full border border-zinc-200 bg-white/90 px-3 py-1 text-xs text-zinc-600 shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-slate-900/90 dark:text-zinc-300"
      >
        Slide semantics
      </button>
      {open ? (
        <section
          data-testid="slide-semantics-readout"
          className="pointer-events-auto w-72 rounded-xl border border-zinc-200 bg-white/95 p-3 text-xs shadow-xl backdrop-blur dark:border-zinc-700 dark:bg-slate-900/95 dark:text-zinc-200"
        >
          <p className="mb-2 text-[11px] text-zinc-500">
            Read-only. Authoring metadata — never shown to learners.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-zinc-500">{label}</dt>
                <dd className="font-medium">{value.replace(/_/g, ' ')}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}
