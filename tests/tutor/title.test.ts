import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAttempt } from '@/lib/persistence/teaching-model-attempts';
import {
  insertConversation,
  readConversation,
  updateConversationLessonAssociation,
  updateConversationTitle,
  type TutorConversation,
} from '@/lib/persistence/tutor-runtime';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import type { ResolvedSubjectPolicy } from '@/lib/server/teaching-model/resolve-policy';
import { countTokens } from '@/lib/server/tutor/token-budget';
import {
  ensureConversationTitle,
  keywordTitle,
  sanitizeTitle,
  TITLE_INPUT_TOKEN_CAP,
} from '@/lib/server/tutor/title';

import { asConnectable, createTutorPool, ok, RecordingPool, STUDENT_REF, T0_MS } from './tutor-test-harness';

/**
 * Automatic titles (CHAT-02; plan §8.5, P6 `title.test.ts`): Primary →
 * Fallback → pending; retry on the next turn; lesson title and topic suffix;
 * the bounded call goes through the executor and stays ≤ 300 input tokens.
 */

const mocks = vi.hoisted(() => ({ callLLM: vi.fn(), streamLLM: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM, streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', async () => {
  const providers = await import('@/lib/ai/providers');
  return {
    resolveModel: async ({ modelString }: { modelString: string }) => {
      const { providerId, modelId } = providers.parseModelString(modelString);
      return { model: { provider: providerId, modelId }, modelInfo: providers.getModelInfo(providerId, modelId), modelString, providerId, modelId, apiKey: 'k' };
    },
  };
});
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

function apiError(statusCode: number) {
  return new APICallError({ message: `HTTP ${statusCode}`, url: 'https://provider.example', requestBodyValues: {}, statusCode, isRetryable: true });
}

const ACADEMIC = {
  subjectNameAr: 'الرياضيات',
  subjectNameEn: 'Mathematics',
  curriculumName: 'المنهج الوطني',
  curriculumVersionLabel: '2026',
  gradeLabel: 'الصف التاسع',
  academicLanguage: 'ar',
};
const FIRST_TURN = { student: 'ما هو التبرير الاستقرائي في الرياضيات؟', tutor: 'التبرير الاستقرائي هو استنتاج قاعدة عامة من أمثلة متكررة.' };
const NOW_S = T0_MS / 1000;

describe('ensureConversationTitle', () => {
  let pool: RecordingPool;
  let policy: ResolvedSubjectPolicy;
  let ids = 0;
  const executor = () => ({ queryable: pool, rateCard: BASE_RATE_CARD, completionRetryDelaysMs: [0, 0, 0], idFactory: () => `tma-${++ids}`, workerId: 'host:1:test', now: () => T0_MS });

  async function conversation(id = 'conv-1'): Promise<TutorConversation> {
    return insertConversation(pool, {
      id,
      tenantId: '1',
      studentRef: STUDENT_REF,
      subjectCode: 'MATH',
      subjectOfferingId: '10',
      subjectName: 'الرياضيات',
      academic: { ...ACADEMIC },
      now: NOW_S,
    });
  }

  const title = (c: TutorConversation, firstTurn = FIRST_TURN) =>
    ensureConversationTitle({ pool: asConnectable(pool), conversation: c, policy, turnId: 'turn-1', firstTurn, academic: ACADEMIC, executor: executor(), now: NOW_S });

  beforeEach(async () => {
    mocks.callLLM.mockReset();
    ids = 0;
    pool = await createTutorPool();
    const { resolveSubjectModelPolicy } = await import('@/lib/server/teaching-model/resolve-policy');
    policy = await resolveSubjectModelPolicy('MATH');
  });

  afterEach(async () => {
    await pool.end();
  });

  it('Primary fails → Fallback produces the topic; the call is ≤ 300 input tokens, stage free-chat-title, two ledger rows', async () => {
    mocks.callLLM.mockRejectedValueOnce(apiError(429)).mockResolvedValueOnce(ok('"التبرير الاستقرائي في الرياضيات".'));
    const c = await conversation();
    const outcome = await title(c);
    expect(outcome).toEqual({ title: 'التبرير الاستقرائي في الرياضيات', titleSource: 'topic', changed: true });
    expect((await readConversation(pool, c.id))!).toMatchObject({ title: 'التبرير الاستقرائي في الرياضيات', titleSource: 'topic' });
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    const [params, stage] = mocks.callLLM.mock.calls[0]!;
    expect(stage).toBe('free-chat-title');
    expect(countTokens(params.messages, 'proxy', 'qwen:qwen3.7-flash')).toBeLessThanOrEqual(TITLE_INPUT_TOKEN_CAP);
    expect(countTokens(params.messages, 'exact', 'openai:gpt-5-nano')).toBeLessThanOrEqual(TITLE_INPUT_TOKEN_CAP);
    expect(params.messages[params.messages.length - 1]).toEqual({ role: 'user', content: 'Title:' });
    const [primary, fallback] = [await readAttempt(pool, 'tma-1'), await readAttempt(pool, 'tma-2')];
    expect(primary).toMatchObject({ stage: 'free-chat-title', capability: 'free_chat', role: 'primary', outcome: 'rate_limited', conversation_id: 'conv-1', turn_id: 'turn-1', budget_effective_cap: 30_080 });
    expect(primary!.budget_estimate_tokens).toBeLessThanOrEqual(TITLE_INPUT_TOKEN_CAP);
    expect(fallback).toMatchObject({ role: 'fallback', outcome: 'succeeded' });
  });

  it('both routes fail → keyword title with `pending`; retried on the next turn; a second failure settles on `fallback`', async () => {
    mocks.callLLM.mockRejectedValue(apiError(503));
    const c = await conversation();
    expect(await title(c)).toEqual({ title: 'التبرير الاستقرائي الرياضيات', titleSource: 'pending', changed: true });
    // Next turn, still failing → fallback (final).
    expect(await title((await readConversation(pool, c.id))!)).toMatchObject({ titleSource: 'fallback', changed: true });
    mocks.callLLM.mockReset().mockResolvedValue(ok('عنوان'));
    expect(await title((await readConversation(pool, c.id))!)).toMatchObject({ changed: false });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('a pending title is retried on the next turn and becomes a topic when a route recovers', async () => {
    mocks.callLLM.mockRejectedValueOnce(apiError(503)).mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce(ok('الأنماط العددية'));
    const c = await conversation();
    expect((await title(c)).titleSource).toBe('pending');
    expect(await title((await readConversation(pool, c.id))!)).toEqual({ title: 'الأنماط العددية', titleSource: 'topic', changed: true });
  });

  it('a confident lesson association names the conversation after the official lesson title (no model call)', async () => {
    const c = await conversation();
    await updateConversationLessonAssociation(pool, c.id, { learningItemType: 'lesson', learningItemId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.7, associatedAtSeq: 1 }, NOW_S);
    expect(await title((await readConversation(pool, c.id))!)).toEqual({ title: 'قانون حفظ الكتلة', titleSource: 'lesson', changed: true });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('a second conversation on the same lesson gets a topic suffix; numbering only when the topic call fails', async () => {
    const first = await conversation('conv-1');
    await updateConversationLessonAssociation(pool, first.id, { learningItemType: 'lesson', learningItemId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.7, associatedAtSeq: 1 }, NOW_S);
    await updateConversationTitle(pool, first.id, { title: 'قانون حفظ الكتلة', titleSource: 'lesson', now: NOW_S });

    const second = await conversation('conv-2');
    await updateConversationLessonAssociation(pool, second.id, { learningItemType: 'lesson', learningItemId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.8, associatedAtSeq: 1 }, NOW_S);
    mocks.callLLM.mockResolvedValueOnce(ok('مسائل'));
    expect(await title((await readConversation(pool, second.id))!)).toEqual({ title: 'قانون حفظ الكتلة — مسائل', titleSource: 'lesson_suffix', changed: true });

    const third = await conversation('conv-3');
    await updateConversationLessonAssociation(pool, third.id, { learningItemType: 'lesson', learningItemId: 'L1', lessonTitle: 'قانون حفظ الكتلة', confidence: 0.8, associatedAtSeq: 1 }, NOW_S);
    mocks.callLLM.mockRejectedValue(apiError(503));
    expect(await title((await readConversation(pool, third.id))!)).toEqual({ title: 'قانون حفظ الكتلة — 3', titleSource: 'lesson_suffix', changed: true });
  });

  it('a later lesson match replaces a topic title but never a lesson-based one', async () => {
    mocks.callLLM.mockResolvedValueOnce(ok('موضوع'));
    const c = await conversation();
    expect((await title(c)).titleSource).toBe('topic');
    await updateConversationLessonAssociation(pool, c.id, { learningItemType: 'lesson', learningItemId: 'L2', lessonTitle: 'المتتابعات', confidence: 0.9, associatedAtSeq: 3 }, NOW_S);
    expect(await title((await readConversation(pool, c.id))!)).toEqual({ title: 'المتتابعات', titleSource: 'lesson', changed: true });
    expect(await title((await readConversation(pool, c.id))!)).toMatchObject({ changed: false, title: 'المتتابعات' });
  });
});

describe('sanitizeTitle / keywordTitle', () => {
  it('strips quotes, prefixes and trailing punctuation; caps at 6 words', () => {
    expect(sanitizeTitle('Title: "Inductive reasoning basics".')).toBe('Inductive reasoning basics');
    expect(sanitizeTitle('العنوان: «قانون حفظ الكتلة»')).toBe('قانون حفظ الكتلة');
    expect(sanitizeTitle('one two three four five six seven eight')).toBe('one two three four five six');
    expect(sanitizeTitle('\n\n')).toBeNull();
  });

  it('keywordTitle takes the first content keywords', () => {
    expect(keywordTitle('what is the law of conservation of mass please')).toBe('law conservation mass');
    expect(keywordTitle('شكرا')).toBeNull();
  });
});
