// ═══════════════════════════════════════════════════════════════════════════
// OPTICAL TRAIN FINGERPRINTING (COORDINATE-ledger metadata layer)
// ═══════════════════════════════════════════════════════════════════════════
// Owner-architected — Feb 2026 architecture, Module 2 (Hardware Profiling),
// verbatim: "Optical Train Fingerprinting: Creates a unique hash:
//   SHA256(camera + lens + filter). If a user previously calibrated this setup,
//   it skips generic DB lookups."
//
// This module implements THAT keying. The optical-train hash is a STABLE,
// deterministic fingerprint of the (camera model × lens/telescope × optical
// filter) configuration — the physical "setup" a user shoots. It is the identity
// the Optical-Workbench store keys its MEASURED calibration profiles under so a
// previously-calibrated train can seed a solve DIRECTLY (rung-0), skipping the
// generic LENS_DB/lensfun nominal lookups.
//
// ─── LEDGER / SCOPE ────────────────────────────────────────────────────────────
// Pure metadata (NEITHER pixel nor coordinate math). No SOLVER_*/GATES.md
// constant lives here — it is an identity string. It never mutates a solve; it
// is a KEY. The measured profile it unlocks flows through the existing
// LensDistortionResolution seam (see workbench_store + lens_distortion rung-0).
//
// ─── HASH ALGORITHM CHOICE ─────────────────────────────────────────────────────
// SHA-256, per the owner's Feb spec (named the algorithm explicitly). Implemented
// as a SYNCHRONOUS, dependency-free, environment-neutral pure-JS routine (the
// browser Web Crypto SubtleCrypto.digest is ASYNC and unusable in the pure sync
// deriveRigKey/extractDeposit path; node:crypto is Node-only). Mirrors the
// environment-neutral ethos of workbench_store's cyrb53, but this is a REAL
// SHA-256 because it is an owner-named identity contract, not an internal
// bookkeeping fingerprint. Test vectors (empty, "abc") are asserted in
// optical_train.test.ts to prove correctness against FIPS-180-4.
//
// ─── SEESTAR EXCLUSION (owner ruling) ──────────────────────────────────────────
// The SeeStar is a MULTI-OBSERVER community device: many independent users shoot
// under one identical camera+lens+filter string. Pooling their per-copy MEASURED
// distortion under a single train hash would mix incompatible physics (unit-to-
// unit tolerance, focus, tilt) and poison the identity profile. SeeStar is
// therefore deliberately NOT registered as a placeholder identity below.
// ═══════════════════════════════════════════════════════════════════════════════

/** Recipe version — bump if the canonicalization or hash construction changes. */
export const TRAIN_HASH_VERSION = '1';

// ─── SHA-256 (synchronous, pure JS, FIPS-180-4) ────────────────────────────────

// prettier-ignore
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** UTF-8 encode a string to bytes (dependency-free — no TextEncoder reliance). */
function utf8Bytes(str: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x80) {
            out.push(c);
        } else if (c < 0x800) {
            out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
            const c2 = str.charCodeAt(++i);
            const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
            out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else {
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return new Uint8Array(out);
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of a byte array → 64-char lowercase hex. Synchronous, deterministic. */
export function sha256HexBytes(bytes: Uint8Array): string {
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const l = bytes.length;
    const bitLen = l * 8;
    const withOne = l + 1;
    const pad = (56 - (withOne % 64) + 64) % 64;
    const total = withOne + pad + 8;
    const msg = new Uint8Array(total);
    msg.set(bytes);
    msg[l] = 0x80;
    // 64-bit big-endian bit length (supports well past any metadata string).
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    msg[total - 8] = (hi >>> 24) & 0xff;
    msg[total - 7] = (hi >>> 16) & 0xff;
    msg[total - 6] = (hi >>> 8) & 0xff;
    msg[total - 5] = hi & 0xff;
    msg[total - 4] = (lo >>> 24) & 0xff;
    msg[total - 3] = (lo >>> 16) & 0xff;
    msg[total - 2] = (lo >>> 8) & 0xff;
    msg[total - 1] = lo & 0xff;

    const w = new Uint32Array(64);
    for (let i = 0; i < total; i += 64) {
        for (let t = 0; t < 16; t++) {
            w[t] = (msg[i + t * 4] << 24) | (msg[i + t * 4 + 1] << 16) | (msg[i + t * 4 + 2] << 8) | msg[i + t * 4 + 3];
        }
        for (let t = 16; t < 64; t++) {
            const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
            const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let t = 0; t < 64; t++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K256[t] + w[t]) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    const hex = (x: number): string => (x >>> 0).toString(16).padStart(8, '0');
    return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

/** SHA-256 of a UTF-8 string → 64-char lowercase hex. */
export function sha256HexString(str: string): string {
    return sha256HexBytes(utf8Bytes(str));
}

// ─── CANONICAL TRAIN STRING ────────────────────────────────────────────────────
// CANONICAL RECIPE (documented + unit-tested — see optical_train.test.ts):
//   segment(x) = String(x ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
//     → trim leading/trailing whitespace, collapse ALL internal whitespace runs
//       to a single space, then case-fold (identity is case/spacing insensitive:
//       "Canon EOS 5D  Mark III" and "canon eos 5d mark iii" are the SAME train).
//   filter: an ABSENT filter (undefined/empty) OR the explicit no-filter value
//     'NONE' both map to the EMPTY segment '' (a clear/unfiltered train). Any
//     other filter id (CLS, DUAL_NB, UHC, UV_IR, …) is normalized like a segment.
//   canonical = [camera, lens, filter].join('|')
//     → a '|' delimiter (never present in a normalized identity) disambiguates
//       segment boundaries so "ab"+"c" ≠ "a"+"bc"; the owner's "camera + lens +
//       filter" is realized as this delimited join.
//   hash = SHA-256(UTF-8(canonical)) → 64-char lowercase hex.

export interface OpticalTrain {
    camera?: string | null;
    lens?: string | null;
    /** Optical filter id (FilterType) or free string. NONE/absent → empty segment. */
    filter?: string | null;
}

/** Normalize one identity segment: trim, collapse whitespace, case-fold. */
export function normalizeTrainSegment(s: unknown): string {
    return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The filter segment: NONE/absent/empty → '' (clear train); else normalized id. */
function normalizeFilterSegment(filter: unknown): string {
    const f = normalizeTrainSegment(filter);
    return f === '' || f === 'none' ? '' : f;
}

/** The exact canonical string that gets hashed (delimiter-joined segments). */
export function canonicalTrainString(train: OpticalTrain): string {
    return [
        normalizeTrainSegment(train.camera),
        normalizeTrainSegment(train.lens),
        normalizeFilterSegment(train.filter),
    ].join('|');
}

/**
 * The optical-train fingerprint: SHA-256(canonical camera|lens|filter) as
 * 64-char lowercase hex. Deterministic and case/spacing-insensitive.
 */
export function deriveOpticalTrainHash(train: OpticalTrain): string {
    return sha256HexString(canonicalTrainString(train));
}

/**
 * Derive the train hash from a receipt/HardMetadata block. Returns null when the
 * train has NO identity to key on (both camera AND lens absent/empty) — a hash of
 * "||" would collide every unidentified frame, so that degenerate case is an
 * honest absence, not a bucket. `filter_type` is the optical filter segment.
 */
export function deriveTrainHashFromMetadata(metadata: any | null | undefined): string | null {
    const camera = normalizeTrainSegment(metadata?.camera_model);
    const lens = normalizeTrainSegment(metadata?.lens_model);
    // Common placeholders are not an identity.
    const cameraReal = camera !== '' && camera !== 'unknown';
    const lensReal = lens !== '' && lens !== 'unknown' && lens !== 'unknown lens';
    if (!cameraReal && !lensReal) return null;
    return deriveOpticalTrainHash({
        camera: metadata?.camera_model,
        lens: metadata?.lens_model,
        filter: metadata?.filter_type,
    });
}

// ─── PLACEHOLDER IDENTITY REGISTRY ─────────────────────────────────────────────
// Owner-directed seed manifest mapping our KNOWN data sources → placeholder
// optical-train identities. "Placeholder tier" = a train we recognize and have
// (or will have) MEASURED calibration for; the identity resolver accepts a SINGLE
// measured deposit for these (they are a known, verified setup), whereas an
// UNREGISTERED train keeps the conservative ≥3-agreement auto-pool gate.
//
// HONEST CAVEAT (graduation TODO): the camera/lens strings below are best-known
// canonical identities, NOT yet verified byte-for-byte against each rig's real
// reaper-surfaced EXIF. Because SOLVER_IDENTITY_PROFILE ships DEFAULT-OFF and a
// train that does not match the runtime hash simply falls through to the nominal
// rung (byte-identical), a string mismatch is SAFE — it just means the identity
// won't engage until the string is pinned against a real receipt at graduation.
// Each entry is derived through THIS module's deriveOpticalTrainHash, so the
// registry is internally consistent by construction.

export interface PlaceholderTrainIdentity {
    /** Stable human label (brand-neutral where practical). */
    label: string;
    camera: string;
    lens: string;
    filter: string; // FilterType id; '' / 'NONE' → clear train
    /** Provenance / caveat note for the graduation audit. */
    note: string;
}

export const PLACEHOLDER_TRAIN_IDENTITIES: readonly PlaceholderTrainIdentity[] = [
    // Contributed X-Trans field library — TWO Fuji trains, same owner/lens (X-Trans
    // sensors). Two bodies → two distinct optical trains under the same lens.
    { label: 'contrib_xt5_xf23', camera: 'Fujifilm X-T5', lens: 'XF23mmF1.4 R', filter: 'NONE',
      note: 'Contributed X-T5 + XF23 (X-Trans). Strings best-known; verify vs real EXIF at graduation.' },
    { label: 'contrib_xt4_xf23', camera: 'Fujifilm X-T4', lens: 'XF23mmF1.4 R', filter: 'NONE',
      note: 'Contributed X-T4 + XF23 (X-Trans). Same lens, different body → distinct train.' },
    // Cocoon nebula — Canon EOS 60Da through a telescope (raw Bayer FITS). Lens
    // absent (scope, no EXIF lens) → empty lens segment.
    { label: 'cocoon_60da', camera: 'Canon EOS 60Da', lens: '', filter: 'NONE',
      note: 'Cocoon carina60Da FITS (telescope; no EXIF lens → empty lens segment).' },
    // 5D3 physics-limited rig (body serial CSM30803 lives on the SERIAL rig_key,
    // NOT the train hash — the train hash is model+lens+filter per the Feb spec).
    { label: 'rig_5d3', camera: 'Canon EOS 5D Mark III', lens: '', filter: 'NONE',
      note: '5D3 single-sub rig (serial CSM30803). Lens string TBD at graduation.' },
    // Gauntlet ultra-wide — Canon T6 + Rokinon 14mm. NOTE the lying-EXIF landmine:
    // the runtime reaper surfaces 'Unknown Lens' (real lens is the 14mm Rokinon),
    // so the RUNTIME train hash keys on the placeholder unless a user hint corrects
    // the lens. Registered with the REAL lens as the target identity; the runtime
    // string reconciliation is a graduation item.
    { label: 'gauntlet_t6_rokinon', camera: 'Canon EOS Rebel T6', lens: 'Rokinon 14mm', filter: 'NONE',
      note: 'Gauntlet UW CR2 (IMG_1410/1414/1653/1757). EXIF LIES (Unknown Lens/50mm); real lens = Rokinon 14mm.' },
    // SeeStar EXCLUDED — multi-observer community device (see header rationale).
];

/** hash → identity, computed once through the canonical hash (self-consistent). */
export const PLACEHOLDER_TRAIN_HASHES: ReadonlyMap<string, PlaceholderTrainIdentity> = (() => {
    const m = new Map<string, PlaceholderTrainIdentity>();
    for (const id of PLACEHOLDER_TRAIN_IDENTITIES) {
        m.set(deriveOpticalTrainHash({ camera: id.camera, lens: id.lens, filter: id.filter }), id);
    }
    return m;
})();

/** Is this train hash one of the known/verified placeholder identities? */
export function isRegisteredTrainIdentity(trainHash: string | null | undefined): boolean {
    return trainHash != null && PLACEHOLDER_TRAIN_HASHES.has(trainHash);
}

/** The registered placeholder identity for a hash, or null. */
export function lookupTrainIdentity(trainHash: string | null | undefined): PlaceholderTrainIdentity | null {
    return trainHash != null ? PLACEHOLDER_TRAIN_HASHES.get(trainHash) ?? null : null;
}
