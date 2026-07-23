// ═══════════════════════════════════════════════════════════════════════════
// TRUTH LOADER — resolve a frame's ground truth (honest-absent → null)
// (spec: docs/VALIDATION_HARNESS.md · Enhancement 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Resolution order (first hit wins):
//   (a) explicit labels — an in-memory array, a labels JSON file, or a labels dir
//   (b) FITS header      — derive CRVAL/RA/DEC + nominal scale (via fits_truth.mjs,
//                          which reuses tools/stack/fits_io.mjs — the canonical
//                          FITS parser; loaded lazily so the tsc gate stays pure)
//   (c) bundled known    — the repo-pinned answers (BUNDLED_KNOWN below)
//   else → null (NO_TRUTH). We never fabricate a label a frame does not have.
//
// The bundled/seed truths we can resolve TODAY live in ./labels.json (tracked)
// and BUNDLED_KNOWN (hard-pinned, so a clone without the local sample files
// still knows the bundled CR2 answer).

import fs from 'node:fs';
import path from 'node:path';
import type { TruthLabel, TruthLabelsFile } from './schema.ts';

/** Signature of a FITS-header → TruthLabel deriver (injectable for tests). */
export type FitsDeriver = (fitsPath: string, frameId: string) => Promise<TruthLabel | null>;

export interface ResolveOptions {
  /** Highest precedence: labels already in memory (e.g. a loaded file). */
  labels?: readonly TruthLabel[];
  /** A labels JSON file (bare array OR `{ labels: [...] }`). */
  labelsFile?: string;
  /** A directory of `<frame_id>.json` single-label files. */
  labelsDir?: string;
  /** A FITS file to derive header truth from (option b). */
  fitsPath?: string;
  /** Include the hard-pinned BUNDLED_KNOWN table as a fallback (default true). */
  allowBundled?: boolean;
  /** Override the FITS deriver (tests inject a pure stub; default = fits_truth.mjs). */
  fitsDeriver?: FitsDeriver;
}

/**
 * Repo-pinned known answers. Durable because the underlying sample files are
 * gitignored/local — a clone has the machinery + these labels, not the frames.
 */
export const BUNDLED_KNOWN: Record<string, TruthLabel> = {
  // El Matador beach CR2 blind solve — the first blind CR2 lock. Answer agrees
  // with an INDEPENDENT brute-forced ground truth to 0.2–0.3° pointing / 0.2%
  // scale (docs/WHITEPAPER.md; commits 7922172, 1c811c0), so this is a genuine
  // truth anchor, not a self-graded circularity.
  sample_observation: {
    frame_id: 'sample_observation',
    source: 'bundled_known',
    ra_hours: 17.5858,
    dec_degrees: -33.83,
    pixel_scale_arcsec: 63.211,
    rotation_deg: 155.65,
    parity: 1,
    provenance_note:
      'Bundled Canon T6 + Rokinon 14mm beach CR2; blind solve agrees with brute-forced ground truth 0.2–0.3° pointing / 0.2% scale (WHITEPAPER; 7922172,1c811c0).',
  },
};

/** Parse a labels JSON (array or `{ labels }`) into a TruthLabel[]. */
export function parseLabels(json: unknown): TruthLabel[] {
  if (Array.isArray(json)) return json as TruthLabel[];
  const f = json as TruthLabelsFile;
  if (f && Array.isArray(f.labels)) return f.labels;
  throw new Error('labels file must be a TruthLabel[] or { labels: TruthLabel[] }');
}

/** Read + parse a labels JSON file. Missing file → []. */
export function loadLabelsFile(file: string): TruthLabel[] {
  if (!fs.existsSync(file)) return [];
  return parseLabels(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Read a directory of `<frame_id>.json` single-label files. Missing dir → []. */
export function loadLabelsDir(dir: string): TruthLabel[] {
  if (!fs.existsSync(dir)) return [];
  const out: TruthLabel[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const l of parseLabels(parsed)) out.push(l);
  }
  return out;
}

/** First label matching `frameId` from an in-memory list (last-write-wins). */
export function findLabel(frameId: string, labels: readonly TruthLabel[]): TruthLabel | null {
  let hit: TruthLabel | null = null;
  for (const l of labels) if (l.frame_id === frameId) hit = l;
  return hit;
}

/**
 * PURE synchronous resolver over an in-memory label list + bundled table (no
 * FITS I/O). The fully-featured async `resolveTruth` layers file/dir/FITS on top.
 */
export function resolveTruthFromLabels(
  frameId: string,
  labels: readonly TruthLabel[] = [],
  opts: { allowBundled?: boolean } = {},
): TruthLabel | null {
  const explicit = findLabel(frameId, labels);
  if (explicit) return explicit;
  if (opts.allowBundled !== false && BUNDLED_KNOWN[frameId]) return BUNDLED_KNOWN[frameId];
  return null;
}

/** Default FITS deriver — lazily reuses fits_truth.mjs (kept out of the tsc graph). */
const defaultFitsDeriver: FitsDeriver = async (fitsPath, frameId) => {
  // Non-literal specifier: not statically resolved by tsc/vite (so the pure
  // tsc gate never sees the untyped .mjs); resolved by Node at runtime relative
  // to this module.
  const specifier = ['.', 'fits_truth.mjs'].join('/');
  const mod = (await import(specifier)) as { deriveFitsTruth: FitsDeriver };
  return mod.deriveFitsTruth(fitsPath, frameId);
};

/**
 * Resolve a frame's truth across all sources, honest-absent → null.
 * Order: explicit in-memory → labelsFile → labelsDir → FITS header → bundled.
 */
export async function resolveTruth(
  frameId: string,
  opts: ResolveOptions = {},
): Promise<TruthLabel | null> {
  // (a) explicit labels — in-memory, then file, then dir.
  const explicitPools: TruthLabel[][] = [];
  if (opts.labels) explicitPools.push([...opts.labels]);
  if (opts.labelsFile) explicitPools.push(loadLabelsFile(opts.labelsFile));
  if (opts.labelsDir) explicitPools.push(loadLabelsDir(opts.labelsDir));
  for (const pool of explicitPools) {
    const hit = findLabel(frameId, pool);
    if (hit) return hit;
  }

  // (b) FITS header.
  if (opts.fitsPath) {
    const deriver = opts.fitsDeriver ?? defaultFitsDeriver;
    const derived = await deriver(opts.fitsPath, frameId);
    if (derived) return derived;
  }

  // (c) bundled known.
  if (opts.allowBundled !== false && BUNDLED_KNOWN[frameId]) return BUNDLED_KNOWN[frameId];

  return null;
}
