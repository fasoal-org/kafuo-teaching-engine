/**
 * Kafuo Agent API wave E2: the agent's C1 correction service routes
 * (`agent-correction` PATCH, `agent-resume` POST). The correction service is mocked;
 * its dry run on a real database is covered in generation-correction.test.ts.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { GenerationAttempt } from '@/lib/types/teaching-package';

const mocks = vi.hoisted(() => ({
  editGenerationCorrection: vi.fn(),
  resumeGenerationAttempt: vi.fn(),
  abandonGenerationAttempt: vi.fn(),
  runGenerationAttempt: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
  pool: { query: () => undefined },
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (callback: () => unknown) => {
    mocks.afterCallbacks.push(callback);
  },
}));
vi.mock('@/lib/server/teaching-package/generation-correction', () => ({
  editGenerationCorrection: mocks.editGenerationCorrection,
  resumeGenerationAttempt: mocks.resumeGenerationAttempt,
  abandonGenerationAttempt: mocks.abandonGenerationAttempt,
}));
vi.mock('@/lib/server/teaching-package/generation-runner', () => ({
  runGenerationAttempt: mocks.runGenerationAttempt,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: mocks.pool }),
}));

import * as agentCorrection from '@/app/api/teaching-packages/generation-attempts/[attemptId]/agent-correction/route';
import * as agentResume from '@/app/api/teaching-packages/generation-attempts/[attemptId]/agent-resume/route';

const SERVICE_KEY = 'agent-correction-route-key';
const ATTEMPT_ID = 'tpa-agent-1';
const TENANT = 'tenant-77';
const AGENT = 'agent:5';
const BASE = `http://localhost/api/teaching-packages/generation-attempts/${ATTEMPT_ID}`;
const FRESH_URL = 'https://r2/pdf?X-Amz-Signature=fresh-signature';

const ctx = () => ({ params: Promise.resolve({ attemptId: ATTEMPT_ID }) });

function send(
  handler: (req: NextRequest, context: ReturnType<typeof ctx>) => Promise<Response>,
  suffix: string,
  method: string,
  body: unknown,
  authorized = true,
): Promise<Response> {
  return handler(
    new NextRequest(`${BASE}/${suffix}`, {
      method,
      headers: {
        ...(authorized ? { authorization: `Bearer ${SERVICE_KEY}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    ctx(),
  );
}

const edit = (body: unknown, authorized = true) =>
  send(agentCorrection.PATCH, 'agent-correction', 'PATCH', body, authorized);
const resume = (body: unknown, authorized = true) =>
  send(agentResume.POST, 'agent-resume', 'POST', body, authorized);

function editBody(overrides: Record<string, unknown> = {}) {
  return {
    tenantContext: { tenantId: TENANT },
    actorRef: AGENT,
    expectedRevision: 3,
    operations: [{ op: 'set', outlineId: 'o-1', field: 'contentRole', value: 'explanation' }],
    ...overrides,
  };
}

function kafuoRequest() {
  return {
    requestId: 'kafuo-req-77',
    tenantContext: { tenantId: TENANT },
    actorRef: 'actor-1',
    learningItem: {
      type: 'lesson',
      id: '901',
      title: 'Photosynthesis',
      unit: { id: '12', title: 'Unit 3' },
      curriculum: { id: '5', name: 'Science 5' },
      curriculumVersion: { id: '8', versionLabel: '2026-A' },
      subjectOffering: {
        id: '10',
        name: 'Science',
        code: 'BIOLOGY',
        nameAr: 'العلوم',
        nameEn: 'Science',
        academicLanguage: 'ar',
      },
      language: 'ar',
    },
    learningObjectives: [
      { objectiveRef: '7001', snapshot: { statement: 'Explain photosynthesis.' } },
    ],
    teachingModel: {
      key: 'g5',
      version: 'g5.v1',
      flow: [{ stage: 'lesson_introduction', instructions: 'Introduce once.' }],
    },
    contentResource: { id: 'cs-1', url: FRESH_URL },
    generation: { enableTTS: true },
  };
}

function resumeBody(overrides: Record<string, unknown> = {}) {
  return {
    tenantContext: { tenantId: TENANT },
    actorRef: AGENT,
    expectedRevision: 3,
    request: kafuoRequest(),
    ...overrides,
  };
}

const attempt = { id: ATTEMPT_ID, status: 'awaiting_admin_correction' } as GenerationAttempt;
const view = { attemptId: ATTEMPT_ID, revision: 3, phase: 'outline', blockingIssues: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.afterCallbacks.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv('DATABASE_URL', 'postgres://agent-correction-route-test');
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
  // The provider/model availability of the re-sent request is not what these tests check.
  vi.stubEnv('TEACHING_SUBJECT_ROUTING', 'off');
});

function expectNothingRan() {
  expect(mocks.editGenerationCorrection).not.toHaveBeenCalled();
  expect(mocks.resumeGenerationAttempt).not.toHaveBeenCalled();
  expect(mocks.abandonGenerationAttempt).not.toHaveBeenCalled();
  expect(mocks.afterCallbacks).toHaveLength(0);
}

describe('the agent surface', () => {
  it('has no abandon route: only agent-correction (PATCH) and agent-resume (POST) exist', () => {
    const dir = path.resolve(
      __dirname,
      '../../app/api/teaching-packages/generation-attempts/[attemptId]',
    );
    const agentDirs = readdirSync(dir).filter((name) => name.startsWith('agent'));
    expect(agentDirs.sort()).toEqual(['agent-correction', 'agent-resume']);
    expect(existsSync(path.join(dir, 'agent-abandon'))).toBe(false);
    expect(Object.keys(agentCorrection).filter((name) => /^[A-Z]+$/.test(name))).toEqual(['PATCH']);
    expect(Object.keys(agentResume).filter((name) => /^[A-Z]+$/.test(name))).toEqual(['POST']);
  });

  it.each([
    ['PATCH agent-correction', () => edit(editBody(), false)],
    ['POST agent-resume', () => resume(resumeBody(), false)],
  ])('%s refuses a missing service key with 401', async (_label, call) => {
    expect((await call()).status).toBe(401);
    expectNothingRan();
  });

  it.each([
    ['an administrator id', 'admin-9'],
    ['a bare user id', '5'],
    ['an empty agent id', 'agent:'],
    ['a non-numeric agent id', 'agent:bot'],
  ])('refuses %s as the actor with 422 on both routes', async (_label, actorRef) => {
    for (const response of [
      await edit(editBody({ actorRef })),
      await resume(resumeBody({ actorRef })),
    ]) {
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'AGENT_ACTION_NOT_ALLOWED' },
      });
    }
    expectNothingRan();
  });
});

describe('PATCH …/agent-correction', () => {
  it.each([
    ['review_plan', { op: 'review_plan' }],
    ['revert_fix', { op: 'revert_fix', fixId: 'fix-1' }],
  ])('refuses %s with 422 before the service runs', async (op, operation) => {
    const response = await edit(
      editBody({ operations: [{ op: 'remove', outlineId: 'o-1' }, operation] }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'AGENT_ACTION_NOT_ALLOWED',
        details: { operations: [{ index: 1, op }] },
      },
    });
    expectNothingRan();
  });

  it('passes the five engine operations, the agent actor and dryRun: false by default', async () => {
    mocks.editGenerationCorrection.mockResolvedValue(view);
    const operations = [
      { op: 'set', outlineId: 'o-1', field: 'teachingStage', value: 2 },
      { op: 'remove', outlineId: 'o-2' },
      { op: 'move', outlineId: 'o-3', toIndex: 0 },
      { op: 'insert_book_slide', outlineId: 'o-4', unitId: '88', title: 'الحل' },
      { op: 'ignore_issue', issueKey: '["X","o-5",null,null]' },
    ];
    const response = await edit(editBody({ operations }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ correction: view, dryRun: false });
    expect(mocks.editGenerationCorrection).toHaveBeenCalledWith(mocks.pool, ATTEMPT_ID, {
      tenantId: TENANT,
      actorRef: AGENT,
      expectedRevision: 3,
      operations,
      dryRun: false,
    });
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('forwards a dry run and answers dryRun: true', async () => {
    mocks.editGenerationCorrection.mockResolvedValue(view);
    const response = await edit(editBody({ dryRun: true }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ correction: view, dryRun: true });
    expect(mocks.editGenerationCorrection.mock.calls[0]![2]).toMatchObject({ dryRun: true });
    // Never cached: a dry-run view is not the stored correction.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a non-boolean dryRun with 400', async () => {
    const response = await edit(editBody({ dryRun: 'yes' }));
    expect(response.status).toBe(400);
    expectNothingRan();
  });

  it('passes a stale revision through as 409 STALE_STATE with the current revision', async () => {
    mocks.editGenerationCorrection.mockRejectedValue(
      new TeachingPackageError('STALE_STATE', 'reload it', { currentRevision: 4 }),
    );
    const response = await edit(editBody());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'STALE_STATE', details: { currentRevision: 4 } },
    });
  });
});

describe('POST …/agent-resume', () => {
  it('a dry run checks everything, answers 200 wouldResume and schedules no run', async () => {
    mocks.resumeGenerationAttempt.mockResolvedValue({ attempt, resumed: false, wouldResume: true });
    const response = await resume(resumeBody({ dryRun: true }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      attempt,
      resumed: false,
      dryRun: true,
      wouldResume: true,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.resumeGenerationAttempt.mock.calls[0]![2]).toMatchObject({
      tenantId: TENANT,
      actorRef: AGENT,
      expectedRevision: 3,
      dryRun: true,
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(mocks.afterCallbacks).toHaveLength(0);
    expect(mocks.runGenerationAttempt).not.toHaveBeenCalled();
  });

  it('a dry run of an already-resumed revision answers wouldResume: false', async () => {
    mocks.resumeGenerationAttempt.mockResolvedValue({ attempt, resumed: false });
    const response = await resume(resumeBody({ dryRun: true }));
    await expect(response.json()).resolves.toMatchObject({ dryRun: true, wouldResume: false });
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it('a real resume answers 202 and schedules exactly the winning run', async () => {
    mocks.resumeGenerationAttempt.mockResolvedValue({
      attempt: { ...attempt, status: 'queued' },
      resumed: true,
    });
    const response = await resume(resumeBody());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ resumed: true, dryRun: false });
    expect(mocks.resumeGenerationAttempt.mock.calls[0]![2]).toMatchObject({ dryRun: false });
    expect(mocks.afterCallbacks).toHaveLength(1);
  });

  it('passes the service refusals through (open issues)', async () => {
    mocks.resumeGenerationAttempt.mockRejectedValue(
      new TeachingPackageError('CORRECTION_INCOMPLETE', '1 issue(s) still need correction'),
    );
    const response = await resume(resumeBody({ dryRun: true }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'CORRECTION_INCOMPLETE' },
    });
  });

  it('runs the shared body checks: a missing request is 400 before the service', async () => {
    const response = await resume(resumeBody({ request: undefined }));
    expect(response.status).toBe(400);
    expectNothingRan();
  });
});
