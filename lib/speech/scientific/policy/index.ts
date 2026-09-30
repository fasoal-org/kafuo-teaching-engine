/**
 * Versioned Arabic pronunciation policy pack (plan §11).
 *
 * The dictionaries are data (`ar-v1/*.json`), hash-locked by
 * `manifest.contentHash` (see `tests/speech/scientific/policy-lock.test.ts`).
 * Every entry carries an approval `status`. Production (`SCIENTIFIC_TTS_MODE=on`)
 * loads the pack with `allowProposed: false`, so a `proposed` entry is never
 * spoken there; shadow mode, diagnostics and the golden/property tests load it
 * with `allowProposed: true` and the result is marked experimental.
 *
 * Pure: no I/O beyond the static JSON imports, no clock, no randomness.
 */
import manifestJson from './ar-v1/manifest.json';
import lettersJson from './ar-v1/letters.json';
import arabicLettersJson from './ar-v1/arabic-letters.json';
import greekJson from './ar-v1/greek.json';
import functionsJson from './ar-v1/functions.json';
import fractionsJson from './ar-v1/fractions.json';
import operatorsJson from './ar-v1/operators.json';
import numbersStructuralJson from './ar-v1/numbers-structural.json';
import unitsJson from './ar-v1/units.json';
import prefixesJson from './ar-v1/prefixes.json';
import chemLettersJson from './ar-v1/chem-letters.json';
import statesJson from './ar-v1/states.json';

/**
 * Bumped by any verbaliser or grammar change that alters prepared text. It is
 * part of `manifest.contentHash`, so a code-only wording change still forces a
 * deliberate policy version bump (FR-039, AS-007).
 */
export const RENDERER_GRAMMAR_VERSION = 'satts-grammar-17';

export type PolicyTableName =
  | 'letters'
  | 'arabic-letters'
  | 'greek'
  | 'functions'
  | 'fractions'
  | 'operators'
  | 'numbers-structural'
  | 'units'
  | 'prefixes'
  | 'chem-letters'
  | 'states';

export type PolicyEntryStatus = 'approved' | 'proposed';

/**
 * What a token is doing where it is read (upgrade plan P2, R4). Every call
 * site knows the role; the resolver uses it with the lesson subject.
 */
export type PolicyRole =
  | 'variable'
  | 'element'
  | 'greek'
  | 'function'
  | 'fraction'
  | 'operator'
  | 'label'
  | 'symbol'
  | 'number'
  | 'repeat'
  | 'unit'
  | 'prefix'
  | 'state'
  | 'bond'
  /** A sign of a parsed reaction: arrow, gas / precipitate mark, arrow condition (DEC-052). */
  | 'reaction';

/** The lesson subject a reading belongs to (`Stage.subjectCode`). */
export type PolicyDomain = 'MATH' | 'PHYSICS' | 'CHEMISTRY';

export interface PolicyEntry {
  /** The token as authored (`x`, `m`, `+`, `2`, `∫`). */
  key: string;
  /** Overrides the table's roles. */
  roles?: PolicyRole[];
  /** Overrides the table's domains; absent means every subject. */
  domains?: PolicyDomain[];
  /** Other spellings of the same token (`µ`, `u` for `μ`). Recognition only. */
  aliases?: string[];
  /** The educational (Saudi teacher) reading. */
  natural: string;
  /** The detailed reading; falls back to `natural`. */
  accessible?: string;
  /** A neutral speakable symbol name (safe fallback, O-9, O-10); falls back to `natural`. */
  literal?: string;
  status: PolicyEntryStatus;
  approvedBy?: string;
  approvedOn?: string;
  source?: string;
  notes?: string;
}

export interface PolicyTableFile {
  table: string;
  description?: string;
  /** Default roles of every entry. */
  roles?: PolicyRole[];
  /** Default domains of every entry; absent means every subject. */
  domains?: PolicyDomain[];
  entries: PolicyEntry[];
}

export type NumbersMode = 'digits' | 'words';

export interface PolicyManifest {
  policyVersion: string;
  status: 'approved' | 'experimental';
  rendererGrammarVersion: string;
  options: { numbersMode: NumbersMode };
  files: string[];
  contentHash: string;
}

export const POLICY_MANIFEST = manifestJson as PolicyManifest;

/** Every table file of the pack, keyed by its file name (hash input). */
export const POLICY_TABLE_FILES: Readonly<Record<string, PolicyTableFile>> = {
  'letters.json': lettersJson as PolicyTableFile,
  'arabic-letters.json': arabicLettersJson as PolicyTableFile,
  'greek.json': greekJson as PolicyTableFile,
  'functions.json': functionsJson as PolicyTableFile,
  'fractions.json': fractionsJson as PolicyTableFile,
  'operators.json': operatorsJson as PolicyTableFile,
  'numbers-structural.json': numbersStructuralJson as PolicyTableFile,
  'units.json': unitsJson as PolicyTableFile,
  'prefixes.json': prefixesJson as PolicyTableFile,
  'chem-letters.json': chemLettersJson as PolicyTableFile,
  'states.json': statesJson as PolicyTableFile,
};

const TABLE_FILE: Readonly<Record<PolicyTableName, string>> = {
  letters: 'letters.json',
  'arabic-letters': 'arabic-letters.json',
  greek: 'greek.json',
  functions: 'functions.json',
  fractions: 'fractions.json',
  operators: 'operators.json',
  'numbers-structural': 'numbers-structural.json',
  units: 'units.json',
  prefixes: 'prefixes.json',
  'chem-letters': 'chem-letters.json',
  states: 'states.json',
};

/** An entry with its table defaults applied. */
export interface ResolvedEntry extends Omit<PolicyEntry, 'roles' | 'domains'> {
  table: PolicyTableName;
  roles: PolicyRole[];
  domains: PolicyDomain[] | null;
}

function resolvedEntries(): ResolvedEntry[] {
  const out: ResolvedEntry[] = [];
  for (const table of Object.keys(TABLE_FILE) as PolicyTableName[]) {
    const file = POLICY_TABLE_FILES[TABLE_FILE[table]];
    for (const entry of file?.entries ?? []) {
      out.push({
        ...entry,
        table,
        roles: entry.roles ?? file?.roles ?? [],
        domains: entry.domains ?? file?.domains ?? null,
      });
    }
  }
  return out;
}

let entryCache: ResolvedEntry[] | null = null;

/** Every entry of the pack, with table defaults applied (tests, tooling). */
export function policyEntries(): readonly ResolvedEntry[] {
  entryCache ??= resolvedEntries();
  return entryCache;
}

/**
 * The legacy `(table, key)` spellings of an entry, for the compatibility
 * layer: `sym:∫`, `chem:electron`, `nom:2`/`gen:2`, `times:2`.
 */
function legacyKeys(entry: ResolvedEntry): string[] {
  if (entry.roles.includes('symbol')) return [`sym:${entry.key}`];
  if (entry.table === 'operators' && entry.domains?.includes('CHEMISTRY')) return [`chem:${entry.key}`];
  if (entry.roles.includes('number')) return [`nom:${entry.key}`, `gen:${entry.key}`];
  if (entry.roles.includes('repeat')) return [`times:${entry.key}`];
  return [entry.key];
}

const legacyIndex = new Map<string, Map<string, ResolvedEntry>>();

function tableIndex(table: PolicyTableName): Map<string, ResolvedEntry> {
  const cached = legacyIndex.get(table);
  if (cached) return cached;
  const index = new Map<string, ResolvedEntry>();
  for (const entry of policyEntries()) {
    if (entry.table !== table) continue;
    for (const key of legacyKeys(entry)) index.set(key, entry);
  }
  legacyIndex.set(table, index);
  return index;
}

let roleIndex: Map<string, ResolvedEntry[]> | null = null;

function roleKey(role: PolicyRole, token: string): string {
  return `${role}\u0000${token}`;
}

function entriesFor(role: PolicyRole, token: string): readonly ResolvedEntry[] {
  if (!roleIndex) {
    roleIndex = new Map();
    for (const entry of policyEntries()) {
      for (const role of entry.roles) {
        const key = roleKey(role, entry.key);
        const list = roleIndex.get(key) ?? [];
        list.push(entry);
        roleIndex.set(key, list);
      }
    }
  }
  return roleIndex.get(roleKey(role, token)) ?? [];
}

/**
 * Recognition, separated from wording (P2 item 4): every token the pack
 * knows in `role`, with its aliases, whatever its approval status.
 */
export function policyTokens(role: PolicyRole): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of policyEntries()) {
    if (!entry.roles.includes(role)) continue;
    out.add(entry.key);
    for (const alias of entry.aliases ?? []) out.add(alias);
  }
  return out;
}

/** The canonical key of an alias (`µ`, `u` → `μ`), or the token itself. */
export function canonicalToken(role: PolicyRole, token: string): string {
  for (const entry of policyEntries()) {
    if (entry.roles.includes(role) && entry.aliases?.includes(token)) return entry.key;
  }
  return token;
}

export interface PolicyLookup {
  text: string;
  proposed: boolean;
}

/** A role-aware query (upgrade plan P2): token + role + subject. */
export interface PolicyQuery {
  role: PolicyRole;
  token: string;
  /** The lesson subject; `null` matches only subject-independent entries. */
  domain: PolicyDomain | null;
}

/**
 * `spoken`: the educational reading (natural/accessible); `literal`: the
 * neutral symbol name (falls back to the natural reading).
 */
export type PolicyReading = 'spoken' | 'literal';

export interface PolicyPackOptions {
  /** Use `proposed` entries (shadow, diagnostics, tests). Default `false`. */
  allowProposed?: boolean;
  /** Overrides the manifest's `numbersMode` (tests and the H3 decision only). */
  numbersMode?: NumbersMode;
}

export interface PolicyPack {
  policyVersion: string;
  /** `experimental` when the manifest is, or when proposed entries are allowed. */
  status: 'approved' | 'experimental';
  numbersMode: NumbersMode;
  allowProposed: boolean;
  /**
   * Role-aware resolution: `(domain, role)` → `(role)` → the token's neutral
   * `symbol` entry → `null` (the caller then speaks the raw token, FR-030).
   */
  resolve(query: PolicyQuery, mode: 'natural' | 'accessible', reading?: PolicyReading): PolicyLookup | null;
  /** Compatibility layer: the legacy `(table, key)` lookup. */
  lookup(table: PolicyTableName, key: string, mode: 'natural' | 'accessible'): PolicyLookup | null;
  has(table: PolicyTableName, key: string): boolean;
}

/** The best entry for a query: subject-specific first, then subject-independent. */
function bestEntry(role: PolicyRole, token: string, domain: PolicyDomain | null): ResolvedEntry | undefined {
  const entries = entriesFor(role, token);
  return (
    (domain ? entries.find((entry) => entry.domains?.includes(domain)) : undefined) ??
    entries.find((entry) => entry.domains === null)
  );
}

export function loadPolicyPack(
  _language: string | null = 'ar',
  options: PolicyPackOptions = {},
): PolicyPack {
  const allowProposed = options.allowProposed === true;
  const numbersMode = options.numbersMode ?? POLICY_MANIFEST.options.numbersMode;
  const usable = (entry: ResolvedEntry | undefined): entry is ResolvedEntry =>
    entry !== undefined && (entry.status === 'approved' || allowProposed);
  const text = (entry: ResolvedEntry, mode: 'natural' | 'accessible', reading: PolicyReading): PolicyLookup => ({
    text:
      reading === 'literal'
        ? (entry.literal ?? entry.natural)
        : mode === 'accessible' && entry.accessible !== undefined
          ? entry.accessible
          : entry.natural,
    proposed: entry.status !== 'approved',
  });
  return {
    policyVersion: POLICY_MANIFEST.policyVersion,
    status: POLICY_MANIFEST.status === 'approved' && !allowProposed ? 'approved' : 'experimental',
    numbersMode,
    allowProposed,
    resolve(query, mode, reading = 'spoken') {
      const entry = bestEntry(query.role, query.token, query.domain);
      if (usable(entry)) return text(entry, mode, reading);
      // The neutral symbol name, when the token has one.
      const neutral = query.role === 'symbol' ? undefined : bestEntry('symbol', query.token, query.domain);
      if (usable(neutral)) return text(neutral, mode, 'literal');
      return null;
    },
    lookup(table, key, mode) {
      const entry = tableIndex(table).get(key);
      if (!usable(entry)) return null;
      return text(entry, mode, 'spoken');
    },
    has(table, key) {
      return usable(tableIndex(table).get(key));
    },
  };
}

/** Fields that never change prepared text; excluded from the content hash. */
const METADATA_FIELDS = new Set(['approvedBy', 'approvedOn', 'source', 'notes', 'description']);


function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (METADATA_FIELDS.has(key)) continue;
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The exact string hashed into `manifest.contentHash`: the grammar version,
 * the options and every listed table, with metadata-only fields removed.
 * Pure; the hashing itself lives outside the renderer.
 */
export function policyHashInput(
  manifest: PolicyManifest = POLICY_MANIFEST,
  files: Readonly<Record<string, PolicyTableFile>> = POLICY_TABLE_FILES,
): string {
  const tables: Record<string, unknown> = {};
  for (const name of [...manifest.files].sort()) tables[name] = canonical(files[name] ?? null);
  return JSON.stringify({
    grammar: RENDERER_GRAMMAR_VERSION,
    policyVersion: manifest.policyVersion,
    status: manifest.status,
    options: canonical(manifest.options),
    tables,
  });
}
