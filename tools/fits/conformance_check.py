#!/usr/bin/env python3
"""
FITS conformance gate — DEV/CI ORACLE ONLY (never shipped, never a repo dep).

Proves that an SkyCruncher-written `.fits` file is a STANDARD, astropy-readable
product whose WCS reproduces the sky positions our solver claims:

  1. astropy.io.fits opens the file; the ndarray shape/dtype are read back and
     (for the tiny ramp fixture) the pixel bytes are asserted EXACT — the
     BITPIX=-32 big-endian planar payload survived byte-for-byte.

  2. astropy.wcs.WCS(header) is built from OUR header (an independent C
     implementation of FITS-WCS). For a `--truth` star list, all_pix2world over
     the matched-star pixels is compared to the catalog ra/dec (genuinely
     independent — the catalog positions came from the star-catalog cross-match,
     not from the WCS). The residual astropy measures must AGREE with the solver's
     OWN per-star residual: a serialization bug (missing CRPIX+1, CD transpose,
     the crval ×15 double-convert, a mis-slotted SIP term) shifts every star by
     ≳1 px (≈scale arcsec) and blows this agreement — while a correct writer
     reproduces the solver residual to well under a pixel. The `--truth` also
     carries a synthetic-SIP fixture: its pixels are pre-displaced so that ONLY a
     reader that APPLIES our A_i_j/B_i_j keywords recovers the catalog — the SIP
     serialization is therefore exercised, not just present.

  3. PARITY: the CD determinant sign read back from the header must match the
     sign the writer was handed (a mirror/parity flip must survive). Covered by
     the negative-determinant ramp fixture and every M66 fixture.

Install the oracle OUTSIDE the repo (do NOT add a Python dep to the project):
    python3 -m pip install --user --break-system-packages astropy numpy

Usage:
    python3 conformance_check.py <file.fits> [--shape H,W] [--datatype float32]
                                             [--ramp] [--truth <stars.json>]
"""
import argparse
import json
import sys

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS


def _angular_sep_arcsec(ra1, dec1, ra2, dec2):
    """Great-circle separation (deg inputs) in arcsec — pure numpy."""
    r1, d1, r2, d2 = map(np.radians, (ra1, dec1, ra2, dec2))
    sin_d = np.sin((d2 - d1) / 2.0) ** 2
    sin_r = np.sin((r2 - r1) / 2.0) ** 2
    hav = sin_d + np.cos(d1) * np.cos(d2) * sin_r
    return np.degrees(2.0 * np.arcsin(np.sqrt(np.clip(hav, 0.0, 1.0)))) * 3600.0


def _truth_check(hdr, truth):
    """all_pix2world over the truth stars; assert astropy's per-star separation
    AGREES with the solver's own residual (writer fidelity). Returns max |Δ|."""
    # Suppress the benign "no inverse SIP (AP_/BP_)" warning — forward-only is our
    # documented, intentional choice (readers invert numerically).
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wcs = WCS(hdr)

    stars = truth["matched_stars"]
    xs = np.array([s["x"] for s in stars], dtype=float)
    ys = np.array([s["y"] for s in stars], dtype=float)
    ra_cat = np.array([s["ra_deg"] for s in stars], dtype=float)
    dec_cat = np.array([s["dec_deg"] for s in stars], dtype=float)
    resid = np.array([s["residual_arcsec"] for s in stars], dtype=float)

    # origin=0 → the input x,y are 0-based engine pixels (CRPIX in the header is
    # 1-based; astropy reconciles via the origin argument).
    world = wcs.all_pix2world(np.column_stack([xs, ys]), 0)
    ra_w, dec_w = world[:, 0], world[:, 1]

    sep = _angular_sep_arcsec(ra_w, dec_w, ra_cat, dec_cat)

    # Per-star agreement: astropy's residual must match the solver's residual to
    # within (abs + rel) tolerance. abs catches the small-residual stars (where a
    # ~scale-sized serialization shift stands out); rel absorbs the tangent-plane
    # vs pixel-scalar measurement-convention difference at the large-residual
    # corners. A misapplied/dropped SIP or a bad CRPIX blows BOTH.
    tol_abs = float(truth.get("tol_arcsec", 0.75))
    tol = tol_abs + 0.02 * resid
    delta = np.abs(sep - resid)
    worst_i = int(np.argmax(delta - tol))          # most out-of-tolerance star
    n_bad = int(np.sum(delta > tol))
    if n_bad > 0:
        i = int(np.argmax(delta))
        raise AssertionError(
            f"WCS fidelity FAILED ({truth['fixture_kind']}): {n_bad}/{len(stars)} stars off. "
            f"worst pixel ({xs[i]:.2f},{ys[i]:.2f}): astropy_sep={sep[i]:.4f}\" "
            f"solver_resid={resid[i]:.4f}\" |Δ|={delta[i]:.4f}\" > tol={tol[i]:.4f}\" "
            f"— a serialization/convention error (CRPIX+1, CD, crval×15, or SIP slot)."
        )
    return float(np.max(delta)), float(np.max(sep)), len(stars)


def _linear_header(hdr):
    """A copy of the header with the SIP distortion STRIPPED (CTYPE forced to plain
    TAN, all A_/B_ keywords removed) — the linear-only reference WCS. Used by the
    catalog-residual check to measure the pre-distortion separation."""
    lin = hdr.copy()
    lin["CTYPE1"] = "RA---TAN"
    lin["CTYPE2"] = "DEC--TAN"
    for k in list(lin.keys()):
        if k in ("A_ORDER", "B_ORDER") or (
            (str(k).startswith("A_") or str(k).startswith("B_"))
            and str(k)[2:].replace("_", "").isdigit()
        ):
            del lin[k]
    return lin


def _stats(sep):
    """(rms, median) in arcsec for a separation array."""
    return float(np.sqrt(np.mean(sep ** 2))), float(np.median(sep))


def _catalog_residual_check(hdr, truth):
    """REAL-ENGINE sign adjudication. Apply the header's LINEAR WCS and its
    SIP/distortion WCS to the matched-star pixels, and compare each to the
    INDEPENDENT catalog ra/dec. The distortion must MOVE positions TOWARD the
    catalog (residuals go DOWN) — the only test that catches a wrong-SIGN SIP
    export (which would push positions AWAY and INCREASE the residual). Returns a
    dict of before/after stats and asserts the improvement."""
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wcs_sip = WCS(hdr)
        wcs_lin = WCS(_linear_header(hdr))

    stars = truth["matched_stars"]
    xy = np.array([[s["x"], s["y"]] for s in stars], dtype=float)
    ra_cat = np.array([s["ra_deg"] for s in stars], dtype=float)
    dec_cat = np.array([s["dec_deg"] for s in stars], dtype=float)

    # origin=0 → inputs are 0-based engine pixels (CRPIX in the header is 1-based).
    lin_world = wcs_lin.all_pix2world(xy, 0)
    sip_world = wcs_sip.all_pix2world(xy, 0)
    sep_lin = _angular_sep_arcsec(lin_world[:, 0], lin_world[:, 1], ra_cat, dec_cat)
    sep_sip = _angular_sep_arcsec(sip_world[:, 0], sip_world[:, 1], ra_cat, dec_cat)

    lin_rms, lin_med = _stats(sep_lin)
    sip_rms, sip_med = _stats(sep_sip)

    print(f"[gate] catalog residual over {len(stars)} stars (astropy-applied WCS vs catalog):")
    print(f"[gate]   LINEAR (no SIP) : rms={lin_rms:.3f}\"  median={lin_med:.3f}\"")
    print(f"[gate]   SIP-APPLIED     : rms={sip_rms:.3f}\"  median={sip_med:.3f}\"")
    print(f"[gate]   Δ median = {sip_med - lin_med:+.3f}\"  Δ rms = {sip_rms - lin_rms:+.3f}\"")

    # SIGN adjudication = the ROBUST center (MEDIAN) must improve: the SIP moves the
    # BULK of well-matched stars TOWARD the catalog. A wrong-sign export pushes them
    # AWAY, worsening the median (and roughly doubling it). rms is REPORTED for
    # context — dominated by mismatched-catalog outliers — but not gated (mirrors
    # the ASDF/TPS check; the low-order SIP happens to improve rms too here).
    if not (sip_med < lin_med):
        raise AssertionError(
            f"SIP made the MEDIAN residual WORSE ({lin_med:.3f}\" → {sip_med:.3f}\") — "
            f"a wrong-SIGN SIP export (astropy applied the distortion backwards)."
        )
    if sip_rms > lin_rms:
        print(f"[gate]   note: rms worsened (outlier tail); the median improvement is the sign proof.")
    return {"linear": (lin_rms, lin_med), "sip": (sip_rms, sip_med), "n": len(stars)}


def main() -> int:
    ap = argparse.ArgumentParser(description="FITS conformance gate (astropy round-trip)")
    ap.add_argument("path", help="path to a .fits file")
    ap.add_argument("--shape", default=None, help='expected data shape, e.g. "6,8"')
    ap.add_argument("--datatype", default=None, help="expected dtype, e.g. float32")
    ap.add_argument("--ramp", action="store_true", help="assert the ramp pixel round-trip (value=i)")
    ap.add_argument("--truth", default=None, help="path to a <stars.json> truth sidecar")
    ap.add_argument("--catalog-truth", default=None,
                    help="path to a real-engine <stars.json> (catalog ra/dec) — "
                         "asserts the SIP export IMPROVES the astropy-applied residual (sign adjudication)")
    args = ap.parse_args()

    with fits.open(args.path) as hdul:
        hdr = hdul[0].header
        data = hdul[0].data
        print(f"[gate] data: shape={data.shape} dtype={data.dtype}")

        if args.shape:
            expected = tuple(int(x) for x in args.shape.split(","))
            assert data.shape == expected, f"shape {data.shape} != expected {expected}"
        if args.datatype:
            assert str(data.dtype).endswith(args.datatype) or str(data.dtype) == f">{args.datatype[0]}4" \
                or data.dtype == np.dtype(args.datatype), f"dtype {data.dtype} != {args.datatype}"

        # BITPIX=-32 → astropy reports float32 (byteorder handled on read).
        assert hdr["BITPIX"] == -32, f"BITPIX {hdr['BITPIX']} != -32"
        assert hdr["SIMPLE"] is True, "SIMPLE != T"

        # Ramp pixel round-trip (value = i) — exact byte survival of the payload.
        if args.ramp:
            flat = np.asarray(data, dtype=np.float64).reshape(-1)
            for i in range(flat.size):
                assert flat[i] == float(i), f"pixel {i} corrupt: got {flat[i]}, want {i}"
            print(f"[gate] pixel round-trip OK (exact, n={flat.size})")

        # PARITY: CD determinant sign survives (mirror/parity flip preserved).
        det = hdr["CD1_1"] * hdr["CD2_2"] - hdr["CD1_2"] * hdr["CD2_1"]
        parity = int(np.sign(det))
        print(f"[gate] CD determinant sign = {parity:+d} (parity)")

        # WCS parse (independent astropy C implementation) — must not raise.
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            _ = WCS(hdr)
        has_sip = str(hdr.get("CTYPE1", "")).endswith("-SIP")
        print(f"[gate] astropy.wcs.WCS(header) built OK ({'LINEAR+SIP' if has_sip else 'LINEAR'})")

        if args.truth:
            truth = json.load(open(args.truth))
            assert parity == int(truth["expected_cd_det_sign"]), \
                f"parity {parity} != expected {truth['expected_cd_det_sign']}"
            max_delta, max_sep, n = _truth_check(hdr, truth)
            print(f"[gate] WCS fidelity OK ({truth['fixture_kind']}): {n} stars, "
                  f"max |astropy_sep − solver_resid| = {max_delta:.4f}\" "
                  f"(tol {truth.get('tol_arcsec', 0.75)}\" +2%·resid); max astropy_sep {max_sep:.2f}\"")

        if args.catalog_truth:
            ctruth = json.load(open(args.catalog_truth))
            assert parity == int(ctruth["expected_cd_det_sign"]), \
                f"parity {parity} != expected {ctruth['expected_cd_det_sign']}"
            _catalog_residual_check(hdr, ctruth)
            print("[gate] SIP export SIGN OK — applying SIP moves stars TOWARD the "
                  "catalog (residual improved vs the linear WCS).")

    tail = ""
    if args.truth:
        tail = f"; WCS reproduces the solver's {json.load(open(args.truth))['fixture_kind']} residuals"
    if args.catalog_truth:
        tail += "; SIP export sign adjudicated (residual improves)"
    print(f"[gate] CONFORMANT — astropy opened the FITS; header + payload + parity intact{tail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
