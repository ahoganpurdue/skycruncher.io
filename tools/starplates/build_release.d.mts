// Type declarations for build_release.mjs — consumed by
// src/engine/tests/starplates_build_release.test.ts. TypeScript resolves this
// file when the test imports '../../../tools/starplates/build_release.mjs',
// which keeps `npx tsc --noEmit` at its known baseline (the .mjs itself is
// tooling, outside tsconfig's `include: ["src"]`).

export declare const RELEASE_DEFAULT: string;
export declare const FORMAT_VERSION: number;
export declare const HEALPIX_ORDER_T1: number;
export declare const CELLS_TOTAL_T1: number;
export declare const CELLS_TOTAL_T2: number;
export declare const T0_MAG_MAX_DEFAULT: number;
export declare const T1_MAG_MAX_NOMINAL: number;
export declare const EPOCH: string;
export declare const EPOCH_JD: number;
export declare const REQUIRED_COLUMNS: string[];
export declare const CSV_HEADER: string;
export declare const KNOWN_DEFECT_DEFAULT: string;

export declare function cell5OfSourceId(sourceId: bigint): number;
export declare function cell6OfSourceId(sourceId: bigint): number;
export declare function sha256Bytes(bytes: Uint8Array | string): string;
export declare function f32Shortest(v: number): number;

export interface BlobRows {
  ra: Float64Array;
  dec: Float64Array;
  pmra: Float32Array;
  pmdec: Float32Array;
  g: Float32Array;
  bprp: Float32Array;
  sid: BigUint64Array;
}
export declare function encodeBlob(rows: BlobRows, meta: Map<string, string>): Uint8Array;

export interface ManifestBlob {
  path: string;
  sha256: string;
  bytes: number;
  tier: string;
  healpix_order: number | null;
  cell: number | null;
  rows: number;
  mag_min: number | null;
  mag_max: number | null;
  source_epoch: string;
  coverage: number;
  center_ra_deg: number | null;
  center_dec_deg: number | null;
  radius_deg: number | null;
}

export interface Manifest {
  release: string;
  format_version: number;
  writer: string;
  source: {
    catalog: string;
    epoch: string;
    epoch_jd: number;
    extraction: string;
    extraction_sha256: string;
    known_defect: string;
  };
  schema: { columns: string[]; sort: string; ipc: string };
  tiers: {
    t0: { kind: string; mag_range: (number | null)[]; coverage: number };
    t1: {
      kind: string; healpix_order: number; mag_range: (number | null)[]; coverage: number;
      cells_total: number; cells_populated: number; excluded_boundary_cell: number | null;
    };
    t2: { kind: string; healpix_order: number; mag_range: (number | null)[]; coverage: number; status: string };
  };
  blobs: ManifestBlob[];
}

export interface BuildStats {
  release: string;
  releaseDir: string;
  linesRead: number;
  rowsIngested: number;
  dropped: { malformed: number; missing_field: number; unparseable: number; out_of_range: number; duplicate: number };
  cellsPopulatedBeforeExclusion: number;
  excludedCell: number | null;
  excludedRows: number;
  cellsPopulated: number;
  coverageT1: number;
  t1Files: number;
  t1Rows: number;
  t1Bytes: number;
  t0Rows: number;
  t0Bytes: number;
  largestCell: { cell: number; rows: number; bytes: number } | null;
  smallestCell: { cell: number; rows: number; bytes: number } | null;
  manifestBytes: number;
  manifestSha256: string;
  manifest: Manifest;
  elapsedMs: number;
}

export interface BuildOptions {
  csv: string;
  outDir: string;
  release?: string;
  t0MagMax?: number;
  excludeBoundaryCell?: boolean;
  knownDefect?: string;
  quiet?: boolean;
}

export declare function buildRelease(opts: BuildOptions): Promise<BuildStats>;
export declare function verifyDeterminism(
  opts: BuildOptions,
  firstStats: BuildStats,
  o?: { quiet?: boolean },
): Promise<boolean>;
