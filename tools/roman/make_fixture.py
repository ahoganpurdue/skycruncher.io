#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════════════
ROMAN L2 FIXTURE MAKER — a small, schema-valid Roman WFI L2 ASDF for the ingestor
═══════════════════════════════════════════════════════════════════════════════

The SkyCruncher ASDF ingestor (tools/roman/ingest_roman.mjs) must read Roman Space
Telescope L2 products, which are ASDF-native. This builds a SMALL such file for
the cross-dialect proof, WITHOUT downloading any survey data.

PRIMARY path (schema-valid): roman_datamodels ships MAKER utilities that build a
schema-valid datamodel with placeholder data. We call
`ImageModel.create_fake_data(shape=…)` (a real WfiImage L2 / `WfiImage` class),
crop the data array tiny, and save via the model's ASDF writer. The result
validates against the Roman Attribute Dictionary (`rad`) schemas — a genuine
Roman L2 container, not a hand-rolled look-alike.

FALLBACK path (Roman-SHAPED, NOT schema-validated): if roman_datamodels is not
importable, build a Roman-shaped ASDF from plain `asdf` + `gwcs` + `astropy`,
tagging the tree `roman` with a representative meta subtree + a real gwcs. This
is labelled `schema_validated: false` in the fixture's own provenance so the
deviation is HONEST, never hidden.

Run (isolated venv, see tools/asdf/INGEST_README.md):
    ~/roman_venv/bin/python tools/roman/make_fixture.py [--shape 16] [--out PATH]

Emits: test_results/roman/roman_l2_fixture.asdf  (gitignored) + a JSON summary
of what was built, on stdout.
"""
import argparse
import json
import os
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_OUT = os.path.join(REPO_ROOT, "test_results", "roman", "roman_l2_fixture.asdf")


def build_schema_valid(shape, out_path, compression):
    """PRIMARY: a real roman_datamodels WfiImage L2, data cropped to shape×shape."""
    from roman_datamodels import datamodels as dm

    model = dm.ImageModel.create_fake_data(shape=(shape, shape))

    # Stamp recognisable, honest metadata so the ingest manifest is legible.
    # (These are placeholder values on a synthetic frame — the science is fake;
    #  the CONTAINER + schema are real, which is what the ingestor is tested on.)
    model.meta.telescope = "ROMAN"
    try:
        model.meta.instrument.name = "WFI"
        model.meta.instrument.detector = "WFI01"
        model.meta.instrument.optical_element = "F158"
    except Exception:
        pass

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    # roman datamodels save writes a schema-validated ASDF file. Default
    # compression is 'lz4'; we default the fixture to UNCOMPRESSED so the Node
    # reader can prove a full binary-block decode across the Roman dialect too
    # (block compression is an orthogonal ASDF-container detail — the reader
    # FLAGS lz4 blocks honestly as present-but-not-decoded when they occur).
    model.save(out_path, all_array_compression=compression)

    # Summarise (read straight off the in-memory model).
    meta = model.meta
    return {
        "path_mode": "roman_datamodels",
        "schema_validated": True,
        "telescope": str(getattr(meta, "telescope", None)),
        "instrument": str(getattr(getattr(meta, "instrument", None), "name", None)),
        "detector": str(getattr(getattr(meta, "instrument", None), "detector", None)),
        "optical_element": str(getattr(getattr(meta, "instrument", None), "optical_element", None)),
        "exposure_type": str(getattr(getattr(meta, "exposure", None), "type", None)),
        "data_shape": list(model.data.shape),
        "data_dtype": str(model.data.dtype),
        "has_gwcs": getattr(meta, "wcs", None) is not None,
    }


def build_fallback(shape, out_path, compression):
    """FALLBACK: Roman-SHAPED ASDF via plain asdf+gwcs (NOT schema-validated)."""
    import numpy as np
    import asdf
    import astropy.units as u
    from astropy.modeling import models
    from astropy import coordinates as coord
    from gwcs import wcs as gwcs_wcs
    from gwcs import coordinate_frames as cf

    # A minimal but real gwcs: detector (pixel) -> ICRS (deg), TAN projection.
    shift = models.Shift(-shape / 2) & models.Shift(-shape / 2)
    scale = models.Scale(0.11 / 3600.0) & models.Scale(0.11 / 3600.0)  # deg/px (~Roman 0.11")
    tan = models.Pix2Sky_TAN()
    celestial_rot = models.RotateNative2Celestial(30.0, -10.0, 180.0)
    det2sky = shift | scale | tan | celestial_rot
    detector_frame = cf.Frame2D(name="detector", axes_order=(0, 1), unit=(u.pix, u.pix))
    sky_frame = cf.CelestialFrame(reference_frame=coord.ICRS(), name="icrs", unit=(u.deg, u.deg))
    wcsobj = gwcs_wcs.WCS([(detector_frame, det2sky), (sky_frame, None)])

    data = (np.arange(shape * shape, dtype="float32").reshape(shape, shape) % 1000)

    tree = {
        "roman": {
            "meta": {
                "telescope": "ROMAN",
                "instrument": {"name": "WFI", "detector": "WFI01", "optical_element": "F158"},
                "exposure": {"type": "WFI_IMAGE", "ma_table_name": "fallback", "nresultants": 6},
                "observation": {"observation_id": "fallback-0001"},
                "wcsinfo": {"ra_ref": 30.0, "dec_ref": -10.0},
            },
            "data": data,
            "wcs": wcsobj,
        },
        "roman_shaped_fixture": {
            "schema_validated": False,
            "note": "Roman-SHAPED (plain asdf+gwcs); NOT validated against rad schemas.",
        },
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with asdf.AsdfFile(tree) as af:
        af.write_to(out_path, all_array_compression=compression)

    return {
        "path_mode": "fallback_roman_shaped",
        "schema_validated": False,
        "telescope": "ROMAN",
        "instrument": "WFI",
        "detector": "WFI01",
        "optical_element": "F158",
        "exposure_type": "WFI_IMAGE",
        "data_shape": [shape, shape],
        "data_dtype": "float32",
        "has_gwcs": True,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shape", type=int, default=16, help="data array is shape×shape (kept small)")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--compress", default="none", choices=["none", "lz4", "zlib", "bzp2"],
                    help="ASDF block compression ('none' lets the Node reader decode pixels)")
    args = ap.parse_args()
    compression = None if args.compress == "none" else args.compress

    try:
        import roman_datamodels  # noqa: F401
        summary = build_schema_valid(args.shape, args.out, compression)
    except Exception as e:  # roman_datamodels absent or maker API drift → honest fallback
        sys.stderr.write(f"[make_fixture] roman_datamodels path failed ({e!r}); using Roman-shaped fallback\n")
        summary = build_fallback(args.shape, args.out, compression)

    summary["compression"] = args.compress
    summary["out"] = args.out
    summary["size_bytes"] = os.path.getsize(args.out)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
