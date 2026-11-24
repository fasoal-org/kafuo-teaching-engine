/**
 * Wave F2.1 over PGlite, through the real `agent-ops/quiz-item-edit` and
 * `agent-ops/quiz-item-delete` routes: options addressed by their current letter, the
 * key checks, short answers, the refusals (bank quiz, engine question, verse item, last
 * item), the learner-first normalization and the delete's backup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { editQuizItem } from '@/lib/server/teaching-package/agent-edit-ops';
import type { AppScene, QuizQuestion } from '@/lib/types/stage';
import { body, quizScene, setupHarness, textSlide, type Harness } from './_pg';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function questions(scene: AppScene): QuizQuestion[] {
  return (scene.content as { questions: QuizQuestion[] }).questions;
}

describe('editQuizItem (pure)', () => {
  const single: QuizQuestion = {
    id: 'q',
    type: 'single',
    question: 's',
    options: [
      { label: 'x', value: 'a' },
      { label: 'y', value: 'b' },
    ],
    answer: ['a'],
  };

  it('addresses options by their stored value and returns the new letters', () => {
    const edited = editQuizItem(single, {
      correctOptionIds: ['b'],
      options: [{ id: 'a', text: 'X' }],
    });
    expect(edited.question.options).toEqual([
      { label: 'X', value: 'A' },
      { label: 'y', value: 'B' },
    ]);
    expect(edited.question.answer).toEqual(['B']);
    expect(edited.optionLetters).toEqual([
      { from: 'a', to: 'A' },
      { from: 'b', to: 'B' },
    ]);
  });

  it('refuses a key not among the options and a single item with two keys', () => {
    expect(() => editQuizItem(single, { correctOptionIds: ['z'] })).toThrow(
      expect.objectContaining({ code: 'QUIZ_KEY_NOT_IN_OPTIONS' }),
    );
    expect(() => editQuizItem(single, { correctOptionIds: ['a', 'b'] })).toThrow(
      expect.objectContaining({ code: 'QUIZ_SINGLE_KEY_COUNT' }),
    );
    expect(() => editQuizItem(single, { options: [{ id: 'q', text: 'n' }] })).toThrow(
      expect.objectContaining({ code: 'QUIZ_OPTION_NOT_FOUND' }),
    );
    expect(() => editQuizItem(single, { correctValue: '4' })).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });
});

describe('agent-ops quiz items', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.pool.end();
    vi.unstubAllEnvs();
  });

  it('edits the stem, an option, the key and the explanation of one item', async () => {
    harness = await setupHarness({ scenes: [quizScene('quiz-1', 1)] });
    const response = await harness.post('quiz-item-edit', {
      expectedRevision: await harness.revision(),
      sceneId: 'quiz-1',
      itemId: 'q1',
      stem: 'ما ناتج اثنين زائد اثنين؟',
      options: [{ id: 'C', text: '6' }],
      correctOptionIds: ['B'],
      explanation: 'اثنان واثنان أربعة',
    });
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(answer).toMatchObject({
      status: 'done',
      itemId: 'q1',
      optionLetters: [
        { from: 'A', to: 'A' },
        { from: 'B', to: 'B' },
        { from: 'C', to: 'C' },
      ],
      item: { id: 'q1', correct_option_ids: ['B'], explanation: 'اثنان واثنان أربعة' },
    });
    const stored = questions(await harness.scene('quiz-1'))[0]!;
    expect(stored).toMatchObject({
      question: 'ما ناتج اثنين زائد اثنين؟',
      answer: ['B'],
      analysis: 'اثنان واثنان أربعة',
    });
    expect(stored.options?.[2]).toEqual({ label: '6', value: 'C' });
    expect(
      await harness.count(
        "SELECT count(*) AS n FROM teaching_package_agent_ops WHERE op = 'quiz-item-edit'",
      ),
    ).toBe(1);
  });

  it('sets a short answer’s correct value and refuses options on it', async () => {
    harness = await setupHarness({ scenes: [quizScene('quiz-1', 1)] });
    const revision = await harness.revision();
    const refused = await harness.post('quiz-item-edit', {
      expectedRevision: revision,
      sceneId: 'quiz-1',
      itemId: 'q3',
      correctOptionIds: ['A'],
    });
    expect(refused.status).toBe(400);
    const done = await harness.post('quiz-item-edit', {
      expectedRevision: revision,
      sceneId: 'quiz-1',
      itemId: 'q3',
      correctValue: '9.0',
    });
    expect(done.status).toBe(200);
    expect((await body(done)).item).toMatchObject({ correct_value: '9.0' });
  });

  it('refuses a bank quiz, an engine question, a verse item and an unknown item', async () => {
    const bank = { ...quizScene('bank-1', 2), questionSource: 'bank' } as AppScene;
    const engine = quizScene('quiz-1', 1);
    questions(engine)[0]!.id = 'q_guide_0123456789abcdef0123';
    questions(engine)[1]!.question = 'قال تعالى ﴿إِنَّ مَعَ الْعُسْرِ يُسْرًا﴾ ما الدرس؟';
    harness = await setupHarness({ scenes: [engine, bank] });
    const revision = await harness.revision();
    const ask = (sceneId: string, itemId: string) =>
      harness.post('quiz-item-edit', {
        expectedRevision: revision,
        sceneId,
        itemId,
        stem: 'سؤال جديد',
      });
    const codes = [];
    for (const [sceneId, itemId] of [
      ['bank-1', 'q1'],
      ['quiz-1', 'q_guide_0123456789abcdef0123'],
      ['quiz-1', 'q2'],
      ['quiz-1', 'nope'],
    ] as const) {
      codes.push((await body(await ask(sceneId, itemId))).error.code);
    }
    expect(codes).toEqual([
      expect.stringMatching(/^BANK_QUIZ_NOT_EDITABLE$/),
      'ENGINE_QUESTION_NOT_EDITABLE',
      'SACRED_EXERCISE_ITEM',
      'QUIZ_ITEM_NOT_FOUND',
    ]);
    const deleteGuide = await harness.post('quiz-item-delete', {
      expectedRevision: revision,
      sceneId: 'quiz-1',
      itemId: 'q_guide_0123456789abcdef0123',
      reason: 'wrong',
    });
    expect((await body(deleteGuide)).error.code).toBe('ENGINE_QUESTION_NOT_EDITABLE');
    expect(await harness.count('SELECT count(*) AS n FROM teaching_package_agent_ops')).toBe(0);
  });

  it('normalizes digits and points on a learner-first package, as regeneration does', async () => {
    harness = await setupHarness({
      scenes: [quizScene('quiz-1', 1), textSlide('scene-2', 2, 'نجمع 12 و 34 ثم 56')],
      teachingModel: { key: 'g5', version: 'g5.v10' },
    });
    const response = await harness.post('quiz-item-edit', {
      expectedRevision: await harness.revision(),
      sceneId: 'quiz-1',
      itemId: 'q2',
      stem: 'اختر الأعداد الزوجية من ٢ إلى ٤',
    });
    expect(response.status).toBe(200);
    const stored = questions(await harness.scene('quiz-1'));
    // The package's other learner text is Western digits: the new stem follows it.
    expect(stored[1]!.question).toBe('اختر الأعداد الزوجية من 2 إلى 4');
    expect(stored.map((q) => q.points)).toEqual([1, 1, 2]);
  });

  it('A8 after a normalized learner-first edit: the slide stays confirmable', async () => {
    harness = await setupHarness({
      scenes: [quizScene('quiz-1', 1), textSlide('scene-2', 2, 'نجمع 12 و 34 ثم 56')],
      teachingModel: { key: 'g5', version: 'g5.v10' },
      governed: true,
    });
    const edited = await harness.post('quiz-item-edit', {
      expectedRevision: await harness.revision(),
      sceneId: 'quiz-1',
      itemId: 'q1',
      stem: 'ما ناتج ٢ + ٢؟',
      correctOptionIds: ['B'],
    });
    expect(edited.status).toBe(200);
    const read = await harness.read();
    const quiz = read.scenes.find((scene) => scene.scene_id === 'quiz-1')!;
    expect(quiz.alignment).toMatchObject({ state: 'stale', confirmable_by_agent: true });
    const confirmed = await harness.post('alignment-confirm', {
      expectedRevision: await harness.revision(),
      sceneId: 'quiz-1',
      reason: 'the agent fixed the key',
    });
    expect(confirmed.status).toBe(200);
  });

  it('deletes one item with its backup, and never the last one', async () => {
    const one = quizScene('quiz-2', 2);
    (one.content as { questions: QuizQuestion[] }).questions.splice(1);
    harness = await setupHarness({ scenes: [quizScene('quiz-1', 1), one] });
    const revision = await harness.revision();
    const dry = await harness.post('quiz-item-delete', {
      expectedRevision: revision,
      dryRun: true,
      sceneId: 'quiz-1',
      itemId: 'q2',
      reason: 'duplicate of q1',
    });
    expect(await body(dry)).toMatchObject({ dryRun: true, status: 'would_update' });
    expect(questions(await harness.scene('quiz-1'))).toHaveLength(3);

    const done = await harness.post('quiz-item-delete', {
      expectedRevision: revision,
      sceneId: 'quiz-1',
      itemId: 'q2',
      reason: 'duplicate of q1',
      idempotencyKey: 'agt_3_delete_item_0001',
    });
    expect(done.status).toBe(200);
    expect(await body(done)).toMatchObject({
      status: 'done',
      deleted: true,
      reason: 'duplicate of q1',
      backup: { scene_id: 'quiz-1', position: 2, item: { id: 'q2' }, question: { id: 'q2' } },
    });
    expect(questions(await harness.scene('quiz-1')).map((q) => q.id)).toEqual(['q1', 'q3']);

    const last = await harness.post('quiz-item-delete', {
      expectedRevision: await harness.revision(),
      sceneId: 'quiz-2',
      itemId: 'q1',
      reason: 'wrong',
    });
    expect(last.status).toBe(422);
    expect((await body(last)).error.code).toBe('QUIZ_LAST_ITEM');
  });
});
