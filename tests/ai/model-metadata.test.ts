import { describe, expect, it } from 'vitest';

import { getModelInfo, PROVIDERS } from '@/lib/ai/providers';
import { getCatalogThinkingCapability, getModelMetadataKey } from '@/lib/ai/model-metadata';
import { pickThinkingLevel } from '@/lib/ai/thinking-config';
import {
  REVIEWER_MAX_OUTPUT_TOKENS,
  reviewerMaxOutputTokens,
} from '@/lib/server/teaching-model/reviewer-policy';
import type { ProviderConfig, ProviderId } from '@/lib/types/provider';

// These models intentionally do not expose a configurable thinking control.
const MODELS_WITHOUT_CONFIGURABLE_THINKING = new Set<string>([
  // Bedrock models can reason, but this provider intentionally does not expose
  // thinking controls yet. Those require Bedrock-specific request serialization
  // (`providerOptions.bedrock.reasoningConfig`), which is outside this text-provider
  // rebase and belongs in the maintainer's follow-up request-serialization review.
  'bedrock:us.anthropic.claude-sonnet-5',
  'bedrock:us.anthropic.claude-opus-4-8',
  'bedrock:us.anthropic.claude-opus-4-7',
  'bedrock:us.anthropic.claude-sonnet-4-6',
  'bedrock:us.amazon.nova-pro-v1:0',
  'bedrock:us.amazon.nova-lite-v1:0',
  'bedrock:us.amazon.nova-micro-v1:0',
  'bedrock:us.meta.llama3-3-70b-instruct-v1:0',
  'siliconflow:Pro/moonshotai/Kimi-K2.5',
  'grok:grok-4.20',
  'grok:grok-4-1-fast-non-reasoning',
  'grok:grok-code-fast-1',
  'atlascloud:qwen/qwen3.5-flash',
  'ollama:llama3.3',
  'ollama:gemma3',
  'ollama:deepseek-r1',
]);

function findDriftedModels(providers: Record<ProviderId, ProviderConfig>): string[] {
  const driftedModels: string[] = [];

  for (const provider of Object.values(providers)) {
    for (const model of provider.models) {
      const key = getModelMetadataKey(provider.id, model.id);

      if (getCatalogThinkingCapability(provider.id, model.id)) {
        continue;
      }

      if (MODELS_WITHOUT_CONFIGURABLE_THINKING.has(key)) {
        continue;
      }

      driftedModels.push(key);
    }
  }

  return driftedModels;
}

describe('model metadata thinking capabilities', () => {
  it('accounts for every PROVIDERS model with a capability or explicit non-thinking allowlist', () => {
    expect(findDriftedModels(PROVIDERS)).toEqual([]);
  });

  it('catches drift when a provider model has no thinking metadata or allowlist entry', () => {
    const syntheticProviders = {
      siliconflow: {
        ...PROVIDERS.siliconflow,
        models: [
          ...PROVIDERS.siliconflow.models,
          { id: '__synthetic_missing__', name: 'x', capabilities: {} },
        ],
      },
    } as Record<ProviderId, ProviderConfig>;

    expect(findDriftedModels(syntheticProviders)).toContain('siliconflow:__synthetic_missing__');
  });

  it('resolves thinking capabilities for the previously missing explicit models', () => {
    expect(getCatalogThinkingCapability('siliconflow', 'deepseek-ai/DeepSeek-V3.2')).toBeDefined();
    expect(getCatalogThinkingCapability('lemonade', 'Gemma-4-26B-A4B-it-GGUF')).toBeDefined();
  });

  it('AI reviewer models: Opus 5.5 is adaptive-only (never disabled), GPT-6 Sol takes effort', () => {
    const opus = getCatalogThinkingCapability('anthropic', 'claude-opus-5-5');
    expect(opus).toMatchObject({
      control: 'effort',
      requestAdapter: 'anthropic',
      toggleable: false,
      anthropicThinking: { type: 'adaptive' },
    });
    expect(opus?.effortValues).toContain('high');
    expect(opus?.effortValues).not.toContain('none');
    const sol = getCatalogThinkingCapability('openai', 'gpt-6-sol');
    expect(sol).toEqual(getCatalogThinkingCapability('openai', 'gpt-6-luna'));
    expect(sol?.effortValues).toContain('high');
  });

  it('owner 16 Nov 2026: Sonnet 5.5 is effort-only like Opus 5.5; Gemini 4 never sends minimal', () => {
    const sonnet = getCatalogThinkingCapability('anthropic', 'claude-sonnet-5-5');
    expect(sonnet).toEqual(getCatalogThinkingCapability('anthropic', 'claude-opus-5-5'));
    expect(sonnet?.effortValues).not.toContain('none');
    expect(getModelInfo('anthropic', 'claude-sonnet-5-5')).toMatchObject({
      contextWindow: 1_000_000,
      outputWindow: 128_000,
    });

    const carbon = getCatalogThinkingCapability('google', 'gemini-4-carbon');
    const hydrogen = getCatalogThinkingCapability('google', 'gemini-4-hydrogen');
    expect(carbon).toMatchObject({ control: 'level', defaultLevel: 'medium', toggleable: false });
    expect(hydrogen).toMatchObject({ control: 'level', defaultLevel: 'high', toggleable: false });
    for (const capability of [carbon!, hydrogen!]) {
      expect(capability.levelValues).toEqual(['low', 'medium', 'high']);
      // A thinking-off request falls to the lowest level Gemini 4 accepts.
      expect(pickThinkingLevel(capability, { mode: 'disabled' })).toBe('low');
    }

    // Listed last: each provider's first model (its default) is unchanged.
    expect(PROVIDERS.anthropic.models[0]?.id).toBe('claude-opus-5');
    expect(PROVIDERS.google.models[0]?.id).toBe('gemini-3.6-flash');
  });

  it('owner 18 Nov 2026: Terra takes GPT-6 effort; Qwen 4 Max and Qwen3.8 Max think by default', () => {
    expect(getCatalogThinkingCapability('openai', 'gpt-6.1-terra')).toEqual(
      getCatalogThinkingCapability('openai', 'gpt-6-luna'),
    );
    for (const id of ['qwen4-max', 'qwen3.8-max']) {
      expect(getCatalogThinkingCapability('qwen', id)).toEqual(
        getCatalogThinkingCapability('qwen', 'qwen3.7-max'),
      );
      expect(getModelInfo('qwen', id)).toMatchObject({
        contextWindow: 1_000_000,
        outputWindow: 131_072,
        capabilities: { vision: true },
      });
    }
    expect(PROVIDERS.openai.models[0]?.id).toBe('gpt-6-luna');
    expect(PROVIDERS.qwen.models[0]?.id).toBe('qwen3.7-plus');
  });

  it('D-4: the reviewer output bound (64k) sits inside both reviewer models’ real output windows', () => {
    const opus = getModelInfo('anthropic', 'claude-opus-5-5');
    const sol = getModelInfo('openai', 'gpt-6-sol');
    expect(opus?.outputWindow).toBe(128_000);
    expect(sol?.outputWindow).toBe(128_000);
    expect(REVIEWER_MAX_OUTPUT_TOKENS).toBe(64_000);
    expect(
      reviewerMaxOutputTokens({
        primary: { modelInfo: opus } as never,
        fallback: { modelInfo: sol } as never,
      }),
    ).toBe(64_000);
    // A smaller window on either route caps the one bound both routes receive.
    expect(
      reviewerMaxOutputTokens({
        primary: { modelInfo: opus } as never,
        fallback: { modelInfo: { ...sol, outputWindow: 48_000 } } as never,
      }),
    ).toBe(48_000);
  });

  it('resolves GPT-5.6 Sol alias metadata through the canonical model ID', () => {
    expect(getCatalogThinkingCapability('openai', 'gpt-5.6-sol')).toEqual(
      getCatalogThinkingCapability('openai', 'gpt-5.6'),
    );
  });
});
