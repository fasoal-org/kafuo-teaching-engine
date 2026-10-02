/**
 * The classroom batch (`generateTTSForClassroom`) and the agent runtime
 * (`synthesizeSceneNarration`) resolve the same Teaching Engine TTS route from
 * the same Stage, override their own provider picks with it, and never fall
 * back to another provider when the routed one has no key.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateTTS: vi.fn(), usage: vi.fn(), persist: vi.fn() }));

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
vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));

import type { Scene } from '@/lib/types/stage';

let root: string;

function scene(): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'S',
    order: 1,
    content: { type: 'slide', canvas: { id: 'c', elements: [] } },
    actions: [{ id: 'a1', type: 'speech', text: 'ثم نكمل الدرس' }],
  } as unknown as Scene;
}

const ROUTE_FIELDS = ['providerId', 'modelId', 'voice', 'apiKey', 'language'] as const;
function picked(call: unknown[]) {
  const config = call[0] as Record<string, unknown>;
  return Object.fromEntries(ROUTE_FIELDS.map((key) => [key, config[key]]));
}

async function runBoth(stage: { language: string; subjectCode: string }) {
  const { generateTTSForClassroom } = await import('@/lib/server/classroom-media-generation');
  const { synthesizeSceneNarration } = await import('@/lib/server/agent-runtime/scene-tts');
  const batchScenes = [scene()];
  const batch = await generateTTSForClassroom(batchScenes, 'stage-1', 'http://host', { stage });
  const batchCalls = mocks.generateTTS.mock.calls.slice();
  mocks.generateTTS.mockClear();
  const agentScene = scene();
  const agent = await synthesizeSceneNarration({
    scene: agentScene,
    force: false,
    stage,
    // A roster binding the route must override.
    roster: [
      { id: 't', role: 'teacher', voiceConfig: { providerId: 'openai-tts', voiceId: 'nova' } },
    ] as never,
  });
  const agentCalls = mocks.generateTTS.mock.calls.slice();
  return { batch, agent, batchCalls, agentCalls, batchScenes, agentScene };
}

beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(join(tmpdir(), 'tts-routing-'));
  vi.stubEnv('OPENMAIC_CLASSROOMS_DIR', root);
  vi.stubEnv('TTS_OPENAI_API_KEY', 'server-openai-key');
  vi.stubEnv('TTS_CARTESIA_API_KEY', 'server-cartesia-key');
  vi.stubEnv('TTS_QWEN_API_KEY', 'server-qwen-key');
  mocks.usage.mockReset();
  mocks.persist.mockReset().mockResolvedValue('/api/classroom-media/stage-1/media/tts-a1.mp3');
  mocks.generateTTS
    .mockReset()
    .mockImplementation(async () => ({ audio: new Uint8Array([1, 2, 3]), format: 'mp3' }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe.each(['off', 'on'])('batch and agent agree (SCIENTIFIC_TTS_MODE=%s)', (mode) => {
  beforeEach(() => vi.stubEnv('SCIENTIFIC_TTS_MODE', mode));

  it.each([
    [{ language: 'en', subjectCode: 'CHEMISTRY' }, 'openai-tts', 'gpt-4o-mini-tts', 'alloy'],
    [
      { language: 'ar-SA', subjectCode: 'CHEMISTRY' },
      'cartesia-tts',
      'sonic-3.6',
      '92f27ee5-d8b9-4c0a-a0c2-f401f6ab0a72',
    ],
    [
      { language: 'ar-SA', subjectCode: 'MATH' },
      'qwen-tts',
      'qwen-audio-3.0-tts-plus',
      'longanlufeng',
    ],
    [
      { language: 'ar', subjectCode: 'BIOLOGY' },
      'qwen-tts',
      'qwen-audio-3.0-tts-plus',
      'longanlufeng',
    ],
  ])('%o → %s / %s / %s', async (stage, providerId, modelId, voice) => {
    const { batch, agent, batchCalls, agentCalls, batchScenes, agentScene } = await runBoth(stage);
    expect(batch).toMatchObject({ generated: 1, failed: 0 });
    expect(agent).toMatchObject({ available: true, generated: 1 });
    expect(picked(batchCalls[0]!)).toMatchObject({ providerId, modelId, voice });
    expect(picked(agentCalls[0]!)).toEqual(picked(batchCalls[0]!));
    // Provenance carries the routed provider/model/voice on both paths.
    for (const action of [batchScenes[0]!.actions![0], agentScene.actions![0]]) {
      expect((action as { audioProvenance?: unknown }).audioProvenance).toMatchObject({
        providerId,
        modelId,
        voice,
      });
    }
  });
});

describe('a routed provider without a key never falls back', () => {
  it('batch skips TTS and agent reports unavailable; neither calls another provider', async () => {
    vi.stubEnv('TTS_QWEN_API_KEY', '');
    const { batch, agent, batchCalls, agentCalls } = await runBoth({
      language: 'ar-SA',
      subjectCode: 'PHYSICS',
    });
    expect(batch).toBeUndefined();
    expect(agent).toMatchObject({ available: false, generated: 0 });
    expect(batchCalls).toHaveLength(0);
    expect(agentCalls).toHaveLength(0);
  });
});

describe("unmatched Stages keep each path's current resolution", () => {
  it('batch uses its first configured provider; agent uses the roster binding', async () => {
    const { batchCalls, agentCalls } = await runBoth({
      language: 'ar-SA',
      subjectCode: 'SOCIAL_STUDIES',
    });
    expect(picked(batchCalls[0]!)).toMatchObject({ providerId: 'openai-tts', voice: 'alloy' });
    expect(picked(agentCalls[0]!)).toMatchObject({ providerId: 'openai-tts', voice: 'nova' });
  });
});
