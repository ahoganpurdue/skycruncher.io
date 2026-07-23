#!/bin/bash
# Independent astrometry.net oracle for IMG_1410 (BLIND on RA/Dec — scale band
# only, so it cannot be biased toward the app's blind solve). Same lite cfg +
# scale band the IMG_1757 oracle used (same rig/lens). Run via WSL Ubuntu-24.04.
set -u
D=/mnt/d/SkyCruncher/test_artifacts/gauntlet_oracle_2026-07-11
CFG=/mnt/d/astrometry_indexes/astrometry_lite.cfg
cd "$D"
echo "=== an-pnmtofits $(date -u) ==="
an-pnmtofits "$D/IMG_1410.pgm" > "$D/IMG_1410.fits" 2> "$D/pnm.err" && echo PNMOK || { echo PNMFAIL; cat "$D/pnm.err"; exit 1; }
ls -la "$D/IMG_1410.fits"
echo "=== solve-field BLIND START $(date -u) ==="
timeout 340 solve-field \
  --config "$CFG" \
  --scale-units arcsecperpix --scale-low 45 --scale-high 70 \
  --downsample 2 --overwrite --no-plots --cpulimit 300 \
  -D "$D" "$D/IMG_1410.fits"
echo "=== solve-field EXIT $? $(date -u) ==="
echo "=== artifacts ==="
ls -la "$D/IMG_1410.wcs" "$D/IMG_1410.solved" 2>&1
if [ -f "$D/IMG_1410.wcs" ]; then
  echo "=== WCSINFO ==="
  wcsinfo "$D/IMG_1410.wcs"
else
  echo "NO_WCS_BLIND"
fi
