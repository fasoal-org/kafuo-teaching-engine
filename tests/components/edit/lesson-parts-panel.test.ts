// @vitest-environment jsdom

/**
 * The "Lesson parts" panel (reviewer-generated-slide-for-lesson-part-plan §5
 * step 1, D-1): every unit in manifest order with its coverage badge, greyed
 * reference units, "Generate slide" only on uncovered instructional units,
 * the single "no lesson parts" line, and the entry's uncovered count.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

function loadLocale(code: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(__dirname, `../../../lib/i18n/locales/${code}.json`), 'utf8'),
  );
}
const EN = loadLocale('en-US');

function translate(key: string, options?: Record<string, unknown>): string {
  let value: unknown = EN;
  for (const part of key.split('.')) value = (value as Record<string, unknown> | undefined)?.[part];
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));
}

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: translate, locale: 'en-US', setLocale: () => {} }),
}));

import { LessonPartsList, LessonPartsPanel, unitBadge } from '@/components/edit/LessonPartsPanel';
import type { ContentUnitSummary, ContentUnitsResponse } from '@/lib/edit/scene-insertion-client';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function unit(
  id: string,
  order: number,
  overrides: Partial<ContentUnitSummary> = {},
): ContentUnitSummary {
  return {
    id,
    order,
    title: `Part ${id}`,
    role: 'EXPLANATION',
    instructional: true,
    textLength: 900,
    coveredBySlideIds: [],
    citedByOtherSceneIds: [],
    covered: false,
    suggestedPosition: null,
    ...overrides,
  };
}

const DATA: ContentUnitsResponse = {
  lineageStatus: 'own_attempt',
  // Deliberately out of order: the panel lists in manifest order.
  units: [
    unit('cu_3', 3, { citedByOtherSceneIds: ['quiz_1'] }),
    unit('cu_1', 1, { covered: true, coveredBySlideIds: ['s1', 's2'] }),
    unit('cu_4', 4, { instructional: false, role: 'REFERENCE' }),
    unit('cu_2', 2, { title: null }),
  ],
  positions: [],
  stages: [],
};

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(element));
}

const rows = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="lesson-part"]')];

describe('LessonPartsPanel', () => {
  it('badges every unit by coverage', () => {
    expect(unitBadge(unit('a', 1, { covered: true, coveredBySlideIds: ['s'] }))).toBe('covered');
    expect(unitBadge(unit('a', 1, { citedByOtherSceneIds: ['q'] }))).toBe('quiz-only');
    expect(unitBadge(unit('a', 1))).toBe('no-slide');
    expect(unitBadge(unit('a', 1, { instructional: false, covered: true }))).toBe('reference');
  });

  it('lists units in manifest order with their badges and Generate only where a slide is missing', () => {
    const onGenerate = vi.fn();
    render(
      createElement(LessonPartsList, {
        mode: 'units',
        data: DATA,
        loadFailed: false,
        busy: false,
        onGenerate,
      }),
    );
    expect(rows().map((row) => row.dataset.unitId)).toEqual(['cu_1', 'cu_2', 'cu_3', 'cu_4']);
    expect(rows().map((row) => row.dataset.badge)).toEqual([
      'covered',
      'no-slide',
      'quiz-only',
      'reference',
    ]);
    const [covered, noSlide, quizOnly, reference] = rows();
    expect(covered!.textContent).toContain('Covered by 2 slide(s)');
    expect(noSlide!.textContent).toContain('Part 2'); // untitled fallback
    expect(noSlide!.textContent).toContain('No slide');
    expect(quizOnly!.textContent).toContain('Quiz only');
    expect(reference!.textContent).toContain('Reference — not taught');
    expect(reference!.className).toContain('opacity-70');
    const generate = (row: HTMLElement) =>
      row.querySelector<HTMLButtonElement>('[data-testid="lesson-part-generate"]');
    expect(generate(covered!)).toBeNull();
    expect(generate(reference!)).toBeNull();
    act(() => generate(quizOnly!)!.click());
    expect(onGenerate).toHaveBeenCalledWith('cu_3');
  });

  it('disables Generate while another generation runs here', () => {
    render(
      createElement(LessonPartsList, {
        mode: 'units',
        data: DATA,
        loadFailed: false,
        busy: true,
        onGenerate: vi.fn(),
      }),
    );
    const buttons = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="lesson-part-generate"]'),
    ];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[0]!.title).toContain('Another AI generation is running');
  });

  it.each([
    ['the gate reports no content units', 'no-parts' as const, null],
    ['the units list is empty', 'units' as const, { ...DATA, units: [] }],
    [
      'the lineage is unavailable',
      'units' as const,
      { ...DATA, lineageStatus: 'unavailable' as const },
    ],
  ])('shows the single "no lesson parts" line when %s', (_, mode, data) => {
    render(
      createElement(LessonPartsList, {
        mode,
        data,
        loadFailed: false,
        busy: false,
        onGenerate: vi.fn(),
      }),
    );
    expect(document.body.querySelector('[data-testid="lesson-parts-none"]')!.textContent).toBe(
      'This package was generated before lesson parts were stored; regenerate the package to use this',
    );
    expect(rows()).toHaveLength(0);
  });

  it('the entry shows how many parts have no slide, and opening it asks for fresh data', () => {
    const onOpen = vi.fn();
    render(
      createElement(LessonPartsPanel, {
        mode: 'units',
        data: DATA,
        loadFailed: false,
        busy: false,
        onOpen,
        onGenerate: vi.fn(),
      }),
    );
    const entry = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="lesson-parts-entry"]',
    )!;
    expect(entry.textContent).toContain('Lesson parts');
    expect(entry.textContent).toContain('2 without a slide');
    act(() => entry.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="lesson-parts-panel"]')).not.toBeNull();
    expect(rows()).toHaveLength(4);
  });
});
