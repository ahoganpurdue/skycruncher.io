// ═══════════════════════════════════════════════════════════════════════════
// PSF LANE — g15u catalog region loader (mesh leg-B incubator, LAW-4)
// ═══════════════════════════════════════════════════════════════════════════
// Reads the greenfield quad-index's `stars.arrow` (starplates-2026.07-quadidx-
// g15u) — schema per its manifest:  ra_deg:f64, dec_deg:f64, g_mag:f32,
// source_id:u64  (Arrow IPC file, single batch, 6,491,802 rows). PURE Gaia
// DR3 G<15 in DEGREES — the hybrid deg/hours atlas-row trap (forced_detect
// normRow / loadAtlasRegion) does NOT apply here: every g15u row is degrees.
//
// This is the FAINT catalog for the leg-B forced-photometry harvest: the
// public/atlas/sectors fallback is shallower than G<15, so faint harvest at
// predicted positions must come from g15u.
//
// Returns star objects shaped exactly like forced_detect.projectStars /
// forcedMeasure expect:  { ra_deg, dec_deg, mag, gaia_id, bp_rp:null }.

import fs from 'node:fs';
import { tableFromIPC } from 'apache-arrow';

const D2R = Math.PI / 180;

let _cache = null; // { path, ra:Float64Array, dec:Float64Array, g:Float32Array, sid:Vector, n }

/** Load (and cache) the full g15u stars table as typed-array columns. */
export function loadG15uTable(starsArrowPath) {
    if (_cache && _cache.path === starsArrowPath) return _cache;
    const buf = fs.readFileSync(starsArrowPath);
    const table = tableFromIPC(buf);
    const ra = table.getChild('ra_deg').toArray();   // Float64Array
    const dec = table.getChild('dec_deg').toArray();  // Float64Array
    const g = table.getChild('g_mag').toArray();      // Float32Array
    const sid = table.getChild('source_id');          // Vector<Uint64> — .get(i) -> BigInt
    _cache = { path: starsArrowPath, ra, dec, g, sid, n: table.numRows };
    return _cache;
}

/**
 * Every g15u star within radiusDeg of (raDeg,decDeg) with magMin < g_mag <= magLimit.
 * Cheap dec pre-filter, then exact great-circle separation on the survivors.
 * `magMin` is EXCLUSIVE, `magLimit` INCLUSIVE (so a (floor, floor+2] band is
 * regionStars({magMin:floor, magLimit:floor+2})).
 */
export function regionStars({ starsArrowPath, raDeg, decDeg, radiusDeg, magLimit = Infinity, magMin = -Infinity }) {
    const t = loadG15uTable(starsArrowPath);
    const cosd0 = Math.cos(decDeg * D2R), sind0 = Math.sin(decDeg * D2R);
    const a0 = raDeg * D2R;
    const decLo = decDeg - radiusDeg, decHi = decDeg + radiusDeg;
    const cosR = Math.cos(Math.min(180, radiusDeg) * D2R);
    const out = [];
    for (let i = 0; i < t.n; i++) {
        const gm = t.g[i];
        if (gm > magLimit || gm <= magMin) continue;
        const dd = t.dec[i];
        if (dd < decLo || dd > decHi) continue;
        const ddr = dd * D2R;
        const c = sind0 * Math.sin(ddr) + cosd0 * Math.cos(ddr) * Math.cos(t.ra[i] * D2R - a0);
        if (c < cosR) continue; // outside the cone (cos decreasing in angle)
        out.push({
            ra_deg: t.ra[i], dec_deg: dd, mag: gm,
            gaia_id: 'Gaia_' + t.sid.get(i).toString(), bp_rp: null,
        });
    }
    return out;
}
