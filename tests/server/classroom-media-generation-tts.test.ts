/**
 * The REAL batch path `generateTTSForClassroom` (plan §17, closes the §4.7
 * gap), provider mocked, classroom dir in a temp folder: B-1 pin, B-2 retry,
 * B-3 usage, B-4 content-addressed file, provenance, skip-if-current.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateTTS: vi.fn(), usage: vi.fn() }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isYaml = (p: unknown) => typeof p === 'string' && p.endsWith('server-providers.yml');
  return {
    ...actual,
    default: { ...actual, existsSync: (p: string) => (isYaml(p) ? false : actual.existsSync(p)) },
    existsSync: (p: string) => (isYaml(p) ? false : actual.existsSync(p)),
  };
});
vi.mock('@/lib/audio/tts-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: mocks.generateTTS,
}));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: mocks.usage }));

import type { Scene } from '@/lib/types/stage';

let root: string;

function scenes(): Scene[] {
  return [
    {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'S',
      order: 3,
      content: { type: 'slide', canvas: { id: 'c', elements: [] } },
      actions: [
        { id: 'a1', type: 'speech', text: 'نحسب x² + 1' },
        { id: 'a2', type: 'speech', text: 'ثم نكمل' },
      ],
    } as unknown as Scene,
  ];
}

async function load() {
  return import('@/lib/server/classroom-media-generation');
}

beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(join(tmpdir(), 'satts-batch-'));
  vi.stubEnv('OPENMAIC_CLASSROOMS_DIR', root);
  vi.stubEnv('TTS_OPENAI_API_KEY', 'server-key');
  mocks.usage.mockReset();
  mocks.generateTTS.mockReset().mockImplementation(async () => ({ audio: new Uint8Array([1, 2, 3]), format: 'mp3' }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('generateTTSForClassroom (flag off: only the approved B-items change)', () => {
  it('B-4: content-addressed file, derived transport id kept, provenance stamped', async () => {
    const { generateTTSForClassroom } = await load();
    const input = scenes();
    const summary = await generateTTSForClassroom(input, 'stage-1', 'http://host');
    expect(summary).toMatchObject({ generated: 2, failed: 0 });
    const speech = input[0]!.actions![0] as unknown as { audioId: string; audioUrl: string; audioProvenance: { fingerprint: string } };
    expect(speech.audioId).toBe('tts_s3_a1');
    expect(speech.audioUrl).toMatch(/^http:\/\/host\/api\/classroom-media\/stage-1\/audio\/tts-a1-[A-Za-z0-9_-]{12}\.mp3$/);
    expect(speech.audioProvenance.fingerprint).toMatch(/^fp1:/);
    const files = await readdir(join(root, 'stage-1', 'audio'));
    expect(files.sort()).toHaveLength(2);
    expect(files.every((f) => /^tts-a[12]-/.test(f))).toBe(true);
    // Flag off: the original text is sent with no governed fields.
    expect(mocks.generateTTS.mock.calls[0]![1]).toBe('نحسب x² + 1');
    expect(mocks.generateTTS.mock.calls[0]![0]).not.toHaveProperty('instructions');
  });

  it('B-1: an operator model pin applies', async () => {
    vi.stubEnv('TTS_OPENAI_MODELS', 'gpt-4o-mini-tts-2025-12-15');
    const { generateTTSForClassroom } = await load();
    await generateTTSForClassroom(scenes(), 'stage-1', '');
    expect(mocks.generateTTS.mock.calls[0]![0]).toMatchObject({ modelId: 'gpt-4o-mini-tts-2025-12-15' });
  });

  it('B-2: one transient failure is retried; B-3: usage is recorded per call', async () => {
    const { TTSRateLimitError, generateTTS: _unused } = await import('@/lib/audio/tts-providers');
    void _unused;
    mocks.generateTTS.mockRejectedValueOnce(new TTSRateLimitError('OpenAI', '429'));
    const { generateTTSForClassroom } = await load();
    const summary = await generateTTSForClassroom(scenes(), 'stage-1', '');
    expect(summary).toMatchObject({ generated: 2, failed: 0 });
    expect(mocks.generateTTS).toHaveBeenCalledTimes(3);
    expect(mocks.usage).toHaveBeenCalledTimes(2);
    expect(mocks.usage.mock.calls[0]![0]).toMatchObject({ kind: 'tts', unit: 'character', quantity: 'نحسب x² + 1'.length });
  });

  it('flag off regenerates every Action as today (no skip-if-current, DEC-002)', async () => {
    const { generateTTSForClassroom } = await load();
    const input = scenes();
    await generateTTSForClassroom(input, 'stage-1', '');
    mocks.generateTTS.mockClear();
    await generateTTSForClassroom(input, 'stage-1', '');
    expect(mocks.generateTTS).toHaveBeenCalledTimes(2);
  });
});

describe('generateTTSForClassroom with SCIENTIFIC_TTS_MODE=on', () => {
  beforeEach(() => {
    vi.stubEnv('SCIENTIFIC_TTS_MODE', 'on');
    // Rendering path (O-4 gates an unapproved policy otherwise).
    vi.stubEnv('SATTS_ALLOW_EXPERIMENTAL', 'true');
    // Arabic MATH routes to Qwen Plus (Teaching Engine TTS routing).
    vi.stubEnv('TTS_QWEN_API_KEY', 'server-qwen-key');
  });

  it('AS-005 / FR-022: a second pass reuses current audio and makes zero provider calls', async () => {
    const { generateTTSForClassroom } = await load();
    const input = scenes();
    const stage = { subjectCode: 'MATH', language: 'ar-SA' };
    await generateTTSForClassroom(input, 'stage-1', '', { stage });
    expect(mocks.generateTTS.mock.calls[0]![1]).not.toContain('²');
    mocks.generateTTS.mockClear();
    const summary = await generateTTSForClassroom(input, 'stage-1', '', { stage });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ reused: 2, generated: 0 });
  });

  it('legacy audio (no provenance) is kept, never silently regenerated (§18.1)', async () => {
    const { generateTTSForClassroom } = await load();
    const input = scenes();
    for (const action of input[0]!.actions!) Object.assign(action, { audioId: 'tts_s3_old' });
    const summary = await generateTTSForClassroom(input, 'stage-1', '', { stage: { subjectCode: 'MATH', language: 'ar' } });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ skipped: 2 });
  });
});

describe('flag off keeps today\'s provider config; turning the flag on does not mass-regenerate', () => {
  it('generateTTS receives exactly the pre-SATTS batch config (speed may be undefined)', async () => {
    const { generateTTSForClassroom } = await load();
    await generateTTSForClassroom(scenes(), 'stage-1', '');
    expect(mocks.generateTTS.mock.calls[0]![0]).toEqual({
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
      apiKey: 'server-key',
      baseUrl: 'https://api.openai.com/v1',
      voice: 'alloy',
      speed: undefined,
    });
  });

  it('R-9: audio made with the flag off on a non-scientific Arabic Stage stays current when the flag turns on', async () => {
    const { generateTTSForClassroom } = await load();
    const input = scenes();
    // An Arabic subject no TTS route matches keeps today's provider resolution.
    vi.stubEnv('TTS_QWEN_API_KEY', 'server-qwen-key');
    const social = { subjectCode: 'SOCIAL_STUDIES', language: 'ar-SA' };
    await generateTTSForClassroom(input, 'stage-1', '', { stage: social });
    mocks.generateTTS.mockClear();
    vi.stubEnv('SCIENTIFIC_TTS_MODE', 'on');
    const summary = await generateTTSForClassroom(input, 'stage-1', '', { stage: social });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ reused: 2 });
    // A MATH Stage's off-mode audio is legitimately stale once the renderer applies.
    const math = { subjectCode: 'MATH', language: 'ar-SA' };
    vi.stubEnv('SCIENTIFIC_TTS_MODE', 'off');
    const mathScenes = scenes();
    await generateTTSForClassroom(mathScenes, 'stage-1', '', { stage: math });
    mocks.generateTTS.mockClear();
    vi.stubEnv('SCIENTIFIC_TTS_MODE', 'on');
    await generateTTSForClassroom(mathScenes, 'stage-1', '', { stage: math });
    // Both are stale: the applied subject is a material input (§13.3), even for a prose-only line.
    expect(mocks.generateTTS).toHaveBeenCalledTimes(2);
  });
});
