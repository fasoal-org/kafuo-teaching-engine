/**
 * GET /api/teaching-packages/tts-catalog (tts-provider-routing-admin-config-
 * plan §3.1): service key only; availability by env var NAME; never a key,
 * value or base URL in the body; today's table listed per subject + language.
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

const SERVICE_KEY = 'catalog-service-key';
const REEM = '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72';

async function get(authorization?: string) {
  const { GET } = await import('@/app/api/teaching-packages/tts-catalog/route');
  const response = await GET(
    new NextRequest('http://localhost/api/teaching-packages/tts-catalog', {
      headers: authorization ? { authorization } : {},
    }),
  );
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

type Catalog = {
  providers: Array<{
    id: string;
    available: boolean;
    unavailableReason: string | null;
    keyEnvVar: string;
    voices: Array<{ id: string; language: string; modelId: string }>;
  }>;
  defaults: Array<{
    subjectCode: string;
    language: string;
    routeId: string | null;
    providerId: string | null;
    voiceId: string | null;
  }>;
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://catalog-test');
  vi.stubEnv('TTS_OPENAI_API_KEY', 'sk-openai-secret-value');
  vi.stubEnv('TTS_OPENAI_BASE_URL', 'https://openai.internal.example/v1');
  vi.stubEnv('TTS_CARTESIA_API_KEY', 'sk-cartesia-secret-value');
  vi.stubEnv('TTS_QWEN_API_KEY', '');
});

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/teaching-packages/tts-catalog', () => {
  it('refuses a missing or wrong service key with 401', async () => {
    expect((await get()).status).toBe(401);
    expect((await get('Bearer wrong-key')).status).toBe(401);
  });

  it('reports availability by env var name and never carries a key, value or base URL', async () => {
    const { status, text, json } = await get(`Bearer ${SERVICE_KEY}`);
    expect(status).toBe(200);
    const catalog = json as Catalog;
    expect(catalog.providers.map((provider) => provider.id)).toEqual([
      'openai-tts',
      'cartesia-tts',
      'qwen-tts',
    ]);
    expect(catalog.providers).toEqual([
      expect.objectContaining({
        id: 'openai-tts',
        available: true,
        unavailableReason: null,
        keyEnvVar: 'TTS_OPENAI_API_KEY',
      }),
      expect.objectContaining({
        id: 'cartesia-tts',
        available: true,
        keyEnvVar: 'TTS_CARTESIA_API_KEY',
        voices: [{ id: REEM, name: 'Reem', language: 'ar', modelId: 'sonic-3.6' }],
      }),
      expect.objectContaining({
        id: 'qwen-tts',
        available: false,
        unavailableReason: 'missing-key',
        keyEnvVar: 'TTS_QWEN_API_KEY',
      }),
    ]);
    for (const secret of [
      'sk-openai-secret-value',
      'sk-cartesia-secret-value',
      'openai.internal',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/apiKey|baseUrl/);
  });

  it('a disabled provider is unavailable with reason "disabled"', async () => {
    vi.stubEnv('TTS_CARTESIA_ENABLED', 'false');
    const catalog = (await get(`Bearer ${SERVICE_KEY}`)).json as Catalog;
    expect(catalog.providers.find((provider) => provider.id === 'cartesia-tts')).toMatchObject({
      available: false,
      unavailableReason: 'disabled',
    });
  });

  it("lists today's table for every subject code and language, unchanged", async () => {
    const catalog = (await get(`Bearer ${SERVICE_KEY}`)).json as Catalog;
    expect(catalog.defaults).toHaveLength(14);
    const row = (subjectCode: string, language: string) =>
      catalog.defaults.find(
        (entry) => entry.subjectCode === subjectCode && entry.language === language,
      );
    expect(row('CHEMISTRY', 'ar')).toMatchObject({
      routeId: 'ar-chemistry-cartesia',
      providerId: 'cartesia-tts',
      voiceId: REEM,
    });
    expect(row('MATH', 'ar')).toMatchObject({ routeId: 'ar-qwen-plus', voiceId: 'longanlufeng' });
    expect(row('MATH', 'en')).toMatchObject({ routeId: 'en-openai', voiceId: 'alloy' });
    // Arabic SOCIAL_STUDIES and ENGLISH have no fixed route today.
    expect(row('SOCIAL_STUDIES', 'ar')).toMatchObject({ routeId: null, providerId: null });
    expect(row('ENGLISH', 'ar')).toMatchObject({ routeId: null, providerId: null });
  });
});
