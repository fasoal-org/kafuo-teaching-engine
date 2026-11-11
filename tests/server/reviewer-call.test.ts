import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { ensureDocumentSchema, ensureStageMetaSchema } from '../teaching-package/helpers';

/**
 * The reviewer's provider switch (ai-reviewer-layer plan D-3, §4.5, O-2), on a
 * real PGlite database with a fake executor: no provider is ever called.
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return { query: (t: string, p?: unknown[]) => this.db.query(t, p), release() {} };
  }
  async end() {
    await this.db.close();
  }
}

const OPUS = 'anthropic:claude-opus-5-5';
const SOL = 'openai:gpt-6-sol';
const DAY = 24 * 60 * 60 * 1000;

describe('runReviewerCall — provider switch', () => {
  let pool: PGlitePool;
  let t = 1_800_000_000_000;
  const resolveRoute = vi.fn(async (_subject: string, mode: 'opus' | 'sol') => ({
    policy: {
      subjectCode: 'MATH',
      policyVersion: 'reviewer-2026-11',
      primary: { role: 'primary', modelString: mode === 'opus' ? OPUS : SOL },
      fallback: { role: 'fallback', modelString: SOL },
    },
    primaryOnly: mode === 'sol',
  }));

  const input = () => ({
    pool: pool as unknown as ConnectableQueryable,
    tenantId: 't-1',
    subjectCode: 'MATH',
    capability: 'package_review' as const,
    stage: 'package-review',
    association: { kind: 'generation' as const, generationAttemptId: 'ga-1', reviewId: 'tpr-1' },
    aggregate: { tenantId: 't-1', learningItem: { type: 'lesson' as const, id: '429' } },
    system: 's',
    prompt: 'p',
    output: { kind: 'json' as const, validate: (x: string) => JSON.parse(x) as unknown },
  });

  const served = (
    outcomes: Array<{ role: 'primary' | 'fallback'; outcome: string; modelString: string }>,
  ) =>
    vi.fn(async () => ({
      text: '{}',
      parsed: {},
      servedBy: outcomes[outcomes.length - 1]!.role,
      attemptIds: outcomes.map((_, i) => `tma-${i}`),
      outcomes,
      usage: null,
      timings: { startedAt: t, ttftMs: null, totalMs: 1, primaryFailureMs: null },
    }));

  const events = async () =>
    (
      await pool.query(
        `SELECT event_type, payload FROM teaching_package_webhook_deliveries ORDER BY sequence`,
      )
    ).rows as Array<{ event_type: string; payload: { switch: Record<string, unknown> } }>;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    const { ensureTeachingPackageSchema } = await import('@/lib/persistence/teaching-package');
    await ensureTeachingPackageSchema(pool as never);
    resolveRoute.mockClear();
  });

  afterEach(async () => {
    await pool.end();
  });

  it('no state row → Opus primary / Sol fallback, nothing switched', async () => {
    const { runReviewerCall } = await import('@/lib/server/teaching-model/reviewer-call');
    const executeStream = served([{ role: 'primary', outcome: 'succeeded', modelString: OPUS }]);
    const result = await runReviewerCall(input(), {
      now: () => t,
      resolveRoute: resolveRoute as never,
      executeStream: executeStream as never,
    });
    expect(resolveRoute).toHaveBeenCalledWith('MATH', 'opus');
    expect(result).toMatchObject({ provider: 'anthropic', modelString: OPUS, switched: null });
    const [, , params, , options] = executeStream.mock.calls[0] as unknown as [
      unknown,
      unknown,
      Record<string, unknown>,
      unknown,
      Record<string, unknown>,
    ];
    // D-4: 64k, the route's targets carry no smaller output window here.
    expect(params.maxOutputTokens).toBe(64_000);
    expect(options).toMatchObject({ fallbackOnRefusal: true, primaryOnly: false });
    expect(options.timeoutMs).toBeGreaterThan(110_000);
    expect(await events()).toEqual([]);
  });

  it('item 5: the caller’s abort signal reaches the executor’s call context', async () => {
    const { runReviewerCall } = await import('@/lib/server/teaching-model/reviewer-call');
    const executeStream = served([{ role: 'primary', outcome: 'succeeded', modelString: OPUS }]);
    const controller = new AbortController();
    await runReviewerCall(
      { ...input(), signal: controller.signal },
      { now: () => t, resolveRoute: resolveRoute as never, executeStream: executeStream as never },
    );
    const [, ctx] = executeStream.mock.calls[0] as unknown as [unknown, { signal?: AbortSignal }];
    expect(ctx.signal).toBe(controller.signal);
    // Without one, no signal is set.
    await runReviewerCall(input(), {
      now: () => t,
      resolveRoute: resolveRoute as never,
      executeStream: executeStream as never,
    });
    const [, plain] = executeStream.mock.calls[1] as unknown as [unknown, { signal?: AbortSignal }];
    expect(plain.signal).toBeUndefined();
  });

  it('Opus credit exhausted → served by Sol, ONE switch row + ONE signed event; later reviews go to Sol only', async () => {
    const { runReviewerCall } = await import('@/lib/server/teaching-model/reviewer-call');
    const exhausted = [
      { role: 'primary' as const, outcome: 'provider_credit_exhausted', modelString: OPUS },
      { role: 'fallback' as const, outcome: 'succeeded', modelString: SOL },
    ];
    const first = await runReviewerCall(input(), {
      now: () => t,
      resolveRoute: resolveRoute as never,
      executeStream: served(exhausted) as never,
    });
    expect(first.provider).toBe('openai');
    expect(first.switched).toMatchObject({ activeProvider: 'openai', reason: 'credit_exhausted' });

    // A concurrent review that also met the exhausted credit emits nothing more.
    const second = await runReviewerCall(input(), {
      now: () => t,
      resolveRoute: resolveRoute as never,
      executeStream: served(exhausted) as never,
    });
    expect(second.switched).toBeNull();

    const sent = await events();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event_type: 'teaching_engine.reviewer_provider_switched',
      payload: {
        switch: {
          activeProvider: 'openai',
          previousProvider: 'anthropic',
          model: SOL,
          reason: 'credit_exhausted',
          switchedAt: t,
          nextProbeAt: t + DAY,
        },
      },
    });

    resolveRoute.mockClear();
    t += 60_000;
    await runReviewerCall(input(), {
      now: () => t,
      resolveRoute: resolveRoute as never,
      executeStream: served([{ role: 'primary', outcome: 'succeeded', modelString: SOL }]) as never,
    });
    expect(resolveRoute).toHaveBeenCalledWith('MATH', 'sol');
  });

  it('O-2: after 24 h one review probes Opus; Opus answering switches back and emits the event', async () => {
    const { runReviewerCall } = await import('@/lib/server/teaching-model/reviewer-call');
    const { readReviewerProviderState } =
      await import('@/lib/server/teaching-model/reviewer-provider-state');
    await runReviewerCall(input(), {
      now: () => t,
      resolveRoute: resolveRoute as never,
      executeStream: served([
        { role: 'primary', outcome: 'provider_credit_exhausted', modelString: OPUS },
        { role: 'fallback', outcome: 'succeeded', modelString: SOL },
      ]) as never,
    });
    t += DAY + 1;
    resolveRoute.mockClear();
    const probe = await runReviewerCall(input(), {
      now: () => t,
      resolveRoute: resolveRoute as never,
      executeStream: served([
        { role: 'primary', outcome: 'succeeded', modelString: OPUS },
      ]) as never,
    });
    expect(resolveRoute).toHaveBeenCalledWith('MATH', 'opus');
    expect(probe.switched).toMatchObject({
      activeProvider: 'anthropic',
      reason: 'probe_succeeded',
    });
    expect((await readReviewerProviderState(pool as never)).activeProvider).toBe('anthropic');
    const sent = await events();
    expect(sent.map((e) => e.payload.switch.activeProvider)).toEqual(['openai', 'anthropic']);
  });

  it('O-2: a failed probe stays on Sol for another 24 h, and only one review claims the probe', async () => {
    const { runReviewerCall } = await import('@/lib/server/teaching-model/reviewer-call');
    const { chooseReviewerRoute, readReviewerProviderState } =
      await import('@/lib/server/teaching-model/reviewer-provider-state');
    await runReviewerCall(input(), {
      now: () => t,
      resolveRoute: resolveRoute as never,
      executeStream: served([
        { role: 'primary', outcome: 'provider_credit_exhausted', modelString: OPUS },
        { role: 'fallback', outcome: 'succeeded', modelString: SOL },
      ]) as never,
    });
    t += DAY + 1;
    expect(await chooseReviewerRoute(pool as never, t)).toEqual({ mode: 'opus', probe: true });
    // The claim moved next_probe_at: a second review at the same moment stays on Sol.
    expect(await chooseReviewerRoute(pool as never, t)).toEqual({ mode: 'sol', probe: false });

    const probe = await runReviewerCall(input(), {
      now: () => t,
      chooseRoute: async () => ({ mode: 'opus', probe: true }),
      resolveRoute: resolveRoute as never,
      executeStream: served([
        { role: 'primary', outcome: 'provider_credit_exhausted', modelString: OPUS },
        { role: 'fallback', outcome: 'succeeded', modelString: SOL },
      ]) as never,
    });
    expect(probe.switched).toBeNull();
    const state = await readReviewerProviderState(pool as never);
    expect(state).toMatchObject({ activeProvider: 'openai', nextProbeAt: t + DAY });
    expect(await events()).toHaveLength(1);
  });

  it('both routes failing still settles the switch before the error propagates', async () => {
    const { runReviewerCall } = await import('@/lib/server/teaching-model/reviewer-call');
    const { TeachingModelUnavailableError } = await import('@/lib/server/teaching-model/execute');
    const executeStream = vi.fn(async () => {
      throw new TeachingModelUnavailableError('both failed', {
        attemptIds: ['a', 'b'],
        outcomes: [
          { role: 'primary', outcome: 'provider_credit_exhausted', modelString: OPUS },
          { role: 'fallback', outcome: 'provider_error', modelString: SOL },
        ],
        retryable: true,
      });
    });
    await expect(
      runReviewerCall(input(), {
        now: () => t,
        resolveRoute: resolveRoute as never,
        executeStream: executeStream as never,
      }),
    ).rejects.toMatchObject({ code: 'TEACHING_MODEL_UNAVAILABLE' });
    expect(await events()).toHaveLength(1);
  });
});

describe('resolveReviewerRoute — each target on its own', () => {
  const resolving =
    (unavailable: ReadonlySet<string>) =>
    async (role: 'primary' | 'fallback', target: { model: string }) => {
      if (unavailable.has(target.model)) throw new Error(`${target.model} has no key`);
      return { role, modelString: target.model } as never;
    };

  it('L-8: in sol mode a Sol that cannot resolve is replaced by Opus alone (never no review)', async () => {
    const { resolveReviewerRoute } = await import('@/lib/server/teaching-model/reviewer-policy');
    const route = await resolveReviewerRoute('MATH', 'sol', resolving(new Set([SOL])) as never);
    expect(route.primaryOnly).toBe(true);
    expect(route.policy.primary).toMatchObject({ role: 'primary', modelString: OPUS });
    expect(route.policy.fallback).toMatchObject({ modelString: OPUS });
  });

  it('sol mode with Sol resolving stays on Sol alone; nothing resolving still refuses', async () => {
    const { resolveReviewerRoute } = await import('@/lib/server/teaching-model/reviewer-policy');
    const onSol = await resolveReviewerRoute('MATH', 'sol', resolving(new Set()) as never);
    expect(onSol).toMatchObject({ primaryOnly: true, policy: { primary: { modelString: SOL } } });
    await expect(
      resolveReviewerRoute('MATH', 'sol', resolving(new Set([SOL, OPUS])) as never),
    ).rejects.toMatchObject({ code: 'SUBJECT_ROUTE_UNAVAILABLE' });
  });
});
