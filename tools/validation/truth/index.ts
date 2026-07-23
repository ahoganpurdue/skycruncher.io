// Ground-truth verification for the Validation & Graduation Harness (Enh1).
// Barrel: schema (+ astrometry.net ingest), WCS comparison, truth loader, and
// the SOLVER harness hook that turns a truth-disagreeing lock into a
// new_false_positive regression. See docs/VALIDATION_HARNESS.md.
export * from './schema.ts';
export * from './compare.ts';
export * from './loader.ts';
export * from './harness_hook.ts';
