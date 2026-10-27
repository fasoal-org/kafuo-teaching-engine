// @vitest-environment jsdom

/**
 * The "Generate a slide for a lesson part" dialog
 * (reviewer-generated-slide-for-lesson-part-plan §5 step 3, §15, §16):
 * field limits, the 0/1/2 allowed-stage rules, one idempotency key per open
 * (kept and the body frozen after `unknown`, renewed after `failed`), the
 * outcome → message mapping, and no closing while running. The client
 * protocol itself is mocked; the run is a stub.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ locale: 'en-US', nextKey: 0 }));

function loadLocale(code: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(__dirname, `../../../lib/i18n/locales/${code}.json`), 'utf8'),
  );
}
const LOCALES: Record<string, Record<string, unknown>> = {
  'en-US': loadLocale('en-US'),
  'ar-SA': loadLocale('ar-SA'),
};

function translate(key: string, options?: Record<string, unknown>): string {
  let value: unknown = LOCALES[mocks.locale];
  for (const part of key.split('.')) value = (value as Record<string, unknown> | undefined)?.[part];
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));
}

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: translate, locale: mocks.locale, setLocale: () => {} }),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));
vi.mock('@/lib/edit/scene-insertion-client', () => ({
  SCENE_INSERTION_LIMITS: {
    units: { min: 1, max: 3 },
    instruction: { min: 0, max: 2000 },
    reason: { min: 5, max: 1000 },
  },
  newInsertionKey: () => `insert-key-${++mocks.nextKey}`,
  runSceneInsertion: vi.fn(),
}));

import { toast } from 'sonner';
import {
  GenerateSlideForPartDialog,
  describePendingKeys,
  insertionTextError,
  insertionUnitsError,
  stageChoiceFor,
  type GenerateSlideForPartDialogProps,
} from '@/components/edit/GenerateSlideForPartDialog';
import type {
  ContentUnitSummary,
  ContentUnitsResponse,
  RunSceneInsertionInput,
  SceneInsertionOutcome,
} from '@/lib/edit/scene-insertion-client';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const STAGE_A = { key: 'explain', flowIndex: 1 };
const STAGE_B = { key: 'practice', flowIndex: 2 };
const SCENES = [
  { id: 's1', title: 'Intro' },
  { id: 's2', title: 'The rule' },
  { id: 's3', title: 'Check' },
];

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
    textLength: 1200,
    coveredBySlideIds: [],
    citedByOtherSceneIds: [],
    covered: false,
    suggestedPosition: null,
    ...overrides,
  };
}

const DATA: ContentUnitsResponse = {
  lineageStatus: 'own_attempt',
  units: [
    unit('cu_1', 1, { covered: true, coveredBySlideIds: ['s1'], title: 'Covered part' }),
    unit('cu_2', 2, { suggestedPosition: { afterSceneId: 's1', beforeSceneId: 's2' } }),
    unit('cu_3', 3, {
      citedByOtherSceneIds: ['s3'],
      suggestedPosition: { afterSceneId: 's2', beforeSceneId: 's3' },
    }),
    unit('cu_4', 4, { instructional: false, role: 'REFERENCE', title: 'Glossary' }),
    unit('cu_5', 5, { suggestedPosition: { afterSceneId: 's2', beforeSceneId: 's3' } }),
    unit('cu_6', 6, { suggestedPosition: { afterSceneId: 's3', beforeSceneId: null } }),
    unit('cu_7', 7, { textLength: 0, title: 'No text' }),
  ],
  positions: [
    { afterSceneId: null, beforeSceneId: 's1', allowedStages: [STAGE_A] },
    { afterSceneId: 's1', beforeSceneId: 's2', allowedStages: [STAGE_A] },
    { afterSceneId: 's2', beforeSceneId: 's3', allowedStages: [STAGE_A, STAGE_B] },
    { afterSceneId: 's3', beforeSceneId: null, allowedStages: [] },
  ],
  stages: [
    { ...STAGE_A, label: 'Explain' },
    { ...STAGE_B, label: 'Practice' },
  ],
};

const roots: Root[] = [];

beforeEach(() => {
  mocks.nextKey = 0;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.info).mockClear();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  mocks.locale = 'en-US';
});

type Run = (input: RunSceneInsertionInput) => Promise<SceneInsertionOutcome>;

function mount(props: Partial<GenerateSlideForPartDialogProps> & { run?: Run } = {}) {
  const onOpenChange = vi.fn();
  const onInserted = vi.fn();
  const onRunningChange = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(GenerateSlideForPartDialog, {
        open: true,
        onOpenChange,
        onInserted,
        onRunningChange,
        stageId: 'stage-1',
        data: DATA,
        scenes: SCENES,
        localGenerationRunning: false,
        gateRunning: [],
        ...props,
        run: (props.run ?? vi.fn()) as never,
      }),
    ),
  );
  return { onOpenChange, onInserted, onRunningChange };
}

const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
const byTestId = <T extends Element>(id: string) => q<T>(`[data-testid="${id}"]`);
const submitButton = () => byTestId<HTMLButtonElement>('insertion-submit')!;
const text = () => document.body.textContent ?? '';

function type(testId: string, value: string) {
  const element = byTestId<HTMLTextAreaElement>(testId)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

function choosePosition(value: string) {
  const select = byTestId<HTMLSelectElement>('insertion-position')!;
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

const VALID_REASON = 'No slide teaches this part.';

describe('GenerateSlideForPartDialog — field rules', () => {
  it('limits: units 1–3, optional instruction ≤ 2000, required reason 5–1000 (trimmed)', () => {
    expect(insertionUnitsError(0)).toEqual({ rule: 'required' });
    expect(insertionUnitsError(1)).toBeNull();
    expect(insertionUnitsError(3)).toBeNull();
    expect(insertionUnitsError(4)).toEqual({ rule: 'max', limit: 3 });
    expect(insertionTextError('instruction', '   ')).toBeNull();
    expect(insertionTextError('instruction', 'x'.repeat(2000))).toBeNull();
    expect(insertionTextError('instruction', 'x'.repeat(2001))).toEqual({
      rule: 'max',
      limit: 2000,
    });
    expect(insertionTextError('reason', '  ')).toEqual({ rule: 'required' });
    expect(insertionTextError('reason', '  abcd  ')).toEqual({ rule: 'min', limit: 5 });
    expect(insertionTextError('reason', ' abcde ')).toBeNull();
    expect(insertionTextError('reason', 'x'.repeat(1001))).toEqual({ rule: 'max', limit: 1000 });
  });

  it('pre-fills the panel unit and its suggested position; lists only uncovered instructional parts; never unit text', () => {
    mount({ initialUnitIds: ['cu_2'] });
    expect(text()).toContain('Generate a slide for a lesson part');
    expect(byTestId<HTMLInputElement>('insertion-unit-cu_2')!.checked).toBe(true);
    // Covered, reference and textless parts are not offered.
    expect(byTestId('insertion-unit-cu_1')).toBeNull();
    expect(byTestId('insertion-unit-cu_4')).toBeNull();
    expect(byTestId('insertion-unit-cu_7')).toBeNull();
    // A quiz-only part is uncovered (D-1), so it is offered.
    expect(byTestId('insertion-unit-cu_3')).not.toBeNull();
    expect(byTestId<HTMLSelectElement>('insertion-position')!.value).toBe('s1|s2');
    expect(text()).toContain('After slide 1 — Intro');
    expect(byTestId('insertion-stage-fixed')!.textContent).toBe('Explain');
    // Reason is required: disabled until it is valid; the instruction is optional.
    expect(submitButton().disabled).toBe(true);
    type('insertion-reason', '  abc ');
    expect(text()).toContain('Write at least 5 characters.');
    expect(submitButton().disabled).toBe(true);
    type('insertion-reason', VALID_REASON);
    expect(submitButton().disabled).toBe(false);
    type('insertion-instruction', 'x'.repeat(2001));
    expect(text()).toContain('Use at most 2000 characters.');
    expect(submitButton().disabled).toBe(true);
  });

  it('requires one unit and caps the choice at three', () => {
    mount({ initialUnitIds: ['cu_2'] });
    type('insertion-reason', VALID_REASON);
    act(() => byTestId<HTMLInputElement>('insertion-unit-cu_2')!.click());
    expect(text()).toContain('Choose at least one lesson part.');
    expect(submitButton().disabled).toBe(true);
    act(() => byTestId<HTMLInputElement>('insertion-unit-cu_2')!.click());
    act(() => byTestId<HTMLInputElement>('insertion-unit-cu_3')!.click());
    act(() => byTestId<HTMLInputElement>('insertion-unit-cu_5')!.click());
    expect(byTestId<HTMLInputElement>('insertion-unit-cu_6')!.disabled).toBe(true);
    expect(submitButton().disabled).toBe(false);
  });
});

describe('GenerateSlideForPartDialog — teaching stage rules', () => {
  it('maps 0 / 1 / 2 allowed stages to refusal / fixed / choice', () => {
    expect(stageChoiceFor({ allowedStages: [] })).toEqual({ kind: 'none' });
    expect(stageChoiceFor(null)).toEqual({ kind: 'none' });
    expect(stageChoiceFor({ allowedStages: [STAGE_A] })).toEqual({ kind: 'fixed', stage: STAGE_A });
    expect(stageChoiceFor({ allowedStages: [STAGE_A, STAGE_B] })).toEqual({
      kind: 'choice',
      options: [STAGE_A, STAGE_B],
    });
  });

  it('no allowed stage: inline refusal and submit disabled', () => {
    mount({ initialUnitIds: ['cu_6'] });
    type('insertion-reason', VALID_REASON);
    expect(byTestId<HTMLSelectElement>('insertion-position')!.value).toBe('s3|');
    expect(byTestId('insertion-stage-none')!.textContent).toContain(
      'No teaching stage at this position allows a new slide.',
    );
    expect(submitButton().disabled).toBe(true);
  });

  it('a boundary offers a two-way choice, defaulting to the first (previous scene’s) stage', async () => {
    const run = vi.fn<Run>(async () => ({ kind: 'busy' }));
    mount({ initialUnitIds: ['cu_2'], run });
    choosePosition('s2|s3');
    const first = byTestId<HTMLInputElement>('insertion-stage-0')!;
    const second = byTestId<HTMLInputElement>('insertion-stage-1')!;
    expect(first.checked).toBe(true);
    expect(second.checked).toBe(false);
    expect(text()).toContain('Practice');
    act(() => second.click());
    type('insertion-reason', VALID_REASON);
    act(() => submitButton().click());
    await flush();
    expect(run.mock.calls[0]![0].request).toMatchObject({
      afterSceneId: 's2',
      beforeSceneId: 's3',
      teachingStage: STAGE_B,
    });
  });

  it('a "+" entry fixes the position and pre-fills the parts suggested for it', () => {
    mount({ fixedPosition: { afterSceneId: 's2', beforeSceneId: 's3' } });
    expect(byTestId('insertion-position')).toBeNull();
    expect(byTestId('insertion-position-fixed')!.textContent).toBe('After slide 2 — The rule');
    expect(byTestId<HTMLInputElement>('insertion-unit-cu_3')!.checked).toBe(true);
    expect(byTestId<HTMLInputElement>('insertion-unit-cu_5')!.checked).toBe(true);
    expect(byTestId<HTMLInputElement>('insertion-unit-cu_2')!.checked).toBe(false);
    expect(byTestId('insertion-stage-choice')).not.toBeNull();
  });

  it('a "+" position the server does not know yet is refused inline', () => {
    mount({ fixedPosition: { afterSceneId: 's1', beforeSceneId: 'unsaved-blank' } });
    type('insertion-reason', VALID_REASON);
    expect(byTestId('insertion-position-unknown')).not.toBeNull();
    expect(submitButton().disabled).toBe(true);
  });
});

describe('GenerateSlideForPartDialog — idempotency key', () => {
  it('sends the trimmed request once with one key; keeps key and body after unknown; renews after failed', async () => {
    let settle!: (outcome: SceneInsertionOutcome) => void;
    const run = vi.fn<Run>(
      () => new Promise<SceneInsertionOutcome>((resolveRun) => (settle = resolveRun)),
    );
    mount({ initialUnitIds: ['cu_2'], run });
    type('insertion-instruction', '  Start from an everyday example.  ');
    type('insertion-reason', `  ${VALID_REASON}  `);
    act(() => {
      submitButton().click();
      submitButton().click();
    });
    expect(run).toHaveBeenCalledTimes(1);
    const first = run.mock.calls[0]![0];
    expect(first).toMatchObject({
      stageId: 'stage-1',
      localGenerationRunning: false,
      gateRunning: [],
      request: {
        unitIds: ['cu_2'],
        afterSceneId: 's1',
        beforeSceneId: 's2',
        teachingStage: STAGE_A,
        instruction: 'Start from an everyday example.',
        reason: VALID_REASON,
        idempotencyKey: 'insert-key-1',
      },
    });

    // unknown → same key, identical body, fields frozen.
    await act(async () => settle({ kind: 'unknown', insertionId: 'tpsi_1' }));
    await flush();
    expect(byTestId('insertion-failure')!.textContent).toContain(
      'We could not confirm whether the slide was added.',
    );
    expect(byTestId<HTMLTextAreaElement>('insertion-reason')!.disabled).toBe(true);
    expect(byTestId<HTMLInputElement>('insertion-unit-cu_2')!.disabled).toBe(true);
    expect(byTestId('insertion-frozen')).not.toBeNull();
    expect(submitButton().textContent).toBe('Retry');
    act(() => submitButton().click());
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].request).toEqual(first.request);

    // failed → a new key and editable fields.
    await act(async () =>
      settle({ kind: 'failed', status: 409, code: 'IDEMPOTENCY_KEY_REUSED', message: 'x' }),
    );
    await flush();
    expect(byTestId('insertion-failure')!.textContent).toContain(
      'The earlier request was sent with different values.',
    );
    expect(byTestId<HTMLTextAreaElement>('insertion-reason')!.disabled).toBe(false);
    expect(submitButton().textContent).toBe('Generate slide');
    act(() => submitButton().click());
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2]![0].request.idempotencyKey).toBe('insert-key-2');
    await act(async () => settle({ kind: 'busy' }));
    await flush();
    // busy sent nothing: the key stays.
    act(() => submitButton().click());
    expect(run.mock.calls[3]![0].request.idempotencyKey).toBe('insert-key-2');
    await act(async () => settle({ kind: 'busy' }));
    await flush();
  });
});

describe('GenerateSlideForPartDialog — outcomes', () => {
  async function submitWith(outcome: SceneInsertionOutcome, props = {}) {
    const run = vi.fn<Run>(async () => outcome);
    const handles = mount({ initialUnitIds: ['cu_2'], run, ...props });
    type('insertion-reason', VALID_REASON);
    act(() => submitButton().click());
    await flush();
    return { run, ...handles };
  }

  it('success: toast names the part, says it can be deleted, closes', async () => {
    const { onOpenChange, onInserted } = await submitWith({
      kind: 'success',
      insertionId: 'tpsi_1',
      sceneId: 'scene_new',
      applied: 'applied',
    });
    expect(toast.success).toHaveBeenCalledWith(
      'Slide added for Part cu_2. You can delete it like any slide.',
    );
    expect(onInserted).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('saved-not-shown: info toast and close', async () => {
    const { onOpenChange } = await submitWith({
      kind: 'saved-not-shown',
      insertionId: 'tpsi_1',
      sceneId: 'scene_new',
      reason: 'stale',
    });
    expect(toast.info).toHaveBeenCalledWith('The slide was added. Reopen the lesson to see it.');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('not-durable: names what is unsaved and keeps the reviewer’s text', async () => {
    const { onOpenChange } = await submitWith({
      kind: 'not-durable',
      pendingKeys: ['scene:s2', 'structure', 'stage', 'outline', 'scene:gone'],
      conflict: false,
    });
    const failure = byTestId('insertion-failure')!.textContent!;
    expect(failure).toContain('Some changes are not saved yet, so nothing was sent');
    expect(failure).toContain('the slide “The rule”');
    expect(failure).toContain('the slide order');
    expect(failure).toContain('the lesson settings');
    expect(failure).toContain('the lesson outline');
    expect(failure).toContain('a slide');
    expect(byTestId<HTMLTextAreaElement>('insertion-reason')!.value).toBe(VALID_REASON);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('not-durable with a conflict: a slide changed elsewhere', async () => {
    await submitWith({ kind: 'not-durable', pendingKeys: [], conflict: true });
    expect(byTestId('insertion-failure')!.textContent).toContain(
      'A slide changed elsewhere. Review it and try again',
    );
  });

  it('busy: another generation is running', async () => {
    await submitWith({ kind: 'busy' });
    expect(byTestId('insertion-failure')!.textContent).toContain(
      'Another AI generation is running on this lesson.',
    );
  });

  it.each([
    ['INSERTION_UNIT_ALREADY_COVERED', 'A slide now teaches one of the chosen lesson parts.'],
    ['INSERTION_FLOW_INVALID', 'teaching order already has a problem'],
    ['STAGE_GENERATION_IN_PROGRESS', 'Another AI generation is running on this lesson.'],
    ['SCENE_CONTENT_GENERATION_FAILED', 'The AI could not write the slide.'],
  ])('failed %s: its localized message', async (code, expected) => {
    await submitWith({ kind: 'failed', status: 409, code, message: 'raw' });
    expect(byTestId('insertion-failure')!.textContent).toContain(expected);
  });

  it('failed with an unknown code: the generic message with the code', async () => {
    await submitWith({ kind: 'failed', status: 500, code: 'SOMETHING_NEW', message: 'raw' });
    expect(byTestId('insertion-failure')!.textContent).toBe(
      'The slide could not be added (SOMETHING_NEW). Nothing was changed.',
    );
  });

  it('passes the same-tab generation state through to the run', async () => {
    const { run } = await submitWith(
      { kind: 'busy' },
      {
        localGenerationRunning: true,
        gateRunning: [{ kind: 'regeneration', id: 'tsr_1', sceneId: 's1' }],
      },
    );
    expect(run.mock.calls[0]![0]).toMatchObject({
      localGenerationRunning: true,
      gateRunning: [{ kind: 'regeneration', id: 'tsr_1', sceneId: 's1' }],
    });
  });

  it('describePendingKeys falls back to a generic phrase when no key is named', () => {
    expect(describePendingKeys([], SCENES, translate, 'en-US')).toBe('your latest changes');
  });
});

describe('GenerateSlideForPartDialog — modal while running', () => {
  it('cannot be closed while running; can be closed after', async () => {
    let settle!: (outcome: SceneInsertionOutcome) => void;
    const run = vi.fn<Run>(
      () => new Promise<SceneInsertionOutcome>((resolveRun) => (settle = resolveRun)),
    );
    const { onOpenChange, onRunningChange } = mount({ initialUnitIds: ['cu_2'], run });
    type('insertion-reason', VALID_REASON);
    act(() => submitButton().click());
    expect(onRunningChange).toHaveBeenLastCalledWith(true);
    expect(byTestId('insertion-running')).not.toBeNull();
    const buttons = () => [...document.body.querySelectorAll('button')];
    expect(buttons().some((button) => button.textContent === 'Close')).toBe(false);
    const cancel = buttons().find((button) => button.textContent === 'Cancel')!;
    expect(cancel.disabled).toBe(true);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => settle({ kind: 'busy' }));
    await flush();
    expect(onRunningChange).toHaveBeenLastCalledWith(false);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows a loading line and no submit while the parts load', () => {
    mount({ data: null });
    expect(byTestId('insertion-loading')).not.toBeNull();
    type('insertion-reason', VALID_REASON);
    expect(submitButton().disabled).toBe(true);
  });

  it('renders Arabic copy right-to-left', () => {
    mocks.locale = 'ar-SA';
    mount({ initialUnitIds: ['cu_2'] });
    expect(byTestId('generate-slide-for-part-dialog')!.getAttribute('dir')).toBe('rtl');
    expect(text()).toContain('توليد شريحة لجزء من الدرس');
    expect(text()).toContain('بعد الشريحة 1 — Intro');
  });
});

describe('GenerateSlideForPartDialog — refreshed data', () => {
  it('a chosen position that vanished from a refreshed read falls back, so select and state agree', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    const props = (data: ContentUnitsResponse) =>
      createElement(GenerateSlideForPartDialog, {
        open: true,
        onOpenChange: vi.fn(),
        stageId: 'stage-1',
        data,
        scenes: SCENES,
        initialUnitIds: ['cu_2'],
        localGenerationRunning: false,
        gateRunning: [],
        run: vi.fn() as never,
      });
    act(() => root.render(props(DATA)));
    choosePosition('s2|s3');
    expect(byTestId<HTMLSelectElement>('insertion-position')!.value).toBe('s2|s3');
    // The refresh after a settled run no longer offers that gap.
    const refreshed: ContentUnitsResponse = {
      ...DATA,
      positions: DATA.positions.filter((option) => option.afterSceneId !== 's2'),
    };
    act(() => root.render(props(refreshed)));
    type('insertion-reason', VALID_REASON);
    expect(byTestId<HTMLSelectElement>('insertion-position')!.value).toBe('s1|s2');
    expect(byTestId('insertion-stage-fixed')!.textContent).toBe('Explain');
    expect(submitButton().disabled).toBe(false);
  });

  it('a failed lesson-parts read shows an error instead of loading forever', () => {
    mount({
      data: null,
      loadFailed: true,
      fixedPosition: { afterSceneId: 's1', beforeSceneId: 's2' },
    });
    expect(byTestId('insertion-load-failed')).not.toBeNull();
    expect(byTestId('insertion-loading')).toBeNull();
    expect(text()).toContain('The lesson parts could not be loaded');
  });
});
