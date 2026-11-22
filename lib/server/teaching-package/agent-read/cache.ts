/**
 * A small in-memory LRU for the agent scene projection (Kafuo Agent API plan
 * §3.3: cached by `(stage_id, document_stage_revision)`). Process-local; a
 * miss only costs a rebuild. The caller checks the service key and the tenant
 * BEFORE consulting it, and the key carries the version id too, so an entry is
 * never served across versions.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Refresh recency: Map iteration order is insertion order.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Version id + stage id + stage revision. */
export function sceneProjectionCacheKey(versionId: string, stageId: string, rev: number): string {
  return `${versionId}\u0000${stageId}\u0000${rev}`;
}
