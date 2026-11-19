/**
 * g5.v11 (owner, 17 Nov 2026): the teacher guide's answer drawings are fetched from their
 * presigned URLs with the content-resource controls, verified (size, SHA-256, PNG) and
 * kept as `guide-<n>` source images — fail-soft: a drawing that fails is left out, logged
 * by item only, and never fails the run.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warnings = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  acquireGuideAnswerFigures,
  GUIDE_FIGURE_SOURCE_ROLE,
} from '@/lib/server/teaching-package/guide-answer-figures';
import type { KafuoTeacherGuide, KafuoTeacherGuideItem } from '@/lib/types/teaching-package';

const uint32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
/** A PNG signature and IHDR header (640×480): all the checks read. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  uint32(13),
  Buffer.from('IHDR'),
  uint32(640),
  uint32(480),
  Buffer.from([8, 6, 0, 0, 0]),
  Buffer.alloc(4),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const URL_OF = (n: number) =>
  `https://r2.example.test/guides/answer-${n}.png?X-Amz-Signature=s${n}`;

function drawing(
  contentUnitId: string,
  label: string,
  n: number,
  bytes: Buffer = PNG,
  overrides: Record<string, unknown> = {},
): KafuoTeacherGuideItem {
  return {
    contentUnitId,
    label,
    status: 'reference',
    modelAnswer: {
      kind: 'figure',
      image: {
        checksumSha256: sha(bytes),
        mimeType: 'image/png',
        sizeBytes: bytes.length,
        url: URL_OF(n),
        ...overrides,
      },
    },
  };
}

const respond = (bytes: Buffer, type = 'image/png') =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': type, 'content-length': String(bytes.length) },
  });

/** A transport serving each URL's bytes (by its number), and recording the calls. */
function transport(bodies: Record<number, Buffer | Error | [Buffer, string]>) {
  return vi.fn(async (input: string | URL) => {
    const n = Number(/answer-(\d+)\.png/.exec(String(input))?.[1]);
    const body = bodies[n];
    if (body instanceof Error) throw body;
    if (Array.isArray(body)) return respond(body[0], body[1]);
    return respond(body ?? PNG);
  });
}

const policy = (secureFetch: ReturnType<typeof transport>, extra = {}) => ({
  secureFetch: secureFetch as never,
  dispatcher: {} as never,
  retryDelayMs: 0,
  ...extra,
});

beforeEach(() => {
  warnings.length = 0;
});

describe('acquireGuideAnswerFigures', () => {
  it('keeps each verified drawing as `guide-<n>`, by its place in the guide', async () => {
    const guide: KafuoTeacherGuide = {
      guideId: 'tg-1',
      items: [
        {
          contentUnitId: '6247',
          label: '1',
          status: 'approved',
          answer: { type: 'number', value: 2 },
        },
        drawing('6249', '12', 1),
        {
          contentUnitId: '6249',
          label: '13',
          status: 'reference',
          modelAnswer: { kind: 'proof', text: 'برهان' },
        },
        drawing('6250', '15', 3),
      ],
    };
    const fetchImpl = transport({});
    const figures = await acquireGuideAnswerFigures(guide, policy(fetchImpl));
    expect(figures.map((figure) => figure.id)).toEqual(['src-guide-2', 'src-guide-4']);
    expect(figures[0]).toEqual({
      id: 'src-guide-2',
      data: PNG,
      mimeType: 'image/png',
      sha256: sha(PNG),
      pageNumber: null,
      width: 640,
      height: 480,
      sourceRole: GUIDE_FIGURE_SOURCE_ROLE,
    });
    // No content unit: never linked to a slide by its unit.
    expect(figures.every((figure) => figure.sourceContentUnitIds === undefined)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([]);
  });

  it('fetches only the lesson’s own units, and at most the drawing limit', async () => {
    const guide = {
      guideId: 'tg-1',
      items: [drawing('6249', '11', 0), drawing('9999', '1', 1), drawing('6249', '12', 2)],
    };
    const fetchImpl = transport({});
    const figures = await acquireGuideAnswerFigures(
      guide,
      policy(fetchImpl, { unitIds: new Set(['6249']), maxFigures: 1 }),
    );
    expect(figures.map((figure) => figure.id)).toEqual(['src-guide-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      'Teacher-guide drawing 6249/12 is over the 1-drawing limit; left out',
    ]);
  });

  it.each([
    [
      'a checksum that does not match',
      PNG,
      { checksumSha256: 'd'.repeat(64) },
      'checksum does not match',
    ],
    ['a body shorter than declared', PNG, { sizeBytes: PNG.length + 5 }, 'size does not match'],
    [
      'a body longer than declared',
      PNG,
      { sizeBytes: PNG.length - 1 },
      'larger than its declared size',
    ],
    ['bytes that are not a PNG', JPEG, {}, 'is not a PNG'],
  ])(
    'leaves out %s, once, logging the item but never its URL',
    async (_name, served, image, reason) => {
      const item = drawing('6249', '12', 1, served, image);
      const fetchImpl = transport({ 1: served });
      const figures = await acquireGuideAnswerFigures(
        { guideId: 'tg-1', items: [item] },
        policy(fetchImpl),
      );
      expect(figures).toEqual([]);
      // An integrity failure is final: never retried.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(warnings).toEqual([`Teacher-guide drawing 6249/12 ${reason}; left out`]);
      expect(warnings.join('\n')).not.toContain('X-Amz-Signature');
    },
  );

  it('retries a transient failure, and gives up on a refused content type at once', async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1)
        throw new Error('socket hang up https://r2.example.test/?X-Amz-Signature=s1');
      return respond(PNG);
    });
    const kept = await acquireGuideAnswerFigures(
      { guideId: 'tg-1', items: [drawing('6249', '12', 1)] },
      policy(flaky as never),
    );
    expect(kept.map((figure) => figure.id)).toEqual(['src-guide-1']);
    expect(flaky).toHaveBeenCalledTimes(2);

    const html = transport({ 1: [PNG, 'text/html'] });
    const refused = await acquireGuideAnswerFigures(
      { guideId: 'tg-1', items: [drawing('6249', '12', 1)] },
      policy(html, { maxAttempts: 3 }),
    );
    expect(refused).toEqual([]);
    expect(html).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(['Teacher-guide drawing 6249/12 could not be downloaded; left out']);
  });

  it('never throws: a dead link leaves the drawing out and the others in', async () => {
    const fetchImpl = transport({
      1: new Error('ECONNRESET https://r2.example.test/?X-Amz-Signature=s1'),
    });
    const figures = await acquireGuideAnswerFigures(
      { guideId: 'tg-1', items: [drawing('6249', '12', 1), drawing('6249', '14', 2)] },
      policy(fetchImpl, { maxAttempts: 2 }),
    );
    expect(figures.map((figure) => figure.id)).toEqual(['src-guide-2']);
    expect(warnings.join('\n')).not.toContain('X-Amz-Signature');
  });

  it('reads nothing from a record without its URL (every record read after the run)', async () => {
    const { url: _url, ...stable } = (
      drawing('6249', '12', 1).modelAnswer as { image: object } & {
        image: { url?: string };
      }
    ).image;
    const fetchImpl = transport({});
    const figures = await acquireGuideAnswerFigures(
      {
        guideId: 'tg-1',
        items: [
          {
            contentUnitId: '6249',
            label: '12',
            status: 'reference',
            modelAnswer: { kind: 'figure', image: stable as never },
          },
        ],
      },
      policy(fetchImpl),
    );
    expect(figures).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('materializeSourceImages — a guide answer drawing', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'guidefig-'));
    vi.stubEnv('OPENMAIC_CLASSROOMS_DIR', tmp);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('is stored as `guide_<n>_<sha8>.png` beside the book images, never as a book image', async () => {
    const [figure] = await acquireGuideAnswerFigures(
      { guideId: 'tg-1', items: [drawing('6249', '12', 1)] },
      policy(transport({})),
    );
    // CLASSROOMS_DIR binds at module load; re-import under the stubbed env.
    vi.resetModules();
    const { materializeSourceImages } = await import('@/lib/server/teaching-package/source-images');
    const { servingMapping, manifest } = await materializeSourceImages(
      [figure!],
      'Stage_fig1',
      'cs-1',
    );
    const file = `guide_1_${sha(PNG).slice(0, 8)}.png`;
    expect(servingMapping).toEqual({
      'src-guide-1': `/api/classroom-media/Stage_fig1/media/${file}`,
    });
    expect(manifest).toEqual([
      expect.objectContaining({
        id: 'src-guide-1',
        sha256: sha(PNG),
        mimeType: 'image/png',
        sourceRole: GUIDE_FIGURE_SOURCE_ROLE,
        servingPath: servingMapping['src-guide-1'],
      }),
    ]);
    // No content unit: a slide inserted for its unit never picks it up.
    expect(manifest[0]!.sourceContentUnitIds).toBeUndefined();
    expect(await fs.readdir(path.join(tmp, 'Stage_fig1', 'media'))).toEqual([file]);
    expect(await fs.readFile(path.join(tmp, 'Stage_fig1', 'media', file))).toEqual(PNG);
  });
});
