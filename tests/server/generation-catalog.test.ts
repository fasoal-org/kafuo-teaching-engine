/**
 * The generation model catalogue (teaching-generation-model-admin-config-plan-
 * 2026-11-18 D-12, D-13): exactly the 11 models, the D-13 thinking options and
 * defaults, the thinking mapping, the pure route validator, and availability by
 * env var NAME only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GENERATION_MODEL_CATALOG,
  GENERATION_POLICY_VERSION,
  generationThinkingOptions,
  parseGenerationModelRoute,
  thinkingConfigFor,
} from '@/lib/server/teaching-model/generation-catalog';
import { POLICY_VERSION } from '@/lib/server/teaching-model/subject-policy';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isYaml = (p: unknown) => typeof p === 'string' && p.endsWith('server-providers.yml');
  return {
    ...actual,
    default: { ...actual, existsSync: (p: string) => (isYaml(p) ? false : actual.existsSync(p)) },
    existsSync: (p: string) => (isYaml(p) ? false : actual.existsSync(p)),
  };
});

const EFFORT_ALL = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_5_5 = ['low', 'medium', 'high', 'xhigh', 'max'];
const GEMINI_4 = ['low', 'medium', 'high'];
const QWEN = ['off', 'on'];

/** Plan D-13, row by row: model, options, prefilled default. */
const D13: Array<[string, string[], string]> = [
  ['openai:gpt-6-luna', EFFORT_ALL, 'low'],
  ['openai:gpt-6.1-terra', EFFORT_ALL, 'medium'],
  ['openai:gpt-6-sol', EFFORT_ALL, 'medium'],
  ['anthropic:claude-opus-5-5', CLAUDE_5_5, 'medium'],
  ['anthropic:claude-sonnet-5-5', CLAUDE_5_5, 'high'],
  ['google:gemini-4-carbon', GEMINI_4, 'medium'],
  ['google:gemini-4-hydrogen', GEMINI_4, 'high'],
  ['qwen:qwen3.7-flash', QWEN, 'off'],
  ['qwen:qwen4-max', QWEN, 'on'],
  ['qwen:qwen3.8-max', QWEN, 'on'],
  ['qwen:qwen3.7-max', QWEN, 'on'],
];

const ROUTE = {
  primary: { model: 'openai:gpt-6.1-terra', thinking: 'medium' },
  fallback: { model: 'openai:gpt-6-luna', thinking: 'low' },
  settingKey: 'teaching_generation.route.MATH',
};

describe('GENERATION_MODEL_CATALOG (D-3, D-13)', () => {
  it('holds exactly the 11 models in picker order, frozen', () => {
    expect(GENERATION_MODEL_CATALOG.map((entry) => entry.model)).toEqual(D13.map(([m]) => m));
    expect(Object.isFrozen(GENERATION_MODEL_CATALOG)).toBe(true);
    expect(GENERATION_POLICY_VERSION).toBe('configured-2026-11');
    expect(GENERATION_POLICY_VERSION).not.toBe(POLICY_VERSION);
  });

  it.each(D13)('%s offers the D-13 options and default', (model, options, defaultThinking) => {
    expect(generationThinkingOptions(model)).toEqual(options);
    const entry = GENERATION_MODEL_CATALOG.find((candidate) => candidate.model === model)!;
    expect(entry.defaultThinking).toBe(defaultThinking);
    expect(generationThinkingOptions(model)).toContain(entry.defaultThinking);
  });

  it('Hydrogen offers no xhigh (the level type stops at high)', () => {
    expect(generationThinkingOptions('google:gemini-4-hydrogen')).not.toContain('xhigh');
  });
});

describe('thinkingConfigFor (D-13 mapping)', () => {
  it.each([
    ['openai:gpt-6-luna', 'none', { mode: 'disabled' }],
    ['openai:gpt-6-luna', 'low', { mode: 'enabled', effort: 'low' }],
    ['openai:gpt-6.1-terra', 'max', { mode: 'enabled', effort: 'max' }],
    ['anthropic:claude-opus-5-5', 'medium', { mode: 'enabled', effort: 'medium' }],
    ['anthropic:claude-sonnet-5-5', 'xhigh', { mode: 'enabled', effort: 'xhigh' }],
    ['google:gemini-4-carbon', 'low', { mode: 'enabled', level: 'low' }],
    ['google:gemini-4-hydrogen', 'high', { mode: 'enabled', level: 'high' }],
    ['qwen:qwen4-max', 'on', { mode: 'enabled' }],
    ['qwen:qwen3.7-flash', 'off', { mode: 'disabled' }],
  ])('%s %s', (model, value, config) => {
    expect(thinkingConfigFor(model, value)).toEqual(config);
  });

  it('refuses a value the model does not offer, and a model outside the catalogue', () => {
    for (const [model, value] of [
      ['anthropic:claude-opus-5-5', 'none'],
      ['google:gemini-4-hydrogen', 'xhigh'],
      ['qwen:qwen4-max', 'high'],
      ['openai:gpt-5-nano', 'low'],
    ]) {
      expect(() => thinkingConfigFor(model!, value!)).toThrowError(
        expect.objectContaining({ code: 'GENERATION_ROUTE_INVALID' }),
      );
    }
  });
});

describe('parseGenerationModelRoute (D-11)', () => {
  it('returns exactly the wire fields (an extra key never survives)', () => {
    expect(
      parseGenerationModelRoute({
        ...ROUTE,
        primary: { ...ROUTE.primary, apiKey: 'sk-x' },
        extra: true,
      }),
    ).toEqual(ROUTE);
  });

  it.each([
    ['not an object', 'openai:gpt-6.1-terra'],
    ['null', null],
    ['a missing primary', { fallback: ROUTE.fallback, settingKey: ROUTE.settingKey }],
    [
      'a model outside the catalogue',
      { ...ROUTE, primary: { model: 'openai:gpt-5-nano', thinking: 'low' } },
    ],
    [
      'a thinking value the model does not offer',
      { ...ROUTE, fallback: { model: 'qwen:qwen4-max', thinking: 'high' } },
    ],
    [
      'a non-string thinking value',
      { ...ROUTE, primary: { model: 'openai:gpt-6-sol', thinking: 3 } },
    ],
    [
      'primary = fallback',
      { ...ROUTE, fallback: { model: 'openai:gpt-6.1-terra', thinking: 'low' } },
    ],
    ['a malformed setting key', { ...ROUTE, settingKey: 'teaching_tts.route.MATH' }],
    ['a lower-case setting key code', { ...ROUTE, settingKey: 'teaching_generation.route.math' }],
  ])('refuses %s with GENERATION_ROUTE_INVALID (400)', (_label, raw) => {
    expect(() => parseGenerationModelRoute(raw)).toThrowError(
      expect.objectContaining({ code: 'GENERATION_ROUTE_INVALID', status: 400 }),
    );
  });
});

describe('resolveConfiguredGenerationPolicy refusals (D-7 relies on them)', () => {
  it('a frozen route that left the catalogue, or an unknown subject, is SUBJECT_ROUTE_UNAVAILABLE', async () => {
    const { resolveConfiguredGenerationPolicy } =
      await import('@/lib/server/teaching-model/resolve-policy');
    for (const route of [
      { ...ROUTE, primary: { model: 'openai:gpt-5-nano', thinking: 'low' } },
      { ...ROUTE, fallback: { model: 'qwen:qwen4-max', thinking: 'high' } },
      { ...ROUTE, settingKey: 'teaching_tts.route.MATH' },
    ]) {
      await expect(resolveConfiguredGenerationPolicy('MATH', route)).rejects.toMatchObject({
        code: 'SUBJECT_ROUTE_UNAVAILABLE',
        status: 422,
      });
    }
    await expect(resolveConfiguredGenerationPolicy('FRENCH', ROUTE)).rejects.toMatchObject({
      code: 'SUBJECT_ROUTE_UNAVAILABLE',
    });
  });
});

describe('buildGenerationModelCatalog (D-12) and availability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-secret-value');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.internal.example/v1');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-anthropic-secret-value');
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('QWEN_API_KEY', 'sk-qwen-secret-value');
  });

  afterEach(() => vi.unstubAllEnvs());

  async function catalogModule() {
    return import('@/lib/server/teaching-model/generation-catalog');
  }

  it('lists the 11 models with registry names, vision, thinking, and availability by env var name', async () => {
    const { buildGenerationModelCatalog } = await catalogModule();
    const catalog = buildGenerationModelCatalog();
    expect(catalog.models.map((model) => model.model)).toEqual(D13.map(([m]) => m));
    expect(catalog.models[1]).toEqual({
      model: 'openai:gpt-6.1-terra',
      name: 'GPT-6.1 Terra',
      providerId: 'openai',
      available: true,
      unavailableReason: null,
      keyEnvVar: 'OPENAI_API_KEY',
      vision: true,
      thinking: { options: EFFORT_ALL, default: 'medium' },
    });
    const byModel = new Map(catalog.models.map((model) => [model.model, model]));
    expect(byModel.get('anthropic:claude-sonnet-5-5')).toMatchObject({
      available: true,
      keyEnvVar: 'ANTHROPIC_API_KEY',
    });
    expect(byModel.get('google:gemini-4-carbon')).toMatchObject({
      available: false,
      unavailableReason: 'missing-key',
      keyEnvVar: 'GOOGLE_API_KEY',
    });
    expect(byModel.get('qwen:qwen4-max')).toMatchObject({
      name: 'Qwen 4 Max',
      available: true,
      keyEnvVar: 'QWEN_API_KEY',
    });
    for (const model of catalog.models) {
      expect(model.thinking.options).toContain(model.thinking.default);
    }
    const text = JSON.stringify(catalog);
    for (const secret of [
      'sk-openai-secret-value',
      'sk-anthropic-secret-value',
      'sk-qwen-secret-value',
      'openai.internal',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/apiKey|baseUrl/);
  });

  it("lists today's table for every subject in catalogue values (Luna low → Qwen3.7 Flash off)", async () => {
    const { buildGenerationModelCatalog, generationThinkingOptions: options } =
      await catalogModule();
    const { defaults } = buildGenerationModelCatalog();
    expect(defaults.map((row) => row.subjectCode)).toEqual([
      'MATH',
      'PHYSICS',
      'BIOLOGY',
      'ARABIC',
      'SOCIAL_STUDIES',
      'CHEMISTRY',
      'ENGLISH',
    ]);
    for (const row of defaults) {
      expect(row).toMatchObject({
        primary: { model: 'openai:gpt-6-luna', thinking: 'low' },
        fallback: { model: 'qwen:qwen3.7-flash', thinking: 'off' },
      });
      expect(options(row.primary.model)).toContain(row.primary.thinking);
      expect(options(row.fallback.model)).toContain(row.fallback.thinking);
    }
  });

  it('an unregistered model is unavailable with reason "unregistered"', async () => {
    const { generationModelAvailability } = await catalogModule();
    expect(generationModelAvailability('openai:not-a-model')).toEqual({
      available: false,
      unavailableReason: 'unregistered',
      keyEnvVar: 'OPENAI_API_KEY',
    });
    expect(generationModelAvailability('nope:model')).toMatchObject({
      available: false,
      unavailableReason: 'unregistered',
    });
  });
});
