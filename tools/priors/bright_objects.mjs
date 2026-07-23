// tools/priors/bright_objects.mjs
//
// Built-in bright-object table + filename catalog-name parser for the search-prior
// triage lane (TASK #20 incubator). PRIOR / TESTIMONY only — every hit is marked
// assumed:true by the caller and MUST NOT be used for astrometry.
//
// Coordinate source: J2000 equatorial, standard published catalog positions
// (Messier 1..110 from the canonical Messier catalog; NGC/IC/Caldwell/Arp extras
// from their published positions). Values are PRIOR-GRADE (rounded to ~0.01 deg);
// they exist to seed a hard visibility floor and a coarse RA window, not to solve.
// No dependency on the runtime atlas (which is gitignored / not in every checkout).
//
// RA_deg, dec_deg are degrees J2000. `name` is the common label.

// --- Messier catalog (J2000, degrees) -------------------------------------
export const MESSIER = {
  1:   { ra: 83.63,  dec: 22.01,  name: 'Crab Nebula' },
  2:   { ra: 323.36, dec: -0.82,  name: 'M2' },
  3:   { ra: 205.55, dec: 28.38,  name: 'M3' },
  4:   { ra: 245.90, dec: -26.53, name: 'M4' },
  5:   { ra: 229.64, dec: 2.08,   name: 'M5' },
  6:   { ra: 265.08, dec: -32.22, name: 'Butterfly Cluster' },
  7:   { ra: 268.46, dec: -34.82, name: 'Ptolemy Cluster' },
  8:   { ra: 270.92, dec: -24.38, name: 'Lagoon Nebula' },
  9:   { ra: 259.80, dec: -18.52, name: 'M9' },
  10:  { ra: 254.29, dec: -4.10,  name: 'M10' },
  11:  { ra: 282.77, dec: -6.27,  name: 'Wild Duck Cluster' },
  12:  { ra: 251.81, dec: -1.95,  name: 'M12' },
  13:  { ra: 250.42, dec: 36.46,  name: 'Hercules Cluster' },
  14:  { ra: 264.40, dec: -3.25,  name: 'M14' },
  15:  { ra: 322.49, dec: 12.17,  name: 'M15' },
  16:  { ra: 274.70, dec: -13.78, name: 'Eagle Nebula' },
  17:  { ra: 275.20, dec: -16.18, name: 'Omega Nebula' },
  18:  { ra: 274.98, dec: -17.13, name: 'M18' },
  19:  { ra: 255.66, dec: -26.27, name: 'M19' },
  20:  { ra: 270.63, dec: -23.03, name: 'Trifid Nebula' },
  21:  { ra: 271.10, dec: -22.50, name: 'M21' },
  22:  { ra: 279.10, dec: -23.90, name: 'M22' },
  23:  { ra: 269.20, dec: -19.02, name: 'M23' },
  24:  { ra: 274.20, dec: -18.48, name: 'M24' },
  25:  { ra: 277.90, dec: -19.25, name: 'M25' },
  26:  { ra: 281.32, dec: -9.40,  name: 'M26' },
  27:  { ra: 299.90, dec: 22.72,  name: 'Dumbbell Nebula' },
  28:  { ra: 276.14, dec: -24.87, name: 'M28' },
  29:  { ra: 305.98, dec: 38.53,  name: 'M29' },
  30:  { ra: 325.09, dec: -23.18, name: 'M30' },
  31:  { ra: 10.68,  dec: 41.27,  name: 'Andromeda Galaxy' },
  32:  { ra: 10.67,  dec: 40.87,  name: 'M32' },
  33:  { ra: 23.46,  dec: 30.66,  name: 'Triangulum Galaxy' },
  34:  { ra: 40.50,  dec: 42.78,  name: 'M34' },
  35:  { ra: 92.24,  dec: 24.33,  name: 'M35' },
  36:  { ra: 84.05,  dec: 34.13,  name: 'M36' },
  37:  { ra: 88.10,  dec: 32.55,  name: 'M37' },
  38:  { ra: 82.18,  dec: 35.85,  name: 'M38' },
  39:  { ra: 323.05, dec: 48.43,  name: 'M39' },
  40:  { ra: 185.60, dec: 58.08,  name: 'M40' },
  41:  { ra: 101.50, dec: -20.73, name: 'M41' },
  42:  { ra: 83.82,  dec: -5.45,  name: 'Orion Nebula' },
  43:  { ra: 83.88,  dec: -5.27,  name: 'De Mairan Nebula' },
  44:  { ra: 130.05, dec: 19.98,  name: 'Beehive Cluster' },
  45:  { ra: 56.75,  dec: 24.12,  name: 'Pleiades' },
  46:  { ra: 115.45, dec: -14.82, name: 'M46' },
  47:  { ra: 114.15, dec: -14.50, name: 'M47' },
  48:  { ra: 123.45, dec: -5.80,  name: 'M48' },
  49:  { ra: 187.44, dec: 8.00,   name: 'M49' },
  50:  { ra: 105.80, dec: -8.34,  name: 'M50' },
  51:  { ra: 202.47, dec: 47.20,  name: 'Whirlpool Galaxy' },
  52:  { ra: 351.05, dec: 61.59,  name: 'M52' },
  53:  { ra: 198.23, dec: 18.17,  name: 'M53' },
  54:  { ra: 283.78, dec: -30.48, name: 'M54' },
  55:  { ra: 295.00, dec: -30.96, name: 'M55' },
  56:  { ra: 289.15, dec: 30.18,  name: 'M56' },
  57:  { ra: 283.40, dec: 33.03,  name: 'Ring Nebula' },
  58:  { ra: 189.43, dec: 11.82,  name: 'M58' },
  59:  { ra: 190.51, dec: 11.65,  name: 'M59' },
  60:  { ra: 190.92, dec: 11.55,  name: 'M60' },
  61:  { ra: 185.48, dec: 4.47,   name: 'M61' },
  62:  { ra: 255.30, dec: -30.11, name: 'M62' },
  63:  { ra: 198.96, dec: 42.03,  name: 'Sunflower Galaxy' },
  64:  { ra: 194.18, dec: 21.68,  name: 'Black Eye Galaxy' },
  65:  { ra: 169.73, dec: 13.09,  name: 'M65' },
  66:  { ra: 170.06, dec: 12.99,  name: 'M66' },
  67:  { ra: 132.85, dec: 11.81,  name: 'M67' },
  68:  { ra: 189.87, dec: -26.75, name: 'M68' },
  69:  { ra: 277.85, dec: -32.35, name: 'M69' },
  70:  { ra: 280.80, dec: -32.30, name: 'M70' },
  71:  { ra: 298.45, dec: 18.78,  name: 'M71' },
  72:  { ra: 313.37, dec: -12.54, name: 'M72' },
  73:  { ra: 314.75, dec: -12.63, name: 'M73' },
  74:  { ra: 24.17,  dec: 15.78,  name: 'Phantom Galaxy' },
  75:  { ra: 301.52, dec: -21.92, name: 'M75' },
  76:  { ra: 25.60,  dec: 51.58,  name: 'Little Dumbbell Nebula' },
  77:  { ra: 40.67,  dec: -0.01,  name: 'M77' },
  78:  { ra: 86.68,  dec: 0.05,   name: 'M78' },
  79:  { ra: 81.05,  dec: -24.55, name: 'M79' },
  80:  { ra: 244.25, dec: -22.98, name: 'M80' },
  81:  { ra: 148.89, dec: 69.07,  name: "Bode's Galaxy" },
  82:  { ra: 148.97, dec: 69.68,  name: 'Cigar Galaxy' },
  83:  { ra: 204.25, dec: -29.87, name: 'Southern Pinwheel' },
  84:  { ra: 186.27, dec: 12.89,  name: 'M84' },
  85:  { ra: 186.35, dec: 18.19,  name: 'M85' },
  86:  { ra: 186.55, dec: 12.95,  name: 'M86' },
  87:  { ra: 187.71, dec: 12.40,  name: 'Virgo A' },
  88:  { ra: 188.00, dec: 14.42,  name: 'M88' },
  89:  { ra: 188.92, dec: 12.55,  name: 'M89' },
  90:  { ra: 189.21, dec: 13.16,  name: 'M90' },
  91:  { ra: 188.86, dec: 14.50,  name: 'M91' },
  92:  { ra: 259.28, dec: 43.14,  name: 'M92' },
  93:  { ra: 116.15, dec: -23.87, name: 'M93' },
  94:  { ra: 192.72, dec: 41.12,  name: 'M94' },
  95:  { ra: 161.00, dec: 11.70,  name: 'M95' },
  96:  { ra: 161.69, dec: 11.82,  name: 'M96' },
  97:  { ra: 168.70, dec: 55.02,  name: 'Owl Nebula' },
  98:  { ra: 183.45, dec: 14.90,  name: 'M98' },
  99:  { ra: 184.71, dec: 14.42,  name: 'M99' },
  100: { ra: 185.73, dec: 15.82,  name: 'M100' },   // filename alias: "Blowdryer Galaxy"
  101: { ra: 210.80, dec: 54.35,  name: 'Pinwheel Galaxy' },
  102: { ra: 226.62, dec: 55.76,  name: 'Spindle Galaxy' },
  103: { ra: 23.34,  dec: 60.70,  name: 'M103' },
  104: { ra: 189.997,dec: -11.62, name: 'Sombrero Galaxy' },
  105: { ra: 161.96, dec: 12.58,  name: 'M105' },
  106: { ra: 184.74, dec: 47.30,  name: 'M106' },
  107: { ra: 248.13, dec: -13.05, name: 'M107' },
  108: { ra: 167.88, dec: 55.67,  name: 'M108' },
  109: { ra: 179.40, dec: 53.38,  name: 'M109' },
  110: { ra: 10.10,  dec: 41.69,  name: 'M110' },
};

// --- NGC / IC / Caldwell / Arp extras present in real filenames (J2000, deg) ---
export const EXTRAS = {
  'NGC869':  { ra: 34.75,  dec: 57.13,  name: 'Double Cluster (h Per)' },
  'NGC884':  { ra: 35.55,  dec: 57.15,  name: 'Double Cluster (chi Per)' },
  'NGC6960': { ra: 311.65, dec: 30.72,  name: 'Veil Nebula / Cygnus Loop (W)' },
  'NGC6992': { ra: 313.40, dec: 31.72,  name: 'Veil Nebula (E)' },
  'NGC7000': { ra: 314.75, dec: 44.53,  name: 'North America Nebula' },
  'NGC7635': { ra: 350.20, dec: 61.20,  name: 'Bubble Nebula' },
  'NGC7023': { ra: 315.40, dec: 68.16,  name: 'Iris Nebula' },
  'NGC2237': { ra: 97.90,  dec: 5.05,   name: 'Rosette Nebula' },     // Caldwell 49
  'NGC6888': { ra: 303.05, dec: 38.35,  name: 'Crescent Nebula' },    // Caldwell 27
  'NGC3372': { ra: 161.26, dec: -59.68, name: 'Carina Nebula' },      // far-south target
  'IC434':   { ra: 85.24,  dec: -2.46,  name: 'Horsehead Nebula' },
  'IC5146':  { ra: 328.38, dec: 47.27,  name: 'Cocoon Nebula' },
  'IC443':   { ra: 94.50,  dec: 22.50,  name: 'Jellyfish Nebula' },
  'ARP316':  { ra: 154.60, dec: 21.83,  name: 'Arp 316 (Leo group)' },
  'LEOTRIP': { ra: 170.30, dec: 13.40,  name: 'Leo Triplet' },
  'MARKARIAN':{ ra: 186.65, dec: 13.03, name: "Markarian's Chain" },
};

// Caldwell -> our catalog id (only entries we actually resolve)
const CALDWELL = { 27: 'NGC6888', 49: 'NGC2237' };

// Common-name substrings -> catalog id. Order matters (first hit wins); longer /
// more specific phrases first so "cygnus loop" beats a bare "loop".
const COMMON_NAMES = [
  ['cygnus loop', 'NGC6960'],
  ['veil', 'NGC6960'],
  ['north america', 'NGC7000'],
  ['double cluster', 'NGC869'],
  ['perseus double', 'NGC869'],
  ['horsehead', 'IC434'],
  ['cocoon', 'IC5146'],
  ['jellyfish', 'IC443'],
  ['rosette', 'NGC2237'],
  ['crescent', 'NGC6888'],
  ['bubble', 'NGC7635'],
  ['iris', 'NGC7023'],
  ['carina', 'NGC3372'],
  ['leo triplet', 'LEOTRIP'],
  ['markarian', 'MARKARIAN'],
  ['andromeda', 'M31'],
  ['triangulum', 'M33'],
  ['whirlpool', 'M51'],
  ['sunflower', 'M63'],
  ['black eye', 'M64'],
  ['pinwheel', 'M101'],
  ['sombrero', 'M104'],
  ["bode", 'M81'],
  ['cigar', 'M82'],
  ['crab', 'M1'],
  ['dumbbell', 'M27'],
  ['ring nebula', 'M57'],
  ['pleiades', 'M45'],
  ['beehive', 'M44'],
  ['owl', 'M97'],
  ['blowdryer', 'M100'],
  ['orion nebula', 'M42'],
  ['orion', 'M42'],
  ['lagoon', 'M8'],
  ['trifid', 'M20'],
  ['eagle', 'M16'],
  ['omega nebula', 'M17'],
  ['hercules cluster', 'M13'],
];

/** Resolve a catalog id token (e.g. "M66","NGC6960","IC434") to a coord record. */
export function resolveCatalogId(id) {
  if (!id) return null;
  const up = id.toUpperCase();
  const m = up.match(/^M0*(\d{1,3})$/);
  if (m) { const rec = MESSIER[+m[1]]; return rec ? { catalog_id: 'M' + (+m[1]), ...rec } : null; }
  if (EXTRAS[up]) return { catalog_id: up, ...EXTRAS[up] };
  return null;
}

/**
 * Parse a file path / name for a catalog object.
 * Scans the FULL relative path (directory names carry the object too, e.g.
 * "corpus/cocoon_60da/lights/L_0020.CR2"). Returns the highest-confidence hit or null.
 * Precedence: explicit Messier/NGC/IC id > Caldwell id > common name.
 * Never throws; returns { catalog_id, name, ra_deg, dec_deg, matched, ambiguous } | null.
 */
export function parseName(pathOrName) {
  if (!pathOrName || typeof pathOrName !== 'string') return null;
  const raw = pathOrName;
  // normalise separators so "cygnus_loop" / "cygnus-loop" match "cygnus loop"
  const norm = raw.replace(/[._/\\-]+/g, ' ').replace(/\s+/g, ' ');
  const lower = norm.toLowerCase();

  const hits = [];

  // Messier: M31, M 66, M66, M_66  (word-boundary M so "IMG" / "5DMkIII" don't match)
  for (const mm of norm.matchAll(/\bM\s?(\d{1,3})\b/g)) {
    const rec = resolveCatalogId('M' + mm[1]);
    if (rec) hits.push({ ...rec, matched: `messier:M${+mm[1]}`, rank: 3 });
  }
  // NGC
  for (const mm of norm.matchAll(/\bNGC\s?(\d{1,4})\b/gi)) {
    const rec = resolveCatalogId('NGC' + mm[1]);
    if (rec) hits.push({ ...rec, matched: `ngc:NGC${mm[1]}`, rank: 3 });
  }
  // IC (require >=3 digits to avoid matching stray "IC" fragments)
  for (const mm of norm.matchAll(/\bIC\s?(\d{3,4})\b/gi)) {
    const rec = resolveCatalogId('IC' + mm[1]);
    if (rec) hits.push({ ...rec, matched: `ic:IC${mm[1]}`, rank: 3 });
  }
  // Arp
  for (const mm of norm.matchAll(/\bArp\s?(\d{1,3})\b/gi)) {
    if (+mm[1] === 316) { const rec = resolveCatalogId('ARP316'); if (rec) hits.push({ ...rec, matched: 'arp:Arp316', rank: 2 }); }
  }
  // Caldwell: bare "C49","C27" — lower confidence (single-letter prefix)
  for (const mm of norm.matchAll(/\bC\s?(\d{1,3})\b/g)) {
    const id = CALDWELL[+mm[1]];
    if (id) { const rec = resolveCatalogId(id); if (rec) hits.push({ ...rec, matched: `caldwell:C${+mm[1]}`, rank: 2 }); }
  }
  // Common names (substring on normalised lower path)
  for (const [phrase, id] of COMMON_NAMES) {
    if (lower.includes(phrase)) { const rec = resolveCatalogId(id); if (rec) { hits.push({ ...rec, matched: `common:${phrase}`, rank: 1 }); break; } }
  }

  if (hits.length === 0) return null;
  // pick highest rank; note ambiguity if >1 DISTINCT catalog id survives
  hits.sort((a, b) => b.rank - a.rank);
  const best = hits[0];
  const distinct = new Set(hits.map((h) => h.catalog_id));
  return {
    catalog_id: best.catalog_id,
    name: best.name,
    ra_deg: best.ra,
    dec_deg: best.dec,
    matched: best.matched,
    ambiguous: distinct.size > 1 ? [...distinct] : null,
  };
}
