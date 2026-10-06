/**
 * Reviewer diagnostics (plan §16.3, FR-010, FR-036): original vs prepared text,
 * warnings and audio status for authorised reviewers; learner grants refused;
 * preview audio is never persisted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ loadStage: vi.fn(), generateTTS: vi.fn(), usage: vi.fn(), persist: vi.fn() }));

vi.mock('@/lib/server/speech/stage-access', () => ({ loadStageForSpeech: mocks.loadStage }));
vi.mock('@/lib/audio/tts-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: mocks.generateTTS,
}));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: mocks.usage }));
vi.mock('@/lib/server/classroom-media-bytes', () => ({ persistClassroomMediaBytes: mocks.persist }));

const document = {
  stage: { id: 'stage-1', subjectCode: 'MATH', language: 'ar-SA' },
  scenes: [
    {
      id: 'scene-1',
      actions: [
        { id: 'a1', type: 'speech', text: 'نحسب x² و \\foo{y}' },
        { id: 'a2', type: 'speech', text: 'مقدمة عامة' },
        { id: 's1', type: 'spotlight', elementId: 'e' },
      ],
    },
  ],
};

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/speech/diagnostics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stageId: 'stage-1', ...body }),
  });
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/speech/diagnostics/route');
  const response = await POST(request(body));
  return { status: response.status, json: await response.json() };
}

beforeEach(() => {
  vi.resetModules();
  mocks.loadStage.mockReset().mockResolvedValue({
    stage: document.stage,
    access: 'owner',
    loadDocument: async () => document,
  });
  mocks.generateTTS.mockReset().mockResolvedValue({ audio: new Uint8Array([7]), format: 'mp3' });
  mocks.persist.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe('POST /api/speech/diagnostics', () => {
  it('returns original, prepared, warnings and status per speech Action (FR-036)', async () => {
    const { status, json } = await post({});
    expect(status).toBe(200);
    expect(mocks.loadStage).toHaveBeenCalledWith(expect.anything(), 'stage-1', 'diagnostics');
    expect(json.actions).toHaveLength(2);
    const [a1, a2] = json.actions;
    expect(a1).toMatchObject({ actionId: 'a1', original: 'نحسب x² و \\foo{y}', path: 'scientific', status: 'missing', policyStatus: 'experimental' });
    expect(a1.prepared).toContain('سين تربيع');
    expect(a1.warnings.map((w: { code: string }) => w.code)).toContain('SATTS_W_UNKNOWN_COMMAND');
    expect(a2).toMatchObject({ prepared: 'مقدمة عامة' });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('refuses callers without an owner/editor grant — a learner grant included (403)', async () => {
    mocks.loadStage.mockResolvedValue(null);
    const { status, json } = await post({});
    expect(status).toBe(403);
    expect(json.errorCode).toBe('SATTS_DIAGNOSTICS_FORBIDDEN');
  });

  it('accessible mode comparison without changing the Stage', async () => {
    const { json } = await post({ actionIds: ['a1'], mode: 'accessible' });
    expect(json.actions[0].prepared).toContain('مرفوعة للقوة اثنين');
    expect(document.stage).not.toHaveProperty('speechReadingMode');
  });

  it('synthesize returns preview audio and never persists or stamps it', async () => {
    const { status, json } = await post({ actionIds: ['a1'], synthesize: true });
    expect(status).toBe(200);
    expect(json.preview).toMatchObject({ format: 'mp3' });
    expect(mocks.generateTTS).toHaveBeenCalledOnce();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(document.scenes[0]!.actions[0]).not.toHaveProperty('audioId');
  });
});
