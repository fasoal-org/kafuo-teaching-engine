/**
 * GET /api/teaching-packages/generation-model-catalog (teaching-generation-
 * model-admin-config-plan-2026-11-18 D-12): 404 unless the package API is
 * configured; service key only; availability by env var NAME; never a key,
 * value or base URL in the body; today's table listed per subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isYaml = (p: unknown) => typeof p === 'string' && p.endsWith('server-providers.yml');
  return {
    ...actual,
    default: { ...actual, existsSync: (p: string) => (isYaml(p) ? false : actual.existsSync(p)) },
    existsSync: (p: string) => (isYaml(p) ? false : actual.existsSync(p)),
  };
});

const SERVICE_KEY = 'generation-catalog-service-key';

async function get(authorization?: string) {
  const { GET } = await import('@/app/api/teaching-packages/generation-model-catalog/route');
  const response = await GET(
    new NextRequest('http://localhost/api/teaching-packages/generation-model-catalog', {
      headers: authorization ? { authorization } : {},
    }),
  );
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

type Catalog = {
  models: Array<{
    model: string;
    name: string;
    providerId: string;
    available: boolean;
    unavailableReason: string | null;
    keyEnvVar: string;
    vision: boolean;
    thinking: { options: string[]; default: string };
  }>;
  defaults: Array<{
    subjectCode: string;
    primary: { model: string; thinking: string };
    fallback: { model: string; thinking: string };
  }>;
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://generation-catalog-test');
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-secret-value');
  vi.stubEnv('OPENAI_BASE_URL', 'https://openai.internal.example/v1');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('GOOGLE_API_KEY', 'sk-google-secret-value');
  vi.stubEnv('QWEN_API_KEY', 'sk-qwen-secret-value');
});

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/teaching-packages/generation-model-catalog', () => {
  it('answers a plain 404 when the package API is not configured', async () => {
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', '');
    expect((await get(`Bearer ${SERVICE_KEY}`)).status).toBe(404);
  });

  it('refuses a missing or wrong service key with 401', async () => {
    expect((await get()).status).toBe(401);
    expect((await get('Bearer wrong-key')).status).toBe(401);
  });

  it('lists the 11 models by env var name, no-store, and never carries a key, value or base URL', async () => {
    const { status, headers, text, json } = await get(`Bearer ${SERVICE_KEY}`);
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('no-store');
    const catalog = json as Catalog;
    expect(catalog.models).toHaveLength(11);
    const byModel = new Map(catalog.models.map((model) => [model.model, model]));
    expect(byModel.get('openai:gpt-6.1-terra')).toMatchObject({
      name: 'GPT-6.1 Terra',
      providerId: 'openai',
      available: true,
      unavailableReason: null,
      keyEnvVar: 'OPENAI_API_KEY',
      thinking: { default: 'medium' },
    });
    expect(byModel.get('anthropic:claude-opus-5-5')).toMatchObject({
      available: false,
      unavailableReason: 'missing-key',
      keyEnvVar: 'ANTHROPIC_API_KEY',
      thinking: { options: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },
    });
    expect(byModel.get('google:gemini-4-hydrogen')).toMatchObject({
      available: true,
      keyEnvVar: 'GOOGLE_API_KEY',
      thinking: { options: ['low', 'medium', 'high'], default: 'high' },
    });
    expect(byModel.get('qwen:qwen3.7-flash')).toMatchObject({
      available: true,
      keyEnvVar: 'QWEN_API_KEY',
      thinking: { options: ['off', 'on'], default: 'off' },
    });
    for (const secret of [
      'sk-openai-secret-value',
      'sk-google-secret-value',
      'sk-qwen-secret-value',
      'openai.internal',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/apiKey|baseUrl/);
  });

  it("lists today's table for every subject code, unchanged", async () => {
    const catalog = (await get(`Bearer ${SERVICE_KEY}`)).json as Catalog;
    expect(catalog.defaults).toHaveLength(7);
    for (const row of catalog.defaults) {
      expect(row).toEqual({
        subjectCode: row.subjectCode,
        primary: { model: 'openai:gpt-6-luna', thinking: 'low' },
        fallback: { model: 'qwen:qwen3.7-flash', thinking: 'off' },
      });
    }
  });
});
