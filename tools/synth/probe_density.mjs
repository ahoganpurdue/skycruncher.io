// Density probe: generate narrow frames at candidate pointings (write:false),
// print in_frame_count so a DENSE and a SPARSE pointing can be picked BY MEASURE.
// No solve; the generator loads the atlas internally (agent never reads sectors).
import { generateFrame } from './generate_frame.mjs';

const CANDIDATES = [
  { name: 'M66_leo',        raDeg: 170.425, decDeg: 12.842 },
  { name: 'cygnus_mw',      raDeg: 305.0,   decDeg: 40.0   },
  { name: 'ngp',            raDeg: 192.85,  decDeg: 27.13  },
  { name: 'highlat_south',  raDeg: 30.0,    decDeg: -20.0  },
  { name: 'sgp',            raDeg: 12.5,    decDeg: -27.13 },
  { name: 'aquila_mw',      raDeg: 285.0,   decDeg: 0.0    },
];

const rows = [];
for (const c of CANDIDATES) {
  for (const rig of ['narrow_seestar', 'medium_refractor']) {
    const { truth } = generateFrame({ rig, raDeg: c.raDeg, decDeg: c.decDeg, write: false });
    rows.push({ field: c.name, rig, ra: c.raDeg, dec: c.decDeg,
      in_frame: truth.catalog.in_frame_count, loaded: truth.catalog.loaded_count,
      sectors: truth.catalog.sectors_loaded });
  }
}
console.log(JSON.stringify(rows, null, 2));
