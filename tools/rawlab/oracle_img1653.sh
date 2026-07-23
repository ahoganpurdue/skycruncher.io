#!/bin/bash
# Independent astrometry.net oracle for IMG_1653 (BLIND on RA/Dec — scale band
# only, same lite cfg + scale band as the IMG_1410/IMG_1757 oracles, same rig).
# Resolves the gauntlet INCONCLUSIVE: is IMG_1653 intrinsically solvable?
# Run via WSL Ubuntu. Input = browser-faithful luminance PGM (gauntlet_decode).
set -u
D=/mnt/d/SkyCruncher/test_artifacts/img1653_truth_2026-07-11
CFG=/mnt/d/astrometry_indexes/astrometry_lite.cfg
cd "$D"
echo "=== an-pnmtofits $(date -u) ==="
an-pnmtofits "$D/IMG_1653.pgm" > "$D/IMG_1653.fits" 2> "$D/pnm.err" && echo PNMOK || { echo PNMFAIL; cat "$D/pnm.err"; exit 1; }
ls -la "$D/IMG_1653.fits"
echo "=== solve-field BLIND START $(date -u) ==="
timeout 360 solve-field \
  --config "$CFG" \
  --scale-units arcsecperpix --scale-low 45 --scale-high 70 \
  --downsample 2 --overwrite --no-plots --cpulimit 300 \
  -D "$D" "$D/IMG_1653.fits"
echo "=== solve-field EXIT $? $(date -u) ==="
echo "=== artifacts ==="
ls -la "$D/IMG_1653.wcs" "$D/IMG_1653.solved" 2>&1
if [ -f "$D/IMG_1653.wcs" ]; then
  echo "=== WCSINFO ==="
  wcsinfo "$D/IMG_1653.wcs"
else
  echo "NO_WCS_BLIND"
fi
