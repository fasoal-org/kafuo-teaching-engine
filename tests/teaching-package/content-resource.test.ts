import { describe, expect, it, vi } from 'vitest';

import type { KafuoContentResource } from '@/lib/types/teaching-package';
import {
  acquireContentResource,
  ContentResourceAcquisitionError,
} from '@/lib/server/teaching-package/content-resource';
import type { ParsedPdfContent } from '@/lib/types/pdf';

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.alloc(64, 0x20),
]);

function okFetch(bytes: Buffer = PDF_BYTES): never {
  return ((input: string | URL, init?: RequestInit) =>
    new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) },
    })) as never;
}

function parsedWith(images: Array<{ id: string; src: string; pageNumber: number }> = []): ParsedPdfContent {
  return {
    text: 'lesson text',
    images: images.map((image) => image.src),
    metadata: { pageCount: 3, pdfImages: images },
  } as ParsedPdfContent;
}

function okExtract(parsed: ParsedPdfContent) {
  return (async () => ({
    metadata: { fileName: 'lesson.pdf', fileSize: PDF_BYTES.length, mimeType: 'application/pdf', pageCount: 3, providerId: 'unpdf', processingTime: 1 },
    blocks: [{ type: 'text', text: parsed.text, pageNumber: 1 }],
    assets: [],
  })) as never;
}

function resource(overrides: Partial<KafuoContentResource> = {}): KafuoContentResource {
  return {
    id: 'cs-1',
    url: 'https://r2.example.test/lesson.pdf?sig=abc',
    mimeType: 'application/pdf',
    ...overrides,
  };
}

describe('acquireContentResource (Layer A)', () => {
  it('downloads, validates, extracts, and normalizes once', async () => {
    const fetchImpl = vi.fn(okFetch());
    const extract = vi.fn(okExtract(parsedWith()));
    const source = await acquireContentResource(resource(), {
      secureFetch: fetchImpl as never,
      extract: extract as never,
      maxAttempts: 3,
      dispatcher: {} as never,
    });
    expect(source.text).toBe('lesson text');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(source.measuredBytes).toBe(PDF_BYTES.length);
    expect(source.measuredSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(source.normalizedImages).toHaveLength(0);
    // Errors/messages never carry the retrieval URL.
    expect(source.text).not.toContain('sig=abc');
  });

  it('retries transient download failures within the policy, then succeeds', async () => {
    const attempts = vi.fn()
      .mockRejectedValueOnce(new Error('network hiccup'))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(PDF_BYTES), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
      );
    const extract = vi.fn(okExtract(parsedWith()));
    const source = await acquireContentResource(resource(), {
      secureFetch: attempts as never,
      extract: extract as never,
      maxAttempts: 3,
    });
    expect(source.text).toBe('lesson text');
    expect(attempts).toHaveBeenCalledTimes(2);
  });

  it('fails terminally on a non-PDF body (no retry)', async () => {
    const fetchImpl = vi.fn(okFetch(Buffer.from('<html>not a pdf</html>')));
    const extract = vi.fn(okExtract(parsedWith()));
    await expect(
      acquireContentResource(resource(), {
        secureFetch: fetchImpl as never,
        extract: extract as never,
        maxAttempts: 3,
        dispatcher: {} as never,
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_RESOURCE_NOT_PDF', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails terminally on a checksum mismatch', async () => {
    await expect(
      acquireContentResource(
        resource({ checksumSha256: 'deadbeef'.repeat(8) }),
        { secureFetch: okFetch() as never, extract: okExtract(parsedWith()) as never, maxAttempts: 2, dispatcher: {} as never },
      ),
    ).rejects.toMatchObject({ code: 'CONTENT_RESOURCE_INTEGRITY_MISMATCH', retryable: false });
  });

  it('fails terminally on a size mismatch', async () => {
    await expect(
      acquireContentResource(resource({ fileSizeBytes: 3 }), {
        secureFetch: okFetch() as never,
        extract: okExtract(parsedWith()) as never,
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_RESOURCE_INTEGRITY_MISMATCH' });
  });

  it('retries provider-transient extraction failures and fails terminally when empty', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('provider 502'));
    await expect(
      acquireContentResource(resource(), {
        secureFetch: okFetch() as never,
        extract: failing as never,
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({ code: 'PDF_EXTRACTION_FAILED', retryable: true });
    expect(failing).toHaveBeenCalledTimes(2);

    const emptyExtract = vi.fn(
      (async () => ({
        metadata: { pageCount: 0 },
        blocks: [],
        assets: [],
      })) as never,
    );
    await expect(
      acquireContentResource(resource(), {
        secureFetch: okFetch() as never,
        extract: emptyExtract as never,
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({ code: 'PDF_CONTENT_EMPTY', retryable: false });
    expect(emptyExtract).toHaveBeenCalledTimes(1);
  });

  it('exhausts transient download retries and surfaces a safe message (no URL)', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('ECONNRESET https://r2.example.test/secret'));
    const caught = await acquireContentResource(resource(), {
      secureFetch: failing as never,
      extract: okExtract(parsedWith()) as never,
      maxAttempts: 2,
      dispatcher: {} as never,
    }).catch((error: unknown) => error);
    const error = caught as ContentResourceAcquisitionError;
    expect(error).toBeInstanceOf(ContentResourceAcquisitionError);
    expect(error.code).toBe('CONTENT_RESOURCE_DOWNLOAD_FAILED');
    expect(error.message).not.toContain('sig=');
    expect(error.message).not.toContain('r2.example.test');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('normalizes extracted source visuals into the vision channel', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0,
    ]);
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    // The real pdf-compat adapter builds pdfImages from the artifact's image
    // assets — exercise that boundary with a genuine asset entry.
    const extract = vi.fn(async () => ({
      metadata: { fileName: 'lesson.pdf', fileSize: PDF_BYTES.length, mimeType: 'application/pdf', pageCount: 3, providerId: 'unpdf', processingTime: 1 },
      blocks: [{ type: 'text', text: 'lesson text', pageNumber: 1 }],
      assets: [
        {
          type: 'image' as const,
          id: 'img_1',
          data: dataUrl,
          pageNumber: 2,
          mimeType: 'image/png',
        },
      ],
    }));
    const source = await acquireContentResource(resource(), {
      secureFetch: okFetch() as never,
      extract: extract as never,
      maxAttempts: 1,
      dispatcher: {} as never,
    });
    expect(source.normalizedImages).toHaveLength(1);
    expect(source.visionImages[0]).toMatchObject({ id: 'src-1', pageNumber: 2 });
    expect(source.visionMapping['src-1']).toBe(dataUrl);
  });
});
