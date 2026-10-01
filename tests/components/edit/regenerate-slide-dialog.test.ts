// @vitest-environment jsdom

/**
 * The "Regenerate slide" dialog (single-slide-regeneration-plan §12.2, §16):
 * two required, separate fields with limits; submit disabled until valid and
 * while running; one request per click burst; values kept on failure; EN and
 * AR copy with the right direction. The run itself is a stub.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ locale: 'en-US' }));

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
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

import { RegenerateSlideDialog } from '@/components/edit/RegenerateSlideDialog';
import type {
  RegenerationOutcome,
  RunSlideRegenerationInput,
} from '@/lib/edit/scene-regeneration-client';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  mocks.locale = 'en-US';
});

function mount(run: (input: never) => Promise<RegenerationOutcome>, onOpenChange = vi.fn()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(RegenerateSlideDialog, {
        open: true,
        onOpenChange,
        stageId: 'stage-1',
        sceneId: 'scene-1',
        sceneTitle: 'Patterns',
        run: run as never,
      }),
    ),
  );
  return { onOpenChange };
}

const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);

function type(testId: string, value: string) {
  const element = q<HTMLTextAreaElement>(`[data-testid="${testId}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

const submitButton = () => q<HTMLButtonElement>('[data-testid="regenerate-submit"]')!;

async function flush() {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

const VALID_INSTRUCTION = 'Explain the rule with a simpler everyday example.';
const VALID_REASON = 'The formula is wrong.';

describe('RegenerateSlideDialog', () => {
  it('shows the scope, both labelled fields with help, and disables submit until both are valid', () => {
    mount(vi.fn());
    const text = document.body.textContent ?? '';
    expect(text).toContain('Regenerate this slide');
    expect(text).toContain('Only this slide is regenerated');
    expect(text).toContain('Requirements for the AI');
    expect(text).toContain('This text is sent to the AI.');
    expect(text).toContain('Reason for regeneration');
    expect(text).toContain('never sent to the AI');
    expect(submitButton().disabled).toBe(true);
    type('regenerate-instruction', VALID_INSTRUCTION);
    expect(submitButton().disabled).toBe(true);
    type('regenerate-reason', VALID_REASON);
    expect(submitButton().disabled).toBe(false);
  });

  it('shows field errors for the limits (trimmed)', () => {
    mount(vi.fn());
    type('regenerate-instruction', '   short   ');
    type('regenerate-reason', '  ab ');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Write at least 10 characters.');
    expect(text).toContain('Write at least 5 characters.');
    type('regenerate-instruction', 'x'.repeat(2001));
    expect(document.body.textContent).toContain('Use at most 2000 characters.');
    expect(submitButton().disabled).toBe(true);
  });

  it('sends trimmed values once, even on a double click, with a well-formed key', async () => {
    let settle!: (outcome: RegenerationOutcome) => void;
    const run = vi.fn(
      (_input: RunSlideRegenerationInput) =>
        new Promise<RegenerationOutcome>((resolveRun) => (settle = resolveRun)),
    );
    const { onOpenChange } = mount(run);
    type('regenerate-instruction', `  ${VALID_INSTRUCTION}  `);
    type('regenerate-reason', VALID_REASON);
    act(() => {
      submitButton().click();
      submitButton().click();
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({
      stageId: 'stage-1',
      sceneId: 'scene-1',
      instruction: VALID_INSTRUCTION,
      reason: VALID_REASON,
    });
    expect(run.mock.calls[0]![0].idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    // Running: modal, fields and buttons disabled, status shown.
    expect(q('[data-testid="regenerate-running"]')).not.toBeNull();
    expect(submitButton().disabled).toBe(true);
    expect(q<HTMLTextAreaElement>('[data-testid="regenerate-instruction"]')!.disabled).toBe(true);
    await act(async () => settle({ kind: 'success', regenerationId: 'tsr-1' }));
    await flush();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the values and shows the reason on a failure', async () => {
    const run = vi.fn(async (_input: RunSlideRegenerationInput) => ({
      kind: 'failed' as const,
      status: 409,
      code: 'SCENE_CHANGED_DURING_REGENERATION',
      message: 'changed',
    }));
    const { onOpenChange } = mount(run);
    type('regenerate-instruction', VALID_INSTRUCTION);
    type('regenerate-reason', VALID_REASON);
    act(() => submitButton().click());
    await flush();
    expect(q('[data-testid="regenerate-failure"]')!.textContent).toContain(
      'changed while it was being regenerated',
    );
    expect(q<HTMLTextAreaElement>('[data-testid="regenerate-instruction"]')!.value).toBe(
      VALID_INSTRUCTION,
    );
    expect(q<HTMLTextAreaElement>('[data-testid="regenerate-reason"]')!.value).toBe(VALID_REASON);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // A retry is a NEW user submission: a new key.
    act(() => submitButton().click());
    await flush();
    const keys = run.mock.calls.map(
      (call) => (call[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it('a not-durable outcome sends nothing more and explains why', async () => {
    const run = vi.fn(async () => ({ kind: 'not-durable' as const }));
    mount(run);
    type('regenerate-instruction', VALID_INSTRUCTION);
    type('regenerate-reason', VALID_REASON);
    act(() => submitButton().click());
    await flush();
    expect(q('[data-testid="regenerate-failure"]')!.textContent).toContain(
      'could not be saved yet',
    );
  });

  it('renders Arabic copy right-to-left', () => {
    mocks.locale = 'ar-SA';
    mount(vi.fn());
    const dialog = q('[data-testid="regenerate-slide-dialog"]')!;
    expect(dialog.getAttribute('dir')).toBe('rtl');
    const text = document.body.textContent ?? '';
    expect(text).toContain('إعادة توليد هذه الشريحة');
    expect(text).toContain('المتطلبات المطلوبة من الذكاء الاصطناعي');
    expect(text).toContain('سبب إعادة التوليد');
  });
});
