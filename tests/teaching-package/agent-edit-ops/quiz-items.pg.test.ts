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
    expect(() => editQuizItem(single, { correctValues: ['4'] })).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });

  it('replaces every accepted short answer and keeps the item auto-graded', () => {
    const short: QuizQuestion = {
      id: 's',
      type: 'short_answer',
      question: 'q',
      answer: ['9', 'تسعة'],
    };
    const edited = editQuizItem(short, { correctValues: ['9', '9.0'] });
    expect(edited.question.answer).toEqual(['9', '9.0']);
    expect(edited.question.hasAnswer).toBe(true);
    // Without a key edit, the stored answers stay as they are.
    expect(editQuizItem(short, { stem: 'new' }).question.answer).toEqual(['9', 'تسعة']);
  });

  it('refuses keying a short answer a teacher or the model grades (no key today)', () => {
    const graded: QuizQuestion[] = [
      { id: 'g1', type: 'short_answer', question: 'q', hasAnswer: false, commentPrompt: 'p' },
      { id: 'g2', type: 'short_answer', question: 'q', hasAnswer: false, answer: ['x'] },
      { id: 'g3', type: 'short_answer', question: 'q' },
    ];
    for (const question of graded) {
      expect(() => editQuizItem(question, { correctValues: ['x'] }), question.id).toThrow(
        expect.objectContaining({ code: 'QUIZ_ITEM_NOT_KEYED' }),
      );
      // Its stem and explanation are still editable.
      expect(editQuizItem(question, { stem: 'n' }).question.hasAnswer).toBe(question.hasAnswer);
    }
  });
});

describe('agent-ops quiz items', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.pool.end();
    vi.unstubAllEnvs();
  });

  it('g5.v12 (QZ-2, review M2): a banked check quiz’s question, options and key are not AI-edited; its explanation is', async () => {
    const check = {
      ...quizScene('quiz-1', 1),
      teachingStage: { key: 'outcome_check_understanding', flowIndex: 0 },
    } as AppScene;
    harness = await setupHarness({
      scenes: [check],
      teachingModel: { key: 'g5', version: 'g5.v12' },
    });
    for (const edit of [
      { correctOptionIds: ['B'] },
      { options: [{ id: 'C', text: '6' }] },
      { stem: 'ما ناتج اثنين زائد اثنين؟' },
    ]) {
      const refused = await harness.post('quiz-item-edit', {
        expectedRevision: await harness.revision(),
        sceneId: 'quiz-1',
        itemId: 'q1',
        ...edit,
      });
      expect(refused.status).toBe(400);
      expect(await body(refused)).toMatchObject({
        error: expect.objectContaining({
          code: 'INVALID_REQUEST',
          details: expect.objectContaining({ rule: 'check_quiz_keys_verified_by_code' }),
        }),
      });
    }
    const explained = await harness.post('quiz-item-edit', {
      expectedRevision: await harness.revision(),
      sceneId: 'quiz-1',
      itemId: 'q1',
      explanation: 'اثنان واثنان أربعة',
    });
    expect(explained.status).toBe(200);
  });

  it('g5.v11 keeps editing a check quiz’s key as before', async () => {
    const check = {
      ...quizScene('quiz-1', 1),
      teachingStage: { key: 'outcome_check_understanding', flowIndex: 0 },
    } as AppScene;
    harness = await setupHarness({
      scenes: [check],
      teachingModel: { key: 'g5', version: 'g5.v11' },
    });
    const response = await harness.post('quiz-item-edit', {
      expectedRevision: await harness.revision(),
      sceneId: 'quiz-1',
      itemId: 'q1',
      correctOptionIds: ['B'],
    });
    expect(response.status).toBe(200);
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

  it('replaces a short answer’s accepted answers and refuses options on it', async () => {
    harness = await setupHarness({ scenes: [quizScene('quiz-1', 1)] });
    const revision = await harness.revision();
    const ask = (fields: Record<string, unknown>) =>
      harness.post('quiz-item-edit', {
        expectedRevision: revision,
        sceneId: 'quiz-1',
        itemId: 'q3',
        ...fields,
      });
    const refused = await ask({ correctOptionIds: ['A'] });
    expect(refused.status).toBe(400);
    // The old single-value field is gone (never deployed): refused, not aliased.
    const old = await ask({ correctValue: '9.0' });
    expect(old.status).toBe(400);
    expect((await body(old)).error).toMatchObject({
      code: 'INVALID_REQUEST',
      details: { field: 'correctValue' },
    });
    for (const malformed of [[], [''], ['  '], [9], 'nine', Array.from({ length: 11 }, String)]) {
      const response = await ask({ correctValues: malformed });
      expect(response.status, JSON.stringify(malformed)).toBe(400);
      expect((await body(response)).error.details).toMatchObject({ field: 'correctValues' });
    }
    expect(await harness.count('SELECT count(*) AS n FROM teaching_package_agent_ops')).toBe(0);

    const done = await ask({ correctValues: ['9', ' 9.0 ', 'تسعة'] });
    expect(done.status).toBe(200);
    expect((await body(done)).item).toMatchObject({ correct_value: '9' });
    const stored = questions(await harness.scene('quiz-1'))[2]!;
    expect(stored.answer).toEqual(['9', '9.0', 'تسعة']);
    expect(stored.hasAnswer).toBe(true);
  });

  it('refuses keying a short answer graded by a teacher or the model (422 QUIZ_ITEM_NOT_KEYED)', async () => {
    const scene = quizScene('quiz-1', 1);
    const graded = questions(scene)[2]!;
    graded.hasAnswer = false;
    delete graded.answer;
    graded.commentPrompt = 'قيّم خطوات الحل';
    harness = await setupHarness({ scenes: [scene] });
    const response = await harness.post('quiz-item-edit', {
      expectedRevision: await harness.revision(),
      sceneId: 'quiz-1',
      itemId: 'q3',
      correctValues: ['9'],
    });
    expect(response.status).toBe(422);
    expect((await body(response)).error.code).toBe('QUIZ_ITEM_NOT_KEYED');
    const stored = questions(await harness.scene('quiz-1'))[2]!;
    expect(stored.hasAnswer).toBe(false);
    expect(stored.answer).toBeUndefined();
    expect(await harness.count('SELECT count(*) AS n FROM teaching_package_agent_ops')).toBe(0);
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
    expect(await body(dry)).toMatchObject({
      dryRun: true,
      status: 'would_update',
      deleted: false,
      would_delete: true,
    });
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
