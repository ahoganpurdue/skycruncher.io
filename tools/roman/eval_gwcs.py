#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════════════
GWCS EVALUATION BRIDGE — pixel→sky at center + 4 corners, via asdf + gwcs (WSL)
═══════════════════════════════════════════════════════════════════════════════

The Node ingestor (tools/roman/ingest_roman.mjs) does NOT re-implement Roman's
(or our own) gwcs transform stack in JS — that stack is a composed astropy
model chain (shift|scale|gnomonic|rotate3d[|SIP|TPS]) whose numerics only the
real `gwcs`/`astropy` own. Instead the .mjs shells to THIS script, which opens
the ASDF with the real libraries, navigates to the `gwcs/wcs` node by a dotted
key path, evaluates pixel→world at the frame center + 4 corners, and returns the
coordinates as JSON on stdout.

HONEST failure: any problem (node is not a gwcs.WCS, eval raises, path missing)
returns `{"ok": false, "error": "…"}` — the caller records the WCS block as
present-but-UNEVALUATED, never a fabricated coordinate.

Run (isolated venv — must match the file's gwcs/asdf-wcs-schemas versions):
    ~/roman_venv/bin/python tools/roman/eval_gwcs.py <file.asdf> <dotted.key.path> --shape H,W
"""
import argparse
import json
import sys
import warnings


def get_by_path(tree, dotted):
    """Navigate a dotted path through mapping-style and attribute-style nodes."""
    node = tree
    for key in dotted.split("."):
        if key == "":
            continue
        got = False
        # mapping/item access first (asdf tree dicts + stnode DNodes)
        try:
            node = node[key]
            got = True
        except Exception:
            pass
        if not got:
            try:
                node = getattr(node, key)
                got = True
            except Exception:
                pass
        if not got:
            raise KeyError(f"path segment '{key}' not found")
    return node


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("keypath", help="dotted path to the gwcs/wcs node, e.g. 'roman.meta.wcs' or 'wcs'")
    ap.add_argument("--shape", default=None, help="'H,W' pixel grid extent (rows,cols); required for corners")
    args = ap.parse_args()

    try:
        import asdf  # noqa
        import gwcs
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"import failed: {e!r}"}))
        return

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # unknown-tag / version warnings are non-fatal
            with asdf.open(args.file, memmap=False, lazy_load=False) as af:
                node = get_by_path(af.tree, args.keypath)

                if not isinstance(node, gwcs.WCS):
                    print(json.dumps({"ok": False, "error": f"node at '{args.keypath}' is {type(node).__name__}, not gwcs.WCS"}))
                    return

                # pixel grid extent
                H = W = None
                if args.shape:
                    parts = [int(p) for p in args.shape.split(",")]
                    if len(parts) >= 2:
                        H, W = parts[0], parts[1]

                def world(x, y):
                    out = node(float(x), float(y))
                    vals = [float(v) for v in (out if isinstance(out, (list, tuple)) else (out,))]
                    return vals

                result = {"ok": True, "n_world_axes": int(node.world_n_dim), "pixel_convention": "0-based (x=col, y=row)"}

                # center
                if H is not None and W is not None:
                    cx, cy = (W - 1) / 2.0, (H - 1) / 2.0
                    result["center"] = {"x": cx, "y": cy, "world": world(cx, cy)}
                    result["corners"] = [
                        {"name": "top_left", "x": 0.0, "y": 0.0, "world": world(0.0, 0.0)},
                        {"name": "top_right", "x": float(W - 1), "y": 0.0, "world": world(W - 1, 0.0)},
                        {"name": "bottom_left", "x": 0.0, "y": float(H - 1), "world": world(0.0, H - 1)},
                        {"name": "bottom_right", "x": float(W - 1), "y": float(H - 1), "world": world(W - 1, H - 1)},
                    ]
                else:
                    result["note"] = "no --shape given; evaluated origin only"
                    result["center"] = {"x": 0.0, "y": 0.0, "world": world(0.0, 0.0)}

                # world-axis labels/units when available (honest metadata)
                try:
                    result["world_axis_names"] = list(node.output_frame.axes_names)
                    result["world_axis_units"] = [str(u) for u in node.output_frame.unit]
                except Exception:
                    pass

                print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
