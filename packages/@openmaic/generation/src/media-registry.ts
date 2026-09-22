/**
 * The per-run media registry: everything the generator LEGITIMATELY handed the
 * slide model, plus — in edit mode — the sources already present on the
 * baseline slide. The slide model is only ever given ids, so:
 *
 * - an id / placeholder in the registry      → resolved as before;
 * - a concrete address equal to a registered source → kept (protects edit-mode
 *   regeneration, stage media, pool assets, inline data, provider URLs);
 * - a concrete address NOT in the registry   → `hallucinated` /
 *   `unregistered-external` → the element is removed;
 * - an id with no mapping                    → `unresolved-reference` → removed.
 *
 * HTTP(S) is not banned as a class — UNREGISTERED HTTP(S) authored by a model
 * is. Editor, import, material and proxy flows do not pass through here.
 */
import type { ImageMapping } from './outline-types.js';

export type UnauthorizedMediaReason =
  | 'hallucinated'
  | 'unregistered-external'
  | 'unresolved-reference';

export interface MediaRegistry {
  /** Ids and generated-media placeholders the model may reference. */
  readonly ids: ReadonlySet<string>;
  /** Concrete addresses that are already authorized for this slide. */
  readonly sources: ReadonlySet<string>;
}

export function buildMediaRegistry(input: {
  imageMapping?: ImageMapping;
  generatedMediaMapping?: ImageMapping;
  placeholderIds?: readonly string[];
  baselineSources?: readonly string[];
}): MediaRegistry {
  const ids = new Set<string>([
    ...Object.keys(input.imageMapping ?? {}),
    ...Object.keys(input.generatedMediaMapping ?? {}),
    ...(input.placeholderIds ?? []),
  ]);
  const sources = new Set<string>(
    [
      ...Object.values(input.imageMapping ?? {}),
      ...Object.values(input.generatedMediaMapping ?? {}),
      ...(input.baselineSources ?? []),
    ].filter((value): value is string => typeof value === 'string' && value !== ''),
  );
  return { ids, sources };
}

/** Why a model-authored concrete `src` is not authorized, or `undefined` if it is. */
export function unauthorizedConcreteSource(
  src: string,
  registry: MediaRegistry,
): UnauthorizedMediaReason | undefined {
  if (registry.sources.has(src) || registry.ids.has(src)) return undefined;
  return /^https?:\/\//i.test(src) ? 'unregistered-external' : 'hallucinated';
}
