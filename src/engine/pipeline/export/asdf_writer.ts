/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ASDF WRITER — shared, dependency-free serializer for the SkyCruncher receipt
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER (pure serialization — no DOM, no session reach-back, no Rust).
 *
 * ONE implementation. The Tauri desktop app, the browser build and the headless
 * Node lane all run this same function (the desktop app is the same React/TS
 * frontend in a webview — no Rust in the byte path). The per-surface sinks are
 * thin (save-dialog + writeFile / Blob download / fs.writeFileSync); the byte
 * production lives HERE so ASDF never lives in two places (the anti-pattern the
 * repo polices).
 *
 * Emits the Advanced Scientific Data Format (STScI, JWST/Roman) — the image as
 * a binary block + the full receipt as YAML metadata. Byte layout is verified
 * against the ASDF Standard 1.6.0 file layout (see asdf-standard file_layout):
 *   - block magic  0xd3 0x42 0x4c 0x4b  ("\xd3BLK")
 *   - header_size  uint16 BIG-ENDIAN  == 48 (bytes after the magic+size field)
 *   - flags        uint32 BIG-ENDIAN
 *   - compression  4 bytes            (0x00000000 = uncompressed)
 *   - allocated_size / used_size / data_size  uint64 BIG-ENDIAN
 *   - checksum     16 bytes           (all-zero = "no checksum", per standard)
 *   - array data   raw LITTLE-ENDIAN  (immediately after the header)
 *
 * HONEST-OR-ABSENT (hard constraint): the fitted WCS is exported as BOTH an
 * ordinary LABELED FITS-keyword mapping under `wcs_fits` (the fallback for
 * readers without gwcs) AND — since the GWCS deliverable landed (e42563f,
 * fidelity-gated by tools/asdf/gwcs_fidelity.py: pixel→world reproduces the
 * FITS-WCS to sub-arcsec) — a NATIVE, astropy-interpretable `gwcs/wcs` tagged
 * transform under `wcs` (LINEAR + SIP, or TPS tabular when fitted). Both are
 * absent when unsolved; the native block is additionally absent when a
 * required keyword is non-finite. UNIT TRAP handled at the file boundary:
 * `crval[0]` is RA in HOURS internally → ×15 for degrees (mirrors
 * `stages/package.ts` generateReceiptWcs and `tools/stack/fits_io.mjs`
 * wcsCards). crpix is engine 0-based / y-down (labeled as such, not silently
 * reinterpreted).
 *
 * ═══ EXPORT LAW: FITTED WCS ONLY (mirrors export/fits_writer.ts) ═════════════
 * serializeAsdf REFUSES when `receipt.wcs` is present with `SOURCE !==
 * 'FITTED'` — a SYNTHESIZED approximation (stages/package.ts can emit
 * SOURCE:'SYNTHESIZED') must never be written as an astropy-interpretable
 * GWCS transform or labeled WCS metadata. An UNSOLVED receipt (no `wcs` at
 * all) still exports, with the WCS blocks honestly absent — that asymmetry vs
 * fits_writer (which requires a WCS outright) is deliberate: ASDF is the
 * full-receipt carrier, FITS is the solved-science carrier.
 *
 * ═══ SIP / TPS SIGN CONVENTION (fixed at the boundary) ════════════════════════
 * The engine stores the distortion fit as OBSERVED − IDEAL (residual_analyzer.ts
 * / tps_fitter.ts). Both distortion carriers here export the IDEAL − OBSERVED
 * (FITS/astropy) direction: the SIP keywords + gwcs polynomial node negate the
 * coefficients via export/sip_convention.ts toFitsSip, and the TPS tabular lookup
 * is baked as u − f (not u + f) so the direct-lookup Tabular2D output IS the
 * corrected offset fed to CD. Proven by the real-engine catalog-residual gate
 * (tools/fits/run_real_conformance.ts): astropy/gwcs-applied SIP/TPS moves stars
 * TOWARD the catalog (median residual DOWN), not away. The pre-fix bug emitted the
 * raw internal coefficients and WORSENED the applied residual.
 */

import { DROPPED_KEYS } from '../stages/receipt_serializer';
import { evalTpsField } from '../m6_plate_solve/tps_eval'; // pure, zero-import leaf (no wasm)
import { toFitsSip } from './sip_convention'; // pure SIP internal→FITS sign bridge

// ─── constants ──────────────────────────────────────────────────────────────

const ASDF_STANDARD_VERSION = '1.6.0';
const CORE_EXTENSION_URI = 'asdf://asdf-format.org/core/extensions/core-1.6.0';
const LIBRARY_NAME = 'SkyCruncher';

// ─── GWCS tag/extension registry ──────────────────────────────────────────────
// Tag names + versions are NOT guessed — they are the exact tags the installed
// `gwcs` (0.21.0) + `asdf-transform-schemas` (0.6.0) + `asdf-wcs-schemas`
// (0.5.0) emit and validate against (captured from a round-tripped reference
// GWCS via the Python oracle; see tools/asdf/gwcs_fidelity.py). Bump these only
// against a re-verified oracle. `!transform/*`, `!core/*`, `!unit/*` resolve via
// the `%TAG ! tag:stsci.edu:asdf/` directive already in the file header; the
// gwcs/astropy tags are namespaced so they use the verbose `!<…>` form.
const GWCS_TAG = {
    wcs: '!<tag:stsci.edu:gwcs/wcs-1.4.0>',
    step: '!<tag:stsci.edu:gwcs/step-1.3.0>',
    frame2d: '!<tag:stsci.edu:gwcs/frame2d-1.2.0>',
    celestial: '!<tag:stsci.edu:gwcs/celestial_frame-1.2.0>',
    icrs: '!<tag:astropy.org:astropy/coordinates/frames/icrs-1.1.0>',
    compose: '!transform/compose-1.4.0',
    concatenate: '!transform/concatenate-1.4.0',
    shift: '!transform/shift-1.4.0',
    affine: '!transform/affine-1.5.0',
    gnomonic: '!transform/gnomonic-1.4.0',
    rotate3d: '!transform/rotate3d-1.5.0',
    polynomial: '!transform/polynomial-1.3.0',
    // tabular-1.4.0 is the standard GWCS distortion representation for a NON-
    // polynomial displacement field (a TPS has no polynomial nodes). Captured
    // from an asdf-astropy Tabular2D round-trip via the WSL oracle (asdf 5.3.1 /
    // asdf-astropy 0.11.0). Covered by the transform-1.7.0 extension ALREADY in
    // GWCS_EXTENSIONS — no new manifest entry needed.
    tabular: '!transform/tabular-1.4.0',
    remap: '!transform/remap_axes-1.5.0',
    ndarray: '!core/ndarray-1.1.0',
    unit: '!unit/unit-1.0.0',
} as const;

/** extension_metadata entries declaring the schemas a reader needs to interpret
 * the native `wcs` (gwcs) block. Versions verified against the installed oracle. */
const GWCS_EXTENSIONS: Array<{ uri: string; manifest?: { name: string; version: string } }> = [
    { uri: 'asdf://asdf-format.org/astronomy/gwcs/extensions/gwcs-1.4.0', manifest: { name: 'asdf_wcs_schemas', version: '0.5.0' } },
    { uri: 'asdf://asdf-format.org/transform/extensions/transform-1.7.0', manifest: { name: 'asdf_transform_schemas', version: '0.6.0' } },
    { uri: 'asdf://astropy.org/astropy/extensions/units-1.3.0' },
    { uri: 'asdf://asdf-format.org/astronomy/coordinates/extensions/coordinates-1.0.0', manifest: { name: 'asdf_coordinates_schemas', version: '0.5.1' } },
];

/** Little-endian platforms only — the block data bytes are written LE (matches
 * the retired Rust writer's explicit big-endian rejection). Guards against ever
 * emitting mis-ordered array bytes on a hypothetical big-endian host. */
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] === 0x02;

// ─── public API ─────────────────────────────────────────────────────────────

export type AsdfPixelArray = Uint16Array | Float32Array;

export interface AsdfImage {
    /** The pixel samples. Uint16Array → 'uint16', Float32Array → 'float32'. */
    data: AsdfPixelArray;
    width: number;
    height: number;
    /** 1 = mono, shape [h,w]; 3 = interleaved RGB, shape [h,w,3]. Default 1. */
    channels?: 1 | 3;
}

export interface AsdfWriterOptions {
    /** asdf_library version (read from package.json by the caller). Required. */
    libraryVersion: string;
    /** Optional project homepage; omitted (honest-or-absent) when unset. */
    homepage?: string;
}

/**
 * Serialize a receipt + image into a complete ASDF byte stream.
 *
 * Pure: `(receipt, image, opts) -> Uint8Array`. No I/O, no deps. The image goes
 * to the binary block; every receipt field goes to the YAML tree (the
 * core/asdf schema is `additionalProperties: true`). Throws on a shape/length
 * mismatch or an unsupported pixel type rather than emit a corrupt file.
 */
export function serializeAsdf(
    receipt: any,
    image: AsdfImage,
    opts: AsdfWriterOptions
): Uint8Array {
    if (!IS_LITTLE_ENDIAN) {
        throw new Error(
            'ASDF export requires a little-endian platform (array data is written little-endian).'
        );
    }

    // EXPORT LAW: fitted WCS only (mirrors fits_writer). A present-but-non-
    // FITTED WCS refuses loudly — never silently continues, never downgrades.
    // Absent wcs (unsolved receipt) is allowed: the WCS blocks stay honestly
    // absent below (buildWcsFits/buildGwcs return null).
    const wcsForLaw = receipt?.wcs;
    if (wcsForLaw != null && wcsForLaw.SOURCE !== 'FITTED') {
        throw new Error(
            `ASDF export refused: receipt.wcs.SOURCE is ${JSON.stringify(wcsForLaw.SOURCE)} — ` +
            `only a FITTED WCS is exported (a SYNTHESIZED approximation is never written as science).`
        );
    }

    const datatype = pixelDatatype(image.data);
    const channels = image.channels === 3 ? 3 : 1;
    const shape = channels === 3
        ? [image.height, image.width, 3]
        : [image.height, image.width];

    const expected = shape.reduce((a, b) => a * b, 1);
    if (image.data.length !== expected) {
        throw new Error(
            `ASDF image shape [${shape.join(',')}] implies ${expected} samples ` +
            `but the array has ${image.data.length}.`
        );
    }

    const byteLength = image.data.byteLength;
    const software = `!core/software-1.0.0 {name: ${dq(LIBRARY_NAME)}, version: ${dq(opts.libraryVersion)}}`;

    // ── build the YAML tree ──────────────────────────────────────────────────
    const lines: string[] = [
        '#ASDF 1.0.0',
        `#ASDF_STANDARD ${ASDF_STANDARD_VERSION}`,
        '%YAML 1.1',
        '%TAG ! tag:stsci.edu:asdf/',
        '--- !core/asdf-1.1.0',
    ];

    // asdf_library (name + version required by the schema)
    lines.push(`asdf_library: ${software}`);

    // Native GWCS transform (astropy-interpretable). Built ONCE here and reused
    // for both the extension self-description and the `wcs` tree node. Null when
    // unsolved OR when the fitted WCS is non-linear beyond LINEAR+SIP scope
    // (honest-or-absent — the labeled `wcs_fits` block remains the fallback).
    const gwcs = buildGwcs(receipt, image.width, image.height);

    // history — self-describes the extensions a reader needs. The file always
    // uses core tags; when a native GWCS `wcs` is present it additionally needs
    // the gwcs/transform/units/coordinates schema manifests, declared here so
    // the file is self-describing (`extension_class` required by
    // core/extension_metadata-1.0.0); `software` names SkyCruncher as the writer.
    lines.push('history:');
    lines.push('  extensions:');
    lines.push(`  - !core/extension_metadata-1.0.0`);
    lines.push(`    extension_class: "asdf.extension._manifest.ManifestExtension"`);
    lines.push(`    extension_uri: ${dq(CORE_EXTENSION_URI)}`);
    lines.push(`    software: ${software}`);
    if (gwcs) {
        for (const ext of GWCS_EXTENSIONS) {
            lines.push(`  - !core/extension_metadata-1.0.0`);
            lines.push(`    extension_class: "asdf.extension._manifest.ManifestExtension"`);
            lines.push(`    extension_uri: ${dq(ext.uri)}`);
            if (ext.manifest) {
                lines.push(`    manifest_software: !core/software-1.0.0 {name: ${dq(ext.manifest.name)}, version: ${dq(ext.manifest.version)}}`);
            }
            lines.push(`    software: ${software}`);
        }
    }

    // data — the image as an ndarray referencing binary block 0
    lines.push('data: !core/ndarray-1.1.0');
    lines.push('  source: 0');
    lines.push(`  datatype: ${datatype}`);
    lines.push('  byteorder: little');
    lines.push(`  shape: ${emitFlow(shape)}`);

    // Sanitize the receipt: drop heavy typed-array keys, coerce non-finite
    // numbers to null, inline small typed arrays, note-out large ones.
    const clean = sanitize(receipt) ?? {};

    // wcs_fits — labeled FITS-keyword metadata (the honest fallback for readers
    // WITHOUT gwcs). Emitted alongside the native `wcs` (gwcs) block below.
    const wcsFits = buildWcsFits(receipt, gwcs != null);
    emitMapEntry('wcs_fits', wcsFits, 0, lines);

    // wcs — the NATIVE, astropy-interpretable GWCS transform pipeline (a
    // `gwcs/wcs` tagged tree). Fidelity-gated (tools/asdf/gwcs_fidelity.py): its
    // pixel→world reproduces the FITS-WCS pixel→world to sub-arcsec, so the
    // parity/convention is proven, not asserted. Absent when unsolved.
    if (gwcs) emitMapEntry('wcs', gwcs, 0, lines);

    // Optional lens-distortion slot — emitted ONLY when the receipt carries
    // MEASURED per-image Brown-Conrady coefficients. Nothing produces those
    // today (per-copy refit deferred; the nominal LENS_DB prior is a heuristic
    // and must never be emitted as if measured), so this is null/absent now — a
    // ready slot for the fast-follow producer.
    const lensDistortion = buildLensDistortion(receipt);
    if (lensDistortion) emitMapEntry('com.skycruncher.lens_distortion', lensDistortion, 0, lines);

    // Optional source-provenance slot — the ORIGIN of the frame's bytes (Google
    // Drive / URL / local-drop), matched at ingest against the intake content-sha
    // ledger. Emitted ONLY when the receipt carries a positively-matched block;
    // absent otherwise (honest-or-absent — unknown origin is never fabricated).
    // ADDITIVE + Python-conformant: core/asdf is additionalProperties:true, so this
    // labeled scalar mapping needs no schema/extension (the bare `source_provenance`
    // receipt key also rides the generic root passthrough below — same as the
    // lens_distortion precedent).
    const sourceProvenance = buildSourceProvenance(receipt);
    if (sourceProvenance) emitMapEntry('com.skycruncher.source_provenance', sourceProvenance, 0, lines);

    // Every remaining receipt field at the tree root (additionalProperties:true).
    // The bare `wcs` receipt key is consumed by the emitters above (labeled
    // `wcs_fits` + native gwcs `wcs`); never re-emit the raw mapping.
    if (clean && typeof clean === 'object' && !Array.isArray(clean)) {
        for (const key of Object.keys(clean)) {
            if (key === 'wcs') continue;
            emitMapEntry(key, clean[key], 0, lines);
        }
    }

    lines.push('...');
    lines.push(''); // trailing newline after the document-end marker

    const textBytes = new TextEncoder().encode(lines.join('\n'));

    // ── build the binary block ───────────────────────────────────────────────
    const header = new Uint8Array(54); // 4 magic + 2 size + 48 body
    header.set([0xd3, 0x42, 0x4c, 0x4b], 0); // "\xd3BLK"
    const hv = new DataView(header.buffer);
    hv.setUint16(4, 48, false);              // header_size (big-endian)
    hv.setUint32(6, 0, false);               // flags
    // compression bytes 10..13 stay 0x00000000 (uncompressed)
    setU64BE(hv, 14, byteLength);            // allocated_size
    setU64BE(hv, 22, byteLength);            // used_size
    setU64BE(hv, 30, byteLength);            // data_size
    // checksum bytes 38..53 stay zero (all-zero = "no checksum")

    // Raw array bytes — native (little-endian, guarded above) order.
    const dataBytes = new Uint8Array(image.data.buffer, image.data.byteOffset, byteLength);

    const out = new Uint8Array(textBytes.length + header.length + dataBytes.length);
    out.set(textBytes, 0);
    out.set(header, textBytes.length);
    out.set(dataBytes, textBytes.length + header.length);
    return out;
}

/** Canonical ASDF file name: `${baseName}_${spatial_hash | timestamp}.asdf`. */
export function asdfFileName(receipt: any, baseName = 'skycruncher'): string {
    return `${baseName}_${receipt?.solution?.spatial_hash ?? Date.now()}.asdf`;
}

// ─── WCS (honest-or-absent) ───────────────────────────────────────────────────

/**
 * The fitted WCS as a labeled FITS-keyword mapping. Reuses `receipt.wcs`
 * (already crval→deg ×15, CD in deg/px, 0-based crpix per generateReceiptWcs)
 * and, when a SIP fit is present, appends the standard SIP keywords. Returns
 * null when unsolved (honest-or-absent). This is the FALLBACK for readers
 * without gwcs; the native, astropy-interpretable transform is the sibling
 * `wcs` (gwcs/wcs) block (present when `hasGwcs`).
 */
function buildWcsFits(receipt: any, hasGwcs: boolean): any {
    const wcs = receipt?.wcs;
    if (!wcs) return null;

    // When a fitted TPS rides the native chain, the native `wcs` carries a RICHER
    // (spline) distortion than this FITS-representable fallback can express — so the
    // two are NOT bit-for-bit equivalent (SIP/linear here vs TPS there). Be honest
    // about which model the native block carries.
    const hasTps = receipt?.solution?.astrometry?.tps != null;

    const out: any = {
        _label: hasGwcs
            ? 'FITS-keyword WCS metadata — the fallback for readers without gwcs. The native, astropy-interpretable transform is the sibling `wcs` (gwcs/wcs) block.'
            : 'FITS-keyword WCS metadata — NOT an interpretable GWCS transform.',
        _todo: hasGwcs
            ? (hasTps
                ? 'A native gwcs `wcs` transform IS emitted alongside, carrying the fitted TPS distortion as a tabular lookup (the FITS-standard SIP keywords here are the FITS-representable fallback, a DIFFERENT/coarser model than the native spline).'
                : 'A native gwcs `wcs` transform IS emitted alongside (fidelity-gated: pixel→world reproduces this FITS-WCS to sub-arcsec).')
            : 'A GWCS transform (schema wcs/wcs) is a separately-gated future deliverable; omitted until validated.',
        _pixel_convention: 'engine 0-based pixel centers, y-down image space',
        ...wcs,
    };

    const sip = receipt?.solution?.astrometry?.sip;
    if (sip && Array.isArray(sip.a) && Array.isArray(sip.b)) {
        // FITS-convention SIP keywords (A_FITS = −A_internal) — identical to the
        // fits_writer cards, so a reader building an astropy WCS from these agrees
        // with the native gwcs polynomial node (which uses the SAME negated A/B).
        const fitsSip = toFitsSip(sip);
        out.CTYPE1 = 'RA---TAN-SIP';
        out.CTYPE2 = 'DEC--TAN-SIP';
        out.A_ORDER = fitsSip.a_order;
        out.B_ORDER = fitsSip.b_order;
        emitSipTerms('A', fitsSip.a, out);
        emitSipTerms('B', fitsSip.b, out);
    }
    return out;
}

function emitSipTerms(prefix: string, coeffs: number[][], out: any): void {
    for (let i = 0; i < coeffs.length; i++) {
        const row = coeffs[i];
        if (!Array.isArray(row)) continue;
        for (let j = 0; j < row.length; j++) {
            const v = row[j];
            if (typeof v === 'number' && Number.isFinite(v) && v !== 0) {
                out[`${prefix}_${i}_${j}`] = v;
            }
        }
    }
}

// ─── native GWCS (gwcs/wcs) transform pipeline ────────────────────────────────

/**
 * Build a NATIVE, astropy-interpretable `gwcs/wcs` transform tree from the
 * fitted WCS. Scope = LINEAR (+ SIP, appended when a fitted A/B is present).
 *
 * The pixel→world chain (0-based detector pixels → ICRS deg), mirroring the
 * standard FITS TAN forward exactly so the two agree to sub-arcsec (proven by
 * tools/asdf/gwcs_fidelity.py — NOT asserted):
 *
 *   (x,y)  Shift(-crpix_x) & Shift(-crpix_y)   → (u,v)   [0-based; no +1]
 *          [ SIP correction  u,v → u',v' ]              [only when sip present]
 *          Affine( matrix=CD, deg/px )         → (ξ,η)   projection-plane deg
 *          Gnomonic (Pix2Sky_TAN)              → (φ,θ)   native spherical
 *          Rotate3D native2celestial(          → (α,δ)   ICRS deg
 *              lon=crval_ra_deg, lat=crval_dec_deg, lon_pole=180)
 *
 * The CD matrix carries the image-space parity (y-down / mirror) as fitted — we
 * feed it through verbatim and assert NO sign; the fidelity gate proves the
 * result. Returns null when unsolved OR when a required keyword is non-finite
 * (honest-or-absent; the labeled `wcs_fits` stays as the fallback).
 *
 * `receipt.wcs` is consumed (crval already ×15 → deg, CD in deg/px, crpix
 * 0-based per generateReceiptWcs) so the HOURS→deg conversion happens once.
 */
function buildGwcs(receipt: any, width: number, height: number): YamlTagged | null {
    const wcs = receipt?.wcs;
    if (!wcs) return null;

    const cx = num(wcs.CRPIX1), cy = num(wcs.CRPIX2);
    const ra = num(wcs.CRVAL1), dec = num(wcs.CRVAL2);
    const cd11 = num(wcs.CD1_1), cd12 = num(wcs.CD1_2);
    const cd21 = num(wcs.CD2_1), cd22 = num(wcs.CD2_2);
    if ([cx, cy, ra, dec, cd11, cd12, cd21, cd22].some(v => v === null)) return null;

    // Shift(-crpix) & Shift(-crpix): pixel → offset-from-reference (0-based).
    const shifts = tag(GWCS_TAG.concatenate, {
        forward: [
            tag(GWCS_TAG.shift, { inputs: ['x'], offset: -(cx as number), outputs: ['y'] }),
            tag(GWCS_TAG.shift, { inputs: ['x'], offset: -(cy as number), outputs: ['y'] }),
        ],
        inputs: ['x0', 'x1'],
        outputs: ['y0', 'y1'],
    });

    // Affine(CD): (u,v) → projection-plane (ξ,η) in degrees. matrix rows are the
    // CD rows exactly; translation is zero (reference offset already removed).
    const affine = tag(GWCS_TAG.affine, {
        inputs: ['x', 'y'],
        matrix: ndarray([[cd11 as number, cd12 as number], [cd21 as number, cd22 as number]], [2, 2]),
        outputs: ['x', 'y'],
        translation: ndarray([0, 0], [2]),
    });

    // Optional distortion correction, inserted BETWEEN the shift and the CD
    // matrix (FITS convention: distortion applies to pixel-offset coords, pre-CD).
    // TPS (tabular lookup) takes precedence over SIP (polynomial) when a fitted
    // TPS is present — both model the SAME residual field, so exactly ONE rides
    // the chain (never both, which would double-correct). Absent → linear chain
    // (byte-identical to a receipt with no distortion fit).
    const distortion = buildTpsCorrection(receipt, width, height) ?? buildSipCorrection(receipt);

    // Compose left-to-right: (((shift | [distortion] | affine) | gnomonic) | rotate).
    let chain: YamlTagged = compose(shifts, affine, ['x0', 'x1'], ['x', 'y']);
    if (distortion) {
        const shiftThenDist = compose(shifts, distortion, ['x0', 'x1'], ['z0', 'z1']);
        chain = compose(shiftThenDist, affine, ['x0', 'x1'], ['x', 'y']);
    }

    const gnomonic = tag(GWCS_TAG.gnomonic, { direction: 'pix2sky', inputs: ['x', 'y'], outputs: ['phi', 'theta'] });
    chain = compose(chain, gnomonic, ['x0', 'x1'], ['phi', 'theta']);

    const rotate = tag(GWCS_TAG.rotate3d, {
        direction: 'native2celestial',
        inputs: ['phi_N', 'theta_N'],
        outputs: ['alpha_C', 'delta_C'],
        phi: ra as number,        // native longitude of the celestial pole → crval_ra
        psi: 180.0,               // lon_pole
        theta: dec as number,     // crval_dec
    });
    chain = compose(chain, rotate, ['x0', 'x1'], ['alpha_C', 'delta_C']);

    const detector = tag(GWCS_TAG.frame2d, {
        axes_names: ['x', 'y'],
        axes_order: [0, 1],
        axis_physical_types: ['custom:x', 'custom:y'],
        name: 'detector',
        unit: [tag(GWCS_TAG.unit, raw('pixel')), tag(GWCS_TAG.unit, raw('pixel'))],
    });
    const celestial = tag(GWCS_TAG.celestial, {
        axes_names: ['lon', 'lat'],
        axes_order: [0, 1],
        axis_physical_types: ['pos.eq.ra', 'pos.eq.dec'],
        name: 'icrs',
        reference_frame: tag(GWCS_TAG.icrs, { frame_attributes: {} }),
        unit: [tag(GWCS_TAG.unit, raw('deg')), tag(GWCS_TAG.unit, raw('deg'))],
    });

    return tag(GWCS_TAG.wcs, {
        name: '',
        pixel_shape: null,
        steps: [
            tag(GWCS_TAG.step, { frame: detector, transform: chain }),
            tag(GWCS_TAG.step, { frame: celestial, transform: null }),
        ],
    });
}

/**
 * The SIP distortion as a gwcs/transform node, or null when no fitted SIP is
 * present (well-corrected optics → honest-absent). FITS SIP forward:
 *   u' = u + Σ A_pq u^p v^q ,   v' = v + Σ B_pq u^p v^q
 * Represented (exactly as asdf-astropy serializes a `Mapping((0,1,0,1)) |
 * (poly_u & poly_v)`) as: remap_axes fans (u,v)→(u,v,u,v), then a concatenate of
 * two transform/polynomial nodes whose coefficient matrices FOLD IN the identity
 * (the u/v linear term gets +1). Coefficients come from the live fitted A/B
 * matrices (receipt.solution.astrometry.sip) — never fabricated.
 */
function buildSipCorrection(receipt: any): YamlTagged | null {
    const sip = receipt?.solution?.astrometry?.sip;
    if (!sip || !Array.isArray(sip.a) || !Array.isArray(sip.b)) return null;

    // FITS-convention coefficients (A_FITS = −A_internal): the polynomial node
    // applies u' = u + Σ A_FITS·u^p v^q, so with the negated A/B the astropy-
    // evaluated chain corrects TOWARD the catalog (matches the FITS SIP cards).
    const fitsSip = toFitsSip(sip);
    const polyU = sipPolynomial(fitsSip.a, /*identityAxis*/ 'u');
    const polyV = sipPolynomial(fitsSip.b, /*identityAxis*/ 'v');
    if (!polyU || !polyV) return null;

    // Fan (u,v) → (u,v,u,v), then apply poly_u to the first pair and poly_v to
    // the second, concatenated → (u',v'). Compose remap|polys = the SIP corr.
    const remap = tag(GWCS_TAG.remap, { inputs: ['x0', 'x1'], mapping: [0, 1, 0, 1], outputs: ['x0', 'x1', 'x2', 'x3'] });
    const polys = tag(GWCS_TAG.concatenate, { forward: [polyU, polyV], inputs: ['x0', 'y0', 'x1', 'y1'], outputs: ['z0', 'z1'] });
    return compose(remap, polys, ['x0', 'x1'], ['z0', 'z1']);
}

/**
 * A transform/polynomial-1.3.0 node for one SIP axis. The FITS A/B matrix is
 * indexed coeff[p][q] = coefficient of u^p v^q; the gwcs polynomial stores an
 * (order+1)×(order+1) `coefficients` ndarray with the SAME [p][q] = x^p y^q
 * layout (inputs x=u, y=v). The identity term (+u for the u-axis, +v for the
 * v-axis) is folded into coeff[1][0] / coeff[0][1] so the node maps (u,v) → u'/v'
 * directly. `domain`/`window` are the astropy default [-1,1] (identity scaling,
 * i.e. the polynomial evaluates on raw u,v — no normalization).
 */
function sipPolynomial(coeffs: number[][], identityAxis: 'u' | 'v'): YamlTagged | null {
    if (!Array.isArray(coeffs)) return null;
    const order = coeffs.length - 1;
    if (order < 1) return null;
    const n = order + 1;

    const mat: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let p = 0; p < n; p++) {
        const row = coeffs[p];
        if (!Array.isArray(row)) continue;
        for (let q = 0; q < Math.min(n, row.length); q++) {
            const v = row[q];
            if (typeof v === 'number' && Number.isFinite(v)) mat[p][q] = v;
        }
    }
    // Fold in the identity (u' = u + Σ…  ⇒  +1 on the u linear term).
    if (identityAxis === 'u') mat[1][0] += 1; else mat[0][1] += 1;

    const unit: number[] = [-1, 1];
    return tag(GWCS_TAG.polynomial, {
        coefficients: ndarray(mat, [n, n]),
        domain: [unit, unit],
        inputs: ['x', 'y'],
        outputs: ['z'],
        window: [unit, unit],
    });
}

// ─── native GWCS TPS distortion (tabular lookup) ──────────────────────────────

/**
 * GWCS grid density for the TPS tabular lookup (per axis). A thin-plate spline is
 * smooth, so a moderate regular grid reproduces it with small linear-interpolation
 * error between nodes AT the nodes there is NO error (the table stores the exact
 * spline value). 24×24 = 576 nodes spans the frame at a step of ~frame/23 while
 * keeping the inline YAML block compact. The fidelity gate evaluates AT the grid
 * nodes, where gwcs's tabular value equals the analytic spline exactly.
 */
const TPS_GWCS_GRID_N = 24;

/**
 * The fitted TPS distortion as a gwcs/transform node (tabular lookup), or null
 * when no fitted TPS is present. A spline has no polynomial nodes, so the standard
 * GWCS representation is a Tabular2D per output axis: two `!transform/tabular`
 * nodes (dx-corrected u', dy-corrected v'), each mapping (u,v)→scalar, fanned by a
 * remap and concatenated — identical wiring to buildSipCorrection, so the same
 * proven shift|distortion|CD placement carries it.
 *
 * The lookup tables sample, on a regular frame-spanning (u,v) grid, the corrected
 * pixel-offset coordinate  u' = u − f_dx(ũ,ṽ),  v' = v − f_dy(ũ,ṽ)  where f is the
 * live fitted spline (evalTpsField — the IDENTICAL evaluator the fitter used,
 * shared via tps_eval so nothing drifts) and ũ,ṽ = (u,v)/tps.scale. Requires the
 * frame dims (grid extent) + the receipt crpix (the chain shift's origin — the
 * tabular input is x−crpix, matching the fit's u,v). Never fabricated: absent
 * unless solution.astrometry.tps is present and well-formed.
 *
 * SIGN (same fix as SIP, see sip_convention.ts): the fitted field f reproduces
 * the internal residual dx = OBSERVED − IDEAL (tps_fitter.ts convention). The
 * gwcs Tabular2D is a DIRECT lookup — its output IS the coordinate fed to CD, no
 * implicit add — so the table must hold the IDEAL (corrected) offset. IDEAL =
 * OBSERVED − (OBSERVED − IDEAL) = u − f, hence the SUBTRACTION below (emitting u +
 * f applied the distortion backwards and worsened the astropy-applied residuals).
 */
function buildTpsCorrection(receipt: any, width: number, height: number): YamlTagged | null {
    const tps = receipt?.solution?.astrometry?.tps;
    if (!tps || !Array.isArray(tps.control_points) ||
        !Array.isArray(tps.weights_x) || !Array.isArray(tps.weights_y)) return null;

    const wcs = receipt?.wcs;
    const cx = num(wcs?.CRPIX1), cy = num(wcs?.CRPIX2);
    const scale = num(tps.scale);
    const affDx = tps.affine?.dx, affDy = tps.affine?.dy;
    if (cx === null || cy === null || scale === null || scale <= 0) return null;
    if (!(width > 1) || !(height > 1)) return null;
    if (!Array.isArray(affDx) || affDx.length !== 3 || !Array.isArray(affDy) || affDy.length !== 3) return null;

    const un: number[] = tps.control_points.map((p: number[]) => p[0]);
    const vn: number[] = tps.control_points.map((p: number[]) => p[1]);
    const aDx = affDx as [number, number, number];
    const aDy = affDy as [number, number, number];
    const N = TPS_GWCS_GRID_N;

    // Grid in pixel-offset (u,v) space spanning the full frame [0,width-1] with a
    // 1px margin so every in-frame pixel (incl. the corners) is strictly interior.
    const uGrid = linspace(-cx - 1, (width - 1) - cx + 1, N);
    const vGrid = linspace(-cy - 1, (height - 1) - cy + 1, N);

    // lookup_table[i][j] = corrected coordinate at node (uGrid[i], vGrid[j]).
    const lutU: number[][] = [];
    const lutV: number[][] = [];
    for (let i = 0; i < N; i++) {
        const rowU: number[] = [], rowV: number[] = [];
        for (let j = 0; j < N; j++) {
            const u = uGrid[i], v = vGrid[j];
            const uNorm = u / scale, vNorm = v / scale;
            // corrected (IDEAL) offset = u − (OBSERVED−IDEAL); see the SIGN note above.
            rowU.push(u - evalTpsField(uNorm, vNorm, un, vn, tps.weights_x, aDx));
            rowV.push(v - evalTpsField(uNorm, vNorm, un, vn, tps.weights_y, aDy));
        }
        lutU.push(rowU);
        lutV.push(rowV);
    }

    const tabU = tabular2d(uGrid, vGrid, lutU);
    const tabV = tabular2d(uGrid, vGrid, lutV);

    // Fan (u,v) → (u,v,u,v), apply tabU to the first pair + tabV to the second,
    // concatenate → (u',v'). Compose remap|tabs = the TPS correction node.
    const remap = tag(GWCS_TAG.remap, { inputs: ['x0', 'x1'], mapping: [0, 1, 0, 1], outputs: ['x0', 'x1', 'x2', 'x3'] });
    const tabs = tag(GWCS_TAG.concatenate, { forward: [tabU, tabV], inputs: ['x0', 'y0', 'x1', 'y1'], outputs: ['z0', 'z1'] });
    return compose(remap, tabs, ['x0', 'x1'], ['z0', 'z1']);
}

/**
 * One `!transform/tabular-1.4.0` node — the exact asdf-astropy Tabular2D shape
 * (captured from a WSL-oracle round-trip): 2-D input → 1-D output, a 2-D
 * `lookup_table` indexed [i,j] = value at (points[0][i], points[1][j]), linear
 * interpolation, extrapolation-safe (bounds_error:false). Coordinate axes + table
 * are inline float64 ndarrays (no extra binary blocks — mirrors sipPolynomial).
 */
function tabular2d(pointsU: number[], pointsV: number[], lut: number[][]): YamlTagged {
    return tag(GWCS_TAG.tabular, {
        bounds_error: false,
        inputs: ['x', 'y'],
        lookup_table: ndarray(lut, [pointsU.length, pointsV.length]),
        method: raw('linear'),
        outputs: ['z'],
        points: [ndarray(pointsU, [pointsU.length]), ndarray(pointsV, [pointsV.length])],
    });
}

/** n evenly-spaced samples over [a,b] inclusive. */
function linspace(a: number, b: number, n: number): number[] {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = a + (b - a) * (i / (n - 1));
    return out;
}

/** compose two transform nodes forward (A | B). */
function compose(a: YamlTagged, b: YamlTagged, inputs: string[], outputs: string[]): YamlTagged {
    return tag(GWCS_TAG.compose, { forward: [a, b], inputs, outputs });
}

/** An inline core/ndarray-1.1.0 (float64) — avoids extra binary blocks. */
function ndarray(data: any, shape: number[]): YamlTagged {
    return tag(GWCS_TAG.ndarray, { data, datatype: raw('float64'), shape });
}

// ─── lens-distortion slot (honest-absent; no producer today) ──────────────────

/**
 * `com.skycruncher.lens_distortion` — a ready slot for a FUTURE producer of
 * MEASURED per-image Brown-Conrady coefficients (per-copy LM/SIP refit). That
 * producer does not exist yet, and the nominal LENS_DB prior is a heuristic that
 * must NEVER be emitted as if measured (the dead Rust path's sin). So this
 * returns null (absent) unless the receipt carries an explicitly-measured block.
 */
function buildLensDistortion(receipt: any): any {
    const meas = receipt?.solution?.lens_distortion_measured
        ?? receipt?.lens_distortion_measured;
    if (!meas || meas.measured !== true) return null; // honest-absent: no producer today
    return {
        _label: 'MEASURED per-image Brown-Conrady lens distortion (per-copy fit).',
        _model: 'brown_conrady',
        ...meas,
    };
}

/**
 * `com.skycruncher.source_provenance` — the ORIGIN of the frame's bytes, populated
 * at ingest by matching the intake fetcher's content-sha ledger. Honest-or-absent:
 * returns null unless the receipt carries a `source_provenance` with at least one
 * populated field (an all-null block means the origin was unknown → nothing to
 * assert, so we emit nothing). The bare receipt key still rides the generic root
 * passthrough; this labeled node just adds a human `_label`.
 */
function buildSourceProvenance(receipt: any): any {
    const sp = receipt?.source_provenance;
    if (!sp || typeof sp !== 'object') return null;
    const populated = sp.origin != null || sp.uri != null || sp.fetched_at != null || sp.intake_sha256 != null;
    if (!populated) return null; // honest-absent: unknown origin
    return {
        _label: 'Origin of the frame bytes — matched at ingest against the intake '
            + 'content-sha ledger (Google Drive / URL / local-drop). Honest-or-absent.',
        origin: sp.origin ?? null,
        uri: sp.uri ?? null,
        fetched_at: sp.fetched_at ?? null,
        intake_sha256: sp.intake_sha256 ?? null,
    };
}

// ─── little helpers ───────────────────────────────────────────────────────────

/** Finite-number coercion — returns null for missing/NaN/Infinity. */
function num(v: any): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pixelDatatype(data: AsdfPixelArray): 'uint16' | 'float32' {
    if (data instanceof Uint16Array) return 'uint16';
    if (data instanceof Float32Array) return 'float32';
    throw new Error('ASDF export supports Uint16Array (uint16) or Float32Array (float32) only.');
}

/** Write a uint64 big-endian without BigInt (safe for values < 2^53 — images
 * are far below 4 GB, so the high word is effectively always small). */
function setU64BE(view: DataView, offset: number, value: number): void {
    const high = Math.floor(value / 0x100000000);
    const low = value >>> 0;
    view.setUint32(offset, high, false);
    view.setUint32(offset + 4, low, false);
}

function isTypedArray(v: any): boolean {
    return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

/**
 * Recursively normalize the receipt into plain YAML-safe values: drop the heavy
 * typed-array keys (mirrors the JSON serializer), inline small typed arrays,
 * note-out large ones, coerce non-finite numbers to null, and strip undefined.
 */
function sanitize(value: any): any {
    if (value === null || value === undefined) return null;
    if (isTypedArray(value)) {
        const len = (value as any).length;
        if (len <= 1024) return Array.from(value as any);
        return `<omitted ${len}-element ${value.constructor?.name ?? 'typed array'}>`;
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (typeof value === 'object') {
        const out: any = {};
        for (const k of Object.keys(value)) {
            if (DROPPED_KEYS.has(k)) continue;
            if (value[k] === undefined) continue;
            out[k] = sanitize(value[k]);
        }
        return out;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
}

// ── YAML tagged / raw nodes (for the native gwcs `wcs` transform tree) ─────────
// A YamlTagged renders `!tag` before its mapping/scalar body; a YamlRaw renders a
// scalar verbatim (unquoted) — used for enum-like tokens (unit names, dtype).

interface YamlTagged { readonly __tag: string; readonly __body: any; }
interface YamlRaw { readonly __raw: string; }

function tag(tagStr: string, body: any): YamlTagged { return { __tag: tagStr, __body: body }; }
function raw(s: string): YamlRaw { return { __raw: s }; }
function isTagged(v: any): v is YamlTagged {
    return v != null && typeof v === 'object' && typeof (v as any).__tag === 'string' && '__body' in v;
}
function isRaw(v: any): v is YamlRaw {
    return v != null && typeof v === 'object' && typeof (v as any).__raw === 'string';
}

// ── YAML emission (block style; strings double-quoted; scalars/short arrays flow)

const YAML_RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '~']);

function pad(indent: number): string {
    return '  '.repeat(indent);
}

/** Double-quote a string as a YAML double-quoted scalar (JSON escapes are a
 * subset of YAML's — \", \\, \n, \t, \uXXXX — so JSON.stringify is safe). */
function dq(s: string): string {
    return JSON.stringify(String(s));
}

function emitKey(key: string): string {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !YAML_RESERVED.has(key.toLowerCase())) {
        return key;
    }
    return dq(key);
}

function isScalar(v: any): boolean {
    if (isRaw(v)) return true;
    return v === null || v === undefined ||
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** Format a finite number as a YAML 1.1 float/int. Guards the exponential trap:
 * `String(1e-8)` → "1e-8", whose mantissa lacks a dot and would parse as a
 * STRING under the YAML 1.1 core float grammar (a real hazard for tiny SIP
 * coefficients). Rewrite "1e-8" → "1.0e-8" so it always parses as a float. */
function numToYaml(n: number): string {
    let s = String(n);
    const m = /^([+-]?\d+)(e[+-]?\d+)$/i.exec(s);
    if (m) s = `${m[1]}.0${m[2]}`;
    return s;
}

function emitScalar(v: any): string {
    if (isRaw(v)) return v.__raw;
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isFinite(v) ? numToYaml(v) : 'null';
    return dq(String(v));
}

/** A value is flowable (one-line `[...]`) if it is a scalar or an array whose
 * elements are all flowable — keeps `shape`, CD rows and SIP matrices compact.
 * Tagged nodes are never flowable (they need block form). */
function isFlowable(v: any): boolean {
    if (isTagged(v)) return false;
    if (isScalar(v)) return true;
    if (Array.isArray(v)) return v.every(isFlowable);
    return false;
}

function emitFlow(v: any): string {
    if (Array.isArray(v)) return '[' + v.map(emitFlow).join(', ') + ']';
    return emitScalar(v);
}

/** Emit `key: value` (and any nested block) at the given indent. */
function emitMapEntry(key: string, value: any, indent: number, out: string[]): void {
    const prefix = pad(indent) + emitKey(key) + ':';
    emitValue(prefix, value, indent, out);
}

function emitValue(prefix: string, value: any, indent: number, out: string[]): void {
    if (isTagged(value)) {
        const body = value.__body;
        if (isScalar(body)) { out.push(prefix + ' ' + value.__tag + ' ' + emitScalar(body)); return; }
        // tagged mapping / sequence: `key: !tag` then the body block under it.
        out.push(prefix + ' ' + value.__tag);
        emitBodyBlock(body, indent + 1, out);
        return;
    }
    if (isScalar(value)) {
        out.push(prefix + ' ' + emitScalar(value));
        return;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) { out.push(prefix + ' []'); return; }
        if (isFlowable(value)) { out.push(prefix + ' ' + emitFlow(value)); return; }
        out.push(prefix);
        for (const item of value) emitSeqItem(item, indent + 1, out);
        return;
    }
    // plain object → block mapping
    const keys = Object.keys(value).filter(k => value[k] !== undefined);
    if (keys.length === 0) { out.push(prefix + ' {}'); return; }
    out.push(prefix);
    for (const k of keys) emitMapEntry(k, value[k], indent + 1, out);
}

/** Emit the body of a tagged node (a mapping or a sequence) at `indent`. */
function emitBodyBlock(body: any, indent: number, out: string[]): void {
    if (Array.isArray(body)) {
        for (const item of body) emitSeqItem(item, indent, out);
        return;
    }
    for (const k of Object.keys(body).filter(k => body[k] !== undefined)) {
        emitMapEntry(k, body[k], indent, out);
    }
}

function emitSeqItem(item: any, indent: number, out: string[]): void {
    const dash = pad(indent) + '-';
    if (isTagged(item)) {
        const body = item.__body;
        if (isScalar(body)) { out.push(dash + ' ' + item.__tag + ' ' + emitScalar(body)); return; }
        // `- !tag` then the body indented one level (aligns: "- " is 2 chars).
        out.push(dash + ' ' + item.__tag);
        emitBodyBlock(body, indent + 1, out);
        return;
    }
    if (isScalar(item)) { out.push(dash + ' ' + emitScalar(item)); return; }
    if (Array.isArray(item)) {
        if (item.length === 0) { out.push(dash + ' []'); return; }
        if (isFlowable(item)) { out.push(dash + ' ' + emitFlow(item)); return; }
        out.push(dash);
        for (const sub of item) emitSeqItem(sub, indent + 1, out);
        return;
    }
    const keys = Object.keys(item).filter(k => item[k] !== undefined);
    if (keys.length === 0) { out.push(dash + ' {}'); return; }
    const sub: string[] = [];
    for (const k of keys) emitMapEntry(k, item[k], indent + 1, sub);
    // Splice the dash onto the first key line (alignment preserved: pad(indent+1)
    // is exactly 2 wider than pad(indent), and "- " is 2 chars).
    sub[0] = pad(indent) + '- ' + sub[0].slice(pad(indent + 1).length);
    out.push(...sub);
}
