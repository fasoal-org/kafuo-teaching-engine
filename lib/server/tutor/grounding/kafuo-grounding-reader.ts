/**
 * Kafuo grounding reader SEAM (discovery-first plan §5.3–§5.5; P7 builds
 * against it, P6 implements it).
 *
 * Each method mirrors one Kafuo-owned `grounding_read_v1` SECURITY DEFINER
 * function, executed as ONE autocommit statement by the P6 reader (dedicated
 * `pg.Pool` from `KAFUO_GROUNDING_DATABASE_URL`, per-process semaphore):
 *
 *   resolveItems          → grounding_read_v1.resolve_items(tenant, student_ref, offering, text, max_candidates)
 *   probeItems            → the D-10 probe: the same resolve_items statement on a
 *                           `none` / `reuse` turn; only a `single` outcome is acted on
 *   itemEmbeddingProfile  → grounding_read_v1.item_embedding_profile(tenant, student_ref, offering, item_ids)
 *   searchUnits           → grounding_read_v1.search_units(tenant, student_ref, offering, targets, query, provider, model, limit)
 *   validateUnits         → grounding_read_v1.validate_units(tenant, student_ref, offering, unit_refs)
 *
 * Contract for implementations:
 *  - Every call re-proves scope inside Kafuo SQL (CHAT-04). A failed proof is
 *    a typed `student_ref_unknown` / `offering_not_permitted` result carrying
 *    NO item data; the turn refuses with SUBJECT_NO_LONGER_AVAILABLE (D-18).
 *  - Expected outcomes are RETURNED, never thrown. Pool admission saturation
 *    is `retrieval_busy` (RET-06, fast); a timeout or statement error is
 *    `retrieval_unavailable`. A thrown error is treated as
 *    `retrieval_unavailable` by the caller.
 *  - No transaction is opened and no connection is held across the embedding
 *    or model call. Text, vectors and rows are never logged (RET-07).
 *  - Ids are Kafuo bigints as decimal strings.
 *
 * P6 implements it in `pg-grounding-reader.ts` (pg Pool + semaphore) and
 * `query-embedding.ts`. P4's `resolve_items` returns `build_id` per candidate
 * (NULL for a title-probe candidate), mapped to the optional
 * `ItemCandidate.buildId`.
 *
 * Contract gap for P4/P5/P6: §5.3/§5.4 list no `build_id` in the
 * `item_embedding_profile` / `search_units` outputs, but snapshot v2,
 * association v2 and `validate_units` need the unit's active build. The seam
 * therefore requires `buildId` on `ItemEmbeddingProfile` and `SearchUnitRow`.
 */

export type GroundingItemType = 'LESSON' | 'SECTION';

/** The grant's values; Kafuo re-proves them on every call (never trusted). */
export interface GroundingReaderScope {
  tenantId: string;
  /** Opaque HMAC student ref from the student grant. */
  studentRef: string;
  /** The Subject Offering pinned at conversation creation. */
  subjectOfferingId: string;
}

/** Optional per-call metadata the P6 reader reports (admission wait, §5.5). */
export interface ReaderCallMeta {
  poolWaitMs?: number;
}

/** Scope proof failed (step 1 of every function): no item data (CHAT-04, D-18). */
export type GroundingScopeRefusal =
  | { outcome: 'student_ref_unknown' }
  | { outcome: 'offering_not_permitted' };

/** Reader-side transport outcomes (RET-06). */
export type GroundingReaderUnavailable =
  | { outcome: 'retrieval_busy' }
  | { outcome: 'retrieval_unavailable' };

// ---------------------------------------------------------------------------
// resolve_items (§5.3)
// ---------------------------------------------------------------------------

export interface ResolveItemsInput {
  /** The student's text; Kafuo normalizes it (`normalize_ar_v2_tokens`). Never logged. */
  text: string;
  /** `p_max_candidates`, default 3. */
  maxCandidates?: number;
}

/** One candidate row of `resolve_items` (§5.3 output). */
export interface ItemCandidate {
  learningItemId: string;
  itemType: GroundingItemType;
  /** Human-readable item title (student- and model-visible; never an id). */
  title: string;
  score: number;
  matchedTermTypes: string[];
  /** `false` only for `index_not_ready` audit candidates. */
  routable: boolean;
  /**
   * The item's active (last successful) Discovery build (P4 `build_id`). NULL
   * only for a title-probe `index_not_ready` candidate: a never-built item has
   * no build. Absent on a candidate rebuilt from a clarification choice.
   */
  buildId?: string | null;
  /** P4 readiness (`ready`, `stale`, `building`, …); audit only. */
  readiness?: string;
  /** P4 match source: `term`, `title` or `fallback`; audit only. */
  matchSource?: 'term' | 'title' | 'fallback';
}

export type IndexCoverage = 'complete' | 'partial';

export type ResolveItemsResult = ReaderCallMeta &
  (
    | {
        /** Top score ≥ S_strong and leads the next by ≥ M: `candidates[0]` is the item. */
        outcome: 'single';
        reasonCode: string | null;
        candidates: ItemCandidate[];
        indexCoverage?: IndexCoverage;
      }
    | {
        /** ≤ `maxCandidates` routable items within M of the top. */
        outcome: 'ambiguous';
        reasonCode: string | null;
        candidates: ItemCandidate[];
        indexCoverage?: IndexCoverage;
      }
    | {
        /** Bounded lexical fallback (CHAT-06): never grounded without the student's choice. */
        outcome: 'weak';
        reasonCode: string | null;
        candidates: ItemCandidate[];
        indexCoverage?: IndexCoverage;
      }
    | {
        /** An eligible item matched but is not routable. Candidates are audit only. */
        outcome: 'index_not_ready';
        reasonCode: string | null;
        candidates: ItemCandidate[];
        indexCoverage?: IndexCoverage;
      }
    | {
        outcome: 'no_match';
        reasonCode: string | null;
        indexCoverage: IndexCoverage;
      }
    | GroundingScopeRefusal
    | GroundingReaderUnavailable
  );

// ---------------------------------------------------------------------------
// item_embedding_profile (§5.4)
// ---------------------------------------------------------------------------

/** The item's selected embedding run (unique by `uq_embedding_runs_active_chunk`). */
export interface ItemEmbeddingProfile {
  learningItemId: string;
  /** The item's active Discovery/content build (contract gap, see header). */
  buildId: string;
  embeddingRunId: string;
  /** From the run's `config_snapshot`. */
  provider: string;
  model: string;
  /** From the stored `embedding_dims` (P5). */
  dims: number;
}

export type ItemProfileEntry =
  | ({ outcome: 'ok' } & ItemEmbeddingProfile)
  | { outcome: 'no_active_embeddings'; learningItemId: string }
  | { outcome: 'embedding_profile_mismatch'; learningItemId: string };

export type ItemEmbeddingProfileResult = ReaderCallMeta &
  (
    | { outcome: 'ok'; items: ItemProfileEntry[] }
    | GroundingScopeRefusal
    | GroundingReaderUnavailable
  );

// ---------------------------------------------------------------------------
// search_units (§5.4)
// ---------------------------------------------------------------------------

export interface SearchTarget {
  learningItemId: string;
  embeddingRunId: string;
}

export interface SearchUnitsInput {
  /** At most 3 targets, all of ONE `(provider, model, dims)` group (RET-01). */
  targets: SearchTarget[];
  /** The query embedding (`real[]`, cast to `public.vector` inside Kafuo). Never logged. */
  query: number[];
  provider: string;
  model: string;
  /** `p_limit`, capped at 5 by Kafuo (RET-03). */
  limit?: number;
}

/** One distinct approved Content Unit, best chunk first (RET-03). */
export interface SearchUnitRow {
  contentUnitId: string;
  learningItemId: string;
  itemType: GroundingItemType;
  unitTitle: string | null;
  text: string;
  charLength: number;
  /** Cosine similarity of the unit's best chunk, 0..1. */
  similarity: number;
  contentRevisionId: string;
  /** `content_units.updated_at` as Kafuo returns it (opaque; echoed back to validate_units). */
  unitUpdatedAt: string;
  /** The unit's active build (contract gap, see header). */
  buildId: string;
}

export type SearchUnitsResult = ReaderCallMeta &
  (
    | {
        outcome: 'ok';
        units: SearchUnitRow[];
        /** Targets Kafuo left out as `dropped_incompatible` (RET-01); audit only. */
        dropped?: Array<{ learningItemId: string; embeddingRunId: string }>;
      }
    /** A target's run is no longer the item's selected run: no rows. */
    | { outcome: 'run_superseded' }
    /** A target run's provider/model no longer equal the query's: no rows. */
    | { outcome: 'embedding_profile_mismatch' }
    | GroundingScopeRefusal
    | GroundingReaderUnavailable
  );

// ---------------------------------------------------------------------------
// validate_units (§5.4, D-17)
// ---------------------------------------------------------------------------

export interface UnitRef {
  contentUnitId: string;
  learningItemId: string;
  buildId: string;
  contentRevisionId: string;
  unitUpdatedAt: string;
}

export type ValidateUnitsResult = ReaderCallMeta &
  (
    | {
        outcome: 'ok';
        /** The subset still approved, current, in an active build, `updated_at` unchanged. */
        validUnitIds: string[];
      }
    | GroundingScopeRefusal
    | GroundingReaderUnavailable
  );

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export interface KafuoGroundingReader {
  resolveItems(scope: GroundingReaderScope, input: ResolveItemsInput): Promise<ResolveItemsResult>;
  /** D-10 probe on a `none` / `reuse` turn (one indexed statement; only `single` is acted on). */
  probeItems(scope: GroundingReaderScope, input: { text: string }): Promise<ResolveItemsResult>;
  itemEmbeddingProfile(
    scope: GroundingReaderScope,
    input: { itemIds: string[] },
  ): Promise<ItemEmbeddingProfileResult>;
  searchUnits(scope: GroundingReaderScope, input: SearchUnitsInput): Promise<SearchUnitsResult>;
  validateUnits(
    scope: GroundingReaderScope,
    input: { unitRefs: UnitRef[] },
  ): Promise<ValidateUnitsResult>;
}

// ---------------------------------------------------------------------------
// Query embedding (P6 `query-embedding.ts`)
// ---------------------------------------------------------------------------

export interface QueryEmbeddingRequest {
  /** The selected run's provider; only the Teaching Engine allowlist (`openai`) is served. */
  provider: string;
  model: string;
  dims: number;
  /** Never logged. */
  text: string;
}

export type QueryEmbeddingResult =
  | { outcome: 'ok'; vector: number[]; tokens: number | null }
  | { outcome: 'embedding_provider_unsupported' }
  /** Timeout or provider error after its one budgeted retry. */
  | { outcome: 'embedding_unavailable' };

export interface QueryEmbedder {
  embed(request: QueryEmbeddingRequest): Promise<QueryEmbeddingResult>;
}

/** What the `direct` grounding source needs (wired by P6 into `TutorRuntimeDeps.grounding`). */
export interface DirectGroundingDeps {
  reader: KafuoGroundingReader;
  embedder: QueryEmbedder;
}
