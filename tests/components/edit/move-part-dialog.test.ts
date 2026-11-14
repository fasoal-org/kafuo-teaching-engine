// @vitest-environment jsdom

/**
 * "Move a lesson part to another slide" (owner, 14 Nov 2026): two ordinary
 * slide regenerations, the TARGET first (add) then the SOURCE (remove); a
 * failed target moves nothing, a failed source can be retried alone, and a
 * slide's only part cannot be moved off it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '../../../lib/i18n/locales/en-US.json'), 'utf8'),
) as Record<string, unknown>;

function translate(key: string, options?: Record<string, unknown>): string {
  let value: unknown = EN;
  for (const part of key.split('.')) value = (value as Record<string, unknown> | undefined)?.[part];
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));
}

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: translate, locale: 'en-US', setLocale: () => {} }),
}));

import { MovePartDialog, partsOnSlide } from '@/components/edit/MovePartDialog';
import type { ContentUnitSummary, ContentUnitsResponse } from '@/lib/edit/scene-insertion-client';
import type { RegenerationOutcome } from '@/lib/edit/scene-regeneration-client';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function unit(id: string, order: number, slides: string[]): ContentUnitSummary {
  return {
    id,
    order,
    title: `Part ${id}`,
    role: 'CONCEPT_EXPLANATION',
    instructional: true,
    textLength: 100,
    coveredBySlideIds: slides,
    citedByOtherSceneIds: [],
    covered: slides.length > 0,
    suggestedPosition: null,
  };
}

const MOVED = unit('cu-1', 1, ['s1']);
const DATA: ContentUnitsResponse = {
  lineageStatus: 'own_attempt',
  units: [MOVED, unit('cu-2', 2, ['s1']), unit('cu-3', 3, ['s2'])],
  positions: [],
  stages: [],
};
const SLIDES = [
  { id: 's1', title: 'One', type: 'slide' },
  { id: 's2', title: 'Two', type: 'slide' },
  { id: 'q1', title: 'Quiz', type: 'quiz' },
  // A recap slide does not count as teaching: a part moved there would be untaught.
  { id: 'r1', title: 'Recap', type: 'slide', contentRole: 'summary' },
];

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function render(
  props: Partial<Parameters<typeof MovePartDialog>[0]> & {
    run: Parameters<typeof MovePartDialog>[0]['run'];
  },
) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(MovePartDialog, {
        open: true,
        onOpenChange: () => {},
        stageId: 'stage-1',
        unit: MOVED,
        data: DATA,
        slides: SLIDES,
        busy: false,
        ...props,
      }),
    ),
  );
}

const byTestId = <T extends HTMLElement>(id: string) =>
  document.body.querySelector<T>(`[data-testid="${id}"]`);

function setValue(element: HTMLSelectElement | HTMLTextAreaElement, value: string, event: string) {
  const proto = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  act(() => {
    element.dispatchEvent(new Event(event, { bubbles: true }));
  });
}

function fillAndStart() {
  setValue(byTestId<HTMLSelectElement>('move-part-to')!, 's2', 'change');
  setValue(
    byTestId<HTMLTextAreaElement>('move-part-reason')!,
    'teach it with its example',
    'input',
  );
}

const success: RegenerationOutcome = { kind: 'success', regenerationId: 'r' };
const failed = (code: string): RegenerationOutcome => ({
  kind: 'failed',
  status: 409,
  code,
  message: code,
});

describe('MovePartDialog', () => {
  it('offers only other slides, never a quiz or the source, and pre-fills the requirements', () => {
    render({ run: vi.fn() });
    const options = [...byTestId<HTMLSelectElement>('move-part-to')!.options].map((o) => o.value);
    expect(options).toEqual(['', 's2']);
    setValue(byTestId<HTMLSelectElement>('move-part-to')!, 's2', 'change');
    expect(byTestId<HTMLTextAreaElement>('move-part-instruction')!.value).toBe(
      'Move the teaching of the part "Part cu-1" from slide 1 to slide 2.',
    );
  });

  it('rewrites the target first (add), then the source (remove)', async () => {
    const run = vi.fn().mockResolvedValue(success);
    render({ run });
    fillAndStart();
    await act(async () => byTestId<HTMLButtonElement>('move-part-start')!.click());
    expect(run.mock.calls.map(([input]) => [input.sceneId, input.contentUnitChange])).toEqual([
      ['s2', { op: 'add', unitId: 'cu-1' }],
      ['s1', { op: 'remove', unitId: 'cu-1' }],
    ]);
    expect(byTestId('move-part-status')!.dataset.phase).toBe('done');
    // Each step is its own paid run with its own key.
    expect(run.mock.calls[0]![0].idempotencyKey).not.toBe(run.mock.calls[1]![0].idempotencyKey);
  });

  it('a failed target moves nothing: the source is never touched', async () => {
    const run = vi.fn().mockResolvedValue(failed('SCENE_CONTENT_GENERATION_FAILED'));
    render({ run });
    fillAndStart();
    await act(async () => byTestId<HTMLButtonElement>('move-part-start')!.click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(byTestId('move-part-status')!.dataset.phase).toBe('targetFailed');
  });

  it('a failed source says both slides teach it, and retries the source alone', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce(failed('STAGE_LOCKED'))
      .mockResolvedValueOnce(success);
    render({ run });
    fillAndStart();
    await act(async () => byTestId<HTMLButtonElement>('move-part-start')!.click());
    expect(byTestId('move-part-status')!.dataset.phase).toBe('sourceFailed');
    await act(async () => byTestId<HTMLButtonElement>('move-part-retry')!.click());
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2]![0]).toMatchObject({
      sceneId: 's1',
      contentUnitChange: { op: 'remove', unitId: 'cu-1' },
    });
    expect(byTestId('move-part-status')!.dataset.phase).toBe('done');
  });

  it('says a server refusal in words, e.g. a part that would be left untaught', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({
        kind: 'failed',
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'contentUnitChange is malformed',
        details: { field: 'contentUnitChange', rule: 'wouldBeUntaught' },
      } satisfies RegenerationOutcome);
    render({ run });
    fillAndStart();
    await act(async () => byTestId<HTMLButtonElement>('move-part-start')!.click());
    const status = byTestId('move-part-status')!;
    expect(status.dataset.phase).toBe('sourceFailed');
    expect(status.textContent).toContain('no other teaching slide teaches this part');
    expect(status.textContent).not.toContain('INVALID_REQUEST');
  });

  it("refuses to move a slide's only part off it", () => {
    const lonely = unit('cu-3', 3, ['s2']);
    render({ run: vi.fn(), unit: lonely });
    expect(partsOnSlide(DATA, 's2')).toBe(1);
    expect(byTestId('move-part-only-part')).not.toBeNull();
    expect(byTestId<HTMLButtonElement>('move-part-start')!.disabled).toBe(true);
  });
});
