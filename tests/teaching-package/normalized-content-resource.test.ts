import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import {
  acquireNormalizedContentResource,
  adaptNormalizedText,
  type NormalizedLessonManifest,
} from '@/lib/server/teaching-package/normalized-content-resource';
import type { KafuoNormalizedContentResource } from '@/lib/types/teaching-package';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3,
  0, 0, 0, 2, 8, 6, 0, 0, 0,
]);
const mediaPath = `media/${createHash('sha256').update(PNG).digest('hex')}.png`;

function manifest(overrides: Partial<NormalizedLessonManifest> = {}): NormalizedLessonManifest {
  return {
    schemaVersion: 'kafuo.normalized-content.v1',
    packageId: 'ncr-1',
    learningItem: { type: 'lesson', id: 'li-1' },
    contentSource: { id: 'cs-1' },
    contentRevisionId: 'rev-1',
    parseRunId: 'run-1',
    structureProfile: { id: 'profile-1', versionId: 'profile-v1' },
    language: 'ar',
    pageCount: 2,
    contentUnits: [
      {
        id: 'cu-1',
        orderIndex: 0,
        role: 'EXPLANATION',
        title: 'Unit',
        // The approved projection the LLM receives. Kafuo derives it from the
        // included blocks (`normalized_content_export.py`), and it — not the
        // blocks — is what this resource is required to render.
        normalizedText: 'authoritative text',
        blocks: [
          {
            id: 'block-1',
            orderIndex: 0,
            blockType: 'text',
            text: 'authoritative text',
            page: 1,
            disposition: 'included',
            associatedVisualIds: ['visual-1'],
          },
        ],
      },
    ],
    visuals: [
      {
        id: 'visual-1',
        mediaPath,
        mimeType: 'image/png',
        sizeBytes: PNG.length,
        checksumSha256: createHash('sha256').update(PNG).digest('hex'),
        width: 3,
        height: 2,
        pageNumber: 1,
        sourceBlockId: 'block-1',
        providerVisualId: 'provider-9',
        contentUnitIds: ['cu-1'],
        blockIds: ['block-1'],
        caption: 'Figure A',
        visionPriority: 10,
      },
    ],
    ...overrides,
  };
}

async function archive(value = manifest(), extra?: (zip: JSZip) => void): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(value));
  zip.file(mediaPath, PNG);
  extra?.(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function resource(
  bytes: Buffer,
  overrides: Partial<KafuoNormalizedContentResource> = {},
): KafuoNormalizedContentResource {
  return {
    id: 'ncr-1',
    url: 'https://r2.example.test/n.zip?sig=secret',
    mimeType: 'application/zip',
    schemaVersion: 'kafuo.normalized-content.v1',
    contentSourceId: 'cs-1',
    contentRevisionId: 'rev-1',
    parseRunId: 'run-1',
    structureProfile: { id: 'profile-1', versionId: 'profile-v1' },
    fileSizeBytes: bytes.length,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    ...overrides,
  };
}

const fetchFor = (bytes: Buffer) =>
  vi.fn(
    async () =>
      new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'application/zip', 'content-length': String(bytes.length) },
      }),
  );

describe('normalized content acquisition', () => {
  it('validates, renders deterministic grounding, and adapts provider visuals', async () => {
    const bytes = await archive();
    const fetchImpl = fetchFor(bytes);
    const source = await acquireNormalizedContentResource(
      resource(bytes),
      { type: 'lesson', id: 'li-1' },
      { secureFetch: fetchImpl as never, dispatcher: {} as never },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(source.text).toContain('CONTENT_UNIT id=cu-1');
    expect(source.text).toContain('authoritative text');
    // Blocks are internal evidence: they stay in the manifest for association and
    // integrity checks, and never reach the model.
    expect(source.text).not.toContain('BLOCK');
    expect(source.text).not.toContain('block-1');
    expect(source.manifest.contentUnits[0]!.blocks[0]!.id).toBe('block-1');
    expect(source.blockCount).toBe(1);
    expect(source.visionImages[0]).toMatchObject({
      id: 'src-1',
      sourceContentUnitIds: ['cu-1'],
      sourceBlockIds: ['block-1'],
      providerVisualId: 'provider-9',
    });
  });

  it('renders the same manifest deterministically', () => {
    expect(adaptNormalizedText(manifest())).toBe(adaptNormalizedText(manifest()));
  });

  describe('Content-Unit projection (what the LLM actually receives)', () => {
    /**
     * The authority model: the approved Content Unit is the pedagogical unit sent to the
     * model; document Blocks are lower-level extraction evidence that stays internal.
     * Rendering blocks is what produced 33 scenes grounded in nothing citable.
     */
    it('renders the approved normalizedText, not the blocks it was derived from', () => {
      const rendered = adaptNormalizedText(
        manifest({
          contentUnits: [
            {
              id: 'cu-1',
              orderIndex: 0,
              role: 'INSTRUCTIONAL',
              subtype: 'concept',
              title: 'Photosynthesis',
              normalizedText: 'The approved unit text.',
              blocks: [
                {
                  id: '51061',
                  orderIndex: 0,
                  blockType: 'text',
                  role: 'instructional',
                  text: 'raw block one',
                  page: 2,
                  disposition: 'included',
                  associatedVisualIds: ['visual-1'],
                },
                {
                  id: '51062',
                  orderIndex: 1,
                  blockType: 'text',
                  text: 'raw block two',
                  page: 2,
                  disposition: 'included',
                },
              ],
            },
          ],
        }),
      );

      expect(rendered).toBe(
        '[[CONTENT_UNIT id=cu-1 order=0 role=INSTRUCTIONAL subtype=concept]]\n' +
          'TITLE: Photosynthesis\n' +
          'The approved unit text.\n' +
          '[[/CONTENT_UNIT]]',
      );
      // No block marker, no block id, no block type/role/page, no per-block visual list.
      expect(rendered).not.toContain('BLOCK');
      expect(rendered).not.toContain('51061');
      expect(rendered).not.toContain('51062');
      expect(rendered).not.toContain('raw block');
      expect(rendered).not.toContain('visual-1');
    });

    it('keeps the blocks in the manifest for internal validation', () => {
      // The projection changes what the MODEL sees. The transport schema is untouched:
      // blocks still resolve visuals, prove associations, and carry page diagnostics.
      const m = manifest();
      adaptNormalizedText(m);
      expect(m.contentUnits[0]!.blocks).toHaveLength(1);
      expect(m.contentUnits[0]!.blocks[0]).toMatchObject({
        id: 'block-1',
        page: 1,
        associatedVisualIds: ['visual-1'],
      });
    });

    it('emits one entry per approved unit, in orderIndex order', () => {
      const rendered = adaptNormalizedText(
        manifest({
          contentUnits: [
            { id: 'cu-b', orderIndex: 1, role: 'INSTRUCTIONAL', normalizedText: 'second', blocks: [] },
            { id: 'cu-a', orderIndex: 0, role: 'INSTRUCTIONAL', normalizedText: 'first', blocks: [] },
          ],
        }),
      );
      expect(rendered.indexOf('cu-a')).toBeLessThan(rendered.indexOf('cu-b'));
      expect(rendered.match(/\[\[CONTENT_UNIT /g)).toHaveLength(2);
      expect(rendered.match(/\[\[\/CONTENT_UNIT\]\]/g)).toHaveLength(2);
    });

    it('fails closed on a teaching unit with no usable normalized text', () => {
      /* Fail-closed rather than reassembling the blocks: an un-normalized instructional
         unit is a Kafuo-side defect, and hiding it behind raw block text would ground the
         lesson in text no reviewer approved. */
      expect(() =>
        adaptNormalizedText(
          manifest({
            contentUnits: [
              { id: 'cu-ok', orderIndex: 0, role: 'INSTRUCTIONAL', normalizedText: 'fine', blocks: [] },
              {
                id: 'cu-bad',
                orderIndex: 1,
                role: 'INSTRUCTIONAL',
                blocks: [
                  { id: 'b-9', orderIndex: 0, blockType: 'text', text: 'unapproved', disposition: 'included' },
                ],
              },
            ],
          }),
        ),
      ).toThrowError(/cu-bad/);
    });

    it('skips a figure-only unit instead of failing the package', () => {
      // Legitimately teaches no prose: its visuals reach the model through the vision
      // channel, associated by this unit's id.
      const rendered = adaptNormalizedText(
        manifest({
          contentUnits: [
            { id: 'cu-text', orderIndex: 0, role: 'INSTRUCTIONAL', normalizedText: 'body', blocks: [] },
            {
              id: 'cu-figure',
              orderIndex: 1,
              role: 'INSTRUCTIONAL',
              blocks: [
                {
                  id: 'b-fig',
                  orderIndex: 0,
                  blockType: 'figure',
                  disposition: 'included',
                  associatedVisualIds: ['visual-1'],
                },
              ],
            },
          ],
        }),
      );
      expect(rendered).toContain('cu-text');
      expect(rendered).not.toContain('cu-figure');
    });

    it('skips a text-less reference unit, per the non-instructional carve-out', () => {
      const rendered = adaptNormalizedText(
        manifest({
          contentUnits: [
            { id: 'cu-text', orderIndex: 0, role: 'INSTRUCTIONAL', normalizedText: 'body', blocks: [] },
            { id: 'cu-ref', orderIndex: 1, role: 'REFERENCE', blocks: [] },
            { id: 'cu-unk', orderIndex: 2, role: 'UNCLASSIFIED', blocks: [] },
          ],
        }),
      );
      expect(rendered).toContain('cu-text');
      expect(rendered).not.toContain('cu-ref');
      expect(rendered).not.toContain('cu-unk');
    });
  });

  it('retries a transient package download within the bounded policy', async () => {
    const bytes = await archive();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-length': String(bytes.length),
          },
        }),
      );
    await expect(
      acquireNormalizedContentResource(
        resource(bytes),
        { type: 'lesson', id: 'li-1' },
        { secureFetch: fetchImpl as never, dispatcher: {} as never, maxAttempts: 2 },
      ),
    ).resolves.toMatchObject({ measuredBytes: bytes.length });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails closed on request/manifest lineage mismatch', async () => {
    const bytes = await archive();
    await expect(
      acquireNormalizedContentResource(
        resource(bytes, { parseRunId: 'newer-run' }),
        { type: 'lesson', id: 'li-1' },
        { secureFetch: fetchFor(bytes) as never, dispatcher: {} as never },
      ),
    ).rejects.toMatchObject({ code: 'NORMALIZED_CONTENT_LINEAGE_MISMATCH' });
  });

  it('rejects package checksum mismatch before opening the archive', async () => {
    const bytes = await archive();
    await expect(
      acquireNormalizedContentResource(
        resource(bytes, { checksumSha256: '0'.repeat(64) }),
        { type: 'lesson', id: 'li-1' },
        { secureFetch: fetchFor(bytes) as never, dispatcher: {} as never },
      ),
    ).rejects.toMatchObject({ code: 'NORMALIZED_CONTENT_INTEGRITY_MISMATCH' });
  });

  it('enforces archive file, expanded-byte, and individual-media limits', async () => {
    const bytes = await archive();
    for (const policy of [
      { maxFiles: 1 },
      { maxExpandedBytes: 1 },
      { maxMediaBytes: PNG.length - 1 },
    ]) {
      await expect(
        acquireNormalizedContentResource(
          resource(bytes),
          { type: 'lesson', id: 'li-1' },
          { secureFetch: fetchFor(bytes) as never, dispatcher: {} as never, ...policy },
        ),
      ).rejects.toMatchObject({ code: 'NORMALIZED_CONTENT_ARCHIVE_INVALID' });
    }
  });

  it('rejects a missing manifest and duplicate content identities', async () => {
    const noManifest = await new JSZip().file(mediaPath, PNG).generateAsync({ type: 'nodebuffer' });
    await expect(
      acquireNormalizedContentResource(
        resource(noManifest),
        { type: 'lesson', id: 'li-1' },
        { secureFetch: fetchFor(noManifest) as never, dispatcher: {} as never },
      ),
    ).rejects.toMatchObject({ code: 'NORMALIZED_CONTENT_ARCHIVE_INVALID' });

    const unit = manifest().contentUnits[0]!;
    const duplicated = manifest({ contentUnits: [unit, { ...unit }] });
    const bytes = await archive(duplicated);
    await expect(
      acquireNormalizedContentResource(
        resource(bytes),
        { type: 'lesson', id: 'li-1' },
        { secureFetch: fetchFor(bytes) as never, dispatcher: {} as never },
      ),
    ).rejects.toMatchObject({ code: 'NORMALIZED_CONTENT_ARCHIVE_INVALID' });
  });

  it('consumes the byte-exact cross-repository normalized-package fixture', async () => {
    const bytes = Buffer.from(
      readFileSync(
        path.join(__dirname, '..', 'fixtures', 'normalized-package-v1.b64'),
        'utf8',
      ).trim(),
      'base64',
    );
    const fixtureResource = resource(bytes, {
      id: 'ncr-3922cc4f151f2baa3bc79e7fcbfd028d90cad2f5f856d92982cc90fab01b2726',
    });
    const source = await acquireNormalizedContentResource(
      fixtureResource,
      { type: 'lesson', id: 'li-1' },
      { secureFetch: fetchFor(bytes) as never, dispatcher: {} as never },
    );
    expect(source.text).toContain('authoritative text');
    expect(source.visionImages[0]).toMatchObject({
      sourceContentUnitIds: ['cu-1'],
      sourceBlockIds: ['block-1'],
    });
  });

  it('rejects dangling and asymmetric associations', async () => {
    const bad = manifest({ visuals: [{ ...manifest().visuals[0]!, blockIds: ['other'] }] });
    const bytes = await archive(bad);
    await expect(
      acquireNormalizedContentResource(
        resource(bytes),
        { type: 'lesson', id: 'li-1' },
        { secureFetch: fetchFor(bytes) as never, dispatcher: {} as never },
      ),
    ).rejects.toMatchObject({ code: 'NORMALIZED_CONTENT_ASSOCIATION_INVALID' });
  });

  it('rejects media checksum/dimension mismatch and empty authoritative text', async () => {
    const badMedia = manifest({ visuals: [{ ...manifest().visuals[0]!, width: 999 }] });
    let bytes = await archive(badMedia);
    await expect(
      acquireNormalizedContentResource(
        resource(bytes),
        { type: 'lesson', id: 'li-1' },
        { secureFetch: fetchFor(bytes) as never, dispatcher: {} as never },
      ),
    ).rejects.toMatchObject({ code: 'NORMALIZED_CONTENT_MEDIA_INVALID' });

    // Emptiness is decided by the APPROVED unit text, and the block text is
    // deliberately left intact: a package whose units carry no normalized text
    // must fail rather than quietly fall back to reassembled block text.
    const empty = manifest({
      contentUnits: [{ ...manifest().contentUnits[0]!, normalizedText: '  ' }],
    });
    bytes = await archive(empty);
    await expect(
      acquireNormalizedContentResource(
        resource(bytes),
        { type: 'lesson', id: 'li-1' },
        { secureFetch: fetchFor(bytes) as never, dispatcher: {} as never },
      ),
    ).rejects.toMatchObject({ code: 'NORMALIZED_CONTENT_EMPTY' });
  });

  it('rejects archive traversal before generation', async () => {
    const bytes = await archive(manifest(), (zip) => zip.file('../escape.txt', 'x'));
    await expect(
      acquireNormalizedContentResource(
        resource(bytes),
        { type: 'lesson', id: 'li-1' },
        { secureFetch: fetchFor(bytes) as never, dispatcher: {} as never },
      ),
    ).rejects.toMatchObject({ code: 'NORMALIZED_CONTENT_ARCHIVE_INVALID' });
  });
});
