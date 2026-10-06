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
  // Pacing has its own test below; the rest run unpaced.
  vi.stubEnv('TTS_BATCH_START_GAP_MS', '0');
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
    // Actions run concurrently, so the retried a1 may record after a2.
    expect(mocks.usage.mock.calls.map((call) => call[0])).toContainEqual(
      expect.objectContaining({ kind: 'tts', unit: 'character', quantity: 'نحسب x² + 1'.length }),
    );
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

describe('generateTTSForClassroom concurrency (TTS_AR_CONCURRENCY, SATTS plan §13.2)', () => {
  /** `perScene` speech Actions in each of `count` scenes. */
  function manyScenes(count = 2, perScene = 3): Scene[] {
    return Array.from({ length: count }, (_, i) => i + 1).map((order) => ({
      id: `scene-${order}`,
      stageId: 'stage-1',
      type: 'slide',
      title: 'S',
      order,
      content: { type: 'slide', canvas: { id: 'c', elements: [] } },
      actions: Array.from({ length: perScene }, (_, n) => ({
        id: `s${order}a${n + 1}`,
        type: 'speech',
        text: `جملة ${order} ${n + 1}`,
      })),
    })) as unknown as Scene[];
  }

  /** Records the peak number of provider calls in flight at once. */
  function trackInFlight() {
    const state = { inFlight: 0, peak: 0 };
    mocks.generateTTS.mockImplementation(async () => {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.inFlight -= 1;
      return { audio: new Uint8Array([1, 2, 3]), format: 'mp3' };
    });
    return state;
  }

  it('defaults to at most 6 Actions at once', async () => {
    const state = trackInFlight();
    const { generateTTSForClassroom } = await load();
    const input = manyScenes(4, 2);
    const summary = await generateTTSForClassroom(input, 'stage-1', 'http://host');
    expect(summary).toMatchObject({ generated: 8, failed: 0 });
    expect(state.peak).toBe(6);
    // Each Action still gets its own derived id and file.
    expect((input[3]!.actions![1] as unknown as { audioId: string }).audioId).toBe('tts_s4_s4a2');
    expect(await readdir(join(root, 'stage-1', 'audio'))).toHaveLength(8);
  });

  it('pools Actions across scenes (one speech Action per scene still runs 2 at once)', async () => {
    vi.stubEnv('TTS_AR_CONCURRENCY', '2');
    const state = trackInFlight();
    const { generateTTSForClassroom } = await load();
    const summary = await generateTTSForClassroom(manyScenes(4, 1), 'stage-1', '');
    expect(summary).toMatchObject({ generated: 4, failed: 0 });
    expect(state.peak).toBe(2);
  });

  it('TTS_BATCH_START_GAP_MS spaces provider starts; reused audio takes no slot', async () => {
    vi.stubEnv('TTS_BATCH_START_GAP_MS', '50');
    const starts: number[] = [];
    mocks.generateTTS.mockImplementation(async () => {
      starts.push(Date.now());
      return { audio: new Uint8Array([1, 2, 3]), format: 'mp3' };
    });
    const { generateTTSForClassroom } = await load();
    await generateTTSForClassroom(manyScenes(2, 2), 'stage-1', '');
    expect(starts).toHaveLength(4);
    const sorted = [...starts].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      // Unpaced starts land ~0 ms apart; the margin absorbs async hops after the slot.
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(40);
    }
  });

  it('reused (current) audio never waits for a start slot', async () => {
    vi.stubEnv('SCIENTIFIC_TTS_MODE', 'on');
    vi.stubEnv('SATTS_ALLOW_EXPERIMENTAL', 'true');
    vi.stubEnv('TTS_QWEN_API_KEY', 'server-qwen-key');
    const { generateTTSForClassroom } = await load();
    const input = manyScenes(2, 2);
    const stage = { subjectCode: 'MATH', language: 'ar-SA' };
    await generateTTSForClassroom(input, 'stage-1', '', { stage });
    vi.stubEnv('TTS_BATCH_START_GAP_MS', '1000');
    const startedAt = Date.now();
    const summary = await generateTTSForClassroom(input, 'stage-1', '', { stage });
    expect(summary).toMatchObject({ reused: 4, generated: 0 });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('TTS_AR_CONCURRENCY=1 keeps the batch strictly serial', async () => {
    vi.stubEnv('TTS_AR_CONCURRENCY', '1');
    const state = trackInFlight();
    const { generateTTSForClassroom } = await load();
    await generateTTSForClassroom(manyScenes(), 'stage-1', '');
    expect(state.peak).toBe(1);
  });

  it('Cartesia keeps its own cap: 2 in flight by default, even with TTS_AR_CONCURRENCY=6', async () => {
    vi.stubEnv('TTS_CARTESIA_API_KEY', 'server-cartesia-key');
    const state = trackInFlight();
    const { generateTTSForClassroom } = await load();
    const summary = await generateTTSForClassroom(manyScenes(4, 2), 'stage-1', '', {
      stage: { subjectCode: 'CHEMISTRY', language: 'ar-SA' },
    });
    expect(summary).toMatchObject({ generated: 8, failed: 0 });
    expect(mocks.generateTTS.mock.calls[0]![0]).toMatchObject({ providerId: 'cartesia-tts' });
    expect(state.peak).toBe(2);
  });

  it('TTS_CARTESIA_BATCH_CONCURRENCY raises the Cartesia cap; other routes keep the pool cap', async () => {
    vi.stubEnv('TTS_CARTESIA_API_KEY', 'server-cartesia-key');
    vi.stubEnv('TTS_CARTESIA_BATCH_CONCURRENCY', '3');
    const cartesia = trackInFlight();
    const { generateTTSForClassroom } = await load();
    await generateTTSForClassroom(manyScenes(4, 2), 'stage-1', '', {
      stage: { subjectCode: 'CHEMISTRY', language: 'ar-SA' },
    });
    expect(cartesia.peak).toBe(3);
  });

  it('a Cartesia 5xx is retried once like any other transient failure', async () => {
    vi.stubEnv('TTS_CARTESIA_API_KEY', 'server-cartesia-key');
    mocks.generateTTS
      .mockRejectedValueOnce(new Error('Cartesia TTS API error (503): overloaded'))
      .mockImplementation(async () => ({ audio: new Uint8Array([1, 2, 3]), format: 'mp3' }));
    const { generateTTSForClassroom } = await load();
    const summary = await generateTTSForClassroom(manyScenes(1, 1), 'stage-1', '', {
      stage: { subjectCode: 'CHEMISTRY', language: 'ar-SA' },
    });
    expect(summary).toMatchObject({ generated: 1, failed: 0 });
    expect(mocks.generateTTS).toHaveBeenCalledTimes(2);
  });

  it('one failed Action never sinks the others running beside it', async () => {
    vi.stubEnv('TTS_AR_CONCURRENCY', '3');
    mocks.generateTTS.mockImplementation(async (_config: unknown, text: string) => {
      if (text === 'جملة 1 2') throw new Error('provider rejected the text');
      return { audio: new Uint8Array([1, 2, 3]), format: 'mp3' };
    });
    const { generateTTSForClassroom } = await load();
    const input = manyScenes();
    const summary = await generateTTSForClassroom(input, 'stage-1', '');
    expect(summary).toMatchObject({ generated: 5, failed: 1 });
    expect(input[0]!.actions![1]).not.toHaveProperty('audioId');
  });
});

describe('loggableErrorMessage', () => {
  it('redacts credential-looking tokens and caps the length', async () => {
    const { loggableErrorMessage } = await import('@/lib/server/speech/narration-synthesis');
    const out = loggableErrorMessage(
      'Cartesia TTS API error (429): too many requests; Authorization: Bearer abc.DEF-123 api_key=sk-live_1234567890abcdef',
    );
    expect(out).toContain('Cartesia TTS API error (429): too many requests');
    expect(out).not.toContain('abc.DEF-123');
    expect(out).not.toContain('sk-live_1234567890abcdef');
    expect(loggableErrorMessage('x'.repeat(1000))).toHaveLength(300);
  });
});
