// @vitest-environment jsdom

/**
 * The bank quiz view's load states (clear quiz messages, 21 Nov 2026): a preview of a
 * version that will never get questions says so with no button; an expired grant or
 * access (401 / a plain 404) says the session ended, with no button (a reload cannot renew
 * a grant); only Kafuo's 503 BANK_QUIZ_UNAVAILABLE names the bank, any other 503 keeps the
 * generic message, both with Retry; `pending_approval` is unchanged. Written with `createElement` because the
 * vitest include covers `*.test.ts` only.
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchBankQuestions: vi.fn() }));

vi.mock('@/lib/quiz/bank-quiz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quiz/bank-quiz')>()),
  fetchBankQuestions: mocks.fetchBankQuestions,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US', setLocale: () => {} }),
}));
vi.mock('@/components/scene-renderers/quiz-view', () => ({
  QuizView: () => createElement('div', { 'data-testid': 'scene-quiz' }),
  QuizMathText: ({ text }: { text: string }) => createElement('span', null, text),
}));

import { BankQuizView } from '@/components/scene-renderers/bank-quiz-view';
import { BankQuizRequestError } from '@/lib/quiz/bank-quiz';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const reload = vi.fn();
const roots: Root[] = [];

beforeAll(() => {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, reload },
    configurable: true,
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
  mocks.fetchBankQuestions.mockReset();
  reload.mockClear();
});

function render(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

async function renderLoaded(): Promise<HTMLElement> {
  const host = render(
    createElement(BankQuizView, { questions: [], sceneId: 'scene-1', stageId: 'stage-1' }),
  );
  await act(async () => {});
  return host;
}

function textOf(host: HTMLElement): string {
  return host.textContent ?? '';
}

describe('BankQuizView load states', () => {
  it('preview_unapproved shows the message and no button', async () => {
    mocks.fetchBankQuestions.mockResolvedValue({ status: 'preview_unapproved', questions: [] });
    const host = await renderLoaded();
    expect(textOf(host)).toContain('quiz.previewUnapproved');
    expect(host.querySelector('button')).toBeNull();
  });

  it.each([
    ['401', () => new BankQuizRequestError(401, null)],
    ['a plain 404', () => new BankQuizRequestError(404, null)],
  ])('session_expired for %s says so, with no button', async (_name, error) => {
    // Review 21 Nov 2026: a reload re-opens `/classroom/:id` only and never redeems a
    // handoff, so it cannot renew an expired or stale grant (preview or learner): the
    // lesson has to be opened again from where it was opened.
    mocks.fetchBankQuestions.mockRejectedValue(error());
    const host = await renderLoaded();
    expect(textOf(host)).toContain('quiz.sessionExpired');
    expect(host.querySelector('button')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a 404 with an error code is the ordinary error, not session_expired', async () => {
    mocks.fetchBankQuestions.mockRejectedValue(new BankQuizRequestError(404, 'some_code'));
    const host = await renderLoaded();
    expect(textOf(host)).toContain('quiz.bankUnavailable');
    expect(textOf(host)).not.toContain('quiz.sessionExpired');
  });

  it('503 names the bank and keeps Retry', async () => {
    mocks.fetchBankQuestions.mockRejectedValue(
      new BankQuizRequestError(503, 'BANK_QUIZ_UNAVAILABLE'),
    );
    const host = await renderLoaded();
    expect(textOf(host)).toContain('quiz.bankUnreachable');
    const button = host.querySelector('button');
    expect(button?.textContent).toContain('quiz.retry');
  });

  it.each([
    ['no code', null],
    ['another code', 'INTERNAL_ERROR'],
  ])('any other 503 (%s) keeps the generic message and Retry', async (_name, code) => {
    mocks.fetchBankQuestions.mockRejectedValue(new BankQuizRequestError(503, code));
    const host = await renderLoaded();
    expect(textOf(host)).toContain('quiz.bankUnavailable');
    expect(textOf(host)).not.toContain('quiz.bankUnreachable');
    expect(host.querySelector('button')?.textContent).toContain('quiz.retry');
  });

  it('pending_approval is unchanged', async () => {
    mocks.fetchBankQuestions.mockResolvedValue({ status: 'pending_approval', questions: [] });
    const host = await renderLoaded();
    expect(textOf(host)).toContain('quiz.bankPending');
    expect(host.querySelector('button')).toBeNull();
  });
});
