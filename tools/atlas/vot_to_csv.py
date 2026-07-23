#!/usr/bin/env python3
"""VOTable -> intake-CSV converter for Gaia archive downloads (WSL roman_venv).

Emits the exact 12-column intake format the pour lane parses
(tools/atlas/pour_gaia_gapfill.mjs), matching gaia_dr3_g_lt_11_raw_2026-07-11.csv:
  source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag,phot_bp_mean_mag,
  phot_rp_mean_mag,ruwe,duplicated_source,ref_epoch
- source_id as plain integer (never scientific/float)
- floats shortest-roundtrip (numpy str), masked/null -> empty string
- duplicated_source lowercase true/false
Handles .vot and .vot.gz transparently (astropy detects gzip).

Usage: vot_to_csv.py <in.vot[.gz]> <out.csv>
Prints the data row count on success (verify against the runbook's MEASURED counts).
"""
import sys

import numpy as np
from astropy.io.votable import parse_single_table

COLUMNS = [
    "source_id", "ra", "dec", "pmra", "pmdec", "parallax",
    "phot_g_mean_mag", "phot_bp_mean_mag", "phot_rp_mean_mag",
    "ruwe", "duplicated_source", "ref_epoch",
]


def fmt_cell(value, masked):
    if masked:
        return ""
    if isinstance(value, (bool, np.bool_)):
        return "true" if value else "false"
    if isinstance(value, (int, np.integer)):
        return str(int(value))
    if isinstance(value, bytes):
        return value.decode("ascii")
    return str(value)  # numpy floats: shortest round-trip repr


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    table = parse_single_table(src).to_table()

    # Gaia TAP uppercases some column names in VOTable output (e.g. SOURCE_ID)
    by_lower = {c.lower(): c for c in table.colnames}
    missing = [c for c in COLUMNS if c not in by_lower]
    if missing:
        print(f"FATAL: VOTable lacks expected columns: {missing}", file=sys.stderr)
        print(f"       present: {table.colnames}", file=sys.stderr)
        return 1

    cols = []
    for name in COLUMNS:
        col = table[by_lower[name]]
        data = col.data.data if hasattr(col.data, "mask") else np.asarray(col.data)
        mask = col.data.mask if hasattr(col.data, "mask") else np.zeros(len(col), bool)
        # scalar mask (numpy collapses all-unmasked to np.False_)
        mask = np.broadcast_to(np.asarray(mask), (len(col),))
        cols.append((data, mask))

    n = len(table)
    with open(dst, "w", newline="\n") as f:
        f.write(",".join(COLUMNS) + "\n")
        chunk = 200_000
        for lo in range(0, n, chunk):
            hi = min(lo + chunk, n)
            lines = []
            for i in range(lo, hi):
                lines.append(",".join(fmt_cell(d[i], m[i]) for d, m in cols))
            f.write("\n".join(lines) + "\n")
    print(n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
