import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Kafuo R1 subject routing policy (contracts §1, plan §7.1).
 *
 * Four properties are pinned:
 *  1. the code-owned table equals the shared fixture
 *     `docs/frds/model_routing/subject-routing-table.v1.json` (both repos pin it);
 *  2. each target's thinking config reaches the provider wire in the shape the
 *     benchmarks used (`enable_thinking: false` for Qwen, `reasoning_effort`
 *     for OpenAI) — asserted on the real request body, not on providerOptions;
 *  3. an unknown code, or an unresolvable target, refuses with
 *     `SUBJECT_ROUTE_UNAVAILABLE` (422) — never a generic model;
 *  4. `MODEL_ROUTES` cannot shadow a policy target.
 */

// In-repo copy of `docs/frds/model_routing/subject-routing-table.v1.json` (the
// workspace docs folder is not under version control); Kafuo keeps the same copy.
const FIXTURE_PATH = path.resolve(
  process.cwd(),
  'tests',
  'fixtures',
  'subject-routing-table.v1.json',
);

interface FixtureTarget {
  model: string;
  thinking: Record<string, unknown>;
  label: string;
}
interface Fixture {
  policyVersion: string;
  subjects: Record<string, { primary: FixtureTarget; fallback: FixtureTarget }>;
}

function readFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
}

describe('SUBJECT_MODEL_POLICY — pinned to the shared fixture', () => {
  it('matches subject-routing-table.v1.json exactly (codes, models, thinking, labels, version)', async () => {
    const fixture = readFixture();
    const { POLICY_VERSION, SUBJECT_CODES, SUBJECT_MODEL_POLICY } =
      await import('@/lib/server/teaching-model/subject-policy');
    expect(POLICY_VERSION).toBe(fixture.policyVersion);
    expect([...SUBJECT_CODES].sort()).toEqual(Object.keys(fixture.subjects).sort());
    for (const code of SUBJECT_CODES) {
      const expected = fixture.subjects[code]!;
      const actual = SUBJECT_MODEL_POLICY[code];
      for (const role of ['primary', 'fallback'] as const) {
        expect(actual[role].model, `${code}.${role}.model`).toBe(expected[role].model);
        expect(actual[role].label, `${code}.${role}.label`).toBe(expected[role].label);
        expect({ ...actual[role].thinking }, `${code}.${role}.thinking`).toEqual(
          expected[role].thinking,
        );
      }
    }
  });

  it('is deep-frozen: no runtime path can mutate the policy', async () => {
    const { SUBJECT_MODEL_POLICY } = await import('@/lib/server/teaching-model/subject-policy');
    expect(Object.isFrozen(SUBJECT_MODEL_POLICY)).toBe(true);
    expect(Object.isFrozen(SUBJECT_MODEL_POLICY.MATH)).toBe(true);
    expect(Object.isFrozen(SUBJECT_MODEL_POLICY.MATH.primary)).toBe(true);
    expect(Object.isFrozen(SUBJECT_MODEL_POLICY.MATH.primary.thinking)).toBe(true);
  });

  it('isSubjectCode accepts exactly the six codes', async () => {
    const { isSubjectCode } = await import('@/lib/server/teaching-model/subject-policy');
    expect(isSubjectCode('MATH')).toBe(true);
    expect(isSubjectCode('CHEMISTRY')).toBe(true);
    expect(isSubjectCode('ENGLISH')).toBe(false);
    expect(isSubjectCode('math')).toBe(false);
    expect(isSubjectCode(null)).toBe(false);
  });

  it('routing mode defaults to enforced and only the literal "off" disables it', async () => {
    const { readRoutingMode } = await import('@/lib/server/teaching-model/subject-policy');
    expect(readRoutingMode({})).toBe('enforced');
    expect(readRoutingMode({ TEACHING_SUBJECT_ROUTING: 'off' })).toBe('off');
    expect(readRoutingMode({ TEACHING_SUBJECT_ROUTING: 'OFF ' })).toBe('off');
    // An unknown value must fail closed (ROUTE-01), never silently disable.
    expect(readRoutingMode({ TEACHING_SUBJECT_ROUTING: 'disabled' })).toBe('enforced');
  });

  it('counter kind: OpenAI is exact, everything else proxy', async () => {
    const { counterKindForProvider } = await import('@/lib/server/teaching-model/subject-policy');
    expect(counterKindForProvider('openai')).toBe('exact');
    expect(counterKindForProvider('qwen')).toBe('proxy');
  });
});

describe('resolveSubjectModelPolicy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
  });

  it('resolves both targets with their thinking, labels and registry metadata', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('QWEN_API_KEY', 'sk-qwen');
    const { resolveSubjectModelPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    const policy = await resolveSubjectModelPolicy('CHEMISTRY');
    expect(policy.subjectCode).toBe('CHEMISTRY');
    expect(policy.policyVersion).toBe('r1-2026-09');
    expect(policy.primary).toMatchObject({
      role: 'primary',
      modelString: 'qwen:qwen3.7-flash',
      providerId: 'qwen',
      modelId: 'qwen3.7-flash',
      thinking: { mode: 'disabled' },
      thinkingLabel: 'nothink',
      counterKind: 'proxy',
    });
    expect(policy.primary.modelInfo.capabilities?.vision).toBe(false);
    expect(policy.primary.modelInfo.outputWindow).toBeGreaterThan(0);
    expect(policy.fallback).toMatchObject({
      role: 'fallback',
      modelString: 'openai:gpt-5.6-luna',
      providerId: 'openai',
      thinking: { mode: 'enabled', effort: 'low' },
      thinkingLabel: 'low',
      counterKind: 'exact',
    });
    expect(policy.fallback.modelInfo.capabilities?.vision).toBe(true);
  });

  it('refuses an unknown subject code with SUBJECT_ROUTE_UNAVAILABLE (422)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('QWEN_API_KEY', 'sk-qwen');
    const { resolveSubjectModelPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    const { TeachingPackageError } = await import('@/lib/server/teaching-package/errors');
    await expect(resolveSubjectModelPolicy('ENGLISH')).rejects.toMatchObject({
      code: 'SUBJECT_ROUTE_UNAVAILABLE',
      status: 422,
    });
    await expect(resolveSubjectModelPolicy(null)).rejects.toBeInstanceOf(TeachingPackageError);
  });

  it('refuses the whole subject when the FALLBACK provider has no key (fail closed)', async () => {
    // MATH: primary qwen (keyed) / fallback openai (unkeyed). A subject with
    // only a working primary is not routed — the fallback is part of the route.
    vi.stubEnv('QWEN_API_KEY', 'sk-qwen');
    const { resolveSubjectModelPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    await expect(resolveSubjectModelPolicy('MATH')).rejects.toMatchObject({
      code: 'SUBJECT_ROUTE_UNAVAILABLE',
      status: 422,
      details: { subjectCode: 'MATH', role: 'fallback', model: 'openai:gpt-5-nano' },
    });
  });

  it('ignores MODEL_ROUTES and DEFAULT_MODEL: a policy target is never re-routed', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('QWEN_API_KEY', 'sk-qwen');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-anthropic');
    vi.stubEnv('DEFAULT_MODEL', 'anthropic:claude-sonnet-4-6');
    // Route EVERY routable stage somewhere else; none of them may win.
    const { LLM_STAGES } = await import('@/lib/server/model-routes');
    vi.stubEnv(
      'MODEL_ROUTES',
      JSON.stringify(
        Object.fromEntries(
          LLM_STAGES.map((stage) => [
            stage,
            { model: 'anthropic:claude-sonnet-4-6', thinking: { mode: 'enabled', effort: 'max' } },
          ]),
        ),
      ),
    );
    const { resolveSubjectModelPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    const policy = await resolveSubjectModelPolicy('ARABIC');
    expect(policy.primary.modelString).toBe('openai:gpt-5.6-luna');
    expect(policy.primary.providerId).toBe('openai');
    expect(policy.primary.thinking).toEqual({ mode: 'enabled', effort: 'low' });
    expect(policy.fallback.modelString).toBe('qwen:qwen3.7-flash');
    expect(policy.fallback.thinking).toEqual({ mode: 'disabled' });
  });
});

/**
 * Wire-shape proof: the resolved target's thinking config, passed to callLLM
 * the way the executor passes it, produces the provider body the benchmarks
 * ran with. Captures the real request through the real provider client with
 * only `fetch` stubbed.
 */
describe('policy thinking → provider request body', () => {
  const originalFetch = globalThis.fetch;
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    bodies = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  function stubChatCompletion(modelId: string) {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
  }

  it('qwen:qwen3.7-flash nothink sends enable_thinking:false', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('QWEN_API_KEY', 'sk-qwen');
    stubChatCompletion('qwen3.7-flash');
    const { resolveSubjectModelPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    const { callLLM } = await import('@/lib/ai/llm');
    const policy = await resolveSubjectModelPolicy('MATH');
    const target = policy.primary;
    await callLLM(
      { model: target.model, prompt: 'hi', maxRetries: 0 },
      'test-qwen',
      undefined,
      target.thinking,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: 'qwen3.7-flash', enable_thinking: false });
    expect(bodies[0]).not.toHaveProperty('thinking_budget');
  });

  it('openai:gpt-5-nano minimal sends reasoning_effort:"minimal"', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('QWEN_API_KEY', 'sk-qwen');
    stubChatCompletion('gpt-5-nano');
    const { resolveSubjectModelPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    const { callLLM } = await import('@/lib/ai/llm');
    const policy = await resolveSubjectModelPolicy('MATH');
    const target = policy.fallback;
    await callLLM(
      { model: target.model, prompt: 'hi', maxRetries: 0 },
      'test-nano',
      undefined,
      target.thinking,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: 'gpt-5-nano', reasoning_effort: 'minimal' });
  });

  it('openai:gpt-5.6-luna low sends reasoning effort "low" on the Responses API', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
    vi.stubEnv('QWEN_API_KEY', 'sk-qwen');
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-5.6-luna',
          output: [
            {
              id: 'msg_1',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
    const { resolveSubjectModelPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    const { callLLM } = await import('@/lib/ai/llm');
    const policy = await resolveSubjectModelPolicy('ARABIC');
    await callLLM(
      { model: policy.primary.model, prompt: 'hi', maxRetries: 0 },
      'test-luna',
      undefined,
      policy.primary.thinking,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: 'gpt-5.6-luna', reasoning: { effort: 'low' } });
  });
});
