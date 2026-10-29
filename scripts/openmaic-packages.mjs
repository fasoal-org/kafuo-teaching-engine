import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one list of owned, publishable @openmaic packages.
 *
 * Several checks and the release workflow each used to carry their own copy of
 * this list, which meant a package missing from one of them was silently exempt
 * from that check rather than failing anything. The scripts now share this
 * module, and {@link assertPackageListIsComplete} verifies from the outside
 * that the root app's own list still agrees with this one.
 *
 * Ordered by dependency: dsl first, followed by its dependents.
 *
 * ── THREAT MODEL FOR EVERY GATE THAT READS THIS ──────────────────────────────
 *
 * This list, and the checks built on it, are configuration held in the same
 * repository as the code they check. Anyone who can merge a change to
 * `scripts/` can also edit the gate itself: shorten this list, relax a rule,
 * delete a workflow step. No amount of additional checking closes that, because
 * every new check arrives with its own editable configuration.
 *
 * That is fine, because it is not the threat these gates are for. They exist to
 * catch MISTAKES — a package added in one place and forgotten in another, a
 * dependency range that publishes differently from how it reads, a test suite
 * that stops running without anyone noticing. Those are silent by default and
 * expensive to find later, which is exactly what a gate is good at. Deliberate
 * subversion is not in scope and cannot be: someone willing to edit these
 * scripts to hide a change can edit the production sources directly, and code
 * review, not tooling, is what stands in the way of that.
 */
export const OPENMAIC_PACKAGES = ['dsl', 'generation', 'storage', 'renderer', 'editor', 'importer'];

/** The packages that depend on other owned packages, and on which ones. */
export const INTERNAL_DEPENDENTS = {
  generation: ['@openmaic/dsl'],
  storage: ['@openmaic/dsl'],
  renderer: ['@openmaic/dsl'],
  editor: ['@openmaic/dsl', '@openmaic/renderer'],
  importer: ['@openmaic/dsl'],
};

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGES_DIRECTORY = join(repositoryRoot, 'packages/@openmaic');

export function packageDirectory(name) {
  return `packages/@openmaic/${name}`;
}

export function readManifest(name) {
  return JSON.parse(readFileSync(join(PACKAGES_DIRECTORY, name, 'package.json'), 'utf8'));
}

/**
 * Where this fork ships the packages. Nothing here publishes them to npm: the
 * root `postinstall` builds them into the Teaching Engine image and the root
 * `dependencies` link them into the app. Until 6 Oct 2026 the cross-check below
 * read upstream's `.github/workflows/publish-packages.yml`, which e0dc7df1
 * removed together with npm publishing.
 */
const ROOT_MANIFEST = 'package.json';

/**
 * Fail if this list has drifted from what actually exists on disk, or from the
 * root app's `@openmaic/*` dependencies.
 *
 * Being wrong in either direction is silent by nature: a package present on
 * disk but missing here is exempt from every check that reads this module, and
 * a package here but missing from the root dependencies never reaches the app.
 * Both read as a pass unless something asserts otherwise, which is what this
 * does.
 *
 * Returns the problems rather than exiting, so a caller can report them
 * alongside its own.
 */
export function assertPackageListIsComplete() {
  const problems = [];

  const onDisk = readdirSync(PACKAGES_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const listed = [...OPENMAIC_PACKAGES].sort();

  for (const name of onDisk) {
    if (!listed.includes(name)) {
      problems.push(
        `packages/@openmaic/${name} exists but is not in OPENMAIC_PACKAGES, so every check ` +
          'that reads this list skips it. Add it there and to the root package.json dependencies.',
      );
    }
  }
  for (const name of listed) {
    if (!onDisk.includes(name)) {
      problems.push(`OPENMAIC_PACKAGES lists ${name}, but packages/@openmaic/${name} is gone.`);
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repositoryRoot, ROOT_MANIFEST), 'utf8'));
  } catch {
    problems.push(
      `${ROOT_MANIFEST} is missing or not valid JSON, so its package list cannot be cross-checked.`,
    );
    return problems;
  }
  problems.push(...crossCheckRootDependencies(manifest));

  return problems;
}

/** Compare two name sets and describe the difference from `expected`. */
function describeSetDifference(expected, observed, subject) {
  const problems = [];
  for (const name of expected) {
    if (!observed.includes(name)) {
      problems.push(`${subject} omits ${name}.`);
    }
  }
  for (const name of observed) {
    if (!expected.includes(name)) {
      problems.push(`${subject} names ${name}, which is not in OPENMAIC_PACKAGES.`);
    }
  }
  return problems;
}

/**
 * Check that the root app's `dependencies` declare exactly
 * {@link OPENMAIC_PACKAGES} as `@openmaic/*` entries.
 *
 * Compared as a SET, so an unexpected entry fails as well as a missing one.
 * Only `dependencies` counts: that is where the app consumes the packages, so
 * an entry moved to `devDependencies` or dropped altogether reads as missing.
 */
function crossCheckRootDependencies(manifest) {
  const dependencies = manifest?.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return [
      `${ROOT_MANIFEST} has no dependencies object; this check expected it to declare ` +
        'every @openmaic package.',
    ];
  }
  const declared = Object.keys(dependencies)
    .filter((name) => name.startsWith('@openmaic/'))
    .map((name) => name.slice('@openmaic/'.length));
  return describeSetDifference(OPENMAIC_PACKAGES, declared, `${ROOT_MANIFEST} dependencies`);
}
