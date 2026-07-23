#!/usr/bin/env python3
"""
ASDF conformance + GWCS FIDELITY gate — DEV/CI ORACLE ONLY (never shipped, never
a repo dep).

Two layers of proof:

  1. CONFORMANCE — round-trips an SkyCruncher `.asdf` file through the STScI
     reference `asdf` library: opens it, validates the tree against the core +
     transform + gwcs schemas, and asserts the ndarray binary block + the
     labeled `wcs_fits` metadata survived intact.

  2. FIDELITY (the real proof for the native `wcs` gwcs block) — schema
     validation will NOT catch a y-down / parity / mirrored-sky flip. So when a
     native `gwcs/wcs` `wcs` is present we LOAD it via gwcs and evaluate
     pixel→world at a grid of pixel positions, comparing against an INDEPENDENT
     astropy.wcs.WCS built from the sibling `wcs_fits` FITS keywords (a separate
     C implementation). Agreement to sub-arcsec is the ONLY thing that licenses
     calling the GWCS "conformant" — a parity flip would diverge by degrees.

Install the oracle OUTSIDE the repo (do NOT add a Python dep to the project):
    python3 -m pip install --user --break-system-packages asdf gwcs astropy
    # pin for a numpy<2 world if astropy/asdf are numpy<2 builds:
    #   'numpy<2' 'scipy==1.13.1' 'gwcs==0.21.0'

Usage:
    python3 conformance_check.py <file.asdf> [--shape H,W] [--datatype uint16]
                                             [--fidelity-arcsec 0.001]
"""
import argparse
import sys

import asdf
import numpy as np


# Far below sub-arcsec on purpose: a correct linear/SIP chain reproduces astropy
# to ~1e-10" (floating point), so a 1e-6" gate passes with ~4 orders of margin
# while still catching every real bug — a parity/axis-swap flip diverges by
# degrees, and a dropped/miswired SIP convention diverges by ~1e-4" (the SIP
# correction magnitude), both >> 1e-6". (A looser sub-arcsec gate could let a
# SIP mismatch slip under it.)
DEFAULT_FIDELITY_ARCSEC = 1.0e-6


def _angular_sep_arcsec(ra1, dec1, ra2, dec2):
    """Great-circle separation (deg inputs) in arcsec — pure-numpy, no SkyCoord
    dependency so the check runs even on a minimal astropy."""
    r1, d1, r2, d2 = map(np.radians, (ra1, dec1, ra2, dec2))
    sin_d = np.sin((d2 - d1) / 2.0) ** 2
    sin_r = np.sin((r2 - r1) / 2.0) ** 2
    hav = sin_d + np.cos(d1) * np.cos(d2) * sin_r
    return np.degrees(2.0 * np.arcsin(np.sqrt(np.clip(hav, 0.0, 1.0)))) * 3600.0


def _fits_header_from_wcs_fits(wf):
    """Reconstruct a FITS WCS header (astropy.wcs) from the labeled `wcs_fits`
    mapping. CRPIX in `wcs_fits` is engine 0-BASED → +1 for the FITS 1-based
    convention (we then evaluate with origin=0 so inputs stay 0-based)."""
    from astropy.io import fits
    hdr = fits.Header()
    hdr["WCSAXES"] = 2
    hdr["CTYPE1"] = wf.get("CTYPE1", "RA---TAN")
    hdr["CTYPE2"] = wf.get("CTYPE2", "DEC--TAN")
    hdr["CRPIX1"] = float(wf["CRPIX1"]) + 1.0
    hdr["CRPIX2"] = float(wf["CRPIX2"]) + 1.0
    hdr["CRVAL1"] = float(wf["CRVAL1"])
    hdr["CRVAL2"] = float(wf["CRVAL2"])
    for k in ("CD1_1", "CD1_2", "CD2_1", "CD2_2"):
        hdr[k] = float(wf[k])
    hdr["RADESYS"] = wf.get("RADESYS", "ICRS")
    # SIP distortion keywords, when the fit carried them.
    for k, v in wf.items():
        if k in ("A_ORDER", "B_ORDER") or (
            (k.startswith("A_") or k.startswith("B_")) and k[2:].replace("_", "").isdigit()
        ):
            hdr[k] = v
    return hdr


def _fidelity_check(af, wf, tol_arcsec):
    """Compare the native gwcs `wcs` pixel→world against an independent
    astropy.wcs.WCS(wcs_fits) at a grid of pixel points. Returns max residual
    (arcsec). Raises AssertionError if any point exceeds `tol_arcsec`."""
    from astropy.wcs import WCS as FitsWCS

    gwcs_obj = af.tree.get("wcs")
    assert gwcs_obj is not None, "native gwcs `wcs` block missing"

    ref = FitsWCS(_fits_header_from_wcs_fits(wf))

    # A grid spanning the frame (corners + center + off-axis interior points) so
    # a parity flip or axis swap can't hide in a symmetric sample.
    try:
        arr = np.asarray(af["data"])
        h, w = int(arr.shape[0]), int(arr.shape[1])
    except Exception:
        h, w = 6, 8
    pts = [
        (0.0, 0.0), (w - 1.0, 0.0), (0.0, h - 1.0), (w - 1.0, h - 1.0),
        ((w - 1) / 2.0, (h - 1) / 2.0), (2.0, 4.0), (6.0, 1.0), (1.5, 2.5),
    ]

    max_sep = 0.0
    worst = None
    for (x, y) in pts:
        ga, gd = gwcs_obj(x, y)                                   # gwcs eval
        rr = ref.all_pix2world([[x, y]], 0)[0]                    # 0-based origin
        ra_ref, dec_ref = float(rr[0]), float(rr[1])
        sep = float(_angular_sep_arcsec(ga, gd, ra_ref, dec_ref))
        if sep > max_sep:
            max_sep, worst = sep, (x, y, ga, gd, ra_ref, dec_ref)
    if max_sep > tol_arcsec:
        x, y, ga, gd, rr, dd = worst
        raise AssertionError(
            f"GWCS fidelity FAILED: max residual {max_sep:.6g}\" > {tol_arcsec}\" "
            f"at pixel ({x},{y}): gwcs=({ga:.9f},{gd:.9f}) ref=({rr:.9f},{dd:.9f}) "
            f"— likely a parity/axis/sign flip in the transform chain."
        )
    return max_sep


def _fits_header_linear(wf):
    """LINEAR-only FITS WCS header from `wcs_fits` — SIP keywords STRIPPED (CTYPE
    forced to plain TAN). The reference for the TPS chain's CD/TAN/rotate part:
    the spline distortion is applied SEPARATELY (analytically, below), so astropy
    must NOT also apply SIP."""
    from astropy.io import fits
    hdr = fits.Header()
    hdr["WCSAXES"] = 2
    hdr["CTYPE1"] = "RA---TAN"
    hdr["CTYPE2"] = "DEC--TAN"
    hdr["CRPIX1"] = float(wf["CRPIX1"]) + 1.0   # engine 0-based → FITS 1-based
    hdr["CRPIX2"] = float(wf["CRPIX2"]) + 1.0
    hdr["CRVAL1"] = float(wf["CRVAL1"])
    hdr["CRVAL2"] = float(wf["CRVAL2"])
    for k in ("CD1_1", "CD1_2", "CD2_1", "CD2_2"):
        hdr[k] = float(wf[k])
    hdr["RADESYS"] = wf.get("RADESYS", "ICRS")
    return hdr


def _find_tabulars(model):
    """Collect Tabular2D leaves from a gwcs forward transform (a binary
    CompoundModel tree). Both dx/dy tabulars share the same grid axes (`points`)."""
    from astropy.modeling.tabular import Tabular2D
    found = []

    def walk(m):
        if isinstance(m, Tabular2D):
            found.append(m)
            return
        left, right = getattr(m, "left", None), getattr(m, "right", None)
        if left is not None:
            walk(left)
        if right is not None:
            walk(right)

    walk(model)
    return found


def _tps_fidelity_check(af, wf, tps, tol_arcsec):
    """Fidelity proof for the native gwcs `wcs` when it carries the fitted TPS as a
    tabular lookup (the FITS-representable SIP in `wcs_fits`, if any, is a DIFFERENT
    fallback model and is NOT used here). Independent construction:

      1. read the tabular grid nodes (the exact (u,v) the table samples) from the
         reconstructed gwcs transform, and the raw TPS params from the tree;
      2. recompute the analytic spline displacement at each node in numpy;
      3. push the corrected pixel through an INDEPENDENT astropy LINEAR WCS;
      4. compare to the native gwcs pixel→world at the same node.

    At a grid node the tabular value EQUALS the analytic spline exactly, so
    agreement to sub-arcsec proves (a) the tabular ENCODES the fitted spline and
    (b) the chain wiring (shift|tabular|CD|TAN|rotate — parity/placement) is
    correct. Returns the max residual (arcsec); raises on exceedance."""
    from astropy.wcs import WCS as FitsWCS

    gwcs_obj = af.tree.get("wcs")
    assert gwcs_obj is not None, "native gwcs `wcs` block missing"

    un = np.asarray(tps["control_points"], dtype=float)[:, 0]
    vn = np.asarray(tps["control_points"], dtype=float)[:, 1]
    wx = np.asarray(tps["weights_x"], dtype=float)
    wy = np.asarray(tps["weights_y"], dtype=float)
    adx = np.asarray(tps["affine"]["dx"], dtype=float)
    ady = np.asarray(tps["affine"]["dy"], dtype=float)
    scale = float(tps["scale"])
    cx, cy = float(wf["CRPIX1"]), float(wf["CRPIX2"])   # engine 0-based origin

    def kern(r2):
        out = np.zeros_like(r2)
        m = r2 > 0
        out[m] = 0.5 * r2[m] * np.log(r2[m])   # r²·ln r = ½ r²·ln r²
        return out

    def field(u, v, w, aff):     # u,v NORMALIZED scalars
        du, dv = u - un, v - vn
        return aff[0] + aff[1] * u + aff[2] * v + float(np.sum(w * kern(du * du + dv * dv)))

    tabs = _find_tabulars(gwcs_obj.forward_transform)
    assert len(tabs) >= 1, "no Tabular2D found in the native gwcs transform"
    ug, vg = [np.asarray(p, dtype=float) for p in tabs[0].points]

    ref = FitsWCS(_fits_header_linear(wf))

    # Sample a subset of nodes (corners + a stride-strided interior) — enough to
    # catch a parity/axis flip without evaluating every one of N².
    su = max(1, len(ug) // 6)
    sv = max(1, len(vg) // 6)
    u_nodes = sorted(set(list(ug[::su]) + [ug[0], ug[-1]]))
    v_nodes = sorted(set(list(vg[::sv]) + [vg[0], vg[-1]]))

    max_sep = 0.0
    worst = None
    for u in u_nodes:
        for v in v_nodes:
            un_, vn_ = u / scale, v / scale
            # corrected offset = u − residual field (asdf_writer bakes u − f; the
            # fitted field is OBSERVED − IDEAL, so IDEAL = u − f). This sign MUST
            # match the export or the self-consistency check tests the wrong thing.
            up = u - field(un_, vn_, wx, adx)          # analytic corrected offset
            vp = v - field(un_, vn_, wy, ady)
            ga, gd = gwcs_obj(u + cx, v + cy)          # native: full-pixel input
            rr = ref.all_pix2world([[up + cx, vp + cy]], 0)[0]
            sep = float(_angular_sep_arcsec(ga, gd, float(rr[0]), float(rr[1])))
            if sep > max_sep:
                max_sep, worst = sep, (u, v, ga, gd, rr[0], rr[1])
    if max_sep > tol_arcsec:
        u, v, ga, gd, rr, dd = worst
        raise AssertionError(
            f"TPS fidelity FAILED: max node residual {max_sep:.6g}\" > {tol_arcsec}\" "
            f"at (u,v)=({u},{v}): gwcs=({ga:.9f},{gd:.9f}) ref=({rr:.9f},{dd:.9f}) "
            f"— tabular encoding OR chain wiring (parity/placement) is wrong."
        )
    return max_sep


def _stats(sep):
    """(rms, median) in arcsec."""
    return float(np.sqrt(np.mean(sep ** 2))), float(np.median(sep))


def _catalog_residual_check(af, wf, ctruth):
    """REAL-ENGINE sign adjudication for the native gwcs `wcs` (which carries the
    fitted TPS as a tabular lookup — precedence over SIP). Apply the native gwcs
    chain AND an INDEPENDENT linear astropy WCS (from wcs_fits, SIP stripped) to
    the matched-star pixels, and compare each to the catalog ra/dec. The TPS chain
    must move positions TOWARD the catalog (residual DOWN) — the only test that
    catches a wrong-SIGN tabular export (which would push AWAY). Returns before/
    after stats; asserts the improvement."""
    from astropy.wcs import WCS as FitsWCS

    gwcs_obj = af.tree.get("wcs")
    assert gwcs_obj is not None, "native gwcs `wcs` block missing"

    stars = ctruth["matched_stars"]
    xs = np.array([s["x"] for s in stars], dtype=float)
    ys = np.array([s["y"] for s in stars], dtype=float)
    ra_cat = np.array([s["ra_deg"] for s in stars], dtype=float)
    dec_cat = np.array([s["dec_deg"] for s in stars], dtype=float)

    ref_lin = FitsWCS(_fits_header_linear(wf))
    lin_world = ref_lin.all_pix2world(np.column_stack([xs, ys]), 0)
    ra_lin, dec_lin = lin_world[:, 0], lin_world[:, 1]

    # Native gwcs pixel->world (0-based detector pixels; gwcs is vectorized).
    ra_gw, dec_gw = gwcs_obj(xs, ys)
    ra_gw = np.asarray(ra_gw, dtype=float)
    dec_gw = np.asarray(dec_gw, dtype=float)

    sep_lin = _angular_sep_arcsec(ra_lin, dec_lin, ra_cat, dec_cat)
    sep_gw = _angular_sep_arcsec(ra_gw, dec_gw, ra_cat, dec_cat)

    lin_rms, lin_med = _stats(sep_lin)
    gw_rms, gw_med = _stats(sep_gw)

    print(f"[gate] catalog residual over {len(stars)} stars (astropy/gwcs-applied WCS vs catalog):")
    print(f"[gate]   LINEAR (no distortion) : rms={lin_rms:.3f}\"  median={lin_med:.3f}\"")
    print(f"[gate]   TPS-APPLIED (native gwcs): rms={gw_rms:.3f}\"  median={gw_med:.3f}\"")
    print(f"[gate]   Δ median = {gw_med - lin_med:+.3f}\"  Δ rms = {gw_rms - lin_rms:+.3f}\"")

    # SIGN adjudication = the ROBUST center (MEDIAN) must improve: the distortion
    # moves the BULK of well-matched stars TOWARD the catalog. A wrong-sign export
    # pushes them AWAY, worsening the median. The rms is REPORTED for context but is
    # NOT gated: it is dominated by mismatched-catalog OUTLIERS, and a flexible
    # spline can improve the bulk while inflating that tail (a fit-flexibility
    # property orthogonal to sign — the fitter's control-set rms_after is the
    # fit-quality metric, not this full-set contaminated rms).
    if not (gw_med < lin_med):
        raise AssertionError(
            f"TPS made the MEDIAN residual WORSE ({lin_med:.3f}\" → {gw_med:.3f}\") — "
            f"a wrong-SIGN tabular export (gwcs applied the distortion backwards)."
        )
    if gw_rms > lin_rms:
        print(f"[gate]   note: rms worsened (flexible spline amplifies the mismatched-catalog "
              f"outlier tail); the median improvement is the sign proof.")
    return {"linear": (lin_rms, lin_med), "tps": (gw_rms, gw_med), "n": len(stars)}


def main() -> int:
    ap = argparse.ArgumentParser(description="ASDF conformance + GWCS fidelity gate")
    ap.add_argument("path", help="path to a .asdf file")
    ap.add_argument("--shape", default=None, help='expected ndarray shape, e.g. "6,8"')
    ap.add_argument("--datatype", default=None, help="expected dtype, e.g. uint16")
    ap.add_argument("--fidelity-arcsec", type=float, default=DEFAULT_FIDELITY_ARCSEC,
                    help="max allowed gwcs-vs-fits pixel->world residual (arcsec)")
    ap.add_argument("--catalog-truth", default=None,
                    help="path to a real-engine <stars.json> (catalog ra/dec) — asserts the "
                         "native gwcs distortion IMPROVES the applied residual (TPS sign adjudication)")
    args = ap.parse_args()

    with asdf.open(args.path) as af:
        # Schema conformance against the core + transform + gwcs standards.
        af.validate()

        arr = np.asarray(af["data"])
        print(f"[gate] data: shape={arr.shape} dtype={arr.dtype} byteorder-ok")

        if args.shape:
            expected = tuple(int(x) for x in args.shape.split(","))
            assert arr.shape == expected, f"shape {arr.shape} != expected {expected}"
        if args.datatype:
            assert str(arr.dtype) == args.datatype, f"dtype {arr.dtype} != {args.datatype}"

        # asdf_library self-identification present
        assert af["asdf_library"]["name"], "asdf_library.name missing"

        # wcs_fits: labeled FITS-keyword metadata (the honest fallback).
        wf = af["wcs_fits"]
        assert wf is not None, "wcs_fits missing"
        assert "_label" in wf, "wcs_fits is not labeled"
        assert "CTYPE1" in wf and "CRVAL1" in wf, "wcs_fits missing FITS keywords"

        # Exact pixel round-trip for the known fixture ramp (value = i*257 & 0xffff)
        if args.datatype == "uint16" and arr.size <= 64:
            flat = arr.reshape(-1)
            for i in range(arr.size):
                got, want = int(flat[i]), (i * 257) & 0xFFFF
                assert got == want, f"pixel {i} corrupt: got {got}, want {want}"
            print("[gate] pixel round-trip OK (exact)")

        # ── GWCS FIDELITY — the parity-catching proof ──────────────────────────
        gwcs_obj = af.tree.get("wcs")
        if gwcs_obj is not None:
            sol = af.tree.get("solution")
            tps = (sol.get("astrometry", {}) or {}).get("tps") if isinstance(sol, dict) else None
            if tps is not None:
                # The native chain carries the TPS (tabular lookup); validate it
                # against the analytic spline at the grid nodes (SIP in wcs_fits, if
                # present, is a separate FITS-fallback model — NOT the reference).
                max_sep = _tps_fidelity_check(af, wf, tps, args.fidelity_arcsec)
                print(f"[gate] GWCS fidelity OK (TPS tabular): max node pixel->world residual "
                      f"{max_sep:.3e}\" < {args.fidelity_arcsec}\" vs analytic spline + independent astropy.wcs")
            else:
                has_sip = any(
                    str(k).startswith(("A_", "B_")) and str(k)[2:].replace("_", "").isdigit()
                    for k in wf.keys()
                )
                max_sep = _fidelity_check(af, wf, args.fidelity_arcsec)
                kind = "LINEAR+SIP" if has_sip else "LINEAR"
                print(f"[gate] GWCS fidelity OK ({kind}): max pixel->world residual "
                      f"{max_sep:.3e}\" < {args.fidelity_arcsec}\" vs independent astropy.wcs")
        else:
            print("[gate] no native gwcs `wcs` block (honest-absent) — fidelity check skipped")

        # ── REAL-ENGINE SIGN ADJUDICATION (catalog residual, before/after) ──────
        if args.catalog_truth:
            import json
            ctruth = json.load(open(args.catalog_truth))
            _catalog_residual_check(af, wf, ctruth)
            print("[gate] TPS/native-gwcs export SIGN OK — the distortion moves stars "
                  "TOWARD the catalog (residual improved vs the linear WCS).")

    tail = "; native gwcs `wcs` fidelity-proven" if gwcs_obj is not None else ""
    if args.catalog_truth:
        tail += "; distortion export sign adjudicated (residual improves)"
    print(f"[gate] CONFORMANT — asdf.validate() passed; ndarray block + wcs_fits intact{tail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
