import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readConversation,
  readMessageByClientId,
  readTurnGrounding,
} from '@/lib/persistence/tutor-runtime';
import { resetLedgerRetryQueueForTests } from '@/lib/server/teaching-model/ledger-retry-queue';
import { BASE_RATE_CARD } from '@/lib/server/teaching-model/rate-card';
import { awaitTutorBackgroundTasks } from '@/lib/server/tutor/conversation-service';
import { isShadowSampled } from '@/lib/server/tutor/grounding/grounding-config';
import {
  compareShadow,
  pendingShadowCount,
  recordShadowComparison,
} from '@/lib/server/tutor/grounding/shadow-grounding';
import {
  KafuoIntegrationError,
  type GroundingSearchResponse,
} from '@/lib/server/tutor/kafuo-integration-client';
import { resetTurnRateLimitForTests } from '@/lib/server/tutor/rate-limit';
import {
  setTutorRuntimeDepsForTests,
  type TutorRuntimeDeps,
} from '@/lib/server/tutor/runtime-deps';

import {
  candidate,
  fakeGroundingReader,
  found,
  single,
  unitRow,
  type FakeGrounding,
} from './fake-grounding-reader';
import {
  asConnectable,
  createTutorPool,
  fakeKafuo,
  ok,
  readSse,
  RecordingPool,
  studentBearer,
  T0_MS,
  textStream,
  type FakeKafuo,
} from './tutor-test-harness';

/**
 * `TUTOR_GROUNDING_SOURCE=shadow` (discovery-first P6): the `kafuo_http` path
 * serves the turn; a sampled retrieve turn also runs the direct path in the
 * background and its comparison lands in `tutor_turn_groundings.resolution`.
 * Whatever the direct side does — retrieve other units, throw, refuse scope,
 * report busy — the student's reply, SSE frames, snapshot, association and
 * metering are byte-for-byte those of `kafuo_http`.
 */

const mocks = vi.hoisted(() => ({ callLLM: vi.fn(), streamLLM: vi.fn(), events: [] as string[] }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM, streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', async () => {
  const providers = await import('@/lib/ai/providers');
  return {
    resolveModel: async ({ modelString }: { modelString: string }) => {
      const { providerId, modelId } = providers.parseModelString(modelString);
      return {
        model: { provider: providerId, modelId },
        modelInfo: providers.getModelInfo(providerId, modelId),
        modelString,
        providerId,
        modelId,
        apiKey: 'k',
      };
    },
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const SERVICE_KEY = 'grounding-shadow-svc-key';
const QUESTION = 'ما تعريف الكتلة حسب المنهج؟';
const HTTP_RESPONSE: GroundingSearchResponse = {
  units: [
    {
      contentUnitId: '3279',
      lessonId: 'L1',
      lessonTitle: 'الكتلة',
      unitTitle: 'تعريف',
      text: 'الكتلة مقدار المادة في الجسم.',
      charLength: 28,
      score: 0.9,
    },
    {
      contentUnitId: '4001',
      lessonId: 'L1',
      lessonTitle: 'الكتلة',
      unitTitle: 'وحدات',
      text: 'تقاس الكتلة بالكيلوجرام.',
      charLength: 24,
      score: 0.8,
    },
  ],
  lessonMatch: { lessonId: 'L1', lessonTitle: 'الكتلة', confidence: 0.7 },
  truncated: false,
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });
function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: studentBearer() },
    body: JSON.stringify(body),
  });
}

describe('shadow grounding (discovery-first P6)', () => {
  let pool: RecordingPool;
  let kafuo: FakeKafuo;
  let grounding: FakeGrounding;
  let ids: number;
  let baseDeps: TutorRuntimeDeps;

  async function createConversation(clientRequestId: string) {
    const { POST } = await import('@/app/api/tutor/conversations/route');
    const response = await POST(
      request('/api/tutor/conversations', { subjectCode: 'MATH', clientRequestId }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  async function send(conversationId: string, clientMessageId: string, text = QUESTION) {
    const { POST } = await import('@/app/api/tutor/conversations/[id]/messages/route');
    return POST(
      request(`/api/tutor/conversations/${conversationId}/messages`, { clientMessageId, text }),
      params(conversationId),
    );
  }

  const auditOf = async (conversationId: string, clientMessageId: string) => {
    const student = (await readMessageByClientId(pool, conversationId, clientMessageId))!;
    return (await readTurnGrounding(pool, student.turnId))!;
  };

  /** What the student and Kafuo see of one turn (ids that differ per conversation stripped). */
  async function observe(conversationId: string, clientMessageId: string) {
    const llmCallsBefore = mocks.streamLLM.mock.calls.length;
    const reservesBefore = kafuo.reserve.mock.calls.length;
    const finalizesBefore = kafuo.finalize.mock.calls.length;
    const searchesBefore = kafuo.groundingSearch.mock.calls.length;
    const response = await send(conversationId, clientMessageId);
    const frames = await readSse(response);
    await awaitTutorBackgroundTasks();
    const conversation = (await readConversation(pool, conversationId))!;
    const strip = (data: unknown) =>
      JSON.parse(JSON.stringify(data ?? null), (key, value) =>
        ['turnId', 'messageId', 'id', 'conversationId', 'reservationId', 'createdAt'].includes(key)
          ? undefined
          : value,
      );
    return {
      status: response.status,
      frames: frames.map((frame) => ({ event: frame.event, data: strip(frame.data) })),
      prompt: mocks.streamLLM.mock.calls.slice(llmCallsBefore).map((call) => call[0].messages),
      reserves: kafuo.reserve.mock.calls.length - reservesBefore,
      finalizes: kafuo.finalize.mock.calls.length - finalizesBefore,
      searches: kafuo.groundingSearch.mock.calls
        .slice(searchesBefore)
        .map((call) => ({ ...call[0] })),
      snapshot: strip({ ...conversation.grounding, setAtSeq: undefined, lastUsedSeq: undefined }),
      association: strip(conversation.lessonAssociation),
    };
  }

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    vi.stubEnv('DATABASE_URL', 'postgres://grounding-shadow-test');
    vi.stubEnv('TUTOR_COMPACTION_ENABLED', 'false');
    mocks.callLLM.mockReset();
    mocks.streamLLM.mockReset();
    mocks.events.length = 0;
    resetLedgerRetryQueueForTests();
    resetTurnRateLimitForTests();
    ids = 0;
    pool = await createTutorPool(mocks.events);
    kafuo = fakeKafuo(mocks.events);
    kafuo.groundingSearch.mockResolvedValue(HTTP_RESPONSE);
    grounding = fakeGroundingReader(mocks.events);
    mocks.callLLM.mockImplementation(async () => ok('الكتلة'));
    mocks.streamLLM.mockImplementation(() => textStream('الكتلة هي مقدار المادة.'));
    baseDeps = {
      pool: asConnectable(pool),
      kafuo: kafuo.client,
      now: () => T0_MS + ids * 1000,
      workerId: 'host:1:shadow',
      idFactory: () => `id-${++ids}`,
      executor: {
        rateCard: BASE_RATE_CARD,
        completionRetryDelaysMs: [0, 0, 0],
        idFactory: () => `tma-${++ids}`,
      },
      heartbeatMs: 0,
      completionTxRetryDelaysMs: [0, 0],
      grounding: grounding.deps,
    };
    setTutorRuntimeDepsForTests(baseDeps);
  });

  afterEach(async () => {
    setTutorRuntimeDepsForTests(undefined);
    await awaitTutorBackgroundTasks();
    await pool.end();
  });

  const DIRECT_BEHAVIOURS: Array<[string, (g: FakeGrounding) => void, Record<string, unknown>]> = [
    [
      'retrieves different units',
      (g) => {
        g.queue('resolveItems', single(candidate('612', 'المثال المضاد', 'SECTION')));
        g.queue(
          'searchUnits',
          found(unitRow('3279', '612', 'نص'), unitRow('9999', '612', 'نص آخر')),
        );
      },
      { outcome: 'retrieved', unitIds: ['3279', '9999'], itemIds: ['612'] },
    ],
    [
      'throws',
      (g) => g.queue('resolveItems', new Error('reader exploded')),
      { outcome: 'insufficient', reason: 'retrieval_unavailable' },
    ],
    [
      'refuses scope',
      (g) => g.queue('resolveItems', { outcome: 'student_ref_unknown' }),
      { outcome: 'refused', reason: 'scope_refused' },
    ],
    [
      'is busy',
      (g) => g.queue('resolveItems', { outcome: 'retrieval_busy' }),
      { outcome: 'insufficient', reason: 'retrieval_busy' },
    ],
  ];

  it.each(DIRECT_BEHAVIOURS)(
    'shadow never changes the reply when the direct side %s',
    async (_label, arrange, expectedDirect) => {
      const httpConversation = await createConversation('cr-http');
      const reference = await observe(httpConversation, 'cm-1');
      expect(reference.frames.map((f) => f.event)).toEqual([
        'turn_start',
        'grounding',
        'text_delta',
        'done',
        'title',
      ]);
      expect(grounding.mocks.resolveItems).not.toHaveBeenCalled();

      const referenceAudit = await auditOf(httpConversation, 'cm-1');
      expect(referenceAudit.resolution).toBeNull();
      expect(referenceAudit.source).toBe('kafuo_http');

      // The same turn on a fresh, identical world (titles are de-duplicated per
      // student, so a second conversation in the same world would differ anyway).
      await pool.end();
      pool = await createTutorPool(mocks.events);
      ids = 0;
      setTutorRuntimeDepsForTests({ ...baseDeps, pool: asConnectable(pool) });
      vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'shadow');
      vi.stubEnv('TUTOR_GROUNDING_SHADOW_SAMPLE', '1');
      arrange(grounding);
      const shadowConversation = await createConversation('cr-http');
      const shadowed = await observe(shadowConversation, 'cm-1');

      expect(shadowed).toEqual(reference);
      expect(grounding.mocks.resolveItems).toHaveBeenCalledTimes(1);

      // The comparison landed in the shadow turn's audit, after the commit.
      const audit = await auditOf(shadowConversation, 'cm-1');
      expect(audit.source).toBe('shadow');
      expect(audit.mode).toBe('retrieved');
      expect(audit.resolution).toMatchObject({
        shadow: 'compared',
        shadowComparison: {
          sampleRate: 1,
          http: {
            outcome: 'retrieved',
            reason: null,
            unitIds: ['3279', '4001'],
            lessonIds: ['L1'],
          },
          direct: expectedDirect,
        },
      });
      expect(pendingShadowCount()).toBe(0);
    },
  );

  it('the turn never waits for the direct side: done arrives while it still hangs', async () => {
    const httpConversation = await createConversation('cr-http');
    const reference = await observe(httpConversation, 'cm-1');

    await pool.end();
    pool = await createTutorPool(mocks.events);
    ids = 0;
    setTutorRuntimeDepsForTests({ ...baseDeps, pool: asConnectable(pool) });
    vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'shadow');
    vi.stubEnv('TUTOR_GROUNDING_SHADOW_SAMPLE', '1');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    grounding.mocks.resolveItems.mockImplementationOnce(async () => {
      await gate;
      return single(candidate('612', 'المثال المضاد', 'SECTION'));
    });
    grounding.queue('searchUnits', found(unitRow('3279', '612', 'نص')));
    const id = await createConversation('cr-http');
    const llmCallsBefore = mocks.streamLLM.mock.calls.length;
    const frames = await readSse(await send(id, 'cm-1'));

    // The stream finished and the turn committed with the gate still closed.
    expect(grounding.mocks.resolveItems).toHaveBeenCalledTimes(1);
    expect(frames.map((f) => f.event)).toEqual(reference.frames.map((f) => f.event));
    expect(frames.at(-2)!.event).toBe('done');
    expect(
      mocks.streamLLM.mock.calls.slice(llmCallsBefore).map((call) => call[0].messages),
    ).toEqual(reference.prompt);
    expect((await auditOf(id, 'cm-1')).resolution).toEqual({ shadow: 'pending' });
    const conversation = (await readConversation(pool, id))!;
    expect(conversation.grounding?.source).toBe('kafuo_http');
    expect(conversation.grounding?.units.map((unit) => unit.unitId)).toEqual(['3279', '4001']);
    expect(pendingShadowCount()).toBe(0);

    // Opening the gate lets the comparison land afterwards.
    release();
    await awaitTutorBackgroundTasks();
    expect((await auditOf(id, 'cm-1')).resolution).toMatchObject({
      shadow: 'compared',
      shadowComparison: {
        direct: { outcome: 'retrieved', unitIds: ['3279'] },
        overlap: { units: { both: 1 }, items: { pairs: [['L1', '612']] } },
      },
    });
  });

  it('records unit and item overlap; nothing but ids, outcomes, counts and timings', async () => {
    vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'shadow');
    vi.stubEnv('TUTOR_GROUNDING_SHADOW_SAMPLE', '1');
    grounding.queue('resolveItems', single(candidate('612', 'المثال المضاد', 'SECTION')));
    grounding.queue(
      'searchUnits',
      found(unitRow('3279', '612', 'نص الوحدة السري'), unitRow('9999', '612', 'نص آخر سري')),
    );
    grounding.queue('embed', {
      outcome: 'ok',
      vector: [0.123456789, 0.987654321, 0.5, 0.5],
      tokens: 9,
    });
    const id = await createConversation('cr-1');
    await readSse(await send(id, 'cm-1'));
    await awaitTutorBackgroundTasks();
    const audit = await auditOf(id, 'cm-1');
    const comparison = (audit.resolution as { shadowComparison: Record<string, unknown> })
      .shadowComparison;
    expect(comparison).toMatchObject({
      overlap: {
        units: { both: 1, httpOnly: 1, directOnly: 1, jaccard: 0.333 },
        // Unit 3279 is lesson L1 on the HTTP side and item 612 on the direct side.
        items: {
          directItems: 1,
          httpLessons: 1,
          directItemsWithSharedUnits: 1,
          httpLessonsWithSharedUnits: 1,
          pairs: [['L1', '612']],
        },
        groundedAgrees: true,
      },
      direct: {
        outcome: 'retrieved',
        resolutionOutcome: 'single',
        candidateItemIds: ['612'],
        embeddingModel: 'text-embedding-3-small',
      },
    });
    const serialized = JSON.stringify(audit.resolution);
    for (const forbidden of [
      'نص الوحدة السري',
      'المثال المضاد',
      QUESTION,
      'الكتلة مقدار',
      '0.123456789',
      '0.987654321',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect((comparison.direct as { timings: Record<string, number> }).timings).toMatchObject({
      poolWaitMs: expect.any(Number),
      resolveMs: expect.any(Number),
      embedMs: expect.any(Number),
      searchMs: expect.any(Number),
    });
  });

  it('unsampled turns record not_sampled and never touch the reader; reuse / none turns never shadow', async () => {
    vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'shadow');
    vi.stubEnv('TUTOR_GROUNDING_SHADOW_SAMPLE', '0');
    const id = await createConversation('cr-1');
    await readSse(await send(id, 'cm-1'));
    await awaitTutorBackgroundTasks();
    expect(await auditOf(id, 'cm-1')).toMatchObject({
      source: 'shadow',
      resolution: { shadow: 'not_sampled' },
    });
    expect(grounding.mocks.resolveItems).not.toHaveBeenCalled();

    vi.stubEnv('TUTOR_GROUNDING_SHADOW_SAMPLE', '1');
    await readSse(await send(id, 'cm-2', 'ليه؟ بسّط أكتر'));
    await readSse(await send(id, 'cm-3', 'شكرا'));
    await awaitTutorBackgroundTasks();
    expect((await auditOf(id, 'cm-2')).assessment).toMatchObject({ decision: 'reuse' });
    expect((await auditOf(id, 'cm-2')).resolution).toBeNull();
    expect((await auditOf(id, 'cm-3')).resolution).toBeNull();
    expect(grounding.mocks.resolveItems).not.toHaveBeenCalled();
    expect(grounding.mocks.embed).not.toHaveBeenCalled();
  });

  it('a scope refusal on the HTTP path still refuses the turn (D-18); the shadow job ends without waiting for a commit', async () => {
    vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'shadow');
    vi.stubEnv('TUTOR_GROUNDING_SHADOW_SAMPLE', '1');
    kafuo.groundingSearch.mockRejectedValueOnce(
      new KafuoIntegrationError('refused', 404, 'student_ref_unknown'),
    );
    const id = await createConversation('cr-1');
    const response = await send(id, 'cm-1');
    expect(response.status).toBe(403);
    const startedAt = performance.now();
    await awaitTutorBackgroundTasks();
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(pendingShadowCount()).toBe(0);
  });

  it('a late comparison from attempt 1 never overwrites the audit row of attempt 2', async () => {
    vi.stubEnv('TUTOR_GROUNDING_SOURCE', 'shadow');
    vi.stubEnv('TUTOR_GROUNDING_SHADOW_SAMPLE', '0');
    const id = await createConversation('cr-1');
    await readSse(await send(id, 'cm-1'));
    const student = (await readMessageByClientId(pool, id, 'cm-1'))!;
    const comparison = compareShadow(
      1,
      {
        outcome: 'retrieved',
        reason: null,
        unitIds: ['1'],
        unitLessonIds: ['L9'],
        lessonIds: ['L9'],
        ms: 1,
      },
      {
        outcome: 'insufficient',
        reason: 'no_match',
        resolutionOutcome: 'no_match',
        candidateItemIds: [],
        itemIds: [],
        unitIds: [],
        unitItemIds: [],
        embeddingModel: null,
        timings: null,
        ms: 1,
      },
    );
    expect(await recordShadowComparison(pool, student.turnId, 2, 'compared', comparison)).toBe(
      false,
    );
    expect((await auditOf(id, 'cm-1')).resolution).toEqual({ shadow: 'not_sampled' });
    expect(await recordShadowComparison(pool, student.turnId, 1, 'compared', comparison)).toBe(
      true,
    );
    expect((await auditOf(id, 'cm-1')).resolution).toMatchObject({
      shadow: 'compared',
      shadowComparison: { overlap: { units: { both: 0, httpOnly: 1, directOnly: 0, jaccard: 0 } } },
    });
  });
});

describe('isShadowSampled', () => {
  it('is deterministic per turn id and tracks the rate', () => {
    expect(isShadowSampled('turn-1', 0)).toBe(false);
    expect(isShadowSampled('turn-1', 1)).toBe(true);
    expect(isShadowSampled('turn-x', 0.5)).toBe(isShadowSampled('turn-x', 0.5));
    const sampled = Array.from({ length: 2_000 }, (_, i) =>
      isShadowSampled(`turn-${i}`, 0.1),
    ).filter(Boolean).length;
    expect(sampled).toBeGreaterThan(140);
    expect(sampled).toBeLessThan(260);
  });
});
