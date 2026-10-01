/**
 * A fake Kafuo grounding reader + query embedder behind the P7 seam
 * (`lib/server/tutor/grounding/kafuo-grounding-reader.ts`). P6 replaces it
 * with the pg-backed reader; these suites never touch a Kafuo database.
 *
 * Every call pushes an event (`reader:resolve`, `reader:probe`,
 * `reader:profile`, `reader:search`, `reader:validate`, `embed`) into the
 * shared events array, so order assertions span reader → assemble → reserve.
 * Results come from a per-method FIFO queue (`queue`), else the defaults:
 * resolve/probe `no_match`, profile `ok` (one openai group), search no units,
 * validate all valid, embed a vector of the requested dims.
 */
import { vi } from 'vitest';

import type {
  DirectGroundingDeps,
  GroundingReaderScope,
  ItemCandidate,
  ItemEmbeddingProfileResult,
  QueryEmbeddingRequest,
  QueryEmbeddingResult,
  ResolveItemsInput,
  ResolveItemsResult,
  SearchUnitRow,
  SearchUnitsInput,
  SearchUnitsResult,
  UnitRef,
  ValidateUnitsResult,
} from '@/lib/server/tutor/grounding/kafuo-grounding-reader';

export const EMBEDDING_GROUP = { provider: 'openai', model: 'text-embedding-3-small', dims: 4 };

export function candidate(
  learningItemId: string,
  title: string,
  itemType: 'LESSON' | 'SECTION' = 'LESSON',
  score = 9,
  routable = true,
): ItemCandidate {
  return {
    learningItemId,
    itemType,
    title,
    score,
    matchedTermTypes: ['glossary', 'concept'],
    routable,
  };
}

export function unitRow(
  contentUnitId: string,
  learningItemId: string,
  text: string,
  options: { itemType?: 'LESSON' | 'SECTION'; unitTitle?: string | null; similarity?: number } = {},
): SearchUnitRow {
  return {
    contentUnitId,
    learningItemId,
    itemType: options.itemType ?? 'LESSON',
    unitTitle: options.unitTitle === undefined ? `وحدة ${contentUnitId}` : options.unitTitle,
    text,
    charLength: text.length,
    similarity: options.similarity ?? 0.8,
    contentRevisionId: `rev-${contentUnitId}`,
    unitUpdatedAt: '2026-09-30T10:00:00+00:00',
    buildId: `b-${learningItemId}`,
  };
}

export const single = (top: ItemCandidate): ResolveItemsResult => ({
  outcome: 'single',
  reasonCode: null,
  candidates: [top],
});
export const ambiguous = (...candidates: ItemCandidate[]): ResolveItemsResult => ({
  outcome: 'ambiguous',
  reasonCode: null,
  candidates,
});
export const weak = (...candidates: ItemCandidate[]): ResolveItemsResult => ({
  outcome: 'weak',
  reasonCode: 'lexical_fallback',
  candidates,
});
export const noMatch = (
  indexCoverage: 'complete' | 'partial' = 'complete',
): ResolveItemsResult => ({
  outcome: 'no_match',
  reasonCode: null,
  indexCoverage,
});
export const notReady = (...candidates: ItemCandidate[]): ResolveItemsResult => ({
  outcome: 'index_not_ready',
  reasonCode: 'stale',
  candidates: candidates.map((c) => ({ ...c, routable: false })),
});
export const found = (...units: SearchUnitRow[]): SearchUnitsResult => ({ outcome: 'ok', units });

type Methods = {
  resolveItems: (
    scope: GroundingReaderScope,
    input: ResolveItemsInput,
  ) => Promise<ResolveItemsResult>;
  probeItems: (scope: GroundingReaderScope, input: { text: string }) => Promise<ResolveItemsResult>;
  itemEmbeddingProfile: (
    scope: GroundingReaderScope,
    input: { itemIds: string[] },
  ) => Promise<ItemEmbeddingProfileResult>;
  searchUnits: (scope: GroundingReaderScope, input: SearchUnitsInput) => Promise<SearchUnitsResult>;
  validateUnits: (
    scope: GroundingReaderScope,
    input: { unitRefs: UnitRef[] },
  ) => Promise<ValidateUnitsResult>;
  embed: (request: QueryEmbeddingRequest) => Promise<QueryEmbeddingResult>;
};

type MethodName = keyof Methods;
type Result<M extends MethodName> = Awaited<ReturnType<Methods[M]>>;
type Queued<M extends MethodName> =
  | Result<M>
  | ((...args: Parameters<Methods[M]>) => Result<M>)
  | Error;

const EVENTS: Record<MethodName, string> = {
  resolveItems: 'reader:resolve',
  probeItems: 'reader:probe',
  itemEmbeddingProfile: 'reader:profile',
  searchUnits: 'reader:search',
  validateUnits: 'reader:validate',
  embed: 'embed',
};

const DEFAULTS: { [M in MethodName]: (...args: Parameters<Methods[M]>) => Result<M> } = {
  resolveItems: () => noMatch(),
  probeItems: () => noMatch(),
  itemEmbeddingProfile: (_scope, input) => ({
    outcome: 'ok',
    items: input.itemIds.map((id) => ({
      outcome: 'ok' as const,
      learningItemId: id,
      buildId: `b-${id}`,
      embeddingRunId: `run-${id}`,
      ...EMBEDDING_GROUP,
    })),
  }),
  searchUnits: () => found(),
  validateUnits: (_scope, input) => ({
    outcome: 'ok',
    validUnitIds: input.unitRefs.map((ref) => ref.contentUnitId),
  }),
  embed: (request) => ({ outcome: 'ok', vector: new Array(request.dims).fill(0.25), tokens: 9 }),
};

export interface FakeGrounding {
  deps: DirectGroundingDeps;
  mocks: { [M in MethodName]: ReturnType<typeof vi.fn<Methods[M]>> };
  /** Results returned, in order, by the next calls of `method` (an Error is thrown). */
  queue<M extends MethodName>(method: M, ...results: Queued<M>[]): void;
  reset(): void;
}

export function fakeGroundingReader(events: string[]): FakeGrounding {
  const queues = new Map<MethodName, unknown[]>();
  const make = <M extends MethodName>(name: M) =>
    vi.fn(async (...args: Parameters<Methods[M]>): Promise<Result<M>> => {
      events.push(EVENTS[name]);
      const next = queues.get(name)?.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return (next as (...a: unknown[]) => Result<M>)(...args);
      if (next !== undefined) return next as Result<M>;
      return (DEFAULTS[name] as (...a: unknown[]) => Result<M>)(...args);
    }) as unknown as ReturnType<typeof vi.fn<Methods[M]>>;
  const mocks = {
    resolveItems: make('resolveItems'),
    probeItems: make('probeItems'),
    itemEmbeddingProfile: make('itemEmbeddingProfile'),
    searchUnits: make('searchUnits'),
    validateUnits: make('validateUnits'),
    embed: make('embed'),
  };
  return {
    deps: {
      reader: {
        resolveItems: mocks.resolveItems,
        probeItems: mocks.probeItems,
        itemEmbeddingProfile: mocks.itemEmbeddingProfile,
        searchUnits: mocks.searchUnits,
        validateUnits: mocks.validateUnits,
      },
      embedder: { embed: mocks.embed },
    },
    mocks,
    queue(method, ...results) {
      queues.set(method, [...(queues.get(method) ?? []), ...results]);
    },
    reset() {
      queues.clear();
      for (const mock of Object.values(mocks)) mock.mockClear();
    },
  };
}
