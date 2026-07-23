// ═══════════════════════════════════════════════════════════════════════════
// FITS-HEADER TRUTH DERIVER (JS — reuses tools/stack/fits_io.mjs)
// (spec: docs/VALIDATION_HARNESS.md · Enhancement 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Derives a ground-truth label from a FITS header. This is a `.mjs` on purpose:
// it reuses the CANONICAL FITS parser (tools/stack/fits_io.mjs, `openFits`)
// rather than re-implementing 2880-byte-block parsing (LAW 4 — no code in two
// places), and staying JS keeps the untyped parser out of the tsc gate. The TS
// loader calls this lazily via a dynamic import.
//
// Truth extracted (honest-absent per axis):
//   center  : CRVAL1/CRVAL2 (deg) if present, else the RA/DEC "object" cards
//             (goto pointing) — RA→hours (÷15), DEC→deg.
//   scale   : sqrt(|det CD|)·3600 if a CD matrix is present (INDEPENDENT, tight);
//             else CDELT; else the NOMINAL optics scale 206.265·XPIXSZ(µm)/FOCALLEN(mm)
//             (APPROXIMATE — nominal focal length); else null (center-only truth).
//   rotation/parity : from the CD matrix if present; else omitted.

import { openFits } from '../../stack/fits_io.mjs';

const RAD = Math.PI / 180;

function num(cards, key) {
  const v = cards[key];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalize360(deg) {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

/**
 * @param {string} fitsPath  path to a FITS file
 * @param {string} frameId   frame identity for the produced label
 * @returns {Promise<import('./schema.ts').TruthLabel | null>}
 */
export async function deriveFitsTruth(fitsPath, frameId) {
  let f;
  try {
    f = openFits(fitsPath);
  } catch {
    return null; // unreadable/unsupported → honest NO_TRUTH
  }
  try {
    const cards = f.cards;

    // ── center ──
    const crval1 = num(cards, 'CRVAL1'); // deg
    const crval2 = num(cards, 'CRVAL2'); // deg
    const raDeg = crval1 != null ? crval1 : num(cards, 'RA'); // "object" pointing
    const decDeg = crval2 != null ? crval2 : num(cards, 'DEC');
    if (raDeg == null || decDeg == null) return null; // no center → no truth
    const usedWcsCenter = crval1 != null && crval2 != null;

    // ── scale + rotation/parity ──
    const cd11 = num(cards, 'CD1_1');
    const cd12 = num(cards, 'CD1_2');
    const cd21 = num(cards, 'CD2_1');
    const cd22 = num(cards, 'CD2_2');
    let pixel_scale_arcsec = null;
    let rotation_deg;
    let parity;
    let scaleNote;

    if (cd11 != null && cd12 != null && cd21 != null && cd22 != null) {
      const det = cd11 * cd22 - cd12 * cd21;
      pixel_scale_arcsec = Math.sqrt(Math.abs(det)) * 3600;
      rotation_deg = normalize360(Math.atan2(cd21, cd11) / RAD);
      parity = det < 0 ? 1 : -1;
      scaleNote = 'CD matrix (independent)';
    } else {
      const cdelt1 = num(cards, 'CDELT1'); // deg/px
      const cdelt2 = num(cards, 'CDELT2');
      if (cdelt1 != null || cdelt2 != null) {
        const c = Math.abs(cdelt1 != null ? cdelt1 : cdelt2);
        pixel_scale_arcsec = c * 3600;
        scaleNote = 'CDELT';
      } else {
        const xpix = num(cards, 'XPIXSZ'); // microns
        const flen = num(cards, 'FOCALLEN'); // mm
        if (xpix != null && flen != null && flen > 0) {
          pixel_scale_arcsec = (206.264806 * xpix) / flen;
          scaleNote = `nominal 206.265·XPIXSZ(${xpix}µm)/FOCALLEN(${flen}mm), APPROXIMATE`;
        } else {
          scaleNote = 'none (center-only truth)';
        }
      }
    }

    const centerNote = usedWcsCenter ? 'CRVAL1/2 (WCS)' : 'RA/DEC object card (goto pointing)';
    const label = {
      frame_id: frameId,
      source: 'fits_header',
      ra_hours: raDeg / 15,
      dec_degrees: decDeg,
      pixel_scale_arcsec,
      provenance_note: `FITS header ${fitsPath.split(/[\\/]/).pop()}: center=${centerNote}; scale=${scaleNote}.`,
      generated_at: new Date().toISOString(),
    };
    if (rotation_deg !== undefined) label.rotation_deg = rotation_deg;
    if (parity !== undefined) label.parity = parity;
    return label;
  } finally {
    f.close();
  }
}
