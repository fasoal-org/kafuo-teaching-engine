/** Shared schema bootstrap for the teaching-package PGlite suites. */
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';

export { ensureDocumentSchema, ensureStageMetaSchema };

/** Placeholder module for lifecycle import indirection in tests. */
export const lifecycle = undefined;
