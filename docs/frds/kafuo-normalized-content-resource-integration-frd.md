# Functional Requirements Document

## Kafuo Normalized Content Resource → Teaching Engine Integration

| Document attribute | Value |
|---|---|
| Product | Kafuo / Kafuo Teaching Engine (OpenMAIC) |
| Document type | Functional Requirements Document (FRD) |
| Version | 0.2 |
| Status | READY FOR FINAL APPROVAL REVIEW |
| Date | 2026-09-16 |
| Scope | Replace duplicate PDF parsing in the Kafuo Teaching Package generation path with consumption of Kafuo's approved normalized lesson content |
| Related approved baseline | `docs/frds/kafuo-teaching-engine-integration-frd.md`, version 0.2 |
| Excluded deliverables | Implementation plan, task breakdown, database migration scripts, and code changes |

## 1. Executive Summary and Functional Decision

Kafuo already parses the lesson PDF through its document-intelligence pipeline, applies the selected Structure Profile, creates ordered Content Units and blocks, preserves page and layout lineage, stores provider-extracted visual evidence, and records review and correction state. The authoritative export lineage is the approved Content Revision, the exact parse run that produced that revision, and the exact Structure Profile version used to produce it. A newer currently-active parse run is not authoritative for that approved revision unless it is the revision's recorded lineage. The current Teaching Engine request does not transmit that normalized result. It transmits only the original PDF resource, causing OpenMAIC to download and parse the PDF a second time.

The duplicate parse is the source of the current visual-quality and association problem. OpenMAIC's fallback parser extracts raw PDF image objects, including decorative frames, labels, and other non-instructional objects, and then asks the generation model to reconstruct text-to-visual relevance from those objects. Kafuo already holds the more accurate normalized text, ordered structure, visual evidence, and block-to-Content-Unit linkage.

The required target behavior is:

```text
Kafuo approved lesson content
  → immutable normalized content package
  → transient authenticated download URL in the generation request
  → OpenMAIC secure bounded download and validation
  → deterministic adapter to the existing generation input
  → existing generateClassroom(...) path
  → existing exact-flow validation and Teaching Package lifecycle
```

For a request carrying a valid `normalizedContentResource`, OpenMAIC must not download or parse the original PDF. Kafuo's approved normalized content, including its authoritative source visuals and their canonical Content Unit → ordered Block → associated visual relationships, becomes the lesson-source authority available to generation.

The original `contentResource` remains in the request during Version 1 only for source identity, provenance, integrity lineage, and rollout compatibility. When `normalizedContentResource` is absent, the existing PDF acquisition/parsing fallback may run. When `normalizedContentResource` is present but invalid or unavailable, normalized acquisition retries according to policy and the attempt fails if still unsuccessful; OpenMAIC must not silently acquire or parse the PDF.

The public `generateClassroom(...)` contract and the existing Teaching Package lifecycle remain the generation foundation. The integration must occur immediately before the existing call in `OpenMAIC/lib/server/teaching-package/generation-runner.ts`. Minimal internal adaptations are required to preserve Kafuo's visual associations through the existing source-visual channel.

## 2. Purpose

This FRD defines:

1. the normalized lesson-content package Kafuo must expose;
2. the generation-request extension that authorizes OpenMAIC to download it;
3. the validation and adaptation behavior inside OpenMAIC;
4. how normalized text, Content Units, blocks, visuals, page lineage, and source associations reach the existing generation path;
5. the required persistence, security, idempotency, failure, and fallback behavior; and
6. the exact code areas affected in Kafuo and OpenMAIC.

## 3. Current State Proven by Code

### 3.1 Kafuo sends the original PDF today

`BuildTeachingEngineGenerationRequestUseCase._resource_facts(...)` reads the lesson-scoped `content_sources` row and returns the original object-storage key, file size, checksum, name, and MIME type:

- `zakrly-backend/app/modules/teaching_engine/application/build_generation_request.py:356-433`

`SendTeachingEngineGenerationUseCase.execute(...)` stores the semantic request snapshot without a URL, creates a transient presigned URL for that original object, and inserts the URL into `contentResource` only when building the wire request:

- claim and stored source key: `zakrly-backend/app/modules/teaching_engine/application/send_generation_request.py:95-119`
- transient URL minting: `send_generation_request.py:121-126`
- wire insertion: `send_generation_request.py:158-165`

No normalized Kafuo parse artifact is included in the current request.

### 3.2 OpenMAIC reparses that PDF today

The current request contract accepts one PDF resource:

```ts
export interface KafuoContentResource {
  id: string;
  url: string;
  fileName?: string;
  mimeType: 'application/pdf';
  fileSizeBytes?: number;
  checksumSha256?: string;
}
```

Evidence:

- `OpenMAIC/lib/types/teaching-package.ts:306-316`
- `KafuoGenerationRequest.contentResource`: `OpenMAIC/lib/types/teaching-package.ts:318-332`

`parseContentResource(...)` requires a PDF and validates the transient URL:

- `OpenMAIC/lib/server/teaching-package/kafuo-request.ts:73-114`

`acquireContentResource(...)` then performs:

```text
contentResource.url
  → fetchBytesSecurely(...)
  → PDF magic/size/checksum validation
  → extractDocument(...)
  → documentArtifactToParsedPdfContent(...)
  → normalizeSourceImages(...)
  → NormalizedSource
```

Evidence:

- acquisition entry point: `OpenMAIC/lib/server/teaching-package/content-resource.ts:119-238`
- secure download: `content-resource.ts:132-148`
- PDF and integrity validation: `content-resource.ts:150-187`
- document extraction: `content-resource.ts:189-207`
- visual normalization: `content-resource.ts:218-234`

### 3.3 The existing pre-generation seam

`runKafuoAttempt(...)` currently acquires the PDF, stores extracted text, constructs `GenerationExecutionInput`, and calls `generateClassroom(...)`:

```text
acquireContentResource(kafuo.contentResource)
  → source.text / source.images / source.visionImages
  → execution.pdfContent
  → generateClassroom(execution, { sourceVisuals })
```

Evidence:

- acquisition: `OpenMAIC/lib/server/teaching-package/generation-runner.ts:97-108`
- retained source context: `generation-runner.ts:109-118`
- `execution.pdfContent`: `generation-runner.ts:120-129`
- `generateClassroom(...)`: `generation-runner.ts:157-182`

The exact current generation argument containing lesson content is:

```ts
pdfContent: {
  text: source.text,
  images: source.images,
  pdfImages: source.visionImages,
}
```

`GenerateClassroomInput` currently defines that field as:

```ts
pdfContent?: { text: string; images: string[]; pdfImages?: PdfImage[] };
```

Evidence: `OpenMAIC/lib/server/classroom-generation.ts:66-86`.

### 3.4 Kafuo already holds the normalized structure required by generation

The Kafuo schema already represents:

- ordered Content Units, role, subtype, title, normalized text, profile version, review state, and correction provenance in `content_units`;
- ordered block membership and included/excluded disposition in `content_unit_blocks`;
- source blocks, normalized text, type, page ownership, layout geometry, suppression state, and durable evidence identity in `document_blocks`;
- visual candidates with parse-run, page, source-block, caption, label, decision, and detection provenance in `visual_candidates`; and
- stored provider visual bytes with parse-run identity, page, provider block identity, MIME type, checksum, dimensions, metadata, and private storage URI in `provider_visual_evidence`.

Evidence:

- `zakrly-backend/app/modules/content_sources/infrastructure/models/content_unit_model.py:56-168`
- `content_unit_model.py:170-250`
- `zakrly-backend/app/modules/content_sources/infrastructure/models/document_block_model.py:38-180` and following source-evidence fields
- `zakrly-backend/app/modules/content_sources/infrastructure/models/educational_asset_models.py:108-225`
- `zakrly-backend/app/modules/content_sources/infrastructure/models/provider_visual_evidence_model.py:66-177`

The Version 1 handoff must use this reviewed block-level lineage. It must not depend on `educational_assets` or `asset_content_unit_associations` being populated when the authoritative provider visual is already linked through its visual candidate and source block.

## 4. Goals

The integration must:

1. eliminate duplicate PDF parsing for generation requests carrying a valid normalized resource;
2. use Kafuo's approved normalized text and ordered Content Units as the authoritative lesson content;
3. use Kafuo's stored provider visuals instead of raw image objects re-extracted from the PDF;
4. preserve deterministic Content Unit → block → visual associations through generation;
5. preserve machine-readable Content Unit/block grounding on generated and persisted outlines;
6. retain the existing `generateClassroom(...)` entry point and Teaching Package lifecycle;
7. keep all signed URLs and raw media out of durable request snapshots, logs, webhooks, and API responses;
8. maintain semantic idempotency across Kafuo and OpenMAIC; and
9. provide a bounded, observable PDF fallback only when `normalizedContentResource` is absent during Version 1 rollout.

## 5. Non-goals

This FRD does not:

1. redesign `generateClassroom(...)`;
2. introduce a new PDF parser in OpenMAIC;
3. move Datalab or Structure Profile execution into OpenMAIC;
4. make OpenMAIC query the Kafuo database directly;
5. share a Python/TypeScript runtime component between services;
6. change Teaching Package status, Stage, Scene, review, webhook, handoff, or exact-flow semantics;
7. require creation of `educational_assets` before a stored provider visual can ground a Teaching Package;
8. expose private R2 URIs or provider credentials to OpenMAIC; or
9. authorize the Admin browser to download or forward the normalized package; or
10. enable or expand SECTION generation. The manifest mirrors the existing Learning Item identity vocabulary, but existing SECTION fail-closed behavior remains unchanged.

## 6. Ownership Boundaries

| Concern | Authority |
|---|---|
| Original PDF and Content Source identity | Kafuo |
| Content Revision approval and operator corrections | Kafuo |
| Exact parse run that produced the approved Content Revision | Kafuo |
| Exact Structure Profile version that produced the approved Content Revision | Kafuo |
| Ordered Content Units and blocks | Kafuo |
| Authoritative source visuals and source associations | Kafuo |
| Immutable normalized package creation | Kafuo |
| Transient download authorization | Kafuo |
| Package transport validation | OpenMAIC |
| Adaptation to generation input | OpenMAIC |
| Teaching Model Flow execution and exact-flow validation | OpenMAIC |
| Stage, Scenes, Teaching Package lifecycle, and handoff | OpenMAIC |

OpenMAIC must consume an immutable representation of Kafuo's approved output. The authority chain is `approved Content Revision → exact associated parse run → exact associated Structure Profile version → exported normalized package`. OpenMAIC must not recreate Kafuo's structure decisions, substitute a newer active parse run, or silently replace the normalized resource with a second PDF parse.

## 7. Target End-to-End Flow

### 7.1 Kafuo preparation

1. Kafuo resolves the same tenant-scoped Learning Item, approved Learning Objectives, Teaching Model version and flow, and lesson-scoped Content Source used by the approved integration.
2. Kafuo resolves the approved Content Revision selected for export.
3. From that approved revision's recorded lineage, Kafuo resolves the exact parse run and exact Structure Profile identity/version that produced it. Kafuo must not substitute a newer currently-active parse run or profile version.
4. Kafuo reads ordered Content Units and their ordered included blocks.
5. Kafuo resolves stored provider visuals through visual candidate/source-block lineage.
6. Kafuo creates or reuses an immutable normalized content package bound to the requested Learning Item and the exact approved-revision lineage. Its identity changes whenever any exported content, association, lineage fact, or media byte changes.
7. Kafuo stores only stable package identity and integrity facts in its command snapshot.
8. After the command claim, Kafuo mints a short-lived URL for the immutable package and sends it to OpenMAIC.

### 7.2 OpenMAIC consumption

1. OpenMAIC validates the request and semantic digest.
2. When `normalizedContentResource` is present, OpenMAIC downloads only the normalized package once per generation attempt using the existing secure-fetch controls; it does not download the original PDF.
3. OpenMAIC validates MIME type, size, checksum, archive bounds, the exact V1 schema identifier, manifest references, media checksums, request/manifest Learning Item scope, and explicit lineage equality.
4. OpenMAIC deterministically renders the ordered normalized lesson content into the existing textual generation channel.
5. OpenMAIC converts authoritative Kafuo visuals into the existing normalized source-image and `PdfImage` channels without re-extracting the PDF.
6. OpenMAIC preserves Content Unit, block, page, caption, and visual identities as provenance and prompt metadata.
7. OpenMAIC calls the existing `generateClassroom(...)` path.
8. The existing exact-flow gate validates the generated outlines and Scenes before package binding.

### 7.3 Call-chain diagram

```text
Kafuo approved Content Revision
  → exact associated parse run
  → exact associated Structure Profile version
  → build immutable normalized package
  → presign package URL after idempotency claim
  → POST Teaching Engine generation request
  → parseKafuoGenerationRequest(...)
  → buildKafuoStartRequest(...)
  → runKafuoAttempt(...)
  → acquireNormalizedContentResource(...)
  → adaptNormalizedContentToSource(...)
  → GenerationExecutionInput.pdfContent + SourceVisualChannel
  → generateClassroom(...)
  → validateExactTeachingFlow(...)
  → completeGenerationAttempt(...)
```

## 8. Generation Request Contract

### 8.1 Existing resource

The existing `contentResource` remains required in Version 1 and continues to identify the original lesson PDF.

### 8.2 New normalized resource

The request must add a sibling object named `normalizedContentResource`:

```ts
interface KafuoNormalizedContentResource {
  id: string;
  url: string;
  mimeType: 'application/zip';
  schemaVersion: 'kafuo.normalized-content.v1';
  contentSourceId: string;
  contentRevisionId: string;
  parseRunId: string;
  structureProfile: {
    id: string;
    versionId: string;
  };
  fileSizeBytes: number;
  checksumSha256: string;
}
```

Rules:

1. `id` identifies one immutable normalized package.
2. `url` is a transient retrieval credential and must never enter the semantic snapshot, digest, logs, progress, webhook payloads, or responses.
3. `contentSourceId` must equal `contentResource.id`.
4. `contentRevisionId`, `parseRunId`, and the Structure Profile identity/version must identify the exact approved Content Revision lineage exported into the package; current-active lineage may not be substituted.
5. `fileSizeBytes` and `checksumSha256` are mandatory because the package, rather than the PDF, is the generation input.
6. Stable normalized-resource facts must participate in the shared Kafuo/OpenMAIC semantic digest.
7. The transient URL must be excluded from the digest so a safe command replay may mint a fresh URL.
8. `schemaVersion` must equal `kafuo.normalized-content.v1`. Future schemas are versioned additions and must not change the meaning of V1.

## 9. Normalized Package Contract

### 9.1 Container

The Version 1 transport is one immutable ZIP archive containing:

```text
manifest.json
media/<content-addressed-file>
```

The archive must not contain absolute paths, parent traversal, symbolic links, executable content, signed URLs, private storage URIs, or credentials.

Package serialization must be deterministic. For the same exported content, media bytes, and lineage, Kafuo must produce identical archive bytes and the same SHA-256 checksum. Determinism must cover manifest serialization, file naming and media paths, file and archive-entry ordering, archive timestamps and metadata, and compression configuration. This contract does not prescribe an archive library.

### 9.2 Manifest

`manifest.json` must contain:

```ts
interface NormalizedLessonManifest {
  schemaVersion: 'kafuo.normalized-content.v1';
  packageId: string;
  learningItem: {
    type: 'lesson' | 'section';
    id: string;
  };
  contentSource: {
    id: string;
    checksumSha256?: string;
  };
  contentRevisionId: string;
  parseRunId: string;
  structureProfile: {
    id: string;
    versionId: string;
  };
  language: string;
  pageCount: number;
  contentUnits: NormalizedContentUnit[];
  visuals: NormalizedSourceVisual[];
}
```

The `learningItem.type` vocabulary mirrors the existing Kafuo generation request. Its presence in this contract does not enable SECTION generation or change existing product-scope gates.

Each `NormalizedContentUnit` must include:

- stable Content Unit id;
- order index;
- source role and optional subtype;
- title and approved normalized text;
- review status and correction provenance necessary to prove the exported state;
- Structure Profile version lineage; and
- ordered included blocks.

Each exported block must include:

- stable block/evidence identity;
- order index within the Content Unit;
- block type and role;
- authoritative text, if the block contributes text;
- page number;
- geometry/layout when present;
- inclusion disposition; and
- zero or more associated visual ids, which are the canonical authority for Content Unit/block/visual association.

Each `NormalizedSourceVisual` must include:

- stable visual id;
- relative archive media path;
- MIME type, byte size, checksum, width, and height;
- physical page number;
- source block/evidence identity;
- candidate/provider visual lineage;
- caption, figure label, and safe provider description when present;
- review/decision state used by the export policy; and
- deterministic vision priority or ordering input.

The canonical association direction is:

```text
Content Unit
  → ordered Blocks
  → each Block's associated visual ids
```

A visual entry may repeat derived Content Unit or block associations for lookup convenience, but those fields are not a second authority. If the wire format carries both directions, OpenMAIC must validate them as symmetric and consistent. Any mismatch is `NORMALIZED_CONTENT_ASSOCIATION_INVALID`.

### 9.3 Authority and filtering rules

1. The manifest must be bound to the same existing Kafuo Learning Item identity as the generation request: `learningItem.type` and `learningItem.id`.
2. Content Units must be exported in authoritative `order_index` order.
3. Blocks must be exported in authoritative `content_unit_blocks.order_index` order.
4. Block-carried visual ids are the association authority; derived reverse associations must not conflict with them.
5. Excluded blocks must not contribute text to generation.
6. Suppressed, filtered, duplicate, or noise content must follow the approved revision's effective decision and must not be silently restored by the exporter.
7. Only successfully stored provider visuals whose checksums match their bytes may be included.
8. A visual rejected or marked duplicate by the applicable review policy must not be exported as an independent authoritative visual.
9. A provider-generated visual description is metadata, not canonical lesson text.
10. Block-level linkage is sufficient for Version 1. Absence of `educational_assets` or `asset_content_unit_associations` must not force raw PDF re-extraction.

## 10. OpenMAIC Acquisition and Validation

### 10.1 Secure acquisition

OpenMAIC must use the same SSRF, DNS, redirect, byte-limit, and timeout protections used by `fetchBytesSecurely(...)`. The normalized archive must have dedicated configurable limits for:

- compressed download bytes;
- uncompressed total bytes;
- file count;
- individual media bytes; and
- acquisition attempts and timeouts.

### 10.2 Validation

Before generation, OpenMAIC must reject the resource if:

1. the downloaded size or SHA-256 does not match the request;
2. the container is not a supported ZIP archive;
3. `manifest.json` is missing or invalid;
4. `schemaVersion` is not exactly `kafuo.normalized-content.v1` in both the request and manifest;
5. manifest package, Learning Item scope, or lineage does not equal the request facts;
6. a media path is unsafe or resolves outside the package;
7. a referenced media file is missing;
8. declared media type, checksum, size, or dimensions do not match the bytes;
9. Content Unit, block, visual, or association identifiers are duplicated or dangling;
10. ordering is invalid; or
11. no authoritative lesson text remains after effective inclusion rules.

Validation failures must occur before `generateClassroom(...)` and before Stage reservation.

### 10.3 Required request-to-manifest equality

OpenMAIC must validate the following exact equality relationships without best-effort reconciliation:

```text
request.normalizedContentResource.id
== manifest.packageId

request.learningItem.type
== manifest.learningItem.type

request.learningItem.id
== manifest.learningItem.id

request.normalizedContentResource.contentSourceId
== manifest.contentSource.id

request.normalizedContentResource.contentRevisionId
== manifest.contentRevisionId

request.normalizedContentResource.parseRunId
== manifest.parseRunId

request.normalizedContentResource.structureProfile
== manifest.structureProfile

request.normalizedContentResource.schemaVersion
== manifest.schemaVersion
== "kafuo.normalized-content.v1"
```

Any mismatch must fail before generation with `NORMALIZED_CONTENT_LINEAGE_MISMATCH`. Kafuo must create the package only from resources already proven to belong to the requested tenant and Learning Item. Tenant identity need not be duplicated inside the archive when the request-scoped Kafuo ownership proof is used, but a package created for one Learning Item must never be accepted for another.

## 11. Adaptation to the Existing Generation Path

### 11.1 Normalized source output

The normalized-resource adapter must produce the existing `NormalizedSource` information required by the runner:

- `text`;
- source visual bytes and metadata;
- `visionImages`;
- measured package bytes and checksum; and
- provenance required for durable source context and the visual manifest.

It must additionally preserve:

- package id and schema version;
- Learning Item type and id;
- Content Revision and parse-run ids;
- Structure Profile id/version;
- Content Unit ids and order;
- block/evidence ids and order; and
- visual-to-block and visual-to-Content-Unit associations.

### 11.2 Deterministic text rendering

OpenMAIC must construct the textual generation input deterministically from the ordered manifest. The rendering must preserve Content Unit boundaries, roles, titles, block order, page references, and visual references. It must not flatten the content in a way that removes the association between lesson concepts and their source visuals.

The rendered value continues to enter generation through:

```ts
GenerationExecutionInput.pdfContent.text
```

The field name remains `pdfContent` for compatibility even though the authoritative input was supplied as a normalized package.

Outline generation must return machine-readable grounding lineage for Kafuo normalized runs. Generated and persisted outline metadata must be able to retain the authoritative normalized inputs that grounded each outline, conceptually:

```ts
sourceContentUnitIds?: string[];
sourceBlockIds?: string[];
```

These fields are optional for compatibility with non-Kafuo and PDF-fallback generation. For normalized generation, any emitted ids must refer to manifest Content Units and blocks and must remain machine-readable after prompt execution. This does not redesign Scene storage.

### 11.3 Visual adaptation

Authoritative visuals must enter the existing source-visual channel as `PdfImage` values and normalized source images. The internal types and prompt formatters must be extended only as necessary to expose:

- Content Unit ids;
- source block/evidence ids;
- caption and figure label;
- page number;
- source role/type; and
- deterministic vision priority.

The outline model must receive the authoritative association metadata and must not be asked to rediscover all relevance from page number and a generic description alone.

The outline model must also receive stable Content Unit and block identifiers and return their grounding lineage on each generated outline. Outline grounding lineage is distinct from visual lineage: outline metadata records content grounding, while the existing source-visual manifest records selected visual provenance.

If the number of valid visuals exceeds the model's vision budget, OpenMAIC must prioritize them deterministically using Kafuo's associations and declared priority. It must not revert to raw PDF image extraction.

### 11.4 `generateClassroom(...)`

The call remains:

```ts
generateClassroom(execution, {
  persistence,
  sourceVisuals,
})
```

The public `GenerateClassroomInput` shape, lifecycle responsibilities, and exact-flow validation location do not require redesign. Minimal internal source-visual adaptations remain required so the existing outline and slide generation stages can consume the authoritative associations.

## 12. Persistence and Provenance

### 12.1 Attempt snapshot

The OpenMAIC attempt snapshot must record only stable, non-secret normalized-resource facts and summaries, including:

- package id and schema version;
- Learning Item type and id;
- Content Source, Content Revision, parse-run, and Structure Profile lineage;
- measured archive size and checksum;
- Content Unit, block, and visual counts; and
- selected/materialized visual counts.

The signed URL, archive bytes, raw image bytes, data URLs, private storage URIs, and credentials must not be persisted.

### 12.2 Source context

`teaching_package_source_contexts` must distinguish original-PDF extraction from normalized Kafuo content and retain sufficient deterministic normalized source context and lineage for the already-approved Question Generation behavior. The retained context must come from the same authoritative normalized source used during classroom generation. Its exact storage bound may remain configurable; this FRD does not require an unlimited full-text copy.

After Teaching Package approval, the existing Question Generation flow remains:

```text
final approved Stage / Scenes
  + retained normalized source context
  + approved Learning Objectives / lineage
  → Teaching Engine question generation
  → existing Kafuo Question Bank
```

No new Teaching Evidence concept, Kafuo callback, or second PDF parse is required.

### 12.3 Source visual manifest

The persisted `SourceVisualManifestEntry` must be extended to retain, for each selected visual:

- normalized package id;
- Content Source id;
- Content Revision and parse-run ids;
- Structure Profile version;
- Kafuo visual/candidate/provider identity;
- associated Content Unit and block/evidence ids;
- page, caption/description, dimensions, MIME type, checksum; and
- final Stage serving path.

No signed or private source URL may be persisted in the manifest.

### 12.4 Outline grounding lineage

For normalized Kafuo generation, persisted outline metadata must retain `sourceContentUnitIds` and `sourceBlockIds` (or contract-equivalent fields) produced during outline generation. The ids must be validated against the normalized manifest and must survive the same persistence, Editor-save merge, and successor-cloning paths through which existing outline metadata survives. This requirement does not add fields to Scene storage.

## 13. Fallback and Compatibility

1. When `normalizedContentResource` is present and valid, it is the required source. OpenMAIC must not download the original PDF and must not invoke `extractDocument(...)` or any PDF parser for it.
2. When `normalizedContentResource` is absent during the Version 1 rollout, OpenMAIC may use the existing `acquireContentResource(...)` PDF download/parsing path.
3. When `normalizedContentResource` is present but invalid or unavailable, OpenMAIC must retry according to the normalized acquisition policy. If acquisition or validation remains unsuccessful, the generation attempt must fail. OpenMAIC must not download or parse the original PDF as a silent fallback because doing so would hide contract or integrity failures and change the authoritative source.
4. Fallback usage must be observable through attempt summaries/metrics without exposing URLs.
5. Removal of the PDF fallback is a later rollout decision and is outside this FRD.

## 14. Failure Behavior

The integration must expose safe, stable failure codes at minimum for:

| Failure | Required code |
|---|---|
| Normalized package download failed | `NORMALIZED_CONTENT_DOWNLOAD_FAILED` |
| Size or checksum mismatch | `NORMALIZED_CONTENT_INTEGRITY_MISMATCH` |
| Unsupported or unsafe archive | `NORMALIZED_CONTENT_ARCHIVE_INVALID` |
| Request or manifest schema is not `kafuo.normalized-content.v1` | `NORMALIZED_CONTENT_SCHEMA_UNSUPPORTED` |
| Request/manifest lineage mismatch | `NORMALIZED_CONTENT_LINEAGE_MISMATCH` |
| Invalid/dangling association | `NORMALIZED_CONTENT_ASSOCIATION_INVALID` |
| Media validation failure | `NORMALIZED_CONTENT_MEDIA_INVALID` |
| No usable authoritative text | `NORMALIZED_CONTENT_EMPTY` |

Transient network failures may be retried within the existing acquisition policy. Integrity, schema, lineage, association, archive-safety, and empty-content failures are terminal for the attempt.

All failure messages must be safe and must not echo signed URLs, storage URIs, archive contents, provider messages, or credentials.

## 15. Security and Tenant Isolation

1. The Admin browser must continue to call only Kafuo Backend.
2. Kafuo must prove tenant and requested-Learning-Item ownership of the Content Source, approved revision, its exact associated parse run and Structure Profile version, Content Units, and visuals before export.
3. The normalized package must contain only the requested Learning Item's approved scope and must declare that Learning Item's existing `type` and `id` identity.
4. Kafuo must mint the package URL only after the durable idempotency claim.
5. OpenMAIC must treat both resource URLs as transient secrets.
6. OpenMAIC must use secure URL fetching and archive-bomb/path-traversal protections.
7. Request snapshots, webhooks, logs, errors, and progress payloads must reject or redact both original and normalized resource URLs.
8. OpenMAIC must not connect directly to Kafuo PostgreSQL or R2 using shared credentials.

## 16. Idempotency and Immutability

1. One normalized package id must always identify the same manifest, archive metadata, and media bytes.
2. Package creation must deterministically serialize the manifest; assign media paths; order files and archive entries; normalize archive timestamps/metadata; and apply a stable compression configuration.
3. The same exported content, association state, media bytes, and lineage must produce the same archive bytes and checksum.
4. Any exported content, ordering, association, review-decision, lineage, or media-byte change must produce a different package identity and checksum.
5. Stable normalized-resource facts must be included in both Kafuo's and OpenMAIC's canonical semantic digest implementations.
6. The two services' shared digest fixtures must be updated together.
7. Refreshing an expired signed URL for the same immutable package must not change the digest.
8. Reusing one `requestId` with different normalized-resource facts must produce the existing idempotency conflict behavior.

## 17. Functional Requirements

### 17.1 Kafuo export

- **FR-NCR-001:** Kafuo shall build an immutable normalized lesson-content package from the approved Content Revision and the exact parse run and exact Structure Profile version recorded as having produced that revision; it shall not substitute newer active lineage.
- **FR-NCR-002:** Kafuo shall export ordered Content Units and ordered included blocks without reintroducing excluded or suppressed content.
- **FR-NCR-003:** Kafuo shall export successfully stored authoritative provider visuals using Content Unit → ordered Block → associated visual ids as the canonical association authority.
- **FR-NCR-004:** Kafuo shall not require an `educational_assets` row when authoritative provider visual evidence and block linkage exist.
- **FR-NCR-005:** Kafuo shall include stable lineage and integrity facts and shall exclude private storage URIs and credentials.
- **FR-NCR-006:** Kafuo shall persist stable package facts in the command snapshot and mint the transient package URL only after command claim.
- **FR-NCR-024:** Kafuo shall bind the package to the requested Learning Item's existing `type` and `id` after proving tenant/item ownership of every exported resource.
- **FR-NCR-025:** Kafuo shall serialize the same exported content, associations, media bytes, and lineage into identical archive bytes/checksum, and shall produce a different identity/checksum when any of them changes.

### 17.2 Request contract

- **FR-NCR-007:** The generation request shall accept `normalizedContentResource` alongside the existing `contentResource`.
- **FR-NCR-008:** Both services shall validate identical stable normalized-resource facts.
- **FR-NCR-009:** Stable normalized-resource facts shall participate in the shared semantic digest; the URL shall not.
- **FR-NCR-026:** The request and manifest shall both use the exact schema identifier `kafuo.normalized-content.v1` and shall match exactly on package, Learning Item, Content Source, Content Revision, parse-run, and Structure Profile identity.

### 17.3 OpenMAIC acquisition and adaptation

- **FR-NCR-010:** OpenMAIC shall download and validate the normalized package once per attempt.
- **FR-NCR-011:** OpenMAIC shall enforce compressed, uncompressed, file-count, media-size, timeout, and retry bounds.
- **FR-NCR-012:** OpenMAIC shall reject unsafe archives, any schema other than `kafuo.normalized-content.v1`, request/manifest lineage or Learning Item mismatch, invalid associations, and media-integrity failures before generation.
- **FR-NCR-013:** OpenMAIC shall deterministically adapt normalized Content Units and blocks into `GenerationExecutionInput.pdfContent.text`.
- **FR-NCR-014:** OpenMAIC shall adapt authoritative visuals into the existing source-visual channel while retaining Kafuo associations.
- **FR-NCR-015:** When a normalized resource is present, OpenMAIC shall not download or parse the original PDF; after normalized acquisition retries, an invalid or unavailable resource shall fail the attempt.
- **FR-NCR-016:** OpenMAIC shall call the existing `generateClassroom(...)` path and shall retain the current exact-flow validation seam.
- **FR-NCR-027:** Kafuo normalized outline generation shall produce machine-readable Content Unit/block grounding lineage, and OpenMAIC shall validate and persist it without changing Scene storage.

### 17.4 Provenance and persistence

- **FR-NCR-017:** OpenMAIC shall persist stable normalized lineage and summary facts without persisting retrieval credentials or raw media.
- **FR-NCR-018:** Selected source-visual manifests shall retain Content Unit/block association lineage.
- **FR-NCR-019:** The existing approved Question Generation flow shall use final approved Stage/Scenes, approved Learning Objectives/lineage, and sufficient deterministic retained context and lineage from the same normalized source used for classroom generation; it shall require neither a Kafuo callback nor a second PDF parse.
- **FR-NCR-028:** Persisted outline grounding lineage shall survive Editor-save metadata merges and successor cloning wherever existing outline metadata survives.

### 17.5 Compatibility and failure

- **FR-NCR-020:** Absence of `normalizedContentResource` may invoke the current PDF path during Version 1 rollout.
- **FR-NCR-021:** Presence of an invalid or unavailable normalized resource shall retry under normalized acquisition policy and then fail the attempt without downloading or parsing the PDF as fallback.
- **FR-NCR-022:** Failures shall use safe stable codes and preserve the prior usable Stage during regeneration.
- **FR-NCR-023:** Existing Stage, Scene, lifecycle, webhook, handoff, and exact-flow contracts shall remain unchanged.

## 18. Required Change Areas

### 18.1 Kafuo Backend

| Area | Required change |
|---|---|
| Normalized content export | Add a read-only exporter that assembles the approved revision, its exact producing parse-run/Structure-Profile lineage, requested Learning Item scope, ordered Content Units/blocks, and provider visuals into an immutable archive. |
| Object storage | Store deterministically serialized immutable package bytes and media under content-addressed or otherwise immutable keys. |
| Generation request DTO | Add stable `normalizedContentResource` facts to the semantic request snapshot. |
| Request builder | Resolve the approved revision and follow its recorded lineage to the exact producing parse run and Structure Profile version; do not use merely current-active lineage. |
| Send use case | Mint the normalized package URL after the existing command claim and add it to the wire request. |
| Canonical digest | Add stable normalized-resource facts, excluding the URL. |
| Tests | Add export determinism, tenant isolation, inclusion/filtering, URL secrecy, replay, and cross-service digest vectors. |

Primary current seams:

- `zakrly-backend/app/modules/teaching_engine/application/build_generation_request.py`
- `zakrly-backend/app/modules/teaching_engine/application/send_generation_request.py`
- Kafuo Teaching Engine request contracts and digest fixtures
- content-source repositories/models used to read revisions, Content Units, blocks, candidates, and provider visual evidence

### 18.2 OpenMAIC request boundary

| Area | Required change |
|---|---|
| Request types | Add `KafuoNormalizedContentResource` and the optional request field with schema `kafuo.normalized-content.v1`. |
| Request parser | Validate normalized-resource identity, URL, Learning Item scope, explicit lineage equality, MIME, size, checksum, and exact schema version. |
| In-memory context | Carry the transient normalized URL only in `KafuoGenerationContext`. |
| Snapshot facts | Persist only stable normalized-resource facts. |
| Canonical digest | Include stable facts and exclude the URL. |
| Secrecy guards | Treat the normalized URL and archive/media payloads as forbidden persisted values. |

Primary current seams:

- `OpenMAIC/lib/types/teaching-package.ts`
- `OpenMAIC/lib/server/teaching-package/kafuo-request.ts`
- shared Kafuo/OpenMAIC digest fixtures

### 18.3 OpenMAIC acquisition and runner

| Area | Required change |
|---|---|
| New acquisition module | Add a normalized-resource downloader/validator separate from the PDF parser. |
| Deterministic adapter | Convert the manifest and media into the runner's source representation while preserving canonical associations and content-grounding ids. |
| Runner selection | Require normalized acquisition when present and never download/parse the PDF in that branch; use existing PDF acquisition only when normalized input is absent. |
| Source context | Record source kind and normalized lineage. |
| Attempt summary | Record normalized counts and measured integrity facts. |

Primary current seams:

- new `OpenMAIC/lib/server/teaching-package/normalized-content-resource.ts`
- new `OpenMAIC/lib/server/teaching-package/normalized-content-adapter.ts`
- `OpenMAIC/lib/server/teaching-package/generation-runner.ts`
- `OpenMAIC/lib/server/teaching-package/content-resource.ts` remains the fallback path

### 18.4 OpenMAIC visuals and prompts

| Area | Required change |
|---|---|
| Normalized image type | Retain Kafuo visual, Content Unit, block/evidence, caption, role, and priority metadata. |
| `PdfImage` | Add optional authoritative association/provenance fields without breaking non-Kafuo callers. |
| Prompt formatters | Render association metadata in Available Images. |
| Outline instructions | Require selection to respect authoritative associations. |
| Outline lineage | Add optional source Content Unit/block ids to generated outline metadata and validate them against the manifest. |
| Visual manifest | Persist the selected visual's normalized lineage and associations. |

Primary current seams:

- `OpenMAIC/lib/server/teaching-package/source-images.ts`
- `OpenMAIC/packages/@openmaic/generation/src/outline-types.ts`
- `OpenMAIC/packages/@openmaic/generation/src/prompt-formatters.ts`
- `OpenMAIC/packages/@openmaic/generation/src/outline-formatters.ts`
- outline prompt templates and snapshots
- `OpenMAIC/lib/types/teaching-package.ts` (`SourceVisualManifestEntry`)

### 18.5 OpenMAIC persistence

| Area | Required change |
|---|---|
| Source context schema | Add source kind and normalized lineage fields sufficient for the approved Stage/Scenes + retained source context + Learning Objectives Question Generation flow. |
| Source visual manifest | Add Kafuo association and normalized-package provenance. |
| Outline persistence | Preserve machine-readable source Content Unit/block grounding through existing outline persistence and Editor-save merge behavior. |
| Clone/successor behavior | Preserve expanded outline and visual provenance exactly where existing outline metadata and source visuals are preserved. |

Primary current seams:

- `OpenMAIC/lib/persistence/teaching-package.ts`
- Teaching Package database migrations
- `OpenMAIC/lib/document-store/persistence-types.ts`
- `OpenMAIC/lib/server/teaching-package/stage-persistence-sink.ts`

### 18.6 Areas that do not require functional redesign

The following remain structurally unchanged:

- `generateClassroom(...)` as the generation entry point;
- Stage reservation and persistence;
- Scene storage and media serving;
- exact Teaching Model Flow validation;
- generation retry and regeneration retention semantics;
- Teaching Package version lifecycle;
- Admin projection and controls;
- Editor/Preview handoff;
- webhook event types and payload lifecycle; and
- Kafuo Admin → Kafuo Backend → Teaching Engine control path.

## 19. Acceptance Criteria

### 19.1 Contract and authority

1. Given an approved Kafuo lesson revision, export follows that revision to its exact producing parse run and Structure Profile version and never substitutes a newer active lineage.
2. Repeated export of the same content, associations, media bytes, Learning Item scope, and lineage produces byte-identical archives and the same checksum; changing any exported value or media byte produces a different identity/checksum.
3. The request includes both original and normalized resource identities, but neither signed URL appears in durable snapshots, logs, webhooks, progress, or responses.
4. Kafuo and OpenMAIC compute the same semantic digest for shared fixtures containing normalized-resource facts.
5. The request and manifest both carry `kafuo.normalized-content.v1` and match exactly on package id, Learning Item type/id, Content Source, Content Revision, parse run, and Structure Profile; any mismatch fails with `NORMALIZED_CONTENT_LINEAGE_MISMATCH`.

### 19.2 OpenMAIC execution

6. Given a valid `normalizedContentResource`, instrumentation proves that the original PDF is not downloaded and `extractDocument(...)` and `parsePDF(...)` are not called.
7. The exact text given to `generateClassroom(...)` is deterministically derived from the ordered normalized Content Units and included blocks.
8. The exact `sourceVisuals.images` values given to `generateClassroom(...)` originate from Kafuo provider visual evidence, not raw PDF object extraction.
9. Available Images presented to outline generation include canonical Content Unit/block association metadata.
10. Generated outlines retain valid `sourceContentUnitIds` and `sourceBlockIds` (or contract-equivalent fields), and the lineage survives persistence, Editor saves, and successor cloning.
11. Selected visual manifest entries retain normalized package, revision, parse-run, Structure Profile, Content Unit, block, page, and checksum provenance.
12. If both forward and derived reverse association fields exist, they are symmetric; a mismatch fails with `NORMALIZED_CONTENT_ASSOCIATION_INVALID`.

### 19.3 Failure and fallback

13. An absent `normalizedContentResource` may use the existing PDF path during rollout and records that fallback observably.
14. A present but invalid or unavailable normalized package retries according to normalized acquisition policy, then fails before Stage reservation without downloading or parsing the PDF.
15. Archive traversal, archive bombs, dangling or asymmetric associations, checksum mismatches, Learning Item mismatch, and lineage mismatches are rejected with safe stable errors.
16. A regeneration failure preserves the prior usable Stage and package version.

### 19.4 Regression

17. Existing non-Kafuo generation callers remain compatible.
18. Existing exact-flow, lifecycle, webhook, handoff, Admin projection, and media-serving tests remain green.
19. Existing source-PDF fallback tests remain green only for requests without a normalized resource.
20. After approval, the existing Question Generation path uses final approved Stage/Scenes, approved Learning Objectives/lineage, and sufficient deterministic retained context from the same normalized source, without a Kafuo callback or second PDF parse.
21. New cross-repository end-to-end coverage proves Kafuo export → request → OpenMAIC acquisition → `generateClassroom(...)` adaptation → outline/source-visual lineage persistence → Stage persistence.

## 20. Required Test Coverage

### Kafuo Backend

- normalized export schema `kafuo.normalized-content.v1` and deterministic manifest/archive bytes and metadata;
- approved revision → exact producing parse-run/Structure-Profile lineage resolution, including a newer-active-run rejection fixture;
- Learning Item scope and tenant/item ownership;
- ordered Content Unit/block inclusion and exclusion behavior;
- provider visual selection and canonical block association, including symmetric reverse-association validation when emitted;
- tenant and lesson isolation;
- immutable identity/checksum change on content or media change;
- command replay with a refreshed URL;
- request snapshot and log secrecy; and
- shared canonical digest vectors.

### OpenMAIC

- request parsing, Learning Item scope, exact V1 schema, and explicit request/manifest equality validation;
- canonical digest and URL exclusion;
- secure normalized download and retry classification;
- ZIP traversal, expansion, count, and media limits;
- manifest lineage and canonical/symmetric association validation;
- deterministic text rendering;
- visual adaptation and priority;
- outline Content Unit/block grounding validation and persistence;
- valid normalized path bypasses original-PDF download and extraction;
- absent normalized resource uses PDF fallback;
- invalid present normalized resource does not fall back;
- bounded deterministic source context, outline lineage, and source visual manifest persistence;
- Question Generation from final approved Stage/Scenes plus retained normalized context and approved Learning Objectives/lineage, without callback or reparse;
- prompt snapshots with authoritative associations;
- generation-runner success/failure/compensation;
- secrecy guards and safe errors; and
- Editor-save and successor/clone outline and visual provenance preservation.

### Cross-repository

- shared request fixtures and digest vectors;
- one real Kafuo normalized package consumed by OpenMAIC; and
- one end-to-end lesson generation proving correct source visuals appear in generated Scenes and normalized Content Unit/block grounding remains on persisted outlines.

## 21. Smallest Integration Point

The smallest existing OpenMAIC integration point is `runKafuoAttempt(...)` immediately before the current `acquireContentResource(...)` result is adapted into `GenerationExecutionInput`:

- `OpenMAIC/lib/server/teaching-package/generation-runner.ts:97-129`

The required branch is conceptually:

```ts
const source = kafuo.normalizedContentResource
  ? await acquireNormalizedContentResource(kafuo.normalizedContentResource)
  : await acquireContentResource(kafuo.contentResource);
```

The conditional is authoritative: presence selects normalized acquisition exclusively. An exception from `acquireNormalizedContentResource(...)` may be retried by normalized acquisition policy but must never continue into `acquireContentResource(...)`.

The resulting source then continues through the existing:

```text
execution.pdfContent
sourceVisuals
generateClassroom(...)
exact-flow validation
attempt completion
```

This is the narrowest integration seam because it replaces only the acquisition and adaptation of authoritative lesson content. It does not require a new generation engine, a second lifecycle, or a redesign of `generateClassroom(...)`.

## 22. Final Functional Outcome

When this FRD is implemented, Kafuo parses and normalizes the lesson once, applies its Structure Profile and review decisions once, and exports one immutable authoritative package. OpenMAIC validates and adapts that package once, then uses its existing generation, visual materialization, exact-flow validation, persistence, and lifecycle machinery.

The resulting Teaching Package is grounded in Kafuo's approved lesson text and correctly associated source visuals rather than in a second, lower-fidelity extraction of raw PDF objects. Its persisted outlines retain machine-readable Content Unit/block grounding, and the retained normalized source context remains compatible with the existing approved Question Generation flow.

## 23. Final Review Status

```text
Architecture / ownership: PASS
Normalized package authority: PASS
Fallback semantics: PASS
Learning Item scope: PASS
Determinism / immutability: PASS
Association authority: PASS
Generation lineage: PASS
Question Generation compatibility: PASS
Security / idempotency: PASS

FRD status:
READY FOR FINAL APPROVAL REVIEW
```
